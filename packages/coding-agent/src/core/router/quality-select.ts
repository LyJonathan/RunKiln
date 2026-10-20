/**
 * Quality-curve selection (router v2): pure math, no I/O.
 *
 * Every allowed (model, thinking level) pair gets
 *   quality = its calibrated pass rate for the turn's task kind at the turn's difficulty, interpolated
 *             between the anchors (router.yaml `quality`), plus public-benchmark leans for the kind;
 *   cost    = context at the cached price for the warm model (full price otherwise)
 *             + (answer tokens + the pair's reasoning tokens at that difficulty) at the output price.
 * Then, in order:
 * 1. Hard filters (vision, context window): never chosen.
 * 2. Escalation (a failed turn before this one, or repeated failures in this one): only pairs at least
 *    `step_margin` better than the failed pair, one distinct quality level up per step. When nothing is
 *    better, the best pairs other than the failed one.
 * 3. Otherwise the band: pairs within the mode's tolerance of the best quality.
 * 4. prefer lowest (low/medium modes): the cheapest in the band; pairs within 1% of that cost go to the
 *    higher quality, then the faster first token. prefer highest (high mode): the best quality, deeper
 *    thinking on ties within 0.005, then cost.
 *
 * Levels per model: the ones it supports, capped by its max_auto_thinking and the mode's max_auto /
 * max_thinking, floored at the mode's min_thinking. A model with no curves of its own (unbenched) borrows
 * the closest benched model's (by output price; the reference model when none is closer), nearest level,
 * offset by its skill scores and a penalty. With unbenched_policy last_resort (default) such a pair is only
 * chosen when no benched pair fits the request.
 */

import type { ModelThinkingLevel } from "@runkiln/ai";
import type { QualityLevel, QualityModel, RouterCacheModel, RouterQuality, TaskKind } from "./catalog.ts";
import { autoLevels, type CandidateModel, NoRouteError } from "./select.ts";
import { THINKING_ORDER } from "./thinking.ts";
import type { CandidateReport, PairReport, QualitySelectionInfo, Selection } from "./types.ts";

export interface QualityCandidate extends CandidateModel {
	/** This model's curves; undefined: borrowed (see borrowFrom). */
	curves?: QualityModel;
	/** For an unbenched model: the benched model whose curves it borrows, and that model's skill scores. */
	borrowFrom?: { id: string; curves: QualityModel; scores?: Readonly<Record<string, number>> };
}

/**
 * The benched model an unbenched one borrows curves from: the one closest in output price (log scale) among
 * `benched` (id + output price, available now), with a vision mismatch counting as one doubling of price.
 * Falls back to the reference model when nothing is listed.
 */
export function closestBenchedModel(
	model: Pick<CandidateModel, "priceOut" | "vision">,
	benched: ReadonlyArray<Pick<CandidateModel, "id" | "priceOut" | "vision">>,
	quality: Pick<RouterQuality, "models" | "referenceModel">,
): string | undefined {
	const withCurves = benched.filter((entry) => Object.keys(quality.models[entry.id]?.levels ?? {}).length > 0);
	if (withCurves.length === 0) return quality.models[quality.referenceModel] ? quality.referenceModel : undefined;
	const distance = (entry: Pick<CandidateModel, "id" | "priceOut" | "vision">) => {
		const a = Math.max(model.priceOut, 1e-6);
		const b = Math.max(entry.priceOut, 1e-6);
		return Math.abs(Math.log2(a / b)) + (entry.vision === model.vision ? 0 : 1);
	};
	return [...withCurves].sort(
		(x, y) =>
			distance(x) - distance(y) ||
			Number(y.id === quality.referenceModel) - Number(x.id === quality.referenceModel) ||
			x.id.localeCompare(y.id),
	)[0].id;
}

export interface QualitySelectInput {
	kind: TaskKind;
	/** Effective difficulty 0..1 (boosts and the low-confidence boost included). */
	difficulty: number;
	contextTokens: number;
	answerTokens: number;
	needsVision: boolean;
	/** Model in use: its prompt cache is warm. */
	heldModelId?: string;
	/**
	 * Thinking level in use on that model. RunInfra caches per (model, effort), so a pair at another level
	 * is priced cold. Undefined: every level of the held model counts as warm (older transcripts).
	 */
	heldThinkingLevel?: ModelThinkingLevel;
	/** Step up from this pair (a failed turn or repeated failures in this one). */
	escalation?: { model: string; level: ModelThinkingLevel; steps: number };
	/**
	 * Cached prompt tokens a pair would get now (the router's warmth ledger: pairs used on this session within the
	 * cache TTL). Undefined: only the held pair is warm, over the whole context.
	 */
	warmTokens?: (model: string, level: ModelThinkingLevel) => number;
	/**
	 * The prompt cache is lost anyway (session start, after compaction, idle past the cache TTL, /new): no pair is
	 * held, so the cheapest good pair is taken.
	 */
	freeSwitch?: boolean;
	/**
	 * Expected time away from the held pair over the horizon (the session's own pace between turns). Past the cache TTL
	 * the held pair expires meanwhile, so the way back is a full miss, not just the growth. Undefined: within the TTL.
	 */
	excursionMs?: number;
	/**
	 * The session already has turns behind it, so the pair taken at a free switch point is likely kept for the next
	 * ones: quality counts in the band (as against a warm pair). False on a session's first turn: the cheapest good pair.
	 */
	sessionUnderway?: boolean;
}

export interface QualityModeConfig {
	tolerance: number;
	prefer: "lowest" | "highest";
	/** Mode floor and ceiling (min_thinking / max_thinking) and its max_auto. */
	floor?: ModelThinkingLevel;
	ceiling?: ModelThinkingLevel;
	maxAuto: ModelThinkingLevel;
	/** quality.cache with the mode's overrides (modes.<mode>.cache); quality.cache when absent. */
	cache?: RouterCacheModel;
}

const round3 = (value: number) => Math.round(value * 1000) / 1000;
const round6 = (value: number) => Math.round(value * 1e6) / 1e6;
const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

/** Value of an [easy, medium, hard] triple at a difficulty, on the five anchors. */
export function interpolate(
	triple: readonly [number, number, number],
	difficulty: number,
	anchors: RouterQuality["anchors"],
	frontierValue: number,
): number {
	const points = [triple[0], triple[0], triple[1], triple[2], frontierValue];
	const d = clamp01(difficulty);
	if (d <= anchors[0]) return points[0];
	for (let i = 1; i < anchors.length; i++) {
		if (d <= anchors[i]) {
			const t = (d - anchors[i - 1]) / (anchors[i] - anchors[i - 1]);
			return points[i - 1] + t * (points[i] - points[i - 1]);
		}
	}
	return points[points.length - 1];
}

/** How much of a hard-anchor lean applies at this difficulty: none to easy, half at medium, all from hard. */
function leanWeight(difficulty: number, anchors: RouterQuality["anchors"]): number {
	return interpolate([0, 0.5, 1], difficulty, anchors, 1);
}

/** The level entry a model uses for `level`: its own, else the nearest it has (higher first). */
export function nearestLevel(curves: QualityModel, level: ModelThinkingLevel): QualityLevel | undefined {
	if (curves.levels[level]) return curves.levels[level];
	const index = THINKING_ORDER.indexOf(level);
	for (let distance = 1; distance < THINKING_ORDER.length; distance++) {
		const up = THINKING_ORDER[index + distance];
		if (up && curves.levels[up]) return curves.levels[up];
		const down = THINKING_ORDER[index - distance];
		if (down && curves.levels[down]) return curves.levels[down];
	}
	return undefined;
}

/** Estimated pass rate and reasoning tokens of one pair for a kind at a difficulty. */
export function pairQuality(
	model: Pick<QualityCandidate, "id" | "skills" | "curves" | "borrowFrom">,
	level: ModelThinkingLevel,
	kind: TaskKind,
	difficulty: number,
	quality: RouterQuality,
	/** The reference model's skill scores (for an unbenched model's offset). */
	referenceScores?: Readonly<Record<string, number>>,
): { quality: number; reasoningTokens: number; derived: boolean } | undefined {
	const own = model.curves && Object.keys(model.curves.levels).length > 0 ? model.curves : undefined;
	const reference = model.borrowFrom?.curves ?? quality.models[quality.referenceModel];
	const curves = own ?? reference;
	if (!curves) return undefined;
	const entry = own?.levels[level] ?? nearestLevel(curves, level);
	if (!entry) return undefined;
	const curveKind = entry.pass[kind] ? kind : quality.kindFrom[kind];
	const triple = (curveKind && entry.pass[curveKind]) || entry.pass.code;
	if (!triple) return undefined;
	const frontier = triple[2] ** quality.frontierExponent;
	let value = interpolate(triple, difficulty, quality.anchors, frontier);
	const lean = quality.priors[kind]?.[model.id];
	if (lean) value += lean * leanWeight(difficulty, quality.anchors);
	let derived = false;
	if (!own) {
		derived = true;
		const skill = quality.kindSkills[kind];
		const lenderScores = model.borrowFrom ? model.borrowFrom.scores : referenceScores;
		if (skill && lenderScores) {
			const mine = model.skills[skill];
			const theirs = lenderScores[skill];
			if (mine !== undefined && theirs !== undefined) value += (mine - theirs) / 100;
		}
		value -= quality.unbenchedPenalty;
	}
	const reasoningTokens = interpolate(entry.reasoningTokens, difficulty, quality.anchors, entry.reasoningTokens[2]);
	return { quality: clamp01(value), reasoningTokens, derived };
}

/** A pair whose provider prompt cache is warm: the held model at the held level (any level when unknown). */
export function isWarmPair(
	modelId: string,
	level: ModelThinkingLevel,
	input: Pick<QualitySelectInput, "heldModelId" | "heldThinkingLevel">,
): boolean {
	if (modelId !== input.heldModelId) return false;
	return input.heldThinkingLevel === undefined || input.heldThinkingLevel === level;
}

export function pairCost(
	model: Pick<CandidateModel, "priceIn" | "priceOut" | "priceCachedIn">,
	contextTokens: number,
	outputTokens: number,
	cacheWarm: boolean,
): number {
	const inputPrice = cacheWarm && model.priceCachedIn > 0 ? model.priceCachedIn : model.priceIn;
	return (contextTokens / 1e6) * inputPrice + (outputTokens / 1e6) * model.priceOut;
}

/**
 * Levels quality selection may use on a model in this mode: `levels` up to the mode's max_auto, and
 * `reserve`, the deeper ones up to max_thinking (used when escalating, or when no level up to max_auto
 * comes within the band of the best). Both inside the model's own max_auto_thinking and the mode floor.
 */
export function modeLevels(
	model: CandidateModel,
	mode: QualityModeConfig,
): { levels: ModelThinkingLevel[]; reserve: ModelThinkingLevel[] } {
	const supported = autoLevels(model);
	const ceiling = mode.ceiling ? THINKING_ORDER.indexOf(mode.ceiling) : THINKING_ORDER.length - 1;
	const cap = Math.min(THINKING_ORDER.indexOf(mode.maxAuto), ceiling);
	const floor = mode.floor ? THINKING_ORDER.indexOf(mode.floor) : 0;
	const index = (level: ModelThinkingLevel) => THINKING_ORDER.indexOf(level);
	const levels = supported.filter((level) => index(level) >= floor && index(level) <= cap);
	const reserve = supported.filter((level) => index(level) >= floor && index(level) > cap && index(level) <= ceiling);
	if (levels.length > 0 || reserve.length > 0) return { levels, reserve };
	// The model has no level inside the band: its nearest one (the finish step clamps what is sent).
	const below = supported.filter((level) => index(level) < floor);
	const above = supported.filter((level) => index(level) > ceiling);
	return {
		levels: below.length > 0 ? [below[below.length - 1]] : above.length > 0 ? [above[0]] : [supported[0]],
		reserve: [],
	};
}

interface ScoredPair extends PairReport {
	model: string;
	ttftMs: number;
	derived: boolean;
	quality: number;
	/** Above the mode's max_auto (see modeLevels). */
	reserve: boolean;
	/** One turn once warm. */
	steadyUsd: number;
	/** The output part of it (answer and reasoning tokens). */
	outputUsd: number;
	/** What this turn pays on top of that for the uncached part of the prompt. */
	missUsd: number;
	/** Share of the prompt cached for this pair now (0..1). */
	warmShare: number;

	price: Pick<CandidateModel, "priceIn" | "priceOut" | "priceCachedIn">;
}

/** Cached tokens a pair gets now: the ledger's, else the whole context for the held pair, else none. */
function warmTokensFor(
	modelId: string,
	level: ModelThinkingLevel,
	input: Pick<QualitySelectInput, "heldModelId" | "heldThinkingLevel" | "warmTokens" | "contextTokens" | "freeSwitch">,
): number {
	if (input.freeSwitch) return 0;
	const tokens = input.warmTokens
		? input.warmTokens(modelId, level)
		: isWarmPair(modelId, level, input)
			? input.contextTokens
			: 0;
	return Math.max(0, Math.min(input.contextTokens, tokens));
}

/** This turn's first request: the cached part at the cached price, the rest at the full price, plus the output. */
function turnCost(
	model: Pick<CandidateModel, "priceIn" | "priceOut" | "priceCachedIn">,
	contextTokens: number,
	warmTokens: number,
	outputTokens: number,
): number {
	const cachedPrice = model.priceCachedIn > 0 ? model.priceCachedIn : model.priceIn;
	return (
		(warmTokens / 1e6) * cachedPrice +
		((contextTokens - warmTokens) / 1e6) * model.priceIn +
		(outputTokens / 1e6) * model.priceOut
	);
}

/**
 * Cost of riding `pair` over the cache horizon: this turn's miss, the following turns warm, and (when it leaves the
 * held pair) the expected miss on the way back. That only covers what the context grew by meanwhile, because the held
 * pair stays cached on the session, unless the time away (`excursionMs`) outlasts the cache TTL: then the whole prompt.
 */
export function horizonCost(
	pair: Pick<ScoredPair, "model" | "level" | "steadyUsd" | "missUsd">,
	held: Pick<ScoredPair, "model" | "level" | "price"> | undefined,
	cache: RouterCacheModel,
	contextTokens = 0,
	excursionMs = 0,
): number {
	let cost = pair.missUsd + cache.horizonTurns * pair.steadyUsd;
	if (held && !(held.model === pair.model && held.level === pair.level)) {
		const growth = cache.horizonTurns * cache.turnGrowthTokens;
		const back = excursionMs > cache.ttlSec * 1000 ? contextTokens + growth : growth;
		const cachedPrice = held.price.priceCachedIn > 0 ? held.price.priceCachedIn : held.price.priceIn;
		cost += cache.returnProbability * (back / 1e6) * (held.price.priceIn - cachedPrice);
	}
	return cost;
}

export function selectByQuality(
	models: readonly QualityCandidate[],
	input: QualitySelectInput,
	mode: QualityModeConfig,
	quality: RouterQuality,
	referenceScores?: Readonly<Record<string, number>>,
): Selection {
	if (models.length === 0) throw new NoRouteError("no routable models");
	const neededContext = input.contextTokens + Math.ceil(input.answerTokens * 1.1);
	const candidates: CandidateReport[] = [];
	const scored: ScoredPair[] = [];
	for (const model of models) {
		const hardFailures: string[] = [];
		if (input.needsVision && !model.vision) hardFailures.push("vision");
		if (model.contextWindow > 0 && model.contextWindow < neededContext) hardFailures.push("context");
		const pairs: ScoredPair[] = [];
		const { levels, reserve } = modeLevels(model, mode);
		for (const level of [...levels, ...reserve]) {
			const estimate = pairQuality(model, level, input.kind, input.difficulty, quality, referenceScores);
			if (!estimate) continue;
			const output = input.answerTokens + estimate.reasoningTokens;
			const warm = warmTokensFor(model.id, level, input);
			const steady = pairCost(model, input.contextTokens, output, true);
			const now = turnCost(model, input.contextTokens, warm, output);
			pairs.push({
				model: model.id,
				level,
				quality: round3(estimate.quality),
				feasible: hardFailures.length === 0,
				minMargin: 0,
				estCostUsd: now,
				steadyUsd: steady,
				outputUsd: (output / 1e6) * model.priceOut,
				missUsd: Math.max(0, now - steady),
				warmShare: input.contextTokens > 0 ? warm / input.contextTokens : 1,
				price: model,
				failed: [...hardFailures],
				ttftMs: model.curves?.ttftMs ?? quality.models[quality.referenceModel]?.ttftMs ?? 1000,
				derived: estimate.derived,
				reserve: reserve.includes(level),
			});
		}
		if (pairs.length === 0) {
			candidates.push({
				model: model.id,
				feasible: false,
				hardFail: true,
				estCostUsd: 0,
				minMargin: 0,
				thinkingLevel: "off",
				failed: [...hardFailures, "no quality curves"],
				pairs: [],
			});
			continue;
		}
		if (hardFailures.length === 0) scored.push(...pairs);
		const bestOwn = [...pairs].sort((a, b) => b.quality - a.quality || a.estCostUsd - b.estCostUsd)[0];
		candidates.push({
			model: model.id,
			feasible: hardFailures.length === 0,
			hardFail: hardFailures.length > 0,
			estCostUsd: bestOwn.estCostUsd,
			minMargin: 0,
			thinkingLevel: bestOwn.level,
			failed: [...hardFailures],
			quality: bestOwn.quality,
			derived: bestOwn.derived,
			pairs: pairs.map(
				({
					model: _m,
					ttftMs: _t,
					derived: _d,
					reserve: _r,
					steadyUsd: _s,
					outputUsd: _o,
					missUsd: _x,
					warmShare: _w,
					price: _p,
					...pair
				}) => pair,
			),
		});
	}
	if (scored.length === 0) {
		const reasons = [...new Set(candidates.flatMap((candidate) => candidate.failed))];
		throw new NoRouteError(`no model fits this request (${reasons.join(", ")})`);
	}
	// Unbenched pairs are a last resort: dropped whenever a benched pair fits.
	if ((quality.unbenchedPolicy ?? "last_resort") === "last_resort" && scored.some((pair) => !pair.derived)) {
		const unbenched = new Set(scored.filter((pair) => pair.derived).map((pair) => pair.model));
		for (let i = scored.length - 1; i >= 0; i--) if (scored[i].derived) scored.splice(i, 1);
		for (const candidate of candidates) {
			if (!unbenched.has(candidate.model)) continue;
			candidate.feasible = false;
			candidate.failed.push("unbenched (a benched model fits)");
		}
	}

	// Reserve levels count only when escalating or when nothing within max_auto reaches the band.
	const inCap = scored.filter((pair) => !pair.reserve);
	const bestAll = Math.max(...scored.map((pair) => pair.quality));
	const bestInCap = inCap.length > 0 ? Math.max(...inCap.map((pair) => pair.quality)) : -1;
	const escalating = !!input.escalation && input.escalation.steps > 0;
	const usable = escalating || bestAll - bestInCap > mode.tolerance + 1e-9 ? scored : inCap;
	const best = Math.max(...usable.map((pair) => pair.quality));
	let pool: ScoredPair[];
	let cause: Selection["cause"] = mode.prefer === "highest" ? "best_quality" : "cheapest_within_band";
	let steps = 0;
	let from: { model: string; level: ModelThinkingLevel; quality: number } | undefined;
	const escalation = input.escalation;
	if (escalation && escalation.steps > 0) {
		steps = Math.min(escalation.steps, quality.maxSteps);
		const failed = models.find((model) => model.id === escalation.model);
		const failedQuality =
			scored.find((pair) => pair.model === escalation.model && pair.level === escalation.level)?.quality ??
			(failed
				? pairQuality(failed, escalation.level, input.kind, input.difficulty, quality, referenceScores)?.quality
				: undefined);
		if (failedQuality !== undefined && steps > 0) {
			from = { model: escalation.model, level: escalation.level, quality: round3(failedQuality) };
			const levels = [
				...new Set(
					usable.map((pair) => pair.quality).filter((value) => value >= failedQuality + quality.stepMargin - 1e-9),
				),
			].sort((a, b) => a - b);
			if (levels.length > 0) {
				const bar = levels[Math.min(steps, levels.length) - 1];
				pool = usable.filter((pair) => pair.quality >= bar - 1e-9);
			} else {
				// Nothing is better than the pair that failed: another pair in the band (a different model or
				// level is the best bet), or the best ones when the failed pair is alone there.
				const band = usable.filter((pair) => pair.quality >= best - mode.tolerance - 1e-9);
				const others = band.filter((pair) => !(pair.model === escalation.model && pair.level === escalation.level));
				pool = others.length > 0 ? others : usable.filter((pair) => pair.quality >= best - 0.005);
			}
			cause = "stepped_up";
		} else {
			steps = 0;
			pool = usable.filter((pair) => pair.quality >= best - mode.tolerance - 1e-9);
		}
	} else {
		pool = usable.filter((pair) => pair.quality >= best - mode.tolerance - 1e-9);
	}

	const cache = mode.cache ?? quality.cache;
	const sticky = cache.enabled && !input.freeSwitch;
	const held =
		sticky && input.heldModelId
			? usable.find(
					(pair) => isWarmPair(pair.model, pair.level, input) && warmTokensFor(pair.model, pair.level, input) > 0,
				)
			: undefined;
	const horizon = (pair: ScoredPair) =>
		cache.enabled ? horizonCost(pair, held, cache, input.contextTokens, input.excursionMs) : pair.estCostUsd;
	// Cache-aware price of a pair: its horizon cost less the failed turns its pass rate avoids over the horizon.
	const failedUsd = cache.failedTurnUsd;
	const value = (pair: ScoredPair) => horizon(pair) - pair.quality * cache.horizonTurns * failedUsd;
	const pick = (candidates: ScoredPair[]): ScoredPair => {
		if (mode.prefer === "highest" && cause !== "stepped_up") {
			const top = Math.max(...candidates.map((pair) => pair.quality));
			return candidates
				.filter((pair) => pair.quality >= top - 0.005)
				.sort(
					(a, b) =>
						THINKING_ORDER.indexOf(b.level) - THINKING_ORDER.indexOf(a.level) ||
						horizon(a) - horizon(b) ||
						a.model.localeCompare(b.model),
				)[0];
		}
		// With a warm pair to leave, or a session the pick will carry on, quality counts in the band too (value());
		// on a session's first turn the cheapest good pair, its pass rate weighted by first_turn_quality.
		if (cache.enabled && (held || input.sessionUnderway)) return lowestBy(candidates, value);
		if (cache.enabled && cache.firstTurnQuality > 0) {
			const weight = cache.horizonTurns * failedUsd * cache.firstTurnQuality;
			return lowestBy(candidates, (pair) => horizon(pair) - pair.quality * weight);
		}
		return lowestBy(candidates, horizon);
	};
	const lowestBy = (candidates: ScoredPair[], score: (pair: ScoredPair) => number): ScoredPair => {
		const cheapest = Math.min(...candidates.map(horizon));
		const lowest = Math.min(...candidates.map(score));
		return candidates
			.filter((pair) => score(pair) <= lowest + cheapest * 0.01 + 1e-12)
			.sort(
				(a, b) =>
					b.quality - a.quality ||
					a.ttftMs - b.ttftMs ||
					horizon(a) - horizon(b) ||
					a.model.localeCompare(b.model),
			)[0];
	};

	let chosen = pick(pool);
	let cacheNote: QualitySelectionInfo["cache"];
	if (held && cause !== "stepped_up") {
		// The warm pair against the best other pair: the quality gain over the horizon against the cache cost of moving
		// there (and likely back). Inside the band too, so a clearly better pair can beat the warm one.
		const isHeld = (pair: ScoredPair) => pair.model === held.model && pair.level === held.level;
		const others = pool.filter((pair) => !isHeld(pair));
		const alternative = isHeld(chosen) ? (others.length > 0 ? pick(others) : undefined) : chosen;
		if (alternative) {
			const inBand = held.quality >= best - mode.tolerance - 1e-9;
			const gainUsd = (alternative.quality - held.quality) * cache.horizonTurns * failedUsd;
			const extraUsd = horizon(alternative) - horizon(held);
			// Inside the band a better pair must be clearly better (more than clear_gain) to cost a miss.
			const unclear = inBand && extraUsd > 0 && alternative.quality - held.quality <= cache.clearGain + 1e-9;
			if (unclear || gainUsd <= extraUsd) {
				cacheNote = {
					kept: true,
					reason: inBand ? "in_band" : "not_worth_miss",
					gainUsd: round6(gainUsd),
					switchUsd: round6(extraUsd),
				};
				chosen = held;
				cause = "held_warm";
			} else {
				cacheNote = { kept: false, reason: "worth_miss", gainUsd: round6(gainUsd), switchUsd: round6(extraUsd) };
				chosen = alternative;
			}
		}
	}

	// Each candidate reports the chosen level for the chosen model, its own best level otherwise.
	for (const candidate of candidates) {
		if (candidate.model !== chosen.model) continue;
		candidate.thinkingLevel = chosen.level;
		candidate.estCostUsd = chosen.estCostUsd;
		candidate.quality = chosen.quality;
	}
	return {
		modelId: chosen.model,
		escalated: steps > 0,
		cause,
		required: [],
		effectiveDifficulty: Math.round(input.difficulty * 100) / 100,
		candidates,
		quality: {
			kind: input.kind,
			best: round3(best),
			chosen: chosen.quality,
			tolerance: mode.tolerance,
			steps,
			from,
			answerTokens: input.answerTokens,
			...(cacheNote ? { cache: cacheNote } : {}),
			...(input.freeSwitch ? { freeSwitch: true } : {}),
		},
	};
}
