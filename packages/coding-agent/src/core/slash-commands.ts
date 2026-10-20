import { APP_NAME } from "../config.ts";
import type { SourceInfo } from "./source-info.ts";

export type SlashCommandSource = "extension" | "prompt" | "skill";

export interface SlashCommandInfo {
	name: string;
	description?: string;
	source: SlashCommandSource;
	sourceInfo: SourceInfo;
}

export interface BuiltinSlashCommand {
	name: string;
	description: string;
	argumentHint?: string;
}

export const BUILTIN_SLASH_COMMANDS: ReadonlyArray<BuiltinSlashCommand> = [
	{ name: "help", description: "Commands, keyboard shortcuts and @/! syntax" },
	{
		name: "permissions",
		description: "What runs without asking: ask, read & write, plan, auto, allow all; rules",
		argumentHint: "[mode|rules|clear|allow|ask|deny <rule>]",
	},
	{ name: "status", description: "Session, model, routing, permissions, keys, context and cost at a glance" },
	{
		name: "usage",
		description: "Cost, cache, models, turns, context and history (tabs)",
		argumentHint: "[overview|models|turns|context|history|today|week|month|all]",
	},
	{
		name: "diff",
		description: "Review the files changed this session (/diff git: uncommitted changes)",
		argumentHint: "[review|git]",
	},
	{
		name: "test",
		description: "Run the project's tests now; /test off|ask|auto sets when they run after changes",
		argumentHint: "[off|ask|auto|<command>]",
	},
	{
		name: "review",
		description: "Read-only code review: findings by priority (P0-P3) with file:line",
		argumentHint: "[uncommitted|<commit>|<branch>]",
	},
	{
		name: "commit",
		description: "Commit the session's changes with a generated message (edit or confirm first)",
		argumentHint: "[turn|session|all]",
	},
	{
		name: "map",
		description: "Repo map: files and key symbols ranked by relevance (what the repo_map tool returns)",
		argumentHint: "[tokens] [paths…] [words…]",
	},
	{ name: "init", description: "Ask the agent to write or improve AGENTS.md for this project" },
	{ name: "doctor", description: "Check Node, git, keys, settings and terminal for problems" },
	{ name: "settings", description: "Open settings menu" },
	{
		name: "model",
		description: "Select model or auto (opens selector UI)",
		argumentHint: "<model|auto[:low|medium|high]>",
	},
	{
		name: "router",
		description: "Why auto picked the model (scores, cost); on/off; mode low/medium/high",
		argumentHint: "[on|off|low|medium|high]",
	},
	{ name: "todo", description: "Show the agent's todo list in full (or fold it back)" },
	{ name: "undo", description: "Undo the last turn's file changes (asks first; the conversation stays)" },
	{
		name: "hooks",
		description: "Shell hooks from settings: list, trust project hooks",
		argumentHint: "[trust|untrust|reload]",
	},
	{
		name: "mcp",
		description: "MCP servers: status, tools, reconnect, trust project servers",
		argumentHint: "[reconnect <server|all>|tools <server>|trust]",
	},
	{
		name: "jobs",
		description: "Background shell jobs: list, show output, kill",
		argumentHint: "[<id>|kill <id|all>]",
	},
	{ name: "rewind", description: "Go back to before an earlier turn: files, conversation, or both" },
	{ name: "tree", description: "Navigate session tree (switch branches)" },
	{ name: "thinking", description: "Set thinking level (auto: router picks)", argumentHint: "<level|auto>" },
	{ name: "export", description: "Export session (HTML default, or specify path: .html/.jsonl)" },
	{ name: "import", description: "Import and resume a session from a JSONL file" },
	{ name: "share", description: "Share session via a Radius artifact or a GitHub gist" },
	{ name: "bug", description: "Report a bug to the RunKiln developers", argumentHint: "<description>" },
	{ name: "copy", description: "Copy last agent message (/copy md, /copy code [n] for a code block)" },
	{ name: "name", description: "Set session display name" },
	{ name: "changelog", description: "Show changelog entries" },
	{ name: "fork", description: "New session from a previous message, or a copy of this one" },
	{ name: "trust", description: "Save project trust decision for future sessions" },
	{
		name: "setup",
		description: "Keys, default model, routing, permissions, theme and footer; wizard runs first-time setup",
		argumentHint: "[keys|model|routing|permissions|look|footer|wizard]",
	},
	{ name: "new", description: "Start a new session (clears the conversation)" },
	{ name: "compact", description: "Manually compact the session context" },
	{ name: "resume", description: "Resume a different session" },
	{ name: "reload", description: "Reload keybindings, extensions, skills, prompts, themes, and context files" },
	{ name: "quit", description: `Quit ${APP_NAME}` },
];

/**
 * Old names that still work but are not listed: each one says its new name once per session. They are reserved
 * like the listed commands, so an extension cannot take them over.
 */
export const HIDDEN_SLASH_ALIASES: Readonly<Record<string, string>> = {
	key: "/setup keys",
	login: "/setup keys",
	logout: "/setup keys",
	runinfra: "/setup keys",
	models: "/setup model",
	"scoped-models": "/setup model",
	statusline: "/setup footer",
	cost: "/usage",
	stats: "/usage",
	session: "/status",
	hotkeys: "/help",
	clear: "/new",
	exit: "/quit",
	clone: "/fork",
};

/** Every built-in name, listed or hidden. */
export const BUILTIN_SLASH_COMMAND_NAMES: ReadonlySet<string> = new Set([
	...BUILTIN_SLASH_COMMANDS.map((command) => command.name),
	...Object.keys(HIDDEN_SLASH_ALIASES),
]);
