import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveCliModel } from "../../src/core/model-resolver.ts";
import { ModelRuntime } from "../../src/core/model-runtime.ts";
import { parseModelsCatalog } from "../../src/core/runkiln/models-catalog.ts";

const modelsYaml = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../../../models.yaml"), "utf8");

describe("models.yaml", () => {
	const catalog = parseModelsCatalog(modelsYaml, "models.yaml");

	it("loads the RunInfra roles and efforts", () => {
		expect(catalog.defaults).toEqual({
			code: "glm-5-3-flash",
			chat: "deepseek-v4-1-flash-1017",
			title: "ornith-1-5-35b",
			fallback: ["glm-5-3-flash", "deepseek-v4-1-flash-1017", "qwen3-8-27b", "ornith-1-5-35b"],
		});
		expect(catalog.models.find((model) => model.id === "glm-5-3-flash")?.reasoningEffort).toBe("low");
		expect(catalog.models.find((model) => model.id === "ornith-1-5-35b")?.reasoningEffort).toBe("none");
		expect(catalog.chatModels.every((model) => model.provider === "runinfra")).toBe(true);
		expect(catalog.chatModels.every((model) => model.baseUrl === "https://api.runinfra.ai/v1")).toBe(true);
	});

	it("rejects keys that could redirect traffic", () => {
		for (const key of [
			"url",
			"base_url",
			"baseUrl",
			"endpoint",
			"host",
			"headers",
			"api_key",
			"apiKey",
			"token",
			"secret",
		]) {
			const text = `provider: runinfra\nmodels:\n  - id: m\n    ${key}: https://evil.example\n`;
			expect(() => parseModelsCatalog(text, "models.yaml")).toThrow(/not allowed/);
		}
	});

	it("rejects a provider other than runinfra", () => {
		expect(() => parseModelsCatalog("provider: openai\nmodels:\n  - id: m\n", "models.yaml")).toThrow(
			/provider must be/,
		);
	});

	it("rejects a default that names an unknown model", () => {
		expect(() => parseModelsCatalog("defaults:\n  code: missing\nmodels:\n  - id: m\n", "models.yaml")).toThrow(
			/defaults.code/,
		);
	});

	it("rejects a duplicate id", () => {
		expect(() => parseModelsCatalog("models:\n  - id: m\n  - id: m\n", "models.yaml")).toThrow(/duplicate/);
	});

	it("keeps the old DeepSeek id as an alias of 1017, for defaults, settings, --model and sessions", async () => {
		expect(catalog.aliases).toEqual({ "deepseek-v4-1-flash": "deepseek-v4-1-flash-1017" });
		expect(catalog.models.some((model) => model.id === "deepseek-v4-1-flash")).toBe(false);
		const old = parseModelsCatalog(
			"defaults:\n  chat: old\n  fallback: [old, new]\nmodels:\n  - id: new\n    aliases: [old]\n",
			"models.yaml",
		);
		expect(old.defaults.chat).toBe("new");
		expect(old.defaults.fallback).toEqual(["new"]);
		const runtime = await ModelRuntime.create({
			catalog,
			runInfraConfig: { baseUrl: "https://api.runinfra.ai/v1", apiKey: "ri_test" },
			offline: true,
			catalogCachePath: false,
		});
		expect(runtime.getModelById("deepseek-v4-1-flash")?.id).toBe("deepseek-v4-1-flash-1017");
		const cli = resolveCliModel({ cliModel: "deepseek-v4-1-flash:off", modelRuntime: runtime });
		expect(cli.model?.id).toBe("deepseek-v4-1-flash-1017");
		expect(cli.thinkingLevel).toBe("off");
	});

	it("keeps glm-5-3 and ornith-1-5-122b manual only: no role, not in failover, still picked by --model", async () => {
		for (const id of ["glm-5-3", "ornith-1-5-122b"]) {
			expect(catalog.models.find((model) => model.id === id)?.roles).toEqual([]);
			expect(catalog.defaults.fallback).not.toContain(id);
		}
		expect(Object.values(catalog.defaults)).not.toContain("glm-5-3");
		expect(Object.values(catalog.defaults)).not.toContain("ornith-1-5-122b");
		expect(catalog.models.find((model) => model.id === "glm-5-3")?.reasoningEfforts).toEqual(["low", "high", "max"]);
		expect(catalog.models.find((model) => model.id === "ornith-1-5-122b")).toMatchObject({
			reasoningEffort: "none",
			thinkingField: "reasoning",
		});
		const runtime = await ModelRuntime.create({
			catalog,
			runInfraConfig: { baseUrl: "https://api.runinfra.ai/v1", apiKey: "ri_test" },
			offline: true,
			catalogCachePath: false,
		});
		const glm = resolveCliModel({ cliModel: "glm-5-3:max", modelRuntime: runtime });
		expect(glm.model?.id).toBe("glm-5-3");
		expect(glm.thinkingLevel).toBe("max");
		expect(resolveCliModel({ cliModel: "ornith-1-5-122b", modelRuntime: runtime }).model?.input).toEqual([
			"text",
			"image",
		]);
	});

	it("rejects an alias that is also a model or listed twice", () => {
		expect(() => parseModelsCatalog("models:\n  - id: a\n    aliases: [b]\n  - id: b\n", "models.yaml")).toThrow(
			/both a model and an alias/,
		);
		expect(() =>
			parseModelsCatalog("models:\n  - id: a\n    aliases: [c]\n  - id: b\n    aliases: [c]\n", "models.yaml"),
		).toThrow(/listed twice/);
	});
});
