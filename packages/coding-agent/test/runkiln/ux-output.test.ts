import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Markdown, setKeybindings, visibleWidth } from "@runkiln/tui";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../../src/core/keybindings.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { generateDiffString } from "../../src/core/tools/edit-diff.ts";
import { editRenderers } from "../../src/core/tools/renderers/edit.ts";
import { readRenderers } from "../../src/core/tools/renderers/read.ts";
import {
	applyBackgroundRanges,
	DiffView,
	diffStats,
	parseDiffRows,
	previewDiffText,
	renderSplitDiffLines,
	renderUnifiedDiffLines,
	resetsBackground,
	resolveDiffLayout,
	wordChangeRanges,
} from "../../src/modes/interactive/components/diff.ts";
import { ToolExecutionComponent } from "../../src/modes/interactive/components/tool-execution.ts";
import {
	commonScope,
	summarizeToolGroup,
	ToolGroupComponent,
} from "../../src/modes/interactive/components/tool-group.ts";
import {
	type DEFAULT_TRANSCRIPT_DISPLAY,
	resetTranscriptDisplay,
	setTranscriptDisplay,
} from "../../src/modes/interactive/components/transcript-display.ts";
import {
	collectTurnStats,
	formatTurnDuration,
	formatTurnRouteDetail,
	formatTurnSummaryLine,
	shouldShowTurnSummary,
	TurnSummaryComponent,
	type TurnSummaryData,
} from "../../src/modes/interactive/components/turn-summary.ts";
import {
	extractCodeBlocks,
	lineCountLabel,
	osc52Sequence,
	parseCopyCommand,
	selectCodeBlock,
} from "../../src/modes/interactive/copy-text.ts";
import { getMarkdownTheme, initTheme, theme } from "../../src/modes/interactive/theme/theme.ts";
import { CardSelection, classifyCardSelectKey } from "../../src/modes/interactive/tool-card-select.ts";
import { stripAnsi } from "../../src/utils/ansi.ts";

let keysDir: string;
beforeAll(() => {
	initTheme("dark");
	keysDir = mkdtempSync(join(tmpdir(), "runkiln-ux-keys-"));
	setKeybindings(KeybindingsManager.create(keysDir));
});
afterAll(() => rmSync(keysDir, { recursive: true, force: true }));
afterEach(() => resetTranscriptDisplay());

const OLD = [
	'import { a } from "./a";',
	"",
	"export function add(x: number, y: number) {",
	"\treturn x + y;",
	"}",
	"",
	"const one = 1;",
	"const two = 2;",
	"const three = 3;",
	"const four = 4;",
	"const five = 5;",
	"const six = 6;",
	"const seven = 7;",
	"const eight = 8;",
	"",
	'const greeting = "hello";',
	"console.log(greeting);",
	"",
].join("\n");
const NEW = OLD.replace('import { a } from "./a";', 'import { a, b } from "./a";')
	.replace("y: number) {", "y: number, z = 0) {")
	.replace("return x + y;", "return x + y + z;")
	.replace('"hello"', '"hello world"')
	.replace("console.log(greeting);", "console.log(greeting, b);\n// done");
const DIFF = generateDiffString(OLD, NEW).diff;

const plain = (lines: string[]) => lines.map((line) => stripAnsi(line));
const uiStub = { requestRender() {} } as any;

describe("diff parsing", () => {
	it("counts added and removed lines and derives new line numbers for context rows", () => {
		expect(diffStats(DIFF)).toEqual({ added: 6, removed: 5 });
		const rows = parseDiffRows(DIFF);
		const gap = rows.find((row) => row.kind === "gap");
		expect(gap?.content).toBe("...");
		const lastContext = rows.filter((row) => row.kind === "context").at(-1);
		// The context rows after the last removed/added run are shifted by the lines added above them.
		expect(lastContext?.newNum).toBeDefined();
		const added = rows.filter((row) => row.kind === "added").map((row) => row.newNum);
		expect(added).toContain(18);
	});

	it("finds changed words and skips pairs with little in common", () => {
		const change = wordChangeRanges('const greeting = "hello";', 'const greeting = "hello world";');
		expect(change).toBeDefined();
		expect(change!.old).toEqual([]);
		expect(change!.new.length).toBeGreaterThan(0);
		expect(wordChangeRanges("alpha beta gamma", "completely different words here")).toBeUndefined();
	});

	it("applies background ranges across nested styling and recognises background resets", () => {
		const styled = `ab${theme.fg("syntaxKeyword", "cd")}ef`;
		const out = applyBackgroundRanges(styled, [{ start: 1, end: 5 }], "\x1b[41m");
		expect(stripAnsi(out)).toBe("abcdef");
		expect(out.indexOf("\x1b[41m")).toBeLessThan(out.indexOf("cd"));
		expect(resetsBackground("\x1b[49m")).toBe(true);
		expect(resetsBackground("\x1b[0m")).toBe(true);
		expect(resetsBackground("\x1b[38;2;0;0;0m")).toBe(false);
		expect(resetsBackground("\x1b[39m")).toBe(false);
	});

	it("keeps an outer theme background after a nested one closes", () => {
		const inner = theme.bg("toolDiffAddedBg", "x");
		const outer = theme.bg("toolSuccessBg", `a${inner}b`);
		const successBg = theme.getBgAnsi("toolSuccessBg");
		expect(outer.indexOf(successBg, outer.indexOf("x"))).toBeGreaterThan(0);
	});
});

describe("diff rendering", () => {
	it("renders unified diffs with syntax colours and word-level backgrounds", () => {
		const lines = renderUnifiedDiffLines(DIFF, { filePath: "src/x.ts" });
		expect(plain(lines)).toContain('+ 1 import { a, b } from "./a";');
		const addedImport = lines.find((line) => stripAnsi(line).startsWith("+ 1"))!;
		expect(addedImport).toContain(theme.getFgAnsi("syntaxKeyword"));
		expect(addedImport).toContain(theme.getBgAnsi("toolDiffAddedBg"));
		const noSyntax = renderUnifiedDiffLines(DIFF, { filePath: "src/x.ts", syntax: false });
		expect(noSyntax.find((line) => stripAnsi(line).startsWith("+ 1"))).not.toContain(
			theme.getFgAnsi("syntaxKeyword"),
		);
	});

	it("renders a side-by-side diff that fits the width, modified lines on one row", () => {
		const width = 150;
		const lines = renderSplitDiffLines(DIFF, width, { filePath: "src/x.ts" });
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		const row = plain(lines).find((line) => line.includes("return x + y;"))!;
		expect(row).toContain("│");
		expect(row).toContain("return x + y + z;");
		// The line added without a removed counterpart has an empty left side.
		const doneRow = plain(lines).find((line) => line.includes("// done"))!;
		expect(doneRow.trimStart().startsWith("│")).toBe(true);
	});

	it("wraps long lines inside split columns instead of cutting them", () => {
		const long = "x".repeat(200);
		const diff = generateDiffString(`a\n${long}\n`, `a\n${long}y\n`).diff;
		const lines = renderSplitDiffLines(diff, 140, {});
		expect(lines.length).toBeGreaterThan(3);
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(140);
	});

	it("picks split in auto mode only from 140 columns", () => {
		expect(resolveDiffLayout("auto", 138, 2)).toBe("split");
		expect(resolveDiffLayout("auto", 137, 2)).toBe("unified");
		expect(resolveDiffLayout("unified", 300)).toBe("unified");
		expect(resolveDiffLayout("split", 60)).toBe("split");
	});

	it("previews the rows around the first change", () => {
		const preview = previewDiffText(DIFF, 4);
		expect(preview.text.split("\n")).toHaveLength(4);
		expect(preview.hidden).toBe(DIFF.split("\n").length - 4);
		const view = new DiffView(DIFF, { maxRows: 4, moreLine: (n) => `… ${n} more` });
		const lines = plain(view.render(80));
		expect(lines).toHaveLength(5);
		expect(lines[4]).toBe(`… ${preview.hidden} more`);
	});
});

function editCard(display: Partial<typeof DEFAULT_TRANSCRIPT_DISPLAY> = {}) {
	setTranscriptDisplay(display);
	const component = new ToolExecutionComponent(
		"edit",
		"call-1",
		{ path: "src/x.ts", edits: [{ oldText: "a", newText: "b" }] },
		{ outputPad: 1 },
		{ ...editRenderers, renderShell: "self" },
		uiStub,
		"/project",
	);
	component.updateResult({ content: [{ type: "text", text: "ok" }], details: { diff: DIFF }, isError: false });
	return component;
}

describe("collapsed edit cards", () => {
	it("shows the path with counts and the first few diff lines by default", () => {
		const lines = plain(editCard().render(100));
		const header = lines.find((line) => line.includes("✎"))!;
		expect(header).toMatch(/✎ src\/x\.ts\s+\+6 −5/);
		const diffLines = lines.filter((line) => /^\s*[+\- ]\s?\d+ /.test(line));
		expect(diffLines.length).toBeLessThanOrEqual(4);
		expect(lines.some((line) => line.includes("more lines (click or ctrl+o to expand)"))).toBe(true);
	});

	it("summary mode shows only the header, full mode the whole diff", () => {
		const summary = plain(editCard({ editDiffs: "summary" }).render(100)).filter((line) => line.trim());
		expect(summary).toHaveLength(1);
		const full = plain(editCard({ editDiffs: "full" }).render(100));
		expect(full.some((line) => line.includes("// done"))).toBe(true);
		expect(full.some((line) => line.includes("more lines"))).toBe(false);
	});

	it("a click expands one card on its own", () => {
		const card = editCard();
		const collapsed = card.render(100).length;
		const rows = plain(card.render(100));
		const headerRow = rows.findIndex((line) => line.includes("✎"));
		card.handleMouse({
			type: "click",
			button: "left",
			x: 3,
			y: headerRow,
			screenX: 3,
			screenY: headerRow,
			width: 100,
			height: collapsed,
			shift: false,
			alt: false,
			ctrl: false,
		} as any);
		expect(card.isExpanded()).toBe(true);
		expect(plain(card.render(100)).some((line) => line.includes("// done"))).toBe(true);
	});

	it("uses the side-by-side layout on wide terminals when expanded", () => {
		const card = editCard({ diffLayout: "auto" });
		card.setExpanded(true);
		const wide = plain(card.render(160));
		expect(wide.some((line) => line.includes("return x + y;") && line.includes("return x + y + z;"))).toBe(true);
		const narrow = plain(card.render(100));
		expect(narrow.some((line) => line.includes("return x + y;") && line.includes("return x + y + z;"))).toBe(false);
	});
});

function readCard(id: string, toolName: string, args: any) {
	const component = new ToolExecutionComponent(
		toolName,
		id,
		args,
		{ outputPad: 1 },
		toolName === "read" ? readRenderers : undefined,
		uiStub,
		"/project",
	);
	component.updateResult({ content: [{ type: "text", text: "line 1\nline 2" }], isError: false });
	return component;
}

describe("grouped read-only tools", () => {
	it("summarises reads, greps and the shared directory", () => {
		const summary = summarizeToolGroup(
			[
				{ toolName: "read", args: { path: "/project/src/core/a.ts" }, status: "success" },
				{ toolName: "read", args: { path: "src/core/b.ts" }, status: "success" },
				{ toolName: "read", args: { path: "src/core/b.ts" }, status: "success" },
				{ toolName: "grep", args: { pattern: "x", path: "src/core/x" }, status: "error" },
				{ toolName: "grep", args: { pattern: "y" }, status: "pending" },
				{ toolName: "ls", args: { path: "src/core" }, status: "success" },
			],
			"/project",
		);
		expect(summary.text).toBe("read 2 files, grep 2×, ls 1× (src/core…)");
		expect(summary.errors).toBe(1);
		expect(summary.pending).toBe(1);
		expect(commonScope(["src/a.ts", "test/b.ts"])).toBeUndefined();
		expect(commonScope(["src/a.ts"])).toBe("src/a.ts");
	});

	it("renders one line until expanded, then the cards", () => {
		const group = new ToolGroupComponent("/project", 1);
		group.addTool(readCard("r1", "read", { path: "src/core/a.ts" }));
		group.addTool(readCard("r2", "read", { path: "src/core/b.ts" }));
		group.addTool(readCard("g1", "grep", { pattern: "foo", path: "src/core" }));
		const collapsed = plain(group.render(80)).filter((line) => line.trim());
		expect(collapsed).toHaveLength(1);
		expect(collapsed[0]).toContain("⌕ read 2 files, grep 1× (src/core…)");
		group.setGroupExpanded(true);
		const expanded = plain(group.render(80));
		expect(expanded.length).toBeGreaterThan(4);
		expect(expanded.join("\n")).toContain("a.ts");
	});

	it("a group of one renders as the plain card", () => {
		const group = new ToolGroupComponent("/project", 1);
		const card = readCard("r1", "read", { path: "src/core/a.ts" });
		group.addTool(card);
		expect(group.render(80)).toEqual(card.render(80));
	});
});

describe("turn summary", () => {
	const branch = [
		{ type: "message", id: "u0", message: { role: "user", content: "old" } },
		{ type: "message", id: "a0", message: { role: "assistant", content: [], usage: { cost: { total: 5 } } } },
		{ type: "message", id: "u1", message: { role: "user", content: "fix it" } },
		{
			type: "message",
			id: "a1",
			message: {
				role: "assistant",
				content: [
					{ type: "toolCall", id: "t1", name: "read", arguments: { path: "a.ts" } },
					{ type: "toolCall", id: "t2", name: "edit", arguments: { path: "a.ts" } },
				],
				usage: { cost: { total: 0.001 } },
				stopReason: "toolUse",
			},
		},
		{
			type: "message",
			id: "r1",
			message: { role: "toolResult", toolCallId: "t1", toolName: "read", isError: false },
		},
		{
			type: "message",
			id: "r2",
			message: { role: "toolResult", toolCallId: "t2", toolName: "edit", isError: false, details: { diff: DIFF } },
		},
		{
			type: "message",
			id: "a2",
			message: { role: "assistant", content: [{ type: "text", text: "done" }], usage: { cost: { total: 0.0021 } } },
		},
	];

	it("collects the last turn's tools, cost and edited files", () => {
		const stats = collectTurnStats(branch);
		expect(stats.userEntryId).toBe("u1");
		expect(stats.tools).toBe(2);
		expect(stats.toolErrors).toBe(0);
		expect(stats.cost).toBeCloseTo(0.0031, 6);
		expect(stats.editFiles).toEqual({ count: 1, added: 6, removed: 5 });
		expect(stats.status).toBe("done");
	});

	const data: TurnSummaryData = {
		status: "done",
		durationMs: 41_200,
		files: { count: 3, added: 27, removed: 8 },
		tools: 9,
		toolErrors: 0,
		cost: 0.0031,
		route: {
			model: "glm-5-3-flash",
			thinking: "low",
			mode: "auto:medium",
			reason: "code.bugfix d0.62 ↑1",
			escalation: 1,
		},
	};

	it("formats one line and drops the least important parts to fit", () => {
		expect(stripAnsi(formatTurnSummaryLine(data, 120))).toBe(
			"✓ 41s - 3 files +27 −8 - 9 tools - $0.0031 - glm-5-3-flash - low ↑1",
		);
		const narrow = stripAnsi(formatTurnSummaryLine(data, 44));
		expect(narrow).toBe("✓ 41s - 3 files +27 −8 - 9 tools - $0.0031");
		expect(formatTurnDuration(125_000)).toBe("2m05s");
		expect(formatTurnRouteDetail(data.route)).toBe("auto:medium picked glm-5-3-flash - low ↑1: code.bugfix d0.62 ↑1");
	});

	it("skips quick plain chat turns and shows the router reason when expanded", () => {
		expect(shouldShowTurnSummary({ ...data, tools: 0, durationMs: 1200 })).toBe(false);
		expect(shouldShowTurnSummary({ ...data, tools: 0, durationMs: 1200, status: "aborted" })).toBe(true);
		const component = new TurnSummaryComponent(data, 1);
		expect(plain(component.render(100)).filter((line) => line.trim())).toHaveLength(1);
		component.setExpanded(true);
		expect(plain(component.render(100)).join("\n")).toContain("code.bugfix d0.62");
	});
});

describe("clean copy", () => {
	const message = [
		"Here:",
		"",
		"```ts",
		"const a = 1;",
		"```",
		"",
		"- item",
		"",
		"  ```bash",
		"  npm test",
		"  ```",
	].join("\n");

	it("extracts code blocks, nested ones included, and picks by number", () => {
		const blocks = extractCodeBlocks(message);
		expect(blocks).toEqual([
			{ lang: "ts", code: "const a = 1;" },
			{ lang: "bash", code: "npm test" },
		]);
		expect(selectCodeBlock(blocks, undefined)).toMatchObject({ position: 2 });
		expect(selectCodeBlock(blocks, 1)).toMatchObject({ position: 1, block: { code: "const a = 1;" } });
		expect(selectCodeBlock(blocks, -2)).toMatchObject({ position: 1 });
		expect(selectCodeBlock(blocks, 3)).toHaveProperty("error");
		expect(selectCodeBlock([], undefined)).toHaveProperty("error");
	});

	it("parses /copy sub-commands", () => {
		expect(parseCopyCommand("/copy")).toEqual({ kind: "message" });
		expect(parseCopyCommand("/copy md")).toEqual({ kind: "md" });
		expect(parseCopyCommand("/copy code")).toEqual({ kind: "code" });
		expect(parseCopyCommand("/copy code 2")).toEqual({ kind: "code", index: 2 });
		expect(parseCopyCommand("/copy code x").kind).toBe("error");
		expect(parseCopyCommand("/copy nope").kind).toBe("error");
		expect(lineCountLabel("a\nb\n")).toBe("2 lines");
		expect(osc52Sequence("hi")).toBe(`\x1b]52;c;${Buffer.from("hi").toString("base64")}\x07`);
		expect(osc52Sequence("x".repeat(100), 10)).toBeUndefined();
	});

	it("draws a copy label on code fences and copies the block on click", () => {
		const copied: string[] = [];
		const md = new Markdown("Text\n\n```ts\nconst a = 1;\nconst b = 2;\n```\n", 1, 0, getMarkdownTheme(), undefined, {
			onCopyCode: (code) => copied.push(code),
		});
		const lines = md.render(60);
		const row = lines.findIndex((line) => stripAnsi(line).trimEnd().endsWith("copy"));
		expect(row).toBeGreaterThan(0);
		expect(visibleWidth(lines[row])).toBeLessThanOrEqual(60);
		const col = stripAnsi(lines[row]).lastIndexOf("copy");
		const event = {
			type: "click",
			button: "left",
			x: col + 1,
			y: row,
			screenX: col + 1,
			screenY: row,
			width: 60,
			height: lines.length,
			shift: false,
			alt: false,
			ctrl: false,
		} as any;
		expect(md.handleMouse(event)).toEqual({ handled: true });
		expect(copied).toEqual(["const a = 1;\nconst b = 2;"]);
		expect(md.handleMouse({ ...event, y: 0 })).toBeUndefined();
		// Without the callback there is no label.
		const bare = new Markdown("```ts\nx\n```", 0, 0, getMarkdownTheme());
		expect(plain(bare.render(60)).some((line) => line.includes("copy"))).toBe(false);
	});
});

describe("card select mode", () => {
	it("moves between cards and toggles the selected one", () => {
		const toggled: number[] = [];
		const markers: Array<string | undefined> = [undefined, undefined, undefined];
		const cards = [0, 1, 2].map((i) => ({
			toggleSelected: () => toggled.push(i),
			setSelectMarker: (marker: string | undefined) => {
				markers[i] = marker;
			},
		}));
		const selection = new CardSelection(cards, ">");
		expect(markers).toEqual([undefined, undefined, ">"]);
		selection.move(-1);
		selection.move(-5);
		expect(selection.position).toBe(0);
		expect(markers).toEqual([">", undefined, undefined]);
		selection.toggle();
		expect(toggled).toEqual([0]);
		selection.dispose();
		expect(markers).toEqual([undefined, undefined, undefined]);
		expect(classifyCardSelectKey("\x1b[A")).toBe("up");
		expect(classifyCardSelectKey("j")).toBe("down");
		expect(classifyCardSelectKey("\r")).toBe("toggle");
		expect(classifyCardSelectKey("\x1b")).toBe("exit");
		expect(classifyCardSelectKey("x")).toBe("other");
	});

	it("draws the marker on the card's spacer row", () => {
		const card = editCard();
		card.setSelectMarker("SELECTED");
		expect(stripAnsi(card.render(100)[0])).toBe("SELECTED");
		card.setSelectMarker(undefined);
		expect(stripAnsi(card.render(100)[0]).trim()).toBe("");
	});
});

describe("display settings", () => {
	it("defaults and ignores invalid values", () => {
		expect(SettingsManager.inMemory().getDisplaySettings()).toEqual({
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
		const custom = SettingsManager.inMemory({
			display: { editDiffs: "summary", diff: "bogus" as any, groupReads: false },
		}).getDisplaySettings();
		expect(custom).toMatchObject({ editDiffs: "summary", diff: "auto", groupReads: false });
	});
});
