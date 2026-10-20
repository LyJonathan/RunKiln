#!/usr/bin/env node
// A tiny MCP server over stdio for tests: newline-delimited JSON-RPC, tools echo / add / fail / slow / grow.
// FIXTURE_TOOL_PREFIX (env) prefixes the descriptions, so tests can check env expansion reached the server.
import { createInterface } from "node:readline";

const prefix = process.env.FIXTURE_TOOL_PREFIX ?? "";
const tools = [
	{
		name: "echo",
		description: `${prefix}Echo the given text back`,
		inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
		annotations: { readOnlyHint: true },
	},
	{
		name: "add",
		description: "Add two numbers",
		inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] },
	},
	{ name: "fail", description: "Always returns an error result", inputSchema: { type: "object", properties: {} } },
	{ name: "slow", description: "Waits a long time (for cancellation tests)", inputSchema: { type: "object", properties: {} } },
	{ name: "grow", description: "Adds a tool named extra and announces list_changed", inputSchema: { type: "object", properties: {} } },
];

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });

process.stderr.write("fixture mcp server started\n");
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
	if (!line.trim()) return;
	const message = JSON.parse(line);
	const { id, method, params } = message;
	if (method === "initialize") {
		return reply(id, {
			protocolVersion: params?.protocolVersion ?? "2025-06-18",
			capabilities: { tools: { listChanged: true } },
			serverInfo: { name: "fixture", version: "1.0.0" },
			instructions: "Fixture server for RunKiln tests.",
		});
	}
	if (method === "notifications/initialized" || method === "notifications/cancelled") return;
	if (method === "tools/list") {
		// Two pages, to exercise pagination.
		if (!params?.cursor) return reply(id, { tools: tools.slice(0, 2), nextCursor: "page2" });
		return reply(id, { tools: tools.slice(2) });
	}
	if (method === "tools/call") {
		const args = params?.arguments ?? {};
		switch (params?.name) {
			case "echo":
				return reply(id, { content: [{ type: "text", text: `echo: ${args.text}` }] });
			case "add":
				return reply(id, { content: [{ type: "text", text: String(args.a + args.b) }], structuredContent: { sum: args.a + args.b } });
			case "fail":
				return reply(id, { content: [{ type: "text", text: "it failed" }], isError: true });
			case "slow":
				return; // never answers
			case "grow":
				tools.push({ name: "extra", description: "Added at runtime", inputSchema: { type: "object", properties: {} } });
				reply(id, { content: [{ type: "text", text: "grown" }] });
				return send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
			case "extra":
				return reply(id, { content: [{ type: "text", text: "extra ran" }] });
			default:
				return send({ jsonrpc: "2.0", id, error: { code: -32602, message: `Unknown tool ${params?.name}` } });
		}
	}
	if (method === "ping") return reply(id, {});
	if (id !== undefined) send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
});
rl.on("close", () => process.exit(0));
