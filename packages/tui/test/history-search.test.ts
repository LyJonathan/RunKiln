import assert from "node:assert";
import { describe, it } from "node:test";
import { fuzzyHighlightIndices, HistorySearch, type HistorySearchItem } from "../src/components/history-search.ts";
import { visibleWidth } from "../src/utils.ts";
import { defaultSelectListTheme } from "./test-themes.ts";

const plain = (text: string) => text;
const theme = {
	border: plain,
	title: plain,
	scopeActive: plain,
	scopeInactive: plain,
	match: (text: string) => `<${text}>`,
	detail: plain,
	hint: plain,
	selectList: defaultSelectListTheme,
};

const CTRL_R = "\x12";
const CTRL_S = "\x13";
const TAB = "\t";
const ENTER = "\r";
const ESC = "\x1b";

function make(data: Record<string, string[]>, accept: Array<[string, string]> = [], cancel: string[] = []) {
	return new HistorySearch({
		scopes: [
			{ id: "session", label: "session" },
			{ id: "project", label: "project" },
			{ id: "all", label: "all" },
		],
		initialScope: "project",
		load: (scope): HistorySearchItem[] => (data[scope] ?? []).map((text) => ({ text, detail: "1h" })),
		onAccept: (text, mode) => accept.push([text, mode]),
		onCancel: () => cancel.push("cancel"),
		theme,
		maxVisible: 5,
	});
}

describe("HistorySearch", () => {
	const data = {
		session: ["fix the failing test"],
		project: ["fix the failing test", "add a router mode", "explain the footer"],
		all: ["fix the failing test", "add a router mode", "explain the footer", "deploy staging"],
	};

	it("starts on the initial scope and lists everything newest first", () => {
		const search = make(data);
		assert.strictEqual(search.getScope(), "project");
		assert.deepStrictEqual(
			search.getMatches().map((m) => m.text),
			data.project,
		);
	});

	it("filters fuzzily as you type", () => {
		const search = make(data);
		for (const char of "rtr") search.handleInput(char);
		assert.deepStrictEqual(
			search.getMatches().map((m) => m.text),
			["add a router mode"],
		);
	});

	it("Ctrl+S cycles the scope session → project → all → session", () => {
		const search = make(data);
		search.handleInput(CTRL_S);
		assert.strictEqual(search.getScope(), "all");
		assert.strictEqual(search.getMatches().length, 4);
		search.handleInput(CTRL_S);
		assert.strictEqual(search.getScope(), "session");
		assert.strictEqual(search.getMatches().length, 1);
	});

	it("Ctrl+R again moves to an older match; Enter inserts, Tab inserts for editing", () => {
		const accepted: Array<[string, string]> = [];
		const search = make(data, accepted);
		search.handleInput(CTRL_R);
		assert.strictEqual(search.getSelected()?.text, "add a router mode");
		search.handleInput(ENTER);
		search.handleInput(TAB);
		assert.deepStrictEqual(accepted, [
			["add a router mode", "replace"],
			["add a router mode", "edit"],
		]);
	});

	it("Esc cancels", () => {
		const cancelled: string[] = [];
		const search = make(data, [], cancelled);
		search.handleInput(ESC);
		assert.deepStrictEqual(cancelled, ["cancel"]);
	});

	it("renders a fixed-height box that never exceeds the width, with highlighted matches", () => {
		const search = make(data);
		for (const char of "foot") search.handleInput(char);
		for (const width of [40, 80, 100]) {
			const lines = search.render(width);
			assert.strictEqual(lines.length, 5 + 1 + 5);
			for (const line of lines) assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}`);
		}
		const joined = search.render(80).join("\n");
		assert.match(joined, /<f><o><o><t>/);
		assert.match(joined, /\[project\]/);
	});

	it("says when nothing is saved yet", () => {
		const search = make({});
		assert.match(search.render(60).join("\n"), /No prompts saved yet/);
	});
});

describe("fuzzyHighlightIndices", () => {
	it("prefers a consecutive substring", () => {
		assert.deepStrictEqual([...fuzzyHighlightIndices("test", "fix the failing test")], [16, 17, 18, 19]);
	});
	it("falls back to the in-order scan and returns nothing on a miss", () => {
		assert.deepStrictEqual([...fuzzyHighlightIndices("ftt", "fix the test")], [0, 4, 8]);
		assert.strictEqual(fuzzyHighlightIndices("zz", "abc").size, 0);
	});
});
