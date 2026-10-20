import { join } from "node:path";
import { isReducedMotion, Loader, Markdown, setReducedMotion, type TUI, visibleWidth } from "@runkiln/tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getThemesDir } from "../../src/config.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { FooterComponent } from "../../src/modes/interactive/components/footer.ts";
import {
	BUILTIN_THEME_NAMES,
	getAvailableThemes,
	getMarkdownTheme,
	isNoColorEnv,
	loadThemeFromPath,
	setThemeInstance,
} from "../../src/modes/interactive/theme/theme.ts";
import { footerStandIns, useTruecolorTheme } from "./footer-fixtures.ts";

const ESC_COLOR = /\x1b\[(?:3[0-9]|4[0-9]|9[0-7]|10[0-7])[;m]/;
const strip = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, "");

function hue(color: {
	kind: string;
	r?: number;
	g?: number;
	b?: number;
}): "blue" | "orange" | "green" | "red" | "other" {
	if (color.kind !== "rgb") return "other";
	const { r = 0, g = 0, b = 0 } = color;
	if (b > r && b > g * 0.9) return "blue";
	if (r > b && g > b && r >= g) return r - g > 90 ? "red" : "orange";
	if (g > r && g > b) return "green";
	return "other";
}

afterEach(() => {
	setReducedMotion(false);
	useTruecolorTheme();
});

describe("built-in accessible themes", () => {
	it("ships colour-blind and high-contrast themes next to dark and light", () => {
		expect(BUILTIN_THEME_NAMES).toEqual(["dark", "light", "dark-colorblind", "light-colorblind", "high-contrast"]);
		const available = getAvailableThemes();
		for (const name of BUILTIN_THEME_NAMES) expect(available).toContain(name);
	});

	it("draws colour-blind diffs in blue and orange instead of green and red", () => {
		for (const name of ["dark-colorblind", "light-colorblind", "high-contrast"]) {
			const t = loadThemeFromPath(join(getThemesDir(), `${name}.json`), "truecolor");
			expect(hue(t.colors.toolDiffAdded as never), name).toBe("blue");
			expect(hue(t.colors.toolDiffRemoved as never), name).toBe("orange");
			expect(hue(t.colors.success as never), name).toBe("blue");
		}
		const dark = loadThemeFromPath(join(getThemesDir(), "dark.json"), "truecolor");
		expect(dark.fg("toolDiffAdded", "+")).not.toBe(
			loadThemeFromPath(join(getThemesDir(), "dark-colorblind.json"), "truecolor").fg("toolDiffAdded", "+"),
		);
	});

	it("keeps high-contrast text near white", () => {
		const t = loadThemeFromPath(join(getThemesDir(), "high-contrast.json"), "truecolor");
		for (const token of ["text", "muted", "dim", "toolOutput"] as const) {
			const color = t.colors[token] as { kind: string; r: number; g: number; b: number };
			expect(Math.min(color.r, color.g, color.b), token).toBeGreaterThanOrEqual(0xbd);
		}
	});
});

describe("NO_COLOR", () => {
	it("is on when set and non-empty", () => {
		expect(isNoColorEnv({ NO_COLOR: "1" })).toBe(true);
		expect(isNoColorEnv({ NO_COLOR: "" })).toBe(false);
		expect(isNoColorEnv({})).toBe(false);
	});

	it("drops every color escape from the theme but keeps the text and attributes", () => {
		vi.stubEnv("NO_COLOR", "1");
		vi.stubEnv("HOME", "/home/john");
		const t = loadThemeFromPath(join(getThemesDir(), "dark.json"), "truecolor");
		expect(t.noColor).toBe(true);
		expect(t.fg("accent", "hi")).toBe("hi");
		expect(t.bg("userMessageBg", "hi")).toBe("hi");
		expect(t.getFgAnsi("accent")).toBe("");
		expect(t.style("x", { fg: "error", bold: true })).toBe("\x1b[1mx\x1b[22m");
		setThemeInstance(t);
		const { session, footerData } = footerStandIns({ name: "x", permissionMode: "allow-all", budget: "over" });
		const lines = new FooterComponent(session, footerData).render(100);
		for (const line of lines) expect(line).not.toMatch(ESC_COLOR);
		expect(strip(lines[0]!)).toMatch(/▸▸ allow all$/);
	});
});

describe("reduced motion", () => {
	function fakeTui(): TUI {
		return { requestRender: () => {} } as unknown as TUI;
	}

	it("shows a static indicator and never starts a timer", () => {
		vi.useFakeTimers();
		try {
			setReducedMotion(true);
			expect(isReducedMotion()).toBe(true);
			const loader = new Loader(
				fakeTui(),
				(s) => s,
				(s) => s,
				"Working...",
			);
			const first = loader.render(40).map(strip);
			vi.advanceTimersByTime(1000);
			expect(loader.render(40).map(strip)).toEqual(first);
			expect(first[1]).toMatch(/^ ● Working\.\.\./);
			expect(vi.getTimerCount()).toBe(0);
			loader.stop();
		} finally {
			vi.useRealTimers();
		}
	});

	it("settles a running spinner when turned on mid-animation", () => {
		vi.useFakeTimers();
		try {
			const loader = new Loader(
				fakeTui(),
				(s) => s,
				(s) => s,
				"Working...",
			);
			vi.advanceTimersByTime(160);
			expect(strip(loader.render(40)[1]!)).not.toContain("●");
			setReducedMotion(true);
			vi.advanceTimersByTime(80);
			expect(strip(loader.render(40)[1]!)).toMatch(/^ ● Working/);
			expect(vi.getTimerCount()).toBe(0);
			loader.stop();
		} finally {
			vi.useRealTimers();
		}
	});

	it("keeps an extension's custom first frame, unanimated", () => {
		setReducedMotion(true);
		const loader = new Loader(
			fakeTui(),
			(s) => s,
			(s) => s,
			"Busy",
			{ frames: ["◐", "◓", "◑", "◒"], intervalMs: 50 },
		);
		expect(strip(loader.render(40)[1]!)).toMatch(/^ ◐ Busy/);
		loader.stop();
	});
});

describe("prose width cap", () => {
	const prose = "word ".repeat(60).trim();
	const code = `const value = ${"x + ".repeat(30)}1;`;

	it("wraps assistant prose at maxProseWidth and keeps code blocks at the full width", () => {
		useTruecolorTheme();
		const md = new Markdown(`${prose}\n\n\`\`\`\n${code}\n\`\`\``, 1, 0, {
			...getMarkdownTheme(),
			maxProseWidth: 60,
		});
		const lines = md.render(160).map((line) => strip(line).trimEnd());
		const proseLines = lines.filter((line) => line.includes("word"));
		expect(proseLines.length).toBeGreaterThan(1);
		for (const line of proseLines) expect(visibleWidth(line)).toBeLessThanOrEqual(61);
		const codeLine = lines.find((line) => line.includes("const value"));
		expect(codeLine && visibleWidth(codeLine)).toBeGreaterThan(100);
	});

	it("changes nothing on terminals narrower than the cap", () => {
		useTruecolorTheme();
		const text = `${prose}\n\n- ${prose}\n\n> ${prose}`;
		const capped = new Markdown(text, 1, 0, { ...getMarkdownTheme(), maxProseWidth: 100 }).render(80);
		const plain = new Markdown(text, 1, 0, getMarkdownTheme()).render(80);
		expect(capped).toEqual(plain);
	});

	it("reads ui.maxProseWidth with a default of 100 and 0 for off", () => {
		expect(SettingsManager.inMemory({}).getMaxProseWidth()).toBe(100);
		expect(SettingsManager.inMemory({ ui: { maxProseWidth: 0 } }).getMaxProseWidth()).toBe(0);
		expect(SettingsManager.inMemory({ ui: { maxProseWidth: 5 } }).getMaxProseWidth()).toBe(20);
		expect(SettingsManager.inMemory({ ui: { reducedMotion: true } }).getReducedMotion()).toBe(true);
		expect(SettingsManager.inMemory({}).getDynamicTitle()).toBe(true);
		expect(SettingsManager.inMemory({ footer: { items: ["model", 3] as never } }).getFooterItems()).toEqual([
			"model",
		]);
	});
});
