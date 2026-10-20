import type { ThinkingLevel } from "@runkiln/agent-core";
import { getSupportedThinkingLevels, type Model, type Transport } from "@runkiln/ai";
import {
	type Component,
	Container,
	getCapabilities,
	type ScrollViewScrollbar,
	type SelectItem,
	type SettingItem,
	SettingsList,
	Spacer,
	Text,
	type WheelScrollLines,
} from "@runkiln/tui";
import { formatHttpIdleTimeoutMs, HTTP_IDLE_TIMEOUT_CHOICES } from "../../../core/http-dispatcher.ts";
import { SETTINGS_DEFAULTS } from "../../../core/settings-defaults.ts";
import {
	CACHE_WARMING_MODES,
	type DefaultProjectTrust,
	type DisplaySettings,
	type FullscreenExitOutput,
	type MermaidRenderingMode,
	type QuietStartup,
	type ResolvedDisplaySettings,
	TURN_SUMMARY_FIELDS,
	type TuiMode,
	type TurnSummaryField,
	type TurnSummaryFields,
	type WarningSettings,
} from "../../../core/settings-manager.ts";
import {
	getSettingsListTheme,
	parseAutoThemeSetting,
	SYSTEM_THEME_NAME,
	type TerminalTheme,
	theme,
} from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import {
	FOOTER_ELEMENT_IDS,
	FOOTER_ELEMENTS,
	type FooterElementId,
	type FooterPreset,
	type FooterShow,
	footerShowForPreset,
	isFooterElementId,
	normalizeFooterShow,
	resolveFooterShow,
} from "./footer.ts";
import { keyDisplayText } from "./keybinding-hints.ts";
import { SelectSubmenu, SteppedSubmenu, type SteppedSubmenuStep } from "./settings-submenu.ts";

/** Boolean rows display "on"/"off"; "true"/"false" are still accepted so older callers keep working. */
export function isOn(value: string): boolean {
	const v = value.trim().toLowerCase();
	return v === "on" || v === "true";
}

/** Display label for a boolean setting. */
export function onOff(value: boolean): "on" | "off" {
	return value ? "on" : "off";
}

const MODEL_PICKER_LAYOUT = { minPrimaryColumnWidth: 12, maxPrimaryColumnWidth: 46 };

const THINKING_DESCRIPTIONS: Record<ThinkingLevel, string> = {
	off: "No reasoning",
	minimal: "Very brief reasoning (~1k tokens)",
	low: "Light reasoning (~2k tokens)",
	medium: "Moderate reasoning (~8k tokens)",
	high: "Deep reasoning (~16k tokens)",
	xhigh: "Extra-high reasoning (~32k tokens)",
	max: "Maximum reasoning",
};

const DEFAULT_PROJECT_TRUST_LABELS: Record<DefaultProjectTrust, string> = {
	ask: "Ask",
	always: "Always trust",
	never: "Never trust",
};

const DEFAULT_PROJECT_TRUST_BY_LABEL = new Map(
	Object.entries(DEFAULT_PROJECT_TRUST_LABELS).map(([value, label]) => [label, value as DefaultProjectTrust]),
);

export interface SettingsConfig {
	autoCompact: boolean;
	defaultModel: string;
	currentModel?: Model<any>;
	availableDefaultModels: readonly Model<any>[];
	showImages: boolean;
	imageWidthCells: number;
	autoResizeImages: boolean;
	blockImages: boolean;
	enableSkillCommands: boolean;
	steeringMode: "all" | "one-at-a-time";
	followUpMode: "all" | "one-at-a-time";
	transport: Transport;
	httpIdleTimeoutMs: number;
	thinkingLevel: ThinkingLevel;
	availableThinkingLevels: ThinkingLevel[];
	modelThinkingLevels: Record<string, ThinkingLevel>;
	currentTheme: string;
	terminalTheme: TerminalTheme;
	availableThemes: string[];
	hideThinkingBlock: boolean;
	mermaidRenderingMode: MermaidRenderingMode;
	/** Transcript display (`display.*`); the rows are hidden when omitted. */
	display?: ResolvedDisplaySettings;
	/** Assistant prose width (`ui.maxProseWidth`, 0: no cap); the row is hidden when omitted. */
	maxProseWidth?: number;
	/** Whether `footer.items` is set; the footer layout row is hidden when omitted. */
	footerLayout?: "default" | "custom";
	/** `footer.show` (parts set on or off); the footer part rows are hidden when omitted. */
	footerShow?: Readonly<Record<string, boolean>>;
	/** The review view key (`app.changes.review`) and the free keys it can move to; the row is hidden when omitted. */
	reviewKey?: { current: string; choices: string[] };
	showCacheMissNotices: boolean;
	/** Auto mode: switch models when the routed one keeps failing (settings failover.enabled). */
	modelFailover?: boolean;
	collapseChangelog: boolean;
	doubleEscapeAction: "fork" | "tree" | "rewind" | "none";
	treeFilterMode: "default" | "no-tools" | "user-only" | "labeled-only" | "all";
	showHardwareCursor: boolean;
	editorPaddingX: number;
	outputPad: 0 | 1;
	autocompleteMaxVisible: number;
	quietStartup: QuietStartup;
	defaultProjectTrust: DefaultProjectTrust;
	clearOnShrink: boolean;
	showKeyHints: boolean;
	showTerminalProgress: boolean;
	dynamicTitle?: boolean;
	reducedMotion?: boolean;
	tuiMode: TuiMode;
	fullscreenExitOutput: FullscreenExitOutput;
	fullscreenScrollbar: ScrollViewScrollbar;
	fullscreenCopyOnSelect: boolean;
	fullscreenWheelScrollLines: WheelScrollLines;
	warnings: WarningSettings;
	/** Mouse and click settings (fullscreen). */
	click?: {
		mouse: string;
		rightClick: string;
		cardActions: boolean;
		editorOpen: string;
		pointerShape: string;
		fullRepaint: boolean;
	};
}

export interface SettingsCallbacks {
	onAutoCompactChange: (enabled: boolean) => void;
	onShowImagesChange: (enabled: boolean) => void;
	onImageWidthCellsChange: (width: number) => void;
	onAutoResizeImagesChange: (enabled: boolean) => void;
	onBlockImagesChange: (blocked: boolean) => void;
	onEnableSkillCommandsChange: (enabled: boolean) => void;
	onSteeringModeChange: (mode: "all" | "one-at-a-time") => void;
	onFollowUpModeChange: (mode: "all" | "one-at-a-time") => void;
	onTransportChange: (transport: Transport) => void;
	onHttpIdleTimeoutMsChange: (timeoutMs: number) => void;
	onModelThinkingLevelChange: (provider: string, modelId: string, level: ThinkingLevel) => void;
	onModelThinkingLevelRemove: (provider: string, modelId: string) => void;
	onThemeChange: (theme: string) => void;
	onThemePreview?: (theme: string) => void;
	onHideThinkingBlockChange: (hidden: boolean) => void;
	onMermaidRenderingModeChange: (mode: MermaidRenderingMode) => void;
	onDisplaySettingChange?: <K extends keyof DisplaySettings>(key: K, value: Required<DisplaySettings>[K]) => void;
	onMaxProseWidthChange?: (width: number) => void;
	/** Open the footer layout picker (/statusline); settings come back when it closes. */
	onOpenFooterLayout?: () => void;
	/** `footer.show` changed (undefined: back to the defaults). */
	onFooterShowChange?: (show: Partial<FooterShow> | undefined) => void;
	/** All, None or Default: sets every footer part and the key hints; Default also clears `footer.items`. */
	onFooterPreset?: (preset: FooterPreset) => void;
	/** A key id, or "none" to unbind the review view key. */
	onReviewKeyChange?: (key: string) => void;
	onShowCacheMissNoticesChange: (shown: boolean) => void;
	onModelFailoverChange?: (enabled: boolean) => void;
	onCollapseChangelogChange: (collapsed: boolean) => void;
	onDoubleEscapeActionChange: (action: "fork" | "tree" | "rewind" | "none") => void;
	onTreeFilterModeChange: (mode: "default" | "no-tools" | "user-only" | "labeled-only" | "all") => void;
	onShowHardwareCursorChange: (enabled: boolean) => void;
	onEditorPaddingXChange: (padding: number) => void;
	onOutputPadChange: (padding: 0 | 1) => void;
	onAutocompleteMaxVisibleChange: (maxVisible: number) => void;
	onQuietStartupChange: (quiet: QuietStartup) => void;
	onDefaultProjectTrustChange: (defaultProjectTrust: DefaultProjectTrust) => void;
	onClearOnShrinkChange: (enabled: boolean) => void;
	onShowKeyHintsChange: (enabled: boolean) => void;
	onShowTerminalProgressChange: (enabled: boolean) => void;
	onDynamicTitleChange?: (enabled: boolean) => void;
	onReducedMotionChange?: (enabled: boolean) => void;
	onTuiModeChange: (mode: TuiMode) => void;
	onFullscreenExitOutputChange: (output: FullscreenExitOutput) => void;
	onFullscreenScrollbarChange: (mode: ScrollViewScrollbar) => void;
	onFullscreenCopyOnSelectChange: (enabled: boolean) => void;
	onFullscreenWheelScrollLinesChange: (lines: WheelScrollLines) => void;
	/** A mouse and click setting changed: id is mouse, mouse-right-click, card-actions, editor-open, pointer-shape or full-repaint. */
	onClickSettingChange?: (id: string, value: string) => void;
	onWarningsChange: (warnings: WarningSettings) => void;
	onCancel: () => void;
}

/**
 * A submenu component for selecting from a list of options.
 */
class WarningSettingsSubmenu extends Container {
	private settingsList: SettingsList;
	private state: WarningSettings;

	constructor(warnings: WarningSettings, onChange: (warnings: WarningSettings) => void, onCancel: () => void) {
		super();

		this.state = { ...warnings };

		const items: SettingItem[] = [
			{
				id: "anthropic-extra-usage",
				label: "Anthropic extra usage",
				description: "Warn when Anthropic subscription auth may use paid extra usage",
				currentValue:
					(this.state.anthropicExtraUsage ?? SETTINGS_DEFAULTS.warnings.anthropicExtraUsage) ? "on" : "off",
				values: ["on", "off"],
			},
		];

		this.settingsList = new SettingsList(
			items,
			Math.min(items.length, 10),
			getSettingsListTheme(),
			(id, newValue) => {
				switch (id) {
					case "anthropic-extra-usage":
						this.state = { ...this.state, anthropicExtraUsage: isOn(newValue) };
						onChange({ ...this.state });
						break;
				}
			},
			onCancel,
		);

		this.addChild(this.settingsList);
	}

	handleInput(data: string): void {
		this.settingsList.handleInput(data);
	}
}

const TURN_SUMMARY_FIELD_LABELS: Record<TurnSummaryField, string> = {
	time: "Time taken",
	files: "Files changed",
	tools: "Tools",
	cost: "Cost",
	model: "Model",
	clock: "Clock",
};

const TURN_SUMMARY_FIELD_DESCRIPTIONS: Record<TurnSummaryField, string> = {
	time: "How long the turn took, 41s",
	files: "Files changed and lines, 3 files +27 -8",
	tools: "Tool calls and failed ones",
	cost: "Cost of the turn",
	model: "Model and thinking level the turn ran on",
	clock: "Time of day the turn ended, 14:32",
};

/** The turn summary fields that are on, in display order ("none" when all are off). */
export function turnSummaryFieldsSummary(fields: Readonly<TurnSummaryFields>): string {
	const on = TURN_SUMMARY_FIELDS.filter((field) => fields[field]);
	return on.length === 0 ? "none" : on.join(", ");
}

/** On/off per turn summary field. */
class TurnSummaryFieldsSubmenu extends Container {
	private settingsList: SettingsList;

	constructor(
		fields: Readonly<TurnSummaryFields>,
		onChange: (fields: TurnSummaryFields) => void,
		onCancel: () => void,
	) {
		super();
		let state = { ...fields };
		const items: SettingItem[] = TURN_SUMMARY_FIELDS.map((field) => ({
			id: field,
			label: TURN_SUMMARY_FIELD_LABELS[field],
			description: TURN_SUMMARY_FIELD_DESCRIPTIONS[field],
			currentValue: state[field] ? "on" : "off",
			values: ["on", "off"],
		}));
		this.addChild(new Text(theme.bold(theme.fg("accent", "Turn summary fields")), 0, 0));
		this.addChild(new Spacer(1));
		this.settingsList = new SettingsList(
			items,
			items.length,
			getSettingsListTheme(),
			(id, newValue) => {
				state = { ...state, [id]: isOn(newValue) };
				onChange({ ...state });
			},
			onCancel,
		);
		this.addChild(this.settingsList);
	}

	handleInput(data: string): void {
		this.settingsList.handleInput(data);
	}
}

/** Row id prefix of the footer part toggles: `footer-show:cwd`. */
export const FOOTER_SHOW_PREFIX = "footer-show:";

/** Which preset the footer matches: today's footer, everything on, everything off, or a mix ("custom"). */
export function footerPresetOf(
	show: Partial<FooterShow>,
	layout: "default" | "custom" | undefined,
	keyHints: boolean,
	turnSummaryMode: ResolvedDisplaySettings["turnSummary"] = "reply",
): FooterPreset | "custom" {
	const resolved = resolveFooterShow(show, turnSummaryMode);
	const defaults = resolveFooterShow({}, turnSummaryMode);
	const values = FOOTER_ELEMENT_IDS.map((id) => resolved[id]);
	if (layout !== "custom" && keyHints && FOOTER_ELEMENT_IDS.every((id) => resolved[id] === defaults[id])) {
		return "default";
	}
	if (keyHints && values.every(Boolean)) return "all";
	if (!keyHints && values.every((on) => !on)) return "none";
	return "custom";
}

/** /settings sections, in order: a title and the ids of its rows. Rows in no section go last, under "Other". */
const SETTINGS_SECTIONS: ReadonlyArray<{ title: string; ids: readonly string[] }> = [
	{
		title: "Model",
		ids: [
			"autocompact",
			"model-failover",
			"model-thinking",
			"steering-mode",
			"follow-up-mode",
			"transport",
			"http-idle-timeout",
			"skill-commands",
			"default-project-trust",
		],
	},
	{
		title: "Display",
		ids: [
			"theme",
			"hide-thinking",
			"tool-output",
			"prose-width",
			"output-padding",
			"mermaid-rendering",
			"display-edit-diffs",
			"display-diff-layout",
			"display-diff-syntax",
			"display-group-reads",
			"display-timestamps",
			"cache-miss-notices",
		],
	},
	{ title: "Turn summary", ids: ["display-turn-summary", "turn-summary-fields"] },
	{ title: "Changes", ids: ["display-changes-tray", "changes-tray-position", "diff-opens", "review-key"] },
	{
		title: "Footer",
		ids: [
			"footer-preset",
			"footer-layout",
			...FOOTER_ELEMENT_IDS.map((id) => `${FOOTER_SHOW_PREFIX}${id}`),
			"key-hints",
		],
	},
	{
		title: "Editor",
		ids: [
			"editor-padding",
			"autocomplete-max-visible",
			"show-hardware-cursor",
			"double-escape-action",
			"tree-filter-mode",
		],
	},
	{ title: "Images", ids: ["show-images", "image-width-cells", "auto-resize-images", "block-images"] },
	{ title: "Startup", ids: ["quiet-startup", "collapse-changelog", "warnings"] },
	{
		title: "Terminal",
		ids: [
			"tui-mode",
			"fullscreen-exit-output",
			"fullscreen-scrollbar",
			"fullscreen-copy-on-select",
			"fullscreen-wheel-scroll-lines",
			"mouse",
			"mouse-right-click",
			"card-actions",
			"editor-open",
			"pointer-shape",
			"full-repaint",
			"clear-on-shrink",
			"terminal-progress",
			"terminal-title",
			"reduced-motion",
		],
	},
];

/** Order rows by section, with a title row before each section. */
export function sectionSettingItems(items: readonly SettingItem[]): SettingItem[] {
	const byId = new Map(items.map((item) => [item.id, item]));
	const ordered: SettingItem[] = [];
	const addSection = (title: string, rows: SettingItem[]) => {
		if (rows.length === 0) return;
		ordered.push({ id: `section:${title}`, label: title, section: true, currentValue: "" });
		ordered.push(...rows);
	};
	for (const section of SETTINGS_SECTIONS) {
		const rows = section.ids.map((id) => byId.get(id)).filter((item): item is SettingItem => item !== undefined);
		for (const row of rows) byId.delete(row.id);
		addSection(section.title, rows);
	}
	addSection("Other", [...byId.values()]);
	return ordered;
}

const TRAY_POSITION_LABELS: Record<ResolvedDisplaySettings["changesTrayPosition"], string> = {
	editor: "above editor",
	footer: "footer",
};

const CLEAR_OVERRIDE_VALUE = "__clear__";

function modelSettingKey(model: Model<any>): string {
	return `${model.provider}/${model.id}`;
}

function modelDisplayLabel(model: Model<any>): string {
	return `${model.id} [${model.provider}]`;
}

function modelThinkingOverridesSummary(overrides: Record<string, ThinkingLevel>): string {
	const count = Object.keys(overrides).length;
	if (count === 0) return "none";
	return `${count} configured`;
}

function modelItemLabel(model: Model<any>): string {
	return `${model.id} ${theme.fg("muted", `[${model.provider}]`)}`;
}

function themeItems(availableThemes: string[], currentTheme: string): SelectItem[] {
	return availableThemes.map((name) => ({
		value: name,
		label: `${name === currentTheme ? "✓ " : "  "}${name}`,
		...(name === SYSTEM_THEME_NAME ? { description: "Theme created from your terminal's colors" } : {}),
	}));
}

const AUTOMATIC_THEME_VALUE = "/";

/** The system theme comes first, then automatic mode, then the remaining themes. */
function singleModeThemeItems(availableThemes: string[], currentTheme: string): SelectItem[] {
	const items = themeItems(availableThemes, currentTheme);
	const systemIndex = items.findIndex((item) => item.value === SYSTEM_THEME_NAME);
	const system = systemIndex === -1 ? [] : items.splice(systemIndex, 1);
	return [
		...system,
		{
			value: AUTOMATIC_THEME_VALUE,
			label: "  automatic",
			description: "Use separate themes for light and dark terminal appearance",
		},
		...items,
	];
}

function preferredTheme(availableThemes: string[], preferred: string | undefined, fallback: string): string {
	if (preferred && availableThemes.includes(preferred)) return preferred;
	if (availableThemes.includes(fallback)) return fallback;
	return availableThemes[0] ?? fallback;
}

function defaultAutomaticThemes(
	currentThemeSetting: string,
	availableThemes: string[],
): { lightTheme: string; darkTheme: string } {
	const autoTheme = parseAutoThemeSetting(currentThemeSetting);
	if (autoTheme) return autoTheme;

	const currentFixedTheme = currentThemeSetting.includes("/") ? undefined : currentThemeSetting;
	const themeName = preferredTheme(availableThemes, currentFixedTheme, SYSTEM_THEME_NAME);
	return { lightTheme: themeName, darkTheme: themeName };
}

class ThemeSubmenu extends Container {
	private inputComponent: Component | undefined;
	private readonly callbacks: SettingsCallbacks;
	private readonly availableThemes: string[];
	private readonly terminalTheme: TerminalTheme;
	private readonly onDone: (selectedValue?: string) => void;
	private readonly originalThemeSetting: string;
	private mode: "single" | "automatic";
	private singleTheme: string;
	private lightTheme: string;
	private darkTheme: string;

	constructor(
		currentThemeSetting: string,
		terminalTheme: TerminalTheme,
		availableThemes: string[],
		callbacks: SettingsCallbacks,
		onDone: (selectedValue?: string) => void,
	) {
		super();
		this.callbacks = callbacks;
		this.availableThemes = availableThemes;
		this.terminalTheme = terminalTheme;
		this.onDone = onDone;
		this.originalThemeSetting = currentThemeSetting;
		const autoTheme = parseAutoThemeSetting(currentThemeSetting);
		const automaticThemes = defaultAutomaticThemes(currentThemeSetting, availableThemes);
		const fixedTheme = autoTheme || currentThemeSetting.includes("/") ? undefined : currentThemeSetting;
		this.mode = autoTheme ? "automatic" : "single";
		this.lightTheme = automaticThemes.lightTheme;
		this.darkTheme = automaticThemes.darkTheme;
		this.singleTheme = preferredTheme(
			availableThemes,
			fixedTheme ?? (autoTheme ? this.getActiveAutomaticTheme() : undefined),
			SYSTEM_THEME_NAME,
		);

		if (this.mode === "automatic") {
			this.showAutomaticMenu();
		} else {
			this.showSingleMenu();
		}
	}

	handleInput(data: string): void {
		this.inputComponent?.handleInput?.(data);
	}

	private setContent(renderComponent: Component, inputComponent: Component = renderComponent): void {
		this.clear();
		this.addChild(renderComponent);
		this.inputComponent = inputComponent;
	}

	private showSingleMenu(): void {
		this.mode = "single";
		const menu = new SelectSubmenu(
			"Theme",
			"Select a theme, or choose automatic to follow terminal appearance.",
			singleModeThemeItems(this.availableThemes, this.singleTheme),
			this.singleTheme,
			(value) => {
				if (value === AUTOMATIC_THEME_VALUE) {
					this.mode = "automatic";
					this.callbacks.onThemePreview?.(this.getThemeSetting());
					this.showAutomaticMenu();
					return;
				}

				this.singleTheme = value;
				this.apply(value);
			},
			() => this.cancel(),
			(value) => {
				this.callbacks.onThemePreview?.(value === AUTOMATIC_THEME_VALUE ? this.getAutomaticThemeSetting() : value);
			},
		);
		this.setContent(menu);
	}

	private showAutomaticMenu(): void {
		this.mode = "automatic";
		const content = new Container();
		content.addChild(new Text(theme.bold(theme.fg("accent", "Automatic Theme")), 0, 0));
		content.addChild(new Spacer(1));
		content.addChild(new Text(theme.fg("muted", "Choose themes for terminal light and dark appearance."), 0, 0));
		content.addChild(new Text(theme.fg("muted", "Light/dark detection requires terminal support."), 0, 0));
		content.addChild(new Spacer(1));

		const items: SettingItem[] = [
			{
				id: "light-theme",
				label: "Light theme",
				description: "Theme to use in automatic mode when the terminal is light",
				currentValue: this.lightTheme,
				submenu: (currentValue, done) =>
					this.createThemeSelect(
						"Light Theme",
						"Select the theme to use for light terminal appearance",
						currentValue,
						done,
						(value) => {
							this.lightTheme = value;
							this.callbacks.onThemePreview?.(this.getThemeSetting());
							done(value);
						},
					),
			},
			{
				id: "dark-theme",
				label: "Dark theme",
				description: "Theme to use in automatic mode when the terminal is dark",
				currentValue: this.darkTheme,
				submenu: (currentValue, done) =>
					this.createThemeSelect(
						"Dark Theme",
						"Select the theme to use for dark terminal appearance",
						currentValue,
						done,
						(value) => {
							this.darkTheme = value;
							this.callbacks.onThemePreview?.(this.getThemeSetting());
							done(value);
						},
					),
			},
			{
				id: "apply",
				label: "Apply",
				description: "Save and go back",
				currentValue: "save and go back",
				values: ["save and go back"],
			},
			{
				id: "single-mode",
				label: "Change mode",
				description: "Switch to one theme for light and dark",
				currentValue: "switch to single theme",
				values: ["switch to single theme"],
			},
		];

		const settingsList = new SettingsList(
			items,
			Math.min(items.length, 10),
			getSettingsListTheme(),
			(id) => {
				switch (id) {
					case "single-mode":
						this.mode = "single";
						this.singleTheme = this.getActiveAutomaticTheme();
						this.callbacks.onThemePreview?.(this.singleTheme);
						this.showSingleMenu();
						break;
					case "apply":
						this.apply(this.getAutomaticThemeSetting());
						break;
				}
			},
			() => this.cancel(),
		);
		content.addChild(settingsList);
		this.setContent(content, settingsList);
	}

	private createThemeSelect(
		title: string,
		description: string,
		currentValue: string,
		done: (selectedValue?: string) => void,
		onSelect: (value: string) => void,
	): SelectSubmenu {
		return new SelectSubmenu(
			title,
			description,
			themeItems(this.availableThemes, currentValue),
			currentValue,
			onSelect,
			() => {
				this.callbacks.onThemePreview?.(this.getThemeSetting());
				done();
			},
			(value) => this.callbacks.onThemePreview?.(value),
		);
	}

	private getThemeSetting(): string {
		return this.mode === "automatic" ? this.getAutomaticThemeSetting() : this.singleTheme;
	}

	private getActiveAutomaticTheme(): string {
		return this.terminalTheme === "light" ? this.lightTheme : this.darkTheme;
	}

	private getAutomaticThemeSetting(): string {
		return `${this.lightTheme}/${this.darkTheme}`;
	}

	private apply(themeSetting: string): void {
		this.onDone(themeSetting);
	}

	private cancel(): void {
		this.callbacks.onThemePreview?.(this.originalThemeSetting);
		this.onDone();
	}
}

/**
 * Main settings selector component.
 */
export class SettingsSelectorComponent extends Container {
	private settingsList: SettingsList;

	constructor(config: SettingsConfig, callbacks: SettingsCallbacks) {
		super();

		const supportsImages = getCapabilities().images;
		const followUpKey = keyDisplayText("app.message.followUp");
		const cycleThinkingKey = keyDisplayText("app.thinking.cycle");
		let currentWarnings = { ...config.warnings };
		let currentFooterShow: Partial<FooterShow> = normalizeFooterShow(config.footerShow);
		let currentFooterLayout = config.footerLayout;
		let currentKeyHints = config.showKeyHints;
		const turnSummaryMode = config.display?.turnSummary;
		let currentTurnSummaryFields: TurnSummaryFields = {
			...(config.display?.turnSummaryFields ?? SETTINGS_DEFAULTS.display.turnSummaryFields),
		};
		const currentModelThinkingLevels = { ...config.modelThinkingLevels };
		const defaultModelByValue = new Map(
			config.availableDefaultModels.map((model) => [modelSettingKey(model), model]),
		);
		const currentDefaultModelKey = defaultModelByValue.has(config.defaultModel) ? config.defaultModel : undefined;
		const currentModelKey = config.currentModel ? modelSettingKey(config.currentModel) : undefined;

		const items: SettingItem[] = [
			{
				id: "autocompact",
				label: "Auto-compact",
				description: "Automatically compact context when it gets too large",
				currentValue: config.autoCompact ? "on" : "off",
				values: ["on", "off"],
			},
			{
				id: "steering-mode",
				label: "Steering mode",
				description:
					"Enter while streaming queues steering messages. 'one-at-a-time': deliver one, wait for response. 'all': deliver all at once.",
				currentValue: config.steeringMode,
				values: ["one-at-a-time", "all"],
			},
			{
				id: "follow-up-mode",
				label: "Follow-up mode",
				description: `${followUpKey} queues follow-up messages until agent stops. 'one-at-a-time': deliver one, wait for response. 'all': deliver all at once.`,
				currentValue: config.followUpMode,
				values: ["one-at-a-time", "all"],
			},
			{
				id: "transport",
				label: "Transport",
				description: "Preferred transport for providers that support multiple transports",
				currentValue: config.transport,
				values: ["sse", "websocket", "websocket-cached", "auto"],
			},
			{
				id: "http-idle-timeout",
				label: "HTTP idle timeout",
				description:
					"Maximum idle gap while waiting for HTTP headers or body chunks. Disable for local models that pause longer than five minutes.",
				currentValue: formatHttpIdleTimeoutMs(config.httpIdleTimeoutMs),
				values: HTTP_IDLE_TIMEOUT_CHOICES.map((choice) => choice.label),
			},
			{
				id: "hide-thinking",
				label: "Hide thinking",
				description: "Hide thinking blocks in assistant responses",
				currentValue: config.hideThinkingBlock ? "on" : "off",
				values: ["on", "off"],
			},
			{
				id: "mermaid-rendering",
				label: "Mermaid diagrams",
				description: "Render Mermaid code blocks as Unicode diagrams",
				currentValue: config.mermaidRenderingMode,
				values: ["off", "final", "streaming"],
			},
			...(config.display === undefined
				? []
				: [
						{
							id: "display-edit-diffs",
							label: "Edit diffs",
							description:
								"How edit cards show their diff until expanded: full, collapsed (counts and a few lines), or summary (header only)",
							currentValue: config.display.editDiffs,
							values: ["collapsed", "summary", "full"],
						},
						{
							id: "display-diff-layout",
							label: "Diff layout",
							description: "Unified, side by side, or side by side when the terminal is at least 140 columns",
							currentValue: config.display.diff,
							values: ["auto", "unified", "split"],
						},
						{
							id: "display-diff-syntax",
							label: "Diff syntax colours",
							description: "Syntax-highlight code inside diffs",
							currentValue: config.display.diffSyntax ? "on" : "off",
							values: ["on", "off"],
						},
						{
							id: "display-group-reads",
							label: "Group read-only tools",
							description: "Fold consecutive read, grep, find and ls calls into one expandable line",
							currentValue: config.display.groupReads ? "on" : "off",
							values: ["on", "off"],
						},
						{
							id: "display-timestamps",
							label: "Timestamps",
							description: "A dim time under each message and reply. time: 14:32. datetime: 2026-10-17 14:32",
							currentValue: config.display.timestamps,
							values: ["off", "time", "datetime"],
						},
						{
							id: "tool-output",
							label: "Tool output",
							description: "Tool cards at startup: collapsed or expanded. The tool expand key still toggles it",
							currentValue: config.display.toolOutput,
							values: ["collapsed", "expanded"],
						},
						{
							id: "display-turn-summary",
							label: "Show summary",
							description:
								"reply: a dim line after each reply. footer: the last turn as a footer row. off: hidden",
							currentValue: config.display.turnSummary,
							values: ["reply", "footer", "off"],
						},
						{
							id: "turn-summary-fields",
							label: "Fields",
							description: "What the summary shows: time taken, files, tools, cost, model, clock",
							currentValue: turnSummaryFieldsSummary(currentTurnSummaryFields),
							submenu: (_currentValue: string, done: (selectedValue?: string) => void) =>
								new TurnSummaryFieldsSubmenu(
									currentTurnSummaryFields,
									(fields) => {
										currentTurnSummaryFields = fields;
										callbacks.onDisplaySettingChange?.("turnSummaryFields", fields);
									},
									() => done(turnSummaryFieldsSummary(currentTurnSummaryFields)),
								),
						},
						{
							id: "display-changes-tray",
							label: "Changes tray",
							description: "A row with the files the agent changed this session",
							currentValue: config.display.changesTray ? "on" : "off",
							values: ["on", "off"],
						},
						{
							id: "changes-tray-position",
							label: "Tray position",
							description: "Above the editor, or under it next to the footer",
							currentValue: TRAY_POSITION_LABELS[config.display.changesTrayPosition],
							values: Object.values(TRAY_POSITION_LABELS),
						},
						{
							id: "diff-opens",
							label: "/diff opens",
							description:
								"review: this session's changes (the git panel when there are none). git: uncommitted changes. /diff review and /diff git open either",
							currentValue: config.display.diffOpens,
							values: ["review", "git"],
						},
					]),
			...(config.reviewKey === undefined
				? []
				: [
						{
							id: "review-key",
							label: "Review key",
							description: "Opens the review view. Saved to keybindings.json",
							currentValue: config.reviewKey.current,
							submenu: (currentValue: string, done: (selectedValue?: string) => void) =>
								new SelectSubmenu(
									"Review key",
									"",
									(config.reviewKey?.choices ?? []).map((key) => ({
										value: key,
										label: `${key === currentValue ? "✓ " : "  "}${key}`,
									})),
									currentValue,
									(value) => done(value),
									() => done(),
								),
						},
					]),
			...(config.maxProseWidth === undefined
				? []
				: [
						{
							id: "prose-width",
							label: "Prose width",
							description:
								"Wrap assistant prose at this many columns; code blocks and tables keep the full width",
							currentValue: config.maxProseWidth > 0 ? String(config.maxProseWidth) : "off",
							values: [
								"off",
								...[...new Set([80, 100, 120, config.maxProseWidth])]
									.filter((width) => width > 0)
									.sort((a, b) => a - b)
									.map(String),
							],
						},
					]),
			...(config.footerLayout === undefined
				? []
				: [
						{
							id: "footer-layout",
							label: "Footer layout",
							description: "Pick, order and break footer items (/statusline)",
							currentValue: config.footerLayout,
							values: [config.footerLayout],
						},
					]),
			...(config.footerShow === undefined
				? []
				: [
						{
							id: "footer-preset",
							label: "Preset",
							description:
								"all: every part on. none: no footer. default: today's footer (also resets the layout)",
							currentValue: footerPresetOf(
								currentFooterShow,
								config.footerLayout,
								config.showKeyHints,
								config.display?.turnSummary,
							),
							values: ["all", "none", "default"],
						},
						...FOOTER_ELEMENT_IDS.map((id) => ({
							id: `${FOOTER_SHOW_PREFIX}${id}`,
							label: FOOTER_ELEMENTS[id].label,
							description: FOOTER_ELEMENTS[id].description,
							currentValue: resolveFooterShow(currentFooterShow, config.display?.turnSummary)[id] ? "on" : "off",
							values: ["on", "off"],
						})),
					]),
			{
				id: "cache-miss-notices",
				label: "Cache miss notices",
				description: "Show transcript notices for cache costs and provider recovery diagnostics",
				currentValue: config.showCacheMissNotices ? "on" : "off",
				values: ["on", "off"],
			},
			...(config.modelFailover === undefined
				? []
				: [
						{
							id: "model-failover",
							label: "Model failover",
							description:
								"Auto mode: when the routed model keeps failing (5xx, 429, timeouts, stalls), switch to the other RunInfra model for the turn. A model you pick is only retried.",
							currentValue: config.modelFailover ? "on" : "off",
							values: ["on", "off"],
						},
					]),
			{
				id: "collapse-changelog",
				label: "Collapse changelog",
				description: "Show condensed changelog after updates",
				currentValue: config.collapseChangelog ? "on" : "off",
				values: ["on", "off"],
			},
			{
				id: "quiet-startup",
				label: "Quiet startup",
				description: "Disable verbose printing at startup (header: keep only the startup header)",
				currentValue: config.quietStartup === "header" ? "header" : onOff(config.quietStartup),
				values: ["on", "header", "off"],
			},
			{
				id: "default-project-trust",
				label: "Default project trust",
				description: "Fallback behavior when no extension or saved trust decision decides project trust",
				currentValue: DEFAULT_PROJECT_TRUST_LABELS[config.defaultProjectTrust],
				values: Object.values(DEFAULT_PROJECT_TRUST_LABELS),
			},
			{
				id: "double-escape-action",
				label: "Double-escape action",
				description: "Action when pressing Escape twice with empty editor",
				currentValue: config.doubleEscapeAction,
				values: ["tree", "fork", "rewind", "none"],
			},
			{
				id: "tree-filter-mode",
				label: "Tree filter mode",
				description: "Default filter when opening /tree",
				currentValue: config.treeFilterMode,
				values: ["default", "no-tools", "user-only", "labeled-only", "all"],
			},
			{
				id: "warnings",
				label: "Warnings",
				description: "Enable or disable individual warnings",
				currentValue: "configure",
				submenu: (_currentValue, done) =>
					new WarningSettingsSubmenu(
						currentWarnings,
						(warnings) => {
							currentWarnings = warnings;
							callbacks.onWarningsChange(warnings);
						},
						() => done(),
					),
			},
			{
				id: "model-thinking",
				label: "Default thinking level per model",
				description: `Override the default thinking level for specific models. ${cycleThinkingKey} cycles in-session.`,
				currentValue: modelThinkingOverridesSummary(currentModelThinkingLevels),
				submenu: (_currentValue, done) => {
					const steps: SteppedSubmenuStep[] = [
						{
							key: "model",
							title: "Per-Model Thinking Level",
							description: "Select a model to configure",
							options: () => {
								const sorted = [...config.availableDefaultModels].sort((a, b) => {
									const aKey = modelSettingKey(a);
									const bKey = modelSettingKey(b);
									if (aKey === currentModelKey) return -1;
									if (bKey === currentModelKey) return 1;
									if (aKey === currentDefaultModelKey) return -1;
									if (bKey === currentDefaultModelKey) return 1;
									return a.provider.localeCompare(b.provider);
								});
								const items: SelectItem[] = sorted.map((model) => {
									const key = modelSettingKey(model);
									const override = currentModelThinkingLevels[key];
									return {
										value: key,
										label: modelItemLabel(model),
										description: override ?? undefined,
									};
								});
								if (items.length === 0) {
									items.push({
										value: "__none__",
										label: "No models available",
										description: "Log in to a provider or configure an API key first",
									});
								}
								return items;
							},
							preselect: () => currentModelKey ?? currentDefaultModelKey,
							searchable: true,
							layout: MODEL_PICKER_LAYOUT,
						},
						{
							key: "level",
							title: (ctx) => {
								const m = defaultModelByValue.get(ctx.model);
								return `Thinking Level for ${m ? modelDisplayLabel(m) : ctx.model}`;
							},
							description: "Select default thinking level for this model",
							options: (ctx) => {
								const model = defaultModelByValue.get(ctx.model);
								if (!model) return [];
								const levels = (
									model.reasoning ? getSupportedThinkingLevels(model) : ["off"]
								) as ThinkingLevel[];
								const activeLevel = currentModelThinkingLevels[ctx.model];
								const items: SelectItem[] = levels.map((level) => ({
									value: level,
									label: `${level === activeLevel ? "✓ " : "  "}${level}`,
									description: THINKING_DESCRIPTIONS[level],
								}));
								if (currentModelThinkingLevels[ctx.model] !== undefined) {
									items.push({
										value: CLEAR_OVERRIDE_VALUE,
										label: "  (clear override)",
										description: `Revert to global default (${config.thinkingLevel})`,
									});
								}
								return items;
							},
							preselect: (ctx) => currentModelThinkingLevels[ctx.model],
						},
					];

					const summary = () => modelThinkingOverridesSummary(currentModelThinkingLevels);

					return new SteppedSubmenu(
						steps,
						(selections) => {
							const model = defaultModelByValue.get(selections.model);
							if (!model) return;
							if (selections.level === CLEAR_OVERRIDE_VALUE) {
								callbacks.onModelThinkingLevelRemove(model.provider, model.id);
								delete currentModelThinkingLevels[selections.model];
							} else {
								callbacks.onModelThinkingLevelChange(
									model.provider,
									model.id,
									selections.level as ThinkingLevel,
								);
								currentModelThinkingLevels[selections.model] = selections.level as ThinkingLevel;
							}
						},
						() => {
							done(summary());
						},
						{ loop: true },
					);
				},
			},
			{
				id: "tui-mode",
				label: "TUI mode",
				description: "Interface layout; regular mode uses the terminal's normal scrollback",
				currentValue: config.tuiMode,
				values: ["regular", "fullscreen"],
			},
			{
				id: "fullscreen-exit-output",
				label: "Fullscreen exit output",
				description: "Print the transcript or only a session resume hint when exiting fullscreen mode",
				currentValue: config.fullscreenExitOutput,
				values: ["transcript", "resume-hint"],
			},
			{
				id: "fullscreen-scrollbar",
				label: "Fullscreen scrollbar",
				description: "Scrollbar behavior in fullscreen mode; has no effect in regular mode",
				currentValue: config.fullscreenScrollbar,
				values: ["auto", "always", "hidden"],
			},
			{
				id: "fullscreen-copy-on-select",
				label: "Fullscreen copy on select",
				description: "Automatically copy selected text in fullscreen mode; disable to copy selections with Ctrl+X",
				currentValue: config.fullscreenCopyOnSelect ? "on" : "off",
				values: ["on", "off"],
			},
			...(config.click
				? [
						{
							id: "mouse",
							label: "Mouse",
							description:
								"Fullscreen mouse capture: on (clicks, hover, selection), wheel (scrolling only), off (terminal selection). Applies on restart",
							currentValue: config.click.mouse,
							values: ["on", "wheel", "off"],
						},
						{
							id: "mouse-right-click",
							label: "Right click",
							description:
								"Card menu or clipboard paste; auto pastes on Windows outside VS Code. Shift flips it",
							currentValue: config.click.rightClick,
							values: ["auto", "menu", "paste"],
						},
						{
							id: "card-actions",
							label: "Card actions",
							description: "Action strip (open, diff, copy, rerun, menu) above the tool card under the pointer",
							currentValue: config.click.cardActions ? "on" : "off",
							values: ["on", "off"],
						},
						{
							id: "editor-open",
							label: "Open files in",
							description:
								"Where clicked paths open (Ctrl+click on a path in text); a template like code -g {file}:{line} is kept as set",
							currentValue: config.click.editorOpen,
							values: [
								...new Set([
									"auto",
									"system",
									"vscode",
									"cursor",
									"zed",
									"nvim",
									"idea",
									"subl",
									"editor",
									config.click.editorOpen,
								]),
							],
						},
						{
							id: "pointer-shape",
							label: "Pointer shape",
							description: "Hand pointer over clickable things (OSC 22); auto turns it on where supported",
							currentValue: config.click.pointerShape,
							values: ["auto", "on", "off"],
						},
						{
							id: "full-repaint",
							label: "Full repaint",
							description: "Rewrite every row each frame; fixes stale fragments in some Windows terminals",
							currentValue: config.click.fullRepaint ? "on" : "off",
							values: ["on", "off"],
						},
					]
				: []),
			{
				id: "fullscreen-wheel-scroll-lines",
				label: "Fullscreen wheel scrolling",
				description:
					"Lines per mouse-wheel event in fullscreen mode; 'auto' speeds up fast wheel spins where the terminal does not",
				currentValue: String(config.fullscreenWheelScrollLines),
				values: [
					"auto",
					...[...new Set([1, 2, 3, 5, 10, config.fullscreenWheelScrollLines])]
						.filter((lines) => lines !== "auto")
						.sort((a, b) => a - b)
						.map(String),
				],
			},
			{
				id: "theme",
				label: "Theme",
				description: "Color theme for the interface",
				currentValue: config.currentTheme,
				submenu: (currentValue, done) =>
					new ThemeSubmenu(currentValue, config.terminalTheme, config.availableThemes, callbacks, done),
			},
		];

		// Only show image toggle if terminal supports it
		if (supportsImages) {
			// Insert after autocompact
			items.splice(1, 0, {
				id: "show-images",
				label: "Show images",
				description: "Render images inline in terminal",
				currentValue: config.showImages ? "on" : "off",
				values: ["on", "off"],
			});
			items.splice(2, 0, {
				id: "image-width-cells",
				label: "Image width",
				description: "Preferred inline image width in terminal cells",
				currentValue: String(config.imageWidthCells),
				values: ["60", "80", "120"],
			});
		}

		// Image auto-resize toggle (always available, affects both attached and read images)
		items.splice(supportsImages ? 3 : 1, 0, {
			id: "auto-resize-images",
			label: "Auto-resize images",
			description: "Resize large images to 2000x2000 max for better model compatibility",
			currentValue: config.autoResizeImages ? "on" : "off",
			values: ["on", "off"],
		});

		// Block images toggle (always available, insert after auto-resize-images)
		const autoResizeIndex = items.findIndex((item) => item.id === "auto-resize-images");
		items.splice(autoResizeIndex + 1, 0, {
			id: "block-images",
			label: "Block images",
			description: "Prevent images from being sent to LLM providers",
			currentValue: config.blockImages ? "on" : "off",
			values: ["on", "off"],
		});

		// Skill commands toggle (insert after block-images)
		const blockImagesIndex = items.findIndex((item) => item.id === "block-images");
		items.splice(blockImagesIndex + 1, 0, {
			id: "skill-commands",
			label: "Skill commands",
			description: "Register skills as /skill:name commands",
			currentValue: config.enableSkillCommands ? "on" : "off",
			values: ["on", "off"],
		});

		// Hardware cursor toggle (insert after skill-commands)
		const skillCommandsIndex = items.findIndex((item) => item.id === "skill-commands");
		items.splice(skillCommandsIndex + 1, 0, {
			id: "show-hardware-cursor",
			label: "Show hardware cursor",
			description: "Use the terminal cursor instead of RunKiln's drawn cursor",
			currentValue: config.showHardwareCursor ? "on" : "off",
			values: ["on", "off"],
		});

		// Editor padding toggle (insert after show-hardware-cursor)
		const hardwareCursorIndex = items.findIndex((item) => item.id === "show-hardware-cursor");
		items.splice(hardwareCursorIndex + 1, 0, {
			id: "editor-padding",
			label: "Editor padding",
			description: "Horizontal padding for input editor (0-3)",
			currentValue: String(config.editorPaddingX),
			values: ["0", "1", "2", "3"],
		});

		// Output padding toggle (insert after editor-padding)
		const editorPaddingIndex = items.findIndex((item) => item.id === "editor-padding");
		items.splice(editorPaddingIndex + 1, 0, {
			id: "output-padding",
			label: "Output padding",
			description: "Horizontal padding for messages, tool output, and command output",
			currentValue: String(config.outputPad),
			values: ["0", "1"],
		});

		// Autocomplete max visible toggle (insert after output-padding)
		const outputPaddingIndex = items.findIndex((item) => item.id === "output-padding");
		items.splice(outputPaddingIndex + 1, 0, {
			id: "autocomplete-max-visible",
			label: "Autocomplete max items",
			description: "Max visible items in autocomplete dropdown (3-20)",
			currentValue: String(config.autocompleteMaxVisible),
			values: ["3", "5", "7", "10", "15", "20"],
		});

		// Clear on shrink toggle (insert after autocomplete-max-visible)
		const autocompleteIndex = items.findIndex((item) => item.id === "autocomplete-max-visible");
		items.splice(autocompleteIndex + 1, 0, {
			id: "clear-on-shrink",
			label: "Clear on shrink",
			description: "Clear empty rows when content shrinks (may cause flicker)",
			currentValue: config.clearOnShrink ? "on" : "off",
			values: ["on", "off"],
		});

		// Key-hint row toggle (insert after autocomplete-max-visible)
		items.splice(items.findIndex((item) => item.id === "autocomplete-max-visible") + 1, 0, {
			id: "key-hints",
			label: "Key hints",
			description: "Dim line under the editor with the keys that matter now (? on an empty prompt lists all)",
			currentValue: config.showKeyHints ? "on" : "off",
			values: ["on", "off"],
		});

		// Terminal progress toggle (insert after clear-on-shrink)
		const clearOnShrinkIndex = items.findIndex((item) => item.id === "clear-on-shrink");
		items.splice(clearOnShrinkIndex + 1, 0, {
			id: "terminal-progress",
			label: "Terminal progress",
			description: "Show OSC 9;4 progress indicators in the terminal tab bar",
			currentValue: config.showTerminalProgress ? "on" : "off",
			values: ["on", "off"],
		});
		const progressIndex = items.findIndex((item) => item.id === "terminal-progress");
		items.splice(
			progressIndex + 1,
			0,
			{
				id: "terminal-title",
				label: "Terminal title",
				description: "Show working / done / needs approval in the terminal title (restored on exit)",
				currentValue: (config.dynamicTitle ?? true) ? "on" : "off",
				values: ["on", "off"],
			},
			{
				id: "reduced-motion",
				label: "Reduced motion",
				description: "No spinners or animations: static indicators instead",
				currentValue: config.reducedMotion ? "on" : "off",
				values: ["on", "off"],
			},
		);

		// Add borders
		this.addChild(new DynamicBorder());

		this.settingsList = new SettingsList(
			sectionSettingItems(items),
			10,
			getSettingsListTheme(),
			(id, newValue) => {
				const refreshPreset = () =>
					this.settingsList.updateValue(
						"footer-preset",
						footerPresetOf(currentFooterShow, currentFooterLayout, currentKeyHints, turnSummaryMode),
					);
				if (id.startsWith(FOOTER_SHOW_PREFIX)) {
					const element = id.slice(FOOTER_SHOW_PREFIX.length);
					if (!isFooterElementId(element)) return;
					currentFooterShow = { ...currentFooterShow, [element]: isOn(newValue) };
					callbacks.onFooterShowChange?.({ ...currentFooterShow });
					refreshPreset();
					return;
				}
				switch (id) {
					case "footer-preset": {
						const preset = newValue as FooterPreset;
						currentFooterShow = footerShowForPreset(preset) ?? {};
						currentKeyHints = preset !== "none";
						if (preset === "default" && currentFooterLayout !== undefined) currentFooterLayout = "default";
						callbacks.onFooterPreset?.(preset);
						const resolved = resolveFooterShow(currentFooterShow, turnSummaryMode);
						for (const element of FOOTER_ELEMENT_IDS as readonly FooterElementId[]) {
							this.settingsList.updateValue(`${FOOTER_SHOW_PREFIX}${element}`, resolved[element] ? "on" : "off");
						}
						this.settingsList.updateValue("key-hints", currentKeyHints ? "on" : "off");
						if (currentFooterLayout !== undefined)
							this.settingsList.updateValue("footer-layout", currentFooterLayout);
						break;
					}
					case "autocompact":
						callbacks.onAutoCompactChange(isOn(newValue));
						break;
					case "show-images":
						callbacks.onShowImagesChange(isOn(newValue));
						break;
					case "image-width-cells":
						callbacks.onImageWidthCellsChange(parseInt(newValue, 10));
						break;
					case "auto-resize-images":
						callbacks.onAutoResizeImagesChange(isOn(newValue));
						break;
					case "block-images":
						callbacks.onBlockImagesChange(isOn(newValue));
						break;
					case "skill-commands":
						callbacks.onEnableSkillCommandsChange(isOn(newValue));
						break;
					case "steering-mode":
						callbacks.onSteeringModeChange(newValue as "all" | "one-at-a-time");
						break;
					case "follow-up-mode":
						callbacks.onFollowUpModeChange(newValue as "all" | "one-at-a-time");
						break;
					case "transport":
						callbacks.onTransportChange(newValue as Transport);
						break;
					case "http-idle-timeout": {
						const choice = HTTP_IDLE_TIMEOUT_CHOICES.find((item) => item.label === newValue);
						if (choice) {
							callbacks.onHttpIdleTimeoutMsChange(choice.timeoutMs);
						}
						break;
					}
					case "hide-thinking":
						callbacks.onHideThinkingBlockChange(isOn(newValue));
						break;
					case "mermaid-rendering":
						callbacks.onMermaidRenderingModeChange(newValue as MermaidRenderingMode);
						break;
					case "display-edit-diffs":
						callbacks.onDisplaySettingChange?.("editDiffs", newValue as Required<DisplaySettings>["editDiffs"]);
						break;
					case "display-diff-layout":
						callbacks.onDisplaySettingChange?.("diff", newValue as Required<DisplaySettings>["diff"]);
						break;
					case "display-diff-syntax":
						callbacks.onDisplaySettingChange?.("diffSyntax", isOn(newValue));
						break;
					case "display-group-reads":
						callbacks.onDisplaySettingChange?.("groupReads", isOn(newValue));
						break;
					case "display-turn-summary":
						callbacks.onDisplaySettingChange?.("turnSummary", newValue as ResolvedDisplaySettings["turnSummary"]);
						break;
					case "tool-output":
						callbacks.onDisplaySettingChange?.("toolOutput", newValue as ResolvedDisplaySettings["toolOutput"]);
						break;
					case "changes-tray-position":
						callbacks.onDisplaySettingChange?.(
							"changesTrayPosition",
							newValue === TRAY_POSITION_LABELS.footer ? "footer" : "editor",
						);
						break;
					case "display-timestamps":
						callbacks.onDisplaySettingChange?.("timestamps", newValue as ResolvedDisplaySettings["timestamps"]);
						break;
					case "diff-opens":
						callbacks.onDisplaySettingChange?.("diffOpens", newValue as ResolvedDisplaySettings["diffOpens"]);
						break;
					case "review-key":
						callbacks.onReviewKeyChange?.(newValue);
						break;
					case "prose-width":
						callbacks.onMaxProseWidthChange?.(newValue === "off" ? 0 : parseInt(newValue, 10));
						break;
					case "footer-layout":
						callbacks.onOpenFooterLayout?.();
						break;
					case "display-changes-tray":
						callbacks.onDisplaySettingChange?.("changesTray", isOn(newValue));
						break;
					case "cache-miss-notices":
						callbacks.onShowCacheMissNoticesChange(isOn(newValue));
						break;
					case "model-failover":
						callbacks.onModelFailoverChange?.(isOn(newValue));
						break;
					case "collapse-changelog":
						callbacks.onCollapseChangelogChange(isOn(newValue));
						break;
					case "quiet-startup":
						callbacks.onQuietStartupChange(newValue === "header" ? "header" : isOn(newValue));
						break;
					case "default-project-trust": {
						const defaultProjectTrust = DEFAULT_PROJECT_TRUST_BY_LABEL.get(newValue);
						if (defaultProjectTrust) {
							callbacks.onDefaultProjectTrustChange(defaultProjectTrust);
						}
						break;
					}
					case "double-escape-action":
						callbacks.onDoubleEscapeActionChange(newValue as "fork" | "tree" | "rewind" | "none");
						break;
					case "tree-filter-mode":
						callbacks.onTreeFilterModeChange(
							newValue as "default" | "no-tools" | "user-only" | "labeled-only" | "all",
						);
						break;
					case "show-hardware-cursor":
						callbacks.onShowHardwareCursorChange(isOn(newValue));
						break;
					case "editor-padding":
						callbacks.onEditorPaddingXChange(parseInt(newValue, 10));
						break;
					case "output-padding":
						callbacks.onOutputPadChange(newValue === "0" ? 0 : 1);
						break;
					case "autocomplete-max-visible":
						callbacks.onAutocompleteMaxVisibleChange(parseInt(newValue, 10));
						break;
					case "clear-on-shrink":
						callbacks.onClearOnShrinkChange(isOn(newValue));
						break;
					case "key-hints":
						currentKeyHints = isOn(newValue);
						callbacks.onShowKeyHintsChange(currentKeyHints);
						refreshPreset();
						break;
					case "terminal-progress":
						callbacks.onShowTerminalProgressChange(isOn(newValue));
						break;
					case "terminal-title":
						callbacks.onDynamicTitleChange?.(isOn(newValue));
						break;
					case "reduced-motion":
						callbacks.onReducedMotionChange?.(isOn(newValue));
						break;
					case "tui-mode":
						callbacks.onTuiModeChange(newValue as TuiMode);
						break;
					case "fullscreen-exit-output":
						callbacks.onFullscreenExitOutputChange(newValue as FullscreenExitOutput);
						break;
					case "fullscreen-scrollbar":
						callbacks.onFullscreenScrollbarChange(newValue as ScrollViewScrollbar);
						break;
					case "fullscreen-copy-on-select":
						callbacks.onFullscreenCopyOnSelectChange(isOn(newValue));
						break;
					case "mouse":
					case "mouse-right-click":
					case "card-actions":
					case "editor-open":
					case "pointer-shape":
					case "full-repaint":
						callbacks.onClickSettingChange?.(id, newValue);
						break;
					case "fullscreen-wheel-scroll-lines":
						callbacks.onFullscreenWheelScrollLinesChange(newValue === "auto" ? "auto" : parseInt(newValue, 10));
						break;
					case "theme":
						callbacks.onThemeChange(newValue);
						break;
				}
			},
			callbacks.onCancel,
			{ enableSearch: true },
		);

		this.addChild(this.settingsList);
		this.addChild(new DynamicBorder());
	}

	getSettingsList(): SettingsList {
		return this.settingsList;
	}
}
