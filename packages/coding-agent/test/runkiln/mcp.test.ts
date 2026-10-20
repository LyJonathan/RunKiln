import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type Api,
	type Context,
	type FauxProviderRegistration,
	fauxAssistantMessage,
	fauxToolCall,
	getCurrentTools,
	type Model,
	registerFauxProvider,
	type SimpleStreamOptions,
	streamSimple,
	type ToolResultMessage,
} from "@runkiln/ai/compat";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionUIContext } from "../../src/core/extensions/types.ts";
import { CommandTrustStore } from "../../src/core/hooks/trust.ts";
import { McpClient, SseTransport, StdioTransport, StreamableHttpTransport } from "../../src/core/mcp/client.ts";
import { expandEnv, loadMcpConfig, mcpToolName, parseMcpServers } from "../../src/core/mcp/config.ts";
import { McpManager } from "../../src/core/mcp/manager.ts";
import { convertMcpContent, searchMcpTools } from "../../src/core/mcp/tools.ts";
import type { ModelRuntime } from "../../src/core/model-runtime.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { buildMcpMarkdown } from "../../src/modes/interactive/extend-commands.ts";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "mcp-stdio-server.mjs");

let root: string;
let agentDir: string;
let projectDir: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "runkiln-mcp-"));
	agentDir = join(root, "agent");
	projectDir = join(root, "project");
	for (const dir of [agentDir, projectDir]) mkdirSync(dir, { recursive: true });
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("MCP config", () => {
	it("expands ${VAR} and ${VAR:-default} and reports unset variables", () => {
		const missing = new Set<string>();
		expect(expandEnv("${A}/x/${B:-dflt}/${C}", { A: "a" }, missing)).toBe("a/x/dflt/");
		expect([...missing]).toEqual(["C"]);
	});

	it("parses stdio, http (and its streamable-http alias), sse; infers the type; skips disabled", () => {
		const { servers, problems } = parseMcpServers(
			{
				fs: { command: "npx", args: ["-y", "fs-mcp", "${ROOT:-/tmp}"], env: { TOKEN: "${TOKEN}" } },
				api: {
					type: "streamable-http",
					url: "${API:-https://api.example.com}/mcp",
					headers: { Authorization: "Bearer ${KEY}" },
				},
				bare: { url: "https://bare.example.com/mcp" },
				old: { type: "sse", url: "https://old.example.com/sse", timeout: 5000, alwaysLoad: true },
				off: { command: "x", disabled: true },
				ws: { type: "ws", url: "wss://x" },
				"bad name": { command: "x" },
			},
			"project",
			".mcp.json",
			{ KEY: "k1" },
		);
		expect(servers.map((s) => [s.name, s.type])).toEqual([
			["fs", "stdio"],
			["api", "http"],
			["bare", "http"],
			["old", "sse"],
		]);
		expect(servers[0]).toMatchObject({ args: ["-y", "fs-mcp", "/tmp"], env: { TOKEN: "" }, missingEnv: ["TOKEN"] });
		expect(servers[1]).toMatchObject({ url: "https://api.example.com/mcp", headers: { Authorization: "Bearer k1" } });
		expect(servers[3]).toMatchObject({ timeout: 5000, alwaysLoad: true });
		expect(problems.map((p) => p.message)).toEqual([
			'ws: transport "ws" is not supported (stdio, http, sse)',
			"bad name: a server name may hold letters, digits, _ . and -",
		]);
	});

	it("reads .mcp.json only in a trusted folder; a global server wins a name clash", () => {
		writeFileSync(
			join(projectDir, ".mcp.json"),
			JSON.stringify({ mcpServers: { docs: { command: "docs" }, shared: { command: "project-version" } } }),
		);
		const global = { mcpServers: { shared: { command: "global-version" } } };
		expect(loadMcpConfig({ globalSettings: global, cwd: projectDir, projectTrusted: false }).servers).toHaveLength(1);
		const loaded = loadMcpConfig({ globalSettings: global, cwd: projectDir, projectTrusted: true });
		expect(loaded.servers.map((s) => `${s.scope}:${s.name}:${s.command}`)).toEqual([
			"global:shared:global-version",
			"project:docs:docs",
		]);
		expect(loaded.problems[0]?.message).toContain("shared: already defined");
	});

	it("names tools mcp__server__tool, cleaned and capped at 64 characters", () => {
		expect(mcpToolName("git-hub", "create.issue")).toBe("mcp__git-hub__create_issue");
		expect(mcpToolName("s", "x".repeat(80))).toHaveLength(64);
	});
});

describe("MCP client over stdio (fixture server)", () => {
	it("initializes, lists paginated tools, calls them, and sees list_changed", async () => {
		const client = new McpClient(new StdioTransport(process.execPath, [FIXTURE], { cwd: projectDir }), projectDir);
		await client.connect(10_000, "test");
		expect(client.serverInfo?.name).toBe("fixture");
		expect(client.instructions).toContain("Fixture server");
		const tools = await client.listTools(5000);
		expect(tools.map((t) => t.name)).toEqual(["echo", "add", "fail", "slow", "grow"]);
		expect(await client.callTool("echo", { text: "hi" }, 5000)).toEqual({
			content: [{ type: "text", text: "echo: hi" }],
		});
		expect((await client.callTool("add", { a: 2, b: 3 }, 5000)).structuredContent).toEqual({ sum: 5 });
		expect((await client.callTool("fail", {}, 5000)).isError).toBe(true);
		await expect(client.callTool("nope", {}, 5000)).rejects.toThrow("Unknown tool nope");
		const changed = new Promise<void>((resolve) => {
			client.onToolsChanged = resolve;
		});
		await client.callTool("grow", {}, 5000);
		await changed;
		expect((await client.listTools(5000)).map((t) => t.name)).toContain("extra");
		await client.close();
	});

	it("times out and cancels a call that never answers; aborts on signal", async () => {
		const client = new McpClient(new StdioTransport(process.execPath, [FIXTURE], { cwd: projectDir }), projectDir);
		await client.connect(10_000, "test");
		await expect(client.callTool("slow", {}, 200)).rejects.toThrow("tools/call timed out");
		const controller = new AbortController();
		const pending = client.callTool("slow", {}, 60_000, controller.signal);
		controller.abort();
		await expect(pending).rejects.toThrow("aborted");
		await client.close();
	});
});

/** A minimal MCP server over HTTP: streamable HTTP at /mcp (JSON or SSE replies), legacy SSE at /sse + /messages. */
function startHttpServer(options: { sseReplies?: boolean; streamable?: boolean } = {}) {
	const streamable = options.streamable ?? true;
	const sseClients = new Set<ServerResponse>();
	const seen: Array<{ path: string; session?: string; auth?: string; protocol?: string; method?: string }> = [];
	const answer = (message: {
		id?: number;
		method?: string;
		params?: { name?: string; arguments?: { text?: string } };
	}) => {
		if (message.id === undefined) return undefined;
		if (message.method === "initialize")
			return {
				jsonrpc: "2.0",
				id: message.id,
				result: {
					protocolVersion: "2025-06-18",
					capabilities: { tools: {} },
					serverInfo: { name: "http-fixture" },
				},
			};
		if (message.method === "tools/list")
			return {
				jsonrpc: "2.0",
				id: message.id,
				result: {
					tools: [
						{
							name: "shout",
							description: "Upper-case text",
							inputSchema: { type: "object", properties: { text: { type: "string" } } },
						},
					],
				},
			};
		if (message.method === "tools/call")
			return {
				jsonrpc: "2.0",
				id: message.id,
				result: { content: [{ type: "text", text: String(message.params?.arguments?.text ?? "").toUpperCase() }] },
			};
		return { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "nope" } };
	};
	const body = (req: IncomingMessage) =>
		new Promise<string>((resolve) => {
			let data = "";
			req.on("data", (chunk) => {
				data += chunk;
			});
			req.on("end", () => resolve(data));
		});
	const server: Server = createServer(async (req, res) => {
		const path = new URL(req.url ?? "/", "http://x").pathname;
		if (req.method === "POST" && path === "/mcp") {
			const message = JSON.parse(await body(req));
			seen.push({
				path,
				session: req.headers["mcp-session-id"] as string | undefined,
				auth: req.headers.authorization,
				protocol: req.headers["mcp-protocol-version"] as string | undefined,
				method: message.method,
			});
			if (!streamable) {
				res.writeHead(405).end();
				return;
			}
			const reply = answer(message);
			if (!reply) {
				res.writeHead(202).end();
				return;
			}
			const headers: Record<string, string> = { "mcp-session-id": "sess-1" };
			if (options.sseReplies) {
				res.writeHead(200, { ...headers, "content-type": "text/event-stream" });
				res.end(`event: message\ndata: ${JSON.stringify(reply)}\n\n`);
			} else {
				res.writeHead(200, { ...headers, "content-type": "application/json" });
				res.end(JSON.stringify(reply));
			}
			return;
		}
		if (req.method === "GET" && (path === "/sse" || path === "/mcp")) {
			res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
			res.write(`event: endpoint\ndata: /messages?sessionId=abc\n\n`);
			sseClients.add(res);
			req.on("close", () => sseClients.delete(res));
			return;
		}
		if (req.method === "POST" && path === "/messages") {
			const message = JSON.parse(await body(req));
			seen.push({ path, method: message.method });
			res.writeHead(202).end();
			const reply = answer(message);
			if (reply) for (const client of sseClients) client.write(`event: message\ndata: ${JSON.stringify(reply)}\n\n`);
			return;
		}
		if (req.method === "DELETE") {
			res.writeHead(200).end();
			return;
		}
		res.writeHead(404).end();
	});
	return new Promise<{ url: string; seen: typeof seen; close: () => Promise<void> }>((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address() as AddressInfo;
			resolve({
				url: `http://127.0.0.1:${port}`,
				seen,
				close: () =>
					new Promise((done) => {
						for (const client of sseClients) client.end();
						server.closeAllConnections();
						server.close(() => done());
					}),
			});
		});
	});
}

describe("MCP client over HTTP", () => {
	it("streamable HTTP with JSON replies: keeps the session id, sends headers and the protocol version", async () => {
		const http = await startHttpServer();
		const client = new McpClient(
			new StreamableHttpTransport(`${http.url}/mcp`, { authorization: "Bearer t" }),
			projectDir,
		);
		await client.connect(5000, "test");
		expect((await client.listTools(5000)).map((t) => t.name)).toEqual(["shout"]);
		expect(await client.callTool("shout", { text: "hey" }, 5000)).toEqual({
			content: [{ type: "text", text: "HEY" }],
		});
		const call = http.seen.find((s) => s.method === "tools/call");
		expect(call).toMatchObject({ session: "sess-1", auth: "Bearer t", protocol: "2025-06-18" });
		expect(http.seen[0]).toMatchObject({ method: "initialize", session: undefined, protocol: undefined });
		await client.close();
		await http.close();
	});

	it("streamable HTTP with SSE replies", async () => {
		const http = await startHttpServer({ sseReplies: true });
		const client = new McpClient(new StreamableHttpTransport(`${http.url}/mcp`), projectDir);
		await client.connect(5000, "test");
		expect(await client.callTool("shout", { text: "sse" }, 5000)).toEqual({
			content: [{ type: "text", text: "SSE" }],
		});
		await client.close();
		await http.close();
	});

	it("the older HTTP+SSE transport", async () => {
		const http = await startHttpServer();
		const client = new McpClient(new SseTransport(`${http.url}/sse`), projectDir);
		await client.connect(5000, "test");
		expect(await client.callTool("shout", { text: "old" }, 5000)).toEqual({
			content: [{ type: "text", text: "OLD" }],
		});
		expect(http.seen.some((s) => s.path === "/messages" && s.method === "tools/call")).toBe(true);
		await client.close();
		await http.close();
	});

	it("an http server that refuses POST falls back to SSE (as Claude Code does)", async () => {
		const http = await startHttpServer({ streamable: false });
		const manager = new McpManager({
			cwd: projectDir,
			trust: new CommandTrustStore(agentDir),
			globalSettings: () => ({ mcpServers: { remote: { type: "http", url: `${http.url}/mcp` } } }),
			settings: () => ({}),
			projectTrusted: () => true,
		});
		await manager.start();
		expect(manager.server("remote")).toMatchObject({ status: "connected", transport: "sse" });
		expect(manager.tools().map((t) => t.name)).toEqual(["mcp__remote__shout"]);
		await manager.dispose();
		await http.close();
	});
});

describe("MCP manager", () => {
	const stdioServer = (extra: object = {}) => ({ command: process.execPath, args: [FIXTURE], ...extra });
	const manager = (global: Record<string, unknown>, settings: Record<string, unknown> = {}) =>
		new McpManager({
			cwd: projectDir,
			trust: new CommandTrustStore(agentDir),
			globalSettings: () => global,
			settings: () => settings,
			projectTrusted: () => true,
		});

	it("starts global servers, passes env, lists tools; project servers wait for trust", async () => {
		writeFileSync(join(projectDir, ".mcp.json"), JSON.stringify({ mcpServers: { proj: stdioServer() } }));
		const m = manager({
			mcpServers: { fx: stdioServer({ env: { FIXTURE_TOOL_PREFIX: "${MCP_TEST_PREFIX:-[pfx] }" } }) },
		});
		expect(m.server("proj")?.status).toBe("needs-trust");
		await m.start();
		expect(m.server("fx")?.status).toBe("connected");
		expect(m.server("proj")?.status).toBe("needs-trust");
		expect(m.tools().find((t) => t.name === "mcp__fx__echo")?.tool.description).toBe(
			"[pfx] Echo the given text back",
		);
		m.trustServers(["proj"], true);
		await m.start();
		expect(m.server("proj")?.status).toBe("connected");
		// Remembered for the next session.
		expect(manager({}).server("proj")?.status).toBe("closed");
		await m.dispose();
	});

	it("reports a server that fails to start with its stderr, and reconnects one that died", async () => {
		const m = manager({
			mcpServers: {
				broken: { command: process.execPath, args: ["-e", "console.error('boom: no config'); process.exit(3)"] },
				fx: stdioServer(),
			},
		});
		await m.start();
		expect(m.server("broken")?.status).toBe("failed");
		expect(m.server("broken")?.error).toContain("boom: no config");
		const md = buildMcpMarkdown(m);
		expect(md).toContain("| **fx** | ● connected | stdio");
		expect(md).toContain("✗ **broken**:");
		await m.reconnect("fx");
		expect(m.server("fx")?.status).toBe("connected");
		await m.dispose();
	});

	it("pins servers listed in mcp.pinned or with alwaysLoad", () => {
		const m = manager(
			{ mcpServers: { a: stdioServer(), b: stdioServer({ alwaysLoad: true }), c: stdioServer() } },
			{ mcp: { pinned: ["a"], disabled: ["c"] } },
		);
		expect(m.servers().map((s) => [s.config.name, s.pinned, s.status])).toEqual([
			["a", true, "closed"],
			["b", true, "closed"],
			["c", false, "disabled"],
		]);
	});

	it("search ranks name matches first", () => {
		const entries = ["create_issue", "list_issues", "get_user"].map((name) => ({
			name: `mcp__gh__${name}`,
			server: "gh",
			tool: { name, description: name === "get_user" ? "Fetch a user, not an issue" : `${name} tool` },
			pinned: false,
		}));
		expect(searchMcpTools(entries, "create issue").map((e) => e.tool.name)).toEqual([
			"create_issue",
			"list_issues",
			"get_user",
		]);
		expect(searchMcpTools(entries, "user").map((e) => e.tool.name)).toEqual(["get_user"]);
	});

	it("converts MCP content to text and images", () => {
		expect(
			convertMcpContent({
				content: [
					{ type: "text", text: "a" },
					{ type: "image", data: "AAAA", mimeType: "image/png" },
					{ type: "resource", resource: { uri: "file:///x", text: "body" } },
					{ type: "resource_link", uri: "file:///y", name: "y" },
				],
			}),
		).toEqual([
			{ type: "text", text: "a" },
			{ type: "image", data: "AAAA", mimeType: "image/png" },
			{ type: "text", text: "body" },
			{ type: "text", text: "[resource link: y file:///y]" },
		]);
		expect(convertMcpContent({ structuredContent: { ok: 1 } })).toEqual([{ type: "text", text: '{"ok":1}' }]);
	});
});

describe("MCP in a session", () => {
	let faux: FauxProviderRegistration;
	const runtime = {
		getModelById: () => undefined,
		hasConfiguredAuth: () => true,
		streamSimple: (model: Model<Api>, context: Context, options?: SimpleStreamOptions) =>
			streamSimple(model, context, options),
	} as unknown as ModelRuntime;

	beforeEach(() => {
		faux = registerFauxProvider();
	});
	afterEach(() => faux.unregister());

	async function open(
		settings: Record<string, unknown>,
		permissionMode: "allow-all" | "read-write" | "plan" = "allow-all",
	) {
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify(settings));
		const { session } = await createAgentSession({
			cwd: projectDir,
			agentDir,
			modelRuntime: runtime,
			model: faux.getModel(),
			settingsManager: SettingsManager.create(projectDir, agentDir),
			sessionManager: SessionManager.inMemory(projectDir),
			thinkingLevel: "off",
			permissionMode,
		});
		const select = vi.fn(
			async (_title: string, options: string[]) => options.find((o) => o === "Deny") ?? options[0],
		);
		await session.bindExtensions({
			uiContext: {
				notify: vi.fn(),
				select,
				confirm: vi.fn(async () => false),
				setStatus: vi.fn(),
			} as unknown as ExtensionUIContext,
			mode: "tui",
		});
		await session.mcp.settled(10_000);
		return { session, select };
	}

	const resultText = (messages: readonly { role: string }[], name: string, nth = 0) => {
		const results = messages.filter(
			(m): m is ToolResultMessage => m.role === "toolResult" && (m as ToolResultMessage).toolName === name,
		);
		const r = results[nth]!;
		return { text: r.content.map((p) => (p.type === "text" ? p.text : "")).join(""), isError: r.isError };
	};

	it("declares only the mcp tool (the prefix stays small and stable); search and call reach the server", async () => {
		const { session } = await open({ mcpServers: { fx: { command: process.execPath, args: [FIXTURE] } } });
		expect(session.getActiveToolNames()).toContain("mcp");
		expect(session.getActiveToolNames().some((name) => name.startsWith("mcp__"))).toBe(false);
		const toolNames: string[][] = [];
		faux.setResponses([
			(context) => {
				toolNames.push(getCurrentTools(context.messages).map((t) => t.name));
				return fauxAssistantMessage([fauxToolCall("mcp", { action: "search", query: "echo text" })], {
					stopReason: "toolUse",
				});
			},
			(context) => {
				toolNames.push(getCurrentTools(context.messages).map((t) => t.name));
				return fauxAssistantMessage(
					[fauxToolCall("mcp", { action: "call", tool: "mcp__fx__echo", arguments: { text: "ping" } })],
					{ stopReason: "toolUse" },
				);
			},
			fauxAssistantMessage("done"),
		]);
		await session.prompt("use the echo tool");
		const search = resultText(session.messages, "mcp", 0);
		expect(search.text).toContain("## mcp__fx__echo");
		expect(search.text).toContain('"required":["text"]');
		// MCP output reaches the model marked as untrusted data.
		expect(resultText(session.messages, "mcp", 1)).toEqual({
			text: '<untrusted source="MCP server fx, tool echo">\necho: ping\n</untrusted>',
			isError: false,
		});
		// The declared tools are the same on both requests: connecting servers never changes the prefix.
		expect(toolNames[0]).toEqual(toolNames[1]);
		expect(toolNames[0]).toContain("mcp");
		session.dispose();
	});

	it("MCP calls go through the permission gate under mcp__server__tool (deny rules, plan mode)", async () => {
		const { session } = await open({
			mcpServers: { fx: { command: process.execPath, args: [FIXTURE] } },
			permissions: { deny: ["mcp__fx__add"] },
		});
		faux.setResponses([
			fauxAssistantMessage(
				[fauxToolCall("mcp", { action: "call", tool: "mcp__fx__add", arguments: { a: 1, b: 2 } })],
				{
					stopReason: "toolUse",
				},
			),
			fauxAssistantMessage("done"),
		]);
		await session.prompt("add");
		const denied = resultText(session.messages, "mcp");
		expect(denied.isError).toBe(true);
		expect(denied.text).toMatch(/mcp__fx__add/);
		session.dispose();

		const plan = await open({ mcpServers: { fx: { command: process.execPath, args: [FIXTURE] } } }, "plan");
		faux.setResponses([
			fauxAssistantMessage(
				[fauxToolCall("mcp", { action: "call", tool: "mcp__fx__echo", arguments: { text: "x" } })],
				{
					stopReason: "toolUse",
				},
			),
			fauxAssistantMessage("done"),
		]);
		await plan.session.prompt("echo");
		expect(resultText(plan.session.messages, "mcp").isError).toBe(true);
		plan.session.dispose();
	});

	it("asks before an MCP call in read & write mode, naming the tool", async () => {
		const { session, select } = await open(
			{ mcpServers: { fx: { command: process.execPath, args: [FIXTURE] } } },
			"read-write",
		);
		faux.setResponses([
			fauxAssistantMessage(
				[fauxToolCall("mcp", { action: "call", tool: "mcp__fx__echo", arguments: { text: "x" } })],
				{
					stopReason: "toolUse",
				},
			),
			fauxAssistantMessage("done"),
		]);
		await session.prompt("echo");
		const prompts = select.mock.calls.map((call) => String(call[0]));
		expect(prompts.some((p) => p.includes("mcp__fx__echo"))).toBe(true);
		expect(prompts.filter((p) => p.startsWith("Allow mcp?"))).toHaveLength(0);
		expect(resultText(session.messages, "mcp").isError).toBe(true);
		session.dispose();
	});

	it("pinned servers declare their tools directly", async () => {
		const { session } = await open({
			mcpServers: { fx: { command: process.execPath, args: [FIXTURE] } },
			mcp: { pinned: ["fx"] },
		});
		expect(session.getActiveToolNames()).toEqual(expect.arrayContaining(["mcp__fx__echo", "mcp__fx__add"]));
		session.dispose();
	});

	it("sessions without MCP servers get no mcp tool", async () => {
		const { session } = await open({});
		expect(session.getActiveToolNames()).not.toContain("mcp");
		session.dispose();
	});
});
