import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createPermissionJudge,
	isPermissionJudgeAvailable,
	JevPermissionJudge,
	OpenRouterPermissionJudge,
	resolvePermissionJudgeBackend,
} from "../../src/core/runkiln/permission-judge.ts";

const input = { toolName: "bash", args: { command: "npm test" }, cwd: "/p", summary: "Run bash command?\nnpm test" };

function fetchReturning(body: unknown, status = 200) {
	return vi.fn(
		async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify(body), { status }),
	) as unknown as typeof globalThis.fetch & { mock: { calls: [string, RequestInit][] } };
}

describe("Jev permission judge", () => {
	it("sends typed decision and reason questions and reads the answers", async () => {
		const fetch = fetchReturning({
			answers: { decision: { choice: "allow", confidence: 0.92 }, reason: { choice: "routine project work" } },
		});
		const judge = new JevPermissionJudge({ apiKey: "k", fetch });
		expect(await judge.judge(input)).toEqual({
			decision: "allow",
			reason: "routine project work",
			category: "routine project work",
			confidence: 0.92,
		});
		const [url, init] = fetch.mock.calls[0];
		expect(url).toBe("https://api.typesafe.ai/v1/systemone");
		const body = JSON.parse(String(init.body));
		expect(Object.keys(body.questions)).toEqual(["decision", "risk", "reason", "requested"]);
		expect(body.questions.decision.type).toBe("choice");
		expect(Object.keys(body.questions.decision.criteria)).toEqual(["allow", "ask", "deny"]);
		expect(body.state.call.tool).toBe("bash");
	});

	it("turns a low-confidence allow into ask", async () => {
		const judge = new JevPermissionJudge({
			apiKey: "k",
			fetch: fetchReturning({
				answers: { decision: { choice: "allow", confidence: 0.4 }, reason: { choice: "routine project work" } },
			}),
		});
		const verdict = await judge.judge(input);
		expect(verdict.decision).toBe("ask");
		expect(verdict.reason).toContain("low confidence");
	});

	it("throws on HTTP errors and malformed answers", async () => {
		await expect(
			new JevPermissionJudge({ apiKey: "k", fetch: fetchReturning({}, 500) }).judge(input),
		).rejects.toThrow("Jev HTTP 500");
		await expect(
			new JevPermissionJudge({
				apiKey: "k",
				fetch: fetchReturning({ answers: { decision: { choice: "maybe" } } }),
			}).judge(input),
		).rejects.toThrow("no decision");
	});

	it("times out", async () => {
		const fetch = vi.fn(
			(_url: string, init: RequestInit) =>
				new Promise<Response>((_resolve, reject) => {
					init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
				}),
		) as unknown as typeof globalThis.fetch;
		await expect(new JevPermissionJudge({ apiKey: "k", fetch, timeoutMs: 20 }).judge(input)).rejects.toThrow(
			"timed out",
		);
	});
});

describe("OpenRouter permission judge", () => {
	it("asks the Decisions API the same typed questions as Jev and reads the choice", async () => {
		const fetch = fetchReturning({
			model: "typesafe/jev-1.14-20261014",
			answers: {
				decision: {
					type: "choice",
					choice: "ask",
					probabilities: { allow: 0.1, ask: 0.85, deny: 0.05 },
					confidence: 0.8,
				},
				reason: { type: "choice", choice: "installs or removes packages" },
				risk: { type: "choice", choice: "medium" },
			},
		});
		const judge = new OpenRouterPermissionJudge({ apiKey: "k", fetch });
		expect(await judge.judge(input)).toMatchObject({ decision: "ask", risk: "medium", confidence: 0.8 });
		const [url, init] = fetch.mock.calls[0];
		expect(url).toBe("https://openrouter.ai/api/v1/systemone");
		const body = JSON.parse(String(init.body));
		expect(body.model).toBe("typesafe/jev-1.14");
		expect(body.messages).toBeUndefined();
		expect(Object.keys(body.questions.decision.criteria)).toEqual(["allow", "ask", "deny"]);
		expect(body.questions).toEqual(
			(new JevPermissionJudge({ apiKey: "k" }).buildRequest(input) as { questions: unknown }).questions,
		);
	});

	it("never sends a legacy chat model", () => {
		expect(new OpenRouterPermissionJudge({ apiKey: "k", model: "google/gemini-2.5-flash-lite" }).model).toBe(
			"typesafe/jev-1.14",
		);
		expect(new OpenRouterPermissionJudge({ apiKey: "k", model: "liquid/d1-ultra" }).model).toBe("liquid/d1-ultra");
	});

	it("takes confidence from the probabilities, so a spread allow asks", async () => {
		const fetch = fetchReturning({
			answers: {
				decision: { type: "choice", choice: "allow", probabilities: { allow: 0.55, ask: 0.4, deny: 0.05 } },
				risk: { type: "choice", choice: "low" },
			},
		});
		const verdict = await new OpenRouterPermissionJudge({ apiKey: "k", fetch }).judge(input);
		expect(verdict.decision).toBe("ask");
		expect(verdict.confidence).toBe(0.55);
		expect(verdict.reason).toMatch(/low confidence 0.55/);
	});

	it("rejects an unknown decision", async () => {
		const fetch = fetchReturning({ answers: { decision: { type: "choice", choice: "yes" } } });
		await expect(new OpenRouterPermissionJudge({ apiKey: "k", fetch }).judge(input)).rejects.toThrow("no decision");
	});
});

describe("judge availability", () => {
	let agentDir: string;
	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "runkiln-judge-"));
		mkdirSync(agentDir, { recursive: true });
	});
	afterEach(() => rmSync(agentDir, { recursive: true, force: true }));

	it("is unavailable without keys and prefers the configured classifier", () => {
		expect(isPermissionJudgeAvailable(agentDir, {})).toBe(false);
		expect(createPermissionJudge(agentDir, {})).toBeUndefined();
		expect(resolvePermissionJudgeBackend({}, { TYPESAFE_API_KEY: "a", OPENROUTER_API_KEY: "b" }, {})).toBe("jev");
		expect(
			resolvePermissionJudgeBackend(
				{ classifier: "openrouter" },
				{ TYPESAFE_API_KEY: "a", OPENROUTER_API_KEY: "b" },
				{},
			),
		).toBe("openrouter");
		expect(resolvePermissionJudgeBackend({ classifier: "off" }, {}, { openrouter: "b" })).toBe("openrouter");
	});

	it("reads the saved router key", () => {
		writeFileSync(join(agentDir, "router-keys.json"), JSON.stringify({ jev: "saved" }));
		expect(isPermissionJudgeAvailable(agentDir, {})).toBe(true);
		expect(createPermissionJudge(agentDir, {})?.label).toBe("Jev");
	});
});
