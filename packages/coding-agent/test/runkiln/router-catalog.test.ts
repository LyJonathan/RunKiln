import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadRouterCatalog, parseRouterCatalog, resolveModeConfig } from "../../src/core/router/catalog.ts";
import { parseModelsCatalog } from "../../src/core/runkiln/models-catalog.ts";
import { TEST_ROUTER_YAML, testCatalog } from "./router-fixtures.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../../..");
const bundledPath = join(repoRoot, "router.yaml");

describe("router.yaml", () => {
	it("ships a taxonomy and scores for the routable RunInfra models", () => {
		const catalog = loadRouterCatalog({ bundledPath, agentDir: join(tmpdir(), "runkiln-no-such-dir") });
		expect(catalog.skills.length).toBe(78);
		expect(catalog.skills.map((skill) => skill.name)).toEqual(
			expect.arrayContaining(["code.bugfix", "chat", "tool.call", "longctx"]),
		);
		// Skills no RunInfra model can serve were dropped.
		expect(catalog.skills.map((skill) => skill.name)).not.toContain("audio.tts");
		const models = parseModelsCatalog(readFileSync(join(repoRoot, "models.yaml"), "utf8"), "models.yaml");
		const ids = models.models.map((model) => model.id);
		for (const id of Object.keys(catalog.models)) expect(ids).toContain(id);
		expect(Object.keys(catalog.models).sort()).toEqual([
			"deepseek-v4-1-flash-1017",
			"glm-5-3-flash",
			"nemotron-3-5-lightning-30b",
			"ornith-1-5-35b",
			"qwen3-8-27b",
		]);
		expect(catalog.models["nemotron-3-5-lightning-30b"].route).toBe(false);
		expect(Object.keys(catalog.modes)).toEqual(["low", "medium", "high"]);
		expect(catalog.thinking.levels[0]).toEqual([0.3, "off"]);
		expect(catalog.thinking.qualityBonus.max).toBe(14);
	});

	it("merges a user file over the bundled one", () => {
		const dir = mkdtempSync(join(tmpdir(), "runkiln-router-"));
		try {
			mkdirSync(dir, { recursive: true });
			writeFileSync(
				join(dir, "router.yaml"),
				[
					"tuning:",
					"  stickiness: 0.5",
					"skills:",
					'  - { name: chat, desc: "Casual talk (user wording)" }',
					'  - { name: my.skill, desc: "A user skill" }',
					"models:",
					"  glm-5-3-flash:",
					"    skills: { my.skill: 77 }",
					"  ornith-1-5-35b:",
					"    route: false",
				].join("\n"),
			);
			const catalog = loadRouterCatalog({ bundledPath, agentDir: dir });
			expect(catalog.tuning.stickiness).toBe(0.5);
			expect(catalog.tuning.reqBase).toBe(20);
			expect(catalog.skills.find((skill) => skill.name === "chat")?.desc).toBe("Casual talk (user wording)");
			expect(catalog.skills.at(-1)).toEqual({ name: "my.skill", desc: "A user skill" });
			expect(catalog.models["glm-5-3-flash"].skills["my.skill"]).toBe(77);
			expect(catalog.models["glm-5-3-flash"].skills["code.bugfix"]).toBe(76);
			expect(catalog.models["ornith-1-5-35b"].route).toBe(false);
			expect(catalog.sources).toHaveLength(2);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("changes its version when the effective catalog changes", () => {
		expect(testCatalog().version).toBe(testCatalog().version);
		expect(testCatalog("tuning:\n  stickiness: 0.3\n").version).not.toBe(testCatalog().version);
	});

	it("rejects typos and bad values instead of ignoring them", () => {
		const parse = (extra: string) => () =>
			parseRouterCatalog([
				{ text: TEST_ROUTER_YAML, path: "base.yaml" },
				{ text: extra, path: "user.yaml" },
			]);
		expect(parse("tunning:\n  stickiness: 1\n")).toThrow(/unknown top-level key/);
		expect(parse("tuning:\n  stickyness: 1\n")).toThrow(/unknown key/);
		expect(parse("tuning:\n  stickiness: -1\n")).toThrow(/non-negative/);
		expect(parse("models:\n  cheap:\n    skills: { nope: 50 }\n")).toThrow(/unknown skill "nope"/);
		expect(parse("models:\n  cheap:\n    skills: { chat: 150 }\n")).toThrow(/0 to 100/);
		expect(parse("thinking:\n  levels: [[0.5, low], [0.2, high]]\n")).toThrow(/ascend/);
		expect(parse("thinking:\n  max_auto: ultra\n")).toThrow(/unknown thinking level/);
	});

	it("parses routing modes and resolves each one over the base tuning", () => {
		const catalog = testCatalog(
			"modes:\n  low:\n    tuning: { req_base: 10 }\n    thinking: { shift: -2, beyond_cap_when_short: false }\n",
		);
		const low = resolveModeConfig(catalog, "low");
		expect(low.tuning.reqBase).toBe(10);
		// Keys the user did not override keep the defaults for the mode.
		expect(low.tuning.costTiebreakFrac).toBe(0.05);
		expect(low.thinking.shift).toBe(-2);
		expect(low.thinking.beyondCapWhenShort).toBe(false);
		const medium = resolveModeConfig(catalog, "medium");
		expect(medium.tuning.reqBase).toBe(20);
		expect(medium.thinking.shift).toBe(0);
		const high = resolveModeConfig(catalog, "high");
		expect(high.thinking).toMatchObject({ shift: 1, maxAuto: "max", prefer: "highest" });
		expect(() => testCatalog("modes:\n  turbo: {}\n")).toThrow(/unknown mode/);
		expect(() => testCatalog("modes:\n  low:\n    thinking: { levels: [] }\n")).toThrow(/only shift/);
	});

	it("reads unknown_model defaults", () => {
		const catalog = testCatalog("unknown_model:\n  skill_score: 50\n  route: false\n");
		expect(catalog.unknownModel).toMatchObject({ skillScore: 50, priceScaling: 8, route: false });
		expect(() => testCatalog("unknown_model:\n  skil_score: 50\n")).toThrow(/unknown key/);
	});
});
