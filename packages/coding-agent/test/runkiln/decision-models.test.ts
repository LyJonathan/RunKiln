import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	BUILTIN_DECISION_MODELS,
	DECISION_MODELS_CACHE_TTL_MS,
	decisionModelHint,
	getCachedDecisionModels,
	getDecisionModels,
	getDecisionModelsCachePath,
	isDecisionModel,
	OPENROUTER_DEFAULT_DECISION_MODEL,
	parseDecisionModels,
	sortDecisionModels,
} from "../../src/core/router/decision-models.ts";
import { DecisionModelPicker } from "../../src/modes/interactive/components/decision-model-picker.ts";

/** Trimmed from a real GET /api/v1/models?output_modalities=decisions answer (2026-10-16). */
const LIVE = {
	data: [
		{
			id: "respan/span-02",
			canonical_slug: "respan/span-02-20261015",
			name: "Respan: Span-02",
			created: 1792108973,
			context_length: 131072,
			architecture: { modality: "text+image->decisions", output_modalities: ["decisions"] },
			pricing: { prompt: "0.00000001", completion: "0" },
		},
		{
			id: "typesafe/jev-1.14",
			canonical_slug: "typesafe/jev-1.14-20261014",
			name: "TypeSafe: Jev 1.14",
			created: 1792021417,
			context_length: 262144,
			architecture: { output_modalities: ["decisions"] },
			pricing: { prompt: "0.000000042", completion: "0" },
		},
		{
			id: "~perplexity/pplx-decider-latest",
			canonical_slug: "~perplexity/pplx-decider-latest",
			alias_target: { name: "Perplexity: Decider V1.2", slug: "perplexity/pplx-decider-v1.2" },
			context_length: 262144,
			architecture: { output_modalities: ["decisions"] },
			pricing: { prompt: "0.00000002", completion: "0" },
		},
		{
			id: "liquid/d1-ultra",
			canonical_slug: "liquid/d1-ultra-20261015",
			context_length: 32768,
			architecture: { output_modalities: ["decisions"] },
			pricing: { prompt: "0.000000042", completion: "0" },
		},
		// A chat model a server might return if it ignored the filter: dropped.
		{
			id: "google/gemini-2.5-flash-lite",
			architecture: { output_modalities: ["text"] },
			pricing: { prompt: "0.0000001", completion: "0.0000004" },
		},
		{ id: "../../etc/passwd", architecture: { output_modalities: ["decisions"] } },
	],
};

const dirs: string[] = [];
function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "rk-decisions-"));
	dirs.push(dir);
	return dir;
}
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fetchJson(body: unknown, status = 200) {
	return vi.fn(
		async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify(body), { status }),
	);
}

describe("decision model list", () => {
	it("keeps only decision models, with price per million input tokens", () => {
		const entries = parseDecisionModels(LIVE);
		expect(entries.map((entry) => entry.id)).toEqual([
			"respan/span-02",
			"typesafe/jev-1.14",
			"~perplexity/pplx-decider-latest",
			"liquid/d1-ultra",
		]);
		expect(entries[1]).toMatchObject({
			canonicalSlug: "typesafe/jev-1.14-20261014",
			pricePerMTokIn: 0.042,
			contextLength: 262144,
		});
		expect(entries[2]?.aliasOf).toBe("perplexity/pplx-decider-v1.2");
		expect(() => parseDecisionModels({})).toThrow(/no data/);
	});

	it("orders the default first, then benched models in bench order, then by price, aliases last", () => {
		const extra = {
			id: "acme/new-decider",
			architecture: { output_modalities: ["decisions"] },
			pricing: { prompt: "0" },
		};
		const sorted = sortDecisionModels(parseDecisionModels({ data: [...LIVE.data, extra] })).map((entry) => entry.id);
		expect(sorted).toEqual([
			"typesafe/jev-1.14",
			"liquid/d1-ultra",
			"respan/span-02",
			"acme/new-decider",
			"~perplexity/pplx-decider-latest",
		]);
		expect(OPENROUTER_DEFAULT_DECISION_MODEL).toBe("typesafe/jev-1.14");
		expect(BUILTIN_DECISION_MODELS.map((entry) => entry.id)).toContain(OPENROUTER_DEFAULT_DECISION_MODEL);
	});

	it("hints price, context, alias and the recommendation", () => {
		const [jev, , span, alias] = sortDecisionModels(parseDecisionModels(LIVE));
		expect(decisionModelHint(jev!)).toBe("$0.042/M in - 256k ctx - recommended");
		expect(decisionModelHint(span!)).toBe("$0.01/M in - 128k ctx");
		expect(decisionModelHint(alias!)).toContain("alias of perplexity/pplx-decider-v1.2");
	});

	it("fetches live without a key, caches for 24 h, and falls back to the stale cache, then the built-in list", async () => {
		const agentDir = tempDir();
		const now = 1_800_000_000_000;
		const live = fetchJson(LIVE);
		const first = await getDecisionModels(agentDir, { fetch: live, now });
		expect(first.source).toBe("live");
		expect(live).toHaveBeenCalledTimes(1);
		const [url, init] = live.mock.calls[0]!;
		expect(url).toBe("https://openrouter.ai/api/v1/models?output_modalities=decisions");
		expect((init?.headers as Record<string, string>).Authorization).toBeUndefined();
		const cachePath = getDecisionModelsCachePath(agentDir);
		expect(existsSync(cachePath)).toBe(true);
		expect(readFileSync(cachePath, "utf8")).not.toContain("gemini");

		// Within 24 h: the cache, no request.
		const cached = await getDecisionModels(agentDir, { fetch: live, now: now + 60_000 });
		expect(cached.source).toBe("cache");
		expect(cached.entries.map((entry) => entry.id)).toEqual(first.entries.map((entry) => entry.id));
		expect(live).toHaveBeenCalledTimes(1);

		// After 24 h with the network down: the stale cache.
		const down = vi.fn(async () => {
			throw new Error("offline");
		});
		const stale = await getDecisionModels(agentDir, { fetch: down, now: now + DECISION_MODELS_CACHE_TTL_MS + 1 });
		expect(stale.source).toBe("stale-cache");
		expect(stale.entries).toHaveLength(4);

		// No cache and no network: the built-in list.
		const empty = await getDecisionModels(tempDir(), { fetch: down, now });
		expect(empty.source).toBe("builtin");
		expect(empty.entries[0]?.id).toBe(OPENROUTER_DEFAULT_DECISION_MODEL);
	});

	it("ignores a tampered cache entry", () => {
		const agentDir = tempDir();
		const path = getDecisionModelsCachePath(agentDir);
		const now = Date.now();
		mkdirSync(join(agentDir, "cache"));
		writeFileSync(
			path,
			JSON.stringify({
				schema: 1,
				fetchedAt: now,
				baseUrl: "https://openrouter.ai/api/v1",
				entries: [{ id: "typesafe/jev-1.14" }, { id: "rm -rf /" }],
			}),
		);
		const list = getCachedDecisionModels(agentDir, { now });
		expect(list.source).toBe("cache");
		expect(list.entries.map((entry) => entry.id)).toEqual(["typesafe/jev-1.14"]);
	});

	it("tells decision models from chat models", () => {
		const live = { source: "live" as const, entries: sortDecisionModels(parseDecisionModels(LIVE)) };
		expect(isDecisionModel("liquid/d1-ultra", live)).toBe(true);
		expect(isDecisionModel("liquid/d1-ultra-20261015", live)).toBe(true);
		expect(isDecisionModel("google/gemini-2.5-flash-lite", live)).toBe(false);
		expect(isDecisionModel("acme/unknown", live)).toBe(false);
		const builtin = { source: "builtin" as const, entries: [...BUILTIN_DECISION_MODELS] };
		expect(isDecisionModel("acme/unknown", builtin)).toBe(true);
		expect(isDecisionModel("google/gemini-2.5-flash-lite", builtin)).toBe(false);
	});
});

describe("decision model picker", () => {
	const many = {
		source: "live" as const,
		entries: Array.from({ length: 12 }, (_, i) => ({ id: `vendor/model-${String(i).padStart(2, "0")}` })),
	};
	const row = (selected: boolean, label: string) => `${selected ? ">" : " "} ${label.trim()}`;
	const more = (text: string) => `(${text})`;

	it("scrolls a window of eight and wraps with the arrows", () => {
		const picker = new DecisionModelPicker(many, "vendor/model-00");
		let lines = picker.render(row, more);
		expect(lines[0]).toBe("");
		expect(lines.filter((line) => line.startsWith(">"))).toEqual(["> vendor/model-00"]);
		expect(lines.at(-1)).toBe("(↓ 4 more)");
		picker.move(-1);
		lines = picker.render(row, more);
		expect(picker.selected?.id).toBe("vendor/model-11");
		expect(lines[0]).toBe("(↑ 4 more)");
		expect(lines.at(-1)).toBe("");
		picker.move(-8);
		expect(picker.selected?.id).toBe("vendor/model-03");
	});

	it("keeps the highlighted model when a fresher list arrives, else the default", () => {
		const picker = new DecisionModelPicker(
			{ source: "builtin", entries: [...BUILTIN_DECISION_MODELS] },
			"liquid/d1-ultra",
		);
		picker.replace({ source: "live", entries: sortDecisionModels(parseDecisionModels(LIVE)) });
		expect(picker.selected?.id).toBe("liquid/d1-ultra");
		expect(picker.sourceLine()).toBe("4 decision models, live from openrouter.ai");
		const other = new DecisionModelPicker({ source: "live", entries: [...BUILTIN_DECISION_MODELS] }, "google/x");
		expect(other.selected?.id).toBe(OPENROUTER_DEFAULT_DECISION_MODEL);
	});
});
