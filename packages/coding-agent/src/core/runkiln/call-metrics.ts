/**
 * Per-call speed metrics: time to first token, output tokens per second and prompt cache hit %.
 *
 * Every model call made through the session's stream function is observed without changing its
 * events. When the call ends, one JSON line is appended to `<agentDir>/logs/calls.jsonl` and
 * listeners (the footer) are notified. Cache hit % is `cached_tokens / prompt_tokens`, where
 * cached_tokens is `usage.prompt_tokens_details.cached_tokens` as reported by RunInfra.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	createAssistantMessageEventStream,
	type Model,
} from "@runkiln/ai";
import { getAgentDir } from "../../config.ts";

export type CallKind = "turn" | "title" | "compaction" | "other";

export interface CallMetrics {
	ts: string;
	kind: CallKind;
	model: string;
	sessionId?: string;
	parentSessionId?: string;
	/** Request start to first streamed token (text, thinking or tool call). */
	ttftMs?: number;
	/** Request start to end of stream. */
	durationMs: number;
	promptTokens: number;
	cachedTokens: number;
	/** cachedTokens / promptTokens * 100, rounded to 0.1. */
	cacheHitPct?: number;
	outputTokens: number;
	/** Output tokens per second between first and last token. */
	tokPerSec?: number;
	stopReason: string;
	error?: string;
}

type Listener = (metrics: CallMetrics) => void;
const listeners = new Set<Listener>();
let lastMetrics: CallMetrics | undefined;

export function onCallMetrics(listener: Listener): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function getLastCallMetrics(): CallMetrics | undefined {
	return lastMetrics;
}

export function getCallMetricsLogPath(agentDir: string = getAgentDir()): string {
	return join(agentDir, "logs", "calls.jsonl");
}

const round1 = (value: number) => Math.round(value * 10) / 10;

function record(metrics: CallMetrics, logPath: string): void {
	lastMetrics = metrics;
	try {
		mkdirSync(dirname(logPath), { recursive: true });
		appendFileSync(logPath, `${JSON.stringify(metrics)}\n`);
	} catch {
		// Metrics must never break a turn.
	}
	for (const listener of listeners) {
		try {
			listener(metrics);
		} catch {
			// Ignore listener failures.
		}
	}
}

export interface ObserveCallOptions {
	model: Model<Api>;
	kind: CallKind;
	sessionId?: string;
	parentSessionId?: string;
	/** Defaults to `<agentDir>/logs/calls.jsonl`. */
	logPath?: string;
}

/** Returns a stream with the same events as `source`, recording metrics when it ends. */
export function observeCallMetrics(
	source: AssistantMessageEventStream,
	options: ObserveCallOptions,
): AssistantMessageEventStream {
	const startedAt = performance.now();
	const out = createAssistantMessageEventStream();
	let firstTokenAt: number | undefined;
	let lastTokenAt: number | undefined;

	void (async () => {
		let final: { message: AssistantMessage; error?: string } | undefined;
		for await (const event of source) {
			if (event.type === "text_delta" || event.type === "thinking_delta" || event.type === "toolcall_delta") {
				const now = performance.now();
				firstTokenAt ??= now;
				lastTokenAt = now;
			} else if (event.type === "done") {
				final = { message: event.message };
			} else if (event.type === "error") {
				final = { message: event.error, error: event.error.errorMessage ?? "error" };
			}
			out.push(event);
		}
		out.end();

		const endedAt = performance.now();
		const usage = final?.message.usage;
		const promptTokens = usage ? usage.input + usage.cacheRead + usage.cacheWrite : 0;
		const cachedTokens = usage?.cacheRead ?? 0;
		const outputTokens = usage?.output ?? 0;
		const decodeMs = firstTokenAt !== undefined && lastTokenAt !== undefined ? lastTokenAt - firstTokenAt : 0;
		record(
			{
				ts: new Date().toISOString(),
				kind: options.kind,
				model: options.model.id,
				sessionId: options.sessionId,
				parentSessionId: options.parentSessionId,
				ttftMs: firstTokenAt !== undefined ? round1(firstTokenAt - startedAt) : undefined,
				durationMs: round1(endedAt - startedAt),
				promptTokens,
				cachedTokens,
				cacheHitPct: promptTokens > 0 ? round1((cachedTokens / promptTokens) * 100) : undefined,
				outputTokens,
				tokPerSec: outputTokens > 0 && decodeMs > 0 ? round1(outputTokens / (decodeMs / 1000)) : undefined,
				stopReason: final?.message.stopReason ?? "unknown",
				error: final?.error,
			},
			options.logPath ?? getCallMetricsLogPath(),
		);
	})();

	return out;
}
