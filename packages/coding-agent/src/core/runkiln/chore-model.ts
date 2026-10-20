/**
 * Side tasks ("chores"): the model calls RunKiln makes for itself, outside the user's turn. They need no
 * deep reasoning, so they go to a fast model with thinking off by default instead of the session model:
 *
 * - session titles (agent-session `_generateSessionTitle`)
 * - compaction summaries, manual and automatic (agent-session `_runDefaultCompaction`)
 * - branch summaries for /tree navigation (agent-session `navigateTree`)
 * - commit messages for /commit and git.autoCommit (agent-session `draftCommit`)
 * - repairs of missed edits, when `edit.autoRepair` is on (agent-session `_runEditRepairChore`)
 *
 * Setting `choreModel`: "<model>" or "<model>:<thinking>" (default "deepseek-v4-1-flash-1017:off"), or "session"
 * for the session model and thinking level. When the chosen model is missing, disabled (`disabledModels`),
 * paused in the live catalog or cooling down after failures, the next one is used: the default, then
 * glm-5-3-flash at low, then the session model.
 */

import type { Api, Model, ModelThinkingLevel } from "@runkiln/ai";
import { getSupportedThinkingLevels } from "@runkiln/ai";
import { clampToSupported, THINKING_ORDER } from "../router/thinking.ts";
import { effortToThinkingLevel } from "./models-catalog.ts";

export const DEFAULT_CHORE_MODEL = "deepseek-v4-1-flash-1017:off";
/** Used when the chore model cannot be: GLM at its lowest level. */
export const CHORE_FALLBACK_MODEL = "glm-5-3-flash:low";
export const SESSION_CHORE_MODEL = "session";

export type ChoreKind = "title" | "compaction" | "branch-summary" | "commit" | "edit-repair";

export interface ChoreModelSpec {
	id: string;
	level?: ModelThinkingLevel;
}

/** Parses "<model>[:<thinking>]" (a "runinfra/" prefix is allowed). "session" and blanks give undefined. */
export function parseChoreModel(value: string | undefined): ChoreModelSpec | undefined {
	const trimmed = value?.trim().replace(/^runinfra\//, "");
	if (!trimmed || trimmed === SESSION_CHORE_MODEL) return undefined;
	const colon = trimmed.lastIndexOf(":");
	if (colon > 0) {
		const level = effortToThinkingLevel(trimmed.slice(colon + 1));
		if (level && THINKING_ORDER.includes(level)) return { id: trimmed.slice(0, colon), level };
	}
	return { id: trimmed };
}

export interface ChoreModelChoice {
	model: Model<Api>;
	thinkingLevel: ModelThinkingLevel;
	/**
	 * setting: the choreModel setting; default: the default chore model (no setting, or the setting is the
	 * default); fallback: a later candidate; session: the session model.
	 */
	source: "setting" | "default" | "fallback" | "session";
	/** Candidates passed over, with why. */
	skipped: Array<{ id: string; reason: string }>;
}

export interface ChoreModelDeps {
	getModel: (id: string) => Model<Api> | undefined;
	/** Enabled (not in disabledModels) and not paused in the live catalog. */
	isUsable: (model: Model<Api>) => boolean;
	/** Not cooling down after failures. */
	isHealthy: (modelId: string) => boolean;
	session?: { model: Model<Api> | undefined; thinkingLevel: ModelThinkingLevel };
}

/** The model and thinking level for a side task, or undefined when nothing (not even the session model) can run it. */
export function resolveChoreModel(setting: string | undefined, deps: ChoreModelDeps): ChoreModelChoice | undefined {
	const skipped: Array<{ id: string; reason: string }> = [];
	const sessionChoice = (): ChoreModelChoice | undefined =>
		deps.session?.model
			? { model: deps.session.model, thinkingLevel: deps.session.thinkingLevel, source: "session", skipped }
			: undefined;
	const wantsSession = setting?.trim() === SESSION_CHORE_MODEL;
	if (wantsSession) {
		const choice = sessionChoice();
		if (choice) return choice;
	}
	const candidates: Array<ChoreModelSpec & { source: ChoreModelChoice["source"] }> = [];
	const add = (spec: ChoreModelSpec | undefined, source: ChoreModelChoice["source"]) => {
		if (spec && !candidates.some((entry) => entry.id === spec.id)) candidates.push({ ...spec, source });
	};
	const configured = wantsSession ? undefined : parseChoreModel(setting);
	const defaultSpec = parseChoreModel(DEFAULT_CHORE_MODEL);
	if (configured && !(configured.id === defaultSpec?.id && configured.level === defaultSpec.level)) {
		add(configured, "setting");
	}
	add(defaultSpec, candidates.length === 0 ? "default" : "fallback");
	add(parseChoreModel(CHORE_FALLBACK_MODEL), "fallback");
	for (const spec of candidates) {
		const model = deps.getModel(spec.id);
		if (!model) {
			skipped.push({ id: spec.id, reason: "unknown model" });
			continue;
		}
		if (!deps.isUsable(model)) {
			skipped.push({ id: spec.id, reason: "disabled or paused" });
			continue;
		}
		if (!deps.isHealthy(model.id)) {
			skipped.push({ id: spec.id, reason: "cooling down after failures" });
			continue;
		}
		const thinkingLevel = clampToSupported(spec.level ?? "off", getSupportedThinkingLevels(model));
		return { model, thinkingLevel, source: spec.source, skipped };
	}
	return sessionChoice();
}
