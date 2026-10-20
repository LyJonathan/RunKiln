/**
 * Keeps a request under RunInfra's request size cap (`max_request_bytes`, 3.5 MB on every model): every image in
 * the transcript is re-sent with each request, so after a few screenshots every request would fail with 413
 * payload_too_large, whatever the model. Per request, on a copy (the transcript keeps every image):
 *
 * 1. Images in older turns become a short text stub, oldest first, keeping the newest ones. A stubbed image stays
 *    stubbed in later requests (`RequestFitState.stubbed`), so the prefix changes once and then caches again.
 * 2. Still too big: old tool output is cut to its head and tail, oldest first. The latest message is never cut.
 *
 * After a 413 the session switches to `strict` for the retry: a lower target and only the newest image kept.
 */

import type { ImageContent, Message, TextContent } from "@runkiln/ai";

/** Body target for normal requests: under the 3.5 MB cap with room for the system prompt, tools and headers. */
export const REQUEST_FIT_TARGET_BYTES = 3_200_000;
/** Target after a 413 (the retry must not fail the same way). */
export const REQUEST_FIT_STRICT_BYTES = 1_600_000;
const KEEP_NEWEST_IMAGES = 2;
const KEEP_NEWEST_IMAGES_STRICT = 1;
const TRIM_KEEP_CHARS = 2000;

/** A provider error for a request body over the size cap (RunInfra: 413 payload_too_large). */
export function isPayloadTooLargeError(errorMessage: string | undefined): boolean {
	return !!errorMessage && /\b413\b|payload_too_large|request entity too large/i.test(errorMessage);
}

/** Shown in place of the raw 413 while the request is shrunk and retried on the same model. */
export const PAYLOAD_TOO_LARGE_RETRYING = "Request too large (413): dropping older images and retrying.";
/** Shown when the shrunk retry failed too. */
export const PAYLOAD_TOO_LARGE_FINAL = "Request still too large (413). Run /compact, or /rewind to before the images.";

export interface RequestFitState {
	/** Set after a 413: the next request fits a lower target and keeps one image. */
	strict: boolean;
	/** Images stubbed in an earlier request (stay stubbed so the prompt prefix stays stable). */
	stubbed: Set<string>;
}

export function createRequestFitState(): RequestFitState {
	return { strict: false, stubbed: new Set() };
}

export interface RequestFitResult {
	messages: Message[];
	imagesRemoved: number;
	toolResultsTrimmed: number;
	/** Serialized size of the messages after fitting. */
	bytes: number;
}

/** Width and height from a PNG, JPEG, GIF or WebP header (base64), or undefined. */
export function imageDimensions(data: string): { width: number; height: number } | undefined {
	let bytes: Buffer;
	try {
		// The header is near the start; JPEG SOF can be further in, so decode up to 64 KB.
		bytes = Buffer.from(data.slice(0, 87_384), "base64");
	} catch {
		return undefined;
	}
	if (bytes.length >= 24 && bytes.readUInt32BE(0) === 0x89504e47) {
		return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
	}
	if (bytes.length >= 10 && bytes.toString("ascii", 0, 3) === "GIF") {
		return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
	}
	if (bytes.length >= 30 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") {
		const chunk = bytes.toString("ascii", 12, 16);
		if (chunk === "VP8X") return { width: 1 + bytes.readUIntLE(24, 3), height: 1 + bytes.readUIntLE(27, 3) };
		if (chunk === "VP8 ") return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
		if (chunk === "VP8L") {
			const b = bytes.readUInt32LE(21);
			return { width: 1 + (b & 0x3fff), height: 1 + ((b >> 14) & 0x3fff) };
		}
	}
	if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
		let offset = 2;
		while (offset + 9 < bytes.length) {
			if (bytes[offset] !== 0xff) return undefined;
			const marker = bytes[offset + 1];
			const length = bytes.readUInt16BE(offset + 2);
			// SOF0-SOF15, except DHT (C4), JPG (C8) and DAC (CC).
			if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
				return { width: bytes.readUInt16BE(offset + 7), height: bytes.readUInt16BE(offset + 5) };
			}
			offset += 2 + length;
		}
	}
	return undefined;
}

const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

interface ImageRef {
	message: number;
	part: number;
	key: string;
	label: string;
	bytes: number;
}

/** Where an image came from: the path of the tool call that produced it, else what kind of message holds it. */
function imageSources(messages: readonly Message[]): Map<string, string> {
	const paths = new Map<string, string>();
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		for (const part of message.content) {
			if (part.type !== "toolCall") continue;
			const args = part.arguments as Record<string, unknown> | undefined;
			const path = args?.path ?? args?.file_path ?? args?.filePath;
			paths.set(part.id, typeof path === "string" ? path : part.name);
		}
	}
	return paths;
}

function stubFor(image: ImageContent, label: string): TextContent {
	const dims = imageDimensions(image.data);
	return {
		type: "text",
		text: `[image removed to fit request size: ${label}${dims ? `, ${dims.width}x${dims.height}` : ""}]`,
	};
}

function trimmedText(text: string): string {
	if (text.length <= TRIM_KEEP_CHARS) return text;
	const head = text.slice(0, Math.floor(TRIM_KEEP_CHARS * 0.6));
	const tail = text.slice(text.length - Math.floor(TRIM_KEEP_CHARS * 0.4));
	return `${head}\n[... ${text.length - head.length - tail.length} chars trimmed to fit the request size ...]\n${tail}`;
}

/**
 * The messages to send, fitted under `targetBytes` (default: REQUEST_FIT_TARGET_BYTES, or the strict target after a
 * 413). Messages that need no change are returned as is; changed ones are copies.
 */
export function fitRequestSize(
	messages: Message[],
	state: RequestFitState = createRequestFitState(),
	targetBytes = state.strict ? REQUEST_FIT_STRICT_BYTES : REQUEST_FIT_TARGET_BYTES,
): RequestFitResult {
	const out = [...messages];
	let bytes = size(out);
	const sticky = state.stubbed.size > 0;
	if (bytes <= targetBytes && !sticky) return { messages: out, imagesRemoved: 0, toolResultsTrimmed: 0, bytes };

	const sources = imageSources(messages);
	const images: ImageRef[] = [];
	messages.forEach((message, index) => {
		if ((message.role !== "user" && message.role !== "toolResult") || typeof message.content === "string") return;
		const owner = message.role === "toolResult" ? `tool:${message.toolCallId}` : `user:${message.timestamp}:${index}`;
		const label =
			message.role === "toolResult"
				? (sources.get(message.toolCallId) ?? message.toolName)
				: "image attached by the user";
		message.content.forEach((part, partIndex) => {
			if (part.type === "image") {
				images.push({ message: index, part: partIndex, key: `${owner}:${partIndex}`, label, bytes: size(part) });
			}
		});
	});

	const copied = new Set<number>();
	const editable = (index: number) => {
		if (!copied.has(index)) {
			const message = out[index] as Message & { content: (TextContent | ImageContent)[] };
			out[index] = { ...message, content: [...message.content] } as Message;
			copied.add(index);
		}
		return out[index] as Message & { content: (TextContent | ImageContent)[] };
	};
	let imagesRemoved = 0;
	const stub = (ref: ImageRef) => {
		const message = editable(ref.message);
		const image = message.content[ref.part] as ImageContent;
		const replacement = stubFor(image, ref.label);
		message.content[ref.part] = replacement;
		bytes -= ref.bytes - size(replacement);
		state.stubbed.add(ref.key);
		imagesRemoved++;
	};

	// Images stubbed before stay stubbed.
	for (const ref of images) if (state.stubbed.has(ref.key)) stub(ref);
	const keep = state.strict ? KEEP_NEWEST_IMAGES_STRICT : KEEP_NEWEST_IMAGES;
	const removable = images.filter((ref) => !state.stubbed.has(ref.key)).slice(0, Math.max(0, images.length - keep));
	for (const ref of removable) {
		if (bytes <= targetBytes) break;
		if (!state.stubbed.has(ref.key)) stub(ref);
	}

	let toolResultsTrimmed = 0;
	const last = out.length - 1;
	for (let index = 0; index < last && bytes > targetBytes; index++) {
		const message = out[index];
		if (message.role !== "toolResult") continue;
		const long = message.content.some((part) => part.type === "text" && part.text.length > TRIM_KEEP_CHARS);
		if (!long) continue;
		const before = size(message);
		const copy = editable(index);
		copy.content = copy.content.map((part) =>
			part.type === "text" ? { ...part, text: trimmedText(part.text) } : part,
		);
		bytes -= before - size(copy);
		toolResultsTrimmed++;
	}

	// Last resort: the images that were kept, oldest first (never the latest message's own).
	if (bytes > targetBytes) {
		for (const ref of images) {
			if (bytes <= targetBytes) break;
			if (state.stubbed.has(ref.key) || ref.message === last) continue;
			stub(ref);
		}
	}
	return { messages: out, imagesRemoved, toolResultsTrimmed, bytes };
}

/**
 * Every image replaced by its stub, for a summary request (/compact): the summary needs the text, and a session that
 * is failing with 413 must still be able to compact. The prefix up to the first image stays byte for byte.
 */
export function stripImages<T extends { role: string; content?: unknown }>(messages: readonly T[]): T[] {
	const sources = imageSources(messages as unknown as Message[]);
	return messages.map((message) => {
		if ((message.role !== "user" && message.role !== "toolResult") || !Array.isArray(message.content)) return message;
		const parts = message.content as (TextContent | ImageContent)[];
		if (!parts.some((part) => part.type === "image")) return message;
		const label =
			message.role === "toolResult"
				? (sources.get((message as unknown as { toolCallId: string }).toolCallId) ??
					(message as unknown as { toolName: string }).toolName)
				: "image attached by the user";
		return { ...message, content: parts.map((part) => (part.type === "image" ? stubFor(part, label) : part)) };
	});
}
