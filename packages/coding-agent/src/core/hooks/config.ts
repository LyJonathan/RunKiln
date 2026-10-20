/**
 * Shell hooks in Claude Code's settings format.
 *
 * ```json
 * { "hooks": { "PreToolUse": [ { "matcher": "bash|edit", "hooks": [ { "type": "command", "command": "./check.sh", "timeout": 30 } ] } ] } }
 * ```
 *
 * Where hooks are read from, in order:
 * - global: `~/.runkiln/agent/settings.json`
 * - project: `<project>/.runkiln/settings.json` and `<project>/.runkiln/settings.local.json`
 * - claude (only with the global setting `claudeHooks: true`): `<project>/.claude/settings.json` and
 *   `<project>/.claude/settings.local.json`, so a repository's existing Claude Code hooks work unchanged.
 *
 * Project and claude hooks are only read when the project folder is trusted, and only run after a one-time
 * confirmation of exactly those commands (see trust.ts): a cloned repository must not run commands on its own.
 * `disableAllHooks: true` in global settings turns every hook off.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME } from "../../config.ts";
import { stripBom } from "../../utils/text.ts";

/** The events RunKiln runs hooks for. */
export const HOOK_EVENTS = [
	"PreToolUse",
	"PostToolUse",
	"UserPromptSubmit",
	"Stop",
	"Notification",
	"SessionStart",
	"PreCompact",
] as const;

export type HookEventName = (typeof HOOK_EVENTS)[number];

/** Events whose matcher filters on a value (tool name, source, trigger, notification type). */
export const MATCHER_EVENTS: ReadonlySet<HookEventName> = new Set([
	"PreToolUse",
	"PostToolUse",
	"SessionStart",
	"PreCompact",
	"Notification",
]);

export type HookScope = "global" | "project" | "claude";

export interface CommandHook {
	type: "command";
	command: string;
	/** Exec form: `command` is the executable and these are its arguments (no shell). */
	args?: string[];
	/** Seconds. Default: 600, or 30 for UserPromptSubmit (as in Claude Code). */
	timeout?: number;
	/** Permission rule syntax filter for tool events, such as `Bash(git *)` or `Edit(*.ts)`. */
	if?: string;
	/** "block": a hook that fails to run, times out or exits with another code blocks like exit code 2. */
	onFailure?: "continue" | "block";
	statusMessage?: string;
}

/** One configured hook with where it came from. */
export interface HookEntry {
	event: HookEventName;
	matcher: string;
	hook: CommandHook;
	scope: HookScope;
	/** The settings file it was read from. */
	source: string;
}

export interface HookConfigProblem {
	source: string;
	message: string;
}

export interface LoadedHooks {
	entries: HookEntry[];
	problems: HookConfigProblem[];
	/** Hook types other than "command" (http, prompt, agent, mcp_tool), which RunKiln does not run. */
	skipped: number;
	disabled: boolean;
}

function readJson(path: string): { value?: Record<string, unknown>; error?: string } {
	if (!existsSync(path)) return {};
	try {
		const parsed = JSON.parse(stripBom(readFileSync(path, "utf8")));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { error: "not a JSON object" };
		return { value: parsed as Record<string, unknown> };
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}

/** Parse the `hooks` object of one settings file. */
export function parseHooksObject(
	raw: unknown,
	scope: HookScope,
	source: string,
): { entries: HookEntry[]; problems: HookConfigProblem[]; skipped: number } {
	const entries: HookEntry[] = [];
	const problems: HookConfigProblem[] = [];
	let skipped = 0;
	if (raw === undefined) return { entries, problems, skipped };
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		return { entries, problems: [{ source, message: "`hooks` must be an object keyed by event name" }], skipped };
	}
	for (const [event, groups] of Object.entries(raw as Record<string, unknown>)) {
		// SubagentStop: subagents were removed; old configs keep loading without a warning.
		if (event === "SubagentStop") continue;
		if (!(HOOK_EVENTS as readonly string[]).includes(event)) {
			problems.push({ source, message: `${event}: not an event RunKiln runs (${HOOK_EVENTS.join(", ")})` });
			continue;
		}
		if (!Array.isArray(groups)) {
			problems.push({ source, message: `${event}: expected an array of matcher groups` });
			continue;
		}
		for (const group of groups) {
			if (!group || typeof group !== "object") continue;
			const { matcher, hooks } = group as { matcher?: unknown; hooks?: unknown };
			if (!Array.isArray(hooks)) {
				problems.push({ source, message: `${event}: a matcher group needs a \`hooks\` array` });
				continue;
			}
			for (const hook of hooks) {
				if (!hook || typeof hook !== "object") continue;
				const h = hook as Record<string, unknown>;
				if (h.type !== "command") {
					skipped++;
					continue;
				}
				if (typeof h.command !== "string" || !h.command.trim()) {
					problems.push({ source, message: `${event}: a command hook needs a \`command\`` });
					continue;
				}
				const parsed: CommandHook = { type: "command", command: h.command };
				if (Array.isArray(h.args) && h.args.every((a) => typeof a === "string")) parsed.args = h.args as string[];
				if (typeof h.timeout === "number" && Number.isFinite(h.timeout) && h.timeout > 0)
					parsed.timeout = h.timeout;
				if (typeof h.if === "string" && h.if.trim()) parsed.if = h.if.trim();
				if (h.onFailure === "block" || h.onFailure === "continue") parsed.onFailure = h.onFailure;
				if (typeof h.statusMessage === "string") parsed.statusMessage = h.statusMessage;
				entries.push({
					event: event as HookEventName,
					matcher: typeof matcher === "string" ? matcher : "",
					hook: parsed,
					scope,
					source,
				});
			}
		}
	}
	return { entries, problems, skipped };
}

export interface HookSources {
	/** The global settings object (already loaded by SettingsManager). */
	globalSettings: Record<string, unknown>;
	cwd: string;
	/** Whether the project folder is trusted at all (project trust); untrusted folders contribute nothing. */
	projectTrusted: boolean;
}

/** The project settings files hooks are read from, with their scope. */
export function projectHookFiles(cwd: string, claude: boolean): Array<{ path: string; scope: HookScope }> {
	const files: Array<{ path: string; scope: HookScope }> = [
		{ path: join(cwd, CONFIG_DIR_NAME, "settings.json"), scope: "project" },
		{ path: join(cwd, CONFIG_DIR_NAME, "settings.local.json"), scope: "project" },
	];
	if (claude) {
		files.push(
			{ path: join(cwd, ".claude", "settings.json"), scope: "claude" },
			{ path: join(cwd, ".claude", "settings.local.json"), scope: "claude" },
		);
	}
	return files;
}

/** Load every configured hook. Identical handlers (same event, matcher and command) run once. */
export function loadHooks(sources: HookSources): LoadedHooks {
	const result: LoadedHooks = { entries: [], problems: [], skipped: 0, disabled: false };
	const global = sources.globalSettings;
	if (global.disableAllHooks === true) {
		result.disabled = true;
		return result;
	}
	const add = (raw: unknown, scope: HookScope, source: string) => {
		const parsed = parseHooksObject(raw, scope, source);
		result.entries.push(...parsed.entries);
		result.problems.push(...parsed.problems);
		result.skipped += parsed.skipped;
	};
	add(global.hooks, "global", "global settings");
	if (sources.projectTrusted) {
		for (const file of projectHookFiles(sources.cwd, global.claudeHooks === true)) {
			const { value, error } = readJson(file.path);
			if (error) result.problems.push({ source: file.path, message: error });
			if (value?.disableAllHooks === true && file.scope !== "global") {
				// A project can turn its own hooks off, never the user's.
				continue;
			}
			if (value) add(value.hooks, file.scope, file.path);
		}
	}
	const seen = new Set<string>();
	result.entries = result.entries.filter((entry) => {
		const key = JSON.stringify([
			entry.event,
			entry.matcher,
			entry.hook.command,
			entry.hook.args ?? null,
			entry.hook.if,
		]);
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
	return result;
}

/** Fingerprint of the project hooks, so a changed command asks for trust again. */
export function projectHooksFingerprint(entries: readonly HookEntry[]): string | undefined {
	const project = entries.filter((entry) => entry.scope !== "global");
	if (project.length === 0) return undefined;
	const canonical = project
		.map((e) => JSON.stringify([e.event, e.matcher, e.hook.command, e.hook.args ?? null, e.hook.if ?? null]))
		.sort()
		.join("\n");
	return createHash("sha256").update(canonical).digest("hex").slice(0, 32);
}

/** Claude Code's names for RunKiln's built-in tools, so matchers written for Claude Code match. */
export const CLAUDE_TOOL_ALIASES: Readonly<Record<string, readonly string[]>> = {
	bash: ["Bash"],
	powershell: ["PowerShell"],
	read: ["Read"],
	edit: ["Edit", "MultiEdit"],
	write: ["Write"],
	grep: ["Grep"],
	find: ["Glob"],
	ls: ["LS"],
	task: ["Task", "Agent"],
	bash_output: ["BashOutput", "KillShell"],
};

const EXACT_MATCHER = /^[A-Za-z0-9_\-\s,|]*$/;

/**
 * Claude Code's matcher rules: "", "*" or no matcher match everything; letters, digits, `_`, `-`, spaces, `,` and `|`
 * only means exact names separated by `|` or `,`; anything else is an unanchored JavaScript regular expression.
 * `values` holds the value and its aliases (for tools: RunKiln's name and Claude Code's).
 */
export function matcherMatches(matcher: string, values: readonly string[]): boolean {
	const trimmed = matcher.trim();
	if (trimmed === "" || trimmed === "*") return true;
	if (EXACT_MATCHER.test(trimmed)) {
		const names = trimmed
			.split(/[|,]/)
			.map((name) => name.trim())
			.filter(Boolean);
		return names.some((name) => values.includes(name));
	}
	let regex: RegExp;
	try {
		regex = new RegExp(trimmed);
	} catch {
		return false;
	}
	return values.some((value) => regex.test(value));
}

/** The values a tool-event matcher is tested against: RunKiln's tool name and Claude Code's names for it. */
export function toolMatchValues(toolName: string): string[] {
	return [toolName, ...(CLAUDE_TOOL_ALIASES[toolName] ?? [])];
}
