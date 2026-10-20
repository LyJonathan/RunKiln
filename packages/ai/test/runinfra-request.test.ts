import { describe, expect, it } from "vitest";
import { buildOpenAICompletionsParams, streamSimple } from "../src/api/openai-completions.ts";
import {
	fitRunInfraRequestSize,
	parseRateLimitResetMs,
	RunInfraRequestGate,
	runInfraMaxTokens,
} from "../src/api/runinfra-request.ts";
import type { Model, TranscriptContext } from "../src/types.ts";
import { retryProviderRequest } from "../src/utils/provider-retry.ts";

function model(overrides: Partial<Model<"openai-completions">> = {}): Model<"openai-completions"> {
	return {
		id: "glm-5-3-flash",
		name: "GLM 5.3 Flash",
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

// Live catalog values for glm-5-3-flash (GET /v1/models, 2026-10-16).
const live = model({
	serviceLimits: { maxOutputTokens: 1048576, responseTimeLimitMs: 740_000, maxConcurrentRequests: 192 },
	inputLimits: { maxRequestBytes: 3670016 },
});

describe("runInfraMaxTokens", () => {
	it("keeps the model default for off/low and raises the cap for deep thinking", () => {
		expect(runInfraMaxTokens(live, "off")).toBe(16384);
		expect(runInfraMaxTokens(live, "low")).toBe(16384);
		expect(runInfraMaxTokens(live, "high")).toBe(32768);
		expect(runInfraMaxTokens(live, "xhigh")).toBe(65536);
		expect(runInfraMaxTokens(live, "max")).toBe(65536);
		expect(runInfraMaxTokens(live, undefined)).toBe(16384);
	});

	it("never exceeds the provider output cap or what fits in the response time ceiling", () => {
		expect(runInfraMaxTokens(model({ serviceLimits: { maxOutputTokens: 20000 } }), "max")).toBe(20000);
		// 100 s * 0.8 * 150 tok/s = 12000 < default: the default stays.
		expect(runInfraMaxTokens(model({ serviceLimits: { responseTimeLimitMs: 100_000 } }), "max")).toBe(16384);
		// 300 s * 0.8 * 150 = 36000.
		expect(runInfraMaxTokens(model({ serviceLimits: { responseTimeLimitMs: 300_000 } }), "max")).toBe(36000);
		// A model default above the table is kept.
		expect(runInfraMaxTokens(model({ maxTokens: 100000 }), "max")).toBe(100000);
	});

	it("streamSimple sends the raised cap for xhigh and the default for low", async () => {
		const context = { messages: [{ role: "user", content: "hi", timestamp: 0 }] } as unknown as TranscriptContext;
		const deepseek = model({
			id: "deepseek-v4-1-flash",
			thinkingLevelMap: {
				off: "none",
				minimal: null,
				low: "low",
				medium: null,
				high: "high",
				xhigh: "xhigh",
				max: "max",
			},
			serviceLimits: { maxOutputTokens: 1048576, responseTimeLimitMs: 740_000 },
		});
		const sent: Array<Record<string, unknown>> = [];
		for (const reasoning of ["low", "xhigh"] as const) {
			const stream = streamSimple(deepseek, context, {
				apiKey: "test",
				reasoning,
				onPayload: (payload) => {
					sent.push(payload as Record<string, unknown>);
					throw new Error("stop before network");
				},
			});
			await stream.result();
		}
		expect(sent.map((p) => [p.reasoning_effort, p.max_completion_tokens])).toEqual([
			["low", 16384],
			["xhigh", 65536],
		]);
	});
});

describe("fitRunInfraRequestSize", () => {
	const big = (n: number) => "x".repeat(n);
	it("leaves a request under the limit untouched", () => {
		const params = {
			messages: [
				{ role: "tool", content: big(10_000) },
				{ role: "user", content: "hi" },
			],
		};
		const before = JSON.stringify(params);
		expect(fitRunInfraRequestSize(params, 3670016).trimmed).toBe(0);
		expect(JSON.stringify(params)).toBe(before);
	});

	it("shortens the oldest tool results until the body fits and never touches the latest message", () => {
		const params = {
			messages: [
				{ role: "system", content: "sys" },
				{ role: "user", content: "go" },
				{ role: "tool", tool_call_id: "a", content: big(60_000) },
				{ role: "tool", tool_call_id: "b", content: big(60_000) },
				{ role: "tool", tool_call_id: "c", content: big(60_000) },
			],
		};
		const limit = 100_000;
		const result = fitRunInfraRequestSize(params, limit);
		expect(result.trimmed).toBe(2);
		expect(Buffer.byteLength(JSON.stringify(params))).toBeLessThanOrEqual(limit);
		expect(params.messages[2].content).toContain("trimmed to fit RunInfra's request size limit");
		expect(params.messages[4].content).toBe(big(60_000));
		expect(params.messages[1].content).toBe("go");
	});

	it("handles tool results with content parts", () => {
		const params = {
			messages: [
				{ role: "tool", content: [{ type: "text", text: big(80_000) }] },
				{ role: "user", content: "next" },
			],
		};
		expect(fitRunInfraRequestSize(params, 30_000).trimmed).toBe(1);
		expect(Buffer.byteLength(JSON.stringify(params))).toBeLessThan(30_000);
	});

	it("is wired into the request: an oversized body is trimmed before it is sent", async () => {
		const context = {
			messages: [
				{ role: "user", content: "read it", timestamp: 0 },
				{
					role: "assistant",
					content: [{ type: "toolCall", id: "t1", name: "read", arguments: { path: "a" } }],
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
					stopReason: "toolUse",
					timestamp: 0,
				},
				{
					role: "toolResult",
					toolCallId: "t1",
					toolName: "read",
					content: [{ type: "text", text: big(200_000) }],
					isError: false,
					timestamp: 0,
				},
				{ role: "user", content: "summarize", timestamp: 0 },
			],
		} as unknown as TranscriptContext;
		const small = model({ inputLimits: { maxRequestBytes: 50_000 } });
		const untrimmed = Buffer.byteLength(JSON.stringify(buildOpenAICompletionsParams(small, context, {})));
		expect(untrimmed).toBeGreaterThan(200_000);
		let sentBytes = 0;
		const fetchStub = (async (_url: unknown, init?: { body?: unknown }) => {
			sentBytes = Buffer.byteLength(String(init?.body ?? ""));
			return new Response("{}", { status: 400 });
		}) as typeof fetch;
		const message = await streamSimple(small, context, { apiKey: "test", fetch: fetchStub }).result();
		expect(sentBytes).toBeGreaterThan(0);
		expect(sentBytes).toBeLessThanOrEqual(50_000);
		expect(message.stopReason).toBe("error");
	});
});

describe("rate-limit pacing", () => {
	it("parses RunInfra's epoch reset and OpenAI-style durations", () => {
		const now = 1_792_178_000_000;
		expect(parseRateLimitResetMs("1792178220", now)).toBe(220_000);
		expect(parseRateLimitResetMs("1s", now)).toBe(1000);
		expect(parseRateLimitResetMs("6m0s", now)).toBe(360_000);
		expect(parseRateLimitResetMs("250ms", now)).toBe(250);
		expect(parseRateLimitResetMs("2", now)).toBe(2000);
		expect(parseRateLimitResetMs("soon", now)).toBeUndefined();
		expect(parseRateLimitResetMs(undefined, now)).toBeUndefined();
	});

	it("caps concurrent requests per key and model", async () => {
		const gate = new RunInfraRequestGate();
		const a = await gate.acquire("k", 2);
		const b = await gate.acquire("k", 2);
		let third = false;
		const pending = gate.acquire("k", 2).then((release) => {
			third = true;
			return release;
		});
		await new Promise((r) => setTimeout(r, 10));
		expect(third).toBe(false);
		expect(gate.activeCount("k")).toBe(2);
		a();
		const c = await pending;
		expect(third).toBe(true);
		b();
		c();
		expect(gate.activeCount("k")).toBe(0);
	});

	it("holds the next request until the window resets when no requests remain", async () => {
		let clock = 1_000_000;
		const gate = new RunInfraRequestGate(() => clock);
		gate.observe("k", { "x-ratelimit-remaining-requests": "0", "x-ratelimit-reset-requests": "0.05" });
		const start = Date.now();
		const release = await gate.acquire("k", undefined);
		expect(Date.now() - start).toBeGreaterThanOrEqual(40);
		release();
		// Remaining > 0: no wait.
		clock += 1000;
		gate.observe("k", { "x-ratelimit-remaining-requests": "9999", "x-ratelimit-reset-requests": "60" });
		const t = Date.now();
		(await gate.acquire("k", undefined))();
		expect(Date.now() - t).toBeLessThan(20);
	});

	it("a 429 without retry-after waits for x-ratelimit-reset", async () => {
		let calls = 0;
		const started = Date.now();
		const result = await retryProviderRequest(
			async () => {
				calls++;
				if (calls === 1) {
					const error = Object.assign(new Error("rate limited"), {
						status: 429,
						headers: new Headers({ "x-ratelimit-reset-requests": "0.08" }),
					});
					throw error;
				}
				return "ok";
			},
			{ maxRetries: 1 },
		);
		expect(result).toBe("ok");
		expect(Date.now() - started).toBeGreaterThanOrEqual(70);
	});
});
