import type { AgentTool } from "@runkiln/agent-core";
import { mkdir as fsMkdir, writeFile as fsWriteFile } from "fs/promises";
import { dirname } from "path";
import { type Static, Type } from "typebox";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";
import { recordEditOutcome } from "../verify/edit-metrics.ts";
import type { PostEditHook } from "../verify/post-edit.ts";
import { type PostEditDetails, postEditDetails } from "./edit.ts";
import { withFileMutationQueue } from "./file-mutation-queue.ts";
import { resolveToCwd } from "./path-utils.ts";
import { writeRenderers } from "./renderers/write.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const writeSchema = Type.Object({
	path: Type.String({ description: "File path" }),
	content: Type.String({ description: "File content" }),
});

export const writeToolSystemPromptContribution = {
	snippet: "Create or overwrite files",
	guidelines: ["Use write only for new files or full rewrites"],
} as const;

export type WriteToolInput = Static<typeof writeSchema>;

/**
 * Pluggable operations for the write tool.
 * Override these to delegate file writing to remote systems (for example SSH).
 */
export interface WriteOperations {
	/** Write content to a file */
	writeFile: (absolutePath: string, content: string) => Promise<void>;
	/** Create directory recursively */
	mkdir: (dir: string) => Promise<void>;
}

const defaultWriteOperations: WriteOperations = {
	writeFile: (path, content) => fsWriteFile(path, content, "utf-8"),
	mkdir: (dir) => fsMkdir(dir, { recursive: true }).then(() => {}),
};

export interface WriteToolOptions {
	/** Custom operations for file writing. Default: local filesystem */
	operations?: WriteOperations;
	/** Diagnostics after the write (only new ones are reported). */
	postEdit?: PostEditHook;
	/** The model making the call, for the per-model edit log. */
	currentModel?: () => string | undefined;
}

export interface WriteToolDetails {
	diagnostics?: PostEditDetails;
}

export function createWriteToolDefinition(
	cwd: string,
	options?: WriteToolOptions,
): ToolDefinition<typeof writeSchema, WriteToolDetails | undefined> {
	const ops = options?.operations ?? defaultWriteOperations;
	return {
		name: "write",
		// mutates files: one at a time, in order, never alongside other calls.
		executionMode: "sequential",
		label: "write",
		description: "Create or overwrite a file; parent directories are created.",
		promptSnippet: writeToolSystemPromptContribution.snippet,
		promptGuidelines: [...writeToolSystemPromptContribution.guidelines],
		parameters: writeSchema,
		constrainedSampling: { type: "json_schema", strict: "prefer" },
		async execute(
			_toolCallId,
			{ path, content }: { path: string; content: string },
			signal?: AbortSignal,
			_onUpdate?,
			ctx?: ExtensionContext,
		) {
			const absolutePath = resolveToCwd(path, ctx?.cwd || cwd);
			const dir = dirname(absolutePath);
			return withFileMutationQueue(absolutePath, async () => {
				// Do not reject from an abort event listener here: that would release the
				// mutation queue while an in-flight filesystem operation may still finish.
				// Checking signal.aborted after each await observes the same aborts while
				// keeping the queue locked until the current operation has settled.
				const throwIfAborted = (): void => {
					if (signal?.aborted) throw new Error("Operation aborted");
				};

				throwIfAborted();
				// Create parent directories if needed.
				await ops.mkdir(dir);
				throwIfAborted();

				const baseline = await options?.postEdit?.before(absolutePath, signal).catch(() => undefined);
				throwIfAborted();

				// Write the file contents.
				await ops.writeFile(absolutePath, content);
				throwIfAborted();

				const report = await options?.postEdit?.after(baseline, absolutePath, signal).catch(() => undefined);
				recordEditOutcome({
					tool: "write",
					model: options?.currentModel?.(),
					outcome: "ok",
					...(report?.newErrors ? { newErrors: report.newErrors } : {}),
				});
				const text = [`Successfully wrote to ${path}`, report?.text].filter(Boolean).join("\n");
				return {
					content: [{ type: "text", text }],
					details: report?.text ? { diagnostics: postEditDetails(report) } : undefined,
				};
			});
		},
		...writeRenderers,
	};
}

export function createWriteTool(cwd: string, options?: WriteToolOptions): AgentTool<typeof writeSchema> {
	return wrapToolDefinition(createWriteToolDefinition(cwd, options));
}
