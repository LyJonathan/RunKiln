/**
 * How MCP tools reach the model without growing the prompt.
 *
 * Every tool of a connected server is registered as `mcp__<server>__<tool>` with `deferred` exposure: callable, but
 * not declared to the model, so the cached prompt prefix does not change when servers connect, reconnect or change
 * their tool lists. The model reaches them through one built-in tool, `mcp`:
 *
 * - `{"action":"search","query":"create issue"}` lists matching tools with their input schemas;
 * - `{"action":"call","tool":"mcp__github__create_issue","arguments":{...}}` runs one.
 *
 * A call goes through `ctx.executeTool`, so it passes the permission gate under its own name (rules such as
 * `mcp__github__*` apply, plan mode blocks it) and fires PreToolUse/PostToolUse hooks like any tool call.
 * Servers listed in `mcp.pinned` (or with `alwaysLoad: true`) get their tools declared directly instead.
 */

import type { ImageContent, TextContent } from "@runkiln/ai";
import { Type } from "typebox";
import { markUntrusted, stripTagCharacters } from "../../utils/untrusted.ts";
import type {
	Extension,
	ExtensionContext,
	SessionShutdownEvent,
	SessionStartEvent,
	ToolDefinition,
} from "../extensions/types.ts";
import { sanitizeForPrompt } from "../runkiln/approval.ts";
import { mcpTrustLines } from "../runkiln/trust-display.ts";
import { createSyntheticSourceInfo } from "../source-info.ts";
import type { McpCallResult, McpContentBlock } from "./client.ts";
import type { McpManager, McpToolEntry } from "./manager.ts";

export const MCP_TOOL_NAME = "mcp";
export const MCP_EXTENSION_PATH = "builtin:mcp";
/** Most tools one search returns. */
const SEARCH_LIMIT = 8;
/** Longest description shown per tool in search results. */
const DESCRIPTION_LIMIT = 600;
/** Longest text a tool result keeps for the model. */
const RESULT_TEXT_LIMIT = 50_000;

/**
 * MCP result content to RunKiln content. With `source`, every text part is wrapped in an untrusted block (the
 * server is outside the project's trust: its output is data for the model, never instructions).
 */
export function convertMcpContent(result: McpCallResult, source?: string): (TextContent | ImageContent)[] {
	const parts: (TextContent | ImageContent)[] = [];
	let textBytes = 0;
	const pushText = (text: string) => {
		if (textBytes >= RESULT_TEXT_LIMIT) return;
		const room = RESULT_TEXT_LIMIT - textBytes;
		const kept =
			text.length > room ? `${text.slice(0, room)}\n[truncated: ${text.length - room} more characters]` : text;
		textBytes += kept.length;
		parts.push({ type: "text", text: source ? markUntrusted(kept, source) : stripTagCharacters(kept) });
	};
	for (const block of (result.content ?? []) as McpContentBlock[]) {
		if (block.type === "text" && typeof block.text === "string") pushText(block.text);
		else if (block.type === "image" && block.data && block.mimeType)
			parts.push({ type: "image", data: block.data, mimeType: block.mimeType });
		else if (block.type === "resource" && block.resource) {
			pushText(
				block.resource.text ?? `[resource ${block.resource.uri ?? ""} (${block.resource.mimeType ?? "binary"})]`,
			);
		} else if (block.type === "resource_link") pushText(`[resource link: ${block.name ?? ""} ${block.uri ?? ""}]`);
		else if (block.type === "audio") pushText(`[audio ${block.mimeType ?? ""} omitted]`);
	}
	if (parts.length === 0 && result.structuredContent !== undefined) pushText(JSON.stringify(result.structuredContent));
	if (parts.length === 0) pushText("(no output)");
	return parts;
}

function definitionFor(manager: McpManager, entry: McpToolEntry): ToolDefinition {
	const { tool, server } = entry;
	const schema = (
		tool.inputSchema && typeof tool.inputSchema === "object" ? tool.inputSchema : { type: "object" }
	) as Record<string, unknown>;
	return {
		name: entry.name,
		label: `${server}:${tool.name}`,
		description: (tool.description ?? tool.title ?? `${tool.name} (MCP server ${server})`).slice(0, 4000),
		parameters: { type: "object", properties: {}, ...schema } as never,
		exposure: entry.pinned ? "direct" : "deferred",
		namespace: { name: `mcp__${server}`, aliases: [server] },
		...(tool.annotations ? { annotations: tool.annotations } : {}),
		async execute(_id, params, signal) {
			const result = await manager.callTool(server, tool.name, params, signal);
			return {
				content: convertMcpContent(result, `MCP server ${server}, tool ${tool.name}`),
				details: { server, tool: tool.name },
				...(result.structuredContent !== undefined ? { structuredContent: result.structuredContent as never } : {}),
				...(result.isError ? { isError: true } : {}),
			};
		},
	};
}

/** Simple ranked search over tool names and descriptions. */
export function searchMcpTools(entries: readonly McpToolEntry[], query: string, limit = SEARCH_LIMIT): McpToolEntry[] {
	const words = query
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((word) => word.length > 1);
	if (words.length === 0) return entries.slice(0, limit);
	const scored = entries.map((entry) => {
		const name = entry.name.toLowerCase();
		const description = (entry.tool.description ?? "").toLowerCase();
		let score = 0;
		for (const word of words) {
			if (name.includes(word)) score += 3;
			if (entry.server.toLowerCase() === word) score += 2;
			if (description.includes(word)) score += 1;
		}
		return { entry, score };
	});
	return scored
		.filter((item) => item.score > 0)
		.sort((a, b) => b.score - a.score)
		.slice(0, limit)
		.map((item) => item.entry);
}

const mcpSchema = Type.Object({
	action: Type.Union([Type.Literal("search"), Type.Literal("call")], { description: "search tools, or call one" }),
	query: Type.Optional(Type.String({ description: "search: words or a server name" })),
	tool: Type.Optional(Type.String({ description: "call: full tool name, mcp__<server>__<tool>" })),
	arguments: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "call: tool input" })),
});

/** The `mcp` tool. `serverNames` is fixed when the session starts, so its description never changes. */
export function createMcpToolDefinition(
	manager: McpManager,
	serverNames: readonly string[],
): ToolDefinition<typeof mcpSchema> {
	return {
		name: MCP_TOOL_NAME,
		label: "mcp",
		description: `Use tools of MCP servers (${serverNames.join(", ") || "none"}). First {"action":"search","query":"..."} to find tools and their input schemas, then {"action":"call","tool":"mcp__<server>__<tool>","arguments":{...}}.`,
		promptSnippet: "Search and call MCP server tools",
		parameters: mcpSchema,
		async execute(_id, params, signal, _onUpdate, ctx) {
			if (params.action === "search") {
				await manager.settled();
				const all = manager.tools();
				const found = searchMcpTools(all, params.query ?? "");
				const lines: string[] = [];
				for (const entry of found) {
					const description = (entry.tool.description ?? "").replace(/\s+/g, " ").slice(0, DESCRIPTION_LIMIT);
					lines.push(
						`## ${entry.name}\n${description}\ninput schema: ${JSON.stringify(entry.tool.inputSchema ?? {})}`,
					);
				}
				const notes = manager
					.servers()
					.filter((state) => state.status !== "connected")
					.map((state) => `${state.config.name}: ${state.status}${state.error ? ` (${state.error})` : ""}`);
				const header =
					found.length > 0
						? `${found.length} of ${all.length} MCP tools match:`
						: all.length > 0
							? `No MCP tool matches "${params.query ?? ""}". Tools: ${all
									.map((entry) => entry.name)
									.join(", ")
									.slice(0, 2000)}`
							: "No MCP tools are available.";
				const text = [header, ...lines, ...(notes.length > 0 ? [`Not connected: ${notes.join("; ")}`] : [])].join(
					"\n\n",
				);
				return {
					content: [{ type: "text", text }],
					details: { action: "search", matches: found.map((e) => e.name) },
				};
			}
			const name = params.tool ?? "";
			if (!name.startsWith("mcp__")) {
				return {
					content: [
						{
							type: "text",
							text: 'call needs "tool": the full name from search, such as mcp__<server>__<tool>.',
						},
					],
					details: { action: "call" },
					isError: true,
				};
			}
			await manager.settled();
			if (!manager.tools().some((entry) => entry.name === name)) {
				return {
					content: [{ type: "text", text: `Unknown MCP tool ${name}. Use {"action":"search"} to list tools.` }],
					details: { action: "call", tool: name },
					isError: true,
				};
			}
			// Through the session's tool pipeline: permission gate (rules name mcp__server__tool), hooks, validation.
			const outcome = await ctx.executeTool(name, params.arguments ?? {}, { signal });
			return {
				content: outcome.result.content,
				details: { action: "call", tool: name },
				...(outcome.isError ? { isError: true } : {}),
			};
		},
	};
}

/** A built-in extension whose tools map holds the registered MCP tools; {@link sync} rebuilds it. */
export function createMcpExtension(manager: McpManager): { extension: Extension; sync(): boolean } {
	const tools = new Map<
		string,
		{ definition: ToolDefinition; sourceInfo: ReturnType<typeof createSyntheticSourceInfo> }
	>();
	let signature = "";
	const handlers = new Map<string, Array<(...args: unknown[]) => Promise<unknown>>>();
	handlers.set("session_start", [
		async (...args: unknown[]) => {
			const [event, ctx] = args as [SessionStartEvent, ExtensionContext];
			if (event.reason === "reload") manager.loadConfig();
			await askMcpTrust(manager, ctx);
			const pinned = manager.servers().filter((state) => state.pinned);
			const all = manager.start();
			// Pinned servers declare their tools directly: wait (bounded) so they are in the first request's prompt.
			if (pinned.length > 0)
				await Promise.race([all, new Promise((resolve) => setTimeout(resolve, 10_000).unref())]);
		},
	]);
	handlers.set("session_shutdown", [
		async (...args: unknown[]) => {
			const [event] = args as [SessionShutdownEvent];
			if (event.reason !== "reload") await manager.dispose();
		},
	]);
	const extension: Extension = {
		path: MCP_EXTENSION_PATH,
		resolvedPath: MCP_EXTENSION_PATH,
		hidden: true,
		sourceInfo: createSyntheticSourceInfo(MCP_EXTENSION_PATH, { source: "builtin" }),
		handlers,
		tools,
		messageRenderers: new Map(),
		commands: new Map(),
		flags: new Map(),
		shortcuts: new Map(),
	};
	return {
		extension,
		sync() {
			const entries = manager.tools();
			const next = JSON.stringify(entries.map((e) => [e.name, e.pinned, e.tool.description, e.tool.inputSchema]));
			if (next === signature) return false;
			signature = next;
			tools.clear();
			for (const entry of entries) {
				if (tools.has(entry.name)) continue;
				tools.set(entry.name, {
					definition: definitionFor(manager, entry),
					sourceInfo: createSyntheticSourceInfo(`mcp:${entry.server}`, { source: "mcp" }),
				});
			}
			return true;
		},
	};
}

/** Ask once about project servers that are not approved yet (interactive sessions only). */
export async function askMcpTrust(manager: McpManager, ctx: ExtensionContext): Promise<void> {
	const pending = manager.untrustedServers();
	if (pending.length === 0 || !ctx.hasUI) return;
	const lines = pending.slice(0, 10).flatMap((state) => mcpTrustLines(state.config));
	if (pending.length > 10) lines.push(`  ... and ${pending.length - 10} more (/mcp)`);
	const choice = await ctx.ui.select(
		`This project defines MCP servers (${sanitizeForPrompt(pending[0]!.config.source)}${pending.length > 1 ? ", ..." : ""}).\n${lines.join("\n")}\n\nStart them?`,
		["Trust and start (remember)", "Trust for this session", "Not now (/mcp trust later)"],
	);
	const names = pending.map((state) => state.config.name);
	if (choice?.startsWith("Trust and")) manager.trustServers(names, true);
	else if (choice?.startsWith("Trust for")) manager.trustServers(names, false);
}
