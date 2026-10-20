import type { ModelThinkingLevel } from "@runkiln/ai";
import type { DecisionSpend } from "../usage/decision-spend.ts";
import type { TaskKind } from "./catalog.ts";

/** The two classifier backends. There is no third: when the configured one fails, the router falls back. */
export type ClassifierBackend = "jev" | "openrouter";

export interface SkillProbability {
	skill: string;
	prob: number;
}

/** What a classifier answers: the same three questions for both backends. */
export interface Classification {
	/** Required skills, highest probability first. The first is the primary skill. Empty: none fits. */
	skills: SkillProbability[];
	/** 0 (trivial) .. 1 (frontier). */
	difficulty: number;
	/** 0..1. */
	confidence: number;
	needsTools: boolean;
	/** v2 classifiers: the task family the quality curves are measured for. */
	kind?: TaskKind;
	/** v2: the request only makes sense with the previous turn ("yes do it", "now the same for X"). */
	followUp?: boolean;
	/** v2: expected answer length level 0 (a sentence) .. 3 (many files). */
	outputLength?: number;
	/** v2: 0..1, the request leaves the scope or cause to guess. */
	ambiguity?: number;
	/** What the call that produced this answer cost (absent when the response reported no usage). */
	spend?: DecisionSpend;
}

/** What the classifier is shown. Plain data; no secrets. */
export interface ClassifierInput {
	/** The newest user request (bounded). */
	request: string;
	/** A short tail of earlier conversation for context (bounded). */
	recentContext: string;
	hasImages: boolean;
	/** v2: the previous turn's routed task kind and difficulty, for judging follow-ups. */
	previous?: { kind: TaskKind; difficulty: number };
	/** Harness facts that help judge difficulty. */
	harness: {
		role: "code" | "chat";
		contextTokens: number;
		toolErrorsThisTurn: number;
		testFailuresThisTurn: number;
		filesTouchedThisTurn: number;
	};
}

export interface RouterClassifier {
	readonly backend: ClassifierBackend;
	/** Jev model name or OpenRouter model id. */
	readonly modelId: string;
	classify(input: ClassifierInput, signal?: AbortSignal): Promise<Classification>;
}

export class ClassifierError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ClassifierError";
	}
}

/** Harness signals for one request, read from the conversation. */
export interface TurnSignals {
	/** Text of the newest user message. */
	latestUserText: string;
	recentContext: string;
	/** Model of the newest successful assistant reply: its provider prompt cache is warm. */
	warmModelId?: string;
	/**
	 * Thinking level of that reply. RunInfra keys its prompt cache by (model, reasoning effort): the same
	 * model at another effort starts cold (probe 2026-10-16), so only this pair counts as warm.
	 */
	warmThinkingLevel?: ModelThinkingLevel;
	/** True when the newest message is from the user (a new turn), false on tool continuations. */
	isNewUserTurn: boolean;
	/** Any image anywhere in the context (they are re-sent every request). */
	hasImages: boolean;
	toolCallsThisTurn: number;
	toolErrorsThisTurn: number;
	testFailuresThisTurn: number;
	filesTouchedThisTurn: number;
	/** The user says the last attempt failed ("still failing", "doesn't work", "try again"). */
	userRetry: boolean;
	contextTokens: number;
	/** The turn before this one (between the two newest user messages). */
	previousTurn?: PreviousTurnSignals;
	/** The newest assistant text before this user message ends with a question (an offer or a plan). */
	assistantAsked?: boolean;
}

export interface PreviousTurnSignals {
	/** A request of that turn ended in an error (provider failure). */
	errored: boolean;
	toolErrors: number;
	/** Test/typecheck commands that failed in that turn. */
	testFailures: number;
	/** The last test/typecheck command of that turn passed (a failure earlier in the turn was fixed). */
	lastTestPassed: boolean;
	/** The turn updated its todo list and ended with this many items not done. */
	unfinishedTodos?: number;
}

export type DecisionSource =
	/** Fresh classifier answer. */
	| "classifier"
	/** Same request seen recently: cached classifier answer. */
	| "cache"
	/** Obvious trivial turn (thanks, ok, hi): no classifier call. */
	| "heuristic"
	/** Bare follow-up ("yes do it", "continue", "try again"): the previous turn's classification, no call. */
	| "follow-up"
	/** Tool continuation: the turn's decision is kept, no classifier call. */
	| "continuation"
	/** New turn on a warm pair that wins for every task kind and difficulty: kept, no classifier call. */
	| "warm-skip"
	/** Tool continuation after failures: re-selected with higher difficulty, no classifier call. */
	| "escalation"
	/** The routing mode changed mid-turn: re-selected with the turn's classification, no classifier call. */
	| "reselect"
	/** Classifier failed or is not configured: kept the previous decision. */
	| "held-fallback"
	/** Classifier failed or is not configured and there was no previous decision: default model. */
	| "default-fallback"
	/** The turn's model kept failing: switched to another model at an equivalent level for this turn. */
	| "failover";

export interface DifficultyBoost {
	reason: string;
	delta: number;
}

export interface RequiredSkill {
	skill: string;
	prob: number;
	minScore: number;
}

/** One (model, thinking level) candidate. */
export interface PairReport {
	level: ModelThinkingLevel;
	/** Quality selection: estimated pass rate of this pair for the turn. */
	quality?: number;
	feasible: boolean;
	minMargin: number;
	estCostUsd: number;
	failed: string[];
}

/** A model with its chosen thinking level (the best of its pairs). */
export interface CandidateReport {
	model: string;
	feasible: boolean;
	/** Vision or context does not fit: never chosen. */
	hardFail: boolean;
	estCostUsd: number;
	/** Worst (score - required) over required skills; negative is a deficit. */
	minMargin: number;
	thinkingLevel: ModelThinkingLevel;
	failed: string[];
	/** Quality selection: estimated pass rate at the chosen level. */
	quality?: number;
	/** Quality selection: curves borrowed from the reference model (not benched). */
	derived?: boolean;
	/** Every level considered for this model. */
	pairs?: PairReport[];
}

export interface QualitySelectionInfo {
	kind: TaskKind;
	/** Best estimated pass rate among the allowed pairs. */
	best: number;
	/** The chosen pair's estimated pass rate. */
	chosen: number;
	tolerance: number;
	/** Escalation steps applied (0: none). */
	steps: number;
	/** The pair the escalation stepped up from. */
	from?: { model: string; level: ModelThinkingLevel; quality: number };
	answerTokens: number;
	/**
	 * Cache-aware choice: the held warm pair was kept (in the mode's band, or the better pair was not worth the
	 * miss) or left (the expected quality gain beat the cache cost). USD over the cache horizon.
	 */
	cache?: { kept: boolean; reason: "in_band" | "not_worth_miss" | "worth_miss"; gainUsd: number; switchUsd: number };
	/** The prompt cache was lost anyway (start, compaction, idle, /new): nothing held. */
	freeSwitch?: boolean;
}

export interface Selection {
	modelId: string;
	escalated: boolean;
	cause:
		| "cheapest_feasible"
		| "held_sticky"
		| "escalated_nearest_fit"
		| "cheapest_within_band"
		| "best_quality"
		| "stepped_up"
		/** Kept the warm pair (cache-aware routing). */
		| "held_warm";
	/** Quality selection details (router v2). */
	quality?: QualitySelectionInfo;
	required: RequiredSkill[];
	effectiveDifficulty: number;
	candidates: CandidateReport[];
}
