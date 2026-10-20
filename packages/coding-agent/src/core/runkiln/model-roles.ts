/**
 * Model roles: which catalog model serves code sessions, chat sessions and background titles.
 *
 * Each role resolves from the user's settings (`models.<role>`), then the models.yaml default,
 * then the fallback list (settings `models.fallback`, else models.yaml `defaults.fallback`), taking
 * the first id that exists in the catalog.
 */

import type { Api, Model } from "@runkiln/ai";
import type { ModelRole, ModelsCatalog, RoleDefaults } from "./models-catalog.ts";

export interface ModelRoleSettings {
	code?: string;
	chat?: string;
	title?: string;
	fallback?: string[];
}

export function effectiveRoleDefaults(catalog: ModelsCatalog, settings: ModelRoleSettings = {}): RoleDefaults {
	return {
		code: settings.code ?? catalog.defaults.code,
		chat: settings.chat ?? catalog.defaults.chat,
		title: settings.title ?? catalog.defaults.title,
		fallback: settings.fallback ?? catalog.defaults.fallback,
	};
}

/** Candidate ids for a role, in preference order, without duplicates. */
export function roleCandidates(role: ModelRole, defaults: RoleDefaults): string[] {
	return [...new Set([defaults[role], ...defaults.fallback])];
}

export interface RoleModelResult {
	model: Model<Api> | undefined;
	/** Set when the preferred id was not usable and a fallback was chosen. */
	fallbackMessage?: string;
}

export function resolveRoleModel(
	role: ModelRole,
	defaults: RoleDefaults,
	lookup: (modelId: string) => Model<Api> | undefined,
): RoleModelResult {
	const candidates = roleCandidates(role, defaults);
	for (const [index, id] of candidates.entries()) {
		const model = lookup(id);
		if (!model) continue;
		return {
			model,
			fallbackMessage:
				index === 0 ? undefined : `Model "${candidates[0]}" for ${role} is not in models.yaml; using "${id}"`,
		};
	}
	return { model: undefined };
}

/**
 * The next catalog model to try after `currentId` fails.
 * Skips the current id and anything already tried. Unknown ids are skipped.
 */
export function nextFallbackModel<T>(
	currentId: string,
	fallback: readonly string[],
	tried: ReadonlySet<string>,
	lookup: (modelId: string) => T | undefined,
): T | undefined {
	const skipped = new Set(tried);
	skipped.add(currentId);
	for (const id of fallback) {
		if (skipped.has(id)) continue;
		const model = lookup(id);
		if (model) return model;
	}
	return undefined;
}
