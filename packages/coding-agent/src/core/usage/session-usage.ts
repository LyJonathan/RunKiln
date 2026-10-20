/**
 * Session usage analysis for `/usage`: every billed call in a session file (main turns, subagents, chores, router
 * classifier, permission judge) as flat records, and the report built from them: overview, per model and thinking, per
 * category, per turn and cache health. Pure functions over session entries, so they work on a resumed session and in
 * tests without a terminal.
 *
 * Costs are what the session stored: the server's billed cost where the response carried one (`costSource: "server"`),
 * else the catalog estimate. Decision-model calls without a billed cost are marked estimated.
 */

import type { AssistantMessage, Usage } from "@runkiln/ai";
import type { SessionEntry } from "../session-manager.ts";

/**
 * Joins model and thinking in machine-readable keys (`runkiln usage --json`, the /usage report): `glm-5-3-flash•low`.
 * A stable output format, so it is not the UI separator; render keys with displayModelKey().
 */
export const MODEL_KEY_SEPARATOR = "•"; // ui-text-style: machine-readable (JSON keys), not UI text

/** A model key as shown to people: `glm-5-3-flash - low`. */
export function displayModelKey(key: string): string {
	return key.split(MODEL_KEY_SEPARATOR).join(" - ");
}

/** Custom entry recording a router decision (one per new user turn, and every switch). */
export const ROUTE_ENTRY_TYPE = "runkiln.route";

export interface RouteEntryData {
	model: string;
	thinking: string;
	mode?: string;
	/** DecisionSource: classifier, cache, heuristic, follow-up, escalation, failover, ... */
	source: string;
	/** shortRouteReason(): "edit d42", "classifier failed, kept last", ... */
	reason: string;
	/** Selection cause: cheapest_within_band, best_quality, stepped_up, ... */
	cause?: string;
	switched?: boolean;
	from?: string;
	estCostUsd?: number;
}

export type UsageCategory = "main" | "subagent" | "chore" | "classifier" | "judge" | "tool";

export const USAGE_CATEGORIES: readonly UsageCategory[] = ["main", "subagent", "chore", "classifier", "judge", "tool"];

export const CATEGORY_LABELS: Record<UsageCategory, string> = {
	main: "Main turns",
	subagent: "Subagents",
	chore: "Chores (titles, compaction)",
	classifier: "Router classifier",
	judge: "Permission judge",
	tool: "Other tools",
};

/** One billed call (or one subagent's total). */
export interface UsageRecord {
	entryId: string;
	ts: number;
	category: UsageCategory;
	/** turn, title, compaction, branch_summary, cache_warm, classifier, judge, task, or the tool name. */
	kind: string;
	provider: string;
	model: string;
	thinking?: string;
	/** Prompt tokens not read from the cache (cache writes included). */
	input: number;
	cached: number;
	output: number;
	/** Subset of output. */
	reasoning: number;
	cost: number;
	costInput: number;
	costCached: number;
	costOutput: number;
	/** True when the cost is an estimate the server did not bill (decision models without usage.cost). */
	estimated: boolean;
	/** True when the cost is the server's billed amount. */
	server: boolean;
	durationMs?: number;
	ttftMs?: number;
	/** 0 before the first user message, then 1, 2, ... */
	turn: number;
	requests: number;
}

/** Catalog prices, USD per million tokens. Satisfied by ModelRuntime. */
export interface UsagePriceSource {
	getModel(
		provider: string,
		modelId: string,
	): { cost: { input: number; output: number; cacheRead: number }; contextWindow?: number } | undefined;
}

function usageRecord(
	base: Pick<UsageRecord, "entryId" | "ts" | "category" | "kind" | "provider" | "model" | "thinking" | "turn">,
	usage: Usage,
	extra: Partial<UsageRecord> = {},
): UsageRecord {
	return {
		...base,
		input: usage.input + usage.cacheWrite,
		cached: usage.cacheRead,
		output: usage.output,
		reasoning: usage.reasoning ?? 0,
		cost: usage.cost.total,
		costInput: usage.cost.input + usage.cost.cacheWrite,
		costCached: usage.cost.cacheRead,
		costOutput: usage.cost.output,
		estimated: false,
		server: usage.costSource === "server",
		requests: 1,
		...extra,
	};
}

/** A subagent's totals in a `task` tool result (sessions from before subagents were removed). */
interface SubagentState {
	model?: string;
	thinking?: string;
	input: number;
	output: number;
	cacheRead: number;
	costUsd: number;
	decisionCostUsd?: number;
	turns?: number;
	startedAt?: number;
	endedAt?: number;
}

/** Split a subagent's total over input / cached / output with its model's catalog prices (the rest goes to input). */
function subagentRecord(
	base: Pick<UsageRecord, "entryId" | "ts" | "turn">,
	agent: SubagentState,
	provider: string,
	prices: UsagePriceSource | undefined,
): UsageRecord {
	const model = agent.model ?? "unknown";
	const price = prices?.getModel(provider, model)?.cost;
	const costCached = price ? (agent.cacheRead * price.cacheRead) / 1e6 : 0;
	const costOutput = price ? (agent.output * price.output) / 1e6 : 0;
	const llmCost = agent.costUsd - (agent.decisionCostUsd ?? 0);
	const scale = price && costCached + costOutput > llmCost && llmCost > 0 ? llmCost / (costCached + costOutput) : 1;
	return {
		...base,
		category: "subagent",
		kind: "task",
		provider,
		model,
		...(agent.thinking ? { thinking: agent.thinking } : {}),
		input: agent.input,
		cached: agent.cacheRead,
		output: agent.output,
		reasoning: 0,
		cost: agent.costUsd,
		costCached: costCached * scale,
		costOutput: costOutput * scale,
		costInput: Math.max(0, agent.costUsd - costCached * scale - costOutput * scale),
		estimated: false,
		server: false,
		requests: Math.max(1, agent.turns ?? 1),
		...(agent.startedAt && agent.endedAt ? { durationMs: agent.endedAt - agent.startedAt } : {}),
	};
}

const CHORE_KINDS = new Set(["title", "cache_warm", "compaction", "branch_summary", "chore"]);

function categoryOfUsageKind(kind: string): UsageCategory {
	if (kind === "classifier") return "classifier";
	if (kind === "judge") return "judge";
	if (CHORE_KINDS.has(kind)) return "chore";
	return "tool";
}

/** Every billed call in the session, in file order (all branches: abandoned branches were billed too). */
export function collectUsageRecords(entries: readonly SessionEntry[], prices?: UsagePriceSource): UsageRecord[] {
	const records: UsageRecord[] = [];
	let turn = 0;
	let thinking: string | undefined;
	let mainProvider = "runinfra";
	for (const entry of entries) {
		const ts = Date.parse(entry.timestamp);
		if (entry.type === "thinking_level_change") {
			thinking = entry.thinkingLevel;
			continue;
		}
		if (entry.type === "message") {
			const message = entry.message;
			if (message.role === "user") {
				turn++;
				continue;
			}
			if (message.role === "assistant") {
				const assistant = message as AssistantMessage;
				mainProvider = assistant.provider;
				const usage = assistant.usage;
				if (usage.input + usage.output + usage.cacheRead + usage.cacheWrite === 0 && usage.cost.total === 0)
					continue;
				records.push(
					usageRecord(
						{
							entryId: entry.id,
							ts: assistant.timestamp || ts,
							category: "main",
							kind: "turn",
							provider: assistant.provider,
							model: assistant.responseModel ?? assistant.model,
							thinking: assistant.thinkingLevel ?? thinking,
							turn,
						},
						usage,
						{
							...(assistant.durationMs !== undefined ? { durationMs: assistant.durationMs } : {}),
							...(assistant.ttftMs !== undefined ? { ttftMs: assistant.ttftMs } : {}),
						},
					),
				);
				continue;
			}
			if (message.role === "toolResult" && message.usage) {
				const agents = (message.details as { agents?: SubagentState[] } | undefined)?.agents;
				if (message.toolName === "task" && Array.isArray(agents) && agents.length > 0) {
					for (const agent of agents) {
						if (agent.costUsd <= 0 && agent.input + agent.output + agent.cacheRead === 0) continue;
						records.push(subagentRecord({ entryId: entry.id, ts, turn }, agent, mainProvider, prices));
					}
				} else {
					records.push(
						usageRecord(
							{
								entryId: entry.id,
								ts,
								category: message.toolName === "task" ? "subagent" : "tool",
								kind: message.toolName,
								provider: mainProvider,
								model: message.toolName,
								turn,
							},
							message.usage,
						),
					);
				}
			}
			continue;
		}
		if (entry.type === "usage") {
			const category = categoryOfUsageKind(entry.kind);
			const estimated = (category === "classifier" || category === "judge") && entry.usage.costSource !== "server";
			records.push(
				usageRecord(
					{
						entryId: entry.id,
						ts,
						category,
						kind: entry.kind,
						provider: entry.provider,
						model: entry.model,
						turn,
					},
					entry.usage,
					{ estimated, ...msFromNote(entry.note) },
				),
			);
			continue;
		}
		if ((entry.type === "compaction" || entry.type === "branch_summary") && entry.usage) {
			records.push(
				usageRecord(
					{
						entryId: entry.id,
						ts,
						category: "chore",
						kind: entry.type,
						provider: mainProvider,
						model: entry.type === "compaction" ? "compaction" : "branch summary",
						turn,
					},
					entry.usage,
				),
			);
		}
	}
	return records;
}

function msFromNote(note: string | undefined): Partial<UsageRecord> {
	const match = note?.match(/(\d+)ms/);
	return match ? { durationMs: Number(match[1]) } : {};
}

// ---------------------------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------------------------

export interface UsageOverview {
	cost: number;
	costInput: number;
	costCached: number;
	costOutput: number;
	/** Of costOutput: reasoning tokens at the output price (estimate). */
	costReasoning: number;
	/** Uncached input of every call, decision models included. */
	input: number;
	/** Of `input`: the router classifier's and permission judge's input (no cache, not in `hitPct`). */
	decisionInput: number;
	cached: number;
	output: number;
	reasoning: number;
	/** cached / (input + cached), LLM calls only (decision models have no cache). */
	hitPct: number | undefined;
	/** What the cached tokens would have cost at the full input price, minus what they cost (catalog prices). */
	savedByCache: number;
	requests: number;
	turns: number;
	/** First to last entry. */
	wallMs: number;
	/** Sum of response times. */
	apiMs: number;
	avgTtftMs: number | undefined;
	/** Part of `cost` that is estimated (decision models without a billed cost). */
	estimatedCost: number;
	/** Part of `cost` billed by the server. */
	serverCost: number;
}

export interface ModelUsageRow {
	model: string;
	thinking?: string;
	/** model•thinking (MODEL_KEY_SEPARATOR, a machine-readable key), or the model with the category for decision models. */
	label: string;
	categories: UsageCategory[];
	turns: number;
	requests: number;
	input: number;
	cached: number;
	output: number;
	hitPct: number | undefined;
	cost: number;
	estimated: boolean;
}

export interface CategoryUsageRow {
	category: UsageCategory;
	label: string;
	requests: number;
	tokens: number;
	cost: number;
	estimated: boolean;
}

export interface TurnUsageRow {
	turn: number;
	/** The user's request, one line. */
	prompt: string;
	ts: number;
	/** The main model and thinking of the turn's first request. */
	model?: string;
	thinking?: string;
	/** The router's pick and why ("classifier - edit d42"), or "manual". */
	route: string;
	/** Selection cause or the switch ("stepped_up", "switched from glm-5-3-flash"). */
	cause?: string;
	switches: number;
	requests: number;
	input: number;
	cached: number;
	output: number;
	hitPct: number | undefined;
	cost: number;
	subagentCost: number;
	decisionCost: number;
	choreCost: number;
	durationMs: number;
}

export type CacheMissReason =
	| "model switch"
	| "thinking switch"
	| "compaction"
	| "idle past the TTL"
	| "prompt or tools changed"
	| "unknown";

export interface CacheHealth {
	state: "warm" | "cold" | "unknown";
	model?: string;
	thinking?: string;
	/** Since the last main request ended. */
	idleMs?: number;
	ttlMs?: number;
	lastMiss?: {
		turn: number;
		ts: number;
		missedTokens: number;
		/** Extra paid compared with a cache hit (catalog prices). */
		missedCost: number;
		reason: CacheMissReason;
		detail?: string;
	};
	misses: number;
}

export interface SessionUsageReport {
	overview: UsageOverview;
	models: ModelUsageRow[];
	categories: CategoryUsageRow[];
	turns: TurnUsageRow[];
	cache: CacheHealth;
}

export interface SessionUsageOptions {
	prices?: UsagePriceSource;
	/** Session idle TTL of a model (catalog), ms. Default 900 s. */
	ttlMs?: (provider: string, model: string) => number;
	now?: number;
}

/** RunInfra's session affinity idle TTL when nothing else says. */
const DEFAULT_TTL_MS = 900_000;
/** Below this many missed prompt tokens a "miss" is 128-token block granularity. */
const MISS_FLOOR_TOKENS = 1024;

const pct = (part: number, whole: number) => (whole > 0 ? (part / whole) * 100 : undefined);

function isLlm(record: UsageRecord): boolean {
	return record.category !== "classifier" && record.category !== "judge";
}

function oneLine(text: string, max = 120): string {
	const line = text.replace(/\s+/g, " ").trim();
	return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function userText(message: { content: unknown }): string {
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) return "";
	return message.content
		.filter((part): part is { type: "text"; text: string } => part?.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join(" ");
}

export function buildSessionUsageReport(
	entries: readonly SessionEntry[],
	options: SessionUsageOptions = {},
): SessionUsageReport {
	const records = collectUsageRecords(entries, options.prices);
	const now = options.now ?? Date.now();
	return {
		overview: buildOverview(entries, records, options.prices),
		models: buildModelRows(records),
		categories: buildCategoryRows(records),
		turns: buildTurnRows(entries, records),
		cache: buildCacheHealth(entries, options, now),
	};
}

function buildOverview(
	entries: readonly SessionEntry[],
	records: readonly UsageRecord[],
	prices: UsagePriceSource | undefined,
): UsageOverview {
	const overview: UsageOverview = {
		cost: 0,
		costInput: 0,
		costCached: 0,
		costOutput: 0,
		costReasoning: 0,
		input: 0,
		decisionInput: 0,
		cached: 0,
		output: 0,
		reasoning: 0,
		hitPct: undefined,
		savedByCache: 0,
		requests: 0,
		turns: 0,
		wallMs: 0,
		apiMs: 0,
		avgTtftMs: undefined,
		estimatedCost: 0,
		serverCost: 0,
	};
	let llmPrompt = 0;
	let llmCached = 0;
	let ttftSum = 0;
	let ttftCount = 0;
	for (const record of records) {
		overview.cost += record.cost;
		overview.costInput += record.costInput;
		overview.costCached += record.costCached;
		overview.costOutput += record.costOutput;
		overview.input += record.input;
		overview.cached += record.cached;
		overview.output += record.output;
		overview.reasoning += record.reasoning;
		overview.requests += record.requests;
		if (record.estimated) overview.estimatedCost += record.cost;
		if (record.server) overview.serverCost += record.cost;
		if (record.durationMs !== undefined && record.category !== "subagent") overview.apiMs += record.durationMs;
		if (record.ttftMs !== undefined) {
			ttftSum += record.ttftMs;
			ttftCount++;
		}
		if (isLlm(record)) {
			llmPrompt += record.input + record.cached;
			llmCached += record.cached;
		} else overview.decisionInput += record.input;
		const price = prices?.getModel(record.provider, record.model)?.cost;
		if (price && record.cached > 0) {
			overview.savedByCache += (record.cached * Math.max(0, price.input - price.cacheRead)) / 1e6;
		}
		if (record.reasoning > 0 && record.output > 0) {
			overview.costReasoning += record.costOutput * (record.reasoning / record.output);
		}
	}
	overview.hitPct = llmCached > 0 ? pct(llmCached, llmPrompt) : undefined;
	overview.avgTtftMs = ttftCount > 0 ? ttftSum / ttftCount : undefined;
	overview.turns = entries.filter((entry) => entry.type === "message" && entry.message.role === "user").length;
	const times = entries.map((entry) => Date.parse(entry.timestamp)).filter((value) => Number.isFinite(value));
	if (times.length > 1) overview.wallMs = Math.max(...times) - Math.min(...times);
	return overview;
}

function buildModelRows(records: readonly UsageRecord[]): ModelUsageRow[] {
	const rows = new Map<string, ModelUsageRow & { turnSet: Set<number> }>();
	for (const record of records) {
		const decision = !isLlm(record);
		const key = decision
			? `${record.model} (${record.category})`
			: `${record.model}${MODEL_KEY_SEPARATOR}${record.thinking ?? "-"}`;
		let row = rows.get(key);
		if (!row) {
			row = {
				model: record.model,
				...(record.thinking && !decision ? { thinking: record.thinking } : {}),
				label: decision
					? `${record.model} (${record.category === "judge" ? "judge" : "router"})`
					: record.thinking
						? `${record.model}${MODEL_KEY_SEPARATOR}${record.thinking}`
						: record.model,
				categories: [],
				turns: 0,
				requests: 0,
				input: 0,
				cached: 0,
				output: 0,
				hitPct: undefined,
				cost: 0,
				estimated: false,
				turnSet: new Set(),
			};
			rows.set(key, row);
		}
		if (!row.categories.includes(record.category)) row.categories.push(record.category);
		row.turnSet.add(record.turn);
		row.requests += record.requests;
		row.input += record.input;
		row.cached += record.cached;
		row.output += record.output;
		row.cost += record.cost;
		row.estimated ||= record.estimated;
	}
	return [...rows.values()]
		.map(({ turnSet, ...row }) => ({
			...row,
			turns: turnSet.size,
			hitPct: row.cached > 0 ? pct(row.cached, row.input + row.cached) : row.input > 0 ? 0 : undefined,
		}))
		.sort((a, b) => b.cost - a.cost || b.requests - a.requests);
}

function buildCategoryRows(records: readonly UsageRecord[]): CategoryUsageRow[] {
	return USAGE_CATEGORIES.map((category) => {
		const matching = records.filter((record) => record.category === category);
		return {
			category,
			label: CATEGORY_LABELS[category],
			requests: matching.reduce((sum, record) => sum + record.requests, 0),
			tokens: matching.reduce((sum, record) => sum + record.input + record.cached + record.output, 0),
			cost: matching.reduce((sum, record) => sum + record.cost, 0),
			estimated: matching.some((record) => record.estimated),
		};
	}).filter((row) => row.requests > 0 || row.category === "main");
}

function routeLabel(route: RouteEntryData | undefined): string {
	if (!route) return "manual";
	return route.reason ? `${route.source} - ${route.reason}` : route.source;
}

function buildTurnRows(entries: readonly SessionEntry[], records: readonly UsageRecord[]): TurnUsageRow[] {
	const rows: TurnUsageRow[] = [];
	const routes = new Map<number, RouteEntryData[]>();
	let turn = 0;
	for (const entry of entries) {
		if (entry.type === "message" && entry.message.role === "user") {
			turn++;
			rows.push({
				turn,
				prompt: oneLine(userText(entry.message)),
				ts: Date.parse(entry.timestamp),
				route: "manual",
				switches: 0,
				requests: 0,
				input: 0,
				cached: 0,
				output: 0,
				hitPct: undefined,
				cost: 0,
				subagentCost: 0,
				decisionCost: 0,
				choreCost: 0,
				durationMs: 0,
			});
		} else if (entry.type === "custom" && entry.customType === ROUTE_ENTRY_TYPE && turn > 0) {
			const list = routes.get(turn) ?? [];
			list.push(entry.data as RouteEntryData);
			routes.set(turn, list);
		}
	}
	const byTurn = new Map(rows.map((row) => [row.turn, row]));
	for (const record of records) {
		const row = byTurn.get(record.turn);
		if (!row) continue;
		row.cost += record.cost;
		if (record.category === "main") {
			row.requests += 1;
			row.input += record.input;
			row.cached += record.cached;
			row.output += record.output;
			row.durationMs += record.durationMs ?? 0;
			if (!row.model) {
				row.model = record.model;
				if (record.thinking) row.thinking = record.thinking;
			}
		} else if (record.category === "subagent") row.subagentCost += record.cost;
		else if (record.category === "classifier" || record.category === "judge") row.decisionCost += record.cost;
		else row.choreCost += record.cost;
	}
	for (const row of rows) {
		row.hitPct = row.input + row.cached > 0 ? pct(row.cached, row.input + row.cached) : undefined;
		const list = routes.get(row.turn);
		if (list && list.length > 0) {
			const first = list[0]!;
			row.route = routeLabel(first);
			row.switches = list.filter((route, index) => index > 0 && route.switched).length;
			const switched = list.find((route, index) => index > 0 && route.switched);
			row.cause = switched
				? `switched to ${switched.model} (${switched.source})`
				: first.switched && first.from
					? `from ${first.from}${first.cause ? `, ${first.cause}` : ""}`
					: first.cause;
			row.model ??= first.model;
			row.thinking ??= first.thinking;
		}
	}
	return rows;
}

/**
 * When a main request finished: its start plus the response time, or when the session saved it (older sessions have
 * no `durationMs`). Only the main conversation's assistant messages count: the classifier, the judge, chores and
 * subagents are separate prompts and never refresh this cache.
 */
function requestEnd(message: AssistantMessage, savedAt: string): number {
	if (message.durationMs !== undefined) return message.timestamp + message.durationMs;
	const saved = Date.parse(savedAt);
	return Number.isFinite(saved) && saved >= message.timestamp ? saved : message.timestamp;
}

function buildCacheHealth(entries: readonly SessionEntry[], options: SessionUsageOptions, now: number): CacheHealth {
	const ttlFor = options.ttlMs ?? (() => DEFAULT_TTL_MS);
	let prev:
		| { prompt: number; model: string; thinking?: string; endedAt: number; provider: string; startedAt: number }
		| undefined;
	let compactedSincePrev = false;
	let turn = 0;
	let misses = 0;
	let lastMiss: CacheHealth["lastMiss"];
	for (const entry of entries) {
		if (entry.type === "compaction") {
			compactedSincePrev = true;
			continue;
		}
		if (entry.type !== "message") continue;
		if (entry.message.role === "user") {
			turn++;
			continue;
		}
		if (entry.message.role !== "assistant") continue;
		const message = entry.message as AssistantMessage;
		if (message.stopReason === "error" || message.stopReason === "aborted") continue;
		const usage = message.usage;
		const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
		if (prompt <= 0) continue;
		const model = message.responseModel ?? message.model;
		if (prev) {
			const expected = Math.min(prev.prompt, prompt);
			const missed = expected - usage.cacheRead;
			if (missed > MISS_FLOOR_TOKENS) {
				misses++;
				const idle = message.timestamp - prev.endedAt;
				const ttl = ttlFor(message.provider, model);
				const reason: CacheMissReason =
					model !== prev.model
						? "model switch"
						: (message.thinkingLevel ?? "") !== (prev.thinking ?? "")
							? "thinking switch"
							: compactedSincePrev
								? "compaction"
								: idle > ttl
									? "idle past the TTL"
									: usage.cacheRead === 0 || missed > expected * 0.5
										? "prompt or tools changed"
										: "unknown";
				const price = options.prices?.getModel(message.provider, model)?.cost;
				lastMiss = {
					turn,
					ts: message.timestamp,
					missedTokens: missed,
					missedCost: price ? (missed * Math.max(0, price.input - price.cacheRead)) / 1e6 : 0,
					reason,
					...(reason === "model switch"
						? { detail: `${prev.model} → ${model}` }
						: reason === "thinking switch"
							? { detail: `${prev.thinking ?? "off"} → ${message.thinkingLevel ?? "off"}` }
							: reason === "idle past the TTL"
								? { detail: `idle ${Math.round(idle / 1000)}s > ${Math.round(ttl / 1000)}s TTL` }
								: {}),
				};
			}
		}
		compactedSincePrev = false;
		prev = {
			prompt,
			model,
			...(message.thinkingLevel ? { thinking: message.thinkingLevel } : {}),
			provider: message.provider,
			startedAt: message.timestamp,
			endedAt: requestEnd(message, entry.timestamp),
		};
	}
	if (!prev) return { state: "unknown", misses, ...(lastMiss ? { lastMiss } : {}) };
	const ttlMs = ttlFor(prev.provider, prev.model);
	const idleMs = Math.max(0, now - prev.endedAt);
	return {
		state: idleMs < ttlMs ? "warm" : "cold",
		model: prev.model,
		...(prev.thinking ? { thinking: prev.thinking } : {}),
		idleMs,
		ttlMs,
		misses,
		...(lastMiss ? { lastMiss } : {}),
	};
}

// ---------------------------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------------------------

export interface ContextBreakdown {
	/** Tokens in the current context (last response's prompt + what came after, estimated), or null when unknown. */
	tokens: number | null;
	contextWindow: number;
	parts: { systemPrompt: number; tools: number; messages: number; toolResults: number };
	/** Parts are chars/4 estimates scaled to `tokens` when it is known. */
	estimated: boolean;
	/** Auto-compaction triggers above this many tokens; undefined when compaction is off. */
	compactAt?: number;
	autoCompact: boolean;
	model?: string;
}
