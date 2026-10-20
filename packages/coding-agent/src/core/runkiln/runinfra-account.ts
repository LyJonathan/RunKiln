/**
 * RunInfra account helpers: where the key comes from, removing it, live checks against
 * `GET /models` and `GET /credits`, friendly error text, and a small on-disk catalog cache.
 *
 * Nothing here logs or returns the key, request headers, or a response body. Error text is built
 * from the HTTP status, the documented `error.code`, and `Retry-After` only.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RUNINFRA_API_KEY_ENV } from "@runkiln/ai/providers/runinfra";
import type { CatalogModel, ModelsCatalog } from "./models-catalog.ts";
import { getRunInfraConfigPath, loadRunInfraConfig } from "./runinfra-config.ts";

/** Where a workspace API key is created. */
export const RUNINFRA_API_KEYS_URL = "https://runinfra.ai/settings/api-keys";
/** Where credits are topped up. */
export const RUNINFRA_TOPUP_URL = "https://runinfra.ai/settings/cost#credits";

// ---------------------------------------------------------------------------------------------
// Key source
// ---------------------------------------------------------------------------------------------

export type RunInfraKeySource = "environment" | "config" | "none";

export interface RunInfraKeyStatus {
	source: RunInfraKeySource;
	/** One line for the UI. Never contains the key. */
	label: string;
	/** True when a key is saved in runinfra.json (even if the env var overrides it). */
	hasSavedKey: boolean;
}

/** `RUNINFRA_API_KEY` wins over `runinfra.json`, matching the provider's own resolution order. */
export function getRunInfraKeyStatus(agentDir: string, env: NodeJS.ProcessEnv = process.env): RunInfraKeyStatus {
	let hasSavedKey = false;
	try {
		hasSavedKey = !!loadRunInfraConfig(agentDir).apiKey;
	} catch {
		hasSavedKey = false;
	}
	if (env[RUNINFRA_API_KEY_ENV]?.trim()) {
		return {
			source: "environment",
			label: hasSavedKey
				? `${RUNINFRA_API_KEY_ENV} (environment, overrides the saved key)`
				: `${RUNINFRA_API_KEY_ENV} (environment)`,
			hasSavedKey,
		};
	}
	if (hasSavedKey) return { source: "config", label: "saved in ~/.runkiln/agent/runinfra.json", hasSavedKey };
	return { source: "none", label: "no key", hasSavedKey };
}

/** The key the provider would use right now, or undefined. Callers must not print it. */
export function getActiveRunInfraKey(agentDir: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
	const envKey = env[RUNINFRA_API_KEY_ENV]?.trim();
	if (envKey) return envKey;
	try {
		return loadRunInfraConfig(agentDir).apiKey;
	} catch {
		return undefined;
	}
}

/**
 * Drop `apiKey` from runinfra.json, keeping every other field (such as `baseUrl`).
 * Deletes the file when nothing else is left. Returns true when a key was removed.
 */
export function removeRunInfraApiKey(agentDir: string): boolean {
	const path = getRunInfraConfigPath(agentDir);
	if (!existsSync(path)) return false;
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		throw new Error("could not read runinfra.json");
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("could not read runinfra.json");
	const record = { ...(parsed as Record<string, unknown>) };
	if (!("apiKey" in record)) return false;
	delete record.apiKey;
	if (Object.keys(record).length === 0) {
		rmSync(path, { force: true });
	} else {
		writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	}
	return true;
}

// ---------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------

export interface RunInfraFailure {
	/** HTTP status, or undefined when the request never got an answer. */
	status?: number;
	/** Documented `error.code`, when the body was the JSON error envelope. */
	code?: string;
	/** Seconds from `Retry-After`. */
	retryAfterSeconds?: number;
}

/** Short, fixed text for a failed RunInfra call. No body, headers, or key. */
export function describeRunInfraFailure(failure: RunInfraFailure): string {
	const { status, code, retryAfterSeconds } = failure;
	const retry = retryAfterSeconds !== undefined ? ` Retry in ${retryAfterSeconds}s.` : " Try again shortly.";
	if (status === undefined) return "Couldn't reach RunInfra. Check your connection.";
	if (status === 401) return "invalid key: RunInfra rejected it (wrong, revoked or expired).";
	if (status === 403) {
		if (code === "credits_scope_violation" || code === "usage_scope_violation") {
			return "This key is scoped to one deployment. Use a workspace key.";
		}
		return "Key refused (403): deactivated, or not a workspace key.";
	}
	if (status === 402) {
		if (code === "spend_limit_reached") return "This key hit its monthly spending limit (402).";
		if (code === "plan_limit_reached") return "Coding plan limit reached (402).";
		if (code === "account_frozen") return "Workspace billing is on hold (402).";
		return `Out of credits (402). Top up at ${RUNINFRA_TOPUP_URL}`;
	}
	if (status === 429) return `Rate limited by RunInfra (429).${retry}`;
	if (status === 503 && code === "hosted_model_paused") return `Model paused (503).${retry}`;
	if (status >= 500) return `RunInfra error ${status}.${retry}`;
	return `RunInfra answered ${status}.`;
}

/**
 * A hint for a chat error that came back from RunInfra, keyed off the status at the start of the
 * provider message ("401 ...") or a documented error code inside it. Undefined when nothing fits.
 */
export function runInfraErrorHint(errorMessage: string | undefined): string | undefined {
	if (!errorMessage) return undefined;
	const statusMatch = /^\s*(?:Error:\s*)?(\d{3})\b/.exec(errorMessage);
	const status = statusMatch ? Number(statusMatch[1]) : undefined;
	const has = (pattern: RegExp) => pattern.test(errorMessage);
	if (status === 401 || has(/\binvalid_api_key\b/))
		return `${describeRunInfraFailure({ status: 401 })} Replace it in /setup keys.`;
	if (status === 403 && has(/\bauth_error\b|deactivated|internal/i)) {
		return `${describeRunInfraFailure({ status: 403 })} Replace it in /setup keys.`;
	}
	if (status === 402 || has(/\binsufficient_credits\b/)) return describeRunInfraFailure({ status: 402 });
	if (status === 429 || has(/\brate_limit_exceeded\b/)) return describeRunInfraFailure({ status: 429 });
	return undefined;
}

function parseRetryAfter(headers: Headers): number | undefined {
	const value = headers.get("retry-after");
	if (!value) return undefined;
	const seconds = Number(value);
	if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
	const date = Date.parse(value);
	if (Number.isFinite(date)) return Math.max(0, Math.ceil((date - Date.now()) / 1000));
	return undefined;
}

async function readErrorCode(response: Response): Promise<string | undefined> {
	try {
		const body = (await response.json()) as unknown;
		const error = body && typeof body === "object" ? (body as Record<string, unknown>).error : undefined;
		const code = error && typeof error === "object" ? (error as Record<string, unknown>).code : undefined;
		return typeof code === "string" && /^[a-z_]{1,64}$/.test(code) ? code : undefined;
	} catch {
		return undefined;
	}
}

// ---------------------------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------------------------

export type RunInfraGetResult = { ok: true; body: unknown } | { ok: false; failure: RunInfraFailure; message: string };

function endpointUrl(baseUrl: string, path: string): string {
	const withSlash = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
	return new URL(path, withSlash).toString();
}

/** `GET {baseUrl}/{path}` with the key only in the Authorization header. */
export async function runInfraGet(options: {
	baseUrl: string;
	apiKey: string;
	path: string;
	fetchImpl?: typeof fetch;
	timeoutMs?: number;
}): Promise<RunInfraGetResult> {
	const fetchImpl = options.fetchImpl ?? fetch;
	const signal = AbortSignal.timeout(options.timeoutMs ?? 15_000);
	let response: Response;
	try {
		response = await fetchImpl(endpointUrl(options.baseUrl, options.path), {
			method: "GET",
			headers: { Authorization: `Bearer ${options.apiKey}` },
			redirect: "error",
			signal,
		});
	} catch {
		const failure: RunInfraFailure = {};
		return { ok: false, failure, message: describeRunInfraFailure(failure) };
	}
	if (!response.ok) {
		const failure: RunInfraFailure = {
			status: response.status,
			code: await readErrorCode(response),
			retryAfterSeconds: parseRetryAfter(response.headers),
		};
		return { ok: false, failure, message: describeRunInfraFailure(failure) };
	}
	try {
		return { ok: true, body: (await response.json()) as unknown };
	} catch {
		return { ok: false, failure: { status: response.status }, message: "RunInfra sent an invalid response." };
	}
}

// ---------------------------------------------------------------------------------------------
// Account status (GET /credits)
// ---------------------------------------------------------------------------------------------

export interface RunInfraAccountStatus {
	availableCents: number;
	balanceCents?: number;
	periodSpentCents?: number;
	planTier?: string;
}

export function parseCredits(body: unknown): RunInfraAccountStatus | undefined {
	if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
	const record = body as Record<string, unknown>;
	const int = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
	const available = int(record.available_cents) ?? int(record.balance_cents);
	if (available === undefined) return undefined;
	const period = record.period && typeof record.period === "object" ? (record.period as Record<string, unknown>) : {};
	const tier =
		typeof record.plan_tier === "string" && /^[a-z0-9_-]{1,24}$/i.test(record.plan_tier)
			? record.plan_tier
			: undefined;
	return {
		availableCents: Math.max(0, available),
		balanceCents: int(record.balance_cents),
		periodSpentCents: int(period.spent_cents),
		planTier: tier,
	};
}

export function formatUsd(cents: number): string {
	return `$${(cents / 100).toFixed(2)}`;
}

export function formatAccountStatus(status: RunInfraAccountStatus): string {
	const parts = [`${formatUsd(status.availableCents)} available`];
	if (status.periodSpentCents !== undefined) parts.push(`${formatUsd(status.periodSpentCents)} spent this period`);
	if (status.planTier) parts.push(`tier ${status.planTier}`);
	return parts.join(" - ");
}

export async function fetchRunInfraAccount(options: {
	baseUrl: string;
	apiKey: string;
	fetchImpl?: typeof fetch;
}): Promise<{ ok: true; status: RunInfraAccountStatus } | { ok: false; message: string; failure?: RunInfraFailure }> {
	const result = await runInfraGet({ ...options, path: "credits" });
	if (!result.ok) return { ok: false, message: result.message, failure: result.failure };
	const status = parseCredits(result.body);
	return status ? { ok: true, status } : { ok: false, message: "No account details in the response." };
}

// ---------------------------------------------------------------------------------------------
// Remote catalog (GET /models) and its cache
// ---------------------------------------------------------------------------------------------

/** The `/models` fields RunKiln uses. Unknown fields are dropped before caching. */
export interface RemoteModelInfo {
	id: string;
	name?: string;
	availability?: "available" | "paused";
	pausedUntil?: string;
	priceIn?: number;
	priceOut?: number;
	cachedIn?: number;
	context?: number;
	vision?: boolean;
	reasoningEfforts?: string[];
	defaultReasoningEffort?: string;
	/** False for an entry that is not a chat model (embeddings, rerank). */
	chat?: boolean;
}

const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
const str = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : undefined);

function isUnavailableEntry(entry: Record<string, unknown>): boolean {
	if (entry.paused === true || entry.available === false || entry.enabled === false) return true;
	for (const field of ["status", "state", "availability"]) {
		const value = entry[field];
		if (typeof value === "string" && /paused|unavailable|disabled/i.test(value)) return true;
	}
	return false;
}

function isChatEntry(entry: Record<string, unknown>): boolean | undefined {
	const modality = str(entry.modality);
	const endpoints = Array.isArray(entry.supported_endpoints) ? entry.supported_endpoints : undefined;
	if (modality === undefined && endpoints === undefined) return undefined;
	if (modality !== undefined && modality !== "llm") return false;
	return endpoints === undefined || endpoints.includes("chat_completions");
}

/** Parse a `/models` body (OpenAI list shape or a bare array). */
export function parseRemoteModels(body: unknown): RemoteModelInfo[] {
	const root =
		body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : undefined;
	const data = Array.isArray(body) ? body : Array.isArray(root?.data) ? root.data : [];
	const models: RemoteModelInfo[] = [];
	for (const item of data) {
		if (!item || typeof item !== "object" || Array.isArray(item)) continue;
		const entry = item as Record<string, unknown>;
		const id = str(entry.id);
		if (!id) continue;
		const pricing = (entry.pricing ?? entry.price) as Record<string, unknown> | undefined;
		const price = pricing && typeof pricing === "object" && !Array.isArray(pricing) ? pricing : {};
		const modalities = Array.isArray(entry.input_modalities) ? entry.input_modalities : undefined;
		const efforts = Array.isArray(entry.reasoning_efforts)
			? entry.reasoning_efforts.filter((value): value is string => typeof value === "string")
			: undefined;
		models.push({
			id,
			name: str(entry.display_name),
			availability: isUnavailableEntry(entry) ? "paused" : "available",
			pausedUntil: str(entry.paused_until),
			priceIn: num(price.input ?? price.in ?? price.prompt),
			priceOut: num(price.output ?? price.out ?? price.completion),
			cachedIn: num(entry.cached_input_price ?? price.cached_in),
			context: num(entry.context_window ?? entry.context_length),
			vision: modalities ? modalities.includes("image") : undefined,
			reasoningEfforts: efforts,
			defaultReasoningEffort: str(entry.default_reasoning_effort),
			chat: isChatEntry(entry),
		});
	}
	return models;
}

export const CATALOG_CACHE_FILE = join("cache", "runinfra-models.json");

export interface CatalogCache {
	fetchedAt: number;
	baseUrl: string;
	models: RemoteModelInfo[];
}

export function getCatalogCachePath(agentDir: string): string {
	return join(agentDir, CATALOG_CACHE_FILE);
}

/** Best effort: a failed write never breaks setup or the models screen. */
export function saveCatalogCache(agentDir: string, baseUrl: string, models: RemoteModelInfo[], now = Date.now()): void {
	try {
		mkdirSync(join(agentDir, "cache"), { recursive: true, mode: 0o700 });
		const cache: CatalogCache = { fetchedAt: now, baseUrl, models };
		writeFileSync(getCatalogCachePath(agentDir), `${JSON.stringify(cache, null, 2)}\n`, {
			encoding: "utf8",
			mode: 0o600,
		});
	} catch {
		// Cache only.
	}
}

export function loadCatalogCache(agentDir: string, baseUrl?: string): CatalogCache | undefined {
	try {
		const parsed = JSON.parse(readFileSync(getCatalogCachePath(agentDir), "utf8")) as Partial<CatalogCache>;
		if (typeof parsed.fetchedAt !== "number" || !Array.isArray(parsed.models)) return undefined;
		if (baseUrl && parsed.baseUrl !== baseUrl) return undefined;
		return {
			fetchedAt: parsed.fetchedAt,
			baseUrl: String(parsed.baseUrl ?? ""),
			models: parseRemoteModels(parsed.models),
		};
	} catch {
		return undefined;
	}
}

export type CatalogSource = "live" | "cache" | "bundled";

export interface LoadedCatalog {
	source: CatalogSource;
	models: RemoteModelInfo[];
	fetchedAt?: number;
	/** Why the live fetch failed, when it did. */
	error?: string;
	failure?: RunInfraFailure;
}

/**
 * Live `/models` first (and refresh the cache), then the cache, then nothing (the caller falls back to
 * models.yaml). Without a key, goes straight to the cache.
 */
export async function loadRunInfraCatalog(options: {
	agentDir: string;
	baseUrl: string;
	apiKey: string | undefined;
	fetchImpl?: typeof fetch;
	offline?: boolean;
}): Promise<LoadedCatalog> {
	let error: string | undefined;
	let failure: RunInfraFailure | undefined;
	if (options.apiKey && !options.offline) {
		const result = await runInfraGet({
			baseUrl: options.baseUrl,
			apiKey: options.apiKey,
			path: "models",
			fetchImpl: options.fetchImpl,
		});
		if (result.ok) {
			const models = parseRemoteModels(result.body);
			saveCatalogCache(options.agentDir, options.baseUrl, models);
			return { source: "live", models, fetchedAt: Date.now() };
		}
		error = result.message;
		failure = result.failure;
	} else if (!options.apiKey) {
		error = "No RunInfra key.";
	}
	const cache = loadCatalogCache(options.agentDir, options.baseUrl);
	if (cache) return { source: "cache", models: cache.models, fetchedAt: cache.fetchedAt, error, failure };
	return { source: "bundled", models: [], error, failure };
}

export function formatAge(fetchedAt: number, now = Date.now()): string {
	const seconds = Math.max(0, Math.round((now - fetchedAt) / 1000));
	if (seconds < 60) return "just now";
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.round(minutes / 60);
	if (hours < 48) return `${hours}h ago`;
	return `${Math.round(hours / 24)}d ago`;
}

// ---------------------------------------------------------------------------------------------
// Model rows for the /models screen, and the disabledModels filter
// ---------------------------------------------------------------------------------------------

export interface ModelRow {
	id: string;
	name: string;
	priceIn?: number;
	priceOut?: number;
	context?: number;
	vision: boolean;
	/** Thinking levels (`reasoning_effort` values) the model supports. */
	efforts: string[];
	/** The effort RunKiln sends today (models.yaml `harness_effort`). */
	harnessEffort?: string;
	/** "unlisted" means the live or cached catalog did not include it for this key. */
	status: "available" | "paused" | "unlisted" | "unknown";
	pausedUntil?: string;
	enabled: boolean;
	/** No quality curves yet: auto routing uses it only when no benched model fits. */
	unbenched?: boolean;
	/** Listed by RunInfra but not in models.yaml (built from the live entry). */
	newInCatalog?: boolean;
}

/**
 * Catalog order (models.yaml), then chat models RunInfra lists that models.yaml does not. Remote values win
 * where the server reported them. `unbenched` marks models without quality curves.
 */
export function buildModelRows(
	catalog: ModelsCatalog,
	remote: readonly RemoteModelInfo[] | undefined,
	disabledModels: readonly string[],
	unbenched: readonly string[] = [],
): ModelRow[] {
	const disabled = new Set(disabledModels);
	const unbenchedIds = new Set(unbenched);
	const byId = new Map((remote ?? []).map((model) => [model.id, model]));
	const haveRemote = (remote?.length ?? 0) > 0;
	const known = new Set(catalog.models.map((model) => model.id));
	const extra: ModelRow[] = (remote ?? [])
		.filter((model) => !known.has(model.id) && model.chat !== false)
		.map((live) => ({
			id: live.id,
			name: live.name ?? live.id,
			priceIn: live.priceIn,
			priceOut: live.priceOut,
			context: live.context,
			vision: live.vision ?? false,
			efforts: live.reasoningEfforts ?? [],
			harnessEffort: live.defaultReasoningEffort,
			status: live.availability ?? "available",
			pausedUntil: live.pausedUntil,
			enabled: !disabled.has(live.id),
			// A model models.yaml does not know has no curves in router.yaml either, unless a user file adds them.
			unbenched: unbenched.length === 0 ? true : unbenchedIds.has(live.id),
			newInCatalog: true,
		}));
	return [
		...catalog.models.map((model: CatalogModel) => {
			const chat = catalog.chatModels.find((entry) => entry.id === model.id);
			const live = byId.get(model.id);
			const status: ModelRow["status"] = !haveRemote
				? "unknown"
				: !live
					? "unlisted"
					: (live.availability ?? "available");
			return {
				id: model.id,
				name: live?.name ?? model.name,
				priceIn: live?.priceIn ?? chat?.cost.input,
				priceOut: live?.priceOut ?? chat?.cost.output,
				context: live?.context ?? chat?.contextWindow,
				vision: live?.vision ?? chat?.input.includes("image") ?? false,
				efforts: live?.reasoningEfforts?.length ? live.reasoningEfforts : model.reasoningEfforts,
				harnessEffort: model.reasoningEffort,
				status,
				pausedUntil: live?.pausedUntil,
				enabled: !disabled.has(model.id),
				unbenched: unbenchedIds.has(model.id),
			};
		}),
		...extra,
	];
}

/** Clean a `disabledModels` value read from settings: strings only, trimmed, no duplicates. */
export function normalizeDisabledModels(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const ids = value.filter((item): item is string => typeof item === "string").map((item) => item.trim());
	return [...new Set(ids.filter(Boolean))];
}

/**
 * Hide disabled models. If that would hide every model (a hand-edited setting), return the input
 * unchanged so RunKiln can still start.
 */
export function filterDisabledModels<T extends { id: string }>(
	models: readonly T[],
	disabledModels: readonly string[],
): T[] {
	if (disabledModels.length === 0) return [...models];
	const disabled = new Set(disabledModels);
	const kept = models.filter((model) => !disabled.has(model.id));
	return kept.length > 0 ? kept : [...models];
}

export function formatContext(tokens: number | undefined): string {
	if (!tokens) return "?";
	if (tokens >= 1_000_000)
		return `${Number.isInteger(tokens / 1_048_576) ? tokens / 1_048_576 : (tokens / 1_000_000).toFixed(1)}M`;
	return `${Math.round(tokens / 1024)}K`;
}

export function formatPrice(value: number | undefined): string {
	if (value === undefined) return "?";
	return `$${value.toFixed(2)}`;
}
