/**
 * The two classifier backends:
 * - Jev, TypeSafe's System One model: POST {base}/v1/systemone with typed choice/score/noul questions.
 * - A decision model on OpenRouter: POST https://openrouter.ai/api/v1/systemone, the same Decisions / System One
 *   request (typed questions) and answers (probabilities). Chat models are never used.
 *
 * Both throw ClassifierError on any failure (network, HTTP status, timeout, malformed answer). The router
 * decides what to do then; nothing here invents an answer.
 */

import { decisionSpendFromResponse } from "../usage/decision-spend.ts";
import type { RouterSkill, TaskKind } from "./catalog.ts";
import {
	AMBIGUITY_QUESTION,
	DIFFICULTY_LEVELS,
	DIFFICULTY_LEVELS_V2,
	DIFFICULTY_QUESTION,
	DIFFICULTY_QUESTION_V2,
	FOLLOW_UP_QUESTION,
	OTHER_SKILL,
	OUTPUT_LENGTH_LEVELS,
	OUTPUT_LENGTH_QUESTION,
	SKILL_QUESTION,
	skillCriteria,
	TASK_OPTIONS,
	TASK_QUESTION,
	TOOLS_QUESTION,
	taskCriteria,
} from "./classifier-prompt.ts";
import { LEGACY_CHAT_CLASSIFIER_MODELS, OPENROUTER_DEFAULT_DECISION_MODEL } from "./decision-models.ts";
import {
	type Classification,
	type ClassifierBackend,
	ClassifierError,
	type ClassifierInput,
	type RouterClassifier,
	type SkillProbability,
} from "./types.ts";

export const JEV_DEFAULT_BASE_URL = "https://api.typesafe.ai";
export const JEV_DEFAULT_MODEL = "jev-latest";
export const JEV_API_KEY_ENV = "TYPESAFE_API_KEY";
export const OPENROUTER_DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";
/** A decision model (output modality "decisions"), never a chat model; see decision-models.ts. */
export const OPENROUTER_DEFAULT_MODEL = OPENROUTER_DEFAULT_DECISION_MODEL;
export const OPENROUTER_API_KEY_ENV = "OPENROUTER_API_KEY";
export const DEFAULT_CLASSIFIER_TIMEOUT_MS = 4000;

const MAX_RESPONSE_CHARS = 200_000;

export interface ClassifierOptions {
	apiKey: string;
	model?: string;
	baseUrl?: string;
	timeoutMs?: number;
	skills: readonly RouterSkill[];
	skillThreshold: number;
	maxSecondarySkills: number;
	/**
	 * Question set: 1 = skill taxonomy + difficulty + tools (score selection); 2 = task kind, calibrated
	 * difficulty, follow-up, output length, ambiguity and tools (quality selection). Default 1.
	 */
	schema?: 1 | 2;
	/** v2: the skill reported for each task kind (footer, legacy fields). */
	kindSkills?: Partial<Record<TaskKind, string>>;
	/** Injected in tests. */
	fetch?: typeof globalThis.fetch;
}

/** v2 skills field: the kind's representative skill, when the taxonomy has it. */
function kindSkill(options: ClassifierOptions, kind: TaskKind, prob: number, names: Set<string>): SkillProbability[] {
	const skill = options.kindSkills?.[kind];
	return skill && names.has(skill) ? [{ skill, prob }] : [];
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** https only; plain http for loopback (local mocks). No credentials in the URL. */
export function validateClassifierBaseUrl(value: string): string {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error(`Invalid router classifier baseUrl: ${value}`);
	}
	if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname))) {
		throw new Error(`Router classifier baseUrl must use https (http only for localhost): ${value}`);
	}
	if (url.username || url.password) throw new Error("Router classifier baseUrl must not contain credentials");
	return value.replace(/\/+$/, "");
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Cuts on code points, never inside a surrogate pair. */
export function truncateText(text: string, max: number): string {
	if (text.length <= max) return text;
	let end = max;
	const last = text.charCodeAt(end - 1);
	if (last >= 0xd800 && last <= 0xdbff) end--;
	return `${text.slice(0, end)}…`;
}

async function postJson(
	fetchImpl: typeof globalThis.fetch,
	url: string,
	headers: Record<string, string>,
	body: unknown,
	timeoutMs: number,
	signal: AbortSignal | undefined,
	label: string,
): Promise<unknown> {
	const timeout = AbortSignal.timeout(timeoutMs);
	const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
	let response: Response;
	try {
		response = await fetchImpl(url, {
			method: "POST",
			headers: { "Content-Type": "application/json", ...headers },
			body: JSON.stringify(body),
			signal: combined,
		});
	} catch (error) {
		if (signal?.aborted) throw error;
		if (timeout.aborted) throw new ClassifierError(`${label} timed out after ${timeoutMs} ms`);
		throw new ClassifierError(`${label} request failed: ${errorText(error)}`);
	}
	const text = await response.text().catch(() => "");
	if (!response.ok) {
		throw new ClassifierError(
			`${label} ${response.status}: ${truncateText(text.trim(), 200) || response.statusText}`,
		);
	}
	if (text.length > MAX_RESPONSE_CHARS) throw new ClassifierError(`${label} response too large`);
	try {
		return JSON.parse(text) as unknown;
	} catch {
		throw new ClassifierError(`${label} returned invalid JSON`);
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function finite(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

function harnessState(input: ClassifierInput) {
	return {
		request: input.request,
		recent_context: input.recentContext || undefined,
		previous_turn: input.previous
			? { task: input.previous.kind, difficulty: Math.round(input.previous.difficulty * 100) / 100 }
			: undefined,
		has_images: input.hasImages,
		harness: {
			session: input.harness.role === "code" ? "coding agent with file and shell tools" : "chat without tools",
			context_tokens: input.harness.contextTokens,
			tool_errors_this_turn: input.harness.toolErrorsThisTurn,
			test_failures_this_turn: input.harness.testFailuresThisTurn,
			files_edited_this_turn: input.harness.filesTouchedThisTurn,
		},
	};
}

// ---------------------------------------------------------------------------------------------
// System One / Decisions API (Jev on TypeSafe, decision models on OpenRouter)
// ---------------------------------------------------------------------------------------------

/**
 * Below this top task probability (router v2) the answer is too spread to route on: the classifier throws and the
 * router takes its fallback.
 */
export const ROUTE_MIN_TASK_PROBABILITY = 0.3;

/** Probability map of a choice or score answer, validated. */
function probabilityMap(answer: Record<string, unknown>, label: string): Record<string, number> | undefined {
	if (!isRecord(answer.probabilities)) return undefined;
	const map: Record<string, number> = {};
	for (const [key, value] of Object.entries(answer.probabilities)) {
		const prob = finite(value);
		if (prob === undefined || prob < -1e-6 || prob > 1 + 1e-6)
			throw new ClassifierError(`${label} probability out of range`);
		map[key] = clamp01(prob);
	}
	return map;
}

/**
 * Confidence of a choice or score answer, from its probabilities: the `confidence` the API derives from them (how
 * concentrated the distribution is) when sent, else the top probability.
 */
function answerConfidence(answer: Record<string, unknown>, probabilities?: Record<string, number>): number | undefined {
	const stated = finite(answer.confidence);
	if (stated !== undefined) return clamp01(stated);
	const values = probabilities ? Object.values(probabilities) : [];
	return values.length > 0 ? Math.max(...values) : undefined;
}

/** The named answer; a `type` other than the one asked is a malformed answer, not a default. */
function typedAnswer(
	answers: Record<string, unknown>,
	name: string,
	type: "choice" | "score" | "noul",
	label: string,
): Record<string, unknown> | undefined {
	const answer = answers[name];
	if (!isRecord(answer)) return undefined;
	if (answer.type !== undefined && answer.type !== type) {
		throw new ClassifierError(`${label} ${name} answer is not a ${type}`);
	}
	return answer;
}

interface SystemOneSpec {
	backend: ClassifierBackend;
	label: string;
	defaultModel: string;
	defaultBaseUrl: string;
	/** Path appended to the base URL. */
	path: string;
	headers?: Record<string, string>;
}

/**
 * The classifier both backends share: one POST of `{ model, state, questions }` with typed choice / score / noul
 * questions, answered with probabilities. Jev on TypeSafe and every decision model on OpenRouter speak it.
 */
abstract class SystemOneClassifier implements RouterClassifier {
	readonly backend: ClassifierBackend;
	readonly modelId: string;
	protected readonly baseUrl: string;
	protected readonly options: ClassifierOptions;
	private readonly spec: SystemOneSpec;
	private readonly criteria: Record<string, string>;
	private readonly skillNames: Set<string>;

	constructor(options: ClassifierOptions, spec: SystemOneSpec) {
		this.options = options;
		this.spec = spec;
		this.backend = spec.backend;
		this.modelId = options.model ?? spec.defaultModel;
		this.baseUrl = validateClassifierBaseUrl(options.baseUrl ?? spec.defaultBaseUrl);
		// Built once: the taxonomy does not change during a session.
		this.criteria = skillCriteria(options.skills);
		this.skillNames = new Set(options.skills.map((skill) => skill.name));
	}

	buildRequest(input: ClassifierInput): unknown {
		if (this.options.schema === 2) {
			return {
				model: this.modelId,
				state: harnessState(input),
				questions: {
					task: { type: "choice", instructions: TASK_QUESTION, criteria: TASK_CRITERIA },
					difficulty: { type: "score", instructions: DIFFICULTY_QUESTION_V2, criteria: [...DIFFICULTY_LEVELS_V2] },
					follow_up: { type: "noul", instructions: FOLLOW_UP_QUESTION },
					output_length: {
						type: "score",
						instructions: OUTPUT_LENGTH_QUESTION,
						criteria: [...OUTPUT_LENGTH_LEVELS],
					},
					ambiguity: { type: "noul", instructions: AMBIGUITY_QUESTION },
					needs_tools: { type: "noul", instructions: TOOLS_QUESTION },
				},
			};
		}
		return {
			model: this.modelId,
			state: harnessState(input),
			questions: {
				skill: { type: "choice", instructions: SKILL_QUESTION, criteria: this.criteria },
				difficulty: { type: "score", instructions: DIFFICULTY_QUESTION, criteria: [...DIFFICULTY_LEVELS] },
				needs_tools: { type: "noul", instructions: TOOLS_QUESTION },
			},
		};
	}

	async classify(input: ClassifierInput, signal?: AbortSignal): Promise<Classification> {
		const startedAt = performance.now();
		const response = await postJson(
			this.options.fetch ?? globalThis.fetch,
			`${this.baseUrl}${this.spec.path}`,
			{ Authorization: `Bearer ${this.options.apiKey}`, ...this.spec.headers },
			this.buildRequest(input),
			this.options.timeoutMs ?? DEFAULT_CLASSIFIER_TIMEOUT_MS,
			signal,
			this.spec.label,
		);
		const classification = this.parse(response);
		const spend = decisionSpendFromResponse(response, this.backend, this.modelId, performance.now() - startedAt);
		return spend ? { ...classification, spend } : classification;
	}

	/** Strict parse of the canonical answer shapes (choice/score/noul). Malformed answers are errors. */
	parse(response: unknown): Classification {
		const label = this.spec.label;
		const answers = isRecord(response) && isRecord(response.answers) ? response.answers : undefined;
		if (!answers) throw new ClassifierError(`${label} response has no answers`);
		if (this.options.schema === 2) return this.parseV2(answers);
		const skillAnswer = typedAnswer(answers, "skill", "choice", label);
		const difficultyAnswer = typedAnswer(answers, "difficulty", "score", label);
		if (!skillAnswer || !difficultyAnswer) {
			throw new ClassifierError(`${label} response is missing the skill or difficulty answer`);
		}

		const skills: SkillProbability[] = [];
		const probabilities = probabilityMap(skillAnswer, `${label} skill`);
		if (probabilities) {
			for (const [skill, prob] of Object.entries(probabilities)) {
				if (skill !== OTHER_SKILL && this.skillNames.has(skill) && prob >= this.options.skillThreshold) {
					skills.push({ skill, prob });
				}
			}
		}
		const choice = typeof skillAnswer.choice === "string" ? skillAnswer.choice : undefined;
		if (!probabilities && choice === undefined) throw new ClassifierError(`${label} skill answer has no choice`);
		if (skills.length === 0 && choice && choice !== OTHER_SKILL && this.skillNames.has(choice)) {
			skills.push({ skill: choice, prob: 1 });
		}
		skills.sort((a, b) => b.prob - a.prob || a.skill.localeCompare(b.skill));
		skills.splice(this.options.maxSecondarySkills + 1);

		const score = finite(difficultyAnswer.score);
		if (score === undefined) throw new ClassifierError(`${label} difficulty answer has no score`);
		// Positions run 0..levels-1; normalize by the top position.
		const difficulty = clamp01(score / (DIFFICULTY_LEVELS.length - 1));

		const confidences = [
			answerConfidence(skillAnswer, probabilities),
			answerConfidence(difficultyAnswer, probabilityMap(difficultyAnswer, `${label} difficulty`)),
		].filter((value): value is number => value !== undefined);
		const confidence = confidences.length > 0 ? clamp01(Math.min(...confidences)) : 0.5;

		const toolsAnswer = typedAnswer(answers, "needs_tools", "noul", label);
		const noul = toolsAnswer ? finite(toolsAnswer.noul) : undefined;
		return { skills, difficulty, confidence, needsTools: noul !== undefined && noul >= 0.5 };
	}

	private parseV2(answers: Record<string, unknown>): Classification {
		const label = this.spec.label;
		const task = typedAnswer(answers, "task", "choice", label);
		const difficultyAnswer = typedAnswer(answers, "difficulty", "score", label);
		if (!task || !difficultyAnswer) {
			throw new ClassifierError(`${label} response is missing the task or difficulty answer`);
		}
		const taskProbabilities = probabilityMap(task, `${label} task`);
		let choice = typeof task.choice === "string" ? task.choice : undefined;
		if (!choice && taskProbabilities) {
			choice = Object.entries(taskProbabilities).sort((a, b) => b[1] - a[1])[0]?.[0];
		}
		const option = choice ? TASK_OPTIONS[choice] : undefined;
		if (!option || !choice) throw new ClassifierError(`${label} task answer has no known choice`);
		// Too spread to route on: the router falls back rather than guessing.
		const top = taskProbabilities?.[choice];
		if (top !== undefined && top < ROUTE_MIN_TASK_PROBABILITY) {
			throw new ClassifierError(`${label} task answer too uncertain (top ${top.toFixed(2)})`);
		}
		const score = finite(difficultyAnswer.score);
		if (score === undefined) throw new ClassifierError(`${label} difficulty answer has no score`);
		const difficulty = clamp01(score / (DIFFICULTY_LEVELS_V2.length - 1));
		const confidences = [
			answerConfidence(task, taskProbabilities),
			answerConfidence(difficultyAnswer, probabilityMap(difficultyAnswer, `${label} difficulty`)),
		].filter((value): value is number => value !== undefined);
		const confidence = confidences.length > 0 ? clamp01(Math.min(...confidences)) : 0.5;
		const noul = (name: string) => {
			const answer = typedAnswer(answers, name, "noul", label);
			const value = answer ? finite(answer.noul) : undefined;
			return value === undefined ? undefined : clamp01(value);
		};
		const lengthAnswer = typedAnswer(answers, "output_length", "score", label);
		const lengthScore = lengthAnswer ? finite(lengthAnswer.score) : undefined;
		return {
			skills: kindSkill(this.options, option.kind, confidence, this.skillNames),
			difficulty,
			confidence,
			needsTools: (noul("needs_tools") ?? 0) >= 0.5,
			kind: option.kind,
			followUp: (noul("follow_up") ?? 0) >= 0.5,
			outputLength:
				lengthScore === undefined ? undefined : Math.min(OUTPUT_LENGTH_LEVELS.length - 1, Math.max(0, lengthScore)),
			ambiguity: noul("ambiguity"),
		};
	}
}

const TASK_CRITERIA = taskCriteria();

/** Jev on TypeSafe: POST {base}/v1/systemone. */
export class JevClassifier extends SystemOneClassifier {
	constructor(options: ClassifierOptions) {
		super(options, {
			backend: "jev",
			label: "Jev",
			defaultModel: JEV_DEFAULT_MODEL,
			defaultBaseUrl: JEV_DEFAULT_BASE_URL,
			path: "/v1/systemone",
		});
	}
}

/**
 * A decision model on OpenRouter: POST {base}/systemone (base https://openrouter.ai/api/v1) with the same request
 * and answers as Jev. A chat model is never sent: a legacy chat default is replaced by the decision default.
 */
export class OpenRouterClassifier extends SystemOneClassifier {
	constructor(options: ClassifierOptions) {
		super(
			{ ...options, model: decisionModelOrDefault(options.model) },
			{
				backend: "openrouter",
				label: "OpenRouter",
				defaultModel: OPENROUTER_DEFAULT_MODEL,
				defaultBaseUrl: OPENROUTER_DEFAULT_BASE_URL,
				path: "/systemone",
				headers: { "HTTP-Referer": "https://github.com/LyJonathan/RunKiln", "X-Title": "RunKiln router" },
			},
		);
	}
}

/** The model to send to OpenRouter's Decisions API: `model` unless it is a known chat model, else the default. */
export function decisionModelOrDefault(model: string | undefined): string {
	return model && !LEGACY_CHAT_CLASSIFIER_MODELS.has(model) ? model : OPENROUTER_DEFAULT_MODEL;
}

// ---------------------------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------------------------

export type ClassifierChoice = ClassifierBackend | "auto" | "off";

export interface ClassifierConfig {
	/**
	 * "auto" picks Jev when a Jev key is available (TYPESAFE_API_KEY, else the saved router key), else
	 * OpenRouter when an OpenRouter key is available.
	 */
	classifier?: ClassifierChoice;
	jev?: { model?: string; baseUrl?: string };
	openrouter?: { model?: string; baseUrl?: string };
	timeoutMs?: number;
}

export interface ClassifierResolution {
	classifier?: RouterClassifier;
	/** Why there is no classifier, or why the configured one could not be built. */
	problem?: string;
}

/** Classifier keys saved by setup / `/key` in `~/.runkiln/agent/router-keys.json`. */
export interface StoredClassifierKeys {
	jev?: string;
	openrouter?: string;
}

export type StoredClassifierKeysSource = StoredClassifierKeys | (() => StoredClassifierKeys);

export const CLASSIFIER_KEY_ENV: Record<ClassifierBackend, string> = {
	jev: JEV_API_KEY_ENV,
	openrouter: OPENROUTER_API_KEY_ENV,
};

export type ClassifierKeySource = "environment" | "file";

/**
 * The key a backend would use: its environment variable first, then the saved router key.
 * Callers must not print it.
 */
export function resolveClassifierKey(
	backend: ClassifierBackend,
	env: NodeJS.ProcessEnv,
	stored: StoredClassifierKeys,
): { apiKey: string; source: ClassifierKeySource } | undefined {
	const envKey = env[CLASSIFIER_KEY_ENV[backend]]?.trim();
	if (envKey) return { apiKey: envKey, source: "environment" };
	const fileKey = stored[backend]?.trim();
	if (fileKey) return { apiKey: fileKey, source: "file" };
	return undefined;
}

/** The backend "auto" resolves to: Jev when it has a key, else OpenRouter when it has one. */
export function resolveClassifierBackend(
	choice: ClassifierChoice,
	env: NodeJS.ProcessEnv,
	stored: StoredClassifierKeys,
): ClassifierBackend | undefined {
	if (choice === "off") return undefined;
	if (choice !== "auto") return choice;
	if (resolveClassifierKey("jev", env, stored)) return "jev";
	if (resolveClassifierKey("openrouter", env, stored)) return "openrouter";
	return undefined;
}

export function createClassifier(
	config: ClassifierConfig,
	catalog: {
		skills: readonly RouterSkill[];
		skillThreshold: number;
		maxSecondarySkills: number;
		/** 2 for quality selection (router v2). */
		schema?: 1 | 2;
		kindSkills?: Partial<Record<TaskKind, string>>;
	},
	env: NodeJS.ProcessEnv = process.env,
	fetchImpl?: typeof globalThis.fetch,
	storedKeys: StoredClassifierKeysSource = {},
): ClassifierResolution {
	const choice = config.classifier ?? "auto";
	if (choice === "off") return { problem: "router classifier is off" };
	let stored: StoredClassifierKeys;
	try {
		stored = typeof storedKeys === "function" ? storedKeys() : storedKeys;
	} catch {
		stored = {};
	}
	const backend = resolveClassifierBackend(choice, env, stored);
	if (!backend) {
		return {
			problem: `no classifier key: set ${JEV_API_KEY_ENV} (Jev) or ${OPENROUTER_API_KEY_ENV} (OpenRouter), or run /setup keys`,
		};
	}
	const apiKey = resolveClassifierKey(backend, env, stored)?.apiKey;
	if (!apiKey) {
		return {
			problem: `${backend} classifier needs ${CLASSIFIER_KEY_ENV[backend]} or a saved router key (/setup keys)`,
		};
	}
	const common = {
		apiKey,
		timeoutMs: config.timeoutMs,
		skills: catalog.skills,
		skillThreshold: catalog.skillThreshold,
		maxSecondarySkills: catalog.maxSecondarySkills,
		schema: catalog.schema,
		kindSkills: catalog.kindSkills,
		fetch: fetchImpl,
	};
	try {
		return {
			classifier:
				backend === "jev"
					? new JevClassifier({ ...common, model: config.jev?.model, baseUrl: config.jev?.baseUrl })
					: new OpenRouterClassifier({
							...common,
							model: config.openrouter?.model,
							baseUrl: config.openrouter?.baseUrl,
						}),
		};
	} catch (error) {
		return { problem: errorText(error) };
	}
}
