import type { ThinkingLevel } from "@runkiln/agent-core";
import type { Model } from "@runkiln/ai";
import type { ScrollViewScrollbar, TerminalCapabilities, WheelScrollLines } from "@runkiln/tui";
import { randomUUID } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import lockfile from "proper-lockfile";
import { CONFIG_DIR_NAME, getAgentDir } from "../config.ts";
import { normalizePath, resolvePath } from "../utils/paths.ts";
import type { ShellEnvironmentPolicy } from "../utils/shell.ts";
import { stripBom } from "../utils/text.ts";
import { DEFAULT_HTTP_IDLE_TIMEOUT_MS, parseHttpIdleTimeoutMs } from "./http-dispatcher.ts";
import {
	type ApprovalTimeoutPolicy,
	approvalTimeoutPolicy,
	DEFAULT_APPROVAL_TIMEOUT_POLICY,
} from "./runkiln/permissions.ts";
import { normalizeDisabledModels } from "./runkiln/runinfra-account.ts";
import { SETTINGS_DEFAULTS } from "./settings-defaults.ts";
import type {
	CacheWarmingMode,
	CompactionModelOverride,
	DefaultProjectTrust,
	DisplaySettings,
	FullscreenExitOutput,
	MermaidRenderingMode,
	QuietStartup,
	RouterSettingsInput,
	SessionShareDestination,
	Settings,
	ThinkingBudgetsSettings,
	TransportSetting,
	TuiMode,
	WarningSettings,
} from "./settings-schema.ts";

export type {
	BranchSummarySettings,
	CacheWarmingMode,
	CodemodeMode,
	CodemodeSettings,
	CompactionModelOverride,
	CompactionSettings,
	DefaultProjectTrust,
	DisplaySettings,
	FullscreenExitOutput,
	ImageSettings,
	MarkdownSettings,
	MermaidRenderingMode,
	ProviderRetrySettings,
	QuietStartup,
	RetrySettings,
	SessionShareDestination,
	Settings,
	TerminalSettings,
	ThinkingBudgetsSettings,
	TransportSetting,
	TuiMode,
	WarningSettings,
} from "./settings-schema.ts";
/** Cache-warming profile. "idle" also warms between agent runs. */
export const CACHE_WARMING_MODES = ["off", "streaming", "idle"] as const satisfies readonly CacheWarmingMode[];

const DEFAULT_COMPACTION_TOKEN_SETTINGS: Required<CompactionModelOverride> = {
	reserveTokens: SETTINGS_DEFAULTS.compaction.reserveTokens,
	keepRecentTokens: SETTINGS_DEFAULTS.compaction.keepRecentTokens,
};

function isMergeableObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepMergeObjects(base: Record<string, unknown>, overrides: Record<string, unknown>): Record<string, unknown> {
	const result = { ...base };

	for (const key of Object.keys(overrides)) {
		const overrideValue = overrides[key];
		if (overrideValue === undefined) {
			continue;
		}

		const baseValue = base[key];
		result[key] =
			isMergeableObject(baseValue) && isMergeableObject(overrideValue)
				? deepMergeObjects(baseValue, overrideValue)
				: overrideValue;
	}

	return result;
}

/** Tools enabled at startup when `defaultTools` does not change them. */
export const DEFAULT_TOOL_NAMES: readonly string[] = ["read", "bash", "edit", "write"];

/** DEFAULT_TOOL_NAMES for this machine: on Windows with no bash at all, `powershell` replaces `bash`. */
export function platformDefaultToolNames(
	hasBash: () => boolean,
	platform: NodeJS.Platform = process.platform,
): readonly string[] {
	if (platform !== "win32" || hasBash()) return DEFAULT_TOOL_NAMES;
	return DEFAULT_TOOL_NAMES.map((name) => (name === "bash" ? "powershell" : name));
}

/** Whether a tool selection entry is a `+name` or `-name` modifier. */
export function isToolModifier(entry: unknown): boolean {
	return typeof entry === "string" && (entry.startsWith("+") || entry.startsWith("-"));
}

/**
 * Validate a tool list from `--tools` or the SDK `tools` option. It is either an allowlist of plain
 * names and patterns or a list of only `+name`/`-name` entries with exact names. Returns the
 * problem, or undefined when the list is valid.
 */
export function getToolListError(entries: readonly string[]): string | undefined {
	const modifiers = entries.filter(isToolModifier);
	if (modifiers.length === 0) return undefined;
	if (modifiers.length < entries.length) return "tool names cannot be mixed with +name or -name entries";
	const pattern = modifiers.find((entry) => entry.includes("*"));
	if (pattern) return `+name and -name entries take exact tool names, not patterns: ${pattern}`;
	return undefined;
}

/**
 * Apply the `+name` and `-name` entries of `entries` to `base` in order: `+name` adds a tool and
 * `-name` removes one. Other entries are ignored.
 */
export function applyToolModifiers(base: readonly string[], entries: readonly string[]): string[] {
	const tools = [...base];
	for (const entry of entries) {
		if (!isToolModifier(entry)) continue;
		const name = entry.slice(1);
		const index = tools.indexOf(name);
		if (entry.startsWith("+") && index === -1 && name) tools.push(name);
		else if (entry.startsWith("-") && index !== -1) tools.splice(index, 1);
	}
	return tools;
}

/**
 * Merge `defaultTools` of two settings layers. A list with plain tool names replaces the inherited
 * one; a list of only `+name`/`-name` entries is appended, so it modifies the inherited selection.
 */
function mergeDefaultTools(base: string[] | undefined, overrides: string[] | undefined): string[] | undefined {
	if (overrides === undefined) return base;
	// Settings files are not validated; a malformed value replaces instead of throwing here.
	if (!Array.isArray(base) || !Array.isArray(overrides) || !overrides.every(isToolModifier)) return overrides;
	return [...base, ...overrides];
}

/**
 * Resolve a merged `defaultTools` list: plain names replace `DEFAULT_TOOL_NAMES`, then `+name` adds
 * and `-name` removes a tool, in list order.
 */
function resolveDefaultTools(entries: string[]): string[] {
	const plain = entries.filter((entry) => !isToolModifier(entry));
	return applyToolModifiers(plain.length > 0 || entries.length === 0 ? plain : DEFAULT_TOOL_NAMES, entries);
}

/**
 * Settings that choose which programs run or where transcripts go. A project file cannot set them: a repo the user
 * trusted for its skills would otherwise own every shell command (shellCommandPrefix, shellPath), the editor, the npm
 * command, the session folder, the share target or the proxy that sees every model request. Only the global
 * settings file (and command-line flags) can set them; a project value is ignored with a warning.
 */
export const GLOBAL_ONLY_SETTINGS = Object.freeze([
	"shellPath",
	"shellCommandPrefix",
	"externalEditor",
	"editor",
	"npmCommand",
	"sessionDir",
	"sessionShareDestination",
	"httpProxy",
	"defaultProjectTrust",
	"shellEnvironment",
] as const satisfies readonly (keyof Settings)[]);

/** Project settings without the global-only keys (see GLOBAL_ONLY_SETTINGS). */
function withoutGlobalOnly(project: Settings): Settings {
	if (!GLOBAL_ONLY_SETTINGS.some((key) => key in project)) return project;
	const copy = { ...project } as Record<string, unknown>;
	for (const key of GLOBAL_ONLY_SETTINGS) delete copy[key];
	return copy as Settings;
}

/** Deep merge settings: project/overrides take precedence, nested objects merge recursively */
function deepMergeSettings(base: Settings, overrides: Settings): Settings {
	const merged = deepMergeObjects(base as Record<string, unknown>, overrides as Record<string, unknown>) as Settings;
	const defaultTools = mergeDefaultTools(base.defaultTools, overrides.defaultTools);
	return defaultTools === undefined ? merged : { ...merged, defaultTools };
}

function parseTimeoutSetting(value: unknown, settingName: string): number | undefined {
	const timeoutMs = parseHttpIdleTimeoutMs(value);
	if (timeoutMs !== undefined) {
		return timeoutMs;
	}
	if (value !== undefined) {
		throw new Error(`Invalid ${settingName} setting: ${String(value)}`);
	}
	return undefined;
}

export type SettingsScope = "global" | "project";

/** Parts of the turn summary that `display.turnSummaryFields` turns on and off, in display order. */
export const TURN_SUMMARY_FIELDS = ["time", "files", "tools", "cost", "model", "clock"] as const;
export type TurnSummaryField = (typeof TURN_SUMMARY_FIELDS)[number];
export type TurnSummaryFields = Record<TurnSummaryField, boolean>;
export type TurnSummaryMode = "reply" | "footer" | "off";

/** `display.*` with defaults filled in (turnSummary normalized from the old boolean form). */
export interface ResolvedDisplaySettings {
	editDiffs: "full" | "collapsed" | "summary";
	diff: "unified" | "split" | "auto";
	diffSyntax: boolean;
	groupReads: boolean;
	turnSummary: TurnSummaryMode;
	turnSummaryFields: TurnSummaryFields;
	toolOutput: "collapsed" | "expanded";
	changesTray: boolean;
	changesTrayPosition: "editor" | "footer";
	diffOpens: "review" | "git";
	timestamps: "off" | "time" | "datetime";
}

export interface SettingsManagerCreateOptions {
	projectTrusted?: boolean;
}

export interface SettingsStorage {
	withLock(scope: SettingsScope, fn: (current: string | undefined) => string | undefined): void;
}

export interface SettingsError {
	scope: SettingsScope;
	path?: string;
	error: Error;
}

type SettingsPaths = Partial<Record<SettingsScope, string>>;

function toSettingsError(scope: SettingsScope, error: unknown, path?: string): SettingsError {
	return {
		scope,
		...(path ? { path } : {}),
		error: error instanceof Error ? error : new Error(String(error)),
	};
}

export class FileSettingsStorage implements SettingsStorage {
	private globalSettingsPath: string;
	private projectSettingsPath: string;

	constructor(cwd: string, agentDir: string) {
		const resolvedCwd = resolvePath(cwd);
		const resolvedAgentDir = resolvePath(agentDir);
		this.globalSettingsPath = join(resolvedAgentDir, "settings.json");
		this.projectSettingsPath = join(resolvedCwd, CONFIG_DIR_NAME, "settings.json");
	}

	private acquireLockSyncWithRetry(path: string): () => void {
		const maxAttempts = 10;
		const delayMs = 20;
		let lastError: unknown;

		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			try {
				return lockfile.lockSync(path, { realpath: false });
			} catch (error) {
				const code =
					typeof error === "object" && error !== null && "code" in error
						? String((error as { code?: unknown }).code)
						: undefined;
				if (code !== "ELOCKED" || attempt === maxAttempts) {
					throw error;
				}
				lastError = error;
				const start = Date.now();
				while (Date.now() - start < delayMs) {
					// Sleep synchronously to avoid changing callers to async.
				}
			}
		}

		throw (lastError as Error) ?? new Error("Failed to acquire settings lock");
	}

	withLock(scope: SettingsScope, fn: (current: string | undefined) => string | undefined): void {
		const path = scope === "global" ? this.globalSettingsPath : this.projectSettingsPath;
		const dir = dirname(path);

		let release: (() => void) | undefined;
		try {
			// Only create directory and lock if file exists or we need to write
			const fileExists = existsSync(path);
			if (fileExists) {
				release = this.acquireLockSyncWithRetry(path);
			}
			const current = fileExists ? readFileSync(path, "utf-8") : undefined;
			const next = fn(current);
			if (next !== undefined) {
				// Only create directory when we actually need to write
				// Global settings can hold MCP headers and env values, so the file and the agent folder are private.
				const isGlobal = scope === "global";
				if (!existsSync(dir)) {
					mkdirSync(dir, { recursive: true, ...(isGlobal ? { mode: 0o700 } : {}) });
				}
				if (!release) {
					release = this.acquireLockSyncWithRetry(path);
				}
				writeFileSync(path, next, { encoding: "utf-8", ...(isGlobal ? { mode: 0o600 } : {}) });
			}
		} finally {
			if (release) {
				release();
			}
		}
	}
}

export class InMemorySettingsStorage implements SettingsStorage {
	private global: string | undefined;
	private project: string | undefined;

	withLock(scope: SettingsScope, fn: (current: string | undefined) => string | undefined): void {
		const current = scope === "global" ? this.global : this.project;
		const next = fn(current);
		if (next !== undefined) {
			if (scope === "global") {
				this.global = next;
			} else {
				this.project = next;
			}
		}
	}
}

export class SettingsManager {
	private storage: SettingsStorage;
	private globalSettings: Settings;
	private projectSettings: Settings;
	private settings: Settings;
	private projectTrusted: boolean;
	private modifiedFields = new Set<keyof Settings>(); // Track global fields modified during session
	private modifiedNestedFields = new Map<keyof Settings, Set<string>>(); // Track global nested field modifications
	private modifiedProjectFields = new Set<keyof Settings>(); // Track project fields modified during session
	private modifiedProjectNestedFields = new Map<keyof Settings, Set<string>>(); // Track project nested field modifications
	private globalSettingsLoadError: Error | null = null; // Track if global settings file had parse errors
	private projectSettingsLoadError: Error | null = null; // Track if project settings file had parse errors
	private writeQueue: Promise<void> = Promise.resolve();
	private errors: SettingsError[];
	private settingsPaths: SettingsPaths;

	private constructor(
		storage: SettingsStorage,
		initialGlobal: Settings,
		initialProject: Settings,
		globalLoadError: Error | null = null,
		projectLoadError: Error | null = null,
		initialErrors: SettingsError[] = [],
		projectTrusted = true,
		settingsPaths: SettingsPaths = {},
	) {
		this.storage = storage;
		this.globalSettings = initialGlobal;
		this.projectSettings = initialProject;
		this.projectTrusted = projectTrusted;
		this.globalSettingsLoadError = globalLoadError;
		this.projectSettingsLoadError = projectLoadError;
		this.errors = [...initialErrors];
		this.settingsPaths = settingsPaths;
		this.settings = deepMergeSettings(this.globalSettings, withoutGlobalOnly(this.projectSettings));
	}

	/** Create a SettingsManager that loads from files */
	static create(
		cwd: string,
		agentDir: string = getAgentDir(),
		options: SettingsManagerCreateOptions = {},
	): SettingsManager {
		const resolvedCwd = resolvePath(cwd);
		const resolvedAgentDir = resolvePath(agentDir);
		const storage = new FileSettingsStorage(resolvedCwd, resolvedAgentDir);
		return SettingsManager.fromStorageWithPaths(storage, options, {
			global: join(resolvedAgentDir, "settings.json"),
			project: join(resolvedCwd, CONFIG_DIR_NAME, "settings.json"),
		});
	}

	/** Create a SettingsManager from an arbitrary storage backend */
	static fromStorage(storage: SettingsStorage, options: SettingsManagerCreateOptions = {}): SettingsManager {
		return SettingsManager.fromStorageWithPaths(storage, options);
	}

	/** Create a manager while retaining optional file paths for reported storage errors. */
	private static fromStorageWithPaths(
		storage: SettingsStorage,
		options: SettingsManagerCreateOptions,
		settingsPaths: SettingsPaths = {},
	): SettingsManager {
		const projectTrusted = options.projectTrusted ?? true;
		const globalLoad = SettingsManager.tryLoadFromStorage(storage, "global");
		const projectLoad = SettingsManager.tryLoadFromStorage(storage, "project", projectTrusted);
		const initialErrors: SettingsError[] = [];
		if (globalLoad.error) {
			initialErrors.push(toSettingsError("global", globalLoad.error, settingsPaths.global));
		}
		if (projectLoad.error) {
			initialErrors.push(toSettingsError("project", projectLoad.error, settingsPaths.project));
		}

		return new SettingsManager(
			storage,
			globalLoad.settings,
			projectLoad.settings,
			globalLoad.error,
			projectLoad.error,
			initialErrors,
			projectTrusted,
			settingsPaths,
		);
	}

	/** Create an in-memory SettingsManager (no file I/O) */
	static inMemory(settings: Partial<Settings> = {}, options: SettingsManagerCreateOptions = {}): SettingsManager {
		const storage = new InMemorySettingsStorage();
		const initialSettings = SettingsManager.migrateSettings(structuredClone(settings) as Record<string, unknown>);
		storage.withLock("global", () => JSON.stringify(initialSettings, null, 2));
		return SettingsManager.fromStorage(storage, options);
	}

	private static loadFromStorage(storage: SettingsStorage, scope: SettingsScope, projectTrusted = true): Settings {
		if (scope === "project" && !projectTrusted) {
			return {};
		}

		let content: string | undefined;
		storage.withLock(scope, (current) => {
			content = current;
			return undefined;
		});

		if (!content) {
			return {};
		}
		const settings = JSON.parse(stripBom(content));
		return SettingsManager.migrateSettings(settings);
	}

	private static tryLoadFromStorage(
		storage: SettingsStorage,
		scope: SettingsScope,
		projectTrusted = true,
	): { settings: Settings; error: Error | null } {
		try {
			return { settings: SettingsManager.loadFromStorage(storage, scope, projectTrusted), error: null };
		} catch (error) {
			return { settings: {}, error: error as Error };
		}
	}

	/** Migrate old settings format to new format */
	private static migrateSettings(settings: Record<string, unknown>): Settings {
		for (const leftover of [
			"enableInstallTelemetry",
			"enableAnalytics",
			"trackingId",
			"packages",
			"extensions",
			"themes",
			// Subagents (task tool, /delegate) were removed: old values are ignored.
			"subagents",
		]) {
			delete settings[leftover];
		}

		// Migrate queueMode -> steeringMode
		if ("queueMode" in settings && !("steeringMode" in settings)) {
			settings.steeringMode = settings.queueMode;
			delete settings.queueMode;
		}

		// Migrate legacy websockets boolean -> transport enum
		if (!("transport" in settings) && typeof settings.websockets === "boolean") {
			settings.transport = settings.websockets ? "websocket" : "sse";
			delete settings.websockets;
		}

		// Migrate old skills object format to new array format
		if (
			"skills" in settings &&
			typeof settings.skills === "object" &&
			settings.skills !== null &&
			!Array.isArray(settings.skills)
		) {
			const skillsSettings = settings.skills as {
				enableSkillCommands?: boolean;
				customDirectories?: unknown;
			};
			if (skillsSettings.enableSkillCommands !== undefined && settings.enableSkillCommands === undefined) {
				settings.enableSkillCommands = skillsSettings.enableSkillCommands;
			}
			if (Array.isArray(skillsSettings.customDirectories) && skillsSettings.customDirectories.length > 0) {
				settings.skills = skillsSettings.customDirectories;
			} else {
				delete settings.skills;
			}
		}

		// Migrate retry.maxDelayMs -> retry.provider.maxRetryDelayMs
		if (
			"retry" in settings &&
			typeof settings.retry === "object" &&
			settings.retry !== null &&
			!Array.isArray(settings.retry)
		) {
			const retrySettings = settings.retry as Record<string, unknown>;
			const providerSettings =
				typeof retrySettings.provider === "object" && retrySettings.provider !== null
					? (retrySettings.provider as Record<string, unknown>)
					: undefined;
			if (
				typeof retrySettings.maxDelayMs === "number" &&
				(providerSettings?.maxRetryDelayMs === undefined || providerSettings?.maxRetryDelayMs === null)
			) {
				retrySettings.provider = {
					...(providerSettings ?? {}),
					maxRetryDelayMs: retrySettings.maxDelayMs,
				};
			}
			delete retrySettings.maxDelayMs;
		}

		return settings as Settings;
	}

	/** A copy of the effective settings: global and project settings merged, with overrides. */
	getSettings(): Settings {
		return structuredClone(this.settings);
	}

	getGlobalSettings(): Settings {
		return structuredClone(this.globalSettings);
	}

	getProjectSettings(): Settings {
		return structuredClone(this.projectSettings);
	}

	isProjectTrusted(): boolean {
		return this.projectTrusted;
	}

	setProjectTrusted(trusted: boolean): void {
		if (this.projectTrusted === trusted) {
			return;
		}

		this.projectTrusted = trusted;
		this.modifiedProjectFields.clear();
		this.modifiedProjectNestedFields.clear();

		if (!trusted) {
			this.projectSettings = {};
			this.projectSettingsLoadError = null;
			this.settings = deepMergeSettings(this.globalSettings, withoutGlobalOnly(this.projectSettings));
			return;
		}

		const projectLoad = SettingsManager.tryLoadFromStorage(this.storage, "project", trusted);
		this.projectSettings = projectLoad.settings;
		this.projectSettingsLoadError = projectLoad.error;
		if (projectLoad.error) {
			this.recordError("project", projectLoad.error);
		}
		this.settings = deepMergeSettings(this.globalSettings, withoutGlobalOnly(this.projectSettings));
	}

	async reload(): Promise<void> {
		await this.writeQueue;
		const globalLoad = SettingsManager.tryLoadFromStorage(this.storage, "global");
		if (!globalLoad.error) {
			this.globalSettings = globalLoad.settings;
			this.globalSettingsLoadError = null;
		} else {
			this.globalSettingsLoadError = globalLoad.error;
			this.recordError("global", globalLoad.error);
		}

		this.modifiedFields.clear();
		this.modifiedNestedFields.clear();
		this.modifiedProjectFields.clear();
		this.modifiedProjectNestedFields.clear();

		const projectLoad = SettingsManager.tryLoadFromStorage(this.storage, "project", this.projectTrusted);
		if (!projectLoad.error) {
			this.projectSettings = projectLoad.settings;
			this.projectSettingsLoadError = null;
		} else {
			this.projectSettingsLoadError = projectLoad.error;
			this.recordError("project", projectLoad.error);
		}

		this.settings = deepMergeSettings(this.globalSettings, withoutGlobalOnly(this.projectSettings));
	}

	/** Apply additional overrides on top of current settings */
	applyOverrides(overrides: Partial<Settings>): void {
		this.settings = deepMergeSettings(this.settings, overrides);
	}

	/** Mark a global field as modified during this session */
	private markModified(field: keyof Settings, nestedKey?: string): void {
		this.modifiedFields.add(field);
		if (nestedKey) {
			if (!this.modifiedNestedFields.has(field)) {
				this.modifiedNestedFields.set(field, new Set());
			}
			this.modifiedNestedFields.get(field)!.add(nestedKey);
		}
	}

	/** Mark a project field as modified during this session */
	private markProjectModified(field: keyof Settings, nestedKey?: string): void {
		this.modifiedProjectFields.add(field);
		if (nestedKey) {
			if (!this.modifiedProjectNestedFields.has(field)) {
				this.modifiedProjectNestedFields.set(field, new Set());
			}
			this.modifiedProjectNestedFields.get(field)!.add(nestedKey);
		}
	}

	private assertProjectTrustedForWrite(): void {
		if (!this.projectTrusted) {
			throw new Error("Project is not trusted; refusing to write project settings");
		}
	}

	private recordError(scope: SettingsScope, error: unknown): void {
		this.errors.push(toSettingsError(scope, error, this.settingsPaths[scope]));
	}

	private clearModifiedScope(scope: SettingsScope): void {
		if (scope === "global") {
			this.modifiedFields.clear();
			this.modifiedNestedFields.clear();
			return;
		}

		this.modifiedProjectFields.clear();
		this.modifiedProjectNestedFields.clear();
	}

	private enqueueWrite(scope: SettingsScope, task: () => void): void {
		this.writeQueue = this.writeQueue
			.then(() => {
				if (scope === "project") {
					this.assertProjectTrustedForWrite();
				}
				task();
				this.clearModifiedScope(scope);
			})
			.catch((error) => {
				this.recordError(scope, error);
			});
	}

	private cloneModifiedNestedFields(source: Map<keyof Settings, Set<string>>): Map<keyof Settings, Set<string>> {
		const snapshot = new Map<keyof Settings, Set<string>>();
		for (const [key, value] of source.entries()) {
			snapshot.set(key, new Set(value));
		}
		return snapshot;
	}

	private persistScopedSettings(
		scope: SettingsScope,
		snapshotSettings: Settings,
		modifiedFields: Set<keyof Settings>,
		modifiedNestedFields: Map<keyof Settings, Set<string>>,
	): void {
		this.storage.withLock(scope, (current) => {
			const currentFileSettings = current
				? SettingsManager.migrateSettings(JSON.parse(stripBom(current)) as Record<string, unknown>)
				: {};
			const mergedSettings: Settings = { ...currentFileSettings };
			for (const field of modifiedFields) {
				const value = snapshotSettings[field];
				if (modifiedNestedFields.has(field) && typeof value === "object" && value !== null) {
					const nestedModified = modifiedNestedFields.get(field)!;
					const baseNested = (currentFileSettings[field] as Record<string, unknown>) ?? {};
					const inMemoryNested = value as Record<string, unknown>;
					const mergedNested = { ...baseNested };
					for (const nestedKey of nestedModified) {
						mergedNested[nestedKey] = inMemoryNested[nestedKey];
					}
					(mergedSettings as Record<string, unknown>)[field] = mergedNested;
				} else {
					(mergedSettings as Record<string, unknown>)[field] = value;
				}
			}

			return JSON.stringify(mergedSettings, null, 2);
		});
	}

	private save(): void {
		this.settings = deepMergeSettings(this.globalSettings, withoutGlobalOnly(this.projectSettings));

		if (this.globalSettingsLoadError) {
			return;
		}

		const snapshotGlobalSettings = structuredClone(this.globalSettings);
		const modifiedFields = new Set(this.modifiedFields);
		const modifiedNestedFields = this.cloneModifiedNestedFields(this.modifiedNestedFields);

		this.enqueueWrite("global", () => {
			this.persistScopedSettings("global", snapshotGlobalSettings, modifiedFields, modifiedNestedFields);
		});
	}

	private saveProjectSettings(settings: Settings): void {
		this.assertProjectTrustedForWrite();
		this.projectSettings = structuredClone(settings);
		this.settings = deepMergeSettings(this.globalSettings, withoutGlobalOnly(this.projectSettings));

		if (this.projectSettingsLoadError) {
			return;
		}

		const snapshotProjectSettings = structuredClone(this.projectSettings);
		const modifiedFields = new Set(this.modifiedProjectFields);
		const modifiedNestedFields = this.cloneModifiedNestedFields(this.modifiedProjectNestedFields);
		this.enqueueWrite("project", () => {
			this.persistScopedSettings("project", snapshotProjectSettings, modifiedFields, modifiedNestedFields);
		});
	}

	private updateProjectSettings(field: keyof Settings, update: (settings: Settings) => void): void {
		this.assertProjectTrustedForWrite();
		const projectSettings = structuredClone(this.projectSettings);
		update(projectSettings);
		this.markProjectModified(field);
		this.saveProjectSettings(projectSettings);
	}

	async flush(): Promise<void> {
		await this.writeQueue;
	}

	/** Global-only keys (GLOBAL_ONLY_SETTINGS) the project settings file sets; they are ignored. */
	getIgnoredProjectSettings(): string[] {
		if (!this.projectTrusted) return [];
		return GLOBAL_ONLY_SETTINGS.filter((key) => this.projectSettings[key] !== undefined);
	}

	/** Parse errors of the settings files as last loaded (not drained), for /doctor. */
	getLoadErrors(): Array<{ scope: SettingsScope; message: string }> {
		const errors: Array<{ scope: SettingsScope; message: string }> = [];
		if (this.globalSettingsLoadError) errors.push({ scope: "global", message: this.globalSettingsLoadError.message });
		if (this.projectSettingsLoadError)
			errors.push({ scope: "project", message: this.projectSettingsLoadError.message });
		return errors;
	}

	drainErrors(): SettingsError[] {
		const drained = [...this.errors];
		this.errors = [];
		return drained;
	}

	getLastChangelogVersion(): string | undefined {
		return this.settings.lastChangelogVersion;
	}

	setLastChangelogVersion(version: string): void {
		this.globalSettings.lastChangelogVersion = version;
		this.markModified("lastChangelogVersion");
		this.save();
	}

	getSessionDir(): string | undefined {
		const sessionDir = this.settings.sessionDir;
		return sessionDir ? normalizePath(sessionDir) : sessionDir;
	}

	getDefaultProvider(): string | undefined {
		return this.settings.defaultProvider;
	}

	getDefaultModel(): string | undefined {
		return this.settings.defaultModel;
	}

	setDefaultProvider(provider: string): void {
		this.globalSettings.defaultProvider = provider;
		this.markModified("defaultProvider");
		this.save();
	}

	setDefaultModel(modelId: string): void {
		this.globalSettings.defaultModel = modelId;
		this.markModified("defaultModel");
		this.save();
	}

	setDefaultModelAndProvider(provider: string, modelId: string): void {
		this.globalSettings.defaultProvider = provider;
		this.globalSettings.defaultModel = modelId;
		this.markModified("defaultProvider");
		this.markModified("defaultModel");
		this.save();
	}

	/** RunKiln model role overrides (model ids from models.yaml). */
	getModelRoles(): NonNullable<Settings["models"]> {
		return { ...(this.settings.models ?? {}) };
	}

	setModelRole(role: "code" | "chat" | "title", modelId: string): void {
		this.globalSettings.models = { ...(this.globalSettings.models ?? {}), [role]: modelId };
		this.markModified("models");
		this.save();
	}

	getSteeringMode(): "all" | "one-at-a-time" {
		return this.settings.steeringMode || SETTINGS_DEFAULTS.steeringMode;
	}

	setSteeringMode(mode: "all" | "one-at-a-time"): void {
		this.globalSettings.steeringMode = mode;
		this.markModified("steeringMode");
		this.save();
	}

	getFollowUpMode(): "all" | "one-at-a-time" {
		return this.settings.followUpMode || SETTINGS_DEFAULTS.followUpMode;
	}

	setFollowUpMode(mode: "all" | "one-at-a-time"): void {
		this.globalSettings.followUpMode = mode;
		this.markModified("followUpMode");
		this.save();
	}

	getThemeSetting(): string | undefined {
		const value = this.settings.theme;
		if (typeof value === "string") return value;
		return undefined;
	}

	getTheme(): string | undefined {
		const theme = this.getThemeSetting();
		return theme?.includes("/") ? undefined : theme;
	}

	setTheme(theme: string): void {
		this.globalSettings.theme = theme;
		this.markModified("theme");
		this.save();
	}

	/** Router settings, read from global settings only: a project must not redirect prompts. */
	getRouterSettings(): RouterSettingsInput {
		return structuredClone(this.globalSettings.router ?? {});
	}

	/** The saved permission mode, read from global settings only: a project must not loosen permissions. */
	getPermissionMode(): string | undefined {
		const permissions: unknown = this.globalSettings.permissions;
		// A bare string was written by pre-release builds of the setup screen.
		if (typeof permissions === "string") return permissions;
		const mode = this.globalSettings.permissions?.mode;
		return typeof mode === "string" ? mode : undefined;
	}

	setPermissionMode(mode: "ask" | "read-write" | "plan" | "auto" | "allow-all"): void {
		const current: unknown = this.globalSettings.permissions;
		const base =
			current && typeof current === "object" && !Array.isArray(current) ? this.globalSettings.permissions : {};
		this.globalSettings.permissions = { ...base, mode };
		this.markModified("permissions", "mode");
		this.save();
	}

	/** `permissions.readsOutsideProject`, read from global settings only. Undefined means the default ("ask"). */
	getReadsOutsideProject(): "ask" | "allow" | undefined {
		const value = this.globalPermissionsObject().readsOutsideProject;
		return value === "ask" || value === "allow" ? value : undefined;
	}

	/**
	 * The approval prompt timeout (permissions.promptTimeoutSec and permissions.timeoutAction). Project settings may set
	 * it too: a timeout only changes how long a prompt waits, never what runs.
	 */
	getApprovalTimeoutPolicy(): ApprovalTimeoutPolicy {
		const permissions: unknown = this.settings.permissions;
		if (!permissions || typeof permissions !== "object" || Array.isArray(permissions)) {
			return { ...DEFAULT_APPROVAL_TIMEOUT_POLICY };
		}
		return approvalTimeoutPolicy(permissions as { promptTimeoutSec?: unknown; timeoutAction?: unknown });
	}

	private globalPermissionsObject(): NonNullable<Settings["permissions"]> {
		const current: unknown = this.globalSettings.permissions;
		return current && typeof current === "object" && !Array.isArray(current)
			? (current as NonNullable<Settings["permissions"]>)
			: {};
	}

	/**
	 * Saved permission rules: `global` (permissions.allow/ask/deny in global settings), `project` (global settings,
	 * permissions.projects[<project folder>]) and `project-file` (the project's .runkiln/settings.json; its allow
	 * rules are ignored by the gate, see permission-rules.ts). Values are returned as stored, unvalidated.
	 */
	getPermissionRuleLists(
		scope: "global" | "project" | "project-file",
		projectDir?: string,
	): { allow?: unknown; ask?: unknown; deny?: unknown } {
		if (scope === "project-file") {
			const permissions: unknown = this.projectSettings.permissions;
			if (!permissions || typeof permissions !== "object" || Array.isArray(permissions)) return {};
			const { allow, ask, deny } = permissions as Record<string, unknown>;
			return structuredClone({ allow, ask, deny });
		}
		const permissions = this.globalPermissionsObject();
		if (scope === "global") {
			const { allow, ask, deny } = permissions;
			return structuredClone({ allow, ask, deny });
		}
		const projects: unknown = permissions.projects;
		if (!projectDir || !projects || typeof projects !== "object") return {};
		const entry = (projects as Record<string, unknown>)[resolvePath(projectDir)];
		return entry && typeof entry === "object" ? structuredClone(entry as Record<string, unknown>) : {};
	}

	/** Replace one rule list of the global or per-project (global settings) rules. */
	setPermissionRuleList(
		scope: "global" | "project",
		action: "allow" | "ask" | "deny",
		rules: string[],
		projectDir?: string,
	): void {
		const permissions = { ...this.globalPermissionsObject() };
		if (scope === "global") {
			if (rules.length > 0) permissions[action] = [...rules];
			else delete permissions[action];
			this.globalSettings.permissions = permissions;
			this.markModified("permissions", action);
		} else {
			if (!projectDir) throw new Error("A project folder is needed for project rules.");
			const key = resolvePath(projectDir);
			const projects = { ...(permissions.projects ?? {}) };
			const entry = { ...(projects[key] ?? {}) };
			if (rules.length > 0) entry[action] = [...rules];
			else delete entry[action];
			if (Object.keys(entry).length > 0) projects[key] = entry;
			else delete projects[key];
			permissions.projects = projects;
			this.globalSettings.permissions = permissions;
			this.markModified("permissions", "projects");
		}
		this.save();
	}

	getDefaultThinkingLevel(): ThinkingLevel | undefined {
		return this.settings.defaultThinkingLevel;
	}

	setDefaultThinkingLevel(level: ThinkingLevel): void {
		this.globalSettings.defaultThinkingLevel = level;
		this.markModified("defaultThinkingLevel");
		this.save();
	}

	getModelThinkingLevel(provider: string, modelId: string): ThinkingLevel | undefined {
		return this.settings.modelThinkingLevels?.[`${provider}/${modelId}`];
	}

	getAllModelThinkingLevels(): Record<string, ThinkingLevel> {
		return { ...(this.settings.modelThinkingLevels ?? {}) };
	}

	setModelThinkingLevel(provider: string, modelId: string, level: ThinkingLevel): void {
		if (!this.globalSettings.modelThinkingLevels) {
			this.globalSettings.modelThinkingLevels = {};
		}
		this.globalSettings.modelThinkingLevels[`${provider}/${modelId}`] = level;
		this.markModified("modelThinkingLevels");
		this.save();
	}

	removeModelThinkingLevel(provider: string, modelId: string): void {
		if (!this.globalSettings.modelThinkingLevels) return;
		delete this.globalSettings.modelThinkingLevels[`${provider}/${modelId}`];
		if (Object.keys(this.globalSettings.modelThinkingLevels).length === 0) {
			delete this.globalSettings.modelThinkingLevels;
		}
		this.markModified("modelThinkingLevels");
		this.save();
	}

	getTransport(): TransportSetting {
		return this.settings.transport ?? SETTINGS_DEFAULTS.transport;
	}

	setTransport(transport: TransportSetting): void {
		this.globalSettings.transport = transport;
		this.markModified("transport");
		this.save();
	}

	getSessionShareDestination(): SessionShareDestination {
		const destination = this.settings.sessionShareDestination;
		return destination === "gist" || destination === "radius"
			? destination
			: SETTINGS_DEFAULTS.sessionShareDestination;
	}

	setSessionShareDestination(destination: SessionShareDestination): void {
		this.globalSettings.sessionShareDestination = destination;
		this.markModified("sessionShareDestination");
		this.save();
	}

	getCompactionEnabled(): boolean {
		return this.settings.compaction?.enabled ?? SETTINGS_DEFAULTS.compaction.enabled;
	}

	setCompactionEnabled(enabled: boolean): void {
		if (!this.globalSettings.compaction) {
			this.globalSettings.compaction = {};
		}
		this.globalSettings.compaction.enabled = enabled;
		this.markModified("compaction", "enabled");
		this.save();
	}

	private getCompactionTokenSetting(
		field: keyof CompactionModelOverride,
		model?: Pick<Model<string>, "provider" | "id">,
	): number {
		const compaction = this.settings.compaction;
		const ordinary = compaction?.[field];
		if (ordinary !== undefined && (typeof ordinary !== "number" || !Number.isSafeInteger(ordinary) || ordinary < 0)) {
			throw new Error(
				`Invalid compaction.${field} setting: ${String(ordinary)}. Expected a non-negative safe integer.`,
			);
		}

		const modelKey = model ? `${model.provider}/${model.id}` : undefined;
		const entry = modelKey !== undefined ? compaction?.modelOverrides?.[modelKey] : undefined;
		if (entry !== undefined && !isMergeableObject(entry)) {
			throw new Error(
				`Invalid compaction.modelOverrides["${modelKey}"] setting: ${String(entry)}. Expected an object.`,
			);
		}
		const override = entry?.[field];
		if (override !== undefined && (typeof override !== "number" || !Number.isSafeInteger(override) || override < 0)) {
			throw new Error(
				`Invalid compaction.modelOverrides["${modelKey}"].${field} setting: ${String(override)}. Expected a non-negative safe integer.`,
			);
		}
		return override ?? ordinary ?? DEFAULT_COMPACTION_TOKEN_SETTINGS[field];
	}

	getCompactionReserveTokens(model?: Pick<Model<string>, "provider" | "id">): number {
		return this.getCompactionTokenSetting("reserveTokens", model);
	}

	getCompactionKeepRecentTokens(model?: Pick<Model<string>, "provider" | "id">): number {
		return this.getCompactionTokenSetting("keepRecentTokens", model);
	}

	getCompactionTriggerTokens(): number | "auto" {
		const value = this.settings.compaction?.triggerTokens;
		return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : "auto";
	}

	getCompactionReuseSessionPrefix(): boolean {
		return this.settings.compaction?.reuseSessionPrefix ?? SETTINGS_DEFAULTS.compaction.reuseSessionPrefix;
	}

	/** Resolve each token setting through model override, ordinary setting, then built-in default. */
	getCompactionSettings(model?: Pick<Model<string>, "provider" | "id">): {
		enabled: boolean;
		reserveTokens: number;
		keepRecentTokens: number;
		triggerTokens: number | "auto";
	} {
		return {
			enabled: this.getCompactionEnabled(),
			reserveTokens: this.getCompactionReserveTokens(model),
			keepRecentTokens: this.getCompactionKeepRecentTokens(model),
			triggerTokens: this.getCompactionTriggerTokens(),
		};
	}

	getBranchSummarySettings(): { reserveTokens: number; skipPrompt: boolean } {
		return {
			reserveTokens: this.settings.branchSummary?.reserveTokens ?? SETTINGS_DEFAULTS.branchSummary.reserveTokens,
			skipPrompt: this.settings.branchSummary?.skipPrompt ?? SETTINGS_DEFAULTS.branchSummary.skipPrompt,
		};
	}

	getBranchSummarySkipPrompt(): boolean {
		return this.settings.branchSummary?.skipPrompt ?? SETTINGS_DEFAULTS.branchSummary.skipPrompt;
	}

	getRetryEnabled(): boolean {
		return this.settings.retry?.enabled ?? SETTINGS_DEFAULTS.retry.enabled;
	}

	setRetryEnabled(enabled: boolean): void {
		if (!this.globalSettings.retry) {
			this.globalSettings.retry = {};
		}
		this.globalSettings.retry.enabled = enabled;
		this.markModified("retry", "enabled");
		this.save();
	}

	getRetrySettings(): { enabled: boolean; maxRetries: number; baseDelayMs: number; maxAgentDelayMs: number } {
		return {
			enabled: this.getRetryEnabled(),
			maxRetries: this.settings.retry?.maxRetries ?? SETTINGS_DEFAULTS.retry.maxRetries,
			baseDelayMs: this.settings.retry?.baseDelayMs ?? SETTINGS_DEFAULTS.retry.baseDelayMs,
			maxAgentDelayMs: this.settings.retry?.maxAgentDelayMs ?? SETTINGS_DEFAULTS.retry.maxAgentDelayMs,
		};
	}

	/** Model failover and the stall check (on by default). */
	getFailoverSettings(): { enabled: boolean; retries: number; stallTimeoutMs: number; cooldownMs?: number } {
		const failover = this.settings.failover;
		const number = (value: unknown, fallback: number) =>
			typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
		const cooldownSec = failover?.cooldownSec;
		return {
			enabled: failover?.enabled ?? SETTINGS_DEFAULTS.failover.enabled,
			retries: Math.floor(number(failover?.retries, SETTINGS_DEFAULTS.failover.retries)),
			stallTimeoutMs: number(failover?.stallTimeoutSec, SETTINGS_DEFAULTS.failover.stallTimeoutSec) * 1000,
			cooldownMs:
				typeof cooldownSec === "number" && Number.isFinite(cooldownSec) && cooldownSec >= 0
					? cooldownSec * 1000
					: undefined,
		};
	}

	setFailoverEnabled(enabled: boolean): void {
		if (!this.globalSettings.failover) this.globalSettings.failover = {};
		this.globalSettings.failover.enabled = enabled;
		this.markModified("failover", "enabled");
		this.save();
	}

	getRepoMapSettings(): { enabled: boolean; firstTurnTokens: number; tokens: number } {
		const value = this.settings.repoMap;
		const int = (input: unknown, fallback: number, min: number, max: number) =>
			typeof input === "number" && Number.isFinite(input)
				? Math.min(max, Math.max(min, Math.floor(input)))
				: fallback;
		return {
			enabled: typeof value?.enabled === "boolean" ? value.enabled : SETTINGS_DEFAULTS.repoMap.enabled,
			firstTurnTokens: int(value?.firstTurnTokens, SETTINGS_DEFAULTS.repoMap.firstTurnTokens, 0, 8192),
			tokens: int(value?.tokens, SETTINGS_DEFAULTS.repoMap.tokens, 64, 8192),
		};
	}

	/** The todo tool: offered, and whether a run that ends with unfinished items gets one hidden reminder. */
	getTodoSettings(): { enabled: boolean; nudge: boolean } {
		const value = this.settings.todo;
		return {
			enabled: typeof value?.enabled === "boolean" ? value.enabled : SETTINGS_DEFAULTS.todo.enabled,
			nudge: typeof value?.nudge === "boolean" ? value.nudge : SETTINGS_DEFAULTS.todo.nudge,
		};
	}

	/** Idle compaction: on, and the smallest context it compacts. */
	getIdleCompactionSettings(): { enabled: boolean; minTokens: number } {
		const value = this.settings.compaction;
		const min = value?.idleMinTokens;
		return {
			enabled:
				this.getCompactionEnabled() &&
				(typeof value?.idleCompact === "boolean" ? value.idleCompact : SETTINGS_DEFAULTS.compaction.idleCompact),
			minTokens:
				typeof min === "number" && Number.isSafeInteger(min) && min >= 0
					? min
					: SETTINGS_DEFAULTS.compaction.idleMinTokens,
		};
	}

	getNotificationsMode(): "auto" | "bell" | "off" {
		const value = this.settings.notifications;
		return value === "auto" || value === "bell" || value === "off" ? value : SETTINGS_DEFAULTS.notifications;
	}

	setNotificationsMode(mode: "auto" | "bell" | "off"): void {
		this.globalSettings.notifications = mode;
		this.markModified("notifications");
		this.save();
	}

	getGitAutoCommit(): "off" | "turn" {
		return this.settings.git?.autoCommit === "turn" ? "turn" : "off";
	}

	/** git.coAuthor: "Name <email>" for a Co-authored-by trailer, or "" (default) for none. */
	getGitCoAuthor(): string {
		const value = this.settings.git?.coAuthor;
		return typeof value === "string" ? value.trim() : SETTINGS_DEFAULTS.git.coAuthor;
	}

	setGitAutoCommit(mode: "off" | "turn"): void {
		if (!this.globalSettings.git) this.globalSettings.git = {};
		this.globalSettings.git.autoCommit = mode;
		this.markModified("git", "autoCommit");
		this.save();
	}

	/** Post-edit diagnostics (`checks`): `false` turns them off. */
	getChecksSettings(): {
		enabled: boolean;
		autoDetect: boolean;
		timeoutMs: number;
		commands?: Record<string, string>;
	} {
		const value: unknown = this.settings.checks;
		const defaults = SETTINGS_DEFAULTS.checks;
		if (value === false) return { enabled: false, autoDetect: defaults.autoDetect, timeoutMs: defaults.timeoutMs };
		const obj = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
		const commands =
			obj.commands && typeof obj.commands === "object"
				? Object.fromEntries(
						Object.entries(obj.commands as Record<string, unknown>).filter(
							(entry): entry is [string, string] => typeof entry[1] === "string",
						),
					)
				: undefined;
		const timeout = typeof obj.timeoutMs === "number" && Number.isFinite(obj.timeoutMs) ? obj.timeoutMs : undefined;
		return {
			enabled: typeof obj.enabled === "boolean" ? obj.enabled : defaults.enabled,
			autoDetect: typeof obj.autoDetect === "boolean" ? obj.autoDetect : defaults.autoDetect,
			timeoutMs: Math.min(60000, Math.max(500, Math.floor(timeout ?? defaults.timeoutMs))),
			...(commands && Object.keys(commands).length > 0 ? { commands } : {}),
		};
	}

	setChecksEnabled(enabled: boolean): void {
		const current: unknown = this.globalSettings.checks;
		const base = current && typeof current === "object" ? (current as object) : {};
		this.globalSettings.checks = { ...base, enabled };
		this.markModified("checks");
		this.save();
	}

	/** The verify loop. A `verify.command` set only in global settings is trusted; one from the project is confirmed. */
	getVerifySettings(): {
		mode: "off" | "ask" | "auto";
		command?: string;
		commandTrusted: boolean;
		maxRetries: number;
		timeoutMs: number;
	} {
		const value = this.settings.verify ?? {};
		const defaults = SETTINGS_DEFAULTS.verify;
		const mode = value.mode === "off" || value.mode === "ask" || value.mode === "auto" ? value.mode : defaults.mode;
		const command = typeof value.command === "string" && value.command.trim() ? value.command.trim() : undefined;
		const projectCommand = this.projectSettings.verify?.command;
		const int = (input: unknown, fallback: number, min: number, max: number) =>
			typeof input === "number" && Number.isFinite(input)
				? Math.min(max, Math.max(min, Math.floor(input)))
				: fallback;
		return {
			mode,
			...(command ? { command } : {}),
			commandTrusted: !!command && !(typeof projectCommand === "string" && projectCommand.trim()),
			maxRetries: int(value.maxRetries, defaults.maxRetries, 0, 5),
			timeoutMs: int(value.timeoutMs, defaults.timeoutMs, 1000, 1_800_000),
		};
	}

	setVerifyMode(mode: "off" | "ask" | "auto"): void {
		this.globalSettings.verify = { ...(this.globalSettings.verify ?? {}), mode };
		this.markModified("verify");
		this.save();
	}

	/** The saved verify choice for a project folder (global settings only). */
	getVerifyProject(projectDir: string): { command?: string; decision: "always" | "never" } | undefined {
		const entry = this.globalSettings.verify?.projects?.[resolvePath(projectDir)];
		if (!entry || (entry.decision !== "always" && entry.decision !== "never")) return undefined;
		return { ...(typeof entry.command === "string" ? { command: entry.command } : {}), decision: entry.decision };
	}

	setVerifyProject(projectDir: string, entry: { command?: string; decision: "always" | "never" } | undefined): void {
		const verify = { ...(this.globalSettings.verify ?? {}) };
		const projects = { ...(verify.projects ?? {}) };
		const key = resolvePath(projectDir);
		if (entry) projects[key] = entry;
		else delete projects[key];
		verify.projects = projects;
		this.globalSettings.verify = verify;
		this.markModified("verify");
		this.save();
	}

	/** Chore-model repair of missed edits (`edit.autoRepair`, off by default). */
	getEditAutoRepair(): boolean {
		const value = this.settings.edit?.autoRepair;
		return typeof value === "boolean" ? value : SETTINGS_DEFAULTS.edit.autoRepair;
	}

	/** Model for side tasks, "<model>[:<thinking>]" or "session". Global settings only: it decides where prompts go. */
	/** `budget.session` / `budget.daily` in USD; invalid or non-positive values are ignored. */
	getBudgetSettings(): { session?: number; daily?: number } {
		const value = (this.settings as Record<string, unknown>).budget;
		if (!value || typeof value !== "object") return {};
		const pick = (key: "session" | "daily") => {
			const amount = (value as Record<string, unknown>)[key];
			return typeof amount === "number" && Number.isFinite(amount) && amount > 0 ? amount : undefined;
		};
		const session = pick("session");
		const daily = pick("daily");
		return { ...(session !== undefined ? { session } : {}), ...(daily !== undefined ? { daily } : {}) };
	}

	getChoreModel(): string {
		const value = this.globalSettings.choreModel;
		return typeof value === "string" && value.trim() ? value.trim() : SETTINGS_DEFAULTS.choreModel;
	}

	getHttpIdleTimeoutMs(): number {
		return parseTimeoutSetting(this.settings.httpIdleTimeoutMs, "httpIdleTimeoutMs") ?? DEFAULT_HTTP_IDLE_TIMEOUT_MS;
	}

	setHttpIdleTimeoutMs(timeoutMs: number): void {
		if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
			throw new Error(`Invalid httpIdleTimeoutMs setting: ${String(timeoutMs)}`);
		}
		this.globalSettings.httpIdleTimeoutMs = Math.floor(timeoutMs);
		this.markModified("httpIdleTimeoutMs");
		this.save();
	}

	/** Read from global settings only because warming costs money. */
	getCacheWarmingMode(): CacheWarmingMode {
		const mode = this.globalSettings.cacheWarming;
		return mode !== undefined && CACHE_WARMING_MODES.includes(mode) ? mode : SETTINGS_DEFAULTS.cacheWarming;
	}

	setCacheWarmingMode(mode: CacheWarmingMode): void {
		this.globalSettings.cacheWarming = mode;
		this.markModified("cacheWarming");
		this.save();
	}

	getProviderRetrySettings(): { timeoutMs?: number; maxRetries?: number; maxRetryDelayMs: number } {
		return {
			timeoutMs: this.settings.retry?.provider?.timeoutMs,
			maxRetries: this.settings.retry?.provider?.maxRetries,
			maxRetryDelayMs:
				this.settings.retry?.provider?.maxRetryDelayMs ?? SETTINGS_DEFAULTS.retry.provider.maxRetryDelayMs,
		};
	}

	getWebSocketConnectTimeoutMs(): number | undefined {
		return parseTimeoutSetting(this.settings.websocketConnectTimeoutMs, "websocketConnectTimeoutMs");
	}

	getHideThinkingBlock(): boolean {
		return this.settings.hideThinkingBlock ?? SETTINGS_DEFAULTS.hideThinkingBlock;
	}

	getShowCacheMissNotices(): boolean {
		return this.settings.showCacheMissNotices ?? SETTINGS_DEFAULTS.showCacheMissNotices;
	}

	getExternalEditorCommand(): string {
		const configuredEditor = this.settings.externalEditor;
		if (typeof configuredEditor === "string" && configuredEditor.trim() !== "") {
			return configuredEditor;
		}
		const environmentEditor = process.env.VISUAL || process.env.EDITOR;
		if (environmentEditor) {
			return environmentEditor;
		}
		return process.platform === "win32" ? "notepad" : "nano";
	}

	setHideThinkingBlock(hide: boolean): void {
		this.globalSettings.hideThinkingBlock = hide;
		this.markModified("hideThinkingBlock");
		this.save();
	}

	setShowCacheMissNotices(show: boolean): void {
		this.globalSettings.showCacheMissNotices = show;
		this.markModified("showCacheMissNotices");
		this.save();
	}

	getShellPath(): string | undefined {
		const shellPath = this.settings.shellPath;
		return shellPath ? normalizePath(shellPath) : shellPath;
	}

	setShellPath(path: string | undefined): void {
		this.globalSettings.shellPath = path;
		this.markModified("shellPath");
		this.save();
	}

	getQuietStartup(): QuietStartup {
		const value = this.settings.quietStartup;
		return value === true || value === "header" ? value : SETTINGS_DEFAULTS.quietStartup;
	}

	setQuietStartup(quiet: QuietStartup): void {
		this.globalSettings.quietStartup = quiet;
		this.markModified("quietStartup");
		this.save();
	}

	getDefaultProjectTrust(): DefaultProjectTrust {
		const value = this.globalSettings.defaultProjectTrust;
		return value === "always" || value === "never" ? value : SETTINGS_DEFAULTS.defaultProjectTrust;
	}

	setDefaultProjectTrust(defaultProjectTrust: DefaultProjectTrust): void {
		this.globalSettings.defaultProjectTrust = defaultProjectTrust;
		this.markModified("defaultProjectTrust");
		this.save();
	}

	/** The shellEnvironment policy (global settings only; see utils/shell.ts filterShellEnv). */
	getShellEnvironment(): ShellEnvironmentPolicy {
		const value: unknown = this.globalSettings.shellEnvironment;
		if (!value || typeof value !== "object" || Array.isArray(value)) return {};
		const raw = value as Record<string, unknown>;
		const strings = (list: unknown) =>
			Array.isArray(list) ? list.filter((item): item is string => typeof item === "string") : undefined;
		return {
			...(raw.inherit === "core" || raw.inherit === "all" ? { inherit: raw.inherit } : {}),
			...(typeof raw.hideSecrets === "boolean" ? { hideSecrets: raw.hideSecrets } : {}),
			...(strings(raw.exclude) ? { exclude: strings(raw.exclude) } : {}),
			...(strings(raw.include) ? { include: strings(raw.include) } : {}),
		};
	}

	getShellCommandPrefix(): string | undefined {
		return this.settings.shellCommandPrefix;
	}

	setShellCommandPrefix(prefix: string | undefined): void {
		this.globalSettings.shellCommandPrefix = prefix;
		this.markModified("shellCommandPrefix");
		this.save();
	}

	getNpmCommand(): string[] | undefined {
		return this.settings.npmCommand ? [...this.settings.npmCommand] : undefined;
	}

	setNpmCommand(command: string[] | undefined): void {
		this.globalSettings.npmCommand = command ? [...command] : undefined;
		this.markModified("npmCommand");
		this.save();
	}

	getCollapseChangelog(): boolean {
		return this.settings.collapseChangelog ?? SETTINGS_DEFAULTS.collapseChangelog;
	}

	setCollapseChangelog(collapse: boolean): void {
		this.globalSettings.collapseChangelog = collapse;
		this.markModified("collapseChangelog");
		this.save();
	}

	/**
	 * Stable ID of this installation, e.g. sent to OpenAI as its agent host ID.
	 * Created on first use. Project settings are ignored so a committed project
	 * settings file cannot give every clone the same ID.
	 */
	getOrCreateDeviceId(): string {
		if (!this.globalSettings.deviceId) {
			this.globalSettings.deviceId = randomUUID();
			this.markModified("deviceId");
			this.save();
		}
		return this.globalSettings.deviceId;
	}

	getSkillPaths(): string[] {
		return [...(this.settings.skills ?? [])];
	}

	setSkillPaths(paths: string[]): void {
		this.globalSettings.skills = paths;
		this.markModified("skills");
		this.save();
	}

	setProjectSkillPaths(paths: string[]): void {
		this.updateProjectSettings("skills", (settings) => {
			settings.skills = paths;
		});
	}

	getPromptTemplatePaths(): string[] {
		return [...(this.settings.prompts ?? [])];
	}

	setPromptTemplatePaths(paths: string[]): void {
		this.globalSettings.prompts = paths;
		this.markModified("prompts");
		this.save();
	}

	setProjectPromptTemplatePaths(paths: string[]): void {
		this.updateProjectSettings("prompts", (settings) => {
			settings.prompts = paths;
		});
	}

	getEnableSkillCommands(): boolean {
		return this.settings.enableSkillCommands ?? SETTINGS_DEFAULTS.enableSkillCommands;
	}

	setEnableSkillCommands(enabled: boolean): void {
		this.globalSettings.enableSkillCommands = enabled;
		this.markModified("enableSkillCommands");
		this.save();
	}

	getThinkingBudgets(): ThinkingBudgetsSettings | undefined {
		return this.settings.thinkingBudgets;
	}

	getTerminalCapabilityOverrides(): Partial<TerminalCapabilities> {
		const terminal = this.settings.terminal;
		const images = terminal?.images;
		return {
			...(images === "kitty" || images === "iterm2" ? { images } : images === false ? { images: null } : {}),
			...(typeof terminal?.trueColor === "boolean" ? { trueColor: terminal.trueColor } : {}),
			...(typeof terminal?.hyperlinks === "boolean" ? { hyperlinks: terminal.hyperlinks } : {}),
		};
	}

	getShowImages(): boolean {
		return this.settings.terminal?.showImages ?? SETTINGS_DEFAULTS.terminal.showImages;
	}

	setShowImages(show: boolean): void {
		if (!this.globalSettings.terminal) {
			this.globalSettings.terminal = {};
		}
		this.globalSettings.terminal.showImages = show;
		this.markModified("terminal", "showImages");
		this.save();
	}

	getImageWidthCells(): number {
		const width = this.settings.terminal?.imageWidthCells;
		if (typeof width !== "number" || !Number.isFinite(width)) {
			return SETTINGS_DEFAULTS.terminal.imageWidthCells;
		}
		return Math.max(1, Math.floor(width));
	}

	setImageWidthCells(width: number): void {
		if (!this.globalSettings.terminal) {
			this.globalSettings.terminal = {};
		}
		this.globalSettings.terminal.imageWidthCells = Math.max(1, Math.floor(width));
		this.markModified("terminal", "imageWidthCells");
		this.save();
	}

	getUiHints(): boolean {
		return this.settings.ui?.hints ?? SETTINGS_DEFAULTS.ui.hints;
	}

	setUiHints(enabled: boolean): void {
		if (!this.globalSettings.ui) {
			this.globalSettings.ui = {};
		}
		this.globalSettings.ui.hints = enabled;
		this.markModified("ui", "hints");
		this.save();
	}

	getClearOnShrink(): boolean {
		// Settings takes precedence, then env var, then default false
		if (this.settings.terminal?.clearOnShrink !== undefined) {
			return this.settings.terminal.clearOnShrink;
		}
		if (process.env.RUNKILN_CLEAR_ON_SHRINK === "1") return true;
		return SETTINGS_DEFAULTS.terminal.clearOnShrink;
	}

	setClearOnShrink(enabled: boolean): void {
		if (!this.globalSettings.terminal) {
			this.globalSettings.terminal = {};
		}
		this.globalSettings.terminal.clearOnShrink = enabled;
		this.markModified("terminal", "clearOnShrink");
		this.save();
	}

	/** OSC 9;4 progress. Unset: on in Windows Terminal (tab ring and taskbar progress), off elsewhere. */
	getShowTerminalProgress(env: NodeJS.ProcessEnv = process.env): boolean {
		const configured = this.settings.terminal?.showTerminalProgress;
		if (configured !== undefined) return configured;
		if (env.WT_SESSION) return true;
		return SETTINGS_DEFAULTS.terminal.showTerminalProgress;
	}

	/** Rewrite every row each frame (`terminal.fullRepaint`, or RUNKILN_FULL_REPAINT=1). */
	getFullRepaint(env: NodeJS.ProcessEnv = process.env): boolean {
		if (env.RUNKILN_FULL_REPAINT === "1") return true;
		if (env.RUNKILN_FULL_REPAINT === "0") return false;
		return this.settings.terminal?.fullRepaint ?? SETTINGS_DEFAULTS.terminal.fullRepaint;
	}

	setFullRepaint(enabled: boolean): void {
		if (!this.globalSettings.terminal) this.globalSettings.terminal = {};
		this.globalSettings.terminal.fullRepaint = enabled;
		this.markModified("terminal", "fullRepaint");
		this.save();
	}

	getPointerShapeSetting(): "auto" | "on" | "off" {
		const value = this.settings.terminal?.pointerShape;
		return value === "on" || value === "off" || value === "auto" ? value : SETTINGS_DEFAULTS.terminal.pointerShape;
	}

	/** Fullscreen mouse capture (`mouse`); RUNKILN_MOUSE overrides it. */
	getMouseMode(env: NodeJS.ProcessEnv = process.env): "on" | "wheel" | "off" {
		const fromEnv = env.RUNKILN_MOUSE?.trim().toLowerCase();
		if (fromEnv === "on" || fromEnv === "wheel" || fromEnv === "off") return fromEnv;
		if (fromEnv === "0" || fromEnv === "false") return "off";
		const value = this.settings.mouse;
		return value === "on" || value === "wheel" || value === "off" ? value : SETTINGS_DEFAULTS.mouse;
	}

	setMouseMode(mode: "on" | "wheel" | "off"): void {
		this.globalSettings.mouse = mode;
		this.markModified("mouse");
		this.save();
	}

	/** Right click: card menu or clipboard paste. "auto" is paste on Windows outside VS Code, menu elsewhere. */
	getMouseRightClick(
		platform: NodeJS.Platform = process.platform,
		env: NodeJS.ProcessEnv = process.env,
	): "menu" | "paste" {
		const value = this.settings.mouseRightClick;
		if (value === "menu" || value === "paste") return value;
		return platform === "win32" && env.TERM_PROGRAM?.toLowerCase() !== "vscode" ? "paste" : "menu";
	}

	getRawMouseRightClick(): "auto" | "menu" | "paste" {
		const value = this.settings.mouseRightClick;
		return value === "menu" || value === "paste" ? value : "auto";
	}

	setPointerShapeSetting(value: "auto" | "on" | "off"): void {
		if (!this.globalSettings.terminal) this.globalSettings.terminal = {};
		this.globalSettings.terminal.pointerShape = value;
		this.markModified("terminal", "pointerShape");
		this.save();
	}

	setMouseRightClick(value: "auto" | "menu" | "paste"): void {
		this.globalSettings.mouseRightClick = value;
		this.markModified("mouseRightClick");
		this.save();
	}

	getCardActions(): boolean {
		return this.settings.cardActions ?? SETTINGS_DEFAULTS.cardActions;
	}

	setCardActions(enabled: boolean): void {
		this.globalSettings.cardActions = enabled;
		this.markModified("cardActions");
		this.save();
	}

	/** `editor.open`: a preset name or a template with {file}, {line}, {col}. */
	getEditorOpen(): string {
		const value = this.settings.editor?.open;
		return typeof value === "string" && value.trim() !== "" ? value.trim() : SETTINGS_DEFAULTS.editor.open;
	}

	setEditorOpen(value: string): void {
		this.globalSettings.editor = { ...(this.globalSettings.editor ?? {}), open: value };
		this.markModified("editor", "open");
		this.save();
	}

	setShowTerminalProgress(enabled: boolean): void {
		if (!this.globalSettings.terminal) {
			this.globalSettings.terminal = {};
		}
		this.globalSettings.terminal.showTerminalProgress = enabled;
		this.markModified("terminal", "showTerminalProgress");
		this.save();
	}

	/** Terminal title with the agent's state (`terminal.dynamicTitle`, default on). */
	getDynamicTitle(): boolean {
		return this.settings.terminal?.dynamicTitle ?? SETTINGS_DEFAULTS.terminal.dynamicTitle;
	}

	setDynamicTitle(enabled: boolean): void {
		if (!this.globalSettings.terminal) {
			this.globalSettings.terminal = {};
		}
		this.globalSettings.terminal.dynamicTitle = enabled;
		this.markModified("terminal", "dynamicTitle");
		this.save();
	}

	/** `footer.items`, or undefined for the default footer layout. */
	getFooterItems(): string[] | undefined {
		const items = this.settings.footer?.items;
		return Array.isArray(items) ? items.filter((item): item is string => typeof item === "string") : undefined;
	}

	/** Save `footer.items` globally; undefined goes back to the default layout. */
	setFooterItems(items: readonly string[] | undefined): void {
		if (!this.globalSettings.footer) {
			this.globalSettings.footer = {};
		}
		this.globalSettings.footer.items = items ? [...items] : undefined;
		this.markModified("footer", "items");
		this.save();
	}

	/** `footer.show`: footer parts turned on or off (only what is set; defaults fill the rest). */
	getFooterShow(): Record<string, boolean> {
		const show = this.settings.footer?.show;
		const result: Record<string, boolean> = {};
		if (typeof show !== "object" || show === null || Array.isArray(show)) return result;
		for (const [key, value] of Object.entries(show)) if (typeof value === "boolean") result[key] = value;
		return result;
	}

	/** Save `footer.show` globally; undefined goes back to the defaults. */
	setFooterShow(show: Readonly<Record<string, boolean>> | undefined): void {
		this.globalSettings.footer ??= {};
		this.globalSettings.footer.show = show ? { ...show } : undefined;
		this.markModified("footer", "show");
		this.save();
	}

	getReducedMotion(): boolean {
		return this.settings.ui?.reducedMotion === true;
	}

	setReducedMotion(enabled: boolean): void {
		if (!this.globalSettings.ui) {
			this.globalSettings.ui = {};
		}
		this.globalSettings.ui.reducedMotion = enabled;
		this.markModified("ui", "reducedMotion");
		this.save();
	}

	/** Columns for assistant prose (`ui.maxProseWidth`); 0 means no cap. */
	getMaxProseWidth(): number {
		const width = this.settings.ui?.maxProseWidth;
		if (typeof width !== "number" || !Number.isFinite(width)) return SETTINGS_DEFAULTS.ui.maxProseWidth;
		return width <= 0 ? 0 : Math.max(20, Math.floor(width));
	}

	setMaxProseWidth(width: number): void {
		if (!this.globalSettings.ui) {
			this.globalSettings.ui = {};
		}
		this.globalSettings.ui.maxProseWidth = width <= 0 ? 0 : Math.max(20, Math.floor(width));
		this.markModified("ui", "maxProseWidth");
		this.save();
	}

	getTuiMode(): TuiMode {
		return this.settings.tuiMode === "regular" ? "regular" : SETTINGS_DEFAULTS.tuiMode;
	}

	setTuiMode(mode: TuiMode): void {
		this.globalSettings.tuiMode = mode;
		this.markModified("tuiMode");
		this.save();
	}

	getFullscreenExitOutput(): FullscreenExitOutput {
		return this.settings.fullscreenExitOutput === "resume-hint"
			? "resume-hint"
			: SETTINGS_DEFAULTS.fullscreenExitOutput;
	}

	setFullscreenExitOutput(output: FullscreenExitOutput): void {
		this.globalSettings.fullscreenExitOutput = output;
		this.markModified("fullscreenExitOutput");
		this.save();
	}

	getFullscreenScrollbar(): ScrollViewScrollbar {
		const mode = this.settings.fullscreenScrollbar;
		return mode === "always" || mode === "hidden" ? mode : SETTINGS_DEFAULTS.fullscreenScrollbar;
	}

	setFullscreenScrollbar(mode: ScrollViewScrollbar): void {
		this.globalSettings.fullscreenScrollbar = mode;
		this.markModified("fullscreenScrollbar");
		this.save();
	}

	getFullscreenCopyOnSelect(): boolean {
		return this.settings.fullscreenCopyOnSelect ?? SETTINGS_DEFAULTS.fullscreenCopyOnSelect;
	}

	setFullscreenCopyOnSelect(enabled: boolean): void {
		this.globalSettings.fullscreenCopyOnSelect = enabled;
		this.markModified("fullscreenCopyOnSelect");
		this.save();
	}

	getFullscreenWheelScrollLines(): WheelScrollLines {
		const lines = this.settings.fullscreenWheelScrollLines;
		return typeof lines === "number" && Number.isFinite(lines)
			? Math.max(1, Math.min(100, Math.floor(lines)))
			: SETTINGS_DEFAULTS.fullscreenWheelScrollLines;
	}

	setFullscreenWheelScrollLines(lines: WheelScrollLines): void {
		this.globalSettings.fullscreenWheelScrollLines =
			lines === "auto" ? lines : Math.max(1, Math.min(100, Math.floor(lines)));
		this.markModified("fullscreenWheelScrollLines");
		this.save();
	}

	getImageAutoResize(): boolean {
		return this.settings.images?.autoResize ?? SETTINGS_DEFAULTS.images.autoResize;
	}

	setImageAutoResize(enabled: boolean): void {
		if (!this.globalSettings.images) {
			this.globalSettings.images = {};
		}
		this.globalSettings.images.autoResize = enabled;
		this.markModified("images", "autoResize");
		this.save();
	}

	getBlockImages(): boolean {
		return this.settings.images?.blockImages ?? SETTINGS_DEFAULTS.images.blockImages;
	}

	setBlockImages(blocked: boolean): void {
		if (!this.globalSettings.images) {
			this.globalSettings.images = {};
		}
		this.globalSettings.images.blockImages = blocked;
		this.markModified("images", "blockImages");
		this.save();
	}

	getEnabledModels(): string[] | undefined {
		return this.settings.enabledModels;
	}

	/** The resolved `defaultTools` selection, or undefined when no settings layer sets it. */
	getDefaultTools(): string[] | undefined {
		const tools = this.settings.defaultTools;
		if (tools === undefined) return undefined;
		return resolveDefaultTools(Array.isArray(tools) ? tools.filter((tool) => typeof tool === "string") : []);
	}

	setEnabledModels(patterns: string[] | undefined): void {
		this.globalSettings.enabledModels = patterns;
		this.markModified("enabledModels");
		this.save();
	}

	/** RunInfra model ids the user turned off in /models. Always an array (empty when unset). */
	getDisabledModels(): string[] {
		return normalizeDisabledModels(this.settings.disabledModels);
	}

	setDisabledModels(modelIds: readonly string[]): void {
		const ids = normalizeDisabledModels([...modelIds]);
		this.globalSettings.disabledModels = ids.length > 0 ? ids : undefined;
		this.markModified("disabledModels");
		this.save();
	}

	getDoubleEscapeAction(): "fork" | "tree" | "rewind" | "none" {
		return this.settings.doubleEscapeAction ?? SETTINGS_DEFAULTS.doubleEscapeAction;
	}

	setDoubleEscapeAction(action: "fork" | "tree" | "rewind" | "none"): void {
		this.globalSettings.doubleEscapeAction = action;
		this.markModified("doubleEscapeAction");
		this.save();
	}

	getTreeFilterMode(): "default" | "no-tools" | "user-only" | "labeled-only" | "all" {
		const mode = this.settings.treeFilterMode;
		const valid = ["default", "no-tools", "user-only", "labeled-only", "all"];
		return mode && valid.includes(mode) ? mode : SETTINGS_DEFAULTS.treeFilterMode;
	}

	setTreeFilterMode(mode: "default" | "no-tools" | "user-only" | "labeled-only" | "all"): void {
		this.globalSettings.treeFilterMode = mode;
		this.markModified("treeFilterMode");
		this.save();
	}

	getShowHardwareCursor(): boolean {
		return this.settings.showHardwareCursor ?? process.env.RUNKILN_HARDWARE_CURSOR === "1";
	}

	setShowHardwareCursor(enabled: boolean): void {
		this.globalSettings.showHardwareCursor = enabled;
		this.markModified("showHardwareCursor");
		this.save();
	}

	getEditorPaddingX(): number {
		return this.settings.editorPaddingX ?? SETTINGS_DEFAULTS.editorPaddingX;
	}

	setEditorPaddingX(padding: number): void {
		this.globalSettings.editorPaddingX = Math.max(0, Math.min(3, Math.floor(padding)));
		this.markModified("editorPaddingX");
		this.save();
	}

	getOutputPad(): 0 | 1 {
		return this.settings.outputPad === 0 ? 0 : SETTINGS_DEFAULTS.outputPad;
	}

	setOutputPad(padding: 0 | 1): void {
		this.globalSettings.outputPad = padding;
		this.markModified("outputPad");
		this.save();
	}

	getAutocompleteMaxVisible(): number {
		return this.settings.autocompleteMaxVisible ?? SETTINGS_DEFAULTS.autocompleteMaxVisible;
	}

	setAutocompleteMaxVisible(maxVisible: number): void {
		this.globalSettings.autocompleteMaxVisible = Math.max(3, Math.min(20, Math.floor(maxVisible)));
		this.markModified("autocompleteMaxVisible");
		this.save();
	}

	getCodeBlockIndent(): string {
		return this.settings.markdown?.codeBlockIndent ?? SETTINGS_DEFAULTS.markdown.codeBlockIndent;
	}

	getMermaidRenderingMode(): MermaidRenderingMode {
		const mode = this.settings.markdown?.mermaid;
		return mode === "off" || mode === "final" ? mode : SETTINGS_DEFAULTS.markdown.mermaid;
	}

	setMermaidRenderingMode(mode: MermaidRenderingMode): void {
		this.globalSettings.markdown ??= {};
		this.globalSettings.markdown.mermaid = mode;
		this.markModified("markdown", "mermaid");
		this.save();
	}

	/** Transcript display options (`display.*`), with defaults filled in and invalid values ignored. */
	getDisplaySettings(): ResolvedDisplaySettings {
		const display = this.settings.display ?? {};
		const defaults = SETTINGS_DEFAULTS.display;
		const pick = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
			allowed.includes(value as T) ? (value as T) : fallback;
		const bool = (value: unknown, fallback: boolean) => (typeof value === "boolean" ? value : fallback);
		const fields: Record<string, unknown> =
			typeof display.turnSummaryFields === "object" && display.turnSummaryFields !== null
				? (display.turnSummaryFields as Record<string, unknown>)
				: {};
		const turnSummaryFields = { ...defaults.turnSummaryFields } as TurnSummaryFields;
		for (const key of TURN_SUMMARY_FIELDS) turnSummaryFields[key] = bool(fields[key], turnSummaryFields[key]);
		const turnSummary =
			display.turnSummary === true
				? "reply"
				: display.turnSummary === false
					? "off"
					: pick(display.turnSummary, ["reply", "footer", "off"] as const, defaults.turnSummary);
		return {
			editDiffs: pick(display.editDiffs, ["full", "collapsed", "summary"] as const, defaults.editDiffs),
			diff: pick(display.diff, ["unified", "split", "auto"] as const, defaults.diff),
			diffSyntax: bool(display.diffSyntax, defaults.diffSyntax),
			groupReads: bool(display.groupReads, defaults.groupReads),
			turnSummary,
			turnSummaryFields,
			toolOutput: pick(display.toolOutput, ["collapsed", "expanded"] as const, defaults.toolOutput),
			changesTray: bool(display.changesTray, defaults.changesTray),
			changesTrayPosition: pick(
				display.changesTrayPosition,
				["editor", "footer"] as const,
				defaults.changesTrayPosition,
			),
			diffOpens: pick(display.diffOpens, ["review", "git"] as const, defaults.diffOpens),
			timestamps: pick(display.timestamps, ["off", "time", "datetime"] as const, defaults.timestamps),
		};
	}

	setDisplaySetting<K extends keyof DisplaySettings>(key: K, value: DisplaySettings[K]): void {
		this.globalSettings.display ??= {};
		this.globalSettings.display[key] = value;
		this.markModified("display", key);
		this.save();
	}

	getWarnings(): WarningSettings {
		return { ...(this.settings.warnings ?? {}) };
	}

	setWarnings(warnings: WarningSettings): void {
		this.globalSettings.warnings = { ...warnings };
		this.markModified("warnings");
		this.save();
	}
}
