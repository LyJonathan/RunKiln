/**
 * A small MCP client (JSON-RPC 2.0) with the three standard transports: stdio, streamable HTTP and the older
 * HTTP+SSE. Only what RunKiln uses: initialize, tools/list (paginated, refreshed on list_changed), tools/call
 * (cancellable), ping and roots/list answers. No dependency on the MCP SDK.
 */

import type { ChildProcess } from "node:child_process";
import { pathToFileURL } from "node:url";
import { spawnProcess } from "../../utils/child-process.ts";
import {
	getMcpServerBaseEnv,
	killProcessTree,
	trackDetachedChildPid,
	untrackDetachedChildPid,
} from "../../utils/shell.ts";

export const MCP_PROTOCOL_VERSION = "2025-06-18";
const STDERR_TAIL_BYTES = 4096;

export type JsonRpcMessage = {
	jsonrpc: "2.0";
	id?: number | string | null;
	method?: string;
	params?: unknown;
	result?: unknown;
	error?: { code: number; message: string; data?: unknown };
};

export interface McpTransport {
	start(onMessage: (message: JsonRpcMessage) => void, onClose: (error?: Error) => void): Promise<void>;
	send(message: JsonRpcMessage): Promise<void>;
	close(): Promise<void>;
	/** Recent stderr (stdio only), for error reports. */
	stderrTail?(): string;
}

// ---------------------------------------------------------------------------------------------------------------
// stdio: newline-delimited JSON on the child's stdin/stdout
// ---------------------------------------------------------------------------------------------------------------

export class StdioTransport implements McpTransport {
	private child?: ChildProcess;
	private stderr = "";
	private closed = false;

	private readonly command: string;
	private readonly args: string[];
	private readonly options: { cwd: string; env?: Record<string, string> };

	constructor(command: string, args: string[], options: { cwd: string; env?: Record<string, string> }) {
		this.command = command;
		this.args = args;
		this.options = options;
	}

	start(onMessage: (message: JsonRpcMessage) => void, onClose: (error?: Error) => void): Promise<void> {
		return new Promise((resolve, reject) => {
			// cross-spawn resolves .cmd and .bat shims on Windows and escapes each argument, instead of handing the
			// whole line to cmd.exe (shell: true), where an expanded value with & or | would run another command.
			const child = spawnProcess(this.command, this.args, {
				cwd: this.options.cwd,
				// A minimal environment plus the server's declared variables: a third-party server does not get the
				// user's tokens and keys just because they are in RunKiln's environment.
				env: {
					...getMcpServerBaseEnv(),
					RUNKILN_PROJECT_DIR: this.options.cwd,
					CLAUDE_PROJECT_DIR: this.options.cwd,
					...this.options.env,
				},
				stdio: ["pipe", "pipe", "pipe"],
				detached: process.platform !== "win32",
				windowsHide: true,
			});
			this.child = child;
			let buffer = "";
			let started = false;
			child.once("spawn", () => {
				started = true;
				if (child.pid) trackDetachedChildPid(child.pid);
				resolve();
			});
			child.once("error", (error) => {
				if (!started) reject(error);
				else onClose(error);
			});
			child.stdout?.setEncoding("utf8");
			child.stdout?.on("data", (chunk: string) => {
				buffer += chunk;
				let newline = buffer.indexOf("\n");
				while (newline >= 0) {
					const line = buffer.slice(0, newline).trim();
					buffer = buffer.slice(newline + 1);
					if (line) {
						try {
							onMessage(JSON.parse(line) as JsonRpcMessage);
						} catch {
							// Servers sometimes log to stdout; ignore lines that are not JSON.
						}
					}
					newline = buffer.indexOf("\n");
				}
			});
			child.stderr?.setEncoding("utf8");
			child.stderr?.on("data", (chunk: string) => {
				this.stderr = (this.stderr + chunk).slice(-STDERR_TAIL_BYTES);
			});
			child.stdin?.on("error", () => {});
			child.once("close", (code, signal) => {
				if (child.pid) untrackDetachedChildPid(child.pid);
				if (this.closed) return onClose();
				const tail = this.stderr.trim().split(/\r?\n/).slice(-3).join(" | ");
				onClose(new Error(`process exited (${signal ?? `code ${code}`})${tail ? `: ${tail}` : ""}`));
			});
		});
	}

	async send(message: JsonRpcMessage): Promise<void> {
		const stdin = this.child?.stdin;
		if (!stdin || stdin.destroyed) throw new Error("server is not running");
		stdin.write(`${JSON.stringify(message)}\n`);
	}

	async close(): Promise<void> {
		this.closed = true;
		const child = this.child;
		if (!child || child.exitCode !== null) return;
		child.stdin?.end();
		await new Promise<void>((resolve) => {
			const timer = setTimeout(() => {
				if (child.pid) killProcessTree(child.pid);
				resolve();
			}, 1000);
			child.once("close", () => {
				clearTimeout(timer);
				resolve();
			});
		});
	}

	stderrTail(): string {
		return this.stderr;
	}
}

// ---------------------------------------------------------------------------------------------------------------
// Server-sent events parsing
// ---------------------------------------------------------------------------------------------------------------

/** Read an SSE stream, calling `onEvent` per event. Resolves when the stream ends. */
export async function readSse(
	body: ReadableStream<Uint8Array>,
	onEvent: (event: { event: string; data: string }) => void,
): Promise<void> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let eventName = "message";
	let data: string[] = [];
	const dispatch = () => {
		if (data.length > 0) onEvent({ event: eventName, data: data.join("\n") });
		eventName = "message";
		data = [];
	};
	for (;;) {
		const { value, done } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		let newline = buffer.search(/\r?\n/);
		while (newline >= 0) {
			const line = buffer.slice(0, newline);
			buffer = buffer.slice(buffer[newline] === "\r" ? newline + 2 : newline + 1);
			if (line === "") dispatch();
			else if (line.startsWith("event:")) eventName = line.slice(6).trim();
			else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
			newline = buffer.search(/\r?\n/);
		}
	}
	dispatch();
}

// ---------------------------------------------------------------------------------------------------------------
// Streamable HTTP: POST each message; the reply is JSON or an SSE stream
// ---------------------------------------------------------------------------------------------------------------

export class HttpError extends Error {
	readonly status: number;
	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

export class StreamableHttpTransport implements McpTransport {
	private sessionId?: string;
	private onMessage?: (message: JsonRpcMessage) => void;
	private readonly controller = new AbortController();
	protocolVersion = MCP_PROTOCOL_VERSION;
	private readonly url: string;
	private readonly headers: Record<string, string>;

	constructor(url: string, headers: Record<string, string> = {}) {
		this.url = url;
		this.headers = headers;
	}

	async start(onMessage: (message: JsonRpcMessage) => void): Promise<void> {
		this.onMessage = onMessage;
	}

	async send(message: JsonRpcMessage): Promise<void> {
		const headers: Record<string, string> = {
			...this.headers,
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
		};
		if (this.sessionId) headers["mcp-session-id"] = this.sessionId;
		if (message.method !== "initialize") headers["mcp-protocol-version"] = this.protocolVersion;
		const response = await fetch(this.url, {
			method: "POST",
			headers,
			body: JSON.stringify(message),
			signal: this.controller.signal,
		});
		const session = response.headers.get("mcp-session-id");
		if (session) this.sessionId = session;
		if (!response.ok) {
			const text = await response.text().catch(() => "");
			throw new HttpError(response.status, `HTTP ${response.status}${text ? `: ${text.slice(0, 200)}` : ""}`);
		}
		if (response.status === 202 || !response.body) return;
		const type = response.headers.get("content-type") ?? "";
		if (type.includes("text/event-stream")) {
			// Read the stream in the background: the reply (and any server requests) arrive as events.
			void readSse(response.body, (event) => {
				if (event.event !== "message" || !event.data) return;
				try {
					this.onMessage?.(JSON.parse(event.data) as JsonRpcMessage);
				} catch {}
			}).catch(() => {});
			return;
		}
		const text = await response.text();
		if (!text.trim()) return;
		const parsed = JSON.parse(text) as JsonRpcMessage | JsonRpcMessage[];
		for (const item of Array.isArray(parsed) ? parsed : [parsed]) this.onMessage?.(item);
	}

	async close(): Promise<void> {
		if (this.sessionId) {
			// Polite session end; servers may not support DELETE.
			await fetch(this.url, {
				method: "DELETE",
				headers: { ...this.headers, "mcp-session-id": this.sessionId },
				signal: AbortSignal.timeout(2000),
			}).catch(() => {});
		}
		this.controller.abort();
	}
}

// ---------------------------------------------------------------------------------------------------------------
// HTTP+SSE (2024-11-05): GET an event stream; its "endpoint" event says where to POST
// ---------------------------------------------------------------------------------------------------------------

export class SseTransport implements McpTransport {
	private endpoint?: string;
	private readonly controller = new AbortController();
	private readonly url: string;
	private readonly headers: Record<string, string>;

	constructor(url: string, headers: Record<string, string> = {}) {
		this.url = url;
		this.headers = headers;
	}

	async start(onMessage: (message: JsonRpcMessage) => void, onClose: (error?: Error) => void): Promise<void> {
		const response = await fetch(this.url, {
			headers: { ...this.headers, accept: "text/event-stream" },
			signal: this.controller.signal,
		});
		if (!response.ok || !response.body)
			throw new HttpError(response.status, `HTTP ${response.status} opening the SSE stream`);
		let resolveEndpoint!: () => void;
		const gotEndpoint = new Promise<void>((resolve) => {
			resolveEndpoint = resolve;
		});
		void readSse(response.body, (event) => {
			if (event.event === "endpoint") {
				this.endpoint = new URL(event.data.trim(), this.url).toString();
				resolveEndpoint();
				return;
			}
			if (event.event === "message" && event.data) {
				try {
					onMessage(JSON.parse(event.data) as JsonRpcMessage);
				} catch {}
			}
		})
			.then(() => {
				if (!this.controller.signal.aborted) onClose(new Error("SSE stream closed"));
			})
			.catch((error) => {
				if (!this.controller.signal.aborted) onClose(error instanceof Error ? error : new Error(String(error)));
			});
		const timeout = new Promise<never>((_, reject) =>
			setTimeout(() => reject(new Error("no endpoint event on the SSE stream")), 10_000).unref(),
		);
		await Promise.race([gotEndpoint, timeout]);
	}

	async send(message: JsonRpcMessage): Promise<void> {
		if (!this.endpoint) throw new Error("SSE transport not started");
		const response = await fetch(this.endpoint, {
			method: "POST",
			headers: { ...this.headers, "content-type": "application/json" },
			body: JSON.stringify(message),
			signal: this.controller.signal,
		});
		if (!response.ok) throw new HttpError(response.status, `HTTP ${response.status}`);
		await response.body?.cancel().catch(() => {});
	}

	async close(): Promise<void> {
		this.controller.abort();
	}
}

// ---------------------------------------------------------------------------------------------------------------
// JSON-RPC client
// ---------------------------------------------------------------------------------------------------------------

export interface McpToolInfo {
	name: string;
	title?: string;
	description?: string;
	inputSchema?: Record<string, unknown>;
	annotations?: {
		readOnlyHint?: boolean;
		destructiveHint?: boolean;
		idempotentHint?: boolean;
		openWorldHint?: boolean;
		title?: string;
	};
}

export interface McpContentBlock {
	type: string;
	text?: string;
	data?: string;
	mimeType?: string;
	resource?: { uri?: string; text?: string; mimeType?: string };
	uri?: string;
	name?: string;
}

export interface McpCallResult {
	content?: McpContentBlock[];
	structuredContent?: unknown;
	isError?: boolean;
}

export class McpRpcError extends Error {
	readonly code: number;
	constructor(code: number, message: string) {
		super(message);
		this.code = code;
	}
}

export class McpClient {
	private nextId = 1;
	private readonly pending = new Map<
		number,
		{ resolve: (value: unknown) => void; reject: (error: Error) => void; timer?: NodeJS.Timeout }
	>();
	private closedError?: Error;
	serverInfo?: { name?: string; version?: string };
	instructions?: string;
	onToolsChanged?: () => void;
	onClose?: (error?: Error) => void;

	readonly transport: McpTransport;
	private readonly cwd: string;

	constructor(transport: McpTransport, cwd: string) {
		this.transport = transport;
		this.cwd = cwd;
	}

	async connect(timeoutMs: number, clientVersion: string): Promise<void> {
		await this.transport.start(
			(message) => this.handle(message),
			(error) => this.closed(error),
		);
		const result = (await this.request(
			"initialize",
			{
				protocolVersion: MCP_PROTOCOL_VERSION,
				capabilities: { roots: { listChanged: false } },
				clientInfo: { name: "runkiln", version: clientVersion },
			},
			timeoutMs,
		)) as { protocolVersion?: string; serverInfo?: { name?: string; version?: string }; instructions?: string };
		this.serverInfo = result?.serverInfo;
		if (typeof result?.instructions === "string") this.instructions = result.instructions;
		if (this.transport instanceof StreamableHttpTransport && result?.protocolVersion) {
			this.transport.protocolVersion = result.protocolVersion;
		}
		await this.notify("notifications/initialized");
	}

	private closed(error?: Error): void {
		this.closedError = error ?? new Error("connection closed");
		for (const [id, entry] of this.pending) {
			if (entry.timer) clearTimeout(entry.timer);
			entry.reject(this.closedError);
			this.pending.delete(id);
		}
		this.onClose?.(error);
	}

	private handle(message: JsonRpcMessage): void {
		if (message.method !== undefined) {
			if (message.id !== undefined && message.id !== null) {
				void this.answer(message);
				return;
			}
			if (message.method === "notifications/tools/list_changed") this.onToolsChanged?.();
			return;
		}
		if (typeof message.id !== "number") return;
		const entry = this.pending.get(message.id);
		if (!entry) return;
		this.pending.delete(message.id);
		if (entry.timer) clearTimeout(entry.timer);
		if (message.error) entry.reject(new McpRpcError(message.error.code, message.error.message));
		else entry.resolve(message.result);
	}

	/** Requests from the server: ping and roots/list are answered, the rest are refused. */
	private async answer(message: JsonRpcMessage): Promise<void> {
		const reply: JsonRpcMessage = { jsonrpc: "2.0", id: message.id };
		if (message.method === "ping") reply.result = {};
		else if (message.method === "roots/list")
			reply.result = { roots: [{ uri: pathToFileURL(this.cwd).href, name: "project" }] };
		else reply.error = { code: -32601, message: `Method not supported by RunKiln: ${message.method}` };
		await this.transport.send(reply).catch(() => {});
	}

	request(method: string, params: unknown, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
		if (this.closedError) return Promise.reject(this.closedError);
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			const entry: { resolve: (v: unknown) => void; reject: (e: Error) => void; timer?: NodeJS.Timeout } = {
				resolve,
				reject,
			};
			const cancel = (reason: string) => {
				if (!this.pending.has(id)) return;
				this.pending.delete(id);
				if (entry.timer) clearTimeout(entry.timer);
				void this.notify("notifications/cancelled", { requestId: id, reason }).catch(() => {});
				reject(new Error(reason));
			};
			entry.timer = setTimeout(
				() => cancel(`${method} timed out after ${Math.round(timeoutMs / 1000)}s`),
				timeoutMs,
			);
			if (signal) {
				if (signal.aborted) return cancel("aborted");
				signal.addEventListener("abort", () => cancel("aborted"), { once: true });
			}
			this.pending.set(id, entry);
			this.transport
				.send({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) })
				.catch((error) => {
					if (!this.pending.has(id)) return;
					this.pending.delete(id);
					if (entry.timer) clearTimeout(entry.timer);
					reject(error instanceof Error ? error : new Error(String(error)));
				});
		});
	}

	async notify(method: string, params?: unknown): Promise<void> {
		await this.transport.send({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) });
	}

	async listTools(timeoutMs: number): Promise<McpToolInfo[]> {
		const tools: McpToolInfo[] = [];
		let cursor: string | undefined;
		for (let page = 0; page < 50; page++) {
			const result = (await this.request("tools/list", cursor ? { cursor } : {}, timeoutMs)) as {
				tools?: McpToolInfo[];
				nextCursor?: string;
			};
			tools.push(...(result?.tools ?? []).filter((tool) => tool && typeof tool.name === "string"));
			cursor = result?.nextCursor;
			if (!cursor) break;
		}
		return tools;
	}

	async callTool(name: string, args: unknown, timeoutMs: number, signal?: AbortSignal): Promise<McpCallResult> {
		return (await this.request("tools/call", { name, arguments: args ?? {} }, timeoutMs, signal)) as McpCallResult;
	}

	async close(): Promise<void> {
		this.closedError ??= new Error("connection closed");
		await this.transport.close().catch(() => {});
	}
}
