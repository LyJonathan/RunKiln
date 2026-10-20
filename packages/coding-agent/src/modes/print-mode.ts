/**
 * Print mode (single-shot): Send prompts, output result, exit.
 *
 * Used for:
 * - `runkiln -p "prompt"` - text output
 * - `runkiln --mode json "prompt"` - JSON event stream
 */

import type { AssistantMessage, ImageContent } from "@runkiln/ai";
import type { AgentSession } from "../core/agent-session.ts";
import type { AgentSessionRuntime } from "../core/agent-session-runtime.ts";
import { flushRawStdout, waitForRawStdoutBackpressure, writeRawStdout } from "../core/output-guard.ts";
import { type Priority, reviewFails } from "../core/runkiln/review.ts";
import { rangeStart, readLedger, summarizeLedger } from "../core/usage/ledger.ts";
import { parseUsageArgument, usageText } from "../core/usage/views.ts";
import { killTrackedDetachedChildren } from "../utils/shell.ts";
import { toJsonEvent } from "./json-event.ts";

/** `/usage [tab|range]` in print mode: every tab as plain text, or `{ type: "usage", ... }` in json mode. */
export function printUsageReport(session: AgentSession, arg: string, mode: "text" | "json"): string {
	const { range = "today" } = parseUsageArgument(arg);
	const report = session.getUsageReport();
	const context = session.getContextBreakdown();
	const budgets = session.getBudgetStatuses();
	const ledgerPath = session.usageLedgerPath;
	const history = ledgerPath
		? { range, summary: summarizeLedger(readLedger(ledgerPath), { since: rangeStart(range) }), ledgerPath }
		: undefined;
	if (mode === "json") {
		return `${JSON.stringify({ type: "usage", report, context, budgets, ...(history ? { history: { range, ...history.summary } } : {}) })}\n`;
	}
	return usageText(
		{ report, ...(context ? { context } : {}), budgets, ...(history ? { history } : {}) },
		process.stdout.columns && process.stdout.columns > 80 ? Math.min(120, process.stdout.columns) : 80,
	);
}

/**
 * Options for print mode.
 */
export interface PrintModeOptions {
	/** Output mode: "text" for final response only, "json" for all events */
	mode: "text" | "json";
	/** Array of additional prompts to send after initialMessage */
	messages?: string[];
	/** First message to send (may contain @file content) */
	initialMessage?: string;
	/** Images to attach to the initial message */
	initialImages?: ImageContent[];
	/** `runkiln review [target]`: run a read-only review instead of prompts; exit 2 when --fail-on matches. */
	review?: { target?: string; failOn?: Priority };
	/** --verify: run the tests after file-changing turns and fail (exit 1) when they still fail at the end. */
	verify?: boolean;
}

/**
 * Run in print (single-shot) mode.
 * Sends prompts to the agent and outputs the result.
 */
export async function runPrintMode(runtimeHost: AgentSessionRuntime, options: PrintModeOptions): Promise<number> {
	const { mode, messages = [], initialMessage, initialImages } = options;
	let exitCode = 0;
	let session = runtimeHost.session;
	let unsubscribe: (() => void) | undefined;
	let unsubscribeBackpressure: (() => void) | undefined;
	let disposed = false;
	const signalCleanupHandlers: Array<() => void> = [];

	const disposeRuntime = async (): Promise<void> => {
		if (disposed) return;
		disposed = true;
		unsubscribe?.();
		unsubscribeBackpressure?.();
		await runtimeHost.dispose();
	};

	const registerSignalHandlers = (): void => {
		const signals: NodeJS.Signals[] = ["SIGTERM"];
		if (process.platform !== "win32") {
			signals.push("SIGHUP");
		}

		for (const signal of signals) {
			const handler = () => {
				killTrackedDetachedChildren();
				void disposeRuntime().finally(() => {
					process.exit(signal === "SIGHUP" ? 129 : 143);
				});
			};
			process.on(signal, handler);
			signalCleanupHandlers.push(() => process.off(signal, handler));
		}
	};

	registerSignalHandlers();

	runtimeHost.setRebindSession(async () => {
		await rebindSession();
	});

	const rebindSession = async (): Promise<void> => {
		session = runtimeHost.session;
		await session.bindExtensions({
			mode: mode === "json" ? "json" : "print",
			commandContextActions: {
				waitForIdle: () => session.waitForIdle(),
				newSession: async (newSessionOptions) => runtimeHost.newSession(newSessionOptions),
				fork: async (entryId, forkOptions) => {
					const result = await runtimeHost.fork(entryId, forkOptions);
					return { cancelled: result.cancelled };
				},
				navigateTree: async (targetId, navigateOptions) => {
					const result = await session.navigateTree(targetId, {
						summarize: navigateOptions?.summarize,
						customInstructions: navigateOptions?.customInstructions,
						replaceInstructions: navigateOptions?.replaceInstructions,
						label: navigateOptions?.label,
					});
					return { cancelled: result.cancelled };
				},
				switchSession: async (sessionPath, switchOptions) => {
					return runtimeHost.switchSession(sessionPath, switchOptions);
				},
				reload: async () => {
					await session.reload();
				},
			},
			onError: (err) => {
				console.error(`Extension error (${err.extensionPath}): ${err.error}`);
			},
		});

		unsubscribe?.();
		unsubscribeBackpressure?.();
		unsubscribe = session.subscribe((event) => {
			if (mode === "json") {
				writeRawStdout(`${JSON.stringify(toJsonEvent(event))}\n`);
			}
		});
		unsubscribeBackpressure =
			mode === "json"
				? session.agent.subscribe(async () => {
						await waitForRawStdoutBackpressure();
					})
				: undefined;
	};

	try {
		if (mode === "json") {
			const header = session.sessionManager.getHeader();
			if (header) {
				writeRawStdout(`${JSON.stringify(header)}\n`);
			}
		}

		await rebindSession();
		if (options.verify) session.verify.forced = true;

		if (options.review) {
			const result = await session.review(options.review.target);
			if (result.error) {
				console.error(result.error);
				return 1;
			}
		}

		// `/usage` (`/cost`, `/stats`) prints the report instead of prompting: plain text, or one JSON line in json mode.
		// In text mode the report follows the final answer.
		const usageReports: string[] = [];
		const send = async (message: string, images?: ImageContent[]) => {
			if (/^\/(usage|cost|stats)(\s|$)/.test(message.trim())) {
				const report = printUsageReport(
					session,
					message
						.trim()
						.replace(/^\/\S+/, "")
						.trim(),
					mode,
				);
				if (mode === "json") writeRawStdout(report);
				else usageReports.push(report);
				return;
			}
			await session.prompt(message, { images, nameSession: false });
		};

		if (initialMessage) {
			await send(initialMessage, initialImages);
		}

		for (const message of messages) {
			await send(message);
		}

		if (mode === "text") {
			const state = session.state;
			const lastMessage = state.messages[state.messages.length - 1];

			if (lastMessage?.role === "assistant") {
				const assistantMsg = lastMessage as AssistantMessage;
				if (assistantMsg.stopReason === "error" || assistantMsg.stopReason === "aborted") {
					console.error(assistantMsg.errorMessage || `Request ${assistantMsg.stopReason}`);
					exitCode = 1;
				} else {
					for (const content of assistantMsg.content) {
						if (content.type === "text") {
							writeRawStdout(`${content.text}\n`);
						}
					}
					if (assistantMsg.stopReason === "length") {
						console.error("Response was truncated: the model reached its output token limit.");
						exitCode = 1;
					}
				}
			}
			for (const report of usageReports) writeRawStdout(report);
		}

		if (options.review?.failOn && exitCode === 0) {
			const last = session.state.messages[session.state.messages.length - 1];
			const text =
				last?.role === "assistant"
					? (last as AssistantMessage).content.map((part) => (part.type === "text" ? part.text : "")).join("")
					: "";
			if (reviewFails(text, options.review.failOn)) {
				console.error(`Review found ${options.review.failOn} or more severe findings.`);
				exitCode = 2;
			}
		}

		if (options.verify) {
			const verify = session.verify;
			verify.forced = true;
			// Nothing ran yet (no file changed): run once so the exit code still says whether the tests pass.
			if (verify.status.state === "idle" || verify.hasPendingChanges) {
				const command = await verify.resolveCommand(true);
				if (command) await verify.run(command);
				else console.error("--verify: no test command found (set verify.command).");
			}
			const status = verify.status;
			if (status.state === "fail" || status.state === "timeout") {
				const what =
					status.state === "timeout" ? "timed out" : `fail${status.failing ? ` (${status.failing} failing)` : ""}`;
				console.error(`--verify: tests still ${what}: ${status.command ?? ""}`);
				exitCode = 1;
			}
		}

		return exitCode;
	} catch (error: unknown) {
		console.error(error instanceof Error ? error.message : String(error));
		return 1;
	} finally {
		for (const cleanup of signalCleanupHandlers) {
			cleanup();
		}
		await disposeRuntime();
		await flushRawStdout();
	}
}
