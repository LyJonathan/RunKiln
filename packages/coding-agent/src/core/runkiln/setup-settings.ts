/**
 * The defaults the setup wizard writes to `<agentDir>/settings.json`: the default model (auto with a
 * routing mode, or one manual model), the default thinking level, the permission mode, and the theme.
 *
 * Keys are not handled here (see setup.ts for the RunInfra key and router/keys.ts for classifier keys).
 * Every write merges into the existing file and keeps fields it does not own.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MODEL_THINKING_LEVELS } from "@runkiln/ai/providers/model-schema";
import { isRouterMode, ROUTER_MODES, type RouterMode } from "../router/catalog.ts";
import { autoModelId, isAutoModelId, parseAutoMode } from "../router/index.ts";
import { type PermissionMode, permissionModeInfo } from "./permissions.ts";
import { restrictToCurrentUser } from "./setup.ts";

export type { PermissionMode };

/**
 * The permission modes in setup's order. The modes, their names and their enforcement are permissions.ts's; setup
 * records the choice as `permissions.mode` in settings.json, the same setting /permissions writes.
 */
export const PERMISSION_MODES: readonly PermissionMode[] = ["auto", "allow-all", "read-write", "ask"];

export const PERMISSION_LABELS: Record<PermissionMode, string> = {
	auto: permissionModeInfo("auto").label,
	"allow-all": permissionModeInfo("allow-all").label,
	"read-write": permissionModeInfo("read-write").label,
	ask: permissionModeInfo("ask").label,
	plan: permissionModeInfo("plan").label,
};

export const PERMISSION_HINTS: Record<PermissionMode, string> = {
	auto: "approves routine actions, asks first on risky ones",
	"allow-all": "every tool runs without asking",
	"read-write": "reads and file edits run freely; commands ask first",
	ask: "asks before every tool call",
	// Not offered by setup: plan mode is for one task (Alt+M, /permissions plan or --permissions plan).
	plan: "read-only: proposes a plan, runs nothing until you approve it",
};

export function isPermissionMode(value: unknown): value is PermissionMode {
	return typeof value === "string" && (PERMISSION_MODES as readonly string[]).includes(value);
}

/**
 * "auto" needs a router classifier key: without one there is no decision model to judge calls. The setup wizard
 * passes permission-judge.ts's rule (isPermissionJudgeAvailable / resolvePermissionJudgeBackend), the one
 * /permissions and the Alt+M cycle use.
 */
export function availablePermissionModes(hasRouterKey: boolean): PermissionMode[] {
	return hasRouterKey ? [...PERMISSION_MODES] : PERMISSION_MODES.filter((mode) => mode !== "auto");
}

export type SetupThinkingLevel = (typeof MODEL_THINKING_LEVELS)[number];
export const SETUP_THINKING_LEVELS: readonly SetupThinkingLevel[] = MODEL_THINKING_LEVELS;

export function isSetupThinkingLevel(value: unknown): value is SetupThinkingLevel {
	return typeof value === "string" && (SETUP_THINKING_LEVELS as readonly string[]).includes(value);
}

export type SetupModelChoice = { kind: "auto"; mode: RouterMode } | { kind: "manual"; id: string };

export { ROUTER_MODES };

export interface SetupDefaults {
	model: SetupModelChoice;
	/** Undefined: each model's own default level (the key is removed). */
	thinking: SetupThinkingLevel | undefined;
	permissions: PermissionMode;
	/** Undefined: leave the theme setting as it is. */
	theme: string | undefined;
}

/** What settings.json holds today, for prefilling a re-run. Unknown or invalid values read as unset. */
export interface StoredSetupDefaults {
	model?: SetupModelChoice;
	thinking?: SetupThinkingLevel;
	permissions?: PermissionMode;
	theme?: string;
	routerMode?: RouterMode;
}

function settingsPath(agentDir: string): string {
	return join(agentDir, "settings.json");
}

function readSettings(agentDir: string): Record<string, unknown> {
	const path = settingsPath(agentDir);
	if (!existsSync(path)) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
	} catch {
		throw new Error("could not read settings.json");
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("could not read settings.json");
	return { ...(parsed as Record<string, unknown>) };
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as Record<string, unknown>) } : {};
}

export function modelChoiceFromId(
	id: string | undefined,
	fallbackMode: RouterMode = "medium",
): SetupModelChoice | undefined {
	const trimmed = id?.trim();
	if (!trimmed) return undefined;
	if (isAutoModelId(trimmed)) return { kind: "auto", mode: parseAutoMode(trimmed) ?? fallbackMode };
	return { kind: "manual", id: trimmed.replace(/^runinfra\//, "") };
}

export function modelChoiceId(choice: SetupModelChoice): string {
	return choice.kind === "auto" ? autoModelId(choice.mode) : choice.id;
}

/** `permissions.mode`; a bare string (written by pre-release builds of the setup screen) is read too. */
function storedPermissionMode(value: unknown): PermissionMode | undefined {
	if (isPermissionMode(value)) return value;
	const mode = asRecord(value).mode;
	return isPermissionMode(mode) ? mode : undefined;
}

export function loadStoredSetupDefaults(agentDir: string): StoredSetupDefaults {
	let settings: Record<string, unknown>;
	try {
		settings = readSettings(agentDir);
	} catch {
		return {};
	}
	const router = asRecord(settings.router);
	const routerMode = isRouterMode(router.mode) ? router.mode : undefined;
	const models = asRecord(settings.models);
	const code = typeof models.code === "string" ? models.code : undefined;
	return {
		model: modelChoiceFromId(code, routerMode),
		thinking: isSetupThinkingLevel(settings.defaultThinkingLevel) ? settings.defaultThinkingLevel : undefined,
		permissions: storedPermissionMode(settings.permissions),
		theme: typeof settings.theme === "string" ? settings.theme : undefined,
		routerMode,
	};
}

/**
 * Merge the wizard's defaults into settings.json:
 * `models.code` (an "auto:<mode>" id or a model id), `router.mode` when auto, `defaultThinkingLevel`
 * (removed when undefined), `permissions.mode`, and `theme` (left alone when undefined).
 */
export function saveSetupDefaults(agentDir: string, defaults: SetupDefaults): void {
	mkdirSync(agentDir, { recursive: true, mode: 0o700 });
	const settings = readSettings(agentDir);
	const models = asRecord(settings.models);
	models.code = modelChoiceId(defaults.model);
	settings.models = models;
	if (defaults.model.kind === "auto") {
		const router = asRecord(settings.router);
		router.mode = defaults.model.mode;
		settings.router = router;
	}
	if (defaults.thinking === undefined) delete settings.defaultThinkingLevel;
	else settings.defaultThinkingLevel = defaults.thinking;
	const permissions = typeof settings.permissions === "string" ? {} : asRecord(settings.permissions);
	permissions.mode = defaults.permissions;
	settings.permissions = permissions;
	if (defaults.theme !== undefined) settings.theme = defaults.theme;
	const path = settingsPath(agentDir);
	writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	if (process.platform !== "win32") restrictToCurrentUser(path);
}

/** One part of the setup defaults, as the /setup hub saves it. Keys that are absent are left alone. */
export interface SetupDefaultsPatch {
	model?: SetupModelChoice;
	/** Present and undefined: each model's own default level (the key is removed). */
	thinking?: SetupThinkingLevel | undefined;
	permissions?: PermissionMode;
	theme?: string;
	/** `router.mode`; an "auto:<mode>" default model follows it. */
	routerMode?: RouterMode;
}

/** Merge one section's change into settings.json, keeping every other field. */
export function updateSetupDefaults(agentDir: string, patch: SetupDefaultsPatch): void {
	mkdirSync(agentDir, { recursive: true, mode: 0o700 });
	const settings = readSettings(agentDir);
	if (patch.model) {
		const models = asRecord(settings.models);
		models.code = modelChoiceId(patch.model);
		settings.models = models;
		if (patch.model.kind === "auto") {
			const router = asRecord(settings.router);
			router.mode = patch.model.mode;
			settings.router = router;
		}
	}
	if (patch.routerMode) {
		const router = asRecord(settings.router);
		router.mode = patch.routerMode;
		settings.router = router;
		const models = asRecord(settings.models);
		if (typeof models.code === "string" && isAutoModelId(models.code)) {
			models.code = autoModelId(patch.routerMode);
			settings.models = models;
		}
	}
	if ("thinking" in patch) {
		if (patch.thinking === undefined) delete settings.defaultThinkingLevel;
		else settings.defaultThinkingLevel = patch.thinking;
	}
	if (patch.permissions) {
		const permissions = typeof settings.permissions === "string" ? {} : asRecord(settings.permissions);
		permissions.mode = patch.permissions;
		settings.permissions = permissions;
	}
	if (patch.theme !== undefined) settings.theme = patch.theme;
	const path = settingsPath(agentDir);
	writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	if (process.platform !== "win32") restrictToCurrentUser(path);
}

/** `footer.items` from settings.json (undefined: the default layout). */
export function loadFooterItemsSetting(agentDir: string): string[] | undefined {
	try {
		const footer = asRecord(readSettings(agentDir).footer);
		return Array.isArray(footer.items)
			? footer.items.filter((item): item is string => typeof item === "string")
			: undefined;
	} catch {
		return undefined;
	}
}
