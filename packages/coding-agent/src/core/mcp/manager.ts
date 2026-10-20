/**
 * MCP servers of a session: start the configured (and trusted) servers in the background, keep their tool lists,
 * reconnect on request, call tools, and close everything when the session ends.
 */

import { VERSION } from "../../config.ts";
import type { CommandTrustStore } from "../hooks/trust.ts";
import {
	HttpError,
	type McpCallResult,
	McpClient,
	type McpToolInfo,
	SseTransport,
	StdioTransport,
	StreamableHttpTransport,
} from "./client.ts";
import {
	type LoadedMcpConfig,
	loadMcpConfig,
	type McpServerConfig,
	type McpSettings,
	mcpToolName,
	readMcpSettings,
} from "./config.ts";

export type McpServerStatus = "connecting" | "connected" | "failed" | "needs-trust" | "disabled" | "closed";

export interface McpServerState {
	config: McpServerConfig;
	status: McpServerStatus;
	error?: string;
	tools: McpToolInfo[];
	/** Tools declared to the model directly (alwaysLoad or mcp.pinned). */
	pinned: boolean;
	instructions?: string;
	serverName?: string;
	/** The transport actually used (http may fall back to sse). */
	transport?: "stdio" | "http" | "sse";
	connectedAt?: number;
}

export interface McpToolEntry {
	/** `mcp__server__tool` */
	name: string;
	server: string;
	tool: McpToolInfo;
	pinned: boolean;
}

export const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;
export const DEFAULT_TOOL_TIMEOUT_MS = 120_000;

export interface McpManagerOptions {
	cwd: string;
	trust: CommandTrustStore;
	globalSettings: () => Record<string, unknown>;
	/** Merged settings (for `mcp` options). */
	settings: () => Record<string, unknown>;
	projectTrusted: () => boolean;
	env?: NodeJS.ProcessEnv;
}

export class McpManager {
	private readonly options: McpManagerOptions;
	private loaded: LoadedMcpConfig = { servers: [], problems: [] };
	private settings: McpSettings = {};
	private readonly states = new Map<string, McpServerState>();
	private readonly clients = new Map<string, McpClient>();
	private readonly listeners = new Set<() => void>();
	private readonly connecting = new Map<string, Promise<void>>();
	private disposed = false;

	constructor(options: McpManagerOptions) {
		this.options = options;
		this.loadConfig();
	}

	get cwd(): string {
		return this.options.cwd;
	}

	/** Re-read configuration. Servers whose config changed are restarted by {@link start}. */
	loadConfig(): void {
		this.loaded = loadMcpConfig({
			globalSettings: this.options.globalSettings(),
			cwd: this.options.cwd,
			projectTrusted: this.options.projectTrusted(),
			...(this.options.env ? { env: this.options.env } : {}),
		});
		this.settings = readMcpSettings(this.options.settings().mcp);
		const names = new Set(this.loaded.servers.map((server) => server.name));
		for (const name of [...this.states.keys()]) {
			if (!names.has(name)) {
				void this.clients.get(name)?.close();
				this.clients.delete(name);
				this.states.delete(name);
			}
		}
		for (const config of this.loaded.servers) {
			const previous = this.states.get(config.name);
			if (previous && previous.config.fingerprint === config.fingerprint && previous.status !== "needs-trust") {
				previous.config = config;
				previous.pinned = this.isPinned(config);
				if (this.isDisabled(config)) previous.status = "disabled";
				continue;
			}
			if (previous) {
				void this.clients.get(config.name)?.close();
				this.clients.delete(config.name);
			}
			this.states.set(config.name, {
				config,
				status: this.initialStatus(config),
				tools: [],
				pinned: this.isPinned(config),
			});
		}
	}

	get problems() {
		return this.loaded.problems;
	}

	get mcpSettings(): McpSettings {
		return this.settings;
	}

	/** Whether any server is configured (decides whether the `mcp` tool is offered). */
	get hasServers(): boolean {
		return this.loaded.servers.length > 0;
	}

	private isPinned(config: McpServerConfig): boolean {
		return config.alwaysLoad === true || (this.settings.pinned ?? []).includes(config.name);
	}

	private isDisabled(config: McpServerConfig): boolean {
		return (this.settings.disabled ?? []).includes(config.name);
	}

	private initialStatus(config: McpServerConfig): McpServerStatus {
		if (this.isDisabled(config)) return "disabled";
		if (
			config.scope === "project" &&
			!this.options.trust.isServerTrusted(this.options.cwd, config.name, config.fingerprint)
		) {
			return "needs-trust";
		}
		return "closed";
	}

	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private changed(): void {
		for (const listener of this.listeners) {
			try {
				listener();
			} catch {}
		}
	}

	servers(): McpServerState[] {
		return [...this.states.values()];
	}

	server(name: string): McpServerState | undefined {
		return this.states.get(name);
	}

	/** Project servers waiting for approval. */
	untrustedServers(): McpServerState[] {
		return this.servers().filter((state) => state.status === "needs-trust");
	}

	trustServers(names: readonly string[], remember: boolean): void {
		const approved = names
			.map((name) => this.states.get(name))
			.filter((state): state is McpServerState => state?.status === "needs-trust");
		this.options.trust.trustServers(
			this.options.cwd,
			approved.map((state) => ({ name: state.config.name, fingerprint: state.config.fingerprint })),
			remember,
		);
		for (const state of approved) state.status = "closed";
		this.changed();
	}

	/** Start every trusted, enabled server that is not running. Resolves when all have connected or failed. */
	async start(): Promise<void> {
		const pending = this.servers()
			.filter((state) => state.status === "closed" || state.status === "failed")
			.map((state) => this.connect(state.config.name));
		await Promise.all(pending);
	}

	/** Wait for servers that are connecting now (used before searching tools). */
	async settled(timeoutMs = 5000): Promise<void> {
		const pending = [...this.connecting.values()];
		if (pending.length === 0) return;
		await Promise.race([Promise.all(pending), new Promise((resolve) => setTimeout(resolve, timeoutMs).unref())]);
	}

	/** (Re)connect one server. */
	connect(name: string): Promise<void> {
		const existing = this.connecting.get(name);
		if (existing) return existing;
		const promise = this.doConnect(name).finally(() => this.connecting.delete(name));
		this.connecting.set(name, promise);
		return promise;
	}

	async reconnect(name: string): Promise<McpServerState | undefined> {
		const state = this.states.get(name);
		if (!state) return undefined;
		if (state.status === "needs-trust" || state.status === "disabled") return state;
		await this.clients.get(name)?.close();
		this.clients.delete(name);
		state.status = "closed";
		await this.connect(name);
		return this.states.get(name);
	}

	private async doConnect(name: string): Promise<void> {
		const state = this.states.get(name);
		if (!state || this.disposed) return;
		if (state.status === "needs-trust" || state.status === "disabled") return;
		state.status = "connecting";
		state.error = undefined;
		this.changed();
		const timeout = this.settings.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
		const config = state.config;
		try {
			const client = await this.open(config, timeout, state);
			if (this.disposed || this.states.get(name) !== state) {
				await client.close();
				return;
			}
			client.onToolsChanged = () => {
				void client
					.listTools(timeout)
					.then((tools) => {
						state.tools = tools;
						this.changed();
					})
					.catch(() => {});
			};
			client.onClose = (error) => {
				if (this.clients.get(name) !== client) return;
				this.clients.delete(name);
				state.status = "failed";
				state.error = error?.message ?? "connection closed";
				this.changed();
			};
			state.tools = await client.listTools(timeout);
			state.instructions = client.instructions;
			state.serverName = client.serverInfo?.name;
			state.status = "connected";
			state.connectedAt = Date.now();
			this.clients.set(name, client);
		} catch (error) {
			state.status = "failed";
			state.error = describeError(error);
			state.tools = [];
		}
		this.changed();
	}

	private async open(config: McpServerConfig, timeout: number, state: McpServerState): Promise<McpClient> {
		const attempt = async (transport: StdioTransport | StreamableHttpTransport | SseTransport) => {
			const client = new McpClient(transport, this.options.cwd);
			try {
				await withTimeout(client.connect(timeout, VERSION), timeout, `${config.name}: no answer to initialize`);
				return client;
			} catch (error) {
				await client.close();
				const tail = transport instanceof StdioTransport ? transport.stderrTail().trim() : "";
				if (tail && error instanceof Error && !error.message.includes(tail.slice(-80))) {
					error.message = `${error.message} (stderr: ${tail.split(/\r?\n/).slice(-2).join(" | ")})`;
				}
				throw error;
			}
		};
		if (config.type === "stdio") {
			state.transport = "stdio";
			return attempt(
				new StdioTransport(config.command!, config.args ?? [], {
					cwd: config.cwd ?? this.options.cwd,
					...(config.env ? { env: config.env } : {}),
				}),
			);
		}
		if (config.type === "sse") {
			state.transport = "sse";
			return attempt(new SseTransport(config.url!, config.headers));
		}
		try {
			state.transport = "http";
			return await attempt(new StreamableHttpTransport(config.url!, config.headers));
		} catch (error) {
			// Servers that only speak the older HTTP+SSE transport answer POST with 4xx: try it, as Claude Code does.
			if (error instanceof HttpError && error.status >= 400 && error.status < 500 && error.status !== 401) {
				state.transport = "sse";
				return attempt(new SseTransport(config.url!, config.headers));
			}
			throw error;
		}
	}

	/** Every tool of every connected server. */
	tools(): McpToolEntry[] {
		const entries: McpToolEntry[] = [];
		for (const state of this.states.values()) {
			if (state.status !== "connected") continue;
			for (const tool of state.tools) {
				entries.push({
					name: mcpToolName(state.config.name, tool.name),
					server: state.config.name,
					tool,
					pinned: state.pinned,
				});
			}
		}
		return entries;
	}

	async callTool(server: string, tool: string, args: unknown, signal?: AbortSignal): Promise<McpCallResult> {
		const client = this.clients.get(server);
		const state = this.states.get(server);
		if (!client || !state) {
			throw new Error(
				`MCP server "${server}" is not connected${state?.error ? ` (${state.error})` : state ? ` (${state.status})` : ""}. The user can reconnect it with /mcp reconnect ${server}.`,
			);
		}
		const timeout = state.config.timeout ?? this.settings.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
		return client.callTool(tool, args, timeout, signal);
	}

	/** Close every server (session end). */
	async dispose(): Promise<void> {
		this.disposed = true;
		const clients = [...this.clients.values()];
		this.clients.clear();
		for (const state of this.states.values())
			if (state.status === "connected" || state.status === "connecting") state.status = "closed";
		await Promise.all(clients.map((client) => client.close()));
	}
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(message)), ms);
		timer.unref?.();
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}

/** An error message with its cause ("fetch failed: connect ECONNREFUSED 127.0.0.1:9"). */
function describeError(error: unknown): string {
	if (!(error instanceof Error)) return String(error);
	const cause = (error as { cause?: unknown }).cause;
	const causeText = cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "";
	return causeText && !error.message.includes(causeText) ? `${error.message}: ${causeText}` : error.message;
}
