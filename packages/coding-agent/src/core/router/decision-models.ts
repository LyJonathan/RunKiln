/**
 * OpenRouter decision models: the models that answer the Decisions / System One API (`POST /api/v1/systemone`)
 * with typed answers and probabilities instead of text. Only these may classify routes or judge permissions on
 * OpenRouter; chat models are never used for either.
 *
 * The list is live: `GET {base}/models?output_modalities=decisions` (public, no key), cached for 24 hours in
 * `<agentDir>/cache/openrouter-decision-models.json` like the RunInfra catalog. When neither the network nor the
 * cache has it, a short built-in list (the models we benched) stands in.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * The default OpenRouter classifier and permission judge. Chosen on router good-pick % and the 63-call
 * permission eval, then safety, latency and cost.
 */
export const OPENROUTER_DEFAULT_DECISION_MODEL = "typesafe/jev-1.14";

/** Benched decision models, used only when the live list and its cache are both unavailable. */
export const BUILTIN_DECISION_MODELS: readonly DecisionModelEntry[] = [
	{ id: "typesafe/jev-1.14", name: "TypeSafe: Jev 1.14", pricePerMTokIn: 0.042, contextLength: 262144 },
	{ id: "liquid/d1-ultra", name: "LiquidAI: d1-ultra", pricePerMTokIn: 0.042, contextLength: 32768 },
	{ id: "respan/span-02", name: "Respan: Span-02", pricePerMTokIn: 0.01, contextLength: 131072 },
];

/**
 * Chat models older builds offered as the OpenRouter classifier. A saved setting naming one is moved to the
 * default even when the live list cannot be read.
 */
export const LEGACY_CHAT_CLASSIFIER_MODELS: ReadonlySet<string> = new Set([
	"google/gemini-2.5-flash-lite",
	"google/gemini-2.0-flash-lite-001",
	"google/gemini-2.0-flash-001",
	"google/gemini-2.5-flash",
	"openai/gpt-4o-mini",
	"openai/gpt-4.1-nano",
	"openai/gpt-4.1-mini",
	"openai/gpt-5-nano",
	"openai/gpt-5-mini",
	"meta-llama/llama-3.1-8b-instruct",
	"mistralai/mistral-small",
	"qwen/qwen-2.5-7b-instruct",
	"anthropic/claude-3-haiku",
	"anthropic/claude-3.5-haiku",
]);

export interface DecisionModelEntry {
	id: string;
	name?: string;
	/** The dated build behind the id (`vendor/model-20261014`). */
	canonicalSlug?: string;
	/** Set on aliases (`~vendor/model-latest`): the model the alias resolves to now. */
	aliasOf?: string;
	/** USD per million input tokens (decision models bill no output). */
	pricePerMTokIn?: number;
	contextLength?: number;
	/** Unix seconds. */
	created?: number;
}

function num(value: unknown): number | undefined {
	const parsed = typeof value === "string" && value.trim() ? Number(value) : value;
	return typeof parsed === "number" && Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function str(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

const MODEL_ID = /^~?[A-Za-z0-9][\w.-]*\/[\w.:~-]+$/;

/**
 * Parses `GET /models?output_modalities=decisions`. Entries whose output modalities do not include `decisions`
 * are dropped (the filter is applied again here, so a server that ignores the query cannot slip a chat model in).
 */
export function parseDecisionModels(body: unknown): DecisionModelEntry[] {
	const data =
		body && typeof body === "object" && Array.isArray((body as { data?: unknown }).data)
			? ((body as { data: unknown[] }).data as unknown[])
			: undefined;
	if (!data) throw new Error("OpenRouter /models response has no data list");
	const entries: DecisionModelEntry[] = [];
	const seen = new Set<string>();
	for (const raw of data) {
		if (!raw || typeof raw !== "object") continue;
		const item = raw as Record<string, unknown>;
		const id = str(item.id);
		if (!id || id.length > 128 || !MODEL_ID.test(id) || seen.has(id)) continue;
		const architecture =
			item.architecture && typeof item.architecture === "object"
				? (item.architecture as Record<string, unknown>)
				: {};
		const outputs = Array.isArray(architecture.output_modalities) ? architecture.output_modalities : [];
		if (!outputs.includes("decisions")) continue;
		const pricing = item.pricing && typeof item.pricing === "object" ? (item.pricing as Record<string, unknown>) : {};
		const prompt = num(pricing.prompt);
		const alias =
			item.alias_target && typeof item.alias_target === "object"
				? str((item.alias_target as Record<string, unknown>).slug)
				: undefined;
		seen.add(id);
		entries.push({
			id,
			name: str(item.name),
			canonicalSlug: str(item.canonical_slug),
			...(alias ? { aliasOf: alias } : {}),
			pricePerMTokIn: prompt === undefined ? undefined : Math.round(prompt * 1e6 * 1e6) / 1e6,
			contextLength: num(item.context_length),
			created: num(item.created),
		});
	}
	return entries;
}

/**
 * Decision models in their bench order (router good picks + the 63-call permission eval, then safety, latency
 * and cost). The picker lists these first, so the measured picks are on top.
 */
export const BENCHED_DECISION_MODELS: readonly string[] = [
	"typesafe/jev-1.14",
	"perplexity/pplx-decider-v1.1-27b",
	"inception/mercury-decide",
	"typesafe/jev-1.13",
	"microsoft/microsoft-decision-1",
	"liquid/d1",
	"liquid/d1-ultra",
	"cloudflare/clef",
	"openai/gpt-6-luna-decisions",
	"togethercomputer/tev1-4b-experimental",
	"cloudflare/clef-flash",
	"nace-ai/drex-v2.0",
	"jaredpalmer/kev-4b",
	"upstage/solar-decide-flash",
	"cloudflare/clef-omni",
	"respan/span-02",
	"upstage/solar-decide",
	"nace-ai/drex-v1.5",
];

/**
 * Picker order: the default first, then the benched models in bench order, then the rest by price (cheapest first)
 * and newest, aliases last. Free (`:free`) variants share the paid model's build but are rate limited.
 */
export function sortDecisionModels(entries: readonly DecisionModelEntry[]): DecisionModelEntry[] {
	const benched = (entry: DecisionModelEntry) => {
		const index = BENCHED_DECISION_MODELS.indexOf(entry.id);
		return index < 0 ? Number.POSITIVE_INFINITY : index;
	};
	const rank = (entry: DecisionModelEntry) =>
		entry.id === OPENROUTER_DEFAULT_DECISION_MODEL
			? 0
			: entry.aliasOf || entry.id.startsWith("~")
				? 3
				: benched(entry) < Infinity
					? 1
					: 2;
	return [...entries].sort(
		(a, b) =>
			rank(a) - rank(b) ||
			(rank(a) === 1 ? benched(a) - benched(b) : 0) ||
			(a.pricePerMTokIn ?? Number.POSITIVE_INFINITY) - (b.pricePerMTokIn ?? Number.POSITIVE_INFINITY) ||
			(b.created ?? 0) - (a.created ?? 0) ||
			a.id.localeCompare(b.id),
	);
}

// ---------------------------------------------------------------------------------------------
// Cache (<agentDir>/cache/openrouter-decision-models.json)
// ---------------------------------------------------------------------------------------------

export const DECISION_MODELS_CACHE_FILE = join("cache", "openrouter-decision-models.json");
export const DECISION_MODELS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_SCHEMA = 1;

interface DecisionModelsCache {
	schema: number;
	fetchedAt: number;
	baseUrl: string;
	entries: DecisionModelEntry[];
}

export function getDecisionModelsCachePath(agentDir: string): string {
	return join(agentDir, DECISION_MODELS_CACHE_FILE);
}

/** Best effort and atomic. No key is stored (the list is public). */
export function saveDecisionModelsCache(
	path: string,
	baseUrl: string,
	entries: readonly DecisionModelEntry[],
	now = Date.now(),
): void {
	try {
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		const cache: DecisionModelsCache = { schema: CACHE_SCHEMA, fetchedAt: now, baseUrl, entries: [...entries] };
		const temp = `${path}.${process.pid}.tmp`;
		writeFileSync(temp, `${JSON.stringify(cache, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
		renameSync(temp, path);
	} catch {
		// Cache only.
	}
}

/** The cached list for this endpoint (any age), or undefined. Re-validated through the parser. */
export function loadDecisionModelsCache(
	path: string,
	baseUrl: string,
): { fetchedAt: number; entries: DecisionModelEntry[] } | undefined {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<DecisionModelsCache>;
		if (parsed.schema !== CACHE_SCHEMA || typeof parsed.fetchedAt !== "number" || !Number.isFinite(parsed.fetchedAt))
			return undefined;
		if (parsed.baseUrl !== baseUrl || !Array.isArray(parsed.entries)) return undefined;
		const entries = parseDecisionModels({
			data: parsed.entries.map((entry) => {
				const e = entry as Partial<DecisionModelEntry>;
				return {
					id: e.id,
					name: e.name,
					canonical_slug: e.canonicalSlug,
					alias_target: e.aliasOf ? { slug: e.aliasOf } : undefined,
					pricing: { prompt: e.pricePerMTokIn === undefined ? undefined : e.pricePerMTokIn / 1e6 },
					context_length: e.contextLength,
					created: e.created,
					architecture: { output_modalities: ["decisions"] },
				};
			}),
		});
		return { fetchedAt: parsed.fetchedAt, entries };
	} catch {
		return undefined;
	}
}

// ---------------------------------------------------------------------------------------------
// Fetch + resolve
// ---------------------------------------------------------------------------------------------

export const OPENROUTER_MODELS_BASE_URL = "https://openrouter.ai/api/v1";

export async function fetchDecisionModels(options: {
	baseUrl?: string;
	fetch?: typeof globalThis.fetch;
	timeoutMs?: number;
	signal?: AbortSignal;
}): Promise<DecisionModelEntry[]> {
	const base = (options.baseUrl ?? OPENROUTER_MODELS_BASE_URL).replace(/\/+$/, "");
	const timeout = AbortSignal.timeout(options.timeoutMs ?? 8000);
	const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
	const response = await (options.fetch ?? globalThis.fetch)(`${base}/models?output_modalities=decisions`, {
		method: "GET",
		headers: { Accept: "application/json" },
		redirect: "error",
		signal,
	});
	if (!response.ok) {
		await response.body?.cancel().catch(() => undefined);
		throw new Error(`OpenRouter /models answered ${response.status}`);
	}
	const entries = parseDecisionModels((await response.json()) as unknown);
	if (entries.length === 0) throw new Error("OpenRouter lists no decision models");
	return entries;
}

export type DecisionModelsSource = "live" | "cache" | "stale-cache" | "builtin";

export interface DecisionModelList {
	entries: DecisionModelEntry[];
	source: DecisionModelsSource;
	fetchedAt?: number;
}

/** The list without network: a cache of any age, else the built-in list. */
export function getCachedDecisionModels(
	agentDir: string,
	options: { baseUrl?: string; now?: number } = {},
): DecisionModelList {
	const base = (options.baseUrl ?? OPENROUTER_MODELS_BASE_URL).replace(/\/+$/, "");
	const cache = loadDecisionModelsCache(getDecisionModelsCachePath(agentDir), base);
	if (cache && cache.entries.length > 0) {
		const fresh = (options.now ?? Date.now()) - cache.fetchedAt < DECISION_MODELS_CACHE_TTL_MS;
		return {
			entries: sortDecisionModels(cache.entries),
			source: fresh ? "cache" : "stale-cache",
			fetchedAt: cache.fetchedAt,
		};
	}
	return { entries: sortDecisionModels(BUILTIN_DECISION_MODELS), source: "builtin" };
}

/** A fresh cache as is; else the live list (saved to the cache); on failure, the stale cache or built-in list. */
export async function getDecisionModels(
	agentDir: string,
	options: {
		baseUrl?: string;
		fetch?: typeof globalThis.fetch;
		now?: number;
		force?: boolean;
		signal?: AbortSignal;
		timeoutMs?: number;
	} = {},
): Promise<DecisionModelList> {
	const cached = getCachedDecisionModels(agentDir, options);
	if (!options.force && cached.source === "cache") return cached;
	const base = (options.baseUrl ?? OPENROUTER_MODELS_BASE_URL).replace(/\/+$/, "");
	try {
		const entries = await fetchDecisionModels({ ...options, baseUrl: base });
		const now = options.now ?? Date.now();
		saveDecisionModelsCache(getDecisionModelsCachePath(agentDir), base, entries, now);
		return { entries: sortDecisionModels(entries), source: "live", fetchedAt: now };
	} catch (error) {
		if (options.signal?.aborted) throw error;
		return cached;
	}
}

/**
 * Whether `id` may be used as the OpenRouter classifier: it is in the decision list. Without a real list (only the
 * built-in one), any id that is not a known chat model passes, so a new decision model can be named by hand.
 */
export function isDecisionModel(id: string, list: DecisionModelList): boolean {
	if (LEGACY_CHAT_CLASSIFIER_MODELS.has(id)) return false;
	if (list.source === "builtin") return true;
	const ids = new Set(
		list.entries.flatMap((entry) => [entry.id, ...(entry.canonicalSlug ? [entry.canonicalSlug] : [])]),
	);
	return ids.has(id);
}

/** Price and context, for picker hints: "$0.042/M - 262k ctx". */
export function decisionModelHint(entry: DecisionModelEntry): string {
	const parts: string[] = [];
	if (entry.pricePerMTokIn !== undefined)
		parts.push(entry.pricePerMTokIn === 0 ? "free" : `$${trimPrice(entry.pricePerMTokIn)}/M in`);
	if (entry.contextLength) parts.push(`${Math.round(entry.contextLength / 1024)}k ctx`);
	if (entry.aliasOf) parts.push(`alias of ${entry.aliasOf}`);
	if (entry.id === OPENROUTER_DEFAULT_DECISION_MODEL) parts.push("recommended");
	return parts.join(" - ");
}

function trimPrice(value: number): string {
	return value >= 0.1 ? value.toFixed(2) : value.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
}
