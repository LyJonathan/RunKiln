/**
 * MCP servers from config, in Claude Code's `mcpServers` format:
 *
 * ```json
 * { "mcpServers": {
 *     "docs": { "command": "npx", "args": ["-y", "docs-mcp"], "env": { "TOKEN": "${DOCS_TOKEN}" } },
 *     "api": { "type": "http", "url": "${API_URL:-https://api.example.com}/mcp", "headers": { "Authorization": "Bearer ${API_KEY}" } },
 *     "old": { "type": "sse", "url": "https://example.com/sse" } } }
 * ```
 *
 * Sources: `mcpServers` in global settings (`~/.runkiln/agent/settings.json`), then the project's `.mcp.json` and
 * `.runkiln/mcp.json`. A project server with the same name as a global one is ignored (the user's config wins).
 * `${VAR}` and `${VAR:-default}` are expanded in command, args, env, url and headers. Project servers are only read
 * in a trusted folder and only start after a one-time confirmation (see ../hooks/trust.ts).
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME } from "../../config.ts";
import { filterShellEnv, type ShellEnvironmentPolicy } from "../../utils/shell.ts";
import { stripBom } from "../../utils/text.ts";

export type McpTransportType = "stdio" | "http" | "sse";
export type McpServerScope = "global" | "project";

export interface McpServerConfig {
	name: string;
	type: McpTransportType;
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	cwd?: string;
	url?: string;
	headers?: Record<string, string>;
	/** Tool call timeout in milliseconds. */
	timeout?: number;
	/** Declare this server's tools to the model directly instead of through the `mcp` tool. */
	alwaysLoad?: boolean;
	scope: McpServerScope;
	source: string;
	/** `${VAR}` references with no value and no default. */
	missingEnv: string[];
	/** Fingerprint of the config as written (before expansion), for trust. */
	fingerprint: string;
	/** Every `${VAR}` the config references, for the trust prompt. */
	envRefs?: string[];
	/**
	 * Project configs only: `${VAR}` references that were not expanded because the name looks like a secret
	 * (shellEnvironment's filter, so its include list allows one). A project file must not export the user's tokens.
	 */
	blockedEnv?: string[];
	/** The config as written, before `${VAR}` expansion, for the trust prompt. */
	written?: {
		command?: string;
		args?: string[];
		env?: Record<string, string>;
		cwd?: string;
		url?: string;
		headers?: Record<string, string>;
	};
}

export interface McpConfigProblem {
	source: string;
	message: string;
}

export interface LoadedMcpConfig {
	servers: McpServerConfig[];
	problems: McpConfigProblem[];
}

/**
 * Expand `${VAR}` and `${VAR:-default}`. Unset variables without a default become "" and are reported. A name
 * `blocked` refuses expands to its default or "" and is reported in `refused`.
 */
export function expandEnv(
	value: string,
	env: NodeJS.ProcessEnv,
	missing: Set<string>,
	blocked?: (name: string) => boolean,
	refused?: Set<string>,
	referenced?: Set<string>,
): string {
	return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_match, name: string, fallback?: string) => {
		referenced?.add(name);
		if (blocked?.(name)) {
			refused?.add(name);
			return fallback ?? "";
		}
		const current = env[name];
		if (current !== undefined && current !== "") return current;
		if (fallback !== undefined) return fallback;
		missing.add(name);
		return "";
	});
}

function readJsonFile(path: string): { value?: Record<string, unknown>; error?: string } {
	if (!existsSync(path)) return {};
	try {
		const parsed = JSON.parse(stripBom(readFileSync(path, "utf8")));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { error: "not a JSON object" };
		return { value: parsed as Record<string, unknown> };
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}

const stringRecord = (value: unknown): Record<string, string> | undefined => {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => typeof v === "string");
	return Object.fromEntries(entries) as Record<string, string>;
};

/** Parse one `mcpServers` object. */
export function parseMcpServers(
	raw: unknown,
	scope: McpServerScope,
	source: string,
	env: NodeJS.ProcessEnv = process.env,
	blockedEnvName?: (name: string) => boolean,
): LoadedMcpConfig {
	const servers: McpServerConfig[] = [];
	const problems: McpConfigProblem[] = [];
	if (raw === undefined) return { servers, problems };
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		return { servers, problems: [{ source, message: "`mcpServers` must be an object keyed by server name" }] };
	}
	for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
		if (!value || typeof value !== "object") continue;
		const entry = value as Record<string, unknown>;
		if (entry.disabled === true) continue;
		if (!/^[A-Za-z0-9_.-]+$/.test(name)) {
			problems.push({ source, message: `${name}: a server name may hold letters, digits, _ . and -` });
			continue;
		}
		const rawType = typeof entry.type === "string" ? entry.type : undefined;
		const type: McpTransportType | undefined =
			rawType === undefined
				? typeof entry.url === "string" && typeof entry.command !== "string"
					? "http"
					: "stdio"
				: rawType === "stdio"
					? "stdio"
					: rawType === "http" || rawType === "streamable-http" || rawType === "streamableHttp"
						? "http"
						: rawType === "sse"
							? "sse"
							: undefined;
		if (!type) {
			problems.push({ source, message: `${name}: transport "${rawType}" is not supported (stdio, http, sse)` });
			continue;
		}
		const missing = new Set<string>();
		const refused = new Set<string>();
		const referenced = new Set<string>();
		const x = (text: string) => expandEnv(text, env, missing, blockedEnvName, refused, referenced);
		const strings = (list: unknown) =>
			Array.isArray(list) ? list.filter((a): a is string => typeof a === "string") : undefined;
		const written = {
			...(typeof entry.command === "string" ? { command: entry.command } : {}),
			...(strings(entry.args) ? { args: strings(entry.args) } : {}),
			...(stringRecord(entry.env) ? { env: stringRecord(entry.env) } : {}),
			...(typeof entry.cwd === "string" ? { cwd: entry.cwd } : {}),
			...(typeof entry.url === "string" ? { url: entry.url } : {}),
			...(stringRecord(entry.headers) ? { headers: stringRecord(entry.headers) } : {}),
		};
		const fingerprint = createHash("sha256")
			.update(JSON.stringify([type, entry.command, entry.args, entry.env, entry.url, entry.headers, entry.cwd]))
			.digest("hex")
			.slice(0, 32);
		const config: McpServerConfig = { name, type, scope, source, missingEnv: [], fingerprint };
		if (type === "stdio") {
			if (typeof entry.command !== "string" || !entry.command.trim()) {
				problems.push({ source, message: `${name}: a stdio server needs a \`command\`` });
				continue;
			}
			config.command = x(entry.command);
			if (Array.isArray(entry.args)) config.args = entry.args.filter((a) => typeof a === "string").map((a) => x(a));
			const envRecord = stringRecord(entry.env);
			if (envRecord) config.env = Object.fromEntries(Object.entries(envRecord).map(([k, v]) => [k, x(v)]));
			if (typeof entry.cwd === "string") config.cwd = x(entry.cwd);
		} else {
			if (typeof entry.url !== "string" || !entry.url.trim()) {
				problems.push({ source, message: `${name}: an ${type} server needs a \`url\`` });
				continue;
			}
			config.url = x(entry.url);
			const headers = stringRecord(entry.headers);
			if (headers) config.headers = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, x(v)]));
		}
		if (typeof entry.timeout === "number" && entry.timeout > 0) config.timeout = entry.timeout;
		if (entry.alwaysLoad === true) config.alwaysLoad = true;
		config.missingEnv = [...missing];
		config.written = written;
		if (referenced.size > 0) config.envRefs = [...referenced];
		if (refused.size > 0) {
			config.blockedEnv = [...refused];
			problems.push({
				source,
				message: `${name}: not expanded ${[...refused].map((v) => `\${${v}}`).join(", ")}: a project MCP config can't read variables that look like secrets (allow one with shellEnvironment.include in global settings)`,
			});
		}
		servers.push(config);
	}
	return { servers, problems };
}

/** The project files MCP servers are read from. */
export function projectMcpFiles(cwd: string): string[] {
	return [join(cwd, ".mcp.json"), join(cwd, CONFIG_DIR_NAME, "mcp.json")];
}

export interface McpSources {
	globalSettings: Record<string, unknown>;
	cwd: string;
	projectTrusted: boolean;
	env?: NodeJS.ProcessEnv;
}

/**
 * Whether a project MCP config may not expand `${name}`: RunKiln's own keys and names that look like secrets, by the
 * global shellEnvironment filter (its include list allows a name).
 */
export function projectEnvBlocked(globalSettings: Record<string, unknown>): (name: string) => boolean {
	const raw = globalSettings.shellEnvironment;
	const policy: ShellEnvironmentPolicy =
		raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as ShellEnvironmentPolicy) : {};
	return (name) => filterShellEnv({ [name]: "x" }, { ...policy, inherit: "all" }).hidden.length > 0;
}

export function loadMcpConfig(sources: McpSources): LoadedMcpConfig {
	const env = sources.env ?? process.env;
	const result = parseMcpServers(sources.globalSettings.mcpServers, "global", "global settings", env);
	if (!sources.projectTrusted) return result;
	const names = new Set(result.servers.map((server) => server.name));
	for (const file of projectMcpFiles(sources.cwd)) {
		const { value, error } = readJsonFile(file);
		if (error) result.problems.push({ source: file, message: error });
		if (!value) continue;
		const parsed = parseMcpServers(value.mcpServers, "project", file, env, projectEnvBlocked(sources.globalSettings));
		result.problems.push(...parsed.problems);
		for (const server of parsed.servers) {
			if (names.has(server.name)) {
				result.problems.push({
					source: file,
					message: `${server.name}: already defined; the first definition is used`,
				});
				continue;
			}
			names.add(server.name);
			result.servers.push(server);
		}
	}
	return result;
}

/** MCP settings (`mcp` key in settings). */
export interface McpSettings {
	/** Servers whose tools are declared to the model directly (like `alwaysLoad`). */
	pinned?: string[];
	/** Servers not to start. */
	disabled?: string[];
	/** Milliseconds to wait for a server to start and list its tools. Default 30000. */
	connectTimeoutMs?: number;
	/** Default tool call timeout in milliseconds. Default 120000. */
	toolTimeoutMs?: number;
}

export function readMcpSettings(raw: unknown): McpSettings {
	if (!raw || typeof raw !== "object") return {};
	const value = raw as Record<string, unknown>;
	const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined);
	const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined);
	const settings: McpSettings = {};
	const pinned = list(value.pinned);
	if (pinned) settings.pinned = pinned;
	const disabled = list(value.disabled);
	if (disabled) settings.disabled = disabled;
	const connect = num(value.connectTimeoutMs);
	if (connect) settings.connectTimeoutMs = connect;
	const tool = num(value.toolTimeoutMs);
	if (tool) settings.toolTimeoutMs = tool;
	return settings;
}

/** Tool name the model, permission rules and hooks use: `mcp__<server>__<tool>`, at most 64 characters. */
export function mcpToolName(server: string, tool: string): string {
	const clean = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, "_");
	return `mcp__${clean(server)}__${clean(tool)}`.slice(0, 64);
}
