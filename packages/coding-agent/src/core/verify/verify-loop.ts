/**
 * The verify loop (like Aider's --auto-test): when a run that changed files is about to settle, run the project's
 * test command; on failure, feed the condensed output back to the model as a hidden follow-up so it keeps going,
 * at most `verify.maxRetries` times. The router counts each follow-up as a failing test, so its usual escalation
 * picks a stronger model or more thinking for the retry. The loop stops early when the same failure repeats.
 *
 * `verify.mode`: "off" never runs it (/test still does), "ask" (default) offers it after the first file-changing
 * turn in a project, "auto" runs it without the offer. A detected command is confirmed once and saved per project.
 */

import type { CustomMessage } from "../messages.ts";
import { runCommand } from "./diagnostics.ts";
import {
	commandSetupFailure,
	condenseTestOutput,
	countFailing,
	type DetectedTestCommand,
	detectTestCommand,
	failureSignature,
} from "./test-command.ts";

export const VERIFY_FAILURE_TYPE = "verify-failure";
export type VerifyMode = "off" | "ask" | "auto";
export const VERIFY_MODES: readonly VerifyMode[] = ["off", "ask", "auto"];
export const DEFAULT_VERIFY_TIMEOUT_MS = 180_000;
export const DEFAULT_VERIFY_MAX_RETRIES = 2;

export interface VerifySettings {
	mode: VerifyMode;
	/** A command from settings (global or project). */
	command?: string;
	/** True when `command` came from the user's global settings (no confirmation needed). */
	commandTrusted: boolean;
	maxRetries: number;
	timeoutMs: number;
}

export interface VerifyProjectEntry {
	command?: string;
	decision: "always" | "never";
}

/** The dialog surface: the extension UI's select and input. */
export interface VerifyUI {
	select(title: string, options: string[], opts?: { signal?: AbortSignal }): Promise<string | undefined>;
	input(title: string, placeholder?: string, opts?: { signal?: AbortSignal }): Promise<string | undefined>;
	notify(message: string, type?: "info" | "warning" | "error"): void;
	setWorkingMessage(message?: string): void;
}

export interface VerifyHost {
	cwd(): string;
	settings(): VerifySettings;
	/** The saved choice for this project (global settings). */
	project(): VerifyProjectEntry | undefined;
	saveProject(entry: VerifyProjectEntry | undefined): void;
	/** Undefined without an interactive UI (print, json). */
	ui(): VerifyUI | undefined;
	/** Plan mode never runs tests. */
	isPlanMode(): boolean;
}

export type VerifyState = "idle" | "running" | "pass" | "fail" | "timeout";

export interface VerifyStatus {
	state: VerifyState;
	command?: string;
	/** Failing tests, when the runner printed a summary. */
	failing?: number;
	/** Hidden follow-ups sent for the current failure streak. */
	retries: number;
	exitCode?: number;
	/** The condensed output of the last run. */
	excerpt?: string;
	durationMs?: number;
	/** Why the loop stopped feeding failures back, when it did. */
	stopped?: "max-retries" | "same-failure" | "not-runnable";
	/** Set when the command could not run at all (see commandSetupFailure). */
	setupError?: string;
}

export interface VerifyRunResult {
	passed: boolean;
	timedOut: boolean;
	exitCode: number;
	failing?: number;
	excerpt: string;
	signature: string;
	durationMs: number;
	/** The command could not run at all: why. Never sent to the model. */
	setupError?: string;
}

export const VERIFY_OPTIONS = {
	always: "Yes, after each change in this project",
	session: "Yes, this session only",
	other: "Use a different command…",
	notNow: "Not now",
	never: "Never in this project",
} as const;

/** The footer marker: `✓ tests`, `✗ 3 failing ↻1`, `… tests`, `⏱ tests`, `⚠ test command`, or undefined before any run. */
export function verifyMarker(status: VerifyStatus): string | undefined {
	switch (status.state) {
		case "running":
			return "… tests";
		case "pass":
			return "✓ tests";
		case "timeout":
			return "⏱ tests";
		case "fail": {
			if (status.setupError) return "⚠ test command";
			const what = status.failing !== undefined && status.failing > 0 ? `${status.failing} failing` : "tests";
			return `✗ ${what}${status.retries > 0 ? ` ↻${status.retries}` : ""}`;
		}
		default:
			return undefined;
	}
}

export function verifyFailureText(
	command: string,
	result: VerifyRunResult,
	attempt: number,
	maxRetries: number,
): string {
	const failing = result.failing !== undefined ? `, ${result.failing} failing` : "";
	return [
		`The tests fail after your changes (\`${command}\`, exit code ${result.exitCode}${failing}). Fix the code so they pass; do not delete, skip or weaken tests unless they are wrong. Automatic retry ${attempt} of ${maxRetries}.`,
		"",
		result.excerpt,
	].join("\n");
}

export class VerifyController {
	private readonly host: VerifyHost;
	private dirty = false;
	private lastSignature: string | undefined;
	private sessionChoice: "yes" | "no" | undefined;
	private sessionCommand: string | undefined;
	private abortController: AbortController | undefined;
	private readonly listeners = new Set<() => void>();
	/** Print mode --verify: run without asking, whatever verify.mode says. */
	forced = false;
	status: VerifyStatus = { state: "idle", retries: 0 };

	constructor(host: VerifyHost) {
		this.host = host;
	}

	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private setStatus(status: VerifyStatus): void {
		this.status = status;
		for (const listener of this.listeners) {
			try {
				listener();
			} catch {
				// A listener never breaks the loop.
			}
		}
	}

	get marker(): string | undefined {
		return verifyMarker(this.status);
	}

	/** Files changed since the last test run. */
	get hasPendingChanges(): boolean {
		return this.dirty;
	}

	/** A finished tool call: a successful edit or write marks the files as changed. */
	noteToolEnd(toolName: string, isError: boolean): void {
		if (!isError && (toolName === "edit" || toolName === "write")) this.dirty = true;
	}

	/** A new user message: a new failure streak. */
	noteUserTurn(): void {
		this.lastSignature = undefined;
		if (this.status.retries !== 0 || this.status.stopped) {
			this.setStatus({ ...this.status, retries: 0, stopped: undefined });
		}
	}

	abort(): void {
		this.abortController?.abort();
	}

	/**
	 * The command to run, asking the user when it still needs a yes. Undefined: do not run. `manual` is /test,
	 * which runs whatever the mode says.
	 */
	async resolveCommand(manual = false, signal?: AbortSignal): Promise<string | undefined> {
		const settings = this.host.settings();
		if (!manual && !this.forced && settings.mode === "off") return undefined;
		const saved = this.host.project();
		if (!manual && !this.forced && saved?.decision === "never") return undefined;
		if (!manual && !this.forced && this.sessionChoice === "no") return undefined;
		if (settings.command && settings.commandTrusted) return settings.command;
		if (saved?.decision === "always" && saved.command) return saved.command;
		if (this.sessionChoice === "yes" && this.sessionCommand) return this.sessionCommand;

		const detected: DetectedTestCommand | undefined = settings.command
			? { command: settings.command, source: "setting" }
			: detectTestCommand(this.host.cwd());
		if (this.forced) return detected?.command;
		// auto: a detected command runs without the offer; a command from project settings is still confirmed.
		if (!manual && settings.mode === "auto" && detected && detected.source !== "setting") return detected.command;
		const ui = this.host.ui();
		if (!ui) return undefined;
		if (!detected) {
			if (!manual) return undefined;
			const typed = (await ui.input("Test command for this project", "npm test", { signal }))?.trim();
			if (!typed) return undefined;
			this.host.saveProject({ command: typed, decision: "always" });
			return typed;
		}
		return this.offer(detected, ui, settings, signal);
	}

	private async offer(
		detected: DetectedTestCommand,
		ui: VerifyUI,
		settings: VerifySettings,
		signal?: AbortSignal,
	): Promise<string | undefined> {
		const from =
			detected.source === "setting"
				? "from this project's settings"
				: detected.source === "package.json"
					? "the package.json test script"
					: `detected (${detected.source})`;
		const title = [
			`Run the tests after changes? \`${detected.command}\` (${from})`,
			`When a turn that changed files ends, RunKiln runs it and sends failures back to the model (at most ${settings.maxRetries} retries).`,
		].join("\n");
		const choice = await ui.select(title, Object.values(VERIFY_OPTIONS), { signal });
		if (choice === VERIFY_OPTIONS.always) {
			this.host.saveProject({ command: detected.command, decision: "always" });
			return detected.command;
		}
		if (choice === VERIFY_OPTIONS.session) {
			this.sessionChoice = "yes";
			this.sessionCommand = detected.command;
			return detected.command;
		}
		if (choice === VERIFY_OPTIONS.other) {
			const typed = (await ui.input("Test command for this project", detected.command, { signal }))?.trim();
			if (!typed) {
				this.sessionChoice = "no";
				return undefined;
			}
			this.host.saveProject({ command: typed, decision: "always" });
			return typed;
		}
		if (choice === VERIFY_OPTIONS.never) {
			this.host.saveProject({ decision: "never" });
			return undefined;
		}
		// "Not now" or dismissed: do not ask again this session.
		this.sessionChoice = "no";
		return undefined;
	}

	/** Runs the command and updates the status. */
	async run(command: string, signal?: AbortSignal): Promise<VerifyRunResult> {
		const settings = this.host.settings();
		this.abortController = new AbortController();
		const onAbort = () => this.abortController?.abort();
		signal?.addEventListener("abort", onAbort, { once: true });
		this.dirty = false;
		this.setStatus({ ...this.status, state: "running", command });
		const ui = this.host.ui();
		ui?.setWorkingMessage(`Running tests: ${command}`);
		try {
			const run = await runCommand(command, [], {
				cwd: this.host.cwd(),
				timeoutMs: settings.timeoutMs,
				shell: true,
				signal: this.abortController.signal,
			});
			const passed = run.code === 0 && !run.timedOut;
			const setupError =
				passed || run.timedOut ? undefined : commandSetupFailure(run.output, run.code, this.host.cwd());
			const result: VerifyRunResult = {
				passed,
				timedOut: run.timedOut,
				exitCode: run.code,
				failing: passed ? 0 : countFailing(run.output),
				excerpt: condenseTestOutput(run.output || `(no output; exit code ${run.code})`),
				signature: failureSignature(run.output),
				durationMs: run.durationMs,
				...(setupError ? { setupError } : {}),
			};
			this.setStatus({
				state: run.timedOut ? "timeout" : passed ? "pass" : "fail",
				command,
				...(result.failing !== undefined ? { failing: result.failing } : {}),
				retries: passed ? 0 : this.status.retries,
				exitCode: run.code,
				excerpt: result.excerpt,
				durationMs: run.durationMs,
				...(setupError ? { setupError, stopped: "not-runnable" as const } : {}),
			});
			if (passed) this.lastSignature = undefined;
			return result;
		} finally {
			signal?.removeEventListener("abort", onAbort);
			this.abortController = undefined;
			ui?.setWorkingMessage();
		}
	}

	/**
	 * At the end of a run: when files changed, run the tests; on a new failure with retries left, return the hidden
	 * follow-up for the model. Undefined means let the run settle.
	 */
	async beforeSettle(signal?: AbortSignal): Promise<CustomMessage | undefined> {
		if (!this.dirty || this.host.isPlanMode() || signal?.aborted) return undefined;
		const command = await this.resolveCommand(false, signal);
		if (!command || signal?.aborted) {
			this.dirty = false;
			return undefined;
		}
		const result = await this.run(command, signal);
		if (signal?.aborted || result.passed) return undefined;
		const ui = this.host.ui();
		if (result.timedOut) {
			ui?.notify(
				`Tests timed out after ${Math.round(this.host.settings().timeoutMs / 1000)}s (${command}).`,
				"warning",
			);
			return undefined;
		}
		if (result.setupError) {
			ui?.notify(
				`The test command could not run (${result.setupError}): \`${command}\`. Not sending this to the model; fix the command with /test or verify.command.`,
				"warning",
			);
			return undefined;
		}
		const settings = this.host.settings();
		const failing = result.failing ? `${result.failing} failing` : `exit code ${result.exitCode}`;
		if (result.signature === this.lastSignature) {
			this.setStatus({ ...this.status, stopped: "same-failure" });
			ui?.notify(
				`Tests still fail (${failing}) with the same failure as before; stopping the automatic retries.`,
				"warning",
			);
			return undefined;
		}
		if (this.status.retries >= settings.maxRetries) {
			this.setStatus({ ...this.status, stopped: "max-retries" });
			ui?.notify(`Tests still fail (${failing}) after ${settings.maxRetries} automatic retries.`, "warning");
			return undefined;
		}
		this.lastSignature = result.signature;
		const attempt = this.status.retries + 1;
		this.setStatus({ ...this.status, retries: attempt });
		ui?.notify(
			`Tests fail (${failing}); sending the failures back to the model (retry ${attempt}/${settings.maxRetries}).`,
			"info",
		);
		return {
			role: "custom",
			customType: VERIFY_FAILURE_TYPE,
			content: [{ type: "text", text: verifyFailureText(command, result, attempt, settings.maxRetries) }],
			display: false,
			details: { command, exitCode: result.exitCode, failing: result.failing, attempt },
			timestamp: Date.now(),
		};
	}
}
