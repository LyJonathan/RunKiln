import { describe, expect, it, vi } from "vitest";
import {
	createClassifier,
	decisionModelOrDefault,
	JevClassifier,
	OPENROUTER_DEFAULT_MODEL,
	OpenRouterClassifier,
	truncateText,
	validateClassifierBaseUrl,
} from "../../src/core/router/classifiers.ts";
import { ClassifierError, type ClassifierInput } from "../../src/core/router/types.ts";
import { testCatalog } from "./router-fixtures.ts";

const catalog = testCatalog();
const common = { apiKey: "test-key", skills: catalog.skills, skillThreshold: 0.12, maxSecondarySkills: 3 };

const input: ClassifierInput = {
	request: "fix the failing test in parser.ts",
	recentContext: "user: earlier question",
	hasImages: false,
	harness: {
		role: "code",
		contextTokens: 1234,
		toolErrorsThisTurn: 0,
		testFailuresThisTurn: 1,
		filesTouchedThisTurn: 0,
	},
};

function fetchReturning(status: number, body: unknown) {
	return vi.fn(
		async (_url: string | URL | Request, _init?: RequestInit) =>
			new Response(typeof body === "string" ? body : JSON.stringify(body), { status }),
	);
}

const JEV_ANSWER = {
	model: "jev-1.13.0",
	answers: {
		skill: {
			type: "choice",
			choice: "code.bugfix",
			confidence: 0.8,
			probabilities: { "code.bugfix": 0.7, chat: 0.05, "reason.deep": 0.2, other: 0.05 },
		},
		difficulty: {
			type: "score",
			score: 3,
			confidence: 0.6,
			probabilities: { "0": 0, "1": 0, "2": 0, "3": 1, "4": 0 },
		},
		needs_tools: { type: "noul", noul: 0.93 },
	},
	usage: { input_tokens: 500, output_tokens: 40 },
};

describe("Jev classifier", () => {
	it("asks the three typed questions at /v1/systemone with a bearer key", async () => {
		const fetch = fetchReturning(200, JEV_ANSWER);
		const jev = new JevClassifier({ ...common, fetch });
		await jev.classify(input);
		const [url, init] = fetch.mock.calls[0];
		expect(url).toBe("https://api.typesafe.ai/v1/systemone");
		expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer test-key");
		const body = JSON.parse(String(init?.body));
		expect(body.model).toBe("jev-latest");
		expect(body.state.request).toBe(input.request);
		expect(body.state.harness.test_failures_this_turn).toBe(1);
		expect(body.questions.skill.type).toBe("choice");
		expect(Object.keys(body.questions.skill.criteria)).toEqual([
			"chat",
			"code.bugfix",
			"reason.deep",
			"tool.call",
			"longctx",
			"other",
		]);
		expect(body.questions.difficulty.type).toBe("score");
		expect(body.questions.difficulty.criteria).toHaveLength(5);
		expect(body.questions.needs_tools.type).toBe("noul");
	});

	it("reads choice probabilities, normalizes the score by its top level, and thresholds the noul", async () => {
		const jev = new JevClassifier({ ...common, fetch: fetchReturning(200, JEV_ANSWER) });
		const result = await jev.classify(input);
		expect(result.skills).toEqual([
			{ skill: "code.bugfix", prob: 0.7 },
			{ skill: "reason.deep", prob: 0.2 },
		]);
		expect(result.difficulty).toBe(0.75);
		expect(result.confidence).toBe(0.6);
		expect(result.needsTools).toBe(true);
	});

	it("maps score position 1 to 0.25, not 1", () => {
		const jev = new JevClassifier(common);
		const answer = structuredClone(JEV_ANSWER);
		answer.answers.difficulty.score = 1;
		expect(jev.parse(answer).difficulty).toBe(0.25);
	});

	it("keeps an out-of-taxonomy answer as no required skill", () => {
		const jev = new JevClassifier(common);
		const answer = structuredClone(JEV_ANSWER) as { answers: { skill: unknown } };
		answer.answers.skill = {
			type: "choice",
			choice: "other",
			confidence: 0.9,
			probabilities: { other: 0.99, chat: 0.01 },
		};
		expect(jev.parse(answer).skills).toEqual([]);
	});

	it("rejects malformed answers instead of inventing one", () => {
		const jev = new JevClassifier(common);
		expect(() => jev.parse({})).toThrow(ClassifierError);
		expect(() => jev.parse({ answers: { skill: { choice: "chat" } } })).toThrow(/difficulty/);
		expect(() => jev.parse({ answers: { skill: { choice: "chat" }, difficulty: { level: "hard" } } })).toThrow(
			/score/,
		);
		expect(() => jev.parse({ answers: { skill: { probabilities: { chat: 7 } }, difficulty: { score: 1 } } })).toThrow(
			/out of range/,
		);
	});

	it("reports HTTP errors and timeouts as classifier errors", async () => {
		const failing = new JevClassifier({ ...common, fetch: fetchReturning(401, "Missing or invalid API key") });
		await expect(failing.classify(input)).rejects.toThrow(/Jev 401: Missing or invalid API key/);

		const hanging = vi.fn(
			(_url: string | URL | Request, init?: RequestInit) =>
				new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
				}),
		);
		const slow = new JevClassifier({ ...common, timeoutMs: 20, fetch: hanging });
		await expect(slow.classify(input)).rejects.toThrow(/timed out after 20 ms/);
	});
});

describe("OpenRouter classifier (Decisions API)", () => {
	it("asks the same typed questions as Jev at /api/v1/systemone with a decision model", async () => {
		const fetch = fetchReturning(200, { ...JEV_ANSWER, model: "typesafe/jev-1.14-20261014", provider: "TypeSafe" });
		const classifier = new OpenRouterClassifier({ ...common, fetch });
		await classifier.classify(input);
		const [url, init] = fetch.mock.calls[0];
		expect(url).toBe("https://openrouter.ai/api/v1/systemone");
		expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer test-key");
		const body = JSON.parse(String(init?.body));
		expect(body.model).toBe(OPENROUTER_DEFAULT_MODEL);
		expect(body.messages).toBeUndefined();
		expect(body.response_format).toBeUndefined();
		expect(body.state.request).toBe(input.request);
		expect(body.questions.skill.type).toBe("choice");
		expect(body.questions.difficulty.type).toBe("score");
		expect(body.questions.needs_tools.type).toBe("noul");
		const jevBody = new JevClassifier(common).buildRequest(input) as { questions: unknown; state: unknown };
		expect(body.questions).toEqual(jevBody.questions);
		expect(body.state).toEqual(jevBody.state);
	});

	it("defaults to a decision model and never sends a legacy chat model", () => {
		expect(OPENROUTER_DEFAULT_MODEL).toBe("typesafe/jev-1.14");
		expect(new OpenRouterClassifier(common).modelId).toBe(OPENROUTER_DEFAULT_MODEL);
		expect(new OpenRouterClassifier({ ...common, model: "google/gemini-2.5-flash-lite" }).modelId).toBe(
			OPENROUTER_DEFAULT_MODEL,
		);
		expect(new OpenRouterClassifier({ ...common, model: "liquid/d1-ultra" }).modelId).toBe("liquid/d1-ultra");
		expect(decisionModelOrDefault(undefined)).toBe(OPENROUTER_DEFAULT_MODEL);
	});

	it("reads probabilities into skills, difficulty, tools and confidence", async () => {
		const classifier = new OpenRouterClassifier({ ...common, fetch: fetchReturning(200, JEV_ANSWER) });
		const result = await classifier.classify(input);
		expect(result.skills).toEqual([
			{ skill: "code.bugfix", prob: 0.7 },
			{ skill: "reason.deep", prob: 0.2 },
		]);
		expect(result.difficulty).toBe(0.75);
		expect(result.needsTools).toBe(true);
		expect(result.confidence).toBe(0.6);
	});

	it("derives confidence from the probabilities when the model sends none", () => {
		const classifier = new OpenRouterClassifier(common);
		const answer = structuredClone(JEV_ANSWER) as {
			answers: { skill: Record<string, unknown>; difficulty: Record<string, unknown> };
		};
		delete answer.answers.skill.confidence;
		delete answer.answers.difficulty.confidence;
		answer.answers.difficulty.probabilities = { "0": 0, "1": 0, "2": 0.1, "3": 0.9, "4": 0 };
		// min(top skill 0.7, top difficulty level 0.9)
		expect(classifier.parse(answer).confidence).toBe(0.7);
	});

	it("rejects malformed or mistyped answers", () => {
		const classifier = new OpenRouterClassifier(common);
		expect(() => classifier.parse({ choices: [{ message: { content: "{}" } }] })).toThrow(/no answers/);
		const mistyped = structuredClone(JEV_ANSWER) as { answers: { difficulty: Record<string, unknown> } };
		mistyped.answers.difficulty.type = "choice";
		expect(() => classifier.parse(mistyped)).toThrow(/not a score/);
	});

	it("reports HTTP errors with the OpenRouter label", async () => {
		const failing = new OpenRouterClassifier({ ...common, fetch: fetchReturning(404, "No endpoints found") });
		await expect(failing.classify(input)).rejects.toThrow(/OpenRouter 404: No endpoints found/);
	});
});

describe("classifier selection", () => {
	const cat = { skills: catalog.skills, skillThreshold: 0.12, maxSecondarySkills: 3 };

	it("picks Jev when TYPESAFE_API_KEY is set, else OpenRouter, else none", () => {
		expect(createClassifier({}, cat, { TYPESAFE_API_KEY: "a", OPENROUTER_API_KEY: "b" }).classifier?.backend).toBe(
			"jev",
		);
		expect(createClassifier({}, cat, { OPENROUTER_API_KEY: "b" }).classifier?.backend).toBe("openrouter");
		const none = createClassifier({}, cat, {});
		expect(none.classifier).toBeUndefined();
		expect(none.problem).toMatch(/TYPESAFE_API_KEY.*OPENROUTER_API_KEY/);
	});

	it("uses the configured backend and model, and says which key is missing", () => {
		const chosen = createClassifier({ classifier: "openrouter", openrouter: { model: "liquid/d1-ultra" } }, cat, {
			TYPESAFE_API_KEY: "a",
			OPENROUTER_API_KEY: "b",
		});
		expect(chosen.classifier?.backend).toBe("openrouter");
		expect(chosen.classifier?.modelId).toBe("liquid/d1-ultra");
		expect(createClassifier({ classifier: "jev" }, cat, { OPENROUTER_API_KEY: "b" }).problem).toMatch(
			/TYPESAFE_API_KEY/,
		);
		expect(createClassifier({ classifier: "off" }, cat, { TYPESAFE_API_KEY: "a" }).classifier).toBeUndefined();
	});

	it("refuses non-https classifier endpoints (http only for localhost)", () => {
		expect(validateClassifierBaseUrl("https://api.typesafe.ai/")).toBe("https://api.typesafe.ai");
		expect(validateClassifierBaseUrl("http://localhost:8099")).toBe("http://localhost:8099");
		expect(() => validateClassifierBaseUrl("http://evil.example")).toThrow(/https/);
		expect(() => validateClassifierBaseUrl("https://user:pw@api.typesafe.ai")).toThrow(/credentials/);
		expect(
			createClassifier({ jev: { baseUrl: "http://evil.example" } }, cat, { TYPESAFE_API_KEY: "a" }).problem,
		).toMatch(/https/);
	});

	it("truncates text without splitting a surrogate pair", () => {
		expect(truncateText("abc", 5)).toBe("abc");
		expect(truncateText("ab😀cd", 3)).toBe("ab…");
		expect(truncateText("abcdef", 3)).toBe("abc…");
	});
});
