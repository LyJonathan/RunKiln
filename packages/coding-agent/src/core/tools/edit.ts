import type { AgentTool } from "@runkiln/agent-core";
import { constants } from "fs";
import { access as fsAccess, readFile as fsReadFile, writeFile as fsWriteFile } from "fs/promises";
import { type Static, Type } from "typebox";
import { splitBom } from "../../utils/text.ts";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";
import { recordEditOutcome } from "../verify/edit-metrics.ts";
import { canAutoRepair, type EditRepairCall, repairEdit } from "../verify/edit-repair.ts";
import { formatDiagnostic, type PostEditHook } from "../verify/post-edit.ts";
import {
	applyEditsToNormalizedContent,
	detectLineEnding,
	type Edit,
	EditNotFoundError,
	generateDiffString,
	generateUnifiedPatch,
	normalizeToLF,
	restoreLineEndings,
} from "./edit-diff.ts";
import { withFileMutationQueue } from "./file-mutation-queue.ts";
import { resolveToCwd } from "./path-utils.ts";
import { type EditRenderState, editRenderers } from "./renderers/edit.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const replaceEditSchema = Type.Object(
	{
		oldText: Type.String({
			description: "Exact text to replace, unique in the original file",
		}),
		newText: Type.String({ description: "Replacement" }),
	},
	{},
);

const editSchema = Type.Object(
	{
		path: Type.String({ description: "File path" }),
		edits: Type.Array(replaceEditSchema, {
			description: "Replacements, each matched against the original file",
		}),
	},
	{},
);

export const editToolSystemPromptContribution = {
	snippet: "Exact-text file edits",
	guidelines: ["Use edit for precise changes; several spots in one file go in one call with several edits[]"],
} as const;

export type EditToolInput = Static<typeof editSchema>;
type LegacyEditToolInput = EditToolInput & {
	oldText?: unknown;
	newText?: unknown;
};

type SingleEditInput = { oldText: string; newText: string };

function isSingleEditInput(value: unknown): value is SingleEditInput {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return false;
	}

	const edit = value as Record<string, unknown>;
	return typeof edit.oldText === "string" && typeof edit.newText === "string";
}

export interface EditToolDetails {
	/** Display-oriented diff of the changes made */
	diff: string;
	/** Standard unified patch of the changes made */
	patch: string;
	/** Line number of the first change in the new file (for editor navigation) */
	firstChangedLine?: number;
	/** New diagnostics the post-edit checks found. */
	diagnostics?: PostEditDetails;
	/** Edits whose oldText the chore model repaired. */
	repaired?: Array<{ editIndex: number; startLine: number; endLine: number; similarity: number }>;
}

/** What the post-edit checks found, for the renderer. */
export interface PostEditDetails {
	checkers: string[];
	newErrors: number;
	newWarnings: number;
	/** One formatted line per diagnostic (capped). */
	lines: string[];
}

export function postEditDetails(report: {
	checkers: string[];
	newErrors: number;
	newWarnings: number;
	diagnostics: Parameters<typeof formatDiagnostic>[0][];
}): PostEditDetails {
	return {
		checkers: report.checkers,
		newErrors: report.newErrors,
		newWarnings: report.newWarnings,
		lines: report.diagnostics.slice(0, 20).map(formatDiagnostic),
	};
}

/**
 * Pluggable operations for the edit tool.
 * Override these to delegate file editing to remote systems (for example SSH).
 */
export interface EditOperations {
	/** Read file contents as a Buffer */
	readFile: (absolutePath: string) => Promise<Buffer>;
	/** Write content to a file */
	writeFile: (absolutePath: string, content: string) => Promise<void>;
	/** Check if file is readable and writable (throw if not) */
	access: (absolutePath: string) => Promise<void>;
}

const defaultEditOperations: EditOperations = {
	readFile: (path) => fsReadFile(path),
	writeFile: (path, content) => fsWriteFile(path, content, "utf-8"),
	access: (path) => fsAccess(path, constants.R_OK | constants.W_OK),
};

export interface EditToolOptions {
	/** Custom operations for file editing. Default: local filesystem */
	operations?: EditOperations;
	/** Diagnostics after the edit (only new ones are reported). */
	postEdit?: PostEditHook;
	/** Chore-model call used to repair a missed oldText. */
	repair?: EditRepairCall;
	/** Whether to try the repair (setting edit.autoRepair). */
	autoRepair?: () => boolean;
	/** The model making the call, for the per-model edit-miss log. */
	currentModel?: () => string | undefined;
}

function prepareEditArguments(input: unknown): EditToolInput {
	if (!input || typeof input !== "object") {
		return input as EditToolInput;
	}

	const args = input as Record<string, unknown>;

	// Some models (Opus 4.6, GLM-5.1) send edits as a JSON string instead of an array.
	// Others send a single edit object instead of a one-element edits array.
	if (typeof args.edits === "string") {
		try {
			const parsed = JSON.parse(args.edits);
			if (Array.isArray(parsed)) {
				args.edits = parsed;
			} else if (isSingleEditInput(parsed)) {
				args.edits = [parsed];
			}
		} catch {}
	} else if (isSingleEditInput(args.edits)) {
		args.edits = [args.edits];
	}

	const legacy = args as LegacyEditToolInput;
	if (typeof legacy.oldText !== "string" || typeof legacy.newText !== "string") {
		return args as EditToolInput;
	}

	const edits = Array.isArray(legacy.edits) ? [...legacy.edits] : [];
	edits.push({ oldText: legacy.oldText, newText: legacy.newText });
	const { oldText: _oldText, newText: _newText, ...rest } = legacy;
	return { ...rest, edits } as EditToolInput;
}

function validateEditInput(input: EditToolInput): { path: string; edits: Edit[] } {
	if (!Array.isArray(input.edits) || input.edits.length === 0) {
		throw new Error("Edit tool input is invalid. edits must contain at least one replacement.");
	}
	return { path: input.path, edits: input.edits };
}

export function createEditToolDefinition(
	cwd: string,
	options?: EditToolOptions,
): ToolDefinition<typeof editSchema, EditToolDetails | undefined, EditRenderState> {
	const ops = options?.operations ?? defaultEditOperations;
	return {
		name: "edit",
		// mutates files: one at a time, in order, never alongside other calls.
		executionMode: "sequential",
		label: "edit",
		description:
			"Replace exact text in one file. Each edits[].oldText must match a unique region of the original file (not the result of earlier edits) and must not overlap another; merge nearby changes into one edit. Keep oldText short but unique.",
		promptSnippet: editToolSystemPromptContribution.snippet,
		promptGuidelines: [...editToolSystemPromptContribution.guidelines],
		parameters: editSchema,
		constrainedSampling: { type: "json_schema", strict: "prefer" },
		renderShell: "self",
		prepareArguments: prepareEditArguments,
		async execute(_toolCallId, input: EditToolInput, signal?: AbortSignal, _onUpdate?, ctx?: ExtensionContext) {
			const { path, edits } = validateEditInput(input);
			const absolutePath = resolveToCwd(path, ctx?.cwd || cwd);

			return withFileMutationQueue(absolutePath, async () => {
				// Do not reject from an abort event listener here: that would release the
				// mutation queue while an in-flight filesystem operation may still finish.
				// Checking signal.aborted after each await observes the same aborts while
				// keeping the queue locked until the current operation has settled.
				const throwIfAborted = (): void => {
					if (signal?.aborted) throw new Error("Operation aborted");
				};

				throwIfAborted();

				// Check if file exists.
				try {
					await ops.access(absolutePath);
				} catch (error: unknown) {
					throwIfAborted();
					const errorMessage =
						error instanceof Error && "code" in error ? `Error code: ${error.code}` : String(error);
					throw new Error(`Could not edit file: ${path}. ${errorMessage}.`);
				}
				throwIfAborted();

				// Read the file.
				const buffer = await ops.readFile(absolutePath);
				const rawContent = buffer.toString("utf-8");
				throwIfAborted();

				// Strip BOM before matching. The model will not include an invisible BOM in oldText.
				const { bom, text: content } = splitBom(rawContent);
				const originalEnding = detectLineEnding(content);
				const normalizedContent = normalizeToLF(content);
				const model = options?.currentModel?.();
				const repaired: NonNullable<EditToolDetails["repaired"]> = [];
				let applied: ReturnType<typeof applyEditsToNormalizedContent> | undefined;
				let current = edits;
				// A missed oldText may be repaired once per edit (setting edit.autoRepair, off by default).
				for (let attempt = 0; !applied; attempt++) {
					try {
						applied = applyEditsToNormalizedContent(normalizedContent, current, path);
					} catch (error) {
						const canRepair =
							error instanceof EditNotFoundError &&
							attempt < current.length &&
							options?.repair &&
							options.autoRepair?.() === true &&
							canAutoRepair(error.closest) &&
							!repaired.some((entry) => entry.editIndex === error.editIndex);
						if (!canRepair) {
							if (error instanceof EditNotFoundError) {
								recordEditOutcome({
									tool: "edit",
									model,
									outcome: "miss",
									similarity: error.closest?.similarity,
								});
							}
							throw error;
						}
						const miss = error as EditNotFoundError;
						const closest = miss.closest!;
						const target = current[miss.editIndex];
						const fix = await repairEdit(
							{
								path,
								content: normalizedContent,
								oldText: normalizeToLF(target.oldText),
								newText: normalizeToLF(target.newText),
								closest,
								signal,
							},
							options!.repair!,
						);
						throwIfAborted();
						if (!fix) {
							recordEditOutcome({ tool: "edit", model, outcome: "miss", similarity: closest.similarity });
							throw new Error(
								`${miss.message}\n(Automatic repair was tried and did not produce a unique match.)`,
							);
						}
						current = current.map((edit, index) => (index === miss.editIndex ? fix : edit));
						repaired.push({
							editIndex: miss.editIndex,
							startLine: closest.startLine,
							endLine: closest.endLine,
							similarity: closest.similarity,
						});
					}
				}
				const { baseContent, newContent } = applied;
				throwIfAborted();

				// Baseline diagnostics on the old content, then write, then check the new content.
				const baseline = await options?.postEdit?.before(absolutePath, signal).catch(() => undefined);
				throwIfAborted();

				const finalContent = bom + restoreLineEndings(newContent, originalEnding);
				await ops.writeFile(absolutePath, finalContent);
				throwIfAborted();

				const report = await options?.postEdit?.after(baseline, absolutePath, signal).catch(() => undefined);
				recordEditOutcome({
					tool: "edit",
					model,
					outcome: repaired.length > 0 ? "repaired" : "ok",
					...(report?.newErrors ? { newErrors: report.newErrors } : {}),
				});

				const diffResult = generateDiffString(baseContent, newContent);
				const patch = generateUnifiedPatch(path, baseContent, newContent);
				const notes = repaired.map(
					(entry) =>
						`Auto-repaired edits[${entry.editIndex}].oldText to the file's text at lines ${entry.startLine}-${entry.endLine} (${Math.floor(entry.similarity * 100)}% similar); check the diff.`,
				);
				const text = [`Successfully replaced ${edits.length} block(s) in ${path}.`, ...notes, report?.text]
					.filter(Boolean)
					.join("\n");
				return {
					content: [{ type: "text", text }],
					details: {
						diff: diffResult.diff,
						patch,
						firstChangedLine: diffResult.firstChangedLine,
						...(report?.text ? { diagnostics: postEditDetails(report) } : {}),
						...(repaired.length > 0 ? { repaired } : {}),
					},
				};
			});
		},
		...editRenderers,
	};
}

export function createEditTool(cwd: string, options?: EditToolOptions): AgentTool<typeof editSchema> {
	return wrapToolDefinition(createEditToolDefinition(cwd, options));
}
