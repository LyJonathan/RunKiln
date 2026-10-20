import { randomUUID } from "node:crypto";
import { unlinkSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { getNativeClipboard } from "@runkiln/tui";
import { runClipboardCommand } from "./clipboard-command.ts";
import { isWSL } from "./wsl.ts";

const MAX_OSC52_ENCODED_LENGTH = 100_000;

/**
 * Whether the terminal window has focus, from focus reports (?1004). Windows Terminal 1.25 ignores OSC 52
 * while unfocused, so an unfocused copy takes the PowerShell path instead. Undefined: not reported.
 */
let terminalFocused: boolean | undefined;

export function setTerminalFocused(focused: boolean | undefined): void {
	terminalFocused = focused;
}

/** Linux commands that also write the PRIMARY selection, so middle-click paste gets the copy. */
export function primarySelectionCommands(env: NodeJS.ProcessEnv): [string, string[]][] {
	const commands: [string, string[]][] = [];
	if (env.WAYLAND_DISPLAY) commands.push(["wl-copy", ["--primary"]]);
	if (env.DISPLAY) commands.push(["xclip", ["-selection", "primary"]], ["xsel", ["--primary", "--input"]]);
	return commands;
}

async function copyPrimarySelection(text: string, env: NodeJS.ProcessEnv): Promise<void> {
	for (const [command, args] of primarySelectionCommands(env)) {
		if ((await runClipboardCommand(command, args, { input: text, timeoutMs: 2000 })) !== undefined) return;
	}
}

/**
 * Remote sessions also emit OSC 52 so the client terminal receives the copy. RUNKILN_CLIPBOARD_OSC52=1
 * covers remote clients that leave no SSH markers, such as multiplexer attaches (#10114, #10835)
 * or IDE daemons (#10826).
 */
function isRemoteSession(env: NodeJS.ProcessEnv): boolean {
	return Boolean(env.SSH_CONNECTION || env.SSH_CLIENT || env.MOSH_CONNECTION || env.RUNKILN_CLIPBOARD_OSC52 === "1");
}

function emitOsc52(text: string): boolean {
	const encoded = Buffer.from(text).toString("base64");
	if (encoded.length > MAX_OSC52_ENCODED_LENGTH) {
		return false;
	}
	process.stdout.write(`\x1b]52;c;${encoded}\x07`);
	return true;
}

/**
 * WSL without WSLg has no Linux display, so the Windows clipboard is written through
 * interop. PowerShell reads the text from a file because `clip.exe` and PowerShell stdin
 * decode piped bytes with the console code page, which mangles non-ASCII UTF-8.
 */
async function copyViaWindowsClipboard(text: string): Promise<boolean> {
	const tmpFile = join(tmpdir(), `runkiln-wsl-clip-${randomUUID()}.txt`);
	try {
		writeFileSync(tmpFile, text, { encoding: "utf8", mode: 0o600 });
		const winPath = (await runClipboardCommand("wslpath", ["-w", tmpFile], { timeoutMs: 1000 }))
			?.toString("utf8")
			.trim();
		if (!winPath) return false;
		const script = `Set-Clipboard -Value ([System.IO.File]::ReadAllText('${winPath.replaceAll("'", "''")}', [System.Text.Encoding]::UTF8))`;
		const result = await runClipboardCommand("powershell.exe", ["-NoProfile", "-Command", script], {
			timeoutMs: 5000,
		});
		return result !== undefined;
	} catch {
		return false;
	} finally {
		try {
			unlinkSync(tmpFile);
		} catch {
			// The file may not have been created.
		}
	}
}

/** Read plain text from the system clipboard. */
export async function readClipboardText(): Promise<string | null> {
	const commands: [string, string[]][] = [];
	// Termux reports platform "android", not "linux" (#10391).
	if (process.env.TERMUX_VERSION) commands.push(["termux-clipboard-get", []]);
	if (platform() === "linux") {
		if (process.env.WAYLAND_DISPLAY) commands.push(["wl-paste", ["--no-newline", "--type", "text"]]);
		if (process.env.DISPLAY) {
			commands.push(["xclip", ["-selection", "clipboard", "-out"]], ["xsel", ["--clipboard", "--output"]]);
		}
	}
	for (const [command, args] of commands) {
		const bytes = await runClipboardCommand(command, args, { timeoutMs: 5000 });
		if (bytes !== undefined) return bytes.toString("utf8") || null;
	}
	try {
		return (await getNativeClipboard()?.getText()) || null;
	} catch {
		return null;
	}
}

/** Read file paths, such as Finder file copies, from the native clipboard. */
export async function readClipboardFilePaths(): Promise<string[] | null> {
	const paths = await getNativeClipboard()?.getFilePaths?.();
	return paths?.length ? paths : null;
}

export async function copyToClipboard(text: string): Promise<void> {
	const p = platform();
	const env = process.env;
	let copied = false;
	// Direct writes precede OSC 52 so the terminal cannot race the native writer.
	// Linux tools retain clipboard selection ownership after this call returns.
	if (p !== "linux") {
		try {
			const clipboard = getNativeClipboard();
			if (clipboard?.setText) {
				await clipboard.setText(text);
				copied = true;
			}
		} catch {
			// Try platform commands next.
		}
	}
	if (!copied) {
		const commands: [string, string[]][] = [];
		if (p === "darwin") commands.push(["pbcopy", []]);
		else if (p === "win32") commands.push(["clip", []]);
		else {
			if (env.TERMUX_VERSION) commands.push(["termux-clipboard-set", []]);
			if (env.WAYLAND_DISPLAY) commands.push(["wl-copy", []]);
			if (env.DISPLAY) {
				commands.push(["xclip", ["-selection", "clipboard"]], ["xsel", ["--clipboard", "--input"]]);
			}
		}
		for (const [command, args] of commands) {
			if ((await runClipboardCommand(command, args, { input: text, timeoutMs: 5000 })) !== undefined) {
				copied = true;
				break;
			}
		}
		// Best effort: PRIMARY too, as other Linux apps do on select.
		if (copied && p === "linux" && !env.TERMUX_VERSION) await copyPrimarySelection(text, env);
	}
	let osc52Emitted = false;
	if (!copied && p === "linux" && isWSL(env)) {
		// Windows Terminal supports OSC 52; prefer it over the slower PowerShell round trip, except while the
		// window is unfocused, where Windows Terminal 1.25 drops it.
		if (env.WT_SESSION && terminalFocused !== false) osc52Emitted = emitOsc52(text);
		copied = osc52Emitted || (await copyViaWindowsClipboard(text));
	}
	// OSC 52 cannot be verified, so a desktop session with a display reports the failure
	// instead (#9618). Without a display the terminal is the only clipboard route (containers,
	// WSL without WSLg), and remote sessions always emit it to reach the client clipboard.
	const headless = p === "linux" && !env.DISPLAY && !env.WAYLAND_DISPLAY && !env.TERMUX_VERSION;
	let oversized = false;
	if (!osc52Emitted && (isRemoteSession(env) || (!copied && headless))) {
		if (emitOsc52(text)) copied = true;
		else oversized = true;
	}
	// Native Windows in Windows Terminal: when clip.exe and the native clipboard both failed, OSC 52 is the last route.
	if (!copied && p === "win32" && env.WT_SESSION && terminalFocused !== false && emitOsc52(text)) copied = true;
	if (copied) return;
	if (oversized) throw new Error("Clipboard unavailable: text exceeds the OSC 52 size limit");
	if (env.TERMUX_VERSION) {
		throw new Error("Clipboard unavailable: install the Termux:API app and `termux-api` package");
	}
	if (p === "linux") {
		if (env.WAYLAND_DISPLAY) {
			throw new Error("Clipboard unavailable: install `wl-clipboard` (`wl-copy`) or check Wayland access");
		}
		if (env.DISPLAY) {
			throw new Error("Clipboard unavailable: install `xclip` or `xsel`, or check X11 access");
		}
	}
	throw new Error("Clipboard unavailable");
}
