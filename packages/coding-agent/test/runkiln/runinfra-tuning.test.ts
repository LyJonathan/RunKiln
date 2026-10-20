/**
 * RunInfra tuning: catalog limits on the model, cost-optimal compaction trigger, compaction on the
 * session's warm prefix, the warm-prefix clock, and the token diet of the default prompt.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentMessage } from "@runkiln/agent-core";
import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	type Model,
	normalizeContext,
	type SimpleStreamOptions,
	type TranscriptContext,
} from "@runkiln/ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	AUTO_COMPACTION_MIN_TOKENS,
	type CompactionPreparation,
	compactionTriggerTokens,
	compactOnSessionPrefix,
	DEFAULT_COMPACTION_SETTINGS,
	SESSION_PREFIX_SUMMARY_INSTRUCTION,
	shouldCompact,
} from "../../src/core/compaction/index.ts";
import { recordLastTurnRequest, sessionIdleTtlMs, warmTurnRequest } from "../../src/core/runkiln/last-request.ts";
import {
	getLiveCatalogCachePath,
	loadLiveCatalogCache,
	mergeLiveCatalog,
	parseLiveModels,
	saveLiveCatalogCache,
} from "../../src/core/runkiln/live-catalog.ts";
import { buildSystemPrompt } from "../../src/core/system-prompt.ts";
import { createAllToolDefinitions } from "../../src/core/tools/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(join(here, "fixtures", "runinfra-models-2026-10-16.json"), "utf8"));

function chatModel(id: string, overrides: Partial<Model<"openai-completions">> = {}): Model<"openai-completions"> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider: "runinfra",
		baseUrl: "https://api.runinfra.ai/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0.11, output: 0.45, cacheRead: 0.03, cacheWrite: 0 },
		contextWindow: 1048576,
		maxTokens: 16384,
		...overrides,
	} as Model<"openai-completions">;
}

describe("live catalog limits", () => {
	it("parses request size, session idle TTL, response ceiling and rate limits", () => {
		const glm = parseLiveModels(fixture).find((entry) => entry.id === "glm-5-3-flash");
		expect(glm).toMatchObject({
			maxRequestBytes: 3670016,
			sessionIdleTtlSeconds: 900,
			responseTimeCeilingSeconds: 740,
			maxConcurrentRequests: 192,
			maxTokensPerMinute: 28000000,
		});
	});

	it("puts them on the merged model without raising the default output cap", () => {
		const { models } = mergeLiveCatalog([chatModel("glm-5-3-flash")], parseLiveModels(fixture), "https://x/v1");
		const glm = models.find((model) => model.id === "glm-5-3-flash");
		expect(glm?.maxTokens).toBe(16384);
		expect(glm?.serviceLimits).toEqual({
			maxOutputTokens: 1048576,
			responseTimeLimitMs: 740_000,
			maxConcurrentRequests: 192,
			maxTokensPerMinute: 28000000,
			sessionIdleTtlMs: 900_000,
		});
		expect(glm?.inputLimits?.maxRequestBytes).toBe(3670016);
		expect(glm?.promptCache?.short).toBe(900);
		expect(sessionIdleTtlMs(glm!)).toBe(900_000);
	});

	it("keeps the limits through the on-disk cache", () => {
		const dir = mkdtempSync(join(tmpdir(), "rk-catalog-"));
		try {
			const path = getLiveCatalogCachePath(dir);
			saveLiveCatalogCache(path, "https://x/v1", parseLiveModels(fixture));
			const entry = loadLiveCatalogCache(path, "https://x/v1")?.entries.find((e) => e.id === "deepseek-v4-1-flash");
			expect(entry).toMatchObject({
				maxRequestBytes: 3670016,
				sessionIdleTtlSeconds: 900,
				maxConcurrentRequests: 72,
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("compaction trigger", () => {
	const settings = { ...DEFAULT_COMPACTION_SETTINGS };
	it("auto: compacts a 1M-window RunInfra model at the cost-optimal point, not near the limit", () => {
		const glm = chatModel("glm-5-3-flash");
		const trigger = compactionTriggerTokens(glm.contextWindow, settings, glm);
		expect(trigger).toBe(AUTO_COMPACTION_MIN_TOKENS);
		expect(shouldCompact(AUTO_COMPACTION_MIN_TOKENS + 1, glm.contextWindow, settings, glm)).toBe(true);
		expect(shouldCompact(150_000, glm.contextWindow, settings, glm)).toBe(false);
	});

	it("never goes past the window minus the reserve, and a number pins it", () => {
		const small = chatModel("qwen", { contextWindow: 131072 });
		expect(compactionTriggerTokens(small.contextWindow, settings, small)).toBe(131072 - settings.reserveTokens);
		const glm = chatModel("glm-5-3-flash");
		expect(compactionTriggerTokens(glm.contextWindow, { ...settings, triggerTokens: 500_000 }, glm)).toBe(500_000);
	});

	it("without a model or prices keeps the old near-the-limit rule", () => {
		expect(shouldCompact(1_000_000, 1048576, settings)).toBe(false);
		expect(shouldCompact(1048576 - settings.reserveTokens + 1, 1048576, settings)).toBe(true);
		const free = chatModel("faux", { cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
		expect(compactionTriggerTokens(1048576, settings, free)).toBe(1048576 - settings.reserveTokens);
	});

	it("simulated long session: the auto trigger cuts the input bill", () => {
		// 3k new tokens per request, 400 requests, 95% cached; compaction keeps ~26k tokens.
		const glm = chatModel("glm-5-3-flash");
		const simulate = (trigger: number) => {
			let context = 2048;
			let cost = 0;
			for (let i = 0; i < 400; i++) {
				context += 3000;
				const cached = context * 0.95;
				cost += (cached * glm.cost.cacheRead + (context - cached) * glm.cost.input) / 1e6;
				if (context > trigger) {
					// Summary on the warm prefix (cached input + 4k output), then a cold short prefix.
					cost += (context * glm.cost.cacheRead + 4096 * glm.cost.output) / 1e6;
					context = settings.keepRecentTokens + 4096 + 2048;
					cost += (context * glm.cost.input) / 1e6;
				}
			}
			return cost;
		};
		const nearLimit = simulate(1048576 - settings.reserveTokens);
		const auto = simulate(compactionTriggerTokens(glm.contextWindow, settings, glm));
		expect(auto).toBeLessThan(nearLimit * 0.5);
	});
});

describe("compaction on the session prefix", () => {
	function fakeStream(capture: { context?: TranscriptContext; options?: SimpleStreamOptions }) {
		return (model: Model<any>, context: TranscriptContext, options?: SimpleStreamOptions) => {
			capture.context = context;
			capture.options = options;
			const stream = createAssistantMessageEventStream();
			const message: AssistantMessage = {
				role: "assistant",
				content: [{ type: "text", text: "## Goal\nFix the cart." }],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: {
					input: 10,
					output: 5,
					cacheRead: 9000,
					cacheWrite: 0,
					totalTokens: 9015,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			};
			queueMicrotask(() => {
				stream.push({ type: "start", partial: message });
				stream.push({ type: "done", reason: "stop", message });
				stream.end();
			});
			return stream;
		};
	}

	it("sends the session's exact last request plus one instruction, with tools off and the session id", async () => {
		const session = normalizeContext({
			systemPrompt: "You are an expert coding assistant in RunKiln.",
			tools: [{ name: "read", description: "Read files", parameters: { type: "object", properties: {} } as never }],
			messages: [
				{ role: "user", content: "fix the cart", timestamp: 1 },
				{ role: "user", content: "and run the tests", timestamp: 2 },
			],
		});
		const preparation = {
			firstKeptEntryId: "entry-7",
			messagesToSummarize: [] as AgentMessage[],
			turnPrefixMessages: [],
			isSplitTurn: false,
			tokensBefore: 210_000,
			fileOps: { read: new Set(["src/cart.js"]), written: new Set<string>(), edited: new Set(["src/cart.js"]) },
			settings: DEFAULT_COMPACTION_SETTINGS,
		} as unknown as CompactionPreparation;
		const capture: { context?: TranscriptContext; options?: SimpleStreamOptions } = {};
		const result = await compactOnSessionPrefix(
			preparation,
			session,
			chatModel("glm-5-3-flash"),
			"key",
			undefined,
			undefined,
			undefined,
			undefined,
			fakeStream(capture),
			undefined,
			undefined,
			undefined,
			"session-123",
		);
		const sent = capture.context!.messages;
		// Byte-identical prefix: the session's messages first, untouched.
		expect(JSON.stringify(sent.slice(0, session.messages.length))).toBe(JSON.stringify(session.messages));
		const last = sent.at(-1) as { role: string; content: Array<{ text: string }> };
		expect(last.role).toBe("user");
		expect(last.content[0].text).toBe(SESSION_PREFIX_SUMMARY_INSTRUCTION);
		expect(capture.options?.toolChoice).toBe("none");
		expect(capture.options?.sessionId).toBe("session-123");
		expect(result.firstKeptEntryId).toBe("entry-7");
		expect(result.summary).toContain("## Goal");
		expect(result.summary).toContain("src/cart.js");
	});

	it("treats the prefix as warm only for the same model within the idle TTL", () => {
		const owner = {};
		const glm = chatModel("glm-5-3-flash", { serviceLimits: { sessionIdleTtlMs: 900_000 } });
		const context = normalizeContext({ messages: [] });
		recordLastTurnRequest(owner, { model: glm, context, at: 1_000_000 });
		expect(warmTurnRequest(owner, glm, 1_000_000 + 60_000)).toBeDefined();
		expect(warmTurnRequest(owner, glm, 1_000_000 + 900_000)).toBeUndefined();
		expect(warmTurnRequest(owner, chatModel("deepseek-v4-1-flash"), 1_000_000 + 1000)).toBeUndefined();
		expect(warmTurnRequest({}, glm, 1_000_000)).toBeUndefined();
	});
});

describe("token diet", () => {
	it("keeps the default system prompt and tool declarations small", () => {
		const tools = createAllToolDefinitions(process.cwd());
		const selected = ["read", "bash", "edit", "write"];
		const snippets = Object.fromEntries(
			selected.map((name) => [name, tools[name as keyof typeof tools].promptSnippet!]),
		);
		const guidelines = Object.fromEntries(
			selected.map((name) => [name, [...(tools[name as keyof typeof tools].promptGuidelines ?? [])]]),
		);
		const prompt = buildSystemPrompt({
			cwd: "/tmp/p",
			selectedTools: selected,
			toolSnippets: snippets,
			toolGuidelines: guidelines,
		});
		const declarations = JSON.stringify(
			selected.map((name) => {
				const tool = tools[name as keyof typeof tools];
				return { name, description: tool.description, parameters: tool.parameters };
			}),
		);
		// Before: 1236 + 2868 characters (8d9082f). Edits rules still present. 700 leaves room for the untrusted-content
		// rule (prompt-injection defence, about 90 characters).
		expect(prompt.length).toBeLessThan(700);
		expect(declarations.length).toBeLessThan(2000);
		expect(prompt).toContain("edits[]");
		expect(tools.edit.description).toContain("unique");
		expect(prompt).not.toContain("RUNKILN_*");
	});
});
