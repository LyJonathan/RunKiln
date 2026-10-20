import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Api, Model } from "@runkiln/ai";
import { getSupportedThinkingLevels } from "@runkiln/ai";
import { describe, expect, it } from "vitest";
import { parseRouterCatalog, type RouterCatalog, resolveModeConfig } from "../../src/core/router/catalog.ts";
import { JevClassifier, OpenRouterClassifier, ROUTE_MIN_TASK_PROBABILITY } from "../../src/core/router/classifiers.ts";
import { fastPath } from "../../src/core/router/fast-path.ts";
import { formatRouterReport, shortRouteReason } from "../../src/core/router/format.ts";
import {
	horizonCost,
	interpolate,
	modeLevels,
	pairQuality,
	type QualityCandidate,
	type QualityModeConfig,
	selectByQuality,
} from "../../src/core/router/quality-select.ts";
import { ModelRouter, type RouteRequest } from "../../src/core/router/router.ts";
import { extractTurnSignals, type SignalMessage } from "../../src/core/router/signals.ts";
import { type Classification, ClassifierError } from "../../src/core/router/types.ts";
import { parseModelsCatalog } from "../../src/core/runkiln/models-catalog.ts";
import { MockClassifier, signals, testCatalog } from "./router-fixtures.ts";

const repo = join(dirname(fileURLToPath(import.meta.url)), "../../../..");
const ROUTER_YAML = readFileSync(join(repo, "router.yaml"), "utf8");
const MODELS = parseModelsCatalog(readFileSync(join(repo, "models.yaml"), "utf8"), "models.yaml").chatModels;
const GLM = "glm-5-3-flash";
const DS = "deepseek-v4-1-flash-1017";
const BENCHED = MODELS.filter((model) => model.id === GLM || model.id === DS);

function bundled(extra?: string): RouterCatalog {
	const docs = [{ text: ROUTER_YAML, path: "router.yaml" }];
	if (extra) docs.push({ text: extra, path: "user-router.yaml" });
	return parseRouterCatalog(docs);
}

const CATALOG = bundled();
const QUALITY = CATALOG.quality!;
const MEDIUM: QualityModeConfig = { tolerance: 0.04, prefer: "lowest", maxAuto: "xhigh" };

function candidates(models: readonly Model<Api>[] = BENCHED): QualityCandidate[] {
	return models.map((model) => ({
		id: model.id,
		priceIn: model.cost.input,
		priceOut: model.cost.output,
		priceCachedIn: model.cost.cacheRead,
		contextWindow: model.contextWindow,
		vision: model.input.includes("image"),
		intelligence: CATALOG.models[model.id]?.intelligence ?? 50,
		skills: CATALOG.models[model.id]?.skills ?? {},
		supportedThinking: getSupportedThinkingLevels(model),
		maxAutoThinking: CATALOG.models[model.id]?.maxAutoThinking,
		curves: QUALITY.models[model.id],
	}));
}

function pick(
	kind: Parameters<typeof selectByQuality>[1]["kind"],
	difficulty: number,
	extra: Partial<Parameters<typeof selectByQuality>[1]> = {},
	mode: QualityModeConfig = MEDIUM,
	models?: readonly Model<Api>[],
) {
	const selection = selectByQuality(
		candidates(models),
		{ kind, difficulty, contextTokens: 14000, answerTokens: 900, needsVision: false, ...extra },
		mode,
		QUALITY,
		CATALOG.models[GLM].skills,
	);
	const level = selection.candidates.find((c) => c.model === selection.modelId)?.thinkingLevel;
	return {
		pair: `${selection.modelId === GLM ? "glm" : selection.modelId === DS ? "ds" : selection.modelId}:${level}`,
		selection,
	};
}

describe("router.yaml quality section", () => {
	it("ships quality selection with curves for both benched models", () => {
		expect(CATALOG.selection).toBe("quality");
		expect(Object.keys(QUALITY.models).sort()).toEqual([DS, GLM]);
		expect(Object.keys(QUALITY.models[DS].levels).sort()).toEqual(["high", "low", "max", "off", "xhigh"]);
		expect(Object.keys(QUALITY.models[GLM].levels).sort()).toEqual(["high", "low", "max"]);
		for (const model of Object.values(QUALITY.models)) {
			for (const level of Object.values(model.levels)) {
				for (const kind of ["chat", "code", "algo", "math", "agentic"] as const) {
					expect(level?.pass[kind]).toHaveLength(3);
				}
			}
		}
		expect(CATALOG.modes.low.tolerance).toBe(0.1);
		expect(CATALOG.modes.high.tolerance).toBe(0.02);
	});

	it("encodes the bench's hard-tier ordering (ds:low > ds:none, glm:max on algorithms)", () => {
		const hard = (model: string, level: "off" | "low" | "high" | "max") =>
			QUALITY.models[model].levels[level]!.pass.algo![2];
		expect(hard(DS, "low")).toBeGreaterThan(hard(DS, "off") + 0.1);
		expect(hard(DS, "low")).toBeGreaterThan(hard(GLM, "max") + 0.1);
		expect(hard(DS, "low")).toBeGreaterThan(hard(DS, "max"));
	});

	it("a user file can switch back to skill scores, with selection: scores or quality: null", () => {
		expect(bundled("selection: scores\n").selection).toBe("scores");
		const cleared = bundled("quality: null\n");
		expect(cleared.selection).toBe("scores");
		expect(cleared.quality).toBeUndefined();
	});

	it("a user file can override one curve and the tolerance", () => {
		const catalog = bundled(
			`quality:\n  tolerance: 0.02\n  models:\n    ${GLM}:\n      levels:\n        low:\n          code: [0.5, 0.5, 0.5]\n`,
		);
		expect(catalog.quality!.tolerance).toBe(0.02);
		expect(catalog.quality!.models[GLM].levels.low!.pass.code).toEqual([0.5, 0.5, 0.5]);
		expect(catalog.quality!.models[GLM].levels.low!.pass.algo).toEqual(QUALITY.models[GLM].levels.low!.pass.algo);
	});

	it("rejects malformed quality settings", () => {
		expect(() => bundled("quality:\n  anchors: [0, 0.5, 0.4, 0.75, 1]\n")).toThrow(/ascend/);
		expect(() =>
			bundled(`quality:\n  models:\n    ${GLM}:\n      levels:\n        low:\n          code: [0.5, 1.2, 0.5]\n`),
		).toThrow(/0 to 1/);
		expect(() =>
			bundled(`quality:\n  models:\n    ${GLM}:\n      levels:\n        low:\n          poetry: [0.5, 0.5, 0.5]\n`),
		).toThrow(/unknown key/);
		expect(() => bundled("quality:\n  priors:\n    gardening: {}\n")).toThrow(/unknown task kind/);
		expect(() => bundled("modes:\n  medium:\n    tolerance: 2\n")).toThrow(/tolerance/);
		expect(() => bundled("selection: magic\n")).toThrow(/quality or scores/);
		expect(() =>
			parseRouterCatalog([{ text: "selection: quality\nskills:\n  - { name: chat }\n", path: "x" }]),
		).toThrow(/needs a quality section/);
	});

	it("the test catalog without a quality section keeps the skill-score selector", () => {
		expect(testCatalog().selection).toBe("scores");
	});
});

describe("curve math", () => {
	it("interpolates between the anchors, trivial = easy, frontier given", () => {
		const anchors = QUALITY.anchors;
		expect(interpolate([0.9, 0.8, 0.6], 0, anchors, 0.36)).toBeCloseTo(0.9);
		expect(interpolate([0.9, 0.8, 0.6], 0.25, anchors, 0.36)).toBeCloseTo(0.9);
		expect(interpolate([0.9, 0.8, 0.6], 0.375, anchors, 0.36)).toBeCloseTo(0.85);
		expect(interpolate([0.9, 0.8, 0.6], 0.75, anchors, 0.36)).toBeCloseTo(0.6);
		expect(interpolate([0.9, 0.8, 0.6], 1, anchors, 0.36)).toBeCloseTo(0.36);
	});

	it("applies public leans fully at hard, half at medium, not at easy", () => {
		const [glm] = candidates().filter((c) => c.id === GLM);
		const at = (kind: "terminal" | "agentic", d: number) => pairQuality(glm, "high", kind, d, QUALITY)!.quality;
		expect(at("terminal", 0.25) - at("agentic", 0.25)).toBeCloseTo(0, 5);
		expect(at("terminal", 0.5) - at("agentic", 0.5)).toBeCloseTo(0.025, 5);
		expect(at("terminal", 0.75) - at("agentic", 0.75)).toBeCloseTo(0.05, 5);
	});

	it("an unbenched model borrows the reference curves with its skill offset and a penalty", () => {
		const qwen = MODELS.find((model) => model.id === "qwen3-8-27b")!;
		const [candidate] = candidates([qwen]);
		const glm = candidates().find((c) => c.id === GLM)!;
		const borrowed = pairQuality(candidate, "low", "code", 0.5, QUALITY, CATALOG.models[GLM].skills)!;
		const reference = pairQuality(glm, "low", "code", 0.5, QUALITY)!;
		const offset =
			(CATALOG.models["qwen3-8-27b"].skills["code.bugfix"] - CATALOG.models[GLM].skills["code.bugfix"]) / 100;
		expect(borrowed.derived).toBe(true);
		expect(borrowed.quality).toBeCloseTo(reference.quality + offset - QUALITY.unbenchedPenalty, 5);
	});

	it("mode levels: max_auto caps, max_thinking bounds the reserve, min_thinking floors", () => {
		const ds = candidates().find((c) => c.id === DS)!;
		const glm = candidates().find((c) => c.id === GLM)!;
		expect(modeLevels(ds, MEDIUM)).toEqual({ levels: ["off", "low", "high"], reserve: [] }); // max_auto_thinking high
		expect(modeLevels(glm, MEDIUM)).toEqual({ levels: ["low", "high"], reserve: ["max"] });
		expect(modeLevels(glm, { ...MEDIUM, ceiling: "low", maxAuto: "low" })).toEqual({ levels: ["low"], reserve: [] });
		expect(modeLevels(ds, { ...MEDIUM, floor: "low", maxAuto: "max" }).levels).toEqual(["low", "high"]);
	});
});

describe("cache-aware selection (router v3)", () => {
	const held = (model: string, level: string) => ({
		heldModelId: model,
		heldThinkingLevel: level as never,
	});

	it("keeps a warm pair that is inside the mode's band instead of dropping to a cheaper cold one", () => {
		// Cold glm:low would be the cheapest pair for this turn alone.
		expect(pick("code", 0.2).pair).toBe("glm:low");
		const kept = pick("code", 0.2, held(DS, "low"));
		expect(kept.pair).toBe("ds:low");
		expect(kept.selection.cause).toBe("held_warm");
		expect(kept.selection.quality?.cache).toMatchObject({ kept: true, reason: "in_band" });
	});

	it("leaves the warm pair for a clearly better in-band pair when the gain beats the miss", () => {
		// glm:low on medium code is in the band but under ds:low; at 14k tokens the miss is cheap.
		const small = pick("code", 0.5, held(GLM, "low"));
		expect(small.pair.startsWith("ds:")).toBe(true);
		expect(small.selection.quality?.cache).toMatchObject({ kept: false, reason: "worth_miss" });
		// At 200k tokens the same gain does not pay for the miss.
		const large = pick("code", 0.5, { ...held(GLM, "low"), contextTokens: 200_000 });
		expect(large.pair).toBe("glm:low");
		expect(large.selection.quality?.cache).toMatchObject({ kept: true, reason: "in_band" });
	});

	it("drops to the cheapest good pair at a free switch point (cache lost anyway)", () => {
		const { pair, selection } = pick("code", 0.2, { ...held(DS, "low"), freeSwitch: true });
		expect(pair).toBe("glm:low");
		expect(selection.quality?.freeSwitch).toBe(true);
	});

	it("drops to a cheaper pair that is still warm on the session (switch-back is warm on RunInfra)", () => {
		const warmTokens = (model: string, level: string) =>
			(model === DS && level === "low") || (model === GLM && level === "low") ? 14000 : 0;
		const dsHighWarm = (model: string, level: string) =>
			model === DS && (level === "low" || level === "high") ? 14000 : 0;
		// Very long answers on hard work held at ds:high: ds:low, warm too and as good, has fewer reasoning tokens.
		expect(pick("code", 0.75, { ...held(DS, "high"), warmTokens: dsHighWarm, answerTokens: 6000 }).pair).toBe(
			"ds:low",
		);
		// On easy code DeepSeek low (measured 0.93 on 1017) is better than GLM low and its cache is cheaper: it stays.
		expect(pick("code", 0.2, { ...held(DS, "low"), warmTokens, answerTokens: 6000 }).pair).toBe("ds:low");
	});

	it("leaves the band only when the quality gain beats the miss now plus the likely miss back", () => {
		// glm:high on hard code is 0.08 under the best pair: worth a miss at 14k tokens, not at 200k.
		const small = pick("code", 0.75, held(GLM, "high"));
		expect(small.pair).toBe("ds:low");
		expect(small.selection.quality?.cache).toMatchObject({ kept: false, reason: "worth_miss" });
		const large = pick("code", 0.75, { ...held(GLM, "high"), contextTokens: 200_000 });
		expect(large.pair).toBe("glm:high");
		expect(large.selection.quality?.cache).toMatchObject({ kept: true, reason: "not_worth_miss" });
		// A large gain (hard algorithms on glm:low) still switches at 200k.
		expect(pick("algo", 0.75, { ...held(GLM, "low"), contextTokens: 200_000 }).pair).toBe("ds:low");
	});

	it("on a session's first turn takes the cheapest good pair; once underway quality counts in the band", () => {
		expect(pick("code", 0.2).pair).toBe("glm:low");
		expect(pick("code", 0.2, { sessionUnderway: true }).pair).not.toBe("glm:low");
	});

	it("needs a clear gain (clear_gain) before an in-band pair may cost a miss", () => {
		// Medium code: ds:low is 0.03 over warm glm:low, past clear_gain (0.02): the miss is paid.
		expect(pick("code", 0.5, held(GLM, "low")).pair.startsWith("ds:")).toBe(true);
		const strict = { ...QUALITY, cache: { ...QUALITY.cache, clearGain: 0.05 } };
		const selection = selectByQuality(
			candidates(),
			{
				kind: "code",
				difficulty: 0.5,
				contextTokens: 14000,
				answerTokens: 900,
				needsVision: false,
				...held(GLM, "low"),
			},
			MEDIUM,
			strict,
			CATALOG.models[GLM].skills,
		);
		expect(selection.modelId).toBe(GLM);
		expect(selection.cause).toBe("held_warm");
	});

	it("reads per-mode cache pricing over quality.cache; provider facts stay global", () => {
		expect(CATALOG.modes.low.cache).toEqual({
			clearGain: 0.1,
			failedTurnUsd: 0.065,
			horizonTurns: 6,
			firstTurnQuality: 0.2,
		});
		expect(CATALOG.modes.medium.cache).toBeUndefined();
		expect(resolveModeConfig(CATALOG, "low").cache?.clearGain).toBe(0.1);
		const user = bundled("modes:\n  medium:\n    cache: { horizon_turns: 3 }\n");
		expect(user.modes.medium.cache).toEqual({ horizonTurns: 3 });
		expect(user.modes.low.cache?.clearGain).toBe(0.1);
		expect(() => bundled("modes:\n  low:\n    cache: { ttl_sec: 60 }\n")).toThrow(/under quality.cache/);
		expect(() => bundled("modes:\n  low:\n    cache: { clear_gain: 2 }\n")).toThrow(/from 0 to 1/);
	});

	it("low mode keeps a warm pair anywhere in its band, medium leaves it for a clear gain", () => {
		// Medium code: ds:low is 0.03 over warm glm:low, past medium's clear_gain (0.02).
		const input = held(GLM, "low");
		expect(pick("code", 0.5, input).pair.startsWith("ds:")).toBe(true);
		const low: QualityModeConfig = {
			tolerance: 0.1,
			prefer: "lowest",
			maxAuto: "low",
			ceiling: "low",
			cache: { ...QUALITY.cache, ...CATALOG.modes.low.cache },
		};
		const kept = pick("code", 0.5, input, low);
		expect(kept.pair).toBe("glm:low");
		expect(kept.selection.cause).toBe("held_warm");
	});

	it("weighs pass rate on a session's first pick by first_turn_quality", () => {
		const base: QualityModeConfig = { tolerance: 0.1, prefer: "lowest", maxAuto: "low", ceiling: "low" };
		const cheapest = pick("code", 0.5, {}, { ...base, cache: QUALITY.cache });
		const weighed = pick("code", 0.5, {}, { ...base, cache: { ...QUALITY.cache, firstTurnQuality: 1 } });
		expect(cheapest.pair).toBe("glm:low");
		expect(weighed.selection.quality?.chosen).toBeGreaterThan(cheapest.selection.quality?.chosen ?? 1);
	});

	it("prices the way back as a full miss when the time away outlasts the cache TTL", () => {
		const pair = { model: DS, level: "low" as const, steadyUsd: 0.001, missUsd: 0.002 };
		const heldPair = {
			model: GLM,
			level: "low" as const,
			price: { priceIn: 0.11, priceOut: 0.45, priceCachedIn: 0.03 },
		};
		const within = horizonCost(pair, heldPair, QUALITY.cache, 100_000, 60_000);
		const past = horizonCost(pair, heldPair, QUALITY.cache, 100_000, 3_600_000);
		expect(past - within).toBeCloseTo((QUALITY.cache.returnProbability * 100_000 * (0.11 - 0.03)) / 1e6, 9);
	});

	it("prices this turn's miss in the estimate: a cold pair costs more than the same pair warm", () => {
		const cold = pick("code", 0.2).selection.candidates.find((c) => c.model === GLM)?.estCostUsd ?? 0;
		const warm =
			pick("code", 0.2, held(GLM, "low")).selection.candidates.find((c) => c.model === GLM)?.estCostUsd ?? 0;
		expect(cold - warm).toBeCloseTo((14000 * (0.11 - 0.03)) / 1e6, 6);
	});
});

describe("selectByQuality on the shipped curves (medium mode)", () => {
	it("easy and medium work: GLM low, the cheapest pair, for every kind but medium agentic", () => {
		for (const kind of ["chat", "code", "algo", "math", "agentic"] as const) {
			expect(pick(kind, 0.1).pair).toBe("glm:low");
			if (kind !== "agentic") expect(pick(kind, 0.45).pair).toBe("glm:low");
		}
		// Medium agentic: GLM low (0.91) falls just outside the 0.04 band of DeepSeek 1017 (0.95 measured).
		expect(pick("agentic", 0.45).pair).toBe("ds:off");
	});

	it("hard algorithms and contest math: DeepSeek with thinking (low), not off, not GLM max", () => {
		expect(pick("algo", 0.75).pair).toBe("ds:low");
		expect(pick("math", 0.8).pair).toBe("ds:low");
	});

	it("hard terminal work: the Terminal-Bench lean toward GLM no longer beats 1017's measured agentic rate", () => {
		// 1017 low: 0.94 measured on hard tool use and code, 0.89 after the -0.05 lean; GLM high 0.78 + 0.05.
		const terminal = pick("terminal", 0.75);
		expect(terminal.pair).toBe("ds:low");
		expect(terminal.selection.quality?.chosen).toBeLessThan(pick("agentic", 0.75).selection.quality?.chosen ?? 0);
	});

	it("never auto-picks deepseek above its max_auto_thinking (high)", () => {
		for (const kind of ["code", "algo", "math", "agentic"] as const) {
			for (const d of [0.6, 0.8, 1]) expect(["ds:xhigh", "ds:max"]).not.toContain(pick(kind, d).pair);
		}
	});

	it("is cache-aware: a warm DeepSeek cache keeps a trivial turn on DeepSeek", () => {
		// Level unknown (an older transcript): every DeepSeek level counts as warm.
		expect(pick("chat", 0, { contextTokens: 60000, heldModelId: DS }).selection.modelId).toBe(DS);
		expect(pick("chat", 0, { contextTokens: 60000, ...{ heldModelId: DS, heldThinkingLevel: "off" } }).pair).toBe(
			"ds:off",
		);
		expect(pick("chat", 0, { contextTokens: 60000, heldModelId: GLM }).pair).toBe("glm:low");
	});

	it("vision requests exclude a text-only model", () => {
		// DeepSeek 1017 takes images; the old one did not. A text-only DeepSeek leaves vision work to GLM.
		expect(pick("algo", 0.8, { needsVision: true }).selection.modelId).toBe(DS);
		const textOnly = BENCHED.map((model) => (model.id === DS ? { ...model, input: ["text" as const] } : model));
		expect(pick("algo", 0.8, { needsVision: true }, MEDIUM, textOnly).selection.modelId).toBe(GLM);
	});

	it("with GLM disabled, easy work goes to deepseek off and hard algo to deepseek low", () => {
		const onlyDs = MODELS.filter((model) => model.id === DS);
		expect(pick("code", 0.2, {}, MEDIUM, onlyDs).pair).toBe("ds:off");
		expect(pick("algo", 0.8, {}, MEDIUM, onlyDs).pair).toBe("ds:low");
	});

	it("escalation steps up from the failed pair, once or twice", () => {
		const base = pick("code", 0.5).pair;
		expect(base).toBe("glm:low");
		const one = pick("code", 0.5, { escalation: { model: GLM, level: "low", steps: 1 } });
		const two = pick("code", 0.5, { escalation: { model: GLM, level: "low", steps: 2 } });
		expect(one.pair).not.toBe("glm:low");
		expect(one.selection.quality!.chosen).toBeGreaterThanOrEqual(
			one.selection.quality!.from!.quality + QUALITY.stepMargin,
		);
		expect(two.selection.quality!.chosen).toBeGreaterThanOrEqual(one.selection.quality!.chosen);
		expect(one.selection.cause).toBe("stepped_up");
		expect(one.selection.escalated).toBe(true);
	});

	it("escalating from the best pair moves to another pair in the band", () => {
		const best = pick("code", 0.8);
		const [model, level] = [
			best.selection.modelId,
			best.selection.candidates.find((c) => c.model === best.selection.modelId)!.thinkingLevel,
		];
		const next = pick("code", 0.8, { escalation: { model, level, steps: 1 } });
		expect(next.pair).not.toBe(best.pair);
	});
});

describe("modes under quality selection", () => {
	it("low mode never thinks above low; high mode never below low and takes the best pair", () => {
		const low: QualityModeConfig = { tolerance: 0.1, prefer: "lowest", maxAuto: "low", ceiling: "low" };
		const high: QualityModeConfig = { tolerance: 0.02, prefer: "highest", maxAuto: "max", floor: "low" };
		for (const kind of ["code", "algo", "math", "agentic", "terminal"] as const) {
			for (const d of [0.2, 0.5, 0.8]) {
				expect(["off", "low"]).toContain(pick(kind, d, {}, low).pair.split(":")[1]);
				const h = pick(kind, d, {}, high);
				expect(h.pair.split(":")[1]).not.toBe("off");
				expect(h.selection.quality!.chosen).toBeGreaterThanOrEqual(h.selection.quality!.best - 0.005);
			}
		}
	});
});

describe("fast path", () => {
	it("acks and greetings are trivial", () => {
		for (const text of [
			"thanks!",
			"ok",
			"cool, thanks",
			"perfect, thank you!",
			"merci beaucoup",
			"hi",
			"lgtm",
			"👍",
		]) {
			expect(fastPath(text, false)).toBe("ack");
		}
	});

	it("approvals are follow-ups; 'ok' after a question approves", () => {
		for (const text of ["yes do it", "go ahead", "continue", "sounds good, go", "yes, finish it", "yes please"]) {
			expect(fastPath(text, true)).toBe("approval");
		}
		expect(fastPath("ok", true)).toBe("approval");
		expect(fastPath("ok", false)).toBe("ack");
		expect(fastPath("yes", false)).toBe("approval");
	});

	it("short retries are retries; real requests go to the classifier", () => {
		expect(fastPath("still failing, same error", false)).toBe("retry");
		expect(fastPath("ok try again", false)).toBe("retry");
		for (const text of [
			"ok and add tests",
			"what does LGTM stand for?",
			"now do the same for PATCH /sessions",
			"fix the bug in parser.ts",
			"thanks, now rename foo to bar",
		]) {
			expect(fastPath(text, true)).toBeUndefined();
		}
		expect(fastPath("This test still fails:\n```\nFAIL x\n```", false)).toBeUndefined();
	});
});

describe("signals for the previous turn", () => {
	const user = (text: string): SignalMessage => ({ role: "user", content: text });
	const assistant = (text: string, extra: Partial<SignalMessage> = {}): SignalMessage => ({
		role: "assistant",
		content: [{ type: "text", text }],
		stopReason: "stop",
		model: GLM,
		...extra,
	});
	const bash = (id: string, command: string): SignalMessage => ({
		role: "assistant",
		content: [{ type: "toolCall", id, name: "bash", arguments: { command } }],
		stopReason: "toolUse",
		model: GLM,
	});
	const result = (id: string, text: string, isError = false): SignalMessage => ({
		role: "toolResult",
		toolCallId: id,
		isError,
		content: [{ type: "text", text }],
	});

	it("reports failing tests at the end of the previous turn, and a recovery", () => {
		const failing = extractTurnSignals(
			[
				user("fix it"),
				bash("a", "npm test"),
				result("a", "Tests: 1 failed, 2 passed"),
				assistant("done"),
				user("still?"),
			],
			{ contextTokens: 1000 },
		);
		expect(failing.previousTurn).toMatchObject({ testFailures: 1, lastTestPassed: false, errored: false });
		const recovered = extractTurnSignals(
			[
				user("fix it"),
				bash("a", "npm test"),
				result("a", "Tests: 1 failed"),
				bash("b", "npm test"),
				result("b", "Tests: 3 passed"),
				assistant("fixed"),
				user("next"),
			],
			{ contextTokens: 1000 },
		);
		expect(recovered.previousTurn).toMatchObject({ testFailures: 1, lastTestPassed: true });
	});

	it("does not count tool calls the user did not approve as failures", () => {
		const denied =
			"Not run: the user did not approve this bash call (declined, no answer, or no interactive approval available).";
		const s = extractTurnSignals(
			[user("fix it"), bash("a", "npm test"), result("a", denied, true), bash("b", "ls"), result("b", denied, true)],
			{ contextTokens: 1000 },
		);
		expect(s.toolErrorsThisTurn).toBe(0);
		expect(s.testFailuresThisTurn).toBe(0);
		const real = extractTurnSignals([user("fix it"), bash("a", "npm test"), result("a", "exit code 1", true)], {
			contextTokens: 1000,
		});
		expect(real.toolErrorsThisTurn).toBe(1);
		expect(real.testFailuresThisTurn).toBe(1);
	});

	it("reports a request error and whether the assistant asked a question", () => {
		const errored = extractTurnSignals([user("do x"), assistant("", { stopReason: "error" }), user("try again")], {
			contextTokens: 1000,
		});
		expect(errored.previousTurn?.errored).toBe(true);
		const asked = extractTurnSignals(
			[user("rename?"), assistant("It's in 2 files. Want me to rename them?"), user("yes")],
			{
				contextTokens: 1000,
			},
		);
		expect(asked.assistantAsked).toBe(true);
		const told = extractTurnSignals([user("rename"), assistant("Renamed."), user("ok")], { contextTokens: 1000 });
		expect(told.assistantAsked).toBe(false);
		expect(extractTurnSignals([user("hi")], { contextTokens: 1 }).previousTurn).toBeUndefined();
	});
});

function v2(
	answer: (request: string) => Partial<Classification>,
	models: readonly Model<Api>[] = BENCHED,
	now?: () => number,
) {
	const classifier = new MockClassifier((input) => ({
		skills: [],
		difficulty: 0.3,
		confidence: 1,
		needsTools: true,
		kind: "code",
		...answer(input.request),
	}));
	const router = new ModelRouter({
		catalog: CATALOG,
		classifier,
		getModels: () => models,
		defaultModelId: () => GLM,
		now,
	});
	return { router, classifier };
}

const turn = (text: string, extra: Partial<RouteRequest["signals"]> = {}): RouteRequest => ({
	signals: signals({ latestUserText: text, contextTokens: 14000, ...extra }),
	role: "code",
	toolsActive: true,
	mode: "medium",
});

const pairOf = (decision: { model: { id: string }; thinkingLevel: string }) =>
	`${decision.model.id === GLM ? "glm" : "ds"}:${decision.thinkingLevel}`;

describe("ModelRouter with quality selection", () => {
	it("routes an ack without calling the classifier", async () => {
		const { router, classifier } = v2(() => ({}));
		const decision = await router.route(turn("thanks!"));
		expect(classifier.calls).toHaveLength(0);
		expect(decision.source).toBe("heuristic");
		expect(decision.kind).toBe("chat");
		// GLM low is cheaper for this request alone, but over the cache horizon DeepSeek's $0.01 cached input wins.
		expect(pairOf(decision)).toBe("ds:off");
		expect(shortRouteReason(decision)).toBe("chat d0.00 fast");
	});

	it("a bare approval inherits the previous turn's hard route, no classifier call", async () => {
		const { router, classifier } = v2(() => ({ kind: "algo", difficulty: 0.8 }));
		const plan = await router.route(turn("offline distinct-count queries, n=2e5: which approach?"));
		expect(pairOf(plan)).toBe("ds:low");
		const approve = await router.route(turn("yes do it", { assistantAsked: true }));
		expect(classifier.calls).toHaveLength(1);
		expect(approve.source).toBe("follow-up");
		expect(approve.followUp).toBe(true);
		expect(pairOf(approve)).toBe("ds:low");
		expect(shortRouteReason(approve)).toBe("algo d0.80 follow-up");
	});

	it("a classifier follow-up keeps the previous kind and the work's full difficulty", async () => {
		const { router } = v2((request) =>
			request.startsWith("now")
				? { kind: "chat", difficulty: 0.25, followUp: true }
				: { kind: "algo", difficulty: 0.8 },
		);
		await router.route(turn("suffix automaton for 10^6"));
		const next = await router.route(turn("now make it work for a 10^5-symbol alphabet"));
		expect(next.kind).toBe("algo");
		expect(next.difficulty).toBeCloseTo(0.8, 5);
		expect(next.anchored).toBe(true);
		expect(pairOf(next)).toBe("ds:low");
	});

	describe("work anchor", () => {
		it("hard task, then 'ok thanks', then 'go on': routes at the hard task's difficulty and pair", async () => {
			const { router, classifier } = v2(() => ({ kind: "algo", difficulty: 0.8 }));
			const hard = await router.route(turn("offline distinct-count queries, n=2e5: implement it"));
			expect(pairOf(hard)).toBe("ds:low");
			const ack = await router.route(turn("ok thanks"));
			expect(ack.source).toBe("heuristic");
			expect(ack.kind).toBe("chat");
			expect(ack.difficulty).toBe(0);
			const goOn = await router.route(turn("go on"));
			expect(classifier.calls).toHaveLength(1);
			expect(goOn.source).toBe("follow-up");
			expect(goOn.anchored).toBe(true);
			expect(goOn.trivial).toBe(false);
			expect(goOn.kind).toBe("algo");
			expect(goOn.difficulty).toBeCloseTo(0.8, 5);
			expect(pairOf(goOn)).toBe(pairOf(hard));
			// "continue" right after stays on the work too.
			const again = await router.route(turn("continue"));
			expect(again.difficulty).toBeCloseTo(0.8, 5);
			expect(pairOf(again)).toBe(pairOf(hard));
		});

		it("after an ack excursion to another pair, 'go on' returns to the work's warm pair", async () => {
			const { router } = v2(() => ({ kind: "algo", difficulty: 0.8 }));
			const hard = await router.route(turn("suffix automaton for 10^6"));
			// The ack lands on another model (the work's is filtered out for it), so the transcript's warm pair is the ack's.
			router.setModelFilter((model) => model.id !== hard.model.id);
			const ack = await router.route(turn("ok thanks"));
			router.setModelFilter(undefined);
			expect(pairOf(ack)).not.toBe(pairOf(hard));
			const goOn = await router.route(
				turn("go on", { warmModelId: ack.model.id, warmThinkingLevel: ack.thinkingLevel }),
			);
			expect(goOn.anchored).toBe(true);
			expect(goOn.difficulty).toBeCloseTo(0.8, 5);
			expect(pairOf(goOn)).toBe(pairOf(hard));
		});

		it("a chat turn in between does not replace the work in progress", async () => {
			const { router } = v2((request) =>
				request.startsWith("what") ? { kind: "chat", difficulty: 0.1 } : { kind: "algo", difficulty: 0.8 },
			);
			const hard = await router.route(turn("suffix automaton for 10^6"));
			await router.route(turn("what does amortized mean?"));
			const goOn = await router.route(turn("go on"));
			expect(goOn.kind).toBe("algo");
			expect(goOn.difficulty).toBeCloseTo(0.8, 5);
			expect(pairOf(goOn)).toBe(pairOf(hard));
		});

		it("three chained classifier follow-ups do not decay", async () => {
			const { router } = v2((request) =>
				request.startsWith("now")
					? { kind: "chat", difficulty: 0.2, followUp: true }
					: { kind: "algo", difficulty: 0.8 },
			);
			await router.route(turn("suffix automaton for 10^6"));
			for (const text of ["now the alphabet", "now the memory", "now the tests"]) {
				const next = await router.route(turn(text));
				expect(next.source).toBe("classifier");
				expect(next.followUp).toBe(true);
				expect(next.kind).toBe("algo");
				expect(next.difficulty).toBeCloseTo(0.8, 5);
			}
		});

		it("an idle reset clears the anchor", async () => {
			let now = 1_000_000;
			const { router } = v2(
				() => ({ kind: "algo", difficulty: 0.8 }),
				BENCHED,
				() => now,
			);
			await router.route(turn("suffix automaton for 10^6"));
			await router.route(turn("ok thanks"));
			now += CATALOG.tuning.sessionIdleResetMin * 60_000 + 1000;
			// Idle: the held decision and the anchor are gone, so "go on" has nothing to inherit and is classified.
			const goOn = await router.route(turn("go on"));
			expect(goOn.anchored).toBeUndefined();
			expect(goOn.source).toBe("classifier");
		});

		it("router.reset() clears the anchor", async () => {
			const { router } = v2((request) =>
				request.startsWith("now")
					? { kind: "chat", difficulty: 0.2, followUp: true }
					: { kind: "algo", difficulty: 0.8 },
			);
			await router.route(turn("suffix automaton for 10^6"));
			router.reset();
			const next = await router.route(turn("now the alphabet"));
			expect(next.anchored).toBeUndefined();
			expect(next.followUp).toBe(false);
		});

		it("a plain new task stands on its own and becomes the new anchor", async () => {
			const { router } = v2((request) =>
				request === "hard"
					? { kind: "algo", difficulty: 0.9 }
					: request.startsWith("now")
						? { kind: "chat", difficulty: 0.2, followUp: true }
						: { kind: "code", difficulty: 0.45 },
			);
			await router.route(turn("hard"));
			const fresh = await router.route(turn("add a --since flag to the CLI"));
			expect(fresh.followUp).toBe(false);
			expect(fresh.anchored).toBeUndefined();
			expect(fresh.momentumApplied).toBe(false);
			expect(fresh.kind).toBe("code");
			expect(fresh.difficulty).toBeCloseTo(0.45, 5);
			const next = await router.route(turn("now the --until flag"));
			expect(next.kind).toBe("code");
			expect(next.difficulty).toBeCloseTo(0.45, 5);
		});
	});

	it("a new self-contained turn does not inherit a hard previous turn; it is picked afresh once the cache is cold", async () => {
		let now = 1_000_000;
		const { router } = v2(
			(request) => (request === "hard" ? { kind: "algo", difficulty: 0.9 } : { kind: "code", difficulty: 0.25 }),
			BENCHED,
			() => now,
		);
		const hard = await router.route(turn("hard"));
		expect(pairOf(hard)).toBe("ds:low");
		// Right after: the hard pair is warm and good enough for the easy turn, so it stays (no miss).
		now += 60_000;
		const easy = await router.route(turn("rename foo to bar in utils.ts"));
		expect(easy.momentumApplied).toBe(false);
		expect(pairOf(easy)).toBe("ds:low");
		// Idle past the cache TTL: every pair is cold, so the hard pair is no longer held; the pick is made afresh
		// (quality counts in the band: the session carries on with it).
		now += 901_000;
		const later = await router.route(turn("rename bar to baz in utils.ts"));
		expect(later.selection?.quality?.freeSwitch).toBe(true);
		expect(later.selection?.cause).not.toBe("held_warm");
		// Picked afresh on its own merits: with 1017's measured code rates ds:low is also the best fresh pick here.
		expect(later.selection?.quality?.cache).toBeUndefined();
	});

	it("steps up after a turn that ended with failing tests, and resets after a good turn", async () => {
		const { router } = v2(() => ({ kind: "code", difficulty: 0.45 }));
		const first = await router.route(turn("fix the flaky scheduler test"));
		expect(pairOf(first)).toBe("glm:low");
		const failed = { errored: false, toolErrors: 0, testFailures: 1, lastTestPassed: false };
		const second = await router.route(turn("look at the ordering again", { previousTurn: failed }));
		expect(second.escalationSteps).toBe(1);
		expect(pairOf(second)).not.toBe("glm:low");
		expect(second.selection?.quality?.from).toMatchObject({ model: GLM, level: "low" });
		expect(shortRouteReason(second)).toContain("↑1");
		const third = await router.route(turn("and the other test", { previousTurn: failed }));
		expect(third.escalationSteps).toBe(2);
		const ok = { errored: false, toolErrors: 0, testFailures: 0, lastTestPassed: true };
		const fourth = await router.route(turn("now add a changelog entry", { previousTurn: ok }));
		expect(fourth.escalationSteps).toBe(0);
		// Back in the band: the stepped-up pair is still warm on the session, so it stays (no miss back to glm:low).
		expect(pairOf(fourth)).toBe(pairOf(third));
	});

	it("skips the classifier when the warm pair wins for every task kind and difficulty", async () => {
		// One model whose only level in low mode is the warm one: nothing the classifier says can move the route.
		const onlyGlm = BENCHED.filter((model) => model.id === GLM);
		const { router, classifier } = v2(() => ({ kind: "code", difficulty: 0.45 }), onlyGlm);
		const low = (text: string, extra: Partial<RouteRequest["signals"]> = {}) => ({
			...turn(text, extra),
			mode: "low" as const,
		});
		const first = await router.route(low("add a --since flag"));
		const second = await router.route(
			low("and a --until flag", { warmModelId: first.model.id, warmThinkingLevel: first.thinkingLevel }),
		);
		expect(second.source).toBe("warm-skip");
		expect(classifier.calls).toHaveLength(1);
		expect(pairOf(second)).toBe(pairOf(first));
		expect(router.stats.warmSkips).toBe(1);
		expect(shortRouteReason(second)).toContain("fast");
	});

	it("still asks the classifier when another pair would win for some answer", async () => {
		const { router, classifier } = v2(() => ({ kind: "algo", difficulty: 0.9 }));
		const first = await router.route(turn("hard"));
		const second = await router.route(
			turn("next one", {
				warmModelId: first.model.id,
				warmThinkingLevel: first.thinkingLevel,
				contextTokens: 200_000,
			}),
		);
		expect(second.source).toBe("classifier");
		expect(classifier.calls).toHaveLength(2);
	});

	it("a provider error or a user retry counts as a failed turn", async () => {
		const { router } = v2(() => ({ kind: "code", difficulty: 0.45 }));
		await router.route(turn("add a --since flag"));
		const errored = await router.route(
			turn("try again", {
				previousTurn: { errored: true, toolErrors: 0, testFailures: 0, lastTestPassed: false },
				userRetry: true,
			}),
		);
		expect(errored.source).toBe("follow-up");
		expect(errored.escalationSteps).toBe(1);
		expect(pairOf(errored)).not.toBe("glm:low");
	});

	it("inside a turn: one tool error keeps the pair, repeated errors jump straight to the top pair once", async () => {
		const { router, classifier } = v2(() => ({ kind: "code", difficulty: 0.45 }));
		const start = await router.route(turn("wire the rate limiter"));
		const one = await router.route(
			turn("wire the rate limiter", { isNewUserTurn: false, toolCallsThisTurn: 2, toolErrorsThisTurn: 1 }),
		);
		// One error raises the difficulty boost a little: the warm pair holds.
		expect(one.escalationSteps ?? 0).toBe(0);
		expect(one.source).toBe("continuation");
		const three = await router.route(
			turn("wire the rate limiter", { isNewUserTurn: false, toolCallsThisTurn: 4, toolErrorsThisTurn: 3 }),
		);
		expect(three.source).toBe("escalation");
		// One jump to max_steps instead of a ladder of two (each step is a cache miss).
		expect(three.escalationSteps).toBe(2);
		expect(three.selection?.quality?.from).toMatchObject({ model: start.model.id, level: start.thinkingLevel });
		expect(classifier.calls).toHaveLength(1);
		const same = await router.route(
			turn("wire the rate limiter", { isNewUserTurn: false, toolCallsThisTurn: 5, toolErrorsThisTurn: 3 }),
		);
		expect(same.source).toBe("continuation");
		expect(pairOf(same)).toBe(pairOf(three));
	});

	it("prefetch starts the classifier once and route() reuses the call", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const { router, classifier } = v2(() => ({ kind: "math", difficulty: 0.8 }));
		const answer = classifier.answer;
		classifier.answer = async (input) => {
			await gate;
			return answer(input);
		};
		const request = turn("AIME-style counting problem");
		router.prefetch(request);
		router.prefetch(request);
		const routed = router.route(request);
		release();
		const decision = await routed;
		expect(classifier.calls).toHaveLength(1);
		expect(decision.source).toBe("classifier");
		expect(pairOf(decision)).toBe("ds:low");
		router.prefetch(turn("thanks"));
		expect(classifier.calls).toHaveLength(1);
	});

	it("a failed prefetch is not an unhandled rejection; route() falls back", async () => {
		const { router } = v2(() => {
			throw new ClassifierError("Jev 500");
		});
		router.prefetch(turn("some request"));
		const decision = await router.route(turn("some request"));
		expect(decision.source).toBe("default-fallback");
		expect(decision.error).toContain("Jev 500");
	});

	it("honours a pinned thinking level and the disabled-models filter", async () => {
		const { router } = v2(() => ({ kind: "algo", difficulty: 0.8 }));
		const pinned = await router.route({ ...turn("hard algo"), pinnedThinking: "max" });
		expect(pinned.thinkingPinned).toBe(true);
		expect(pinned.thinkingLevel).toBe("max");
		expect(pinned.routerThinkingLevel).toBe("low");
		router.setModelFilter((model) => model.id !== DS);
		router.reset();
		const glmOnly = await router.route(turn("hard algo 2"));
		expect(glmOnly.model.id).toBe(GLM);
	});

	it("mode bounds hold: low never above low, high never below low", async () => {
		const { router } = v2((request) => ({ kind: "algo", difficulty: request === "easy" ? 0.1 : 0.9 }));
		const low = await router.route({ ...turn("hard"), mode: "low" });
		expect(["off", "low"]).toContain(low.thinkingLevel);
		const high = await router.route({ ...turn("easy"), mode: "high" });
		expect(high.trivial).toBe(true);
		expect(high.thinkingLevel).not.toBe("off");
	});

	it("the /router report shows the task and quality lines", async () => {
		const { router } = v2(() => ({ kind: "terminal", difficulty: 0.75, outputLength: 2, ambiguity: 0.6 }));
		const decision = await router.route(turn("CI publish fails with E403"));
		const report = formatRouterReport({ enabled: true, mode: "medium", catalogSources: ["router.yaml"] }, decision);
		expect(report).toContain("Task: kind terminal");
		expect(report).toMatch(/Quality: chosen 0\.\d\d - best 0\.\d\d - band 0\.04/);
		expect(report).toContain("answer ~2500 tokens");
		expect(report).toMatch(/pass 0\.\d\d/);
	});

	it("an old (skills-only) classifier answer still routes, by mapping the skill to a kind", async () => {
		const { router } = v2(() => ({ kind: undefined, skills: [{ skill: "code.algo", prob: 0.9 }], difficulty: 0.8 }));
		const decision = await router.route(turn("hard algo"));
		expect(decision.kind).toBe("algo");
		expect(pairOf(decision)).toBe("ds:low");
	});
});

describe("v2 classifier questions", () => {
	const options = {
		apiKey: "k",
		skills: CATALOG.skills,
		skillThreshold: 0.12,
		maxSecondarySkills: 3,
		schema: 2 as const,
		kindSkills: QUALITY.kindSkills,
	};
	const input = {
		request: "yes do it",
		recentContext: "assistant: Want me to implement the BIT approach?",
		hasImages: false,
		previous: { kind: "algo" as const, difficulty: 0.8 },
		harness: {
			role: "code" as const,
			contextTokens: 1000,
			toolErrorsThisTurn: 0,
			testFailuresThisTurn: 0,
			filesTouchedThisTurn: 0,
		},
	};

	it("Jev asks task, difficulty, follow-up, output length, ambiguity and tools, with the previous turn in state", () => {
		const body = new JevClassifier(options).buildRequest(input) as {
			state: { previous_turn: unknown };
			questions: Record<string, { type: string }>;
		};
		expect(Object.keys(body.questions)).toEqual([
			"task",
			"difficulty",
			"follow_up",
			"output_length",
			"ambiguity",
			"needs_tools",
		]);
		expect(body.questions.task.type).toBe("choice");
		expect(body.questions.output_length.type).toBe("score");
		expect(body.state.previous_turn).toEqual({ task: "algo", difficulty: 0.8 });
		expect(JSON.stringify(body).length).toBeLessThan(
			JSON.stringify(new JevClassifier({ ...options, schema: 1 }).buildRequest(input)).length,
		);
	});

	it("parses a Jev v2 answer", () => {
		const parsed = new JevClassifier(options).parse({
			answers: {
				task: { choice: "algorithm", confidence: 0.8 },
				difficulty: { score: 3, confidence: 0.9 },
				follow_up: { noul: 0.9 },
				output_length: { score: 2.4 },
				ambiguity: { noul: 0.1 },
				needs_tools: { noul: 0.2 },
			},
		});
		expect(parsed).toMatchObject({
			kind: "algo",
			difficulty: 0.75,
			confidence: 0.8,
			followUp: true,
			outputLength: 2.4,
			ambiguity: 0.1,
			needsTools: false,
			skills: [{ skill: "code.algo", prob: 0.8 }],
		});
		expect(() =>
			new JevClassifier(options).parse({ answers: { task: { choice: "poetry" }, difficulty: { score: 1 } } }),
		).toThrow(ClassifierError);
	});

	it("OpenRouter v2: the same typed questions, answered with probabilities", () => {
		const classifier = new OpenRouterClassifier(options);
		const body = classifier.buildRequest(input) as { model: string; questions: Record<string, { type: string }> };
		expect(body.model).toBe("typesafe/jev-1.14");
		expect(body.questions).toEqual(
			(new JevClassifier(options).buildRequest(input) as { questions: unknown }).questions,
		);
		const parsed = classifier.parse({
			model: "liquid/d1-ultra-20261015",
			answers: {
				task: {
					type: "choice",
					choice: "terminal",
					probabilities: { terminal: 0.7, multi_file: 0.2, feature: 0.1 },
					confidence: 0.62,
				},
				difficulty: {
					type: "score",
					score: 3,
					probabilities: { "0": 0, "1": 0, "2": 0.05, "3": 0.9, "4": 0.05 },
					confidence: 0.85,
				},
				follow_up: { type: "noul", noul: 0.1 },
				output_length: { type: "score", score: 2 },
				ambiguity: { type: "noul", noul: 0.8 },
				needs_tools: { type: "noul", noul: 0.95 },
				parts: { type: "score", score: 2 },
			},
		});
		expect(parsed).toMatchObject({
			kind: "terminal",
			difficulty: 0.75,
			confidence: 0.62,
			followUp: false,
			outputLength: 2,
			ambiguity: 0.8,
			needsTools: true,
		});
		// An extra answer (the retired parts question) is ignored.
		expect(parsed).not.toHaveProperty("parts");
		expect(() =>
			classifier.parse({
				answers: { task: { type: "choice", choice: "x" }, difficulty: { type: "score", score: 1 } },
			}),
		).toThrow(ClassifierError);
	});

	it("falls back (throws) when the task answer is too spread to route on", () => {
		const classifier = new OpenRouterClassifier(options);
		const spread = Object.fromEntries(
			["chat", "explain", "lookup", "edit", "feature", "review", "algorithm", "math", "multi_file", "terminal"].map(
				(name, index) => [name, index === 4 ? 0.19 : 0.09],
			),
		);
		expect(ROUTE_MIN_TASK_PROBABILITY).toBe(0.3);
		expect(() =>
			classifier.parse({
				answers: {
					task: { type: "choice", choice: "feature", probabilities: spread, confidence: 0.05 },
					difficulty: { type: "score", score: 2 },
				},
			}),
		).toThrow(/too uncertain/);
	});
});
