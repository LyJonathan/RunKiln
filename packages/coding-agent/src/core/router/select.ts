/**
 * Model selection: pure math, no I/O.
 *
 * 1. Hard filters (vision, context = input + output * 1.1). A model that fails one is never chosen,
 *    not even when escalating.
 * 2. Required minimum per skill = req_base + difficulty * req_span for the primary skill, times
 *    secondary_factor for the others (plus tool.call when tools are needed, longctx for big contexts).
 * 3. A candidate is a (model, thinking level) pair: the level adds quality_bonus to the model's scores and
 *    multiplies its output cost. Levels run from the difficulty floor up to the mode's max_auto. Per model
 *    the lowest feasible level is kept (prefer: highest keeps the deepest), so a hard task can stay on a
 *    cheap model at high thinking before a pricier model is needed. Per model, router.yaml can cap the
 *    levels auto routing uses (max_auto_thinking, in every mode) and allow thinking off below a difficulty
 *    (auto_off_below) despite the floor.
 * 4. Cheapest feasible model, by estimated cost of this request: input at the cached price for the model
 *    already in use (its prompt cache is warm) and the full price for any other, plus output scaled by its
 *    thinking level. Among models within cost_tiebreak_frac of the cheapest (the mode's quality band), the
 *    larger skill margin wins; then cost; then id (catalog order never matters).
 * 5. Stickiness: the model in use stays when it is feasible and within `stickiness` of the best cost.
 * 6. Nothing feasible: escalate to the least-deficient hard-eligible model and flag it.
 */

import type { ModelThinkingLevel } from "@runkiln/ai";
import type { RouterThinking, RouterTuning } from "./catalog.ts";
import { desiredThinkingLevel, maxLevel, THINKING_ORDER } from "./thinking.ts";
import type { CandidateReport, PairReport, RequiredSkill, Selection, SkillProbability } from "./types.ts";

export interface CandidateModel {
	id: string;
	/** USD per 1M tokens. */
	priceIn: number;
	priceOut: number;
	priceCachedIn: number;
	contextWindow: number;
	vision: boolean;
	intelligence: number;
	skills: Readonly<Record<string, number>>;
	supportedThinking: readonly ModelThinkingLevel[];
	/** router.yaml max_auto_thinking: the deepest level auto routing picks for this model, in any mode. */
	maxAutoThinking?: ModelThinkingLevel;
	/** router.yaml auto_off_below: below this effective difficulty thinking off is allowed on this model. */
	autoOffBelow?: number;
}

export interface SelectInput {
	skills: readonly SkillProbability[];
	difficulty: number;
	confidence: number;
	needsTools: boolean;
	needsVision: boolean;
	contextTokens: number;
	outputTokens: number;
	/** Model in use (its prompt cache is warm). */
	heldModelId?: string;
	/** Thinking level in use on the held model: other levels are priced cold (RunInfra caches per effort). */
	heldThinkingLevel?: ModelThinkingLevel;
}

export class NoRouteError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "NoRouteError";
	}
}

const round2 = (value: number) => Math.round(value * 100) / 100;

export function effectiveDifficulty(difficulty: number, confidence: number, tuning: RouterTuning): number {
	return Math.min(1, Math.max(0, difficulty + (1 - confidence) * tuning.lowConfidenceBoost));
}

export function requiredSkills(input: SelectInput, difficulty: number, tuning: RouterTuning): RequiredSkill[] {
	const primaryMin = tuning.reqBase + difficulty * tuning.reqSpan;
	const secondaryMin = Math.round(primaryMin * tuning.secondaryFactor);
	const required: RequiredSkill[] = input.skills.map((entry, index) => ({
		skill: entry.skill,
		prob: entry.prob,
		minScore: index === 0 ? Math.round(primaryMin) : secondaryMin,
	}));
	if (input.needsTools && !required.some((entry) => entry.skill === "tool.call")) {
		required.push({ skill: "tool.call", prob: 0, minScore: secondaryMin });
	}
	if (input.contextTokens >= tuning.longctxTokens && !required.some((entry) => entry.skill === "longctx")) {
		required.push({ skill: "longctx", prob: 0, minScore: secondaryMin });
	}
	return required;
}

export function estimateCost(
	model: CandidateModel,
	contextTokens: number,
	outputTokens: number,
	thinking: ModelThinkingLevel,
	cacheWarm: boolean,
	thinkingConfig: RouterThinking,
): number {
	const inputPrice = cacheWarm && model.priceCachedIn > 0 ? model.priceCachedIn : model.priceIn;
	const output = outputTokens * (thinkingConfig.outputMultiplier[thinking] ?? 1);
	return (contextTokens / 1e6) * inputPrice + (output / 1e6) * model.priceOut;
}

/**
 * Levels auto routing may use on a model: the supported ones up to its max_auto_thinking (at least its
 * lowest supported level). The mode's max_auto and the beyond-the-cap search work inside this set, so the
 * per-model cap holds in every mode; a level the user picks is not routed and not bound by it.
 */
export function autoLevels(model: Pick<CandidateModel, "supportedThinking" | "maxAutoThinking">): ModelThinkingLevel[] {
	const supported =
		model.supportedThinking.length > 0 ? [...model.supportedThinking] : (["off"] as ModelThinkingLevel[]);
	if (!model.maxAutoThinking) return supported;
	const cap = THINKING_ORDER.indexOf(model.maxAutoThinking);
	const capped = supported.filter((level) => THINKING_ORDER.indexOf(level) <= cap);
	return capped.length > 0 ? capped : [supported[0]];
}

export function selectModel(
	models: readonly CandidateModel[],
	input: SelectInput,
	tuning: RouterTuning,
	thinkingConfig: RouterThinking,
): Selection {
	if (models.length === 0) throw new NoRouteError("no routable models");
	const difficulty = effectiveDifficulty(input.difficulty, input.confidence, tuning);
	const required = requiredSkills(input, difficulty, tuning);
	// Minimum thinking for this difficulty and skill (mode shift included).
	// The routing mode's min_thinking is a hard floor on top of it.
	const floor = maxLevel(
		desiredThinkingLevel(difficulty, input.skills[0]?.skill, thinkingConfig),
		thinkingConfig.floor,
	);
	const neededContext = input.contextTokens + Math.ceil(input.outputTokens * 1.1);
	// With no required skill (out-of-taxonomy request), judge by general intelligence at the secondary bar.
	const generalistBar = (tuning.reqBase + difficulty * tuning.reqSpan) * tuning.secondaryFactor;

	// max_auto never exceeds the mode's max_thinking (resolveModeConfig), and neither does the
	// beyond-the-cap search below: the ceiling is hard, escalation moves to another model instead.
	const ceilingIndex = thinkingConfig.ceiling
		? THINKING_ORDER.indexOf(thinkingConfig.ceiling)
		: THINKING_ORDER.length - 1;
	const capIndex = Math.min(THINKING_ORDER.indexOf(thinkingConfig.maxAuto), ceilingIndex);
	const floorIndex = THINKING_ORDER.indexOf(floor);
	const candidates: CandidateReport[] = models.map((model) => {
		const hardFailures: string[] = [];
		if (input.needsVision && !model.vision) hardFailures.push("vision");
		if (model.contextWindow > 0 && model.contextWindow < neededContext) hardFailures.push("context");
		const warmModel = model.id === input.heldModelId;

		// Levels this model may run at: supported up to its max_auto_thinking, at most max_auto, at least
		// the difficulty floor (or off, below its auto_off_below).
		const supported = autoLevels(model);
		// auto_off_below: thinking off stays allowed on this model below that difficulty (deep skills too).
		const modelFloorIndex =
			model.autoOffBelow !== undefined && difficulty < model.autoOffBelow && supported.includes("off")
				? Math.max(0, thinkingConfig.floor ? THINKING_ORDER.indexOf(thinkingConfig.floor) : 0)
				: floorIndex;
		const capped = supported.filter((level) => THINKING_ORDER.indexOf(level) <= capIndex);
		const allowed = capped.length > 0 ? capped : [supported[0]];
		const aboveFloor = allowed.filter((level) => THINKING_ORDER.indexOf(level) >= modelFloorIndex);
		const levels = aboveFloor.length > 0 ? aboveFloor : [allowed[allowed.length - 1]];

		// One candidate per (model, level): the level adds its quality bonus and its output cost.
		const evaluate = (level: ModelThinkingLevel): PairReport => {
			const bonus = thinkingConfig.qualityBonus[level] ?? 0;
			const failed: string[] = [];
			let minMargin = Number.POSITIVE_INFINITY;
			for (const entry of required) {
				const score = model.skills[entry.skill];
				const have = (score ?? 0) + (score === undefined ? 0 : bonus);
				const margin = have - entry.minScore;
				minMargin = Math.min(minMargin, margin);
				if (margin < 0) failed.push(`${entry.skill}(${score === undefined ? "unscored" : have}<${entry.minScore})`);
			}
			if (required.length === 0) {
				const have = model.intelligence + bonus;
				minMargin = have - generalistBar;
				if (minMargin < 0) failed.push(`intelligence(${have}<${Math.round(generalistBar)})`);
			}
			return {
				level,
				feasible: failed.length === 0,
				minMargin: round2(minMargin),
				estCostUsd: estimateCost(
					model,
					input.contextTokens,
					input.outputTokens,
					level,
					warmModel && (input.heldThinkingLevel === undefined || input.heldThinkingLevel === level),
					thinkingConfig,
				),
				failed,
			};
		};
		const pairs = levels.map(evaluate);
		if (thinkingConfig.beyondCapWhenShort && !pairs.some((pair) => pair.feasible)) {
			// Max thinking on this model before a pricier model: levels above max_auto.
			const above = supported
				.filter(
					(level) => THINKING_ORDER.indexOf(level) > capIndex && THINKING_ORDER.indexOf(level) <= ceilingIndex,
				)
				.map(evaluate);
			// The first that clears it, or else the deepest (best margin for escalation).
			const pick = above.find((pair) => pair.feasible) ?? above[above.length - 1];
			if (pick) pairs.push(pick);
		}
		const feasiblePairs = pairs.filter((pair) => pair.feasible);
		// Lowest level that clears the bar (cheapest), or the deepest allowed (prefer: highest);
		// with none clearing it, the deepest (best margin).
		const best =
			feasiblePairs.length > 0
				? thinkingConfig.prefer === "highest"
					? feasiblePairs[feasiblePairs.length - 1]
					: feasiblePairs[0]
				: pairs[pairs.length - 1];
		return {
			model: model.id,
			feasible: hardFailures.length === 0 && best.feasible,
			hardFail: hardFailures.length > 0,
			estCostUsd: best.estCostUsd,
			minMargin: best.minMargin,
			thinkingLevel: best.level,
			failed: [...hardFailures, ...best.failed],
			pairs,
		};
	});

	const eligible = candidates.filter((candidate) => !candidate.hardFail);
	if (eligible.length === 0) {
		const reasons = [
			...new Set(
				candidates.flatMap((candidate) => candidate.failed.filter((f) => f === "vision" || f === "context")),
			),
		];
		throw new NoRouteError(`no model fits this request (${reasons.join(", ")})`);
	}
	const byCost = (a: CandidateReport, b: CandidateReport) =>
		a.estCostUsd - b.estCostUsd || a.model.localeCompare(b.model);
	const held = input.heldModelId ? eligible.find((candidate) => candidate.model === input.heldModelId) : undefined;
	const feasible = eligible.filter((candidate) => candidate.feasible).sort(byCost);

	let chosen: CandidateReport;
	let cause: Selection["cause"];
	let escalated = false;
	if (feasible.length > 0) {
		const threshold = feasible[0].estCostUsd * (1 + tuning.costTiebreakFrac);
		chosen = feasible
			.filter((candidate) => candidate.estCostUsd <= threshold)
			.sort((a, b) => b.minMargin - a.minMargin || byCost(a, b))[0];
		cause = "cheapest_feasible";
		// stickiness 0 (high mode) means never stick: a cheaper warm model (say, from a trivial turn) must not
		// keep a non-trivial turn off the strongest pair.
		if (
			tuning.stickiness > 0 &&
			held?.feasible &&
			held !== chosen &&
			held.estCostUsd <= chosen.estCostUsd * (1 + tuning.stickiness)
		) {
			chosen = held;
			cause = "held_sticky";
		}
	} else {
		const ranked = [...eligible].sort((a, b) => b.minMargin - a.minMargin || byCost(a, b));
		chosen = ranked[0];
		// Keep the model in use when it is as close as the best (within one point).
		if (held && held !== chosen && held.minMargin >= chosen.minMargin - 1) chosen = held;
		cause = "escalated_nearest_fit";
		escalated = true;
	}

	return {
		modelId: chosen.model,
		escalated,
		cause,
		required,
		effectiveDifficulty: round2(difficulty),
		candidates,
	};
}
