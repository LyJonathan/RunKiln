/**
 * RunKiln model catalog: reads models.yaml (shipped with the package).
 *
 * models.yaml describes models only. It never decides where requests go: this loader reads
 * no URL, host, header or key fields, and every model it returns points at the RunInfra
 * provider, whose endpoint comes from the local user config (see runinfra-config.ts).
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Model, ModelThinkingLevel, ThinkingLevelMap } from "@runkiln/ai";
import { RUNINFRA_DEFAULT_BASE_URL, RUNINFRA_PROVIDER_ID } from "@runkiln/ai/providers/runinfra";
import { parse as parseYaml } from "yaml";
import { getPackageDir } from "../../config.ts";

export type ModelRole = "code" | "chat" | "title";

export interface RoleDefaults {
	code: string;
	chat: string;
	title: string;
	fallback: string[];
}

export interface CatalogModel {
	id: string;
	name: string;
	roles: string[];
	/** Sent as `reasoning_effort` on every request; undefined sends nothing. */
	reasoningEffort?: string;
	/** Field the model streams thinking in (informational; both fields are always read). */
	thinkingField?: string;
	/** Provider effort values the model accepts (`reasoning_efforts` plus `harness_effort`). */
	reasoningEfforts: string[];
	/** Thinking level matching `harness_effort`: the level used when nobody picked one. */
	defaultThinkingLevel?: ModelThinkingLevel;
}

const THINKING_LEVELS: readonly ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** RunKiln thinking level for a provider effort value ("none" is "off"; the rest share names). */
export function effortToThinkingLevel(effort: string): ModelThinkingLevel | undefined {
	const normalized = effort.trim().toLowerCase();
	if (normalized === "none") return "off";
	return THINKING_LEVELS.find((level) => level === normalized);
}

/**
 * Thinking-level map for a model: each level the model accepts maps to its provider effort value,
 * every other level is marked unsupported (null) so the level clamps to the nearest supported one.
 * Returns undefined when the model accepts fewer than two levels (nothing to choose).
 */
export function buildThinkingLevelMap(efforts: readonly string[]): ThinkingLevelMap | undefined {
	const map: ThinkingLevelMap = {};
	let supported = 0;
	for (const level of THINKING_LEVELS) {
		const effort = efforts.find((candidate) => effortToThinkingLevel(candidate) === level);
		map[level] = effort ?? null;
		if (effort) supported++;
	}
	return supported >= 2 ? map : undefined;
}

export interface ModelsCatalog {
	path: string;
	defaults: RoleDefaults;
	models: CatalogModel[];
	/** Chat models for the RunInfra provider, in file order. */
	chatModels: Model<"openai-completions">[];
	/** Old model ids that now mean another model (`aliases` on a models.yaml entry): alias -> model id. */
	aliases?: Record<string, string>;
}

/** `id` itself, or the model an alias in the catalog stands for. */
export function canonicalModelId(catalog: Pick<ModelsCatalog, "aliases">, id: string): string {
	return catalog.aliases?.[id] ?? id;
}

/** Keys that would let models.yaml steer traffic. Their presence is an error, not something to ignore silently. */
const FORBIDDEN_KEYS = new Set(["url", "baseurl", "endpoint", "host", "headers", "apikey", "key", "token", "secret"]);

const normalizeKey = (key: string) => key.toLowerCase().replace(/[-_]/g, "");

const DEFAULT_CONTEXT_WINDOW = 131072;
const DEFAULT_MAX_TOKENS = 16384;

function findForbiddenKey(value: unknown, path: string): string | undefined {
	if (Array.isArray(value)) {
		for (const [index, item] of value.entries()) {
			const found = findForbiddenKey(item, `${path}[${index}]`);
			if (found) return found;
		}
		return undefined;
	}
	if (!value || typeof value !== "object") return undefined;
	for (const [key, child] of Object.entries(value)) {
		if (FORBIDDEN_KEYS.has(normalizeKey(key))) {
			return `${path}.${key}`;
		}
		const found = findForbiddenKey(child, `${path}.${key}`);
		if (found) return found;
	}
	return undefined;
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asStringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/** Locates models.yaml: next to the built package (dist/), the package root, or the repo root in source checkouts. */
export function getBundledModelsYamlPath(): string {
	const packageDir = getPackageDir();
	const candidates = [
		join(packageDir, "dist", "models.yaml"),
		join(packageDir, "models.yaml"),
		join(dirname(dirname(packageDir)), "models.yaml"),
	];
	const found = candidates.find((candidate) => existsSync(candidate));
	if (!found) throw new Error(`models.yaml not found (looked in: ${candidates.join(", ")})`);
	return found;
}

export function parseModelsCatalog(text: string, path: string): ModelsCatalog {
	const doc = parseYaml(text) as unknown;
	if (!doc || typeof doc !== "object") throw new Error(`${path}: expected a YAML mapping`);
	const forbidden = findForbiddenKey(doc, "models.yaml");
	if (forbidden) {
		throw new Error(
			`${path}: "${forbidden}" is not allowed; endpoints and keys come only from the local user config`,
		);
	}
	const root = doc as Record<string, unknown>;
	if (root.provider !== undefined && root.provider !== RUNINFRA_PROVIDER_ID) {
		throw new Error(`${path}: provider must be "${RUNINFRA_PROVIDER_ID}"`);
	}

	const rawModels = Array.isArray(root.models) ? root.models : [];
	const models: CatalogModel[] = [];
	const chatModels: Model<"openai-completions">[] = [];
	const aliases: Record<string, string> = {};
	for (const raw of rawModels) {
		if (!raw || typeof raw !== "object") continue;
		const entry = raw as Record<string, unknown>;
		const id = asString(entry.id);
		if (!id) throw new Error(`${path}: every model needs an id`);
		if (models.some((model) => model.id === id)) throw new Error(`${path}: duplicate model id "${id}"`);
		const price = (entry.price && typeof entry.price === "object" ? entry.price : {}) as Record<string, unknown>;
		const effort = asString(entry.harness_effort);
		const efforts = [...new Set([...asStringArray(entry.reasoning_efforts), ...(effort ? [effort] : [])])];
		const thinkingLevelMap = buildThinkingLevelMap(efforts);
		const catalogModel: CatalogModel = {
			id,
			name: asString(entry.name) ?? id,
			roles: asStringArray(entry.roles),
			reasoningEffort: effort,
			thinkingField: asString(entry.thinking_field),
			reasoningEfforts: efforts,
			defaultThinkingLevel: effort ? effortToThinkingLevel(effort) : undefined,
		};
		models.push(catalogModel);
		for (const alias of asStringArray(entry.aliases)) {
			if (aliases[alias]) throw new Error(`${path}: alias "${alias}" is listed twice`);
			aliases[alias] = id;
		}
		chatModels.push({
			id,
			name: catalogModel.name,
			api: "openai-completions",
			provider: RUNINFRA_PROVIDER_ID,
			// Placeholder: the RunInfra provider overwrites this with the configured endpoint.
			baseUrl: RUNINFRA_DEFAULT_BASE_URL,
			// Models that accept two or more efforts get selectable thinking levels (mapped to their own
			// effort names); the rest keep the fixed harness effort.
			reasoning: thinkingLevelMap !== undefined,
			reasoningEffort: effort,
			...(thinkingLevelMap ? { thinkingLevelMap } : {}),
			input: entry.images === true ? ["text", "image"] : ["text"],
			cost: {
				input: asNumber(price.in) ?? 0,
				output: asNumber(price.out) ?? 0,
				cacheRead: asNumber(price.cached_in) ?? 0,
				cacheWrite: 0,
			},
			contextWindow: asNumber(entry.context) ?? DEFAULT_CONTEXT_WINDOW,
			maxTokens: asNumber(entry.max_tokens) ?? DEFAULT_MAX_TOKENS,
		});
	}
	if (models.length === 0) throw new Error(`${path}: no models defined`);
	for (const alias of Object.keys(aliases)) {
		if (models.some((model) => model.id === alias))
			throw new Error(`${path}: "${alias}" is both a model and an alias`);
	}

	const known = (id: string | undefined): id is string => !!id && models.some((model) => model.id === id);
	const canonical = (id: string | undefined) => (id === undefined ? undefined : (aliases[id] ?? id));
	const defaultsRaw = (root.defaults && typeof root.defaults === "object" ? root.defaults : {}) as Record<
		string,
		unknown
	>;
	const fallback = [...new Set(asStringArray(defaultsRaw.fallback).map((id) => aliases[id] ?? id))].filter(known);
	const firstWithRole = (role: string) => models.find((model) => model.roles.includes(role))?.id;
	const pick = (role: ModelRole): string => {
		const configured = canonical(asString(defaultsRaw[role]));
		if (configured !== undefined && !known(configured)) {
			throw new Error(`${path}: defaults.${role} "${configured}" is not a model in this file`);
		}
		return configured ?? firstWithRole(role) ?? fallback[0] ?? models[0].id;
	};

	return {
		path,
		defaults: { code: pick("code"), chat: pick("chat"), title: pick("title"), fallback },
		models,
		chatModels,
		aliases,
	};
}

export function loadModelsCatalog(path: string = getBundledModelsYamlPath()): ModelsCatalog {
	return parseModelsCatalog(readFileSync(path, "utf8"), path);
}
