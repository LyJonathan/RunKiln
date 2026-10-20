import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEditToolDefinition } from "../../src/core/tools/edit.ts";
import { createWriteToolDefinition } from "../../src/core/tools/write.ts";
import {
	configuredCheckers,
	type Diagnostic,
	detectCheckers,
	newDiagnostics,
	parseAnyFormat,
	parseCompilerLines,
	runCheckers,
} from "../../src/core/verify/diagnostics.ts";
import { getEditStats, resetEditStats, setEditMetricsLogPath } from "../../src/core/verify/edit-metrics.ts";
import { DIAGNOSTICS_MARKER, PostEditChecks, type PostEditSettings } from "../../src/core/verify/post-edit.ts";

/**
 * A stand-in for biome: `biome lint --reporter=github ... <file>` prints one ::error per line containing BAD and
 * one ::warning per line containing MEH.
 */
const FAKE_BIOME = `#!/usr/bin/env node
const fs = require("fs");
const file = process.argv[process.argv.length - 1];
const lines = fs.readFileSync(file, "utf8").split("\\n");
let bad = 0;
lines.forEach((line, i) => {
  if (line.includes("BAD")) { bad++; console.log("::error title=lint/fake/noBad,file=" + file + ",line=" + (i + 1) + ",col=1::Bad thing here."); }
  if (line.includes("MEH")) console.log("::warning title=lint/fake/meh,file=" + file + ",line=" + (i + 1) + ",col=1::Meh.");
});
process.exit(bad ? 1 : 0);
`;

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map((part) => part.text ?? "").join("");
}

describe("diagnostic parsers", () => {
	it("reads tsc, gcc-style, ruff and shellcheck lines", () => {
		const root = "/proj";
		const out = parseCompilerLines(
			[
				"src/a.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.",
				"main.go:4:2: undefined: foo",
				"x.py:1:8: F401 [*] `os` imported but unused",
				"run.sh:3:5: warning: Double quote to prevent globbing and word splitting. [SC2086]",
				"src/main.rs:2:5: error[E0425]: cannot find value `y` in this scope",
				"Found 1 error.",
			].join("\n"),
			"t",
			root,
		);
		expect(out.map((d) => [d.file, d.line, d.severity, d.code])).toEqual([
			["src/a.ts", 3, "error", "TS2322"],
			["main.go", 4, "error", undefined],
			["x.py", 1, "error", "F401"],
			["run.sh", 3, "warning", "SC2086"],
			["src/main.rs", 2, "error", "E0425"],
		]);
		expect(out[2].message).toBe("`os` imported but unused");
	});

	it("turns an unreadable failure into one diagnostic instead of reporting the file clean", () => {
		const found = parseAnyFormat("Something exploded\n", 2, "mycheck", "/proj/a.txt", "/proj");
		expect(found).toEqual([
			{ file: "a.txt", line: 0, severity: "error", message: "Something exploded", source: "mycheck" },
		]);
		expect(parseAnyFormat("all good\n", 0, "mycheck", "/proj/a.txt", "/proj")).toEqual([]);
	});

	it("reports only diagnostics that are new, ignoring line shifts", () => {
		const d = (line: number, message: string): Diagnostic => ({
			file: "a.ts",
			line,
			severity: "error",
			message,
			source: "biome",
		});
		const before = [d(3, "old problem"), d(9, "twice"), d(10, "twice")];
		const after = [d(5, "old problem"), d(11, "twice"), d(12, "twice"), d(13, "twice"), d(2, "new problem")];
		expect(newDiagnostics(before, after).map((x) => [x.line, x.message])).toEqual([
			[13, "twice"],
			[2, "new problem"],
		]);
	});

	it("matches configured commands by glob and fills in {file}", () => {
		const checks = configuredCheckers("/proj/src/app.py", "/proj", {
			"*.py": "mypy --strict {file}",
			"src/**/*.ts": "eslint",
			"*.go": "go vet",
		});
		expect(checks.map((c) => [c.id, c.command, c.kind])).toEqual([
			["mypy", "mypy --strict src/app.py", "configured"],
		]);
		expect(configuredCheckers("/proj/src/x/y.ts", "/proj", { "src/**/*.ts": "eslint" })[0].command).toBe(
			"eslint src/x/y.ts",
		);
	});
});

describe("checker detection and runs", () => {
	let root: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "runkiln-checks-"));
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	function installFakeBiome(): void {
		mkdirSync(join(root, "node_modules", ".bin"), { recursive: true });
		const bin = join(root, "node_modules", ".bin", "biome");
		writeFileSync(bin, FAKE_BIOME);
		chmodSync(bin, 0o755);
		writeFileSync(join(root, "biome.json"), "{}");
	}

	it("uses the project's biome for TS/JS when it is installed and configured, else node --check for JS", () => {
		writeFileSync(join(root, "a.js"), "let x = 1;\n");
		expect(detectCheckers(join(root, "a.js"), root).map((c) => c.id)).toEqual(["node"]);
		// No linter and no tsc: Node's type stripper plus node --check.
		expect(detectCheckers(join(root, "a.ts"), root).map((c) => c.id)).toEqual(["ts-syntax"]);
		installFakeBiome();
		expect(detectCheckers(join(root, "a.js"), root).map((c) => c.id)).toEqual(["biome"]);
		expect(detectCheckers(join(root, "a.ts"), root).map((c) => c.id)).toEqual(["biome"]);
	});

	it("checks JSON in-process and plain JS with node --check", async () => {
		writeFileSync(join(root, "data.json"), '{"a": 1,\n "b": }\n');
		const json = await runCheckers(detectCheckers(join(root, "data.json"), root), join(root, "data.json"), root, {
			timeoutMs: 4000,
		});
		expect(json.diagnostics).toHaveLength(1);
		expect(json.diagnostics[0]).toMatchObject({ file: "data.json", severity: "error", source: "json", line: 2 });

		writeFileSync(join(root, "a.js"), "function f( {\n");
		const js = await runCheckers(detectCheckers(join(root, "a.js"), root), join(root, "a.js"), root, {
			timeoutMs: 4000,
		});
		expect(js.ran).toEqual(["node"]);
		expect(js.diagnostics[0]).toMatchObject({ file: "a.js", severity: "error", source: "node", code: "SyntaxError" });
	});

	it("checks TypeScript syntax with Node's type stripper when there is no linter or tsc", async () => {
		writeFileSync(join(root, "ok.ts"), "const a: number = 1;\nexport { a };\n");
		writeFileSync(join(root, "dup.ts"), "const a: number = 1;\nconst a = 2;\nexport { a };\n");
		writeFileSync(join(root, "bad.ts"), "function f(x: number {\n  return x;\n}\n");
		const check = async (name: string) =>
			(await runCheckers(detectCheckers(join(root, name), root), join(root, name), root, { timeoutMs: 4000 }))
				.diagnostics;
		expect(await check("ok.ts")).toEqual([]);
		expect(await check("dup.ts")).toEqual([
			expect.objectContaining({
				file: "dup.ts",
				line: 2,
				source: "ts-syntax",
				message: "Identifier 'a' has already been declared",
			}),
		]);
		expect(await check("bad.ts")).toEqual([
			expect.objectContaining({ file: "bad.ts", severity: "error", source: "ts-syntax" }),
		]);
	});

	it("drops a checker that times out", async () => {
		const result = await runCheckers(
			[
				{
					id: "sleepy",
					kind: "configured",
					scope: "file",
					command: "sleep 5",
					args: [],
					shell: true,
					parse: () => [],
				},
			],
			join(root, "a.txt"),
			root,
			{ timeoutMs: 300 },
		);
		expect(result.timedOut).toEqual(["sleepy"]);
		expect(result.diagnostics).toEqual([]);
	});

	describe("edit and write with post-edit checks", () => {
		let settings: PostEditSettings;
		let planMode: boolean;
		let checks: PostEditChecks;

		beforeEach(() => {
			installFakeBiome();
			settings = { enabled: true, autoDetect: true, timeoutMs: 4000 };
			planMode = false;
			checks = new PostEditChecks({ cwd: () => root, settings: () => settings, isActive: () => !planMode });
			resetEditStats();
			setEditMetricsLogPath(join(root, "edits.jsonl"));
		});

		afterEach(() => setEditMetricsLogPath(undefined));

		it("appends only the errors the edit introduced, with the marker the router counts", async () => {
			writeFileSync(join(root, "a.ts"), "const a = 1; // BAD already\nconst b = 2;\n");
			const edit = createEditToolDefinition(root, { postEdit: checks, currentModel: () => "glm-test" });
			const result = await edit.execute(
				"1",
				{
					path: "a.ts",
					edits: [{ oldText: "const b = 2;", newText: "const b = 2; // BAD new\nconst c = 3; // MEH" }],
				},
				undefined,
				undefined,
				undefined as never,
			);
			const text = textOf(result);
			expect(text).toContain("Successfully replaced 1 block(s) in a.ts.");
			expect(text).toContain(
				`${DIAGNOSTICS_MARKER} (biome): 1 new error, 1 new warning in a.ts. Fix them unless they are expected.`,
			);
			expect(text).toContain("a.ts:2:1 error lint/fake/noBad: Bad thing here. (biome)");
			expect(text).not.toContain("a.ts:1:1");
			expect(result.details?.diagnostics).toMatchObject({ checkers: ["biome"], newErrors: 1, newWarnings: 1 });
			expect(getEditStats().get("glm-test")).toEqual({ edits: 1, misses: 0, repaired: 0, newErrors: 1 });
			expect(JSON.parse(readFileSync(join(root, "edits.jsonl"), "utf8").trim())).toMatchObject({
				tool: "edit",
				model: "glm-test",
				outcome: "ok",
				newErrors: 1,
			});
		});

		it("says nothing when the edit introduced nothing, and nothing at all when checks are off or in plan mode", async () => {
			writeFileSync(join(root, "a.ts"), "const a = 1; // BAD already\n");
			const edit = createEditToolDefinition(root, { postEdit: checks });
			const clean = await edit.execute(
				"1",
				{ path: "a.ts", edits: [{ oldText: "const a = 1;", newText: "const a = 2;" }] },
				undefined,
				undefined,
				undefined as never,
			);
			expect(textOf(clean)).toBe("Successfully replaced 1 block(s) in a.ts.");

			settings = { ...settings, enabled: false };
			const off = await edit.execute(
				"2",
				{ path: "a.ts", edits: [{ oldText: "const a = 2;", newText: "const a = 2; // BAD" }] },
				undefined,
				undefined,
				undefined as never,
			);
			expect(textOf(off)).not.toContain(DIAGNOSTICS_MARKER);

			settings = { ...settings, enabled: true };
			planMode = true;
			const plan = await edit.execute(
				"3",
				{ path: "a.ts", edits: [{ oldText: "const a = 2; // BAD", newText: "const a = 2; // BAD BAD" }] },
				undefined,
				undefined,
				undefined as never,
			);
			expect(textOf(plan)).not.toContain(DIAGNOSTICS_MARKER);
		});

		it("checks a new file written from scratch against an empty baseline", async () => {
			const write = createWriteToolDefinition(root, { postEdit: checks });
			const result = await write.execute(
				"1",
				{ path: "src/new.ts", content: "export const x = 1; // BAD\n" },
				undefined,
				undefined,
				undefined as never,
			);
			expect(textOf(result)).toContain(`${DIAGNOSTICS_MARKER} (biome): 1 new error in src/new.ts.`);
			expect(result.details?.diagnostics?.newErrors).toBe(1);
		});

		it("caps the report at about 20 lines", async () => {
			writeFileSync(join(root, "a.ts"), "x\n");
			const write = createWriteToolDefinition(root, { postEdit: checks });
			const many = Array.from({ length: 60 }, (_, i) => `const v${i} = ${i}; // BAD`).join("\n");
			const result = await write.execute(
				"1",
				{ path: "a.ts", content: many },
				undefined,
				undefined,
				undefined as never,
			);
			const report = textOf(result).split(`${DIAGNOSTICS_MARKER}`)[1];
			expect(report.split("\n").length).toBeLessThanOrEqual(24);
			expect(report).toContain("60 new errors");
			expect(report).toContain("omitted");
		});

		it("asks the gate before a configured check command and skips it when refused", async () => {
			const approve = vi.fn(async (_command: string) => false);
			const gated = new PostEditChecks({
				cwd: () => root,
				settings: () => ({ enabled: true, autoDetect: false, timeoutMs: 4000, commands: { "*.txt": "false" } }),
				isActive: () => true,
				approveCommand: approve,
			});
			writeFileSync(join(root, "a.txt"), "hello\n");
			const edit = createEditToolDefinition(root, { postEdit: gated });
			for (const [from, to] of [
				["hello", "hi"],
				["hi", "hey"],
			]) {
				const result = await edit.execute(
					"1",
					{ path: "a.txt", edits: [{ oldText: from, newText: to }] },
					undefined,
					undefined,
					undefined as never,
				);
				expect(textOf(result)).not.toContain(DIAGNOSTICS_MARKER);
			}
			// Asked once per session, not per edit.
			expect(approve).toHaveBeenCalledTimes(1);
			expect(approve.mock.calls[0][0]).toBe("false a.txt");
		});

		it("runs an approved configured command and reports what it prints", async () => {
			const checker = join(root, "check.sh");
			writeFileSync(checker, '#!/bin/sh\ngrep -n TODO "$1" | sed "s|^|$1:|; s|:\\([0-9]*\\):|:\\1: error: |"\n');
			chmodSync(checker, 0o755);
			const gated = new PostEditChecks({
				cwd: () => root,
				settings: () => ({
					enabled: true,
					autoDetect: false,
					timeoutMs: 4000,
					commands: { "*.md": `${checker} {file}` },
				}),
				isActive: () => true,
				approveCommand: async () => true,
			});
			writeFileSync(join(root, "notes.md"), "# Notes\n");
			const edit = createEditToolDefinition(root, { postEdit: gated });
			const result = await edit.execute(
				"1",
				{ path: "notes.md", edits: [{ oldText: "# Notes", newText: "# Notes\nTODO fix" }] },
				undefined,
				undefined,
				undefined as never,
			);
			expect(textOf(result)).toContain("1 new error in notes.md");
			expect(textOf(result)).toContain("notes.md:2 error: TODO fix");
		});
	});
});
