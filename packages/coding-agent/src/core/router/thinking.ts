/**
 * Thinking level per turn: from effective difficulty and the primary skill, clamped to what the chosen
 * model accepts.
 */

import type { ModelThinkingLevel } from "@runkiln/ai";
import type { RouterThinking } from "./catalog.ts";

export const THINKING_ORDER: readonly ModelThinkingLevel[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];

function shift(level: ModelThinkingLevel, steps: number): ModelThinkingLevel {
	const index = THINKING_ORDER.indexOf(level);
	return THINKING_ORDER[Math.min(THINKING_ORDER.length - 1, Math.max(0, index + steps))];
}

/** The level the router wants, before clamping to a model. */
export function desiredThinkingLevel(
	difficulty: number,
	primarySkill: string | undefined,
	config: RouterThinking,
): ModelThinkingLevel {
	let level: ModelThinkingLevel = config.levels[config.levels.length - 1][1];
	for (const [bound, candidate] of config.levels) {
		if (difficulty < bound) {
			level = candidate;
			break;
		}
	}
	if (primarySkill && config.deepSkills.includes(primarySkill)) level = shift(level, 1);
	else if (primarySkill && config.lightSkills.includes(primarySkill)) level = shift(level, -1);
	if (config.shift) level = shift(level, config.shift);
	const cap = THINKING_ORDER.indexOf(config.maxAuto);
	return THINKING_ORDER.indexOf(level) > cap ? config.maxAuto : level;
}

/**
 * Nearest supported level: the level itself, else the next higher, else the next lower
 * (same rule as clampThinkingLevel in @runkiln/ai).
 */
export function clampToSupported(
	level: ModelThinkingLevel,
	supported: readonly ModelThinkingLevel[],
): ModelThinkingLevel {
	if (supported.length === 0) return "off";
	if (supported.includes(level)) return level;
	const index = THINKING_ORDER.indexOf(level);
	for (let i = index + 1; i < THINKING_ORDER.length; i++) {
		if (supported.includes(THINKING_ORDER[i])) return THINKING_ORDER[i];
	}
	for (let i = index - 1; i >= 0; i--) {
		if (supported.includes(THINKING_ORDER[i])) return THINKING_ORDER[i];
	}
	return supported[0];
}

/**
 * Nearest supported level inside the [floor, ceiling] band of a routing mode (min_thinking /
 * max_thinking). The level is moved into the band first, then to the nearest level the model supports
 * inside it. When the model supports no level in the band, the band cannot hold: plain clampToSupported.
 */
export function clampToBand(
	level: ModelThinkingLevel,
	supported: readonly ModelThinkingLevel[],
	floor?: ModelThinkingLevel,
	ceiling?: ModelThinkingLevel,
): ModelThinkingLevel {
	if (!floor && !ceiling) return clampToSupported(level, supported);
	const low = floor ? THINKING_ORDER.indexOf(floor) : 0;
	const high = ceiling ? THINKING_ORDER.indexOf(ceiling) : THINKING_ORDER.length - 1;
	const inBand = (candidate: ModelThinkingLevel) => {
		const index = THINKING_ORDER.indexOf(candidate);
		return index >= low && index <= high;
	};
	const band = supported.filter(inBand);
	if (band.length === 0) return clampToSupported(level, supported);
	const index = Math.min(high, Math.max(low, THINKING_ORDER.indexOf(level)));
	return clampToSupported(THINKING_ORDER[index], band);
}

/** The higher of two levels. */
export function maxLevel(a: ModelThinkingLevel, b: ModelThinkingLevel | undefined): ModelThinkingLevel {
	if (!b) return a;
	return THINKING_ORDER.indexOf(b) > THINKING_ORDER.indexOf(a) ? b : a;
}
