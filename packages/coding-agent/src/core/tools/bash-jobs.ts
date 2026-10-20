/**
 * Background shell jobs: `bash` with `background: true` starts a command and returns a job id at once; `bash_output`
 * reads what the job printed since the last read (optionally only lines matching a filter), waits for more, or kills
 * it. For dev servers, watchers and other commands that never exit on their own.
 *
 * Each job keeps the last {@link DEFAULT_JOB_BUFFER_BYTES} of output (older output is dropped and the read says so).
 * Jobs are process groups tracked like every detached child, so they die with RunKiln; the session also kills them
 * when it ends. A foreground command that looks long-running (`npm run dev`, `vite`, `--watch`…) and is still
 * running after `autoBackgroundSeconds` is moved to the background instead of holding the turn.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { constants as osConstants } from "node:os";
import { Type } from "typebox";
import { getShellConfig, killProcessTree, trackDetachedChildPid, untrackDetachedChildPid } from "../../utils/shell.ts";
import type { ToolDefinition } from "../extensions/types.ts";

export const BASH_OUTPUT_TOOL_NAME = "bash_output";
/** Output a job keeps (the tail). */
export const DEFAULT_JOB_BUFFER_BYTES = 256 * 1024;
/** Most output one read returns to the model. */
export const READ_LIMIT_BYTES = 16 * 1024;
/** Default seconds a likely long-running foreground command may run before it moves to the background. */
export const DEFAULT_AUTO_BACKGROUND_SECONDS = 20;
/** Most seconds `bash_output` waits for new output. */
export const MAX_WAIT_SECONDS = 60;
/** Most jobs kept (finished ones are dropped first). */
const MAX_JOBS = 20;

export type JobStatus = "running" | "exited" | "killed" | "failed";

export interface JobInfo {
	id: string;
	command: string;
	cwd: string;
	pid?: number;
	status: JobStatus;
	exitCode?: number | null;
	startedAt: number;
	endedAt?: number;
	/** Total bytes the job printed. */
	totalBytes: number;
	/** Bytes not read yet by bash_output. */
	unreadBytes: number;
	/** Last non-empty output line, for listings. */
	lastLine: string;
	/** Started by the agent (`background: true`) or moved there automatically. */
	origin: "background" | "auto";
}

interface Job extends JobInfo {
	child?: ChildProcess;
	/** Kept output (the tail of everything printed). */
	buffer: string;
	/** Absolute byte offset of buffer[0] in the job's whole output. */
	bufferStart: number;
	/** Absolute offset read so far. */
	readOffset: number;
	waiters: Set<() => void>;
	exited: Promise<void>;
}

const LONG_RUNNING_PATTERNS: readonly RegExp[] = [
	/\b(npm|pnpm|yarn|bun)\s+(run\s+)?(dev|start|serve|watch|preview)\b/,
	/\bnpx\s+(vite|next\s+dev|nodemon|serve|http-server|webpack\s+serve)\b/,
	/(^|[\s;&|(])(vite|nodemon|webpack-dev-server|http-server|live-server)(\s|$)/,
	/\bnext\s+dev\b/,
	/\b(tsc|jest|vitest|webpack|rollup|esbuild|cargo\s+watch|tailwindcss)\b[^\n]*\s--watch\b/,
	/(^|\s)--watch(\s|=|$)/,
	/\bvitest\b(?![^\n]*\b(run|--run)\b)/,
	/\bpython3?\s+-m\s+http\.server\b/,
	/\b(flask|uvicorn|gunicorn)\s+/,
	/\bmanage\.py\s+runserver\b/,
	/\brails\s+s(erver)?\b/,
	/\bdocker(-compose|\s+compose)\s+up\b(?![^\n]*\s-d\b)/,
	/\btail\s+-f\b/,
	/\bwatchexec\b|\bentr\b/,
];

/** Whether a command probably never exits on its own (dev server, watcher). Best effort. */
export function looksLongRunning(command: string): boolean {
	const text = command.trim();
	if (!text || /&\s*$/.test(text)) return false;
	return LONG_RUNNING_PATTERNS.some((pattern) => pattern.test(text));
}

export interface JobManagerOptions {
	bufferBytes?: number;
	shellPath?: string;
}

export class JobManager {
	private readonly jobs = new Map<string, Job>();
	private next = 1;
	private readonly listeners = new Set<() => void>();
	readonly bufferBytes: number;
	private readonly shellPath?: string;

	constructor(options: JobManagerOptions = {}) {
		this.bufferBytes = options.bufferBytes ?? DEFAULT_JOB_BUFFER_BYTES;
		this.shellPath = options.shellPath;
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

	/** Start a command as a job. */
	start(command: string, cwd: string, env: NodeJS.ProcessEnv, origin: JobInfo["origin"] = "background"): JobInfo {
		this.prune();
		const id = `job-${this.next++}`;
		const shell = getShellConfig(this.shellPath);
		const viaStdin = shell.commandTransport === "stdin";
		let resolveExit!: () => void;
		const job: Job = {
			id,
			command,
			cwd,
			status: "running",
			startedAt: Date.now(),
			totalBytes: 0,
			unreadBytes: 0,
			lastLine: "",
			origin,
			buffer: "",
			bufferStart: 0,
			readOffset: 0,
			waiters: new Set(),
			exited: new Promise<void>((resolve) => {
				resolveExit = resolve;
			}),
		};
		this.jobs.set(id, job);
		let child: ChildProcess;
		try {
			child = spawn(shell.shell, viaStdin ? shell.args : [...shell.args, command], {
				cwd,
				env,
				detached: process.platform !== "win32",
				stdio: [viaStdin ? "pipe" : "ignore", "pipe", "pipe"],
				windowsHide: true,
			});
		} catch (error) {
			job.status = "failed";
			job.endedAt = Date.now();
			this.append(job, `Failed to start: ${error instanceof Error ? error.message : String(error)}\n`);
			resolveExit();
			this.changed();
			return this.info(job);
		}
		job.child = child;
		job.pid = child.pid;
		if (viaStdin) {
			child.stdin?.on("error", () => {});
			child.stdin?.end(command);
		}
		if (child.pid) trackDetachedChildPid(child.pid);
		const onData = (chunk: Buffer) => this.append(job, chunk.toString("utf8"));
		child.stdout?.on("data", onData);
		child.stderr?.on("data", onData);
		child.once("error", (error) => {
			if (job.status === "running") job.status = "failed";
			this.append(job, `\n${error.message}\n`);
		});
		child.once("close", (code, signal) => {
			if (child.pid) untrackDetachedChildPid(child.pid);
			if (job.status === "running") job.status = "exited";
			job.exitCode = code ?? (signal ? 128 + (osConstants.signals[signal] ?? 0) : null);
			job.endedAt = Date.now();
			job.child = undefined;
			this.wake(job);
			resolveExit();
			this.changed();
		});
		this.changed();
		return this.info(job);
	}

	private append(job: Job, text: string): void {
		if (!text) return;
		job.buffer += text;
		job.totalBytes += Buffer.byteLength(text);
		const lines = text.split(/\r?\n/).filter((line) => line.trim());
		if (lines.length > 0) job.lastLine = lines[lines.length - 1]!.slice(0, 200);
		if (job.buffer.length > this.bufferBytes) {
			const drop = job.buffer.length - this.bufferBytes;
			job.buffer = job.buffer.slice(drop);
			job.bufferStart += drop;
		}
		this.wake(job);
	}

	private wake(job: Job): void {
		for (const waiter of job.waiters) waiter();
		job.waiters.clear();
	}

	/** Drop finished jobs beyond the limit, oldest first. */
	private prune(): void {
		if (this.jobs.size < MAX_JOBS) return;
		for (const job of [...this.jobs.values()].sort((a, b) => a.startedAt - b.startedAt)) {
			if (this.jobs.size < MAX_JOBS) break;
			if (job.status !== "running") this.jobs.delete(job.id);
		}
	}

	private info(job: Job): JobInfo {
		return {
			id: job.id,
			command: job.command,
			cwd: job.cwd,
			...(job.pid !== undefined ? { pid: job.pid } : {}),
			status: job.status,
			...(job.exitCode !== undefined ? { exitCode: job.exitCode } : {}),
			startedAt: job.startedAt,
			...(job.endedAt !== undefined ? { endedAt: job.endedAt } : {}),
			totalBytes: job.totalBytes,
			unreadBytes: Math.max(0, job.bufferStart + job.buffer.length - Math.max(job.readOffset, job.bufferStart)),
			lastLine: job.lastLine,
			origin: job.origin,
		};
	}

	list(): JobInfo[] {
		return [...this.jobs.values()].map((job) => this.info(job));
	}

	get(id: string): JobInfo | undefined {
		const job = this.jobs.get(this.resolveId(id));
		return job ? this.info(job) : undefined;
	}

	get runningCount(): number {
		return [...this.jobs.values()].filter((job) => job.status === "running").length;
	}

	/** Accept "job-3", "3" or "%3". */
	resolveId(id: string): string {
		const trimmed = id.trim().replace(/^%/, "");
		return /^\d+$/.test(trimmed) ? `job-${trimmed}` : trimmed;
	}

	/** Wait until the job prints something new or exits, at most `ms`. */
	async waitForOutput(id: string, ms: number, signal?: AbortSignal): Promise<void> {
		const job = this.jobs.get(this.resolveId(id));
		if (!job || job.status !== "running" || ms <= 0) return;
		if (job.bufferStart + job.buffer.length > job.readOffset) return;
		await new Promise<void>((resolve) => {
			const done = () => {
				clearTimeout(timer);
				signal?.removeEventListener("abort", done);
				job.waiters.delete(done);
				resolve();
			};
			const timer = setTimeout(done, ms);
			job.waiters.add(done);
			signal?.addEventListener("abort", done, { once: true });
		});
	}

	/** Wait for the job to exit, at most `ms`. Returns whether it exited. */
	async waitForExit(id: string, ms: number): Promise<boolean> {
		const job = this.jobs.get(this.resolveId(id));
		if (!job) return true;
		if (job.status !== "running") return true;
		let timer: NodeJS.Timeout | undefined;
		const exited = await Promise.race([
			job.exited.then(() => true),
			new Promise<boolean>((resolve) => {
				timer = setTimeout(() => resolve(false), ms);
			}),
		]);
		if (timer) clearTimeout(timer);
		return exited;
	}

	/**
	 * Output since the last read. With `filter`, only matching lines are returned (all new output still counts as
	 * read). Long output keeps its tail.
	 */
	read(
		id: string,
		options: { filter?: RegExp; limitBytes?: number } = {},
	): { text: string; dropped: number; truncated: number } {
		const job = this.jobs.get(this.resolveId(id));
		if (!job) return { text: "", dropped: 0, truncated: 0 };
		const end = job.bufferStart + job.buffer.length;
		const from = Math.max(job.readOffset, job.bufferStart);
		const dropped = Math.max(0, job.bufferStart - job.readOffset);
		let text = job.buffer.slice(from - job.bufferStart);
		// Only whole lines while running, so a filter never sees half a line; the rest is read next time.
		let consumedTo = end;
		if (job.status === "running") {
			const lastNewline = text.lastIndexOf("\n");
			if (lastNewline >= 0 && lastNewline < text.length - 1 && text.length - lastNewline < 4096) {
				consumedTo = from + lastNewline + 1;
				text = text.slice(0, lastNewline + 1);
			}
		}
		job.readOffset = consumedTo;
		if (options.filter) {
			const filter = options.filter;
			text = text
				.split(/\r?\n/)
				.filter((line) => filter.test(line))
				.join("\n");
		}
		const limit = options.limitBytes ?? READ_LIMIT_BYTES;
		let truncated = 0;
		if (text.length > limit) {
			truncated = text.length - limit;
			text = text.slice(-limit);
		}
		return { text, dropped, truncated };
	}

	/** The last `lines` lines a job printed (does not count as read). */
	tail(id: string, lines = 40): string {
		const job = this.jobs.get(this.resolveId(id));
		if (!job) return "";
		return job.buffer
			.split(/\r?\n/)
			.slice(-lines - 1)
			.join("\n")
			.replace(/\s+$/, "");
	}

	/** Kill a job (its whole process group). */
	kill(id: string): JobInfo | undefined {
		const job = this.jobs.get(this.resolveId(id));
		if (!job) return undefined;
		if (job.status === "running") {
			job.status = "killed";
			if (job.pid) killProcessTree(job.pid);
			this.changed();
		}
		return this.info(job);
	}

	/** Kill every running job (session end). */
	killAll(): number {
		let count = 0;
		for (const job of this.jobs.values()) {
			if (job.status !== "running") continue;
			job.status = "killed";
			if (job.pid) killProcessTree(job.pid);
			count++;
		}
		if (count > 0) this.changed();
		return count;
	}
}

/** How long a job ran (or has been running): "45s", "3m07s". */
export function jobDuration(job: JobInfo, now = Date.now()): string {
	const seconds = Math.max(0, Math.round(((job.endedAt ?? now) - job.startedAt) / 1000));
	return seconds >= 60 ? `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s` : `${seconds}s`;
}

/** Short status line for a job: "job-2 running 1m03s npm run dev". */
export function describeJob(job: JobInfo, now = Date.now()): string {
	const time = jobDuration(job, now);
	const state =
		job.status === "exited" ? `exited ${job.exitCode ?? "?"}` : job.status === "running" ? "running" : job.status;
	return `${job.id} ${state} ${time} ${job.command.split("\n")[0]!.slice(0, 80)}`;
}

/** A job's status and new output as tool text. */
export function formatJobRead(
	job: JobInfo,
	read: { text: string; dropped: number; truncated: number },
	filter?: string,
): string {
	const lines = [`[${describeJob(job)}${job.pid ? ` - pid ${job.pid}` : ""}]`];
	if (read.dropped > 0) lines.push(`[${read.dropped} bytes of older output were dropped (buffer cap)]`);
	if (read.truncated > 0)
		lines.push(`[showing the last part; ${read.truncated} earlier characters of this read not shown]`);
	const body = read.text.replace(/\s+$/, "");
	lines.push(body ? body : filter ? `(no new lines match /${filter}/)` : "(no new output)");
	return lines.join("\n");
}

const bashOutputSchema = Type.Object({
	job_id: Type.String({ description: "Job id from bash background, e.g. job-1" }),
	filter: Type.Optional(Type.String({ description: "Regex: only return matching lines" })),
	wait: Type.Optional(Type.Number({ description: `Seconds to wait for new output (max ${MAX_WAIT_SECONDS})` })),
	kill: Type.Optional(Type.Boolean({ description: "Stop the job" })),
});

export function createBashOutputToolDefinition(jobs: JobManager): ToolDefinition<typeof bashOutputSchema> {
	return {
		name: BASH_OUTPUT_TOOL_NAME,
		label: "bash_output",
		description:
			"Read new output of a background bash job (bash with background: true), optionally wait for it, or kill it.",
		promptSnippet: "Read or stop background bash jobs",
		parameters: bashOutputSchema,
		async execute(_id, params, signal) {
			const job = jobs.get(params.job_id);
			if (!job) {
				const known = jobs.list().map((j) => describeJob(j));
				return {
					content: [
						{
							type: "text",
							text: `No job ${params.job_id}.${known.length ? ` Jobs:\n${known.join("\n")}` : " No jobs."}`,
						},
					],
					details: undefined,
					isError: true,
				};
			}
			let filter: RegExp | undefined;
			if (params.filter) {
				try {
					filter = new RegExp(params.filter, "i");
				} catch (error) {
					return {
						content: [
							{
								type: "text",
								text: `Invalid filter: ${error instanceof Error ? error.message : String(error)}`,
							},
						],
						details: undefined,
						isError: true,
					};
				}
			}
			if (params.kill) {
				jobs.kill(job.id);
				await jobs.waitForExit(job.id, 2000);
			} else if (params.wait && params.wait > 0) {
				await jobs.waitForOutput(job.id, Math.min(params.wait, MAX_WAIT_SECONDS) * 1000, signal);
			}
			const read = jobs.read(job.id, filter ? { filter } : {});
			const now = jobs.get(job.id)!;
			return {
				content: [{ type: "text", text: formatJobRead(now, read, params.filter) }],
				details: { job: now },
			};
		},
	};
}
