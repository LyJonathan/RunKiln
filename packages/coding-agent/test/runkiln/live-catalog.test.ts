/**
 * Live RunInfra catalog: recorded GET /v1/models bodies (fixtures/), the 24 h on-disk cache, router.yaml
 * catalog overrides, and how auto routing treats models that are new (unbenched) or gone.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Api, Model } from "@runkiln/ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModelRuntime } from "../../src/core/model-runtime.ts";
import { parseRouterCatalog } from "../../src/core/router/catalog.ts";
import { formatRouterReport } from "../../src/core/router/format.ts";
import { closestBenchedModel } from "../../src/core/router/quality-select.ts";
import { ModelRouter } from "../../src/core/router/router.ts";
import {
	applyCatalogOverrides,
	LIVE_CATALOG_CACHE_TTL_MS,
	loadLiveCatalogCache,
	mergeLiveCatalog,
	parseLiveModels,
	saveLiveCatalogCache,
} from "../../src/core/runkiln/live-catalog.ts";
import { parseModelsCatalog } from "../../src/core/runkiln/models-catalog.ts";
import { buildModelRows, parseRemoteModels } from "../../src/core/runkiln/runinfra-account.ts";
import { buildStatusMarkdown } from "../../src/modes/interactive/runkiln-commands.ts";
import { classification, MockClassifier, signals } from "./router-fixtures.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "../../../..");
const fixture = (name: string) => JSON.parse(readFileSync(join(here, "fixtures", name), "utf8")) as unknown;
/** Recorded 2026-10-16 from GET https://api.runinfra.ai/v1/models. */
const RECORDED = fixture("runinfra-models-2026-10-17.json");
/** Recorded 2026-10-20 from GET https://api.runinfra.ai/v1/models (glm-5-3 and ornith-1-5-122b added). */
const RECORDED_1020 = fixture("runinfra-models-2026-10-20.json");
/** The same body with ornith-1-5-35b gone and a new model (kimi-k3-flash) added. */
const NEW_AND_GONE = fixture("runinfra-models-new-and-gone.json");
const MODELS_YAML = readFileSync(join(repo, "models.yaml"), "utf8");
const ROUTER_YAML = readFileSync(join(repo, "router.yaml"), "utf8");
const BASE_URL = "https://api.runinfra.ai/v1";

const respond = (body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));

describe("recorded /v1/models", () => {
	it("parses every chat model with prices, limits and thinking levels", () => {
		const entries = parseLiveModels(RECORDED);
		expect(entries.map((entry) => entry.id)).toEqual([
			"deepseek-v4-1-flash",
			"deepseek-v4-1-flash-1017",
			"glm-5-3-flash",
			"nemotron-3-5-lightning-30b",
			"ornith-1-5-35b",
			"qwen3-8-27b",
		]);
		const glm = entries.find((entry) => entry.id === "glm-5-3-flash")!;
		expect(glm).toMatchObject({
			availability: "available",
			contextWindow: 1048576,
			maxOutputTokens: 1048576,
			priceIn: 0.11,
			priceOut: 0.45,
			priceCachedIn: 0.03,
			images: true,
			reasoningEfforts: ["low", "high", "max"],
			defaultReasoningEffort: "max",
			toolCalling: true,
		});
	});

	it("updates the models.yaml entries from it and clamps max output to the live limit", () => {
		const catalog = parseModelsCatalog(MODELS_YAML, "models.yaml");
		// The old DeepSeek id is an alias of 1017: the runtime drops it from the live list before merging.
		expect(catalog.aliases).toEqual({ "deepseek-v4-1-flash": "deepseek-v4-1-flash-1017" });
		const live = parseLiveModels(RECORDED_1020).filter((entry) => !catalog.aliases?.[entry.id]);
		const merged = mergeLiveCatalog(catalog.chatModels, live, BASE_URL);
		expect(merged.added).toEqual([]);
		expect(merged.missing).toEqual([]);
		const ds = merged.models.find((model) => model.id === "deepseek-v4-1-flash-1017")!;
		expect(ds.cost).toMatchObject({ input: 0.15, output: 0.6, cacheRead: 0.01 });
		expect(ds.contextWindow).toBe(1048576);
		// Live 1M output is above the harness default: the models.yaml cap stays.
		expect(ds.maxTokens).toBe(16384);
		expect(ds.thinkingLevelMap).toMatchObject({ off: "none", low: "low", high: "high", xhigh: "xhigh", max: "max" });
		const lowCap = mergeLiveCatalog(
			catalog.chatModels,
			parseLiveModels({ data: [{ id: "glm-5-3-flash", max_output_tokens: 8192, modality: "llm" }] }),
			BASE_URL,
		);
		expect(lowCap.models[0].maxTokens).toBe(8192);
	});

	it("matches the 2026-10-20 prices and limits of the manual-only glm-5-3 and ornith-1-5-122b", () => {
		const catalog = parseModelsCatalog(MODELS_YAML, "models.yaml");
		const live = parseLiveModels(RECORDED_1020);
		expect(live.find((entry) => entry.id === "glm-5-3")).toMatchObject({
			contextWindow: 1048576,
			priceIn: 1.3,
			priceOut: 4.2,
			priceCachedIn: 0.13,
			images: false,
			reasoningEfforts: ["low", "high", "max"],
			toolCalling: true,
		});
		expect(live.find((entry) => entry.id === "ornith-1-5-122b")).toMatchObject({
			contextWindow: 262144,
			maxOutputTokens: 262144,
			priceIn: 0.2,
			priceOut: 0.8,
			priceCachedIn: 0.02,
			images: true,
			reasoningEfforts: [],
			toolCalling: true,
		});
		const merged = mergeLiveCatalog(catalog.chatModels, live, BASE_URL);
		expect(merged.models.find((model) => model.id === "glm-5-3")).toMatchObject({
			input: ["text"],
			cost: { input: 1.3, output: 4.2, cacheRead: 0.13, cacheWrite: 0 },
			reasoning: true,
			reasoningEffort: "high",
		});
		expect(merged.models.find((model) => model.id === "ornith-1-5-122b")).toMatchObject({
			input: ["text", "image"],
			cost: { input: 0.2, output: 0.8, cacheRead: 0.02, cacheWrite: 0 },
			contextWindow: 262144,
			reasoning: false,
			reasoningEffort: "none",
		});
	});

	it("adds new models and drops gone ones", () => {
		const catalog = parseModelsCatalog(MODELS_YAML, "models.yaml");
		const merged = mergeLiveCatalog(catalog.chatModels, parseLiveModels(NEW_AND_GONE), BASE_URL);
		expect(merged.added).toEqual(["kimi-k3-flash"]);
		expect(merged.missing).toEqual(["ornith-1-5-35b"]);
		expect(merged.models.find((model) => model.id === "kimi-k3-flash")).toMatchObject({
			name: "Kimi K3 Flash",
			contextWindow: 262144,
			input: ["text", "image"],
			cost: { input: 0.12, output: 0.5, cacheRead: 0.03, cacheWrite: 0 },
			reasoningEffort: "low",
		});
	});
});

describe("on-disk catalog cache", () => {
	let dir: string;
	let path: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "runkiln-catalog-"));
		path = join(dir, "cache", "runinfra-catalog.json");
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	function runtime(
		fetch: typeof globalThis.fetch,
		now: () => number,
		extra: Partial<Parameters<typeof ModelRuntime.create>[0]> = {},
	) {
		return ModelRuntime.create({
			catalog: parseModelsCatalog(MODELS_YAML, "models.yaml"),
			runInfraConfig: { baseUrl: BASE_URL, apiKey: "ri_test" },
			fetch,
			catalogCachePath: path,
			now,
			offline: false,
			...extra,
		});
	}

	it("round-trips entries, and ignores another endpoint, another schema or a broken file", () => {
		const entries = parseLiveModels(NEW_AND_GONE);
		saveLiveCatalogCache(path, BASE_URL, entries, 1000);
		const text = readFileSync(path, "utf8");
		expect(text).not.toContain("ri_test");
		expect(loadLiveCatalogCache(path, BASE_URL)).toEqual({ schema: 2, fetchedAt: 1000, baseUrl: BASE_URL, entries });
		expect(loadLiveCatalogCache(path, "https://other.example/v1")).toBeUndefined();
		writeFileSync(path, JSON.stringify({ ...JSON.parse(text), schema: 99 }));
		expect(loadLiveCatalogCache(path, BASE_URL)).toBeUndefined();
		writeFileSync(path, "{ not json");
		expect(loadLiveCatalogCache(path, BASE_URL)).toBeUndefined();
	});

	it("writes the cache on a live fetch and starts the next process from it without the network", async () => {
		let clock = 1_000_000;
		const fetch = respond(NEW_AND_GONE);
		const first = await runtime(fetch, () => clock);
		await first.refreshLiveCatalog();
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(loadLiveCatalogCache(path, BASE_URL)?.fetchedAt).toBe(clock);

		clock += 60 * 60 * 1000; // an hour later, a new process
		const never = vi.fn();
		const second = await runtime(never as unknown as typeof globalThis.fetch, () => clock, { offline: true });
		// The cached list is in place before any refresh.
		expect(second.liveCatalogStatus).toMatchObject({
			source: "cache",
			added: ["kimi-k3-flash"],
			missing: ["ornith-1-5-35b"],
		});
		expect(second.getRoutableModels().map((model) => model.id)).toContain("kimi-k3-flash");
		expect(second.getRoutableModels().map((model) => model.id)).not.toContain("ornith-1-5-35b");
		await second.refreshLiveCatalog();
		expect(never).not.toHaveBeenCalled();
	});

	it("answers from a fresh cache at once, revalidates it in the background, and refetches after 24 h", async () => {
		let clock = 5_000_000;
		saveLiveCatalogCache(path, BASE_URL, parseLiveModels(RECORDED), clock);
		const fetch = respond(NEW_AND_GONE);
		const rt = await runtime(fetch, () => clock);

		clock += 5 * 60 * 1000; // 5 min: fresh, no request
		expect((await rt.refreshLiveCatalog()).source).toBe("cache");
		expect(fetch).not.toHaveBeenCalled();

		clock += 10 * 60 * 1000; // 15 min: still answers from the cache, one background request
		const status = await rt.refreshLiveCatalog();
		expect(status.source).toBe("cache");
		expect(fetch).toHaveBeenCalledTimes(1);
		await vi.waitFor(() => expect(rt.liveCatalogStatus?.source).toBe("live"));
		expect(rt.liveCatalogStatus?.added).toEqual(["kimi-k3-flash"]);

		// A process started on a cache older than 24 h waits for the fetch.
		saveLiveCatalogCache(path, BASE_URL, parseLiveModels(RECORDED), clock - LIVE_CATALOG_CACHE_TTL_MS - 1);
		const stale = await runtime(fetch, () => clock);
		const fresh = await stale.refreshLiveCatalog();
		expect(fetch).toHaveBeenCalledTimes(2);
		expect(fresh.source).toBe("live");
	});

	it("keeps the cached list when the live fetch fails", async () => {
		const clock = 9_000_000;
		saveLiveCatalogCache(path, BASE_URL, parseLiveModels(NEW_AND_GONE), clock - LIVE_CATALOG_CACHE_TTL_MS - 1);
		const failing = vi.fn(async () => new Response("down", { status: 503 }));
		const rt = await runtime(failing, () => clock);
		const status = await rt.refreshLiveCatalog();
		expect(status.error).toMatch(/503/);
		expect(rt.getRoutableModels().map((model) => model.id)).toContain("kimi-k3-flash");
	});

	it("is off unless asked for when a catalog is passed in (tests never touch ~/.runkiln)", async () => {
		const fetch = respond(RECORDED);
		const rt = await ModelRuntime.create({
			catalog: parseModelsCatalog(MODELS_YAML, "models.yaml"),
			runInfraConfig: { baseUrl: BASE_URL, apiKey: "ri_test" },
			fetch,
			offline: false,
		});
		await rt.refreshLiveCatalog();
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(loadLiveCatalogCache(path, BASE_URL)).toBeUndefined();
	});
});

describe("router.yaml catalog overrides", () => {
	const USER = `
models:
  glm-5-3-flash:
    catalog:
      price: { in: 0.2, out: 0.9 }
      context: 131072
      max_output: 4096
      reasoning_efforts: [low]
`;

	it("parses models.<id>.catalog and rejects unknown keys", () => {
		const catalog = parseRouterCatalog([
			{ text: ROUTER_YAML, path: "router.yaml" },
			{ text: USER, path: "user.yaml" },
		]);
		expect(catalog.models["glm-5-3-flash"].catalog).toEqual({
			priceIn: 0.2,
			priceOut: 0.9,
			contextWindow: 131072,
			maxOutputTokens: 4096,
			reasoningEfforts: ["low"],
		});
		// Scores are untouched by an override.
		expect(catalog.models["glm-5-3-flash"].skills["code.bugfix"]).toBeGreaterThan(0);
		expect(() =>
			parseRouterCatalog([
				{ text: ROUTER_YAML, path: "router.yaml" },
				{ text: "models: { glm-5-3-flash: { catalog: { speed: 3 } } }", path: "user.yaml" },
			]),
		).toThrow(/catalog.speed: unknown key/);
		expect(() =>
			parseRouterCatalog([
				{ text: ROUTER_YAML, path: "router.yaml" },
				{ text: "models: { glm-5-3-flash: { catalog: { price: { in: -1 } } } }", path: "user.yaml" },
			]),
		).toThrow(/price.in/);
	});

	it("beats the live catalog in the runtime", async () => {
		const rt = await ModelRuntime.create({
			catalog: parseModelsCatalog(MODELS_YAML, "models.yaml"),
			runInfraConfig: { baseUrl: BASE_URL, apiKey: "ri_test" },
			fetch: respond(RECORDED),
			offline: false,
			catalogOverrides: {
				"glm-5-3-flash": {
					priceIn: 0.2,
					priceOut: 0.9,
					contextWindow: 131072,
					maxOutputTokens: 4096,
					reasoningEfforts: ["low", "high"],
				},
			},
		});
		await rt.refreshLiveCatalog();
		const glm = rt.getModelById("glm-5-3-flash")!;
		expect(glm.cost).toMatchObject({ input: 0.2, output: 0.9, cacheRead: 0.03 });
		expect(glm.contextWindow).toBe(131072);
		expect(glm.maxTokens).toBe(4096);
		expect(glm.thinkingLevelMap).toMatchObject({ low: "low", high: "high", max: null });
		// Other models keep their live values.
		expect(rt.getModelById("deepseek-v4-1-flash-1017")!.cost.output).toBe(0.6);
		// The old id resolves to its successor; the live listing of the old model is not offered on its own.
		expect(rt.getModelById("deepseek-v4-1-flash")?.id).toBe("deepseek-v4-1-flash-1017");
		expect(rt.getModels().some((model) => model.id === "deepseek-v4-1-flash")).toBe(false);
		const catalogGlm = parseModelsCatalog(MODELS_YAML, "models.yaml").chatModels[0];
		expect(applyCatalogOverrides([catalogGlm], {})[0]).toBe(catalogGlm);
	});
});

describe("auto routing with new and gone models", () => {
	const catalog = parseRouterCatalog([{ text: ROUTER_YAML, path: "router.yaml" }]);

	async function liveModels(body: unknown): Promise<Model<Api>[]> {
		const rt = await ModelRuntime.create({
			catalog: parseModelsCatalog(MODELS_YAML, "models.yaml"),
			runInfraConfig: { baseUrl: BASE_URL, apiKey: "ri_test" },
			fetch: respond(body),
			offline: false,
		});
		await rt.refreshLiveCatalog();
		return [...rt.getRoutableModels()];
	}

	function router(models: readonly Model<Api>[], difficulty = 0.4) {
		return new ModelRouter({
			catalog,
			classifier: new MockClassifier(() =>
				classification({ difficulty, skills: [{ skill: "code.bugfix", prob: 0.9 }] }),
			),
			getModels: () => models,
			defaultModelId: () => "glm-5-3-flash",
		});
	}

	it("never auto-routes to the manual-only glm-5-3 and ornith-1-5-122b", async () => {
		const models = await liveModels(RECORDED_1020);
		const ids = models.map((model) => model.id);
		expect(ids).toContain("glm-5-3");
		expect(ids).toContain("ornith-1-5-122b");
		for (const difficulty of [0.1, 0.4, 0.7, 0.95]) {
			for (const mode of ["low", "medium", "high"] as const) {
				for (const hasImages of [false, true]) {
					const decision = await router(models, difficulty).route({
						signals: signals({ hasImages }),
						role: "code",
						toolsActive: true,
						mode,
					});
					expect(["glm-5-3", "ornith-1-5-122b"]).not.toContain(decision.model.id);
					const candidates = decision.selection?.candidates.map((row) => row.model) ?? [];
					expect(candidates).not.toContain("glm-5-3");
					expect(candidates).not.toContain("ornith-1-5-122b");
				}
			}
		}
	});

	it("routes an image turn to a model the live catalog lists with image input", async () => {
		const models = await liveModels(RECORDED);
		const vision = models.filter((model) => model.input.includes("image")).map((model) => model.id);
		expect(vision.sort()).toEqual(["deepseek-v4-1-flash-1017", "glm-5-3-flash", "ornith-1-5-35b", "qwen3-8-27b"]);
		for (const difficulty of [0.1, 0.4, 0.7, 0.95]) {
			for (const mode of ["low", "medium", "high"] as const) {
				const decision = await router(models, difficulty).route({
					signals: signals({ hasImages: true }),
					role: "code",
					toolsActive: true,
					mode,
				});
				expect(vision).toContain(decision.model.id);
			}
		}
		// The text-only models stay eligible for text turns.
		const text = await router(
			models.filter((model) => !model.input.includes("image")),
			0.4,
		).route({
			signals: signals(),
			role: "code",
			toolsActive: true,
			mode: "medium",
		});
		expect(["deepseek-v4-1-flash-1017", "nemotron-3-5-lightning-30b"]).toContain(text.model.id);
	});

	it("marks the new model (and models.yaml models without curves) unbenched", async () => {
		const models = await liveModels(NEW_AND_GONE);
		// nemotron has no curves either, but route: false keeps it out of auto routing altogether.
		expect(router(models).unbenchedModelIds()).toEqual(["qwen3-8-27b", "kimi-k3-flash"]);
	});

	it("fails over to a benched model, never to a gone or paused one, and to an unbenched one only as a last resort", async () => {
		const models = await liveModels(NEW_AND_GONE);
		expect(models.map((model) => model.id)).not.toContain("ornith-1-5-35b");
		const r = router(models);
		const unbenched = r.unbenchedModelIds();
		const first = r.failoverTarget("glm-5-3-flash", "high");
		expect(first?.model.id).toBe("deepseek-v4-1-flash-1017");
		expect(r.failoverTarget("deepseek-v4-1-flash-1017", "high")?.model.id).toBe("glm-5-3-flash");
		// Only unbenched models left besides the failing one: one of them takes the turn.
		r.markModelFailed("deepseek-v4-1-flash-1017");
		const last = r.failoverTarget("glm-5-3-flash", "high");
		expect(last && unbenched.includes(last.model.id)).toBe(true);
		// An unbenched model loses to a benched one even when router.yaml rates it higher.
		const boosted = new ModelRouter({
			catalog: parseRouterCatalog([
				{ text: ROUTER_YAML, path: "router.yaml" },
				{ text: "models:\n  qwen3-8-27b:\n    intelligence: 99\n", path: "override.yaml" },
			]),
			classifier: new MockClassifier(() => classification({ difficulty: 0.4 })),
			getModels: () => models,
			defaultModelId: () => "glm-5-3-flash",
		});
		expect(boosted.failoverTarget("glm-5-3-flash", "high")?.model.id).toBe("deepseek-v4-1-flash-1017");
		// A model the live catalog pauses is never a target.
		const paused = router(models.filter((model) => model.id !== "deepseek-v4-1-flash-1017"));
		expect(paused.failoverTarget("glm-5-3-flash", "high")?.model.id).not.toBe("deepseek-v4-1-flash-1017");
	});

	it("borrows curves from the closest benched model by price and vision", () => {
		const benched = [
			{ id: "glm-5-3-flash", priceOut: 0.45, vision: true },
			{ id: "deepseek-v4-1-flash-1017", priceOut: 0.58, vision: false },
		];
		const quality = catalog.quality!;
		expect(closestBenchedModel({ priceOut: 0.5, vision: true }, benched, quality)).toBe("glm-5-3-flash");
		expect(closestBenchedModel({ priceOut: 0.6, vision: false }, benched, quality)).toBe("deepseek-v4-1-flash-1017");
		expect(closestBenchedModel({ priceOut: 0.6, vision: false }, [], quality)).toBe(quality.referenceModel);
	});

	it("never picks an unbenched model while a benched one fits, and does when none does", async () => {
		const models = await liveModels(NEW_AND_GONE);
		for (const difficulty of [0.1, 0.4, 0.7, 0.95]) {
			const decision = await router(models, difficulty).route({
				signals: signals(),
				role: "code",
				toolsActive: true,
				mode: "medium",
			});
			expect(["glm-5-3-flash", "deepseek-v4-1-flash-1017"]).toContain(decision.model.id);
			const kimi = decision.selection?.candidates.find((row) => row.model === "kimi-k3-flash");
			expect(kimi).toMatchObject({ feasible: false, derived: true });
			expect(kimi?.failed).toContain("unbenched (a benched model fits)");
		}
		// An image turn without GLM (the only benched vision model): an unbenched vision model takes it.
		const noGlm = models.filter((model) => model.id !== "glm-5-3-flash");
		const r = router(noGlm);
		const decision = await r.route({
			signals: signals({ hasImages: true }),
			role: "code",
			toolsActive: true,
			mode: "medium",
		});
		expect(["kimi-k3-flash", "qwen3-8-27b"]).toContain(decision.model.id);
		const report = formatRouterReport(
			{ enabled: true, mode: "medium", catalogSources: catalog.sources, derivedModels: r.unbenchedModelIds() },
			decision,
		);
		expect(report).toMatch(/Unbenched \(borrowed, discounted curves/);
		expect(report).toMatch(/\* unbenched: curves borrowed from the closest benched model/);
	});

	it("the penalty policy lets an unbenched model compete", async () => {
		const penalty = parseRouterCatalog([
			{ text: ROUTER_YAML, path: "router.yaml" },
			{ text: "quality: { unbenched_policy: penalty }", path: "user.yaml" },
		]);
		expect(penalty.quality?.unbenchedPolicy).toBe("penalty");
		expect(catalog.quality?.unbenchedPolicy).toBe("last_resort");
		const models = await liveModels(NEW_AND_GONE);
		const r = new ModelRouter({
			catalog: penalty,
			classifier: new MockClassifier(() => classification({ difficulty: 0.4 })),
			getModels: () => models,
			defaultModelId: () => "glm-5-3-flash",
		});
		const decision = await r.route({ signals: signals(), role: "code", toolsActive: true, mode: "medium" });
		const kimi = decision.selection?.candidates.find((row) => row.model === "kimi-k3-flash");
		expect(kimi?.failed ?? []).not.toContain("unbenched (a benched model fits)");
	});

	it("skips a gone model: its curves and scores stay in router.yaml but it is never a candidate", async () => {
		const gone = {
			object: "list",
			data: (RECORDED as { data: Array<{ id: string }> }).data.filter((m) => m.id !== "deepseek-v4-1-flash-1017"),
		};
		const models = await liveModels(gone);
		expect(models.map((model) => model.id)).not.toContain("deepseek-v4-1-flash-1017");
		const decision = await router(models, 0.9).route({
			signals: signals(),
			role: "code",
			toolsActive: true,
			mode: "high",
		});
		expect(decision.model.id).toBe("glm-5-3-flash");
		expect(decision.selection?.candidates.map((row) => row.model)).not.toContain("deepseek-v4-1-flash-1017");
	});
});

describe("/models and /status", () => {
	it("lists live-only models and marks unbenched ones", () => {
		const catalog = parseModelsCatalog(MODELS_YAML, "models.yaml");
		const rows = buildModelRows(catalog, parseRemoteModels(NEW_AND_GONE), [], ["qwen3-8-27b", "kimi-k3-flash"]);
		expect(rows.map((row) => row.id)).toEqual([
			"glm-5-3-flash",
			"deepseek-v4-1-flash-1017",
			"glm-5-3",
			"qwen3-8-27b",
			"ornith-1-5-35b",
			"ornith-1-5-122b",
			"nemotron-3-5-lightning-30b",
			"kimi-k3-flash",
		]);
		expect(rows.find((row) => row.id === "ornith-1-5-35b")?.status).toBe("unlisted");
		expect(rows.find((row) => row.id === "kimi-k3-flash")).toMatchObject({
			unbenched: true,
			newInCatalog: true,
			priceOut: 0.5,
		});
		expect(rows.find((row) => row.id === "qwen3-8-27b")?.unbenched).toBe(true);
		expect(rows.find((row) => row.id === "glm-5-3-flash")?.unbenched).toBe(false);
		// Non-chat entries never become rows.
		const withEmbedder = parseRemoteModels({ data: [{ id: "embed-1", modality: "embedding" }] });
		expect(buildModelRows(catalog, withEmbedder, []).map((row) => row.id)).not.toContain("embed-1");
	});

	it("/status names the catalog source and the unbenched models", () => {
		const markdown = buildStatusMarkdown({
			version: "0.1.0",
			cwd: "/repo",
			sessionId: "s",
			model: "runinfra/glm-5-3-flash",
			routing: "auto:medium",
			thinking: "auto",
			permissionMode: "read-write",
			sessionRules: [],
			runInfraKey: true,
			catalog: "cached RunInfra catalog (2h ago): glm-5-3-flash, kimi-k3-flash",
			unbenched: ["kimi-k3-flash"],
			messages: 0,
			cost: 0,
		});
		expect(markdown).toMatch(/\| Catalog \| cached RunInfra catalog \(2h ago\)/);
		expect(markdown).toMatch(
			/\| Unbenched \| kimi-k3-flash \(manual use works; auto picks them only when no benched model fits\)/,
		);
	});
});
