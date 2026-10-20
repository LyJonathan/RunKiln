import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setKeybindings } from "@runkiln/tui";
import { beforeAll, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../../src/core/keybindings.ts";
import { SETTINGS_DEFAULTS } from "../../src/core/settings-defaults.ts";
import {
	type ResolvedDisplaySettings,
	SettingsManager,
	type TurnSummaryFields,
} from "../../src/core/settings-manager.ts";
import { resolveDiffTarget } from "../../src/modes/interactive/components/changes-tray.ts";
import { FOOTER_ITEM_IDS, FooterComponent } from "../../src/modes/interactive/components/footer.ts";
import {
	type SettingsCallbacks,
	type SettingsConfig,
	SettingsSelectorComponent,
	turnSummaryFieldsSummary,
} from "../../src/modes/interactive/components/settings-selector.ts";
import {
	formatTurnSummaryLine,
	TurnSummaryComponent,
	type TurnSummaryData,
} from "../../src/modes/interactive/components/turn-summary.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";
import { footerStandIns } from "./footer-fixtures.ts";

const strip = (text: string) => text.replace(/\x1b\[[0-9;:]*[A-Za-z]/g, "").replace(/\x1b\]8;[^\x07]*\x07/g, "");
const plain = (lines: string[]) => lines.map((line) => strip(line).trimEnd());
const BANNED = /[·•—]/;
const DOWN = "\x1b[B";
const UP = "\x1b[A";

const turn: TurnSummaryData = {
	status: "done",
	durationMs: 41_000,
	files: { count: 3, added: 27, removed: 8 },
	tools: 9,
	toolErrors: 0,
	cost: 0.0031,
	route: { model: "glm-5-3-flash", thinking: "low", mode: "auto:medium" },
	endedAt: new Date(2026, 9, 17, 14, 32).getTime(),
};

function selectorConfig(display: ResolvedDisplaySettings, extra: Partial<SettingsConfig> = {}): SettingsConfig {
	return {
		autoCompact: true,
		defaultModel: "runinfra/glm-5-3-flash",
		availableDefaultModels: [],
		showImages: true,
		imageWidthCells: 60,
		autoResizeImages: true,
		blockImages: false,
		enableSkillCommands: true,
		steeringMode: "one-at-a-time",
		followUpMode: "one-at-a-time",
		transport: "auto",
		httpIdleTimeoutMs: 300_000,
		thinkingLevel: "medium",
		availableThinkingLevels: ["off", "low", "medium", "high"],
		modelThinkingLevels: {},
		currentTheme: "dark",
		terminalTheme: "dark",
		availableThemes: ["dark", "light"],
		hideThinkingBlock: false,
		mermaidRenderingMode: "streaming",
		display,
		maxProseWidth: 100,
		footerLayout: "default",
		reviewKey: { current: "alt+c", choices: ["alt+c", "alt+g", "none"] },
		showCacheMissNotices: false,
		modelFailover: true,
		collapseChangelog: false,
		doubleEscapeAction: "tree",
		treeFilterMode: "default",
		showHardwareCursor: false,
		editorPaddingX: 0,
		outputPad: 1,
		autocompleteMaxVisible: 5,
		quietStartup: false,
		defaultProjectTrust: "ask",
		clearOnShrink: false,
		showKeyHints: true,
		showTerminalProgress: false,
		dynamicTitle: true,
		reducedMotion: false,
		tuiMode: "fullscreen",
		fullscreenExitOutput: "transcript",
		fullscreenScrollbar: "auto",
		fullscreenCopyOnSelect: true,
		fullscreenWheelScrollLines: "auto",
		warnings: {},
		...extra,
	};
}

function recordingCallbacks(calls: Array<[string, unknown, unknown?]>): SettingsCallbacks {
	return new Proxy({} as SettingsCallbacks, {
		get:
			(_target, name) =>
			(...args: unknown[]) =>
				calls.push([String(name), args[0], args[1]]),
	});
}

/** Move the cursor down to the row labelled `label` (rows are unique). */
function selectRow(selector: SettingsSelectorComponent, label: string, width = 100): string[] {
	const list = selector.getSettingsList();
	for (let i = 0; i < 80; i++) {
		const lines = plain(selector.render(width));
		if (lines.some((line) => line.startsWith(`→ ${label} `) || line === `→ ${label}`)) return lines;
		list.handleInput(DOWN);
	}
	throw new Error(`row not found: ${label}`);
}

beforeAll(() => {
	initTheme("dark");
	setKeybindings(KeybindingsManager.create(mkdtempSync(join(tmpdir(), "rk-keys-"))));
});

describe("display settings defaults", () => {
	it("keep today's behaviour", () => {
		const display = SettingsManager.inMemory().getDisplaySettings();
		expect(display).toEqual({
			editDiffs: "collapsed",
			diff: "auto",
			diffSyntax: true,
			groupReads: true,
			turnSummary: "reply",
			turnSummaryFields: { time: true, files: true, tools: true, cost: true, model: true, clock: false },
			toolOutput: "collapsed",
			changesTray: true,
			changesTrayPosition: "editor",
			diffOpens: "review",
			timestamps: "off",
		});
		expect(SettingsManager.inMemory().getMaxProseWidth()).toBe(SETTINGS_DEFAULTS.ui.maxProseWidth);
	});

	it("reads the old boolean turnSummary and ignores invalid values", () => {
		expect(SettingsManager.inMemory({ display: { turnSummary: true } }).getDisplaySettings().turnSummary).toBe(
			"reply",
		);
		expect(SettingsManager.inMemory({ display: { turnSummary: false } }).getDisplaySettings().turnSummary).toBe(
			"off",
		);
		const bogus = SettingsManager.inMemory({
			display: {
				turnSummary: "sometimes" as never,
				toolOutput: "open" as never,
				changesTrayPosition: "left" as never,
				diffOpens: "both" as never,
				turnSummaryFields: { cost: false, clock: "yes" as never },
			},
		}).getDisplaySettings();
		expect(bogus).toMatchObject({
			turnSummary: "reply",
			toolOutput: "collapsed",
			changesTrayPosition: "editor",
			diffOpens: "review",
		});
		expect(bogus.turnSummaryFields).toEqual({
			time: true,
			files: true,
			tools: true,
			cost: false,
			model: true,
			clock: false,
		});
	});

	it("persist in settings.json", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "rk-agent-"));
		const cwd = mkdtempSync(join(tmpdir(), "rk-cwd-"));
		const settings = SettingsManager.create(cwd, agentDir);
		settings.setDisplaySetting("turnSummary", "footer");
		settings.setDisplaySetting("turnSummaryFields", {
			time: true,
			files: false,
			tools: true,
			cost: true,
			model: false,
			clock: true,
		});
		settings.setDisplaySetting("toolOutput", "expanded");
		settings.setDisplaySetting("changesTrayPosition", "footer");
		settings.setDisplaySetting("diffOpens", "git");
		settings.setMaxProseWidth(80);
		await settings.flush();
		const saved = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8"));
		expect(saved.display).toMatchObject({
			turnSummary: "footer",
			toolOutput: "expanded",
			changesTrayPosition: "footer",
			diffOpens: "git",
		});
		const reloaded = SettingsManager.create(cwd, agentDir).getDisplaySettings();
		expect(reloaded).toMatchObject({
			turnSummary: "footer",
			toolOutput: "expanded",
			changesTrayPosition: "footer",
			diffOpens: "git",
		});
		expect(reloaded.turnSummaryFields).toEqual({
			time: true,
			files: false,
			tools: true,
			cost: true,
			model: false,
			clock: true,
		});
		expect(SettingsManager.create(cwd, agentDir).getMaxProseWidth()).toBe(80);
	});
});

describe("turn summary fields", () => {
	const all: TurnSummaryFields = { ...SETTINGS_DEFAULTS.display.turnSummaryFields };

	it("default fields render as before", () => {
		expect(strip(formatTurnSummaryLine(turn, 120))).toBe(
			"✓ 41s - 3 files +27 −8 - 9 tools - $0.0031 - glm-5-3-flash - low",
		);
		expect(strip(formatTurnSummaryLine(turn, 120, all))).toBe(strip(formatTurnSummaryLine(turn, 120)));
	});

	it("each field turns its part off", () => {
		expect(strip(formatTurnSummaryLine(turn, 120, { ...all, time: false }))).toBe(
			"✓ 3 files +27 −8 - 9 tools - $0.0031 - glm-5-3-flash - low",
		);
		expect(strip(formatTurnSummaryLine(turn, 120, { ...all, files: false }))).toBe(
			"✓ 41s - 9 tools - $0.0031 - glm-5-3-flash - low",
		);
		expect(strip(formatTurnSummaryLine(turn, 120, { ...all, tools: false }))).toBe(
			"✓ 41s - 3 files +27 −8 - $0.0031 - glm-5-3-flash - low",
		);
		expect(strip(formatTurnSummaryLine(turn, 120, { ...all, cost: false }))).toBe(
			"✓ 41s - 3 files +27 −8 - 9 tools - glm-5-3-flash - low",
		);
		expect(strip(formatTurnSummaryLine(turn, 120, { ...all, model: false }))).toBe(
			"✓ 41s - 3 files +27 −8 - 9 tools - $0.0031",
		);
		expect(strip(formatTurnSummaryLine(turn, 120, { ...all, clock: true }))).toBe(
			"✓ 14:32 - 41s - 3 files +27 −8 - 9 tools - $0.0031 - glm-5-3-flash - low",
		);
		const none = { time: false, files: false, tools: false, cost: false, model: false, clock: false };
		expect(strip(formatTurnSummaryLine(turn, 120, none))).toBe("✓");
	});

	it("the transcript line reads the fields at render time", () => {
		let fields = { ...all };
		const component = new TurnSummaryComponent(turn, 1, undefined, () => fields);
		expect(plain(component.render(100))[1]).toContain("$0.0031");
		fields = { ...all, cost: false };
		expect(plain(component.render(100))[1]).not.toContain("$0.0031");
	});

	it("summarizes the fields for the settings row", () => {
		expect(turnSummaryFieldsSummary(all)).toBe("time, files, tools, cost, model");
		expect(
			turnSummaryFieldsSummary({ time: false, files: false, tools: false, cost: false, model: false, clock: false }),
		).toBe("none");
	});
});

describe("turn summary in the footer", () => {
	function footer(items?: string[]) {
		const { session, footerData } = footerStandIns({ name: "manual" });
		return new FooterComponent(session, footerData, items);
	}

	it("reply mode leaves the footer as it was", () => {
		const plainFooter = footer();
		const before = plainFooter.render(100);
		plainFooter.setLastTurn(turn);
		expect(plainFooter.render(100)).toEqual(before);
	});

	it("footer mode adds the last turn as a row flush left, with its fields", () => {
		const f = footer();
		const before = plain(f.render(100));
		f.setTurnSummary("footer", SETTINGS_DEFAULTS.display.turnSummaryFields);
		expect(plain(f.render(100))).toEqual(before);
		f.setLastTurn(turn);
		const after = plain(f.render(100));
		expect(after).toHaveLength(before.length + 1);
		expect(after.at(-1)).toBe("✓ 41s - 3 files +27 −8 - 9 tools - $0.0031 - glm-5-3-flash - low");
		f.setTurnSummary("footer", { ...SETTINGS_DEFAULTS.display.turnSummaryFields, files: false, model: false });
		expect(plain(f.render(100)).at(-1)).toBe("✓ 41s - 9 tools - $0.0031");
		f.setTurnSummary("off", SETTINGS_DEFAULTS.display.turnSummaryFields);
		expect(plain(f.render(100))).toEqual(before);
		for (const line of f.render(60)) expect(strip(line).length).toBeLessThanOrEqual(60);
	});

	it("a footer layout can place the turn item itself", () => {
		expect(FOOTER_ITEM_IDS).toContain("turn");
		const f = footer(["cwd", "break", "turn"]);
		expect(plain(f.render(100))).toHaveLength(1);
		f.setLastTurn(turn);
		f.setTurnSummary("footer", SETTINGS_DEFAULTS.display.turnSummaryFields);
		const lines = plain(f.render(100));
		expect(lines).toHaveLength(2);
		expect(lines[1]).toMatch(/^✓ 41s - 3 files/);
	});
});

describe("/diff target", () => {
	it("follows display.diffOpens unless /diff names one", () => {
		expect(resolveDiffTarget("", "review")).toBe("review");
		expect(resolveDiffTarget("", "git")).toBe("git");
		expect(resolveDiffTarget("git", "review")).toBe("git");
		expect(resolveDiffTarget(" Review ", "git")).toBe("review");
		expect(resolveDiffTarget("whatever", "git")).toBe("git");
	});
});

describe("review key", () => {
	it("rebinds app.changes.review in keybindings.json and keeps other entries", () => {
		const dir = mkdtempSync(join(tmpdir(), "rk-keys-"));
		const keys = KeybindingsManager.create(dir);
		expect(keys.getKeys("app.changes.review")).toEqual(["alt+c"]);
		keys.setUserBinding("app.tools.select", "alt+o");
		keys.setUserBinding("app.changes.review", "alt+g");
		expect(keys.getKeys("app.changes.review")).toEqual(["alt+g"]);
		const saved = JSON.parse(readFileSync(join(dir, "keybindings.json"), "utf-8"));
		expect(saved).toEqual({ "app.tools.select": "alt+o", "app.changes.review": "alt+g" });
		expect(KeybindingsManager.create(dir).getKeys("app.changes.review")).toEqual(["alt+g"]);
		keys.setUserBinding("app.changes.review", []);
		expect(keys.getKeys("app.changes.review")).toEqual([]);
		keys.setUserBinding("app.changes.review", undefined);
		expect(keys.getKeys("app.changes.review")).toEqual(["alt+c"]);
		expect(JSON.parse(readFileSync(join(dir, "keybindings.json"), "utf-8"))).toEqual({
			"app.tools.select": "alt+o",
		});
	});

	it("knows which keys other actions use", () => {
		const keys = KeybindingsManager.create(mkdtempSync(join(tmpdir(), "rk-keys-")));
		expect(keys.actionsUsingKey("alt+c", "app.changes.review")).toEqual([]);
		expect(keys.actionsUsingKey("alt+c")).toEqual(["app.changes.review"]);
		expect(keys.actionsUsingKey("ctrl+t", "app.changes.review").length).toBeGreaterThan(0);
	});
});

describe("/settings sections", () => {
	const display = () => SettingsManager.inMemory().getDisplaySettings();

	it("draws section titles flush left with a blank row above, and never selects one", () => {
		const selector = new SettingsSelectorComponent(selectorConfig(display()), recordingCallbacks([]));
		const lines = plain(selector.render(100));
		const first = lines.findIndex((line) => line === "Model");
		expect(first).toBeGreaterThan(0);
		expect(lines[first + 1]).toMatch(/^→ Auto-compact\s+on$/);
		// Up from the first row wraps to the last row, not to a title.
		selector.getSettingsList().handleInput(UP);
		expect(plain(selector.render(100)).some((line) => line.startsWith("→ ") && line.length > 2)).toBe(true);
		const all = selectRow(selector, "Show summary");
		const title = all.indexOf("Turn summary");
		expect(title).toBeGreaterThan(0);
		expect(all[title - 1]).toBe("");
		for (const line of selector.render(100)) expect(BANNED.test(strip(line))).toBe(false);
	});

	it("groups the new rows under Turn summary, Changes, Footer and Display, with today's defaults", () => {
		const selector = new SettingsSelectorComponent(selectorConfig(display()), recordingCallbacks([]));
		const rows: string[] = [];
		const list = selector.getSettingsList();
		for (let i = 0; i < 60; i++) {
			const current = plain(selector.render(120)).find((line) => line.startsWith("→ "));
			if (current && !rows.includes(current)) rows.push(current);
			list.handleInput(DOWN);
		}
		const row = (label: string) => rows.find((line) => line.startsWith(`→ ${label} `))?.replace(/\s+/g, " ");
		expect(row("Show summary")).toBe("→ Show summary reply");
		expect(row("Fields")).toBe("→ Fields time, files, tools, cost, model");
		expect(row("Changes tray")).toBe("→ Changes tray on");
		expect(row("Tray position")).toBe("→ Tray position above editor");
		expect(row("/diff opens")).toBe("→ /diff opens review");
		expect(row("Review key")).toBe("→ Review key alt+c");
		expect(row("Footer layout")).toBe("→ Footer layout default");
		expect(row("Tool output")).toBe("→ Tool output collapsed");
		expect(row("Prose width")).toBe("→ Prose width 100");
	});

	it("each new row reports its change", () => {
		const calls: Array<[string, unknown, unknown?]> = [];
		const selector = new SettingsSelectorComponent(selectorConfig(display()), recordingCallbacks(calls));
		const list = selector.getSettingsList();
		const change = (label: string) => {
			selectRow(selector, label);
			list.handleInput("\r");
		};
		change("Show summary");
		change("Tool output");
		change("Tray position");
		change("/diff opens");
		change("Prose width");
		change("Footer layout");
		expect(calls).toEqual([
			["onDisplaySettingChange", "turnSummary", "footer"],
			["onDisplaySettingChange", "toolOutput", "expanded"],
			["onDisplaySettingChange", "changesTrayPosition", "footer"],
			["onDisplaySettingChange", "diffOpens", "git"],
			["onMaxProseWidthChange", 120, undefined],
			["onOpenFooterLayout", undefined, undefined],
		]);
	});

	it("turn summary fields open a list of on/off rows", () => {
		const calls: Array<[string, unknown, unknown?]> = [];
		const selector = new SettingsSelectorComponent(selectorConfig(display()), recordingCallbacks(calls));
		selectRow(selector, "Fields");
		const list = selector.getSettingsList();
		list.handleInput("\r");
		const sub = plain(selector.render(100));
		expect(sub[1]).toBe("Turn summary fields");
		expect(sub.some((line) => /^→ Time taken\s+on$/.test(line))).toBe(true);
		expect(sub.some((line) => /^ {2}Clock\s+off$/.test(line))).toBe(true);
		list.handleInput(DOWN);
		list.handleInput(DOWN);
		list.handleInput(DOWN);
		list.handleInput("\r");
		expect(calls).toEqual([
			[
				"onDisplaySettingChange",
				"turnSummaryFields",
				{ time: true, files: true, tools: true, cost: false, model: true, clock: false },
			],
		]);
		list.handleInput("\x1b");
		expect(plain(selector.render(120)).some((line) => /^→ Fields\s+time, files, tools, model$/.test(line))).toBe(
			true,
		);
	});

	it("the review key picker lists free keys with no notes and saves the pick", () => {
		const calls: Array<[string, unknown, unknown?]> = [];
		const selector = new SettingsSelectorComponent(selectorConfig(display()), recordingCallbacks(calls));
		selectRow(selector, "Review key");
		const list = selector.getSettingsList();
		list.handleInput("\r");
		const picker = plain(selector.render(80)).filter((line) => line.trim());
		expect(picker).toEqual([
			"─".repeat(80),
			"Review key",
			"→ ✓ alt+c",
			"    alt+g",
			"    none",
			"  Enter to select - Esc to go back",
			"─".repeat(80),
		]);
		list.handleInput(DOWN);
		list.handleInput("\r");
		expect(calls).toEqual([["onReviewKeyChange", "alt+g", undefined]]);
	});

	it("search finds rows across sections and leaves the titles out", () => {
		const selector = new SettingsSelectorComponent(selectorConfig(display()), recordingCallbacks([]));
		for (const ch of "tray") selector.getSettingsList().handleInput(ch);
		const lines = plain(selector.render(100));
		expect(lines).not.toContain("Changes");
		expect(lines.some((line) => /^→ (Changes tray|Tray position)/.test(line))).toBe(true);
	});
});
