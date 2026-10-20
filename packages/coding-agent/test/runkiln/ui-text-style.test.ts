/**
 * UI text style: no middle dot ("·"), bullet ("•") or em dash ("—") in strings shipped in any package's src.
 * Separators are a plain "-". Code is checked with comments blanked out (comments are free text); a small scanner tells
 * comments from strings and templates, so "//" inside a string is not a comment.
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

const PACKAGES = join(import.meta.dirname, "..", "..", "..");
const BANNED = /[·•—]/;

/** Files where the character is data, not a separator. Keep this list short and say why. */
const ALLOWED = new Set([
	"tui/src/latex.ts", // \cdot and \bullet render as their glyphs
	"tui/src/components/input.ts", // "•" masks a secret value while it is typed
	"tui/src/utils.ts", // CJK line-break punctuation class
	"coding-agent/src/core/verify/edit-hint.ts", // "·" shows a space in indentation diffs sent to the model
	"coding-agent/src/modes/interactive/components/easter-egg-3d.ts", // glyph width class
]);

function sourceFiles(dir: string): string[] {
	const files: string[] = [];
	for (const name of readdirSync(dir)) {
		if (name === "node_modules" || name === "dist") continue;
		const path = join(dir, name);
		if (statSync(path).isDirectory()) files.push(...sourceFiles(path));
		else if (/\.(ts|tsx|js|mjs)$/.test(name) && !name.endsWith(".d.ts")) files.push(path);
	}
	return files;
}

/** `source` with every comment replaced by spaces (newlines kept, so line numbers still match). */
function blankComments(source: string): string {
	let out = "";
	let state: "code" | "line" | "block" | "'" | '"' | "`" = "code";
	for (let i = 0; i < source.length; i++) {
		const char = source[i] ?? "";
		const next = source[i + 1] ?? "";
		if (state === "code") {
			if (char === "/" && next === "/") {
				state = "line";
				out += "  ";
				i++;
				continue;
			}
			if (char === "/" && next === "*") {
				state = "block";
				out += "  ";
				i++;
				continue;
			}
			if (char === "'" || char === '"' || char === "`") state = char;
			out += char;
			continue;
		}
		if (state === "line") {
			if (char === "\n") {
				state = "code";
				out += char;
			} else out += " ";
			continue;
		}
		if (state === "block") {
			if (char === "*" && next === "/") {
				state = "code";
				out += "  ";
				i++;
			} else out += char === "\n" ? char : " ";
			continue;
		}
		// Inside a string or template: an escape skips a character; a plain quote string ends at a newline.
		if (char === "\\") {
			out += char + next;
			i++;
			continue;
		}
		if (char === state || (char === "\n" && state !== "`")) state = "code";
		out += char;
	}
	return out;
}

/**
 * Machine-readable output (JSON keys, file formats) is not UI text: a line that defines it carries this marker in
 * a comment and keeps its format. Rendered text converts it (e.g. usage keys through displayModelKey()).
 */
const MACHINE_READABLE = "ui-text-style: machine-readable";

/** Lines of `path` (comments blanked) that hold a banned character. */
function bannedStrings(path: string): Array<{ line: number; text: string }> {
	const source = readFileSync(path, "utf8");
	if (!BANNED.test(source)) return [];
	const original = source.split("\n");
	const hits: Array<{ line: number; text: string }> = [];
	for (const [index, line] of blankComments(source).split("\n").entries()) {
		if (original[index]?.includes(MACHINE_READABLE)) continue;
		if (BANNED.test(line)) hits.push({ line: index + 1, text: line.trim().slice(0, 100) });
	}
	return hits;
}

describe("UI text style", () => {
	it('uses " - " instead of "·", "•" or "—" in every UI string (machine-readable lines excepted)', () => {
		const offenders: string[] = [];
		for (const pkg of readdirSync(PACKAGES)) {
			const src = join(PACKAGES, pkg, "src");
			let isDir = false;
			try {
				isDir = statSync(src).isDirectory();
			} catch {
				isDir = false;
			}
			if (!isDir) continue;
			for (const path of sourceFiles(src)) {
				const rel = relative(PACKAGES, path).split(sep).join("/");
				if (ALLOWED.has(rel)) continue;
				for (const hit of bannedStrings(path)) offenders.push(`${rel}:${hit.line}  ${JSON.stringify(hit.text)}`);
			}
		}
		expect(offenders, `Use " - " (or "-") instead:\n${offenders.join("\n")}`).toEqual([]);
	});

	it("skips machine-readable lines (marked), never rendered UI strings", () => {
		const dir = mkdtempSync(join(tmpdir(), "ui-text-style-"));
		const file = join(dir, "probe.ts");
		writeFileSync(
			file,
			[`export const KEY = "a•b"; // ${MACHINE_READABLE} (JSON keys)`, 'export const LABEL = "a • b";'].join("\n"),
		);
		expect(bannedStrings(file).map((hit) => hit.line)).toEqual([2]);
		rmSync(dir, { recursive: true, force: true });
	});

	it("checks strings and templates, not comments", () => {
		const probe = [
			"// a · comment",
			'const url = "https://x.example"; // trailing — comment',
			"/* block",
			"   — still a comment */",
			'const a = "x · y";',
			"const b = `p — $" + "{a}`;",
		].join("\n");
		const kept = blankComments(probe).split("\n");
		expect(kept.filter((line) => BANNED.test(line))).toEqual(['const a = "x · y";', "const b = `p — $" + "{a}`;"]);
		expect(kept[1]).toContain('"https://x.example"');
	});
});
