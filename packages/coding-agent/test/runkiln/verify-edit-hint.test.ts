import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEditToolDefinition } from "../../src/core/tools/edit.ts";
import { applyEditsToNormalizedContent, EditNotFoundError } from "../../src/core/tools/edit-diff.ts";
import { compactDiff, findClosestMatch, formatEditHint, similarityRatio } from "../../src/core/verify/edit-hint.ts";
import { getEditStats, resetEditStats, setEditMetricsLogPath } from "../../src/core/verify/edit-metrics.ts";
import { buildRepairPrompt, parseRepair, validateRepair } from "../../src/core/verify/edit-repair.ts";

const FILE = [
	"export function total(items) {",
	"\tlet sum = 0;",
	"\tfor (const item of items) {",
	"\t\tsum += item.price * item.qty;",
	"\t}",
	"\treturn sum;",
	"}",
	"",
	"export function count(items) {",
	"\treturn items.length;",
	"}",
	"",
].join("\n");

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map((part) => part.text ?? "").join("");
}

describe("closest match after a failed edit", () => {
	it("is close to difflib's ratio", () => {
		expect(similarityRatio("abcd", "abcd")).toBe(1);
		expect(similarityRatio("abcd", "bcde")).toBeCloseTo(0.75);
		expect(similarityRatio("", "")).toBe(1);
	});

	it("finds the window that differs only in indentation and shows the difference", () => {
		const oldText = "    for (const item of items) {\n        sum += item.price * item.qty;\n    }";
		const match = findClosestMatch(FILE, oldText);
		expect(match).toMatchObject({ startLine: 3, endLine: 5, ambiguous: false });
		expect(match!.similarity).toBeGreaterThan(0.8);
		const diff = compactDiff(oldText, match!.text);
		expect(diff).toContain("+ →for (const item of items) {");
		expect(diff).toContain("- ····for (const item of items) {");
		expect(diff.at(-1)).toContain("only indentation differs");
	});

	it("finds a window with a renamed variable and diffs only the changed line", () => {
		const oldText = "\tlet total = 0;\n\tfor (const item of items) {\n\t\ttotal += item.price * item.qty;";
		const match = findClosestMatch(FILE, oldText)!;
		expect([match.startLine, match.endLine]).toEqual([2, 4]);
		const hint = formatEditHint(match, oldText);
		expect(hint).toMatch(/^Closest match: lines 2-4 \(\d+% similar\)\. The file has:/);
		expect(hint).toContain("2\t\tlet sum = 0;");
		expect(hint).toContain("- \tlet total = 0;");
		expect(hint).toContain("+ \tlet sum = 0;");
		expect(hint).not.toContain("- \tfor (const item of items) {");
	});

	it("flags two equally close spots as ambiguous", () => {
		const content = "a();\nfoo(1, 2);\nb();\nfoo(1, 2);\nc();\n";
		const match = findClosestMatch(content, "foo(1, 3);")!;
		expect(match.ambiguous).toBe(true);
		expect(formatEditHint(match, "foo(1, 3);")).toContain("another spot is about as close");
	});

	it("says there is no close match instead of showing a poor one", () => {
		const hint = formatEditHint(findClosestMatch(FILE, "completely unrelated text here"), "completely unrelated");
		expect(hint).toMatch(/^No close match in the file/);
	});

	it("puts the hint in the edit error, with the edit index and the window", () => {
		let caught: unknown;
		try {
			applyEditsToNormalizedContent(
				FILE,
				[
					{ oldText: "return items.length;", newText: "return items.length + 0;" },
					{ oldText: "\treturn summ;", newText: "\treturn sum * 2;" },
				],
				"cart.js",
			);
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(EditNotFoundError);
		const error = caught as EditNotFoundError;
		expect(error.editIndex).toBe(1);
		expect(error.message).toContain("Could not find edits[1] in cart.js.");
		expect(error.message).toContain("Closest match: lines 6-6");
		expect(error.message).toContain("+ \treturn sum;");
	});

	it("stays fast on a large file", () => {
		const big = Array.from({ length: 20000 }, (_, i) => `const value${i} = compute(${i}, "row ${i}");`).join("\n");
		const started = Date.now();
		const match = findClosestMatch(big, 'const value12345 = compute(12345, "row 12346");');
		expect(match?.startLine).toBe(12346);
		expect(Date.now() - started).toBeLessThan(3000);
	});
});

describe("chore-model repair of a missed edit", () => {
	let root: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "runkiln-repair-"));
		writeFileSync(join(root, "cart.js"), FILE);
		resetEditStats();
		setEditMetricsLogPath(false);
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
		setEditMetricsLogPath(undefined);
	});

	const missed = {
		oldText: "    return sum;",
		newText: "    return Math.round(sum);",
	};

	it("parses and validates the model's reply", () => {
		expect(parseRepair('```json\n{"oldText": "\\treturn sum;", "newText": "\\treturn 1;"}\n```')).toEqual({
			oldText: "\treturn sum;",
			newText: "\treturn 1;",
		});
		expect(parseRepair("no json")).toBeUndefined();
		const match = findClosestMatch(FILE, missed.oldText)!;
		expect(validateRepair(FILE, { oldText: "\treturn sum;", newText: "" }, match)).toBe(true);
		// Not unique.
		expect(validateRepair(FILE, { oldText: "\treturn", newText: "" }, match)).toBe(false);
		// Unique but far from the window.
		expect(validateRepair(FILE, { oldText: "\treturn items.length;", newText: "" }, match)).toBe(false);
		expect(buildRepairPrompt({ path: "cart.js", content: FILE, ...missed, closest: match })).toContain(
			"File cart.js, lines 6-6:",
		);
	});

	it("is off by default: the miss is returned with the hint and logged", async () => {
		const repair = vi.fn(async () => '{"oldText": "\\treturn sum;", "newText": "\\treturn Math.round(sum);"}');
		const edit = createEditToolDefinition(root, { repair, currentModel: () => "glm-test" });
		await expect(
			edit.execute("1", { path: "cart.js", edits: [missed] }, undefined, undefined, undefined as never),
		).rejects.toThrow(/Closest match: lines 6-6 \(\d+% similar\)/);
		expect(repair).not.toHaveBeenCalled();
		expect(getEditStats().get("glm-test")).toMatchObject({ edits: 1, misses: 1, repaired: 0 });
	});

	it("applies a validated repair when edit.autoRepair is on", async () => {
		const repair = vi.fn(async () => '{"oldText": "\\treturn sum;", "newText": "\\treturn Math.round(sum);"}');
		const edit = createEditToolDefinition(root, { repair, autoRepair: () => true, currentModel: () => "glm-test" });
		const result = await edit.execute(
			"1",
			{ path: "cart.js", edits: [missed] },
			undefined,
			undefined,
			undefined as never,
		);
		expect(repair).toHaveBeenCalledTimes(1);
		expect(readFileSync(join(root, "cart.js"), "utf8")).toContain("\treturn Math.round(sum);\n");
		expect(textOf(result)).toContain("Auto-repaired edits[0].oldText to the file's text at lines 6-6");
		expect(result.details?.repaired).toEqual([expect.objectContaining({ editIndex: 0, startLine: 6, endLine: 6 })]);
		expect(getEditStats().get("glm-test")).toMatchObject({ edits: 1, misses: 0, repaired: 1 });
	});

	it("refuses a repair that does not match exactly once, and leaves the file alone", async () => {
		const repair = vi.fn(async () => '{"oldText": "\\treturn", "newText": "\\treturn 0;"}');
		const edit = createEditToolDefinition(root, { repair, autoRepair: () => true });
		await expect(
			edit.execute("1", { path: "cart.js", edits: [missed] }, undefined, undefined, undefined as never),
		).rejects.toThrow(/Automatic repair was tried/);
		expect(readFileSync(join(root, "cart.js"), "utf8")).toBe(FILE);
	});

	it("does not ask the model when the closest match is below 90% or ambiguous", async () => {
		const repair = vi.fn(async () => undefined);
		const edit = createEditToolDefinition(root, { repair, autoRepair: () => true });
		await expect(
			edit.execute(
				"1",
				{ path: "cart.js", edits: [{ oldText: "\tlet total = 100;\n\tconsole.log(items);", newText: "x" }] },
				undefined,
				undefined,
				undefined as never,
			),
		).rejects.toThrow(/Could not find the exact text/);
		expect(repair).not.toHaveBeenCalled();
	});
});
