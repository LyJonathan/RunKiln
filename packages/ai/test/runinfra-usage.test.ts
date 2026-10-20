import { describe, expect, it } from "vitest";
import { applyServerCost, parseOpenAICompletionsUsage, serverBilledCost } from "../src/api/openai-completions.ts";
import type { Model } from "../src/types.ts";
import { AssistantMessageEventStream } from "../src/utils/event-stream.ts";

/** Prices from models.yaml, in USD per million tokens. */
function runInfraModel(id: string, input: number, cacheRead: number, output: number): Model<"openai-completions"> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider: "runinfra",
		baseUrl: "https://api.runinfra.ai/v1",
		reasoning: true,
		input: ["text"],
		cost: { input, output, cacheRead, cacheWrite: 0 },
		contextWindow: 1048576,
		maxTokens: 32768,
	} as Model<"openai-completions">;
}

const glm = runInfraModel("glm-5-3-flash", 0.11, 0.03, 0.45);
const deepseek = runInfraModel("deepseek-v4-1-flash", 0.14, 0.03, 0.58);

describe("RunInfra usage", () => {
	it("splits cached prompt tokens out of input and prices them at the cached rate (glm, live shape)", () => {
		// Recorded from api.runinfra.ai on 2026-10-16: second identical request in one x-session-id.
		const usage = parseOpenAICompletionsUsage(
			{
				prompt_tokens: 2998,
				completion_tokens: 6,
				prompt_tokens_details: { cached_tokens: 2816, created_cache_tokens: 0, multimodal_tokens: null } as never,
				completion_tokens_details: { reasoning_tokens: 3 },
				runinfra: { cost_microcents: 10720, cached_input_tokens: 2816 },
			},
			glm,
		);
		expect(usage.input).toBe(182);
		expect(usage.cacheRead).toBe(2816);
		expect(usage.cacheWrite).toBe(0);
		expect(usage.output).toBe(6);
		expect(usage.reasoning).toBe(3);
		// RunInfra billed 10720 microcents = $0.0001072 for this request.
		expect(usage.cost.total).toBeCloseTo(0.0001072, 9);
		expect(usage.cost.cacheRead).toBeCloseTo((2816 * 0.03) / 1e6, 12);
	});

	it("keeps created_cache_tokens in input: cache writes cost the normal input price (deepseek, live shape)", () => {
		const usage = parseOpenAICompletionsUsage(
			{
				prompt_tokens: 3410,
				completion_tokens: 2,
				prompt_tokens_details: { cached_tokens: 0, created_cache_tokens: 3232 },
				runinfra: { cost_microcents: 47856, cached_input_tokens: 0 },
			},
			deepseek,
		);
		expect(usage.input).toBe(3410);
		expect(usage.cacheRead).toBe(0);
		expect(usage.cacheWrite).toBe(0);
		expect(usage.cost.total).toBeCloseTo(0.00047856, 9);
	});

	it("falls back to usage.runinfra.cached_input_tokens and never counts more cached than prompt tokens", () => {
		const fallback = parseOpenAICompletionsUsage(
			{ prompt_tokens: 1000, completion_tokens: 0, runinfra: { cached_input_tokens: 896 } },
			glm,
		);
		expect(fallback.cacheRead).toBe(896);
		expect(fallback.input).toBe(104);
		const clamped = parseOpenAICompletionsUsage(
			{ prompt_tokens: 100, completion_tokens: 0, prompt_tokens_details: { cached_tokens: 128 } },
			glm,
		);
		expect(clamped.cacheRead).toBe(100);
		expect(clamped.input).toBe(0);
	});

	it("prefers the billed usage.cost over the catalog estimate and scales the buckets to it", () => {
		const usage = parseOpenAICompletionsUsage(
			{
				prompt_tokens: 2998,
				completion_tokens: 6,
				prompt_tokens_details: { cached_tokens: 2816 },
				cost: 0.0002,
				runinfra: { cost_microcents: 10720, cached_input_tokens: 2816 },
			},
			glm,
		);
		expect(usage.costSource).toBe("server");
		expect(usage.cost.total).toBe(0.0002);
		const sum = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
		expect(sum).toBeCloseTo(0.0002, 12);
	});

	it("reads cost_microcents when usage.cost is absent and leaves usage without a billed cost alone", () => {
		expect(serverBilledCost({ runinfra: { cost_microcents: 47856 } })).toBeCloseTo(0.00047856, 12);
		expect(serverBilledCost({ cost: null, runinfra: null })).toBeUndefined();
		const plain = parseOpenAICompletionsUsage({ prompt_tokens: 1000, completion_tokens: 10 }, glm);
		expect(plain.costSource).toBeUndefined();
		const unpriced = {
			input: 10,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 10,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		applyServerCost(unpriced, 0.001);
		expect(unpriced.cost).toEqual({ input: 0.001, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 });
	});
});

describe("AssistantMessageEventStream timing", () => {
	it("stamps ttftMs at the first streamed token, next to durationMs", async () => {
		const stream = new AssistantMessageEventStream();
		const message = {
			role: "assistant",
			content: [],
			api: "openai-completions",
			provider: "runinfra",
			model: "glm-5-3-flash",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		} as never as import("../src/types.ts").AssistantMessage;
		await new Promise((resolve) => setTimeout(resolve, 15));
		stream.push({ type: "text_delta", contentIndex: 0, delta: "hi", partial: message } as never);
		stream.push({ type: "done", reason: "stop", message } as never);
		const done = await stream.result();
		expect(done.ttftMs).toBeGreaterThanOrEqual(10);
		expect(done.durationMs).toBeGreaterThanOrEqual(done.ttftMs ?? 0);
	});
});
