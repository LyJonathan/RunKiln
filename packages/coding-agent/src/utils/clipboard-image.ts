import { getNativeClipboard } from "@runkiln/tui";
import { randomUUID } from "crypto";
import { accessSync, constants, readFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { delimiter, join } from "path";

import { runClipboardCommand } from "./clipboard-command.ts";
import { detectSupportedImageMimeType } from "./mime.ts";
import { loadPhoton } from "./photon.ts";
import { isWSL } from "./wsl.ts";

export type ClipboardImage = {
	bytes: Uint8Array;
	mimeType: string;
};

const SUPPORTED_IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;

const DEFAULT_LIST_TIMEOUT_MS = 1000;
const DEFAULT_POWERSHELL_TIMEOUT_MS = 5000;

export function isWaylandSession(env: NodeJS.ProcessEnv = process.env): boolean {
	return Boolean(env.WAYLAND_DISPLAY) || env.XDG_SESSION_TYPE === "wayland";
}

function baseMimeType(mimeType: string): string {
	return mimeType.split(";")[0]?.trim().toLowerCase() ?? mimeType.toLowerCase();
}

export function extensionForImageMimeType(mimeType: string): string | null {
	switch (baseMimeType(mimeType)) {
		case "image/png":
			return "png";
		case "image/jpeg":
			return "jpg";
		case "image/webp":
			return "webp";
		case "image/gif":
			return "gif";
		default:
			return null;
	}
}

function selectPreferredImageMimeType(mimeTypes: string[]): string | null {
	const normalized = mimeTypes
		.map((t) => t.trim())
		.filter(Boolean)
		.map((t) => ({ raw: t, base: baseMimeType(t) }));

	for (const preferred of SUPPORTED_IMAGE_MIME_TYPES) {
		const match = normalized.find((t) => t.base === preferred);
		if (match) {
			return match.raw;
		}
	}

	const anyImage = normalized.find((t) => t.base.startsWith("image/"));
	return anyImage?.raw ?? null;
}

function isSupportedImageMimeType(mimeType: string): boolean {
	const base = baseMimeType(mimeType);
	return SUPPORTED_IMAGE_MIME_TYPES.some((t) => t === base);
}

/**
 * Convert unsupported image formats to PNG using Photon.
 * Returns null if conversion is unavailable or fails.
 */
async function convertToPng(bytes: Uint8Array): Promise<Uint8Array | null> {
	const photon = await loadPhoton();
	if (!photon) {
		return null;
	}

	try {
		const image = photon.PhotonImage.new_from_byteslice(bytes);
		try {
			return image.get_bytes();
		} finally {
			image.free();
		}
	} catch {
		return null;
	}
}

// Undefined means the backend failed; null means it has no image. An empty
// Wayland clipboard must not fall through to stale X11 clipboard contents.
async function readClipboardImageViaWlPaste(run: ClipboardRunner): Promise<ClipboardImage | null | undefined> {
	const list = await run("wl-paste", ["--list-types"], { timeoutMs: DEFAULT_LIST_TIMEOUT_MS });
	if (list === undefined) return undefined;

	const types = list
		.toString("utf-8")
		.split(/\r?\n/)
		.map((t) => t.trim())
		.filter(Boolean);

	const selectedType = selectPreferredImageMimeType(types);
	if (!selectedType) {
		return null;
	}

	const data = await run("wl-paste", ["--type", selectedType, "--no-newline"]);
	if (data === undefined) return undefined;
	if (data.length === 0) return null;

	return { bytes: data, mimeType: baseMimeType(selectedType) };
}

/**
 * On WSL, the Linux clipboard (Wayland/X11) does not receive image data from
 * Windows screenshots (Win+Shift+S). PowerShell can access the Windows clipboard
 * directly, so we use it as a fallback.
 */
async function readClipboardImageViaPowerShell(
	run: ClipboardRunner,
	native: boolean,
): Promise<ClipboardImage | null | undefined> {
	const tmpFile = join(tmpdir(), `runkiln-wsl-clip-${randomUUID()}.png`);

	try {
		let winPath = tmpFile;
		if (!native) {
			const winPathResult = await run("wslpath", ["-w", tmpFile], {
				timeoutMs: DEFAULT_LIST_TIMEOUT_MS,
			});
			if (winPathResult === undefined) {
				return undefined;
			}
			winPath = winPathResult.toString("utf-8").trim();
			if (!winPath) {
				return undefined;
			}
		}

		const psQuotedWinPath = winPath.replaceAll("'", "''");
		const psScript = [
			"Add-Type -AssemblyName System.Windows.Forms",
			"Add-Type -AssemblyName System.Drawing",
			`$path = '${psQuotedWinPath}'`,
			"$img = [System.Windows.Forms.Clipboard]::GetImage()",
			"if ($img) { $img.Save($path, [System.Drawing.Imaging.ImageFormat]::Png); Write-Output 'ok' } else { Write-Output 'empty' }",
		].join("; ");

		const result = await run("powershell.exe", ["-NoProfile", "-Command", psScript], {
			timeoutMs: DEFAULT_POWERSHELL_TIMEOUT_MS,
		});
		if (result === undefined) {
			return undefined;
		}

		const output = result.toString("utf-8").trim();
		if (output !== "ok") {
			return null;
		}

		const bytes = readFileSync(tmpFile);
		if (bytes.length === 0) {
			return null;
		}

		return { bytes: new Uint8Array(bytes), mimeType: "image/png" };
	} catch {
		return null;
	} finally {
		try {
			unlinkSync(tmpFile);
		} catch {
			// Ignore cleanup errors.
		}
	}
}

async function readClipboardImageViaXclip(run: ClipboardRunner): Promise<ClipboardImage | null | undefined> {
	const targets = await run("xclip", ["-selection", "clipboard", "-t", "TARGETS", "-o"], {
		timeoutMs: DEFAULT_LIST_TIMEOUT_MS,
	});

	if (targets === undefined) return undefined;

	const candidateTypes = targets
		.toString("utf-8")
		.split(/\r?\n/)
		.map((t) => t.trim())
		.filter(Boolean);
	const preferred = selectPreferredImageMimeType(candidateTypes);
	if (!preferred) return null;

	const data = await run("xclip", ["-selection", "clipboard", "-t", preferred, "-o"]);
	if (data === undefined) return undefined;
	if (data.length === 0) return null;
	return { bytes: data, mimeType: baseMimeType(preferred) };
}

async function readClipboardImageViaNativeClipboard(
	native: ClipboardImageDeps["native"],
): Promise<ClipboardImage | null | undefined> {
	let bytes: Uint8Array | null | undefined;
	try {
		bytes = await native()?.getImage();
	} catch {
		return undefined;
	}
	if (bytes === undefined) return undefined;
	if (!bytes?.length) return null;
	return { bytes, mimeType: detectSupportedImageMimeType(bytes) ?? "application/octet-stream" };
}

/** macOS without the native helper: `pngpaste` when installed, else AppleScript (always there). */
async function readClipboardImageViaMacTools(
	run: ClipboardRunner,
	has: (command: string) => boolean,
): Promise<ClipboardImage | null | undefined> {
	if (has("pngpaste")) {
		const data = await run("pngpaste", ["-"], { timeoutMs: DEFAULT_POWERSHELL_TIMEOUT_MS });
		if (data && data.length > 0) return { bytes: new Uint8Array(data), mimeType: "image/png" };
	}
	if (!has("osascript")) return undefined;
	const info = await run("osascript", ["-e", "clipboard info"], { timeoutMs: DEFAULT_LIST_TIMEOUT_MS * 2 });
	if (info === undefined) return undefined;
	const types = info.toString("utf-8");
	const klass = types.includes("PNGf")
		? "PNGf"
		: types.includes("TIFF")
			? "TIFF"
			: types.includes("JPEG")
				? "JPEG"
				: undefined;
	if (!klass) return null;
	const out = await run("osascript", ["-e", `get the clipboard as «class ${klass}»`], {
		timeoutMs: DEFAULT_POWERSHELL_TIMEOUT_MS,
		maxBufferBytes: 120 * 1024 * 1024,
	});
	if (out === undefined) return null;
	const hex = out.toString("utf-8").match(/«data [A-Za-z]{4}([0-9A-Fa-f]*)»/)?.[1];
	if (!hex) return null;
	const bytes = new Uint8Array(Buffer.from(hex, "hex"));
	const mimeType = klass === "PNGf" ? "image/png" : klass === "JPEG" ? "image/jpeg" : "image/tiff";
	return { bytes, mimeType };
}

export type ClipboardRunner = typeof runClipboardCommand;

export interface ClipboardImageDeps {
	run: ClipboardRunner;
	/** Whether a command is on PATH (for the "install …" hint and optional helpers). */
	has: (command: string) => boolean;
	native: () => { getImage(): Promise<Uint8Array | null | undefined> } | undefined;
}

/** Whether `command` is an executable on PATH (PATHEXT on Windows). */
export function commandOnPath(
	command: string,
	env: NodeJS.ProcessEnv = process.env,
	platform = process.platform,
): boolean {
	const dirs = (env.PATH ?? env.Path ?? "").split(platform === "win32" ? ";" : delimiter).filter(Boolean);
	const exts = platform === "win32" ? ["", ...(env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";")] : [""];
	for (const dir of dirs) {
		for (const ext of exts) {
			try {
				accessSync(join(dir, command + ext), platform === "win32" ? constants.F_OK : constants.X_OK);
				return true;
			} catch {
				// keep looking
			}
		}
	}
	return false;
}

export type ClipboardImageReadResult =
	| { kind: "image"; image: ClipboardImage }
	/** The clipboard was read and holds no image (text, files, or nothing). */
	| { kind: "empty" }
	/** No way to read the clipboard here; `message` says what to install or do instead. */
	| { kind: "unavailable"; message: string };

/** What to install (or do) when no clipboard backend worked. */
export function clipboardImageHelpHint(
	platform: NodeJS.Platform,
	env: NodeJS.ProcessEnv,
	has: (command: string) => boolean,
): string {
	if (platform === "darwin")
		return "Couldn't read images from the clipboard. Install pngpaste (brew install pngpaste), or drag the image file in.";
	if (platform === "win32")
		return "Couldn't read images from the clipboard: PowerShell (powershell.exe) was not found. Drag the image file in instead.";
	if (platform !== "linux")
		return "Image paste isn't supported on this platform. Drag the image file in or paste its path.";
	const wsl = isWSL(env);
	const wayland = isWaylandSession(env);
	if (wsl && !has("powershell.exe"))
		return "Couldn't reach the Windows clipboard: powershell.exe is not on PATH (enable WSL interop), or install wl-clipboard / xclip.";
	if (!wayland && !env.DISPLAY && !wsl)
		return "No display (SSH or a headless session), so the clipboard can't be read. Drag the image file in or paste its path.";
	if (wayland && !has("wl-paste"))
		return "Install wl-clipboard to paste images on Wayland (e.g. sudo apt install wl-clipboard).";
	if (!has("xclip")) return "Install xclip to paste images on X11 (e.g. sudo apt install xclip).";
	return "Couldn't read the clipboard. Drag the image file in or paste its path.";
}

function defaultDeps(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): ClipboardImageDeps {
	return {
		run: runClipboardCommand,
		has: (command) => commandOnPath(command, env, platform),
		native: () => getNativeClipboard(),
	};
}

/**
 * Read an image from the system clipboard, telling "no image" apart from "can't read the clipboard".
 * Linux: wl-paste (Wayland, WSLg) then xclip (X11), the Windows clipboard through PowerShell on WSL,
 * then the bundled X11 helper. macOS: the bundled helper, then pngpaste or AppleScript. Windows: the
 * bundled helper, then PowerShell.
 */
export async function readClipboardImageResult(options?: {
	env?: NodeJS.ProcessEnv;
	platform?: NodeJS.Platform;
	deps?: Partial<ClipboardImageDeps>;
}): Promise<ClipboardImageReadResult> {
	const env = options?.env ?? process.env;
	const platform = options?.platform ?? process.platform;
	const deps = { ...defaultDeps(env, platform), ...options?.deps };

	if (env.TERMUX_VERSION) {
		return {
			kind: "unavailable",
			message: "Image paste isn't supported in Termux. Paste the image file path instead.",
		};
	}

	let image: ClipboardImage | null | undefined;

	if (platform === "linux") {
		const wsl = isWSL(env);
		if (isWaylandSession(env) || wsl) {
			image = await readClipboardImageViaWlPaste(deps.run);
		}
		if (image === undefined) image = await readClipboardImageViaXclip(deps.run);
		// Preserve Linux's empty/unavailable distinction if Windows has no image.
		if (!image && wsl) {
			const windows = await readClipboardImageViaPowerShell(deps.run, false);
			if (windows !== undefined) image = windows ?? image ?? null;
		}
		if (image === undefined) image = await readClipboardImageViaNativeClipboard(deps.native);
		// xclip/wl-paste exit non-zero when the clipboard has no owner at all: that is "empty".
		if (image === undefined && (deps.has("xclip") || deps.has("wl-paste"))) image = null;
	} else if (platform === "darwin") {
		image = await readClipboardImageViaNativeClipboard(deps.native);
		if (image === undefined) image = await readClipboardImageViaMacTools(deps.run, deps.has);
	} else if (platform === "win32") {
		image = await readClipboardImageViaNativeClipboard(deps.native);
		if (image === undefined) image = await readClipboardImageViaPowerShell(deps.run, true);
	} else {
		image = await readClipboardImageViaNativeClipboard(deps.native);
	}

	if (image === undefined) return { kind: "unavailable", message: clipboardImageHelpHint(platform, env, deps.has) };
	if (!image) return { kind: "empty" };

	// Convert unsupported formats (e.g., Windows DIB data wrapped as BMP, macOS TIFF) to PNG
	if (!isSupportedImageMimeType(image.mimeType)) {
		const pngBytes = await convertToPng(image.bytes);
		if (!pngBytes) {
			return {
				kind: "unavailable",
				message: `The clipboard image (${image.mimeType}) could not be converted to PNG.`,
			};
		}
		return { kind: "image", image: { bytes: pngBytes, mimeType: "image/png" } };
	}

	return { kind: "image", image };
}

export async function readClipboardImage(options?: {
	env?: NodeJS.ProcessEnv;
	platform?: NodeJS.Platform;
}): Promise<ClipboardImage | null> {
	const result = await readClipboardImageResult(options);
	return result.kind === "image" ? result.image : null;
}
