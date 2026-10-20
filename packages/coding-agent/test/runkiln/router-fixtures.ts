import type { Api, Model, ThinkingLevelMap } from "@runkiln/ai";
import { parseRouterCatalog, type RouterCatalog } from "../../src/core/router/catalog.ts";
import type { CandidateModel } from "../../src/core/router/select.ts";
import type { Classification, ClassifierInput, RouterClassifier, TurnSignals } from "../../src/core/router/types.ts";

/** Small catalog: three skills, two models (cheap/weak, strong/pricier). */
export const TEST_ROUTER_YAML = `
tuning:
  skill_threshold: 0.12
  max_secondary_skills: 3
  req_base: 20
  req_span: 60
  secondary_factor: 0.8
  low_confidence_boost: 0
  cost_tiebreak_frac: 0.10
  stickiness: 0.25
  default_output_tokens: 1000
  momentum_decay: 0.85
  session_idle_reset_min: 30
  longctx_tokens: 100000
  failed_model_cooldown_sec: 300
thinking:
  deep_skills: [reason.deep]
  light_skills: [chat]
skills:
  - { name: chat, desc: "Small talk" }
  - { name: code.bugfix, desc: "Fix bugs" }
  - { name: reason.deep, desc: "Hard reasoning" }
  - { name: tool.call, desc: "Tool calls" }
  - { name: longctx, desc: "Long context" }
models:
  cheap:
    intelligence: 40
    skills: { chat: 60, code.bugfix: 40, reason.deep: 30, tool.call: 45, longctx: 40 }
  strong:
    intelligence: 60
    skills: { chat: 55, code.bugfix: 70, reason.deep: 65, tool.call: 60, longctx: 60 }
`;

export function testCatalog(extra?: string): RouterCatalog {
	const documents = [{ text: TEST_ROUTER_YAML, path: "test-router.yaml" }];
	if (extra) documents.push({ text: extra, path: "user-router.yaml" });
	return parseRouterCatalog(documents);
}

const FULL_MAP: ThinkingLevelMap = {
	off: "none",
	minimal: null,
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: null,
	max: null,
};

export function testModel(
	id: string,
	overrides: Partial<Model<"openai-completions">> = {},
): Model<"openai-completions"> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider: "runinfra",
		baseUrl: "https://api.runinfra.ai/v1",
		reasoning: true,
		thinkingLevelMap: FULL_MAP,
		input: ["text"],
		cost:
			id === "strong"
				? { input: 0.3, output: 1.2, cacheRead: 0.03, cacheWrite: 0 }
				: { input: 0.1, output: 0.4, cacheRead: 0.01, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 16_384,
		...overrides,
	};
}

export const TEST_MODELS: Model<Api>[] = [testModel("cheap"), testModel("strong")];

export function candidate(id: string, overrides: Partial<CandidateModel> = {}): CandidateModel {
	const catalog = testCatalog();
	const model = testModel(id);
	return {
		id,
		priceIn: model.cost.input,
		priceOut: model.cost.output,
		priceCachedIn: model.cost.cacheRead,
		contextWindow: model.contextWindow,
		vision: false,
		intelligence: catalog.models[id]?.intelligence ?? 50,
		skills: catalog.models[id]?.skills ?? {},
		supportedThinking: ["off", "low", "medium", "high"],
		...overrides,
	};
}

export function signals(overrides: Partial<TurnSignals> = {}): TurnSignals {
	return {
		latestUserText: "fix the bug",
		recentContext: "",
		isNewUserTurn: true,
		hasImages: false,
		toolCallsThisTurn: 0,
		toolErrorsThisTurn: 0,
		testFailuresThisTurn: 0,
		filesTouchedThisTurn: 0,
		userRetry: false,
		contextTokens: 5000,
		...overrides,
	};
}

/** A classifier that answers from a function and records its calls. No network. */
export class MockClassifier implements RouterClassifier {
	readonly backend = "jev" as const;
	readonly modelId = "jev-mock";
	readonly calls: ClassifierInput[] = [];
	answer: (input: ClassifierInput) => Classification | Promise<Classification>;

	constructor(answer: (input: ClassifierInput) => Classification | Promise<Classification>) {
		this.answer = answer;
	}

	async classify(input: ClassifierInput): Promise<Classification> {
		this.calls.push(input);
		return this.answer(input);
	}
}

export function classification(overrides: Partial<Classification> = {}): Classification {
	return {
		skills: [{ skill: "code.bugfix", prob: 0.8 }],
		difficulty: 0.2,
		confidence: 1,
		needsTools: false,
		...overrides,
	};
}
