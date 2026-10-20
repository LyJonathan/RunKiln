import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type Api,
	type Context,
	type FauxProviderRegistration,
	fauxAssistantMessage,
	fauxToolCall,
	type Model,
	registerFauxProvider,
	type SimpleStreamOptions,
	streamSimple,
	type ToolResultMessage,
} from "@runkiln/ai/compat";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelRuntime } from "../../src/core/model-runtime.ts";
import { parseRouterCatalog } from "../../src/core/router/catalog.ts";
import { ModelRouter, type RouteRequest } from "../../src/core/router/router.ts";
import { extractTurnSignals, type SignalMessage } from "../../src/core/router/signals.ts";
import { parseModelsCatalog } from "../../src/core/runkiln/models-catalog.ts";
import type { PermissionMode } from "../../src/core/runkiln/permissions.ts";
import { setProcessPermissionMode } from "../../src/core/runkiln/permissions.ts";
import {
	createTodoToolDefinition,
	currentTodoItems,
	formatTodoResult,
	normalizeTodoItems,
	TODO_NUDGE_MESSAGE_TYPE,
	TODO_TOOL_DESCRIPTION,
	todoNudgeText,
} from "../../src/core/runkiln/todo.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { MockClassifier, signals } from "./router-fixtures.ts";

describe("todo list model", () => {
	it("normalizes loose input: statuses, empty text, duplicate ids, caps", () => {
		const items = normalizeTodoItems([
			{ id: "a", text: "  read the code ", status: "completed" },
			{ id: "a", text: "write the fix", status: "In Progress" },
			{ id: "c", text: "", status: "pending" },
			{ text: "run tests", status: "whatever" },
			"junk",
		]);
		expect(items).toEqual([
			{ id: "a", text: "read the code", status: "done" },
			{ id: "2", text: "write the fix", status: "in_progress" },
			{ id: "4", text: "run tests", status: "pending" },
		]);
		expect(normalizeTodoItems(Array.from({ length: 50 }, (_, i) => ({ id: `${i}`, text: `t${i}` })))).toHaveLength(
			30,
		);
	});

	it("summarizes the list for the model and builds the nudge from unfinished items only", () => {
		const items = normalizeTodoItems([
			{ id: "1", text: "read", status: "done" },
			{ id: "2", text: "fix", status: "in_progress" },
			{ id: "3", text: "test", status: "pending" },
		]);
		expect(formatTodoResult(items)).toBe("Todo list saved: 1/3 done. In progress: fix");
		expect(formatTodoResult([])).toBe("Todo list cleared.");
		const nudge = todoNudgeText(items);
		expect(nudge).toContain("2 unfinished items");
		expect(nudge).toContain("- [~] fix");
		expect(nudge).toContain("- [ ] test");
		expect(nudge).not.toContain("read");
	});

	it("the current list is the newest successful todo result", () => {
		const result = (items: unknown, isError = false) => ({
			role: "toolResult",
			toolName: "todo",
			isError,
			details: { items },
		});
		expect(currentTodoItems([])).toEqual([]);
		const messages = [
			result([{ id: "1", text: "old", status: "pending" }]),
			{ role: "toolResult", toolName: "bash", details: { items: [] } },
			result([{ id: "1", text: "new", status: "done" }]),
			result([{ id: "1", text: "broken", status: "done" }], true),
		];
		expect(currentTodoItems(messages)).toEqual([{ id: "1", text: "new", status: "done" }]);
	});

	it("keeps the definition small and stable (cached prefix)", () => {
		const definition = createTodoToolDefinition();
		const declared = JSON.stringify({
			name: definition.name,
			description: definition.description,
			parameters: definition.parameters,
		});
		// About 4 characters per token: stay near 120 tokens.
		expect(declared.length).toBeLessThan(640);
		expect(definition.description).toBe(TODO_TOOL_DESCRIPTION);
		expect(JSON.stringify(createTodoToolDefinition().parameters)).toBe(JSON.stringify(definition.parameters));
	});

	it("accepts a JSON-string list or a todos key", () => {
		const definition = createTodoToolDefinition();
		expect(definition.prepareArguments?.({ items: '[{"id":"1","text":"x","status":"pending"}]' })).toEqual({
			items: [{ id: "1", text: "x", status: "pending" }],
		});
		expect(definition.prepareArguments?.({ todos: [{ id: "1", text: "y", status: "done" }] })).toEqual({
			items: [{ id: "1", text: "y", status: "done" }],
		});
	});
});

describe("unfinished todo items as a router signal", () => {
	const user = (text: string): SignalMessage => ({ role: "user", content: text });
	const todoCall = (id: string, items: unknown): SignalMessage => ({
		role: "assistant",
		stopReason: "toolUse",
		content: [{ type: "toolCall", id, name: "todo", arguments: { items } }],
	});
	const todoResult = (id: string, items: unknown): SignalMessage => ({
		role: "toolResult",
		toolCallId: id,
		toolName: "todo",
		content: [{ type: "text", text: "saved" }],
		details: { items },
	});
	const done = (text: string): SignalMessage => ({
		role: "assistant",
		stopReason: "stop",
		content: [{ type: "text", text }],
	});

	it("reports the previous turn's unfinished items, and none once they are done", () => {
		const open = [
			{ id: "1", text: "a", status: "done" },
			{ id: "2", text: "b", status: "pending" },
		];
		const unfinished = extractTurnSignals(
			[user("do a and b"), todoCall("t", open), todoResult("t", open), done("did a"), user("continue")],
			{ contextTokens: 1 },
		);
		expect(unfinished.previousTurn?.unfinishedTodos).toBe(1);
		const closed = open.map((item) => ({ ...item, status: "done" }));
		const finished = extractTurnSignals(
			[user("do a and b"), todoCall("t", closed), todoResult("t", closed), done("all done"), user("thanks")],
			{ contextTokens: 1 },
		);
		expect(finished.previousTurn?.unfinishedTodos).toBeUndefined();
	});

	const repo = join(dirname(fileURLToPath(import.meta.url)), "../../../..");
	const catalog = parseRouterCatalog([{ text: readFileSync(join(repo, "router.yaml"), "utf8"), path: "router.yaml" }]);
	const models = parseModelsCatalog(readFileSync(join(repo, "models.yaml"), "utf8"), "models.yaml").chatModels.filter(
		(model) => model.id === "glm-5-3-flash" || model.id === "deepseek-v4-1-flash",
	);
	const turn = (text: string, extra: Partial<RouteRequest["signals"]> = {}): RouteRequest => ({
		signals: signals({ latestUserText: text, contextTokens: 14000, ...extra }),
		role: "code",
		toolsActive: true,
		mode: "medium",
	});

	it("steps up after a turn that stopped with unfinished items, unless it asked the user something", async () => {
		const classifier = new MockClassifier(() => ({
			skills: [],
			difficulty: 0.45,
			confidence: 1,
			needsTools: true,
			kind: "code",
		}));
		const router = new ModelRouter({
			catalog,
			classifier,
			getModels: () => models as readonly Model<Api>[],
			defaultModelId: () => "glm-5-3-flash",
		});
		await router.route(turn("refactor the parser in four steps"));
		const stopped = { errored: false, toolErrors: 0, testFailures: 0, lastTestPassed: false, unfinishedTodos: 2 };
		const next = await router.route(turn("keep going on the parser", { previousTurn: stopped }));
		expect(next.escalationSteps).toBe(1);
		const asked = await router.route(
			turn("use the second option for the parser", { previousTurn: stopped, assistantAsked: true }),
		);
		expect(asked.escalationSteps ?? 0).toBe(0);
	});
});

describe("todo tool on the session", () => {
	let root: string;
	let agentDir: string;
	let projectDir: string;
	let faux: FauxProviderRegistration;

	const runtime = {
		getModelById: () => undefined,
		hasConfiguredAuth: () => true,
		streamSimple: (model: Model<Api>, context: Context, options?: SimpleStreamOptions) =>
			streamSimple(model, context, options),
	} as unknown as ModelRuntime;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "runkiln-todo-"));
		agentDir = join(root, "agent");
		projectDir = join(root, "project");
		for (const dir of [agentDir, projectDir, join(root, "sessions")]) mkdirSync(dir, { recursive: true });
		faux = registerFauxProvider();
		vi.stubEnv("TYPESAFE_API_KEY", "");
		vi.stubEnv("OPENROUTER_API_KEY", "");
	});

	afterEach(() => {
		faux.unregister();
		setProcessPermissionMode(undefined);
		vi.unstubAllEnvs();
		rmSync(root, { recursive: true, force: true });
	});

	async function openSession(mode: PermissionMode, settings: Record<string, unknown> = {}) {
		const settingsManager = SettingsManager.inMemory(settings as never);
		const result = await createAgentSession({
			cwd: projectDir,
			agentDir,
			modelRuntime: runtime,
			model: faux.getModel(),
			settingsManager,
			sessionManager: SessionManager.create(projectDir, join(root, "sessions")),
			thinkingLevel: "off",
			permissionMode: mode,
		});
		return result.session;
	}

	const open = [
		{ id: "1", text: "read the code", status: "done" },
		{ id: "2", text: "write the fix", status: "pending" },
	];

	it("is active by default, runs without a prompt in ask and plan mode, and persists in the session", async () => {
		for (const mode of ["ask", "plan"] as const) {
			const session = await openSession(mode);
			expect(session.getActiveToolNames()).toContain("todo");
			const prompts: unknown[] = [];
			session.setApprovalPrompt(async (prompt) => {
				prompts.push(prompt);
				return { choice: "deny" };
			});
			faux.setResponses([
				fauxAssistantMessage([fauxToolCall("todo", { items: open.map((item) => ({ ...item, status: "done" })) })], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("done"),
			]);
			await session.prompt("plan it");
			const result = session.messages.find(
				(message): message is ToolResultMessage => message.role === "toolResult" && message.toolName === "todo",
			);
			expect(result?.isError).toBe(false);
			expect(prompts).toHaveLength(0);
			expect(session.todoItems.map((item) => item.status)).toEqual(["done", "done"]);
			session.dispose();
		}
	});

	it("nudges once with a hidden message when the run ends with unfinished items", async () => {
		const session = await openSession("allow-all");
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("todo", { items: open })], { stopReason: "toolUse" }),
			fauxAssistantMessage("I read the code."),
			fauxAssistantMessage("Still not done, sorry."),
		]);
		await session.prompt("fix it");
		const nudges = session.messages.filter(
			(message) =>
				message.role === "custom" && (message as { customType?: string }).customType === TODO_NUDGE_MESSAGE_TYPE,
		);
		expect(nudges).toHaveLength(1);
		expect((nudges[0] as { display?: boolean }).display).toBe(false);
		const last = session.messages[session.messages.length - 1];
		expect(last.role).toBe("assistant");
		// The second answer came after the nudge; there was no second nudge.
		expect(faux.state.callCount).toBe(3);
		session.dispose();
	});

	it("does not nudge when todo.nudge is off, and is not offered when todo.enabled is off", async () => {
		const quiet = await openSession("allow-all", { todo: { nudge: false } });
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("todo", { items: open })], { stopReason: "toolUse" }),
			fauxAssistantMessage("Stopping here."),
		]);
		await quiet.prompt("fix it");
		expect(faux.state.callCount).toBe(2);
		quiet.dispose();
		const off = await openSession("allow-all", { todo: { enabled: false } });
		expect(off.getActiveToolNames()).not.toContain("todo");
		off.dispose();
	});
});
