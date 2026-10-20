import { constants } from "node:fs";
import { access as fsAccess } from "node:fs/promises";
import { constants as osConstants } from "node:os";
import type { AgentTool } from "@runkiln/agent-core";
import { spawn } from "child_process";
import { type Static, Type } from "typebox";
import { waitForChildProcess } from "../../utils/child-process.ts";
import {
	getShellConfig,
	getShellEnv,
	killProcessTree,
	type ShellConfig,
	trackDetachedChildPid,
	untrackDetachedChildPid,
} from "../../utils/shell.ts";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";
import {
	DEFAULT_AUTO_BACKGROUND_SECONDS,
	describeJob,
	formatJobRead,
	type JobManager,
	looksLongRunning,
} from "./bash-jobs.ts";
import { CONDENSE_MAX_BYTES, CONDENSE_MAX_LINES, condenseOutput } from "./condense-output.ts";
import { OutputAccumulator } from "./output-accumulator.ts";
import { BASH_UPDATE_THROTTLE_MS, createShellRenderers } from "./renderers/bash.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import { formatSize, type TruncationResult } from "./truncate.ts";

const MAX_TIMEOUT_MS = 2_147_483_647;
/** Output limit of `structuredContent.output`, which programmatic callers such as codemode scripts receive. */
const STRUCTURED_OUTPUT_MAX_BYTES = 1024 * 1024;
/** Output scanned for error-looking lines when condensing; longer output keeps its two ends. */
const CONDENSE_SCAN_MAX_BYTES = 8 * 1024 * 1024;
const MAX_TIMEOUT_SECONDS = MAX_TIMEOUT_MS / 1000;

function resolveTimeoutMs(timeout: number | undefined): number | undefined {
	if (timeout === undefined) return undefined;
	if (!Number.isFinite(timeout) || timeout <= 0) {
		throw new Error("Invalid timeout: must be a finite number of seconds");
	}

	const timeoutMs = timeout * 1000;
	if (timeoutMs > MAX_TIMEOUT_MS) {
		throw new Error(`Invalid timeout: maximum is ${MAX_TIMEOUT_SECONDS} seconds`);
	}
	return timeoutMs;
}

const foregroundShellSchema = Type.Object({
	command: Type.String({ description: "Command" }),
	timeout: Type.Optional(Type.Number({ description: "Seconds (default: none)" })),
});

/** With background jobs (the session's bash tool): `background` starts a job. */
const bashSchema = Type.Object({
	command: Type.String({ description: "Command" }),
	timeout: Type.Optional(Type.Number({ description: "Seconds (default: none)" })),
	background: Type.Optional(
		Type.Boolean({ description: "Run as a background job (dev servers, watchers); read it with bash_output" }),
	),
});

export const bashToolSystemPromptContribution = {
	snippet: "Run shell commands",
	guidelines: [] as string[],
} as const;

export type BashToolInput = Static<typeof bashSchema>;

/**
 * Result for programmatic callers such as codemode scripts. A non-zero exit code is an error result for the model, but scripts still resolve to this value.
 * `output` is not limited like the model-facing output: callers decide how much of it reaches the model.
 */
const bashOutputSchema = Type.Object({
	output: Type.String({ description: "Combined stdout and stderr, possibly truncated" }),
	truncated: Type.Boolean(),
	full_output_path: Type.Optional(Type.String({ description: "Full output, when truncated" })),
	exit_code: Type.Number(),
	wall_time_seconds: Type.Number(),
});

export type BashToolOutput = Static<typeof bashOutputSchema>;

export interface BashToolDetails {
	truncation?: TruncationResult;
	fullOutputPath?: string;
}

/**
 * Pluggable operations for the bash tool.
 * Override these to delegate command execution to remote systems (for example SSH).
 */
export interface BashOperations {
	/**
	 * Execute a command and stream output.
	 * @param command The command to execute
	 * @param cwd Working directory
	 * @param options Execution options
	 * @returns Promise resolving to the exit code. Report signal terminations as 128 + signal number;
	 * a null exit code is treated as a failed command.
	 */
	exec: (
		command: string,
		cwd: string,
		options: {
			onData: (data: Buffer) => void;
			signal?: AbortSignal;
			timeout?: number;
			env?: NodeJS.ProcessEnv;
		},
	) => Promise<{ exitCode: number | null }>;
}

/** Shared process execution used by the built-in shell tools. */
export function createLocalShellOperations(shellName: string, resolveShellConfig: () => ShellConfig): BashOperations {
	return {
		exec: async (command, cwd, { onData, signal, timeout, env }) => {
			const timeoutMs = resolveTimeoutMs(timeout);
			if (signal?.aborted) {
				throw new Error("aborted");
			}
			const shellConfig = resolveShellConfig();
			try {
				await fsAccess(cwd, constants.F_OK);
			} catch {
				throw new Error(`Working directory does not exist: ${cwd}\nCannot execute ${shellName} commands.`);
			}

			const commandFromStdin = shellConfig.commandTransport === "stdin";
			const child = spawn(shellConfig.shell, commandFromStdin ? shellConfig.args : [...shellConfig.args, command], {
				cwd,
				detached: process.platform !== "win32",
				env: env ?? getShellEnv(),
				stdio: [commandFromStdin ? "pipe" : "ignore", "pipe", "pipe"],
				windowsHide: true,
			});
			if (commandFromStdin) {
				child.stdin?.on("error", () => {});
				child.stdin?.end(command);
			}
			if (child.pid) trackDetachedChildPid(child.pid);
			let timedOut = false;
			let timeoutHandle: NodeJS.Timeout | undefined;
			const onAbort = () => {
				if (child.pid) killProcessTree(child.pid);
			};

			try {
				// Set timeout if provided.
				if (timeoutMs !== undefined) {
					timeoutHandle = setTimeout(() => {
						timedOut = true;
						if (child.pid) killProcessTree(child.pid);
					}, timeoutMs);
				}
				// Stream stdout and stderr.
				child.stdout?.on("data", onData);
				child.stderr?.on("data", onData);
				// Handle abort signal by killing the entire process tree.
				if (signal) {
					if (signal.aborted) onAbort();
					else signal.addEventListener("abort", onAbort, { once: true });
				}
				// Handle shell spawn errors and wait for the process to terminate without hanging
				// on inherited stdio handles held by detached descendants.
				const exitCode = await waitForChildProcess(child);
				if (signal?.aborted) {
					throw new Error("aborted");
				}
				if (timedOut) {
					throw new Error(`timeout:${timeout}`);
				}
				// A signal-killed shell has no exit code. Use the standard shell convention so
				// callers do not mistake the termination for a successful command.
				const signalCode = child.signalCode;
				return { exitCode: exitCode ?? (signalCode ? 128 + (osConstants.signals[signalCode] ?? 0) : 1) };
			} finally {
				if (child.pid) untrackDetachedChildPid(child.pid);
				if (timeoutHandle) clearTimeout(timeoutHandle);
				if (signal) signal.removeEventListener("abort", onAbort);
			}
		},
	};
}

/**
 * Create bash operations using RunKiln's built-in local shell execution backend.
 *
 * This is useful for extensions that intercept user_bash and still want RunKiln's
 * standard local shell behavior while wrapping or rewriting commands.
 */
export function createLocalBashOperations(options?: { shellPath?: string }): BashOperations {
	return createLocalShellOperations("bash", () => getShellConfig(options?.shellPath));
}

export interface BashSpawnContext {
	command: string;
	cwd: string;
	env: NodeJS.ProcessEnv;
}

export type BashSpawnHook = (context: BashSpawnContext) => BashSpawnContext;

function resolveSpawnContext(
	command: string,
	cwd: string,
	spawnHook: BashSpawnHook | undefined,
	exposeSessionEnvironment: boolean,
	ctx: ExtensionContext | undefined,
): BashSpawnContext {
	// getShellEnv() already drops shell secrets such as RUNINFRA_API_KEY, so spawnHook starts without them.
	const env = { ...getShellEnv() };
	delete env.RUNKILN_SESSION_ID;
	delete env.RUNKILN_SESSION_FILE;
	delete env.RUNKILN_PROVIDER;
	delete env.RUNKILN_MODEL;
	delete env.RUNKILN_REASONING_LEVEL;
	if (exposeSessionEnvironment && ctx) {
		const model = ctx.model;
		env.RUNKILN_SESSION_ID = ctx.sessionManager.getSessionId();
		const sessionFile = ctx.sessionManager.getSessionFile();
		if (sessionFile) env.RUNKILN_SESSION_FILE = sessionFile;
		if (model) {
			env.RUNKILN_PROVIDER = model.provider;
			env.RUNKILN_MODEL = model.id;
		}
		if (ctx.thinkingLevel) env.RUNKILN_REASONING_LEVEL = ctx.thinkingLevel;
	}
	const baseContext: BashSpawnContext = { command, cwd, env };
	return spawnHook ? spawnHook(baseContext) : baseContext;
}

export interface BashToolOptions {
	/** Custom operations for command execution. Default: local shell */
	operations?: BashOperations;
	/** Command prefix prepended to every command (for example shell setup commands) */
	commandPrefix?: string;
	/** Optional explicit shell path from settings */
	shellPath?: string;
	/** Expose current session metadata as RUNKILN_* environment variables. Default: true */
	exposeSessionEnvironment?: boolean;
	/** Hook to adjust command, cwd, or env before execution */
	spawnHook?: BashSpawnHook;
	/** Background jobs (`background: true`). Without it the parameter is refused. */
	jobs?: JobManager;
	/**
	 * Seconds a command that looks long-running (`npm run dev`, `vite`, `--watch`…) may run in the foreground before
	 * it is moved to the background. 0 turns it off. Default: 20. Needs `jobs`; not used with custom `operations`.
	 */
	autoBackgroundSeconds?: number;
}

export type BashRenderState = {
	startedAt: number | undefined;
	endedAt: number | undefined;
	interval: NodeJS.Timeout | undefined;
};

export interface ShellToolConfig {
	name: string;
	label: string;
	shellName: string;
	prompt: string;
	promptSnippet: string;
	promptGuidelines?: readonly string[];
	tempFilePrefix: string;
}

export function createShellToolDefinition(
	cwd: string,
	config: ShellToolConfig,
	options?: BashToolOptions,
): ToolDefinition<typeof bashSchema, BashToolDetails | undefined, BashRenderState> {
	const ops = options?.operations ?? createLocalBashOperations({ shellPath: options?.shellPath });
	const commandPrefix = options?.commandPrefix;
	const exposeSessionEnvironment = options?.exposeSessionEnvironment ?? true;
	const spawnHook = options?.spawnHook;
	const jobs = options?.jobs;
	const autoBackgroundSeconds = options?.operations
		? 0
		: (options?.autoBackgroundSeconds ?? DEFAULT_AUTO_BACKGROUND_SECONDS);
	return {
		name: config.name,
		// Runs commands: one at a time, in order, never alongside other calls.
		executionMode: "sequential",
		label: config.label,
		description: `Run a ${config.shellName} command in the working directory; returns stdout and stderr. Output over ${CONDENSE_MAX_LINES} lines or ${CONDENSE_MAX_BYTES / 1024}KB is condensed to head, tail and error lines (full log saved to a file).`,
		promptSnippet: config.promptSnippet,
		promptGuidelines: exposeSessionEnvironment && config.promptGuidelines ? [...config.promptGuidelines] : undefined,
		parameters: (jobs ? bashSchema : foregroundShellSchema) as typeof bashSchema,
		outputSchema: bashOutputSchema,
		constrainedSampling: { type: "json_schema", strict: "prefer" },
		async execute(
			_toolCallId,
			{ command, timeout, background }: { command: string; timeout?: number; background?: boolean },
			signal?: AbortSignal,
			onUpdate?,
			ctx?: ExtensionContext,
		) {
			const resolvedCommand = commandPrefix ? `${commandPrefix}\n${command}` : command;
			const spawnContext = resolveSpawnContext(
				resolvedCommand,
				ctx?.cwd || cwd,
				spawnHook,
				exposeSessionEnvironment,
				ctx,
			);
			if (background) {
				if (!jobs) throw new Error(`background is not available for ${config.name} here`);
				return startBackgroundJob(jobs, spawnContext, command, signal);
			}
			if (jobs && autoBackgroundSeconds > 0 && timeout === undefined && looksLongRunning(command)) {
				return runWithAutoBackground(jobs, spawnContext, command, autoBackgroundSeconds, signal);
			}
			const output = new OutputAccumulator({
				tempFilePrefix: config.tempFilePrefix,
				maxLines: CONDENSE_MAX_LINES,
				maxBytes: CONDENSE_MAX_BYTES,
			});
			let acceptingOutput = true;
			let updateTimer: NodeJS.Timeout | undefined;
			let updateDirty = false;
			let lastUpdateAt = 0;

			const emitOutputUpdate = () => {
				if (!onUpdate || !updateDirty) return;
				updateDirty = false;
				lastUpdateAt = Date.now();
				const snapshot = output.snapshot({ persistIfTruncated: true });
				onUpdate({
					content: [{ type: "text", text: snapshot.content || "" }],
					details: {
						truncation: snapshot.truncation.truncated ? snapshot.truncation : undefined,
						fullOutputPath: snapshot.fullOutputPath,
					},
				});
			};

			const clearUpdateTimer = () => {
				if (updateTimer) {
					clearTimeout(updateTimer);
					updateTimer = undefined;
				}
			};

			const scheduleOutputUpdate = () => {
				if (!onUpdate) return;
				updateDirty = true;
				const delay = BASH_UPDATE_THROTTLE_MS - (Date.now() - lastUpdateAt);
				if (delay <= 0) {
					clearUpdateTimer();
					emitOutputUpdate();
					return;
				}
				updateTimer ??= setTimeout(() => {
					updateTimer = undefined;
					emitOutputUpdate();
				}, delay);
			};

			if (onUpdate) {
				onUpdate({ content: [], details: undefined });
			}

			const handleData = (data: Buffer) => {
				if (!acceptingOutput) return;
				output.append(data);
				scheduleOutputUpdate();
			};

			const finishOutput = async () => {
				acceptingOutput = false;
				output.finish();
				clearUpdateTimer();
				emitOutputUpdate();
				const snapshot = output.snapshot({ persistIfTruncated: true });
				await output.closeTempFile();
				return snapshot;
			};

			const formatOutput = async (snapshot: Awaited<ReturnType<typeof finishOutput>>, emptyText = "(no output)") => {
				const truncation = snapshot.truncation;
				let text = snapshot.content || emptyText;
				let details: BashToolDetails | undefined;
				if (truncation.truncated) {
					details = { truncation, fullOutputPath: snapshot.fullOutputPath };
					// Long output: keep the head, the tail and the error-looking lines, not just the tail.
					const full = await output.readFullOutput(CONDENSE_SCAN_MAX_BYTES).catch(() => undefined);
					if (full) {
						text = condenseOutput(full.content, {
							fullOutputPath: snapshot.fullOutputPath,
							exactLineNumbers: !full.truncated,
						}).text;
					} else {
						const startLine = truncation.totalLines - truncation.outputLines + 1;
						const endLine = truncation.totalLines;
						if (truncation.lastLinePartial) {
							const lastLineSize = formatSize(output.getLastLineBytes());
							text += `\n\n[Showing last ${formatSize(truncation.outputBytes)} of line ${endLine} (line is ${lastLineSize}). Full output: ${snapshot.fullOutputPath}]`;
						} else {
							text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}. Full output: ${snapshot.fullOutputPath}]`;
						}
					}
				}
				return { text, details };
			};

			const appendStatus = (text: string, status: string) => `${text ? `${text}\n\n` : ""}${status}`;
			const startedAt = performance.now();

			try {
				let exitCode: number | null;
				try {
					const result = await ops.exec(spawnContext.command, spawnContext.cwd, {
						onData: handleData,
						signal,
						timeout,
						env: spawnContext.env,
					});
					exitCode = result.exitCode;
				} catch (err) {
					const snapshot = await finishOutput();
					const { text } = await formatOutput(snapshot, "");
					if (err instanceof Error && err.message === "aborted") {
						throw new Error(appendStatus(text, "Command aborted"));
					}
					if (err instanceof Error && err.message.startsWith("timeout:")) {
						const timeoutSecs = err.message.split(":")[1];
						throw new Error(appendStatus(text, `Command timed out after ${timeoutSecs} seconds`));
					}
					throw err;
				}

				const snapshot = await finishOutput();
				const { text: outputText, details } = await formatOutput(snapshot);
				if (exitCode === null) {
					throw new Error(appendStatus(outputText, "Command terminated without an exit code"));
				}
				const wallTimeSeconds = Math.round((performance.now() - startedAt) / 100) / 10;
				const fullOutput = await output.readFullOutput(STRUCTURED_OUTPUT_MAX_BYTES);
				const structuredContent: BashToolOutput = {
					output: fullOutput.content,
					truncated: fullOutput.truncated,
					...(fullOutput.truncated && snapshot.fullOutputPath
						? { full_output_path: snapshot.fullOutputPath }
						: {}),
					exit_code: exitCode,
					wall_time_seconds: wallTimeSeconds,
				};
				if (exitCode !== 0) {
					return {
						content: [{ type: "text", text: appendStatus(outputText, `Command exited with code ${exitCode}`) }],
						details,
						structuredContent,
						isError: true,
					};
				}
				return { content: [{ type: "text", text: outputText }], details, structuredContent };
			} finally {
				clearUpdateTimer();
			}
		},
		...createShellRenderers(config.prompt),
	};
}

/** Seconds `background: true` waits for first output before returning. */
const BACKGROUND_GRACE_MS = 1500;

async function startBackgroundJob(
	jobs: JobManager,
	spawnContext: BashSpawnContext,
	command: string,
	signal: AbortSignal | undefined,
) {
	if (signal?.aborted) throw new Error("Command aborted");
	const started = jobs.start(spawnContext.command, spawnContext.cwd, spawnContext.env, "background");
	await jobs.waitForExit(started.id, BACKGROUND_GRACE_MS);
	const read = jobs.read(started.id);
	const job = jobs.get(started.id)!;
	const display = { ...job, command };
	const note =
		job.status === "running"
			? `Started ${job.id} in the background. Read new output with bash_output {"job_id":"${job.id}"} (filter, wait), stop it with kill: true.`
			: `${job.id} already finished.`;
	return {
		content: [{ type: "text" as const, text: `${note}\n${formatJobRead(display, read)}` }],
		details: undefined,
		...(job.status !== "running" && job.exitCode !== 0 ? { isError: true } : {}),
	};
}

/** A likely long-running command: foreground until it exits or `seconds` pass, then it stays running as a job. */
async function runWithAutoBackground(
	jobs: JobManager,
	spawnContext: BashSpawnContext,
	command: string,
	seconds: number,
	signal: AbortSignal | undefined,
) {
	if (signal?.aborted) throw new Error("Command aborted");
	const started = jobs.start(spawnContext.command, spawnContext.cwd, spawnContext.env, "auto");
	const onAbort = () => jobs.kill(started.id);
	signal?.addEventListener("abort", onAbort, { once: true });
	try {
		await jobs.waitForExit(started.id, seconds * 1000);
	} finally {
		signal?.removeEventListener("abort", onAbort);
	}
	const read = jobs.read(started.id, { limitBytes: CONDENSE_MAX_BYTES });
	const job = jobs.get(started.id)!;
	if (signal?.aborted) throw new Error(`${read.text ? `${read.text}\n\n` : ""}Command aborted`);
	if (job.status !== "running") {
		const text = read.text.replace(/\s+$/, "") || "(no output)";
		if (job.exitCode !== 0) {
			return {
				content: [{ type: "text" as const, text: `${text}\n\nCommand exited with code ${job.exitCode}` }],
				details: undefined,
				isError: true,
			};
		}
		return { content: [{ type: "text" as const, text }], details: undefined };
	}
	const text = [
		`This looks like a long-running command (dev server or watcher) and it was still running after ${seconds}s, so it was moved to the background as ${job.id} instead of holding the turn. Next time pass background: true.`,
		`Read new output with bash_output {"job_id":"${job.id}"} (filter, wait), stop it with kill: true.`,
		formatJobRead({ ...job, command }, read),
	].join("\n");
	return { content: [{ type: "text" as const, text }], details: undefined };
}

export { describeJob };

const bashToolConfig: ShellToolConfig = {
	name: "bash",
	label: "bash",
	shellName: "bash",
	prompt: "$",
	promptSnippet: bashToolSystemPromptContribution.snippet,
	promptGuidelines: bashToolSystemPromptContribution.guidelines,
	tempFilePrefix: "runkiln-bash",
};

export function createBashToolDefinition(
	cwd: string,
	options?: BashToolOptions,
): ToolDefinition<typeof bashSchema, BashToolDetails | undefined, BashRenderState> {
	return createShellToolDefinition(cwd, bashToolConfig, options);
}

export function createBashTool(cwd: string, options?: BashToolOptions): AgentTool<typeof bashSchema> {
	const definition = createBashToolDefinition(cwd, options);
	const tool = wrapToolDefinition(definition);
	Object.assign(tool, {
		promptSnippet: definition.promptSnippet,
		promptGuidelines: definition.promptGuidelines,
	});
	return tool;
}
