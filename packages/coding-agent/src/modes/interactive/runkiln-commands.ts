/**
 * Text for the RunKiln slash commands that only report: /help, /status, /cost, /doctor, /diff, and the /init prompt.
 * Kept out of interactive-mode.ts so each one can be tested without a terminal. Everything returned is markdown.
 */

import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import { join } from "node:path";
import { type PermissionMode, permissionModeInfo } from "../../core/runkiln/permissions.ts";
import { BUILTIN_SLASH_COMMANDS } from "../../core/slash-commands.ts";

/** Escape a value for a markdown table cell. */
function cell(text: string): string {
	return text.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

export interface HelpCommand {
	name: string;
	description?: string;
	argumentHint?: string;
}

/** /help: every command with its description, then the input shortcuts. */
export function buildHelpMarkdown(input: {
	extra?: HelpCommand[];
	keys: { permissions: string; thinking: string; model: string; routerMode?: string; hotkeysHint?: string };
}): string {
	const rows = BUILTIN_SLASH_COMMANDS.map(
		(command) =>
			`| \`/${command.name}${command.argumentHint ? ` ${command.argumentHint}` : ""}\` | ${cell(command.description)} |`,
	);
	const lines = ["**Commands**", "| Command | What it does |", "|---|---|", ...rows];
	if (input.extra && input.extra.length > 0) {
		lines.push("", "**Prompts, skills and extensions**", "| Command | What it does |", "|---|---|");
		for (const command of input.extra) {
			lines.push(
				`| \`/${command.name}${command.argumentHint ? ` ${command.argumentHint}` : ""}\` | ${cell(command.description ?? "")} |`,
			);
		}
	}
	lines.push(
		"",
		"**Input**",
		"| Type | What it does |",
		"|---|---|",
		"| `/` | Command palette (fuzzy search; Tab completes) |",
		"| `@path` | Mention a file (fuzzy file search); its content is attached |",
		"| `!command` | Run a shell command yourself and add its output to the context |",
		"| `!!command` | Run a shell command without adding it to the context |",
		`| \`${input.keys.permissions}\` | Cycle the permission mode |`,
		`| \`${input.keys.thinking}\` | Cycle the thinking level |`,
		`| \`${input.keys.model}\` | Cycle models |`,
		...(input.keys.routerMode
			? [`| \`${input.keys.routerMode}\` | Cycle the auto routing mode (auto:low/medium/high) |`]
			: []),
		"",
		input.keys.hotkeysHint ?? "",
	);
	return lines.join("\n");
}

export interface StatusInput {
	version: string;
	cwd: string;
	gitBranch?: string | null;
	sessionFile?: string;
	sessionId: string;
	sessionName?: string;
	model: string;
	routing: string;
	thinking: string;
	permissionMode: PermissionMode;
	sessionRules: string[];
	autoBackend?: string;
	runInfraKey: boolean;
	/** Where the model list came from (live / cached RunInfra catalog or models.yaml). */
	catalog?: string;
	/** Routable models without quality curves of their own. */
	unbenched?: string[];
	contextPercent?: number | null;
	contextWindow?: number;
	messages: number;
	cost: number;
	/** Post-edit checks, verify loop and edit misses, one line each. */
	checks?: string;
	verify?: string;
	editMisses?: string;
}

/** /status: one table of what this session runs with. */
export function buildStatusMarkdown(input: StatusInput): string {
	const permission = permissionModeInfo(input.permissionMode);
	const rows: Array<[string, string]> = [
		["Version", `RunKiln ${input.version}`],
		["Project", `${input.cwd}${input.gitBranch ? ` (${input.gitBranch})` : ""}`],
		["Session", `${input.sessionName ? `${input.sessionName} - ` : ""}${input.sessionFile ?? "in memory"}`],
		["Model", input.model],
		["Routing", input.routing],
		["Thinking", input.thinking],
		["Permissions", `${permission.label}: ${permission.description}`],
		[
			"Always allowed",
			input.sessionRules.length > 0
				? input.sessionRules.join("; ")
				: "nothing yet (answer a prompt with “Always allow”)",
		],
		["Auto decision model", input.autoBackend ?? "none (no Jev or OpenRouter key; /setup keys adds one)"],
		["RunInfra key", input.runInfraKey ? "set" : "not set (/setup keys)"],
		...(input.catalog ? ([["Catalog", input.catalog]] as Array<[string, string]>) : []),
		...(input.unbenched && input.unbenched.length > 0
			? ([
					[
						"Unbenched",
						`${input.unbenched.join(", ")} (manual use works; auto picks them only when no benched model fits)`,
					],
				] as Array<[string, string]>)
			: []),
		[
			"Context",
			input.contextPercent === undefined || input.contextPercent === null
				? "unknown until the next reply"
				: `${input.contextPercent.toFixed(1)}% of ${input.contextWindow?.toLocaleString() ?? "?"} tokens`,
		],
		...(input.checks ? ([["Checks after edits", input.checks]] as Array<[string, string]>) : []),
		...(input.verify ? ([["Tests (verify)", input.verify]] as Array<[string, string]>) : []),
		...(input.editMisses ? ([["Edit misses", input.editMisses]] as Array<[string, string]>) : []),
		["Messages", String(input.messages)],
		["Cost", `$${input.cost.toFixed(4)}`],
	];
	return ["| Setting | Value |", "|---|---|", ...rows.map(([key, value]) => `| ${key} | ${cell(value)} |`)].join("\n");
}

export interface CostInput {
	tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
	cost: number;
	breakdown: Array<{ key: string; cost: number; tokens: number }>;
	subscription: boolean;
}

/** /cost: tokens and dollars for the session, per model when more than one ran. */
export function buildCostMarkdown(input: CostInput): string {
	const prompt = input.tokens.input + input.tokens.cacheRead + input.tokens.cacheWrite;
	const hit =
		prompt > 0 && input.tokens.cacheRead > 0
			? ` (${((input.tokens.cacheRead / prompt) * 100).toFixed(1)}% cached)`
			: "";
	const lines = [
		"| | Session |",
		"|---|---|",
		`| Cost | $${input.cost.toFixed(4)}${input.subscription ? " (subscription)" : ""} |`,
		`| Input | ${prompt.toLocaleString()} tokens${hit} |`,
		`| Output | ${input.tokens.output.toLocaleString()} tokens |`,
	];
	if (input.breakdown.length > 1) {
		lines.push("", "| Model | Cost | Tokens |", "|---|---|---|");
		for (const entry of input.breakdown) {
			lines.push(`| ${cell(entry.key)} | $${entry.cost.toFixed(4)} | ${entry.tokens.toLocaleString()} |`);
		}
	}
	return lines.join("\n");
}

function run(
	command: string,
	args: string[],
	cwd: string,
	timeout = 5000,
): { ok: boolean; stdout: string; stderr: string } {
	try {
		const result = spawnSync(command, args, { cwd, encoding: "utf8", timeout, maxBuffer: 4 * 1024 * 1024 });
		return { ok: result.status === 0, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
	} catch {
		return { ok: false, stdout: "", stderr: "" };
	}
}

/** Uncommitted changes are cut to this many characters in /diff. */
export const MAX_DIFF_CHARS = 60_000;

/** /diff: what changed in the working tree since the last commit (staged and unstaged), with untracked files. */
export function buildDiffMarkdown(cwd: string): string {
	const inside = run("git", ["rev-parse", "--is-inside-work-tree"], cwd);
	if (!inside.ok) return "Not a git repository, so there is nothing to diff.";
	const hasHead = run("git", ["rev-parse", "--verify", "HEAD"], cwd).ok;
	const base = hasHead ? ["HEAD"] : [];
	const stat = run("git", ["diff", "--stat", ...base], cwd).stdout.trim();
	const diff = run("git", ["diff", "--no-color", ...base], cwd).stdout;
	const untracked = run("git", ["ls-files", "--others", "--exclude-standard"], cwd).stdout.split("\n").filter(Boolean);
	if (!stat && untracked.length === 0) return "No changes since the last commit.";
	const parts: string[] = [];
	if (stat) parts.push("```", stat, "```");
	if (untracked.length > 0) {
		parts.push(
			`**Untracked** (${untracked.length}): ${untracked
				.slice(0, 20)
				.map((file) => `\`${file}\``)
				.join(", ")}${untracked.length > 20 ? ", …" : ""}`,
		);
	}
	if (diff.trim()) {
		const cut = diff.length > MAX_DIFF_CHARS;
		parts.push("", "```diff", (cut ? diff.slice(0, MAX_DIFF_CHARS) : diff).trimEnd(), "```");
		if (cut)
			parts.push(`_Diff cut at ${MAX_DIFF_CHARS.toLocaleString()} characters; run \`git diff\` for the rest._`);
	}
	return parts.join("\n");
}

/** /init: the prompt that asks the agent to write or improve AGENTS.md (writes to it always ask). */
export function buildInitPrompt(cwd: string): string {
	const existing = ["AGENTS.md", "CLAUDE.md", ".cursorrules", ".github/copilot-instructions.md"].filter((file) =>
		existsSync(join(cwd, file)),
	);
	const start = existing.includes("AGENTS.md")
		? "Improve the existing AGENTS.md in this project."
		: existing.length > 0
			? `Create AGENTS.md for this project, starting from what ${existing.join(" and ")} already say${existing.length > 1 ? "" : "s"}.`
			: "Create an AGENTS.md file for this project.";
	return [
		start,
		"It is read by coding agents at the start of every session, so keep it short (under about 80 lines) and specific to this repository:",
		"- What the project is and how it is laid out (main packages or folders, one line each).",
		"- The exact commands to install, build, type check, lint and test, including how to run a single test.",
		"- Code style and conventions that are not obvious from the code (naming, error handling, imports, formatting tools).",
		"- Anything an agent must not do or must ask about (generated files, secrets, release steps).",
		"Read the README, package manifests, CI workflows and a few representative source files first. Do not invent commands: only list ones you found. Then write the file.",
	].join("\n");
}

export interface DoctorCheck {
	ok: boolean | "warn";
	name: string;
	detail: string;
}

export interface DoctorInput {
	cwd: string;
	agentDir: string;
	nodeVersion: string;
	runInfraKey: boolean;
	autoBackend?: string;
	permissionMode: PermissionMode;
	settingsErrors: string[];
	env: NodeJS.ProcessEnv;
	commandExists?: (command: string) => boolean;
}

function defaultCommandExists(command: string): boolean {
	const probe =
		process.platform === "win32"
			? run("where", [command], process.cwd())
			: run("sh", ["-c", `command -v ${command}`], process.cwd());
	return probe.ok && probe.stdout.trim() !== "";
}

function versionAtLeast(version: string, minimum: [number, number, number]): boolean {
	const parts = version
		.replace(/^v/, "")
		.split(".")
		.map((part) => Number.parseInt(part, 10) || 0);
	for (let i = 0; i < 3; i++) {
		if ((parts[i] ?? 0) > minimum[i]) return true;
		if ((parts[i] ?? 0) < minimum[i]) return false;
	}
	return true;
}

/** /doctor: environment checks with a fix for each problem. */
export function runDoctorChecks(input: DoctorInput): DoctorCheck[] {
	const exists = input.commandExists ?? defaultCommandExists;
	const checks: DoctorCheck[] = [];
	checks.push({
		ok: versionAtLeast(input.nodeVersion, [22, 19, 0]),
		name: "Node.js",
		detail: versionAtLeast(input.nodeVersion, [22, 19, 0])
			? input.nodeVersion
			: `${input.nodeVersion}: RunKiln needs Node 22.19 or newer`,
	});
	const git = exists("git");
	checks.push({
		ok: git ? true : "warn",
		name: "git",
		detail: git ? "found" : "not found: /diff and branch info need git",
	});
	const rg = exists("rg");
	checks.push({
		ok: rg ? true : "warn",
		name: "ripgrep (rg)",
		detail: rg ? "found" : "not found yet: RunKiln downloads it on start",
	});
	const fd = exists("fd");
	checks.push({
		ok: fd ? true : "warn",
		name: "fd",
		detail: fd ? "found" : "not found yet: @ file search downloads it on start",
	});
	checks.push({
		ok: input.runInfraKey,
		name: "RunInfra key",
		detail: input.runInfraKey ? "set" : "not set: /setup keys or `runkiln key set`",
	});
	checks.push({
		ok: input.autoBackend ? true : "warn",
		name: "Decision model",
		detail: input.autoBackend
			? `${input.autoBackend} (used by the auto model and auto permissions)`
			: "no Jev or OpenRouter key: auto routing and auto permissions are off (/setup keys)",
	});
	checks.push({
		ok: input.permissionMode === "allow-all" ? "warn" : true,
		name: "Permissions",
		detail:
			input.permissionMode === "allow-all"
				? "allow all: nothing asks. Use it only in a sandbox (/permissions to change)"
				: permissionModeInfo(input.permissionMode).label,
	});
	checks.push({
		ok: input.settingsErrors.length === 0,
		name: "Settings",
		detail: input.settingsErrors.length === 0 ? "valid" : input.settingsErrors.join("; "),
	});
	let writable = true;
	try {
		accessSync(input.agentDir, constants.W_OK);
	} catch {
		writable = !existsSync(input.agentDir);
	}
	checks.push({
		ok: writable,
		name: "Config folder",
		detail: writable ? input.agentDir : `${input.agentDir} is not writable: settings and sessions cannot be saved`,
	});
	const truecolor = /truecolor|24bit/i.test(input.env.COLORTERM ?? "");
	checks.push({
		ok: truecolor ? true : "warn",
		name: "Terminal colors",
		detail: truecolor ? "24-bit color" : "COLORTERM is not truecolor: colors are approximated",
	});
	return checks;
}

export function formatDoctorMarkdown(checks: DoctorCheck[]): string {
	const icon = (ok: DoctorCheck["ok"]) => (ok === true ? "✓" : ok === "warn" ? "!" : "✗");
	const problems = checks.filter((check) => check.ok === false).length;
	const warnings = checks.filter((check) => check.ok === "warn").length;
	const summary =
		problems === 0 && warnings === 0
			? "Everything looks good."
			: `${problems} problem${problems === 1 ? "" : "s"}, ${warnings} warning${warnings === 1 ? "" : "s"}.`;
	return [
		"| | Check | Result |",
		"|---|---|---|",
		...checks.map((check) => `| ${icon(check.ok)} | ${check.name} | ${cell(check.detail)} |`),
		"",
		summary,
	].join("\n");
}

/** /test: the run's outcome and its condensed output. */
export function buildTestMarkdown(
	command: string,
	result: {
		passed: boolean;
		timedOut: boolean;
		exitCode: number;
		failing?: number;
		excerpt: string;
		durationMs: number;
	},
): string {
	const seconds = (result.durationMs / 1000).toFixed(1);
	const head = result.passed
		? `✓ \`${command}\` passed in ${seconds}s.`
		: result.timedOut
			? `⏱ \`${command}\` timed out after ${seconds}s.`
			: `✗ \`${command}\` failed (exit code ${result.exitCode}${result.failing ? `, ${result.failing} failing` : ""}) in ${seconds}s.`;
	return [head, "", "```", result.excerpt.trimEnd(), "```"].join("\n");
}

/** Per-model edit misses for /status, e.g. "glm-5-3-flash 2/14 (1 repaired)". */
export function formatEditMisses(
	stats: ReadonlyMap<string, { edits: number; misses: number; repaired: number }>,
): string | undefined {
	const parts = [...stats.entries()]
		.filter(([, entry]) => entry.edits > 0)
		.map(
			([model, entry]) =>
				`${model} ${entry.misses}/${entry.edits}${entry.repaired > 0 ? ` (${entry.repaired} repaired)` : ""}`,
		);
	return parts.length > 0 ? parts.join(", ") : undefined;
}
