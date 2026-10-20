/**
 * CLI argument parsing and help display
 */

import type { ThinkingLevel } from "@runkiln/agent-core";
import chalk from "chalk";
import { APP_NAME, CONFIG_DIR_NAME, ENV_AGENT_DIR, ENV_SESSION_DIR } from "../config.ts";
import { PERMISSION_MODE_VALUES, type PermissionMode, parsePermissionMode } from "../core/runkiln/permissions.ts";
import { getToolListError, type TuiMode } from "../core/settings-manager.ts";

export type Mode = "text" | "json" | "rpc";

export interface Args {
	provider?: string;
	model?: string;
	systemPrompt?: string;
	appendSystemPrompt?: string[];
	thinking?: ThinkingLevel;
	/** --thinking auto: in auto mode the router picks the thinking level (the default). */
	thinkingAuto?: boolean;
	/** --router-classifier: jev, openrouter, auto (pick by available key) or off. */
	routerClassifier?: "jev" | "openrouter" | "auto" | "off";
	/** --router-model: Jev model name or OpenRouter decision model id for the classifier. */
	routerModel?: string;
	/** --router-mode: low, medium or high (auto routing mode). */
	routerMode?: "low" | "medium" | "high";
	/** --permissions: ask, read-write, plan, auto or allow-all (aliases accepted, see parsePermissionMode). */
	permissions?: PermissionMode;
	continue?: boolean;
	resume?: boolean;
	help?: boolean;
	version?: boolean;
	mode?: Mode;
	name?: string;
	noSession?: boolean;
	session?: string;
	sessionId?: string;
	fork?: string;
	sessionDir?: string;
	models?: string[];
	tools?: string[];
	excludeTools?: string[];
	noTools?: boolean;
	noBuiltinTools?: boolean;
	/** RunKiln: chat session (chat model, no tools). */
	chat?: boolean;
	/** RunKiln: parent session id for subagents (sent as x-parent-session-id). */
	parentSessionId?: string;
	print?: boolean;
	export?: string;
	noSkills?: boolean;
	skills?: string[];
	promptTemplates?: string[];
	noPromptTemplates?: boolean;
	useTheme?: string;
	noContextFiles?: boolean;
	listModels?: string | true;
	offline?: boolean;
	/** Print mode: run the tests after file-changing turns (verify loop) and exit non-zero if they still fail. */
	verify?: boolean;
	tuiMode?: TuiMode;
	verbose?: boolean;
	projectTrustOverride?: boolean;
	/** --worktree [name]: run the session in a new git worktree and branch; true when no name was given. */
	worktree?: string | true;
	messages: string[];
	fileArgs: string[];
	/** Unknown flags (potentially extension flags) - map of flag name to value */
	unknownFlags: Map<string, boolean | string>;
	diagnostics: Array<{ type: "warning" | "error"; message: string }>;
}

const VALID_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export function isValidThinkingLevel(level: string): level is ThinkingLevel {
	return VALID_THINKING_LEVELS.includes(level as ThinkingLevel);
}

export function normalizeSessionName(value: string): string | undefined {
	const name = value.trim();
	return name.length > 0 ? name : undefined;
}

export function parseArgs(args: string[]): Args {
	const result: Args = {
		messages: [],
		fileArgs: [],
		unknownFlags: new Map(),
		diagnostics: [],
	};

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];

		if (arg === "--") {
			for (const positionalArg of args.slice(i + 1)) {
				if (positionalArg.startsWith("@")) {
					result.fileArgs.push(positionalArg.slice(1));
				} else {
					result.messages.push(positionalArg);
				}
			}
			break;
		} else if (arg === "--help" || arg === "-h") {
			result.help = true;
		} else if (arg === "--version" || arg === "-v") {
			result.version = true;
		} else if (arg === "--mode") {
			const mode = args[i + 1];
			if (mode === undefined || mode.startsWith("-")) {
				result.diagnostics.push({ type: "error", message: "--mode requires text, json, or rpc" });
				continue;
			}
			i++;
			if (mode !== "text" && mode !== "json" && mode !== "rpc") {
				result.diagnostics.push({
					type: "error",
					message: `Invalid mode "${mode}". Valid values: text, json, rpc`,
				});
				continue;
			}
			result.mode = mode;
		} else if (arg === "--continue" || arg === "-c") {
			result.continue = true;
		} else if (arg === "--resume" || arg === "-r") {
			result.resume = true;
		} else if (arg === "--provider" && i + 1 < args.length) {
			result.provider = args[++i];
		} else if (arg === "--model" && i + 1 < args.length) {
			result.model = args[++i];
		} else if (arg === "--system-prompt" && i + 1 < args.length) {
			result.systemPrompt = args[++i];
		} else if (arg === "--append-system-prompt" && i + 1 < args.length) {
			result.appendSystemPrompt = result.appendSystemPrompt ?? [];
			result.appendSystemPrompt.push(args[++i]);
		} else if (arg === "--name" || arg === "-n") {
			if (i + 1 < args.length) {
				result.name = args[++i];
			} else {
				result.diagnostics.push({ type: "error", message: "--name requires a value" });
			}
		} else if (arg === "--no-session") {
			result.noSession = true;
		} else if (arg === "--session" && i + 1 < args.length) {
			result.session = args[++i];
		} else if (arg === "--session-id" && i + 1 < args.length) {
			result.sessionId = args[++i];
		} else if (arg === "--fork" && i + 1 < args.length) {
			result.fork = args[++i];
		} else if (arg === "--session-dir" && i + 1 < args.length) {
			result.sessionDir = args[++i];
		} else if (arg === "--models" && i + 1 < args.length) {
			result.models = args[++i]
				.split(",")
				.map((s) => s.trim())
				.filter((pattern) => pattern.length > 0);
		} else if (arg === "--no-tools" || arg === "-nt") {
			result.noTools = true;
		} else if (arg === "--no-builtin-tools" || arg === "-nbt") {
			result.noBuiltinTools = true;
		} else if ((arg === "--tools" || arg === "-t") && i + 1 < args.length) {
			const tools = args[++i]
				.split(",")
				.map((s) => s.trim())
				.filter((name) => name.length > 0);
			const error = getToolListError(tools);
			if (error) {
				result.diagnostics.push({ type: "error", message: `${arg}: ${error}` });
			} else {
				result.tools = tools;
			}
		} else if ((arg === "--exclude-tools" || arg === "-xt") && i + 1 < args.length) {
			result.excludeTools = args[++i]
				.split(",")
				.map((s) => s.trim())
				.filter((name) => name.length > 0);
		} else if (arg === "--router-classifier" && i + 1 < args.length) {
			const value = args[++i].trim().toLowerCase();
			if (value === "jev" || value === "openrouter" || value === "auto" || value === "off") {
				result.routerClassifier = value;
			} else {
				result.diagnostics.push({
					type: "error",
					message: `Invalid --router-classifier "${value}". Valid values: jev, openrouter, auto, off`,
				});
			}
		} else if (arg === "--router-mode" && i + 1 < args.length) {
			const value = args[++i].trim().toLowerCase();
			if (value === "low" || value === "medium" || value === "high") {
				result.routerMode = value;
			} else {
				result.diagnostics.push({
					type: "error",
					message: `Invalid --router-mode "${value}". Valid values: low, medium, high`,
				});
			}
		} else if ((arg === "--permissions" || arg === "--permission-mode") && i + 1 < args.length) {
			const value = args[++i];
			const mode = parsePermissionMode(value);
			if (mode) {
				result.permissions = mode;
			} else {
				result.diagnostics.push({
					type: "error",
					message: `Invalid --permissions "${value.trim()}". Valid values: ${PERMISSION_MODE_VALUES}`,
				});
			}
		} else if (arg === "--yolo") {
			result.permissions = "allow-all";
		} else if (arg === "--router-model" && i + 1 < args.length) {
			result.routerModel = args[++i].trim();
		} else if (arg === "--thinking" && i + 1 < args.length) {
			const level = args[++i];
			if (level === "auto") {
				result.thinkingAuto = true;
			} else if (isValidThinkingLevel(level)) {
				result.thinking = level;
			} else {
				result.diagnostics.push({
					type: "warning",
					message: `Invalid thinking level "${level}". Valid values: ${VALID_THINKING_LEVELS.join(", ")}`,
				});
			}
		} else if (arg === "--print" || arg === "-p") {
			result.print = true;
			const next = args[i + 1];
			if (next !== undefined && !next.startsWith("@") && (!next.startsWith("-") || next.startsWith("---"))) {
				result.messages.push(next);
				i++;
			}
		} else if (arg === "--export" && i + 1 < args.length) {
			result.export = args[++i];
		} else if (arg === "--chat") {
			result.chat = true;
		} else if (arg === "--parent-session-id" && i + 1 < args.length) {
			result.parentSessionId = args[++i];
		} else if (arg === "--skill" && i + 1 < args.length) {
			result.skills = result.skills ?? [];
			result.skills.push(args[++i]);
		} else if (arg === "--prompt-template" && i + 1 < args.length) {
			result.promptTemplates = result.promptTemplates ?? [];
			result.promptTemplates.push(args[++i]);
		} else if (arg === "--use-theme") {
			const themeName = args[i + 1];
			if (themeName === undefined || themeName.startsWith("-")) {
				result.diagnostics.push({ type: "error", message: "--use-theme requires a theme name" });
			} else {
				result.useTheme = themeName;
				i++;
			}
		} else if (arg === "--no-skills" || arg === "-ns") {
			result.noSkills = true;
		} else if (arg === "--no-prompt-templates" || arg === "-np") {
			result.noPromptTemplates = true;
		} else if (arg === "--no-context-files" || arg === "-nc") {
			result.noContextFiles = true;
		} else if (arg === "--list-models") {
			// Check if next arg is a search pattern (not a flag or file arg)
			if (i + 1 < args.length && !args[i + 1].startsWith("-") && !args[i + 1].startsWith("@")) {
				result.listModels = args[++i];
			} else {
				result.listModels = true;
			}
		} else if (arg === "--tui-mode") {
			const mode = args[i + 1];
			if (mode === "regular" || mode === "fullscreen") {
				result.tuiMode = mode;
				i++;
			} else if (mode === undefined || mode.startsWith("-")) {
				result.diagnostics.push({ type: "error", message: "--tui-mode requires regular or fullscreen" });
			} else {
				i++;
				result.diagnostics.push({
					type: "error",
					message: `Invalid TUI mode "${mode}". Valid values: regular, fullscreen`,
				});
			}
		} else if (arg === "--worktree" || arg.startsWith("--worktree=")) {
			// A name is one word (letters, digits, . _ -); anything else that follows is a message.
			const inline = arg.startsWith("--worktree=") ? arg.slice("--worktree=".length) : undefined;
			const next = args[i + 1];
			if (inline !== undefined) result.worktree = inline || true;
			else if (next !== undefined && /^[A-Za-z0-9._-]+$/.test(next) && !next.startsWith("-")) {
				result.worktree = next;
				i++;
			} else result.worktree = true;
		} else if (arg === "--verbose") {
			result.verbose = true;
		} else if (arg === "--approve" || arg === "-a") {
			result.projectTrustOverride = true;
		} else if (arg === "--no-approve" || arg === "-na") {
			result.projectTrustOverride = false;
		} else if (arg === "--offline") {
			result.offline = true;
		} else if (arg === "--verify") {
			result.verify = true;
		} else if (arg.startsWith("@")) {
			result.fileArgs.push(arg.slice(1)); // Remove @ prefix
		} else if (arg.startsWith("--")) {
			const eqIndex = arg.indexOf("=");
			if (eqIndex !== -1) {
				result.unknownFlags.set(arg.slice(2, eqIndex), arg.slice(eqIndex + 1));
			} else {
				const flagName = arg.slice(2);
				const next = args[i + 1];
				if (next !== undefined && !next.startsWith("-") && !next.startsWith("@")) {
					result.unknownFlags.set(flagName, next);
					i++;
				} else {
					result.unknownFlags.set(flagName, true);
				}
			}
		} else if (arg.startsWith("-") && !arg.startsWith("--")) {
			result.diagnostics.push({ type: "error", message: `Unknown option: ${arg}` });
		} else if (!arg.startsWith("-")) {
			result.messages.push(arg);
		}
	}

	return result;
}

export function printHelp(): void {
	console.log(`${chalk.bold(APP_NAME)} - fast coding agent for RunInfra (read, bash, edit, write tools)

${chalk.bold("Usage:")}
  ${APP_NAME} [options] [--] [@files...] [messages...]

${chalk.bold("Commands:")}
  ${APP_NAME} setup [section]        Full-screen setup; with keys|model|routing|permissions|look|footer, the setup hub
  ${APP_NAME} key                    Which keys are set (RunInfra, Jev, OpenRouter) and where they come from
  ${APP_NAME} key set [runinfra|jev|openrouter] [--stdin] [--router-model <id>]
                                 Check and save a key (--stdin: read it from stdin)
  ${APP_NAME} key remove <runinfra|jev|openrouter>   Remove a saved key
  ${APP_NAME} key test [runinfra|jev|openrouter]     Check the active keys live
  ${APP_NAME} review [uncommitted|<commit>|<branch>] [--fail-on P0|P1|P2|P3]
                                 Read-only code review in print mode (CI): findings by priority with file:line;
                                 exit 2 when --fail-on matches a finding
  ${APP_NAME} --worktree [name]      Start the session in a new git worktree and branch (.runkiln/worktrees/<name>);
                                 on exit, merge it, keep it, or remove it

${chalk.bold("Options:")}
  --model <id|auto[:mode]>       Model id, or "auto" / "auto:low|medium|high" to let the router pick model and
                                 thinking per turn (default: the code model, or the chat model with --chat)
  --router-mode <mode>           Auto routing mode: low (cost-efficient), medium (default, leans to quality),
                                 high (deepest model and thinking)
  --thinking <level|auto>        Thinking level: off, minimal, low, medium, high, xhigh, max; with --model auto
                                 a level pins it, "auto" (default) lets the router pick
  --router-classifier <name>     Classifier for --model auto: jev, openrouter, auto (by available key), off
  --router-model <id>            Classifier model: Jev model name or OpenRouter decision model id
  --permissions <mode>           What runs without asking: ask (everything asks), read-write (default: reads and
                                 in-project edits run, commands ask), plan (read-only: research and propose a
                                 plan; writes, edits and commands are blocked until you approve it), auto (a
                                 Jev/OpenRouter model judges each call, risky ones ask), allow-all (nothing asks).
                                 Also RUNKILN_PERMISSIONS. Saved deny rules apply in every mode.
                                 Print mode cannot ask, so calls that would ask are denied there.
  --yolo                         Same as --permissions allow-all
  --chat                         Chat session: chat model from settings/models.yaml, no tools
  --system-prompt <text>         System prompt (default: coding assistant prompt)
  --append-system-prompt <text>  Append text or file contents to the system prompt (can be used multiple times)
  --mode <mode>                  Output mode: text (default), json, or rpc
  --print, -p                    Non-interactive mode: process prompt and exit
  --continue, -c                 Continue previous session
  --resume, -r                   Select a session to resume
  --session <path|id>            Use specific session file or partial UUID
  --session-id <id>              Use exact project session ID, creating it if missing
  --parent-session-id <id>       Run as a subagent of this session (sent as x-parent-session-id)
  --fork <path|id>               Fork specific session file or partial UUID into a new session
  --session-dir <dir>            Directory for session storage and lookup
  --no-session                   Don't save session (ephemeral)
  --name, -n <name>              Set session display name
  --models <patterns>            Comma-separated model patterns for Ctrl+P cycling (before the first message)
  --no-tools, -nt                Disable all tools by default
  --no-builtin-tools, -nbt       Disable built-in tools by default
  --tools, -t <tools>            Comma-separated allowlist of tool names or patterns (*) to enable
                                 Only +name/-name entries add to or remove from the defaults
  --exclude-tools, -xt <tools>   Comma-separated denylist of tool names or patterns (*) to disable
  --skill <path>                 Load a skill file or directory (can be used multiple times)
  --no-skills, -ns               Disable skills discovery and loading
  --prompt-template <path>       Load a prompt template file or directory (can be used multiple times)
  --no-prompt-templates, -np     Disable prompt template discovery and loading
  --use-theme <name>             Set the initial interactive theme (dark, light, system)
  --no-context-files, -nc        Disable AGENTS.md and CLAUDE.md discovery and loading
  --export <file>                Export session file to HTML and exit
  --list-models [search]         List models from models.yaml (with optional fuzzy search)
  --verbose                      Force verbose startup (overrides quietStartup setting)
  --tui-mode <mode>              TUI mode: fullscreen (default) or regular
  --approve, -a                  Trust project-local files for this run
  --no-approve, -na              Ignore project-local files for this run
  --offline                      Disable startup network operations (same as RUNKILN_OFFLINE=1)
  --verify                       Print mode: run the tests after file-changing turns, feed failures back
                                 (verify.maxRetries), exit 1 if they still fail
  --                             End option parsing; treat remaining arguments as messages/files
  --help, -h                     Show this help
  --version, -v                  Show version number

${chalk.bold("Approvals:")}
  Every shell command and every file write outside the project folder asks first.
  Without an answer (print, json and rpc modes, or no response) the action is denied.

${chalk.bold("Examples:")}
  # Interactive mode
  ${APP_NAME}

  # Non-interactive mode (process and exit)
  ${APP_NAME} -p "Explain src/index.ts"

  # Chat with the chat model
  ${APP_NAME} --chat "What is a monad?"

  # Use another model from models.yaml
  ${APP_NAME} --model deepseek-v4-1-flash-1017 "Help me refactor this code"

  # Let the router pick model and thinking per turn (Jev classifier), deepest mode
  TYPESAFE_API_KEY=... ${APP_NAME} --model auto:high

  # Read-only mode (no file modifications possible)
  ${APP_NAME} --tools read,grep,find,ls -p "Review the code in src/"

${chalk.bold("Configuration:")}
  ~/${CONFIG_DIR_NAME}/agent/runinfra.json    RunInfra endpoint and key: {"baseUrl": "...", "apiKey": "..."}. /setup keys and "key set" edit this (mode 0600).
  ~/${CONFIG_DIR_NAME}/agent/settings.json    Settings, including model roles: {"models": {"code": "...", "chat": "...", "title": "...", "fallback": [...]}}
                                              "disabledModels": [...] hides models from selection and routing (/setup model)
  ~/${CONFIG_DIR_NAME}/agent/router-keys.json Router classifier keys (Jev, OpenRouter). /setup keys and "key set" edit this (mode 0600).
  ~/${CONFIG_DIR_NAME}/agent/cache/runinfra-models.json  Last RunInfra catalog, used offline
  ~/${CONFIG_DIR_NAME}/agent/logs/calls.jsonl Per-call TTFT, tok/s and cache hit %
  ~/${CONFIG_DIR_NAME}/agent/router.yaml      Router catalog override (skills, model scores, tuning) merged over the bundled one
  Router settings (global only): {"router": {"mode": "medium", "classifier": "jev"|"openrouter", "jev": {"model": "..."},
                                  "openrouter": {"model": "..."}, "timeoutMs": 4000, "fallbackModel": "..."}}

${chalk.bold("Environment Variables:")}
  RUNINFRA_API_KEY                 - RunInfra API key (wins over runinfra.json)
  TYPESAFE_API_KEY                 - Jev (TypeSafe) key for the auto router's classifier (wins over router-keys.json)
  OPENROUTER_API_KEY               - OpenRouter key for the auto router's classifier (wins over router-keys.json)
  ${ENV_AGENT_DIR.padEnd(32)} - Config directory (default: ~/${CONFIG_DIR_NAME}/agent)
  ${ENV_SESSION_DIR.padEnd(32)} - Session storage directory (overridden by --session-dir)
  RUNKILN_PARENT_SESSION_ID        - Parent session id for subagents (same as --parent-session-id)
  RUNKILN_PACKAGE_DIR              - Override package directory
  RUNKILN_OFFLINE                  - Disable startup network operations when set to 1/true/yes
  RUNKILN_SETUP_INLINE             - Show setup inline instead of full screen when set to 1

${chalk.bold("Built-in Tool Names:")}
  read       - Read file contents
  bash       - Execute bash commands (asks first)
  powershell - Execute PowerShell commands on Windows (asks first)
  edit       - Edit files with find/replace (asks first outside the project)
  write      - Write files (asks first outside the project)
  grep       - Search file contents (read-only, off by default)
  find       - Find files by glob pattern (read-only, off by default)
  ls         - List directory contents (read-only, off by default)
`);
}
