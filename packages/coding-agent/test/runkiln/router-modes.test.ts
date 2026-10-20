import { describe, expect, it, vi } from "vitest";
import { ModelRuntime } from "../../src/core/model-runtime.ts";
import { autoModelId, isAutoModelId, parseAutoMode } from "../../src/core/router/index.ts";
import { ModelRouter } from "../../src/core/router/router.ts";
import { mergeLiveCatalog, parseLiveModels } from "../../src/core/runkiln/live-catalog.ts";
import { parseModelsCatalog } from "../../src/core/runkiln/models-catalog.ts";
import { classification, MockClassifier, signals, TEST_MODELS, testCatalog, testModel } from "./router-fixtures.ts";

const THINKING_ORDER = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

function routerWith(models = TEST_MODELS, answer = classification({ difficulty: 0.4 })) {
	const classifier = new MockClassifier(() => answer);
	const router = new ModelRouter({
		catalog: testCatalog(),
		classifier,
		getModels: () => models,
		defaultModelId: () => "cheap",
	});
	return { router, classifier };
}

describe("routing modes", () => {
	it("names modes as auto:<mode>", () => {
		expect(isAutoModelId("auto")).toBe(true);
		expect(isAutoModelId("auto:high")).toBe(true);
		expect(isAutoModelId("runinfra/auto:low")).toBe(true);
		expect(isAutoModelId("auto:turbo")).toBe(false);
		expect(isAutoModelId("glm-5-3-flash")).toBe(false);
		expect(parseAutoMode("auto:LOW")).toBe("low");
		expect(parseAutoMode("auto")).toBeUndefined();
		expect(autoModelId("medium")).toBe("auto:medium");
	});

	it("spends more and thinks deeper from low to medium to high on the same request", async () => {
		const results = [];
		for (const mode of ["low", "medium", "high"] as const) {
			const { router } = routerWith();
			results.push(await router.route({ signals: signals(), role: "code", toolsActive: true, mode }));
		}
		const [low, medium, high] = results;
		expect(results.map((d) => d.mode)).toEqual(["low", "medium", "high"]);
		// low: cheapest capable pair; medium: higher bar -> more thinking or a stronger model; high: deepest.
		expect(low.model.id).toBe("cheap");
		expect(low.estCostUsd ?? 0).toBeLessThanOrEqual(medium.estCostUsd ?? 0);
		expect(medium.estCostUsd ?? 0).toBeLessThanOrEqual(high.estCostUsd ?? 0);
		const depth = (level: string) => THINKING_ORDER.indexOf(level);
		expect(depth(low.thinkingLevel)).toBeLessThanOrEqual(depth(medium.thinkingLevel));
		expect(depth(medium.thinkingLevel)).toBeLessThanOrEqual(depth(high.thinkingLevel));
		expect(high.model.id).toBe("strong");
		expect(high.thinkingLevel).toBe("high");
	});

	it("gives simple tasks the cheapest model at the lowest level in every mode but high", async () => {
		for (const mode of ["low", "medium"] as const) {
			const { router } = routerWith(TEST_MODELS, classification({ difficulty: 0.05 }));
			const decision = await router.route({ signals: signals(), role: "code", toolsActive: false, mode });
			expect([decision.model.id, decision.thinkingLevel]).toEqual(["cheap", "off"]);
		}
	});

	it("re-selects mid-turn when the mode changes, without a classifier call", async () => {
		const { router, classifier } = routerWith();
		const first = await router.route({ signals: signals(), role: "code", toolsActive: true, mode: "low" });
		const next = await router.route({
			signals: signals({ isNewUserTurn: false, toolCallsThisTurn: 1, warmModelId: first.model.id }),
			role: "code",
			toolsActive: true,
			mode: "high",
		});
		expect(classifier.calls).toHaveLength(1);
		expect(next.source).toBe("reselect");
		expect(next.mode).toBe("high");
		expect(next.model.id).toBe("strong");
	});
});

describe("models the catalog does not score", () => {
	it("routes a new model with default scores and a price prior", () => {
		const newcomer = testModel("brand-new", { cost: { input: 0.6, output: 2.4, cacheRead: 0.06, cacheWrite: 0 } });
		const budget = testModel("budget-new", { cost: { input: 0.05, output: 0.1, cacheRead: 0.01, cacheWrite: 0 } });
		const { router } = routerWith([...TEST_MODELS, newcomer, budget]);
		const scores = router.scoresFor(newcomer);
		// Median scored output price is 1.2 (cheap 0.4, strong 1.2 -> upper median); 2.4 is 2x -> +8.
		expect(scores.derived).toBe(true);
		expect(scores.skills["code.bugfix"]).toBe(53);
		// 0.1 is 12x cheaper -> about -29, clamped to min_score 25.
		expect(router.scoresFor(budget).skills["code.bugfix"]).toBe(25);
		expect(router.scoresFor(TEST_MODELS[0]).derived).toBe(false);
		expect(router.candidateModels().map((entry) => entry.model.id)).toEqual([
			"cheap",
			"strong",
			"brand-new",
			"budget-new",
		]);
	});

	it("keeps a model out when router.yaml or unknown_model says route: false", () => {
		const newcomer = testModel("brand-new");
		const catalog = testCatalog("models:\n  strong:\n    route: false\nunknown_model:\n  route: false\n");
		const router = new ModelRouter({
			catalog,
			getModels: () => [...TEST_MODELS, newcomer],
			defaultModelId: () => "cheap",
		});
		expect(router.candidateModels().map((entry) => entry.model.id)).toEqual(["cheap"]);
	});
});

const LIVE_BODY = {
	object: "list",
	data: [
		{
			id: "glm-5-3-flash",
			display_name: "GLM 5.3 Flash",
			availability: "available",
			context_window: 1048576,
			pricing: { input: 0.12, output: 0.5 },
			cached_input_price: 0.03,
			input_modalities: ["text", "image"],
			reasoning_efforts: ["low", "high", "max"],
			default_reasoning_effort: "max",
			tool_calling: true,
			modality: "llm",
			supported_endpoints: ["chat_completions", "messages"],
		},
		{
			id: "deepseek-v4-1-flash",
			availability: "paused",
			paused_until: "2026-10-16T00:00:00Z",
			reasoning_efforts: ["none", "low", "medium", "max"],
		},
		{
			id: "glm-6-flash",
			display_name: "GLM 6 Flash",
			availability: "available",
			context_window: 524288,
			max_output_tokens: 131072,
			pricing: { input: 0.2, output: 0.8 },
			cached_input_price: 0.04,
			input_modalities: ["text"],
			reasoning_efforts: ["none", "low", "high"],
			default_reasoning_effort: "low",
			modality: "llm",
		},
		{ id: "some-embedder", modality: "embedding", availability: "available" },
	],
};

const MODELS_YAML = `
provider: runinfra
defaults:
  code: glm-5-3-flash
  chat: deepseek-v4-1-flash
  title: glm-5-3-flash
  fallback: [glm-5-3-flash]
models:
  - id: glm-5-3-flash
    name: GLM 5.3 Flash
    roles: [code]
    price: { in: 0.11, out: 0.45, cached_in: 0.03 }
    context: 1048576
    images: true
    reasoning_efforts: [low, high, max]
    harness_effort: low
  - id: deepseek-v4-1-flash
    name: DeepSeek V4.1 Flash
    roles: [chat]
    price: { in: 0.14, out: 0.58, cached_in: 0.03 }
    context: 1048576
    images: false
    reasoning_efforts: [none, low, high, xhigh, max]
    harness_effort: none
  - id: qwen3-8-27b
    name: Qwen3.8 27B
    roles: [fallback]
    price: { in: 0.1, out: 0.4, cached_in: 0.01 }
    context: 262144
    images: true
    reasoning_efforts: [none, low, medium, xhigh]
    harness_effort: none
`;

describe("RunInfra live catalog", () => {
	it("parses /v1/models and keeps chat models only", () => {
		const entries = parseLiveModels(LIVE_BODY);
		expect(entries.map((entry) => entry.id)).toEqual([
			"glm-5-3-flash",
			"deepseek-v4-1-flash",
			"glm-6-flash",
			"some-embedder",
		]);
		expect(() => parseLiveModels({ error: "nope" })).toThrow(/no data/);
		const catalog = parseModelsCatalog(MODELS_YAML, "models.yaml");
		const merged = mergeLiveCatalog(catalog.chatModels, entries, "https://api.runinfra.ai/v1");
		expect(merged.models.map((model) => model.id)).toEqual(["glm-5-3-flash", "deepseek-v4-1-flash", "glm-6-flash"]);
		expect(merged.added).toEqual(["glm-6-flash"]);
		expect(merged.missing).toEqual(["qwen3-8-27b"]);
		expect(merged.paused).toEqual(["deepseek-v4-1-flash"]);
	});

	it("takes live prices and limits, keeps the models.yaml harness effort, and builds new models", () => {
		const catalog = parseModelsCatalog(MODELS_YAML, "models.yaml");
		const merged = mergeLiveCatalog(catalog.chatModels, parseLiveModels(LIVE_BODY), "https://api.runinfra.ai/v1");
		const glm = merged.models[0];
		expect(glm.cost).toMatchObject({ input: 0.12, output: 0.5, cacheRead: 0.03 });
		expect(glm.reasoningEffort).toBe("low");
		// Live reasoning_efforts (measured distinct) replace models.yaml's for deepseek.
		expect(merged.models[1].thinkingLevelMap).toMatchObject({
			off: "none",
			low: "low",
			medium: "medium",
			high: null,
			max: "max",
		});
		const fresh = merged.models[2];
		expect(fresh).toMatchObject({
			name: "GLM 6 Flash",
			provider: "runinfra",
			reasoning: true,
			reasoningEffort: "low",
			input: ["text"],
			contextWindow: 524288,
			maxTokens: 32768,
			cost: { input: 0.2, output: 0.8, cacheRead: 0.04, cacheWrite: 0 },
		});
	});

	async function runtimeWith(fetch: typeof globalThis.fetch, offline = false) {
		return ModelRuntime.create({
			catalog: parseModelsCatalog(MODELS_YAML, "models.yaml"),
			runInfraConfig: { baseUrl: "https://api.runinfra.ai/v1", apiKey: "ri_test" },
			fetch,
			offline,
		});
	}

	it("rebuilds the model list from the live catalog and routes only available models", async () => {
		const fetch = vi.fn(async () => new Response(JSON.stringify(LIVE_BODY), { status: 200 }));
		const runtime = await runtimeWith(fetch);
		expect(runtime.getRoutableModels().map((model) => model.id)).toEqual([
			"glm-5-3-flash",
			"deepseek-v4-1-flash",
			"qwen3-8-27b",
		]);
		const status = await runtime.refreshLiveCatalog();
		expect(fetch).toHaveBeenCalledWith("https://api.runinfra.ai/v1/models", expect.anything());
		expect(status).toMatchObject({ available: ["glm-5-3-flash", "glm-6-flash"], paused: ["deepseek-v4-1-flash"] });
		expect(runtime.getRoutableModels().map((model) => model.id)).toEqual(["glm-5-3-flash", "glm-6-flash"]);
		// Paused models stay listed for manual picks; the auto modes are listed too.
		expect(runtime.getAvailableSnapshot().map((model) => model.id)).toEqual([
			"glm-5-3-flash",
			"deepseek-v4-1-flash",
			"glm-6-flash",
			"auto:low",
			"auto:medium",
			"auto:high",
		]);
		// Cached: no second request inside the TTL.
		await runtime.refreshLiveCatalog();
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it("keeps models.yaml when the live catalog fails or the runtime is offline", async () => {
		const failing = vi.fn(async () => new Response("down", { status: 503 }));
		const runtime = await runtimeWith(failing);
		const status = await runtime.refreshLiveCatalog();
		expect(status.error).toMatch(/503/);
		expect(runtime.getRoutableModels()).toHaveLength(3);

		const never = vi.fn();
		const offline = await runtimeWith(never as unknown as typeof globalThis.fetch, true);
		expect((await offline.refreshLiveCatalog()).error).toBe("offline");
		expect(never).not.toHaveBeenCalled();
	});
});
