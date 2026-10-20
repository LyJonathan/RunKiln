import { describe, expect, it } from "vitest";
import { ModelRouter } from "../../src/core/router/router.ts";
import { ClassifierError } from "../../src/core/router/types.ts";
import { classification, MockClassifier, signals, TEST_MODELS, testCatalog } from "./router-fixtures.ts";

function setup(options: { classifier?: MockClassifier; now?: () => number; problem?: string } = {}) {
	const classifier = options.classifier ?? new MockClassifier(() => classification());
	const router = new ModelRouter({
		catalog: testCatalog(),
		classifier: options.problem ? undefined : classifier,
		classifierProblem: options.problem,
		getModels: () => TEST_MODELS,
		defaultModelId: () => "cheap",
		defaultThinkingLevel: () => "low",
		now: options.now,
	});
	return { router, classifier };
}

const request = (
	overrides: Parameters<typeof signals>[0] = {},
	extra: { pinnedThinking?: "off" | "high" | "max" } = {},
) => ({
	signals: signals(overrides),
	role: "code" as const,
	toolsActive: true,
	...extra,
});

describe("ModelRouter", () => {
	it("classifies a new user turn and routes easy work to the cheap model with light thinking", async () => {
		const { router, classifier } = setup();
		const decision = await router.route(request({ latestUserText: "rename this variable" }));
		expect(classifier.calls).toHaveLength(1);
		expect(classifier.calls[0].request).toBe("rename this variable");
		expect(decision.model.id).toBe("cheap");
		expect(decision.source).toBe("classifier");
		expect(decision.backend).toBe("jev");
		// Easy: the cheapest model at its lowest level.
		expect(decision.thinkingLevel).toBe("off");
		expect(decision.mode).toBe("medium");
		expect(decision.estCostUsd).toBeGreaterThan(0);
	});

	it("routes hard work to the strong model and thinks more", async () => {
		const { router } = setup({
			classifier: new MockClassifier(() =>
				classification({ difficulty: 0.8, skills: [{ skill: "reason.deep", prob: 0.9 }] }),
			),
		});
		const decision = await router.route(request());
		expect(decision.model.id).toBe("strong");
		// Bar 68: strong (65) clears it at high (+10); the cheap model cannot at any level.
		expect(decision.routerThinkingLevel).toBe("high");
	});

	it("does not call the classifier on tool continuations: the turn's decision is kept", async () => {
		const { router, classifier } = setup();
		await router.route(request());
		const next = await router.route(request({ isNewUserTurn: false, toolCallsThisTurn: 1, warmModelId: "cheap" }));
		expect(classifier.calls).toHaveLength(1);
		expect(next.source).toBe("continuation");
		expect(next.model.id).toBe("cheap");
		expect(router.stats.continuations).toBe(1);
	});

	it("escalates within a tool loop on tool errors and failing tests, without a classifier call", async () => {
		const { router, classifier } = setup({
			classifier: new MockClassifier(() => classification({ difficulty: 0.3 })),
		});
		const first = await router.route(request());
		expect(first.model.id).toBe("cheap");
		const failing = await router.route(
			request({
				isNewUserTurn: false,
				toolCallsThisTurn: 4,
				toolErrorsThisTurn: 1,
				testFailuresThisTurn: 1,
				warmModelId: "cheap",
			}),
		);
		expect(classifier.calls).toHaveLength(1);
		expect(failing.source).toBe("escalation");
		expect(failing.boosts.map((b) => b.reason)).toEqual(["1 tool error", "failing tests"]);
		// 0.3 + 0.08 + 0.15 = 0.53 -> bugfix needs 52; cheap has 40 -> strong.
		expect(failing.difficulty).toBeCloseTo(0.53);
		expect(failing.model.id).toBe("strong");
		// The same failures again do not re-select.
		const again = await router.route(
			request({
				isNewUserTurn: false,
				toolCallsThisTurn: 5,
				toolErrorsThisTurn: 1,
				testFailuresThisTurn: 1,
				warmModelId: "strong",
			}),
		);
		expect(again.source).toBe("continuation");
		expect(again.model.id).toBe("strong");
	});

	it("reuses a cached answer for the same request", async () => {
		const { router, classifier } = setup();
		await router.route(request({ latestUserText: "same thing" }));
		const second = await router.route(request({ latestUserText: "same thing" }));
		expect(classifier.calls).toHaveLength(1);
		expect(second.source).toBe("cache");
		expect(router.stats.cacheHits).toBe(1);
	});

	it("expires cached answers after the TTL", async () => {
		let now = 0;
		const classifier = new MockClassifier(() => classification());
		const router = new ModelRouter({
			catalog: testCatalog(),
			classifier,
			getModels: () => TEST_MODELS,
			defaultModelId: () => "cheap",
			cacheTtlMs: 1000,
			now: () => now,
		});
		await router.route(request({ latestUserText: "same" }));
		now = 2000;
		await router.route(request({ latestUserText: "same" }));
		expect(classifier.calls).toHaveLength(2);
	});

	it("escalates fast and de-escalates slowly across turns (momentum, applied once)", async () => {
		const answers = [0.9, 0.1, 0.1];
		const { router } = setup({
			classifier: new MockClassifier(() => classification({ difficulty: answers.shift() ?? 0.1 })),
		});
		const hard = await router.route(request({ latestUserText: "hard" }));
		expect(hard.model.id).toBe("strong");
		const easier = await router.route(request({ latestUserText: "easy 1" }));
		expect(easier.rawDifficulty).toBe(0.1);
		expect(easier.momentumApplied).toBe(true);
		expect(easier.difficulty).toBeCloseTo(0.9 * 0.85);
		const easiest = await router.route(request({ latestUserText: "easy 2" }));
		expect(easiest.difficulty).toBeCloseTo(0.9 * 0.85 * 0.85);
	});

	it("resets momentum after the session sits idle", async () => {
		let now = 0;
		const answers = [0.9, 0.1];
		const { router } = setup({
			classifier: new MockClassifier(() => classification({ difficulty: answers.shift() ?? 0.1 })),
			now: () => now,
		});
		await router.route(request({ latestUserText: "hard" }));
		now = 31 * 60_000;
		const later = await router.route(request({ latestUserText: "easy" }));
		expect(later.momentumApplied).toBe(false);
		expect(later.difficulty).toBe(0.1);
	});

	it("falls back to the held decision when the classifier fails, and says so", async () => {
		let fail = false;
		const { router } = setup({
			classifier: new MockClassifier(() => {
				if (fail) throw new ClassifierError("Jev timed out after 4000 ms");
				return classification({ difficulty: 0.8 });
			}),
		});
		const first = await router.route(request({ latestUserText: "a" }));
		fail = true;
		const second = await router.route(request({ latestUserText: "b" }));
		expect(second.source).toBe("held-fallback");
		expect(second.model.id).toBe(first.model.id);
		expect(second.thinkingLevel).toBe(first.thinkingLevel);
		expect(second.error).toBe("Jev timed out after 4000 ms");
		expect(router.stats.classifierFailures).toBe(1);
		expect(router.stats.fallbacks).toBe(1);
	});

	it("falls back to the default model when the classifier fails before any decision", async () => {
		const { router } = setup({ classifier: new MockClassifier(() => Promise.reject(new Error("network down"))) });
		const decision = await router.route(request());
		expect(decision.source).toBe("default-fallback");
		expect(decision.model.id).toBe("cheap");
		expect(decision.thinkingLevel).toBe("low");
		expect(decision.error).toBe("network down");
	});

	it("uses the default model and reports why when no classifier is configured", async () => {
		const { router } = setup({
			problem: "no classifier key: set TYPESAFE_API_KEY (Jev) or OPENROUTER_API_KEY (OpenRouter)",
		});
		const decision = await router.route(request());
		expect(decision.source).toBe("default-fallback");
		expect(decision.error).toMatch(/TYPESAFE_API_KEY/);
	});

	it("propagates an abort instead of falling back", async () => {
		const controller = new AbortController();
		const { router } = setup({
			classifier: new MockClassifier(() => {
				controller.abort();
				throw new Error("aborted");
			}),
		});
		await expect(router.route(request(), controller.signal)).rejects.toThrow("aborted");
	});

	it("applies a pinned thinking level, clamped to the chosen model", async () => {
		const { router } = setup();
		const pinned = await router.route(request({}, { pinnedThinking: "max" }));
		expect(pinned.thinkingPinned).toBe(true);
		// The test models support off/low/medium/high: max clamps down to high.
		expect(pinned.thinkingLevel).toBe("high");
		expect(pinned.routerThinkingLevel).toBe("off");
	});

	it("skips a model whose request failed and picks another", async () => {
		const { router } = setup({ classifier: new MockClassifier(() => classification({ difficulty: 0.8 })) });
		const first = await router.route(request());
		expect(first.model.id).toBe("strong");
		router.markModelFailed("strong");
		expect(router.hasAlternative("cheap")).toBe(false);
		const retry = await router.route(request({ isNewUserTurn: false, warmModelId: "strong" }));
		expect(retry.model.id).toBe("cheap");
		expect(retry.selection?.escalated).toBe(true);
	});

	it("requires tool support on tool continuations and when the classifier says tools are needed", async () => {
		const { router } = setup({ classifier: new MockClassifier(() => classification({ needsTools: true })) });
		const decision = await router.route(request());
		expect(decision.selection?.required.map((r) => r.skill)).toContain("tool.call");
		const chat = await router.route({ ...request({ latestUserText: "other" }), role: "chat", toolsActive: false });
		expect(chat.selection?.required.map((r) => r.skill)).not.toContain("tool.call");
	});

	it("flags a switch away from the warm model", async () => {
		const { router } = setup({ classifier: new MockClassifier(() => classification({ difficulty: 0.8 })) });
		const decision = await router.route(request({ warmModelId: "cheap" }));
		expect(decision.model.id).toBe("strong");
		expect(decision.switched).toBe(true);
		expect(decision.previousModelId).toBe("cheap");
	});
});
