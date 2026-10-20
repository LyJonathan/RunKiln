import { describe, expect, it } from "vitest";
import { DEFAULT_THINKING } from "../../src/core/router/catalog.ts";
import {
	effectiveDifficulty,
	estimateCost,
	NoRouteError,
	requiredSkills,
	type SelectInput,
	selectModel,
} from "../../src/core/router/select.ts";
import { candidate, testCatalog } from "./router-fixtures.ts";

const catalog = testCatalog();
const { tuning, thinking } = catalog;

function input(overrides: Partial<SelectInput> = {}): SelectInput {
	return {
		skills: [{ skill: "code.bugfix", prob: 0.8 }],
		difficulty: 0.2,
		confidence: 1,
		needsTools: false,
		needsVision: false,
		contextTokens: 5000,
		outputTokens: 1000,
		...overrides,
	};
}

const models = [candidate("cheap"), candidate("strong")];

describe("router selection math", () => {
	it("requires req_base + difficulty * req_span for the primary skill and x secondary_factor for the rest", () => {
		const required = requiredSkills(
			input({
				skills: [
					{ skill: "code.bugfix", prob: 0.7 },
					{ skill: "chat", prob: 0.2 },
				],
			}),
			0.5,
			tuning,
		);
		expect(required).toEqual([
			{ skill: "code.bugfix", prob: 0.7, minScore: 50 },
			{ skill: "chat", prob: 0.2, minScore: 40 },
		]);
	});

	it("adds tool.call when tools are needed and longctx for big contexts, at the secondary bar", () => {
		const required = requiredSkills(input({ needsTools: true, contextTokens: 120_000 }), 0.5, tuning);
		expect(required.map((r) => [r.skill, r.minScore])).toEqual([
			["code.bugfix", 50],
			["tool.call", 40],
			["longctx", 40],
		]);
	});

	it("raises difficulty for low classifier confidence", () => {
		expect(effectiveDifficulty(0.4, 0.5, { ...tuning, lowConfidenceBoost: 0.2 })).toBeCloseTo(0.5);
		expect(effectiveDifficulty(0.95, 0, { ...tuning, lowConfidenceBoost: 0.2 })).toBe(1);
	});

	it("picks the cheapest (model, thinking) pair that clears every bar", () => {
		const easy = selectModel(models, input({ difficulty: 0.2 }), tuning, thinking);
		expect(easy.modelId).toBe("cheap");
		expect(easy.cause).toBe("cheapest_feasible");
		expect(easy.escalated).toBe(false);
		// Simple task: cheapest model at the lowest level.
		expect(easy.candidates.find((c) => c.model === "cheap")?.thinkingLevel).toBe("off");

		const hardest = selectModel(models, input({ difficulty: 0.6 }), tuning, thinking);
		expect(hardest.modelId).toBe("strong");
		const cheap = hardest.candidates.find((c) => c.model === "cheap");
		expect(cheap?.feasible).toBe(false);
		expect(cheap?.failed).toEqual(["code.bugfix(50<56)"]);
	});

	it("stays on the cheap model with more thinking before moving to a pricier model", () => {
		// Bar 50: cheap scores 40 (+4 low, +7 medium, +10 high), strong 70.
		const result = selectModel(models, input({ difficulty: 0.5 }), tuning, thinking);
		expect(result.modelId).toBe("cheap");
		const cheap = result.candidates.find((c) => c.model === "cheap");
		expect(cheap?.thinkingLevel).toBe("high");
		// Floor at d 0.5 is minimal; the test models start at low above it.
		expect(cheap?.pairs?.map((p) => [p.level, p.feasible])).toEqual([
			["low", false],
			["medium", false],
			["high", true],
		]);
		// Each pair costs more as thinking rises (output tokens).
		const costs = cheap?.pairs?.map((p) => p.estCostUsd) ?? [];
		expect([...costs].sort((a, b) => a - b)).toEqual(costs);
	});

	it("keeps the deepest allowed level with prefer: highest", () => {
		const result = selectModel(models, input({ difficulty: 0.2 }), tuning, { ...thinking, prefer: "highest" });
		expect(result.candidates.find((c) => c.model === result.modelId)?.thinkingLevel).toBe("high");
	});

	it("uses levels above max_auto on a model before escalating (beyond_cap_when_short)", () => {
		const glmLike = [candidate("cheap", { supportedThinking: ["low", "high", "max"] })];
		// Bar 50: cheap needs +10 -> high, but max_auto is low; max (+14) clears it.
		const capped = { ...thinking, maxAuto: "low" as const };
		const short = selectModel(glmLike, input({ difficulty: 0.5 }), tuning, { ...capped, beyondCapWhenShort: false });
		expect(short.escalated).toBe(true);
		expect(short.candidates[0].thinkingLevel).toBe("low");
		const beyond = selectModel(glmLike, input({ difficulty: 0.5 }), tuning, { ...capped, beyondCapWhenShort: true });
		expect(beyond.escalated).toBe(false);
		expect(beyond.candidates[0].thinkingLevel).toBe("high");
	});

	it("escalates to the least deficient model and flags it when nothing clears the bar", () => {
		const result = selectModel(
			models,
			input({ difficulty: 1, skills: [{ skill: "reason.deep", prob: 0.9 }] }),
			tuning,
			thinking,
		);
		expect(result.modelId).toBe("strong");
		expect(result.escalated).toBe(true);
		expect(result.cause).toBe("escalated_nearest_fit");
	});

	it("never escalates onto a model that fails a hard filter (vision)", () => {
		const vision = [candidate("cheap", { vision: true }), candidate("strong", { vision: false })];
		const result = selectModel(vision, input({ difficulty: 1, needsVision: true }), tuning, thinking);
		expect(result.modelId).toBe("cheap");
		expect(result.escalated).toBe(true);
		expect(result.candidates.find((c) => c.model === "strong")).toMatchObject({
			hardFail: true,
			failed: expect.arrayContaining(["vision"]),
		});
	});

	it("filters on context = input + output * 1.1", () => {
		const small = [candidate("cheap", { contextWindow: 10_000 }), candidate("strong")];
		// 8900 + 1100 = 10000 fits exactly; one more token does not.
		expect(selectModel(small, input({ contextTokens: 8900 }), tuning, thinking).modelId).toBe("cheap");
		const over = selectModel(small, input({ contextTokens: 8901 }), tuning, thinking);
		expect(over.modelId).toBe("strong");
		expect(over.candidates.find((c) => c.model === "cheap")?.failed).toContain("context");
	});

	it("throws NoRouteError when no model passes the hard filters", () => {
		expect(() => selectModel(models, input({ needsVision: true }), tuning, thinking)).toThrow(NoRouteError);
		expect(() => selectModel([], input(), tuning, thinking)).toThrow(NoRouteError);
	});

	it("prefers the larger skill margin among near-ties (within cost_tiebreak_frac)", () => {
		const a = candidate("a", { priceIn: 0.1, priceOut: 0.4, skills: { "code.bugfix": 40 } });
		const b = candidate("b", { priceIn: 0.105, priceOut: 0.42, skills: { "code.bugfix": 60 } });
		const result = selectModel([a, b], input(), tuning, thinking);
		expect(result.modelId).toBe("b");
		// Outside the tie-break window, the cheaper one wins.
		const pricey = candidate("b", { priceIn: 0.2, priceOut: 0.8, skills: { "code.bugfix": 60 } });
		expect(selectModel([a, pricey], input(), tuning, thinking).modelId).toBe("a");
	});

	it("is independent of catalog order and breaks exact ties by id", () => {
		const twins = [
			candidate("zeta", { skills: { "code.bugfix": 50 } }),
			candidate("alpha", { skills: { "code.bugfix": 50 } }),
		];
		expect(selectModel(twins, input(), tuning, thinking).modelId).toBe("alpha");
		expect(selectModel([...twins].reverse(), input(), tuning, thinking).modelId).toBe("alpha");
		expect(selectModel([...models].reverse(), input({ difficulty: 0.6 }), tuning, thinking).modelId).toBe("strong");
	});

	it("charges the cached input price only for the model whose cache is warm", () => {
		const strong = candidate("strong");
		const cold = estimateCost(strong, 100_000, 1000, "off", false, DEFAULT_THINKING);
		const warm = estimateCost(strong, 100_000, 1000, "off", true, DEFAULT_THINKING);
		expect(cold).toBeCloseTo(0.1 * 0.3 + 0.001 * 1.2);
		expect(warm).toBeCloseTo(0.1 * 0.03 + 0.001 * 1.2);
		// Thinking tokens are billed as output.
		expect(estimateCost(strong, 0, 1000, "high", false, DEFAULT_THINKING)).toBeCloseTo(0.003 * 1.2);
	});

	it("keeps the warm model when switching would lose its prompt cache", () => {
		// Large context: the strong model's warm cache makes it cheaper than a cold switch to cheap.
		const result = selectModel(models, input({ contextTokens: 60_000, heldModelId: "strong" }), tuning, thinking);
		expect(result.modelId).toBe("strong");
		// Without a warm cache the cheap model wins the same request.
		expect(selectModel(models, input({ contextTokens: 60_000 }), tuning, thinking).modelId).toBe("cheap");
	});

	it("sticks with the held model when it is within `stickiness` of the best cost", () => {
		const skills = { "code.bugfix": 50 };
		const a = candidate("a", { priceIn: 0.1, priceOut: 0.4, priceCachedIn: 0.1, skills });
		const b = candidate("b", { priceIn: 0.12, priceOut: 0.48, priceCachedIn: 0.12, skills });
		const sticky = selectModel([a, b], input({ heldModelId: "b" }), tuning, thinking);
		expect(sticky).toMatchObject({ modelId: "b", cause: "held_sticky" });
		const notSticky = selectModel([a, b], input({ heldModelId: "b" }), { ...tuning, stickiness: 0 }, thinking);
		expect(notSticky.modelId).toBe("a");
	});

	it("judges out-of-taxonomy requests by general intelligence", () => {
		const result = selectModel(models, input({ skills: [], difficulty: 0.5 }), tuning, thinking);
		// Generalist bar: (20 + 0.5 * 60) * 0.8 = 40: both clear it, cheap is cheaper.
		expect(result.required).toEqual([]);
		expect(result.modelId).toBe("cheap");
	});

	it("reports the thinking level per candidate, clamped to what each model supports", () => {
		const limited = [candidate("cheap", { supportedThinking: ["off", "high"] }), candidate("strong")];
		const result = selectModel(limited, input({ difficulty: 0.5 }), tuning, thinking);
		// d 0.5 -> low; cheap only has off/high -> high; strong supports low.
		expect(result.candidates.find((c) => c.model === "cheap")?.thinkingLevel).toBe("high");
		expect(result.candidates.find((c) => c.model === "strong")?.thinkingLevel).toBe("low");
	});

	it("does not clamp the router's thinking above max_auto (glm-style low/high/max)", () => {
		const glmLike = [candidate("strong", { supportedThinking: ["low", "high", "max"] })];
		// d 1 wants xhigh; glm has no xhigh. Clamping up would give max, which is over max_auto.
		const result = selectModel(glmLike, input({ difficulty: 1 }), tuning, thinking);
		expect(result.candidates[0].thinkingLevel).toBe("high");
	});
});
