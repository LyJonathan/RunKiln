/**
 * What the hook and MCP trust prompts show: everything that will run, as written in the project file. A hook shows
 * its command and every argument; an MCP server shows its command and arguments or its URL, its working directory,
 * its env values, its header names and values, and the `${VAR}` names it reads. Values are shown as written, before
 * `${VAR}` expansion, so the prompt never prints a secret. Every piece goes through sanitizeForPrompt, so escape
 * sequences and bidi or invisible characters in a project file cannot repaint or hide part of the prompt.
 */

import type { CommandHook } from "../hooks/config.ts";
import type { McpServerConfig } from "../mcp/config.ts";
import { sanitizeForPrompt } from "./approval.ts";

/** Longest piece shown; the rest is counted. */
const MAX_PIECE = 400;

function shown(text: string): string {
	const clean = sanitizeForPrompt(text);
	const chars = [...clean];
	if (chars.length <= MAX_PIECE) return clean;
	return `${chars.slice(0, MAX_PIECE).join("")}... (${chars.length - MAX_PIECE} more characters)`;
}

/** An argument as it would be typed: quoted when it holds spaces, quotes or nothing. */
function arg(text: string): string {
	return text === "" || /[\s"'\\]/.test(text) ? shown(JSON.stringify(text)) : shown(text);
}

/** `command arg1 "arg 2"`, sanitized. */
export function commandLine(command: string, args: readonly string[] = []): string {
	return [shown(command), ...args.map(arg)].join(" ");
}

/** One hook's line for the trust prompt: `event [matcher]: command args`. */
export function hookTrustLine(entry: { event: string; matcher?: string; hook: CommandHook }): string {
	const where = `${shown(entry.event)}${entry.matcher ? ` [${shown(entry.matcher)}]` : ""}`;
	const what = entry.hook.args ? commandLine(entry.hook.command, entry.hook.args) : shown(entry.hook.command);
	return `  ${where}: ${what}`;
}

/** One MCP server's lines for the trust prompt. */
export function mcpTrustLines(config: McpServerConfig): string[] {
	const written = config.written ?? {
		command: config.command,
		args: config.args,
		env: config.env,
		cwd: config.cwd,
		url: config.url,
		headers: config.headers,
	};
	const lines: string[] = [];
	if (config.type === "stdio") {
		lines.push(`  ${shown(config.name)}: ${commandLine(written.command ?? "", written.args ?? [])}`);
		if (written.cwd) lines.push(`    cwd: ${shown(written.cwd)}`);
		for (const [key, value] of Object.entries(written.env ?? {})) lines.push(`    env ${shown(key)}=${arg(value)}`);
	} else {
		lines.push(`  ${shown(config.name)}: ${shown(config.type)} ${shown(written.url ?? "")}`);
		for (const [key, value] of Object.entries(written.headers ?? {})) {
			lines.push(`    header ${shown(key)}: ${shown(value)}`);
		}
	}
	// A blocked name is listed once, on its own line below, rather than as read and then as not expanded.
	const blocked = new Set(config.blockedEnv ?? []);
	const reads = (config.envRefs ?? []).filter((name) => !blocked.has(name));
	if (reads.length > 0) {
		lines.push(`    reads your environment: ${reads.map((name) => `\${${shown(name)}}`).join(", ")}`);
	}
	if (config.blockedEnv && config.blockedEnv.length > 0) {
		lines.push(
			`    not expanded (look like secrets): ${config.blockedEnv.map((name) => `\${${shown(name)}}`).join(", ")}`,
		);
	}
	return lines;
}
