/**
 * "auto": the routing mode, shown next to the real models in every model list.
 *
 * The auto entry is a placeholder Model so the selector, /model, --model, cycling and RPC can offer it.
 * It never reaches a provider: selecting it turns routing on, and each request is sent to the concrete
 * model the router picks.
 */

import type { Api, Model, ModelThinkingLevel } from "@runkiln/ai";
import { RUNINFRA_DEFAULT_BASE_URL, RUNINFRA_PROVIDER_ID } from "@runkiln/ai/providers/runinfra";
import { effortToThinkingLevel } from "../runkiln/models-catalog.ts";
import { DEFAULT_MODES, isRouterMode, ROUTER_MODES, type RouterCatalog, type RouterMode } from "./catalog.ts";
import {
	type ClassifierChoice,
	type ClassifierConfig,
	createClassifier,
	resolveClassifierBackend,
	type StoredClassifierKeysSource,
} from "./classifiers.ts";
import { readRouterKeys } from "./keys.ts";
import { ModelRouter } from "./router.ts";

export const AUTO_MODEL_ID = "auto";

/** "auto" or "auto:<mode>" (also with a "runinfra/" prefix). */
export function isAutoModelId(id: string | undefined): boolean {
	if (!id) return false;
	const normalized = id
		.trim()
		.toLowerCase()
		.replace(/^runinfra\//, "");
	if (normalized === AUTO_MODEL_ID) return true;
	return normalized.startsWith(`${AUTO_MODEL_ID}:`) && isRouterMode(normalized.slice(AUTO_MODEL_ID.length + 1));
}

/** The mode named by "auto:<mode>"; undefined for bare "auto" or a non-auto id. */
export function parseAutoMode(id: string | undefined): RouterMode | undefined {
	if (!isAutoModelId(id)) return undefined;
	const normalized = (id ?? "")
		.trim()
		.toLowerCase()
		.replace(/^runinfra\//, "");
	const mode = normalized.slice(AUTO_MODEL_ID.length + 1);
	return isRouterMode(mode) ? mode : undefined;
}

export function autoModelId(mode: RouterMode): string {
	return `${AUTO_MODEL_ID}:${mode}`;
}

export function isAutoModel(model: { id: string; provider?: string } | undefined): boolean {
	return (
		!!model && isAutoModelId(model.id) && (model.provider === undefined || model.provider === RUNINFRA_PROVIDER_ID)
	);
}

/**
 * The auto placeholders, one per routing mode ("auto:low", "auto:medium", "auto:high"). Limits are the
 * largest any routable model offers.
 */
export function createAutoModels(models: readonly Model<Api>[]): Record<RouterMode, Model<"openai-completions">> {
	const result = {} as Record<RouterMode, Model<"openai-completions">>;
	for (const mode of ROUTER_MODES) result[mode] = createAutoModel(models, mode);
	return result;
}

export function createAutoModel(
	models: readonly Model<Api>[],
	mode: RouterMode = "medium",
): Model<"openai-completions"> {
	return {
		id: autoModelId(mode),
		name: `Auto ${mode}: ${DEFAULT_MODES[mode].description}`,
		api: "openai-completions",
		provider: RUNINFRA_PROVIDER_ID,
		baseUrl: RUNINFRA_DEFAULT_BASE_URL,
		reasoning: true,
		input: models.some((model) => model.input.includes("image")) ? ["text", "image"] : ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: Math.max(0, ...models.map((model) => model.contextWindow)),
		maxTokens: Math.max(0, ...models.map((model) => model.maxTokens)),
	};
}

/** Router settings (global settings only: they decide where prompts are sent). */
export interface RouterSettings extends ClassifierConfig {
	/** Routing mode used when "auto" is picked without one. Default "medium". */
	mode?: RouterMode;
	/** Model used when the classifier fails before any decision exists. Default: the role model. */
	fallbackModel?: string;
	/** Seconds a classifier answer is reused for the same request. Default 600. */
	cacheTtlSec?: number;
}

export interface RouterOverrides {
	classifier?: ClassifierChoice;
	/** Model for the chosen backend: a Jev model name or an OpenRouter model id. */
	classifierModel?: string;
}

/** Applies CLI overrides (--router-classifier, --router-model) over settings. */
export function applyRouterOverrides(settings: RouterSettings, overrides: RouterOverrides | undefined): RouterSettings {
	if (!overrides) return settings;
	const result: RouterSettings = { ...settings, jev: { ...settings.jev }, openrouter: { ...settings.openrouter } };
	if (overrides.classifier) result.classifier = overrides.classifier;
	if (overrides.classifierModel) {
		const backend =
			result.classifier && result.classifier !== "auto" && result.classifier !== "off"
				? result.classifier
				: (resolveClassifierBackend("auto", process.env, readRouterKeys()) ?? "openrouter");
		if (backend === "jev") result.jev = { ...result.jev, model: overrides.classifierModel };
		else result.openrouter = { ...result.openrouter, model: overrides.classifierModel };
	}
	return result;
}

/** The model's harness effort as a thinking level (what RunKiln sends when nobody picks one). */
export function harnessThinkingLevel(model: Model<Api>): ModelThinkingLevel | undefined {
	return model.reasoningEffort ? effortToThinkingLevel(model.reasoningEffort) : undefined;
}

export function createModelRouter(options: {
	catalog: RouterCatalog;
	settings: RouterSettings;
	getModels: () => readonly Model<Api>[];
	defaultModelId: () => string | undefined;
	env?: NodeJS.ProcessEnv;
	fetch?: typeof globalThis.fetch;
	/**
	 * Saved classifier keys. Default: `router-keys.json` in the agent dir, read when the router is built.
	 * When `env` is injected (tests, SDK) and this is not, no saved keys are read.
	 */
	storedKeys?: StoredClassifierKeysSource;
}): ModelRouter {
	const { classifier, problem } = createClassifier(
		options.settings,
		{
			skills: options.catalog.skills,
			skillThreshold: options.catalog.tuning.skillThreshold,
			maxSecondarySkills: options.catalog.tuning.maxSecondarySkills,
			// Quality selection asks the v2 questions (task kind, calibrated difficulty, follow-up, length).
			schema: options.catalog.selection === "quality" && options.catalog.quality ? 2 : 1,
			kindSkills: options.catalog.quality?.kindSkills,
		},
		options.env,
		options.fetch,
		options.storedKeys ?? (options.env ? {} : () => readRouterKeys()),
	);
	return new ModelRouter({
		catalog: options.catalog,
		classifier,
		classifierProblem: problem,
		getModels: options.getModels,
		defaultModelId: () => options.settings.fallbackModel ?? options.defaultModelId(),
		defaultThinkingLevel: harnessThinkingLevel,
		cacheTtlMs: options.settings.cacheTtlSec !== undefined ? options.settings.cacheTtlSec * 1000 : undefined,
	});
}

export type { RouterCatalog, RouterMode } from "./catalog.ts";
export { DEFAULT_ROUTER_MODE, isRouterMode, loadRouterCatalog, ROUTER_MODES } from "./catalog.ts";
export { formatRouterReport, type RouterStatus, shortRouteReason } from "./format.ts";
export { ModelRouter, type RouteDecision, type RouteRequest } from "./router.ts";
export { extractTurnSignals } from "./signals.ts";
