/**
 * Harness signals for routing, read from the conversation the next request will send.
 * Pure functions over messages: no session state, so they are easy to test and cannot drift.
 */

import type { ModelThinkingLevel } from "@runkiln/ai";
import { todoItemsFromMessage, unfinishedTodos } from "../runkiln/todo.ts";
import { truncateText } from "./classifiers.ts";
import type { PreviousTurnSignals, TurnSignals } from "./types.ts";

/** The message fields the router reads. AgentMessage, Message and custom messages all fit. */
export interface SignalMessage {
	role: string;
	content?: unknown;
	isError?: boolean;
	toolCallId?: string;
	toolName?: string;
	details?: unknown;
	stopReason?: string;
	model?: string;
	thinkingLevel?: string;
	/** Custom messages: the verify loop's failure follow-up is "verify-failure". */
	customType?: string;
}

const MAX_REQUEST_CHARS = 6000;
const MAX_CONTEXT_CHARS = 1500;
const LONG_LOOP_TOOL_CALLS = 25;

const EDIT_TOOLS = new Set(["edit", "write", "apply_patch", "multi_edit"]);
const SHELL_TOOLS = new Set(["bash", "powershell", "shell"]);
const TEST_COMMAND =
	/\b(test|tests|vitest|jest|mocha|pytest|unittest|cargo\s+(test|check|clippy)|go\s+(test|vet)|tsc|typecheck|npm\s+run\s+(check|lint|build)|make\s+(test|check)|ruff|mypy|eslint)\b/i;
const TEST_FAILURE =
	/(\b[1-9]\d*\s+(failed|failing|errors?)\b)|\bFAIL(ED)?\b|AssertionError|panicked at|Traceback \(most recent call last\)|error TS\d{3,5}|\bnpm ERR!|exited with code [1-9]|exit code [1-9]/;
/** A tool call the user (or print mode) did not approve: not a failure of the model. */
const NOT_APPROVED = /\bNot run: the user did not approve\b/;

/** New errors the post-edit checks appended to an edit/write result (core/verify/post-edit.ts). */
const NEW_DIAGNOSTIC_ERRORS = /^Diagnostics after edit \([^)]*\): (\d+) new errors?\b/m;
/** The verify loop's hidden follow-up after a failing test run (core/verify/verify-loop.ts). */
const VERIFY_FAILURE_TYPE = "verify-failure";

/**
 * A failed tool result that counts against the model (approval denials do not). An edit that succeeded but
 * introduced errors (post-edit diagnostics) counts too.
 */
function isToolFailure(message: SignalMessage): boolean {
	if (!message.isError) return NEW_DIAGNOSTIC_ERRORS.test(textOf(message.content));
	return !NOT_APPROVED.test(textOf(message.content));
}

function isVerifyFailure(message: SignalMessage): boolean {
	return message.role === "custom" && message.customType === VERIFY_FAILURE_TYPE;
}

const USER_RETRY =
	/\b(still (fails?|failing|broken|wrong|not working|doesn'?t work)|(does ?n[o']?t|did ?n[o']?t|is ?n[o']?t) work(ing)?|not working|try again|that'?s wrong|wrong again|same error|didn'?t fix|marche (toujours )?pas|toujours (pas|la même erreur)|ne marche pas|réessaie)\b/i;

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const part of content) {
		if (part && typeof part === "object" && (part as { type?: unknown }).type === "text") {
			const text = (part as { text?: unknown }).text;
			if (typeof text === "string") parts.push(text);
		}
	}
	return parts.join("\n");
}

function hasImage(content: unknown): boolean {
	return (
		Array.isArray(content) &&
		content.some((part) => part && typeof part === "object" && (part as { type?: unknown }).type === "image")
	);
}

interface ToolCallPart {
	id: string;
	name: string;
	arguments: Record<string, unknown>;
}

function toolCallsOf(content: unknown): ToolCallPart[] {
	if (!Array.isArray(content)) return [];
	const calls: ToolCallPart[] = [];
	for (const part of content) {
		if (!part || typeof part !== "object" || (part as { type?: unknown }).type !== "toolCall") continue;
		const call = part as { id?: unknown; name?: unknown; arguments?: unknown };
		calls.push({
			id: typeof call.id === "string" ? call.id : "",
			name: typeof call.name === "string" ? call.name : "",
			arguments:
				call.arguments && typeof call.arguments === "object" ? (call.arguments as Record<string, unknown>) : {},
		});
	}
	return calls;
}

function editedPath(call: ToolCallPart): string | undefined {
	for (const key of ["path", "file_path", "filePath", "file"]) {
		const value = call.arguments[key];
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	return undefined;
}

/** Failures of the turn between two user messages (exclusive bounds). */
function turnOutcome(messages: readonly SignalMessage[], start: number, end: number): PreviousTurnSignals {
	let errored = false;
	let toolErrors = 0;
	let testFailures = 0;
	let lastTestPassed = false;
	let unfinished: number | undefined;
	const commands = new Map<string, string>();
	for (let i = start; i < end; i++) {
		const message = messages[i];
		if (message.role === "assistant") {
			if (message.stopReason === "error") errored = true;
			for (const call of toolCallsOf(message.content)) {
				if (SHELL_TOOLS.has(call.name) && typeof call.arguments.command === "string") {
					commands.set(call.id, call.arguments.command);
				}
			}
		} else if (message.role === "toolResult") {
			if (isToolFailure(message)) toolErrors++;
			const todos = todoItemsFromMessage(message);
			if (todos) unfinished = unfinishedTodos(todos).length;
			const command = message.toolCallId ? commands.get(message.toolCallId) : undefined;
			if (command && TEST_COMMAND.test(command) && !NOT_APPROVED.test(textOf(message.content))) {
				const failed = !!message.isError || TEST_FAILURE.test(textOf(message.content));
				if (failed) testFailures++;
				lastTestPassed = !failed;
			}
		}
	}
	return {
		errored,
		toolErrors,
		testFailures,
		lastTestPassed,
		...(unfinished !== undefined && unfinished > 0 ? { unfinishedTodos: unfinished } : {}),
	};
}

export interface ExtractSignalsOptions {
	contextTokens: number;
}

export function extractTurnSignals(messages: readonly SignalMessage[], options: ExtractSignalsOptions): TurnSignals {
	let lastUser = -1;
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].role === "user") {
			lastUser = i;
			break;
		}
	}
	const newest = messages[messages.length - 1];
	const latestUserText = lastUser >= 0 ? textOf(messages[lastUser].content) : "";

	// A short tail before the newest request: previous user message and assistant text.
	const tail: string[] = [];
	for (let i = lastUser - 1; i >= 0 && tail.length < 2; i--) {
		const message = messages[i];
		if (message.role !== "user" && message.role !== "assistant") continue;
		const text = textOf(message.content).trim();
		if (text) tail.unshift(`${message.role}: ${truncateText(text, 600)}`);
	}

	let toolCalls = 0;
	let toolErrors = 0;
	let testFailures = 0;
	const files = new Set<string>();
	const commands = new Map<string, string>();
	for (let i = Math.max(0, lastUser + 1); i < messages.length; i++) {
		const message = messages[i];
		if (message.role === "assistant") {
			for (const call of toolCallsOf(message.content)) {
				toolCalls++;
				if (EDIT_TOOLS.has(call.name)) {
					const path = editedPath(call);
					if (path) files.add(path);
				}
				if (SHELL_TOOLS.has(call.name) && typeof call.arguments.command === "string") {
					commands.set(call.id, call.arguments.command);
				}
			}
		} else if (isVerifyFailure(message)) {
			// In-turn only: a later passing verify run leaves no message, so the previous-turn outcome skips these.
			testFailures++;
		} else if (message.role === "toolResult") {
			if (isToolFailure(message)) toolErrors++;
			const command = message.toolCallId ? commands.get(message.toolCallId) : undefined;
			const text = textOf(message.content);
			if (
				command &&
				TEST_COMMAND.test(command) &&
				!NOT_APPROVED.test(text) &&
				(message.isError || TEST_FAILURE.test(text))
			) {
				testFailures++;
			}
		}
	}

	let previousUser = -1;
	for (let i = lastUser - 1; i >= 0; i--) {
		if (messages[i].role === "user") {
			previousUser = i;
			break;
		}
	}
	const previousTurn = previousUser >= 0 ? turnOutcome(messages, previousUser + 1, lastUser) : undefined;
	let assistantAsked = false;
	for (let i = lastUser - 1; i > previousUser && i >= 0; i--) {
		if (messages[i].role !== "assistant") continue;
		const text = textOf(messages[i].content).trim();
		if (!text) continue;
		const lastLine =
			text
				.split("\n")
				.filter((line) => line.trim())
				.pop() ?? "";
		assistantAsked = /\?\s*\**\s*$/.test(text) || lastLine.includes("?");
		break;
	}

	let warmModelId: string | undefined;
	let warmThinkingLevel: ModelThinkingLevel | undefined;
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role !== "assistant" || message.stopReason === "error" || message.stopReason === "aborted") continue;
		if (typeof message.model === "string") warmModelId = message.model;
		if (typeof message.thinkingLevel === "string") warmThinkingLevel = message.thinkingLevel as ModelThinkingLevel;
		break;
	}

	return {
		latestUserText: truncateText(latestUserText, MAX_REQUEST_CHARS),
		warmModelId,
		...(warmThinkingLevel ? { warmThinkingLevel } : {}),
		recentContext: truncateText(tail.join("\n"), MAX_CONTEXT_CHARS),
		isNewUserTurn: newest?.role === "user",
		hasImages: messages.some((message) => hasImage(message.content)),
		toolCallsThisTurn: toolCalls,
		toolErrorsThisTurn: toolErrors,
		testFailuresThisTurn: testFailures,
		filesTouchedThisTurn: files.size,
		userRetry: USER_RETRY.test(latestUserText),
		contextTokens: Math.max(0, Math.round(options.contextTokens)),
		previousTurn,
		assistantAsked,
	};
}

export const LONG_LOOP_THRESHOLD = LONG_LOOP_TOOL_CALLS;
