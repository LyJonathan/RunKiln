/**
 * ModelRouter: picks the model and thinking level for each request of one session.
 *
 * Overhead stays low: the classifier runs only on a new user turn (never on tool continuations), and a
 * recent identical request reuses the cached answer. Within a tool loop the turn's decision is kept;
 * it is re-selected (still without a classifier call) only when new failures raise the difficulty.
 * Momentum escalates at once and de-escalates slowly across turns.
 *
 * When the classifier fails or is not configured, the router does not guess: it keeps the previous
 * decision, or uses the default model when there is none, and says so in the decision.
 */

import { createHash } from "node:crypto";
import { type Api, getSupportedThinkingLevels, type Model, type ModelThinkingLevel } from "@runkiln/ai";
import type { DecisionSpend } from "../usage/decision-spend.ts";
import {
	DEFAULT_ROUTER_MODE,
	type RouterCatalog,
	type RouterMode,
	type RouterModelScores,
	resolveModeConfig,
	type TaskKind,
} from "./catalog.ts";
import { fastPath } from "./fast-path.ts";
import { ModelHealth } from "./health.ts";
import {
	closestBenchedModel,
	type QualityCandidate,
	type QualityModeConfig,
	type QualitySelectInput,
	selectByQuality,
} from "./quality-select.ts";
import { type CandidateModel, effectiveDifficulty, NoRouteError, selectModel } from "./select.ts";
import { LONG_LOOP_THRESHOLD } from "./signals.ts";
import { clampToBand, clampToSupported } from "./thinking.ts";
import type {
	Classification,
	ClassifierBackend,
	ClassifierInput,
	DecisionSource,
	DifficultyBoost,
	RouterClassifier,
	Selection,
	SkillProbability,
	TurnSignals,
} from "./types.ts";

export interface RouteRequest {
	signals: TurnSignals;
	role: "code" | "chat";
	/** Tools are declared to the model in this session. */
	toolsActive: boolean;
	/** Thinking level the user pinned; overrides the router's level (clamped to the chosen model). */
	pinnedThinking?: ModelThinkingLevel;
	/** Routing mode: low (cost-efficient), medium (default), high (deepest). */
	mode?: RouterMode;
}

export interface RouteDecision {
	model: Model<Api>;
	/** Level sent: the pinned level when there is one, else the router's, clamped to the model. */
	thinkingLevel: ModelThinkingLevel;
	/** Level the router chose for this model. */
	routerThinkingLevel: ModelThinkingLevel;
	thinkingPinned: boolean;
	mode: RouterMode;
	source: DecisionSource;
	backend?: ClassifierBackend;
	classifierModel?: string;
	classification?: Classification;
	/** Classifier difficulty for this turn. */
	rawDifficulty?: number;
	/** After momentum and boosts (before the low-confidence boost in selection). */
	difficulty?: number;
	momentumApplied: boolean;
	/**
	 * The mode's trivial-turn policy applied (trivial_below): cheapest feasible model, lowest level the
	 * mode's min_thinking allows, momentum ignored for this selection.
	 */
	trivial: boolean;
	boosts: DifficultyBoost[];
	selection?: Selection;
	/** Quality selection: the task kind routed on. */
	kind?: TaskKind;
	/** Quality selection: this turn continues the previous one and inherited its classification. */
	followUp?: boolean;
	/** Quality selection: a follow-up that inherited the work anchor (the last substantive task), not the previous turn. */
	anchored?: boolean;
	/** Quality selection: escalation steps applied after failures (0: none). */
	escalationSteps?: number;
	estCostUsd?: number;
	classifierMs?: number;
	/** Why the classifier gave no answer (fallback decisions). */
	error?: string;
	/** Failover decisions: the model that failed this turn. */
	failoverFrom?: string;
	previousModelId?: string;
	switched: boolean;
	at: number;
}

export interface RouterStats {
	classifierCalls: number;
	cacheHits: number;
	classifierFailures: number;
	continuations: number;
	escalations: number;
	fallbacks: number;
	/** New turns kept on the warm pair without a classifier call (it wins for every kind and difficulty). */
	warmSkips: number;
}

export interface ModelRouterOptions {
	catalog: RouterCatalog;
	classifier?: RouterClassifier;
	/** Why there is no classifier (shown in fallbacks). */
	classifierProblem?: string;
	/** Concrete models the session may use. */
	getModels: () => readonly Model<Api>[];
	/** Model used when the classifier fails before any decision exists. */
	defaultModelId: () => string | undefined;
	/** Default thinking level for a model when nothing else decides (its harness effort). */
	defaultThinkingLevel?: (model: Model<Api>) => ModelThinkingLevel | undefined;
	cacheTtlMs?: number;
	cacheSize?: number;
	now?: () => number;
	/** Shared model health (the session's). Default: a private one with router.yaml's cooldown. */
	health?: ModelHealth;
}

/** The turn's failover: every request until the session ends it goes to this model and level. */
interface FailoverPin {
	from: string;
	modelId: string;
	level: ModelThinkingLevel;
}

interface HeldDecision {
	mode: RouterMode;
	classification: Classification;
	/** Difficulty after momentum, before boosts. */
	baseDifficulty: number;
	appliedBoost: number;
	modelId: string;
	routerThinkingLevel: ModelThinkingLevel;
	trivial: boolean;
	selection?: Selection;
	backend?: ClassifierBackend;
	at: number;
	/** Quality selection: the turn's kind, the pair it started on, and the steps applied. */
	kind?: TaskKind;
	turnStart?: { model: string; level: ModelThinkingLevel };
	steps?: number;
	inTurnSteps?: number;
	followUp?: boolean;
}

/**
 * The work in progress: the last substantive classified turn (a task kind other than chat, above the trivial policy,
 * from the classifier or its cache, not itself a follow-up). Acks, approvals, retries and follow-ups never replace it,
 * so "ok thanks" then "go on" continues the work, not the trivial ack.
 */
interface WorkAnchor {
	classification: Classification;
	baseDifficulty: number;
	kind: TaskKind;
	modelId: string;
	routerThinkingLevel: ModelThinkingLevel;
	backend?: ClassifierBackend;
	at: number;
}

interface Momentum {
	difficulty: number;
	skills: SkillProbability[];
	at: number;
}

const DEFAULT_CACHE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_CACHE_SIZE = 128;

export class ModelRouter {
	readonly catalog: RouterCatalog;
	readonly classifier?: RouterClassifier;
	readonly classifierProblem?: string;
	private readonly options: ModelRouterOptions;
	private readonly cache = new Map<string, { at: number; classification: Classification }>();
	private healthValue: ModelHealth;
	private failoverPin?: FailoverPin;
	private held?: HeldDecision;
	/** Quality selection: the work in progress (see WorkAnchor). Cleared with the held decision on idle and reset. */
	private anchor?: WorkAnchor;
	private momentum?: Momentum;
	private lastDecisionValue?: RouteDecision;
	private modelFilter?: (model: Model<Api>) => boolean;
	/** Quality selection: consecutive failed turns (resets when a turn ends well). */
	private failStreak = 0;
	/**
	 * Warmth ledger: per (model, thinking level) pair, the prompt tokens of its last request on this session and when.
	 * RunInfra keeps each pair's cache on the session for the idle TTL, so a pair used recently is warm up to there.
	 */
	private readonly warmth = new Map<string, { tokens: number; at: number }>();
	/** The prompt cache was lost (compaction): the next new turn is a free switch point. */
	private cacheLostPending = false;
	/** Time between new turns on this session (see turnIntervalMs). */
	private turnPace = { totalMs: 0, count: 0 };
	private lastTurnAt?: number;
	/** New user turns routed on this session (this one included). */
	private turnsRouted = 0;
	/** Classifier calls in flight, by cache key (prefetch() and route() share one call). */
	private readonly inflight = new Map<string, Promise<Classification>>();
	/** Called once per billed classifier call (prefetches included; cached answers are not billed again). */
	onClassifierSpend?: (spend: DecisionSpend) => void;
	readonly stats: RouterStats = {
		classifierCalls: 0,
		warmSkips: 0,
		cacheHits: 0,
		classifierFailures: 0,
		continuations: 0,
		escalations: 0,
		fallbacks: 0,
	};

	constructor(options: ModelRouterOptions) {
		this.options = options;
		this.catalog = options.catalog;
		this.classifier = options.classifier;
		this.classifierProblem = options.classifierProblem;
		this.healthValue =
			options.health ??
			new ModelHealth({
				cooldownMs: () => this.catalog.tuning.failedModelCooldownSec * 1000,
				now: () => this.now(),
			});
	}

	/** Model health the router consults: models cooling down are never candidates. */
	get health(): ModelHealth {
		return this.healthValue;
	}

	/** Share the session's model health (so side tasks and the router agree on which model is down). */
	setHealth(health: ModelHealth): void {
		this.healthValue = health;
	}

	/**
	 * Restrict the models this router may use, on top of `getModels`. The session sets it so every
	 * router, built in or injected (SDK, tests), honors the `disabledModels` setting.
	 */
	setModelFilter(filter: ((model: Model<Api>) => boolean) | undefined): void {
		this.modelFilter = filter;
	}

	/** `getModels`, minus models the model filter rejects. */
	availableModels(): readonly Model<Api>[] {
		const models = this.options.getModels();
		const filter = this.modelFilter;
		return filter ? models.filter((model) => filter(model)) : models;
	}

	get lastDecision(): RouteDecision | undefined {
		return this.lastDecisionValue;
	}

	private now(): number {
		return this.options.now?.() ?? Date.now();
	}

	/** Skip a model whose request failed, for the cooldown (settings failover.cooldownSec, else router.yaml). */
	markModelFailed(modelId: string, error?: string): void {
		this.healthValue.markFailed(modelId, error);
		if (this.held?.modelId === modelId) this.held = { ...this.held, appliedBoost: -1 };
	}

	/**
	 * The model to fail over to when `fromModelId` keeps failing: another routable, enabled, healthy model
	 * that fits the request (vision, context), at the level equivalent to `level`. Only models the live
	 * catalog lists as available are candidates (paused and gone models never are). Benched models come
	 * first (unbenchedModelIds: no quality curves, or no router.yaml scores under score selection), so an
	 * unbenched model is a last resort, then the higher intelligence, then the lower output price.
	 * Undefined when there is none.
	 *
	 * Equivalent level: the same level when the target supports it, else the next higher one, else the next
	 * lower (clampToSupported). For the RunInfra pair: GLM low/high/max map to DeepSeek low/high/max, and
	 * DeepSeek none/xhigh map to GLM low/max.
	 */
	failoverTarget(
		fromModelId: string,
		level: ModelThinkingLevel,
		needs: { hasImages?: boolean; contextTokens?: number } = {},
	): { model: Model<Api>; thinkingLevel: ModelThinkingLevel } | undefined {
		const routable = this.candidateModels();
		const unbenched = new Set(this.unbenchedModelIds());
		const benched = (id: string) => !unbenched.has(id);
		const candidates = routable
			.filter((entry) => entry.model.id !== fromModelId)
			.filter((entry) => !needs.hasImages || entry.candidate.vision)
			.filter((entry) => !needs.contextTokens || entry.candidate.contextWindow >= needs.contextTokens)
			.sort(
				(a, b) =>
					Number(benched(b.model.id)) - Number(benched(a.model.id)) ||
					b.candidate.intelligence - a.candidate.intelligence ||
					a.candidate.priceOut - b.candidate.priceOut,
			);
		const target = candidates[0];
		if (!target) return undefined;
		return { model: target.model, thinkingLevel: clampToSupported(level, target.candidate.supportedThinking) };
	}

	/**
	 * Fail over for the rest of the turn: `from` cools down and every request goes to `to` at `level`
	 * until endFailover() (the session calls it when the turn ends).
	 */
	startFailover(from: string, to: string, level: ModelThinkingLevel, error?: string): void {
		this.markModelFailed(from, error);
		this.failoverPin = { from, modelId: to, level };
	}

	/** A failover is pinning this turn's requests to another model. */
	get failingOver(): boolean {
		return this.failoverPin !== undefined;
	}

	endFailover(): void {
		this.failoverPin = undefined;
	}

	get activeFailover(): { from: string; to: string; level: ModelThinkingLevel } | undefined {
		const pin = this.failoverPin;
		return pin ? { from: pin.from, to: pin.modelId, level: pin.level } : undefined;
	}

	/** The pinned failover decision, or undefined (and the pin dropped) when its model became unusable. */
	private failoverDecision(request: RouteRequest): RouteDecision | undefined {
		const pin = this.failoverPin;
		if (!pin) return undefined;
		const model = this.candidateModels().find((entry) => entry.model.id === pin.modelId)?.model;
		if (!model) {
			this.failoverPin = undefined;
			return undefined;
		}
		const held = this.held;
		return this.finish({
			model,
			request,
			routerThinkingLevel: pin.level,
			source: "failover",
			backend: held?.backend,
			classification: held?.classification,
			difficulty: held ? Math.min(1, held.baseDifficulty + held.appliedBoost) : undefined,
			momentumApplied: false,
			boosts: this.boosts(request.signals),
			kind: held?.kind,
			failoverFrom: pin.from,
		});
	}

	/** True when another routable model is available besides `modelId`. */
	hasAlternative(modelId: string): boolean {
		return this.candidateModels().some((entry) => entry.model.id !== modelId);
	}

	/** Forget momentum and the held decision (new session, or after /new). */
	reset(): void {
		this.held = undefined;
		this.anchor = undefined;
		this.failoverPin = undefined;
		this.momentum = undefined;
		this.lastDecisionValue = undefined;
		this.failStreak = 0;
		this.warmth.clear();
		this.cacheLostPending = false;
		this.turnPace = { totalMs: 0, count: 0 };
		this.lastTurnAt = undefined;
		this.turnsRouted = 0;
	}

	/** The session replaced its prompt prefix (compaction): every pair is cold, the next turn may switch for free. */
	cacheLost(): void {
		this.warmth.clear();
		this.cacheLostPending = true;
	}

	/**
	 * Cached tokens a pair would get now: its last prompt on this session, rounded down to RunInfra's 128-token
	 * blocks less one (the tail block is recomputed), or 0 past the cache TTL. Undefined when nothing is recorded
	 * (a router that has not sent anything yet: the transcript's warm pair counts as warm, as before).
	 */
	warmTokens(model: string, level: ModelThinkingLevel, now = this.now()): number | undefined {
		if (this.warmth.size === 0) return undefined;
		const entry = this.warmth.get(`${model}:${level}`);
		const ttlMs = (this.catalog.quality?.cache.ttlSec ?? 900) * 1000;
		if (!entry || now - entry.at > ttlMs) return 0;
		return Math.max(0, Math.floor(entry.tokens / 128) * 128 - 128);
	}

	/** Mean time between new turns on this session (gaps past the cache TTL are breaks and do not count). */
	turnIntervalMs(): number | undefined {
		return this.turnPace.count > 0 ? this.turnPace.totalMs / this.turnPace.count : undefined;
	}

	private recordTurnStart(now: number): void {
		this.turnsRouted++;
		const last = this.lastTurnAt;
		this.lastTurnAt = now;
		if (last === undefined) return;
		const ttlMs = (this.catalog.quality?.cache.ttlSec ?? 900) * 1000;
		if (now - last > ttlMs) return;
		this.turnPace.totalMs += now - last;
		this.turnPace.count++;
	}

	/** Whether the prompt cache is gone anyway for the next new turn: nothing routed yet, compaction or idle past the TTL. */
	private freeSwitchPoint(now: number): boolean {
		if (!this.held || this.cacheLostPending) return true;
		const ttlMs = (this.catalog.quality?.cache.ttlSec ?? 900) * 1000;
		let newest = 0;
		for (const entry of this.warmth.values()) newest = Math.max(newest, entry.at);
		return newest > 0 && now - newest > ttlMs;
	}

	/** True when this router selects by quality curves (router v2). */
	get usesQuality(): boolean {
		return this.catalog.selection === "quality" && !!this.catalog.quality;
	}

	/** Routable models: in router.yaml, `route` not false, available, not cooling down. */
	candidateModels(): Array<{ model: Model<Api>; candidate: CandidateModel }> {
		const result: Array<{ model: Model<Api>; candidate: CandidateModel }> = [];
		const available = this.availableModels();
		for (const model of available) {
			const scores = this.scoresFor(model, available);
			if (!scores.route) continue;
			if (!this.healthValue.isHealthy(model.id)) continue;
			result.push({
				model,
				candidate: {
					id: model.id,
					priceIn: model.cost.input,
					priceOut: model.cost.output,
					priceCachedIn: model.cost.cacheRead,
					contextWindow: model.contextWindow,
					vision: model.input.includes("image"),
					intelligence: scores.intelligence,
					skills: scores.skills,
					supportedThinking: getSupportedThinkingLevels(model),
					maxAutoThinking: this.catalog.models[model.id]?.maxAutoThinking,
					autoOffBelow: this.catalog.models[model.id]?.autoOffBelow,
				},
			});
		}
		return result;
	}

	/**
	 * Quality candidates: each model with its own curves, or (unbenched) the closest benched model's to
	 * borrow, discounted in pairQuality by the skill offset and quality.unbenched_penalty.
	 */
	private qualityCandidates(candidates: readonly CandidateModel[]): QualityCandidate[] {
		const quality = this.catalog.quality;
		if (!quality) return [...candidates];
		const hasCurves = (id: string) => Object.keys(quality.models[id]?.levels ?? {}).length > 0;
		const benched = candidates.filter((candidate) => hasCurves(candidate.id));
		return candidates.map((candidate): QualityCandidate => {
			if (hasCurves(candidate.id)) return { ...candidate, curves: quality.models[candidate.id] };
			const lender = closestBenchedModel(candidate, benched, quality);
			const curves = lender ? quality.models[lender] : undefined;
			if (!lender || !curves) return { ...candidate };
			return { ...candidate, borrowFrom: { id: lender, curves, scores: this.catalog.models[lender]?.skills } };
		});
	}

	/**
	 * Unbenched models among `models`: no quality curves of their own (quality selection), or no router.yaml
	 * skill scores (score selection), among those auto routing may use (route not false). Auto routing treats
	 * them as a last resort; manual use is unaffected.
	 */
	unbenchedModelIds(models: readonly Model<Api>[] = this.availableModels()): string[] {
		const quality = this.usesQuality ? this.catalog.quality : undefined;
		return models
			.filter((model) => {
				const scores = this.scoresFor(model, models);
				if (!scores.route) return false;
				return quality ? Object.keys(quality.models[model.id]?.levels ?? {}).length === 0 : scores.derived;
			})
			.map((model) => model.id);
	}

	/**
	 * Scores from router.yaml, or defaults for a model it does not score (a new RunInfra model):
	 * unknown_model.skill_score for every skill plus a price prior relative to the scored models.
	 */
	scoresFor(
		model: Model<Api>,
		available: readonly Model<Api>[] = this.availableModels(),
	): RouterModelScores & {
		derived: boolean;
	} {
		const listed = this.catalog.models[model.id];
		if (listed && (!listed.route || Object.keys(listed.skills).length > 0)) return { ...listed, derived: false };
		const unknown = this.catalog.unknownModel;
		const scoredPrices = available
			.filter((candidate) => Object.keys(this.catalog.models[candidate.id]?.skills ?? {}).length > 0)
			.map((candidate) => candidate.cost.output)
			.filter((price) => price > 0)
			.sort((a, b) => a - b);
		const reference = scoredPrices.length > 0 ? scoredPrices[Math.floor(scoredPrices.length / 2)] : 0;
		const prior =
			reference > 0 && model.cost.output > 0 ? unknown.priceScaling * Math.log2(model.cost.output / reference) : 0;
		const score = Math.round(Math.min(unknown.maxScore, Math.max(unknown.minScore, unknown.skillScore + prior)));
		const skills: Record<string, number> = {};
		for (const skill of this.catalog.skills) skills[skill.name] = score;
		return {
			intelligence: listed?.intelligence || score,
			skills,
			route: listed?.route ?? unknown.route,
			derived: true,
		};
	}

	private cacheKey(request: RouteRequest): string {
		const hash = createHash("sha256");
		hash.update(
			JSON.stringify([
				this.catalog.version,
				this.classifier?.backend,
				this.classifier?.modelId,
				request.role,
				request.signals.hasImages,
				request.signals.latestUserText,
				// v2 asks about follow-ups, so the same words in another context are another question.
				this.usesQuality ? request.signals.recentContext : undefined,
				this.usesQuality && this.held ? [this.held.kind, this.held.baseDifficulty] : undefined,
			]),
		);
		return hash.digest("hex");
	}

	private cacheGet(key: string): Classification | undefined {
		const entry = this.cache.get(key);
		if (!entry) return undefined;
		if (this.now() - entry.at > (this.options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS)) {
			this.cache.delete(key);
			return undefined;
		}
		this.cache.delete(key);
		this.cache.set(key, entry);
		return entry.classification;
	}

	private cacheSet(key: string, classification: Classification): void {
		this.cache.delete(key);
		this.cache.set(key, { at: this.now(), classification });
		const max = this.options.cacheSize ?? DEFAULT_CACHE_SIZE;
		while (this.cache.size > max) {
			const oldest = this.cache.keys().next().value;
			if (oldest === undefined) break;
			this.cache.delete(oldest);
		}
	}

	/** Difficulty added for failures and effort seen in the current turn. */
	boosts(signals: TurnSignals): DifficultyBoost[] {
		const config = this.catalog.escalation;
		const boosts: DifficultyBoost[] = [];
		if (signals.toolErrorsThisTurn > 0) {
			boosts.push({
				reason: `${signals.toolErrorsThisTurn} tool error${signals.toolErrorsThisTurn === 1 ? "" : "s"}`,
				delta: Math.min(config.toolErrorCap, signals.toolErrorsThisTurn * config.toolError),
			});
		}
		if (signals.testFailuresThisTurn > 0) boosts.push({ reason: "failing tests", delta: config.testFailure });
		if (signals.userRetry) boosts.push({ reason: "user reports it still fails", delta: config.userRetry });
		if (signals.filesTouchedThisTurn >= 3) {
			boosts.push({ reason: `${signals.filesTouchedThisTurn} files edited`, delta: config.multiFile });
		}
		if (signals.toolCallsThisTurn >= LONG_LOOP_THRESHOLD)
			boosts.push({ reason: "long tool loop", delta: config.longLoop });
		return boosts.filter((boost) => boost.delta > 0);
	}

	async route(request: RouteRequest, signal?: AbortSignal): Promise<RouteDecision> {
		const failover = this.failoverDecision(request);
		if (failover) return failover;
		if (this.usesQuality) return this.routeQuality(request, signal);
		const now = this.now();
		const idleMs = this.catalog.tuning.sessionIdleResetMin * 60_000;
		if (this.momentum && now - this.momentum.at > idleMs) this.momentum = undefined;
		if (this.held && now - this.held.at > idleMs) this.held = undefined;

		const { signals } = request;
		const boosts = this.boosts(signals);
		const boostTotal = boosts.reduce((sum, boost) => sum + boost.delta, 0);

		const mode = request.mode ?? DEFAULT_ROUTER_MODE;
		// Tool continuation: keep the turn's decision unless new failures raised the difficulty
		// or the routing mode changed.
		if (!signals.isNewUserTurn && this.held) {
			const held = this.held;
			const heldModel = this.candidateModels().find((entry) => entry.model.id === held.modelId)?.model;
			if (held.mode !== mode) {
				return this.decide(request, held.classification, held.baseDifficulty, boosts, "reselect", {
					backend: held.backend,
					momentumApplied: false,
				});
			}
			if (heldModel && boostTotal <= held.appliedBoost + 1e-9) {
				this.stats.continuations++;
				held.at = now;
				return this.finish({
					model: heldModel,
					request,
					routerThinkingLevel: held.routerThinkingLevel,
					source: "continuation",
					backend: held.backend,
					classification: held.classification,
					difficulty: Math.min(1, held.baseDifficulty + held.appliedBoost),
					momentumApplied: false,
					trivial: held.trivial,
					boosts,
					selection: held.selection,
				});
			}
			this.stats.escalations++;
			return this.decide(request, held.classification, held.baseDifficulty, boosts, "escalation", {
				backend: held.backend,
				momentumApplied: false,
			});
		}

		let classification: Classification | undefined;
		let source: DecisionSource = "classifier";
		let error: string | undefined;
		let classifierMs: number | undefined;
		const key = this.cacheKey(request);
		const cached = this.cacheGet(key);
		if (cached) {
			classification = cached;
			source = "cache";
			this.stats.cacheHits++;
		} else if (this.classifier) {
			const started = Date.now();
			try {
				this.stats.classifierCalls++;
				classification = await this.classifier.classify(
					{
						request: signals.latestUserText,
						recentContext: signals.recentContext,
						hasImages: signals.hasImages,
						harness: {
							role: request.role,
							contextTokens: signals.contextTokens,
							toolErrorsThisTurn: signals.toolErrorsThisTurn,
							testFailuresThisTurn: signals.testFailuresThisTurn,
							filesTouchedThisTurn: signals.filesTouchedThisTurn,
						},
					},
					signal,
				);
				classifierMs = Date.now() - started;
				this.cacheSet(key, classification);
				this.reportSpend(classification);
			} catch (caught) {
				if (signal?.aborted) throw caught;
				this.stats.classifierFailures++;
				error = caught instanceof Error ? caught.message : String(caught);
			}
		} else {
			error = this.classifierProblem ?? "no classifier configured";
		}

		if (!classification) return this.fallback(request, boosts, error ?? "classifier failed");

		// Momentum, applied once per turn: escalate at once, de-escalate slowly.
		let baseDifficulty = classification.difficulty;
		let skills = classification.skills;
		let momentumApplied = false;
		if (this.momentum) {
			const carried = this.momentum.difficulty * this.catalog.tuning.momentumDecay;
			if (carried > baseDifficulty) {
				baseDifficulty = carried;
				momentumApplied = true;
				const merged = [...skills];
				for (const previous of this.momentum.skills) {
					if (merged.length > this.catalog.tuning.maxSecondarySkills) break;
					if (!merged.some((entry) => entry.skill === previous.skill)) {
						merged.push({ skill: previous.skill, prob: previous.prob * 0.5 });
					}
				}
				skills = merged;
			}
		}
		return this.decide(request, { ...classification, skills }, baseDifficulty, boosts, source, {
			backend: this.classifier?.backend,
			classifierMs,
			momentumApplied,
			rawDifficulty: classification.difficulty,
		});
	}

	// -------------------------------------------------------------------------------------------
	// Router v2: quality-curve selection
	// -------------------------------------------------------------------------------------------

	private classifierInput(request: RouteRequest): ClassifierInput {
		const { signals } = request;
		return {
			request: signals.latestUserText,
			recentContext: signals.recentContext,
			hasImages: signals.hasImages,
			previous: this.held?.kind ? { kind: this.held.kind, difficulty: this.held.baseDifficulty } : undefined,
			harness: {
				role: request.role,
				contextTokens: signals.contextTokens,
				toolErrorsThisTurn: signals.toolErrorsThisTurn,
				testFailuresThisTurn: signals.testFailuresThisTurn,
				filesTouchedThisTurn: signals.filesTouchedThisTurn,
			},
		};
	}

	/** Tell the listener what a fresh classifier answer cost. */
	private reportSpend(classification: Classification): void {
		if (!classification.spend) return;
		try {
			this.onClassifierSpend?.(classification.spend);
		} catch {
			// Accounting never changes a route.
		}
	}

	/** One classifier call per key: concurrent prefetch() and route() share it; answers are cached. */
	private classifyOnce(request: RouteRequest, key: string, signal?: AbortSignal): Promise<Classification> {
		const running = this.inflight.get(key);
		if (running) return running;
		const classifier = this.classifier;
		if (!classifier) return Promise.reject(new Error(this.classifierProblem ?? "no classifier configured"));
		this.stats.classifierCalls++;
		const promise = classifier.classify(this.classifierInput(request), signal).then((classification) => {
			this.cacheSet(key, classification);
			this.reportSpend(classification);
			return classification;
		});
		const tracked = promise.finally(() => this.inflight.delete(key));
		// The caller that awaits it handles a failure; a prefetch nobody awaits must not be unhandled.
		tracked.catch(() => {});
		this.inflight.set(key, tracked);
		return tracked;
	}

	/**
	 * Starts the classifier for a new user turn without waiting (call it before slower request preparation,
	 * such as the live-catalog refresh); route() then awaits the same call. No-op on tool continuations,
	 * cached requests, fast-path turns, the legacy selector, or without a classifier.
	 */
	prefetch(request: RouteRequest, signal?: AbortSignal): void {
		if (!this.usesQuality || !this.classifier || !request.signals.isNewUserTurn) return;
		const { signals } = request;
		const fast = fastPath(signals.latestUserText, signals.assistantAsked ?? false);
		if (fast === "ack" || ((fast === "approval" || fast === "retry") && this.held)) return;
		const key = this.cacheKey(request);
		if (this.cacheGet(key) || this.inflight.has(key)) return;
		void this.classifyOnce(request, key, signal).catch(() => {});
	}

	/** Steps for failures inside the current turn: 1 for a failing test or 2+ tool errors, 2 for more. */
	private inTurnSteps(signals: TurnSignals): number {
		const first = signals.testFailuresThisTurn > 0 || signals.toolErrorsThisTurn >= 2 ? 1 : 0;
		const second = signals.testFailuresThisTurn >= 2 || signals.toolErrorsThisTurn >= 4 ? 1 : 0;
		return Math.min(this.catalog.quality?.maxSteps ?? 2, first + second);
	}

	/**
	 * The previous turn failed: a request error, tests still failing at its end, repeated tool errors, or it ended
	 * with unfinished todo items without asking the user anything (it stopped before the work was done).
	 */
	private previousTurnFailed(signals: TurnSignals, retry: boolean): boolean {
		const previous = signals.previousTurn;
		const failed =
			!!previous &&
			(previous.errored ||
				(previous.testFailures > 0 && !previous.lastTestPassed) ||
				previous.toolErrors >= 3 ||
				((previous.unfinishedTodos ?? 0) > 0 && !signals.assistantAsked));
		return failed || signals.userRetry || retry;
	}

	private kindOf(classification: Classification): TaskKind {
		if (classification.kind) return classification.kind;
		// A v1 answer (skills only): map the primary skill onto a kind.
		const skill = classification.skills[0]?.skill ?? "";
		if (skill === "code.algo") return "algo";
		if (skill.startsWith("math") || skill === "reason.deep") return "math";
		if (skill === "agent" || skill === "tool.call") return "agentic";
		if (["code.ci", "code.docker", "code.devops", "code.build", "code.cli"].includes(skill)) return "terminal";
		if (skill.startsWith("code.")) return "code";
		return "chat";
	}

	private async routeQuality(request: RouteRequest, signal?: AbortSignal): Promise<RouteDecision> {
		const now = this.now();
		const cacheAware = this.catalog.quality?.cache.enabled ?? false;
		// Decided before the idle reset below drops the held decision: a free switch point is where the prompt
		// cache is lost anyway, so moving to another pair costs no extra miss.
		const freeSwitch = request.signals.isNewUserTurn && cacheAware && this.freeSwitchPoint(now);
		if (request.signals.isNewUserTurn) {
			this.recordTurnStart(now);
			this.cacheLostPending = false;
		}
		if (freeSwitch) this.warmth.clear();
		const idleMs = this.catalog.tuning.sessionIdleResetMin * 60_000;
		if (this.held && now - this.held.at > idleMs) {
			this.held = undefined;
			this.failStreak = 0;
		}
		// The anchor lives as long as the session's held decision: idle (or no held decision) drops it too.
		if (!this.held) this.anchor = undefined;
		const { signals } = request;
		const boosts = this.boosts(signals);
		const boostTotal = boosts.reduce((sum, boost) => sum + boost.delta, 0);
		const mode = request.mode ?? DEFAULT_ROUTER_MODE;

		// Tool continuation: keep the turn's pair unless failures in this turn call for a step up, new
		// boosts raised the difficulty, or the mode changed.
		if (!signals.isNewUserTurn && this.held) {
			const held = this.held;
			const heldModel = this.candidateModels().find((entry) => entry.model.id === held.modelId)?.model;
			const steps = this.inTurnSteps(signals);
			if (held.mode !== mode) {
				return this.decideQuality(request, held.classification, held.baseDifficulty, boosts, "reselect", {
					backend: held.backend,
					followUp: held.followUp,
					escalation:
						held.turnStart && (held.steps ?? 0) > 0 ? { ...held.turnStart, steps: held.steps ?? 0 } : undefined,
					keepTurnStart: true,
				});
			}
			// Cache-aware: inside a tool loop only hard failures (a failing test, repeated tool errors) leave the warm
			// pair; softer boosts (files edited, a long loop) wait for the next turn.
			if (heldModel && (cacheAware || boostTotal <= held.appliedBoost + 1e-9) && steps <= (held.inTurnSteps ?? 0)) {
				this.stats.continuations++;
				held.at = now;
				return this.finish({
					model: heldModel,
					request,
					routerThinkingLevel: held.routerThinkingLevel,
					source: "continuation",
					backend: held.backend,
					classification: held.classification,
					difficulty: Math.min(1, held.baseDifficulty + held.appliedBoost),
					momentumApplied: false,
					trivial: held.trivial,
					boosts,
					selection: held.selection,
					kind: held.kind,
					followUp: held.followUp,
					escalationSteps: held.steps,
				});
			}
			this.stats.escalations++;
			const from = held.turnStart ?? { model: held.modelId, level: held.routerThinkingLevel };
			const maxSteps = this.catalog.quality?.maxSteps ?? 2;
			const total = Math.min(maxSteps, (held.steps ?? 0) + steps);
			// Cache-aware: one jump, straight to the pair expected to finish (every step is a cache miss), and no
			// further step inside this turn.
			const jump = cacheAware && steps > 0 ? maxSteps : steps;
			return this.decideQuality(request, held.classification, held.baseDifficulty, boosts, "escalation", {
				backend: held.backend,
				followUp: held.followUp,
				escalation: total > 0 ? { ...from, steps: jump > 0 ? jump : (held.steps ?? 0) } : undefined,
				inTurnSteps: jump,
				keepTurnStart: true,
			});
		}

		const fast = signals.isNewUserTurn
			? fastPath(signals.latestUserText, signals.assistantAsked ?? false)
			: undefined;
		const previous = this.held;
		const failed = !!previous && signals.isNewUserTurn && this.previousTurnFailed(signals, fast === "retry");
		this.failStreak = failed ? this.failStreak + 1 : 0;
		const steps = failed ? Math.min(this.catalog.quality?.maxSteps ?? 2, this.failStreak) : 0;
		const escalation =
			steps > 0 && previous ? { model: previous.modelId, level: previous.routerThinkingLevel, steps } : undefined;

		// Obvious turns skip the classifier.
		if (fast === "ack") {
			return this.decideQuality(request, this.trivialClassification(), 0, boosts, "heuristic", {
				escalation,
				freeSwitch,
			});
		}
		if ((fast === "approval" || fast === "retry") && previous) {
			// The work being approved is the work in progress (the anchor), not an ack or a chat turn in between.
			const anchor = this.anchor;
			const base = anchor ?? previous;
			return this.decideQuality(request, base.classification, base.baseDifficulty, boosts, "follow-up", {
				backend: base.backend,
				followUp: true,
				anchored: !!anchor,
				escalation,
				freeSwitch,
			});
		}

		// The warm pair would be kept whatever the classifier says: skip the call (its latency is on the critical path).
		if (previous && !escalation && !freeSwitch && cacheAware && this.warmPairWinsEverywhere(request, boosts)) {
			this.stats.warmSkips++;
			return this.decideQuality(request, previous.classification, previous.baseDifficulty, boosts, "warm-skip", {
				backend: previous.backend,
				followUp: previous.followUp,
			});
		}

		let classification: Classification | undefined;
		let source: DecisionSource = "classifier";
		let error: string | undefined;
		let classifierMs: number | undefined;
		const key = this.cacheKey(request);
		const cached = this.cacheGet(key);
		if (cached) {
			classification = cached;
			source = "cache";
			this.stats.cacheHits++;
		} else if (this.classifier) {
			const started = Date.now();
			const wasRunning = this.inflight.has(key);
			try {
				classification = await this.classifyOnce(request, key, signal);
				classifierMs = Date.now() - started;
				if (wasRunning) source = "classifier";
			} catch (caught) {
				if (signal?.aborted) throw caught;
				this.stats.classifierFailures++;
				error = caught instanceof Error ? caught.message : String(caught);
			}
		} else {
			error = this.classifierProblem ?? "no classifier configured";
		}
		if (!classification) return this.fallback(request, boosts, error ?? "classifier failed");

		// Follow-ups inherit the previous turn's work; other turns stand on their own, except that an
		// ambiguous or low-confidence one keeps some of the previous difficulty (momentum).
		let baseDifficulty = classification.difficulty;
		let effective = classification;
		let followUp = false;
		let momentumApplied = false;
		const anchor = this.anchor;
		if (previous && classification.followUp) {
			followUp = true;
			// The anchor at full difficulty (chains of follow-ups do not decay), else the previous turn, decayed.
			const base = anchor ?? previous;
			const inherited = anchor ? anchor.baseDifficulty : previous.baseDifficulty * 0.9;
			baseDifficulty = Math.max(baseDifficulty, inherited);
			const kind = classification.kind === "chat" || !classification.kind ? base.kind : classification.kind;
			effective = {
				...classification,
				kind,
				skills: kind === base.kind ? base.classification.skills : classification.skills,
			};
		} else if (previous && ((classification.ambiguity ?? 0) >= 0.5 || classification.confidence < 0.5)) {
			// Momentum from the higher of the previous turn and the work in progress.
			const carried = Math.max(previous.baseDifficulty, anchor?.baseDifficulty ?? 0) * this.catalog.tuning.momentumDecay;
			if (carried > baseDifficulty) {
				baseDifficulty = carried;
				momentumApplied = true;
			}
		}
		const decision = this.decideQuality(request, effective, baseDifficulty, boosts, source, {
			backend: this.classifier?.backend,
			classifierMs,
			rawDifficulty: classification.difficulty,
			momentumApplied,
			followUp,
			anchored: followUp && !!anchor,
			escalation,
			freeSwitch,
		});
		// A substantive new task becomes the work in progress; follow-ups, chat and trivial turns keep the old one.
		if (!followUp && decision.source === source && !decision.trivial && decision.kind && decision.kind !== "chat") {
			this.anchor = {
				classification: { ...effective, kind: decision.kind },
				baseDifficulty,
				kind: decision.kind,
				modelId: decision.model.id,
				routerThinkingLevel: decision.routerThinkingLevel,
				backend: this.classifier?.backend,
				at: decision.at,
			};
		}
		return decision;
	}

	/** Warmth inputs of a quality selection: the held pair, the ledger, the session's pace. */
	private cacheInput(
		signals: TurnSignals,
		freeSwitch: boolean | undefined,
		mode: QualityModeConfig,
		prefer?: { model: string; level: ModelThinkingLevel },
	): Pick<
		QualitySelectInput,
		"heldModelId" | "heldThinkingLevel" | "freeSwitch" | "excursionMs" | "sessionUnderway" | "warmTokens"
	> {
		const horizonTurns = mode.cache?.horizonTurns ?? 3;
		// An anchored follow-up after a trivial excursion (an ack on a cheap pair): the work's pair is the one to keep
		// warm, when the ledger says it still is.
		if (prefer && (this.warmTokens(prefer.model, prefer.level) ?? 0) > 0) {
			return {
				heldModelId: prefer.model,
				heldThinkingLevel: prefer.level,
				freeSwitch,
				excursionMs: (this.turnIntervalMs() ?? 0) * horizonTurns,
				sessionUnderway: this.turnsRouted > 1,
				warmTokens: (model, level) => this.warmTokens(model, level) ?? 0,
			};
		}
		return {
			// The transcript's warm pair, else the pair this router sent last (the ledger says if it is still warm).
			heldModelId: signals.warmModelId ?? this.lastDecisionValue?.model.id,
			heldThinkingLevel: signals.warmModelId ? signals.warmThinkingLevel : this.lastDecisionValue?.thinkingLevel,
			freeSwitch,
			excursionMs: (this.turnIntervalMs() ?? 0) * horizonTurns,
			sessionUnderway: this.turnsRouted > 1,
			warmTokens: (model, level) =>
				this.warmTokens(model, level) ??
				(model === signals.warmModelId &&
				(signals.warmThinkingLevel === undefined || signals.warmThinkingLevel === level)
					? signals.contextTokens
					: 0),
		};
	}

	private qualityMode(resolved: ReturnType<typeof resolveModeConfig>, trivial: boolean): QualityModeConfig {
		const quality = this.catalog.quality;
		return {
			tolerance: resolved.tolerance ?? quality?.tolerance ?? 0,
			prefer: trivial ? "lowest" : resolved.thinking.prefer,
			floor: resolved.thinking.floor,
			ceiling: resolved.thinking.ceiling,
			maxAuto: resolved.thinking.maxAuto,
			cache: quality ? { ...quality.cache, ...resolved.cache } : undefined,
		};
	}

	/**
	 * Whether the warm pair is kept for every task kind, difficulty and answer length the classifier could return:
	 * then its answer cannot change the route. Checked on a grid (difficulty in eighths, every answer length level).
	 */
	private warmPairWinsEverywhere(request: RouteRequest, boosts: DifficultyBoost[]): boolean {
		const quality = this.catalog.quality;
		if (!quality) return false;
		const { signals } = request;
		const resolved = resolveModeConfig(this.catalog, request.mode ?? DEFAULT_ROUTER_MODE);
		const cacheInput = this.cacheInput(signals, false, this.qualityMode(resolved, false));
		if (!cacheInput.heldModelId) return false;
		const models = this.qualityCandidates(this.candidateModels().map((entry) => entry.candidate));
		const reference = this.catalog.models[quality.referenceModel]?.skills;
		const boostTotal = boosts.reduce((sum, boost) => sum + boost.delta, 0);
		const kinds = Object.keys(quality.kindSkills) as TaskKind[];
		const held = `${cacheInput.heldModelId}:${cacheInput.heldThinkingLevel}`;
		// Hard work first: that is where another pair usually wins, so a miss is found after a few selections.
		for (const trivial of [false, true]) {
			const mode = this.qualityMode(resolved, trivial);
			for (const kind of kinds.length > 0 ? kinds : (["code"] as TaskKind[])) {
				for (let step = 8; step >= 0; step--) {
					const difficulty = Math.min(1, step / 8 + (trivial ? 0 : boostTotal));
					for (const answerTokens of quality.answerTokens) {
						let selection: Selection;
						try {
							selection = selectByQuality(
								models,
								{
									...cacheInput,
									kind,
									difficulty,
									contextTokens: signals.contextTokens,
									answerTokens,
									needsVision: signals.hasImages,
								},
								mode,
								quality,
								reference,
							);
						} catch {
							return false;
						}
						const level = selection.candidates.find((c) => c.model === selection.modelId)?.thinkingLevel;
						const pair = `${selection.modelId}:${level}`;
						if (selection.cause !== "held_warm" && pair !== held) return false;
					}
				}
			}
		}
		return true;
	}

	private trivialClassification(): Classification {
		const skill = this.catalog.quality?.kindSkills.chat;
		return {
			skills: skill && this.catalog.skills.some((entry) => entry.name === skill) ? [{ skill, prob: 1 }] : [],
			difficulty: 0,
			confidence: 1,
			needsTools: false,
			kind: "chat",
			outputLength: 0,
			ambiguity: 0,
		};
	}

	private decideQuality(
		request: RouteRequest,
		classification: Classification,
		baseDifficulty: number,
		boosts: DifficultyBoost[],
		source: DecisionSource,
		extra: {
			backend?: ClassifierBackend;
			classifierMs?: number;
			rawDifficulty?: number;
			momentumApplied?: boolean;
			followUp?: boolean;
			/** A follow-up that inherited the work anchor. */
			anchored?: boolean;
			escalation?: { model: string; level: ModelThinkingLevel; steps: number };
			inTurnSteps?: number;
			keepTurnStart?: boolean;
			/** The prompt cache is lost anyway: no pair is held. */
			freeSwitch?: boolean;
		},
	): RouteDecision {
		const quality = this.catalog.quality;
		if (!quality) throw new Error("quality selection without a quality section");
		const { signals } = request;
		const mode = request.mode ?? DEFAULT_ROUTER_MODE;
		const resolved = resolveModeConfig(this.catalog, mode);
		const { tuning, thinking } = resolved;
		const boostTotal = boosts.reduce((sum, boost) => sum + boost.delta, 0);
		const difficulty = Math.min(1, baseDifficulty + boostTotal);
		const effective = effectiveDifficulty(difficulty, classification.confidence, tuning);
		const turnDifficulty = Math.min(1, classification.difficulty + boostTotal);
		const trivial =
			!extra.followUp &&
			resolved.trivialBelow > 0 &&
			effectiveDifficulty(turnDifficulty, classification.confidence, tuning) < resolved.trivialBelow;
		const kind = this.kindOf(classification);
		const length = classification.outputLength;
		const answerTokens =
			length === undefined
				? quality.defaultAnswerTokens
				: quality.answerTokens[Math.min(quality.answerTokens.length - 1, Math.max(0, Math.round(length)))];
		const candidates = this.candidateModels();
		let selection: Selection;
		try {
			selection = selectByQuality(
				this.qualityCandidates(candidates.map((entry) => entry.candidate)),
				{
					...this.cacheInput(
						signals,
						extra.freeSwitch,
						this.qualityMode(resolved, trivial),
						extra.anchored && this.anchor && (this.held?.trivial || this.held?.kind === "chat")
							? { model: this.anchor.modelId, level: this.anchor.routerThinkingLevel }
							: undefined,
					),
					kind,
					difficulty: trivial ? Math.min(effective, turnDifficulty) : effective,
					contextTokens: signals.contextTokens,
					answerTokens,
					needsVision: signals.hasImages,
					escalation: extra.escalation,
				},
				this.qualityMode(resolved, trivial),
				quality,
				this.catalog.models[quality.referenceModel]?.skills,
			);
		} catch (caught) {
			if (!(caught instanceof NoRouteError)) throw caught;
			return this.fallback(request, boosts, caught.message);
		}
		const chosen = candidates.find((entry) => entry.model.id === selection.modelId);
		if (!chosen) return this.fallback(request, boosts, "selected model is unavailable");
		const report = selection.candidates.find((candidate) => candidate.model === selection.modelId);
		const routerThinkingLevel = report?.thinkingLevel ?? "off";
		const steps = selection.quality?.steps ?? 0;
		const previousStart = this.held?.turnStart;
		this.momentum = { difficulty, skills: classification.skills, at: this.now() };
		this.held = {
			mode,
			classification: { ...classification, kind },
			baseDifficulty,
			appliedBoost: boostTotal,
			modelId: chosen.model.id,
			routerThinkingLevel,
			trivial,
			selection,
			backend: extra.backend,
			at: this.now(),
			kind,
			turnStart:
				extra.keepTurnStart && previousStart
					? previousStart
					: { model: chosen.model.id, level: routerThinkingLevel },
			steps: extra.keepTurnStart ? (this.held?.steps ?? 0) : steps,
			inTurnSteps: extra.inTurnSteps ?? 0,
			followUp: extra.followUp,
		};
		return this.finish({
			model: chosen.model,
			request,
			routerThinkingLevel,
			source,
			backend: extra.backend,
			classification,
			rawDifficulty: extra.rawDifficulty,
			difficulty,
			momentumApplied: extra.momentumApplied ?? false,
			trivial,
			boosts,
			selection,
			estCostUsd: report?.estCostUsd,
			classifierMs: extra.classifierMs,
			kind,
			followUp: extra.followUp,
			anchored: extra.anchored || undefined,
			escalationSteps: steps,
		});
	}

	private decide(
		request: RouteRequest,
		classification: Classification,
		baseDifficulty: number,
		boosts: DifficultyBoost[],
		source: DecisionSource,
		extra: { backend?: ClassifierBackend; classifierMs?: number; momentumApplied: boolean; rawDifficulty?: number },
	): RouteDecision {
		const { signals } = request;
		const mode = request.mode ?? DEFAULT_ROUTER_MODE;
		const resolved = resolveModeConfig(this.catalog, mode);
		let { tuning, thinking } = resolved;
		const boostTotal = boosts.reduce((sum, boost) => sum + boost.delta, 0);
		const difficulty = Math.min(1, baseDifficulty + boostTotal);
		// Trivial turn (greeting, ack, one-line lookup): judged on this turn's own difficulty, so momentum
		// from earlier hard work does not make a "thanks" expensive. Failures this turn (boosts) count.
		const turnDifficulty = Math.min(1, classification.difficulty + boostTotal);
		const trivial =
			resolved.trivialBelow > 0 &&
			effectiveDifficulty(turnDifficulty, classification.confidence, tuning) < resolved.trivialBelow;
		if (trivial) {
			// Cheapest feasible model at the lowest level the mode's floor (min_thinking) allows.
			tuning = { ...tuning, costTiebreakFrac: 0 };
			thinking = { ...thinking, prefer: "lowest" };
		}
		const candidates = this.candidateModels();
		let selection: Selection;
		try {
			selection = selectModel(
				candidates.map((entry) => entry.candidate),
				{
					skills: classification.skills,
					difficulty: trivial ? turnDifficulty : difficulty,
					confidence: classification.confidence,
					needsTools: request.toolsActive && (classification.needsTools || !signals.isNewUserTurn),
					needsVision: signals.hasImages,
					contextTokens: signals.contextTokens,
					outputTokens: tuning.defaultOutputTokens,
					heldModelId: signals.warmModelId,
					heldThinkingLevel: signals.warmThinkingLevel,
				},
				tuning,
				thinking,
			);
		} catch (caught) {
			if (!(caught instanceof NoRouteError)) throw caught;
			return this.fallback(request, boosts, caught.message);
		}
		const chosen = candidates.find((entry) => entry.model.id === selection.modelId);
		if (!chosen) return this.fallback(request, boosts, "selected model is unavailable");
		const report = selection.candidates.find((candidate) => candidate.model === selection.modelId);
		const routerThinkingLevel = report?.thinkingLevel ?? "off";

		this.momentum = { difficulty, skills: classification.skills, at: this.now() };
		this.held = {
			mode,
			classification,
			baseDifficulty,
			appliedBoost: boostTotal,
			modelId: chosen.model.id,
			routerThinkingLevel,
			trivial,
			selection,
			backend: extra.backend,
			at: this.now(),
		};
		return this.finish({
			model: chosen.model,
			request,
			routerThinkingLevel,
			source,
			backend: extra.backend,
			classification,
			rawDifficulty: extra.rawDifficulty,
			difficulty,
			momentumApplied: extra.momentumApplied,
			trivial,
			boosts,
			selection,
			estCostUsd: report?.estCostUsd,
			classifierMs: extra.classifierMs,
		});
	}

	private fallback(request: RouteRequest, boosts: DifficultyBoost[], error: string): RouteDecision {
		this.stats.fallbacks++;
		const available = this.availableModels();
		const held = this.held;
		const heldModel = held ? available.find((model) => model.id === held.modelId) : undefined;
		if (held && heldModel) {
			held.at = this.now();
			return this.finish({
				model: heldModel,
				request,
				routerThinkingLevel: held.routerThinkingLevel,
				source: "held-fallback",
				backend: held.backend,
				classification: held.classification,
				difficulty: held.baseDifficulty,
				momentumApplied: false,
				boosts,
				selection: held.selection,
				error,
			});
		}
		const defaultId = this.options.defaultModelId();
		const model =
			available.find((candidate) => candidate.id === defaultId) ??
			available.find((candidate) => candidate.id === request.signals.warmModelId) ??
			available[0];
		if (!model) throw new NoRouteError(`no model available (${error})`);
		const thinking =
			this.options.defaultThinkingLevel?.(model) ?? clampToSupported("off", getSupportedThinkingLevels(model));
		return this.finish({
			model,
			request,
			routerThinkingLevel: thinking,
			source: "default-fallback",
			momentumApplied: false,
			boosts,
			error,
		});
	}

	private finish(input: {
		model: Model<Api>;
		request: RouteRequest;
		routerThinkingLevel: ModelThinkingLevel;
		source: DecisionSource;
		backend?: ClassifierBackend;
		classification?: Classification;
		rawDifficulty?: number;
		difficulty?: number;
		momentumApplied: boolean;
		trivial?: boolean;
		boosts: DifficultyBoost[];
		selection?: Selection;
		estCostUsd?: number;
		classifierMs?: number;
		error?: string;
		kind?: TaskKind;
		followUp?: boolean;
		anchored?: boolean;
		escalationSteps?: number;
		failoverFrom?: string;
	}): RouteDecision {
		const supported = getSupportedThinkingLevels(input.model);
		const pinned = input.request.pinnedThinking;
		const mode = input.request.mode ?? DEFAULT_ROUTER_MODE;
		// The mode's min_thinking/max_thinking bound every level the router sends (fallbacks and held
		// decisions from another mode too). A level the user pinned is theirs and is not bound.
		const { minThinking, maxThinking } = this.catalog.modes[mode];
		const routerThinkingLevel = clampToBand(input.routerThinkingLevel, supported, minThinking, maxThinking);
		const previousModelId = input.request.signals.warmModelId ?? this.lastDecisionValue?.model.id;
		const decision: RouteDecision = {
			model: input.model,
			thinkingLevel: pinned ? clampToSupported(pinned, supported) : routerThinkingLevel,
			routerThinkingLevel,
			thinkingPinned: pinned !== undefined,
			mode,
			source: input.source,
			backend: input.backend,
			classifierModel: input.backend ? this.classifier?.modelId : undefined,
			classification: input.classification,
			rawDifficulty: input.rawDifficulty,
			difficulty: input.difficulty,
			momentumApplied: input.momentumApplied,
			trivial: input.trivial ?? false,
			boosts: input.boosts,
			selection: input.selection,
			kind: input.kind,
			followUp: input.followUp,
			...(input.anchored ? { anchored: true } : {}),
			escalationSteps: input.escalationSteps,
			estCostUsd:
				input.estCostUsd ?? input.selection?.candidates.find((c) => c.model === input.model.id)?.estCostUsd,
			classifierMs: input.classifierMs,
			error: input.error,
			failoverFrom: input.failoverFrom,
			previousModelId,
			switched: previousModelId !== undefined && previousModelId !== input.model.id,
			at: this.now(),
		};
		this.lastDecisionValue = decision;
		this.warmth.set(`${decision.model.id}:${decision.thinkingLevel}`, {
			tokens: input.request.signals.contextTokens,
			at: decision.at,
		});
		return decision;
	}
}
