/**
 * Diagnostics after an edit: which checkers apply to a file, how to run them, and how to read their output.
 *
 * Auto-detected checkers are fast, read-only and installed in the project or on PATH: biome or eslint (the
 * project's own), tsc --noEmit (only while it stays fast), ruff or a Python syntax check, gofmt and go vet,
 * cargo check, node --check, shellcheck or bash -n, and an in-process JSON parse. Configured checks are
 * shell commands per glob from the `checks.commands` setting, with `{file}` replaced by the file path.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as nodeModule from "node:module";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { minimatch } from "minimatch";
import { getNodeExecutable } from "../../utils/node-exec.ts";

export type DiagnosticSeverity = "error" | "warning";

export interface Diagnostic {
	/** Path relative to the project root (forward slashes). */
	file: string;
	line: number;
	col?: number;
	severity: DiagnosticSeverity;
	code?: string;
	message: string;
	/** Checker id, e.g. "biome". */
	source: string;
}

export interface CheckerSpec {
	id: string;
	/** "auto": detected, safe and read-only. "configured": from the checks setting (passes the permission gate). */
	kind: "auto" | "configured";
	/** "project" checkers check more than the file; their output is filtered to it. */
	scope: "file" | "project";
	/** Command and args (spawned without a shell), or a shell command line for configured checks. */
	command: string;
	args: string[];
	shell?: boolean;
	/** Runs in-process instead of spawning. */
	inline?: (absPath: string) => Diagnostic[];
	parse: (output: string, exitCode: number, absPath: string, root: string) => Diagnostic[];
}

export interface RunCheckResult {
	diagnostics: Diagnostic[];
	/** Checkers that ran to completion. */
	ran: string[];
	/** Checkers that hit the timeout. */
	timedOut: string[];
	/** Milliseconds per checker id. */
	durations: Record<string, number>;
}

const MAX_MESSAGE_CHARS = 200;

export function toProjectPath(file: string, root: string): string {
	const abs = isAbsolute(file) ? file : resolve(root, file);
	const rel = relative(root, abs);
	return (rel && !rel.startsWith("..") ? rel : abs).split(sep).join("/");
}

function clipMessage(message: string): string {
	const oneLine = message.replace(/\s+/g, " ").trim();
	return oneLine.length > MAX_MESSAGE_CHARS ? `${oneLine.slice(0, MAX_MESSAGE_CHARS)}…` : oneLine;
}

// ---------------------------------------------------------------------------
// Output parsers
// ---------------------------------------------------------------------------

/** GitHub annotations: `::error title=lint/x,file=a.ts,line=3,col=5::message` (biome --reporter=github). */
function parseGithub(output: string, source: string, root: string): Diagnostic[] {
	const out: Diagnostic[] = [];
	for (const line of output.split("\n")) {
		const match = /^::(error|warning|notice)\s+([^:]*)::(.*)$/.exec(line.trim());
		if (!match || match[1] === "notice") continue;
		const props = new Map<string, string>();
		for (const pair of match[2].split(",")) {
			const eq = pair.indexOf("=");
			if (eq > 0) props.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
		}
		const file = props.get("file");
		if (!file) continue;
		out.push({
			file: toProjectPath(file, root),
			line: Number(props.get("line") ?? 0) || 0,
			...(props.get("col") ? { col: Number(props.get("col")) } : {}),
			severity: match[1] === "error" ? "error" : "warning",
			...(props.get("title") ? { code: props.get("title") } : {}),
			message: clipMessage(match[3]),
			source,
		});
	}
	return out;
}

const TSC_LINE = /^(.+?)\((\d+),(\d+)\):\s*(error|warning)\s+(TS\d+):\s*(.*)$/;
const GCC_LINE =
	/^(.+?):(\d+)(?::(\d+))?:\s*(?:(fatal error|error|warning|note|info|style)(?:\[([^\]]+)\])?\s*:?\s*)?(.*)$/i;

/** gcc-style `file:line[:col]: [error|warning][code]: message`, tsc-style `file(line,col): error TS1: message`. */
export function parseCompilerLines(
	output: string,
	source: string,
	root: string,
	defaultSeverity: DiagnosticSeverity = "error",
): Diagnostic[] {
	const out: Diagnostic[] = [];
	for (const raw of output.split("\n")) {
		const line = raw.replace(/\x1b\[[0-9;]*m/g, "").trimEnd();
		if (!line.trim()) continue;
		const tsc = TSC_LINE.exec(line);
		if (tsc) {
			out.push({
				file: toProjectPath(tsc[1].trim(), root),
				line: Number(tsc[2]),
				col: Number(tsc[3]),
				severity: tsc[4] === "warning" ? "warning" : "error",
				code: tsc[5],
				message: clipMessage(tsc[6]),
				source,
			});
			continue;
		}
		const gcc = GCC_LINE.exec(line);
		if (!gcc) continue;
		const file = gcc[1].trim();
		// Avoid matching prose such as "Note: 3 things" or URLs.
		if (/\s/.test(file) && !existsSync(resolve(root, file))) continue;
		if (/^[a-z]+$/i.test(file) && !existsSync(resolve(root, file))) continue;
		const level = gcc[4]?.toLowerCase();
		if (level === "note" || level === "info") continue;
		const severity: DiagnosticSeverity =
			level === "warning" || level === "style" ? "warning" : level ? "error" : defaultSeverity;
		let message = gcc[6].trim();
		let code = gcc[5];
		// ruff: "F401 [*] `os` imported but unused"; shellcheck gcc: "message [SC2086]".
		const lead = /^([A-Z]{1,4}\d{2,5})\s+(?:\[\*\]\s+)?(.*)$/.exec(message);
		if (!code && lead) {
			code = lead[1];
			message = lead[2];
		}
		const trail = /^(.*)\s\[(SC\d+)\]$/.exec(message);
		if (!code && trail) {
			code = trail[2];
			message = trail[1];
		}
		out.push({
			file: toProjectPath(file, root),
			line: Number(gcc[2]),
			...(gcc[3] ? { col: Number(gcc[3]) } : {}),
			severity,
			...(code ? { code } : {}),
			message: clipMessage(message),
			source,
		});
	}
	return out;
}

/** Python tracebacks (`File "x", line N` then `SyntaxError: msg`). */
function parsePythonSyntax(output: string, source: string, absPath: string, root: string): Diagnostic[] {
	const lines = output.split("\n").filter((line) => line.trim());
	let lineNo = 0;
	for (const line of lines) {
		const match = /File "([^"]+)", line (\d+)/.exec(line);
		if (match) lineNo = Number(match[2]);
	}
	const last = lines.findLast((line) => /^\w*(Error|Exception)\b/.test(line.trim()));
	if (!last) return [];
	const match = /^(\w+):\s*(.*)$/.exec(last.trim());
	return [
		{
			file: toProjectPath(absPath, root),
			line: lineNo,
			severity: "error",
			code: match?.[1],
			message: clipMessage(match?.[2] ?? last),
			source,
		},
	];
}

/** eslint --format json. "File ignored" notices are dropped. */
function parseEslintJson(output: string, root: string): Diagnostic[] {
	const start = output.indexOf("[");
	if (start < 0) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(output.slice(start));
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) return [];
	const out: Diagnostic[] = [];
	for (const file of parsed as Array<{ filePath?: string; messages?: unknown[] }>) {
		for (const raw of file.messages ?? []) {
			const message = raw as {
				line?: number;
				column?: number;
				message?: string;
				ruleId?: string;
				severity?: number;
			};
			if (!message.message || /^File ignored/.test(message.message)) continue;
			out.push({
				file: toProjectPath(file.filePath ?? "", root),
				line: message.line ?? 0,
				...(message.column ? { col: message.column } : {}),
				severity: message.severity === 2 ? "error" : "warning",
				...(message.ruleId ? { code: message.ruleId } : {}),
				message: clipMessage(message.message),
				source: "eslint",
			});
		}
	}
	return out;
}

/** Ruff codes that mean broken code rather than style: E9 (syntax/io), F63, F7, F82 (undefined names). */
function ruffSeverity(code: string | undefined): DiagnosticSeverity {
	if (!code) return "error";
	return /^(E9|F63|F7|F82|invalid-syntax)/.test(code) ? "error" : "warning";
}

/**
 * Any of the formats above. A checker that failed without output we can read gives one diagnostic built from its
 * first error-looking line, so a broken file is never reported as clean.
 */
export function parseAnyFormat(
	output: string,
	exitCode: number,
	source: string,
	absPath: string,
	root: string,
): Diagnostic[] {
	const github = parseGithub(output, source, root);
	if (github.length > 0) return github;
	const compiler = parseCompilerLines(output, source, root);
	if (compiler.length > 0) return compiler;
	const python = parsePythonSyntax(output, source, absPath, root);
	if (python.length > 0) return python;
	if (exitCode === 0) return [];
	const first =
		output
			.split("\n")
			.map((line) => line.trim())
			.find((line) => /error|fail|invalid|unexpected/i.test(line)) ??
		output
			.split("\n")
			.map((line) => line.trim())
			.find(Boolean);
	if (!first) return [];
	return [{ file: toProjectPath(absPath, root), line: 0, severity: "error", message: clipMessage(first), source }];
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

const JS_TS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);
const TS = new Set([".ts", ".tsx", ".mts", ".cts"]);
const PLAIN_JS = new Set([".js", ".mjs", ".cjs"]);
const BIOME_EXTRA = new Set([".json", ".jsonc", ".css"]);
const SHELL = new Set([".sh", ".bash"]);

const pathCache = new Map<string, string | undefined>();

/** An executable on PATH (cached), or undefined. */
export function whichOnPath(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
	const key = `${name}\0${env.PATH ?? ""}`;
	if (pathCache.has(key)) return pathCache.get(key);
	const exts = process.platform === "win32" ? (env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
	let found: string | undefined;
	for (const dir of (env.PATH ?? "").split(delimiter)) {
		if (!dir) continue;
		for (const ext of exts) {
			const candidate = join(dir, name + ext);
			if (existsSync(candidate)) {
				found = candidate;
				break;
			}
		}
		if (found) break;
	}
	pathCache.set(key, found);
	return found;
}

/** The nearest ancestor of `start` (up to and including `root`) that contains `name`. */
export function findUp(start: string, root: string, name: string): string | undefined {
	let dir = start;
	for (;;) {
		const candidate = join(dir, name);
		if (existsSync(candidate)) return candidate;
		if (dir === root) return undefined;
		const parent = dirname(dir);
		if (parent === dir || relative(root, parent).startsWith("..")) return undefined;
		dir = parent;
	}
}

/** A project-local node binary, e.g. node_modules/.bin/biome, looked up from the file's folder to the root. */
function localBin(start: string, root: string, name: string): string | undefined {
	const suffix = process.platform === "win32" ? ".cmd" : "";
	return findUp(start, root, join("node_modules", ".bin", name + suffix));
}

function hasEslintConfig(start: string, root: string): boolean {
	const names = [
		"eslint.config.js",
		"eslint.config.mjs",
		"eslint.config.cjs",
		"eslint.config.ts",
		".eslintrc",
		".eslintrc.js",
		".eslintrc.cjs",
		".eslintrc.json",
		".eslintrc.yml",
		".eslintrc.yaml",
	];
	if (names.some((name) => findUp(start, root, name))) return true;
	const pkg = findUp(start, root, "package.json");
	if (!pkg) return false;
	try {
		return "eslintConfig" in (JSON.parse(readFileSync(pkg, "utf8")) as object);
	} catch {
		return false;
	}
}

function isShellScript(absPath: string): boolean {
	if (SHELL.has(extname(absPath))) return true;
	if (extname(absPath)) return false;
	try {
		const head = readFileSync(absPath, "utf8").slice(0, 80);
		return /^#!.*\b(ba)?sh\b/.test(head);
	} catch {
		return false;
	}
}

function jsonChecker(): CheckerSpec {
	return {
		id: "json",
		kind: "auto",
		scope: "file",
		command: "",
		args: [],
		inline: (absPath) => {
			let text: string;
			try {
				text = readFileSync(absPath, "utf8");
			} catch {
				return [];
			}
			try {
				JSON.parse(text.replace(/^\uFEFF/, ""));
				return [];
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				const offset = jsonErrorOffset(text.replace(/^\uFEFF/, ""));
				const line = offset === undefined ? 0 : text.slice(0, offset).split("\n").length;
				return [{ file: absPath, line, severity: "error", message: clipMessage(message), source: "json" }];
			}
		},
		parse: () => [],
	};
}

/**
 * Where JSON.parse fails, found by bisection: a prefix that fails only at its very end is still valid so far.
 * (Node 22 messages carry no position.)
 */
function jsonErrorOffset(text: string): number | undefined {
	if (text.length > 2_000_000) return undefined;
	const failsEarly = (length: number) => {
		try {
			JSON.parse(text.slice(0, length));
			return false;
		} catch (error) {
			const message = error instanceof Error ? error.message : "";
			if (/end of (JSON )?input/i.test(message)) return false;
			// "... at position N": N at the end of the prefix means it only ran out of text.
			const position = /at position (\d+)/.exec(message);
			return position ? Number(position[1]) < length : true;
		}
	};
	if (!failsEarly(text.length)) return undefined;
	let low = 0;
	let high = text.length;
	while (low < high) {
		const mid = (low + high) >> 1;
		if (failsEarly(mid)) high = mid;
		else low = mid + 1;
	}
	return Math.max(0, low - 1);
}

type StripTypes = (code: string, options?: { mode?: "strip" | "transform" }) => string;

/** Node's built-in TypeScript stripper (Node >= 22.13), without its experimental warning. */
function stripTypes(code: string): string {
	const strip = (nodeModule as unknown as { stripTypeScriptTypes?: StripTypes }).stripTypeScriptTypes;
	if (!strip) throw new Error("unavailable");
	const original = process.emitWarning;
	process.emitWarning = (() => {}) as typeof process.emitWarning;
	try {
		return strip(code, { mode: "transform" });
	} finally {
		process.emitWarning = original;
	}
}

/**
 * TypeScript syntax check for projects with neither biome/eslint nor tsc: Node's own type stripper, then
 * `node --check` on the result. Syntax only; the stripper's own errors carry no line number.
 */
function tsSyntaxChecker(): CheckerSpec {
	return {
		id: "ts-syntax",
		kind: "auto",
		scope: "file",
		command: "",
		args: [],
		inline: (absPath) => {
			let source: string;
			try {
				source = readFileSync(absPath, "utf8");
			} catch {
				return [];
			}
			let js: string;
			try {
				js = stripTypes(source);
			} catch (error) {
				const code = (error as { code?: string }).code;
				if (code !== "ERR_INVALID_TYPESCRIPT_SYNTAX") return [];
				const message = error instanceof Error ? error.message : String(error);
				return [{ file: absPath, line: 0, severity: "error", message: clipMessage(message), source: "ts-syntax" }];
			}
			const node = getNodeExecutable();
			if (!node) return [];
			const dir = mkdtempSync(join(tmpdir(), "runkiln-ts-check-"));
			try {
				const file = join(dir, `${basename(absPath).replace(/\.[cm]?tsx?$/, "")}.mjs`);
				writeFileSync(file, js);
				const run = spawnSync(node, ["--check", file], { encoding: "utf8", timeout: 4000 });
				if (run.status === 0 || run.status === null) return [];
				const output = `${run.stderr ?? ""}${run.stdout ?? ""}`;
				// Same line numbers: transform mode keeps lines in place.
				return parseNodeCheck(output.replaceAll(file, absPath), run.status, absPath, dirname(absPath)).map((d) => ({
					...d,
					file: absPath,
					source: "ts-syntax",
				}));
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		},
		parse: () => [],
	};
}

export interface DetectOptions {
	/** Checker ids to leave out (e.g. tsc after it proved slow). */
	skip?: ReadonlySet<string>;
	env?: NodeJS.ProcessEnv;
}

/** The auto-detected checkers for a file, in the order they are reported. */
export function detectCheckers(absPath: string, root: string, options: DetectOptions = {}): CheckerSpec[] {
	const skip = options.skip ?? new Set<string>();
	const env = options.env ?? process.env;
	const dir = dirname(absPath);
	const ext = extname(absPath).toLowerCase();
	const name = basename(absPath);
	const checkers: CheckerSpec[] = [];
	const add = (spec: CheckerSpec) => {
		if (!skip.has(spec.id)) checkers.push(spec);
	};

	if (JS_TS.has(ext) || BIOME_EXTRA.has(ext)) {
		const biome = localBin(dir, root, "biome");
		const biomeConfig = findUp(dir, root, "biome.json") ?? findUp(dir, root, "biome.jsonc");
		const eslint = JS_TS.has(ext) ? localBin(dir, root, "eslint") : undefined;
		const linted = !!(biome && biomeConfig) || !!(eslint && hasEslintConfig(dir, root));
		if (biome && biomeConfig) {
			add({
				id: "biome",
				kind: "auto",
				scope: "file",
				command: biome,
				args: ["lint", "--reporter=github", "--max-diagnostics=50", "--no-errors-on-unmatched", absPath],
				parse: (output, _code, _abs, projectRoot) => parseGithub(output, "biome", projectRoot),
			});
		} else if (eslint && hasEslintConfig(dir, root)) {
			add({
				id: "eslint",
				kind: "auto",
				scope: "file",
				command: eslint,
				args: ["--format", "json", absPath],
				parse: (output, _code, _abs, projectRoot) => parseEslintJson(output, projectRoot),
			});
		} else if (PLAIN_JS.has(ext) && getNodeExecutable()) {
			add({
				id: "node",
				kind: "auto",
				scope: "file",
				command: getNodeExecutable() ?? "node",
				args: ["--check", absPath],
				parse: (output, code, abs, projectRoot) => parseNodeCheck(output, code, abs, projectRoot),
			});
		} else if (ext === ".json" && !/^(ts|js)config.*\.json$/.test(name) && !absPath.includes(`${sep}.vscode${sep}`)) {
			add(jsonChecker());
		}
		const tsconfig = TS.has(ext) ? join(root, "tsconfig.json") : undefined;
		const tsc = tsconfig && existsSync(tsconfig) ? localBin(root, root, "tsc") : undefined;
		if (TS.has(ext) && ext !== ".tsx" && !linted && (!tsc || skip.has("tsc"))) add(tsSyntaxChecker());
		if (tsc && tsconfig) {
			add({
				id: "tsc",
				kind: "auto",
				scope: "project",
				command: tsc,
				args: ["--noEmit", "-p", tsconfig, "--pretty", "false"],
				parse: (output, _code, _abs, projectRoot) => parseCompilerLines(output, "tsc", projectRoot),
			});
		}
	} else if (ext === ".py" || ext === ".pyi") {
		const ruff = findUp(dir, root, join(".venv", "bin", "ruff")) ?? whichOnPath("ruff", env);
		if (ruff) {
			add({
				id: "ruff",
				kind: "auto",
				scope: "file",
				command: ruff,
				args: ["check", "--output-format=concise", "--no-fix", "--quiet", absPath],
				parse: (output, _code, _abs, projectRoot) =>
					parseCompilerLines(output, "ruff", projectRoot).map((d) => ({ ...d, severity: ruffSeverity(d.code) })),
			});
		} else {
			const python = whichOnPath("python3", env) ?? whichOnPath("python", env);
			if (python) {
				// Same check as `python -m py_compile` without writing __pycache__.
				add({
					id: "python",
					kind: "auto",
					scope: "file",
					command: python,
					args: ["-c", "import ast,sys;ast.parse(open(sys.argv[1],'rb').read(),sys.argv[1])", absPath],
					parse: (output, _code, abs, projectRoot) => parsePythonSyntax(output, "python", abs, projectRoot),
				});
			}
		}
	} else if (ext === ".go") {
		const gofmt = whichOnPath("gofmt", env);
		if (gofmt) {
			add({
				id: "gofmt",
				kind: "auto",
				scope: "file",
				command: gofmt,
				args: ["-l", "-e", absPath],
				// -l also lists unformatted files; only the syntax errors count.
				parse: (output, _code, _abs, projectRoot) =>
					parseCompilerLines(output, "gofmt", projectRoot).filter((d) => d.line > 0),
			});
		}
		const go = whichOnPath("go", env);
		if (go && findUp(dir, root, "go.mod")) {
			const rel = toProjectPath(dir, root);
			add({
				id: "go vet",
				kind: "auto",
				scope: "project",
				command: go,
				args: ["vet", rel === "" || rel === "." ? "." : `./${rel}`],
				parse: (output, _code, _abs, projectRoot) =>
					parseCompilerLines(output.replace(/^vet: /gm, ""), "go vet", projectRoot),
			});
		}
	} else if (ext === ".rs") {
		const cargo = whichOnPath("cargo", env);
		const manifest = findUp(dir, root, "Cargo.toml");
		if (cargo && manifest) {
			add({
				id: "cargo",
				kind: "auto",
				scope: "project",
				command: cargo,
				args: ["check", "--message-format", "short", "--quiet", "--manifest-path", manifest],
				parse: (output, _code, _abs, projectRoot) =>
					parseCompilerLines(output, "cargo", projectRoot).filter((d) => !/^aborting due to/.test(d.message)),
			});
		}
	} else if (isShellScript(absPath)) {
		const shellcheck = whichOnPath("shellcheck", env);
		if (shellcheck) {
			add({
				id: "shellcheck",
				kind: "auto",
				scope: "file",
				command: shellcheck,
				args: ["-f", "gcc", "-S", "warning", absPath],
				parse: (output, _code, _abs, projectRoot) => parseCompilerLines(output, "shellcheck", projectRoot),
			});
		} else {
			const bash = whichOnPath("bash", env);
			if (bash) {
				add({
					id: "bash",
					kind: "auto",
					scope: "file",
					command: bash,
					args: ["-n", absPath],
					parse: (output, code, abs, projectRoot) => parseBashSyntax(output, code, abs, projectRoot),
				});
			}
		}
	}
	return checkers;
}

function parseNodeCheck(output: string, code: number, absPath: string, root: string): Diagnostic[] {
	if (code === 0) return [];
	const location = new RegExp(`${escapeRegExp(absPath)}:(\\d+)`).exec(output);
	const errorLine = output.split("\n").find((line) => /^\w*Error\b/.test(line.trim()));
	return [
		{
			file: toProjectPath(absPath, root),
			line: location ? Number(location[1]) : 0,
			severity: "error",
			...(errorLine ? { code: errorLine.trim().split(":")[0] } : {}),
			message: clipMessage(errorLine ? errorLine.trim().replace(/^\w+:\s*/, "") : output.trim().split("\n")[0]),
			source: "node",
		},
	];
}

function parseBashSyntax(output: string, code: number, absPath: string, root: string): Diagnostic[] {
	if (code === 0) return [];
	const out: Diagnostic[] = [];
	for (const line of output.split("\n")) {
		const match = /line (\d+): (.*)$/.exec(line);
		if (match) {
			out.push({
				file: toProjectPath(absPath, root),
				line: Number(match[1]),
				severity: "error",
				message: clipMessage(match[2]),
				source: "bash",
			});
		}
	}
	return out;
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Configured checks for the file: `checks.commands` globs matched against the project-relative path. */
export function configuredCheckers(
	absPath: string,
	root: string,
	commands: Readonly<Record<string, string>> | undefined,
): CheckerSpec[] {
	if (!commands) return [];
	const rel = toProjectPath(absPath, root);
	const out: CheckerSpec[] = [];
	for (const [glob, command] of Object.entries(commands)) {
		if (typeof command !== "string" || !command.trim()) continue;
		const matches =
			minimatch(rel, glob, { dot: true, matchBase: !glob.includes("/") }) ||
			minimatch(basename(rel), glob, { dot: true });
		if (!matches) continue;
		const line = command.includes("{file}")
			? command.replaceAll("{file}", shellQuote(rel))
			: `${command} ${shellQuote(rel)}`;
		out.push({
			id: command.trim().split(/\s+/)[0],
			kind: "configured",
			scope: "file",
			command: line,
			args: [],
			shell: true,
			parse: (output, code, abs, projectRoot) =>
				parseAnyFormat(output, code, command.trim().split(/\s+/)[0], abs, projectRoot),
		});
	}
	return out;
}

export function shellQuote(value: string): string {
	if (/^[\w@%+=:,./-]+$/.test(value)) return value;
	if (process.platform === "win32") return `"${value.replace(/"/g, '""')}"`;
	return `'${value.replace(/'/g, "'\\''")}'`;
}

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

export interface SpawnResult {
	output: string;
	code: number;
	timedOut: boolean;
	/** The command could not start (not installed). */
	failedToStart: boolean;
	durationMs: number;
}

const MAX_CAPTURE_BYTES = 512 * 1024;

/** Runs a command with a timeout; stdout and stderr are interleaved. Never throws. */
export function runCommand(
	command: string,
	args: string[],
	options: { cwd: string; timeoutMs: number; shell?: boolean; signal?: AbortSignal; env?: NodeJS.ProcessEnv },
): Promise<SpawnResult> {
	const started = Date.now();
	return new Promise((resolveResult) => {
		let output = "";
		let bytes = 0;
		let timedOut = false;
		let settled = false;
		const finish = (result: Omit<SpawnResult, "durationMs">) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", onAbort);
			resolveResult({ ...result, durationMs: Date.now() - started });
		};
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(command, args, {
				cwd: options.cwd,
				shell: options.shell ?? false,
				stdio: ["ignore", "pipe", "pipe"],
				env: { ...(options.env ?? process.env), NO_COLOR: "1", FORCE_COLOR: "0", CI: "1" },
				detached: process.platform !== "win32",
				windowsHide: true,
			});
		} catch {
			resolveResult({ output: "", code: -1, timedOut: false, failedToStart: true, durationMs: 0 });
			return;
		}
		const kill = () => {
			try {
				if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
				else child.kill("SIGKILL");
			} catch {
				// Already gone.
			}
		};
		const onAbort = () => {
			kill();
			finish({ output, code: -1, timedOut: false, failedToStart: false });
		};
		const timer = setTimeout(() => {
			timedOut = true;
			kill();
			finish({ output, code: -1, timedOut: true, failedToStart: false });
		}, options.timeoutMs);
		options.signal?.addEventListener("abort", onAbort, { once: true });
		const collect = (chunk: Buffer) => {
			if (bytes >= MAX_CAPTURE_BYTES) return;
			bytes += chunk.length;
			output += chunk.toString("utf8");
		};
		child.stdout?.on("data", collect);
		child.stderr?.on("data", collect);
		child.on("error", () => finish({ output, code: -1, timedOut: false, failedToStart: true }));
		child.on("close", (code) =>
			finish({ output, code: code ?? (timedOut ? -1 : 1), timedOut, failedToStart: false }),
		);
	});
}

/** Runs the checkers for one file in parallel and returns that file's diagnostics. */
export async function runCheckers(
	checkers: readonly CheckerSpec[],
	absPath: string,
	root: string,
	options: { timeoutMs: number; signal?: AbortSignal },
): Promise<RunCheckResult> {
	const target = toProjectPath(absPath, root);
	const result: RunCheckResult = { diagnostics: [], ran: [], timedOut: [], durations: {} };
	const outcomes = await Promise.all(
		checkers.map(async (checker) => {
			if (checker.inline) {
				const started = Date.now();
				const found = checker.inline(absPath).map((d) => ({ ...d, file: toProjectPath(d.file, root) }));
				return { checker, found, run: { timedOut: false, failedToStart: false, durationMs: Date.now() - started } };
			}
			const run = await runCommand(checker.command, checker.args, {
				cwd: root,
				timeoutMs: options.timeoutMs,
				shell: checker.shell,
				signal: options.signal,
			});
			if (run.timedOut || run.failedToStart) return { checker, found: [] as Diagnostic[], run };
			return { checker, found: checker.parse(run.output, run.code, absPath, root), run };
		}),
	);
	for (const { checker, found, run } of outcomes) {
		result.durations[checker.id] = run.durationMs;
		if (run.timedOut) {
			result.timedOut.push(checker.id);
			continue;
		}
		if (run.failedToStart) continue;
		result.ran.push(checker.id);
		// Project-wide checkers report other files too; keep this file's. A configured check that
		// printed no usable path (line 0) is about the file it was given.
		for (const diagnostic of found) {
			if (diagnostic.file === target || (checker.scope === "file" && diagnostic.line === 0)) {
				result.diagnostics.push({ ...diagnostic, file: target });
			}
		}
	}
	return result;
}

/** Diagnostics in `after` that were not in `before`. Line numbers are ignored (edits shift them). */
export function newDiagnostics(before: readonly Diagnostic[], after: readonly Diagnostic[]): Diagnostic[] {
	const key = (d: Diagnostic) => `${d.source}\0${d.severity}\0${d.code ?? ""}\0${d.message}`;
	const counts = new Map<string, number>();
	for (const d of before) counts.set(key(d), (counts.get(key(d)) ?? 0) + 1);
	const fresh: Diagnostic[] = [];
	for (const d of after) {
		const left = counts.get(key(d)) ?? 0;
		if (left > 0) counts.set(key(d), left - 1);
		else fresh.push(d);
	}
	return fresh;
}
