/**
 * Router classifier keys: `<agentDir>/router-keys.json` (default `~/.runkiln/agent/router-keys.json`, 0600),
 * the `router.classifier` setting, and live key checks.
 *
 * Environment variables (TYPESAFE_API_KEY, OPENROUTER_API_KEY) always win over the saved file.
 * Nothing here logs or returns a key, request headers, or a response body. Error text is built from
 * the HTTP status and `Retry-After` only.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "../../config.ts";
import { type FileLockOptions, restrictToCurrentUser } from "../runkiln/setup.ts";
import {
	CLASSIFIER_KEY_ENV,
	type ClassifierChoice,
	JEV_DEFAULT_BASE_URL,
	JEV_DEFAULT_MODEL,
	OPENROUTER_DEFAULT_BASE_URL,
	OPENROUTER_DEFAULT_MODEL,
	resolveClassifierBackend,
	resolveClassifierKey,
	type StoredClassifierKeys,
	validateClassifierBaseUrl,
} from "./classifiers.ts";
import { type DecisionModelList, getCachedDecisionModels, isDecisionModel } from "./decision-models.ts";
import type { ClassifierBackend } from "./types.ts";

export const ROUTER_KEYS_FILE = "router-keys.json";
export const ROUTER_KEYS_DISPLAY_PATH = "~/.runkiln/agent/router-keys.json";
export const ROUTER_BACKENDS: readonly ClassifierBackend[] = ["jev", "openrouter"];

export const ROUTER_BACKEND_LABELS: Record<ClassifierBackend, string> = {
	jev: "Jev (TypeSafe)",
	openrouter: "OpenRouter",
};

/** Short names for error text. */
const SHORT_LABELS: Record<ClassifierBackend, string> = { jev: "Jev", openrouter: "OpenRouter" };

/** Where a key is created. */
export const ROUTER_KEY_URLS: Record<ClassifierBackend, string> = {
	jev: "https://console.typesafe.ai/",
	openrouter: "https://openrouter.ai/settings/keys",
};

export const ROUTER_WINDOWS_ACL_WARNING =
	"Router key saved, but RunKiln couldn't lock the file. Make `router-keys.json` readable only by you.";

export function isRouterBackend(value: unknown): value is ClassifierBackend {
	return value === "jev" || value === "openrouter";
}

// ---------------------------------------------------------------------------------------------
// router-keys.json
// ---------------------------------------------------------------------------------------------

export function getRouterKeysPath(agentDir: string = getAgentDir()): string {
	return join(agentDir, ROUTER_KEYS_FILE);
}

function readObject(path: string, what: string): Record<string, unknown> {
	if (!existsSync(path)) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
	} catch {
		throw new Error(`could not read ${what}`);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`could not read ${what}`);
	return { ...(parsed as Record<string, unknown>) };
}

function keyOf(record: Record<string, unknown>, backend: ClassifierBackend): string | undefined {
	const entry = record[backend];
	const value =
		typeof entry === "string"
			? entry
			: entry && typeof entry === "object" && !Array.isArray(entry)
				? (entry as Record<string, unknown>).apiKey
				: undefined;
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Saved keys. Throws on an unreadable file; see {@link readRouterKeys} for the forgiving version. */
export function loadRouterKeys(agentDir: string = getAgentDir()): StoredClassifierKeys {
	const record = readObject(getRouterKeysPath(agentDir), ROUTER_KEYS_FILE);
	return { jev: keyOf(record, "jev"), openrouter: keyOf(record, "openrouter") };
}

/** Saved keys, or none when the file is missing or unreadable (the router then reports no key). */
export function readRouterKeys(agentDir: string = getAgentDir()): StoredClassifierKeys {
	try {
		return loadRouterKeys(agentDir);
	} catch {
		return {};
	}
}

function ensureAgentDir(agentDir: string): void {
	mkdirSync(agentDir, { recursive: true, mode: 0o700 });
	if (process.platform !== "win32") chmodSync(agentDir, 0o700);
}

/** One line, printable, no spaces: anything else is a paste accident, not a key. */
export function validateRouterKeyShape(apiKey: string): string | undefined {
	if (!apiKey) return "Enter a key.";
	if (apiKey.length > 512) return "That key is too long.";
	if (/[\s\u0000-\u001f\u007f]/.test(apiKey)) return "A key is one line with no spaces.";
	return undefined;
}

/**
 * Save `apiKey` for `backend`, keeping the other backend's key. The file is written 0600 (POSIX) or
 * locked with icacls (Windows). Returns a warning when Windows could not lock it.
 */
export function saveRouterKey(
	agentDir: string,
	backend: ClassifierBackend,
	apiKey: string,
	options?: FileLockOptions,
): string | undefined {
	const problem = validateRouterKeyShape(apiKey);
	if (problem) throw new Error(problem);
	ensureAgentDir(agentDir);
	const path = getRouterKeysPath(agentDir);
	const record = readObject(path, ROUTER_KEYS_FILE);
	record[backend] = { apiKey };
	writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	return restrictToCurrentUser(path, options) ? ROUTER_WINDOWS_ACL_WARNING : undefined;
}

/** Remove one backend's saved key (deleting the file when it is empty). True when a key was removed. */
export function removeRouterKey(agentDir: string, backend: ClassifierBackend): boolean {
	const path = getRouterKeysPath(agentDir);
	if (!existsSync(path)) return false;
	const record = readObject(path, ROUTER_KEYS_FILE);
	if (!(backend in record)) return false;
	delete record[backend];
	if (Object.keys(record).length === 0) rmSync(path, { force: true });
	else writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	return true;
}

// ---------------------------------------------------------------------------------------------
// Key source and the active classifier
// ---------------------------------------------------------------------------------------------

export type RouterKeySource = "environment" | "file" | "none";

export interface RouterKeyStatus {
	backend: ClassifierBackend;
	source: RouterKeySource;
	/** One line for the UI. Never contains the key. */
	label: string;
	/** True when a key is saved in router-keys.json (even if the env var overrides it). */
	hasSavedKey: boolean;
}

export function getRouterKeyStatus(
	agentDir: string,
	backend: ClassifierBackend,
	env: NodeJS.ProcessEnv = process.env,
): RouterKeyStatus {
	const stored = readRouterKeys(agentDir);
	const hasSavedKey = !!stored[backend];
	const envName = CLASSIFIER_KEY_ENV[backend];
	const resolved = resolveClassifierKey(backend, env, stored);
	if (resolved?.source === "environment") {
		return {
			backend,
			source: "environment",
			label: hasSavedKey ? `${envName} (environment, overrides the saved key)` : `${envName} (environment)`,
			hasSavedKey,
		};
	}
	if (resolved?.source === "file") {
		return { backend, source: "file", label: `saved in ${ROUTER_KEYS_DISPLAY_PATH}`, hasSavedKey };
	}
	return { backend, source: "none", label: "no key", hasSavedKey };
}

/** The key `backend` would use right now (env first, then the file). Callers must not print it. */
export function getActiveRouterKey(
	agentDir: string,
	backend: ClassifierBackend,
	env: NodeJS.ProcessEnv = process.env,
): string | undefined {
	return resolveClassifierKey(backend, env, readRouterKeys(agentDir))?.apiKey;
}

export interface RouterClassifierSettings {
	classifier?: ClassifierChoice;
	jevModel?: string;
	openrouterModel?: string;
	jevBaseUrl?: string;
	openrouterBaseUrl?: string;
}

function settingsPath(agentDir: string): string {
	return join(agentDir, "settings.json");
}

const CHOICES: readonly ClassifierChoice[] = ["auto", "jev", "openrouter", "off"];

/** `router.*` from the global settings.json. Forgiving: an unreadable file reads as defaults. */
export function loadRouterClassifierSettings(agentDir: string = getAgentDir()): RouterClassifierSettings {
	let record: Record<string, unknown>;
	try {
		record = readObject(settingsPath(agentDir), "settings.json");
	} catch {
		return {};
	}
	const router = record.router;
	if (!router || typeof router !== "object" || Array.isArray(router)) return {};
	const value = router as Record<string, unknown>;
	const sub = (name: string, field: string) => {
		const entry = value[name];
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) return undefined;
		const text = (entry as Record<string, unknown>)[field];
		return typeof text === "string" && text.trim() ? text.trim() : undefined;
	};
	const classifier = CHOICES.includes(value.classifier as ClassifierChoice)
		? (value.classifier as ClassifierChoice)
		: undefined;
	return {
		classifier,
		jevModel: sub("jev", "model"),
		openrouterModel: sub("openrouter", "model"),
		jevBaseUrl: sub("jev", "baseUrl"),
		openrouterBaseUrl: sub("openrouter", "baseUrl"),
	};
}

/**
 * Set `router.classifier` (and, when given, the classifier model for that backend) in the global
 * settings.json, keeping every other field.
 */
export function saveRouterClassifier(agentDir: string, classifier: ClassifierChoice, model?: string): void {
	ensureAgentDir(agentDir);
	const path = settingsPath(agentDir);
	const record = readObject(path, "settings.json");
	const router =
		record.router && typeof record.router === "object" && !Array.isArray(record.router)
			? { ...(record.router as Record<string, unknown>) }
			: {};
	router.classifier = classifier;
	if (model && isRouterBackend(classifier)) {
		const current = router[classifier];
		const backendSettings =
			current && typeof current === "object" && !Array.isArray(current)
				? { ...(current as Record<string, unknown>) }
				: {};
		backendSettings.model = model;
		router[classifier] = backendSettings;
	}
	record.router = router;
	writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

/** Set `router.openrouter.model` (the OpenRouter decision model), keeping `router.classifier` as it is. */
export function saveOpenRouterDecisionModel(agentDir: string, model: string): void {
	ensureAgentDir(agentDir);
	const path = settingsPath(agentDir);
	const record = readObject(path, "settings.json");
	const router =
		record.router && typeof record.router === "object" && !Array.isArray(record.router)
			? { ...(record.router as Record<string, unknown>) }
			: {};
	const current = router.openrouter;
	const backendSettings =
		current && typeof current === "object" && !Array.isArray(current)
			? { ...(current as Record<string, unknown>) }
			: {};
	backendSettings.model = model;
	router.openrouter = backendSettings;
	record.router = router;
	writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

export interface ActiveRouterClassifier {
	/** The configured choice (default "auto"). */
	choice: ClassifierChoice;
	/** The backend in use: the configured one, or what "auto" resolves to. Undefined when off or no key. */
	backend?: ClassifierBackend;
	/** The classifier model for that backend. */
	model?: string;
	key?: RouterKeyStatus;
}

export function getActiveRouterClassifier(
	agentDir: string,
	env: NodeJS.ProcessEnv = process.env,
	settings: RouterClassifierSettings = loadRouterClassifierSettings(agentDir),
): ActiveRouterClassifier {
	const choice = settings.classifier ?? "auto";
	const backend = resolveClassifierBackend(choice, env, readRouterKeys(agentDir));
	if (!backend) return { choice };
	const model =
		backend === "jev"
			? (settings.jevModel ?? JEV_DEFAULT_MODEL)
			: (settings.openrouterModel ?? OPENROUTER_DEFAULT_MODEL);
	return { choice, backend, model, key: getRouterKeyStatus(agentDir, backend, env) };
}

/** OpenRouter model ids look like `vendor/model[:variant]` (aliases start with `~`). */
export function validateOpenRouterModelId(value: string): string | undefined {
	const id = value.trim();
	if (!id) return `Enter a decision model id, such as ${OPENROUTER_DEFAULT_MODEL}.`;
	if (id.length > 128 || !/^~?[A-Za-z0-9][\w.-]*\/[\w.:~-]+$/.test(id)) {
		return `Model ids look like vendor/model, such as ${OPENROUTER_DEFAULT_MODEL}.`;
	}
	return undefined;
}

/**
 * An OpenRouter classifier model must be a decision model (output modality "decisions"): `list` is the live,
 * cached or built-in decision list. Returns the problem, or undefined when `value` may be used.
 */
export function validateOpenRouterDecisionModel(value: string, list: DecisionModelList): string | undefined {
	const shape = validateOpenRouterModelId(value);
	if (shape) return shape;
	if (!isDecisionModel(value.trim(), list)) {
		return `${value.trim()} is not an OpenRouter decision model. Pick one from https://openrouter.ai/models?output_modalities=decisions (default ${OPENROUTER_DEFAULT_MODEL}).`;
	}
	return undefined;
}

/**
 * Settings saved by older builds may name a chat model (the old default google/gemini-2.5-flash-lite) as
 * `router.openrouter.model`. Only decision models may classify or judge permissions, so such a setting is moved to
 * the decision default. Uses the cached decision list (no network). Returns a one-line notice, or undefined when
 * nothing changed.
 */
export function migrateOpenRouterClassifierModel(
	agentDir: string = getAgentDir(),
	list: DecisionModelList = getCachedDecisionModels(agentDir),
): string | undefined {
	const path = settingsPath(agentDir);
	if (!existsSync(path)) return undefined;
	let record: Record<string, unknown>;
	try {
		record = readObject(path, "settings.json");
	} catch {
		return undefined;
	}
	const router = record.router;
	if (!router || typeof router !== "object" || Array.isArray(router)) return undefined;
	const openrouter = (router as Record<string, unknown>).openrouter;
	if (!openrouter || typeof openrouter !== "object" || Array.isArray(openrouter)) return undefined;
	const model = (openrouter as Record<string, unknown>).model;
	if (typeof model !== "string" || !model.trim() || isDecisionModel(model.trim(), list)) return undefined;
	(openrouter as Record<string, unknown>).model = OPENROUTER_DEFAULT_MODEL;
	try {
		writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	} catch {
		return undefined;
	}
	return `Router: ${model.trim()} is not a decision model, so the OpenRouter classifier now uses ${OPENROUTER_DEFAULT_MODEL}.`;
}

// ---------------------------------------------------------------------------------------------
// Live checks
// ---------------------------------------------------------------------------------------------

export interface RouterKeyFailure {
	/** HTTP status, or undefined when the request never got an answer. */
	status?: number;
	retryAfterSeconds?: number;
	timedOut?: boolean;
}

/** Short, fixed text for a failed check. No body, headers, or key. */
export function describeRouterKeyFailure(backend: ClassifierBackend, failure: RouterKeyFailure): string {
	const name = SHORT_LABELS[backend];
	const { status, retryAfterSeconds } = failure;
	const retry = retryAfterSeconds !== undefined ? ` Retry in ${retryAfterSeconds}s.` : " Try again shortly.";
	if (failure.timedOut) return `${name} didn't answer in time. Check your connection.`;
	if (status === undefined) return `Couldn't reach ${name}. Check your connection.`;
	if (status === 401) return `invalid key: ${name} rejected it (wrong, revoked or expired).`;
	if (status === 403) return `Key refused by ${name} (403): disabled, or not allowed for this API.`;
	if (status === 402) return `${name} account is out of credits (402).`;
	if (status === 429) return `Rate limited by ${name} (429).${retry}`;
	if (status >= 500) return `${name} error ${status}.${retry}`;
	return `${name} answered ${status}.`;
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

export interface RouterKeyCheck {
	ok: boolean;
	/** A fixed line: "✓ Jev key works", a status-specific error, or a network line. Never the key. */
	message: string;
	/** Extra detail for a working key (OpenRouter credit left, a missing Jev model). */
	detail?: string;
	failure?: RouterKeyFailure;
}

const money = (value: unknown) =>
	typeof value === "number" && Number.isFinite(value) ? `$${value.toFixed(2)}` : undefined;

function openRouterDetail(body: unknown): string | undefined {
	const data =
		body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>).data : undefined;
	if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
	const record = data as Record<string, unknown>;
	// `label` echoes part of the key: never shown.
	const parts: string[] = [];
	const used = money(record.usage);
	if (used) parts.push(`${used} used`);
	const left = money(record.limit_remaining);
	if (left) parts.push(`${left} left on this key`);
	else if (record.limit === null) parts.push("no limit on this key");
	if (record.is_free_tier === true) parts.push("free tier");
	return parts.length > 0 ? parts.join(" - ") : undefined;
}

function jevModelNames(body: unknown): string[] {
	const root = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
	const list = Array.isArray(root.models) ? root.models : Array.isArray(root.data) ? root.data : [];
	const names: string[] = [];
	for (const item of list) {
		if (!item || typeof item !== "object") continue;
		const entry = item as Record<string, unknown>;
		const name = typeof entry.name === "string" ? entry.name : typeof entry.id === "string" ? entry.id : undefined;
		if (name) names.push(name);
	}
	return names;
}

/**
 * Check a classifier key live.
 * - Jev: `GET {base}/v1/models` (also confirms the configured Jev model is listed).
 * - OpenRouter: `GET {base}/key` (returns the key's usage and limit).
 * The key goes only in the Authorization header; redirects are refused.
 */
export async function checkRouterKey(options: {
	backend: ClassifierBackend;
	apiKey: string;
	baseUrl?: string;
	model?: string;
	fetchImpl?: typeof fetch;
	timeoutMs?: number;
}): Promise<RouterKeyCheck> {
	const { backend } = options;
	const shape = validateRouterKeyShape(options.apiKey.trim());
	if (shape) return { ok: false, message: shape };
	let base: string;
	try {
		base = validateClassifierBaseUrl(
			options.baseUrl ?? (backend === "jev" ? JEV_DEFAULT_BASE_URL : OPENROUTER_DEFAULT_BASE_URL),
		);
	} catch (error) {
		return { ok: false, message: error instanceof Error ? error.message : "Invalid classifier baseUrl." };
	}
	const url = backend === "jev" ? `${base}/v1/models` : `${base}/key`;
	const fetchImpl = options.fetchImpl ?? fetch;
	const timeout = AbortSignal.timeout(options.timeoutMs ?? 10_000);
	let response: Response;
	try {
		response = await fetchImpl(url, {
			method: "GET",
			headers: { Authorization: `Bearer ${options.apiKey.trim()}` },
			redirect: "error",
			signal: timeout,
		});
	} catch {
		const failure: RouterKeyFailure = { timedOut: timeout.aborted };
		return { ok: false, message: describeRouterKeyFailure(backend, failure), failure };
	}
	if (!response.ok) {
		await response.body?.cancel().catch(() => undefined);
		const failure: RouterKeyFailure = {
			status: response.status,
			retryAfterSeconds: parseRetryAfter(response.headers),
		};
		return { ok: false, message: describeRouterKeyFailure(backend, failure), failure };
	}
	let body: unknown;
	try {
		body = (await response.json()) as unknown;
	} catch {
		return {
			ok: false,
			message: `${SHORT_LABELS[backend]} sent an invalid response.`,
			failure: { status: response.status },
		};
	}
	const message = `✓ ${SHORT_LABELS[backend]} key works`;
	if (backend === "openrouter") return { ok: true, message, detail: openRouterDetail(body) };
	const names = jevModelNames(body);
	const model = options.model ?? JEV_DEFAULT_MODEL;
	const detail = names.length > 0 && !names.includes(model) ? `Jev does not list model ${model}.` : undefined;
	return { ok: true, message, detail };
}
