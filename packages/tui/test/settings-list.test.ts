import assert from "node:assert";
import { describe, it } from "node:test";
import { SettingsList, type SettingsListTheme } from "../src/components/settings-list.ts";

const testTheme: SettingsListTheme = {
	label: (text) => text,
	value: (text) => text,
	description: (text) => text,
	cursor: "> ",
	hint: (text) => text,
};

const items = [
	{
		id: "tui-mode",
		label: "TUI mode",
		currentValue: "regular",
		values: ["regular", "fullscreen"],
	},
];

describe("SettingsList", () => {
	it("includes spaces in an active search instead of changing the selected setting", () => {
		const changes: Array<{ id: string; value: string }> = [];
		const list = new SettingsList(
			items.map((item) => ({ ...item })),
			10,
			testTheme,
			(id, value) => changes.push({ id, value }),
			() => {},
			{ enableSearch: true },
		);

		for (const character of "TUI mode") list.handleInput(character);

		assert.deepStrictEqual(changes, []);
		assert.match(list.render(80)[0] ?? "", /TUI mode/);

		list.handleInput("\r");
		assert.deepStrictEqual(changes, [{ id: "tui-mode", value: "fullscreen" }]);
	});

	it("keeps Space as a change shortcut before a search query is entered", () => {
		const changes: Array<{ id: string; value: string }> = [];
		const list = new SettingsList(
			items.map((item) => ({ ...item })),
			10,
			testTheme,
			(id, value) => changes.push({ id, value }),
			() => {},
			{ enableSearch: true },
		);

		list.handleInput(" ");

		assert.deepStrictEqual(changes, [{ id: "tui-mode", value: "fullscreen" }]);
	});

	it("skips section titles when moving, draws them flush left and leaves them out of search", () => {
		const changes: Array<{ id: string; value: string }> = [];
		const list = new SettingsList(
			[
				{ id: "s1", label: "Display", section: true, currentValue: "" },
				{ id: "a", label: "Alpha", currentValue: "on", values: ["on", "off"] },
				{ id: "s2", label: "Footer", section: true, currentValue: "" },
				{ id: "b", label: "Beta", currentValue: "on", values: ["on", "off"] },
			],
			10,
			{ ...testTheme, section: (text) => `#${text}` },
			(id, value) => changes.push({ id, value }),
			() => {},
			{ enableSearch: true },
		);
		const lines = list.render(40);
		assert.deepStrictEqual(lines.slice(2, 7), ["#Display", "> Alpha  on", "", "#Footer", "  Beta   on"]);
		list.handleInput("\x1b[B");
		assert.strictEqual(list.render(40)[6], "> Beta   on");
		list.handleInput("\x1b[B");
		assert.strictEqual(list.render(40)[3], "> Alpha  on");
		list.handleInput("\x1b[A");
		list.handleInput("\r");
		assert.deepStrictEqual(changes, [{ id: "b", value: "off" }]);
		for (const character of "Foot") list.handleInput(character);
		assert.ok(!list.render(40).includes("#Footer"));
	});

	it("maps clicks to rows below section titles and blank rows", () => {
		const changes: string[] = [];
		const list = new SettingsList(
			[
				{ id: "s1", label: "One", section: true, currentValue: "" },
				{ id: "a", label: "Alpha", currentValue: "on", values: ["on", "off"] },
				{ id: "s2", label: "Two", section: true, currentValue: "" },
				{ id: "b", label: "Beta", currentValue: "on", values: ["on", "off"] },
			],
			10,
			testTheme,
			(id) => changes.push(id),
			() => {},
		);
		list.render(40);
		const click = (y: number) => {
			list.handleMouse({ type: "press", button: "left", x: 2, y, width: 40, height: 10 } as never);
			list.handleMouse({ type: "click", button: "left", x: 2, y, width: 40, height: 10 } as never);
		};
		click(0);
		click(2);
		click(3);
		assert.deepStrictEqual(changes, []);
		click(4);
		click(1);
		assert.deepStrictEqual(changes, ["b", "a"]);
	});
});
