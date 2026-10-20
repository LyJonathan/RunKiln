/**
 * Permission modes: how much a session may do without asking.
 *
 * The approval gate in approval.ts decides what a tool call is (a read, a write inside or outside the project, a
 * shell command, another tool) and what the prompt shows. This module layers the user's chosen mode on top:
 *
 * - "ask"        Ask everything: every read, write and command asks.
 * - "read-write" Read & write (the default): reads and edits inside the project run; every shell command asks, and
 *                so do writes outside the project and to protected files (git hooks, package.json, AGENTS.md, ...).
 * - "auto"       Saved rules first, then the risk rules (riskReasons: a risky call always asks; the decision model
 *                can only turn it into a deny when it is confident), then a local pre-pass (auto-prepass.ts: read-only
 *                git, ls/cat of project files, the project's test/lint/build scripts, ordinary project edits run
 *                without a model call), then a decision model (Jev or the OpenRouter router model) that sees the
 *                call with the user's latest request, recent turns and a git summary, and answers allow, ask or
 *                deny with a risk level, a category and a confidence (permission-judge.ts; weak answers ask). The
 *                model is started as soon as the agent has written the call (prefetch), answers are cached per
 *                normalized command, and any model error or timeout asks. Only selectable when a classifier key
 *                exists.
 * - "plan"       Plan mode, as in Claude Code: read-only. The genuine read, grep, find and ls run; every write, edit,
 *                shell command and other tool is blocked (not asked) with a reason that tells the model to keep
 *                planning. The model ends its turn with a plan (plan-mode.ts); approving it switches back to the
 *                mode the session was in before plan mode.
 * - "allow-all"  Nothing asks.
 *
 * Rules that hold in every mode: a write whose path names a different file on Windows is refused without asking
 * (approval.ts), saved deny rules block (plan and allow-all included, see permission-rules.ts), and "always allow"
 * rules, session or saved, never approve a risky call.
 *
 * Session rules ("always allow this") are scoped to one AgentSession and never written to disk: a command prefix
 * such as `npm test` (every part of a chained command must match, and no part may use command substitution or
 * paths outside the project), one file, edits anywhere in the project, reads, or one tool name.
 */

import { basename, relative, resolve, sep } from "node:path";
import { isOutputFile } from "../../utils/output-files.ts";
import { resolveToCwd } from "../tools/path-utils.ts";
import type { DecisionSpend } from "../usage/decision-spend.ts";
import {
	type ApprovalRequest,
	analyzeShellCommand,
	approvalRequestForToolCall,
	isApprovalRefusal,
	isInsideProject,
	NO_PROMPT_TOOLS,
	powershellUnsafe,
	protectedProjectReason,
	realpathDeep,
	SHELL_TOOLS,
	sanitizeForPrompt,
	type ToolCallOptions,
	WRITE_TOOLS,
} from "./approval.ts";
import { autoPrepass, isRunnerCommand, isRunnerInput } from "./auto-prepass.ts";
import { describeSavedRule, evaluateSavedRules, type SavedRule, savedRulesForSuggestion } from "./permission-rules.ts";

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------

export type PermissionMode = "ask" | "read-write" | "plan" | "auto" | "allow-all";

export interface PermissionModeInfo {
	id: PermissionMode;
	/** Name in pickers and messages. */
	label: string;
	/** Compact footer badge. */
	badge: string;
	/** One line for pickers and /help. */
	description: string;
}

/**
 * In picker and cycle order. The first three follow Claude Code's Shift+Tab cycle (default, accept edits, plan mode);
 * RunKiln's auto and allow-all come after.
 */
export const PERMISSION_MODES: readonly PermissionModeInfo[] = Object.freeze([
	{
		id: "ask",
		label: "Ask everything",
		badge: "ask all",
		description: "Every read, write and command asks first.",
	},
	{
		id: "read-write",
		label: "Read & write",
		badge: "read & write",
		description: "Reads and edits inside the project run. Every shell command asks.",
	},
	{
		id: "plan",
		label: "Plan",
		badge: "plan - read-only",
		description: "Read-only: research and propose a plan. Writes, edits and commands are blocked until you approve.",
	},
	{
		id: "auto",
		label: "Auto",
		badge: "auto",
		description: "A decision model allows, asks or denies each call. Risky calls always ask.",
	},
	{
		id: "allow-all",
		label: "Allow all",
		badge: "allow all",
		description: "Nothing asks. Use it in a sandbox, a container or a throwaway checkout.",
	},
]);

export const DEFAULT_PERMISSION_MODE: PermissionMode = "read-write";

/** Environment variable that sets the mode for one run (below --permissions, above the saved setting). */
export const PERMISSIONS_ENV = "RUNKILN_PERMISSIONS";

export const PERMISSION_MODE_VALUES = "ask, read-write, plan, auto, allow-all";

const MODE_ALIASES: Record<string, PermissionMode> = {
	ask: "ask",
	"ask-all": "ask",
	"ask-everything": "ask",
	manual: "ask",
	"read-write": "read-write",
	"read&write": "read-write",
	"read-and-write": "read-write",
	rw: "read-write",
	edits: "read-write",
	"accept-edits": "read-write",
	acceptedits: "read-write",
	plan: "plan",
	"plan-mode": "plan",
	planning: "plan",
	"read-only": "plan",
	readonly: "plan",
	auto: "auto",
	"allow-all": "allow-all",
	allowall: "allow-all",
	all: "allow-all",
	yolo: "allow-all",
	bypass: "allow-all",
};

/** The mode a user-typed value names (case and spacing are ignored), or undefined. */
export function parsePermissionMode(value: unknown): PermissionMode | undefined {
	if (typeof value !== "string") return undefined;
	const key = value
		.trim()
		.toLowerCase()
		.replace(/[\s_]+/g, "-");
	return MODE_ALIASES[key];
}

export function permissionModeInfo(mode: PermissionMode): PermissionModeInfo {
	return PERMISSION_MODES.find((info) => info.id === mode) ?? PERMISSION_MODES[1];
}

/**
 * The next mode for the cycle key. "auto" is skipped when no decision model is available, and "allow-all" is only
 * part of the cycle when `includeAllowAll` is set (the session started in it or the user picked it in
 * /permissions), so one key press never grants everything by accident.
 */
export function nextPermissionMode(
	current: PermissionMode,
	options: { autoAvailable: boolean; includeAllowAll: boolean },
): PermissionMode {
	const cycle = PERMISSION_MODES.map((info) => info.id).filter(
		(id) => (id !== "auto" || options.autoAvailable) && (id !== "allow-all" || options.includeAllowAll),
	);
	const index = cycle.indexOf(current);
	return cycle[(index + 1) % cycle.length] ?? DEFAULT_PERMISSION_MODE;
}

/**
 * The mode a process starts in: the --permissions flag, else RUNKILN_PERMISSIONS, else the saved setting, else the
 * default. `auto` without an available decision model falls back to the default, with a notice.
 */
export function resolveStartupPermissionMode(input: {
	flag?: string;
	env?: NodeJS.ProcessEnv;
	saved?: string;
	autoAvailable: boolean;
}): { mode: PermissionMode; notice?: string } {
	const envValue = input.env?.[PERMISSIONS_ENV];
	const candidates: Array<[string | undefined, string]> = [
		[input.flag, "--permissions"],
		[envValue, PERMISSIONS_ENV],
		[input.saved, "the permissions setting"],
	];
	for (const [value, source] of candidates) {
		if (value === undefined || value.trim() === "") continue;
		const mode = parsePermissionMode(value);
		if (!mode) {
			return {
				mode: DEFAULT_PERMISSION_MODE,
				notice: `Unknown permission mode "${sanitizeForPrompt(value)}" from ${source}; using read & write. Modes: ${PERMISSION_MODE_VALUES}.`,
			};
		}
		if (mode === "auto" && !input.autoAvailable) {
			return {
				mode: DEFAULT_PERMISSION_MODE,
				notice: `Auto permissions need a Jev or OpenRouter key (/setup keys or \`runkiln key set jev\`); using read & write.`,
			};
		}
		return { mode };
	}
	return { mode: DEFAULT_PERMISSION_MODE };
}

let processPermissionMode: PermissionMode | undefined;

/** The mode new sessions in this process start in (set at startup and whenever the user changes it). */
export function getProcessPermissionMode(): PermissionMode | undefined {
	return processPermissionMode;
}

export function setProcessPermissionMode(mode: PermissionMode | undefined): void {
	processPermissionMode = mode;
}

// ---------------------------------------------------------------------------
// Risk rules
// ---------------------------------------------------------------------------

/** Paths that usually hold credentials. Matched against forward-slashed paths. */
const SECRET_PATH =
	/(^|[\\/\s"'=])(\.env(\.[\w.-]+)?|\.netrc|\.pgpass|\.npmrc|\.pypirc|\.git-credentials|\.vault-token|\.terraformrc|terraform\.rc|[\w.-]+\.tfvars|id_[\w-]+|credentials(\.json|\.toml|\.db)?|[\w.-]+\.pem|[\w.-]+\.key|[\w.-]+\.p12|[\w.-]+\.pfx|[\w.-]+\.keystore|[\w.-]+\.jks|\.ssh[\\/]?|\.aws[\\/]?|\.azure[\\/]?|\.gnupg[\\/]?|\.kube[\\/]?|\.docker[\\/]config\.json|gh[\\/]hosts\.yml|gcloud[\\/]?|\.config[\\/]gcloud[\\/]?|\.m2[\\/]settings\.xml|\.gem[\\/]credentials|\.cargo[\\/]credentials(\.toml)?|router-keys\.json|runinfra\.json|auth\.json)($|[\\/\s"';|&)])/i;

/** Template and sample env files are not secrets. */
function mentionsSecretPath(text: string): boolean {
	return SECRET_PATH.test(text.replace(/\.env\.(example|sample|template|dist)\b/gi, " "));
}

interface ShellRiskRule {
	pattern: RegExp;
	reason: string;
}

/** Matched against each top-level segment and each nested command, lowercased, with runs of spaces collapsed. */
const SHELL_SEGMENT_RISKS: readonly ShellRiskRule[] = [
	{ pattern: /^(sudo|doas|su|pkexec|runas)(\s|$)/, reason: "runs as another user (sudo)" },
	{
		pattern: /^rm\s(.*\s)?(-[a-z]*[rf][a-z]*|--recursive|--force)(\s|$)/,
		reason: "deletes files recursively or by force (rm -r/-f)",
	},
	{
		// PowerShell accepts any unambiguous prefix of a parameter (-r, -rec, -fo) and en or em dashes for the hyphen.
		pattern:
			/^(remove-item|ri|rm|del|erase|rd|rmdir)\s(.*\s)?([-\u2013\u2014\u2015]r(e(c(u(r(se?)?)?)?)?)?|[-\u2013\u2014\u2015]fo(r(ce?)?)?|\/s)(:\S*)?(\s|$)/,
		reason: "deletes folders recursively or by force (Remove-Item -Recurse/-Force)",
	},
	{
		pattern:
			/^(pwsh|powershell)(\.exe)?\s(.*\s)?[-\u2013\u2014\u2015/](e|ec|en|enc\w*|encodeda\w*|c|co|com\w*|f|fi|file)(:\S*)?(\s|$)/,
		reason: "starts another PowerShell with its own command (-Command, -File or -EncodedCommand)",
	},
	{ pattern: /^git\s(.*\s)?push(\s|$)/, reason: "pushes to a git remote" },
	{ pattern: /^git\s(.*\s)?reset\s(.*\s)?--hard(\s|$)/, reason: "discards git changes (reset --hard)" },
	{ pattern: /^git\s(.*\s)?clean\s(.*\s)?-[a-z]*f/, reason: "deletes untracked files (git clean -f)" },
	{ pattern: /^git\s(.*\s)?stash\s+(drop|clear)(\s|$)/, reason: "discards stashed changes (git stash drop/clear)" },
	{ pattern: /^git\s(.*\s)?branch\s(.*\s)?(-d|-D|--delete)(\s|$)/i, reason: "deletes a git branch" },
	{ pattern: /^git\s(.*\s)?(filter-branch|filter-repo)(\s|$)/, reason: "rewrites git history" },
	{ pattern: /^(npm|pnpm|yarn|bun)\s(.*\s)?publish(\s|$)/, reason: "publishes a package" },
	{ pattern: /^(cargo|twine|gem|poetry)\s(.*\s)?(publish|upload|push)(\s|$)/, reason: "publishes a package" },
	{ pattern: /^docker\s(.*\s)?push(\s|$)/, reason: "pushes an image" },
	{ pattern: /^(chmod|chown|chgrp)\s(.*\s)?(-[a-z]*r|--recursive|777)/, reason: "changes permissions recursively" },
	{ pattern: /^(dd|mkfs[\w.]*|fdisk|parted|diskpart|format)(\s|$)/, reason: "writes to a disk or partition" },
	{
		pattern: /^(shutdown|reboot|halt|poweroff|systemctl\s+(stop|disable|poweroff|reboot))(\s|$)/,
		reason: "stops or changes the system",
	},
	{
		pattern: /^(printenv|env|set|export\s+-p|declare\s+-x)$/,
		reason: "prints environment variables, which may hold secrets",
	},
	{ pattern: /^(eval|exec)\s/, reason: "runs a command built at run time (eval)" },
	{ pattern: /^(kill|pkill|killall)\s(.*\s)?(-9\s+)?(1|-1)$/, reason: "kills every process" },
];

/** Matched against the whole command, lowercased. */
const SHELL_COMMAND_RISKS: readonly ShellRiskRule[] = [
	{
		pattern:
			/\b(curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod|fetch)\b[^\n]*\|\s*(sudo\s+)?(ba|z|da|k|fi)?sh\b|\b(curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod)\b[^\n]*\|\s*(sudo\s+)?(python3?|node|perl|ruby|iex|invoke-expression)\b/,
		reason: "pipes a download into a shell or interpreter (curl | sh)",
	},
	{ pattern: /\bbase64\s+(-d|--decode)\b[^\n]*\|\s*(ba|z)?sh\b/, reason: "pipes decoded data into a shell" },
	{
		pattern: /\$\{?[a-z_]*(token|secret|password|passwd|api_?key|private_?key|access_?key)[a-z_]*\}?/,
		reason: "uses a secret from the environment",
	},
	{ pattern: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, reason: "fork bomb" },
	{ pattern: /\brm\s[^\n]*\s(\/|~|~\/|\$home|\/\*)(\s|$)/, reason: "deletes from the root or home folder" },
	{
		pattern: /(^|[^\w-])(iex|invoke-expression)([^\w-]|$)/,
		reason: "runs a string as PowerShell code (Invoke-Expression)",
	},
	{
		pattern: /(^|[^\w-])(start-process|saps|invoke-command|icm|invoke-item|ii)([^\w-]|$)/,
		reason: "starts another program or runs a remote command (Start-Process, Invoke-Command)",
	},
	{ pattern: /(^|[^\w-])add-type([^\w-]|$)/, reason: "compiles and loads code (Add-Type)" },
	{
		pattern: /\[(system\.management\.automation\.)?scriptblock\]\s*::\s*create/,
		reason: "builds code at run time ([ScriptBlock]::Create)",
	},
	{ pattern: /(^|[^\w-])set-executionpolicy([^\w-]|$)/, reason: "changes the PowerShell execution policy" },
];

/** Matched against each top-level part of a PowerShell command, lowercased. */
const POWERSHELL_SEGMENT_RISKS: readonly ShellRiskRule[] = [
	{
		pattern: /^start(\s|$)/,
		reason: "starts another program or runs a remote command (Start-Process, Invoke-Command)",
	},
];

function normalizeSegment(segment: string): string {
	return segment.trim().replace(/\s+/g, " ").toLowerCase();
}

/** Strips a leading `cd x &&`-free env assignment (FOO=bar cmd) so `FOO=1 git push` still matches. */
function withoutEnvAssignments(segment: string): string {
	return segment.replace(/^([a-z_][a-z0-9_]*=("[^"]*"|'[^']*'|\S*)\s+)+/i, "");
}

/**
 * Why a tool call is risky, or an empty list. Risky calls always ask in auto mode, whatever the decision model
 * says, and session "always allow" rules never cover them. `allow-all` is the only mode that runs them silently.
 */
export function riskReasons(toolName: string, args: unknown, cwd: string, options: ToolCallOptions = {}): string[] {
	const input = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
	const reasons = new Set<string>();
	if (SHELL_TOOLS.has(toolName)) {
		const command = typeof input.command === "string" ? input.command : "";
		const analysis = analyzeShellCommand(command, cwd);
		const lowered = command.toLowerCase();
		const parts = [
			...analysis.segments,
			...analysis.substitutions.map((sub) => sub.replace(/^[$<>]\(|\)$|^`|`$/g, "")),
		];
		for (const part of parts) {
			const segment = withoutEnvAssignments(normalizeSegment(part));
			for (const rule of SHELL_SEGMENT_RISKS) if (rule.pattern.test(segment)) reasons.add(rule.reason);
		}
		for (const rule of SHELL_COMMAND_RISKS) if (rule.pattern.test(lowered)) reasons.add(rule.reason);
		if (toolName === "powershell") {
			for (const part of parts) {
				const segment = normalizeSegment(part);
				for (const rule of POWERSHELL_SEGMENT_RISKS) if (rule.pattern.test(segment)) reasons.add(rule.reason);
			}
		}
		const powershell = powershellUnsafe(toolName, command);
		if (powershell) reasons.add(powershell);
		if (analysis.writesOutside.length > 0) reasons.add("writes outside the project");
		else if (analysis.pathsOutside.length > 0) reasons.add("uses paths outside the project");
		if (mentionsSecretPath(command)) reasons.add("touches a secrets or credentials file");
		return [...reasons];
	}
	const rawPath = typeof input.path === "string" ? input.path : "";
	if (WRITE_TOOLS.has(toolName)) {
		if (!rawPath) return [];
		const target = resolveToCwd(rawPath, cwd);
		if (!isInsideProject(target, cwd)) reasons.add("writes outside the project");
		else {
			const reason = protectedProjectReason(relative(resolve(cwd), resolve(target)));
			if (reason) reasons.add(`modifies a protected file: ${reason}`);
		}
		if (mentionsSecretPath(` ${target} `)) reasons.add("writes a secrets or credentials file");
		if (!options.builtin) reasons.add("a custom tool replaces the built-in write tool");
		return [...reasons];
	}
	if (NO_PROMPT_TOOLS.includes(toolName) && rawPath) {
		// The real path too, so a link such as notes.txt -> ~/.aws/credentials is caught.
		const target = resolveToCwd(rawPath, cwd);
		let real: string | undefined;
		try {
			real = realpathDeep(target);
		} catch {
			real = undefined;
		}
		if (mentionsSecretPath(` ${target} `) || (real !== undefined && mentionsSecretPath(` ${real} `))) {
			reasons.add("reads a secrets or credentials file");
		}
	}
	return [...reasons];
}

// ---------------------------------------------------------------------------
// Session rules ("always allow")
// ---------------------------------------------------------------------------

export type PermissionRule =
	| { kind: "command"; prefix: string }
	| { kind: "file"; path: string }
	| { kind: "project-edits" }
	| { kind: "reads" }
	| { kind: "tool"; name: string };

/** Commands whose second word is a subcommand that changes what they do (`git status` vs `git push`). */
const SUBCOMMAND_PROGRAMS = new Set([
	"git",
	"npm",
	"pnpm",
	"yarn",
	"bun",
	"npx",
	"bunx",
	"cargo",
	"go",
	"docker",
	"kubectl",
	"pip",
	"pip3",
	"uv",
	"poetry",
	"deno",
	"dotnet",
	"gradle",
	"mvn",
	"make",
	"just",
	"python",
	"python3",
	"node",
	"ruby",
	"perl",
	"bash",
	"sh",
	"zsh",
	"pwsh",
	"gh",
	"brew",
	"apt",
	"apt-get",
	"rustup",
	"tsc",
	"vitest",
	"jest",
	"pytest",
]);

/**
 * The prefix an "always allow" rule stores for one command segment: the program, plus its subcommand or script for
 * programs where that decides what runs (`git status`, `npm test`, `python scripts/x.py`). Undefined when the segment
 * starts with an environment assignment or is empty.
 */
export function commandPrefix(segment: string): string | undefined {
	const words = segment.trim().split(/\s+/).filter(Boolean);
	if (words.length === 0 || words[0].includes("=")) return undefined;
	const program = words[0];
	const second = words[1];
	if (second && SUBCOMMAND_PROGRAMS.has(basename(program).toLowerCase()) && !second.startsWith("-")) {
		// `npm run build`: keep the script name too.
		const third = words[2];
		if (["run", "exec", "x"].includes(second) && third && !third.startsWith("-")) {
			return `${program} ${second} ${third}`;
		}
		return `${program} ${second}`;
	}
	return program;
}

function segmentMatchesPrefix(segment: string, prefix: string): boolean {
	const words = segment.trim().split(/\s+/).filter(Boolean);
	const prefixWords = prefix.split(" ");
	return prefixWords.every((word, index) => words[index] === word);
}

/** A rule the prompt can offer for this call, with the label it shows. */
export interface RuleSuggestion {
	rules: PermissionRule[];
	label: string;
	/** The same rules as saved rules ("always allow in this project"), when they have a saved form. */
	projectRules?: string[];
	projectLabel?: string;
}

function code(text: string): string {
	return `\`${sanitizeForPrompt(text)}\``;
}

/**
 * What "always allow" would add for this call, or undefined when the call cannot get a rule: a risky call, a shell
 * command with command substitution, or one whose parts have no stable prefix.
 */
export function suggestAlwaysRule(
	mode: PermissionMode,
	toolName: string,
	args: unknown,
	cwd: string,
	options: ToolCallOptions = {},
): RuleSuggestion | undefined {
	const session = suggestSessionRule(mode, toolName, args, cwd, options);
	if (!session) return undefined;
	const projectRules = savedRulesForSuggestion(session.rules, toolName, cwd);
	if (!projectRules) return session;
	const projectLabel = session.label.endsWith(" this session")
		? `${session.label.slice(0, -" this session".length)} in this project (saved)`
		: `${session.label} (saved for this project)`;
	return { ...session, projectRules, projectLabel };
}

function suggestSessionRule(
	mode: PermissionMode,
	toolName: string,
	args: unknown,
	cwd: string,
	options: ToolCallOptions,
): RuleSuggestion | undefined {
	if (riskReasons(toolName, args, cwd, options).length > 0) return undefined;
	const input = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
	const genuine = options.builtin === true;
	if (SHELL_TOOLS.has(toolName)) {
		const command = typeof input.command === "string" ? input.command : "";
		const analysis = analyzeShellCommand(command, cwd);
		if (analysis.substitutions.length > 0 || analysis.segments.length === 0) return undefined;
		const prefixes: string[] = [];
		for (const segment of analysis.segments) {
			const prefix = commandPrefix(segment);
			if (!prefix) return undefined;
			if (!prefixes.includes(prefix)) prefixes.push(prefix);
		}
		if (prefixes.length > 3) return undefined;
		return {
			rules: prefixes.map((prefix) => ({ kind: "command", prefix })),
			label: `Always allow ${prefixes.map(code).join(", ")} commands this session`,
		};
	}
	if (WRITE_TOOLS.has(toolName) && genuine) {
		const rawPath = typeof input.path === "string" ? input.path : "";
		if (!rawPath) return undefined;
		const target = resolveToCwd(rawPath, cwd);
		if (mode === "ask" && isInsideProject(target, cwd) && !protectedProjectReason(relative(cwd, target))) {
			return { rules: [{ kind: "project-edits" }], label: "Always allow file edits in this project this session" };
		}
		const shown = isInsideProject(target, cwd) ? relative(cwd, target) : target;
		return { rules: [{ kind: "file", path: target }], label: `Always allow writes to ${code(shown)} this session` };
	}
	if (NO_PROMPT_TOOLS.includes(toolName) && genuine) {
		return { rules: [{ kind: "reads" }], label: "Always allow reads and searches this session" };
	}
	return { rules: [{ kind: "tool", name: toolName }], label: `Always allow ${code(toolName)} this session` };
}

function ruleCovers(
	rule: PermissionRule,
	toolName: string,
	args: unknown,
	cwd: string,
	options: ToolCallOptions,
): boolean {
	const input = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
	const genuine = options.builtin === true;
	switch (rule.kind) {
		case "tool":
			return rule.name === toolName && !SHELL_TOOLS.has(toolName) && !(WRITE_TOOLS.has(toolName) && genuine);
		case "reads":
			return NO_PROMPT_TOOLS.includes(toolName) && genuine;
		case "file":
		case "project-edits": {
			if (!WRITE_TOOLS.has(toolName) || !genuine) return false;
			const rawPath = typeof input.path === "string" ? input.path : "";
			if (!rawPath) return false;
			const target = resolveToCwd(rawPath, cwd);
			if (rule.kind === "file") return resolve(target) === resolve(rule.path);
			return isInsideProject(target, cwd) && !protectedProjectReason(relative(cwd, target));
		}
		case "command":
			return false;
	}
}

/** Whether the session rules approve this call. A shell command needs every part covered by a prefix rule. */
export function rulesAllow(
	rules: readonly PermissionRule[],
	toolName: string,
	args: unknown,
	cwd: string,
	options: ToolCallOptions = {},
): boolean {
	if (rules.length === 0) return false;
	if (riskReasons(toolName, args, cwd, options).length > 0) return false;
	if (SHELL_TOOLS.has(toolName)) {
		const input = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
		const command = typeof input.command === "string" ? input.command : "";
		if (powershellUnsafe(toolName, command)) return false;
		const analysis = analyzeShellCommand(command, cwd);
		if (analysis.substitutions.length > 0 || analysis.segments.length === 0) return false;
		const prefixes = rules.filter((rule) => rule.kind === "command").map((rule) => rule.prefix);
		return analysis.segments.every((segment) => prefixes.some((prefix) => segmentMatchesPrefix(segment, prefix)));
	}
	return rules.some((rule) => ruleCovers(rule, toolName, args, cwd, options));
}

export function describeRule(rule: PermissionRule, cwd: string): string {
	switch (rule.kind) {
		case "command":
			return `commands starting with ${code(rule.prefix)}`;
		case "file": {
			const inside = isInsideProject(rule.path, cwd);
			return `writes to ${code(inside ? relative(cwd, rule.path) || "." : rule.path)}`;
		}
		case "project-edits":
			return "file edits in the project";
		case "reads":
			return "reads and searches";
		case "tool":
			return `the ${code(rule.name)} tool`;
	}
}

function sameRule(a: PermissionRule, b: PermissionRule): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

/** What a decision model answered for one call. */
export interface JudgeVerdict {
	decision: "allow" | "ask" | "deny";
	/** Short, user-facing. */
	reason: string;
	risk?: "low" | "medium" | "high";
	category?: string;
	confidence?: number;
	/** What the decision-model call behind this verdict cost. */
	spend?: DecisionSpend;
}

/** What the session tells the decision model about the work around a call (see permission-judge.ts). */
export interface JudgeContext {
	/** The user's latest request, as typed. */
	request?: string;
	/** A few recent turns: user messages and the agent's tool calls (never tool output). */
	recentTurns?: string[];
	/** A short git summary: branch and changed files. */
	git?: string;
}

export interface JudgeInput {
	toolName: string;
	args: unknown;
	cwd: string;
	/** The prompt the user would see, which already describes the call. */
	summary: string;
	context?: JudgeContext;
}

export interface PermissionJudge {
	/** "jev" or "openrouter", for messages. */
	readonly label: string;
	judge(input: JudgeInput, signal?: AbortSignal): Promise<JudgeVerdict>;
}

/** What the gate decided before anyone is asked. */
export type PermissionDecision =
	| { action: "allow"; via: "mode" | "rule" | "saved-rule" | "prepass" | "judge"; reason?: string }
	| { action: "deny"; reason: string; via: "refusal" | "judge" | "rule" | "plan" }
	| {
			action: "ask";
			request: ApprovalRequest;
			risks: string[];
			judgeReason?: string;
			/** Set when a saved ask rule made this call ask. */
			askRule?: string;
			suggestion?: RuleSuggestion;
	  };

/** A risky call is blocked (not asked) only when the decision model denies it at least this confidently. */
export const RISKY_DENY_CONFIDENCE = 0.9;

/**
 * The read-only gate shared by plan mode and /review: only the genuine (built-in) read, grep, find and ls run.
 */
export function isReadOnlyToolCall(toolName: string, options: ToolCallOptions = {}): boolean {
	return NO_PROMPT_TOOLS.includes(toolName) && options.builtin === true;
}

/** The block reason for a call that plan mode stops. */
export function planModeBlockReason(toolName: string): string {
	const tool = sanitizeForPrompt(toolName);
	return `Not run: plan mode is on, so RunKiln is read-only and blocks this ${tool} call (every write, edit, shell command and tool other than read, grep, find and ls). Keep researching with the read-only tools, then end your turn with the plan under a "## Plan" heading; the user approves it before anything runs.`;
}

/** The block reason for a call a saved deny rule stops. */
export function denyRuleReason(toolName: string, rule: SavedRule): string {
	return `Not run: the user's permission rules deny this ${sanitizeForPrompt(toolName)} call (deny rule \`${sanitizeForPrompt(rule.text)}\`, ${describeSavedRule(rule.text)}). Do not retry it or work around it; ask the user if it is really needed.`;
}

function readTarget(toolName: string, input: Record<string, unknown>): string {
	if (typeof input.path === "string" && input.path) return input.path;
	if (typeof input.pattern === "string") return input.pattern;
	return ".";
}

/** A prompt for a call the read & write baseline would have run without asking (used by ask and auto). */
function requestForAllowedCall(toolName: string, args: unknown, cwd: string, outside = false): ApprovalRequest {
	const input = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
	const tool = sanitizeForPrompt(toolName);
	if (WRITE_TOOLS.has(toolName)) {
		const target = typeof input.path === "string" ? resolveToCwd(input.path, cwd) : "";
		const shown = target && isInsideProject(target, cwd) ? relative(cwd, target) : target;
		const lines = [`${tool} wants to write ${sanitizeForPrompt(shown || "(no path)")}`];
		if (toolName === "edit" && Array.isArray(input.edits)) lines.push(`${input.edits.length} edit(s)`);
		else if (typeof input.content === "string") lines.push(`${input.content.split("\n").length} line(s)`);
		lines.push("", `Project folder: ${sanitizeForPrompt(cwd)}`);
		return { title: `Allow ${tool}?`, message: lines.join("\n") };
	}
	const target = sanitizeForPrompt(readTarget(toolName, input));
	const extra =
		typeof input.pattern === "string" && typeof input.path === "string" ? ` in ${sanitizeForPrompt(input.path)}` : "";
	return {
		title: outside ? `Allow ${tool} outside the project?` : `Allow ${tool}?`,
		message: `${tool} ${typeof input.pattern === "string" ? `searches for ${sanitizeForPrompt(input.pattern)}${extra}` : `reads ${target}`}\n\nProject folder: ${sanitizeForPrompt(cwd)}`,
	};
}

/** Whitespace outside quotes collapsed, so `git  status ` and `git status` share one decision. */
export function normalizeCommand(command: string): string {
	let out = "";
	let quote: string | undefined;
	let space = false;
	for (const ch of command.trim()) {
		if (quote) {
			out += ch;
			if (ch === quote) quote = undefined;
			continue;
		}
		if (ch === " " || ch === "\t") {
			space = true;
			continue;
		}
		if (space && out !== "") out += " ";
		space = false;
		if (ch === "'" || ch === '"') quote = ch;
		out += ch;
	}
	return out;
}

function stableJson(value: unknown): string {
	return JSON.stringify(value, (_key, inner: unknown) => {
		if (inner && typeof inner === "object" && !Array.isArray(inner)) {
			return Object.fromEntries(
				Object.entries(inner as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)),
			);
		}
		return typeof inner === "bigint" ? `${inner}n` : inner;
	});
}

/**
 * The cache key of a judged call: the normalized command for shell tools (a timeout argument does not change what
 * runs), the arguments with sorted keys for the rest.
 */
export function judgeCacheKey(toolName: string, args: unknown, cwd: string): string {
	try {
		if (SHELL_TOOLS.has(toolName) && args && typeof args === "object") {
			const command = (args as Record<string, unknown>).command;
			if (typeof command === "string") return JSON.stringify([toolName, cwd, normalizeCommand(command)]);
		}
		return stableJson([toolName, cwd, args]);
	} catch {
		return `${toolName}\u0000${cwd}\u0000${String(args)}`;
	}
}

export interface PermissionGateOptions {
	mode?: PermissionMode;
	/** Builds the decision model on first use; undefined when none is configured. */
	judgeFactory?: () => PermissionJudge | undefined;
	/** Whether auto is selectable (a classifier key exists). Defaults to judgeFactory being set. */
	isAutoAvailable?: () => boolean;
	/** The saved allow, ask and deny rules that apply to this session's project (read on every decision). */
	savedRules?: () => readonly SavedRule[];
	/** The mode approving a plan returns to when the session started in plan mode. Defaults to read & write. */
	planReturnMode?: () => PermissionMode | undefined;
	/** The work around a call, for the decision model (the user's request, recent turns, git summary). */
	judgeContext?: () => JudgeContext | undefined;
	/** Called once per billed decision-model call (prefetches included; cached verdicts are not billed again). */
	onJudgeSpend?: (spend: DecisionSpend) => void;
	/**
	 * `permissions.readsOutsideProject`: "ask" (the default) makes read, grep, find and ls of a path outside the
	 * project ask in every mode but allow-all; "allow" runs them as before.
	 */
	readsOutsideProject?: () => ReadsOutsideProject | undefined;
	/**
	 * Folders outside the project that reads may use without asking: the loaded skills' folders, RunKiln's docs.
	 * RunKiln's own output files (truncated tool output) are always readable.
	 */
	readRoots?: () => readonly string[];
}

export type ReadsOutsideProject = "ask" | "allow";

/** The `permissions.readsOutsideProject` value a setting names, or undefined. */
export function parseReadsOutsideProject(value: unknown): ReadsOutsideProject | undefined {
	return value === "ask" || value === "allow" ? value : undefined;
}

/**
 * Whether a genuine read, grep, find or ls call reads outside the project (after resolving links) and is not under
 * one of `roots` or one of RunKiln's own output files.
 */
export function readsOutside(toolName: string, args: unknown, cwd: string, roots: readonly string[] = []): boolean {
	if (!NO_PROMPT_TOOLS.includes(toolName) || toolName === "repo_map") return false;
	const input = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
	const raw = typeof input.path === "string" && input.path.trim() !== "" ? input.path : undefined;
	if (!raw) return false;
	const target = resolveToCwd(raw, cwd);
	if (isInsideProject(target, cwd)) return false;
	if (isOutputFile(target)) return false;
	return !roots.some((root) => isInsideProject(target, root));
}

/**
 * One session's permission state: the mode, the "always allow" rules and the decision cache. The mode is shared with
 * the process (new sessions start in the last mode the user picked); rules and cached decisions are per session.
 */
export class PermissionGate {
	private _mode: PermissionMode;
	private readonly _rules: PermissionRule[] = [];
	private readonly _cache = new Map<string, JudgeVerdict>();
	/** Judge calls started early (prefetch) or still running, by cache key. */
	private readonly _inflight = new Map<string, Promise<JudgeVerdict>>();
	private readonly _judgeContext: () => JudgeContext | undefined;
	private readonly _onJudgeSpend: ((spend: DecisionSpend) => void) | undefined;
	private readonly _judgeFactory: (() => PermissionJudge | undefined) | undefined;
	private readonly _isAutoAvailable: () => boolean;
	private _judge: PermissionJudge | undefined | null = null;
	private readonly _listeners = new Set<(mode: PermissionMode, previous: PermissionMode) => void>();
	private readonly _savedRules: () => readonly SavedRule[];
	private readonly _readsOutsideProject: () => ReadsOutsideProject | undefined;
	private readonly _readRoots: () => readonly string[];
	private _modeBeforePlan: PermissionMode;
	/**
	 * Runner inputs (test files, runner config, build scripts; see isRunnerInput) the agent changed since the last
	 * runner command ran, as project-relative paths. While it is not empty, the next runner command is never allowed
	 * by a rule or the pre-pass: auto mode sends it to the decision model, the other modes ask.
	 */
	private readonly _changedRunnerInputs = new Set<string>();
	/** Set once allow-all was chosen in this process, so the cycle key includes it from then on. */
	allowAllInCycle = false;

	constructor(options: PermissionGateOptions = {}) {
		this._mode = options.mode ?? DEFAULT_PERMISSION_MODE;
		this._judgeFactory = options.judgeFactory;
		this._isAutoAvailable = options.isAutoAvailable ?? (() => this._judgeFactory !== undefined);
		this._savedRules = options.savedRules ?? (() => []);
		this._judgeContext = options.judgeContext ?? (() => undefined);
		this._onJudgeSpend = options.onJudgeSpend;
		this._readsOutsideProject = options.readsOutsideProject ?? (() => undefined);
		this._readRoots = options.readRoots ?? (() => []);
		let returnMode: PermissionMode | undefined;
		try {
			returnMode = options.planReturnMode?.();
		} catch {
			returnMode = undefined;
		}
		this._modeBeforePlan = returnMode && returnMode !== "plan" ? returnMode : DEFAULT_PERMISSION_MODE;
		if (this._mode === "allow-all") this.allowAllInCycle = true;
	}

	get mode(): PermissionMode {
		return this._mode;
	}

	/** The mode plan mode was entered from: approving or discarding a plan returns to it. */
	get modeBeforePlan(): PermissionMode {
		return this._modeBeforePlan;
	}

	/** The saved rules in effect now. A broken rule source counts as no rules. */
	savedRules(): readonly SavedRule[] {
		try {
			return this._savedRules();
		} catch {
			return [];
		}
	}

	get rules(): readonly PermissionRule[] {
		return this._rules;
	}

	isAutoAvailable(): boolean {
		try {
			return this._isAutoAvailable();
		} catch {
			return false;
		}
	}

	/** Change the mode. Returns an error message when auto is chosen without a decision model. */
	setMode(mode: PermissionMode): string | undefined {
		if (mode === "auto" && !this.isAutoAvailable()) {
			return "Auto needs a Jev or OpenRouter key. Add one in /setup keys (or `runkiln key set jev`).";
		}
		if (mode === "allow-all") this.allowAllInCycle = true;
		if (mode === this._mode) return undefined;
		const previous = this._mode;
		if (mode === "plan") this._modeBeforePlan = previous;
		this._mode = mode;
		// A key added or changed since the judge was built takes effect on the next auto decision.
		this._judge = null;
		for (const listener of this._listeners) listener(mode, previous);
		return undefined;
	}

	onModeChange(listener: (mode: PermissionMode, previous: PermissionMode) => void): () => void {
		this._listeners.add(listener);
		return () => this._listeners.delete(listener);
	}

	addRules(rules: readonly PermissionRule[]): void {
		for (const rule of rules) if (!this._rules.some((existing) => sameRule(existing, rule))) this._rules.push(rule);
	}

	/** Remove one session rule by its index in `rules`. Returns whether a rule was removed. */
	removeRule(index: number): boolean {
		if (!Number.isInteger(index) || index < 0 || index >= this._rules.length) return false;
		this._rules.splice(index, 1);
		return true;
	}

	clearRules(): number {
		const count = this._rules.length;
		this._rules.length = 0;
		return count;
	}

	clearCache(): void {
		this._cache.clear();
		this._inflight.clear();
	}

	private context(): JudgeContext | undefined {
		try {
			return this._judgeContext();
		} catch {
			return undefined;
		}
	}

	/**
	 * The judge's verdict for a call, sharing one request between a prefetch and the decision. Successful verdicts are
	 * cached for the session; failures are not.
	 */
	private judgeOnce(judge: PermissionJudge, key: string, input: JudgeInput): Promise<JudgeVerdict> {
		const cached = this._cache.get(key);
		if (cached) return Promise.resolve(cached);
		const running = this._inflight.get(key);
		if (running) return running;
		const started = judge.judge(input).then(
			(verdict) => {
				if (verdict.spend) {
					try {
						this._onJudgeSpend?.(verdict.spend);
					} catch {
						// Accounting must never change a permission decision.
					}
				}
				this._cache.set(key, verdict);
				this._inflight.delete(key);
				return verdict;
			},
			(error: unknown) => {
				this._inflight.delete(key);
				throw error;
			},
		);
		// A prefetch nobody awaits must not surface as an unhandled rejection.
		started.catch(() => undefined);
		this._inflight.set(key, started);
		return started;
	}

	/** Whether this genuine read call reads outside the project and the setting says it asks. */
	private outsideReadAsks(toolName: string, args: unknown, cwd: string, options: ToolCallOptions): boolean {
		if (options.builtin !== true) return false;
		try {
			if ((this._readsOutsideProject() ?? "ask") === "allow") return false;
			return readsOutside(toolName, args, cwd, this._readRoots());
		} catch {
			return true;
		}
	}

	/** The runner inputs changed since the last runner command ran (see _changedRunnerInputs). */
	get changedRunnerInputs(): readonly string[] {
		return [...this._changedRunnerInputs];
	}

	/**
	 * Record a call that is about to run (allowed by the gate or approved by the user): a write to a runner input
	 * marks it changed, and a runner command clears the changes, since the user or the model has now seen them.
	 */
	noteRunning(toolName: string, args: unknown, cwd: string): void {
		try {
			const input = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
			if (WRITE_TOOLS.has(toolName) && typeof input.path === "string" && input.path) {
				const target = resolveToCwd(input.path, cwd);
				if (!isInsideProject(target, cwd)) return;
				const rel = relative(resolve(cwd), resolve(target)).split(sep).join("/");
				if (isRunnerInput(rel)) this._changedRunnerInputs.add(rel);
				return;
			}
			if (SHELL_TOOLS.has(toolName) && typeof input.command === "string") {
				if (isRunnerCommand(input.command, cwd)) this._changedRunnerInputs.clear();
			}
		} catch {
			// Bookkeeping must never change a decision.
		}
	}

	/**
	 * The runner inputs this call would execute after the agent changed them, or undefined: set only for a runner
	 * command while runner inputs are changed.
	 */
	private runnerAfterWrite(toolName: string, args: unknown, cwd: string): string[] | undefined {
		if (this._changedRunnerInputs.size === 0 || !SHELL_TOOLS.has(toolName)) return undefined;
		const input = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
		const command = typeof input.command === "string" ? input.command : "";
		return isRunnerCommand(command, cwd) ? [...this._changedRunnerInputs] : undefined;
	}

	/**
	 * What auto mode decides before any model call, or "judge" when the call needs the decision model. Saved rules
	 * first, then risk rules, then the session rules and the local pre-pass (auto-prepass.ts).
	 */
	private autoPrecheck(
		toolName: string,
		args: unknown,
		cwd: string,
		options: ToolCallOptions,
	):
		| "judge"
		| { via: "mode" | "rule" | "saved-rule" | "prepass" | "risk" | "ask-rule" | "deny-rule"; reason?: string } {
		const saved = evaluateSavedRules(this.savedRules(), toolName, args, cwd, options);
		if (saved?.action === "deny") return { via: "deny-rule" };
		if (saved?.action === "ask") return { via: "ask-rule" };
		if (riskReasons(toolName, args, cwd, options).length > 0) return "judge";
		if (this.runnerAfterWrite(toolName, args, cwd)) return "judge";
		if (saved?.action === "allow") return { via: "saved-rule" };
		if (rulesAllow(this._rules, toolName, args, cwd, options)) return { via: "rule" };
		const baseline = approvalRequestForToolCall(toolName, args, cwd, options);
		if (this.outsideReadAsks(toolName, args, cwd, options)) return { via: "ask-rule" };
		if (baseline === undefined && NO_PROMPT_TOOLS.includes(toolName)) return { via: "mode" };
		const prepass = autoPrepass(toolName, args, cwd, options);
		if (prepass) return { via: "prepass", reason: prepass.reason };
		return "judge";
	}

	/**
	 * Start the decision model on a call as soon as it is known (the session calls this when the model finishes
	 * writing a tool call, while the call is still being shown), so the decision is ready or nearly ready when the
	 * call reaches the gate. Does nothing outside auto mode or when no model call is needed.
	 */
	prefetch(toolName: string, args: unknown, cwd: string, options: ToolCallOptions = {}): boolean {
		if (this._mode !== "auto") return false;
		try {
			const baseline = approvalRequestForToolCall(toolName, args, cwd, options);
			if (isApprovalRefusal(baseline)) return false;
			if (this.autoPrecheck(toolName, args, cwd, options) !== "judge") return false;
			const judge = this.judge();
			if (!judge) return false;
			const request = baseline ?? requestForAllowedCall(toolName, args, cwd);
			const changed = this.runnerAfterWrite(toolName, args, cwd);
			const key = runnerCacheKey(judgeCacheKey(toolName, args, cwd), changed);
			const context = this.context();
			const risks = riskReasons(toolName, args, cwd, options);
			void this.judgeOnce(judge, key, {
				toolName,
				args,
				cwd,
				summary: `${request.title}\n${request.message}${risks.length > 0 ? `\nRisk rules: ${risks.join("; ")}` : ""}${changed ? `\n${runnerAfterWriteNote(changed)}` : ""}`,
				...(context ? { context } : {}),
			});
			return true;
		} catch {
			return false;
		}
	}

	private judge(): PermissionJudge | undefined {
		if (this._judge === null) {
			try {
				this._judge = this._judgeFactory?.();
			} catch {
				this._judge = undefined;
			}
		}
		return this._judge ?? undefined;
	}

	/**
	 * Decide a tool call under the current mode. Asking the user is the caller's job; when the user approves, the
	 * caller reports it with noteRunning. An allowed call is recorded here (see noteRunning).
	 */
	async decide(
		toolName: string,
		args: unknown,
		cwd: string,
		options: ToolCallOptions = {},
		signal?: AbortSignal,
	): Promise<PermissionDecision> {
		const decision = await this.decideCall(toolName, args, cwd, options, signal);
		if (decision.action === "allow") this.noteRunning(toolName, args, cwd);
		return decision;
	}

	private async decideCall(
		toolName: string,
		args: unknown,
		cwd: string,
		options: ToolCallOptions,
		signal: AbortSignal | undefined,
	): Promise<PermissionDecision> {
		const baseline = approvalRequestForToolCall(toolName, args, cwd, options);
		if (isApprovalRefusal(baseline)) return { action: "deny", reason: baseline.reason, via: "refusal" };
		const mode = this._mode;
		// Saved deny rules hold in every mode, allow-all and plan included.
		const saved = evaluateSavedRules(this.savedRules(), toolName, args, cwd, options);
		if (saved?.action === "deny")
			return { action: "deny", reason: denyRuleReason(toolName, saved.rule), via: "rule" };
		if (mode === "allow-all") return { action: "allow", via: "mode" };

		const risks = riskReasons(toolName, args, cwd, options);
		const outsideRead = this.outsideReadAsks(toolName, args, cwd, options);
		const request = baseline ?? requestForAllowedCall(toolName, args, cwd, outsideRead);
		const askRule = saved?.action === "ask" ? saved.rule.text : undefined;
		const ask = (judgeReason?: string): PermissionDecision => ({
			action: "ask",
			request,
			risks,
			...(judgeReason ? { judgeReason } : {}),
			...(askRule ? { askRule } : {}),
			suggestion: askRule ? undefined : suggestAlwaysRule(mode, toolName, args, cwd, options),
		});

		if (mode === "plan") {
			// Read-only: only the genuine read tools run. Allow rules do not lift it; an ask rule still asks.
			if (!isReadOnlyToolCall(toolName, options)) {
				return { action: "deny", reason: planModeBlockReason(toolName), via: "plan" };
			}
			// A secrets file or a path outside the project asks here too.
			return askRule || risks.length > 0 || outsideRead ? ask() : { action: "allow", via: "mode" };
		}
		if (askRule) return ask();
		// Write-then-run: after the agent changed a file this runner executes, no rule or pre-pass runs it unseen.
		const changed = this.runnerAfterWrite(toolName, args, cwd);
		const changedNote = changed ? runnerAfterWriteNote(changed) : undefined;
		const safe = risks.length === 0;
		if (!changed && safe && saved?.action === "allow") return { action: "allow", via: "saved-rule" };
		if (!changed && rulesAllow(this._rules, toolName, args, cwd, options)) return { action: "allow", via: "rule" };

		if (mode === "ask") return ask(changedNote);
		// Reads of secrets files ask in every mode but allow-all, and so do reads outside the project (by default).
		if (NO_PROMPT_TOOLS.includes(toolName) && (risks.length > 0 || outsideRead)) return ask();
		if (mode === "read-write") return baseline === undefined ? { action: "allow", via: "mode" } : ask(changedNote);

		// auto: saved rules were applied above; then risk rules, the local pre-pass, then the decision model.
		if (risks.length > 0) {
			// A risky call always asks. The model is still consulted (usually prefetched), but it can only make the
			// answer stricter: a confident deny blocks the call, anything else asks with its reason shown.
			const judge = this.judge();
			if (!judge) return ask();
			try {
				const context = this.context();
				const verdict = await abortable(
					this.judgeOnce(judge, judgeCacheKey(toolName, args, cwd), {
						toolName,
						args,
						cwd,
						summary: `${request.title}\n${request.message}\nRisk rules: ${risks.join("; ")}`,
						...(context ? { context } : {}),
					}),
					signal,
				);
				const reason = sanitizeForPrompt(`${judge.label}: ${verdict.reason}`).slice(0, 200);
				if (verdict.decision === "deny" && (verdict.confidence ?? 1) >= RISKY_DENY_CONFIDENCE) {
					return { action: "deny", reason, via: "judge" };
				}
				return ask(reason);
			} catch {
				return ask();
			}
		}
		// Plain reads and searches of non-secret paths never need a model, as in every other mode but "ask".
		if (baseline === undefined && NO_PROMPT_TOOLS.includes(toolName)) return { action: "allow", via: "mode" };
		const prepass = changed ? undefined : autoPrepass(toolName, args, cwd, options);
		if (prepass) return { action: "allow", via: "prepass", reason: prepass.reason };
		const judge = this.judge();
		if (!judge) {
			return ask(changedNote ?? "No decision model is available (no Jev or OpenRouter key), so this asks.");
		}
		// A verdict from before the change must not cover the runner now, so the changed files are part of the key.
		const key = runnerCacheKey(judgeCacheKey(toolName, args, cwd), changed);
		let verdict: JudgeVerdict;
		try {
			const context = this.context();
			const pending = this.judgeOnce(judge, key, {
				toolName,
				args,
				cwd,
				summary: `${request.title}\n${request.message}${changedNote ? `\n${changedNote}` : ""}`,
				...(context ? { context } : {}),
			});
			verdict = await abortable(pending, signal);
		} catch (error) {
			if (signal?.aborted) return ask();
			const detail = error instanceof Error ? error.message : String(error);
			return ask(`The decision model failed (${sanitizeForPrompt(detail).slice(0, 120)}), so this asks.`);
		}
		const reason = sanitizeForPrompt(`${judge.label}: ${verdict.reason}`).slice(0, 200);
		if (verdict.decision === "allow") return { action: "allow", via: "judge", reason };
		if (verdict.decision === "deny") return { action: "deny", reason, via: "judge" };
		return ask(reason);
	}
}

/** What the prompt and the decision model are told about runner inputs the agent changed. */
export function runnerAfterWriteNote(changed: readonly string[]): string {
	const shown = changed.slice(0, 5).map((path) => sanitizeForPrompt(path));
	const more = changed.length > 5 ? ` and ${changed.length - 5} more` : "";
	return `The agent changed files this command runs (${shown.join(", ")}${more}) since the last test or build run.`;
}

function runnerCacheKey(key: string, changed: readonly string[] | undefined): string {
	return changed ? `${key}\u0000changed:${[...changed].sort().join("\u0000")}` : key;
}

/** The promise, rejected early when the signal aborts. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
	if (!signal) return promise;
	if (signal.aborted) return Promise.reject(new Error("aborted"));
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(new Error("aborted"));
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error: unknown) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}

// ---------------------------------------------------------------------------
// The user's answer
// ---------------------------------------------------------------------------

export type ApprovalChoice = "allow-once" | "allow-always" | "allow-project" | "deny" | "deny-feedback";

export interface ApprovalAnswer {
	choice: ApprovalChoice;
	/** For deny-feedback: what the model should do instead. */
	feedback?: string;
}

/** Everything a UI needs to show one approval prompt. */
export interface PermissionPrompt {
	toolName: string;
	mode: PermissionMode;
	title: string;
	message: string;
	risks: string[];
	judgeReason?: string;
	/** The "always allow" option's label, when the call can get a rule. */
	alwaysLabel?: string;
	/** The "always allow in this project (saved)" option's label, when the rule has a saved form. */
	projectLabel?: string;
	/** The saved ask rule that made this call ask, when one did. */
	askRule?: string;
	/** Code inside the message to show with syntax colour (see ApprovalRequest.code). */
	code?: ApprovalRequest["code"];
	/** What a write or edit would change (see ApprovalRequest.diff). */
	diff?: ApprovalRequest["diff"];
	/** How long the prompt waits for an answer; 0 waits indefinitely. */
	timeoutMs: number;
	/** What happens when the timeout runs out: deny the call (the default), or keep waiting and notify. */
	timeoutAction?: ApprovalTimeoutAction;
}

/** What an approval prompt does when `permissions.promptTimeoutSec` runs out. */
export type ApprovalTimeoutAction = "deny" | "pause";

export interface ApprovalTimeoutPolicy {
	/** 0 waits indefinitely. */
	timeoutMs: number;
	action: ApprovalTimeoutAction;
}

/** The default: wait for the answer as long as it takes. */
export const DEFAULT_APPROVAL_TIMEOUT_POLICY: ApprovalTimeoutPolicy = Object.freeze({ timeoutMs: 0, action: "deny" });

/** Longest timeout accepted (a day); larger values are capped. */
const MAX_PROMPT_TIMEOUT_SEC = 86_400;

/**
 * The timeout policy from `permissions.promptTimeoutSec` (seconds, 0 or unset = wait indefinitely) and
 * `permissions.timeoutAction` ("deny" or "pause"). Invalid values fall back to the defaults.
 */
export function approvalTimeoutPolicy(
	settings: { promptTimeoutSec?: unknown; timeoutAction?: unknown } | undefined,
): ApprovalTimeoutPolicy {
	const seconds = settings?.promptTimeoutSec;
	const valid = typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0;
	const timeoutMs = valid ? Math.round(Math.min(seconds, MAX_PROMPT_TIMEOUT_SEC) * 1000) : 0;
	const action: ApprovalTimeoutAction = settings?.timeoutAction === "pause" ? "pause" : "deny";
	return { timeoutMs, action };
}

export const APPROVAL_OPTION_LABELS = {
	once: "Allow once",
	deny: "Deny",
	feedback: "Deny and tell the model what to do instead",
} as const;

/** The block reason the model sees for a denial. Feedback is sanitized and capped. */
export function denialReason(toolName: string, answer: ApprovalAnswer | undefined): string {
	const tool = sanitizeForPrompt(toolName);
	if (answer?.choice === "deny-feedback" && answer.feedback?.trim()) {
		const feedback = sanitizeForPrompt(answer.feedback.trim(), { multiline: true }).slice(0, 2000);
		return `Not run: the user denied this ${tool} call and said: ${feedback}`;
	}
	if (answer?.choice === "deny" || answer?.choice === "deny-feedback") {
		return `Not run: the user denied this ${tool} call. Do not retry it as is; ask the user or try another way.`;
	}
	return `Not run: this ${tool} call needs approval and none was given (declined, no answer, or no interactive approval available).`;
}

/** The denial reason when no UI can ask (print and json mode). */
export function headlessDenialReason(toolName: string, mode: PermissionMode): string {
	return `Not run: this ${sanitizeForPrompt(toolName)} call needs approval in ${permissionModeInfo(mode).label} mode, and print mode cannot ask. Run with --permissions auto or --permissions allow-all to let it run unattended.`;
}

/** Splits a path for display, keeping it short: `src/core/` style relative paths for files inside the project. */
export function shortPath(path: string, cwd: string): string {
	if (isInsideProject(path, cwd)) {
		const rel = relative(cwd, path);
		return rel === "" ? "." : rel.split(sep).join("/");
	}
	return path;
}
