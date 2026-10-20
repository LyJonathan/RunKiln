/**
 * Images in the interactive editor: clipboard reads (with a clear message when there is no image or no
 * helper), pasted and dragged-in paths, @path mentions, the size/format checks with resizing, the chip
 * store, and the warning for a manual model without image input.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	acceptsImages,
	formatImageSize,
	ImageAttachments,
	MAX_IMAGE_PAYLOAD_BYTES,
	mentionedImagePaths,
	nonVisionWarning,
	normalizePastedPath,
	parsePastedImagePaths,
	prepareImageBytes,
	prepareImageFile,
	splitPastedPaths,
} from "../../src/modes/interactive/image-attachments.ts";
import {
	type ClipboardRunner,
	clipboardImageHelpHint,
	readClipboardImageResult,
} from "../../src/utils/clipboard-image.ts";
import { loadPhoton } from "../../src/utils/photon.ts";

/** A 1×1 PNG. */
const TINY_PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
	"base64",
);

const dirs: string[] = [];
function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "runkiln-images-"));
	dirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("image checks", () => {
	it("accepts a small PNG as is and labels it with its size", async () => {
		const result = await prepareImageBytes(new Uint8Array(TINY_PNG));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.image).toMatchObject({ type: "image", mimeType: "image/png" });
		expect(result.label).toBe(formatImageSize(result.bytes));
		expect(result.note).toBeUndefined();
	});

	it("refuses bytes that are not an image, and empty files", async () => {
		const text = await prepareImageBytes(new TextEncoder().encode("not an image at all"), "notes.png");
		expect(text).toEqual({
			ok: false,
			message: expect.stringContaining("notes.png is not a PNG, JPEG, GIF, WebP or BMP image"),
		});
		expect(await prepareImageBytes(new Uint8Array(), "x.png")).toEqual({ ok: false, message: "x.png is empty." });
	});

	it("resizes a large image below the request cap and says so", async () => {
		const photon = await loadPhoton();
		expect(photon).toBeTruthy();
		const width = 2400;
		const height = 1600;
		const pixels = new Uint8Array(width * height * 4);
		let seed = 7;
		for (let i = 0; i < pixels.length; i++) {
			seed = (seed * 1103515245 + 12345) & 0x7fffffff;
			pixels[i] = i % 4 === 3 ? 255 : seed & 0xff;
		}
		const image = new photon!.PhotonImage(pixels, width, height);
		const png = image.get_bytes();
		image.free();
		expect(png.length).toBeGreaterThan(MAX_IMAGE_PAYLOAD_BYTES);
		const result = await prepareImageBytes(png, "noise.png");
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.image.data.length).toBeLessThanOrEqual(MAX_IMAGE_PAYLOAD_BYTES);
		expect(result.note).toBe("resized from 2400×1600");
	}, 60_000);

	it("formats sizes for the chip", () => {
		expect(formatImageSize(512)).toBe("512 B");
		expect(formatImageSize(240 * 1024)).toBe("240 KB");
		expect(formatImageSize(Math.round(1.5 * 1024 * 1024))).toBe("1.5 MB");
	});
});

describe("pasted and dragged-in paths", () => {
	const options = (dir: string) => ({ cwd: dir, home: "/home/kiln" });

	it("normalizes the forms terminals send for a drop", () => {
		const o = { cwd: "/work", home: "/home/kiln" };
		expect(normalizePastedPath("'/tmp/a b.png'", o)).toBe("/tmp/a b.png");
		expect(normalizePastedPath("/tmp/a\\ b\\(1\\).png", o)).toBe("/tmp/a b(1).png");
		expect(normalizePastedPath("file:///tmp/a%20b.png", o)).toBe("/tmp/a b.png");
		expect(normalizePastedPath("~/shot.png", o)).toBe("/home/kiln/shot.png");
		expect(normalizePastedPath("shots/x.png", o)).toBe("/work/shots/x.png");
		expect(normalizePastedPath("C:\\Users\\kiln\\shot.png", { ...o, wsl: true })).toBe("/mnt/c/Users/kiln/shot.png");
		expect(splitPastedPaths("/a/x.png /b/y\\ z.jpg '/c/w v.gif'")).toEqual([
			"/a/x.png",
			"/b/y\\ z.jpg",
			"'/c/w v.gif'",
		]);
		expect(splitPastedPaths("/a/x.png\n/b/y.png\n")).toEqual(["/a/x.png", "/b/y.png"]);
	});

	it("attaches only when the paste is a list of existing files with an image", () => {
		const dir = tempDir();
		writeFileSync(join(dir, "shot one.png"), TINY_PNG);
		writeFileSync(join(dir, "b.jpg"), TINY_PNG);
		writeFileSync(join(dir, "notes.txt"), "hi");
		const o = options(dir);
		expect(parsePastedImagePaths(`${join(dir, "shot\\ one.png")}`, o)).toEqual({
			images: [join(dir, "shot one.png")],
			others: [],
		});
		// Unescaped spaces in a single dropped path still resolve as one file.
		expect(parsePastedImagePaths(join(dir, "shot one.png"), o)).toEqual({
			images: [join(dir, "shot one.png")],
			others: [],
		});
		expect(parsePastedImagePaths(`${join(dir, "b.jpg")}\n${join(dir, "notes.txt")}`, o)).toEqual({
			images: [join(dir, "b.jpg")],
			others: [join(dir, "notes.txt")],
		});
		expect(parsePastedImagePaths(join(dir, "notes.txt"), o)).toBeUndefined();
		expect(parsePastedImagePaths(join(dir, "missing.png"), o)).toBeUndefined();
		expect(parsePastedImagePaths("look at this /tmp/x.png please", o)).toBeUndefined();
	});

	it("finds @mentions of image files, which then go with the prompt", async () => {
		const dir = tempDir();
		writeFileSync(join(dir, "ui.png"), TINY_PNG);
		writeFileSync(join(dir, "main.ts"), "x");
		const found = mentionedImagePaths("fix the layout in @ui.png, see @main.ts and @missing.png", options(dir));
		expect(found).toEqual([join(dir, "ui.png")]);
		const prepared = await prepareImageFile(found[0]!);
		expect(prepared.ok).toBe(true);
	});
});

describe("image chips", () => {
	const prepared = { image: { type: "image" as const, data: "AA==", mimeType: "image/png" }, bytes: 1, label: "1 B" };

	it("sends only the images whose chips are still in the text, in chip order", () => {
		const store = new ImageAttachments();
		const one = store.add(prepared);
		const two = store.add({ ...prepared, label: "2 B" });
		const three = store.add(prepared);
		expect([one.id, two.id, three.id]).toEqual([1, 2, 3]);
		// Chip 2 was deleted from the editor; chip 3 comes first in the text.
		const sent = store.resolve("compare [image 3 - 1 B] with [image 1 - 1 B]");
		expect(sent.map((item) => item.id)).toEqual([3, 1]);
		store.clear();
		expect(store.size).toBe(0);
		expect(store.add(prepared).id).toBe(1);
	});

	it("warns for a manual model without image input and names models that take images", () => {
		const deepseek = {
			id: "deepseek-v4-1-flash",
			name: "DeepSeek V4.1 Flash",
			input: ["text"] as ("text" | "image")[],
		};
		const glm = { id: "glm-5-3-flash", name: "GLM 5.3 Flash", input: ["text", "image"] as ("text" | "image")[] };
		expect(acceptsImages(glm)).toBe(true);
		expect(acceptsImages(deepseek)).toBe(false);
		expect(nonVisionWarning(deepseek, [glm])).toBe(
			'DeepSeek V4.1 Flash can\'t see images; it gets "(image omitted)" instead. Switch with /model (GLM 5.3 Flash) or use auto.',
		);
	});
});

describe("clipboard image read", () => {
	type Call = { command: string; args: readonly string[] };
	function runner(handler: (command: string, args: readonly string[]) => Buffer | undefined) {
		const calls: Call[] = [];
		const run: ClipboardRunner = async (command, args) => {
			calls.push({ command, args });
			return handler(command, args);
		};
		return { run, calls };
	}
	const none = () => undefined;

	it("Wayland: reads the image type wl-paste lists", async () => {
		const { run, calls } = runner((command, args) => {
			if (command !== "wl-paste") return undefined;
			return args.includes("--list-types") ? Buffer.from("text/plain\nimage/png\n") : TINY_PNG;
		});
		const result = await readClipboardImageResult({
			platform: "linux",
			env: { WAYLAND_DISPLAY: "wayland-0", WSL_DISTRO_NAME: "" },
			deps: { run, has: () => true, native: none },
		});
		expect(result.kind).toBe("image");
		expect(calls[1]?.args).toEqual(["--type", "image/png", "--no-newline"]);
	});

	it("X11 with only text on the clipboard says there is no image", async () => {
		const { run } = runner((command, args) =>
			command === "xclip" && args.includes("TARGETS") ? Buffer.from("UTF8_STRING\nTEXT\n") : undefined,
		);
		const result = await readClipboardImageResult({
			platform: "linux",
			env: { DISPLAY: ":0" },
			deps: { run, has: (command) => command === "xclip", native: () => ({ getImage: async () => undefined }) },
		});
		expect(result).toEqual({ kind: "empty" });
	});

	it("names the helper to install when none can read the clipboard", async () => {
		const { run } = runner(() => undefined);
		const x11 = await readClipboardImageResult({
			platform: "linux",
			env: { DISPLAY: ":0" },
			deps: { run, has: () => false, native: none },
		});
		expect(x11).toEqual({ kind: "unavailable", message: expect.stringContaining("Install xclip") });
		const wayland = await readClipboardImageResult({
			platform: "linux",
			env: { WAYLAND_DISPLAY: "wayland-0" },
			deps: { run, has: () => false, native: none },
		});
		expect(wayland).toEqual({ kind: "unavailable", message: expect.stringContaining("Install wl-clipboard") });
		const ssh = await readClipboardImageResult({
			platform: "linux",
			env: {},
			deps: { run, has: () => false, native: none },
		});
		expect(ssh).toEqual({ kind: "unavailable", message: expect.stringContaining("No display") });
		expect(clipboardImageHelpHint("linux", { WSL_DISTRO_NAME: "Ubuntu" }, () => false)).toContain("powershell.exe");
		expect(clipboardImageHelpHint("darwin", {}, () => false)).toContain("brew install pngpaste");
	});

	it("macOS without the native helper falls back to AppleScript", async () => {
		const { run } = runner((command, args) => {
			if (command !== "osascript") return undefined;
			if (args[1] === "clipboard info") return Buffer.from("«class PNGf», 70, «class 8BPS», 1000");
			return Buffer.from(`«data PNGf${TINY_PNG.toString("hex").toUpperCase()}»\n`);
		});
		const result = await readClipboardImageResult({
			platform: "darwin",
			env: {},
			deps: { run, has: (command) => command === "osascript", native: none },
		});
		expect(result.kind).toBe("image");
		if (result.kind === "image") expect(Buffer.from(result.image.bytes).equals(TINY_PNG)).toBe(true);
	});

	it("Windows without the native helper reads the clipboard through PowerShell", async () => {
		const { run } = runner((command, args) => {
			if (command !== "powershell.exe") return undefined;
			const path = String(args[2]).match(/\$path = '([^']+)'/)?.[1];
			if (path) writeFileSync(path, TINY_PNG);
			return Buffer.from("ok\r\n");
		});
		const result = await readClipboardImageResult({
			platform: "win32",
			env: {},
			deps: { run, has: () => true, native: none },
		});
		expect(result.kind).toBe("image");
		const missing = await readClipboardImageResult({
			platform: "win32",
			env: {},
			deps: { run: async () => undefined, has: () => false, native: none },
		});
		expect(missing).toEqual({ kind: "unavailable", message: expect.stringContaining("PowerShell") });
	});

	it("WSL: an empty Linux clipboard falls back to the Windows one", async () => {
		const { run } = runner((command, args) => {
			if (command === "wl-paste" && args.includes("--list-types")) return Buffer.from("text/plain\n");
			if (command === "wslpath") return Buffer.from("C:\\\\tmp\\\\x.png\n");
			if (command === "powershell.exe") return Buffer.from("empty\r\n");
			return undefined;
		});
		const result = await readClipboardImageResult({
			platform: "linux",
			env: { WSL_DISTRO_NAME: "Ubuntu", WAYLAND_DISPLAY: "wayland-0" },
			deps: { run, has: () => true, native: none },
		});
		expect(result).toEqual({ kind: "empty" });
	});
});
