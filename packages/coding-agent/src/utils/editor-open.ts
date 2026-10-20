/**
 * Open a file in the user's editor at a line (setting `editor.open`). This module only plans the command;
 * the interactive mode runs it. Nothing here goes through a shell, except a Windows `.cmd`/`.bat` custom
 * template, which is run through `cmd.exe` with quoted arguments and refused when an argument has a cmd
 * metacharacter.
 *
 * Presets: auto (default), system, vscode, cursor, zed, nvim, idea, subl, editor ($VISUAL/$EDITOR). Anything
 * else containing `{file}` is a custom template, for example `code -g {file}:{line}:{col}`.
 */

import { homedir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export const EDITOR_OPEN_PRESETS = [
	"auto",
	"system",
	"vscode",
	"cursor",
	"zed",
	"nvim",
	"idea",
	"subl",
	"editor",
] as const;
export type EditorOpenPreset = (typeof EDITOR_OPEN_PRESETS)[number];

export interface FileLocation {
	file: string;
	line?: number;
	col?: number;
}

export type EditorOpenPlan =
	| {
			kind: "spawn";
			command: string;
			args: string[];
			/** Editor name for the toast, e.g. "VS Code". */
			label: string;
			/** Runs in this terminal: the TUI must stop while it runs. */
			terminal?: boolean;
			/** Pass args to the process unquoted (Windows cmd.exe invocation). */
			windowsVerbatimArguments?: boolean;
	  }
	/** An editor URL (vscode://, idea://) or the file itself, opened with the OS default handler. */
	| { kind: "open"; target: string; label: string }
	/** Nothing local can open it (SSH, UNC path, unsafe template): copy `path:line` instead. */
	| { kind: "copy"; text: string; reason: string };

export interface EditorOpenContext {
	platform: NodeJS.Platform;
	env: NodeJS.ProcessEnv;
}

const PRESET_LABELS: Record<Exclude<EditorOpenPreset, "auto" | "editor">, string> = {
	system: "the default app",
	vscode: "VS Code",
	cursor: "Cursor",
	zed: "Zed",
	nvim: "Neovim",
	idea: "IntelliJ",
	subl: "Sublime Text",
};

/** Terminal editors take over this terminal; they run with the TUI stopped. */
const TERMINAL_EDITORS = new Set(["vi", "vim", "nvim", "nano", "emacs", "micro", "kak", "hx", "helix", "joe", "ne"]);
/** Editors that take `+line file`. */
const PLUS_LINE_EDITORS = new Set(["vi", "vim", "nvim", "nano", "emacs", "micro", "kak", "joe", "ne"]);

/**
 * Parse `src/foo.ts:42:3`, `src/foo.ts:42`, `src/foo.ts(42,3)`, `src/foo.ts#L42` or a `file://` URL (with an
 * optional `#L42` or `#L42C3`) into a location. Relative paths resolve against cwd, `~` against home.
 */
export function parseFileLocation(
	input: string,
	cwd: string,
	platform: NodeJS.Platform = process.platform,
): FileLocation | undefined {
	let text = input.trim();
	if (text === "") return undefined;
	let line: number | undefined;
	let col: number | undefined;
	const pathApi = platform === "win32" ? path.win32 : path.posix;

	if (/^file:\/\//i.test(text)) {
		let hash = "";
		const hashAt = text.indexOf("#");
		if (hashAt >= 0) {
			hash = text.slice(hashAt + 1);
			text = text.slice(0, hashAt);
		}
		let file: string;
		try {
			file = fileURLToPath(text, { windows: platform === "win32" });
		} catch {
			return undefined;
		}
		const hashMatch = /^L(\d+)(?:C(\d+))?$/i.exec(hash);
		if (hashMatch) {
			line = Number(hashMatch[1]);
			if (hashMatch[2]) col = Number(hashMatch[2]);
		}
		const suffix = splitLineSuffix(file);
		return withPosition(suffix.file, line ?? suffix.line, col ?? suffix.col);
	}

	const hashLine = /^(.*)#L(\d+)(?:C(\d+))?$/i.exec(text);
	if (hashLine) {
		text = hashLine[1]!;
		line = Number(hashLine[2]);
		if (hashLine[3]) col = Number(hashLine[3]);
	} else {
		const paren = /^(.*)\((\d+)(?:,\s*(\d+))?\)$/.exec(text);
		if (paren) {
			text = paren[1]!;
			line = Number(paren[2]);
			if (paren[3]) col = Number(paren[3]);
		} else {
			const suffix = splitLineSuffix(text);
			text = suffix.file;
			line = suffix.line;
			col = suffix.col;
		}
	}
	if (text === "") return undefined;
	if (text === "~" || text.startsWith("~/") || text.startsWith("~\\")) text = pathApi.join(homedir(), text.slice(1));
	const file = pathApi.isAbsolute(text) ? pathApi.normalize(text) : pathApi.resolve(cwd, text);
	return withPosition(file, line, col);
}

function splitLineSuffix(text: string): FileLocation {
	const match = /^(.*?):(\d+)(?::(\d+))?$/.exec(text);
	// A bare drive letter ("C:") is not a line suffix.
	if (!match || match[1] === "" || /^[A-Za-z]$/.test(match[1]!)) return { file: text };
	return { file: match[1]!, line: Number(match[2]), ...(match[3] ? { col: Number(match[3]) } : {}) };
}

function withPosition(file: string, line?: number, col?: number): FileLocation {
	return {
		file,
		...(line !== undefined && line > 0 ? { line } : {}),
		...(col !== undefined && col > 0 ? { col } : {}),
	};
}

/** `path:line` (or `path:line:col`) for toasts and the copy fallback. */
export function formatFileLocation(location: FileLocation, cwd?: string): string {
	let file = location.file;
	if (cwd) {
		const relative = path.relative(cwd, file);
		if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) file = relative;
	}
	if (location.line === undefined) return file;
	return location.col === undefined ? `${file}:${location.line}` : `${file}:${location.line}:${location.col}`;
}

function isUncPath(file: string): boolean {
	return /^(\\\\|\/\/)[^\\/]/.test(file);
}

function isRemoteSession(env: NodeJS.ProcessEnv): boolean {
	return Boolean(env.SSH_CONNECTION || env.SSH_CLIENT || env.SSH_TTY);
}

function commandBase(command: string): string {
	return path
		.basename(command.replace(/\\/g, "/"))
		.toLowerCase()
		.replace(/\.(exe|cmd|bat)$/, "");
}

/** Map an editor command name to a preset, when it is one. */
function presetForCommand(command: string): keyof typeof PRESET_LABELS | undefined {
	const base = commandBase(command);
	if (base === "code" || base === "code-insiders" || base === "codium") return "vscode";
	if (base === "cursor") return "cursor";
	if (base === "zed" || base === "zeditor") return "zed";
	if (base === "subl") return "subl";
	if (base === "idea" || base === "idea64") return "idea";
	return undefined;
}

/** Which preset "auto" means here: the editor whose terminal RunKiln runs in, else $VISUAL/$EDITOR, else system. */
export function resolveAutoPreset(env: NodeJS.ProcessEnv): EditorOpenPreset {
	if (env.TERM_PROGRAM === "vscode") return env.CURSOR_TRACE_ID ? "cursor" : "vscode";
	if (env.ZED_TERM === "true" || env.TERM_PROGRAM === "zed") return "zed";
	if (env.TERMINAL_EMULATOR === "JetBrains-JediTerm") return "idea";
	if (env.NVIM) return "nvim";
	const configured = env.VISUAL || env.EDITOR;
	if (configured) {
		const [command] = splitCommandLine(configured);
		if (command && (presetForCommand(command) || TERMINAL_EDITORS.has(commandBase(command)))) return "editor";
	}
	return "system";
}

/** Split a command line into argv, honouring single and double quotes. No shell expansion. */
export function splitCommandLine(text: string): string[] {
	const args: string[] = [];
	let current = "";
	let quote: '"' | "'" | undefined;
	let started = false;
	for (const char of text) {
		if (quote) {
			if (char === quote) quote = undefined;
			else current += char;
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
			started = true;
			continue;
		}
		if (/\s/.test(char)) {
			if (started) args.push(current);
			current = "";
			started = false;
			continue;
		}
		current += char;
		started = true;
	}
	if (started) args.push(current);
	return args;
}

/** `vscode://file/C:/a b/x.ts:12:3` style URL (path segments encoded, slashes kept). */
export function editorUrl(scheme: string, location: FileLocation): string {
	const forward = location.file.replace(/\\/g, "/");
	const encoded = forward
		.split("/")
		.map((segment, index) => (index === 0 && /^[A-Za-z]:$/.test(segment) ? segment : encodeURIComponent(segment)))
		.join("/");
	const lead = encoded.startsWith("/") ? "" : "/";
	const position =
		location.line === undefined ? "" : `:${location.line}${location.col === undefined ? "" : `:${location.col}`}`;
	return `${scheme}://file${lead}${encoded}${position}`;
}

const CMD_METACHARACTERS = /["%&|<>^!\r\n]/;

/**
 * Run a Windows `.cmd`/`.bat` (which Node refuses to spawn directly) through cmd.exe. Each argument is
 * double-quoted; arguments with cmd metacharacters are refused (returns undefined), since cmd re-parses them.
 */
export function windowsCmdInvocation(
	command: string,
	args: string[],
): { command: string; args: string[]; windowsVerbatimArguments: true } | undefined {
	if ([command, ...args].some((arg) => CMD_METACHARACTERS.test(arg))) return undefined;
	const quote = (arg: string) => `"${arg}"`;
	const line = [command, ...args].map(quote).join(" ");
	return { command: "cmd.exe", args: ["/d", "/s", "/c", `"${line}"`], windowsVerbatimArguments: true };
}

function lineCol(location: FileLocation): string {
	if (location.line === undefined) return location.file;
	return `${location.file}:${location.line}${location.col === undefined ? "" : `:${location.col}`}`;
}

/** Arguments that open `location` in a known editor command. */
function argsForCommand(base: string, location: FileLocation): string[] {
	if (base === "code" || base === "code-insiders" || base === "codium" || base === "cursor") {
		return location.line === undefined ? [location.file] : ["-g", lineCol(location)];
	}
	if (base === "zed" || base === "zeditor" || base === "subl" || base === "hx" || base === "helix") {
		return [lineCol(location)];
	}
	if (base === "idea" || base === "idea64") {
		const args: string[] = [];
		if (location.line !== undefined) args.push("--line", String(location.line));
		if (location.col !== undefined) args.push("--column", String(location.col));
		return [...args, location.file];
	}
	if (PLUS_LINE_EDITORS.has(base) && location.line !== undefined) {
		const position =
			base === "nano" && location.col !== undefined ? `+${location.line},${location.col}` : `+${location.line}`;
		return [position, location.file];
	}
	return [location.file];
}

/** Escape a path for a Vim `:edit` command. */
function vimEscape(file: string): string {
	return file.replace(/([\\ %#|"])/g, "\\$1");
}

/** Plan how to open `location` for the `editor.open` setting. */
export function planEditorOpen(
	setting: string | undefined,
	location: FileLocation,
	context: EditorOpenContext = { platform: process.platform, env: process.env },
): EditorOpenPlan {
	const { platform, env } = context;
	const text = lineCol(location);
	if (isUncPath(location.file)) return { kind: "copy", text, reason: "network path, not opened" };

	const value = (setting ?? "auto").trim() || "auto";
	if (value.includes("{file}")) return planTemplate(value, location, context);

	let preset = (EDITOR_OPEN_PRESETS as readonly string[]).includes(value) ? (value as EditorOpenPreset) : "auto";
	if (preset === "auto") preset = resolveAutoPreset(env);

	// Over SSH a local editor or opener would open on the remote machine. VS Code's and Cursor's remote
	// terminals are the exception: their `code` CLI opens the file in the client window.
	const remote = isRemoteSession(env);
	const vscodeRemote = env.TERM_PROGRAM === "vscode";
	if (remote && !(vscodeRemote && (preset === "vscode" || preset === "cursor")) && !(preset === "nvim" && env.NVIM)) {
		return { kind: "copy", text, reason: "no local editor" };
	}

	switch (preset) {
		case "system":
			return { kind: "open", target: location.file, label: PRESET_LABELS.system };
		case "vscode":
		case "cursor": {
			const command = preset === "vscode" ? "code" : "cursor";
			// Windows installs code.cmd, which Node cannot spawn without a shell: use the URL handler.
			if (platform === "win32") {
				return {
					kind: "open",
					target: editorUrl(preset === "vscode" ? "vscode" : "cursor", location),
					label: PRESET_LABELS[preset],
				};
			}
			return { kind: "spawn", command, args: argsForCommand(command, location), label: PRESET_LABELS[preset] };
		}
		case "zed":
			return { kind: "spawn", command: "zed", args: argsForCommand("zed", location), label: PRESET_LABELS.zed };
		case "subl":
			return { kind: "spawn", command: "subl", args: argsForCommand("subl", location), label: PRESET_LABELS.subl };
		case "idea": {
			if (platform === "win32") {
				const query = `file=${encodeURIComponent(location.file)}${location.line === undefined ? "" : `&line=${location.line}`}`;
				return { kind: "open", target: `idea://open?${query}`, label: PRESET_LABELS.idea };
			}
			return { kind: "spawn", command: "idea", args: argsForCommand("idea", location), label: PRESET_LABELS.idea };
		}
		case "nvim": {
			if (env.NVIM) {
				const jump = location.line === undefined ? "" : `+${location.line} `;
				return {
					kind: "spawn",
					command: "nvim",
					args: ["--server", env.NVIM, "--remote-send", `<C-\\><C-N>:edit ${jump}${vimEscape(location.file)}<CR>`],
					label: PRESET_LABELS.nvim,
				};
			}
			return {
				kind: "spawn",
				command: "nvim",
				args: argsForCommand("nvim", location),
				label: PRESET_LABELS.nvim,
				terminal: true,
			};
		}
		case "editor": {
			const configured = env.VISUAL || env.EDITOR;
			const argv = configured ? splitCommandLine(configured) : [];
			const command = argv[0];
			if (!command) return { kind: "open", target: location.file, label: PRESET_LABELS.system };
			const mapped = presetForCommand(command);
			if (mapped && platform === "win32" && (mapped === "vscode" || mapped === "cursor")) {
				return { kind: "open", target: editorUrl(mapped, location), label: PRESET_LABELS[mapped] };
			}
			const base = commandBase(command);
			// Drop a --wait flag: the editor should open beside RunKiln, not block it.
			const extra = argv.slice(1).filter((arg) => arg !== "--wait" && arg !== "-w");
			return {
				kind: "spawn",
				command,
				args: [...extra, ...argsForCommand(base, location)],
				label: mapped ? PRESET_LABELS[mapped] : base,
				...(TERMINAL_EDITORS.has(base) ? { terminal: true } : {}),
			};
		}
		default:
			return { kind: "open", target: location.file, label: PRESET_LABELS.system };
	}
}

function planTemplate(template: string, location: FileLocation, context: EditorOpenContext): EditorOpenPlan {
	const text = lineCol(location);
	if (isRemoteSession(context.env)) return { kind: "copy", text, reason: "no local editor" };
	const argv = splitCommandLine(template).map((arg) =>
		arg
			.replaceAll("{file}", location.file)
			.replaceAll("{line}", String(location.line ?? 1))
			.replaceAll("{col}", String(location.col ?? 1)),
	);
	const [command, ...args] = argv;
	if (!command) return { kind: "copy", text, reason: "empty editor.open template" };
	const base = commandBase(command);
	const mapped = presetForCommand(command);
	const label = mapped ? PRESET_LABELS[mapped] : base;
	if (context.platform === "win32" && /\.(cmd|bat)$/i.test(command)) {
		const invocation = windowsCmdInvocation(command, args);
		if (!invocation) return { kind: "copy", text, reason: "path not safe for cmd.exe" };
		return { kind: "spawn", ...invocation, label };
	}
	return { kind: "spawn", command, args, label, ...(TERMINAL_EDITORS.has(base) ? { terminal: true } : {}) };
}
