import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { matchesKey } from "@runkiln/tui";
import { describe, expect, it } from "vitest";
import { RESERVED_KEYBINDINGS_FOR_EXTENSION_CONFLICTS } from "../../src/core/extensions/runner.ts";
import { KEYBINDINGS, KeybindingsManager } from "../../src/core/keybindings.ts";
import { loadRouterCatalog, parseRouterCatalog, resolveModeConfig } from "../../src/core/router/catalog.ts";
import { formatRouterReport } from "../../src/core/router/format.ts";
import { ModelRouter } from "../../src/core/router/router.ts";
import { clampToBand } from "../../src/core/router/thinking.ts";
import { runkilnOnboardingLine } from "../../src/modes/interactive/components/onboarding-line.ts";
import {
	classification,
	MockClassifier,
	signals,
	TEST_MODELS,
	TEST_ROUTER_YAML,
	testCatalog,
} from "./router-fixtures.ts";

const ORDER = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const depth = (level: string) => ORDER.indexOf(level);

function routerWith(difficulty: number | ((request: string) => number), extraYaml?: string) {
	const classifier = new MockClassifier((input) =>
		classification({ difficulty: typeof difficulty === "number" ? difficulty : difficulty(input.request) }),
	);
	const router = new ModelRouter({
		catalog: testCatalog(extraYaml),
		classifier,
		getModels: () => TEST_MODELS,
		defaultModelId: () => "cheap",
	});
	return { router, classifier };
}

describe("high mode on trivial turns (trivial_below + min_thinking)", () => {
	it("routes a trivial turn to the cheapest model with thinking floored at low, never off", async () => {
		const { router } = routerWith(0.02);
		const decision = await router.route({ signals: signals(), role: "code", toolsActive: false, mode: "high" });
		expect(decision.trivial).toBe(true);
		expect(decision.model.id).toBe("cheap");
		expect(decision.thinkingLevel).toBe("low");
		expect(decision.routerThinkingLevel).not.toBe("off");
	});

	it("gives non-trivial turns the strongest pair", async () => {
		const { router } = routerWith(0.6);
		const decision = await router.route({ signals: signals(), role: "code", toolsActive: false, mode: "high" });
		expect(decision.trivial).toBe(false);
		expect(decision.model.id).toBe("strong");
		expect(decision.thinkingLevel).toBe("high");
	});

	it("judges triviality on the turn itself: momentum from a hard turn does not make a 'thanks' expensive", async () => {
		const { router } = routerWith((request) => (request === "thanks" ? 0.02 : 0.9));
		const hard = await router.route({ signals: signals(), role: "code", toolsActive: false, mode: "high" });
		expect(hard.model.id).toBe("strong");
		const thanks = await router.route({
			signals: signals({ latestUserText: "thanks", warmModelId: "strong" }),
			role: "code",
			toolsActive: false,
			mode: "high",
		});
		expect(thanks.trivial).toBe(true);
		expect([thanks.model.id, thanks.thinkingLevel]).toEqual(["cheap", "low"]);
		// Back to real work: the cheap model is warm now, but high mode does not stick to it.
		const again = await router.route({
			signals: signals({ latestUserText: "fix it properly", warmModelId: "cheap" }),
			role: "code",
			toolsActive: false,
			mode: "high",
		});
		expect(again.trivial).toBe(false);
		expect([again.model.id, again.thinkingLevel]).toEqual(["strong", "high"]);
	});

	it("stops treating the turn as trivial once failures in it raise the difficulty", async () => {
		const { router } = routerWith(0.02);
		const first = await router.route({ signals: signals(), role: "code", toolsActive: true, mode: "high" });
		expect(first.trivial).toBe(true);
		const next = await router.route({
			signals: signals({ isNewUserTurn: false, toolCallsThisTurn: 3, toolErrorsThisTurn: 3, warmModelId: "cheap" }),
			role: "code",
			toolsActive: true,
			mode: "high",
		});
		expect(next.source).toBe("escalation");
		expect(next.trivial).toBe(false);
		expect(next.model.id).toBe("strong");
	});

	it("keeps the trivial pair on a plain tool continuation", async () => {
		const { router, classifier } = routerWith(0.02);
		await router.route({ signals: signals(), role: "code", toolsActive: true, mode: "high" });
		const next = await router.route({
			signals: signals({ isNewUserTurn: false, toolCallsThisTurn: 1, warmModelId: "cheap" }),
			role: "code",
			toolsActive: true,
			mode: "high",
		});
		expect(classifier.calls).toHaveLength(1);
		expect([next.source, next.trivial, next.model.id, next.thinkingLevel]).toEqual([
			"continuation",
			true,
			"cheap",
			"low",
		]);
	});

	it("reads the floor and the trivial bound from router.yaml", async () => {
		const floored = routerWith(0.02, "modes:\n  high:\n    min_thinking: medium\n");
		const decision = await floored.router.route({
			signals: signals(),
			role: "code",
			toolsActive: false,
			mode: "high",
		});
		expect([decision.model.id, decision.thinkingLevel]).toEqual(["cheap", "medium"]);

		const off = routerWith(0.02, "modes:\n  high:\n    trivial_below: 0\n");
		const strong = await off.router.route({ signals: signals(), role: "code", toolsActive: false, mode: "high" });
		expect(strong.trivial).toBe(false);
		expect(strong.model.id).toBe("strong");
	});

	it("leaves low and medium without a trivial policy or a floor by default", async () => {
		for (const mode of ["low", "medium"] as const) {
			const { router } = routerWith(0.02);
			const decision = await router.route({ signals: signals(), role: "code", toolsActive: false, mode });
			expect(decision.trivial).toBe(false);
			expect(decision.thinkingLevel).toBe("off");
		}
	});

	it("does not bind a level the user pinned", async () => {
		const { router } = routerWith(0.02);
		const decision = await router.route({
			signals: signals(),
			role: "code",
			toolsActive: false,
			mode: "high",
			pinnedThinking: "off",
		});
		expect(decision.thinkingLevel).toBe("off");
		expect(decision.thinkingPinned).toBe(true);
	});
});

describe("low mode thinking cap (max_thinking)", () => {
	it("caps low mode at thinking low by default, even on a hard task", async () => {
		const { router } = routerWith(0.95);
		const decision = await router.route({ signals: signals(), role: "code", toolsActive: false, mode: "low" });
		expect(depth(decision.thinkingLevel)).toBeLessThanOrEqual(depth("low"));
		expect(resolveModeConfig(testCatalog(), "low").thinking.maxAuto).toBe("low");
	});

	it("lets escalation raise the model but never the thinking level above the cap", async () => {
		const { router } = routerWith(0.3);
		const first = await router.route({ signals: signals(), role: "code", toolsActive: true, mode: "low" });
		expect(first.model.id).toBe("cheap");
		const escalated = await router.route({
			signals: signals({
				isNewUserTurn: false,
				toolCallsThisTurn: 30,
				toolErrorsThisTurn: 3,
				testFailuresThisTurn: 1,
				userRetry: true,
				warmModelId: "cheap",
			}),
			role: "code",
			toolsActive: true,
			mode: "low",
		});
		expect(escalated.source).toBe("escalation");
		expect(escalated.model.id).toBe("strong");
		expect(depth(escalated.thinkingLevel)).toBeLessThanOrEqual(depth("low"));
		for (const candidate of escalated.selection?.candidates ?? []) {
			for (const pair of candidate.pairs ?? []) expect(depth(pair.level)).toBeLessThanOrEqual(depth("low"));
		}
	});

	it("holds the cap when the user turns beyond_cap_when_short back on", async () => {
		const { router } = routerWith(0.99, "modes:\n  low:\n    thinking: { beyond_cap_when_short: true }\n");
		const decision = await router.route({ signals: signals(), role: "code", toolsActive: false, mode: "low" });
		expect(depth(decision.thinkingLevel)).toBeLessThanOrEqual(depth("low"));
	});

	it("caps momentum too", async () => {
		const { router } = routerWith((request) => (request === "next" ? 0.1 : 0.99));
		await router.route({ signals: signals(), role: "code", toolsActive: false, mode: "low" });
		const next = await router.route({
			signals: signals({ latestUserText: "next" }),
			role: "code",
			toolsActive: false,
			mode: "low",
		});
		expect(next.momentumApplied).toBe(true);
		expect(depth(next.thinkingLevel)).toBeLessThanOrEqual(depth("low"));
	});

	it("is configurable, and a manual pick is not capped", async () => {
		const raised = routerWith(0.95, "modes:\n  low:\n    max_thinking: medium\n");
		const decision = await raised.router.route({ signals: signals(), role: "code", toolsActive: false, mode: "low" });
		expect(depth(decision.thinkingLevel)).toBeLessThanOrEqual(depth("medium"));

		const { router } = routerWith(0.95);
		const pinned = await router.route({
			signals: signals(),
			role: "code",
			toolsActive: false,
			mode: "low",
			pinnedThinking: "high",
		});
		expect(pinned.thinkingLevel).toBe("high");
		expect(depth(pinned.routerThinkingLevel)).toBeLessThanOrEqual(depth("low"));
	});

	it("bounds the default model's level on a classifier fallback", async () => {
		const router = new ModelRouter({
			catalog: testCatalog(),
			getModels: () => TEST_MODELS,
			defaultModelId: () => "cheap",
			defaultThinkingLevel: () => "high",
		});
		const decision = await router.route({ signals: signals(), role: "code", toolsActive: false, mode: "low" });
		expect(decision.source).toBe("default-fallback");
		expect(decision.thinkingLevel).toBe("low");
	});
});

describe("mode policy keys in router.yaml", () => {
	const parse = (extra: string) =>
		parseRouterCatalog([
			{ text: TEST_ROUTER_YAML, path: "test-router.yaml" },
			{ text: extra, path: "user-router.yaml" },
		]);

	it("ships low max_thinking low, high min_thinking low and trivial_below 0.2 by default", () => {
		const catalog = testCatalog();
		expect(catalog.modes.low.maxThinking).toBe("low");
		expect(catalog.modes.high.minThinking).toBe("low");
		expect(catalog.modes.high.trivialBelow).toBe(0.2);
		expect(catalog.modes.medium.minThinking).toBeUndefined();
		expect(catalog.modes.medium.maxThinking).toBeUndefined();
	});

	it("accepts camelCase, 'none' for off, and null to clear a bound", () => {
		const catalog = parse("modes:\n  low:\n    maxThinking: none\n  high:\n    min_thinking: null\n");
		expect(catalog.modes.low.maxThinking).toBe("off");
		expect(catalog.modes.high.minThinking).toBeUndefined();
	});

	it("rejects unknown levels, inverted bounds and out-of-range trivial bounds", () => {
		expect(() => parse("modes:\n  low:\n    max_thinking: turbo\n")).toThrow(/unknown thinking level/);
		expect(() => parse("modes:\n  medium:\n    min_thinking: high\n    max_thinking: low\n")).toThrow(
			/above max_thinking/,
		);
		expect(() => parse("modes:\n  high:\n    trivial_below: 2\n")).toThrow(/trivial_below/);
	});

	it("has no dead thinking.max_auto under low: max_thinking is the one cap (bundled file and defaults)", () => {
		const bundled = loadRouterCatalog({
			bundledPath: join(dirname(fileURLToPath(import.meta.url)), "../../../../router.yaml"),
			agentDir: join(tmpdir(), "runkiln-no-such-dir"),
		});
		for (const catalog of [bundled, testCatalog()]) {
			expect(catalog.modes.low.thinking.maxAuto).toBeUndefined();
			expect(catalog.modes.low.maxThinking).toBe("low");
			// Resolved: max_auto comes down to the cap, so the beyond-cap search has nothing to add either.
			expect(resolveModeConfig(catalog, "low").thinking).toMatchObject({ maxAuto: "low", ceiling: "low" });
		}
	});

	it("rejects a mode entry whose max_auto sits above its own max_thinking (it would never apply)", () => {
		expect(() => parse("modes:\n  low:\n    thinking: { max_auto: high }\n    max_thinking: low\n")).toThrow(
			/max_auto: high is above max_thinking \(low\) and would never apply/,
		);
		// At or below the cap is fine, and so is max_auto alone (an older user file): the cap still holds.
		expect(
			parse("modes:\n  low:\n    thinking: { max_auto: low }\n    max_thinking: low\n").modes.low.thinking.maxAuto,
		).toBe("low");
		const legacy = parse("modes:\n  low:\n    thinking: { max_auto: high }\n");
		expect(legacy.modes.low.thinking.maxAuto).toBe("high");
		expect(resolveModeConfig(legacy, "low").thinking.maxAuto).toBe("low");
		// Raising max_thinking in the same entry makes max_auto live again.
		const raised = parse("modes:\n  low:\n    thinking: { max_auto: high }\n    max_thinking: high\n");
		expect(resolveModeConfig(raised, "low").thinking.maxAuto).toBe("high");
	});

	it("clamps a level into the band on the model's supported levels", () => {
		const glm = ["low", "high", "max"] as const;
		expect(clampToBand("off", glm, "low")).toBe("low");
		expect(clampToBand("max", glm, undefined, "low")).toBe("low");
		const deepseek = ["off", "low", "high", "xhigh", "max"] as const;
		expect(clampToBand("medium", deepseek, undefined, "low")).toBe("low");
		expect(clampToBand("minimal", deepseek, "low", "low")).toBe("low");
		// No supported level inside the band: the band cannot hold.
		expect(clampToBand("off", ["high"], undefined, "low")).toBe("high");
	});
});

describe("mode-cycle keybinding", () => {
	it("binds app.router.cycleMode to alt+r by default (alt+m is the permission-mode cycle)", () => {
		expect(KEYBINDINGS["app.router.cycleMode"].defaultKeys).toBe("alt+r");
		expect(new KeybindingsManager().getKeys("app.router.cycleMode")).toEqual(["alt+r"]);
		expect(matchesKey("\x1br", "alt+r")).toBe(true);
		expect(KEYBINDINGS["app.permissions.cycle"].defaultKeys).toBe("alt+m");
	});

	it("does not clash with any other default binding", () => {
		const clashes = Object.entries(KEYBINDINGS)
			.filter(([id]) => id !== "app.router.cycleMode")
			.filter(([, definition]) => {
				const keys: readonly string[] = Array.isArray(definition.defaultKeys)
					? definition.defaultKeys
					: [definition.defaultKeys];
				return keys.includes("alt+r");
			})
			.map(([id]) => id);
		expect(clashes).toEqual([]);
		expect(KEYBINDINGS["app.thinking.cycle"].defaultKeys).toBe("shift+tab");
	});

	it("is rebindable like the other keybindings", () => {
		const manager = new KeybindingsManager({ "app.router.cycleMode": "ctrl+alt+o" });
		expect(manager.getKeys("app.router.cycleMode")).toEqual(["ctrl+alt+o"]);
		expect(manager.matches("\x1br", "app.router.cycleMode")).toBe(false);
		const disabled = new KeybindingsManager({ "app.router.cycleMode": [] });
		expect(disabled.getKeys("app.router.cycleMode")).toEqual([]);
	});

	it("is reserved against extension shortcuts", () => {
		expect(RESERVED_KEYBINDINGS_FOR_EXTENSION_CONFLICTS).toContain("app.router.cycleMode");
	});

	it("names the key in the /router report", () => {
		const status = { enabled: true, mode: "low" as const, catalogSources: [] };
		expect(formatRouterReport({ ...status, modeCycleKey: "alt+r" }, undefined)).toContain("alt+r cycles them");
		expect(formatRouterReport(status, undefined)).not.toContain("cycles them");
	});
});

describe("startup onboarding line", () => {
	it("is RunKiln's own, names the mode-cycle key, and no longer mentions Pi", () => {
		const line = runkilnOnboardingLine("alt+r");
		expect(line).toContain("RunKiln");
		expect(line).toContain("alt+r cycles auto:low/medium/high");
		expect(line).not.toMatch(/\bPi\b/);
		expect(runkilnOnboardingLine("")).toContain("/router low|medium|high");
	});
});
