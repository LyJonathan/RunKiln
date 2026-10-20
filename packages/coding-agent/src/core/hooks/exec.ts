/**
 * Running one command hook: JSON on stdin, exit code and stdout back, Claude Code's rules for reading them.
 */

import { spawn } from "node:child_process";
import {
	getShellConfig,
	getShellEnv,
	killProcessTree,
	trackDetachedChildPid,
	untrackDetachedChildPid,
} from "../../utils/shell.ts";
import type { CommandHook, HookEventName } from "./config.ts";

/** Most bytes of stdout/stderr kept from one hook. */
const MAX_CAPTURE_BYTES = 1024 * 1024;
/** additionalContext, systemMessage and plain stdout are capped like Claude Code's 10,000 characters. */
export const HOOK_TEXT_LIMIT = 10_000;

/** Default timeouts in seconds, as in Claude Code: 600, and 30 for UserPromptSubmit. */
export function defaultHookTimeout(event: HookEventName): number {
	return event === "UserPromptSubmit" ? 30 : 600;
}

export interface HookRunResult {
	exitCode: number | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
	/** The command could not be started. */
	spawnError?: string;
	durationMs: number;
}

export interface HookOutputJson {
	continue?: boolean;
	stopReason?: string;
	suppressOutput?: boolean;
	systemMessage?: string;
	decision?: string;
	reason?: string;
	hookSpecificOutput?: {
		hookEventName?: string;
		permissionDecision?: "allow" | "deny" | "ask" | "defer";
		permissionDecisionReason?: string;
		updatedInput?: Record<string, unknown>;
		additionalContext?: string;
		updatedToolOutput?: unknown;
	};
}

/** What one hook run means. */
export interface HookOutcome {
	kind: "success" | "block" | "error";
	/** Parsed JSON output, when stdout was one JSON object. */
	json?: HookOutputJson;
	/** Plain stdout (exit 0, not JSON). */
	text?: string;
	/** Why it blocked (stderr on exit 2, or the JSON reason). */
	reason?: string;
	/** For "error": a one-line notice. */
	error?: string;
}

export interface RunHookOptions {
	cwd: string;
	event: HookEventName;
	signal?: AbortSignal;
	env?: NodeJS.ProcessEnv;
}

function cap(text: string, limit: number): string {
	return text.length > limit ? `${text.slice(0, limit)}\n[truncated: ${text.length - limit} more characters]` : text;
}

/** Spawn one hook and collect its output. Never throws. */
export function runCommandHook(hook: CommandHook, input: unknown, options: RunHookOptions): Promise<HookRunResult> {
	const started = Date.now();
	const timeoutMs = (hook.timeout ?? defaultHookTimeout(options.event)) * 1000;
	const env = {
		...getShellEnv(),
		...options.env,
		RUNKILN_PROJECT_DIR: options.cwd,
		// Claude Code's name, so hook scripts written for it find the project.
		CLAUDE_PROJECT_DIR: options.cwd,
	};
	const expand = (value: string) =>
		value.replace(/\$\{(RUNKILN_PROJECT_DIR|CLAUDE_PROJECT_DIR)\}/g, () => options.cwd);
	return new Promise((resolvePromise) => {
		let child: ReturnType<typeof spawn>;
		try {
			if (hook.args) {
				child = spawn(expand(hook.command), hook.args.map(expand), {
					cwd: options.cwd,
					env,
					detached: process.platform !== "win32",
					stdio: ["pipe", "pipe", "pipe"],
					windowsHide: true,
				});
			} else {
				const shell =
					process.platform === "win32"
						? getShellConfig()
						: { shell: "/bin/sh", args: ["-c"], commandTransport: "argv" };
				const viaStdin = shell.commandTransport === "stdin";
				child = spawn(shell.shell, viaStdin ? shell.args : [...shell.args, hook.command], {
					cwd: options.cwd,
					env,
					detached: process.platform !== "win32",
					stdio: ["pipe", "pipe", "pipe"],
					windowsHide: true,
				});
			}
		} catch (error) {
			resolvePromise({
				exitCode: null,
				stdout: "",
				stderr: "",
				timedOut: false,
				spawnError: error instanceof Error ? error.message : String(error),
				durationMs: Date.now() - started,
			});
			return;
		}
		if (child.pid) trackDetachedChildPid(child.pid);
		const out: Buffer[] = [];
		const err: Buffer[] = [];
		let outBytes = 0;
		let errBytes = 0;
		let timedOut = false;
		let settled = false;
		child.stdout?.on("data", (chunk: Buffer) => {
			if (outBytes < MAX_CAPTURE_BYTES) out.push(chunk);
			outBytes += chunk.length;
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			if (errBytes < MAX_CAPTURE_BYTES) err.push(chunk);
			errBytes += chunk.length;
		});
		const kill = () => {
			if (child.pid) killProcessTree(child.pid);
		};
		const timer = setTimeout(() => {
			timedOut = true;
			kill();
		}, timeoutMs);
		const onAbort = () => kill();
		options.signal?.addEventListener("abort", onAbort, { once: true });
		const finish = (exitCode: number | null, spawnError?: string) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", onAbort);
			if (child.pid) untrackDetachedChildPid(child.pid);
			resolvePromise({
				exitCode,
				stdout: Buffer.concat(out).toString("utf8"),
				stderr: Buffer.concat(err).toString("utf8"),
				timedOut,
				...(spawnError ? { spawnError } : {}),
				durationMs: Date.now() - started,
			});
		};
		child.on("error", (error) => finish(null, error.message));
		child.on("close", (code) => finish(code));
		child.stdin?.on("error", () => {});
		const stdinText = `${JSON.stringify(input)}\n`;
		if (!hook.args && process.platform === "win32" && getShellConfig().commandTransport === "stdin") {
			child.stdin?.end(`${hook.command}\n`);
		} else {
			child.stdin?.end(stdinText);
		}
	});
}

/** Parse stdout as Claude Code does: one JSON object with only whitespace around it, else plain text. */
export function parseHookStdout(stdout: string): { json?: HookOutputJson; text?: string; parseError?: string } {
	const trimmed = stdout.trim();
	if (!trimmed) return {};
	if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return { text: trimmed };
	try {
		const parsed = JSON.parse(trimmed);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { text: trimmed };
		return { json: parsed as HookOutputJson };
	} catch (error) {
		// Several JSON lines that are each objects but set no field count as plain text in Claude Code; keep it simple.
		const lines = trimmed.split(/\r?\n/);
		if (lines.length > 1 && lines.every((line) => line.trim().startsWith("{") || line.trim() === "")) {
			return { text: trimmed };
		}
		return { parseError: error instanceof Error ? error.message : String(error) };
	}
}

/**
 * Exit code and stdout to an outcome (Claude Code's table): exit 0 with JSON applies the fields; exit 2 blocks with
 * stderr (JSON still read, a JSON reason wins); any other exit is a non-blocking error unless stdout is valid JSON,
 * in which case the JSON decides. `onFailure: "block"` turns a failure (cannot start, timeout, other exit code,
 * invalid JSON) into a block.
 */
export function interpretHookRun(hook: CommandHook, run: HookRunResult): HookOutcome {
	const label = hook.args ? [hook.command, ...hook.args].join(" ") : hook.command;
	const fail = (message: string): HookOutcome =>
		hook.onFailure === "block"
			? { kind: "block", reason: `[${label}]: ${message}; blocking because onFailure is "block"` }
			: { kind: "error", error: `[${label}]: ${message}` };
	if (run.spawnError) return fail(`failed to start: ${run.spawnError}`);
	if (run.timedOut) return fail(`timed out after ${hook.timeout ?? "the default"} seconds`);
	const parsed = parseHookStdout(run.stdout);
	const firstStderr = run.stderr.trim().split(/\r?\n/)[0] ?? "";
	if (run.exitCode === 2) {
		const jsonReason = parsed.json?.hookSpecificOutput?.permissionDecisionReason ?? parsed.json?.reason;
		const reason = cap((jsonReason ?? run.stderr.trim()) || "blocked by hook", HOOK_TEXT_LIMIT);
		return { kind: "block", ...(parsed.json ? { json: parsed.json } : {}), reason };
	}
	if (parsed.parseError) return fail(`invalid JSON output: ${parsed.parseError}`);
	if (run.exitCode !== 0) {
		if (parsed.json && hook.onFailure !== "block") return { kind: "success", json: parsed.json };
		return fail(`failed with non-blocking status code ${run.exitCode}${firstStderr ? `: ${firstStderr}` : ""}`);
	}
	if (parsed.json) return { kind: "success", json: parsed.json };
	return { kind: "success", ...(parsed.text ? { text: cap(parsed.text, HOOK_TEXT_LIMIT) } : {}) };
}

/** Cap a context string from a hook and neutralise system-reminder tags, as Claude Code does. */
export function sanitizeHookContext(text: string): string {
	return cap(text.replace(/<(\/?system-reminder)/gi, "&lt;$1"), HOOK_TEXT_LIMIT);
}
