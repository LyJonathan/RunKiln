/**
 * First-run setup: check a RunInfra key and save it plus model roles.
 *
 * The check is a plain GET {baseUrl}/models. The key is sent only in the Authorization
 * header. No x-session-id, no other auth headers, and nothing from this module is logged:
 * not the key, not request or response headers, and not the /models body.
 */

import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { RUNINFRA_API_KEY_ENV } from "@runkiln/ai/providers/runinfra";
import { currentUserSid, ensurePrivateDir } from "../../utils/private-files.ts";
import { effectiveRoleDefaults, type ModelRoleSettings } from "./model-roles.ts";
import type { ModelRole, ModelsCatalog } from "./models-catalog.ts";
import {
	describeRunInfraFailure,
	parseRemoteModels,
	type RemoteModelInfo,
	RUNINFRA_API_KEYS_URL,
	runInfraGet,
} from "./runinfra-account.ts";
import { getRunInfraConfigPath, loadRunInfraConfig, type RunInfraConfig } from "./runinfra-config.ts";

/** Where a workspace API key is created (Settings > API keys). */
export const RUNINFRA_KEY_URL = RUNINFRA_API_KEYS_URL;

export const SETUP_WELCOME = "Welcome to RunKiln. Three quick steps (one optional) and you're coding.";
export const SETUP_DONE = "You're set. Type a task or `/` to see commands.";
export const SETUP_KEY_SAVED = "key saved";
export const SETUP_ENV_KEY = "Using `RUNINFRA_API_KEY` from your environment.";
export const SETUP_WINDOWS_ACL_WARNING =
	"Key saved, but RunKiln couldn't lock the file. Make `runinfra.json` readable only by you.";
export const SETUP_KEPT_KEY = "kept the saved key";
export const SETUP_KEY_WORKS = "✓ Key works";
export const SETUP_INVALID_KEY = "invalid key";

export const ROLE_HINTS: Record<ModelRole, string> = {
	code: "fast coder",
	chat: "chat",
	title: "short titles",
};

export interface SetupModel {
	id: string;
	name: string;
	priceLabel?: string;
}

export interface KeyCheckResult {
	ok: boolean;
	/** A fixed message: "✓ Key works", "invalid key: …", a status-specific line, or a network line. */
	message: string;
	models: SetupModel[];
	/** Every model the endpoint listed, for the catalog cache. Empty on failure. */
	remote: RemoteModelInfo[];
}

export interface SetupRoles {
	code: string;
	chat: string;
	title: string;
}

function readJsonObject(path: string): Record<string, unknown> {
	if (!existsSync(path)) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
	} catch {
		throw new Error("could not read config");
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("could not read config");
	}
	return { ...(parsed as Record<string, unknown>) };
}

export interface FileLockOptions {
	/** Defaults to the current platform. Tests pass `"win32"` to exercise the ACL warning. */
	platform?: NodeJS.Platform;
	/** Defaults to `execFileSync`. Tests pass a throw to simulate a failed `icacls`. */
	execFile?: (command: string, args: readonly string[]) => void;
}

/**
 * Limit the config file to the current user.
 * POSIX: mode 0600 (applied after the write so the umask cannot widen it).
 * Windows: best-effort `icacls` to drop inherited ACEs and grant the current user full control.
 * If `icacls` is missing or fails, the file is still written and this returns a one-line warning.
 * The warning names `runinfra.json` only. It does not include the key or the full path.
 */
export function restrictToCurrentUser(filePath: string, options: FileLockOptions = {}): string | undefined {
	const platform = options.platform ?? process.platform;
	if (platform === "win32") {
		try {
			// The SID names exactly this account (a bare user name can resolve to another principal on domain-joined
			// machines). One icacls call: removing inheritance and granting in two calls leaves a moment with no ACE.
			const sid = options.execFile ? undefined : currentUserSid();
			const principal = sid ? `*${sid}` : userInfo().username;
			const execFile =
				options.execFile ??
				((command: string, args: readonly string[]) => {
					execFileSync(command, args, { stdio: "ignore", windowsHide: true });
				});
			execFile("icacls", [filePath, "/inheritance:r", "/grant:r", `${principal}:(F)`]);
		} catch {
			return SETUP_WINDOWS_ACL_WARNING;
		}
		return undefined;
	}
	chmodSync(filePath, 0o600);
	return undefined;
}

function ensureAgentDir(agentDir: string): void {
	ensurePrivateDir(agentDir);
}

/**
 * Write `apiKey` into `<agentDir>/runinfra.json`, preserving every other field.
 * Returns a warning when the file was saved but Windows could not lock it down.
 */
export function saveRunInfraApiKey(agentDir: string, apiKey: string, options?: FileLockOptions): string | undefined {
	ensureAgentDir(agentDir);
	const path = getRunInfraConfigPath(agentDir);
	const existing = readJsonObject(path);
	existing.apiKey = apiKey;
	writeFileSync(path, `${JSON.stringify(existing, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	return restrictToCurrentUser(path, options);
}

/** Merge model roles into `<agentDir>/settings.json` without dropping other fields. */
export function saveModelRoles(agentDir: string, roles: SetupRoles): void {
	ensureAgentDir(agentDir);
	const path = join(agentDir, "settings.json");
	const existing = readJsonObject(path);
	const models =
		existing.models && typeof existing.models === "object" && !Array.isArray(existing.models)
			? { ...(existing.models as Record<string, unknown>) }
			: {};
	models.code = roles.code;
	models.chat = roles.chat;
	models.title = roles.title;
	existing.models = models;
	writeFileSync(path, `${JSON.stringify(existing, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

export function loadModelRoleSettings(agentDir: string): ModelRoleSettings {
	const path = join(agentDir, "settings.json");
	if (!existsSync(path)) return {};
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
		const models = (parsed as Record<string, unknown>).models;
		if (!models || typeof models !== "object" || Array.isArray(models)) return {};
		const record = models as Record<string, unknown>;
		const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : undefined);
		const fallback = Array.isArray(record.fallback)
			? record.fallback.filter((item): item is string => typeof item === "string")
			: undefined;
		return {
			code: text(record.code),
			chat: text(record.chat),
			title: text(record.title),
			fallback,
		};
	} catch {
		return {};
	}
}

export function defaultSetupRoles(catalog: ModelsCatalog, settings: ModelRoleSettings = {}): SetupRoles {
	const defaults = effectiveRoleDefaults(catalog, settings);
	return { code: defaults.code, chat: defaults.chat, title: defaults.title };
}

function isUnavailable(entry: Record<string, unknown>): boolean {
	if (entry.paused === true || entry.available === false || entry.enabled === false) return true;
	for (const field of ["status", "state", "availability"]) {
		const value = entry[field];
		if (typeof value === "string" && /paused|unavailable|disabled/i.test(value)) return true;
	}
	return false;
}

function asPrice(value: unknown): string | undefined {
	if (typeof value === "number" && Number.isFinite(value)) {
		return Number.isInteger(Math.round(value * 1e6) / 1e4) ? value.toFixed(2) : String(value);
	}
	if (typeof value === "string") {
		const trimmed = value.trim();
		if (trimmed.length > 0 && trimmed.length <= 16 && !/[A-Za-z]/.test(trimmed)) return trimmed;
	}
	return undefined;
}

function priceLabel(entry: Record<string, unknown>): string | undefined {
	const source = entry.price ?? entry.pricing;
	if (!source || typeof source !== "object" || Array.isArray(source)) return undefined;
	const record = source as Record<string, unknown>;
	const input = asPrice(record.in ?? record.input ?? record.prompt);
	const output = asPrice(record.out ?? record.output ?? record.completion);
	if (input === undefined && output === undefined) return undefined;
	const parts: string[] = [];
	if (input !== undefined) parts.push(`$${input} in`);
	if (output !== undefined) parts.push(`$${output} out`);
	return parts.join(" / ");
}

/** Catalog order, keeping only ids the endpoint returned and that are not paused or unavailable. */
export function buildSetupModels(body: unknown, catalog: ModelsCatalog): SetupModel[] {
	const root =
		body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : undefined;
	const data = Array.isArray(body) ? body : Array.isArray(root?.data) ? root.data : [];
	const byId = new Map<string, Record<string, unknown>>();
	for (const item of data) {
		if (!item || typeof item !== "object" || Array.isArray(item)) continue;
		const entry = item as Record<string, unknown>;
		const id = typeof entry.id === "string" ? entry.id.trim() : "";
		if (!id || isUnavailable(entry)) continue;
		byId.set(id, entry);
	}
	const models: SetupModel[] = [];
	for (const model of catalog.models) {
		const entry = byId.get(model.id);
		if (!entry) continue;
		models.push({ id: model.id, name: model.name, priceLabel: priceLabel(entry) });
	}
	return models;
}

export function keyCheckFailureMessage(status: number | undefined): string {
	return describeRunInfraFailure({ status });
}

/**
 * GET {baseUrl}/models. The key is the Authorization bearer token and is not put anywhere else.
 * Failures return a fixed message. The response body and headers are never copied into that message.
 */
export async function checkRunInfraKey(options: {
	baseUrl: string;
	apiKey: string;
	catalog: ModelsCatalog;
	fetchImpl?: typeof fetch;
}): Promise<KeyCheckResult> {
	const result = await runInfraGet({
		baseUrl: options.baseUrl,
		apiKey: options.apiKey,
		path: "models",
		fetchImpl: options.fetchImpl,
	});
	if (!result.ok) return { ok: false, message: result.message, models: [], remote: [] };
	return {
		ok: true,
		message: SETUP_KEY_WORKS,
		models: buildSetupModels(result.body, options.catalog),
		remote: parseRemoteModels(result.body),
	};
}

export function environmentApiKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
	const value = env[RUNINFRA_API_KEY_ENV]?.trim();
	return value ? value : undefined;
}

export function needsFirstRunSetup(agentDir: string, env: NodeJS.ProcessEnv = process.env): boolean {
	if (environmentApiKey(env)) return false;
	return !loadRunInfraConfig(agentDir).apiKey;
}

export function loadSetupConfig(agentDir: string): RunInfraConfig {
	return loadRunInfraConfig(agentDir);
}
