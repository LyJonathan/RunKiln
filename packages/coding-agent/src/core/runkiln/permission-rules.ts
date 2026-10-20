/**
 * Saved permission rules: allow, ask and deny, written like Claude Code's permission rules.
 *
 * A rule is a tool name with an optional specifier in parentheses:
 *
 * - `Bash`, `Bash(npm test)`, `Bash(npm run build:*)`, `Bash(git status *)`: shell commands. Without parentheses (or
 *   with `*`) every command matches. A specifier ending in `:*` or ` *` matches commands that start with those words;
 *   otherwise the command must be exactly that (spacing ignored). `PowerShell(...)` is the same for powershell, and
 *   `Shell(...)` matches both.
 * - `Read`, `Read(src/**)`, `Read(~/.ssh/**)`: read, grep, find and ls. `Grep(...)`, `Find(...)` and `Ls(...)` name
 *   one of them.
 * - `Edit`, `Edit(src/**)`, `Write(docs/*.md)`: the write and edit tools (Edit and Write mean the same).
 * - Any other name, such as `mcp__github__create_issue` or `mcp__github__*`: that tool, `*` matching any characters.
 *
 * Path specifiers are globs. `*` matches inside one path name, `**` across folders, `?` one character. A pattern
 * without a slash matches that name at any depth (`*.pem`, `.env`); `./x` and `x/y` are relative to the project
 * folder; `/x` is absolute and `~/x` is in the home folder. A pattern also matches everything inside a folder it
 * matches, so `Read(secrets)` covers `secrets/key.txt`. Both the path as written (resolved) and its real path
 * (links followed) are checked.
 *
 * Where rules live:
 * - Global settings (`~/.runkiln/agent/settings.json`), `permissions.allow` / `ask` / `deny`.
 * - Global settings, `permissions.projects["<project folder>"]`: rules for one project, written by "always allow in
 *   this project" in the approval prompt and by `/permissions allow … --project`.
 * - The project's own `.runkiln/settings.json`, `permissions.ask` / `deny`. A project may only tighten: its allow
 *   rules are ignored (and shown as ignored in `/permissions rules`), because a repository you clone must not be able
 *   to let commands run without asking.
 *
 * Deny beats ask, ask beats allow. Deny rules apply in every mode, plan and allow-all included. Ask rules apply in
 * every mode except allow-all. Allow rules never approve a risky call (see riskReasons) and never lift plan mode.
 * Shell matching is best effort: it reads the command the way approval.ts splits it (every part of a chain, and the
 * commands inside `$(...)`), so a deny rule is a guard rail, not a sandbox.
 */

import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { resolveToCwd } from "../tools/path-utils.ts";
import {
	analyzeShellCommand,
	isInsideProject,
	NO_PROMPT_TOOLS,
	powershellUnsafe,
	realpathDeep,
	SHELL_TOOLS,
	sanitizeForPrompt,
	type ToolCallOptions,
	WRITE_TOOLS,
} from "./approval.ts";

export type RuleAction = "allow" | "ask" | "deny";

export const RULE_ACTIONS: readonly RuleAction[] = Object.freeze(["deny", "ask", "allow"]);

/** Where a saved rule comes from, from the narrowest to the widest. */
export type RuleScope = "project-file" | "project" | "global";

export const RULE_SCOPE_LABELS: Record<RuleScope, string> = {
	"project-file": "Project file (.runkiln/settings.json)",
	project: "This project (your settings)",
	global: "Global (your settings)",
};

export type ParsedRule =
	| { kind: "shell"; tools: readonly string[]; match: "any" | "exact" | "prefix"; words: readonly string[] }
	| { kind: "path"; tools: readonly string[]; pattern?: string }
	| { kind: "tool"; pattern: string };

/** One rule as saved, with its parse. */
export interface SavedRule {
	action: RuleAction;
	scope: RuleScope;
	/** The rule as written in settings. */
	text: string;
	rule: ParsedRule;
}

/** A rule from settings that cannot be used, with the reason (shown in /permissions rules). */
export interface IgnoredRule {
	action: RuleAction;
	scope: RuleScope;
	text: string;
	reason: string;
}

export interface RawRuleLists {
	allow?: unknown;
	ask?: unknown;
	deny?: unknown;
}

export interface LoadedRules {
	rules: SavedRule[];
	ignored: IgnoredRule[];
}

// The path-taking read tools a `Read(...)` rule covers (repo_map runs without asking but takes no path rule).
const READ_TOOLS: readonly string[] = Object.freeze(NO_PROMPT_TOOLS.filter((tool) => tool !== "repo_map"));
const EDIT_TOOLS: readonly string[] = Object.freeze([...WRITE_TOOLS]);

const NAMED_KINDS: Record<string, { kind: "shell" | "path"; tools: readonly string[]; label: string }> = {
	bash: { kind: "shell", tools: ["bash"], label: "Bash" },
	powershell: { kind: "shell", tools: ["powershell"], label: "PowerShell" },
	shell: { kind: "shell", tools: [...SHELL_TOOLS], label: "Shell" },
	read: { kind: "path", tools: READ_TOOLS, label: "Read" },
	grep: { kind: "path", tools: ["grep"], label: "Grep" },
	find: { kind: "path", tools: ["find"], label: "Find" },
	ls: { kind: "path", tools: ["ls"], label: "Ls" },
	edit: { kind: "path", tools: EDIT_TOOLS, label: "Edit" },
	write: { kind: "path", tools: EDIT_TOOLS, label: "Write" },
};

const TOOL_NAME = /^[A-Za-z0-9_.:*-]+$/;

function words(text: string): string[] {
	return text.trim().split(/\s+/).filter(Boolean);
}

/** The parse of one rule, or an error message. */
export function parseRule(text: string): ParsedRule | { error: string } {
	const trimmed = typeof text === "string" ? text.trim() : "";
	if (!trimmed) return { error: "empty rule" };
	const open = trimmed.indexOf("(");
	let name = trimmed;
	let spec: string | undefined;
	if (open >= 0) {
		if (!trimmed.endsWith(")")) return { error: "missing closing parenthesis" };
		name = trimmed.slice(0, open).trim();
		spec = trimmed.slice(open + 1, -1).trim();
	}
	if (!name) return { error: "missing tool name" };
	const named = NAMED_KINDS[name.toLowerCase()];
	if (named?.kind === "shell") {
		if (spec === undefined || spec === "" || spec === "*" || spec === ":*") {
			return { kind: "shell", tools: named.tools, match: "any", words: [] };
		}
		let body = spec;
		let match: "exact" | "prefix" = "exact";
		if (body.endsWith(":*")) {
			match = "prefix";
			body = body.slice(0, -2);
		} else if (/\s\*$/.test(body)) {
			match = "prefix";
			body = body.slice(0, -1);
		}
		const parts = words(body);
		if (parts.length === 0) return { error: "empty command" };
		if (parts.some((part) => part.includes("*"))) {
			return { error: "a command rule takes `*` only at the end (`npm run test:*`)" };
		}
		return { kind: "shell", tools: named.tools, match, words: parts };
	}
	if (named?.kind === "path") {
		if (spec === undefined || spec === "" || spec === "**") return { kind: "path", tools: named.tools };
		return { kind: "path", tools: named.tools, pattern: spec };
	}
	if (spec !== undefined) return { error: `${sanitizeForPrompt(name)} takes no (…) part; write the tool name alone` };
	if (!TOOL_NAME.test(name)) return { error: "a tool name may hold letters, digits, _ . : - and *" };
	return { kind: "tool", pattern: name };
}

function isParsed(value: ParsedRule | { error: string }): value is ParsedRule {
	return !("error" in value);
}

/**
 * Load the rule lists of one scope. A project file's allow rules are ignored: a project may only tighten.
 */
export function loadRuleLists(raw: RawRuleLists | undefined, scope: RuleScope): LoadedRules {
	const rules: SavedRule[] = [];
	const ignored: IgnoredRule[] = [];
	if (!raw || typeof raw !== "object") return { rules, ignored };
	for (const action of RULE_ACTIONS) {
		const list = (raw as Record<string, unknown>)[action];
		if (list === undefined) continue;
		if (!Array.isArray(list)) {
			ignored.push({ action, scope, text: String(list), reason: `permissions.${action} must be a list of rules` });
			continue;
		}
		for (const entry of list) {
			const text = typeof entry === "string" ? entry.trim() : String(entry);
			if (action === "allow" && scope === "project-file") {
				ignored.push({ action, scope, text, reason: "a project's settings can only tighten permissions" });
				continue;
			}
			const parsed = typeof entry === "string" ? parseRule(entry) : { error: "a rule must be a string" };
			if (isParsed(parsed)) rules.push({ action, scope, text, rule: parsed });
			else ignored.push({ action, scope, text, reason: parsed.error });
		}
	}
	return { rules, ignored };
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

function escapeRegex(text: string): string {
	return text.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

/** A glob as a regular expression over forward-slashed paths. */
export function globToRegExp(glob: string, ignoreCase: boolean): RegExp {
	let out = "";
	for (let i = 0; i < glob.length; i++) {
		const ch = glob[i];
		if (ch === "*") {
			if (glob[i + 1] === "*") {
				const slash = glob[i + 2] === "/";
				out += slash ? "(?:.*/)?" : ".*";
				i += slash ? 2 : 1;
			} else {
				out += "[^/]*";
			}
		} else if (ch === "?") {
			out += "[^/]";
		} else {
			out += escapeRegex(ch);
		}
	}
	return new RegExp(`^${out}$`, ignoreCase ? "i" : "");
}

function slashed(path: string): string {
	return path.split(sep).join("/").replace(/\\/g, "/");
}

/** The path and every folder above it, so a pattern that names a folder covers what is inside. */
function withAncestors(path: string): string[] {
	const parts = path.split("/");
	const out: string[] = [];
	for (let i = parts.length; i >= 1; i--) {
		const candidate = parts.slice(0, i).join("/");
		if (candidate !== "" || i === 1) out.push(candidate || "/");
	}
	return out;
}

function expandHome(pattern: string): string {
	if (pattern === "~") return homedir();
	if (pattern.startsWith("~/")) return join(homedir(), pattern.slice(2));
	return pattern;
}

/**
 * Whether `pattern` matches the target path. Relative patterns are matched against the path inside the project
 * (never against a path outside it); absolute and `~/` patterns against the absolute path.
 */
export function pathPatternMatches(
	pattern: string,
	absoluteTargets: readonly string[],
	cwd: string,
	ignoreCase: boolean,
): boolean {
	let spec = pattern.trim();
	const absolute = spec.startsWith("~") || isAbsolute(spec) || /^[A-Za-z]:[\\/]/.test(spec);
	if (absolute) spec = slashed(resolve(expandHome(spec)));
	else {
		spec = slashed(spec).replace(/^\.\//, "");
		if (spec.endsWith("/")) spec = `${spec}**`;
		if (!spec.includes("/")) spec = `**/${spec}`;
	}
	const regex = globToRegExp(spec, ignoreCase);
	const root = resolve(cwd);
	for (const target of absoluteTargets) {
		if (absolute) {
			if (withAncestors(slashed(resolve(target))).some((candidate) => regex.test(candidate))) return true;
			continue;
		}
		const rel = relative(root, resolve(target));
		if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) continue;
		const inside = slashed(rel);
		if (inside === "") {
			if (regex.test("") || regex.test(".")) return true;
			continue;
		}
		if (withAncestors(inside).some((candidate) => regex.test(candidate))) return true;
	}
	return false;
}

/** The resolved target of a path tool call and its real path, when it has one. */
function pathTargets(toolName: string, input: Record<string, unknown>, cwd: string): string[] | undefined {
	const raw = typeof input.path === "string" && input.path.trim() !== "" ? input.path : undefined;
	if (!raw) {
		// grep, find and ls default to the project folder; write and edit need a path.
		return WRITE_TOOLS.has(toolName) ? undefined : [resolve(cwd)];
	}
	const target = resolveToCwd(raw, cwd);
	const targets = [target];
	try {
		const real = realpathDeep(target);
		if (real !== resolve(target)) targets.push(real);
	} catch {
		// An unresolvable path is matched as written.
	}
	return targets;
}

function normalizeCommandWords(segment: string): string[] {
	const parts = words(segment);
	// FOO=1 git push: the assignments are not the command.
	while (parts.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(parts[0])) parts.shift();
	return parts;
}

function commandMatches(rule: Extract<ParsedRule, { kind: "shell" }>, segment: string, lenient: boolean): boolean {
	if (rule.match === "any") return true;
	const parts = normalizeCommandWords(segment);
	const variants = [parts];
	// /usr/bin/rm -rf x is rm -rf x for a deny or ask rule.
	if (lenient && parts.length > 0 && basename(parts[0]) !== parts[0])
		variants.push([basename(parts[0]), ...parts.slice(1)]);
	return variants.some((candidate) => {
		const same = (a: string, b: string) => (lenient ? a.toLowerCase() === b.toLowerCase() : a === b);
		if (rule.match === "exact" && candidate.length !== rule.words.length) return false;
		if (candidate.length < rule.words.length) return false;
		return rule.words.every((word, index) => same(word, candidate[index]));
	});
}

function toolPatternMatches(pattern: string, toolName: string): boolean {
	if (!pattern.includes("*")) return pattern === toolName;
	return new RegExp(`^${pattern.split("*").map(escapeRegex).join(".*")}$`).test(toolName);
}

/** The commands of a shell call: every part of a chain, plus the commands inside substitutions. */
function shellParts(command: string, cwd: string): { segments: string[]; nested: string[] } {
	const analysis = analyzeShellCommand(command, cwd);
	const nested = analysis.substitutions.flatMap((sub) => {
		const body = sub.replace(/^[$<>]\(|\)$|^`|`$/g, "");
		return analyzeShellCommand(body, cwd).segments;
	});
	return { segments: analysis.segments, nested };
}

/**
 * Whether a deny or ask rule matches the call. Matching is lenient (any part of a shell command, case-insensitive
 * paths, any tool under a built-in name), because a stricter answer is the safe failure.
 */
export function restrictiveRuleMatches(rule: ParsedRule, toolName: string, args: unknown, cwd: string): boolean {
	const input = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
	switch (rule.kind) {
		case "tool":
			return toolPatternMatches(rule.pattern, toolName);
		case "shell": {
			if (!rule.tools.includes(toolName)) return false;
			const command = typeof input.command === "string" ? input.command : "";
			if (rule.match === "any") return true;
			const { segments, nested } = shellParts(command, cwd);
			return [...segments, ...nested].some((segment) => commandMatches(rule, segment, true));
		}
		case "path": {
			if (!rule.tools.includes(toolName)) return false;
			if (rule.pattern === undefined) return true;
			const targets = pathTargets(toolName, input, cwd);
			if (!targets) return false;
			return pathPatternMatches(rule.pattern, targets, cwd, true);
		}
	}
}

/**
 * Whether allow rules cover the call. Strict: built-in names only for the genuine built-in tools, every part of a
 * shell chain covered and no command substitution, case-sensitive paths.
 */
export function allowRulesCover(
	rules: readonly ParsedRule[],
	toolName: string,
	args: unknown,
	cwd: string,
	options: ToolCallOptions = {},
): boolean {
	if (rules.length === 0) return false;
	const input = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
	const genuine = options.builtin === true;
	if (SHELL_TOOLS.has(toolName)) {
		const shellRules = rules.filter(
			(rule): rule is Extract<ParsedRule, { kind: "shell" }> =>
				rule.kind === "shell" && rule.tools.includes(toolName),
		);
		if (shellRules.length === 0) return false;
		const command = typeof input.command === "string" ? input.command : "";
		// PowerShell expressions can hide any command inside an argument, so no allow rule covers them, not even "any".
		if (powershellUnsafe(toolName, command)) return false;
		const analysis = analyzeShellCommand(command, cwd);
		if (analysis.segments.length === 0) return false;
		if (shellRules.some((rule) => rule.match === "any")) return true;
		if (analysis.substitutions.length > 0) return false;
		return analysis.segments.every((segment) => shellRules.some((rule) => commandMatches(rule, segment, false)));
	}
	const builtinName = READ_TOOLS.includes(toolName) || WRITE_TOOLS.has(toolName);
	for (const rule of rules) {
		if (rule.kind === "tool") {
			// A tool rule never covers shell commands or the built-in file tools; Bash(...)/Read(...)/Edit(...) do.
			if (builtinName && genuine) continue;
			if (toolPatternMatches(rule.pattern, toolName)) return true;
			continue;
		}
		if (rule.kind !== "path" || !rule.tools.includes(toolName) || !genuine) continue;
		if (rule.pattern === undefined) return true;
		const targets = pathTargets(toolName, input, cwd);
		if (targets && pathPatternMatches(rule.pattern, targets, cwd, false)) return true;
	}
	return false;
}

/** What the saved rules say about a call before the mode is applied. */
export type RuleVerdict = { action: RuleAction; rule: SavedRule } | undefined;

/** Deny beats ask, ask beats allow. Allow is reported only when allow rules cover the whole call. */
export function evaluateSavedRules(
	rules: readonly SavedRule[],
	toolName: string,
	args: unknown,
	cwd: string,
	options: ToolCallOptions = {},
): RuleVerdict {
	for (const action of ["deny", "ask"] as const) {
		const hit = rules.find(
			(saved) => saved.action === action && restrictiveRuleMatches(saved.rule, toolName, args, cwd),
		);
		if (hit) return { action, rule: hit };
	}
	const allows = rules.filter((saved) => saved.action === "allow");
	if (
		allows.length > 0 &&
		allowRulesCover(
			allows.map((saved) => saved.rule),
			toolName,
			args,
			cwd,
			options,
		)
	) {
		// Report the first rule that covers the call alone, else the first allow rule (a chain covered by several).
		const single = allows.find((saved) => allowRulesCover([saved.rule], toolName, args, cwd, options));
		return { action: "allow", rule: single ?? allows[0] };
	}
	return undefined;
}

/** A rule in its canonical written form. */
export function formatRule(rule: ParsedRule): string {
	switch (rule.kind) {
		case "tool":
			return rule.pattern;
		case "shell": {
			const name = rule.tools.length > 1 ? "Shell" : rule.tools[0] === "powershell" ? "PowerShell" : "Bash";
			if (rule.match === "any") return name;
			return `${name}(${rule.words.join(" ")}${rule.match === "prefix" ? ":*" : ""})`;
		}
		case "path": {
			const name =
				rule.tools.length === READ_TOOLS.length && rule.tools.every((tool) => READ_TOOLS.includes(tool))
					? "Read"
					: rule.tools.some((tool) => WRITE_TOOLS.has(tool))
						? "Edit"
						: (NAMED_KINDS[rule.tools[0]]?.label ?? rule.tools[0]);
			return rule.pattern === undefined ? name : `${name}(${rule.pattern})`;
		}
	}
}

/** A rule as a short phrase for messages ("commands starting with `npm test`"). */
export function describeSavedRule(text: string): string {
	const parsed = parseRule(text);
	if (!isParsed(parsed)) return `\`${sanitizeForPrompt(text)}\``;
	switch (parsed.kind) {
		case "tool":
			return parsed.pattern.includes("*")
				? `tools matching \`${parsed.pattern}\``
				: `the \`${parsed.pattern}\` tool`;
		case "shell":
			if (parsed.match === "any") return "every shell command";
			return parsed.match === "prefix"
				? `commands starting with \`${sanitizeForPrompt(parsed.words.join(" "))}\``
				: `the command \`${sanitizeForPrompt(parsed.words.join(" "))}\``;
		case "path": {
			const what = parsed.tools.some((tool) => WRITE_TOOLS.has(tool)) ? "edits" : "reads";
			return parsed.pattern === undefined ? `all ${what}` : `${what} of \`${sanitizeForPrompt(parsed.pattern)}\``;
		}
	}
}

/** Globs have no escape syntax, so a path holding glob characters cannot be saved as a rule. */
function globSafe(path: string): boolean {
	return !/[*?]/.test(path);
}

/**
 * The saved rules ("always allow in this project") for a session suggestion, or undefined when one part has no
 * saved form. Mirrors the session rules in permissions.ts: command prefixes, one file, project edits, reads, a tool.
 */
export function savedRulesForSuggestion(
	sessionRules: ReadonlyArray<
		| { kind: "command"; prefix: string }
		| { kind: "file"; path: string }
		| { kind: "project-edits" }
		| { kind: "reads" }
		| { kind: "tool"; name: string }
	>,
	toolName: string,
	cwd: string,
): string[] | undefined {
	const out: string[] = [];
	for (const rule of sessionRules) {
		switch (rule.kind) {
			case "command": {
				const name = toolName === "powershell" ? "PowerShell" : "Bash";
				if (rule.prefix.includes("*") || rule.prefix.includes(")")) return undefined;
				out.push(`${name}(${rule.prefix}:*)`);
				break;
			}
			case "file": {
				const inside = isInsideProject(rule.path, cwd);
				const shown = inside ? slashed(relative(resolve(cwd), resolve(rule.path))) : slashed(resolve(rule.path));
				if (!shown || !globSafe(shown) || shown.includes(")")) return undefined;
				// A bare name would match at any depth; anchor in-project files to the project folder.
				out.push(`Edit(${inside && !shown.includes("/") ? `./${shown}` : shown})`);
				break;
			}
			case "project-edits":
				out.push("Edit(**)");
				break;
			case "reads":
				out.push("Read");
				break;
			case "tool":
				if (!TOOL_NAME.test(rule.name) || rule.name.includes("*")) return undefined;
				out.push(rule.name);
				break;
		}
	}
	return out.length > 0 ? out : undefined;
}
