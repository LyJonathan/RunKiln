/**
 * The `todo` tool, as Claude Code's TodoWrite and Codex's plan tool: the model keeps a short checklist for a
 * multi-step task. Each call sends the whole list, which replaces the previous one, so the state is simply the
 * last successful todo result on the current branch (no extra session entry: /tree, /undo and /resume see the
 * list that was current at that point).
 *
 * The definition is small (about 120 tokens) and never changes, so it stays in the cached prompt prefix. The tool
 * only edits session state: it runs without an approval prompt in every permission mode, plan mode included.
 * When a run ends with unfinished items, the session nudges the model once with a hidden message, and the router
 * counts the unfinished items as a "not done" signal on the next turn.
 */

import type { AgentToolResult } from "@runkiln/agent-core";
import { Text } from "@runkiln/tui";
import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";

export const TODO_TOOL_NAME = "todo";
/** customType of the hidden nudge sent when a run ends with unfinished items. */
export const TODO_NUDGE_MESSAGE_TYPE = "runkiln-todo-nudge";
export const MAX_TODO_ITEMS = 30;
const MAX_TEXT = 200;

export type TodoStatus = "pending" | "in_progress" | "done";
export const TODO_STATUSES: readonly TodoStatus[] = ["pending", "in_progress", "done"];

export interface TodoItem {
	id: string;
	text: string;
	status: TodoStatus;
}

export interface TodoToolDetails {
	items: TodoItem[];
}

const todoSchema = Type.Object({
	items: Type.Array(
		Type.Object({
			id: Type.String(),
			text: Type.String(),
			status: Type.Unsafe<TodoStatus>({ type: "string", enum: [...TODO_STATUSES] }),
		}),
	),
});

export type TodoToolInput = Static<typeof todoSchema>;

export const TODO_TOOL_DESCRIPTION =
	"Checklist for multi-step work. Send the full list each call; it replaces the old one. Keep one item in_progress, mark items done as soon as they are, and finish every item (or remove it) before ending your turn. Skip for one-step tasks.";

/** Normalizes model input: trims, drops empty items, caps text and count, maps loose status words. */
export function normalizeTodoItems(input: unknown): TodoItem[] {
	const raw = Array.isArray(input) ? input : [];
	const items: TodoItem[] = [];
	const seen = new Set<string>();
	for (const [index, entry] of raw.entries()) {
		if (!entry || typeof entry !== "object") continue;
		const record = entry as Record<string, unknown>;
		const text = typeof record.text === "string" ? record.text.replace(/\s+/g, " ").trim() : "";
		if (!text) continue;
		let id = typeof record.id === "string" || typeof record.id === "number" ? String(record.id).trim() : "";
		if (!id || seen.has(id)) id = String(index + 1);
		while (seen.has(id)) id = `${id}'`;
		seen.add(id);
		items.push({
			id,
			text: text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text,
			status: toStatus(record.status),
		});
		if (items.length >= MAX_TODO_ITEMS) break;
	}
	return items;
}

function toStatus(value: unknown): TodoStatus {
	const word =
		typeof value === "string"
			? value
					.trim()
					.toLowerCase()
					.replace(/[\s-]+/g, "_")
			: "";
	if (word === "done" || word === "completed" || word === "complete" || word === "finished") return "done";
	if (word === "in_progress" || word === "active" || word === "doing" || word === "started") return "in_progress";
	return "pending";
}

export function unfinishedTodos(items: readonly TodoItem[] | undefined): TodoItem[] {
	return (items ?? []).filter((item) => item.status !== "done");
}

/** The short text result the model sees. */
export function formatTodoResult(items: readonly TodoItem[]): string {
	if (items.length === 0) return "Todo list cleared.";
	const done = items.filter((item) => item.status === "done").length;
	const current = items.find((item) => item.status === "in_progress");
	const parts = [`Todo list saved: ${done}/${items.length} done.`];
	if (current) parts.push(`In progress: ${current.text}`);
	else if (done < items.length) parts.push(`Next: ${items.find((item) => item.status !== "done")?.text}`);
	return parts.join(" ");
}

/** The hidden note sent once when a run ends with unfinished items. */
export function todoNudgeText(items: readonly TodoItem[]): string {
	const open = unfinishedTodos(items);
	const list = open
		.slice(0, 8)
		.map((item) => `- [${item.status === "in_progress" ? "~" : " "}] ${item.text}`)
		.join("\n");
	return [
		"<system-reminder>",
		`Your todo list still has ${open.length} unfinished item${open.length === 1 ? "" : "s"}:`,
		list,
		"Continue with them now. If an item is no longer needed or is blocked on the user, update the list (todo) and say why; if you need a decision from the user, ask it.",
		"</system-reminder>",
	].join("\n");
}

/** The message fields read when looking for the current list. */
interface TodoSourceMessage {
	role: string;
	toolName?: string;
	isError?: boolean;
	details?: unknown;
}

/** The list from one message, when it is a successful todo result. */
export function todoItemsFromMessage(message: TodoSourceMessage | undefined): TodoItem[] | undefined {
	if (!message || message.role !== "toolResult" || message.toolName !== TODO_TOOL_NAME || message.isError) {
		return undefined;
	}
	const details = message.details as Partial<TodoToolDetails> | undefined;
	return Array.isArray(details?.items) ? normalizeTodoItems(details.items) : undefined;
}

/** The current list: the newest successful todo result among `messages` (oldest first). */
export function currentTodoItems(messages: readonly TodoSourceMessage[]): TodoItem[] {
	for (let i = messages.length - 1; i >= 0; i--) {
		const items = todoItemsFromMessage(messages[i]);
		if (items) return items;
	}
	return [];
}

const STATUS_MARK: Record<TodoStatus, string> = { pending: "☐", in_progress: "◐", done: "☑" };

export interface TodoTheme {
	fg(color: string, text: string): string;
	bold(text: string): string;
	strikethrough?(text: string): string;
}

/** One line per item, for the panel above the editor and the tool result. */
export function renderTodoLines(items: readonly TodoItem[], theme: TodoTheme, width: number): string[] {
	const max = Math.max(10, width - 4);
	return items.map((item) => {
		const text = item.text.length > max ? `${item.text.slice(0, max - 1)}…` : item.text;
		const mark = STATUS_MARK[item.status];
		if (item.status === "done")
			return theme.fg("dim", `${mark} ${theme.strikethrough ? theme.strikethrough(text) : text}`);
		if (item.status === "in_progress") return `${theme.fg("accent", mark)} ${theme.bold(text)}`;
		return `${theme.fg("muted", mark)} ${text}`;
	});
}

export function todoSummaryLabel(items: readonly TodoItem[]): string {
	const done = items.filter((item) => item.status === "done").length;
	return `Todo ${done}/${items.length}`;
}

export function createTodoToolDefinition(): ToolDefinition<typeof todoSchema, TodoToolDetails> {
	return {
		name: TODO_TOOL_NAME,
		label: "todo",
		description: TODO_TOOL_DESCRIPTION,
		parameters: todoSchema,
		executionMode: "sequential",
		prepareArguments(args) {
			// Some models send the list as a JSON string or under another key.
			const record = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
			let items = record.items ?? record.todos ?? record.list;
			if (typeof items === "string") {
				try {
					items = JSON.parse(items);
				} catch {
					items = [];
				}
			}
			return { items: Array.isArray(items) ? (items as TodoToolInput["items"]) : [] };
		},
		async execute(_toolCallId, params): Promise<AgentToolResult<TodoToolDetails>> {
			const items = normalizeTodoItems(params.items);
			return { content: [{ type: "text", text: formatTodoResult(items) }], details: { items } };
		},
		renderCall(_args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(context.executionStarted ? "" : theme.fg("toolTitle", theme.bold("todo")));
			return text;
		},
		renderResult(result, _options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const items = (result.details as TodoToolDetails | undefined)?.items ?? [];
			const current = items.find((item) => item.status === "in_progress");
			const label = theme.fg("toolTitle", theme.bold(items.length > 0 ? todoSummaryLabel(items) : "Todo cleared"));
			text.setText(current ? `${label} ${theme.fg("muted", `- ${current.text}`)}` : label);
			return text;
		},
	};
}
