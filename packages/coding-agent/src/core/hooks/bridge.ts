/**
 * Bridges shell hooks into RunKiln's extension events, as a built-in extension:
 *
 * | Hook             | Extension event        | What a block does                                         |
 * |------------------|------------------------|-----------------------------------------------------------|
 * | PreToolUse       | tool_call              | the call does not run; the reason is the tool's error     |
 * | PostToolUse      | tool_result            | the reason is added to the tool result for the model      |
 * | UserPromptSubmit | input                  | the prompt is not sent; the reason is shown to the user   |
 * | Stop             | agent_before_settle    | the agent continues with the reason as a message          |
 * | Notification     | approval prompt, agent_settled | nothing (side effects only)                      |
 * | SessionStart     | session_start          | nothing; output becomes context                           |
 * | PreCompact       | session_before_compact | compaction is cancelled                                   |
 *
 * Context from SessionStart and UserPromptSubmit (plain stdout or `additionalContext`) is added as a hidden message
 * before the next model request, never to the system prompt, so the cached prompt prefix stays the same.
 *
 * PreToolUse runs after RunKiln's permission gate: a hook can deny a call the gate allowed, or ask about it, but its
 * "allow" cannot approve a call the gate would ask about (permission rules stay the only way to loosen).
 */

import type { ImageContent, TextContent } from "@runkiln/ai";
import type {
	AgentBeforeSettleEvent,
	BoundaryResult,
	Extension,
	ExtensionContext,
	InputEvent,
	InputEventResult,
	SessionBeforeCompactEvent,
	SessionStartEvent,
	ToolCallEvent,
	ToolCallEventResult,
	ToolResultEvent,
	ToolResultEventResult,
} from "../extensions/types.ts";
import { hookTrustLine } from "../runkiln/trust-display.ts";
import { createSyntheticSourceInfo } from "../source-info.ts";
import type { HookEventResult, HookManager } from "./manager.ts";

export const HOOKS_EXTENSION_PATH = "builtin:hooks";
/** customType of the hidden message carrying hook context to the model. */
export const HOOK_CONTEXT_MESSAGE_TYPE = "hook-context";
/** customType of the visible message a blocking Stop hook adds. */
export const HOOK_FEEDBACK_MESSAGE_TYPE = "hook-feedback";
/** Most times Stop hooks may keep the agent going in one run. */
export const MAX_STOP_CONTINUATIONS = 5;

/** Claude Code's permission_mode names for RunKiln's modes. */
export function claudePermissionMode(mode: string): string {
	switch (mode) {
		case "ask":
			return "default";
		case "read-write":
			return "acceptEdits";
		case "allow-all":
			return "bypassPermissions";
		default:
			return mode;
	}
}

/** A copy of the tool input with Claude Code's `file_path` next to `path`, for scripts written for Claude Code. */
function hookToolInput(input: Record<string, unknown>): Record<string, unknown> {
	if (typeof input.path === "string" && input.file_path === undefined) return { ...input, file_path: input.path };
	return { ...input };
}

function textOf(content: readonly (TextContent | ImageContent)[] | undefined): string {
	return (content ?? [])
		.filter((part): part is TextContent => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

export interface HooksBridge {
	extension: Extension;
	/** Run Notification hooks (fire and forget). */
	notify(type: string, message: string, title?: string): void;
}

export function createHooksBridge(manager: HookManager): HooksBridge {
	const handlers = new Map<string, Array<(...args: unknown[]) => Promise<unknown>>>();
	const on = <E, R>(event: string, handler: (event: E, ctx: ExtensionContext) => Promise<R>) => {
		handlers.set(event, [...(handlers.get(event) ?? []), handler as (...args: unknown[]) => Promise<unknown>]);
	};
	/** Context waiting for the next model request (SessionStart, UserPromptSubmit). */
	let pendingContext: string[] = [];
	/** PreToolUse additionalContext, added to that call's result. */
	const toolContext = new Map<string, string[]>();
	let stopContinuations = 0;
	let lastCtx: ExtensionContext | undefined;

	const report = (result: HookEventResult, ctx: ExtensionContext | undefined) => {
		if (!ctx?.hasUI) return;
		for (const message of result.messages) ctx.ui.notify(message, "info");
		for (const error of result.errors) ctx.ui.notify(error, "warning");
	};

	const askTrust = async (ctx: ExtensionContext) => {
		const pending = manager.untrustedProjectHooks;
		if (pending.length === 0 || !ctx.hasUI) return;
		const lines = pending.slice(0, 12).map((entry) => hookTrustLine(entry));
		if (pending.length > 12) lines.push(`  ... and ${pending.length - 12} more (/hooks)`);
		const choice = await ctx.ui.select(
			`This project defines hooks: shell commands that run on agent events.\n${lines.join("\n")}\n\nRun them?`,
			["Trust these hooks (remember)", "Trust for this session", "Not now (/hooks trust later)"],
		);
		if (choice?.startsWith("Trust these")) manager.trustProjectHooks(true);
		else if (choice?.startsWith("Trust for")) manager.trustProjectHooks(false);
	};

	on<SessionStartEvent, void>("session_start", async (event, ctx) => {
		lastCtx = ctx;
		if (event.reason === "reload") manager.reload();
		await askTrust(ctx);
		if (!manager.hasHooks("SessionStart")) return;
		const source =
			event.reason === "new" ? "clear" : event.reason === "reload" ? "startup" : (event.reason as string);
		const result = await manager.run(
			"SessionStart",
			{ source, ...(ctx.model ? { model: `${ctx.model.provider}/${ctx.model.id}` } : {}) },
			{ matchValues: [source] },
		);
		report(result, ctx);
		if (result.blocked && result.reason && ctx.hasUI) ctx.ui.notify(`SessionStart hook: ${result.reason}`, "warning");
		pendingContext.push(...result.context);
	});

	on<InputEvent, InputEventResult>("input", async (event, ctx) => {
		lastCtx = ctx;
		stopContinuations = 0;
		if (event.source === "extension" || !manager.hasHooks("UserPromptSubmit")) return { action: "continue" };
		const result = await manager.run("UserPromptSubmit", { prompt: event.text });
		report(result, ctx);
		if (result.blocked || result.stop) {
			const reason = result.reason ?? result.stop?.reason ?? "blocked by a UserPromptSubmit hook";
			if (ctx.hasUI) ctx.ui.notify(`Prompt blocked by a hook: ${reason}`, "warning");
			return { action: "handled" };
		}
		pendingContext.push(...result.context);
		return { action: "continue" };
	});

	on<unknown, { message: { customType: string; content: string; display: boolean } } | undefined>(
		"before_agent_start",
		async () => {
			if (pendingContext.length === 0) return undefined;
			const content = pendingContext.join("\n\n");
			pendingContext = [];
			return { message: { customType: HOOK_CONTEXT_MESSAGE_TYPE, content, display: false } };
		},
	);

	on<ToolCallEvent, ToolCallEventResult | undefined>("tool_call", async (event, ctx) => {
		lastCtx = ctx;
		const tool = { name: event.toolName, input: event.input };
		if (manager.matching("PreToolUse", { tool }).length === 0) return undefined;
		const result = await manager.run(
			"PreToolUse",
			{ tool_name: event.toolName, tool_input: hookToolInput(event.input), tool_use_id: event.toolCallId },
			{ tool, signal: ctx.signal },
		);
		report(result, ctx);
		if (result.context.length > 0) toolContext.set(event.toolCallId, result.context);
		if (result.stop) {
			ctx.abort();
			return { block: true, reason: result.stop.reason ?? "Stopped by a PreToolUse hook (continue: false)." };
		}
		if (result.blocked) {
			return { block: true, reason: `PreToolUse:${event.toolName} hook error: ${result.reason ?? "blocked"}` };
		}
		if (result.ask) {
			const allowed = ctx.hasUI
				? await ctx.ui.confirm(`Hook asks before ${event.toolName}`, result.ask.reason)
				: false;
			if (!allowed) {
				return {
					block: true,
					reason: `PreToolUse:${event.toolName}: not run (a hook asked and ${ctx.hasUI ? "the user said no" : "no one could answer"}): ${result.ask.reason}`,
				};
			}
		}
		if (result.updatedInput) {
			// Patch in place (extension contract): later handlers and the tool see the new input.
			const input = event.input as Record<string, unknown>;
			for (const key of Object.keys(input)) delete input[key];
			Object.assign(input, result.updatedInput);
		}
		return undefined;
	});

	on<ToolResultEvent, ToolResultEventResult | undefined>("tool_result", async (event, ctx) => {
		lastCtx = ctx;
		const extra: string[] = [...(toolContext.get(event.toolCallId) ?? [])];
		toolContext.delete(event.toolCallId);
		let content = event.content;
		let changed = false;
		const tool = { name: event.toolName, input: event.input };
		if (manager.matching("PostToolUse", { tool }).length > 0) {
			const result = await manager.run(
				"PostToolUse",
				{
					tool_name: event.toolName,
					tool_input: hookToolInput(event.input),
					tool_response: { content: textOf(event.content), is_error: event.isError },
					tool_use_id: event.toolCallId,
				},
				{ tool, signal: ctx.signal },
			);
			report(result, ctx);
			if (result.updatedToolOutput !== undefined) {
				const text =
					typeof result.updatedToolOutput === "string"
						? result.updatedToolOutput
						: JSON.stringify(result.updatedToolOutput);
				content = [{ type: "text", text }];
				changed = true;
			}
			if (result.blocked) extra.push(`PostToolUse:${event.toolName} hook feedback: ${result.reason ?? "blocked"}`);
			extra.push(...result.context);
			if (result.stop) ctx.abort();
		}
		if (extra.length === 0 && !changed) return undefined;
		return {
			content: extra.length > 0 ? [...content, { type: "text", text: extra.join("\n") }] : content,
			details: event.details,
		};
	});

	on<AgentBeforeSettleEvent, BoundaryResult | undefined>("agent_before_settle", async (event, ctx) => {
		lastCtx = ctx;
		if (event.outcome === "aborted" || !manager.hasHooks("Stop")) return undefined;
		const lastAssistant = [...event.context.contextMessages]
			.reverse()
			.find((message) => message.role === "assistant") as { content?: unknown } | undefined;
		const lastText = Array.isArray(lastAssistant?.content)
			? (lastAssistant.content as Array<{ type: string; text?: string }>)
					.filter((part) => part.type === "text")
					.map((part) => part.text ?? "")
					.join("\n")
			: "";
		const result = await manager.run("Stop", {
			stop_hook_active: stopContinuations > 0,
			last_assistant_message: lastText,
		});
		report(result, ctx);
		if (result.stop) return undefined;
		const feedback = [
			...(result.blocked ? [result.reason ?? "A Stop hook asked to continue."] : []),
			...result.context,
		];
		if (feedback.length === 0) return undefined;
		if (stopContinuations >= MAX_STOP_CONTINUATIONS) {
			if (ctx.hasUI)
				ctx.ui.notify(`Stop hooks asked to continue ${MAX_STOP_CONTINUATIONS} times; stopping here.`, "warning");
			return undefined;
		}
		stopContinuations++;
		return {
			entries: [
				...event.entries,
				{
					type: "custom_message",
					customType: HOOK_FEEDBACK_MESSAGE_TYPE,
					content: `Stop hook feedback:\n${feedback.join("\n")}`,
					display: true,
				},
			],
			continue: true,
		};
	});

	on<SessionBeforeCompactEvent, { cancel: boolean } | undefined>("session_before_compact", async (event, ctx) => {
		if (!manager.hasHooks("PreCompact")) return undefined;
		const trigger = event.reason === "manual" ? "manual" : "auto";
		const result = await manager.run(
			"PreCompact",
			{ trigger, custom_instructions: event.customInstructions ?? "" },
			{ matchValues: [trigger], signal: event.signal },
		);
		report(result, ctx);
		if (result.blocked) {
			if (ctx.hasUI) ctx.ui.notify(`Compaction blocked by a PreCompact hook: ${result.reason ?? ""}`, "warning");
			return { cancel: true };
		}
		return undefined;
	});

	on<unknown, void>("agent_settled", async (_event, ctx) => {
		lastCtx = ctx;
		if (!ctx.hasUI || !manager.hasHooks("Notification")) return;
		void manager
			.run(
				"Notification",
				{ message: "RunKiln is waiting for your input", notification_type: "idle_prompt" },
				{ matchValues: ["idle_prompt"] },
			)
			.then((result) => report(result, ctx));
	});

	const extension: Extension = {
		path: HOOKS_EXTENSION_PATH,
		resolvedPath: HOOKS_EXTENSION_PATH,
		hidden: true,
		sourceInfo: createSyntheticSourceInfo(HOOKS_EXTENSION_PATH, { source: "builtin" }),
		handlers,
		tools: new Map(),
		messageRenderers: new Map(),
		commands: new Map(),
		flags: new Map(),
		shortcuts: new Map(),
	};
	return {
		extension,
		notify(type, message, title) {
			if (!manager.hasHooks("Notification")) return;
			void manager
				.run(
					"Notification",
					{ message, notification_type: type, ...(title ? { title } : {}) },
					{ matchValues: [type] },
				)
				.then((result) => report(result, lastCtx));
		},
	};
}
