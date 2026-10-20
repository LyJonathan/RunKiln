/**
 * Markdown for /hooks, /mcp and /jobs. Kept out of interactive-mode.ts so they can be tested and rendered without a
 * terminal.
 */

import { HOOK_EVENTS } from "../../core/hooks/config.ts";
import type { HookManager } from "../../core/hooks/manager.ts";
import type { McpManager } from "../../core/mcp/manager.ts";
import { hookTrustLine, mcpTrustLines } from "../../core/runkiln/trust-display.ts";
import { type JobInfo, type JobManager, jobDuration } from "../../core/tools/bash-jobs.ts";
import { toPosixRelative } from "../../utils/paths.ts";

function cell(text: string): string {
	return text.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function code(text: string): string {
	return `\`${text.replace(/`/g, "'")}\``;
}

/** Text cut to `max` characters, with an ellipsis when it was cut. */
function clip(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function shortPath(path: string, cwd: string): string {
	const rel = toPosixRelative(cwd, path);
	return rel && rel !== "." ? rel : path;
}

/** Lines in a code fence longer than any backtick run inside them, so file text cannot close it early. */
function fenced(body: readonly string[]): string[] {
	const longest = Math.max(
		0,
		...body.map((line) => Math.max(0, ...(line.match(/`+/g) ?? []).map((run) => run.length))),
	);
	const fence = "`".repeat(Math.max(3, longest + 1));
	return [fence, ...body, fence];
}

/** /hooks: every configured hook, by event, with where it comes from and whether it runs. */
export function buildHooksMarkdown(hooks: HookManager): string {
	const config = hooks.config;
	if (config.disabled) return "All hooks are off (`disableAllHooks: true` in global settings).";
	const trusted = hooks.projectHooksTrusted;
	const lines: string[] = [];
	if (config.entries.length === 0) {
		lines.push(
			"No hooks configured.",
			"",
			'Add them under `hooks` in `~/.runkiln/agent/settings.json` or the project\'s `.runkiln/settings.json`, in Claude Code\'s format: `{ "PostToolUse": [{ "matcher": "edit|write", "hooks": [{ "type": "command", "command": "npx biome format --write ." }] }] }`.',
		);
	} else {
		lines.push("| Event | Matcher | Command | Time | From | Runs |", "|---|---|---|---|---|---|");
		for (const event of HOOK_EVENTS) {
			for (const entry of config.entries.filter((e) => e.event === event)) {
				const command = entry.hook.args ? [entry.hook.command, ...entry.hook.args].join(" ") : entry.hook.command;
				const runs = entry.scope === "global" || trusted ? "✓" : "◇";
				lines.push(
					`| ${event} | ${code(cell(entry.matcher || "*"))}${entry.hook.if ? ` if ${code(cell(entry.hook.if))}` : ""} | ${code(cell(clip(command, 70)))} | ${entry.hook.timeout ?? (event === "UserPromptSubmit" ? 30 : 600)}s | ${entry.scope} | ${runs} |`,
				);
			}
		}
	}
	const files = [
		...new Set(config.entries.filter((e) => e.scope !== "global").map((e) => shortPath(e.source, hooks.cwd))),
	];
	if (files.length > 0) lines.push("", `Project hooks from ${files.map(code).join(", ")}.`);
	if (!trusted) {
		lines.push(
			"",
			"◇ **Project hooks need your OK** before they run (they are commands from the repository). `/hooks trust` approves exactly these commands; a changed command asks again.",
		);
		const pending = config.entries.filter((e) => e.scope !== "global");
		if (pending.length > 0) lines.push("", "Full commands:", ...fenced(pending.map((entry) => hookTrustLine(entry))));
	}
	if (config.skipped > 0) {
		lines.push(
			"",
			`${config.skipped} hook(s) of another type (http, prompt, agent, mcp_tool) are ignored: only \`command\` hooks run.`,
		);
	}
	for (const problem of config.problems)
		lines.push("", `! ${cell(shortPath(problem.source, hooks.cwd))}: ${cell(problem.message)}`);
	lines.push("", "`/hooks trust` - `/hooks untrust` - `/hooks reload`");
	return lines.join("\n");
}

/** /mcp: servers, status, tools and how they reach the model. */
export function buildMcpMarkdown(mcp: McpManager, options: { toolsOf?: string } = {}): string {
	const servers = mcp.servers();
	if (servers.length === 0) {
		return [
			"No MCP servers configured.",
			"",
			'Add a project `.mcp.json` (`{ "mcpServers": { "docs": { "command": "npx", "args": ["-y", "docs-mcp"] } } }`) or `mcpServers` in `~/.runkiln/agent/settings.json`. Remote servers: `{ "type": "http", "url": "https://…/mcp" }`.',
		].join("\n");
	}
	const icon: Record<string, string> = {
		connected: "● connected",
		connecting: "◌ connecting",
		failed: "✗ failed",
		"needs-trust": "◇ needs trust",
		disabled: "○ disabled",
		closed: "○ stopped",
	};
	// Short cells so the table fits 80 columns without breaking words; the legend below explains "Via".
	const lines = ["| Server | Status | Transport | Tools | Via | From |", "|---|---|---|---|---|---|"];
	for (const state of servers) {
		const c = state.config;
		// Paths shortened to their last part (scoped package names kept): the full command is in the config file.
		const base = (part: string) =>
			part.includes("/") && !part.includes("://") && !part.startsWith("@") ? part.split("/").pop()! : part;
		// A remote server shows its host only: a long URL is one unbreakable word that squeezes every other column.
		const host = (url: string) => {
			try {
				return new URL(url).host || url;
			} catch {
				return url;
			}
		};
		const target = c.type === "stdio" ? [c.command ?? "", ...(c.args ?? [])].map(base).join(" ") : host(c.url ?? "");
		lines.push(
			`| **${cell(c.name)}** | ${icon[state.status] ?? state.status} | ${state.transport ?? c.type} ${code(cell(target.slice(0, 40)))} | ${state.status === "connected" ? state.tools.length : "-"} | ${state.pinned ? "direct" : "`mcp`"} | ${c.scope === "global" ? "global" : cell(shortPath(c.source, mcp.cwd))} |`,
		);
	}
	for (const state of servers) {
		if (state.error) lines.push("", `✗ **${cell(state.config.name)}**: ${cell(state.error.slice(0, 300))}`);
		if (state.config.missingEnv.length > 0)
			lines.push(
				"",
				`! **${cell(state.config.name)}**: unset variables ${state.config.missingEnv.map(code).join(", ")}`,
			);
	}
	const shown = options.toolsOf ? servers.filter((s) => s.config.name === options.toolsOf) : servers;
	const toolLines: string[] = [];
	for (const state of shown) {
		if (state.status !== "connected" || state.tools.length === 0) continue;
		const names = state.tools.map((tool) => tool.name);
		const limit = options.toolsOf ? names.length : 12;
		toolLines.push(
			`- **${cell(state.config.name)}**: ${names.slice(0, limit).map(code).join(", ")}${names.length > limit ? ` … +${names.length - limit} (\`/mcp tools ${state.config.name}\`)` : ""}`,
		);
	}
	if (toolLines.length > 0)
		lines.push("", "**Tools** (permission rules name them `mcp__<server>__<tool>`)", ...toolLines);
	lines.push(
		"",
		"Via `mcp`: the model reaches the tools through the `mcp` tool. Direct: declared to the model (pinned).",
	);
	const untrusted = servers.filter((s) => s.status === "needs-trust");
	if (untrusted.length > 0) {
		lines.push("", "**Project servers need your OK** before they start. `/mcp trust` approves them.");
		lines.push("", ...fenced(untrusted.flatMap((s) => mcpTrustLines(s.config))));
	}
	for (const problem of mcp.problems)
		lines.push("", `! ${cell(shortPath(problem.source, mcp.cwd))}: ${cell(problem.message)}`);
	lines.push("", "`/mcp reconnect <server|all>` - `/mcp tools <server>` - `/mcp trust`");
	return lines.join("\n");
}

/** /jobs: background jobs, newest first. */
export function buildJobsMarkdown(jobs: JobManager | readonly JobInfo[], now = Date.now()): string {
	const list = [...(Array.isArray(jobs) ? jobs : (jobs as JobManager).list())].sort(
		(a, b) => b.startedAt - a.startedAt,
	);
	if (list.length === 0) {
		return "No background jobs. The agent starts one with `bash` and `background: true` (dev servers, watchers); a command that looks long-running is moved here after 20s.";
	}
	const lines = ["| Job | Status | Time | PID | Command | Last output |", "|---|---|---|---|---|---|"];
	for (const job of list) {
		const status = job.status === "exited" ? `exited ${job.exitCode ?? "?"}` : job.status;
		lines.push(
			`| **${job.id}**${job.origin === "auto" ? " (auto)" : ""} | ${status} | ${jobDuration(job, now)} | ${job.pid ?? "–"} | ${code(cell(clip(job.command.split("\n")[0]!, 48)))} | ${cell(clip(job.lastLine, 60)) || "–"} |`,
		);
	}
	lines.push("", "`/jobs kill <id|all>` - `/jobs <id>` shows its recent output - jobs stop when RunKiln exits");
	return lines.join("\n");
}
