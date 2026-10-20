import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildOpenAICompletionsParams } from "@runkiln/ai/api/openai-completions";
import {
	type Api,
	type Context,
	fauxAssistantMessage,
	fauxToolCall,
	getApiProvider,
	type Model,
	registerApiProvider,
	type SimpleStreamOptions,
	streamSimple,
	type ToolResultMessage,
	type TranscriptContext,
	unregisterApiProviders,
} from "@runkiln/ai/compat";
import { createFauxCore } from "@runkiln/ai/providers/faux";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ModelRuntime } from "../../src/core/model-runtime.ts";
import { createAutoModels } from "../../src/core/router/index.ts";
import { ModelRouter } from "../../src/core/router/router.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { classification, MockClassifier, testCatalog } from "./router-fixtures.ts";

/** The wire format the prefix is compared in: RunInfra's Chat Completions body. */
const runInfraModel = {
	id: "glm-5-3-flash",
	name: "GLM 5.3 Flash",
	api: "openai-completions",
	provider: "runinfra",
	baseUrl: "https://api.runinfra.ai/v1",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0.11, output: 0.45, cacheRead: 0.03, cacheWrite: 0 },
	contextWindow: 1048576,
	maxTokens: 32768,
} as Model<"openai-completions">;

/**
 * Byte stability across a scripted session: every request must extend the previous one byte for byte (tool
 * definitions, system message, history), whatever the user toggles between turns: plan mode, auto routing
 * (Alt+R), the thinking level, a tool turned off, /reload with changed instructions and a todo setting change.
 * A break here is a full prefix-cache miss on RunInfra.
 */
describe("request prefix across a scripted session with mode toggles", () => {
	let root: string;
	let projectDir: string;
	let agentDir: string;
	let faux: ReturnType<typeof createFauxCore>;
	let requests: TranscriptContext[];

	let models: string[];

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "runkiln-stable-"));
		projectDir = join(root, "project");
		agentDir = join(root, "agent");
		for (const dir of [agentDir, projectDir, join(root, "sessions")]) mkdirSync(dir, { recursive: true });
		writeFileSync(join(projectDir, "notes.txt"), "line one\nline two\n");
		writeFileSync(join(projectDir, "AGENTS.md"), "Indent with tabs.\n");
		requests = [];
		models = [];
		faux = createFauxCore({
			models: [
				{
					id: "cheap",
					reasoning: true,
					contextWindow: 1_000_000,
					cost: { input: 0.1, output: 0.4, cacheRead: 0.01, cacheWrite: 0 },
				},
				{
					id: "strong",
					reasoning: true,
					contextWindow: 1_000_000,
					cost: { input: 0.3, output: 1.2, cacheRead: 0.03, cacheWrite: 0 },
				},
			],
		});
	});

	afterEach(() => {
		unregisterApiProviders("cache-stability");
		rmSync(root, { recursive: true, force: true });
	});

	function capture(reply: ReturnType<typeof fauxAssistantMessage>) {
		return (context: TranscriptContext) => {
			requests.push(structuredClone(context));
			return reply;
		};
	}

	function wire(context: TranscriptContext) {
		const params = buildOpenAICompletionsParams(runInfraModel, context);
		return {
			tools: JSON.stringify(params.tools ?? []),
			messages: params.messages.map((message) => JSON.stringify(message)),
		};
	}

	function expectEachRequestExtendsThePrevious(): void {
		const wired = requests.map(wire);
		for (let i = 1; i < wired.length; i++) {
			const earlier = wired[i - 1];
			const later = wired[i];
			expect(later.tools, `tools changed at request ${i + 1}`).toBe(earlier.tools);
			expect(later.messages.length).toBeGreaterThan(earlier.messages.length);
			expect(later.messages.slice(0, earlier.messages.length), `prefix broke at request ${i + 1}`).toEqual(
				earlier.messages,
			);
		}
	}

	const toolResults = (session: { messages: unknown[] }, name: string) =>
		(session.messages as ToolResultMessage[]).filter(
			(message) => message.role === "toolResult" && message.toolName === name,
		);
	const text = (result: ToolResultMessage) =>
		result.content.map((part) => (part.type === "text" ? part.text : "")).join("");

	it("extends the previous request byte for byte through every toggle", async () => {
		const register = () =>
			registerApiProvider(
				{ api: faux.api, stream: faux.stream, streamSimple: faux.streamSimple },
				"cache-stability",
			);
		register();
		const autoModels = createAutoModels(faux.models as Model<Api>[]);
		const runtime = {
			autoModel: autoModels.medium,
			autoModelFor: (mode: "low" | "medium" | "high" = "medium") => autoModels[mode],
			getAvailableSnapshot: () => [...(faux.models as Model<Api>[]), ...Object.values(autoModels)],
			getModelById: () => undefined,
			hasConfiguredAuth: () => true,
			checkAuth: async () => ({ type: "api_key" }),
			streamSimple: (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => {
				models.push(model.id);
				// /reload resets the API provider registry: put the faux back the way registerFauxProvider does.
				if (!getApiProvider(faux.api)) register();
				return streamSimple(model, context, options);
			},
		} as unknown as ModelRuntime;
		const router = new ModelRouter({
			catalog: testCatalog(),
			classifier: new MockClassifier((input) =>
				classification({ difficulty: input.request.includes("hard") ? 0.8 : 0.1 }),
			),
			getModels: () => faux.models as Model<Api>[],
			defaultModelId: () => "cheap",
		});
		const { session } = await createAgentSession({
			cwd: projectDir,
			agentDir,
			modelRuntime: runtime,
			model: faux.getModel("cheap"),
			sessionManager: SessionManager.create(projectDir, join(root, "sessions")),
			thinkingLevel: "off",
			router,
		});
		const declared = () => session.getActiveToolNames();
		expect(declared()).toContain("todo");
		expect(declared()).toContain("edit");

		// 1. A turn with a tool call.
		faux.setResponses([
			capture(fauxAssistantMessage([fauxToolCall("read", { path: "notes.txt" })], { stopReason: "toolUse" })),
			capture(fauxAssistantMessage("Two lines.")),
		]);
		await session.prompt("What is in notes.txt?");

		// 2. Plan mode on (Alt+M), a turn that asks a question, then back.
		const previousMode = session.permissionMode;
		session.setPermissionMode("plan");
		faux.appendResponses([capture(fauxAssistantMessage("Which file should the plan cover?"))]);
		await session.prompt("Plan a refactor.");
		session.setPermissionMode(previousMode);

		// 3. Auto routing on (Alt+R) for a routed turn on another model, then off, thinking level changed.
		session.setAutoRouting(true);
		faux.appendResponses([capture(fauxAssistantMessage("Refactored."))]);
		await session.prompt("Now a hard refactor.");
		expect(models.at(-1)).toBe("strong");
		session.setAutoRouting(false);
		session.setThinkingLevel("high");
		faux.appendResponses([capture(fauxAssistantMessage("Noted."))]);
		await session.prompt("Keep going.");

		// 4. A tool turned off mid-session (an extension or /tools): still declared, refused when called.
		session.setActiveToolsByName(declared().filter((name) => name !== "edit"));
		faux.appendResponses([
			capture(
				fauxAssistantMessage([fauxToolCall("edit", { path: "notes.txt", edits: [] })], { stopReason: "toolUse" }),
			),
			capture(fauxAssistantMessage("Edit is off.")),
		]);
		await session.prompt("Edit notes.txt.");
		expect(text(toolResults(session, "edit").at(-1) as ToolResultMessage)).toMatch(/turned off for this session/);

		// 5. /reload after the project instructions changed and the todo tool was turned off in settings.
		writeFileSync(join(projectDir, "AGENTS.md"), "Indent with two spaces.\n");
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ todo: { enabled: false } }));
		await session.reload();
		faux.appendResponses([
			capture(fauxAssistantMessage([fauxToolCall("todo", { items: [] })], { stopReason: "toolUse" })),
			capture(fauxAssistantMessage("Done.")),
		]);
		await session.prompt("Tidy up.");
		expect(text(toolResults(session, "todo").at(-1) as ToolResultMessage)).toMatch(/turned off for this session/);

		// 6. One more plain turn.
		faux.appendResponses([capture(fauxAssistantMessage("Bye."))]);
		await session.prompt("Thanks.");

		expect(requests).toHaveLength(10);
		expectEachRequestExtendsThePrevious();
		// The changed instructions reached the model as an appended note, not as a new system prompt.
		const last = wire(requests.at(-1) as TranscriptContext).messages;
		expect(last[0]).toContain("Indent with tabs.");
		expect(last[0]).not.toContain("two spaces");
		const notes = last.filter((message) => message.includes("[Session update, not from the user]"));
		expect(notes).toHaveLength(1);
		expect(notes[0]).toContain("Indent with two spaces.");
		// The declared tools never changed.
		expect(declared()).toContain("todo");
		expect(declared()).toContain("edit");
	});
});
