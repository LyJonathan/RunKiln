/**
 * Images attached to the next prompt in the interactive editor.
 *
 * An image gets in three ways: Ctrl+V (Alt+V on Windows) reads the system clipboard, a pasted or
 * dragged-in file path (terminals turn a drop into a bracketed paste of the path), or an `@path`
 * mention of an image file. Each attached image shows in the editor as an atomic chip
 * `[image 1 - 240 KB]`; deleting the chip drops the image. On submit, the images whose chips are still
 * in the text are sent with the prompt as image content (not as a path the model would have to read).
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { extname, isAbsolute, resolve } from "node:path";
import type { Api, ImageContent, Model } from "@runkiln/ai";
import { imageMarkerIds } from "@runkiln/tui";
import { processImage } from "../../utils/image-process.ts";
import { detectSupportedImageMimeType } from "../../utils/mime.ts";

/** Files bigger than this are refused before any decoding. */
export const MAX_IMAGE_FILE_BYTES = 30 * 1024 * 1024;
/**
 * Base64 payload per image after resizing. RunInfra caps a request at 3.5 MiB (`max_request_bytes` on
 * /v1/models), so one image stays well below it and leaves room for the conversation.
 */
export const MAX_IMAGE_PAYLOAD_BYTES = 2 * 1024 * 1024;

export const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"] as const;

export interface PreparedImage {
	image: ImageContent;
	/** Bytes of the image as sent (decoded payload). */
	bytes: number;
	/** The chip label, e.g. "240 KB". */
	label: string;
	/** A note for the status line ("resized from 4032×3024"), when there is one. */
	note?: string;
}

export type PrepareResult = ({ ok: true } & PreparedImage) | { ok: false; message: string };

export function formatImageSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Check, convert and (when needed) shrink raw image bytes for a prompt. PNG, JPEG, GIF and WebP are
 * sent as is when small enough; BMP is converted to PNG. Anything bigger than the payload cap is resized
 * (photon, bundled; it runs off the main thread when it can).
 */
export async function prepareImageBytes(bytes: Uint8Array, nameForErrors = "the image"): Promise<PrepareResult> {
	if (bytes.length === 0) return { ok: false, message: `${nameForErrors} is empty.` };
	if (bytes.length > MAX_IMAGE_FILE_BYTES)
		return {
			ok: false,
			message: `${nameForErrors} is ${formatImageSize(bytes.length)}; the limit is ${formatImageSize(MAX_IMAGE_FILE_BYTES)}.`,
		};
	const mimeType = detectSupportedImageMimeType(bytes);
	if (!mimeType)
		return {
			ok: false,
			message: `${nameForErrors} is not a PNG, JPEG, GIF, WebP or BMP image (animated PNGs are not supported).`,
		};
	const processed = await processImage(bytes, mimeType, {
		autoResizeImages: true,
		resizeOptions: { maxBytes: MAX_IMAGE_PAYLOAD_BYTES },
	});
	if (!processed.ok)
		return {
			ok: false,
			message: `${nameForErrors} could not be ${mimeType === "image/bmp" ? "converted" : "made small enough"} to send.`,
		};
	const sent = Math.floor((processed.data.length * 3) / 4);
	const resized = processed.hints.find((hint) => hint.startsWith("[Image: original"));
	const match = resized?.match(/original (\d+)x(\d+)/);
	return {
		ok: true,
		image: { type: "image", data: processed.data, mimeType: processed.mimeType },
		bytes: sent,
		label: formatImageSize(sent),
		note: match ? `resized from ${match[1]}×${match[2]}` : undefined,
	};
}

export function isImagePath(path: string): boolean {
	return (IMAGE_EXTENSIONS as readonly string[]).includes(extname(path).toLowerCase());
}

export interface PathParseOptions {
	cwd: string;
	home?: string;
	/** On WSL, Windows paths (C:\…) are mapped to /mnt/c/…. */
	wsl?: boolean;
	exists?: (path: string) => boolean;
}

/** One pasted token as a local path: strips quotes, `file://`, shell escapes, and expands `~`. */
export function normalizePastedPath(token: string, options: PathParseOptions): string | undefined {
	let value = token.trim();
	if (!value) return undefined;
	if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"')))
		value = value.slice(1, -1);
	if (value.startsWith("file://")) {
		try {
			value = decodeURIComponent(new URL(value).pathname);
			// file:///C:/x on Windows
			if (/^\/[A-Za-z]:\//.test(value) && process.platform === "win32") value = value.slice(1);
		} catch {
			return undefined;
		}
	} else {
		// Shell-escaped drops (macOS Terminal, iTerm2, many Linux terminals): "a\ b.png".
		value = value.replace(/\\([ '"()&;$`!#[\]{}*?<>|\\])/g, "$1");
	}
	if (options.wsl) {
		const drive = value.match(/^([A-Za-z]):[\\/](.*)$/);
		if (drive) value = `/mnt/${drive[1]!.toLowerCase()}/${drive[2]!.replace(/\\/g, "/")}`;
	}
	if (value === "~" || value.startsWith("~/")) value = `${options.home ?? homedir()}${value.slice(1)}`;
	if (!isAbsolute(value) && !/^[A-Za-z]:[\\/]/.test(value)) value = resolve(options.cwd, value);
	return value;
}

/** Split a paste into path-like tokens: one per line, or several on one line separated by unescaped spaces. */
export function splitPastedPaths(text: string): string[] {
	const trimmed = text.trim();
	if (!trimmed) return [];
	const lines = trimmed
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);
	if (lines.length > 1) return lines;
	const line = lines[0] ?? "";
	const tokens: string[] = [];
	let current = "";
	let quote: string | undefined;
	for (let i = 0; i < line.length; i++) {
		const char = line[i]!;
		if (quote) {
			current += char;
			if (char === quote) quote = undefined;
			continue;
		}
		if (char === "\\" && i + 1 < line.length) {
			current += char + line[i + 1];
			i++;
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			current += char;
			continue;
		}
		if (char === " ") {
			if (current) tokens.push(current);
			current = "";
			continue;
		}
		current += char;
	}
	if (current) tokens.push(current);
	return tokens;
}

/**
 * A paste that is only paths to existing files, with at least one image: the image paths, and the other
 * paths (kept as text). Undefined for anything else, which is then pasted as plain text.
 */
export function parsePastedImagePaths(
	text: string,
	options: PathParseOptions,
): { images: string[]; others: string[] } | undefined {
	if (text.length > 8192) return undefined;
	const exists =
		options.exists ??
		((path: string) => {
			try {
				return existsSync(path) && statSync(path).isFile();
			} catch {
				return false;
			}
		});
	const tokens = splitPastedPaths(text);
	if (tokens.length === 0 || tokens.length > 20) return undefined;
	const images: string[] = [];
	const others: string[] = [];
	for (const token of tokens) {
		const path = normalizePastedPath(token, options);
		if (!path || !exists(path)) {
			// The whole paste is not a file list (or a single path with spaces that we split): try it whole.
			if (tokens.length > 1) {
				const whole = normalizePastedPath(text, options);
				if (whole && isImagePath(whole) && exists(whole)) return { images: [whole], others: [] };
			}
			return undefined;
		}
		if (isImagePath(path)) images.push(path);
		else others.push(token);
	}
	return images.length > 0 ? { images, others } : undefined;
}

/** `@path` mentions of image files in a prompt (the form the @ autocomplete inserts). */
export function mentionedImagePaths(text: string, options: PathParseOptions): string[] {
	const paths: string[] = [];
	const pattern = /(^|\s)@("[^"]+"|'[^']+'|(?:\\ |[^\s])+)/g;
	for (const match of text.matchAll(pattern)) {
		const raw = match[2] ?? "";
		const exists =
			options.exists ??
			((candidate: string) => {
				try {
					return statSync(candidate).isFile();
				} catch {
					return false;
				}
			});
		// "see @shot.png," : the punctuation after a mention is not part of the path.
		for (const candidate of [raw, raw.replace(/[,.;:!?)\]]+$/, "")]) {
			const path = normalizePastedPath(candidate, options);
			if (!path || !isImagePath(path) || !exists(path)) continue;
			if (!paths.includes(path)) paths.push(path);
			break;
		}
	}
	return paths;
}

export async function prepareImageFile(path: string): Promise<PrepareResult> {
	let size: number;
	try {
		size = statSync(path).size;
	} catch {
		return { ok: false, message: `Can't read ${path}.` };
	}
	if (size > MAX_IMAGE_FILE_BYTES)
		return {
			ok: false,
			message: `${path} is ${formatImageSize(size)}; the limit is ${formatImageSize(MAX_IMAGE_FILE_BYTES)}.`,
		};
	let bytes: Uint8Array;
	try {
		bytes = new Uint8Array(readFileSync(path));
	} catch {
		return { ok: false, message: `Can't read ${path}.` };
	}
	return prepareImageBytes(bytes, path);
}

export interface PendingImage extends PreparedImage {
	id: number;
}

/** Images waiting for the next submit, by chip id. Ids restart at 1 once everything was sent. */
export class ImageAttachments {
	private readonly items = new Map<number, PendingImage>();
	private nextId = 1;

	add(prepared: PreparedImage): PendingImage {
		const item: PendingImage = { ...prepared, id: this.nextId++ };
		this.items.set(item.id, item);
		return item;
	}

	get size(): number {
		return this.items.size;
	}

	/** The images whose chips are in `text`, in chip order. */
	resolve(text: string): PendingImage[] {
		return imageMarkerIds(text)
			.map((id) => this.items.get(id))
			.filter((item): item is PendingImage => item !== undefined);
	}

	get(id: number): PendingImage | undefined {
		return this.items.get(id);
	}

	/** Remove the images with these ids and return them (prompt stash keeps them aside). */
	take(ids: readonly number[]): PendingImage[] {
		const taken: PendingImage[] = [];
		for (const id of ids) {
			const item = this.items.get(id);
			if (!item) continue;
			this.items.delete(id);
			taken.push(item);
		}
		return taken;
	}

	clear(): void {
		this.items.clear();
		this.nextId = 1;
	}
}

/** Whether a model takes images. The auto model routes image turns to a vision model by itself. */
export function acceptsImages(model: Pick<Model<Api>, "input"> | undefined): boolean {
	return !model || model.input.includes("image");
}

/** The warning for a manual model without image input, naming models that do take images. */
export function nonVisionWarning(
	model: Pick<Model<Api>, "name" | "id" | "input">,
	visionModels: ReadonlyArray<Pick<Model<Api>, "name" | "id">>,
): string {
	const names = visionModels.map((entry) => entry.name || entry.id);
	const options =
		names.length > 0 ? ` Switch with /model (${names.join(", ")}) or use auto.` : " Switch with /model or use auto.";
	return `${model.name || model.id} can't see images; it gets "(image omitted)" instead.${options}`;
}
