/**
 * Approval gate for tool calls: the read & write baseline. permissions.ts applies the user's permission mode
 * (ask, read-write, auto, allow-all) and session rules on top of it. Every tool call passes through it before it
 * runs (AgentSession's _approveToolCall), extension and MCP tools included. The decision uses the tool name and
 * arguments only.
 *
 * - read, grep, find, ls and repo_map (NO_PROMPT_TOOLS) run without asking only when the tool that will run under
 *   that name is the genuine built-in (the session decides, see ToolCallOptions). A custom, extension or SDK
 *   tool that takes one of those names asks, and so does any other name, including a case variant such as
 *   "Read". No tool can mark itself read-only: nothing from its definition is read.
 * - Every other tool (MCP, extension, or one added later) asks, and the prompt shows its name and its
 *   arguments as JSON. A replacement of a built-in tool says so in its title.
 * - write and edit get the path checks below only when they are the genuine built-in; a replacement asks.
 * - Every shell command (bash, powershell) needs an explicit yes. A chained command is shown whole,
 *   split into its parts, so a harmless first part cannot hide the rest. (Session "always allow"
 *   prefix rules live in permissions.ts and must match every part.)
 * - A write or edit whose path, resolved target or resolved real path has a name that Windows reads as another
 *   file or device (a trailing dot or space, a colon, a device name such as CON or NUL, or an 8.3 short name such
 *   as PACKAG~1.JSO in any name except the project folder's own path) is refused without asking.
 * - Every file write (write, edit) whose target resolves outside the project folder needs an
 *   explicit yes. Targets are resolved the way the tools resolve them (cwd, `~`, `@` prefix,
 *   lexical `..`), then every path component is followed through symlinks/junctions, including
 *   links whose target does not exist yet, so `..`, absolute paths and links that point out of the
 *   project are all caught. The real path is then canonicalized with fs.realpathSync.native, so 8.3
 *   short names and letter case are judged as they are on disk.
 * - Project files that run code, steer coding agents or change which programs run (git metadata and
 *   hooks, package.json, CI workflows, AGENTS.md, VS Code tasks, ...) need an explicit yes even inside
 *   the project.
 * - Text from commands, paths and arguments that is shown in a prompt is sanitized (see sanitizeForPrompt).
 * - No answer means no: without a UI (print/json mode), on dismissal, on abort and on timeout
 *   the call is denied.
 */

import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { inspect } from "node:util";
import { CONFIG_DIR_NAME, getAgentDir } from "../../config.ts";
import { stripAnsi } from "../../utils/ansi.ts";
import { resolveToCwd } from "../tools/path-utils.ts";
import type { ApprovalDiff } from "./approval-preview.ts";

export const SHELL_TOOLS = new Set(["bash", "powershell"]);
export const WRITE_TOOLS = new Set(["write", "edit"]);
/**
 * The only tools that run without asking, matched by exact name, and only when the tool that runs under that name
 * is the genuine built-in (see ToolCallOptions). The list is hardcoded: a tool cannot add itself to it.
 */
export const NO_PROMPT_TOOLS: readonly string[] = Object.freeze(["read", "grep", "find", "ls", "repo_map"]);

/** How long an approval prompt waits before denying. */
export const APPROVAL_TIMEOUT_MS = 120_000;

const isWindows = process.platform === "win32";

/** Most symlink/junction expansions one path may take before it is treated as unresolvable. */
const MAX_LINK_HOPS = 40;

function splitComponents(path: string): string[] {
	return path.split(isWindows ? /[\\/]+/ : /\/+/).filter((part) => part !== "");
}

/** lstat of a path, or undefined when it does not exist. Any other error is thrown. */
function lstatIfPresent(path: string) {
	try {
		return lstatSync(path);
	} catch (error) {
		const code = (error as { code?: unknown } | undefined)?.code;
		if (code === "ENOENT" || code === "ENOTDIR") return undefined;
		throw error;
	}
}

/**
 * The real location of an absolute path. Every component is checked with lstat and every symlink or
 * junction is followed with readlink, including links whose target does not exist (a dangling link is
 * still followed to its target). A component that does not exist cannot contain links, so the rest of
 * the path is appended as written. Throws on a link loop, on more than MAX_LINK_HOPS links, and on any
 * error other than "does not exist"; callers treat a path that throws as outside the project.
 */
export function realpathDeep(absolutePath: string): string {
	const start = resolve(absolutePath);
	const { root } = parse(start);
	let current = root;
	let pending = splitComponents(start.slice(root.length));
	let hops = 0;
	for (;;) {
		const part = pending.shift();
		if (part === undefined) return current;
		if (part === ".") continue;
		if (part === "..") {
			current = dirname(current);
			continue;
		}
		const candidate = join(current, part);
		const stats = lstatIfPresent(candidate);
		if (!stats) return resolve(candidate, ...pending);
		if (!stats.isSymbolicLink()) {
			current = candidate;
			continue;
		}
		hops++;
		if (hops > MAX_LINK_HOPS) throw new Error(`Too many links while resolving ${start}`);
		const target = readlinkSync(candidate);
		const targetRoot = parse(target).root;
		if (targetRoot !== "" && !isAbsolute(target)) throw new Error(`Unsupported link target ${target}`);
		// The target's components are walked again from here rather than normalized lexically, because
		// `..` after a link means the parent of the link's real target. `current` is always a real path.
		if (isAbsolute(target)) current = parse(resolve(current, target)).root;
		pending = [...splitComponents(target.slice(targetRoot.length)), ...pending];
	}
}

/**
 * The real path of `path`, or undefined when it cannot be resolved. realpathDeep follows the links; the result is then
 * canonicalized, so the project folder and the target are compared the way they are spelled on disk.
 */
function tryRealpath(path: string): string | undefined {
	try {
		return canonicalizeExisting(realpathDeep(path));
	} catch {
		return undefined;
	}
}

/**
 * `path` with its nearest existing ancestor canonicalized by fs.realpathSync.native. On Windows that expands 8.3 short
 * names and sets the letter case of each name as it is on disk. The part that does not exist is appended as written.
 * Only for a path that is already free of links (see realpathDeep). Throws when the ancestor cannot be resolved.
 */
function canonicalizeExisting(path: string): string {
	const missing: string[] = [];
	let existing = resolve(path);
	while (lstatIfPresent(existing) === undefined) {
		const parent = dirname(existing);
		if (parent === existing) break;
		missing.unshift(basename(existing));
		existing = parent;
	}
	return resolve(realpathSync.native(existing), ...missing);
}

/**
 * The path of `target` relative to the project root, with links resolved and names canonicalized on both sides, or
 * undefined when it is outside. A path that cannot be resolved counts as outside.
 */
function insideProjectPath(target: string, projectRoot: string): string | undefined {
	const root = tryRealpath(projectRoot);
	const real = tryRealpath(target);
	if (root === undefined || real === undefined) return undefined;
	const rel = isWindows ? relative(root.toLowerCase(), real.toLowerCase()) : relative(root, real);
	if (rel === "") return rel;
	if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return undefined;
	return rel;
}

/** True when `target` is the project root or inside it, after resolving links on both sides. */
export function isInsideProject(target: string, projectRoot: string): boolean {
	return insideProjectPath(target, projectRoot) !== undefined;
}

// ---------------------------------------------------------------------------
// Protected project files
// ---------------------------------------------------------------------------

// Windows and default macOS file systems are case-insensitive, so the protected patterns always ignore case
// (an extra prompt is the safe failure).
const PATH_FLAGS = "i";

/**
 * Project files that run code, steer coding agents or change which programs run. A write to any of them needs
 * an explicit yes, even inside the project. Each pattern matches at any depth, so a nested package.json or the
 * .git folder of a submodule is covered too. Patterns match project-relative paths with forward slashes.
 */
export const PROTECTED_PROJECT_PATHS: ReadonlyArray<{ readonly pattern: RegExp; readonly reason: string }> = [
	{
		pattern: new RegExp(String.raw`(^|/)\.git(/|$)`, PATH_FLAGS),
		reason: "Git hooks and config here run commands when git runs.",
	},
	{
		pattern: new RegExp(String.raw`(^|/)\.husky(/|$)`, PATH_FLAGS),
		reason: "Husky hooks run commands when git runs.",
	},
	{
		pattern: new RegExp(String.raw`(^|/)\.npmrc$`, PATH_FLAGS),
		reason: "npm config can change registries and the shell that runs scripts.",
	},
	{
		pattern: new RegExp(String.raw`(^|/)\.github/workflows(/|$)`, PATH_FLAGS),
		reason: "Workflow files run code in CI with the repository's secrets.",
	},
	{
		pattern: new RegExp(String.raw`(^|/)AGENTS\.md$`, PATH_FLAGS),
		reason: "AGENTS.md gives instructions to coding agents.",
	},
	{
		pattern: new RegExp(String.raw`(^|/)CLAUDE\.md$`, PATH_FLAGS),
		reason: "CLAUDE.md gives instructions to coding agents.",
	},
	{
		pattern: new RegExp(String.raw`(^|/)\.(cursor|claude)(/|$)`, PATH_FLAGS),
		reason: "Cursor or Claude settings and rules steer coding agents.",
	},
	{
		pattern: new RegExp(String.raw`(^|/)\.envrc$`, PATH_FLAGS),
		reason: "direnv runs .envrc as shell code when you enter the folder.",
	},
	{
		pattern: new RegExp(String.raw`(^|/)\.vscode/settings\.json$`, PATH_FLAGS),
		reason: "VS Code settings can point tools at other programs.",
	},
	{
		pattern: new RegExp(String.raw`(^|/)\.vscode/tasks\.json$`, PATH_FLAGS),
		reason: "VS Code tasks can run commands.",
	},
	{
		pattern: new RegExp(String.raw`(^|/)package\.json$`, PATH_FLAGS),
		reason: "package.json can define install and build scripts that run code.",
	},
	{
		// The project's RunKiln folder, except the contents of a worktree it holds (.runkiln/worktrees/<name>/...).
		pattern: new RegExp(String.raw`(^|/)${escapeRegExp(CONFIG_DIR_NAME)}(/|$)(?!worktrees/[^/]+/.)`, PATH_FLAGS),
		reason: "RunKiln loads project settings, hooks, MCP servers, skills and system prompts from here.",
	},
	{
		pattern: new RegExp(String.raw`(^|/)\.mcp\.json$`, PATH_FLAGS),
		reason: "MCP config starts programs when an agent opens the project.",
	},
	{
		pattern: new RegExp(String.raw`(^|/)\.agents(/|$)`, PATH_FLAGS),
		reason: "Skills here load into later agent sessions.",
	},
	{
		pattern: new RegExp(
			String.raw`(^|/)(\.(gemini|codex|opencode|windsurf|continue|cline|roo|kiro|amazonq|aider[^/]*|zed)(/|$)|opencode\.jsonc?$|GEMINI\.md$|AGENTS\.override\.md$|\.(cursorrules|windsurfrules|clinerules|roorules)$|\.github/(copilot-instructions\.md|instructions/|prompts/|chatmodes/))`,
			PATH_FLAGS,
		),
		reason: "Other coding agents read their settings, rules and MCP servers from here.",
	},
	{
		pattern: new RegExp(
			String.raw`(^|/)([^/]+\.config\.[^/]+|vitest\.(workspace|setup)\.[^/]+|jest\.setup\.[^/]+|\.(eslintrc|babelrc|mocharc|swcrc|prettierrc)(\.[^/]+)?)$`,
			PATH_FLAGS,
		),
		reason: "Config files like this one run code when tests, linters or builds run.",
	},
	{
		pattern: new RegExp(
			String.raw`(^|/)(conftest\.py|pyproject\.toml|setup\.py|setup\.cfg|pytest\.ini|tox\.ini|noxfile\.py|sitecustomize\.py|usercustomize\.py)$`,
			PATH_FLAGS,
		),
		reason: "Python test runners and builds run code from this file.",
	},
	{
		pattern: new RegExp(
			String.raw`(^|/)(GNUmakefile|makefile|[^/]+\.mk|justfile|\.justfile|Taskfile\.ya?ml|Rakefile|build\.rs|build\.gradle(\.kts)?|settings\.gradle(\.kts)?|pom\.xml|CMakeLists\.txt|\.cargo/config(\.toml)?)$`,
			PATH_FLAGS,
		),
		reason: "Build runners (make, just, cargo, gradle, maven, cmake) run code from this file.",
	},
	{
		pattern: new RegExp(
			String.raw`(^|/)(\.pre-commit-config\.ya?ml|\.?lefthook(-local)?\.ya?ml|\.gitattributes|\.gitmodules|\.yarnrc(\.ya?ml)?|\.pnpmfile\.c?js|bunfig\.toml)$`,
			PATH_FLAGS,
		),
		reason: "Git, hook and package manager config here can run programs.",
	},
	{
		pattern: new RegExp(String.raw`(^|/)(\.devcontainer|\.idea)(/|$)|(^|/)\.vscode/launch\.json$`, PATH_FLAGS),
		reason: "Editor and dev container config here can run commands.",
	},
	{
		pattern: new RegExp(
			String.raw`(^|/)\.(bashrc|bash_profile|bash_login|zshrc|zshenv|zprofile|profile)$`,
			PATH_FLAGS,
		),
		reason: "Shell startup files run code when a shell starts.",
	},
];

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Why a project-relative path is a protected file, or undefined when it is not one. */
export function protectedProjectReason(relativePath: string): string | undefined {
	const slashed = relativePath.split(sep).join("/");
	return PROTECTED_PROJECT_PATHS.find(({ pattern }) => pattern.test(slashed))?.reason;
}

export function isProtectedProjectPath(relativePath: string): boolean {
	return protectedProjectReason(relativePath) !== undefined;
}

/**
 * Why a write to `target` inside the project is protected, checking both the lexical path (relative to
 * the project folder) and the resolved path (relative to the real project root).
 */
function protectedWriteReason(target: string, cwd: string, realRelative: string): string | undefined {
	return protectedProjectReason(relative(resolve(cwd), resolve(target))) ?? protectedProjectReason(realRelative);
}

// ---------------------------------------------------------------------------
// RunKiln's own key files
// ---------------------------------------------------------------------------

/**
 * Files in the agent folder that hold RunKiln's keys or its hook and MCP approvals. No tool may read or write them:
 * a read leaks the keys, a write could approve a hook or server. The CLI (`runkiln login`, /key) manages them.
 */
export const RUNKILN_KEY_FILES: readonly string[] = Object.freeze([
	"auth.json",
	"router-keys.json",
	"runinfra.json",
	"command-trust.json",
]);

const KEY_FILE_NAMES = RUNKILN_KEY_FILES.map((name) => escapeRegExp(name)).join("|");

/** The key files as `<agent folder>/<name>`, for the current agent folder. */
function keyFilePaths(): string[] {
	const agentDir = resolve(getAgentDir());
	return RUNKILN_KEY_FILES.map((name) => join(agentDir, name));
}

function samePath(a: string, b: string): boolean {
	return isWindows || process.platform === "darwin" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** Whether `target` (or its real path) is one of RunKiln's key files, or the agent folder itself. */
export function isRunkilnKeyFile(target: string): boolean {
	const agentDir = resolve(getAgentDir());
	const forms = [resolve(target)];
	const real = tryRealpath(target);
	if (real !== undefined) forms.push(real);
	const realAgentDir = tryRealpath(agentDir);
	const keys = [...keyFilePaths(), ...(realAgentDir ? RUNKILN_KEY_FILES.map((name) => join(realAgentDir, name)) : [])];
	return forms.some((form) => keys.some((key) => samePath(form, key)));
}

/** The refusal reason for a tool call that touches RunKiln's key files. */
export function keyFileRefusal(): string {
	return "Refused: RunKiln's own key and trust files (router-keys.json, runinfra.json, command-trust.json, auth.json in the agent folder) are never read or written by tools. Manage keys with /key or `runkiln login`.";
}

/** Whether a shell command names one of RunKiln's key files in the agent folder. */
function shellTouchesKeyFile(command: string): boolean {
	const agentDir = resolve(getAgentDir());
	const named = new RegExp(String.raw`(^|[\\/])agent[\\/]+(${KEY_FILE_NAMES})`, "i");
	const viaConfigDir = new RegExp(
		String.raw`${escapeRegExp(CONFIG_DIR_NAME)}[\\/]+agent[\\/]+(${KEY_FILE_NAMES})`,
		"i",
	);
	if (viaConfigDir.test(command)) return true;
	const lowered = command.toLowerCase();
	if (lowered.includes(agentDir.toLowerCase()) && new RegExp(KEY_FILE_NAMES, "i").test(command)) return true;
	return named.test(command) && /runkiln/i.test(command);
}

// ---------------------------------------------------------------------------
// Windows alias names
// ---------------------------------------------------------------------------

/** The only colon a Windows path may hold: a drive letter, as the first name of an absolute path. */
const DRIVE_LETTER = /^[A-Za-z]:$/;

/** Windows device names. They are matched against the part of a name before its first dot, ignoring case. */
const DEVICE_NAME = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;

/**
 * A name of a path. `checkShort` is whether the 8.3 short-name check applies to it: every name does, except the
 * names that form the project folder's own path.
 */
interface PathName {
	name: string;
	checkShort: boolean;
}

/** The names of a path, split on both separators, without empty, "." and ".." names. */
function namesOf(path: string): string[] {
	return path.split(/[\\/]+/).filter((name) => name !== "" && name !== "." && name !== "..");
}

/** Whether two spellings are the same name or path. Windows file names do not differ by case. */
function sameName(a: string, b: string): boolean {
	return isWindows ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/**
 * The names of a relative path as written. All of them get the 8.3 check: nothing in a relative path is exempt, and a
 * name that a later ".." cancels is still checked, because it was written.
 */
function checkedNames(relativePath: string): PathName[] {
	return namesOf(relativePath).map((name) => ({ name, checkShort: true }));
}

/**
 * The names of an absolute path. The names that form `projectRoot` (the project folder as spelled) are exempt from the
 * 8.3 check, but only when the path starts with exactly those names. Any other path, including one that reaches the
 * project folder through another spelling such as JOHNSO~1, has every name checked.
 */
function absoluteNames(path: string, projectRoot: string | undefined): PathName[] {
	const names = namesOf(path);
	const exempt = projectRoot === undefined ? [] : namesOf(projectRoot);
	const startsWithRoot = exempt.length <= names.length && exempt.every((part, index) => sameName(part, names[index]));
	return names.map((name, index) => ({ name, checkShort: !(startsWithRoot && index < exempt.length) }));
}

/**
 * Why a path names a different file than it looks like, or undefined when no name does. Windows drops trailing
 * dots and spaces, reads a colon as an alternate data stream or device, treats device names (CON, NUL, COM1...)
 * as devices, and accepts 8.3 short names (PACKAG~1.JSO) that can stand for other names. The dot, space, colon and
 * device checks apply to every name; the 8.3 check applies to every name that is not part of the project folder's
 * own path. The check runs on every platform.
 */
function windowsAliasRefusal(parts: readonly PathName[]): string | undefined {
	for (let index = 0; index < parts.length; index++) {
		const { name, checkShort } = parts[index];
		const named = `Refused: path segment "${sanitizeForPrompt(name)}"`;
		const otherFile = "Windows would write a different file than the one named.";
		if (name.endsWith(".")) return `${named} ends in a dot; ${otherFile}`;
		if (name.endsWith(" ")) return `${named} ends in a space; ${otherFile}`;
		if (DEVICE_NAME.test(name.split(".")[0])) {
			return `${named} is a Windows device name; writing to it would not create a file.`;
		}
		if (checkShort && /~\d/.test(name)) {
			return `${named} is a Windows 8.3 short name, which can stand for a different file.`;
		}
		if (name.includes(":") && !(index === 0 && DRIVE_LETTER.test(name))) {
			// "a:b" without a separator after the drive letter is relative to drive A:, not to the project.
			if (index === 0 && /^[A-Za-z]:/.test(name)) {
				return `${named} contains a colon after a drive letter, so Windows reads it as relative to that drive.`;
			}
			return `${named} contains a colon, which Windows reads as an alternate data stream or device.`;
		}
	}
	return undefined;
}

/**
 * Why a write to `target` is refused for the names in its path, or undefined. Three forms are checked: the path as
 * written, the resolved target, and its real path (links followed, names canonicalized). The project folder is taken
 * as spelled for the written and resolved forms, and as canonicalized for the real path. In each form the 8.3 check
 * skips only the names of the project folder itself, and only for a path that starts with them.
 */
function aliasRefusalFor(rawPath: string, target: string, cwd: string): string | undefined {
	const written = rawPath.replace(/^@/, "");
	const root = resolve(cwd);
	const writtenParts = isAbsolute(written) ? absoluteNames(written, root) : checkedNames(written);
	const lexicalParts = absoluteNames(target, root);
	const realTarget = tryRealpath(target);
	const realParts = realTarget === undefined ? undefined : absoluteNames(realTarget, tryRealpath(cwd));
	return (
		windowsAliasRefusal(writtenParts) ??
		windowsAliasRefusal(lexicalParts) ??
		(realParts === undefined ? undefined : windowsAliasRefusal(realParts))
	);
}

// ---------------------------------------------------------------------------
// Shell command analysis
// ---------------------------------------------------------------------------

export interface ShellAnalysis {
	/** Top-level commands, split on ; && || | & and newlines (outside quotes). */
	segments: string[];
	/** Command substitutions and process substitutions: $(...), `...`, <(...), >(...). */
	substitutions: string[];
	/** Redirect targets (> >> 2> &> >|) that resolve outside the project. */
	writesOutside: string[];
	/** Other path-like words that resolve outside the project. */
	pathsOutside: string[];
}

interface Token {
	type: "word" | "op" | "redirect";
	value: string;
	/** Source text of a word before quote/escape removal. */
	raw?: string;
}

/** Read a balanced $( ... ) / <( ... ) body starting after the opening paren. Returns [body, endIndex]. */
function readParenBody(text: string, start: number): [string, number] {
	let depth = 1;
	let i = start;
	let quote: string | undefined;
	while (i < text.length) {
		const ch = text[i];
		if (quote) {
			if (ch === "\\" && quote === '"') i++;
			else if (ch === quote) quote = undefined;
		} else if (ch === "'" || ch === '"') {
			quote = ch;
		} else if (ch === "\\") {
			i++;
		} else if (ch === "(") {
			depth++;
		} else if (ch === ")") {
			depth--;
			if (depth === 0) return [text.slice(start, i), i];
		}
		i++;
	}
	return [text.slice(start), text.length];
}

function tokenize(command: string, substitutions: string[]): Token[] {
	const tokens: Token[] = [];
	let word = "";
	let inWord = false;
	let wordStart = 0;
	let i = 0;
	const flush = () => {
		if (inWord) tokens.push({ type: "word", value: word, raw: command.slice(wordStart, i) });
		word = "";
		inWord = false;
	};
	const startWord = (at: number) => {
		if (!inWord) wordStart = at;
		inWord = true;
	};
	while (i < command.length) {
		const pos = i;
		const ch = command[i];
		const next = command[i + 1];
		if (ch === "'") {
			const end = command.indexOf("'", i + 1);
			const stop = end < 0 ? command.length : end;
			word += command.slice(i + 1, stop);
			startWord(pos);
			i = stop + 1;
			continue;
		}
		if (ch === '"') {
			i++;
			startWord(pos);
			while (i < command.length && command[i] !== '"') {
				if (command[i] === "\\" && i + 1 < command.length) {
					word += command[i + 1];
					i += 2;
					continue;
				}
				if (command[i] === "$" && command[i + 1] === "(") {
					const [body, end] = readParenBody(command, i + 2);
					substitutions.push(`$(${body})`);
					word += `$(${body})`;
					i = end + 1;
					continue;
				}
				if (command[i] === "`") {
					const end = command.indexOf("`", i + 1);
					const stop = end < 0 ? command.length : end;
					substitutions.push(command.slice(i, stop + 1));
					word += command.slice(i, stop + 1);
					i = stop + 1;
					continue;
				}
				word += command[i];
				i++;
			}
			i++;
			continue;
		}
		if (ch === "\\" && next !== undefined) {
			word += next;
			startWord(pos);
			i += 2;
			continue;
		}
		if ((ch === "$" || ch === "<" || ch === ">") && next === "(") {
			const [body, end] = readParenBody(command, i + 2);
			substitutions.push(`${ch}(${body})`);
			word += `${ch}(${body})`;
			startWord(pos);
			i = end + 1;
			continue;
		}
		if (ch === "`") {
			const end = command.indexOf("`", i + 1);
			const stop = end < 0 ? command.length : end;
			substitutions.push(command.slice(i, stop + 1));
			word += command.slice(i, stop + 1);
			startWord(pos);
			i = stop + 1;
			continue;
		}
		if (ch === "\n" || ch === ";") {
			flush();
			tokens.push({ type: "op", value: ch === "\n" ? "\\n" : ";" });
			i++;
			continue;
		}
		if ((ch === "&" && next === "&") || (ch === "|" && next === "|")) {
			flush();
			tokens.push({ type: "op", value: ch + next });
			i += 2;
			continue;
		}
		if (ch === "&" && next === ">") {
			flush();
			const append = command[i + 2] === ">";
			tokens.push({ type: "redirect", value: append ? "&>>" : "&>" });
			i += append ? 3 : 2;
			continue;
		}
		if (ch === "|" || ch === "&") {
			flush();
			tokens.push({ type: "op", value: ch });
			i++;
			continue;
		}
		if (ch === ">" || (/[0-9]/.test(ch) && next === ">" && !inWord)) {
			flush();
			let j = ch === ">" ? i : i + 1;
			let op = command[j];
			j++;
			if (command[j] === ">" || command[j] === "|") {
				op += command[j];
				j++;
			}
			if (command[j] === "&") {
				// >&2 style fd duplication: not a file write.
				j++;
				while (j < command.length && /[0-9-]/.test(command[j])) j++;
				i = j;
				continue;
			}
			tokens.push({ type: "redirect", value: (ch === ">" ? "" : ch) + op });
			i = j;
			continue;
		}
		if (ch === "<") {
			flush();
			tokens.push({ type: "op", value: "<" });
			i++;
			continue;
		}
		if (ch === " " || ch === "\t" || ch === "\r") {
			flush();
			i++;
			continue;
		}
		word += ch;
		startWord(pos);
		i++;
	}
	flush();
	return tokens;
}

function looksLikePath(word: string): boolean {
	if (!word || word.startsWith("-") || word.includes("://")) return false;
	return (
		word.startsWith("/") ||
		word.startsWith("~") ||
		word.startsWith("\\") ||
		/^[A-Za-z]:[\\/]/.test(word) ||
		word === ".." ||
		word.startsWith("../") ||
		word.startsWith("..\\") ||
		word.includes("/../") ||
		word.includes("\\..\\")
	);
}

function resolveShellPath(word: string, cwd: string): string {
	if (word === "~" || word.startsWith("~/") || word.startsWith("~\\")) return join(homedir(), word.slice(1));
	return resolve(cwd, word);
}

/**
 * The word as written, if it (or its unescaped form) is a path outside the project. Both readings are
 * checked because `\` is an escape in bash but a separator in Windows paths.
 */
function pathOutside(token: Token, cwd: string, anyPath = false): string | undefined {
	const raw = token.raw?.replace(/^["']|["']$/g, "");
	for (const candidate of [token.value, raw]) {
		if (!candidate || (!anyPath && !looksLikePath(candidate))) continue;
		if (!isInsideProject(resolveShellPath(candidate, cwd), cwd)) return raw ?? token.value;
	}
	return undefined;
}

export function analyzeShellCommand(command: string, cwd: string): ShellAnalysis {
	const substitutions: string[] = [];
	const tokens = tokenize(command, substitutions);
	const segments: string[] = [];
	const writesOutside: string[] = [];
	const pathsOutside: string[] = [];
	let current: string[] = [];
	const pushSegment = () => {
		if (current.length > 0) segments.push(current.join(" "));
		current = [];
	};
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		if (token.type === "op") {
			if (token.value === "<") {
				current.push("<");
				continue;
			}
			pushSegment();
			continue;
		}
		if (token.type === "redirect") {
			const target = tokens[i + 1]?.type === "word" ? tokens[i + 1].value : undefined;
			current.push(target ? `${token.value} ${target}` : token.value);
			if (target) {
				i++;
				const isDevNull = /^\/dev\/(null|stdout|stderr)$/.test(target) || /^nul$/i.test(target);
				const outsideTarget = isDevNull ? undefined : pathOutside(tokens[i], cwd, true);
				if (outsideTarget) writesOutside.push(outsideTarget);
			}
			continue;
		}
		current.push(token.value);
		const outsidePath = pathOutside(token, cwd);
		if (outsidePath) pathsOutside.push(outsidePath);
	}
	pushSegment();
	return {
		segments,
		substitutions: [...new Set(substitutions)],
		writesOutside: [...new Set(writesOutside)],
		pathsOutside: [...new Set(pathsOutside)],
	};
}

// ---------------------------------------------------------------------------
// PowerShell
// ---------------------------------------------------------------------------

/** Characters PowerShell reads as single quotes (it accepts the typographic ones too). */
const PS_SINGLE_QUOTES = new Set(["'", "\u2018", "\u2019", "\u201a", "\u201b"]);
/** Characters PowerShell reads as double quotes. */
const PS_DOUBLE_QUOTES = new Set(['"', "\u201c", "\u201d", "\u201e"]);
/** Characters PowerShell reads as a parameter dash: hyphen, en dash, em dash, horizontal bar. */
const PS_DASH = "[-\u2013\u2014\u2015/]";
/**
 * Outside quotes, these start an expression, a script block, a variable, a splat or array, an escape, a call or
 * background operator, a statement separator or a pipeline. In argument mode `git log (iex 'calc')` evaluates the
 * parenthesis, so a command with any of them is never matched by a prefix rule or allowed without asking.
 */
const PS_UNSAFE_OUTSIDE = new Set(["(", ")", "{", "}", "$", "@", "`", "&", ";", "|"]);
/** -EncodedCommand / -EncodedArguments and every prefix PowerShell accepts for them (-e, -ec, -enc, ...). */
const PS_ENCODED = new RegExp(
	`^${PS_DASH}(e|ec|en|enc|enco|encod|encode|encoded|encodedc\\w*|encodeda\\w*)(:.*)?$`,
	"i",
);

/**
 * Why a PowerShell command uses PowerShell syntax that the bash-style analyser cannot judge, or undefined when it is
 * plain words. Text in single quotes is literal in PowerShell and is skipped; in double quotes `$` and the backtick
 * still expand. `--%` (stop parsing) and the encoded-command flags are refused in any position.
 */
export function powershellUnsafeReason(command: string): string | undefined {
	const found = new Set<string>();
	let quote: "single" | "double" | undefined;
	let word = "";
	const words: string[] = [];
	const endWord = () => {
		if (word !== "") words.push(word);
		word = "";
	};
	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (quote === "single") {
			if (PS_SINGLE_QUOTES.has(ch)) {
				// '' inside a single-quoted string is an escaped quote.
				if (PS_SINGLE_QUOTES.has(command[i + 1] ?? "")) {
					i++;
					continue;
				}
				quote = undefined;
			}
			word += ch;
			continue;
		}
		if (quote === "double") {
			if (ch === "$" || ch === "`") found.add(ch);
			else if (PS_DOUBLE_QUOTES.has(ch)) quote = undefined;
			word += ch;
			continue;
		}
		if (PS_SINGLE_QUOTES.has(ch)) {
			quote = "single";
			word += ch;
			continue;
		}
		if (PS_DOUBLE_QUOTES.has(ch)) {
			quote = "double";
			word += ch;
			continue;
		}
		if (PS_UNSAFE_OUTSIDE.has(ch)) found.add(ch);
		if (/\s/.test(ch)) endWord();
		else word += ch;
	}
	endWord();
	const notes: string[] = [];
	if (words.some((w) => w === "--%")) notes.push("--% (stop parsing)");
	if (words.some((w) => PS_ENCODED.test(w))) notes.push("an encoded command (-EncodedCommand)");
	if (found.size > 0) notes.push([...found].join(" "));
	if (notes.length === 0) return undefined;
	return `uses PowerShell expressions or operators (${notes.join(", ")})`;
}

/** Whether a shell tool call is a PowerShell command the analyser cannot judge (see powershellUnsafeReason). */
export function powershellUnsafe(toolName: string, command: string): string | undefined {
	return toolName === "powershell" ? powershellUnsafeReason(command) : undefined;
}

// ---------------------------------------------------------------------------
// Approval requests
// ---------------------------------------------------------------------------

export interface ApprovalRequest {
	title: string;
	message: string;
	/**
	 * Code that appears verbatim in the message (a shell command, an MCP call's arguments), so a UI can show that part
	 * with syntax colour. `message` always holds the full text, for prompts and readers that show plain text.
	 */
	code?: { text: string; language: "bash" | "json" };
	/** What a write or edit would change (approval-preview.ts). Display only: the gate never reads it. */
	diff?: ApprovalDiff;
}

/** A tool call that is blocked without asking. */
export interface ApprovalRefusal {
	/** Why the call is blocked. It is returned to the model as the block reason. */
	reason: string;
}

/**
 * What the session knows about the tool that will run under a name. The defaults are the safe ones: a name that
 * is not known to be the genuine built-in asks.
 */
export interface ToolCallOptions {
	/**
	 * True only when the tool that runs under the name is the genuine built-in definition from core/tools. Only then
	 * do read, grep, find and ls run without asking, and write and edit get their path checks. Defaults to false.
	 */
	builtin?: boolean;
	/** True when a different tool (custom, extension or SDK) runs under the name of a built-in tool. */
	replacesBuiltin?: boolean;
}

export function isApprovalRefusal(outcome: ApprovalRequest | ApprovalRefusal | undefined): outcome is ApprovalRefusal {
	return outcome !== undefined && "reason" in outcome;
}

/**
 * Whether a code point is a control, line or paragraph separator, bidi override or isolate, or an
 * invisible format character.
 */
function isPromptUnsafe(code: number): boolean {
	return (
		code <= 0x1f ||
		(code >= 0x7f && code <= 0x9f) ||
		(code >= 0x200b && code <= 0x200f) ||
		(code >= 0x2028 && code <= 0x202e) ||
		(code >= 0x2060 && code <= 0x2069) ||
		code === 0xfeff ||
		// Unicode tag characters ("ASCII smuggling"): invisible, but models read them.
		(code >= 0xe0000 && code <= 0xe007f)
	);
}

/** A visible escape for one code point: a backslash, x and two hex digits, or u and four. */
function visibleEscape(code: number): string {
	if (code > 0xffff) return `\\u{${code.toString(16)}}`;
	return code <= 0xff ? `\\x${code.toString(16).padStart(2, "0")}` : `\\u${code.toString(16).padStart(4, "0")}`;
}

/**
 * Make untrusted text (commands, paths, tool names) safe to show in an approval prompt. Terminal escape
 * sequences are removed. Other unsafe characters (see isPromptUnsafe) become visible escapes, so they can
 * neither vanish nor repaint the screen. Carriage returns and newlines show as backslash-r and backslash-n,
 * except that `multiline` keeps newlines. Tabs are kept.
 */
export function sanitizeForPrompt(text: string, options: { multiline?: boolean } = {}): string {
	let out = "";
	for (const char of stripAnsi(text)) {
		const code = char.codePointAt(0) ?? 0;
		if (!isPromptUnsafe(code) || char === "\t") out += char;
		else if (char === "\n") out += options.multiline ? char : "\\n";
		else if (char === "\r") out += "\\r";
		else out += visibleEscape(code);
	}
	return out;
}

function formatShellRequest(toolName: string, command: string, cwd: string): ApprovalRequest {
	const analysis = analyzeShellCommand(command, cwd);
	const shownList = (items: string[]) => items.map((item) => sanitizeForPrompt(item)).join(", ");
	const lines = [sanitizeForPrompt(command.trim(), { multiline: true })];
	if (stripAnsi(command) !== command) {
		lines.push("(Terminal escape sequences were removed from this display; the command that runs is unchanged.)");
	}
	if (analysis.segments.length > 1) {
		lines.push("", `This runs ${analysis.segments.length} commands:`);
		analysis.segments.forEach((segment, index) => {
			lines.push(`  ${index + 1}. ${sanitizeForPrompt(segment)}`);
		});
	}
	if (analysis.substitutions.length > 0) {
		lines.push("", `Runs nested commands: ${shownList(analysis.substitutions)}`);
	}
	if (analysis.writesOutside.length > 0) {
		lines.push("", `Writes outside the project: ${shownList(analysis.writesOutside)}`);
	}
	if (analysis.pathsOutside.length > 0) {
		lines.push("", `Uses paths outside the project: ${shownList(analysis.pathsOutside)}`);
	}
	const powershell = powershellUnsafe(toolName, command);
	if (powershell) {
		lines.push("", `This command ${sanitizeForPrompt(powershell)}; RunKiln cannot see what they run.`);
	}
	lines.push("", `Working directory: ${sanitizeForPrompt(cwd)}`);
	return {
		title: `Run ${sanitizeForPrompt(toolName)} command?`,
		message: lines.join("\n"),
		code: { text: lines[0], language: "bash" },
	};
}

/** A note for the approval message when the target is reached through links. */
function linkNote(target: string): string {
	const real = tryRealpath(target);
	if (real === undefined) return "\n(its links could not be resolved)";
	return sameName(real, resolve(target)) ? "" : `\n(resolves to ${sanitizeForPrompt(real)})`;
}

/** Arguments shown in a prompt are capped at this many characters of pretty JSON. */
const MAX_ARGUMENT_DISPLAY = 4000;

/**
 * The arguments as pretty JSON. Values JSON cannot hold (bigint, circular structures, throwing getters) are
 * shown by util.inspect instead, so the prompt always shows something.
 */
function argumentsText(args: unknown, compact = false): string {
	try {
		const json = JSON.stringify(
			args,
			(_key, value: unknown) => (typeof value === "bigint" ? `${value}n` : value),
			compact ? undefined : 2,
		);
		if (json !== undefined) return json;
	} catch {
		// Circular structures and throwing toJSON or getters fall through to util.inspect.
	}
	try {
		return inspect(args, { depth: 8, breakLength: 80 });
	} catch {
		return "[arguments could not be displayed]";
	}
}

/**
 * The request for a tool that is not a genuine shell or write tool: its name and its arguments. A replacement of a
 * built-in tool says so in the title and the message.
 */
function otherToolRequest(toolName: string, args: unknown, replacesBuiltin: boolean): ApprovalRequest {
	const tool = sanitizeForPrompt(toolName);
	// MCP calls (mcp__server__tool) show their arguments as compact JSON: one wrapped line, usually short.
	const mcp = toolName.startsWith("mcp__");
	const chars = [...sanitizeForPrompt(argumentsText(args, mcp), { multiline: true })];
	const kept = chars.slice(0, MAX_ARGUMENT_DISPLAY).join("");
	const left = chars.length - MAX_ARGUMENT_DISPLAY;
	const shown = left > 0 ? `${kept}\n... (${left} more characters)` : kept;
	if (replacesBuiltin) {
		const note = `A custom, extension or SDK tool replaces the built-in ${tool} tool, so it asks.`;
		return {
			title: `Allow ${tool} (replaces a built-in tool)?`,
			message: `${note} It will run with these arguments:\n${shown}`,
		};
	}
	if (mcp) {
		return {
			title: `Allow ${tool}?`,
			message: `${tool} will run with these arguments:\n${shown}`,
			...(left > 0 ? {} : { code: { text: shown, language: "json" as const } }),
		};
	}
	return { title: `Allow ${tool}?`, message: `${tool} will run with these arguments:\n${shown}` };
}

/**
 * What a tool call needs before it runs (see the header): undefined when it runs without asking, an
 * ApprovalRequest when it runs only after an explicit yes, or an ApprovalRefusal when it is blocked without
 * asking. `cwd` is the project folder the tools resolve paths against. `options` says what the session knows
 * about the tool that will run; with the defaults, read, grep, find, ls, write and edit all ask.
 */
export function approvalRequestForToolCall(
	toolName: string,
	args: unknown,
	cwd: string,
	options: ToolCallOptions = {},
): ApprovalRequest | ApprovalRefusal | undefined {
	const genuine = options.builtin === true;
	const input = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
	// RunKiln's own key files are refused for every tool and in every mode.
	if (typeof input.path === "string" && input.path && isRunkilnKeyFile(resolveToCwd(input.path, cwd))) {
		return { reason: keyFileRefusal() };
	}
	if (NO_PROMPT_TOOLS.includes(toolName) && genuine) return undefined;
	if (SHELL_TOOLS.has(toolName)) {
		const command = typeof input.command === "string" ? input.command : "";
		if (shellTouchesKeyFile(command)) return { reason: keyFileRefusal() };
		return formatShellRequest(toolName, command, cwd);
	}
	if (WRITE_TOOLS.has(toolName) && genuine) {
		const rawPath = typeof input.path === "string" ? input.path : "";
		const tool = sanitizeForPrompt(toolName);
		// An unusable path is still asked about; the tool reports the error if approved.
		if (!rawPath) return { title: `Allow ${tool}?`, message: "No target path given." };
		const target = resolveToCwd(rawPath, cwd);
		// Checked before anything is asked: a name that Windows reads as another file cannot be approved.
		const refusal = aliasRefusalFor(rawPath, target, cwd);
		if (refusal !== undefined) return { reason: refusal };
		const shownTarget = sanitizeForPrompt(target);
		const shownProject = sanitizeForPrompt(cwd);
		const inside = insideProjectPath(target, cwd);
		if (inside === undefined) {
			return {
				title: `Allow ${tool} outside the project?`,
				message: `${tool} wants to write ${shownTarget}${linkNote(target)}\n\nProject folder: ${shownProject}`,
			};
		}
		const reason = protectedWriteReason(target, cwd, inside);
		if (reason === undefined) return undefined;
		return {
			title: `Allow ${tool} to modify a protected file?`,
			message: [
				`${tool} wants to write ${shownTarget}${linkNote(target)}`,
				reason,
				"",
				`Project folder: ${shownProject}`,
			].join("\n"),
		};
	}
	return otherToolRequest(toolName, args, options.replacesBuiltin === true);
}

export interface ApprovalUI {
	hasUI: boolean;
	confirm(title: string, message: string, opts?: { signal?: AbortSignal; timeout?: number }): Promise<boolean>;
}

/** Ask the user; anything other than an explicit yes (no UI, dismissal, timeout, abort, error) denies. */
export async function requestApproval(
	ui: ApprovalUI | undefined,
	request: ApprovalRequest,
	options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<boolean> {
	if (!ui?.hasUI || options.signal?.aborted) return false;
	try {
		const approved = await ui.confirm(request.title, request.message, {
			signal: options.signal,
			timeout: options.timeoutMs ?? APPROVAL_TIMEOUT_MS,
		});
		return approved === true && !options.signal?.aborted;
	} catch {
		return false;
	}
}
