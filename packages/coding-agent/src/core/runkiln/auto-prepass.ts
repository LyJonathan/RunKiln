/**
 * The local pre-pass of auto permissions: calls that are obviously routine run without a model call, so auto mode is
 * fast on the calls a coding agent makes most. Anything the pre-pass does not recognize goes to the decision model;
 * risky calls (permissions.ts riskReasons) never reach the pre-pass, they always ask.
 *
 * Allowed without a model call:
 * - the genuine write and edit tools on an ordinary file inside the project (what read & write mode runs too);
 * - shell commands whose every part is read-only inspection: `git status|diff|log|show|blame|ls-files|rev-parse|…`
 *   (plain listing forms only), `ls`, `pwd`, `cat|head|tail|wc|stat|file` of files inside the project, `echo`,
 *   `which`, `find` without -exec/-delete, `grep`/`rg` without in-place flags, `--version` checks;
 * - the project's own test, lint, type-check, format and build scripts: `npm test`, `npm run lint`, `pnpm build`,
 *   `yarn typecheck`, … when package.json defines that script, and the usual direct runners (`tsc --noEmit`,
 *   `cargo test|check|build|clippy|fmt`, `go test|build|vet`, `pytest`, `make test|check|lint`).
 *
 * Never pre-allowed: `npx`, `pnpx`, `bunx` and `pnpm|yarn dlx` (they can download a package and run it), and a runner
 * command after the agent changed one of the runner's input files (test files, runner config, build scripts) since
 * the last runner command ran (write-then-run; see isRunnerCommand and isRunnerInput, used by permissions.ts).
 *
 * A part with command substitution, a redirect to a file (other than /dev/null), or a path outside the project is never
 * pre-allowed. The pre-pass never denies: what it does not allow goes on to the next step.
 */

import { readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { resolveToCwd } from "../tools/path-utils.ts";
import {
	analyzeShellCommand,
	isInsideProject,
	powershellUnsafe,
	protectedProjectReason,
	SHELL_TOOLS,
	type ToolCallOptions,
	WRITE_TOOLS,
} from "./approval.ts";

export interface PrepassVerdict {
	decision: "allow";
	category: string;
	reason: string;
}

/** Script names that check or build the project (prefix match: test:unit, lint:fix, build:prod, …). */
const CHECK_SCRIPT =
	/^(test|tests|unit|e2e|lint|eslint|check|checks|typecheck|type-check|types|tsc|format|fmt|prettier|biome|build|compile|verify|ci)(:[\w:.-]+)?$/i;

const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun"]);

const READ_ONLY_GIT = new Set([
	"status",
	"diff",
	"log",
	"show",
	"blame",
	"ls-files",
	"ls-tree",
	"rev-parse",
	"describe",
	"shortlog",
	"reflog",
	"grep",
	"cat-file",
	"whatchanged",
	"merge-base",
	"count-objects",
]);

/** Programs that only read when given in-project paths (or none). */
const READ_ONLY_PROGRAMS = new Set([
	"ls",
	"pwd",
	"cat",
	"head",
	"tail",
	"wc",
	"stat",
	"file",
	"echo",
	"which",
	"type",
	"tree",
	"du",
	"grep",
	"egrep",
	"rg",
	"find",
	"sort",
	"uniq",
	"cut",
	"tr",
	"basename",
	"dirname",
	"realpath",
	"date",
	"true",
	"test",
	"diff",
	"cmp",
	"jq",
]);

interface PackageScripts {
	scripts: Set<string>;
	readAt: number;
}

const scriptCache = new Map<string, PackageScripts>();

/** The script names of the project's package.json (cached for a few seconds), or an empty set. */
export function packageScripts(cwd: string): Set<string> {
	const key = resolve(cwd);
	const cached = scriptCache.get(key);
	if (cached && Date.now() - cached.readAt < 5000) return cached.scripts;
	let scripts = new Set<string>();
	try {
		const parsed = JSON.parse(readFileSync(join(key, "package.json"), "utf8")) as { scripts?: unknown };
		if (parsed.scripts && typeof parsed.scripts === "object") scripts = new Set(Object.keys(parsed.scripts));
	} catch {
		// No package.json, or not JSON.
	}
	scriptCache.set(key, { scripts, readAt: Date.now() });
	return scripts;
}

function wordsOf(segment: string): string[] {
	const words = segment.trim().split(/\s+/).filter(Boolean);
	while (words.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) words.shift();
	return words;
}

function hasFileRedirect(words: readonly string[]): boolean {
	for (let i = 0; i < words.length; i++) {
		if (/^\d*(>|>>|>\||&>|&>>)$/.test(words[i])) {
			const target = words[i + 1] ?? "";
			if (!/^\/dev\/(null|stdout|stderr)$/.test(target)) return true;
		}
	}
	return false;
}

function pathArgsInside(words: readonly string[], cwd: string): boolean {
	for (const word of words) {
		if (word.startsWith("-") || word === "<") continue;
		if (word.includes("/") || word.startsWith("~") || word.startsWith(".")) {
			const target = resolveToCwd(word, cwd);
			if (!isInsideProject(target, cwd)) return false;
		}
	}
	return true;
}

/** Why one shell part is routine, or undefined. */
function routineSegment(segment: string, cwd: string, scripts: Set<string>): string | undefined {
	const words = wordsOf(segment);
	if (words.length === 0 || hasFileRedirect(words)) return undefined;
	const [program, sub, third] = words;
	const rest = words.slice(1);
	if (words.length === 2 && (sub === "--version" || sub === "-v" || sub === "-V")) return "version check";
	if (program === "git") {
		if (!sub) return undefined;
		if (READ_ONLY_GIT.has(sub)) {
			if (rest.some((word) => /^--(output|ext-diff|exec)/.test(word))) return undefined;
			return "read-only git";
		}
		if (
			sub === "branch" &&
			rest
				.slice(1)
				.every((word) =>
					/^(-a|-r|-v|-vv|--list|--show-current|--all|--remotes|--verbose|--no-color|--color)$/.test(word),
				)
		) {
			return "read-only git";
		}
		if (
			sub === "remote" &&
			rest.slice(1).every((word) => word === "-v" || word === "show" || word === "get-url" || !word.startsWith("-"))
		) {
			if (rest.length === 1 || rest[1] === "-v") return "read-only git";
		}
		if (sub === "stash" && third === "list") return "read-only git";
		if (sub === "tag" && rest.length === 1) return "read-only git";
		return undefined;
	}
	if (READ_ONLY_PROGRAMS.has(program)) {
		if (program === "find" && rest.some((word) => /^-(exec|execdir|ok|okdir|delete|fprint|fprintf|fls)$/.test(word)))
			return undefined;
		if ((program === "grep" || program === "rg") && rest.some((word) => /^--(pre|replace)/.test(word)))
			return undefined;
		if (program === "sort" && rest.some((word) => word === "-o" || word.startsWith("--output"))) return undefined;
		if (!pathArgsInside(rest, cwd)) return undefined;
		return "read-only inspection";
	}
	if (PACKAGE_MANAGERS.has(program)) {
		let script: string | undefined;
		if (sub === "run" || sub === "run-script") script = third;
		else if (sub === "test" || sub === "t") script = "test";
		else if (program !== "npm" && sub && scripts.has(sub)) script = sub; // `pnpm lint`, `yarn build`
		if (script && scripts.has(script) && CHECK_SCRIPT.test(script)) return "project test, lint or build script";
		return undefined;
	}
	// npx, pnpx, bunx and dlx can download and run a package, so they always go to the decision model.
	if (program === "tsc" && (rest.includes("--noEmit") || rest.length === 0 || rest[0] === "-p")) return "type check";
	if (program === "cargo" && sub && ["test", "check", "build", "clippy", "fmt", "doc", "bench"].includes(sub))
		return "project test, lint or build";
	if (program === "go" && sub && ["test", "build", "vet", "fmt"].includes(sub)) return "project test, lint or build";
	if ((program === "pytest" || program === "ruff" || program === "mypy") && !rest.includes("--fix"))
		return "project test or lint";
	if (
		(program === "python" || program === "python3") &&
		sub === "-m" &&
		(third === "pytest" || third === "unittest" || third === "mypy")
	)
		return "project tests";
	if (
		program === "make" &&
		(rest.length === 0 || (rest.length === 1 && /^(test|check|lint|build|all)$/.test(rest[0])))
	)
		return "project test, lint or build";
	return undefined;
}

/**
 * Whether the call is obviously routine. Call it only for calls with no risk reasons (riskReasons(...) is empty).
 */
export function autoPrepass(
	toolName: string,
	args: unknown,
	cwd: string,
	options: ToolCallOptions = {},
): PrepassVerdict | undefined {
	const input = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
	if (WRITE_TOOLS.has(toolName)) {
		if (options.builtin !== true) return undefined;
		const raw = typeof input.path === "string" ? input.path : "";
		if (!raw) return undefined;
		const target = resolveToCwd(raw, cwd);
		if (!isInsideProject(target, cwd) || protectedProjectReason(relative(resolve(cwd), resolve(target))))
			return undefined;
		return {
			decision: "allow",
			category: "routine project work",
			reason: "edits an ordinary file inside the project",
		};
	}
	if (!SHELL_TOOLS.has(toolName)) return undefined;
	const command = typeof input.command === "string" ? input.command : "";
	if (powershellUnsafe(toolName, command)) return undefined;
	const analysis = analyzeShellCommand(command, cwd);
	if (analysis.segments.length === 0 || analysis.substitutions.length > 0) return undefined;
	if (analysis.writesOutside.length > 0 || analysis.pathsOutside.length > 0) return undefined;
	// cd inside the project is harmless, but only as a step before other routine parts.
	const scripts = packageScripts(cwd);
	const reasons: string[] = [];
	for (const segment of analysis.segments) {
		const words = wordsOf(segment);
		if (words[0] === "cd" && words.length <= 2 && pathArgsInside(words.slice(1), cwd)) continue;
		const reason = routineSegment(segment, cwd, scripts);
		if (!reason) return undefined;
		if (!reasons.includes(reason)) reasons.push(reason);
	}
	if (reasons.length === 0) return undefined;
	return { decision: "allow", category: "routine project work", reason: reasons.join(", ") };
}

// ---------------------------------------------------------------------------
// Write-then-run
// ---------------------------------------------------------------------------

/**
 * Project files a test, lint or build runner executes or loads as code: test files, runner and tool config, Python
 * test hooks, build scripts and package.json. An edit to one of them followed by a runner command is arbitrary code
 * execution, so that runner command is not pre-allowed (permissions.ts).
 */
const RUNNER_INPUT = new RegExp(
	[
		String.raw`(^|/)(test|tests|__tests__|spec|specs|e2e|testing)/`,
		String.raw`\.(test|spec|e2e|bench)\.[cm]?[jt]sx?$`,
		String.raw`(^|/)test_[^/]*\.py$`,
		String.raw`_test\.(py|go)$`,
		String.raw`(^|/)[^/]+\.config\.[^/]+$`,
		String.raw`(^|/)(vitest\.(workspace|setup)|jest\.setup|setupTests)\.[^/]+$`,
		String.raw`(^|/)\.(eslintrc|babelrc|mocharc|swcrc|prettierrc)(\.[^/]+)?$`,
		String.raw`(^|/)(conftest\.py|pyproject\.toml|setup\.py|setup\.cfg|pytest\.ini|tox\.ini|noxfile\.py)$`,
		String.raw`(^|/)(GNUmakefile|makefile|[^/]+\.mk|justfile|Taskfile\.ya?ml|Rakefile|build\.rs|build\.gradle(\.kts)?|pom\.xml|CMakeLists\.txt)$`,
		String.raw`(^|/)\.cargo/config(\.toml)?$`,
		String.raw`(^|/)(package\.json|tsconfig[^/]*\.json|\.npmrc|\.yarnrc(\.ya?ml)?|\.pnpmfile\.c?js|bunfig\.toml)$`,
	].join("|"),
	"i",
);

/** Whether a project-relative path (either separator) is an input a runner executes (see RUNNER_INPUT). */
export function isRunnerInput(relativePath: string): boolean {
	return RUNNER_INPUT.test(relativePath.split(/[\\/]+/).join("/"));
}

const RUNNER_SUBCOMMANDS: Record<string, RegExp> = {
	npm: /^(test|t|tst|run|run-script|exec|x|start|restart|install-test|it|ci|install|i|rebuild|pack|publish)$/,
	pnpm: /^.+$/,
	yarn: /^.+$/,
	bun: /^.+$/,
	cargo: /^(test|t|build|b|check|c|run|r|bench|clippy|doc|fmt|install)$/,
	go: /^(test|build|run|generate|vet|install)$/,
	dotnet: /^(test|build|run)$/,
	deno: /^(test|task|run|bench)$/,
	python: /^-m$/,
	python3: /^-m$/,
	py: /^-m$/,
	uv: /^(run|pip)$/,
	poetry: /^(run|install)$/,
};

/** Programs that run project code whatever their arguments. */
const RUNNER_PROGRAMS = new Set([
	"npx",
	"pnpx",
	"bunx",
	"vitest",
	"jest",
	"mocha",
	"ava",
	"playwright",
	"pytest",
	"tox",
	"nox",
	"make",
	"gmake",
	"just",
	"task",
	"rake",
	"gradle",
	"gradlew",
	"./gradlew",
	"mvn",
	"./mvnw",
	"cmake",
	"ctest",
	"node",
	"tsx",
	"ts-node",
	"eslint",
	"prettier",
	"biome",
	"webpack",
	"vite",
	"rollup",
	"esbuild",
]);

/**
 * Whether a shell command runs a test, lint or build runner (or another program that executes project files): the
 * commands that execute the files isRunnerInput names.
 */
export function isRunnerCommand(command: string, cwd: string): boolean {
	let segments: string[];
	try {
		segments = analyzeShellCommand(command, cwd).segments;
	} catch {
		return true;
	}
	return segments.some((segment) => {
		const words = wordsOf(segment);
		if (words.length === 0) return false;
		const program = words[0].replace(/\.(exe|cmd|bat)$/i, "").toLowerCase();
		const base = program.split(/[\\/]/).pop() ?? program;
		if (RUNNER_PROGRAMS.has(program) || RUNNER_PROGRAMS.has(base)) return true;
		const sub = RUNNER_SUBCOMMANDS[base];
		return sub !== undefined && words[1] !== undefined && sub.test(words[1].toLowerCase());
	});
}
