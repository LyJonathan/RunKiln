import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Api,
	type Context,
	type FauxProviderRegistration,
	fauxAssistantMessage,
	type Model,
	registerFauxProvider,
	type SimpleStreamOptions,
	streamSimple,
} from "@runkiln/ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ModelRuntime } from "../../src/core/model-runtime.ts";
import { createAutoModels } from "../../src/core/router/index.ts";
import { ModelRouter } from "../../src/core/router/router.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { classification, MockClassifier, testCatalog } from "./router-fixtures.ts";

/** The router as the session runs it: auto picks per request, a manual pick overrides it. */
describe("auto model in a session", () => {
	let root: string;
	let faux: FauxProviderRegistration;
	let classifier: MockClassifier;
	let requests: Array<{ model: string; reasoning: string | undefined }>;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "runkiln-router-session-"));
		for (const dir of ["agent", "project", "sessions"]) mkdirSync(join(root, dir), { recursive: true });
		faux = registerFauxProvider({
			models: [
				{ id: "cheap", reasoning: true, cost: { input: 0.1, output: 0.4, cacheRead: 0.01, cacheWrite: 0 } },
				{ id: "strong", reasoning: true, cost: { input: 0.3, output: 1.2, cacheRead: 0.03, cacheWrite: 0 } },
			],
		});
		classifier = new MockClassifier((input) =>
			classification({ difficulty: input.request.includes("hard") ? 0.8 : 0.1 }),
		);
		requests = [];
	});

	afterEach(() => {
		faux.unregister();
		rmSync(root, { recursive: true, force: true });
	});

	async function openSession() {
		const autoModels = createAutoModels(faux.models as Model<Api>[]);
		const autoModel = autoModels.medium;
		const runtime = {
			autoModel,
			autoModelFor: (mode: "low" | "medium" | "high" = "medium") => autoModels[mode],
			getAvailableSnapshot: () => [...(faux.models as Model<Api>[]), ...Object.values(autoModels)],
			getModelById: () => undefined,
			hasConfiguredAuth: () => true,
			checkAuth: async () => ({ type: "api_key" }),
			streamSimple: (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => {
				requests.push({ model: model.id, reasoning: options?.reasoning });
				return streamSimple(model, context, options);
			},
		} as unknown as ModelRuntime;
		const router = new ModelRouter({
			catalog: testCatalog(),
			classifier,
			getModels: () => faux.models as Model<Api>[],
			defaultModelId: () => "cheap",
		});
		const { session } = await createAgentSession({
			cwd: join(root, "project"),
			agentDir: join(root, "agent"),
			modelRuntime: runtime,
			model: faux.getModel("cheap"),
			sessionManager: SessionManager.create(join(root, "project"), join(root, "sessions")),
			thinkingLevel: "off",
			noTools: "all",
			router,
		});
		return { session, autoModel, autoModels };
	}

	it("routes each new user turn and sends the chosen model and thinking level", async () => {
		const { session, autoModel } = await openSession();
		await session.setModel(autoModel);
		expect(session.isAutoRouting).toBe(true);
		expect(session.selectedModel?.id).toBe("auto:medium");

		faux.setResponses([fauxAssistantMessage("done")]);
		await session.prompt("a hard refactor");
		expect(classifier.calls).toHaveLength(1);
		expect(requests.at(-1)?.model).toBe("strong");
		expect(session.model?.id).toBe("strong");
		expect(session.lastRouteDecision?.source).toBe("classifier");
		expect(requests.at(-1)?.reasoning).toBe(session.lastRouteDecision?.thinkingLevel);

		faux.setResponses([fauxAssistantMessage("ok")]);
		await session.prompt("an easy question");
		expect(classifier.calls).toHaveLength(2);
		expect(session.formatRouterReport()).toContain("Last decision:");
		session.dispose();
	});

	it("lets a manual pick override routing, even after routed replies", async () => {
		const { session, autoModel } = await openSession();
		await session.setModel(autoModel);
		faux.setResponses([fauxAssistantMessage("done")]);
		await session.prompt("a hard task");
		expect(session.model?.id).toBe("strong");

		await session.setModel(faux.getModel("cheap") as Model<Api>);
		expect(session.isAutoRouting).toBe(false);
		faux.setResponses([fauxAssistantMessage("ok")]);
		await session.prompt("another hard task");
		expect(classifier.calls).toHaveLength(1);
		expect(requests.at(-1)?.model).toBe("cheap");
		session.dispose();
	});

	it("keeps a pinned thinking level over the router's choice", async () => {
		const { session, autoModel } = await openSession();
		await session.setModel(autoModel);
		session.setThinkingLevel("high");
		expect(session.isThinkingAuto).toBe(false);
		faux.setResponses([fauxAssistantMessage("ok")]);
		await session.prompt("easy");
		expect(session.lastRouteDecision?.routerThinkingLevel).toBe("off");
		expect(session.lastRouteDecision?.thinkingLevel).toBe("high");
		expect(requests.at(-1)?.reasoning).toBe("high");

		session.setThinkingAuto();
		expect(session.isThinkingAuto).toBe(true);
		faux.setResponses([fauxAssistantMessage("ok")]);
		await session.prompt("easy again");
		expect(requests.at(-1)?.reasoning).toBeUndefined();
		session.dispose();
	});

	it("cycles thinking through auto in auto mode", async () => {
		const { session, autoModel } = await openSession();
		await session.setModel(autoModel);
		expect(session.cycleThinkingLevel()).toBe("off");
		expect(session.isThinkingAuto).toBe(false);
		let level: string | undefined;
		for (let i = 0; i < 10 && level !== "auto"; i++) level = session.cycleThinkingLevel();
		expect(level).toBe("auto");
		expect(session.isThinkingAuto).toBe(true);
		session.dispose();
	});

	it("selects routing modes as auto:<mode> models, cycles through them, and routes with the mode", async () => {
		const { session, autoModels } = await openSession();
		await session.setModel(autoModels.high);
		expect(session.isAutoRouting).toBe(true);
		expect(session.routerMode).toBe("high");
		expect(session.selectedModel?.id).toBe("auto:high");
		faux.setResponses([fauxAssistantMessage("ok")]);
		await session.prompt("a hard task");
		expect(session.lastRouteDecision?.mode).toBe("high");
		// High mode: the strongest model at its deepest allowed level for a non-trivial request.
		expect(requests.at(-1)).toEqual({ model: "strong", reasoning: "high" });
		faux.setResponses([fauxAssistantMessage("ok")]);
		await session.prompt("easy");
		// A trivial turn in high mode: the cheapest model, thinking floored at low (never off).
		expect(session.lastRouteDecision?.trivial).toBe(true);
		expect(requests.at(-1)).toEqual({ model: "cheap", reasoning: "low" });

		session.setRouterMode("low");
		faux.setResponses([fauxAssistantMessage("ok")]);
		await session.prompt("easy again");
		expect(session.lastRouteDecision?.mode).toBe("low");
		// Low mode caps thinking at low: momentum from the hard task may move the model, never the level.
		expect(["off", "minimal", "low"]).toContain(requests.at(-1)?.reasoning ?? "off");

		// Ctrl+P order: cheap, strong, auto:low, auto:medium, auto:high.
		// Backward from auto:low leaves auto mode for the concrete model before it.
		const back = await session.cycleModel("backward");
		expect(back?.model.id).toBe("strong");
		expect(session.isAutoRouting).toBe(false);
		const low = await session.cycleModel("forward");
		expect(low?.model.id).toBe("auto:low");
		expect(session.routerMode).toBe("low");
		const medium = await session.cycleModel("forward");
		expect(medium?.model.id).toBe("auto:medium");
		expect(session.routerMode).toBe("medium");
		const high = await session.cycleModel("forward");
		expect(high?.model.id).toBe("auto:high");
		const leave = await session.cycleModel("forward");
		expect(leave?.model.id).toBe("cheap");
		expect(session.isAutoRouting).toBe(false);
		session.dispose();
	});

	it("cycles auto:low → medium → high with the mode-cycle key, turning auto on from a manual model", async () => {
		const { session } = await openSession();
		expect(session.isAutoRouting).toBe(false);
		expect(session.cycleRouterMode()).toBe("medium");
		expect(session.isAutoRouting).toBe(true);
		expect(session.selectedModel?.id).toBe("auto:medium");
		expect(session.cycleRouterMode()).toBe("high");
		expect(session.cycleRouterMode()).toBe("low");
		expect(session.selectedModel?.id).toBe("auto:low");
		expect(session.cycleRouterMode()).toBe("medium");
		session.setThinkingLevel("high");
		expect(session.cycleRouterMode()).toBe("high");
		expect(session.pinnedThinkingLevel).toBe("high");
		expect(session.formatRouterReport({ modeCycleKey: "alt+r" })).toContain("alt+r cycles them");
		session.dispose();
	});

	it("never routes to a model hidden by the disabledModels setting", async () => {
		writeFileSync(join(root, "agent", "settings.json"), JSON.stringify({ disabledModels: ["strong", 42] }));
		const { session, autoModel } = await openSession();
		await session.setModel(autoModel);
		faux.setResponses([fauxAssistantMessage("ok")]);
		await session.prompt("a hard task");
		expect(requests.at(-1)?.model).toBe("cheap");
		expect(session.lastRouteDecision?.selection?.candidates.map((c) => c.model)).toEqual(["cheap"]);
		session.dispose();
	});

	it("ignores a malformed disabledModels setting", async () => {
		writeFileSync(join(root, "agent", "settings.json"), JSON.stringify({ disabledModels: "strong" }));
		const { session, autoModel } = await openSession();
		await session.setModel(autoModel);
		faux.setResponses([fauxAssistantMessage("ok")]);
		await session.prompt("a hard task");
		expect(requests.at(-1)?.model).toBe("strong");
		session.dispose();
	});
});
