/**
 * The rows under (and the todo line above) the editor are flush with both terminal edges: they start at column 0
 * like the editor, and a right-aligned item ends exactly at the last column, never past it (a full-width line must
 * not wrap). Checked at 80 and 100 columns, and with WT_SESSION set (Windows Terminal).
 */

import { visibleWidth } from "@runkiln/tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { formatKeyHints, selectKeyHints } from "../../src/modes/interactive/components/key-hint-row.ts";
import { TodoPanelComponent } from "../../src/modes/interactive/components/todo-panel.ts";
import { FOOTER_SCENARIOS, scenarioFooter, useTruecolorTheme } from "./footer-fixtures.ts";

const strip = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b\]8;[^\x07]*\x07/g, "");

describe.each([
	["plain terminal", undefined],
	["Windows Terminal", "wt-session"],
])("footer edges (%s)", (_name, wtSession) => {
	beforeAll(() => useTruecolorTheme());
	afterEach(() => vi.unstubAllEnvs());

	for (const width of [80, 100]) {
		it(`starts every row at column 0 and ends right-aligned rows at column ${width}`, () => {
			vi.stubEnv("HOME", "/home/john");
			vi.stubEnv("WT_SESSION", wtSession ?? "");
			for (const scenario of FOOTER_SCENARIOS) {
				const lines = scenarioFooter(scenario).render(width);
				for (const [row, line] of lines.entries()) {
					const text = strip(line);
					const where = `${scenario.name} row ${row}: "${text}"`;
					expect(visibleWidth(line), where).toBeLessThanOrEqual(width);
					// A row starts at column 0, or is right-aligned only (the route on its own line); a row with a
					// right part (badge, model, route) ends exactly at the last column.
					const rightOnly = text.startsWith(" ");
					if (rightOnly || /\S {2,}\S/.test(text)) expect(visibleWidth(line), where).toBe(width);
					if (rightOnly) expect(text.trimStart().length, where).toBeGreaterThan(0);
				}
			}
		});

		it(`starts the key hint row at column 0 at ${width} columns`, () => {
			vi.stubEnv("WT_SESSION", wtSession ?? "");
			for (const mode of ["idle", "approval", "selection"] as const) {
				const line = formatKeyHints(selectKeyHints({ mode } as never), width);
				expect(line.length > 0, mode).toBe(true);
				expect(strip(line).startsWith(" "), mode).toBe(false);
				expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			}
		});

		it(`starts the todo lines above the editor at column 0 at ${width} columns`, () => {
			const panel = new TodoPanelComponent();
			panel.setItems([
				{ id: "1", text: "read the config", status: "done" },
				{ id: "2", text: "fix the parser", status: "in_progress" },
				{ id: "3", text: "add a test", status: "pending" },
			]);
			const lines = panel.render(width);
			expect(lines.length).toBeGreaterThan(1);
			for (const line of lines) {
				expect(strip(line).startsWith(" "), strip(line)).toBe(false);
				expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			}
		});
	}
});
