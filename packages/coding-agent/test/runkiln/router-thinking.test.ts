import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getSupportedThinkingLevels } from "@runkiln/ai";
import { resolveReasoningEffort } from "@runkiln/ai/api/openai-completions";
import { describe, expect, it } from "vitest";
import { DEFAULT_THINKING } from "../../src/core/router/catalog.ts";
import { harnessThinkingLevel } from "../../src/core/router/index.ts";
import { clampToSupported, desiredThinkingLevel } from "../../src/core/router/thinking.ts";
import {
	buildThinkingLevelMap,
	effortToThinkingLevel,
	parseModelsCatalog,
} from "../../src/core/runkiln/models-catalog.ts";

const modelsYaml = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../../../models.yaml"), "utf8");
const catalog = parseModelsCatalog(modelsYaml, "models.yaml");
const model = (id: string) => {
	const found = catalog.chatModels.find((candidate) => candidate.id === id);
	if (!found) throw new Error(`missing ${id}`);
	return found;
};

const config = { ...DEFAULT_THINKING, deepSkills: ["math.proof"], lightSkills: ["chat"] };

describe("router thinking level", () => {
	it("maps effective difficulty to a minimum level", () => {
		expect(desiredThinkingLevel(0.05, "code.bugfix", config)).toBe("off");
		expect(desiredThinkingLevel(0.3, "code.bugfix", config)).toBe("minimal");
		expect(desiredThinkingLevel(0.6, "code.bugfix", config)).toBe("low");
		expect(desiredThinkingLevel(0.85, "code.bugfix", config)).toBe("medium");
		expect(desiredThinkingLevel(1, "code.bugfix", config)).toBe("high");
	});

	it("thinks one level more for deep skills and one less for light ones", () => {
		expect(desiredThinkingLevel(0.6, "math.proof", config)).toBe("medium");
		expect(desiredThinkingLevel(0.6, "chat", config)).toBe("minimal");
		expect(desiredThinkingLevel(0.05, "chat", config)).toBe("off");
	});

	it("shifts with the routing mode and never goes above max_auto on its own", () => {
		expect(desiredThinkingLevel(0.6, "code.bugfix", { ...config, shift: 1 })).toBe("medium");
		expect(desiredThinkingLevel(0.6, "code.bugfix", { ...config, shift: -1 })).toBe("minimal");
		expect(desiredThinkingLevel(1, "math.proof", config)).toBe("xhigh");
		expect(desiredThinkingLevel(1, "math.proof", { ...config, shift: 1, maxAuto: "max" })).toBe("max");
		expect(desiredThinkingLevel(1, "math.proof", { ...config, maxAuto: "high" })).toBe("high");
	});

	it("clamps to the nearest supported level, upward first", () => {
		expect(clampToSupported("off", ["low", "high", "max"])).toBe("low");
		expect(clampToSupported("medium", ["low", "high", "max"])).toBe("high");
		expect(clampToSupported("max", ["off", "low"])).toBe("low");
		expect(clampToSupported("high", ["high"])).toBe("high");
		expect(clampToSupported("high", [])).toBe("off");
	});
});

describe("models.yaml thinking levels", () => {
	it("maps provider efforts to thinking levels and marks the rest unsupported", () => {
		expect(effortToThinkingLevel("none")).toBe("off");
		expect(effortToThinkingLevel("xhigh")).toBe("xhigh");
		expect(effortToThinkingLevel("bogus")).toBeUndefined();
		expect(buildThinkingLevelMap(["low", "high", "max"])).toEqual({
			off: null,
			minimal: null,
			low: "low",
			medium: null,
			high: "high",
			xhigh: null,
			max: "max",
		});
		// One level is no choice: the model keeps its fixed effort.
		expect(buildThinkingLevelMap(["none"])).toBeUndefined();
	});

	it("gives each RunInfra model the levels its API accepts", () => {
		expect(getSupportedThinkingLevels(model("glm-5-3-flash"))).toEqual(["low", "high", "max"]);
		expect(getSupportedThinkingLevels(model("deepseek-v4-1-flash-1017"))).toEqual([
			"off",
			"low",
			"high",
			"xhigh",
			"max",
		]);
		expect(getSupportedThinkingLevels(model("qwen3-8-27b"))).toEqual(["off", "low", "medium", "xhigh"]);
		// Ornith only takes "none": no selectable levels, fixed effort.
		expect(model("ornith-1-5-35b").reasoning).toBe(false);
		expect(getSupportedThinkingLevels(model("ornith-1-5-35b"))).toEqual(["off"]);
	});

	it("keeps the harness effort as each model's default level", () => {
		expect(harnessThinkingLevel(model("glm-5-3-flash"))).toBe("low");
		expect(harnessThinkingLevel(model("deepseek-v4-1-flash-1017"))).toBe("off");
	});

	it("sends the effort for the requested level, clamped, or the harness effort when none is requested", () => {
		const glm = model("glm-5-3-flash");
		expect(resolveReasoningEffort(glm, "high")).toBe("high");
		expect(resolveReasoningEffort(glm, "medium")).toBe("high");
		expect(resolveReasoningEffort(glm, "off")).toBe("low");
		expect(resolveReasoningEffort(glm, undefined)).toBe("low");
		expect(resolveReasoningEffort(model("deepseek-v4-1-flash-1017"), "off")).toBe("none");
		expect(resolveReasoningEffort(model("qwen3-8-27b"), "high")).toBe("xhigh");
		expect(resolveReasoningEffort(model("ornith-1-5-35b"), "high")).toBe("none");
	});
});
