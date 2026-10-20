/**
 * RunInfra live catalog: GET {baseUrl}/models lists the model ids a key can call right now, with
 * availability, prices, context window, image input and reasoning efforts.
 *
 * models.yaml stays the source for what the API does not say (harness effort, roles, notes); the live
 * list decides which models exist for this key and carries current prices and limits. A model RunInfra
 * adds later is usable (and routable, with default scores) without a code or models.yaml change.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Model } from "@runkiln/ai";
import { RUNINFRA_PROVIDER_ID } from "@runkiln/ai/providers/runinfra";
import { buildThinkingLevelMap } from "./models-catalog.ts";

export interface LiveModelEntry {
	id: string;
	displayName?: string;
	availability: string;
	contextWindow?: number;
	maxOutputTokens?: number;
	priceIn?: number;
	priceOut?: number;
	priceCachedIn?: number;
	images?: boolean;
	reasoningEfforts: string[];
	defaultReasoningEffort?: string;
	toolCalling?: boolean;
	modality?: string;
	supportedEndpoints?: string[];
	/** Largest request body accepted (`max_request_bytes`). */
	maxRequestBytes?: number;
	/** Session affinity idle TTL (`session_affinity_idle_ttl_seconds`): the warm cache's lifetime. */
	sessionIdleTtlSeconds?: number;
	/** Longest a response may stream (`response_time_ceiling_seconds`). */
	responseTimeCeilingSeconds?: number;
	maxConcurrentRequests?: number;
	maxTokensPerMinute?: number;
}

export interface LiveCatalogMerge {
	models: Model<"openai-completions">[];
	/** Listed but paused: kept for manual picks, skipped by the router. */
	paused: string[];
	/** Live ids not in models.yaml (built from the live entry). */
	added: string[];
	/** models.yaml ids this key cannot reach (dropped). */
	missing: string[];
}

const DEFAULT_CONTEXT_WINDOW = 131072;
const DEFAULT_MAX_TOKENS = 16384;
const MAX_TOKENS_CAP = 32768;

function num(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function str(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function strings(value: unknown): string[] | undefined {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined;
}

/** Parses a GET /v1/models body. Entries without an id are skipped; a body without `data` is an error. */
export function parseLiveModels(body: unknown): LiveModelEntry[] {
	const data =
		body && typeof body === "object" && Array.isArray((body as { data?: unknown }).data)
			? ((body as { data: unknown[] }).data as unknown[])
			: undefined;
	if (!data) throw new Error("RunInfra /models response has no data list");
	const entries: LiveModelEntry[] = [];
	for (const raw of data) {
		if (!raw || typeof raw !== "object") continue;
		const item = raw as Record<string, unknown>;
		const id = str(item.id);
		if (!id) continue;
		const pricing = item.pricing && typeof item.pricing === "object" ? (item.pricing as Record<string, unknown>) : {};
		const modalities = strings(item.input_modalities);
		entries.push({
			id,
			displayName: str(item.display_name),
			availability: str(item.availability) ?? "available",
			contextWindow: num(item.context_window) ?? num(item.context_length),
			maxOutputTokens: num(item.max_completion_tokens) ?? num(item.max_output_tokens),
			priceIn: num(pricing.input),
			priceOut: num(pricing.output),
			priceCachedIn: num(item.cached_input_price) ?? num(item.cached_input_price_usd_per_mtok),
			images: modalities ? modalities.includes("image") : undefined,
			reasoningEfforts: strings(item.reasoning_efforts) ?? [],
			defaultReasoningEffort: str(item.default_reasoning_effort),
			toolCalling: typeof item.tool_calling === "boolean" ? item.tool_calling : undefined,
			modality: str(item.modality),
			supportedEndpoints: strings(item.supported_endpoints),
			maxRequestBytes: num(item.max_request_bytes),
			sessionIdleTtlSeconds: num(item.session_affinity_idle_ttl_seconds),
			responseTimeCeilingSeconds: num(item.response_time_ceiling_seconds),
			maxConcurrentRequests: num(item.max_concurrent_requests_per_api_key),
			maxTokensPerMinute: num(item.max_tokens_per_minute_per_workspace),
		});
	}
	return entries;
}

/**
 * Service limits, request-size cap and cache lifetime from a live entry, in the shape the RunInfra
 * stream reads (`serviceLimits`, `inputLimits.maxRequestBytes`, `promptCache.short`).
 */
export function liveLimitFields(
	entry: LiveModelEntry,
	model?: Pick<Model<"openai-completions">, "inputLimits" | "promptCache" | "serviceLimits">,
): Pick<Model<"openai-completions">, "inputLimits" | "promptCache" | "serviceLimits"> {
	const serviceLimits = {
		...model?.serviceLimits,
		...(entry.maxOutputTokens !== undefined ? { maxOutputTokens: entry.maxOutputTokens } : {}),
		...(entry.responseTimeCeilingSeconds !== undefined
			? { responseTimeLimitMs: entry.responseTimeCeilingSeconds * 1000 }
			: {}),
		...(entry.maxConcurrentRequests !== undefined ? { maxConcurrentRequests: entry.maxConcurrentRequests } : {}),
		...(entry.maxTokensPerMinute !== undefined ? { maxTokensPerMinute: entry.maxTokensPerMinute } : {}),
		...(entry.sessionIdleTtlSeconds !== undefined ? { sessionIdleTtlMs: entry.sessionIdleTtlSeconds * 1000 } : {}),
	};
	const out: Pick<Model<"openai-completions">, "inputLimits" | "promptCache" | "serviceLimits"> = {};
	if (Object.keys(serviceLimits).length > 0) out.serviceLimits = serviceLimits;
	if (entry.maxRequestBytes !== undefined || model?.inputLimits) {
		out.inputLimits = {
			...model?.inputLimits,
			...(entry.maxRequestBytes !== undefined ? { maxRequestBytes: entry.maxRequestBytes } : {}),
		};
	}
	if (entry.sessionIdleTtlSeconds !== undefined || model?.promptCache) {
		out.promptCache = {
			...model?.promptCache,
			...(entry.sessionIdleTtlSeconds !== undefined ? { short: entry.sessionIdleTtlSeconds } : {}),
		};
	}
	return out;
}

function isChatModel(entry: LiveModelEntry): boolean {
	if (entry.modality !== undefined && entry.modality !== "llm") return false;
	if (entry.supportedEndpoints !== undefined && !entry.supportedEndpoints.includes("chat_completions")) return false;
	return true;
}

function fromLiveEntry(entry: LiveModelEntry, baseUrl: string): Model<"openai-completions"> {
	const harness = entry.defaultReasoningEffort;
	const efforts = [...new Set([...entry.reasoningEfforts, ...(harness ? [harness] : [])])];
	const thinkingLevelMap = buildThinkingLevelMap(efforts);
	return {
		id: entry.id,
		name: entry.displayName ?? entry.id,
		api: "openai-completions",
		provider: RUNINFRA_PROVIDER_ID,
		baseUrl,
		reasoning: thinkingLevelMap !== undefined,
		reasoningEffort: harness,
		...(thinkingLevelMap ? { thinkingLevelMap } : {}),
		input: entry.images ? ["text", "image"] : ["text"],
		cost: {
			input: entry.priceIn ?? 0,
			output: entry.priceOut ?? 0,
			cacheRead: entry.priceCachedIn ?? 0,
			cacheWrite: 0,
		},
		contextWindow: entry.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
		maxTokens: Math.min(entry.maxOutputTokens ?? DEFAULT_MAX_TOKENS, MAX_TOKENS_CAP),
		...liveLimitFields(entry),
	};
}

/**
 * The model list for a key: models.yaml entries the key can reach (with live prices and limits when
 * given), plus live chat models models.yaml does not know. Order: models.yaml first, then new ones.
 */
export function mergeLiveCatalog(
	staticModels: readonly Model<"openai-completions">[],
	live: readonly LiveModelEntry[],
	baseUrl: string,
): LiveCatalogMerge {
	const chat = live.filter(isChatModel);
	const byId = new Map(chat.map((entry) => [entry.id, entry]));
	const models: Model<"openai-completions">[] = [];
	const missing: string[] = [];
	for (const model of staticModels) {
		const entry = byId.get(model.id);
		if (!entry) {
			missing.push(model.id);
			continue;
		}
		// Live reasoning_efforts are the levels RunInfra measured as distinct; they win over models.yaml.
		const efforts =
			entry.reasoningEfforts.length > 0
				? [...new Set([...entry.reasoningEfforts, ...(model.reasoningEffort ? [model.reasoningEffort] : [])])]
				: undefined;
		const liveMap = efforts ? buildThinkingLevelMap(efforts) : undefined;
		const { thinkingLevelMap: _staticMap, ...rest } = model;
		const thinking = efforts
			? { reasoning: liveMap !== undefined, ...(liveMap ? { thinkingLevelMap: liveMap } : {}) }
			: {
					reasoning: model.reasoning,
					...(model.thinkingLevelMap ? { thinkingLevelMap: model.thinkingLevelMap } : {}),
				};
		models.push({
			...rest,
			...thinking,
			name: model.name || entry.displayName || model.id,
			input: entry.images === undefined ? model.input : entry.images ? ["text", "image"] : ["text"],
			cost: {
				input: entry.priceIn ?? model.cost.input,
				output: entry.priceOut ?? model.cost.output,
				cacheRead: entry.priceCachedIn ?? model.cost.cacheRead,
				cacheWrite: model.cost.cacheWrite,
			},
			contextWindow: entry.contextWindow ?? model.contextWindow,
			// The live limit only lowers the request cap: models.yaml's max_tokens is the harness default.
			// Deep-thinking turns may go above it up to serviceLimits.maxOutputTokens (runInfraMaxTokens).
			maxTokens:
				entry.maxOutputTokens !== undefined ? Math.min(model.maxTokens, entry.maxOutputTokens) : model.maxTokens,
			...liveLimitFields(entry, model),
		});
	}
	const known = new Set(staticModels.map((model) => model.id));
	const added: string[] = [];
	for (const entry of chat) {
		if (known.has(entry.id)) continue;
		models.push(fromLiveEntry(entry, baseUrl));
		added.push(entry.id);
	}
	const paused = chat.filter((entry) => entry.availability !== "available").map((entry) => entry.id);
	return { models, paused, added, missing };
}

// ---------------------------------------------------------------------------------------------
// On-disk cache of the live catalog (<agentDir>/cache/runinfra-catalog.json)
// ---------------------------------------------------------------------------------------------

/** Cache file under the agent directory. Separate from the /models screen's cache (other fields). */
export const LIVE_CATALOG_CACHE_FILE = join("cache", "runinfra-catalog.json");
/** How long a cached catalog is used without asking RunInfra again. */
export const LIVE_CATALOG_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
// 2: limits (request bytes, session idle TTL, response ceiling, rate limits) are cached too.
const CACHE_SCHEMA = 2;

export interface LiveCatalogCache {
	schema: number;
	fetchedAt: number;
	baseUrl: string;
	entries: LiveModelEntry[];
}

export function getLiveCatalogCachePath(agentDir: string): string {
	return join(agentDir, LIVE_CATALOG_CACHE_FILE);
}

/** Best effort and atomic (temp file + rename): a failed write never breaks startup. No key is stored. */
export function saveLiveCatalogCache(
	path: string,
	baseUrl: string,
	entries: readonly LiveModelEntry[],
	now = Date.now(),
): void {
	try {
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		const cache: LiveCatalogCache = { schema: CACHE_SCHEMA, fetchedAt: now, baseUrl, entries: [...entries] };
		const temp = `${path}.${process.pid}.tmp`;
		writeFileSync(temp, `${JSON.stringify(cache, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
		renameSync(temp, path);
	} catch {
		// Cache only.
	}
}

/** The cached catalog for this endpoint, or undefined (missing, unreadable, other schema or endpoint). */
export function loadLiveCatalogCache(path: string, baseUrl: string): LiveCatalogCache | undefined {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<LiveCatalogCache>;
		if (
			parsed.schema !== CACHE_SCHEMA ||
			typeof parsed.fetchedAt !== "number" ||
			!Number.isFinite(parsed.fetchedAt)
		) {
			return undefined;
		}
		if (parsed.baseUrl !== baseUrl || !Array.isArray(parsed.entries)) return undefined;
		// Re-validate through the parser's field checks (a hand-edited file cannot inject odd values).
		const entries = parseLiveModels({
			data: parsed.entries.map((entry) => toWireShape(entry as Partial<LiveModelEntry>)),
		});
		return { schema: CACHE_SCHEMA, fetchedAt: parsed.fetchedAt, baseUrl, entries };
	} catch {
		return undefined;
	}
}

/** A cached entry back in the /models wire shape, so {@link parseLiveModels} validates it again. */
function toWireShape(entry: Partial<LiveModelEntry>): Record<string, unknown> {
	return {
		id: entry.id,
		display_name: entry.displayName,
		availability: entry.availability,
		context_window: entry.contextWindow,
		max_completion_tokens: entry.maxOutputTokens,
		pricing: { input: entry.priceIn, output: entry.priceOut },
		cached_input_price: entry.priceCachedIn,
		input_modalities: entry.images === undefined ? undefined : entry.images ? ["text", "image"] : ["text"],
		reasoning_efforts: entry.reasoningEfforts,
		default_reasoning_effort: entry.defaultReasoningEffort,
		tool_calling: entry.toolCalling,
		modality: entry.modality,
		supported_endpoints: entry.supportedEndpoints,
		max_request_bytes: entry.maxRequestBytes,
		session_affinity_idle_ttl_seconds: entry.sessionIdleTtlSeconds,
		response_time_ceiling_seconds: entry.responseTimeCeilingSeconds,
		max_concurrent_requests_per_api_key: entry.maxConcurrentRequests,
		max_tokens_per_minute_per_workspace: entry.maxTokensPerMinute,
	};
}

// ---------------------------------------------------------------------------------------------
// router.yaml catalog overrides (models.<id>.catalog), applied over the live values
// ---------------------------------------------------------------------------------------------

/** Per-model values that beat both models.yaml and the live catalog (router.yaml `models.<id>.catalog`). */
export interface CatalogOverride {
	priceIn?: number;
	priceOut?: number;
	priceCachedIn?: number;
	contextWindow?: number;
	maxOutputTokens?: number;
	/** reasoning_effort values the model accepts (replaces the live/models.yaml list). */
	reasoningEfforts?: string[];
}

export function applyCatalogOverrides(
	models: readonly Model<"openai-completions">[],
	overrides: Readonly<Record<string, CatalogOverride>>,
): Model<"openai-completions">[] {
	return models.map((model) => {
		const override = overrides[model.id];
		if (!override) return model;
		const next: Model<"openai-completions"> = {
			...model,
			cost: {
				input: override.priceIn ?? model.cost.input,
				output: override.priceOut ?? model.cost.output,
				cacheRead: override.priceCachedIn ?? model.cost.cacheRead,
				cacheWrite: model.cost.cacheWrite,
			},
			contextWindow: override.contextWindow ?? model.contextWindow,
			maxTokens: override.maxOutputTokens ?? model.maxTokens,
			// A pinned max_output is also the ceiling for deep-thinking turns.
			...(override.maxOutputTokens !== undefined
				? { serviceLimits: { ...model.serviceLimits, maxOutputTokens: override.maxOutputTokens } }
				: {}),
		};
		if (override.reasoningEfforts) {
			const efforts = [
				...new Set([...override.reasoningEfforts, ...(model.reasoningEffort ? [model.reasoningEffort] : [])]),
			];
			const map = buildThinkingLevelMap(efforts);
			const { thinkingLevelMap: _old, ...rest } = next;
			return { ...rest, reasoning: map !== undefined, ...(map ? { thinkingLevelMap: map } : {}) };
		}
		return next;
	});
}
