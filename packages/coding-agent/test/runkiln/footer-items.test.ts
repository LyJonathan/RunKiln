import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setKeybindings, visibleWidth } from "@runkiln/tui";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../../src/core/keybindings.ts";
import {
	FooterComponent,
	type FooterItemEntry,
	normalizeFooterItems,
} from "../../src/modes/interactive/components/footer.ts";
import {
	DEFAULT_FOOTER_ITEMS,
	StatusLinePickerComponent,
} from "../../src/modes/interactive/components/statusline-picker.ts";
import { theme } from "../../src/modes/interactive/theme/theme.ts";
import { type FooterScenario, footerStandIns, renderFooterMatrix, useTruecolorTheme } from "./footer-fixtures.ts";

describe("default footer layout", () => {
	beforeAll(() => useTruecolorTheme());

	it("renders exactly the committed golden (UPDATE_FOOTER_GOLDEN=1 to regenerate)", () => {
		vi.stubEnv("HOME", "/home/john");
		vi.stubEnv("RUNKILN_EXPERIMENTAL", "");
		const goldenPath = join(import.meta.dirname, "footer-default-golden.json");
		const now = renderFooterMatrix();
		// UPDATE_FOOTER_GOLDEN=1 rewrites the golden after an intended change to the default footer.
		if (process.env.UPDATE_FOOTER_GOLDEN === "1") writeFileSync(goldenPath, `${JSON.stringify(now, null, "\t")}\n`);
		const golden = JSON.parse(readFileSync(goldenPath, "utf8"));
		expect(Object.keys(now)).toEqual(Object.keys(golden));
		for (const key of Object.keys(golden)) expect(now[key], key).toEqual(golden[key]);
	});
});

const strip = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, "");

function custom(items: string[], scenario: FooterScenario = { name: "x" }, extra: Record<string, unknown> = {}) {
	const { session, footerData } = footerStandIns(scenario, extra);
	const footer = new FooterComponent(session, footerData, items);
	footer.now = () => new Date(2026, 9, 17, 9, 5);
	return footer;
}

describe("configured footer (footer.items)", () => {
	beforeAll(() => useTruecolorTheme());

	it("normalizes the setting: known ids, no duplicates, no stray breaks", () => {
		expect(normalizeFooterItems(undefined)).toBeUndefined();
		expect(normalizeFooterItems("model")).toBeUndefined();
		expect(normalizeFooterItems(["break", "Model", "model", "nope", "break", "break", "cost", "break"])).toEqual([
			"model",
			"break",
			"cost",
		]);
		expect(normalizeFooterItems([])).toEqual([]);
	});

	it("draws the items in order, with the permission badge right-aligned when it ends the line", () => {
		vi.stubEnv("HOME", "/home/john");
		const lines = custom(["model", "thinking", "cost", "cache", "context", "time", "permissions"]).render(100);
		expect(lines).toHaveLength(1);
		const text = strip(lines[0]!);
		expect(text).toBe(
			`${"deepseek-v4-1-flash - high - $0.0024 - 84% cached - 4.3%/1.0M (auto) - 09:05".padEnd(86)}▸ read & write`,
		);
		expect(visibleWidth(lines[0]!)).toBe(100);
	});

	it("starts a new line at each break and keeps an inline badge where it is listed", () => {
		vi.stubEnv("HOME", "/home/john");
		const lines = custom(["permissions", "cwd", "branch", "break", "router", "model"], {
			name: "x",
			autoRouting: true,
		}).render(100);
		expect(lines.map(strip)).toEqual([
			"▸ read & write - ~/code/RunKiln - ⎇ main",
			"auto:medium - algo d0.75 ↑1 follow-up - deepseek-v4-1-flash",
		]);
	});

	it("drops the lowest-priority items first on narrow terminals and never squeezes the badge", () => {
		vi.stubEnv("HOME", "/home/john");
		const items = ["time", "cwd", "branch", "model", "thinking", "cost", "cache", "context", "permissions"];
		const at = (width: number) => custom(items).render(width).map(strip);
		expect(at(140)[0]).toContain("09:05 - ~/code/RunKiln - ⎇ main");
		const at60 = at(60);
		expect(at60[0]).toMatch(/▸ read & write$/);
		expect(at60[0]).not.toContain("09:05");
		expect(at60[0]).not.toContain("~/code");
		expect(at60[0]).toContain("deepseek-v4-1-flash");
		for (const width of [10, 16, 24, 30, 40, 60, 80]) {
			const lines = custom(items).render(width);
			for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			if (width >= 16) expect(strip(lines[0]!)).toContain("▸ read & write");
		}
		// Only the badge is left when nothing else fits.
		expect(at(16)[0]).toBe("▸ read & write");
	});

	it("shows tests and jobs statuses as items and leaves them off the extension line", () => {
		const scenario: FooterScenario = {
			name: "x",
			statuses: { jobs: "2 jobs (/jobs)", tests: "tests ✓ 412", lint: "lint clean" },
		};
		const lines = custom(["tests", "jobs", "context"], scenario).render(80).map(strip);
		expect(lines).toEqual(["tests ✓ 412 - 2 jobs (/jobs) - 4.3%/1.0M (auto)", "lint clean"]);
		// Without the items, they stay on the extension line as before.
		expect(custom(["context"], scenario).render(80).map(strip)[1]).toBe("2 jobs (/jobs) lint clean tests ✓ 412");
	});

	it("shows the verify loop's last run as the tests item and in the default layout", () => {
		const failing = { marker: "✗ 3 failing ↻1", status: { state: "fail", retries: 1, failing: 3 } };
		const setup = { marker: "⚠ test command", status: { state: "fail", retries: 0, setupError: "no tests" } };
		const scenario: FooterScenario = { name: "x", statuses: { tests: "ext tests", lint: "lint clean" } };
		// The loop's marker wins over an extension's "tests" status, which stays off the extension line.
		expect(custom(["tests", "context"], scenario, { verify: failing }).render(80).map(strip)).toEqual([
			"✗ 3 failing ↻1 - 4.3%/1.0M (auto)",
			"lint clean",
		]);
		const warning = custom(["tests"], { name: "x" }, { verify: setup }).render(80)[0]!;
		expect(strip(warning)).toBe("⚠ test command");
		expect(warning).toContain(theme.getFgAnsi("warning"));
		// No run yet: the extension status (or nothing).
		expect(
			custom(["tests"], scenario, { verify: { marker: undefined, status: { state: "idle" } } }).render(80)[0],
		).toBe("ext tests");
		// Default layout: the marker follows the context meter.
		const { session, footerData } = footerStandIns({ name: "x" }, { verify: failing });
		const line = strip(new FooterComponent(session, footerData).render(120)[1]!);
		expect(line).toMatch(/4\.3%\/1\.0M \(auto\) - ✗ 3 failing ↻1/);
	});

	it("shows todo progress and hides items with nothing to show", () => {
		const todoItems = [
			{ id: "1", text: "a", status: "completed" },
			{ id: "2", text: "b", status: "in_progress" },
			{ id: "3", text: "c", status: "pending" },
		];
		expect(custom(["todo", "router", "session"], { name: "x" }, { todoItems }).render(80).map(strip)).toEqual([
			"todo 1/3",
		]);
		expect(custom(["todo", "branch"], { name: "x", branch: null }).render(80)).toEqual([]);
	});

	it("opens /usage from a click on the cost item, wherever it is", () => {
		const footer = custom(["model", "break", "context", "cost"]);
		let clicks = 0;
		footer.onUsageClick = () => clicks++;
		const lines = footer.render(80).map(strip);
		expect(lines[1]).toBe("4.3%/1.0M (auto) - $0.0024");
		const click = (x: number, y: number) =>
			footer.handleMouse({
				type: "click",
				button: "left",
				x,
				y,
				screenX: x,
				screenY: 20 + y,
				width: 80,
				height: 2,
				shift: false,
				alt: false,
				ctrl: false,
			});
		expect(click(20, 1)).toMatchObject({ handled: true });
		expect(click(20, 0)).toBeUndefined();
		expect(click(2, 1)).toBeUndefined();
		expect(clicks).toBe(1);
	});

	it("colors the cost by budget and the context by fill level", () => {
		const over = custom(["cost", "context"], { name: "x", budget: "over", contextPercent: 95 }).render(80)[0]!;
		expect(strip(over)).toBe("$0.0024/$0.50 - 95.0%/1.0M (auto)");
		expect(over).toContain(theme.fg("error", "$0.0024/$0.50"));
		expect(over).toContain(theme.fg("error", "95.0%/1.0M (auto)"));
	});
});

describe("/statusline picker", () => {
	let keysDir: string;
	beforeAll(() => {
		useTruecolorTheme();
		keysDir = mkdtempSync(join(tmpdir(), "runkiln-keys-"));
		setKeybindings(KeybindingsManager.create(keysDir));
	});
	afterAll(() => rmSync(keysDir, { recursive: true, force: true }));

	function picker(items: string[] | undefined) {
		const saved: Array<FooterItemEntry[] | undefined> = [];
		let cancelled = 0;
		const { session, footerData } = footerStandIns({ name: "x" });
		const preview = new FooterComponent(session, footerData);
		const component = new StatusLinePickerComponent({
			items,
			preview: (value, width) => {
				preview.setItems(value);
				return preview.render(width);
			},
			onSave: (value) => saved.push(value),
			onCancel: () => cancelled++,
		});
		return { component, saved, cancelled: () => cancelled };
	}

	it("starts from the default layout and saves nothing custom until something changes", () => {
		vi.stubEnv("HOME", "/home/john");
		const { component, saved } = picker(undefined);
		const text = component.render(100).map(strip);
		expect(text[1]).toContain("Status line - default layout");
		expect(text.some((line) => line.includes("~/code/RunKiln (main)"))).toBe(true);
		component.handleInput("\x13"); // ctrl+s
		expect(saved).toEqual([undefined]);
	});

	it("toggles, reorders and saves footer.items, with a live preview", () => {
		vi.stubEnv("HOME", "/home/john");
		const { component, saved } = picker(["model", "permissions"]);
		// Rows: model, permissions, then the disabled items in registry order (router, thinking, ...).
		component.handleInput("\x1b[B"); // down: permissions
		component.handleInput("\x1b[B"); // down: router
		component.handleInput("\x1b[B"); // down: thinking
		component.handleInput(" "); // enable thinking
		component.handleInput("\x1b[1;3A"); // alt+up: thinking above router
		component.handleInput("\x1b[1;3A"); // alt+up: thinking above permissions
		expect(component.value).toEqual(["model", "thinking", "permissions"]);
		const text = component.render(80).map(strip);
		expect(text.some((line) => /^deepseek-v4-1-flash - high +▸ read & write$/.test(line))).toBe(true);
		expect(text[1]).toContain("(unsaved)");
		component.handleInput("\x13");
		expect(saved).toEqual([["model", "thinking", "permissions"]]);
	});

	it("goes back to the default layout with r and cancels with Esc", () => {
		const { component, saved, cancelled } = picker(["model"]);
		component.handleInput("r");
		expect(component.value).toBeUndefined();
		component.handleInput("\x1b");
		expect(cancelled()).toBe(1);
		expect(saved).toEqual([]);
		expect(DEFAULT_FOOTER_ITEMS).toContain("permissions");
	});

	it("fits every row in narrow terminals", () => {
		const { component } = picker(undefined);
		for (const width of [40, 60])
			for (const line of component.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
	});
});
