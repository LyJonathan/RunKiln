/**
 * The first-run setup wizard: RunInfra key, how models are picked (auto with a mode, or one manual model and
 * its thinking level), a classifier key only when auto routing or auto permissions need one, permissions,
 * theme, then a compact review where any step can be reopened, and a short "done" screen (fullscreen).
 *
 * Layout comes from setup-frame.ts: fixed slots, blank lines that never collapse, a reserved status slot,
 * and a body that scrolls instead of squeezing on short windows. Every row keeps its hint line, so moving
 * the cursor never changes the height of a step. Options, chips, fields and key hints are clickable.
 *
 * After a key checks out the key step stays on screen with "✓ Key works - N models"; enter continues, and
 * it moves on by itself after a short pause when nothing is pressed. Defaults are preselected so enter,
 * enter, enter finishes.
 *
 * Keys are held only in masked inputs or private fields and never reach a rendered line. Nothing is
 * written until Finish on the review screen.
 */

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
import { VERSION } from "../../../../config.ts";
import { DEFAULT_MODES, ROUTER_MODES, type RouterMode } from "../../../../core/router/catalog.ts";
import {
	CLASSIFIER_KEY_ENV,
	JEV_DEFAULT_MODEL,
	OPENROUTER_DEFAULT_MODEL,
	type StoredClassifierKeys,
} from "../../../../core/router/classifiers.ts";
import {
	type DecisionModelList,
	getCachedDecisionModels,
	getDecisionModels,
	isDecisionModel,
} from "../../../../core/router/decision-models.ts";
import {
	checkRouterKey,
	getActiveRouterClassifier,
	loadRouterClassifierSettings,
	ROUTER_BACKEND_LABELS,
	ROUTER_KEY_URLS,
	type RouterClassifierSettings,
	readRouterKeys,
	saveRouterClassifier,
	saveRouterKey,
} from "../../../../core/router/keys.ts";
import type { ClassifierBackend } from "../../../../core/router/types.ts";
import { loadModelsCatalog, type ModelsCatalog } from "../../../../core/runkiln/models-catalog.ts";
import { resolvePermissionJudgeBackend } from "../../../../core/runkiln/permission-judge.ts";
import { saveCatalogCache } from "../../../../core/runkiln/runinfra-account.ts";
import {
	checkRunInfraKey,
	environmentApiKey,
	type FileLockOptions,
	loadSetupConfig,
	RUNINFRA_KEY_URL,
	SETUP_DONE,
	SETUP_ENV_KEY,
	SETUP_KEPT_KEY,
	SETUP_KEY_SAVED,
	SETUP_KEY_WORKS,
	type SetupModel,
	saveRunInfraApiKey,
} from "../../../../core/runkiln/setup.ts";
import {
	loadStoredSetupDefaults,
	PERMISSION_HINTS,
	PERMISSION_LABELS,
	PERMISSION_MODES,
	type PermissionMode,
	SETUP_THINKING_LEVELS,
	type SetupModelChoice,
	type SetupThinkingLevel,
	type StoredSetupDefaults,
	saveSetupDefaults,
} from "../../../../core/runkiln/setup-settings.ts";
import { SYSTEM_THEME_NAME } from "../../theme/system-theme.ts";
import { getAvailableThemes, getTerminalTheme, resolveThemeSetting, setTheme, theme } from "../../theme/theme.ts";
import { DecisionModelPicker } from "../decision-model-picker.ts";
import { rkBannerLines } from "../rk-banner.ts";
import { type EditableStep, SETUP_STEP_LABELS, SetupFlow, type SetupStepId } from "./setup-flow.ts";
import {
	center,
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
	type Tone,
} from "./setup-frame.ts";

export interface SetupResult {
	/** Lines to show once setup is over. Never includes a key. */
	lines: string[];
	savedKey: boolean;
}

export type SetupLayout = "fullscreen" | "inline";

export interface SetupWizardOptions {
	agentDir: string;
	catalog?: ModelsCatalog;
	env?: NodeJS.ProcessEnv;
	fetchImpl?: typeof fetch;
	/** Overrides the baseUrl from runinfra.json. */
	baseUrl?: string;
	/** Overrides the POSIX chmod / Windows icacls step. */
	fileLock?: FileLockOptions;
	/** Overrides the classifier endpoints used for the router key check (tests). */
	routerBaseUrls?: Partial<Record<ClassifierBackend, string>>;
	/**
	 * The OpenRouter decision-model list for the classifier picker. Default: the 24 h cache (or the built-in list)
	 * right away, then the live list from openrouter.ai when the cache is not fresh.
	 */
	decisionModels?: { initial?: DecisionModelList; refresh?: () => Promise<DecisionModelList> };
	/** Default "fullscreen". */
	layout?: SetupLayout;
	/** Start on the welcome screen. Default: true in fullscreen, false inline. */
	welcome?: boolean;
	/** Terminal rows for the fullscreen layout. Default: process.stdout.rows, else 30. */
	getRows?: () => number;
	/** Themes offered in the theme step. Default: the built-in themes. Fewer than two hides the step. */
	themes?: readonly string[];
	/** Apply a theme while it is highlighted; `undefined` restores the one in use before setup. */
	previewTheme?: (name: string | undefined) => void;
	/** Spinner frame interval in ms (tests pass 0 to disable the timer). Default 80. */
	spinnerIntervalMs?: number;
	/**
	 * How long a checked key stays on screen before the wizard moves on by itself, in ms. Any key press
	 * cancels it; enter moves on at once. 0 turns it off (tests). Default 1200.
	 */
	keyAdvanceMs?: number;
	/** Called after async work (a key check) so the TUI can repaint. */
	requestRender?: () => void;
	onComplete: (result: SetupResult) => void;
	onCancel: () => void;
}

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export const SETUP_WIZARD_WELCOME = "Welcome to RunKiln";
export const SETUP_WIZARD_TAGLINE = "Ready in a minute. Nothing is saved until you finish.";
export const SETUP_WIZARD_DONE = "✓ You're set";
export const SETUP_ROUTER_SKIPPED = "router: off (add a classifier key later with /setup keys)";
export const SETUP_QUIT_PROMPT = "Quit setup? Nothing has been saved.";
/** The shortcuts on the done screen. */
export const DONE_SHORTCUTS: ReadonlyArray<readonly [string, string]> = [
	["Alt+R", "routing mode (auto low / medium / high)"],
	["Alt+M", "permission mode"],
	["/help", "every command"],
];

type RouterOption = "keep" | ClassifierBackend | "skip";
type RouterPhase = "choose" | "model" | "key";
type KeySource = "typed" | "saved" | "env";
type ModelRow = 0 | 1 | 2;

interface SummaryRow {
	step: EditableStep;
	label: string;
	value: string;
	tone?: Tone;
}

type StatusLine = StatusMessage;

const THINKING_HINTS: Record<SetupThinkingLevel, string> = {
	off: "fastest, cheapest",
	minimal: "a quick sketch",
	low: "routine edits",
	medium: "balanced",
	high: "harder changes",
	xhigh: "slower, deeper",
	max: "deepest, slowest",
};

export class SetupWizard implements Component, Focusable {
	private readonly agentDir: string;
	private readonly catalog: ModelsCatalog;
	private readonly env: NodeJS.ProcessEnv;
	private readonly fetchImpl: typeof fetch | undefined;
	private readonly baseUrl: string;
	private readonly fileLock: FileLockOptions | undefined;
	private readonly routerBaseUrls: Partial<Record<ClassifierBackend, string>>;
	private readonly layout: SetupLayout;
	private readonly getRows: () => number;
	private readonly previewThemeImpl: (name: string | undefined) => void;
	private readonly spinnerIntervalMs: number;
	private readonly keyAdvanceMs: number;
	private readonly requestRender: () => void;
	private readonly onCompleteCallback: (result: SetupResult) => void;
	private readonly onCancelCallback: () => void;
	private readonly flow: SetupFlow;
	private readonly stored: StoredSetupDefaults;
	private readonly routerSettings: RouterClassifierSettings;
	private readonly themes: readonly string[];
	/** A key saved in runinfra.json before setup. Never rendered. */
	private readonly existingKey: string | undefined;
	/** A classifier (saved key or env key) already works: auto routing needs no classifier step. */
	private readonly classifierBefore: boolean;

	private readonly keyInput = new Input({ prompt: "", mask: true });
	private readonly routerKeyInput = new Input({ prompt: "", mask: true });
	private readonly decisionModelsOption: SetupWizardOptions["decisionModels"];
	private routerPicker: DecisionModelPicker | undefined;
	private decisionRefresh: Promise<void> | undefined;

	// Key step
	private keySource: KeySource | undefined;
	private keyOk = false;
	/** A typed key that passed the check, held until Finish. Never rendered. */
	private keyToSave: string | undefined;
	private keyStatus: StatusLine | undefined;
	private models: SetupModel[] = [];

	// Classifier step
	private routerPhase: RouterPhase = "choose";
	private routerOptions: RouterOption[] = [];
	private routerCursor = 0;
	private routerChoice: RouterOption | undefined;
	private routerModel: string | undefined;
	private routerKeyToSave: string | undefined;
	private routerUsingEnv = false;
	private routerOk = false;
	private routerStatus: StatusLine | undefined;
	private routerDetail: string | undefined;
	/** Auto permissions were picked without a classifier key: the classifier step was opened for them. */
	private wantAutoPermissions = false;

	// Model (with thinking for a manual model), permissions, theme
	/** 0 auto, 1 manual model, 2 manual thinking. Rows 1 and 2 both mean "manual". */
	private modelRow: ModelRow;
	private autoMode: RouterMode;
	private manualIndex: number | undefined;
	private thinkingIndex: number;
	private permission: PermissionMode;
	private permissionCursor: number;
	private permissionChosen = false;
	private themeIndex: number;
	private themeTouched = false;

	// Review and done
	private summaryCursor = 0;
	private saveError: string | undefined;
	private doneResult: SetupResult | undefined;

	/** One line for the next screen's status slot ("No classifier: using ..."). */
	private flash: StatusLine | undefined;
	/** The last frame, for mouse hit testing. */
	private lastFrame: Frame | undefined;
	/** Moves on from a checked key unless a key is pressed first. */
	private advanceTimer: NodeJS.Timeout | undefined;
	private quitConfirm = false;
	/** Width of the last frame, to tell at input time whether the "too small" notice is up. */
	private lastWidth = 0;
	private busy = false;
	private closed = false;
	private spinnerFrame = 0;
	private spinnerTimer: NodeJS.Timeout | undefined;
	private task: Promise<void> = Promise.resolve();
	private _focused = false;

	constructor(options: SetupWizardOptions) {
		this.agentDir = options.agentDir;
		this.catalog = options.catalog ?? loadModelsCatalog();
		this.env = options.env ?? process.env;
		this.fetchImpl = options.fetchImpl;
		const config = loadSetupConfig(options.agentDir);
		this.baseUrl = options.baseUrl ?? config.baseUrl;
		this.existingKey = config.apiKey;
		this.fileLock = options.fileLock;
		this.routerSettings = loadRouterClassifierSettings(options.agentDir);
		this.decisionModelsOption = options.decisionModels;
		this.routerBaseUrls = {
			jev: options.routerBaseUrls?.jev ?? this.routerSettings.jevBaseUrl,
			openrouter: options.routerBaseUrls?.openrouter ?? this.routerSettings.openrouterBaseUrl,
		};
		this.layout = options.layout ?? "fullscreen";
		this.getRows = options.getRows ?? (() => process.stdout.rows || 30);
		this.spinnerIntervalMs = options.spinnerIntervalMs ?? 80;
		this.keyAdvanceMs = options.keyAdvanceMs ?? 1200;
		this.requestRender = options.requestRender ?? (() => {});
		this.onCompleteCallback = options.onComplete;
		this.onCancelCallback = options.onCancel;
		this.stored = loadStoredSetupDefaults(options.agentDir);
		const active = safeActiveClassifier(this.agentDir, this.env, this.routerSettings);
		this.classifierBefore =
			active.choice !== "off" && !!active.backend && !!active.key && active.key.source !== "none";

		this.themes = options.themes ?? getAvailableThemes();
		const storedTheme = this.stored.theme;
		const themeIndex = storedTheme ? this.themes.indexOf(storedTheme) : this.themes.indexOf(SYSTEM_THEME_NAME);
		this.themeIndex = Math.max(0, themeIndex);
		this.previewThemeImpl =
			options.previewTheme ??
			((name) => {
				setTheme(name ?? resolveThemeSetting(storedTheme, getTerminalTheme()) ?? SYSTEM_THEME_NAME);
			});

		this.flow = new SetupFlow({
			welcome: options.welcome ?? this.layout === "fullscreen",
			theme: this.themes.length > 1,
			done: this.layout === "fullscreen",
			include: (step) => (step === "router" ? this.needsClassifierStep() : true),
		});

		// Auto is preselected when a classifier already works (or was the saved choice and still can);
		// otherwise one manual model, so enter-enter-enter finishes without a second key.
		const storedKind = this.stored.model?.kind;
		this.modelRow = storedKind === "manual" ? 1 : this.classifierBefore ? 0 : 1;
		this.autoMode =
			this.stored.model?.kind === "auto" ? this.stored.model.mode : (this.stored.routerMode ?? "medium");
		this.thinkingIndex = this.stored.thinking ? SETUP_THINKING_LEVELS.indexOf(this.stored.thinking) + 1 : 0;
		this.permission = this.stored.permissions ?? "read-write";
		this.permissionCursor = PERMISSION_MODES.indexOf(this.permission);
		this.models = this.catalog.models.map((model) => ({ id: model.id, name: model.name }));

		if (this.flow.current === "key") this.enterKeyStep();
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.keyInput.focused = value;
		this.routerKeyInput.focused = value;
	}

	/** The step on screen (tests, host). */
	get step(): SetupStepId {
		return this.flow.current;
	}

	get isQuitConfirmOpen(): boolean {
		return this.quitConfirm;
	}

	invalidate(): void {}

	/** Resolves when the current key check finishes. */
	whenIdle(): Promise<void> {
		return this.task;
	}

	dispose(): void {
		this.closed = true;
		this.stopSpinner();
		this.cancelAdvance();
		this.keyInput.setValue("");
		this.routerKeyInput.setValue("");
		this.keyToSave = undefined;
		this.routerKeyToSave = undefined;
	}

	// =========================================================================
	// Input
	// =========================================================================

	handleInput(data: string): void {
		if (this.closed) return;
		this.cancelAdvance();
		this.onInput(data);
		this.requestRender();
	}

	/** Clicks run the target under the pointer; the wheel moves like the arrows. */
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
		this.cancelAdvance();
		hit.run();
		this.requestRender();
		return { handled: true };
	}

	/** After a key checks out: stay on screen, then run `next` unless something is pressed first. */
	private scheduleAdvance(next: () => void): void {
		this.cancelAdvance();
		if (this.keyAdvanceMs <= 0) return;
		this.advanceTimer = setTimeout(() => {
			this.advanceTimer = undefined;
			if (this.closed) return;
			next();
			this.requestRender();
		}, this.keyAdvanceMs);
		this.advanceTimer.unref?.();
	}

	private cancelAdvance(): void {
		if (this.advanceTimer) clearTimeout(this.advanceTimer);
		this.advanceTimer = undefined;
	}

	private onInput(data: string): void {
		const ctrlC = data === "\x03" || matchesKey(data, "ctrl+c");
		if (this.flow.current === "done") {
			// Everything is saved: any of these just closes.
			if (ctrlC || isSubmit(data) || isEscape(data) || data === "q" || data === "Q") this.complete();
			return;
		}
		if (this.quitConfirm) {
			if (ctrlC || data === "y" || data === "Y" || data === "q") this.cancel();
			else if (data === "n" || data === "N" || isEscape(data) || isSubmit(data)) this.quitConfirm = false;
			return;
		}
		if (ctrlC) {
			this.quitConfirm = true;
			return;
		}
		if (this.isTooSmall()) {
			if (data === "q" || data === "Q" || isEscape(data)) this.quitConfirm = true;
			return;
		}
		if (this.busy) return;
		const typing = this.isTyping();
		if (!typing && (data === "q" || data === "Q")) {
			this.quitConfirm = true;
			return;
		}
		switch (this.flow.current) {
			case "welcome":
				if (isSubmit(data)) this.goNext();
				else if (isEscape(data)) this.quitConfirm = true;
				return;
			case "key":
				this.onKeyInput(data);
				return;
			case "model":
				this.onModelInput(data);
				return;
			case "router":
				this.onRouterInput(data);
				return;
			case "permissions":
				this.onPermissionsInput(data);
				return;
			case "theme":
				this.onThemeInput(data);
				return;
			case "summary":
				this.onSummaryInput(data);
				return;
			default:
				return;
		}
	}

	/** A text field has focus, so letters (including q) are typed. */
	private isTyping(): boolean {
		const step = this.flow.current;
		if (step === "key") return this.keySource !== "env";
		if (step === "router") return this.routerPhase === "key" && !this.routerUsingEnv;
		return false;
	}

	private goNext(): void {
		this.saveError = undefined;
		this.flash = undefined;
		const next = this.flow.next();
		this.onEnter(next);
	}

	private goBack(): void {
		this.flash = undefined;
		if (this.flow.back() === "quit") {
			this.quitConfirm = true;
			return;
		}
		this.onEnter(this.flow.current);
	}

	/** Prepare a step as it comes on screen. */
	private onEnter(step: SetupStepId): void {
		switch (step) {
			case "key":
				this.enterKeyStep();
				return;
			case "router":
				this.enterRouterStep();
				return;
			case "permissions":
				// With a classifier and no earlier choice, auto is the suggested default.
				if (!this.permissionChosen && !this.stored.permissions && this.autoPermissionsAvailable())
					this.permission = "auto";
				this.normalizeForRouter();
				this.permissionCursor = PERMISSION_MODES.indexOf(this.permission);
				return;
			case "summary":
				this.normalizeForRouter();
				this.summaryCursor = this.summaryRows().length;
				return;
			default:
				return;
		}
	}

	// ----- key ---------------------------------------------------------------

	private enterKeyStep(): void {
		if (this.keyOk) return;
		const envKey = environmentApiKey(this.env);
		if (envKey) {
			this.keySource = "env";
			this.checkKey(envKey, "env");
			return;
		}
		this.keySource = undefined;
	}

	private onKeyInput(data: string): void {
		if (isEscape(data)) {
			this.keyInput.setValue("");
			this.goBack();
			return;
		}
		if (this.keySource === "env") {
			if (isSubmit(data) && this.keyOk) this.goNext();
			else if (isSubmit(data)) this.checkKey(environmentApiKey(this.env) ?? "", "env");
			return;
		}
		if (isSubmit(data)) {
			this.submitKey();
			return;
		}
		const pasteEnded = data.includes("\x1b[201~");
		this.keyInput.handleInput(data);
		if (this.keyOk && this.keyInput.getValue()) {
			// Typing after a checked key replaces it: check again before moving on.
			this.keyOk = false;
			this.keyToSave = undefined;
			this.keyStatus = undefined;
		}
		if (pasteEnded && this.keyInput.getValue().trim()) this.submitKey();
	}

	private submitKey(): void {
		const typed = this.keyInput.getValue().trim();
		if (typed) {
			this.checkKey(typed, "typed");
			return;
		}
		if (this.keyOk) {
			this.goNext();
			return;
		}
		if (this.existingKey) {
			this.checkKey(this.existingKey, "saved");
			return;
		}
		this.keyStatus = { tone: "muted", text: "Paste a key first." };
	}

	private checkKey(key: string, source: KeySource): void {
		this.busy = true;
		this.keyStatus = { tone: "checking", text: "Checking with RunInfra…" };
		this.startSpinner();
		this.task = (async () => {
			try {
				const result = await checkRunInfraKey({
					baseUrl: this.baseUrl,
					apiKey: key,
					catalog: this.catalog,
					fetchImpl: this.fetchImpl,
				});
				if (this.closed) return;
				if (!result.ok) {
					this.keyOk = false;
					this.keyToSave = undefined;
					if (source === "typed") this.keyInput.setValue("");
					this.keyStatus = { tone: "error", text: result.message };
					return;
				}
				saveCatalogCache(this.agentDir, this.baseUrl, result.remote);
				if (result.models.length > 0) this.models = result.models;
				this.keyOk = true;
				this.keySource = source;
				this.keyToSave = source === "typed" ? key : undefined;
				this.keyInput.setValue("");
				const count = result.models.length;
				const text = count > 0 ? `${SETUP_KEY_WORKS} - ${count} model${count === 1 ? "" : "s"}` : SETUP_KEY_WORKS;
				this.keyStatus = { tone: "success", text };
				// The result stays on screen; enter continues. An env key waits for enter so it is clear which
				// key is used.
				if (source !== "env") this.scheduleAdvance(() => this.goNext());
			} catch {
				if (this.closed) return;
				this.keyOk = false;
				if (source === "typed") this.keyInput.setValue("");
				this.keyStatus = { tone: "error", text: "Couldn't reach RunInfra. Check your connection." };
			} finally {
				this.busy = false;
				this.stopSpinner();
				this.requestRender();
			}
		})();
	}

	// ----- model -------------------------------------------------------------

	private manualModels(): SetupModel[] {
		return this.models;
	}

	/** The highlighted manual model: the one picked here, else the saved one, else the catalog default. */
	private manualModelIndex(): number {
		const models = this.manualModels();
		if (this.manualIndex !== undefined) return Math.min(this.manualIndex, Math.max(0, models.length - 1));
		const stored = this.stored.model;
		if (stored?.kind === "manual") {
			const index = models.findIndex((model) => model.id === stored.id);
			if (index >= 0) return index;
		}
		return Math.max(
			0,
			models.findIndex((model) => model.id === this.catalog.defaults.code),
		);
	}

	private wantsAuto(): boolean {
		return this.modelRow === 0;
	}

	private currentModelChoice(): SetupModelChoice {
		if (this.wantsAuto() && this.hasRouter()) return { kind: "auto", mode: this.autoMode };
		const model = this.manualModels()[this.manualModelIndex()];
		return { kind: "manual", id: model?.id ?? this.catalog.defaults.code };
	}

	private onModelInput(data: string): void {
		if (isEscape(data)) {
			this.goBack();
			return;
		}
		if (isSubmit(data)) {
			this.goNext();
			return;
		}
		if (isUp(data) || isDown(data)) {
			// Auto, Manual, and (once manual) its thinking row.
			const rows: ModelRow[] = this.modelRow === 0 ? [0, 1] : [0, 1, 2];
			const at = rows.indexOf(this.modelRow);
			const step = isUp(data) ? -1 : 1;
			this.modelRow = rows[(at + step + rows.length) % rows.length] ?? 0;
			return;
		}
		const delta = isLeft(data) ? -1 : isRight(data) ? 1 : 0;
		if (delta === 0) return;
		if (this.modelRow === 0) {
			const index = ROUTER_MODES.indexOf(this.autoMode);
			this.autoMode = ROUTER_MODES[(index + delta + ROUTER_MODES.length) % ROUTER_MODES.length] ?? "medium";
			return;
		}
		if (this.modelRow === 2) {
			const count = SETUP_THINKING_LEVELS.length + 1;
			this.thinkingIndex = Math.max(0, Math.min(count - 1, this.thinkingIndex + delta));
			return;
		}
		const models = this.manualModels();
		if (models.length === 0) return;
		this.manualIndex = (this.manualModelIndex() + delta + models.length) % models.length;
	}

	private thinkingChoice(): SetupThinkingLevel | undefined {
		return this.thinkingIndex === 0 ? undefined : SETUP_THINKING_LEVELS[this.thinkingIndex - 1];
	}

	// ----- classifier --------------------------------------------------------

	/**
	 * The classifier step shows only when something needs it and no classifier works yet: auto routing,
	 * or auto permissions picked on the permissions screen. Once configured here it stays in the indicator.
	 */
	private needsClassifierStep(): boolean {
		if (this.routerBackend() && this.routerOk) return true;
		if (this.classifierBefore) return false;
		return this.wantsAuto() || this.wantAutoPermissions;
	}

	private enterRouterStep(): void {
		this.routerPhase = "choose";
		const options: RouterOption[] = this.classifierBefore ? ["keep"] : [];
		options.push("jev", "openrouter", "skip");
		this.routerOptions = options;
		if (this.routerChoice && options.includes(this.routerChoice)) {
			this.routerCursor = options.indexOf(this.routerChoice);
			return;
		}
		const envBackend = (["jev", "openrouter"] as const).find((backend) =>
			this.env[CLASSIFIER_KEY_ENV[backend]]?.trim(),
		);
		const preferred: RouterOption = options.includes("keep") ? "keep" : (envBackend ?? "jev");
		this.routerCursor = Math.max(0, options.indexOf(preferred));
	}

	/** Leave the classifier step: back to permissions when it was opened from there, else one step back. */
	private leaveRouterBack(): void {
		if (this.wantAutoPermissions && !this.flow.isEditing) {
			this.wantAutoPermissions = false;
			this.flash = undefined;
			this.flow.jump("permissions");
			this.onEnter("permissions");
			return;
		}
		this.wantAutoPermissions = false;
		this.goBack();
	}

	private onRouterInput(data: string): void {
		if (this.routerPhase === "model") {
			this.onRouterModelInput(data);
			return;
		}
		if (this.routerPhase === "key") {
			this.onRouterKeyInput(data);
			return;
		}
		if (isEscape(data)) {
			this.leaveRouterBack();
			return;
		}
		const count = this.routerOptions.length;
		if (isUp(data)) {
			this.routerCursor = (this.routerCursor + count - 1) % count;
			return;
		}
		if (isDown(data)) {
			this.routerCursor = (this.routerCursor + 1) % count;
			return;
		}
		if (!isSubmit(data)) return;
		const option = this.routerOptions[this.routerCursor] ?? "skip";
		this.routerStatus = undefined;
		this.routerDetail = undefined;
		if (option === "keep" || option === "skip") {
			this.routerChoice = option;
			this.routerKeyToSave = undefined;
			this.routerModel = undefined;
			this.routerUsingEnv = false;
			this.routerOk = option === "keep";
			let flash: StatusLine | undefined;
			if (option === "skip") {
				if (this.wantsAuto()) {
					this.modelRow = 1;
					const choice = this.currentModelChoice();
					const name = choice.kind === "manual" ? this.modelName(choice.id) : "";
					flash = { tone: "muted", text: `No classifier: using ${name}` };
				}
				this.wantAutoPermissions = false;
			}
			this.goNext();
			if (flash) this.flash = flash;
			return;
		}
		if (this.routerChoice !== option) {
			this.routerOk = false;
			this.routerKeyToSave = undefined;
		}
		this.routerChoice = option;
		this.flash = undefined;
		if (option === "openrouter") {
			this.openDecisionPicker();
			this.routerPhase = "model";
			return;
		}
		this.routerModel = undefined;
		this.enterRouterKey();
	}

	/** The decision-model picker: the cached (or built-in) list now, the live list when it arrives. */
	private openDecisionPicker(): void {
		const initial = this.decisionModelsOption?.initial ?? getCachedDecisionModels(this.agentDir);
		const saved = this.routerSettings.openrouterModel;
		const current = this.routerModel ?? (saved && isDecisionModel(saved, initial) ? saved : OPENROUTER_DEFAULT_MODEL);
		if (this.routerPicker) this.routerPicker.select(current);
		else this.routerPicker = new DecisionModelPicker(initial, current);
		if (initial.source === "cache" && !this.decisionModelsOption?.refresh) return;
		if (this.decisionRefresh) return;
		const refresh =
			this.decisionModelsOption?.refresh ?? (() => getDecisionModels(this.agentDir, { fetch: this.fetchImpl }));
		this.decisionRefresh = refresh()
			.then((list) => {
				if (this.closed || list.entries.length === 0) return;
				this.routerPicker?.replace(list);
				this.requestRender();
			})
			.catch(() => {});
	}

	private onRouterModelInput(data: string): void {
		if (isEscape(data)) {
			this.routerStatus = undefined;
			this.routerPhase = "choose";
			return;
		}
		const picker = this.routerPicker;
		if (!picker) return;
		if (isUp(data)) {
			picker.move(-1);
			return;
		}
		if (isDown(data)) {
			picker.move(1);
			return;
		}
		if (matchesKey(data, "pageUp")) {
			picker.move(-8);
			return;
		}
		if (matchesKey(data, "pageDown")) {
			picker.move(8);
			return;
		}
		if (!isSubmit(data)) return;
		const model = picker.selected?.id;
		if (!model) return;
		if (model !== this.routerModel) this.routerOk = false;
		this.routerModel = model;
		this.routerStatus = undefined;
		this.enterRouterKey();
	}

	private routerBackend(): ClassifierBackend | undefined {
		const choice = this.routerChoice;
		return choice === "jev" || choice === "openrouter" ? choice : undefined;
	}

	private enterRouterKey(): void {
		const backend = this.routerBackend();
		if (!backend) return;
		this.routerKeyInput.setValue("");
		this.routerPhase = "key";
		const envKey = this.env[CLASSIFIER_KEY_ENV[backend]]?.trim();
		this.routerUsingEnv = !!envKey;
		if (this.routerOk) return;
		this.routerStatus = undefined;
		this.routerDetail = undefined;
		if (envKey) this.checkRouter(envKey, false);
	}

	private onRouterKeyInput(data: string): void {
		const backend = this.routerBackend();
		if (!backend) return;
		if (isEscape(data)) {
			this.routerKeyInput.setValue("");
			this.routerStatus = undefined;
			this.routerDetail = undefined;
			this.routerPhase = backend === "openrouter" ? "model" : "choose";
			return;
		}
		if (this.routerUsingEnv) {
			if (!isSubmit(data)) return;
			if (this.routerOk) this.routerDone();
			else {
				const envKey = this.env[CLASSIFIER_KEY_ENV[backend]]?.trim();
				if (envKey) this.checkRouter(envKey, false);
			}
			return;
		}
		if (!isSubmit(data)) {
			const pasteEnded = data.includes("\x1b[201~");
			this.routerKeyInput.handleInput(data);
			if (this.routerKeyInput.getValue()) {
				this.routerOk = false;
				this.routerKeyToSave = undefined;
			}
			if (pasteEnded && this.routerKeyInput.getValue().trim()) this.submitRouterKey(backend);
			return;
		}
		this.submitRouterKey(backend);
	}

	private submitRouterKey(backend: ClassifierBackend): void {
		const typed = this.routerKeyInput.getValue().trim();
		if (!typed && this.routerOk) {
			this.routerDone();
			return;
		}
		const saved = readRouterKeys(this.agentDir)[backend];
		if (!typed && !saved) {
			this.routerStatus = { tone: "muted", text: "Paste a key, or esc for another option." };
			return;
		}
		this.checkRouter(typed || (saved as string), !!typed);
	}

	/** A working classifier: auto permissions picked earlier become the choice, then move on. */
	private routerDone(): void {
		if (this.wantAutoPermissions) {
			this.permission = "auto";
			this.permissionChosen = true;
			this.wantAutoPermissions = false;
		}
		this.goNext();
	}

	/** Live check; on success moves on. Typed keys are held for Finish. */
	private checkRouter(key: string, typed: boolean): void {
		const backend = this.routerBackend();
		if (!backend) return;
		this.busy = true;
		this.routerStatus = { tone: "checking", text: `Checking with ${ROUTER_BACKEND_LABELS[backend]}…` };
		this.routerDetail = undefined;
		this.startSpinner();
		this.task = (async () => {
			try {
				const result = await checkRouterKey({
					backend,
					apiKey: key,
					baseUrl: this.routerBaseUrls[backend],
					model: backend === "jev" ? (this.routerSettings.jevModel ?? JEV_DEFAULT_MODEL) : this.routerModel,
					fetchImpl: this.fetchImpl,
				});
				if (this.closed) return;
				this.routerKeyInput.setValue("");
				if (!result.ok) {
					this.routerOk = false;
					this.routerKeyToSave = undefined;
					this.routerStatus = { tone: "error", text: result.message };
					return;
				}
				this.routerOk = true;
				this.routerKeyToSave = typed ? key : undefined;
				this.routerStatus = { tone: "success", text: result.message };
				this.routerDetail = result.detail;
				if (!this.routerUsingEnv) this.scheduleAdvance(() => this.routerDone());
			} catch {
				if (this.closed) return;
				this.routerKeyInput.setValue("");
				this.routerOk = false;
				this.routerStatus = { tone: "error", text: "Couldn't check the key. Check your connection." };
			} finally {
				this.busy = false;
				this.stopSpinner();
				this.requestRender();
			}
		})();
	}

	/** A classifier will be configured once setup finishes. */
	private hasRouter(): boolean {
		const choice = this.routerChoice;
		if (choice === undefined || choice === "keep") return this.classifierBefore;
		return !!this.routerBackend() && this.routerOk;
	}

	/**
	 * Whether auto permissions will be available once setup is saved, by permission-judge.ts's rule (the one
	 * /permissions, Alt+M and startup use): a Jev or OpenRouter key exists, from the environment, the saved keys, or
	 * the key this setup checked and will save.
	 */
	private autoPermissionsAvailable(): boolean {
		let stored: StoredClassifierKeys = {};
		try {
			stored = { ...readRouterKeys(this.agentDir) };
		} catch {
			stored = {};
		}
		const choice = this.routerChoice;
		let classifier = this.routerSettings.classifier;
		if (choice === "skip") classifier = "off";
		else if ((choice === "jev" || choice === "openrouter") && this.routerOk) {
			classifier = choice;
			if (this.routerKeyToSave) stored[choice] = this.routerKeyToSave;
		}
		return resolvePermissionJudgeBackend({ ...this.routerSettings, classifier }, this.env, stored) !== undefined;
	}

	/** Without a classifier, auto routing and auto permissions have nothing to ask: fall back. */
	private normalizeForRouter(): void {
		if (this.permission === "auto" && !this.autoPermissionsAvailable()) this.permission = "read-write";
		if (this.wantsAuto() && !this.hasRouter()) this.modelRow = 1;
	}

	// ----- permissions -------------------------------------------------------

	private onPermissionsInput(data: string): void {
		if (isEscape(data)) {
			this.goBack();
			return;
		}
		const available = this.autoPermissionsAvailable();
		if (isSubmit(data)) {
			const mode = PERMISSION_MODES[this.permissionCursor];
			if (!mode) return;
			if (mode === "auto" && !available) {
				// Auto permissions need a classifier key: add one, then come back with auto chosen.
				this.wantAutoPermissions = true;
				this.flow.jump("router");
				this.enterRouterStep();
				return;
			}
			this.permission = mode;
			this.permissionChosen = true;
			this.goNext();
			return;
		}
		const delta = isUp(data) ? -1 : isDown(data) ? 1 : 0;
		if (delta === 0) return;
		this.permissionCursor = (this.permissionCursor + delta + PERMISSION_MODES.length) % PERMISSION_MODES.length;
	}

	// ----- theme -------------------------------------------------------------

	private onThemeInput(data: string): void {
		if (isEscape(data)) {
			this.goBack();
			return;
		}
		if (isSubmit(data)) {
			this.goNext();
			return;
		}
		const delta = isUp(data) || isLeft(data) ? -1 : isDown(data) || isRight(data) ? 1 : 0;
		if (delta === 0 || this.themes.length === 0) return;
		this.themeIndex = (this.themeIndex + delta + this.themes.length) % this.themes.length;
		this.themeTouched = true;
		this.previewThemeImpl(this.themes[this.themeIndex]);
	}

	private themeChoice(): string | undefined {
		if (this.themes.length < 2) return undefined;
		return this.themes[this.themeIndex];
	}

	// ----- summary -----------------------------------------------------------

	private summaryRows(): SummaryRow[] {
		const rows: SummaryRow[] = [];
		rows.push({ step: "key", label: "Key", ...this.keySummary() });
		const model = this.currentModelChoice();
		const thinking = this.thinkingChoice();
		rows.push({
			step: "model",
			label: "Model",
			value:
				model.kind === "auto"
					? `Auto - ${model.mode}`
					: `${this.modelName(model.id)}${thinking ? ` - thinking ${thinking}` : ""}`,
		});
		rows.push({ step: "router", label: "Classifier", ...this.routerSummaryValue() });
		rows.push({
			step: "permissions",
			label: "Permissions",
			value: PERMISSION_LABELS[this.permission],
			tone: this.permission === "allow-all" ? "warning" : undefined,
		});
		if (this.flow.steps.includes("theme"))
			rows.push({ step: "theme", label: "Theme", value: this.themeChoice() ?? "unchanged" });
		return rows;
	}

	private keySummary(): { value: string; tone?: Tone } {
		if (!this.keyOk) return { value: "not checked", tone: "error" };
		if (this.keySource === "env") return { value: "RUNINFRA_API_KEY ✓" };
		if (this.keySource === "typed" && this.existingKey)
			return { value: "new ✓ - replaces the saved key", tone: "warning" };
		if (this.keySource === "typed") return { value: "new ✓ - saved 0600" };
		return { value: "saved ✓" };
	}

	private routerSummaryValue(): { value: string; tone?: Tone } {
		const choice = this.routerChoice;
		if (choice === "skip" || (!choice && !this.classifierBefore)) return { value: "none", tone: "muted" };
		if (!choice || choice === "keep") {
			const active = safeActiveClassifier(this.agentDir, this.env, this.routerSettings);
			return { value: active.backend ? `${ROUTER_BACKEND_LABELS[active.backend]} ✓` : "unchanged" };
		}
		if (!this.routerOk) return { value: `${ROUTER_BACKEND_LABELS[choice]} - not checked`, tone: "error" };
		const model = choice === "openrouter" && this.routerModel ? ` - ${this.routerModel}` : "";
		const key = this.routerUsingEnv ? ` - ${CLASSIFIER_KEY_ENV[choice]}` : this.routerKeyToSave ? " - new" : "";
		return { value: `${ROUTER_BACKEND_LABELS[choice]} ✓${model}${key}` };
	}

	private modelName(id: string): string {
		return (
			this.models.find((model) => model.id === id)?.name ??
			this.catalog.models.find((model) => model.id === id)?.name ??
			id
		);
	}

	private onSummaryInput(data: string): void {
		const rows = this.summaryRows();
		const count = rows.length + 1;
		if (isEscape(data)) {
			this.goBack();
			return;
		}
		if (isUp(data)) {
			this.summaryCursor = (this.summaryCursor + count - 1) % count;
			return;
		}
		if (isDown(data)) {
			this.summaryCursor = (this.summaryCursor + 1) % count;
			return;
		}
		if (data === "f" || data === "F") {
			this.finish();
			return;
		}
		if (data === "e" || data === "E" || isSubmit(data)) {
			const row = rows[this.summaryCursor];
			if (!row) {
				if (isSubmit(data)) this.finish();
				return;
			}
			this.flash = undefined;
			this.flow.edit(row.step);
			this.onEnter(row.step);
		}
	}

	private finish(): void {
		if (!this.keyOk) {
			this.saveError = "Check a RunInfra key first.";
			return;
		}
		const lines: string[] = [SETUP_DONE];
		const warnings: string[] = [];
		let savedKey = false;
		try {
			if (this.keyToSave) {
				const warning = saveRunInfraApiKey(this.agentDir, this.keyToSave, this.fileLock);
				if (warning) warnings.push(warning);
				savedKey = true;
			}
			saveSetupDefaults(this.agentDir, {
				model: this.currentModelChoice(),
				thinking: this.thinkingChoice(),
				permissions: this.permission,
				theme: this.themeChoice(),
			});
			const routerWarning = this.saveRouter();
			if (routerWarning) warnings.push(routerWarning);
		} catch {
			this.saveError = "Could not save the settings. Check that ~/.runkiln/agent is writable.";
			return;
		}
		lines.push(savedKey ? SETUP_KEY_SAVED : this.keySource === "env" ? SETUP_ENV_KEY : SETUP_KEPT_KEY);
		lines.push(this.routerResultLine());
		const model = this.currentModelChoice();
		lines.push(`model: ${model.kind === "auto" ? `auto (${model.mode})` : model.id}`);
		lines.push(`permissions: ${this.permission}`);
		lines.push(...warnings);
		this.keyToSave = undefined;
		this.routerKeyToSave = undefined;
		this.stopSpinner();
		this.doneResult = { lines, savedKey };
		this.quitConfirm = false;
		// Fullscreen ends on a short "done" screen with the key shortcuts; inline closes right away.
		if (this.flow.next() !== "done") this.complete();
	}

	private complete(): void {
		const result = this.doneResult;
		if (!result || this.closed) return;
		this.closed = true;
		this.stopSpinner();
		this.cancelAdvance();
		this.onCompleteCallback(result);
	}

	private saveRouter(): string | undefined {
		const choice = this.routerChoice;
		if (!choice || choice === "keep") return undefined;
		if (choice === "skip") {
			saveRouterClassifier(this.agentDir, "off");
			return undefined;
		}
		if (!this.routerOk) return undefined;
		let warning: string | undefined;
		if (this.routerKeyToSave) warning = saveRouterKey(this.agentDir, choice, this.routerKeyToSave, this.fileLock);
		saveRouterClassifier(this.agentDir, choice, choice === "openrouter" ? this.routerModel : undefined);
		return warning;
	}

	private routerResultLine(): string {
		const choice = this.routerChoice;
		if (choice === "skip" || (!choice && !this.classifierBefore)) return SETUP_ROUTER_SKIPPED;
		if (!choice || choice === "keep") {
			const active = safeActiveClassifier(this.agentDir, this.env);
			return active.backend ? `router: kept ${ROUTER_BACKEND_LABELS[active.backend]}` : "router: unchanged";
		}
		const model = choice === "openrouter" && this.routerModel ? ` (${this.routerModel})` : "";
		const key = this.routerUsingEnv
			? `using \`${CLASSIFIER_KEY_ENV[choice]}\``
			: this.routerKeyToSave
				? "key saved"
				: "kept the saved key";
		return `router: ${ROUTER_BACKEND_LABELS[choice]}${model}, ${key}`;
	}

	private cancel(): void {
		if (this.themeTouched) this.previewThemeImpl(undefined);
		this.dispose();
		this.onCancelCallback();
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

	/** The fullscreen frame is the "make the terminal larger" notice: only quitting works there. */
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
			return this.renderTooSmallNotice(width, rows);
		}
		const column = this.layout === "fullscreen" ? columnWidth(width) : Math.max(20, Math.min(MAX_COLUMN, width));
		const screen = this.screen(column, rows);
		const send = (data: string) => this.handleInput(data);
		const frame =
			this.layout === "fullscreen"
				? renderFrame({ width, rows, ...screen, send })
				: renderInlineFrame({ width, ...screen, send });
		this.lastFrame = frame;
		return frame.lines;
	}

	private renderTooSmallNotice(width: number, rows: number): string[] {
		const message = this.quitConfirm
			? [
					theme.bold(SETUP_QUIT_PROMPT),
					`${theme.fg("dim", "y")} ${theme.fg("muted", "quit")}${theme.fg("dim", " - ")}${theme.fg("dim", "n")} ${theme.fg("muted", "keep going")}`,
				]
			: [
					ember(theme.bold("RunKiln setup")),
					theme.fg("muted", `Make the terminal at least ${MIN_COLUMNS}x${MIN_ROWS}`),
					theme.fg("dim", `now ${width}x${rows} - q quits`),
				];
		return renderTooSmall(width, rows, message);
	}

	/** Header, body, status and hints for the current step. */
	private screen(
		column: number,
		rows: number,
	): { header: FrameLine[]; body: FrameLine[]; status: string; hints: HintItem[]; centered?: boolean } {
		const step = this.flow.current;
		if (step === "welcome") {
			return { header: [], body: this.welcomeBody(column, rows), status: "", hints: this.hints(), centered: true };
		}
		if (step === "done") {
			return { header: [], body: this.doneBody(column), status: "", hints: this.hints(), centered: true };
		}
		const { title, subtitle, body } = this.stepScreen(column);
		const header: FrameLine[] = [
			this.stepIndicator(column),
			{ text: "" },
			{ text: ember(theme.bold(title)) },
			{ text: subtitle ? clip(theme.fg("muted", subtitle), column) : "" },
		];
		return { header, body, status: this.statusSlot(), hints: this.hints() };
	}

	private spinner(): string {
		return isReducedMotion() ? STATIC_INDICATOR : (SPINNER[this.spinnerFrame] ?? "⠋");
	}

	/** The status slot: the quit prompt, the step's own status, a save error, or the note carried over. */
	private statusSlot(): string {
		if (this.quitConfirm) return theme.fg("warning", theme.bold(SETUP_QUIT_PROMPT));
		const step = this.flow.current;
		let line: StatusLine | undefined;
		if (step === "key") line = this.keyStatus;
		else if (step === "router" && this.routerPhase !== "choose") line = this.routerStatus;
		else if (step === "summary" && this.saveError) line = { tone: "error", text: this.saveError };
		return statusText(line ?? this.flash, this.spinner());
	}

	private welcomeBody(column: number, rows: number): FrameLine[] {
		const lines: FrameLine[] = [];
		const banner = rkBannerLines(VERSION);
		// The banner only when it fits with the welcome text and the hint row; never clipped.
		if (this.layout === "fullscreen" && rows >= banner.length + 14) {
			const bannerWidth = Math.max(...banner.map((line) => visibleWidth(line)));
			const offset = " ".repeat(Math.max(0, Math.floor((column - bannerWidth) / 2)));
			for (const line of banner) lines.push({ text: offset + line });
			lines.push({ text: "" }, { text: "" });
		}
		lines.push({ text: center(theme.bold(SETUP_WIZARD_WELCOME), column) });
		lines.push({ text: center(theme.fg("muted", SETUP_WIZARD_TAGLINE), column) });
		lines.push({ text: "" }, { text: "" });
		lines.push(this.buttonLine("Press enter", column, () => this.goNext()));
		return lines;
	}

	private doneBody(column: number): FrameLine[] {
		const lines: FrameLine[] = [{ text: center(theme.fg("success", theme.bold(SETUP_WIZARD_DONE)), column) }];
		lines.push({ text: "" });
		const keyWidth = Math.max(...DONE_SHORTCUTS.map(([key]) => key.length));
		const rows = DONE_SHORTCUTS.map(
			([key, label]) => `${ember(theme.bold(key.padEnd(keyWidth)))}   ${theme.fg("text", label)}`,
		);
		const rowWidth = Math.max(...rows.map((row) => visibleWidth(row)));
		const offset = " ".repeat(Math.max(0, Math.floor((column - rowWidth) / 2)));
		for (const row of rows) lines.push({ text: offset + row });
		lines.push({ text: "" }, { text: "" });
		lines.push(this.buttonLine("Press enter to start", column, () => this.complete()));
		return lines;
	}

	/** A centered "▸ label" that runs `run` when clicked. */
	private buttonLine(label: string, column: number, run: () => void): FrameLine {
		const text = center(`${ember("▸")} ${theme.bold(label)}`, column);
		const start = visibleWidth(text) - visibleWidth(`▸ ${label}`);
		return { text, hits: [{ x0: start, x1: visibleWidth(text), run }], focus: true };
	}

	private stepIndicator(column: number): FrameLine {
		const steps = this.flow.indicatorSteps;
		const parts = steps.map((step) => {
			const state = this.flow.stateOf(step);
			const label = SETUP_STEP_LABELS[step];
			if (state === "current") return `${ember("●")} ${ember(theme.bold(label))}`;
			if (state === "done") return `${theme.fg("success", "✓")} ${theme.fg("muted", label)}`;
			return theme.fg("dim", `○ ${label}`);
		});
		const full = parts.join(theme.fg("dim", " - "));
		if (visibleWidth(full) <= column) return { text: full };
		const dots = steps
			.map((step) => {
				const state = this.flow.stateOf(step);
				return state === "current"
					? ember("●")
					: state === "done"
						? theme.fg("success", "●")
						: theme.fg("dim", "○");
			})
			.join(" ");
		return { text: `${dots}  ${theme.fg("muted", `${this.flow.position}/${this.flow.total}`)}` };
	}

	private stepScreen(column: number): { title: string; subtitle?: string; body: FrameLine[] } {
		switch (this.flow.current) {
			case "key":
				return { title: "RunInfra key", subtitle: "Paste it. It is checked live.", body: this.keyBody(column) };
			case "model":
				return {
					title: "Model",
					subtitle: "Auto picks per task. Manual uses one model.",
					body: this.modelBody(column),
				};
			case "router":
				return { title: "Classifier", subtitle: this.routerReason(), body: this.routerBody(column) };
			case "permissions":
				return {
					title: "Permissions",
					subtitle: "What may run without asking?",
					body: this.permissionsBody(column),
				};
			case "theme":
				return { title: "Theme", subtitle: "Moving previews it.", body: this.themeBody(column) };
			case "summary":
				return { title: "Review", subtitle: "Enter on a row changes it.", body: this.summaryBody(column) };
			default:
				return { title: "", body: [] };
		}
	}

	private linkLine(url: string): FrameLine {
		return { text: `${theme.fg("dim", "Get one  ")}${theme.fg("mdLink", hyperlink(url, url))}` };
	}

	/** Field, then one line under it (link, length, or nothing): four rows whatever the state. */
	private keyBody(column: number): FrameLine[] {
		if (this.keySource === "env") {
			return [
				{ text: `${ember("●")} ${theme.fg("text", SETUP_ENV_KEY)}`, focus: true },
				{ text: theme.fg("dim", "Unset it to paste a key here instead.") },
			];
		}
		const value = this.keyInput.getValue();
		const placeholder = this.keyOk ? "checked" : this.existingKey ? "enter keeps the saved key" : "paste your key";
		const lines = fieldLines({
			body: this.keyInput.render(60)[0] ?? "",
			empty: !value,
			placeholder,
			label: "Key",
			column,
			focused: this._focused && !this.keyOk,
		});
		if (value) lines.push({ text: theme.fg("dim", `${value.length} characters, hidden`) });
		else lines.push(this.linkLine(RUNINFRA_KEY_URL));
		return lines;
	}

	private routerOptionLabel(option: RouterOption): string {
		if (option === "keep") {
			const active = safeActiveClassifier(this.agentDir, this.env, this.routerSettings);
			return active.backend ? `Keep ${ROUTER_BACKEND_LABELS[active.backend]}` : "Keep current";
		}
		if (option === "skip") return "Skip";
		return ROUTER_BACKEND_LABELS[option];
	}

	private routerOptionHint(option: RouterOption): string {
		switch (option) {
			case "keep": {
				const active = safeActiveClassifier(this.agentDir, this.env, this.routerSettings);
				return active.backend ? [active.model, active.key?.label].filter(Boolean).join(" - ") : "";
			}
			case "jev":
				return this.env[CLASSIFIER_KEY_ENV.jev]?.trim()
					? `${CLASSIFIER_KEY_ENV.jev} is set`
					: "System One classifier";
			case "openrouter":
				return this.env[CLASSIFIER_KEY_ENV.openrouter]?.trim()
					? `${CLASSIFIER_KEY_ENV.openrouter} is set`
					: `a decision model, ${OPENROUTER_DEFAULT_MODEL} by default`;
			default:
				return this.wantsAuto() ? "use a manual model" : "add one later with /setup keys";
		}
	}

	private routerReason(): string {
		if (this.wantAutoPermissions) return "Auto permissions need a small classifier key.";
		if (this.wantsAuto() && !this.classifierBefore) return "Auto routing needs a small classifier key.";
		return "Picks the model for each task. Optional.";
	}

	private routerBody(column: number): FrameLine[] {
		if (this.routerPhase === "choose") {
			const labels = this.routerOptions.map((option) => this.routerOptionLabel(option));
			const labelWidth = Math.max(...labels.map((label) => label.length));
			return this.routerOptions.map((option, index) =>
				optionLine({
					selected: index === this.routerCursor,
					label: labels[index] ?? "",
					labelWidth,
					hint: this.routerOptionHint(option),
					column,
					run: () => {
						this.routerCursor = index;
						this.onRouterInput("\r");
					},
				}),
			);
		}
		const backend = this.routerBackend() ?? "jev";
		if (this.routerPhase === "model") {
			const lines: FrameLine[] = [{ text: theme.fg("muted", "Decision model") }];
			const picker = this.routerPicker;
			if (picker) {
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
								this.onRouterModelInput("\r");
							},
						}),
					);
				}
				lines.push(more(window.below > 0 ? `↓ ${window.below} more` : ""));
				lines.push({ text: theme.fg("dim", clip(picker.sourceLine(), column)) });
			}
			lines.push({ text: theme.fg("dim", clip("Only decision models route and judge permissions.", column)) });
			return lines;
		}
		const envName = CLASSIFIER_KEY_ENV[backend];
		const lines: FrameLine[] = [];
		if (this.routerUsingEnv) {
			lines.push({
				text: `${ember("●")} ${theme.fg("text", `Using \`${envName}\` from your environment.`)}`,
				focus: true,
			});
			lines.push({ text: "" });
		} else {
			const saved = !!safeRouterKeys(this.agentDir)[backend];
			const model = backend === "openrouter" && this.routerModel ? ` - ${this.routerModel}` : "";
			const value = this.routerKeyInput.getValue();
			lines.push(
				...fieldLines({
					body: this.routerKeyInput.render(60)[0] ?? "",
					empty: !value,
					placeholder: this.routerOk ? "checked" : saved ? "enter keeps the saved key" : "paste your key",
					label: `${ROUTER_BACKEND_LABELS[backend]} key${model}`,
					column,
					focused: this._focused && !this.routerOk,
				}),
			);
			lines.push(this.linkLine(ROUTER_KEY_URLS[backend]));
		}
		// Reserved: the classifier's own detail once the key checks out.
		lines.push({ text: this.routerDetail ? theme.fg("dim", clip(this.routerDetail, column)) : "" });
		return lines;
	}

	private modelLabelWidth(): number {
		return Math.max("Auto".length, "Manual".length, "Thinking".length);
	}

	/**
	 * Auto, Manual and Thinking, each with its detail line always present, so the step keeps its height
	 * whichever row has the cursor.
	 */
	private modelBody(column: number): FrameLine[] {
		const labelWidth = this.modelLabelWidth();
		// Details line up with the value text (after the two-column chip padding).
		const indent = 2 + labelWidth + 2 + 2;
		const lines: FrameLine[] = [];
		const autoSelected = this.modelRow === 0;
		const manual = !autoSelected;
		const autoHint =
			this.classifierBefore || this.hasRouter()
				? DEFAULT_MODES[this.autoMode].description
				: "needs a classifier key (next step)";
		lines.push(
			chipLine({
				selected: autoSelected,
				label: "Auto",
				labelWidth,
				chips: ROUTER_MODES,
				current: ROUTER_MODES.indexOf(this.autoMode),
				inactive: manual,
				onFocus: () => {
					this.modelRow = 0;
				},
				onPick: (index) => {
					this.modelRow = 0;
					this.autoMode = ROUTER_MODES[index] ?? this.autoMode;
				},
			}),
		);
		lines.push(detailLine(autoHint, indent, column, autoSelected ? "muted" : "dim"));
		lines.push({ text: "" });

		const models = this.manualModels();
		const model = models[this.manualModelIndex()];
		const name = model?.name ?? this.catalog.defaults.code;
		lines.push(
			this.stepperLine({
				selected: this.modelRow === 1,
				label: "Manual",
				labelWidth,
				value: name,
				inactive: autoSelected,
				onFocus: () => {
					this.modelRow = 1;
				},
				onStep: (delta) => {
					this.modelRow = 1;
					this.onModelInput(delta < 0 ? "\x1b[D" : "\x1b[C");
				},
			}),
		);
		const detail = [
			model?.priceLabel ? `${model.priceLabel} per 1M` : undefined,
			models.length > 1 ? `${this.manualModelIndex() + 1} of ${models.length}` : undefined,
		]
			.filter(Boolean)
			.join(" - ");
		lines.push(detailLine(detail, indent, column, this.modelRow === 1 ? "muted" : "dim"));
		lines.push({ text: "" });

		const thinking = manual ? (this.thinkingChoice() ?? "model default") : "picked per task";
		lines.push(
			this.stepperLine({
				selected: this.modelRow === 2,
				label: "Thinking",
				labelWidth,
				value: thinking,
				inactive: autoSelected,
				disabled: autoSelected,
				onFocus: () => {
					if (manual) this.modelRow = 2;
				},
				onStep: (delta) => {
					if (!manual) return;
					this.modelRow = 2;
					this.onModelInput(delta < 0 ? "\x1b[D" : "\x1b[C");
				},
			}),
		);
		const thinkingHint = !manual
			? "auto routing sets it"
			: this.thinkingChoice()
				? THINKING_HINTS[this.thinkingChoice() as SetupThinkingLevel]
				: "each model's tuned level";
		lines.push(detailLine(thinkingHint, indent, column, this.modelRow === 2 ? "muted" : "dim"));
		return lines;
	}

	/** `Label  ‹ value ›`: the arrows step the value (keyboard ←→ or a click on either arrow). */
	private stepperLine(options: {
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
		const arrows = !options.disabled;
		const shown = selected
			? ember(theme.bold(`‹ ${value} ›`))
			: options.disabled
				? theme.fg("dim", `  ${value}`)
				: options.inactive
					? theme.fg("dim", `  ${value}  `)
					: theme.bold(`  ${value}  `);
		const width = visibleWidth(`‹ ${value} ›`);
		const hits = [{ x0: 0, x1: x, run: options.onFocus }];
		if (arrows) {
			hits.push({ x0: x, x1: x + 2, run: () => options.onStep(-1) });
			hits.push({ x0: x + 2, x1: x + width - 2, run: options.onFocus });
			hits.push({ x0: x + width - 2, x1: x + width, run: () => options.onStep(1) });
		}
		return { text: `${head}${shown}`, hits, focus: selected };
	}

	private permissionsBody(column: number): FrameLine[] {
		const available = this.autoPermissionsAvailable();
		const labelWidth = Math.max(...PERMISSION_MODES.map((mode) => PERMISSION_LABELS[mode].length));
		return PERMISSION_MODES.map((mode, index) => {
			const needsKey = mode === "auto" && !available;
			return optionLine({
				selected: index === this.permissionCursor,
				label: PERMISSION_LABELS[mode],
				labelWidth,
				hint: needsKey ? "needs a classifier key - enter adds one" : PERMISSION_HINTS[mode],
				column,
				disabled: needsKey,
				hintTone: mode === "allow-all" ? "warning" : "dim",
				run: () => {
					this.permissionCursor = index;
					this.onPermissionsInput("\r");
				},
			});
		});
	}

	private themeBody(column: number): FrameLine[] {
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
					hint,
					column,
					run: () => {
						if (this.themeIndex === index) {
							this.goNext();
							return;
						}
						this.themeIndex = index;
						this.themeTouched = true;
						this.previewThemeImpl(this.themes[index]);
					},
				}),
			);
		}
		lines.push({ text: "" });
		lines.push(...themePreview(Math.min(column, 44)));
		return lines;
	}

	private summaryBody(column: number): FrameLine[] {
		const lines: FrameLine[] = [];
		const rows = this.summaryRows();
		const labelWidth = Math.max(...rows.map((row) => row.label.length));
		for (const [index, row] of rows.entries()) {
			const selected = index === this.summaryCursor;
			const room = Math.max(4, column - labelWidth - 12);
			const value = clip(row.value, room);
			const shown = row.tone ? theme.fg(row.tone, value) : theme.fg("text", value);
			const pointer = selected ? ember("❯") : " ";
			const label = selected
				? ember(theme.bold(row.label.padEnd(labelWidth)))
				: theme.fg("muted", row.label.padEnd(labelWidth));
			const edit = selected ? theme.fg("dim", "  change") : "";
			const text = `${pointer} ${label}   ${shown}${edit}`;
			lines.push({
				text,
				focus: selected,
				hits: [
					{
						x0: 0,
						x1: Math.max(visibleWidth(text), labelWidth + 4),
						run: () => {
							this.summaryCursor = index;
							this.onSummaryInput("\r");
						},
					},
				],
			});
		}
		lines.push({ text: "" });
		const finishSelected = this.summaryCursor === rows.length;
		const button = finishSelected
			? `${ember("❯")} ${ember(theme.bold("[ Finish ]"))}`
			: `  ${theme.fg("text", "[ Finish ]")}`;
		lines.push({ text: button, focus: finishSelected, hits: [{ x0: 0, x1: 12, run: () => this.finish() }] });
		return lines;
	}

	private hints(): HintItem[] {
		const ENTER = "\r";
		const ESC = "\x1b";
		if (this.flow.current === "done") return [{ key: "enter", label: "start", data: ENTER }];
		if (this.quitConfirm) {
			return [
				{ key: "y", label: "quit", data: "y" },
				{ key: "n", label: "keep going", data: "n" },
			];
		}
		if (this.busy) return [{ key: "ctrl+c", label: "quit" }];
		const step = this.flow.current;
		const first = this.flow.steps[0] === step && !this.flow.isEditing;
		const back: HintItem = this.flow.isEditing
			? { key: "esc", label: "back to review", data: ESC }
			: { key: "esc", label: first ? "quit" : "back", data: ESC };
		const quitHint: HintItem = this.isTyping()
			? { key: "ctrl+c", label: "quit" }
			: { key: "q", label: "quit", data: "q" };
		// On the first screen esc already quits; one quit hint is enough.
		const quit = first ? undefined : quitHint;
		const list = (items: Array<HintItem | undefined>) => items.filter((item): item is HintItem => !!item);
		const move: HintItem = { key: "↑↓", label: "move" };
		switch (step) {
			case "welcome":
				return [
					{ key: "enter", label: "start", data: ENTER },
					{ key: "q", label: "quit", data: "q" },
				];
			case "key":
				if (this.keySource === "env")
					return list([{ key: "enter", label: this.keyOk ? "next" : "check again", data: ENTER }, back, quit]);
				return list([
					{ key: "enter", label: this.keyInput.getValue() || !this.keyOk ? "check" : "next", data: ENTER },
					back,
					quit,
				]);
			case "router":
				if (this.routerPhase === "choose")
					return list([move, { key: "enter", label: "select", data: ENTER }, back, quit]);
				if (this.routerPhase === "model")
					return list([
						move,
						{ key: "enter", label: "next", data: ENTER },
						{ key: "esc", label: "back", data: ESC },
						quit,
					]);
				return list([
					{
						key: "enter",
						label: this.routerOk && !this.routerKeyInput.getValue() ? "next" : "check",
						data: ENTER,
					},
					{ key: "esc", label: "back", data: ESC },
					quit,
				]);
			case "model":
				return list([
					move,
					{ key: "←→", label: "change" },
					{ key: "enter", label: "next", data: ENTER },
					back,
					quit,
				]);
			case "permissions":
			case "theme":
				return list([move, { key: "enter", label: "select", data: ENTER }, back, quit]);
			case "summary":
				return this.summaryCursor < this.summaryRows().length
					? [
							move,
							{ key: "enter", label: "change", data: ENTER },
							{ key: "f", label: "finish", data: "f" },
							{ key: "q", label: "quit", data: "q" },
						]
					: [
							move,
							{ key: "enter", label: "finish", data: ENTER },
							{ key: "esc", label: "back", data: ESC },
							{ key: "q", label: "quit", data: "q" },
						];
			default:
				return [];
		}
	}
}

/** A small code sample in the active theme, boxed, for the theme step and the hub's Look section. */
export function themePreview(width: number): FrameLine[] {
	const border = (text: string) => theme.fg("borderMuted", text);
	const row = (text: string) =>
		`${border("│")} ${text}${" ".repeat(Math.max(0, width - 4 - visibleWidth(text)))} ${border("│")}`;
	return [
		{ text: border(`╭─ Preview ${"─".repeat(Math.max(0, width - 12))}╮`) },
		{
			text: row(
				`${theme.fg("syntaxKeyword", "const")} ${theme.fg("syntaxVariable", "kiln")} ${theme.fg("syntaxOperator", "=")} ${theme.fg("syntaxString", '"fired"')}${theme.fg("syntaxPunctuation", ";")}`,
			),
		},
		{
			text: row(
				`${theme.fg("toolDiffAdded", "+ added")}  ${theme.fg("toolDiffRemoved", "- removed")}  ${theme.fg("success", "✓")} ${theme.fg("warning", "!")} ${theme.fg("error", "✗")}`,
			),
		},
		{ text: border(`╰${"─".repeat(width - 2)}╯`) },
	];
}

function safeActiveClassifier(
	agentDir: string,
	env: NodeJS.ProcessEnv,
	settings?: RouterClassifierSettings,
): ReturnType<typeof getActiveRouterClassifier> {
	try {
		return getActiveRouterClassifier(agentDir, env, settings);
	} catch {
		return { choice: "off" };
	}
}

function safeRouterKeys(agentDir: string): StoredClassifierKeys {
	try {
		return readRouterKeys(agentDir);
	} catch {
		return {};
	}
}

function isSubmit(data: string): boolean {
	return getKeybindings().matches(data, "tui.input.submit") || data === "\r" || data === "\n";
}

function isEscape(data: string): boolean {
	return matchesKey(data, "escape");
}

function isUp(data: string): boolean {
	return matchesKey(data, "up") || matchesKey(data, "shift+tab") || getKeybindings().matches(data, "tui.select.up");
}

function isDown(data: string): boolean {
	return matchesKey(data, "down") || matchesKey(data, "tab") || getKeybindings().matches(data, "tui.select.down");
}

function isLeft(data: string): boolean {
	return matchesKey(data, "left");
}

function isRight(data: string): boolean {
	return matchesKey(data, "right");
}
