import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setKeybindings, visibleWidth } from "@runkiln/tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../../src/core/keybindings.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { AssistantMessageComponent } from "../../src/modes/interactive/components/assistant-message.ts";
import {
	FOOTER_ELEMENT_IDS,
	FOOTER_ELEMENTS,
	FooterComponent,
	type FooterElementId,
	type FooterShow,
	footerShowForPreset,
	normalizeFooterShow,
	resolveFooterShow,
} from "../../src/modes/interactive/components/footer.ts";
import {
	footerPresetOf,
	isOn,
	onOff,
	type SettingsCallbacks,
	type SettingsConfig,
	SettingsSelectorComponent,
} from "../../src/modes/interactive/components/settings-selector.ts";
import {
	formatMessageTimestamp,
	resetTranscriptDisplay,
	setTranscriptDisplay,
	timestampRow,
} from "../../src/modes/interactive/components/transcript-display.ts";
import { UserMessageComponent } from "../../src/modes/interactive/components/user-message.ts";
import {
	FOOTER_SCENARIOS,
	FOOTER_WIDTHS,
	type FooterScenario,
	footerStandIns,
	useTruecolorTheme,
} from "./footer-fixtures.ts";

const strip = (text: string) => text.replace(/\x1b\[[0-9;:]*[A-Za-z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");
const plain = (lines: string[]) => lines.map((line) => strip(line));
const BANNED = /[·•—]/;
const DOWN = "\x1b[B";

const EVERYTHING: FooterScenario = {
	name: "all",
	permissionMode: "allow-all",
	autoRouting: true,
	providers: 3,
	sessionName: "big refactor",
	statuses: { lint: "lint clean" },
};

const LAST_TURN = {
	status: "done" as const,
	durationMs: 41_000,
	files: { count: 3, added: 27, removed: 8 },
	tools: 9,
	toolErrors: 0,
	cost: 0.0031,
	route: { model: "glm-5-3-flash", thinking: "low", mode: "auto:medium" },
};

function footerFor(
	scenario: FooterScenario,
	show: unknown,
	options: { items?: string[]; extra?: Record<string, unknown> } = {},
): FooterComponent {
	const { session, footerData } = footerStandIns(scenario, {
		verify: { marker: "✓ tests", status: { state: "pass" } },
		todoItems: [{ status: "completed" }, { status: "pending" }],
		...options.extra,
	});
	const footer = new FooterComponent(session, footerData, options.items);
	footer.setShow(show);
	footer.now = () => new Date(2026, 9, 17, 9, 5);
	footer.queueCount = () => 2;
	footer.setLastTurn(LAST_TURN);
	if (scenario.autoCompact === false) footer.setAutoCompactEnabled(false);
	return footer;
}

/** Text that shows an element in the EVERYTHING scenario at 220 columns. */
const MARKERS: Record<FooterElementId, string> = {
	cwd: "~/code/RunKiln",
	branch: "(main)",
	session: "big refactor",
	permissions: "allow all",
	cost: "$0.0024",
	cache: "% cached",
	context: "%/1.0M",
	autoCompact: "(auto)",
	tests: "✓ tests",
	xp: "xp",
	todo: "todo 1/2",
	queue: "2 queued",
	time: "09:05",
	provider: "(runinfra)",
	router: "auto:medium",
	model: "deepseek-v4-1-flash",
	thinking: "high",
	decision: "algo",
	confidence: "d0.75",
	turn: "41s",
	statuses: "lint clean",
};

beforeAll(() => {
	useTruecolorTheme();
	setKeybindings(KeybindingsManager.create(mkdtempSync(join(tmpdir(), "rk-keys-"))));
});

afterEach(() => {
	vi.unstubAllEnvs();
	resetTranscriptDisplay();
});

describe("footer.show", () => {
	it("unset, empty, explicit defaults and the Default preset all render the golden footer", () => {
		vi.stubEnv("HOME", "/home/john");
		vi.stubEnv("RUNKILN_EXPERIMENTAL", "");
		const golden = JSON.parse(readFileSync(join(import.meta.dirname, "footer-default-golden.json"), "utf8"));
		const explicit: Partial<FooterShow> = { ...resolveFooterShow({}) };
		delete explicit.turn;
		for (const show of [undefined, {}, footerShowForPreset("default"), explicit]) {
			for (const scenario of FOOTER_SCENARIOS) {
				for (const width of FOOTER_WIDTHS) {
					const { session, footerData } = footerStandIns(scenario);
					const footer = new FooterComponent(session, footerData);
					footer.setShow(show);
					if (scenario.autoCompact === false) footer.setAutoCompactEnabled(false);
					expect(footer.render(width), `${scenario.name}@${width}`).toEqual(golden[`${scenario.name}@${width}`]);
				}
			}
		}
	});

	it("each element turns on and off on its own", () => {
		vi.stubEnv("HOME", "/home/john");
		vi.stubEnv("RUNKILN_EXPERIMENTAL", "1");
		const all = footerShowForPreset("all")!;
		const full = plain(footerFor(EVERYTHING, all).render(220)).join("\n");
		for (const id of FOOTER_ELEMENT_IDS) {
			expect(full, `${id} with All`).toContain(MARKERS[id]);
			const without = plain(footerFor(EVERYTHING, { ...all, [id]: false }).render(220)).join("\n");
			// Strip what the other elements print so a marker that is a substring of another one is not counted.
			const count = (text: string) => text.split(MARKERS[id]).length - 1;
			expect(count(without), `${id} off`).toBeLessThan(count(full));
		}
	});

	it("defaults: todo, queue, clock and the last turn row are off; the turn row follows Turn summary: footer", () => {
		vi.stubEnv("HOME", "/home/john");
		const text = plain(footerFor(EVERYTHING, {}).render(220)).join("\n");
		for (const id of ["todo", "queue", "time", "turn"] as const) {
			expect(FOOTER_ELEMENTS[id].defaultOn).toBe(false);
			expect(text).not.toContain(MARKERS[id]);
		}
		const footer = footerFor(EVERYTHING, {});
		footer.setTurnSummary("footer", { time: true, files: true, tools: true, cost: true, model: true, clock: false });
		expect(plain(footer.render(220)).join("\n")).toContain("41s");
		footer.setShow({ turn: false });
		expect(plain(footer.render(220)).join("\n")).not.toContain("41s");
		expect(resolveFooterShow({}, "footer").turn).toBe(true);
		expect(resolveFooterShow({}, "reply").turn).toBe(false);
	});

	it("None draws no footer at all", () => {
		vi.stubEnv("HOME", "/home/john");
		expect(footerFor(EVERYTHING, footerShowForPreset("none")).render(100)).toEqual([]);
	});

	it("a row whose items are all off disappears; spacing stays flush to both edges", () => {
		vi.stubEnv("HOME", "/home/john");
		const none = footerShowForPreset("none")!;
		for (const width of [80, 100]) {
			// Model and cost only: one row, cost at column 0, model ending at the last column.
			const lines = plain(footerFor({ name: "m" }, { ...none, model: true, cost: true }).render(width));
			expect(lines).toHaveLength(1);
			expect(lines[0]!.startsWith("$0.0024")).toBe(true);
			expect(lines[0]!.endsWith("deepseek-v4-1-flash")).toBe(true);
			expect(visibleWidth(lines[0]!)).toBe(width);
			// The badge alone ends at the last column.
			const badge = plain(footerFor({ name: "b" }, { ...none, permissions: true }).render(width));
			expect(badge).toHaveLength(1);
			expect(badge[0]!.endsWith("▸ read & write")).toBe(true);
			expect(visibleWidth(badge[0]!)).toBe(width);
			// The route alone sits at the right edge.
			const route = plain(footerFor({ name: "r" }, { ...none, model: true, thinking: true }).render(width));
			expect(route).toEqual([
				`${" ".repeat(width - "deepseek-v4-1-flash - high".length)}deepseek-v4-1-flash - high`,
			]);
		}
	});

	it("splits the cost meter and the route reason into their parts", () => {
		vi.stubEnv("HOME", "/home/john");
		const auto: FooterScenario = { name: "a", autoRouting: true };
		const text = (show: Partial<FooterShow>) => plain(footerFor(auto, show).render(160)).join("\n");
		expect(text({ cache: false })).not.toContain("cached");
		expect(text({ cache: false })).toContain("$0.0024 - 4.3%");
		expect(text({ cost: false })).toContain("84% cached - 4.3%");
		expect(text({ confidence: false })).toContain("high - algo ↑1 follow-up");
		expect(text({ decision: false })).toMatch(/high - d0\.75$/m);
		expect(text({ router: false })).toContain("deepseek-v4-1-flash - high - algo d0.75");
		expect(text({ model: false })).toContain("auto:medium - high - algo");
		expect(text({ autoCompact: false })).toContain("4.3%/1.0M -");
		expect(text({ cwd: false })).toMatch(/^\(main\)/);
	});

	it("with footer.items, only an explicit false hides an item (old layouts render as before)", () => {
		vi.stubEnv("HOME", "/home/john");
		const items = ["model", "time", "cost", "context", "permissions"];
		const before = footerFor({ name: "c" }, undefined, { items }).render(100);
		expect(plain(before).join("")).toContain("09:05");
		expect(footerFor({ name: "c" }, {}, { items }).render(100)).toEqual(before);
		expect(footerFor({ name: "c" }, footerShowForPreset("default"), { items }).render(100)).toEqual(before);
		const hidden = plain(footerFor({ name: "c" }, { time: false, autoCompact: false }, { items }).render(100));
		expect(hidden.join("")).not.toContain("09:05");
		expect(hidden.join("")).not.toContain("(auto)");
		expect(plain(footerFor({ name: "c" }, { queue: true }, { items: ["queue"] }).render(40))).toEqual(["2 queued"]);
	});

	it("normalizes the setting and the presets", () => {
		expect(normalizeFooterShow({ cwd: false, nope: true, model: "yes", time: true })).toEqual({
			cwd: false,
			time: true,
		});
		expect(normalizeFooterShow(["cwd"])).toEqual({});
		expect(normalizeFooterShow(null)).toEqual({});
		expect(Object.values(footerShowForPreset("all")!).every(Boolean)).toBe(true);
		expect(Object.values(footerShowForPreset("none")!).some(Boolean)).toBe(false);
		expect(footerShowForPreset("default")).toBeUndefined();
		expect(footerPresetOf({}, "default", true)).toBe("default");
		expect(footerPresetOf({}, "custom", true)).toBe("custom");
		expect(footerPresetOf(footerShowForPreset("all")!, "default", true)).toBe("all");
		expect(footerPresetOf(footerShowForPreset("none")!, "default", false)).toBe("none");
		expect(footerPresetOf({ cwd: false }, "default", true)).toBe("custom");
	});

	it("persists footer.show next to footer.items", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "rk-agent-"));
		const cwd = mkdtempSync(join(tmpdir(), "rk-cwd-"));
		const settings = SettingsManager.create(cwd, agentDir);
		settings.setFooterItems(["model", "break", "cost"]);
		settings.setFooterShow({ cwd: false, time: true });
		await settings.flush();
		const saved = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8"));
		expect(saved.footer).toEqual({ items: ["model", "break", "cost"], show: { cwd: false, time: true } });
		const reloaded = SettingsManager.create(cwd, agentDir);
		expect(reloaded.getFooterShow()).toEqual({ cwd: false, time: true });
		expect(reloaded.getFooterItems()).toEqual(["model", "break", "cost"]);
		reloaded.setFooterShow(undefined);
		await reloaded.flush();
		expect(SettingsManager.create(cwd, agentDir).getFooterShow()).toEqual({});
		expect(SettingsManager.inMemory({ footer: { show: { cwd: "no" as never } } }).getFooterShow()).toEqual({});
	});
});

function selectorConfig(extra: Partial<SettingsConfig> = {}): SettingsConfig {
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
		display: SettingsManager.inMemory().getDisplaySettings(),
		footerLayout: "default",
		footerShow: {},
		showCacheMissNotices: false,
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

/** Every row of the list as `label value`, walking the cursor through it. */
function allRows(selector: SettingsSelectorComponent): Map<string, string> {
	const list = selector.getSettingsList();
	const rows = new Map<string, string>();
	for (let i = 0; i < 140; i++) {
		const current = plain(selector.render(120)).find((line) => line.startsWith("→ "));
		if (current) {
			const match = /^→ (.+?)\s{2,}(\S.*)$/.exec(current.trimEnd());
			if (match) rows.set(match[1]!, match[2]!);
		}
		list.handleInput(DOWN);
	}
	return rows;
}

function selectRow(selector: SettingsSelectorComponent, label: string): void {
	const list = selector.getSettingsList();
	for (let i = 0; i < 140; i++) {
		const lines = plain(selector.render(120)).map((line) => line.trimEnd());
		if (lines.some((line) => line.startsWith(`→ ${label}  `))) return;
		list.handleInput(DOWN);
	}
	throw new Error(`row not found: ${label}`);
}

describe("/settings > Footer", () => {
	it("lists a preset row and one on/off row per footer part, with today's defaults", () => {
		const selector = new SettingsSelectorComponent(selectorConfig(), recordingCallbacks([]));
		const rows = allRows(selector);
		expect(rows.get("Preset")).toBe("default");
		for (const id of FOOTER_ELEMENT_IDS) {
			expect(rows.get(FOOTER_ELEMENTS[id].label), id).toBe(FOOTER_ELEMENTS[id].defaultOn ? "on" : "off");
		}
		expect(rows.get("Key hints")).toBe("on");
		expect(rows.get("Timestamps")).toBe("off");
		for (const line of selector.render(120)) expect(BANNED.test(strip(line))).toBe(false);
	});

	it("a part row saves footer.show and moves the preset to custom", () => {
		const calls: Array<[string, unknown, unknown?]> = [];
		const selector = new SettingsSelectorComponent(selectorConfig(), recordingCallbacks(calls));
		selectRow(selector, "Directory");
		selector.getSettingsList().handleInput("\r");
		expect(calls).toEqual([["onFooterShowChange", { cwd: false }, undefined]]);
		expect(allRows(selector).get("Preset")).toBe("custom");
	});

	it("presets set every part and the key hints", () => {
		const calls: Array<[string, unknown, unknown?]> = [];
		const selector = new SettingsSelectorComponent(selectorConfig(), recordingCallbacks(calls));
		selectRow(selector, "Preset");
		selector.getSettingsList().handleInput("\r");
		let rows = allRows(selector);
		expect(rows.get("Preset")).toBe("all");
		for (const id of FOOTER_ELEMENT_IDS) expect(rows.get(FOOTER_ELEMENTS[id].label)).toBe("on");
		selectRow(selector, "Preset");
		selector.getSettingsList().handleInput("\r");
		rows = allRows(selector);
		expect(rows.get("Preset")).toBe("none");
		for (const id of FOOTER_ELEMENT_IDS) expect(rows.get(FOOTER_ELEMENTS[id].label)).toBe("off");
		expect(rows.get("Key hints")).toBe("off");
		selectRow(selector, "Preset");
		selector.getSettingsList().handleInput("\r");
		rows = allRows(selector);
		expect(rows.get("Preset")).toBe("default");
		expect(rows.get("Directory")).toBe("on");
		expect(rows.get("Clock")).toBe("off");
		expect(rows.get("Key hints")).toBe("on");
		expect(calls.map((call) => call[1])).toEqual(["all", "none", "default"]);
	});

	it("Default also resets a custom layout row", () => {
		const selector = new SettingsSelectorComponent(
			selectorConfig({ footerLayout: "custom", footerShow: { time: true } }),
			recordingCallbacks([]),
		);
		expect(allRows(selector).get("Preset")).toBe("custom");
		selectRow(selector, "Preset");
		selector.getSettingsList().handleInput("\r");
		selectRow(selector, "Preset");
		selector.getSettingsList().handleInput("\r");
		selectRow(selector, "Preset");
		selector.getSettingsList().handleInput("\r");
		expect(allRows(selector).get("Footer layout")).toBe("default");
	});
});

describe("display.timestamps", () => {
	const at = Date.UTC(2026, 9, 17, 12, 32); // 14:32 in Paris (summer time)

	it("formats time and date in the given zone, nothing when off", () => {
		expect(formatMessageTimestamp(at, "time", "Europe/Paris")).toBe("14:32");
		expect(formatMessageTimestamp(at, "datetime", "Europe/Paris")).toBe("2026-10-17 14:32");
		expect(formatMessageTimestamp(at, "time", "UTC")).toBe("12:32");
		expect(formatMessageTimestamp(at, "off", "Europe/Paris")).toBeUndefined();
	});

	it("draws a row ending at the last column, in the TZ zone", () => {
		vi.stubEnv("TZ", "Europe/Paris");
		expect(timestampRow(at, 20, (text) => text, "time")).toBe(`${" ".repeat(15)}14:32`);
		expect(timestampRow(at, 20, (text) => text, "datetime")).toBe("    2026-10-17 14:32");
		expect(timestampRow(at, 20, (text) => text, "off")).toBeUndefined();
		expect(timestampRow(undefined, 20, (text) => text, "time")).toBeUndefined();
	});

	it("adds a dim row under user messages and finished replies, none when off", () => {
		vi.stubEnv("TZ", "Europe/Paris");
		const user = new UserMessageComponent("hello");
		user.timestamp = at;
		const offLines = user.render(60);
		setTranscriptDisplay({ timestamps: "time" });
		const onLines = user.render(60);
		expect(onLines.length).toBe(offLines.length + 1);
		expect(strip(onLines.at(-1)!)).toBe(`${" ".repeat(55)}14:32`);

		const reply = {
			role: "assistant",
			content: [{ type: "text", text: "done" }],
			timestamp: at,
			durationMs: 60_000,
			stopReason: "stop",
		} as never;
		const assistant = new AssistantMessageComponent(reply);
		expect(strip(assistant.render(60).at(-1)!)).toBe(`${" ".repeat(55)}14:33`);
		setTranscriptDisplay({ timestamps: "datetime" });
		expect(strip(assistant.render(60).at(-1)!)).toBe(`${" ".repeat(44)}2026-10-17 14:33`);
		assistant.updateContent(reply, true);
		expect(assistant.render(60).some((line) => strip(line).includes("14:33"))).toBe(false);
		setTranscriptDisplay({ timestamps: "off" });
		assistant.updateContent(reply, false);
		expect(assistant.render(60).some((line) => strip(line).includes("14:33"))).toBe(false);
	});

	it("persists and falls back to off for unknown values", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "rk-agent-"));
		const cwd = mkdtempSync(join(tmpdir(), "rk-cwd-"));
		const settings = SettingsManager.create(cwd, agentDir);
		expect(settings.getDisplaySettings().timestamps).toBe("off");
		settings.setDisplaySetting("timestamps", "datetime");
		await settings.flush();
		expect(SettingsManager.create(cwd, agentDir).getDisplaySettings().timestamps).toBe("datetime");
		expect(
			SettingsManager.inMemory({ display: { timestamps: "always" as never } }).getDisplaySettings().timestamps,
		).toBe("off");
	});

	it("the settings row reports its change", () => {
		const calls: Array<[string, unknown, unknown?]> = [];
		const selector = new SettingsSelectorComponent(selectorConfig(), recordingCallbacks(calls));
		selectRow(selector, "Timestamps");
		selector.getSettingsList().handleInput("\r");
		expect(calls).toEqual([["onDisplaySettingChange", "timestamps", "time"]]);
	});
});

describe("/settings boolean rows", () => {
	it("display on/off, never true/false", () => {
		const selector = new SettingsSelectorComponent(selectorConfig(), recordingCallbacks([]));
		const rows = allRows(selector);
		expect(rows.size).toBeGreaterThan(20);
		for (const [label, value] of rows) expect(value, label).not.toMatch(/^(true|false)$/);
		expect(rows.get("Auto-compact")).toMatch(/^(on|off)$/);
	});

	it("toggling a boolean row still saves a boolean", () => {
		const calls: Array<[string, unknown, unknown?]> = [];
		const selector = new SettingsSelectorComponent(selectorConfig(), recordingCallbacks(calls));
		selectRow(selector, "Auto-compact");
		const before = allRows(selector).get("Auto-compact");
		selectRow(selector, "Auto-compact");
		selector.getSettingsList().handleInput("\r");
		const call = calls.find(([name]) => name === "onAutoCompactChange");
		expect(call?.[1]).toBe(before !== "on");
	});

	it("accepts on/off and the old true/false strings", () => {
		expect(isOn("on")).toBe(true);
		expect(isOn("ON")).toBe(true);
		expect(isOn("true")).toBe(true);
		expect(isOn("off")).toBe(false);
		expect(isOn("false")).toBe(false);
		expect(onOff(true)).toBe("on");
		expect(onOff(false)).toBe("off");
	});
});
