/**
 * One-time trust for commands a project brings with it: project hooks and project MCP servers.
 *
 * Folder trust (project-trust.ts) decides whether a project's settings are read at all. Hooks and MCP servers run
 * commands, so they need a second, narrower yes: the user approves exactly the commands they were shown. The
 * approval is stored as a fingerprint of those commands per project folder, so editing a hook or server (for
 * example by pulling a commit) asks again. Stored in `<agentDir>/command-trust.json`.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { stripBom } from "../../utils/text.ts";

export type CommandTrustKind = "hooks" | "mcp";

interface TrustFileShape {
	[projectDir: string]: { hooks?: string; mcp?: Record<string, string> } | undefined;
}

export class CommandTrustStore {
	readonly path: string;
	/** Approvals for this process only ("trust for this session"). */
	private readonly session = new Map<string, string>();

	constructor(agentDir: string) {
		this.path = join(agentDir, "command-trust.json");
	}

	private read(): TrustFileShape {
		if (!existsSync(this.path)) return {};
		try {
			const parsed = JSON.parse(stripBom(readFileSync(this.path, "utf8")));
			return parsed && typeof parsed === "object" ? (parsed as TrustFileShape) : {};
		} catch {
			return {};
		}
	}

	private write(data: TrustFileShape): void {
		mkdirSync(dirname(this.path), { recursive: true });
		writeFileSync(this.path, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
	}

	private key(kind: string, projectDir: string, name = ""): string {
		return `${kind}\0${resolve(projectDir)}\0${name}`;
	}

	/** Whether the project's hooks with this fingerprint were approved. */
	isHooksTrusted(projectDir: string, fingerprint: string): boolean {
		if (this.session.get(this.key("hooks", projectDir)) === fingerprint) return true;
		return this.read()[resolve(projectDir)]?.hooks === fingerprint;
	}

	trustHooks(projectDir: string, fingerprint: string, remember: boolean): void {
		this.session.set(this.key("hooks", projectDir), fingerprint);
		if (!remember) return;
		const data = this.read();
		const dir = resolve(projectDir);
		data[dir] = { ...data[dir], hooks: fingerprint };
		this.write(data);
	}

	/** Whether the project MCP server `name` with this fingerprint was approved. */
	isServerTrusted(projectDir: string, name: string, fingerprint: string): boolean {
		if (this.session.get(this.key("mcp", projectDir, name)) === fingerprint) return true;
		return this.read()[resolve(projectDir)]?.mcp?.[name] === fingerprint;
	}

	trustServers(projectDir: string, servers: ReadonlyArray<{ name: string; fingerprint: string }>, remember: boolean) {
		for (const server of servers) this.session.set(this.key("mcp", projectDir, server.name), server.fingerprint);
		if (!remember || servers.length === 0) return;
		const data = this.read();
		const dir = resolve(projectDir);
		const mcp = { ...data[dir]?.mcp };
		for (const server of servers) mcp[server.name] = server.fingerprint;
		data[dir] = { ...data[dir], mcp };
		this.write(data);
	}

	/** Forget every approval for the project (hooks and servers). */
	revoke(projectDir: string, kind?: CommandTrustKind): void {
		for (const key of [...this.session.keys()]) {
			const [k, dir] = key.split("\0");
			if (dir === resolve(projectDir) && (!kind || k === kind)) this.session.delete(key);
		}
		const data = this.read();
		const dir = resolve(projectDir);
		if (!data[dir]) return;
		if (!kind) delete data[dir];
		else delete data[dir]![kind];
		this.write(data);
	}
}
