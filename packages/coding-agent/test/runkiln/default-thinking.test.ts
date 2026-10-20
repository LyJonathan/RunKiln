import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
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
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { classification, MockClassifier, testCatalog } from "./router-fixtures.ts";

/**
 * `defaultThinkingLevel` (set in /models) drives manual models when the user has not set a level
 * with /thinking and auto routing is off, clamped to the levels the model supports.
 */
describe("defaultThinkingLevel for manual models", () => {
	let root: string;
	let faux: FauxProviderRegistration;
	let requests: Array<{ model: string; reasoning: string | undefined }>;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "runkiln-default-thinking-"));
		for (const dir of ["agent", "project", "sessions"]) mkdirSync(join(root, dir), { recursive: true });
		faux = registerFauxProvider({
			models: [
				{ id: "cheap", reasoning: true, cost: { input: 0.1, output: 0.4, cacheRead: 0.01, cacheWrite: 0 } },
				{ id: "strong", reasoning: true, cost: { input: 0.3, output: 1.2, cacheRead: 0.03, cacheWrite: 0 } },
			],
		});
		// Like glm-5-3-flash on RunInfra: low / high / max only.
		for (const model of faux.models as Model<Api>[]) {
			model.thinkingLevelMap = {
				off: null,
				minimal: null,
				low: "low",
				medium: null,
				high: "high",
				xhigh: null,
				max: "max",
			};
		}
		requests = [];
	});

	afterEach(() => {
		faux.unregister();
		rmSync(root, { recursive: true, force: true });
	});

	async function openSession(settings: SettingsManager) {
		const autoModels = createAutoModels(faux.models as Model<Api>[]);
		const runtime = {
			autoModel: autoModels.medium,
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
			classifier: new MockClassifier(() => classification({ difficulty: 0.1 })),
			getModels: () => faux.models as Model<Api>[],
			defaultModelId: () => "cheap",
		});
		const { session } = await createAgentSession({
			cwd: join(root, "project"),
			agentDir: join(root, "agent"),
			modelRuntime: runtime,
			model: faux.getModel("cheap"),
			settingsManager: settings,
			sessionManager: SessionManager.create(join(root, "project"), join(root, "sessions")),
			noTools: "all",
			router,
		});
		return { session, autoModel: autoModels.medium };
	}

	it("starts a manual model on the default level, clamped to what the model supports", async () => {
		const { session } = await openSession(SettingsManager.inMemory({ defaultThinkingLevel: "medium" }));
		expect(session.isAutoRouting).toBe(false);
		// medium is not supported: it clamps up to high.
		expect(session.thinkingLevel).toBe("high");
		faux.setResponses([fauxAssistantMessage("ok")]);
		await session.prompt("hello");
		expect(requests.at(-1)).toEqual({ model: "cheap", reasoning: "high" });
		session.dispose();
	});

	it("follows a changed default until the user sets a level with /thinking", async () => {
		const settings = SettingsManager.inMemory({ defaultThinkingLevel: "low" });
		const { session } = await openSession(settings);
		expect(session.thinkingLevel).toBe("low");

		settings.setDefaultThinkingLevel("xhigh");
		session.applyDefaultThinkingLevel();
		// xhigh is not supported: it clamps up to max.
		expect(session.thinkingLevel).toBe("max");

		session.setThinkingLevel("low");
		settings.setDefaultThinkingLevel("high");
		session.applyDefaultThinkingLevel();
		expect(session.thinkingLevel).toBe("low");
		session.dispose();
	});

	it("uses the default again when leaving auto mode, not the router's last level", async () => {
		const settings = SettingsManager.inMemory({ defaultThinkingLevel: "max" });
		const { session, autoModel } = await openSession(settings);
		await session.setModel(autoModel);
		faux.setResponses([fauxAssistantMessage("ok")]);
		await session.prompt("an easy question");
		const routed = session.lastRouteDecision?.thinkingLevel;
		expect(routed).toBeDefined();
		expect(routed).not.toBe("max");

		// In auto mode the router owns the level; the default does not override it.
		settings.setDefaultThinkingLevel("max");
		session.applyDefaultThinkingLevel();
		expect(session.thinkingLevel).toBe(routed);

		await session.setModel(faux.getModel("cheap") as Model<Api>);
		expect(session.isAutoRouting).toBe(false);
		expect(session.thinkingLevel).toBe("max");

		await session.setModel(autoModel);
		session.setAutoRouting(false);
		expect(session.thinkingLevel).toBe("max");
		session.dispose();
	});

	it("keeps an explicit SDK thinkingLevel over the default", async () => {
		const settings = SettingsManager.inMemory({ defaultThinkingLevel: "max" });
		const autoModels = createAutoModels(faux.models as Model<Api>[]);
		const runtime = {
			autoModel: autoModels.medium,
			autoModelFor: (mode: "low" | "medium" | "high" = "medium") => autoModels[mode],
			getAvailableSnapshot: () => [...(faux.models as Model<Api>[]), ...Object.values(autoModels)],
			getModelById: () => undefined,
			hasConfiguredAuth: () => true,
			checkAuth: async () => ({ type: "api_key" }),
		} as unknown as ModelRuntime;
		const { session } = await createAgentSession({
			cwd: join(root, "project"),
			agentDir: join(root, "agent"),
			modelRuntime: runtime,
			model: faux.getModel("cheap"),
			settingsManager: settings,
			sessionManager: SessionManager.create(join(root, "project"), join(root, "sessions")),
			thinkingLevel: "low",
			noTools: "all",
		});
		expect(session.thinkingLevel).toBe("low");
		session.applyDefaultThinkingLevel();
		expect(session.thinkingLevel).toBe("low");
		session.dispose();
	});
});
