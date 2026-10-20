/**
 * RunInfra request shaping: the output cap per thinking level, the request-size guard and
 * client-side pacing from the catalog's limits and the rate-limit response headers.
 *
 * All of it reads limits the live catalog (GET /v1/models) puts on the model; a model without
 * them (tests, an offline models.yaml) keeps the plain behavior.
 */

import type { Model, ModelThinkingLevel } from "../types.ts";

/**
 * Output cap per thinking level, used when the caller sets no `maxTokens`. A deep-thinking turn
 * spends most of its budget on reasoning: at 16384 an xhigh/max turn on GLM or DeepSeek was cut
 * off before the answer. `max_completion_tokens` is a ceiling, not a reservation (RunInfra bills
 * tokens produced), so a higher cap costs nothing unless the model uses it. 65536 tokens at the
 * slowest benched speed (~180 tok/s) take ~6 min, inside the 740 s response time ceiling.
 */
export const RUNINFRA_THINKING_MAX_TOKENS: Readonly<Partial<Record<ModelThinkingLevel, number>>> = {
	medium: 32768,
	high: 32768,
	xhigh: 65536,
	max: 65536,
};

/** Throughput assumed for the response-time check when nothing better is known (tokens/s). */
const ASSUMED_MIN_TOKENS_PER_SECOND = 150;
/** Share of the response time ceiling a single answer may plan to use. */
const RESPONSE_TIME_SHARE = 0.8;

/**
 * The `max_completion_tokens` to send for `level`: the model default, raised for deep thinking,
 * never above the provider's output cap or what fits in the response time ceiling.
 */
export function runInfraMaxTokens(model: Model<any>, level: ModelThinkingLevel | undefined): number {
	const base = model.maxTokens;
	const wanted = Math.max(base, (level && RUNINFRA_THINKING_MAX_TOKENS[level]) || 0);
	if (wanted === base) return base;
	let cap = wanted;
	const hard = model.serviceLimits?.maxOutputTokens;
	if (hard !== undefined && hard > 0) cap = Math.min(cap, hard);
	const ceilingMs = model.serviceLimits?.responseTimeLimitMs;
	if (ceilingMs !== undefined && ceilingMs > 0) {
		cap = Math.min(cap, Math.floor((ceilingMs / 1000) * RESPONSE_TIME_SHARE * ASSUMED_MIN_TOKENS_PER_SECOND));
	}
	return Math.max(base, cap);
}

// ---------------------------------------------------------------------------------------------
// Request size guard (catalog max_request_bytes)
// ---------------------------------------------------------------------------------------------

interface WireMessage {
	role: string;
	content?: unknown;
	[key: string]: unknown;
}

const TRIM_KEEP_CHARS = 2000;
/** Headroom under max_request_bytes for headers the body estimate does not see. */
const SIZE_SAFETY = 0.97;

function textLength(content: unknown): number {
	if (typeof content === "string") return content.length;
	if (Array.isArray(content)) {
		let total = 0;
		for (const part of content) {
			if (part && typeof part === "object") {
				const p = part as { text?: unknown; image_url?: { url?: unknown } };
				if (typeof p.text === "string") total += p.text.length;
				if (typeof p.image_url?.url === "string") total += p.image_url.url.length;
			}
		}
		return total;
	}
	return 0;
}

/**
 * Cheap upper-bound guess of the serialized body size. JSON escaping of code (quotes, newlines,
 * tabs) inflates text by ~10%; the exact size is only computed when the guess comes near the limit.
 */
function roughBodyBytes(params: { messages: WireMessage[]; tools?: unknown }): number {
	let chars = 0;
	for (const message of params.messages) chars += textLength(message.content) + 64;
	return chars * 1.25 + (params.tools ? 16_384 : 0);
}

function trimmedText(text: string, limit: number): string {
	if (text.length <= limit) return text;
	const head = text.slice(0, Math.floor(limit * 0.6));
	const tail = text.slice(text.length - Math.floor(limit * 0.4));
	const removed = text.length - head.length - tail.length;
	return `${head}\n[... ${removed} chars trimmed to fit RunInfra's request size limit ...]\n${tail}`;
}

export interface FitRequestResult {
	/** Number of tool results that were shortened. */
	trimmed: number;
	/** Serialized size after trimming (exact), or undefined when no exact size was needed. */
	bytes?: number;
}

/**
 * Keeps a request under the model's `max_request_bytes` so RunInfra never answers 413: tool
 * results (oldest first, the bulk of any large request) are shortened to head + tail until the
 * body fits. The latest message is never touched. Mutates `params` in place.
 * A trim changes earlier messages, so the prompt cache misses once; a 413 would fail the turn.
 */
export function fitRunInfraRequestSize(
	params: { messages: WireMessage[]; tools?: unknown },
	maxRequestBytes: number | undefined,
): FitRequestResult {
	if (!maxRequestBytes || maxRequestBytes <= 0) return { trimmed: 0 };
	const limit = Math.floor(maxRequestBytes * SIZE_SAFETY);
	if (roughBodyBytes(params) <= limit) return { trimmed: 0 };
	let bytes = Buffer.byteLength(JSON.stringify(params));
	if (bytes <= limit) return { trimmed: 0, bytes };
	let trimmed = 0;
	const last = params.messages.length - 1;
	// Largest first within the oldest half, then the rest: few edits, big savings.
	const candidates = params.messages
		.map((message, index) => ({ message, index, size: textLength(message.content) }))
		.filter(({ message, index, size }) => index < last && message.role === "tool" && size > TRIM_KEEP_CHARS)
		.sort((a, b) => a.index - b.index);
	for (const { message } of candidates) {
		if (bytes <= limit) break;
		const before = Buffer.byteLength(JSON.stringify(message.content));
		if (typeof message.content === "string") {
			message.content = trimmedText(message.content, TRIM_KEEP_CHARS);
		} else if (Array.isArray(message.content)) {
			message.content = message.content.map((part) =>
				part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
					? { ...(part as object), text: trimmedText((part as { text: string }).text, TRIM_KEEP_CHARS) }
					: part,
			);
		}
		bytes -= before - Buffer.byteLength(JSON.stringify(message.content));
		trimmed++;
	}
	return { trimmed, bytes };
}

// ---------------------------------------------------------------------------------------------
// Client-side pacing (x-ratelimit-* headers, catalog max_concurrent_requests_per_api_key)
// ---------------------------------------------------------------------------------------------

/**
 * Parses a rate-limit reset header into milliseconds from `now`. RunInfra sends a Unix epoch in
 * seconds (`x-ratelimit-reset-requests: 1792178220`); OpenAI-style durations ("1s", "6m0s",
 * "250ms") and plain seconds are accepted too.
 */
export function parseRateLimitResetMs(value: string | null | undefined, now = Date.now()): number | undefined {
	if (!value) return undefined;
	const trimmed = value.trim();
	if (/^\d+(\.\d+)?$/.test(trimmed)) {
		const n = Number(trimmed);
		if (n > 1e12) return Math.max(0, n - now); // epoch ms
		if (n > 1e9) return Math.max(0, n * 1000 - now); // epoch s
		return n * 1000; // seconds from now
	}
	const parts = [...trimmed.matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/g)];
	if (parts.length === 0 || parts.map((p) => p[0]).join("") !== trimmed) return undefined;
	let ms = 0;
	for (const [, num, unit] of parts) {
		const n = Number(num);
		ms += unit === "ms" ? n : unit === "s" ? n * 1000 : unit === "m" ? n * 60_000 : n * 3_600_000;
	}
	return ms;
}

/** Longest a request waits client-side for a rate-limit window; beyond it the server decides. */
export const MAX_CLIENT_PACING_MS = 30_000;
/** Requests left in the window at or below which the next request waits for the reset. */
const PACING_REMAINING_FLOOR = 0;

interface GateState {
	active: number;
	waiters: Array<() => void>;
	/** Epoch ms before which new requests wait (window exhausted). */
	blockedUntil: number;
}

/**
 * One gate per RunInfra API key and model, process-wide: caps concurrent streams at the catalog's
 * `max_concurrent_requests_per_api_key` (subagents and parallel side calls share it) and holds new
 * requests when the last response said the request window is used up.
 */
export class RunInfraRequestGate {
	private readonly gates = new Map<string, GateState>();
	private readonly now: () => number;
	constructor(now: () => number = Date.now) {
		this.now = now;
	}

	private state(key: string): GateState {
		let state = this.gates.get(key);
		if (!state) {
			state = { active: 0, waiters: [], blockedUntil: 0 };
			this.gates.set(key, state);
		}
		return state;
	}

	/** Waits for a slot; resolves to a release function. */
	async acquire(key: string, maxConcurrent: number | undefined, signal?: AbortSignal): Promise<() => void> {
		const state = this.state(key);
		const wait = state.blockedUntil - this.now();
		if (wait > 0) await sleep(Math.min(wait, MAX_CLIENT_PACING_MS), signal);
		if (maxConcurrent && maxConcurrent > 0) {
			while (state.active >= maxConcurrent) {
				await new Promise<void>((resolve, reject) => {
					const onAbort = () => reject(signal?.reason ?? new Error("Request aborted"));
					signal?.addEventListener("abort", onAbort, { once: true });
					state.waiters.push(() => {
						signal?.removeEventListener("abort", onAbort);
						resolve();
					});
				});
			}
		}
		state.active++;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			state.active--;
			state.waiters.shift()?.();
		};
	}

	/** Reads x-ratelimit-remaining / -reset from a response. */
	observe(key: string, headers: Record<string, string>): void {
		const remainingRaw = headers["x-ratelimit-remaining-requests"] ?? headers["x-ratelimit-remaining"];
		if (remainingRaw === undefined) return;
		const remaining = Number(remainingRaw);
		if (!Number.isFinite(remaining) || remaining > PACING_REMAINING_FLOOR) return;
		const resetMs = parseRateLimitResetMs(
			headers["x-ratelimit-reset-requests"] ?? headers["x-ratelimit-reset"],
			this.now(),
		);
		if (resetMs === undefined) return;
		this.state(key).blockedUntil = this.now() + Math.min(resetMs, MAX_CLIENT_PACING_MS);
	}

	/** For tests. */
	activeCount(key: string): number {
		return this.gates.get(key)?.active ?? 0;
	}
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) return reject(signal.reason ?? new Error("Request aborted"));
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(signal?.reason ?? new Error("Request aborted"));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

/** The process-wide gate the RunInfra stream uses. */
export const runInfraRequestGate = new RunInfraRequestGate();

/** Gate key: the key's last 8 characters (never the whole key) plus the model id. */
export function runInfraGateKey(apiKey: string, modelId: string): string {
	return `${apiKey.slice(-8)}:${modelId}`;
}
