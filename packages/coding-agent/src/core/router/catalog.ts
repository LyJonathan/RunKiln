/**
 * Router catalog: the skill taxonomy, per-model skill scores and tuning (router.yaml).
 *
 * The bundled router.yaml ships next to models.yaml. A user file at `<agentDir>/router.yaml` is merged
 * over it. Only the user's agent directory is read, never a project, so a repository cannot change how
 * prompts are routed. Prices, context windows and reasoning efforts come from models.yaml, not here.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ModelThinkingLevel } from "@runkiln/ai";
import { parse as parseYaml } from "yaml";
import { getAgentDir, getPackageDir } from "../../config.ts";
import type { CatalogOverride } from "../runkiln/live-catalog.ts";

export const ROUTER_CATALOG_FILE = "router.yaml";

export interface RouterSkill {
	name: string;
	desc: string;
}

export interface RouterModelScores {
	intelligence: number;
	skills: Record<string, number>;
	/** False keeps the model out of auto routing. */
	route: boolean;
	/**
	 * Highest thinking level the router picks on its own for this model (max_auto_thinking), in every
	 * mode and also when escalating past the mode's max_auto. A level the user picks is not bound by it.
	 */
	maxAutoThinking?: ModelThinkingLevel;
	/**
	 * Below this effective difficulty the router may run this model with thinking off (auto_off_below),
	 * whatever minimum the difficulty table and skill shift would ask. Only for a model that supports off.
	 */
	autoOffBelow?: number;
	/**
	 * Catalog values that beat the live RunInfra catalog and models.yaml (router.yaml `models.<id>.catalog`:
	 * price { in, out, cached_in }, context, max_output, reasoning_efforts).
	 */
	catalog?: CatalogOverride;
}

export interface RouterTuning {
	skillThreshold: number;
	maxSecondarySkills: number;
	reqBase: number;
	reqSpan: number;
	secondaryFactor: number;
	lowConfidenceBoost: number;
	costTiebreakFrac: number;
	stickiness: number;
	defaultOutputTokens: number;
	momentumDecay: number;
	sessionIdleResetMin: number;
	longctxTokens: number;
	failedModelCooldownSec: number;
}

export interface RouterEscalation {
	toolError: number;
	toolErrorCap: number;
	testFailure: number;
	userRetry: number;
	multiFile: number;
	longLoop: number;
}

export interface RouterThinking {
	/**
	 * Ascending [upper bound, level] pairs: the minimum thinking level for a difficulty. The router may
	 * pick a higher level when that is the cheapest way for a model to clear the quality bar.
	 */
	levels: Array<[number, ModelThinkingLevel]>;
	maxAuto: ModelThinkingLevel;
	/** Levels added to every choice (routing modes: -1 for low, +1 for high). */
	shift: number;
	/** Skill points a thinking level adds to a model's scores: (model, level) is one candidate. */
	qualityBonus: Partial<Record<ModelThinkingLevel, number>>;
	/** Per model, use the lowest level that clears the bar (cheapest) or the highest allowed (deepest). */
	prefer: "lowest" | "highest";
	/**
	 * When no level up to max_auto clears the bar on a model, try its levels above max_auto before
	 * moving to another model (max thinking before a pricier model).
	 */
	beyondCapWhenShort: boolean;
	/** Hard bounds from the routing mode (min_thinking / max_thinking); not set in router.yaml `thinking`. */
	floor?: ModelThinkingLevel;
	ceiling?: ModelThinkingLevel;
	deepSkills: string[];
	lightSkills: string[];
	outputMultiplier: Partial<Record<ModelThinkingLevel, number>>;
}

/** Scores for a RunInfra model router.yaml does not list (a model new to the live catalog). */
export interface RouterUnknownModel {
	/** Score for every skill, before the price prior. */
	skillScore: number;
	/**
	 * Price prior: + price_scaling * log2(output price / median output price of scored models).
	 * A pricier new model is assumed somewhat stronger until it is scored. 0 turns it off.
	 */
	priceScaling: number;
	minScore: number;
	maxScore: number;
	route: boolean;
}

export const ROUTER_MODES = ["low", "medium", "high"] as const;
export type RouterMode = (typeof ROUTER_MODES)[number];
export const DEFAULT_ROUTER_MODE: RouterMode = "medium";

export function isRouterMode(value: unknown): value is RouterMode {
	return typeof value === "string" && (ROUTER_MODES as readonly string[]).includes(value);
}

/** Per-mode overrides of tuning and thinking (the base tuning is "medium"). */
export interface RouterModeConfig {
	description: string;
	tuning: Partial<RouterTuning>;
	thinking: Partial<Pick<RouterThinking, "shift" | "maxAuto" | "prefer" | "beyondCapWhenShort">>;
	/**
	 * Lowest thinking level the router sends in this mode (min_thinking). A hard floor: it holds on
	 * trivial turns too. A level the user pinned is not bound by it.
	 */
	minThinking?: ModelThinkingLevel;
	/**
	 * Highest thinking level the router sends in this mode (max_thinking). A hard cap: escalation
	 * (tool errors, failing tests, momentum) may move to a stronger model but never above it. A level
	 * the user pinned is not bound by it.
	 */
	maxThinking?: ModelThinkingLevel;
	/** Prompt-cache pricing overrides for this mode (modes.<mode>.cache), on top of quality.cache. */
	cache?: Partial<RouterCacheModel>;
	/**
	 * Trivial-turn bound (trivial_below): a turn whose classifier difficulty (plus this turn's boosts and
	 * the low-confidence boost, without momentum) is below it is trivial. A trivial turn takes the
	 * cheapest feasible model at the lowest level the floor allows. 0 (default) turns it off.
	 */
	trivialBelow?: number;
	/** Quality selection: this mode's quality band (tolerance); default quality.tolerance. */
	tolerance?: number;
}

/** Task families the quality curves are measured for. */
export const TASK_KINDS = ["chat", "code", "algo", "math", "agentic", "terminal"] as const;
export type TaskKind = (typeof TASK_KINDS)[number];

/** Pass rate at the easy, medium and hard anchors (trivial = easy; frontier is extrapolated). */
export type TierTriple = [number, number, number];

/** One (model, thinking level) pair's calibrated curves. */
export interface QualityLevel {
	/** Mean reasoning tokens per call at the easy, medium and hard anchors. */
	reasoningTokens: TierTriple;
	pass: Partial<Record<TaskKind, TierTriple>>;
}

export interface QualityModel {
	/** Time to first token in ms (tie-break between equally cheap pairs). */
	ttftMs?: number;
	levels: Partial<Record<ModelThinkingLevel, QualityLevel>>;
}

/**
 * Quality-curve selection (router v2). Present in the shipped router.yaml; a catalog without it (or with
 * `selection: scores`) uses the skill-score selector.
 */
export interface RouterQuality {
	/** Difficulty of the trivial, easy, medium, hard and frontier anchors (ascending, 0..1). */
	anchors: [number, number, number, number, number];
	/** Frontier pass rate = hard pass rate ^ frontier_exponent (no data above hard). */
	frontierExponent: number;
	/** Medium-mode quality band: a pair is good enough when its pass rate is within this of the best. */
	tolerance: number;
	/** Answer tokens for the classifier's output-length levels (tiny, short, long, very long). */
	answerTokens: [number, number, number, number];
	defaultAnswerTokens: number;
	/** Pass-rate points taken off a model with no curves of its own (derived from the closest benched model). */
	unbenchedPenalty: number;
	/**
	 * How auto routing treats an unbenched pair (a model without curves of its own): "last_resort" (default)
	 * uses it only when no benched model fits the request; "penalty" lets it compete with the penalty.
	 */
	unbenchedPolicy: "last_resort" | "penalty";
	/** Fallback model whose curves an unbenched model borrows when no benched model is closer. */
	referenceModel: string;
	/** Skill whose score stands for a task kind (unbenched-model offsets, footer, legacy policy). */
	kindSkills: Partial<Record<TaskKind, string>>;
	/** A kind without its own curves uses another kind's (terminal -> agentic). */
	kindFrom: Partial<Record<TaskKind, TaskKind>>;
	/** Public-benchmark leans in pass-rate points at the hard anchor (half at medium, none below). */
	priors: Partial<Record<TaskKind, Record<string, number>>>;
	/** Escalation: a step needs this much more pass rate than the failed pair; at most max_steps. */
	stepMargin: number;
	maxSteps: number;
	/** Prompt-cache pricing of a switch (router v3); see router.yaml `quality.cache`. */
	cache: RouterCacheModel;
	models: Record<string, QualityModel>;
}

/**
 * How the router prices leaving a warm (model, thinking) pair. RunInfra keeps one prompt cache per pair on a
 * session: a switch misses once on the new pair, a return within the idle TTL is
 * warm up to where that pair left off, and a thinking change is a switch.
 */
export interface RouterCacheModel {
	/** false: one-turn pricing (warm price for the held pair only), no stickiness. */
	enabled: boolean;
	/** Provider cache idle TTL: a pair unused for longer is cold (RunInfra affinity: 900 s). */
	ttlSec: number;
	/** Turns a switch is expected to last before the next free switch point. */
	horizonTurns: number;
	/** Chance the session comes back to the pair it leaves (escalations decay back). */
	returnProbability: number;
	/** Tokens a turn adds to the context (answer, tool calls and results): the miss on the way back. */
	turnGrowthTokens: number;
	/** Cost of one failed turn in USD (the wasted turn, the retry, the user's time) that a better pair avoids. */
	failedTurnUsd: number;
	/** Inside the band, the pass-rate gain a pair needs over the warm one before it may cost a miss. */
	clearGain: number;
	/**
	 * A session's first pick: the share of failed_turn_usd its pass rate counts for (0: the cheapest good pair). The
	 * first pick is the pair a sticky session stays on, so a mode that rarely leaves the warm pair weighs it.
	 */
	firstTurnQuality: number;
}

export const DEFAULT_CACHE_MODEL: RouterCacheModel = {
	enabled: true,
	ttlSec: 900,
	horizonTurns: 4,
	returnProbability: 0.5,
	turnGrowthTokens: 4000,
	failedTurnUsd: 0.035,
	clearGain: 0.02,
	firstTurnQuality: 0,
};

/** Cache keys a mode may override (modes.<mode>.cache): the pricing, not the provider facts (enabled, ttl_sec). */
const MODE_CACHE_KEYS: ReadonlyArray<keyof RouterCacheModel> = [
	"horizonTurns",
	"returnProbability",
	"turnGrowthTokens",
	"failedTurnUsd",
	"clearGain",
	"firstTurnQuality",
];

export interface RouterCatalog {
	/** Short hash of the effective catalog; part of decision-cache keys. */
	version: string;
	sources: string[];
	tuning: RouterTuning;
	escalation: RouterEscalation;
	thinking: RouterThinking;
	skills: RouterSkill[];
	models: Record<string, RouterModelScores>;
	unknownModel: RouterUnknownModel;
	modes: Record<RouterMode, RouterModeConfig>;
	/** "quality" (curves, router v2) or "scores" (skill-score bars). Default: quality when curves exist. */
	selection: "quality" | "scores";
	quality?: RouterQuality;
}

const THINKING_LEVELS: readonly ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export const DEFAULT_TUNING: RouterTuning = {
	skillThreshold: 0.12,
	maxSecondarySkills: 3,
	reqBase: 20,
	reqSpan: 75,
	secondaryFactor: 0.8,
	lowConfidenceBoost: 0.15,
	costTiebreakFrac: 0.5,
	stickiness: 0.25,
	defaultOutputTokens: 2048,
	momentumDecay: 0.85,
	sessionIdleResetMin: 30,
	longctxTokens: 131072,
	failedModelCooldownSec: 300,
};

export const DEFAULT_ESCALATION: RouterEscalation = {
	toolError: 0.08,
	toolErrorCap: 0.24,
	testFailure: 0.15,
	userRetry: 0.1,
	multiFile: 0.05,
	longLoop: 0.05,
};

export const DEFAULT_THINKING: RouterThinking = {
	levels: [
		[0.3, "off"],
		[0.55, "minimal"],
		[0.75, "low"],
		[0.9, "medium"],
		[1.01, "high"],
	],
	maxAuto: "xhigh",
	shift: 0,
	qualityBonus: { off: 0, minimal: 2, low: 4, medium: 7, high: 10, xhigh: 12, max: 14 },
	prefer: "lowest",
	beyondCapWhenShort: true,
	deepSkills: [],
	lightSkills: [],
	outputMultiplier: { off: 1, minimal: 1.2, low: 1.5, medium: 2, high: 3, xhigh: 4, max: 5 },
};

export const DEFAULT_UNKNOWN_MODEL: RouterUnknownModel = {
	skillScore: 45,
	priceScaling: 8,
	minScore: 25,
	maxScore: 70,
	route: true,
};

export const DEFAULT_MODES: Record<RouterMode, RouterModeConfig> = {
	low: {
		description: "cost-efficient: lower bars, cheapest model, lighter thinking",
		tuning: { reqBase: 15, reqSpan: 60, costTiebreakFrac: 0.05 },
		// maxThinking is the cap; a maxAuto above it would never apply (resolveModeConfig clamps it).
		thinking: { shift: -1, beyondCapWhenShort: false },
		maxThinking: "low",
	},
	medium: { description: "balanced: cost-aware, leans toward quality", tuning: {}, thinking: {} },
	high: {
		description: "deepest: strongest model and deepest thinking for hard tasks",
		tuning: { reqBase: 30, reqSpan: 70, costTiebreakFrac: 10, stickiness: 0 },
		thinking: { shift: 1, maxAuto: "max", prefer: "highest" },
		minThinking: "low",
		trivialBelow: 0.2,
	},
};

type Raw = Record<string, unknown>;

function isRecord(value: unknown): value is Raw {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function snakeToCamel(key: string): string {
	return key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

function readNumbers<T extends object>(base: T, raw: unknown, path: string): T {
	const baseRecord = base as unknown as Record<string, unknown>;
	if (raw === undefined) return { ...base };
	if (!isRecord(raw)) throw new Error(`${path}: expected a mapping`);
	const result: Record<string, unknown> = { ...baseRecord };
	for (const [key, value] of Object.entries(raw)) {
		const camel = snakeToCamel(key);
		if (!(camel in baseRecord)) throw new Error(`${path}.${key}: unknown key`);
		if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
			throw new Error(`${path}.${key}: expected a non-negative number`);
		}
		result[camel] = value;
	}
	return result as unknown as T;
}

function isThinkingLevel(value: unknown): value is ModelThinkingLevel {
	return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);
}

function stringList(raw: unknown, path: string): string[] {
	if (!Array.isArray(raw) || raw.some((item) => typeof item !== "string")) {
		throw new Error(`${path}: expected a list of strings`);
	}
	return raw as string[];
}

function readThinking(base: RouterThinking, raw: unknown, path: string): RouterThinking {
	if (raw === undefined) return structuredClone(base);
	if (!isRecord(raw)) throw new Error(`${path}: expected a mapping`);
	const result = structuredClone(base);
	for (const [key, value] of Object.entries(raw)) {
		switch (snakeToCamel(key)) {
			case "levels": {
				if (!Array.isArray(value) || value.length === 0) throw new Error(`${path}.levels: expected a list`);
				const levels: Array<[number, ModelThinkingLevel]> = [];
				for (const [index, pair] of value.entries()) {
					if (!Array.isArray(pair) || typeof pair[0] !== "number" || !isThinkingLevel(pair[1])) {
						throw new Error(`${path}.levels[${index}]: expected [bound, level]`);
					}
					if (levels.length > 0 && pair[0] <= levels[levels.length - 1][0]) {
						throw new Error(`${path}.levels: bounds must ascend`);
					}
					levels.push([pair[0], pair[1]]);
				}
				result.levels = levels;
				break;
			}
			case "maxAuto":
				if (!isThinkingLevel(value)) throw new Error(`${path}.max_auto: unknown thinking level`);
				result.maxAuto = value;
				break;
			case "beyondCapWhenShort":
				if (typeof value !== "boolean") throw new Error(`${path}.beyond_cap_when_short: expected true or false`);
				result.beyondCapWhenShort = value;
				break;
			case "prefer":
				if (value !== "lowest" && value !== "highest")
					throw new Error(`${path}.prefer: expected lowest or highest`);
				result.prefer = value;
				break;
			case "qualityBonus": {
				if (!isRecord(value)) throw new Error(`${path}.quality_bonus: expected a mapping`);
				for (const [level, bonus] of Object.entries(value)) {
					if (!isThinkingLevel(level) || typeof bonus !== "number" || !Number.isFinite(bonus) || bonus < 0) {
						throw new Error(`${path}.quality_bonus.${level}: expected a level and a non-negative number`);
					}
					result.qualityBonus[level] = bonus;
				}
				break;
			}
			case "shift":
				if (typeof value !== "number" || !Number.isInteger(value) || Math.abs(value) > 3) {
					throw new Error(`${path}.shift: expected an integer from -3 to 3`);
				}
				result.shift = value;
				break;
			case "deepSkills":
				result.deepSkills = stringList(value, `${path}.deep_skills`);
				break;
			case "lightSkills":
				result.lightSkills = stringList(value, `${path}.light_skills`);
				break;
			case "outputMultiplier": {
				if (!isRecord(value)) throw new Error(`${path}.output_multiplier: expected a mapping`);
				for (const [level, factor] of Object.entries(value)) {
					if (!isThinkingLevel(level) || typeof factor !== "number" || !(factor > 0)) {
						throw new Error(`${path}.output_multiplier.${level}: expected a level and a positive number`);
					}
					result.outputMultiplier[level] = factor;
				}
				break;
			}
			default:
				throw new Error(`${path}.${key}: unknown key`);
		}
	}
	return result;
}

function readSkills(base: RouterSkill[], raw: unknown, path: string): RouterSkill[] {
	if (raw === undefined) return base.map((skill) => ({ ...skill }));
	if (!Array.isArray(raw)) throw new Error(`${path}: expected a list`);
	const result = base.map((skill) => ({ ...skill }));
	const seen = new Set<string>();
	for (const [index, entry] of raw.entries()) {
		if (!isRecord(entry) || typeof entry.name !== "string" || !entry.name.trim()) {
			throw new Error(`${path}[${index}]: every skill needs a name`);
		}
		const name = entry.name.trim();
		if (seen.has(name)) throw new Error(`${path}: duplicate skill "${name}"`);
		seen.add(name);
		const skill = { name, desc: typeof entry.desc === "string" && entry.desc.trim() ? entry.desc.trim() : name };
		const existing = result.findIndex((candidate) => candidate.name === name);
		if (existing >= 0) result[existing] = skill;
		else result.push(skill);
	}
	return result;
}

function readModels(
	base: Record<string, RouterModelScores>,
	raw: unknown,
	path: string,
): Record<string, RouterModelScores> {
	const result: Record<string, RouterModelScores> = structuredClone(base);
	if (raw === undefined) return result;
	if (!isRecord(raw)) throw new Error(`${path}: expected a mapping of model id to scores`);
	for (const [id, entry] of Object.entries(raw)) {
		if (!isRecord(entry)) throw new Error(`${path}.${id}: expected a mapping`);
		const current = result[id] ?? { intelligence: 0, skills: {}, route: true };
		if (entry.intelligence !== undefined) {
			if (typeof entry.intelligence !== "number" || !Number.isFinite(entry.intelligence)) {
				throw new Error(`${path}.${id}.intelligence: expected a number`);
			}
			current.intelligence = entry.intelligence;
		}
		if (entry.route !== undefined) {
			if (typeof entry.route !== "boolean") throw new Error(`${path}.${id}.route: expected true or false`);
			current.route = entry.route;
		}
		const maxAuto = "max_auto_thinking" in entry ? entry.max_auto_thinking : entry.maxAutoThinking;
		if (maxAuto === null) delete current.maxAutoThinking;
		else if (maxAuto !== undefined) {
			// "none" is the provider name for "off".
			const level = maxAuto === "none" ? "off" : maxAuto;
			if (!isThinkingLevel(level)) {
				throw new Error(
					`${path}.${id}.max_auto_thinking: unknown thinking level (use ${THINKING_LEVELS.join(", ")})`,
				);
			}
			current.maxAutoThinking = level;
		}
		const offBelow = "auto_off_below" in entry ? entry.auto_off_below : entry.autoOffBelow;
		if (offBelow === null) delete current.autoOffBelow;
		else if (offBelow !== undefined) {
			if (typeof offBelow !== "number" || !Number.isFinite(offBelow) || offBelow < 0 || offBelow > 1) {
				throw new Error(`${path}.${id}.auto_off_below: expected a difficulty from 0 to 1`);
			}
			current.autoOffBelow = offBelow;
		}
		if (entry.catalog === null) delete current.catalog;
		else if (entry.catalog !== undefined)
			current.catalog = readCatalogOverride(current.catalog, entry.catalog, `${path}.${id}.catalog`);
		if (entry.skills !== undefined) {
			if (!isRecord(entry.skills)) throw new Error(`${path}.${id}.skills: expected a mapping`);
			for (const [skill, score] of Object.entries(entry.skills)) {
				if (typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > 100) {
					throw new Error(`${path}.${id}.skills.${skill}: expected a score from 0 to 100`);
				}
				current.skills[skill] = score;
			}
		}
		result[id] = current;
	}
	return result;
}

function readCatalogOverride(base: CatalogOverride | undefined, raw: unknown, path: string): CatalogOverride {
	if (!isRecord(raw)) throw new Error(`${path}: expected a mapping`);
	const result: CatalogOverride = { ...(base ?? {}) };
	const positive = (value: unknown, at: string): number => {
		if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
			throw new Error(`${at}: expected a non-negative number`);
		return value;
	};
	for (const [key, value] of Object.entries(raw)) {
		switch (key) {
			case "price": {
				if (!isRecord(value)) throw new Error(`${path}.price: expected { in, out, cached_in }`);
				for (const [k, v] of Object.entries(value)) {
					if (k === "in") result.priceIn = positive(v, `${path}.price.in`);
					else if (k === "out") result.priceOut = positive(v, `${path}.price.out`);
					else if (k === "cached_in") result.priceCachedIn = positive(v, `${path}.price.cached_in`);
					else throw new Error(`${path}.price.${k}: unknown key (in, out, cached_in)`);
				}
				break;
			}
			case "context":
				result.contextWindow = positive(value, `${path}.context`);
				break;
			case "max_output":
				result.maxOutputTokens = positive(value, `${path}.max_output`);
				break;
			case "reasoning_efforts":
				result.reasoningEfforts = stringList(value, `${path}.reasoning_efforts`);
				break;
			default:
				throw new Error(`${path}.${key}: unknown key (price, context, max_output, reasoning_efforts)`);
		}
	}
	return result;
}

function readUnknownModel(base: RouterUnknownModel, raw: unknown, path: string): RouterUnknownModel {
	if (raw === undefined) return { ...base };
	if (!isRecord(raw)) throw new Error(`${path}: expected a mapping`);
	const { route, ...numbers } = raw;
	const { route: baseRoute, ...baseNumbers } = base;
	if (route !== undefined && typeof route !== "boolean") throw new Error(`${path}.route: expected true or false`);
	return { ...readNumbers(baseNumbers, numbers, path), route: (route as boolean | undefined) ?? baseRoute };
}

const MODE_KEYS = [
	"description",
	"tuning",
	"thinking",
	"min_thinking",
	"minThinking",
	"max_thinking",
	"maxThinking",
	"trivial_below",
	"trivialBelow",
	"tolerance",
	"cache",
];

function readModes(
	base: Record<RouterMode, RouterModeConfig>,
	raw: unknown,
	path: string,
): Record<RouterMode, RouterModeConfig> {
	const result = structuredClone(base);
	if (raw === undefined) return result;
	if (!isRecord(raw)) throw new Error(`${path}: expected a mapping of mode to overrides`);
	for (const [mode, entry] of Object.entries(raw)) {
		if (!isRouterMode(mode)) throw new Error(`${path}.${mode}: unknown mode (use ${ROUTER_MODES.join(", ")})`);
		if (entry === null) continue;
		if (!isRecord(entry)) throw new Error(`${path}.${mode}: expected a mapping`);
		const current = result[mode];
		for (const key of Object.keys(entry)) {
			if (!MODE_KEYS.includes(key)) throw new Error(`${path}.${mode}.${key}: unknown key`);
		}
		if (typeof entry.description === "string") current.description = entry.description;
		for (const [snake, camel] of [
			["min_thinking", "minThinking"],
			["max_thinking", "maxThinking"],
		] as const) {
			const raw = snake in entry ? entry[snake] : entry[camel];
			if (raw === undefined) continue;
			// null clears a bound inherited from the defaults; "none" is the provider name for "off".
			if (raw === null) {
				delete current[camel];
				continue;
			}
			const value = raw === "none" ? "off" : raw;
			if (!isThinkingLevel(value)) {
				throw new Error(`${path}.${mode}.${snake}: unknown thinking level (use ${THINKING_LEVELS.join(", ")})`);
			}
			current[camel] = value;
		}
		const trivial = entry.trivial_below ?? entry.trivialBelow;
		if (trivial !== undefined) {
			if (typeof trivial !== "number" || !Number.isFinite(trivial) || trivial < 0 || trivial > 1) {
				throw new Error(`${path}.${mode}.trivial_below: expected a difficulty from 0 to 1`);
			}
			current.trivialBelow = trivial;
		}
		if (entry.tolerance !== undefined) {
			if (
				typeof entry.tolerance !== "number" ||
				!Number.isFinite(entry.tolerance) ||
				entry.tolerance < 0 ||
				entry.tolerance > 1
			) {
				throw new Error(`${path}.${mode}.tolerance: expected a pass-rate band from 0 to 1`);
			}
			current.tolerance = entry.tolerance;
		}
		if (entry.cache !== undefined) {
			if (!isRecord(entry.cache)) throw new Error(`${path}.${mode}.cache: expected a mapping`);
			const parsed = readCache({ ...DEFAULT_CACHE_MODEL }, entry.cache, `${path}.${mode}.cache`);
			const overrides: Partial<RouterCacheModel> = { ...current.cache };
			for (const key of Object.keys(entry.cache)) {
				const camel = snakeToCamel(key) as keyof RouterCacheModel;
				if (!MODE_CACHE_KEYS.includes(camel)) {
					throw new Error(
						`${path}.${mode}.cache.${key}: set it under quality.cache (it is the same for every mode)`,
					);
				}
				Object.assign(overrides, { [camel]: parsed[camel] });
			}
			current.cache = overrides;
		}
		if (
			current.minThinking &&
			current.maxThinking &&
			THINKING_LEVELS.indexOf(current.minThinking) > THINKING_LEVELS.indexOf(current.maxThinking)
		) {
			throw new Error(
				`${path}.${mode}: min_thinking (${current.minThinking}) is above max_thinking (${current.maxThinking})`,
			);
		}
		if (entry.tuning !== undefined) {
			if (!isRecord(entry.tuning)) throw new Error(`${path}.${mode}.tuning: expected a mapping`);
			const parsed = readNumbers(DEFAULT_TUNING, entry.tuning, `${path}.${mode}.tuning`);
			for (const key of Object.keys(entry.tuning)) {
				const camel = snakeToCamel(key) as keyof RouterTuning;
				current.tuning[camel] = parsed[camel];
			}
		}
		if (entry.thinking !== undefined) {
			if (!isRecord(entry.thinking)) throw new Error(`${path}.${mode}.thinking: expected a mapping`);
			for (const key of Object.keys(entry.thinking)) {
				if (
					!["shift", "max_auto", "maxAuto", "prefer", "beyond_cap_when_short", "beyondCapWhenShort"].includes(key)
				) {
					throw new Error(
						`${path}.${mode}.thinking.${key}: only shift, max_auto, prefer and beyond_cap_when_short can change per mode`,
					);
				}
			}
			const parsed = readThinking(DEFAULT_THINKING, entry.thinking, `${path}.${mode}.thinking`);
			if (entry.thinking.shift !== undefined) current.thinking.shift = parsed.shift;
			if (entry.thinking.prefer !== undefined) current.thinking.prefer = parsed.prefer;
			if (entry.thinking.beyond_cap_when_short !== undefined || entry.thinking.beyondCapWhenShort !== undefined) {
				current.thinking.beyondCapWhenShort = parsed.beyondCapWhenShort;
			}
			if (entry.thinking.max_auto !== undefined || entry.thinking.maxAuto !== undefined) {
				current.thinking.maxAuto = parsed.maxAuto;
				// Both set in one mode entry with max_auto above max_thinking: max_auto would be dead (the hard
				// cap wins in resolveModeConfig), so say so instead of silently ignoring it.
				const ownCap = entry.max_thinking ?? entry.maxThinking;
				if (
					ownCap !== undefined &&
					ownCap !== null &&
					current.maxThinking &&
					THINKING_LEVELS.indexOf(parsed.maxAuto) > THINKING_LEVELS.indexOf(current.maxThinking)
				) {
					throw new Error(
						`${path}.${mode}.thinking.max_auto: ${parsed.maxAuto} is above max_thinking (${current.maxThinking}) and would never apply; drop it or raise max_thinking`,
					);
				}
			}
		}
	}
	return result;
}

/**
 * Tuning and thinking for one routing mode: the base values with the mode's overrides. The mode's
 * min_thinking/max_thinking become thinking.floor/ceiling, and max_auto never exceeds the ceiling.
 */
export function resolveModeConfig(
	catalog: Pick<RouterCatalog, "tuning" | "thinking" | "modes">,
	mode: RouterMode,
): {
	tuning: RouterTuning;
	thinking: RouterThinking;
	trivialBelow: number;
	tolerance?: number;
	cache?: Partial<RouterCacheModel>;
} {
	const overrides = catalog.modes[mode];
	const thinking: RouterThinking = { ...catalog.thinking, ...overrides.thinking };
	if (overrides.minThinking) thinking.floor = overrides.minThinking;
	if (overrides.maxThinking) {
		thinking.ceiling = overrides.maxThinking;
		if (THINKING_LEVELS.indexOf(thinking.maxAuto) > THINKING_LEVELS.indexOf(overrides.maxThinking)) {
			thinking.maxAuto = overrides.maxThinking;
		}
	}
	return {
		tuning: { ...catalog.tuning, ...overrides.tuning },
		thinking,
		trivialBelow: overrides.trivialBelow ?? 0,
		tolerance: overrides.tolerance,
		cache: overrides.cache,
	};
}

export const DEFAULT_QUALITY: Omit<RouterQuality, "models"> = {
	anchors: [0, 0.25, 0.5, 0.75, 1],
	frontierExponent: 2,
	tolerance: 0.04,
	answerTokens: [150, 700, 2500, 6000],
	defaultAnswerTokens: 900,
	unbenchedPenalty: 0.05,
	unbenchedPolicy: "last_resort",
	referenceModel: "",
	kindSkills: {},
	kindFrom: {},
	priors: {},
	stepMargin: 0.02,
	maxSteps: 2,
	cache: { ...DEFAULT_CACHE_MODEL },
};

function readCache(base: RouterCacheModel, raw: Raw, at: string): RouterCacheModel {
	const result = { ...base };
	for (const [k, v] of Object.entries(raw)) {
		const where = `${at}.${k}`;
		switch (snakeToCamel(k)) {
			case "enabled":
				if (typeof v !== "boolean") throw new Error(`${where}: expected true or false`);
				result.enabled = v;
				break;
			case "ttlSec":
				result.ttlSec = nonNegative(v, where);
				break;
			case "horizonTurns":
				result.horizonTurns = Math.max(1, nonNegative(v, where));
				break;
			case "returnProbability":
				result.returnProbability = unit(v, where);
				break;
			case "turnGrowthTokens":
				result.turnGrowthTokens = nonNegative(v, where);
				break;
			case "failedTurnUsd":
				result.failedTurnUsd = nonNegative(v, where);
				break;
			case "clearGain":
				result.clearGain = unit(v, where);
				break;
			case "firstTurnQuality":
				result.firstTurnQuality = unit(v, where);
				break;
			default:
				throw new Error(`${where}: unknown key`);
		}
	}
	return result;
}

function unit(value: unknown, path: string): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
		throw new Error(`${path}: expected a number from 0 to 1`);
	}
	return value;
}

function triple(value: unknown, path: string, check: (v: unknown, p: string) => number): TierTriple {
	if (!Array.isArray(value) || value.length !== 3) throw new Error(`${path}: expected [easy, medium, hard]`);
	return [check(value[0], `${path}[0]`), check(value[1], `${path}[1]`), check(value[2], `${path}[2]`)];
}

function nonNegative(value: unknown, path: string): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		throw new Error(`${path}: expected a non-negative number`);
	}
	return value;
}

function isTaskKind(value: unknown): value is TaskKind {
	return typeof value === "string" && (TASK_KINDS as readonly string[]).includes(value);
}

function readQuality(base: RouterQuality | undefined, raw: unknown, path: string): RouterQuality | undefined {
	if (raw === undefined) return base ? structuredClone(base) : undefined;
	if (raw === null) return undefined;
	if (!isRecord(raw)) throw new Error(`${path}: expected a mapping`);
	const result: RouterQuality = base ? structuredClone(base) : { ...structuredClone(DEFAULT_QUALITY), models: {} };
	for (const [key, value] of Object.entries(raw)) {
		const at = `${path}.${key}`;
		switch (snakeToCamel(key)) {
			case "anchors": {
				if (!Array.isArray(value) || value.length !== 5) throw new Error(`${at}: expected five difficulties`);
				const anchors = value.map((v, i) => unit(v, `${at}[${i}]`));
				for (let i = 1; i < 5; i++) if (anchors[i] <= anchors[i - 1]) throw new Error(`${at}: must ascend`);
				result.anchors = anchors as RouterQuality["anchors"];
				break;
			}
			case "frontierExponent":
				result.frontierExponent = nonNegative(value, at);
				break;
			case "tolerance":
				result.tolerance = unit(value, at);
				break;
			case "answerTokens": {
				if (!Array.isArray(value) || value.length !== 4) throw new Error(`${at}: expected four token counts`);
				result.answerTokens = value.map((v, i) => nonNegative(v, `${at}[${i}]`)) as RouterQuality["answerTokens"];
				break;
			}
			case "defaultAnswerTokens":
				result.defaultAnswerTokens = nonNegative(value, at);
				break;
			case "unbenchedPenalty":
				result.unbenchedPenalty = unit(value, at);
				break;
			case "unbenchedPolicy":
				if (value !== "last_resort" && value !== "penalty")
					throw new Error(`${at}: expected last_resort or penalty`);
				result.unbenchedPolicy = value;
				break;
			case "referenceModel":
				if (typeof value !== "string") throw new Error(`${at}: expected a model id`);
				result.referenceModel = value;
				break;
			case "stepMargin":
				result.stepMargin = unit(value, at);
				break;
			case "maxSteps":
				if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 5) {
					throw new Error(`${at}: expected an integer from 0 to 5`);
				}
				result.maxSteps = value;
				break;
			case "cache": {
				if (!isRecord(value)) throw new Error(`${at}: expected a mapping`);
				result.cache = readCache(result.cache, value, at);
				break;
			}
			case "kindSkills":
			case "kindFrom": {
				if (!isRecord(value)) throw new Error(`${at}: expected a mapping of task kind`);
				for (const [kind, target] of Object.entries(value)) {
					if (!isTaskKind(kind))
						throw new Error(`${at}.${kind}: unknown task kind (use ${TASK_KINDS.join(", ")})`);
					if (typeof target !== "string") throw new Error(`${at}.${kind}: expected a string`);
					if (key.startsWith("kind_from") || key === "kindFrom") {
						if (!isTaskKind(target)) throw new Error(`${at}.${kind}: unknown task kind "${target}"`);
						result.kindFrom[kind] = target;
					} else result.kindSkills[kind] = target;
				}
				break;
			}
			case "priors": {
				if (!isRecord(value)) throw new Error(`${at}: expected a mapping of task kind to model leans`);
				for (const [kind, leans] of Object.entries(value)) {
					if (!isTaskKind(kind)) throw new Error(`${at}.${kind}: unknown task kind`);
					if (!isRecord(leans)) throw new Error(`${at}.${kind}: expected a mapping of model id to points`);
					const parsed: Record<string, number> = {};
					for (const [model, lean] of Object.entries(leans)) {
						if (typeof lean !== "number" || !Number.isFinite(lean) || Math.abs(lean) > 0.5) {
							throw new Error(`${at}.${kind}.${model}: expected a number from -0.5 to 0.5`);
						}
						parsed[model] = lean;
					}
					result.priors[kind] = parsed;
				}
				break;
			}
			case "models": {
				if (!isRecord(value)) throw new Error(`${at}: expected a mapping of model id`);
				for (const [id, entry] of Object.entries(value)) {
					if (entry === null) {
						delete result.models[id];
						continue;
					}
					if (!isRecord(entry)) throw new Error(`${at}.${id}: expected a mapping`);
					const model: QualityModel = result.models[id] ?? { levels: {} };
					for (const k of Object.keys(entry)) {
						if (!["ttft_ms", "ttftMs", "levels"].includes(k)) throw new Error(`${at}.${id}.${k}: unknown key`);
					}
					const ttft = entry.ttft_ms ?? entry.ttftMs;
					if (ttft !== undefined) model.ttftMs = nonNegative(ttft, `${at}.${id}.ttft_ms`);
					if (entry.levels !== undefined) {
						if (!isRecord(entry.levels)) throw new Error(`${at}.${id}.levels: expected a mapping`);
						for (const [rawLevel, levelEntry] of Object.entries(entry.levels)) {
							const level = rawLevel === "none" ? "off" : rawLevel;
							const lp = `${at}.${id}.levels.${rawLevel}`;
							if (!isThinkingLevel(level)) throw new Error(`${lp}: unknown thinking level`);
							if (!isRecord(levelEntry)) throw new Error(`${lp}: expected a mapping`);
							// A user file merges per kind over the shipped entry for this level.
							const existing = model.levels[level];
							const parsed: QualityLevel = existing
								? { reasoningTokens: [...existing.reasoningTokens], pass: { ...existing.pass } }
								: { reasoningTokens: [0, 0, 0], pass: {} };
							for (const [k, v] of Object.entries(levelEntry)) {
								if (k === "reasoning_tokens" || k === "reasoningTokens") {
									parsed.reasoningTokens = triple(v, `${lp}.${k}`, nonNegative);
								} else if (isTaskKind(k)) parsed.pass[k] = triple(v, `${lp}.${k}`, unit);
								else throw new Error(`${lp}.${k}: unknown key (reasoning_tokens or a task kind)`);
							}
							model.levels[level] = parsed;
						}
					}
					result.models[id] = model;
				}
				break;
			}
			default:
				throw new Error(`${at}: unknown key`);
		}
	}
	return result;
}

const EMPTY_CATALOG: Omit<RouterCatalog, "version" | "sources"> = {
	tuning: DEFAULT_TUNING,
	escalation: DEFAULT_ESCALATION,
	thinking: DEFAULT_THINKING,
	skills: [],
	models: {},
	unknownModel: DEFAULT_UNKNOWN_MODEL,
	modes: DEFAULT_MODES,
	selection: "scores",
};

/** Merges one parsed router.yaml document over `base`. */
export function mergeRouterCatalog(
	base: Omit<RouterCatalog, "version" | "sources">,
	doc: unknown,
	path: string,
): Omit<RouterCatalog, "version" | "sources"> {
	if (doc === null || doc === undefined) return structuredClone(base);
	if (!isRecord(doc)) throw new Error(`${path}: expected a YAML mapping`);
	for (const key of Object.keys(doc)) {
		if (
			![
				"version",
				"tuning",
				"escalation",
				"thinking",
				"skills",
				"models",
				"unknown_model",
				"modes",
				"selection",
				"quality",
			].includes(key)
		) {
			throw new Error(`${path}: unknown top-level key "${key}"`);
		}
	}
	const merged = {
		tuning: readNumbers(base.tuning, doc.tuning, `${path}: tuning`),
		escalation: readNumbers(base.escalation, doc.escalation, `${path}: escalation`),
		thinking: readThinking(base.thinking, doc.thinking, `${path}: thinking`),
		skills: readSkills(base.skills, doc.skills, `${path}: skills`),
		models: readModels(base.models, doc.models, `${path}: models`),
		unknownModel: readUnknownModel(base.unknownModel, doc.unknown_model, `${path}: unknown_model`),
		modes: readModes(base.modes, doc.modes, `${path}: modes`),
		selection: base.selection,
		quality: readQuality(base.quality, doc.quality, `${path}: quality`),
	};
	if (doc.quality !== undefined && doc.quality !== null && doc.selection === undefined) merged.selection = "quality";
	if (doc.quality === null) merged.selection = "scores";
	if (doc.selection !== undefined) {
		if (doc.selection !== "quality" && doc.selection !== "scores") {
			throw new Error(`${path}: selection must be quality or scores`);
		}
		merged.selection = doc.selection;
	}
	if (merged.selection === "quality" && !merged.quality) {
		throw new Error(`${path}: selection: quality needs a quality section`);
	}
	const known = new Set(merged.skills.map((skill) => skill.name));
	for (const [id, model] of Object.entries(merged.models)) {
		for (const skill of Object.keys(model.skills)) {
			if (!known.has(skill)) throw new Error(`${path}: models.${id} scores unknown skill "${skill}"`);
		}
	}
	return merged;
}

export function parseRouterCatalog(
	documents: Array<{ text: string; path: string }>,
	base: Omit<RouterCatalog, "version" | "sources"> = EMPTY_CATALOG,
): RouterCatalog {
	let merged = structuredClone(base);
	const hash = createHash("sha256");
	for (const { text, path } of documents) {
		merged = mergeRouterCatalog(merged, parseYaml(text) as unknown, path);
		hash.update(text);
	}
	if (merged.skills.length === 0) throw new Error("router catalog defines no skills");
	return { ...merged, version: hash.digest("hex").slice(0, 12), sources: documents.map((doc) => doc.path) };
}

/** Locates the bundled router.yaml: dist/, the package root, or the repo root in source checkouts. */
export function getBundledRouterYamlPath(): string {
	const packageDir = getPackageDir();
	const candidates = [
		join(packageDir, "dist", ROUTER_CATALOG_FILE),
		join(packageDir, ROUTER_CATALOG_FILE),
		join(dirname(dirname(packageDir)), ROUTER_CATALOG_FILE),
	];
	const found = candidates.find((candidate) => existsSync(candidate));
	if (!found) throw new Error(`${ROUTER_CATALOG_FILE} not found (looked in: ${candidates.join(", ")})`);
	return found;
}

export function getUserRouterYamlPath(agentDir: string = getAgentDir()): string {
	return join(agentDir, ROUTER_CATALOG_FILE);
}

/** Bundled router.yaml merged with the user's `<agentDir>/router.yaml` when it exists. */
export function loadRouterCatalog(options: { agentDir?: string; bundledPath?: string } = {}): RouterCatalog {
	const bundledPath = options.bundledPath ?? getBundledRouterYamlPath();
	const documents = [{ text: readFileSync(bundledPath, "utf8"), path: bundledPath }];
	const userPath = getUserRouterYamlPath(options.agentDir);
	if (existsSync(userPath)) documents.push({ text: readFileSync(userPath, "utf8"), path: userPath });
	return parseRouterCatalog(documents);
}
