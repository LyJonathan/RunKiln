/**
 * `repo_map` tool: the ranked, token-budgeted map of the repository's files and key symbols. Read-only; runs in
 * parallel with other read-only calls. Centered on the files and identifiers the conversation mentions, plus the
 * optional `paths` and `query`.
 */

import { join } from "node:path";
import type { AgentTool } from "@runkiln/agent-core";
import { type Static, Type } from "typebox";
import { getAgentDir } from "../../config.ts";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";
import { wrapToolDefinition } from "../tools/tool-definition-wrapper.ts";
import { conversationText, DEFAULT_MAP_TOKENS, getRepoMap, MAX_MAP_TOKENS, type RepoMapResult } from "./repo-map.ts";

export const REPO_MAP_TOOL_NAME = "repo_map";

const repoMapSchema = Type.Object({
	paths: Type.Optional(
		Type.Array(Type.String(), { description: "Files or directories to center the map on (optional)" }),
	),
	query: Type.Optional(
		Type.String({ description: "Identifiers or words to look for, e.g. 'parseConfig retry' (optional)" }),
	),
	tokens: Type.Optional(
		Type.Number({ description: `Token budget for the map (default ${DEFAULT_MAP_TOKENS}, max ${MAX_MAP_TOKENS})` }),
	),
});

export type RepoMapToolInput = Static<typeof repoMapSchema>;

export interface RepoMapToolDetails {
	files: number;
	symbols: number;
	totalFiles: number;
	tokens: number;
	parser: RepoMapResult["parser"];
	reparsed: number;
	buildMs: number;
}

export function repoMapCacheDir(): string {
	return join(getAgentDir(), "cache", "repo-map");
}

/** The header line above a map. */
export function repoMapHeader(result: RepoMapResult): string {
	const files = result.focusFiles;
	let fileFocus: string[] = files.slice(0, 2);
	if (files.length > 2) {
		// Many files: name the folder they share.
		const parts = files[0]!.split("/");
		let common = parts.length - 1;
		for (const file of files) {
			const other = file.split("/");
			let i = 0;
			while (i < common && other[i] === parts[i]) i++;
			common = i;
		}
		fileFocus = [
			common > 0 ? `${files.length} files in ${parts.slice(0, common).join("/")}/` : `${files.length} files`,
		];
	}
	const idents = result.focusIdents.slice(0, 4);
	const named = [...fileFocus, ...idents];
	const focus =
		named.length > 0
			? `, centered on ${named.join(", ")}${result.focusIdents.length > idents.length ? ", …" : ""}`
			: "";
	return `Repo map: ${result.files} of ${result.totalFiles} files, ${result.symbols} symbols, ~${result.tokens} tokens${focus}`;
}

export function createRepoMapToolDefinition(
	cwd: string,
	options: { cacheDir?: string } = {},
): ToolDefinition<typeof repoMapSchema, RepoMapToolDetails | undefined> {
	return {
		name: REPO_MAP_TOOL_NAME,
		executionMode: "parallel",
		label: "repo map",
		description:
			"Map of the repository: source files with the signatures of their key functions, classes, types and exports, ranked by how much the rest of the code uses them and by relevance to the conversation. Pass `paths` or `query` to center it. Use it to find where things are before reading files, instead of listing directories or grepping.",
		promptSnippet: "Ranked map of the repo's files and key symbols",
		parameters: repoMapSchema,
		async execute(_toolCallId, params: RepoMapToolInput, signal?: AbortSignal, _onUpdate?, ctx?: ExtensionContext) {
			if (signal?.aborted) throw new Error("Operation aborted");
			const root = ctx?.cwd ?? cwd;
			const map = getRepoMap(root, options.cacheDir ?? repoMapCacheDir());
			const entries = ctx?.sessionManager?.getBranch?.() ?? [];
			const result = await map.render({
				focusPaths: params.paths,
				query: params.query,
				conversation: conversationText(entries as never),
				tokens: params.tokens,
			});
			const text =
				result.text.length > 0
					? `${repoMapHeader(result)}\n\n${result.text}`
					: "No source files found in this directory (the repo map covers TS/JS, Python, Go, Rust, Java, Ruby, C#, C/C++, PHP and a few more).";
			return {
				content: [{ type: "text", text }],
				details: {
					files: result.files,
					symbols: result.symbols,
					totalFiles: result.totalFiles,
					tokens: result.tokens,
					parser: result.parser,
					reparsed: result.reparsed,
					buildMs: result.buildMs,
				},
			};
		},
	};
}

export function createRepoMapTool(cwd: string, options?: { cacheDir?: string }): AgentTool<typeof repoMapSchema> {
	return wrapToolDefinition(createRepoMapToolDefinition(cwd, options));
}
