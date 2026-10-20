/**
 * The verify loop's test command: detection (package.json test script, pytest, cargo test, go test) and reading
 * a run's output (failing count, a signature to spot the same failure twice, a condensed excerpt for the model).
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { condenseOutput, isErrorLikeLine } from "../tools/condense-output.ts";
import { whichOnPath } from "./diagnostics.ts";

export type TestCommandSource = "setting" | "saved" | "package.json" | "pytest" | "cargo" | "go";

export interface DetectedTestCommand {
	command: string;
	source: TestCommandSource;
}

const NPM_PLACEHOLDER = /no test specified/;

function readJson(path: string): Record<string, unknown> | undefined {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
	} catch {
		return undefined;
	}
}

function packageManager(cwd: string): string {
	if (existsSync(join(cwd, "pnpm-lock.yaml"))) return "pnpm";
	if (existsSync(join(cwd, "yarn.lock"))) return "yarn";
	if (existsSync(join(cwd, "bun.lockb")) || existsSync(join(cwd, "bun.lock"))) return "bun run";
	return "npm";
}

function hasPytest(cwd: string): boolean {
	if (existsSync(join(cwd, "pytest.ini")) || existsSync(join(cwd, "conftest.py"))) return true;
	for (const name of ["pyproject.toml", "setup.cfg", "tox.ini"]) {
		try {
			if (/\[(tool:)?pytest|\[tool\.pytest/.test(readFileSync(join(cwd, name), "utf8"))) return true;
		} catch {
			// Not there.
		}
	}
	for (const dir of ["tests", "test", "."]) {
		try {
			if (readdirSync(join(cwd, dir)).some((name) => /^test_.*\.py$|_test\.py$/.test(name))) return true;
		} catch {
			// Not there.
		}
	}
	return false;
}

/** The project's test command, or undefined when none is found. */
export function detectTestCommand(cwd: string, env: NodeJS.ProcessEnv = process.env): DetectedTestCommand | undefined {
	const pkg = readJson(join(cwd, "package.json"));
	const scripts = pkg?.scripts as Record<string, unknown> | undefined;
	if (typeof scripts?.test === "string" && scripts.test.trim() && !NPM_PLACEHOLDER.test(scripts.test)) {
		return { command: `${packageManager(cwd)} test`, source: "package.json" };
	}
	if (hasPytest(cwd)) {
		const python = whichOnPath("python3", env) ? "python3" : "python";
		return { command: `${python} -m pytest -q`, source: "pytest" };
	}
	if (existsSync(join(cwd, "Cargo.toml"))) return { command: "cargo test -q", source: "cargo" };
	if (existsSync(join(cwd, "go.mod"))) return { command: "go test ./...", source: "go" };
	return undefined;
}

// ---------------------------------------------------------------------------
// Reading a run
// ---------------------------------------------------------------------------

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

export function stripAnsi(text: string): string {
	return text.replace(ANSI, "");
}

/** Failing tests reported by common runners (summed over packages), or undefined when no summary was found. */
export function countFailing(output: string): number | undefined {
	const text = stripAnsi(output);
	const sum = (pattern: RegExp) => {
		let total = 0;
		let found = false;
		for (const match of text.matchAll(pattern)) {
			total += Number(match[1]);
			found = true;
		}
		return found ? total : undefined;
	};
	// vitest "Tests  3 failed | 10 passed", jest "Tests:       3 failed, 10 passed".
	const vitest = sum(/^\s*Tests:?\s+(\d+) failed/gm);
	if (vitest !== undefined) return vitest;
	// cargo "test result: FAILED. 10 passed; 3 failed".
	const cargo = sum(/test result: FAILED\. \d+ passed; (\d+) failed/g);
	if (cargo !== undefined) return cargo;
	// node --test "# fail 3" / "ℹ fail 3".
	const node = sum(/^(?:#|ℹ) fail (\d+)/gm);
	if (node !== undefined) return node;
	// pytest "=== 3 failed, 2 passed in 0.12s ===" (collection errors count too).
	const pytestLine = /^=+ (.*) in [\d.]+s(?: \([^)]*\))? =+$/m.exec(text);
	if (pytestLine) {
		const failed = /(\d+) failed/.exec(pytestLine[1]);
		const errors = /(\d+) errors?/.exec(pytestLine[1]);
		if (failed || errors) return Number(failed?.[1] ?? 0) + Number(errors?.[1] ?? 0);
	}
	// mocha "3 failing".
	const mocha = sum(/^\s*(\d+) failing\b/gm);
	if (mocha !== undefined) return mocha;
	// go "--- FAIL: TestX".
	const goFails = text.match(/^\s*--- FAIL: /gm)?.length;
	if (goFails) return goFails;
	return undefined;
}

/** A stable fingerprint of a failure: its error-looking lines without timings, durations or addresses. */
export function failureSignature(output: string): string {
	const lines = stripAnsi(output)
		.split("\n")
		.filter((line) => isErrorLikeLine(line))
		.map((line) =>
			line
				.replace(/\d+(\.\d+)?\s?(ms|s|sec|seconds)\b/g, "")
				.replace(/0x[0-9a-f]+/gi, "")
				.replace(/\d{2}:\d{2}:\d{2}(\.\d+)?/g, "")
				.replace(/\s+/g, " ")
				.trim(),
		)
		.filter(Boolean);
	const unique = [...new Set(lines)].sort().slice(0, 60);
	return createHash("sha1").update(unique.join("\n")).digest("hex").slice(0, 16);
}

/**
 * Why the test command could not run at all (missing test file, unknown command, nothing collected), or undefined
 * when it ran and failed. Such a failure says nothing about the code, so the verify loop does not hand it to the
 * model: in the A/B bench (r3) a command naming a test file that did not exist sent the model hunting for it for
 * up to 20 turns, and it ended up writing its own test file.
 */
export function commandSetupFailure(output: string, exitCode: number, cwd: string): string | undefined {
	const text = stripAnsi(output);
	if (
		exitCode === 127 ||
		exitCode === 126 ||
		/(?:^|\n|: )(?:\S+: )?command not found\b|is not recognized as an internal or external command/.test(text)
	) {
		return "the test command was not found";
	}
	// node --test: "Could not find '/abs/or/rel/x.test.ts'".
	for (const m of text.matchAll(/Could not find '([^']+)'/g)) {
		if (!existsSync(resolve(cwd, m[1]))) return `the test file ${m[1]} does not exist`;
	}
	// pytest: exit 4 "file or directory not found", exit 5 "no tests ran".
	const pytestMissing = /ERROR: file or directory not found: (\S+)/.exec(text);
	if (pytestMissing) return `the test file ${pytestMissing[1]} does not exist`;
	if (exitCode === 5 && /no tests ran/i.test(text)) return "no tests were collected";
	// unittest: the named test module itself is missing (not a missing import inside it).
	for (const m of text.matchAll(/Failed to import test module: ([\w.]+)[\s\S]*?No module named '([\w.]+)'/g)) {
		if (m[1] === m[2]) return `the test module ${m[1]} does not exist`;
	}
	if (/^NO TESTS RAN\b/m.test(text)) return "no tests were collected";
	// jest / vitest: nothing matched.
	if (/^No tests found, exiting with code 1/m.test(text) || /^No test files found, exiting with code 1/m.test(text)) {
		return "no tests were collected";
	}
	return undefined;
}

export const VERIFY_EXCERPT_MAX_BYTES = 6000;

/** The test output trimmed for the model: head, error lines, tail. */
export function condenseTestOutput(output: string): string {
	const text = stripAnsi(output).replace(/\r/g, "");
	return condenseOutput(text, {
		maxLines: 80,
		maxBytes: VERIFY_EXCERPT_MAX_BYTES,
		headLines: 6,
		tailLines: 30,
		maxErrorLines: 30,
	}).text;
}
