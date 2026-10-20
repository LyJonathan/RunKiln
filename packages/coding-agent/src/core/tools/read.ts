import { createHash } from "node:crypto";
import type { AgentTool } from "@runkiln/agent-core";
import type { Api, ImageContent, Model, ModelImageResizeOptions, TextContent } from "@runkiln/ai";
import { constants } from "fs";
import { access as fsAccess, readFile as fsReadFile } from "fs/promises";
import { type Static, Type } from "typebox";
import { getAgentDir } from "../../config.ts";
import { processImage } from "../../utils/image-process.ts";
import type { ImageResizeOptions } from "../../utils/image-resize.ts";
import { detectSupportedImageMimeTypeFromFile } from "../../utils/mime.ts";
import { isOutsideProject, markUntrusted, stripTagCharacters } from "../../utils/untrusted.ts";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";
import { resolveReadPathAsync } from "./path-utils.ts";
import { readRenderers } from "./renderers/read.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, type TruncationResult, truncateHead } from "./truncate.ts";

const readSchema = Type.Object({
	path: Type.String({ description: "File path" }),
	offset: Type.Optional(Type.Number({ description: "Start line (1-based)" })),
	limit: Type.Optional(Type.Number({ description: "Max lines" })),
});

export const readToolSystemPromptContribution = {
	snippet: "Read files",
	guidelines: ["Use read, not cat or sed, to view files."],
} as const;

export type ReadToolInput = Static<typeof readSchema>;

/**
 * Result for programmatic callers such as codemode scripts: the text for text files, and an image
 * block for images that codemode's `image()` accepts. `note` is the text that goes with the image,
 * such as resize hints. Property descriptions are left out so the type stays on one line in tool
 * descriptions.
 */
const readOutputSchema = Type.Union([
	Type.String(),
	Type.Object({ type: Type.Literal("image"), data: Type.String(), mimeType: Type.String(), note: Type.String() }),
]);

export type ReadToolOutput = Static<typeof readOutputSchema>;

export interface ReadToolDetails {
	truncation?: TruncationResult;
	/** What this read returned: the file, the requested range and a hash of the file's bytes. */
	readKey?: ReadKey;
	/** True when the result is a short stub because an identical earlier read is still in context. */
	unchangedSinceEarlierRead?: boolean;
}

/** Identifies one text read: same key means the model already holds exactly this output. */
export interface ReadKey {
	path: string;
	offset: number | null;
	limit: number | null;
	/** First 16 hex digits of the SHA-256 of the whole file. */
	sha256: string;
}

function sameReadKey(a: ReadKey, b: ReadKey): boolean {
	return a.path === b.path && a.offset === b.offset && a.limit === b.limit && a.sha256 === b.sha256;
}

/**
 * Whether a full result of the same read (same file bytes, same offset and limit) is still part of
 * the model's context. Compacted or edited-away results do not count, so the model gets the file again.
 */
export function hasEarlierIdenticalRead(ctx: ExtensionContext | undefined, key: ReadKey): boolean {
	const sessionManager = ctx?.sessionManager;
	if (!sessionManager || typeof sessionManager.buildSessionProjection !== "function") return false;
	let messages: readonly { role: string }[];
	try {
		messages = sessionManager.buildSessionProjection().messages;
	} catch {
		return false;
	}
	for (const message of messages) {
		if (message.role !== "toolResult") continue;
		const result = message as { toolName?: string; details?: ReadToolDetails; content?: unknown };
		if (result.toolName !== "read") continue;
		const details = result.details;
		if (!details?.readKey || details.unchangedSinceEarlierRead) continue;
		if (!Array.isArray(result.content) || result.content.length === 0) continue;
		if (sameReadKey(details.readKey, key)) return true;
	}
	return false;
}

/**
 * Pluggable operations for the read tool.
 * Override these to delegate file reading to remote systems (for example SSH).
 */
export interface ReadOperations {
	/** Read file contents as a Buffer */
	readFile: (absolutePath: string) => Promise<Buffer>;
	/** Check if file is readable (throw if not) */
	access: (absolutePath: string) => Promise<void>;
	/** Detect image MIME type, return null or undefined for non-images */
	detectImageMimeType?: (absolutePath: string) => Promise<string | null | undefined>;
}

const defaultReadOperations: ReadOperations = {
	readFile: (path) => fsReadFile(path),
	access: (path) => fsAccess(path, constants.R_OK),
	detectImageMimeType: detectSupportedImageMimeTypeFromFile,
};

export interface ReadToolOptions {
	/** Whether to auto-resize images. Default: true */
	autoResizeImages?: boolean;
	/** Fallback resize profile when the execution context has no model metadata. */
	resizeOptions?: ModelImageResizeOptions;
	/** Custom operations for file reading. Default: local filesystem */
	operations?: ReadOperations;
}

/** The image block and its note, or the text for text files and images that could not be processed. */
function toReadOutput(content: (TextContent | ImageContent)[]): ReadToolOutput {
	const text = content.find((block) => block.type === "text")?.text ?? "";
	const image = content.find((block) => block.type === "image");
	return image ? { type: "image", data: image.data, mimeType: image.mimeType, note: text } : text;
}

/**
 * Images the read tool attaches: at most 1568 px on the long side and about 500 KB, PNG screenshots re-encoded
 * (JPEG at quality 80 when smaller). Every image is re-sent with each later request and RunInfra caps a request
 * at 3.5 MB, so a few full-size screenshots would otherwise make every request fail with 413.
 */
export const READ_IMAGE_RESIZE: ImageResizeOptions = {
	maxWidth: 1568,
	maxHeight: 1568,
	maxBytes: 500 * 1024,
	jpegQuality: 80,
	reencodeAboveBytes: 256 * 1024,
};

/** The read tool's profile, tightened by a stricter model or caller profile (each limit the smaller one). */
export function readImageResizeOptions(profile: ModelImageResizeOptions | undefined): ImageResizeOptions {
	const min = (a: number | undefined, b: number | undefined) =>
		a === undefined ? b : b === undefined ? a : Math.min(a, b);
	return {
		...READ_IMAGE_RESIZE,
		maxWidth: min(READ_IMAGE_RESIZE.maxWidth, profile?.maxWidth),
		maxHeight: min(READ_IMAGE_RESIZE.maxHeight, profile?.maxHeight),
		maxBytes: min(READ_IMAGE_RESIZE.maxBytes, profile?.maxBytes),
		jpegQuality: profile?.jpegQuality ?? READ_IMAGE_RESIZE.jpegQuality,
	};
}

function getNonVisionImageNote(model: Model<Api> | undefined): string | undefined {
	if (!model || model.input.includes("image")) {
		return undefined;
	}
	return "[Current model does not support images. The image will be omitted from this request.]";
}

export function createReadToolDefinition(
	cwd: string,
	options?: ReadToolOptions,
): ToolDefinition<typeof readSchema, ReadToolDetails | undefined> {
	const autoResizeImages = options?.autoResizeImages ?? true;
	const fallbackResizeOptions = options?.resizeOptions;
	const ops = options?.operations ?? defaultReadOperations;
	return {
		name: "read",
		// read-only: runs concurrently with the other read-only calls of the same message.
		executionMode: "parallel",
		label: "read",
		description: `Read a text file or an image (jpg, png, gif, webp, bmp). Text stops at ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB; continue with offset/limit.`,
		promptSnippet: readToolSystemPromptContribution.snippet,
		promptGuidelines: [...readToolSystemPromptContribution.guidelines],
		parameters: readSchema,
		outputSchema: readOutputSchema,
		constrainedSampling: { type: "json_schema", strict: "prefer" },
		async execute(
			_toolCallId,
			{ path, offset, limit }: { path: string; offset?: number; limit?: number },
			signal?: AbortSignal,
			_onUpdate?,
			ctx?: ExtensionContext,
		) {
			return new Promise<{ content: (TextContent | ImageContent)[]; details: ReadToolDetails | undefined }>(
				(resolve, reject) => {
					if (signal?.aborted) {
						reject(new Error("Operation aborted"));
						return;
					}
					let aborted = false;
					const onAbort = () => {
						aborted = true;
						reject(new Error("Operation aborted"));
					};
					signal?.addEventListener("abort", onAbort, { once: true });

					(async () => {
						try {
							const absolutePath = await resolveReadPathAsync(path, ctx?.cwd || cwd);
							if (aborted) return;
							// Check if file exists and is readable.
							await ops.access(absolutePath);
							if (aborted) return;
							const mimeType = ops.detectImageMimeType ? await ops.detectImageMimeType(absolutePath) : undefined;
							let content: (TextContent | ImageContent)[];
							let details: ReadToolDetails | undefined;
							const nonVisionImageNote = getNonVisionImageNote(ctx?.model);
							if (mimeType) {
								// Read image as binary.
								const buffer = await ops.readFile(absolutePath);
								const processed = await processImage(buffer, mimeType, {
									autoResizeImages,
									resizeOptions: readImageResizeOptions(
										ctx?.model?.inputLimits?.images?.resize ?? fallbackResizeOptions,
									),
								});
								if (!processed.ok) {
									let textNote = `Read image file [${mimeType}]\n${processed.message}`;
									if (nonVisionImageNote) textNote += `\n${nonVisionImageNote}`;
									content = [{ type: "text", text: textNote }];
								} else {
									let textNote = `Read image file [${processed.mimeType}]`;
									if (processed.hints.length > 0) textNote += `\n${processed.hints.join("\n")}`;
									if (nonVisionImageNote) textNote += `\n${nonVisionImageNote}`;
									content = [
										{ type: "text", text: textNote },
										{ type: "image", data: processed.data, mimeType: processed.mimeType },
									];
								}
							} else {
								// Read text content.
								const buffer = await ops.readFile(absolutePath);
								const readKey: ReadKey = {
									path: absolutePath,
									offset: offset ?? null,
									limit: limit ?? null,
									sha256: createHash("sha256").update(buffer).digest("hex").slice(0, 16),
								};
								if (hasEarlierIdenticalRead(ctx, readKey)) {
									// The model already holds this exact output; re-sending it only costs tokens.
									if (aborted) return;
									signal?.removeEventListener("abort", onAbort);
									resolve({
										content: [
											{
												type: "text",
												text: `[${path} is unchanged since an earlier read in this conversation (same content, same offset/limit). Use that earlier result.]`,
											},
										],
										details: { readKey, unchangedSinceEarlierRead: true },
									});
									return;
								}
								// Tag characters are invisible to people but readable by models: never passed on.
								const textContent = stripTagCharacters(buffer.toString("utf-8"));
								const allLines = textContent.split("\n");
								const totalFileLines = allLines.length;
								// Apply offset if specified. Convert from 1-indexed input to 0-indexed array access.
								const startLine = offset ? Math.max(0, offset - 1) : 0;
								const startLineDisplay = startLine + 1;
								// Check if offset is out of bounds.
								if (startLine >= allLines.length) {
									throw new Error(`Offset ${offset} is beyond end of file (${allLines.length} lines total)`);
								}
								let selectedContent: string;
								let userLimitedLines: number | undefined;
								// If limit is specified by the user, honor it first. Otherwise truncateHead decides.
								if (limit !== undefined) {
									const endLine = Math.min(startLine + limit, allLines.length);
									selectedContent = allLines.slice(startLine, endLine).join("\n");
									userLimitedLines = endLine - startLine;
								} else {
									selectedContent = allLines.slice(startLine).join("\n");
								}
								// Apply truncation, respecting both line and byte limits.
								const truncation = truncateHead(selectedContent);
								let outputText: string;
								if (truncation.firstLineExceedsLimit) {
									// First line alone exceeds the byte limit. Point the model at a bash fallback.
									const firstLineSize = formatSize(Buffer.byteLength(allLines[startLine], "utf-8"));
									outputText = `[Line ${startLineDisplay} is ${firstLineSize}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Use bash: sed -n '${startLineDisplay}p' ${path} | head -c ${DEFAULT_MAX_BYTES}]`;
									details = { truncation };
								} else if (truncation.truncated) {
									// Truncation occurred. Build an actionable continuation notice.
									const endLineDisplay = startLineDisplay + truncation.outputLines - 1;
									const nextOffset = endLineDisplay + 1;
									outputText = truncation.content;
									if (truncation.truncatedBy === "lines") {
										outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines}. Use offset=${nextOffset} to continue.]`;
									} else {
										outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Use offset=${nextOffset} to continue.]`;
									}
									details = { truncation };
								} else if (userLimitedLines !== undefined && startLine + userLimitedLines < allLines.length) {
									// User-specified limit stopped early, but the file still has more content.
									const remaining = allLines.length - (startLine + userLimitedLines);
									const nextOffset = startLine + userLimitedLines + 1;
									outputText = `${truncation.content}\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue.]`;
								} else {
									// No truncation and no remaining user-limited content.
									outputText = truncation.content;
								}
								// A file from outside the project (not RunKiln's own folder) is marked as untrusted data.
								const root = ctx?.cwd || cwd;
								if (isOutsideProject(absolutePath, root) && isOutsideProject(absolutePath, getAgentDir())) {
									outputText = markUntrusted(outputText, `file outside the project: ${path}`);
								}
								content = [{ type: "text", text: outputText }];
								details = { ...details, readKey };
							}

							if (aborted) return;
							signal?.removeEventListener("abort", onAbort);
							resolve({ content, details });
						} catch (error: any) {
							signal?.removeEventListener("abort", onAbort);
							if (!aborted) reject(error);
						}
					})();
				},
			).then((result) => ({ ...result, structuredContent: toReadOutput(result.content) }));
		},
		...readRenderers,
	};
}

export function createReadTool(cwd: string, options?: ReadToolOptions): AgentTool<typeof readSchema> {
	return wrapToolDefinition(createReadToolDefinition(cwd, options));
}
