import { beforeAll, describe, expect, it } from "vitest";
import {
	RK_BANNER_ART,
	RK_BANNER_NAME_COLUMN,
	rkBannerLines,
} from "../../src/modes/interactive/components/rk-banner.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";

const stripAnsi = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");

describe("RK startup banner", () => {
	beforeAll(() => initTheme("dark"));

	it("is 5 lines of plain text, at most 36 columns wide", () => {
		expect(RK_BANNER_ART).toHaveLength(5);
		for (const line of RK_BANNER_ART) {
			expect(line.length).toBeLessThanOrEqual(36);
			expect(line).not.toMatch(/\x1b/);
		}
	});

	it("puts the name where the version lines up", () => {
		expect(RK_BANNER_ART[2].indexOf("RunKiln")).toBe(RK_BANNER_NAME_COLUMN);
	});

	it("colors the art without changing it", () => {
		const lines = rkBannerLines();
		expect(lines.map(stripAnsi)).toEqual(RK_BANNER_ART.map((line) => line.trimEnd()));
		const withVersion = stripAnsi(rkBannerLines("0.1.0")[3]);
		expect(withVersion.indexOf("v0.1.0")).toBe(RK_BANNER_NAME_COLUMN);
	});
});
