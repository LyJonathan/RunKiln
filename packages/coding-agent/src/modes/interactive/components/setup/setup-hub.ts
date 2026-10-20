/**
 * `/setup`: one re-enterable place for keys, the default model, routing, permissions, the theme and the
 * footer. `/setup keys` (and the old /key, /login, /logout, /runinfra) open it on a section.
 *
 * Sections are tabs (tab / shift+tab, 1-6, or a click). A change is saved when it is confirmed: enter on a
 * row, or a key that passes its live check. Esc (or ctrl+c) closes the hub and returns to the session;
 * anything highlighted but not confirmed is dropped. The layout is the wizard's (setup-frame.ts): fixed
 * slots, a reserved status line, a body that scrolls on short windows, and clickable rows and hints.
 *
 * Keys are held only in a masked input and never reach a rendered line.
 */

import { RUNINFRA_API_KEY_ENV } from "@runkiln/ai/providers/runinfra";
import {
	type Component,
	type Focusable,
	getKeybindings,
	hyperlink,
	Input,
	isReducedMotion,
	matchesKey,
	STATIC_INDICATOR,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	visibleWidth,
} from "@runkiln/tui";
import { DEFAULT_MODES, ROUTER_MODES, type RouterMode } from "../../../../core/router/catalog.ts";
import {
	CLASSIFIER_KEY_ENV,
	type ClassifierChoice,
	JEV_DEFAULT_MODEL,
	OPENROUTER_DEFAULT_MODEL,
} from "../../../../core/router/classifiers.ts";
import {
	type DecisionModelList,
	getCachedDecisionModels,
	getDecisionModels,
} from "../../../../core/router/decision-models.ts";
import {
	checkRouterKey,
	getActiveRouterClassifier,
	getActiveRouterKey,
	getRouterKeyStatus,
	loadRouterClassifierSettings,
	ROUTER_BACKEND_LABELS,
	ROUTER_KEY_URLS,
	type RouterClassifierSettings,
	removeRouterKey,
	saveOpenRouterDecisionModel,
	saveRouterClassifier,
	saveRouterKey,
} from "../../../../core/router/keys.ts";
import type { ClassifierBackend } from "../../../../core/router/types.ts";
import { loadModelsCatalog, type ModelsCatalog } from "../../../../core/runkiln/models-catalog.ts";
import { resolvePermissionJudgeBackend } from "../../../../core/runkiln/permission-judge.ts";
import {
	fetchRunInfraAccount,
	formatUsd,
	getActiveRunInfraKey,
	getRunInfraKeyStatus,
	removeRunInfraApiKey,
	saveCatalogCache,
} from "../../../../core/runkiln/runinfra-account.ts";
import { loadRunInfraConfig } from "../../../../core/runkiln/runinfra-config.ts";
import {
	checkRunInfraKey,
	type FileLockOptions,
	RUNINFRA_KEY_URL,
	type SetupModel,
	saveRunInfraApiKey,
} from "../../../../core/runkiln/setup.ts";
import {
	loadFooterItemsSetting,
	loadStoredSetupDefaults,
	PERMISSION_HINTS,
	PERMISSION_LABELS,
	PERMISSION_MODES,
	type PermissionMode,
	SETUP_THINKING_LEVELS,
	type SetupModelChoice,
	type SetupThinkingLevel,
	updateSetupDefaults,
} from "../../../../core/runkiln/setup-settings.ts";
import { SYSTEM_THEME_NAME } from "../../theme/system-theme.ts";
import { getAvailableThemes, getTerminalTheme, resolveThemeSetting, setTheme, theme } from "../../theme/theme.ts";
import { DecisionModelPicker } from "../decision-model-picker.ts";
import {
	chipLine,
	clip,
	columnWidth,
	detailLine,
	ember,
	type Frame,
	type FrameLine,
	fieldLines,
	type HintItem,
	hitAt,
	MAX_COLUMN,
	MIN_COLUMNS,
	MIN_ROWS,
	optionLine,
	renderFrame,
	renderInlineFrame,
	renderTooSmall,
	type StatusMessage,
	statusText,
} from "./setup-frame.ts";
import { themePreview } from "./setup-wizard.ts";

export const HUB_SECTIONS = ["keys", "model", "routing", "permissions", "look", "footer"] as const;
export type HubSection = (typeof HUB_SECTIONS)[number];

export const HUB_SECTION_LABELS: Record<HubSection, string> = {
	keys: "Keys",
	model: "Model",
	routing: "Routing",
	permissions: "Permissions",
	look: "Look",
	footer: "Footer",
};

const SECTION_SUBTITLES: Record<HubSection, string> = {
	keys: "Set, test or remove. A key is saved once it checks out.",
	model: "Default for new sessions. Enter saves.",
	routing: "How auto picks a model. Enter saves.",
	permissions: "Default mode. Enter saves.",
	look: "Enter saves the highlighted theme.",
	footer: "What the status line shows.",
};

/** Section names accepted by `/setup <name>` and `runkiln setup <name>`, with a few short forms. */
export function parseHubSection(value: string | undefined): HubSection | undefined {
	const name = value?.trim().toLowerCase();
	if (!name) return undefined;
	if ((HUB_SECTIONS as readonly string[]).includes(name)) return name as HubSection;
	const aliases: Record<string, HubSection> = {
		key: "keys",
		models: "model",
		router: "routing",
		route: "routing",
		permission: "permissions",
		perms: "permissions",
		theme: "look",
		statusline: "footer",
	};
	return aliases[name];
}

/** Screens the hub hands back to the host, which owns them (they need a live session). */
export type HubScreen = "models" | "scoped-models" | "statusline";

export type HubKey = "runinfra" | ClassifierBackend;
export const HUB_KEYS: readonly HubKey[] = ["runinfra", "jev", "openrouter"];
export const HUB_KEY_LABELS: Record<HubKey, string> = {
	runinfra: "RunInfra",
	jev: ROUTER_BACKEND_LABELS.jev,
	openrouter: ROUTER_BACKEND_LABELS.openrouter,
};

export interface SetupHubResult {
	/** The section open when the hub closed (to reopen it there). */
	section: HubSection;
	/** The host should open this screen, then may reopen the hub on `section`. */
	open?: HubScreen;
	/** The saved RunInfra key changed. */
	keyChanged: boolean;
	/** A classifier key or `router.*` changed: rebuild the router. */
	routerChanged: boolean;
	/** settings.json changed (model, thinking, permissions, theme). */
	settingsChanged: boolean;
}

export interface SetupHubOptions {
	agentDir: string;
	section?: HubSection;
	/** Open the Keys section on this key's field, or on its remove prompt. */
	keyAction?: { key: HubKey; action: "set" | "remove" };
	catalog?: ModelsCatalog;
	env?: NodeJS.ProcessEnv;
	fetchImpl?: typeof fetch;
	/** Overrides the baseUrl from runinfra.json (tests). */
	baseUrl?: string;
	fileLock?: FileLockOptions;
	routerBaseUrls?: Partial<Record<ClassifierBackend, string>>;
	decisionModels?: { initial?: DecisionModelList; refresh?: () => Promise<DecisionModelList> };
	/** Default "fullscreen". */
	layout?: "fullscreen" | "inline";
	getRows?: () => number;
	themes?: readonly string[];
	previewTheme?: (name: string | undefined) => void;
	/** Screens the host can open. Rows for the others say where to find them instead. */
	screens?: readonly HubScreen[];
	spinnerIntervalMs?: number;
	requestRender?: () => void;
	onClose: (result: SetupHubResult) => void;
}

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const THINKING_HINTS: Record<SetupThinkingLevel, string> = {
	off: "fastest, cheapest",
	minimal: "a quick sketch",
	low: "routine edits",
	medium: "balanced",
	high: "harder changes",
	xhigh: "slower, deeper",
	max: "deepest, slowest",
};

const CLASSIFIER_CHOICES: readonly ClassifierChoice[] = ["auto", "jev", "openrouter", "off"];
const CLASSIFIER_CHOICE_LABELS: Record<ClassifierChoice, string> = {
	auto: "Auto",
	jev: "Jev",
	openrouter: "OpenRouter",
	off: "Off",
};
const CLASSIFIER_CHOICE_HINTS: Record<ClassifierChoice, string> = {
	auto: "Jev when it has a key, else OpenRouter",
	jev: "TypeSafe's System One classifier",
	openrouter: "a small decision model on OpenRouter",
	off: "no classifier: auto routing and auto permissions are off",
};

type KeyMode = "list" | "input" | "confirmRemove";
type KeyState = "untested" | "works" | "failed";

/** Rows of the Model section. */
type ModelRow = "auto" | "manual" | "thinking" | "models" | "scoped";
/** Rows of the Routing section. */
type RoutingRow = "mode" | "classifier" | "decision";

const ENTER = "\r";
const ESC = "\x1b";
const DELETE = "\x1b[3~";

export class SetupHub implements Component, Focusable {
	private readonly agentDir: string;
	private readonly catalog: ModelsCatalog;
	private readonly env: NodeJS.ProcessEnv;
	private readonly fetchImpl: typeof fetch | undefined;
	private readonly baseUrlOverride: string | undefined;
	private readonly fileLock: FileLockOptions | undefined;
	private readonly routerBaseUrlOverrides: Partial<Record<ClassifierBackend, string>>;
	private readonly decisionModelsOption: SetupHubOptions["decisionModels"];
	private readonly layout: "fullscreen" | "inline";
	private readonly getRows: () => number;
	private readonly themes: readonly string[];
	private readonly previewThemeImpl: (name: string | undefined) => void;
	private readonly screens: ReadonlySet<HubScreen>;
	private readonly spinnerIntervalMs: number;
	private readonly requestRender: () => void;
	private readonly onCloseCallback: (result: SetupHubResult) => void;
	private readonly keyInput = new Input({ prompt: "", mask: true });

	private section: HubSection;
	private status: StatusMessage | undefined;
	private keyChanged = false;
	private routerChanged = false;
	private settingsChanged = false;
	private busy = false;
	private closed = false;
	private task: Promise<void> = Promise.resolve();
	private spinnerFrame = 0;
	private spinnerTimer: NodeJS.Timeout | undefined;
	private lastFrame: Frame | undefined;
	private lastWidth = 0;
	private _focused = false;

	// Keys
	private keyCursor = 0;
	private keyMode: KeyMode = "list";
	private readonly keyStates: Record<HubKey, KeyState> = {
		runinfra: "untested",
		jev: "untested",
		openrouter: "untested",
	};
	private modelCount: number | undefined;
	/** Available credits from `GET /credits` after the RunInfra key checks out; best effort. */
	private credits: string | undefined;

	// Model
	private models: SetupModel[];
	private modelRows: ModelRow[] = [];
	private modelCursor = 0;
	private autoMode: RouterMode;
	private wantAuto: boolean;
	private manualIndex: number;
	private thinkingIndex: number;

	// Routing
	private routerSettings: RouterClassifierSettings;
	private routingCursor = 0;
	private routerMode: RouterMode;
	private classifierIndex: number;
	private routingPicker: DecisionModelPicker | undefined;
	private decisionRefresh: Promise<void> | undefined;

	// Permissions
	private permissionCursor: number;
	private savedPermission: PermissionMode;

	// Look
	private themeIndex: number;
	private savedThemeIndex: number;
	private themePreviewed = false;

	constructor(options: SetupHubOptions) {
		this.agentDir = options.agentDir;
		this.catalog = options.catalog ?? loadModelsCatalog();
		this.env = options.env ?? process.env;
		this.fetchImpl = options.fetchImpl;
		this.baseUrlOverride = options.baseUrl;
		this.fileLock = options.fileLock;
		this.routerBaseUrlOverrides = options.routerBaseUrls ?? {};
		this.decisionModelsOption = options.decisionModels;
		this.layout = options.layout ?? "fullscreen";
		this.getRows = options.getRows ?? (() => process.stdout.rows || 30);
		this.screens = new Set(options.screens ?? []);
		this.spinnerIntervalMs = options.spinnerIntervalMs ?? 80;
		this.requestRender = options.requestRender ?? (() => {});
		this.onCloseCallback = options.onClose;
		this.section = options.section ?? "keys";

		const stored = loadStoredSetupDefaults(this.agentDir);
		this.models = this.catalog.models.map((model) => ({
			id: model.id,
			name: model.name,
		}));
		const storedModel = stored.model;
		this.wantAuto = storedModel?.kind === "auto";
		this.autoMode = storedModel?.kind === "auto" ? storedModel.mode : (stored.routerMode ?? "medium");
		const manualId = storedModel?.kind === "manual" ? storedModel.id : this.catalog.defaults.code;
		this.manualIndex = Math.max(
			0,
			this.models.findIndex((model) => model.id === manualId),
		);
		this.thinkingIndex = stored.thinking ? SETUP_THINKING_LEVELS.indexOf(stored.thinking) + 1 : 0;

		this.routerSettings = loadRouterClassifierSettings(this.agentDir);
		this.routerMode = stored.routerMode ?? "medium";
		this.classifierIndex = Math.max(0, CLASSIFIER_CHOICES.indexOf(this.routerSettings.classifier ?? "auto"));

		this.savedPermission = stored.permissions ?? "read-write";
		this.permissionCursor = Math.max(0, PERMISSION_MODES.indexOf(this.savedPermission));

		this.themes = options.themes ?? getAvailableThemes();
		const themeIndex = stored.theme ? this.themes.indexOf(stored.theme) : this.themes.indexOf(SYSTEM_THEME_NAME);
		this.themeIndex = Math.max(0, themeIndex);
		this.savedThemeIndex = this.themeIndex;
		this.previewThemeImpl =
			options.previewTheme ??
			((name) => {
				const saved = loadStoredSetupDefaults(this.agentDir).theme;
				setTheme(name ?? resolveThemeSetting(saved, getTerminalTheme()) ?? SYSTEM_THEME_NAME);
			});

		this.rebuildModelRows();
		this.modelCursor = this.wantAuto ? 0 : 1;
		if (options.keyAction) {
			this.section = "keys";
			this.keyCursor = Math.max(0, HUB_KEYS.indexOf(options.keyAction.key));
			if (options.keyAction.action === "set") this.openKeyInput();
			else this.askRemove();
		}
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.keyInput.focused = value;
	}

	/** The open section (tests, host). */
	get currentSection(): HubSection {
		return this.section;
	}

	invalidate(): void {}

	/** Resolves when the current key check finishes. */
	whenIdle(): Promise<void> {
		return this.task;
	}

	dispose(): void {
		this.closed = true;
		this.stopSpinner();
		this.keyInput.setValue("");
	}

	// =========================================================================
	// Input
	// =========================================================================

	handleInput(data: string): void {
		if (this.closed) return;
		this.onInput(data);
		this.requestRender();
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (this.closed) return undefined;
		if (event.type === "wheel" && event.wheelDelta) {
			if (this.busy || this.isTyping()) return { handled: true, render: false };
			this.handleInput(event.wheelDelta < 0 ? "\x1b[A" : "\x1b[B");
			return { handled: true };
		}
		if (event.button !== "left" || (event.type !== "press" && event.type !== "click")) return undefined;
		const hit = hitAt(this.lastFrame, event.x, event.y);
		if (!hit) return undefined;
		if (event.type === "press") return { handled: true, focus: true, render: false };
		if (this.busy) return { handled: true, render: false };
		hit.run();
		this.requestRender();
		return { handled: true };
	}

	private isTyping(): boolean {
		return this.section === "keys" && this.keyMode === "input";
	}

	private onInput(data: string): void {
		if (data === "\x03" || matchesKey(data, "ctrl+c")) {
			this.close();
			return;
		}
		if (this.busy) return;
		if (this.isTooSmall()) {
			if (isEscape(data) || data === "q") this.close();
			return;
		}
		// Section switching works everywhere except while typing a key.
		if (!this.isTyping() && this.keyMode !== "confirmRemove" && !this.routingPicker) {
			if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) {
				this.switchSection(matchesKey(data, "tab") ? 1 : -1);
				return;
			}
			const digit = Number.parseInt(data, 10);
			if (data.length === 1 && digit >= 1 && digit <= HUB_SECTIONS.length) {
				this.openSection(HUB_SECTIONS[digit - 1] ?? this.section);
				return;
			}
		}
		switch (this.section) {
			case "keys":
				this.onKeysInput(data);
				return;
			case "model":
				this.onModelInput(data);
				return;
			case "routing":
				this.onRoutingInput(data);
				return;
			case "permissions":
				this.onPermissionsInput(data);
				return;
			case "look":
				this.onLookInput(data);
				return;
			case "footer":
				this.onFooterInput(data);
				return;
		}
	}

	private switchSection(delta: number): void {
		const index = HUB_SECTIONS.indexOf(this.section);
		this.openSection(HUB_SECTIONS[(index + delta + HUB_SECTIONS.length) % HUB_SECTIONS.length] ?? "keys");
	}

	/** Leave the current section: a previewed theme that was not saved is undone. */
	private openSection(section: HubSection): void {
		if (section === this.section) return;
		this.leaveSection();
		this.section = section;
		this.status = undefined;
	}

	private leaveSection(): void {
		if (this.section === "look" && this.themePreviewed) {
			this.themeIndex = this.savedThemeIndex;
			this.previewThemeImpl(undefined);
			this.themePreviewed = false;
		}
		if (this.section === "keys") {
			this.keyMode = "list";
			this.keyInput.setValue("");
		}
		this.routingPicker = undefined;
	}

	private close(open?: HubScreen): void {
		if (this.closed) return;
		this.leaveSection();
		this.dispose();
		this.onCloseCallback({
			section: this.section,
			open,
			keyChanged: this.keyChanged,
			routerChanged: this.routerChanged,
			settingsChanged: this.settingsChanged,
		});
	}

	private saved(text: string, tone: StatusMessage["tone"] = "success"): void {
		this.status = { tone, text };
	}

	/** Write settings; a failure becomes the status line instead of an exception. */
	private write(save: () => void): boolean {
		try {
			save();
			return true;
		} catch (error) {
			this.status = {
				tone: "error",
				text: error instanceof Error ? `Not saved: ${error.message}` : "Not saved: settings.json is not writable.",
			};
			return false;
		}
	}

	// ----- keys --------------------------------------------------------------

	private selectedKey(): HubKey {
		return HUB_KEYS[this.keyCursor] ?? "runinfra";
	}

	private openKeyInput(): void {
		this.keyMode = "input";
		this.keyInput.setValue("");
		this.status = undefined;
	}

	private askRemove(): void {
		const key = this.selectedKey();
		if (!this.hasSavedKey(key)) {
			this.status = { tone: "muted", text: `No saved ${HUB_KEY_LABELS[key]} key.` };
			this.keyMode = "list";
			return;
		}
		this.keyMode = "confirmRemove";
		this.status = undefined;
	}

	private onKeysInput(data: string): void {
		if (this.keyMode === "confirmRemove") {
			if (data === "y" || data === "Y") this.removeKey();
			else if (data === "n" || data === "N" || isEscape(data) || isSubmit(data)) {
				this.keyMode = "list";
				this.status = undefined;
			}
			return;
		}
		if (this.keyMode === "input") {
			if (isEscape(data)) {
				this.keyMode = "list";
				this.keyInput.setValue("");
				this.status = undefined;
				return;
			}
			if (isSubmit(data)) {
				this.submitKey();
				return;
			}
			const pasteEnded = data.includes("\x1b[201~");
			this.keyInput.handleInput(data);
			if (pasteEnded && this.keyInput.getValue().trim()) this.submitKey();
			return;
		}
		if (isEscape(data)) {
			this.close();
			return;
		}
		if (isUp(data) || isDown(data)) {
			const delta = isUp(data) ? -1 : 1;
			this.keyCursor = (this.keyCursor + delta + HUB_KEYS.length) % HUB_KEYS.length;
			this.status = undefined;
			return;
		}
		if (isSubmit(data)) this.openKeyInput();
		else if (data === "t" || data === "T") this.testKey();
		else if (data === DELETE || data === "\x7f" || data === "\b" || data === "r" || data === "R") this.askRemove();
	}

	private hasSavedKey(key: HubKey): boolean {
		try {
			if (key === "runinfra") return getRunInfraKeyStatus(this.agentDir, this.env).hasSavedKey;
			return getRouterKeyStatus(this.agentDir, key, this.env).hasSavedKey;
		} catch {
			return false;
		}
	}

	private keySource(key: HubKey): "env" | "saved" | "none" {
		try {
			if (key === "runinfra") {
				const source = getRunInfraKeyStatus(this.agentDir, this.env).source;
				return source === "environment" ? "env" : source === "config" ? "saved" : "none";
			}
			const source = getRouterKeyStatus(this.agentDir, key, this.env).source;
			return source === "environment" ? "env" : source === "file" ? "saved" : "none";
		} catch {
			return "none";
		}
	}

	private activeKey(key: HubKey): string | undefined {
		try {
			return key === "runinfra"
				? getActiveRunInfraKey(this.agentDir, this.env)
				: getActiveRouterKey(this.agentDir, key, this.env);
		} catch {
			return undefined;
		}
	}

	private baseUrl(): string {
		if (this.baseUrlOverride) return this.baseUrlOverride;
		try {
			return loadRunInfraConfig(this.agentDir).baseUrl;
		} catch {
			return loadRunInfraConfig("").baseUrl;
		}
	}

	private routerBaseUrl(backend: ClassifierBackend): string | undefined {
		return (
			this.routerBaseUrlOverrides[backend] ??
			(backend === "jev" ? this.routerSettings.jevBaseUrl : this.routerSettings.openrouterBaseUrl)
		);
	}

	private submitKey(): void {
		const typed = this.keyInput.getValue().trim();
		if (!typed) {
			this.status = { tone: "muted", text: "Paste a key first." };
			return;
		}
		this.check(this.selectedKey(), typed, true);
	}

	private testKey(): void {
		const key = this.selectedKey();
		const active = this.activeKey(key);
		if (!active) {
			this.status = { tone: "muted", text: `No ${HUB_KEY_LABELS[key]} key. Enter sets one.` };
			return;
		}
		this.check(key, active, false);
	}

	/** Live check. A typed key that works is saved right away. */
	private check(key: HubKey, value: string, save: boolean): void {
		this.busy = true;
		this.status = { tone: "checking", text: `Checking with ${HUB_KEY_LABELS[key]}…` };
		this.startSpinner();
		this.task = (async () => {
			try {
				const result = await this.runCheck(key, value);
				if (this.closed) return;
				this.keyInput.setValue("");
				if (!result.ok) {
					this.keyStates[key] = "failed";
					this.status = { tone: "error", text: result.message };
					return;
				}
				this.keyStates[key] = "works";
				let text = result.message;
				if (save) {
					const warning = this.saveKey(key, value);
					if (warning === false) return;
					text = `${text} - saved`;
					if (warning) text = `${text} (${warning})`;
					const shadow = this.keySource(key) === "env";
					if (shadow) text = `${text}; ${this.envName(key)} still wins`;
					else if (key !== "runinfra" && this.activeBackend() !== key) text = `${text}; not in use (Routing)`;
					this.keyMode = "list";
				}
				this.status = { tone: "success", text };
			} catch {
				if (this.closed) return;
				this.keyInput.setValue("");
				this.keyStates[key] = "failed";
				this.status = { tone: "error", text: "Couldn't check the key. Check your connection." };
			} finally {
				this.busy = false;
				this.stopSpinner();
				this.requestRender();
			}
		})();
	}

	private async runCheck(key: HubKey, value: string): Promise<{ ok: boolean; message: string }> {
		if (key === "runinfra") {
			const baseUrl = this.baseUrl();
			const result = await checkRunInfraKey({
				baseUrl,
				apiKey: value,
				catalog: this.catalog,
				fetchImpl: this.fetchImpl,
			});
			if (!result.ok) return { ok: false, message: result.message };
			saveCatalogCache(this.agentDir, baseUrl, result.remote);
			if (result.models.length > 0) this.models = result.models;
			const count = result.models.length;
			this.modelCount = count;
			this.loadCredits(baseUrl, value);
			const works = "✓ Key works";
			return { ok: true, message: count > 0 ? `${works} - ${count} model${count === 1 ? "" : "s"}` : works };
		}
		const result = await checkRouterKey({
			backend: key,
			apiKey: value,
			baseUrl: this.routerBaseUrl(key),
			model:
				key === "jev"
					? (this.routerSettings.jevModel ?? JEV_DEFAULT_MODEL)
					: (this.routerSettings.openrouterModel ?? OPENROUTER_DEFAULT_MODEL),
			fetchImpl: this.fetchImpl,
		});
		return { ok: result.ok, message: result.message };
	}

	/** Shows the account's available credits in the RunInfra detail line. Failures leave it out. */
	private loadCredits(baseUrl: string, apiKey: string): void {
		this.credits = undefined;
		void fetchRunInfraAccount({ baseUrl, apiKey, fetchImpl: this.fetchImpl })
			.then((account) => {
				if (this.closed || !account.ok) return;
				this.credits = `${formatUsd(account.status.availableCents)} available`;
				this.requestRender();
			})
			.catch(() => {});
	}

	/** Returns the lock warning, undefined, or false when the save failed (status set). */
	private saveKey(key: HubKey, value: string): string | undefined | false {
		try {
			if (key === "runinfra") {
				const warning = saveRunInfraApiKey(this.agentDir, value, this.fileLock);
				this.keyChanged = true;
				return warning ?? undefined;
			}
			const warning = saveRouterKey(this.agentDir, key, value, this.fileLock);
			this.routerChanged = true;
			return warning ?? undefined;
		} catch (error) {
			this.status = { tone: "error", text: error instanceof Error ? error.message : "Could not save the key." };
			return false;
		}
	}

	private removeKey(): void {
		const key = this.selectedKey();
		this.keyMode = "list";
		try {
			const removed = key === "runinfra" ? removeRunInfraApiKey(this.agentDir) : removeRouterKey(this.agentDir, key);
			if (key === "runinfra") this.keyChanged = this.keyChanged || removed;
			else this.routerChanged = this.routerChanged || removed;
			this.keyStates[key] = "untested";
			if (key === "runinfra") this.credits = undefined;
			const still = this.keySource(key) === "env" ? `; ${this.envName(key)} is still set` : "";
			this.status = removed
				? { tone: "success", text: `${HUB_KEY_LABELS[key]} key removed${still}` }
				: { tone: "muted", text: `No saved ${HUB_KEY_LABELS[key]} key.` };
		} catch (error) {
			this.status = { tone: "error", text: error instanceof Error ? error.message : "Could not remove the key." };
		}
	}

	private envName(key: HubKey): string {
		return key === "runinfra" ? RUNINFRA_API_KEY_ENV : CLASSIFIER_KEY_ENV[key];
	}

	private activeBackend(): ClassifierBackend | undefined {
		try {
			return getActiveRouterClassifier(this.agentDir, this.env, this.routerSettings).backend;
		} catch {
			return undefined;
		}
	}

	private classifierAvailable(): boolean {
		try {
			return resolvePermissionJudgeBackend(this.routerSettings, this.env, this.readStoredRouterKeys()) !== undefined;
		} catch {
			return false;
		}
	}

	private readStoredRouterKeys(): Partial<Record<ClassifierBackend, string>> {
		const keys: Partial<Record<ClassifierBackend, string>> = {};
		for (const backend of ["jev", "openrouter"] as const) {
			if (this.keySource(backend) === "saved") {
				const value = this.activeKey(backend);
				if (value) keys[backend] = value;
			}
		}
		return keys;
	}

	// ----- model -------------------------------------------------------------

	private rebuildModelRows(): void {
		const rows: ModelRow[] = ["auto", "manual"];
		if (!this.wantAuto) rows.push("thinking");
		rows.push("models", "scoped");
		const current = this.modelRows[this.modelCursor];
		this.modelRows = rows;
		this.modelCursor = Math.max(0, current ? rows.indexOf(current) : 0);
	}

	private modelChoice(): SetupModelChoice {
		if (this.wantAuto) return { kind: "auto", mode: this.autoMode };
		return { kind: "manual", id: this.models[this.manualIndex]?.id ?? this.catalog.defaults.code };
	}

	private thinkingChoice(): SetupThinkingLevel | undefined {
		return this.thinkingIndex === 0 ? undefined : SETUP_THINKING_LEVELS[this.thinkingIndex - 1];
	}

	private onModelInput(data: string): void {
		if (isEscape(data)) {
			this.close();
			return;
		}
		const row = this.modelRows[this.modelCursor] ?? "auto";
		if (isUp(data) || isDown(data)) {
			const delta = isUp(data) ? -1 : 1;
			this.modelCursor = (this.modelCursor + delta + this.modelRows.length) % this.modelRows.length;
			const next = this.modelRows[this.modelCursor];
			// Moving onto Auto or Manual picks it, like the wizard.
			if (next === "auto" || next === "manual") this.pickModelKind(next === "auto");
			return;
		}
		const delta = isLeft(data) ? -1 : isRight(data) ? 1 : 0;
		if (delta !== 0) {
			if (row === "auto") {
				const index = ROUTER_MODES.indexOf(this.autoMode);
				this.autoMode = ROUTER_MODES[(index + delta + ROUTER_MODES.length) % ROUTER_MODES.length] ?? "medium";
			} else if (row === "manual" && this.models.length > 0) {
				this.manualIndex = (this.manualIndex + delta + this.models.length) % this.models.length;
			} else if (row === "thinking") {
				const count = SETUP_THINKING_LEVELS.length + 1;
				this.thinkingIndex = Math.max(0, Math.min(count - 1, this.thinkingIndex + delta));
			} else return;
			this.status = { tone: "muted", text: "Not saved yet: enter saves." };
			return;
		}
		if (!isSubmit(data)) return;
		if (row === "models") {
			this.openScreen("models");
			return;
		}
		if (row === "scoped") {
			this.openScreen("scoped-models");
			return;
		}
		this.saveModel();
	}

	private pickModelKind(auto: boolean): void {
		if (this.wantAuto === auto) return;
		this.wantAuto = auto;
		this.rebuildModelRows();
		this.status = { tone: "muted", text: "Not saved yet: enter saves." };
	}

	private saveModel(): void {
		const choice = this.modelChoice();
		if (choice.kind === "auto" && !this.classifierAvailable()) {
			this.status = { tone: "warning", text: "Auto needs a Jev or OpenRouter key: add one in Keys." };
			return;
		}
		const thinking = choice.kind === "auto" ? undefined : this.thinkingChoice();
		const saved = this.write(() => updateSetupDefaults(this.agentDir, { model: choice, thinking }));
		if (!saved) return;
		this.settingsChanged = true;
		if (choice.kind === "auto") this.routerMode = choice.mode;
		const name =
			choice.kind === "auto"
				? `Auto - ${choice.mode}`
				: `${this.models[this.manualIndex]?.name ?? choice.id}${thinking ? ` - thinking ${thinking}` : ""}`;
		this.saved(`Saved: ${name}. New sessions use it.`);
	}

	private openScreen(screen: HubScreen): void {
		if (!this.screens.has(screen)) {
			const where = screen === "statusline" ? "/setup footer" : "/setup model";
			this.status = { tone: "muted", text: `Open ${where} inside a session for this.` };
			return;
		}
		this.close(screen);
	}

	// ----- routing -----------------------------------------------------------

	private routingRows(): RoutingRow[] {
		return ["mode", "classifier", "decision"];
	}

	private onRoutingInput(data: string): void {
		if (this.routingPicker) {
			this.onDecisionPickerInput(data);
			return;
		}
		if (isEscape(data)) {
			this.close();
			return;
		}
		const rows = this.routingRows();
		if (isUp(data) || isDown(data)) {
			const delta = isUp(data) ? -1 : 1;
			this.routingCursor = (this.routingCursor + delta + rows.length) % rows.length;
			return;
		}
		const row = rows[this.routingCursor] ?? "mode";
		const delta = isLeft(data) ? -1 : isRight(data) ? 1 : 0;
		if (delta !== 0) {
			if (row === "mode") {
				const index = ROUTER_MODES.indexOf(this.routerMode);
				this.routerMode = ROUTER_MODES[(index + delta + ROUTER_MODES.length) % ROUTER_MODES.length] ?? "medium";
			} else if (row === "classifier") {
				this.classifierIndex =
					(this.classifierIndex + delta + CLASSIFIER_CHOICES.length) % CLASSIFIER_CHOICES.length;
			} else return;
			this.status = { tone: "muted", text: "Not saved yet: enter saves." };
			return;
		}
		if (!isSubmit(data)) return;
		if (row === "mode") {
			if (!this.write(() => updateSetupDefaults(this.agentDir, { routerMode: this.routerMode }))) return;
			this.settingsChanged = true;
			this.routerChanged = true;
			if (this.wantAuto) this.autoMode = this.routerMode;
			this.saved(`Saved: auto routing mode ${this.routerMode}.`);
			return;
		}
		if (row === "classifier") {
			const choice = CLASSIFIER_CHOICES[this.classifierIndex] ?? "auto";
			if (!this.write(() => saveRouterClassifier(this.agentDir, choice))) return;
			this.routerSettings = loadRouterClassifierSettings(this.agentDir);
			this.routerChanged = true;
			const needsKey = (choice === "jev" || choice === "openrouter") && this.keySource(choice) === "none";
			if (needsKey)
				this.saved(`Saved: ${CLASSIFIER_CHOICE_LABELS[choice]}. It has no key yet: add one in Keys.`, "warning");
			else this.saved(`Saved: classifier ${CLASSIFIER_CHOICE_LABELS[choice]}.`);
			return;
		}
		this.openDecisionPicker();
	}

	private openDecisionPicker(): void {
		const initial = this.decisionModelsOption?.initial ?? getCachedDecisionModels(this.agentDir);
		const current = this.routerSettings.openrouterModel ?? OPENROUTER_DEFAULT_MODEL;
		const picker = new DecisionModelPicker(initial, current, 6);
		this.routingPicker = picker;
		this.status = undefined;
		if (this.decisionRefresh) return;
		if (initial.source === "cache" && !this.decisionModelsOption?.refresh) return;
		const refresh =
			this.decisionModelsOption?.refresh ?? (() => getDecisionModels(this.agentDir, { fetch: this.fetchImpl }));
		this.decisionRefresh = refresh()
			.then((list) => {
				if (this.closed || list.entries.length === 0) return;
				this.routingPicker?.replace(list);
				this.requestRender();
			})
			.catch(() => {});
	}

	private onDecisionPickerInput(data: string): void {
		const picker = this.routingPicker;
		if (!picker) return;
		if (isEscape(data)) {
			this.routingPicker = undefined;
			return;
		}
		if (isUp(data)) picker.move(-1);
		else if (isDown(data)) picker.move(1);
		else if (matchesKey(data, "pageUp")) picker.move(-6);
		else if (matchesKey(data, "pageDown")) picker.move(6);
		else if (isSubmit(data)) {
			const model = picker.selected?.id;
			if (!model) return;
			if (!this.write(() => saveOpenRouterDecisionModel(this.agentDir, model))) return;
			this.routerSettings = loadRouterClassifierSettings(this.agentDir);
			this.routerChanged = true;
			this.routingPicker = undefined;
			this.saved(`Saved: decision model ${model}.`);
		}
	}

	// ----- permissions -------------------------------------------------------

	private onPermissionsInput(data: string): void {
		if (isEscape(data)) {
			this.close();
			return;
		}
		if (isUp(data) || isDown(data)) {
			const delta = isUp(data) ? -1 : 1;
			this.permissionCursor = (this.permissionCursor + delta + PERMISSION_MODES.length) % PERMISSION_MODES.length;
			return;
		}
		if (!isSubmit(data)) return;
		const mode = PERMISSION_MODES[this.permissionCursor];
		if (!mode) return;
		if (mode === "auto" && !this.classifierAvailable()) {
			this.status = { tone: "warning", text: "Auto needs a Jev or OpenRouter key: add one in Keys." };
			return;
		}
		if (!this.write(() => updateSetupDefaults(this.agentDir, { permissions: mode }))) return;
		this.savedPermission = mode;
		this.settingsChanged = true;
		this.saved(
			`Saved: ${PERMISSION_LABELS[mode]}. Applies to this session too.`,
			mode === "allow-all" ? "warning" : "success",
		);
	}

	// ----- look --------------------------------------------------------------

	private onLookInput(data: string): void {
		if (isEscape(data)) {
			this.close();
			return;
		}
		if (isUp(data) || isDown(data)) {
			if (this.themes.length === 0) return;
			const delta = isUp(data) ? -1 : 1;
			this.previewThemeAt((this.themeIndex + delta + this.themes.length) % this.themes.length);
			return;
		}
		if (isSubmit(data)) this.saveTheme();
	}

	private previewThemeAt(index: number): void {
		this.themeIndex = index;
		this.themePreviewed = index !== this.savedThemeIndex;
		this.previewThemeImpl(this.themes[index]);
		this.status = this.themePreviewed ? { tone: "muted", text: "Preview: enter saves." } : undefined;
	}

	private saveTheme(): void {
		const name = this.themes[this.themeIndex];
		if (!name) return;
		if (!this.write(() => updateSetupDefaults(this.agentDir, { theme: name }))) return;
		this.savedThemeIndex = this.themeIndex;
		this.themePreviewed = false;
		this.settingsChanged = true;
		this.saved(`Saved: theme ${name}.`);
	}

	// ----- footer ------------------------------------------------------------

	private onFooterInput(data: string): void {
		if (isEscape(data)) {
			this.close();
			return;
		}
		if (isSubmit(data)) this.openScreen("statusline");
	}

	// =========================================================================
	// Spinner
	// =========================================================================

	private startSpinner(): void {
		this.spinnerFrame = 0;
		if (this.spinnerIntervalMs <= 0 || this.spinnerTimer || isReducedMotion()) return;
		this.spinnerTimer = setInterval(() => {
			this.spinnerFrame = (this.spinnerFrame + 1) % SPINNER.length;
			this.requestRender();
		}, this.spinnerIntervalMs);
		this.spinnerTimer.unref?.();
	}

	private stopSpinner(): void {
		if (this.spinnerTimer) clearInterval(this.spinnerTimer);
		this.spinnerTimer = undefined;
	}

	// =========================================================================
	// Rendering
	// =========================================================================

	private isTooSmall(): boolean {
		return (
			this.layout === "fullscreen" &&
			this.lastWidth > 0 &&
			(this.lastWidth < MIN_COLUMNS || this.getRows() < MIN_ROWS)
		);
	}

	render(width: number): string[] {
		this.lastWidth = width;
		const rows = Math.max(1, this.getRows());
		if (this.layout === "fullscreen" && (width < MIN_COLUMNS || rows < MIN_ROWS)) {
			this.lastFrame = undefined;
			return renderTooSmall(width, rows, [
				ember(theme.bold("RunKiln setup")),
				theme.fg("muted", `Make the terminal at least ${MIN_COLUMNS}x${MIN_ROWS}`),
				theme.fg("dim", `now ${width}x${rows} - esc closes`),
			]);
		}
		const column = this.layout === "fullscreen" ? columnWidth(width) : Math.max(20, Math.min(MAX_COLUMN, width));
		// The lit tab is the title: tabs, blank, one short line.
		const header: FrameLine[] = [
			this.tabsLine(column),
			{ text: "" },
			{ text: clip(theme.fg("muted", SECTION_SUBTITLES[this.section]), column) },
		];
		const spec = {
			header,
			body: this.body(column),
			status: this.statusSlot(),
			hints: this.hints(),
			send: (data: string) => this.handleInput(data),
		};
		const frame =
			this.layout === "fullscreen" ? renderFrame({ width, rows, ...spec }) : renderInlineFrame({ width, ...spec });
		this.lastFrame = frame;
		return frame.lines;
	}

	/** `Keys   Model   Routing ...` with the open one lit; each tab is clickable. */
	private tabsLine(column: number): FrameLine {
		const gap = "   ";
		const compact = HUB_SECTIONS.map((section) => HUB_SECTION_LABELS[section]).join(gap).length > column;
		let text = "";
		const hits = [];
		for (const [index, section] of HUB_SECTIONS.entries()) {
			if (index > 0) text += compact ? "  " : gap;
			const label = compact ? HUB_SECTION_LABELS[section].slice(0, 4) : HUB_SECTION_LABELS[section];
			const shown = section === this.section ? ember(theme.bold(label)) : theme.fg("muted", label);
			const x0 = visibleWidth(text);
			text += shown;
			hits.push({ x0, x1: visibleWidth(text), run: () => this.openSection(section) });
		}
		return { text, hits };
	}

	private spinner(): string {
		return isReducedMotion() ? STATIC_INDICATOR : (SPINNER[this.spinnerFrame] ?? "⠋");
	}

	private statusSlot(): string {
		if (this.section === "keys" && this.keyMode === "confirmRemove") {
			return theme.fg("warning", theme.bold(`Remove the saved ${HUB_KEY_LABELS[this.selectedKey()]} key?`));
		}
		return statusText(this.status, this.spinner());
	}

	private body(column: number): FrameLine[] {
		switch (this.section) {
			case "keys":
				return this.keysBody(column);
			case "model":
				return this.modelBody(column);
			case "routing":
				return this.routingBody(column);
			case "permissions":
				return this.permissionsBody(column);
			case "look":
				return this.lookBody(column);
			case "footer":
				return this.footerBody(column);
		}
	}

	private keyStateText(key: HubKey): { text: string; tone: "success" | "error" | "dim" | "muted" } {
		const source = this.keySource(key);
		const state = this.keyStates[key];
		if (source === "none") return { text: "not set", tone: "dim" };
		const from = source === "env" ? this.envName(key) : "saved";
		if (state === "works") return { text: `${from} - ✓ works`, tone: "success" };
		if (state === "failed") return { text: `${from} - ✗ failed`, tone: "error" };
		return { text: from, tone: "muted" };
	}

	/** Three key rows, a blank, then four rows for the selected key: its field, or its details and buttons. */
	private keysBody(column: number): FrameLine[] {
		const lines: FrameLine[] = [];
		const labelWidth = Math.max(...HUB_KEYS.map((key) => HUB_KEY_LABELS[key].length));
		for (const [index, key] of HUB_KEYS.entries()) {
			const state = this.keyStateText(key);
			const selected = index === this.keyCursor;
			const role = key === "runinfra" ? "models" : "classifier";
			const line = optionLine({
				selected,
				label: HUB_KEY_LABELS[key],
				labelWidth,
				column,
				run: () => {
					if (this.keyCursor === index && this.keyMode === "list") this.openKeyInput();
					else {
						this.keyCursor = index;
						this.keyMode = "list";
						this.keyInput.setValue("");
						this.status = undefined;
					}
				},
			});
			const roleText = theme.fg("dim", role.padEnd(12));
			lines.push({ ...line, text: `${line.text}  ${roleText}${theme.fg(state.tone, state.text)}` });
		}
		lines.push({ text: "" });
		const key = this.selectedKey();
		const url = key === "runinfra" ? RUNINFRA_KEY_URL : ROUTER_KEY_URLS[key];
		const link = { text: `${theme.fg("dim", "Get one  ")}${theme.fg("mdLink", hyperlink(url, url))}` };
		if (this.keyMode === "input") {
			const value = this.keyInput.getValue();
			lines.push(
				...fieldLines({
					body: this.keyInput.render(60)[0] ?? "",
					empty: !value,
					placeholder: "paste the key",
					label: `${HUB_KEY_LABELS[key]} key`,
					column,
					focused: this._focused,
				}),
			);
			lines.push(value ? { text: theme.fg("dim", `${value.length} characters, hidden`) } : link);
			return lines;
		}
		const detail = this.keyDetail(key);
		lines.push({ text: theme.fg("muted", clip(detail, column)) });
		lines.push(link);
		lines.push({ text: "" });
		lines.push(
			this.buttons([
				{ label: "Set", run: () => this.openKeyInput() },
				{ label: "Test", run: () => this.testKey() },
				{ label: "Remove", run: () => this.askRemove() },
			]),
		);
		return lines;
	}

	private keyDetail(key: HubKey): string {
		const source = this.keySource(key);
		if (key === "runinfra") {
			const count =
				(this.modelCount !== undefined ? ` - ${this.modelCount} models` : "") +
				(this.credits ? ` - ${this.credits}` : "");
			if (source === "env")
				return `From ${RUNINFRA_API_KEY_ENV}${this.hasSavedKey(key) ? " (overrides the saved key)" : ""}${count}`;
			if (source === "saved") return `Saved in ~/.runkiln/agent/runinfra.json${count}`;
			return "Needed for every model.";
		}
		const used = this.activeBackend() === key ? "in use" : "not in use";
		if (source === "env") return `From ${CLASSIFIER_KEY_ENV[key]} - ${used}`;
		if (source === "saved") return `Saved in ~/.runkiln/agent/router-keys.json - ${used}`;
		return "Optional. Auto routing and auto permissions need Jev or OpenRouter.";
	}

	/** `[ Set ]  [ Test ]  [ Remove ]`, each clickable. */
	private buttons(items: Array<{ label: string; run: () => void }>): FrameLine {
		let text = "  ";
		const hits = [];
		for (const [index, item] of items.entries()) {
			if (index > 0) text += "  ";
			const x0 = visibleWidth(text);
			text += theme.fg("text", `[ ${item.label} ]`);
			hits.push({ x0, x1: visibleWidth(text), run: item.run });
		}
		return { text, hits };
	}

	private modelBody(column: number): FrameLine[] {
		const labelWidth = Math.max("Auto".length, "Manual".length, "Thinking".length, "Enabled models".length);
		const indent = 2 + labelWidth + 2 + 2;
		const lines: FrameLine[] = [];
		const row = this.modelRows[this.modelCursor];
		const focusRow = (name: ModelRow) => () => {
			this.modelCursor = Math.max(0, this.modelRows.indexOf(name));
		};
		lines.push(
			chipLine({
				selected: row === "auto",
				label: "Auto",
				labelWidth,
				chips: ROUTER_MODES,
				current: ROUTER_MODES.indexOf(this.autoMode),
				inactive: !this.wantAuto,
				onFocus: () => {
					this.pickModelKind(true);
					focusRow("auto")();
				},
				onPick: (index) => {
					this.pickModelKind(true);
					focusRow("auto")();
					this.autoMode = ROUTER_MODES[index] ?? this.autoMode;
					this.status = { tone: "muted", text: "Not saved yet: enter saves." };
				},
			}),
		);
		const autoHint = this.classifierAvailable()
			? DEFAULT_MODES[this.autoMode].description
			: "needs a Jev or OpenRouter key (Keys)";
		lines.push(detailLine(autoHint, indent, column, row === "auto" ? "muted" : "dim"));
		const model = this.models[this.manualIndex];
		lines.push(
			this.stepper({
				selected: row === "manual",
				label: "Manual",
				labelWidth,
				value: model?.name ?? this.catalog.defaults.code,
				inactive: this.wantAuto,
				onFocus: () => {
					this.pickModelKind(false);
					focusRow("manual")();
				},
				onStep: (delta) => {
					this.pickModelKind(false);
					focusRow("manual")();
					this.onModelInput(delta < 0 ? "\x1b[D" : "\x1b[C");
				},
			}),
		);
		const detail = [
			model?.priceLabel ? `${model.priceLabel} per 1M` : undefined,
			this.models.length > 1 ? `${this.manualIndex + 1} of ${this.models.length}` : undefined,
		]
			.filter(Boolean)
			.join(" - ");
		lines.push(detailLine(detail, indent, column, row === "manual" ? "muted" : "dim"));
		const thinking = this.wantAuto ? "picked per task" : (this.thinkingChoice() ?? "model default");
		lines.push(
			this.stepper({
				selected: row === "thinking",
				label: "Thinking",
				labelWidth,
				value: thinking,
				inactive: this.wantAuto,
				disabled: this.wantAuto,
				onFocus: () => {
					if (!this.wantAuto) focusRow("thinking")();
				},
				onStep: (delta) => {
					if (this.wantAuto) return;
					focusRow("thinking")();
					this.onModelInput(delta < 0 ? "\x1b[D" : "\x1b[C");
				},
			}),
		);
		const thinkingHint = this.wantAuto
			? "auto routing sets it"
			: this.thinkingChoice()
				? THINKING_HINTS[this.thinkingChoice() as SetupThinkingLevel]
				: "each model's tuned level";
		lines.push(detailLine(thinkingHint, indent, column, row === "thinking" ? "muted" : "dim"));
		lines.push({ text: "" });
		const open = (name: ModelRow, label: string, hint: string, screen: HubScreen) =>
			optionLine({
				selected: row === name,
				label,
				labelWidth,
				hint: this.screens.has(screen) ? hint : "inside a session",
				column,
				run: () => {
					focusRow(name)();
					this.openScreen(screen);
				},
			});
		lines.push(open("models", "Enabled models", "turn models on or off, thinking per model", "models"));
		lines.push(open("scoped", "Ctrl+P cycle", "which models Ctrl+P steps through", "scoped-models"));
		return lines;
	}

	private stepper(options: {
		selected: boolean;
		label: string;
		labelWidth: number;
		value: string;
		inactive?: boolean;
		disabled?: boolean;
		onFocus: () => void;
		onStep: (delta: number) => void;
	}): FrameLine {
		const { selected, label, labelWidth, value } = options;
		const pointer = selected ? ember("❯") : " ";
		const padded = label.padEnd(labelWidth);
		const name = selected ? ember(theme.bold(padded)) : theme.fg(options.inactive ? "muted" : "text", padded);
		const head = `${pointer} ${name}  `;
		const x = visibleWidth(head);
		const shown = selected
			? ember(theme.bold(`‹ ${value} ›`))
			: options.inactive
				? theme.fg("dim", `  ${value}  `)
				: theme.bold(`  ${value}  `);
		const width = visibleWidth(`‹ ${value} ›`);
		const hits = [{ x0: 0, x1: x, run: options.onFocus }];
		if (!options.disabled) {
			hits.push({ x0: x, x1: x + 2, run: () => options.onStep(-1) });
			hits.push({ x0: x + 2, x1: x + width - 2, run: options.onFocus });
			hits.push({ x0: x + width - 2, x1: x + width, run: () => options.onStep(1) });
		}
		return { text: `${head}${shown}`, hits, focus: selected };
	}

	private routingBody(column: number): FrameLine[] {
		const picker = this.routingPicker;
		if (picker) {
			const lines: FrameLine[] = [{ text: theme.fg("muted", "OpenRouter decision model") }];
			const window = picker.window();
			const more = (text: string) => ({ text: text ? `  ${theme.fg("dim", text)}` : "" });
			lines.push(more(window.above > 0 ? `↑ ${window.above} more` : ""));
			for (const item of window.items) {
				lines.push(
					optionLine({
						selected: item.selected,
						label: item.label,
						labelWidth: item.label.length,
						hint: item.hint,
						column,
						run: () => {
							picker.select(item.id);
							this.onDecisionPickerInput(ENTER);
						},
					}),
				);
			}
			lines.push(more(window.below > 0 ? `↓ ${window.below} more` : ""));
			lines.push({ text: theme.fg("dim", clip(picker.sourceLine(), column)) });
			return lines;
		}
		const labelWidth = "Decision model".length;
		const indent = 2 + labelWidth + 2 + 2;
		const rows = this.routingRows();
		const row = rows[this.routingCursor];
		const focus = (name: RoutingRow) => () => {
			this.routingCursor = rows.indexOf(name);
		};
		const lines: FrameLine[] = [];
		lines.push(
			chipLine({
				selected: row === "mode",
				label: "Default mode",
				labelWidth,
				chips: ROUTER_MODES,
				current: ROUTER_MODES.indexOf(this.routerMode),
				onFocus: focus("mode"),
				onPick: (index) => {
					focus("mode")();
					this.routerMode = ROUTER_MODES[index] ?? this.routerMode;
					this.status = { tone: "muted", text: "Not saved yet: enter saves." };
				},
			}),
		);
		lines.push(
			detailLine(DEFAULT_MODES[this.routerMode].description, indent, column, row === "mode" ? "muted" : "dim"),
		);
		const choice = CLASSIFIER_CHOICES[this.classifierIndex] ?? "auto";
		lines.push(
			chipLine({
				selected: row === "classifier",
				label: "Classifier",
				labelWidth,
				chips: CLASSIFIER_CHOICES.map((value) => CLASSIFIER_CHOICE_LABELS[value]),
				current: this.classifierIndex,
				onFocus: focus("classifier"),
				onPick: (index) => {
					focus("classifier")();
					this.classifierIndex = index;
					this.status = { tone: "muted", text: "Not saved yet: enter saves." };
				},
			}),
		);
		const active = this.activeBackend();
		const inUse = active ? `in use: ${CLASSIFIER_CHOICE_LABELS[active]}` : "none in use";
		lines.push(
			detailLine(
				`${CLASSIFIER_CHOICE_HINTS[choice]} - ${inUse}`,
				indent,
				column,
				row === "classifier" ? "muted" : "dim",
			),
		);
		const decision = this.routerSettings.openrouterModel ?? OPENROUTER_DEFAULT_MODEL;
		const decisionLine = optionLine({
			selected: row === "decision",
			label: "Decision model",
			labelWidth,
			column,
			run: () => {
				focus("decision")();
				this.openDecisionPicker();
			},
		});
		lines.push({ ...decisionLine, text: `${decisionLine.text}    ${theme.bold(clip(decision, column - indent))}` });
		lines.push(
			detailLine(
				"OpenRouter only - enter picks from the list",
				indent,
				column,
				row === "decision" ? "muted" : "dim",
			),
		);
		return lines;
	}

	private permissionsBody(column: number): FrameLine[] {
		const available = this.classifierAvailable();
		const labelWidth = Math.max(...PERMISSION_MODES.map((mode) => PERMISSION_LABELS[mode].length));
		return PERMISSION_MODES.map((mode, index) => {
			const needsKey = mode === "auto" && !available;
			return optionLine({
				selected: index === this.permissionCursor,
				label: PERMISSION_LABELS[mode],
				labelWidth,
				mark: mode === this.savedPermission ? theme.fg("success", "● ") : "  ",
				hint: needsKey ? "needs a Jev or OpenRouter key (Keys)" : PERMISSION_HINTS[mode],
				column,
				disabled: needsKey,
				hintTone: mode === "allow-all" ? "warning" : "dim",
				run: () => {
					this.permissionCursor = index;
					this.onPermissionsInput(ENTER);
				},
			});
		});
	}

	private lookBody(column: number): FrameLine[] {
		const lines: FrameLine[] = [];
		const labelWidth = Math.max(8, ...this.themes.map((name) => name.length));
		for (const [index, name] of this.themes.entries()) {
			const hint =
				name === SYSTEM_THEME_NAME
					? "follows the terminal"
					: name === "dark"
						? "dark background"
						: name === "light"
							? "light background"
							: "";
			lines.push(
				optionLine({
					selected: index === this.themeIndex,
					label: name,
					labelWidth,
					mark: index === this.savedThemeIndex ? theme.fg("success", "● ") : "  ",
					hint,
					column,
					run: () => {
						if (index === this.themeIndex) this.saveTheme();
						else this.previewThemeAt(index);
					},
				}),
			);
		}
		lines.push({ text: "" });
		lines.push(...themePreview(Math.min(column, 44)));
		return lines;
	}

	private footerBody(column: number): FrameLine[] {
		const items = loadFooterItemsSetting(this.agentDir);
		const summary = items ? items.filter((item) => item !== "|").join(", ") || "nothing" : "default layout";
		const line = optionLine({
			selected: true,
			label: "Footer items",
			labelWidth: "Footer items".length + 2,
			hint: this.screens.has("statusline") ? "enter opens the picker with a live preview" : "inside a session",
			column,
			run: () => this.openScreen("statusline"),
		});
		return [line, detailLine(summary, 2 + "Footer items".length + 4, column, "muted")];
	}

	private hints(): HintItem[] {
		const close: HintItem = { key: "esc", label: "close", data: ESC };
		const tab: HintItem = { key: "tab", label: "section", data: "\t" };
		const move: HintItem = { key: "↑↓", label: "move" };
		if (this.busy) return [{ key: "ctrl+c", label: "close" }];
		switch (this.section) {
			case "keys":
				if (this.keyMode === "confirmRemove")
					return [
						{ key: "y", label: "remove", data: "y" },
						{ key: "n", label: "keep", data: "n" },
					];
				if (this.keyMode === "input")
					return [
						{ key: "enter", label: "check and save", data: ENTER },
						{ key: "esc", label: "cancel", data: ESC },
					];
				return [
					move,
					{ key: "enter", label: "set", data: ENTER },
					{ key: "t", label: "test", data: "t" },
					{ key: "del", label: "remove", data: DELETE },
					tab,
					close,
				];
			case "model":
			case "routing": {
				if (this.routingPicker && this.section === "routing")
					return [move, { key: "enter", label: "save", data: ENTER }, { key: "esc", label: "back", data: ESC }];
				const row = this.section === "model" ? this.modelRows[this.modelCursor] : undefined;
				const opens =
					row === "models" || row === "scoped" || (this.section === "routing" && this.routingCursor === 2);
				return [
					move,
					...(opens ? [] : [{ key: "←→", label: "change" }]),
					{ key: "enter", label: opens ? "open" : "save", data: ENTER },
					tab,
					close,
				];
			}
			case "permissions":
			case "look":
				return [move, { key: "enter", label: "save", data: ENTER }, tab, close];
			case "footer":
				return [{ key: "enter", label: "open", data: ENTER }, tab, close];
		}
	}
}

function isSubmit(data: string): boolean {
	return getKeybindings().matches(data, "tui.input.submit") || data === "\r" || data === "\n";
}

function isEscape(data: string): boolean {
	return matchesKey(data, "escape");
}

function isUp(data: string): boolean {
	return matchesKey(data, "up") || getKeybindings().matches(data, "tui.select.up");
}

function isDown(data: string): boolean {
	return matchesKey(data, "down") || getKeybindings().matches(data, "tui.select.down");
}

function isLeft(data: string): boolean {
	return matchesKey(data, "left");
}

function isRight(data: string): boolean {
	return matchesKey(data, "right");
}
