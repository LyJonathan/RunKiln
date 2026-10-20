import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getSupportedThinkingLevels, type ModelThinkingLevel, type ThinkingLevelMap } from "@runkiln/ai";
import { describe, expect, it } from "vitest";
import {
	loadRouterCatalog,
	parseRouterCatalog,
	type RouterMode,
	resolveModeConfig,
} from "../../src/core/router/catalog.ts";
import { ModelRouter } from "../../src/core/router/router.ts";
import { autoLevels, type CandidateModel, type SelectInput, selectModel } from "../../src/core/router/select.ts";
import { parseModelsCatalog } from "../../src/core/runkiln/models-catalog.ts";
import {
	candidate,
	classification,
	MockClassifier,
	signals,
	TEST_ROUTER_YAML,
	testCatalog,
	testModel,
} from "./router-fixtures.ts";

// Per-model thinking policy in router.yaml: max_auto_thinking (deepseek-v4-1-flash-1017: high) and
// auto_off_below (deepseek-v4-1-flash-1017: 0.55).

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../../..");
const bundled = loadRouterCatalog({
	bundledPath: join(repoRoot, "router.yaml"),
	agentDir: join(tmpdir(), "runkiln-no-such-dir"),
});
const modelsCatalog = parseModelsCatalog(readFileSync(join(repoRoot, "models.yaml"), "utf8"), "models.yaml");

const DS = "deepseek-v4-1-flash-1017";
const GLM = "glm-5-3-flash";

/** Candidates for the real RunInfra models, from models.yaml (prices, levels) and the bundled router.yaml. */
function realCandidate(id: string, overrides: Partial<CandidateModel> = {}): CandidateModel {
	const model = modelsCatalog.chatModels.find((entry) => entry.id === id);
	if (!model) throw new Error(`missing ${id} in models.yaml`);
	const scores = bundled.models[id];
	return {
		id,
		priceIn: model.cost.input,
		priceOut: model.cost.output,
		priceCachedIn: model.cost.cacheRead,
		contextWindow: model.contextWindow,
		vision: false,
		intelligence: scores.intelligence,
		skills: scores.skills,
		supportedThinking: getSupportedThinkingLevels(model),
		maxAutoThinking: scores.maxAutoThinking,
		autoOffBelow: scores.autoOffBelow,
		...overrides,
	};
}

function input(skill: string, difficulty: number, overrides: Partial<SelectInput> = {}): SelectInput {
	return {
		skills: [{ skill, prob: 1 }],
		difficulty,
		confidence: 1,
		needsTools: false,
		needsVision: false,
		contextTokens: 20_000,
		outputTokens: 2048,
		...overrides,
	};
}

function pick(models: CandidateModel[], mode: RouterMode, request: SelectInput) {
	const { tuning, thinking } = resolveModeConfig(bundled, mode);
	const selection = selectModel(models, request, tuning, thinking);
	const byModel = (id: string) => selection.candidates.find((entry) => entry.model === id);
	return { selection, byModel, level: byModel(selection.modelId)?.thinkingLevel };
}

describe("router.yaml per-model thinking keys", () => {
	it("caps deepseek-v4-1-flash-1017 auto thinking at high and allows it off below 0.55; GLM has neither", () => {
		expect(bundled.models[DS].maxAutoThinking).toBe("high");
		expect(bundled.models[DS].autoOffBelow).toBe(0.55);
		expect(bundled.models[GLM].maxAutoThinking).toBeUndefined();
		expect(bundled.models[GLM].autoOffBelow).toBeUndefined();
	});

	it("reads, merges and clears the keys from a user file, and rejects bad values", () => {
		const user = testCatalog("models:\n  cheap:\n    max_auto_thinking: none\n    auto_off_below: 0.4\n");
		expect(user.models.cheap).toMatchObject({ maxAutoThinking: "off", autoOffBelow: 0.4 });
		// Scores are untouched by the thinking keys.
		expect(user.models.cheap.skills["code.bugfix"]).toBe(40);
		const cleared = parseRouterCatalog([
			{ text: TEST_ROUTER_YAML, path: "base.yaml" },
			{ text: "models:\n  cheap:\n    max_auto_thinking: high\n    auto_off_below: 0.5\n", path: "a.yaml" },
			{ text: "models:\n  cheap:\n    max_auto_thinking: null\n    auto_off_below: null\n", path: "b.yaml" },
		]);
		expect(cleared.models.cheap.maxAutoThinking).toBeUndefined();
		expect(cleared.models.cheap.autoOffBelow).toBeUndefined();
		expect(() => testCatalog("models:\n  cheap:\n    max_auto_thinking: ultra\n")).toThrow(
			/max_auto_thinking: unknown thinking level/,
		);
		expect(() => testCatalog("models:\n  cheap:\n    auto_off_below: 1.5\n")).toThrow(
			/auto_off_below: expected a difficulty/,
		);
	});
});

describe("max_auto_thinking", () => {
	it("limits the levels auto routing may use on a model, never below its lowest level", () => {
		const ds: ModelThinkingLevel[] = ["off", "low", "high", "xhigh", "max"];
		expect(autoLevels({ supportedThinking: ds, maxAutoThinking: "high" })).toEqual(["off", "low", "high"]);
		expect(autoLevels({ supportedThinking: ds })).toEqual(ds);
		// A cap below every supported level keeps the lowest one (glm-style low/high/max capped at off).
		expect(autoLevels({ supportedThinking: ["low", "high", "max"], maxAutoThinking: "off" })).toEqual(["low"]);
		expect(autoLevels({ supportedThinking: [] })).toEqual(["off"]);
	});

	it("holds in every mode: high mode (max_auto max, prefer highest) stops at high on deepseek", () => {
		const ds = [realCandidate(DS)];
		for (const mode of ["low", "medium", "high"] as const) {
			for (const difficulty of [0.2, 0.6, 0.9, 1]) {
				const { byModel } = pick(ds, mode, input("code.algo", difficulty));
				const levels = byModel(DS)?.pairs?.map((pair) => pair.level) ?? [];
				expect(levels).not.toContain("xhigh");
				expect(levels).not.toContain("max");
			}
		}
		expect(pick(ds, "high", input("code.algo", 0.9)).level).toBe("high");
		// Without the cap, high mode would take deepseek to max.
		expect(pick([realCandidate(DS, { maxAutoThinking: undefined })], "high", input("code.algo", 0.9)).level).toBe(
			"max",
		);
	});

	it("also stops the beyond-max_auto search (medium mode): a short deepseek escalates instead of going to xhigh/max", () => {
		// d 1, code.algo: bar 95 in medium mode, floor xhigh (deep skill). ds 76 + high 10 = 86 falls short;
		// xhigh/max are not tried.
		const { byModel, selection } = pick([realCandidate(DS)], "medium", input("code.algo", 1));
		expect(byModel(DS)?.thinkingLevel).toBe("high");
		expect(byModel(DS)?.pairs?.map((pair) => pair.level)).toEqual(["high"]);
		expect(selection.escalated).toBe(true);
		const uncapped = pick([realCandidate(DS, { maxAutoThinking: undefined })], "medium", input("code.algo", 1));
		expect(uncapped.byModel(DS)?.pairs?.map((pair) => pair.level)).toEqual(["xhigh", "max"]);
	});

	it("does not change GLM: it still reaches max on hard work", () => {
		expect(pick([realCandidate(GLM)], "high", input("code.algo", 0.9)).level).toBe("max");
		expect(pick([realCandidate(GLM)], "medium", input("code.bugfix", 0.9)).level).toBe("max");
	});
});

describe("auto_off_below", () => {
	it("lets deepseek run with thinking off through the medium band, deep skills included", () => {
		const ds = [realCandidate(DS)];
		// d 0.3-0.55: the floor is minimal (low for deep skills), which deepseek used to round up to low.
		for (const skill of ["code.bugfix", "code.algo", "math", "chat"]) {
			for (const difficulty of [0.1, 0.3, 0.4, 0.5]) {
				const { byModel } = pick(ds, "medium", input(skill, difficulty));
				expect(byModel(DS)?.pairs?.[0]?.level, `${skill} at ${difficulty}`).toBe("off");
			}
		}
		expect(pick(ds, "medium", input("code.algo", 0.4)).level).toBe("off");
		expect(pick(ds, "medium", input("math", 0.5)).level).toBe("off");
		// Without the key the old floor applies: low on a deep skill even at d 0.1.
		const old = pick([realCandidate(DS, { autoOffBelow: undefined })], "medium", input("code.algo", 0.1));
		expect(old.byModel(DS)?.pairs?.[0]?.level).toBe("low");
	});

	it("keeps forced thinking on hard work (from 0.55)", () => {
		const ds = [realCandidate(DS)];
		for (const difficulty of [0.55, 0.6, 0.8, 0.95]) {
			const levels = pick(ds, "medium", input("code.bugfix", difficulty))
				.byModel(DS)
				?.pairs?.map((pair) => pair.level);
			expect(levels, `d ${difficulty}`).not.toContain("off");
		}
		expect(pick(ds, "medium", input("math", 0.6)).level).toBe("high");
	});

	it("counts the low-confidence boost (effective difficulty)", () => {
		// 0.45 + (1 - 0.2) * 0.15 = 0.57: not relaxed.
		const { byModel } = pick([realCandidate(DS)], "medium", input("code.bugfix", 0.45, { confidence: 0.2 }));
		expect(byModel(DS)?.pairs?.map((pair) => pair.level)).not.toContain("off");
	});

	it("leaves GLM exactly as before: it has no off level and minimal maps to low", () => {
		const glm = realCandidate(GLM);
		for (const mode of ["low", "medium", "high"] as const) {
			for (const skill of ["code.bugfix", "code.algo", "chat"]) {
				for (const difficulty of [0.1, 0.3, 0.5, 0.7, 0.9]) {
					const request = input(skill, difficulty);
					const relaxed = pick([{ ...glm, autoOffBelow: 0.55 }], mode, request).byModel(GLM);
					const plain = pick([glm], mode, request).byModel(GLM);
					expect(relaxed).toEqual(plain);
					expect(plain?.pairs?.map((pair) => pair.level)).not.toContain("off");
				}
			}
		}
	});

	it("changes routing between the two models only by deepseek's own pairs", () => {
		const models = [realCandidate(GLM), realCandidate(DS)];
		// Chat at d 0.4: deepseek at off, as before (chat is a light skill).
		const chat = pick(models, "medium", input("chat", 0.4));
		expect(chat.selection.modelId).toBe(DS);
		expect(chat.level).toBe("off");
		// code.bugfix stays on glm:low (deepseek is 2 points below it on code.* other than algo).
		const bugfix = pick(models, "medium", input("code.bugfix", 0.4, { needsTools: true }));
		expect(bugfix.selection.modelId).toBe(GLM);
		expect(bugfix.level).toBe("low");
	});
});

describe("ModelRouter with per-model thinking keys", () => {
	const FULL_MAP: ThinkingLevelMap = {
		off: "none",
		minimal: null,
		low: "low",
		medium: "medium",
		high: "high",
		xhigh: "xhigh",
		max: "max",
	};

	it("never sends an auto level above max_auto_thinking, but a pinned level is not capped", async () => {
		const catalog = testCatalog("models:\n  strong:\n    max_auto_thinking: low\n");
		const router = new ModelRouter({
			catalog,
			classifier: new MockClassifier(() =>
				classification({ difficulty: 0.8, skills: [{ skill: "reason.deep", prob: 0.9 }] }),
			),
			getModels: () => [testModel("strong", { thinkingLevelMap: FULL_MAP })],
			defaultModelId: () => "strong",
			defaultThinkingLevel: () => "low",
		});
		const request = (pinnedThinking?: ModelThinkingLevel) => ({
			signals: signals(),
			role: "code" as const,
			toolsActive: true,
			pinnedThinking,
		});
		const auto = await router.route(request());
		expect(auto.model.id).toBe("strong");
		// d 0.8 + deep skill wants high or more; the per-model cap holds it at low (escalated: short of the bar).
		expect(auto.routerThinkingLevel).toBe("low");
		expect(auto.thinkingLevel).toBe("low");
		router.reset();
		const pinned = await router.route(request("max"));
		expect(pinned.thinkingPinned).toBe(true);
		expect(pinned.thinkingLevel).toBe("max");
		expect(pinned.routerThinkingLevel).toBe("low");
	});

	it("passes the router.yaml keys through to selection candidates", () => {
		const router = new ModelRouter({
			catalog: testCatalog("models:\n  cheap:\n    max_auto_thinking: medium\n    auto_off_below: 0.6\n"),
			getModels: () => [testModel("cheap"), testModel("strong")],
			defaultModelId: () => "cheap",
		});
		const cheap = router.candidateModels().find((entry) => entry.model.id === "cheap")?.candidate;
		expect(cheap).toMatchObject({ maxAutoThinking: "medium", autoOffBelow: 0.6 });
		const strong = router.candidateModels().find((entry) => entry.model.id === "strong")?.candidate;
		expect(strong?.maxAutoThinking).toBeUndefined();
	});
});

describe("auto_off_below on synthetic models", () => {
	it("only relaxes models that support off", () => {
		const catalog = testCatalog();
		const noOff = candidate("cheap", { supportedThinking: ["low", "high"], autoOffBelow: 0.9 });
		const withOff = candidate("cheap", { supportedThinking: ["off", "low", "high"], autoOffBelow: 0.9 });
		const request = input("reason.deep", 0.4, { contextTokens: 5000, outputTokens: 1000 });
		const levels = (model: CandidateModel) =>
			selectModel([model], request, catalog.tuning, catalog.thinking).candidates[0].pairs?.map((pair) => pair.level);
		expect(levels(noOff)?.[0]).toBe("low");
		expect(levels(withOff)?.[0]).toBe("off");
	});
});
