import { isAbsolute, relative, resolve, sep } from "node:path";
import {
	ClickableRows,
	type Component,
	HitMap,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
	visibleWidth,
} from "@runkiln/tui";
import type { AgentSession } from "../../../core/agent-session.ts";
import { areExperimentalFeaturesEnabled } from "../../../core/experimental.ts";
import type { ContextUsage } from "../../../core/extensions/types.ts";
import type { ReadonlyFooterDataProvider } from "../../../core/footer-data-provider.ts";
import { type RouteDecision, shortRouteReason } from "../../../core/router/index.ts";
import { permissionModeInfo } from "../../../core/runkiln/permissions.ts";
import type { TurnSummaryFields, TurnSummaryMode } from "../../../core/settings-manager.ts";
import { type BudgetStatus, tightestBudget } from "../../../core/usage/budget.ts";
import { usd, usdLimit } from "../../../core/usage/views.ts";
import { addUsageToTotals, createUsageTotals, type UsageTotals } from "../../../core/usage-totals.ts";
import { theme } from "../theme/theme.ts";
import { underline } from "./hover-style.ts";
import { DEFAULT_TURN_SUMMARY_FIELDS, formatTurnSummaryLine, type TurnSummaryData } from "./turn-summary.ts";

/**
 * Sanitize text for display in a single-line status.
 * Removes newlines, tabs, carriage returns, and other control characters.
 */
function sanitizeStatusText(text: string): string {
	// Replace newlines, tabs, carriage returns with space, then collapse multiple spaces
	return text
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

/**
 * Format token counts for compact footer display.
 */
export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

/** Dollar amounts in the footer: four decimals below a cent, where cheap models live. */
export function formatCost(cost: number): string {
	return cost > 0 && cost < 0.01 ? `$${cost.toFixed(4)}` : `$${cost.toFixed(3)}`;
}

/**
 * The compact cost meter: `$0.0123 - 87% cached`, with the tightest budget as `$0.41/$0.50` when one is set.
 * Undefined before anything was billed (and no budget is set).
 */
export function formatCostMeter(
	totals: Pick<UsageTotals, "input" | "cacheRead" | "cacheWrite" | "cost">,
	budget?: Pick<BudgetStatus, "limit">,
	options: { cached?: boolean } = {},
): string | undefined {
	const prompt = totals.input + totals.cacheRead + totals.cacheWrite;
	if (totals.cost <= 0 && prompt <= 0 && !budget) return undefined;
	const money = budget ? `${usd(totals.cost)}/${usdLimit(budget.limit)}` : usd(totals.cost);
	const hit =
		options.cached !== false && prompt > 0 && totals.cacheRead > 0
			? ` - ${Math.round((totals.cacheRead / prompt) * 100)}% cached`
			: "";
	return `${money}${hit}`;
}

/** "hit 91%" for the session's prompt-cache hit rate, or undefined before any cache activity. */
export function formatCacheHitRate(
	totals: Pick<UsageTotals, "input" | "cacheRead" | "cacheWrite">,
): string | undefined {
	const prompt = totals.input + totals.cacheRead + totals.cacheWrite;
	if (prompt <= 0 || totals.cacheRead + totals.cacheWrite <= 0) return undefined;
	return `hit ${Math.round((totals.cacheRead / prompt) * 100)}%`;
}

export function formatCwdForFooter(cwd: string, home: string | undefined): string {
	if (!home) return cwd;

	const resolvedCwd = resolve(cwd);
	const resolvedHome = resolve(home);
	const relativeToHome = relative(resolvedHome, resolvedCwd);
	const isInsideHome =
		relativeToHome === "" ||
		(relativeToHome !== ".." && !relativeToHome.startsWith(`..${sep}`) && !isAbsolute(relativeToHome));

	if (!isInsideHome) return cwd;
	return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}

// ============================================================================
// Footer items
// ============================================================================

/** Built-in footer items, in the order the /statusline picker lists them. */
export const FOOTER_ITEM_IDS = [
	"model",
	"router",
	"thinking",
	"permissions",
	"cost",
	"cache",
	"context",
	"tests",
	"jobs",
	"todo",
	"branch",
	"cwd",
	"session",
	"time",
	"turn",
	"queue",
] as const;

export type FooterItemId = (typeof FOOTER_ITEM_IDS)[number];

/** `footer.items` entry that starts a new footer line. */
export const FOOTER_LINE_BREAK = "break";

export type FooterItemEntry = FooterItemId | typeof FOOTER_LINE_BREAK;

export interface FooterItemInfo {
	id: FooterItemId;
	label: string;
	description: string;
	/**
	 * Higher stays longer: on a narrow terminal the lowest-priority items of a line go first. The permission badge is
	 * never dropped or cut.
	 */
	priority: number;
}

export const FOOTER_ITEMS: Readonly<Record<FooterItemId, FooterItemInfo>> = {
	model: { id: "model", label: "Model", description: "Model in use (the routed model in auto mode)", priority: 90 },
	router: {
		id: "router",
		label: "Router",
		description: "Auto routing mode and why it picked the model (auto mode only)",
		priority: 70,
	},
	thinking: { id: "thinking", label: "Thinking", description: "Thinking level", priority: 60 },
	permissions: {
		id: "permissions",
		label: "Permissions",
		description: "Permission mode badge (never dropped; right-aligned when last on its line)",
		priority: Number.POSITIVE_INFINITY,
	},
	cost: {
		id: "cost",
		label: "Cost",
		description: "Session cost and the tightest budget (click: /usage)",
		priority: 75,
	},
	cache: { id: "cache", label: "Cache", description: "Prompt-cache hit rate", priority: 40 },
	context: { id: "context", label: "Context", description: "Context window used", priority: 80 },
	tests: {
		id: "tests",
		label: "Tests",
		description: "Last test run of the verify loop (or a tests status an extension reports)",
		priority: 50,
	},
	jobs: { id: "jobs", label: "Jobs", description: "Running background jobs", priority: 55 },
	todo: { id: "todo", label: "Todo", description: "Todo list progress (done/total)", priority: 45 },
	branch: { id: "branch", label: "Git branch", description: "Current git branch", priority: 35 },
	cwd: { id: "cwd", label: "Directory", description: "Working directory", priority: 30 },
	session: { id: "session", label: "Session name", description: "Session name, when set", priority: 25 },
	time: { id: "time", label: "Time", description: "Clock (HH:MM), updated when the footer redraws", priority: 10 },
	turn: {
		id: "turn",
		label: "Last turn",
		description: "The last turn's summary (time, files, tools, cost, model)",
		priority: 20,
	},
	queue: { id: "queue", label: "Queue", description: "Queued steering and follow-up messages", priority: 52 },
};

// ============================================================================
// Footer elements: on/off per part of the footer (`footer.show`)
// ============================================================================

/**
 * Every part of the footer that `footer.show` turns on and off, in /settings order. Ids shared with footer items
 * (model, cost, ...) also hide that item in a `footer.items` layout when set to false.
 */
export const FOOTER_ELEMENT_IDS = [
	"cwd",
	"branch",
	"session",
	"permissions",
	"cost",
	"cache",
	"context",
	"autoCompact",
	"tests",
	"xp",
	"todo",
	"queue",
	"time",
	"provider",
	"router",
	"model",
	"thinking",
	"decision",
	"confidence",
	"turn",
	"statuses",
] as const;

export type FooterElementId = (typeof FOOTER_ELEMENT_IDS)[number];
export type FooterShow = Record<FooterElementId, boolean>;

export interface FooterElementInfo {
	id: FooterElementId;
	label: string;
	description: string;
	/** On in today's footer. `turn` follows `display.turnSummary: "footer"` until set. */
	defaultOn: boolean;
}

const element = (id: FooterElementId, label: string, description: string, defaultOn = true): FooterElementInfo => ({
	id,
	label,
	description,
	defaultOn,
});

export const FOOTER_ELEMENTS: Readonly<Record<FooterElementId, FooterElementInfo>> = {
	cwd: element("cwd", "Directory", "Working directory, ~/project"),
	branch: element("branch", "Git branch", "Current git branch, (main)"),
	session: element("session", "Session name", "Session name, when set"),
	permissions: element("permissions", "Permission mode", "Permission badge at the right end, read & write"),
	cost: element("cost", "Cost", "Session cost and the tightest budget, $0.0123"),
	cache: element("cache", "Cache %", "Prompt-cache hit rate, 87% cached"),
	context: element("context", "Context", "Context window used, 4.3%/1.0M"),
	autoCompact: element("autoCompact", "Auto-compact marker", "(auto) after the context, when auto-compact is on"),
	tests: element("tests", "Tests", "Last test run of the verify loop"),
	xp: element("xp", "Experimental marker", "xp, when experimental features are on"),
	todo: element("todo", "Todo", "Todo list progress, todo 2/5", false),
	queue: element("queue", "Queue", "Queued steering and follow-up messages, 2 queued", false),
	time: element("time", "Clock", "Time of day, 14:32", false),
	provider: element("provider", "Provider", "(provider) before the model, with more than one provider"),
	router: element("router", "Router mode", "auto:medium, in auto mode"),
	model: element("model", "Model", "Model in use"),
	thinking: element("thinking", "Thinking level", "Thinking level, high"),
	decision: element("decision", "Router decision", "Why the router picked the model: code, fast, cached"),
	confidence: element("confidence", "Router difficulty", "Classifier difficulty score, d0.75"),
	turn: element(
		"turn",
		"Last turn row",
		"The last turn as a footer row (follows Turn summary: footer until set)",
		false,
	),
	statuses: element("statuses", "Extension statuses", "Row with extension status texts"),
};

export function isFooterElementId(value: unknown): value is FooterElementId {
	return typeof value === "string" && (FOOTER_ELEMENT_IDS as readonly string[]).includes(value);
}

/** Clean a `footer.show` setting: known element ids with boolean values only. */
export function normalizeFooterShow(value: unknown): Partial<FooterShow> {
	const result: Partial<FooterShow> = {};
	if (typeof value !== "object" || value === null || Array.isArray(value)) return result;
	for (const [key, on] of Object.entries(value as Record<string, unknown>)) {
		if (isFooterElementId(key) && typeof on === "boolean") result[key] = on;
	}
	return result;
}

/** Every element with its value: the setting over the defaults. `turn` follows the turn summary mode until set. */
export function resolveFooterShow(show: Partial<FooterShow>, turnSummaryMode: TurnSummaryMode = "reply"): FooterShow {
	const resolved = {} as FooterShow;
	for (const id of FOOTER_ELEMENT_IDS) resolved[id] = show[id] ?? FOOTER_ELEMENTS[id].defaultOn;
	resolved.turn = show.turn ?? turnSummaryMode === "footer";
	return resolved;
}

export type FooterPreset = "all" | "none" | "default";

/** `footer.show` for a preset: every element on, every element off, or unset (today's footer). */
export function footerShowForPreset(preset: FooterPreset): Partial<FooterShow> | undefined {
	if (preset === "default") return undefined;
	const show = {} as FooterShow;
	for (const id of FOOTER_ELEMENT_IDS) show[id] = preset === "all";
	return show;
}

/** Extension status keys shown by an item instead of the extension status line, when that item is in the footer. */
const STATUS_KEYS_BY_ITEM: Partial<Record<FooterItemId, string>> = { jobs: "jobs", tests: "tests" };

export function isFooterItemId(value: unknown): value is FooterItemId {
	return typeof value === "string" && (FOOTER_ITEM_IDS as readonly string[]).includes(value);
}

/**
 * Clean a `footer.items` setting: known ids and line breaks only, no duplicate items, no leading, trailing or doubled
 * breaks. Undefined (the default layout) for anything that is not an array.
 */
export function normalizeFooterItems(value: unknown): FooterItemEntry[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const seen = new Set<string>();
	const result: FooterItemEntry[] = [];
	for (const raw of value) {
		const entry = typeof raw === "string" ? raw.trim().toLowerCase() : raw;
		if (entry === FOOTER_LINE_BREAK) {
			if (result.length > 0 && result.at(-1) !== FOOTER_LINE_BREAK) result.push(FOOTER_LINE_BREAK);
		} else if (isFooterItemId(entry) && !seen.has(entry)) {
			seen.add(entry);
			result.push(entry);
		}
	}
	while (result.at(-1) === FOOTER_LINE_BREAK) result.pop();
	return result;
}

/** What a click on a footer item does (the interactive mode runs it). */
export type FooterAction =
	| "usage"
	| "router"
	| "model"
	| "thinking"
	| "permissions"
	| "context"
	| "branch"
	| "todo"
	| "jobs"
	| "tests";

const ITEM_ACTIONS: Partial<Record<FooterItemId, FooterAction>> = {
	model: "model",
	router: "router",
	thinking: "thinking",
	permissions: "permissions",
	cost: "usage",
	cache: "usage",
	context: "context",
	tests: "tests",
	jobs: "jobs",
	todo: "todo",
	branch: "branch",
};

/** One rendered item: styled text, and what a click on it does. */
interface FooterSegment {
	id: FooterItemId;
	text: string;
	click?: FooterAction;
}

interface SessionStats {
	session: AgentSession;
	sessionId: string;
	leafId: string | null;
	entryCount: number;
	limitsModel: unknown;
	usageTotals: UsageTotals;
	/** Router classifier and permission judge input tokens: no prompt cache, so left out of the hit rate. */
	decisionPrompt: number;
	/** Cost of the LLM calls since the last user prompt (one turn can be several calls). */
	turnCost: number;
	budget: BudgetStatus | undefined;
	contextUsage: ContextUsage | undefined;
	/** Todo progress, computed on first use (only a footer with the todo item needs it). */
	todo?: { done: number; total: number } | null;
}

/** Clock for the time item: local HH:MM. */
export function formatFooterClock(now: Date): string {
	return `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
}

/**
 * Footer component that shows pwd, token stats, and context usage.
 * Computes token/context stats from session, gets git branch and extension statuses from provider.
 *
 * Without `footer.items` it draws the default layout (pwd and permission badge, then stats and route). With them it
 * draws the listed items in order, one line per `break`, dropping the lowest-priority items when a line is too narrow.
 */
export class FooterComponent implements Component {
	private autoCompactEnabled = true;
	private session: AgentSession;
	private footerData: ReadonlyFooterDataProvider;
	private sessionStats?: SessionStats;
	private items: FooterItemEntry[] | undefined;
	/** Clock for the time item (tests pin it). */
	now: () => Date = () => new Date();
	/** Clickable items: their rows and columns in the last render. */
	private readonly hits = new HitMap<FooterAction>();
	private readonly rows = new ClickableRows<FooterAction>();
	/** Click on the cost meter: opens /usage. */
	onUsageClick: (() => void) | undefined;
	/** Click on any other item (route, model, permission badge, context, branch, todo, ...). */
	onAction: ((action: FooterAction, event: TuiMouseEvent) => void) | undefined;
	/** The last finished turn, for the turn item and the `display.turnSummary: "footer"` row. */
	private lastTurn: TurnSummaryData | undefined;
	private turnSummaryMode: TurnSummaryMode = "reply";
	private turnSummaryFields: Readonly<TurnSummaryFields> = DEFAULT_TURN_SUMMARY_FIELDS;
	/** `footer.show`: what is set; defaults fill the rest. */
	private show: Partial<FooterShow> = {};
	/** Queued steering and follow-up messages, for the queue element (interactive mode sets it). */
	queueCount: () => number = () => 0;

	constructor(session: AgentSession, footerData: ReadonlyFooterDataProvider, items?: readonly string[]) {
		this.session = session;
		this.footerData = footerData;
		this.setItems(items);
	}

	setSession(session: AgentSession): void {
		this.session = session;
	}

	setAutoCompactEnabled(enabled: boolean): void {
		this.autoCompactEnabled = enabled;
	}

	/** The `footer.items` setting; undefined restores the default layout. */
	setItems(items: readonly string[] | undefined): void {
		this.items = normalizeFooterItems(items);
	}

	getItems(): FooterItemEntry[] | undefined {
		return this.items ? [...this.items] : undefined;
	}

	/** The `footer.show` setting (elements on and off); empty restores the defaults. */
	setShow(show: unknown): void {
		this.show = normalizeFooterShow(show);
	}

	/**
	 * Whether an element is drawn. The default layout uses the defaults for unset elements; a `footer.items` layout
	 * draws what it lists, so only an explicit false hides there.
	 */
	private shows(id: FooterElementId): boolean {
		if (this.items) return this.show[id] !== false;
		return resolveFooterShow(this.show, this.turnSummaryMode)[id];
	}

	/** The last finished turn (undefined: none yet, or a new session). */
	setLastTurn(turn: TurnSummaryData | undefined): void {
		this.lastTurn = turn;
	}

	/** `display.turnSummary` and its fields: "footer" adds a last-turn row unless the layout has the turn item. */
	setTurnSummary(mode: TurnSummaryMode, fields: Readonly<TurnSummaryFields>): void {
		this.turnSummaryMode = mode;
		this.turnSummaryFields = fields;
	}

	/** The last-turn row of `display.turnSummary: "footer"`, flush left; undefined when there is none to draw. */
	private lastTurnRow(width: number): string | undefined {
		if (!this.lastTurn) return undefined;
		if (!(this.show.turn ?? this.turnSummaryMode === "footer")) return undefined;
		if (this.items?.includes("turn")) return undefined;
		return formatTurnSummaryLine(this.lastTurn, width, this.turnSummaryFields);
	}

	/**
	 * No-op: git branch caching now handled by provider.
	 * Kept for compatibility with existing call sites in interactive-mode.
	 */
	invalidate(): void {
		// No-op: git branch is cached/invalidated by provider
	}

	/**
	 * Clean up resources.
	 * Git watcher cleanup now handled by provider.
	 */
	dispose(): void {
		// Git watcher cleanup handled by provider
	}

	/**
	 * Usage totals and context usage scan the whole session, and the footer renders on every frame.
	 * Entries are append-only and every append moves the leaf, so the results only change with the
	 * session, leaf, entry count, or the model whose context window applies.
	 */
	private getSessionStats(): SessionStats {
		const sessionManager = this.session.sessionManager;
		const entryCount = sessionManager.getEntryCount();
		const sessionId = sessionManager.getSessionId();
		const leafId = sessionManager.getLeafId();
		const limitsModel = this.session.routedModel?.model ?? this.session.model;
		const cached = this.sessionStats;
		if (
			cached &&
			cached.session === this.session &&
			cached.sessionId === sessionId &&
			cached.leafId === leafId &&
			cached.entryCount === entryCount &&
			cached.limitsModel === limitsModel
		) {
			return cached;
		}

		// Calculate cumulative usage from ALL session entries (not just post-compaction messages)
		const usageTotals = createUsageTotals();
		let turnCost = 0;
		let decisionPrompt = 0;

		for (const entry of sessionManager.getEntries()) {
			if (entry.type === "message" && entry.message.role === "user") {
				turnCost = 0;
			} else if (entry.type === "usage") {
				addUsageToTotals(usageTotals, entry.usage);
				// Decision models (router classifier, permission judge) have no prompt cache: keep their input out of the
				// cache hit rate, as /usage does, so the footer and the overlay show the same percentage.
				if (entry.kind === "classifier" || entry.kind === "judge") decisionPrompt += entry.usage.input;
			} else if (entry.type === "message" && entry.message.role === "assistant") {
				addUsageToTotals(usageTotals, entry.message.usage);
				turnCost += entry.message.usage.cost.total;
			} else if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.usage) {
				addUsageToTotals(usageTotals, entry.message.usage);
			} else if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
				addUsageToTotals(usageTotals, entry.usage);
			}
		}

		// Calculate context usage from session (handles compaction correctly).
		// After compaction, tokens are unknown until the next LLM response.
		const contextUsage = this.session.getContextUsage();
		let budget: BudgetStatus | undefined;
		try {
			budget = tightestBudget(this.session.getBudgetStatuses?.() ?? []);
		} catch {
			budget = undefined;
		}
		this.sessionStats = {
			budget,
			session: this.session,
			sessionId,
			leafId,
			entryCount,
			limitsModel,
			usageTotals,
			decisionPrompt,
			turnCost,
			contextUsage,
		};
		return this.sessionStats;
	}

	// ------------------------------------------------------------------------
	// Item texts, shared by the default layout and configured footers
	// ------------------------------------------------------------------------

	/** `▸ read & write`, in the warning color for allow-all so it is never missed. */
	private permissionBadge(): string {
		const mode = this.session.permissionMode;
		const info = permissionModeInfo(mode);
		const color = mode === "allow-all" ? "warning" : mode === "ask" ? "muted" : "accent";
		const icon = mode === "allow-all" ? "▸▸" : mode === "plan" ? "‖" : "▸";
		return `${theme.fg(color, icon)} ${theme.fg(color, info.badge)}`;
	}

	private usingSubscription(): boolean {
		const model = this.session.state.model;
		// Kimi Coding is subscription-backed despite using API-key authentication.
		return model
			? model.provider === "kimi-coding" || this.session.modelRuntime.isUsingSubscription(model.provider)
			: false;
	}

	/** Prompt totals for the hit rate: decision-model input left out. */
	private cacheTotals(stats: SessionStats): UsageTotals {
		return { ...stats.usageTotals, input: Math.max(0, stats.usageTotals.input - stats.decisionPrompt) };
	}

	/** Cost text colored by budget level, or undefined before anything was billed. */
	private colorByBudget(text: string, budget: BudgetStatus | undefined): string {
		return budget?.level === "over"
			? theme.fg("error", text)
			: budget?.level === "warn"
				? theme.fg("warning", text)
				: text;
	}

	/** `4.3%/1.0M (auto)`, warning above 70%, error above 90%. */
	private contextText(stats: SessionStats): string {
		const state = this.session.state;
		const { contextUsage } = stats;
		const contextWindow = contextUsage?.contextWindow ?? state.model?.contextWindow ?? 0;
		const contextPercentValue = contextUsage?.percent ?? 0;
		const contextPercent = contextUsage?.percent !== null ? contextPercentValue.toFixed(1) : "?";
		const autoIndicator = this.autoCompactEnabled && this.shows("autoCompact") ? " (auto)" : "";
		const contextPercentDisplay =
			contextPercent === "?"
				? `?/${formatTokens(contextWindow)}${autoIndicator}`
				: `${contextPercent}%/${formatTokens(contextWindow)}${autoIndicator}`;
		if (contextPercentValue > 90) return theme.fg("error", contextPercentDisplay);
		if (contextPercentValue > 70) return theme.fg("warning", contextPercentDisplay);
		return contextPercentDisplay;
	}

	private thinkingText(): string | undefined {
		const state = this.session.state;
		const thinkingLevel = state.thinkingLevel || "off";
		if (this.session.isAutoRouting) return this.session.isThinkingAuto ? thinkingLevel : `${thinkingLevel} (pinned)`;
		if (!state.model?.reasoning) return undefined;
		return thinkingLevel === "off" ? "thinking off" : thinkingLevel;
	}

	/**
	 * The route reason with its decision and difficulty parts as `footer.show` allows: `code d0.75 fast`, `code fast`
	 * or `d0.75`.
	 */
	private routeReason(decision: RouteDecision): string {
		const reason = shortRouteReason(decision);
		const showDecision = this.shows("decision");
		const showConfidence = this.shows("confidence");
		if (showDecision && showConfidence) return reason;
		const confidence = decision.difficulty !== undefined ? `d${decision.difficulty.toFixed(2)}` : undefined;
		return reason
			.split(" ")
			.filter((token) => (token === confidence ? showConfidence : showDecision))
			.join(" ");
	}

	/**
	 * The model / route text of the default layout: `auto:<mode> → <model> - <thinking> - <why>`, each part as
	 * `footer.show` allows. Empty when every part is off.
	 */
	private routeText(): string {
		const state = this.session.state;
		const model = this.shows("model") ? state.model?.id || "no-model" : undefined;
		if (this.session.isAutoRouting) {
			const decision = this.session.lastRouteDecision;
			const router = this.shows("router")
				? `auto:${this.session.routerMode}${decision?.error ? "!" : ""}`
				: undefined;
			const lead = router && model ? `${router} → ${model}` : (router ?? model ?? "");
			if (!decision) return router ? `${lead} (routes on next message)` : lead;
			const thinking = this.shows("thinking") ? this.thinkingText() : undefined;
			return [lead, thinking, this.routeReason(decision)].filter((part) => part).join(" - ");
		}
		if (state.model?.reasoning && this.shows("thinking")) {
			return [model, this.thinkingText()].filter((part) => part).join(" - ");
		}
		return model ?? "";
	}

	private todoProgress(stats: SessionStats): { done: number; total: number } | null {
		if (stats.todo === undefined) {
			let items: Array<{ status: string }> = [];
			try {
				items = this.session.todoItems ?? [];
			} catch {
				items = [];
			}
			stats.todo =
				items.length === 0
					? null
					: { done: items.filter((item) => item.status === "completed").length, total: items.length };
		}
		return stats.todo;
	}

	/** The verify loop's last test run, coloured by its state; undefined before the first run. */
	private verifyText(): string | undefined {
		const verify = this.session.verify;
		const marker = verify?.marker;
		if (!marker) return undefined;
		const status = verify.status;
		const color =
			status.state === "pass"
				? "success"
				: status.state === "fail"
					? status.setupError
						? "warning"
						: "error"
					: status.state === "timeout"
						? "warning"
						: "muted";
		return theme.fg(color, marker);
	}

	/** One item's segment, or undefined when it has nothing to show right now. */
	private renderItem(id: FooterItemId, stats: SessionStats): FooterSegment | undefined {
		const state = this.session.state;
		switch (id) {
			case "model": {
				const name = state.model?.id || "no-model";
				const withProvider =
					this.footerData.getAvailableProviderCount() > 1 && state.model && this.shows("provider")
						? `(${state.model.provider}) ${name}`
						: name;
				return { id, text: theme.fg("dim", withProvider) };
			}
			case "router": {
				if (!this.session.isAutoRouting) return undefined;
				const decision = this.session.lastRouteDecision;
				const auto = `auto:${this.session.routerMode}${decision?.error ? "!" : ""}`;
				const why = decision ? this.routeReason(decision) : "routes on next message";
				return { id, text: theme.fg("dim", why ? `${auto} - ${why}` : auto) };
			}
			case "thinking": {
				const text = this.thinkingText();
				return text ? { id, text: theme.fg("dim", text) } : undefined;
			}
			case "permissions":
				return { id, text: this.permissionBadge() };
			case "cost": {
				const totals = this.cacheTotals(stats);
				const subscription = this.usingSubscription();
				const billed = totals.cost > 0 || totals.input + totals.cacheRead + totals.cacheWrite > 0;
				if (!billed && !stats.budget && !subscription) return undefined;
				const money = stats.budget ? `${usd(totals.cost)}/${usdLimit(stats.budget.limit)}` : usd(totals.cost);
				const text = `${money}${subscription ? " (sub)" : ""}`;
				const colored = this.colorByBudget(text, stats.budget);
				return {
					id,
					text: stats.budget && stats.budget.level !== "ok" ? colored : theme.fg("dim", text),
					click: "usage",
				};
			}
			case "cache": {
				const totals = this.cacheTotals(stats);
				const prompt = totals.input + totals.cacheRead + totals.cacheWrite;
				if (prompt <= 0 || totals.cacheRead <= 0) return undefined;
				return { id, text: theme.fg("dim", `${Math.round((totals.cacheRead / prompt) * 100)}% cached`) };
			}
			case "context": {
				const text = this.contextText(stats);
				const colored = (stats.contextUsage?.percent ?? 0) > 70;
				return { id, text: colored ? text : theme.fg("dim", text) };
			}
			case "tests": {
				// The verify loop's marker; an extension's "tests" status when the loop has not run.
				const verify = this.verifyText();
				if (verify) return { id, text: verify };
				const status = this.footerData.getExtensionStatuses().get(STATUS_KEYS_BY_ITEM[id]!);
				const text = status ? sanitizeStatusText(status) : "";
				return text ? { id, text } : undefined;
			}
			case "jobs": {
				const status = this.footerData.getExtensionStatuses().get(STATUS_KEYS_BY_ITEM[id]!);
				const text = status ? sanitizeStatusText(status) : "";
				return text ? { id, text } : undefined;
			}
			case "todo": {
				const progress = this.todoProgress(stats);
				return progress ? { id, text: theme.fg("dim", `todo ${progress.done}/${progress.total}`) } : undefined;
			}
			case "branch": {
				const branch = this.footerData.getGitBranch();
				return branch ? { id, text: theme.fg("dim", `⎇ ${branch}`) } : undefined;
			}
			case "cwd": {
				const cwd = formatCwdForFooter(
					this.session.sessionManager.getCwd(),
					process.env.HOME || process.env.USERPROFILE,
				);
				return { id, text: theme.fg("dim", cwd) };
			}
			case "session": {
				const name = this.session.sessionManager.getSessionName();
				return name ? { id, text: theme.fg("dim", sanitizeStatusText(name)) } : undefined;
			}
			case "time":
				return { id, text: theme.fg("dim", formatFooterClock(this.now())) };
			case "queue": {
				const count = this.queueCount();
				return count > 0 ? { id, text: theme.fg("dim", `${count} queued`) } : undefined;
			}
			case "turn":
				return this.lastTurn
					? { id, text: formatTurnSummaryLine(this.lastTurn, Number.MAX_SAFE_INTEGER, this.turnSummaryFields) }
					: undefined;
		}
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		const value = event.type === "leave" ? undefined : this.hits.at(event.x, event.y);
		const available = (action: FooterAction | undefined) =>
			action === undefined
				? undefined
				: action === "usage"
					? this.onUsageClick
						? action
						: undefined
					: this.onAction
						? action
						: undefined;
		return this.rows.handle(available(value), event, {
			activate: (action, clickEvent) => {
				if (action === "usage") this.onUsageClick?.();
				else this.onAction?.(action, clickEvent);
			},
		});
	}

	/** Hovered items are underlined. */
	private styleClickable(text: string, action: FooterAction | undefined): string {
		return action !== undefined && this.rows.isHovered(action) ? underline(text) : text;
	}

	render(width: number): string[] {
		this.hits.reset();
		const lines = this.items ? this.renderItems(this.items, width) : this.renderDefault(width);
		const turnRow = this.lastTurnRow(width);
		if (turnRow) lines.push(turnRow);
		// Add extension statuses on a single line, sorted by key alphabetically. Statuses an item shows are left out.
		const shownByItems = new Set(
			(this.items ?? []).map((id) => STATUS_KEYS_BY_ITEM[id as FooterItemId]).filter((key) => key !== undefined),
		);
		const extensionStatuses = [...this.footerData.getExtensionStatuses().entries()].filter(
			([key]) => !shownByItems.has(key),
		);
		if (extensionStatuses.length > 0 && this.shows("statuses")) {
			const sortedStatuses = extensionStatuses
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([, text]) => sanitizeStatusText(text));
			const statusLine = sortedStatuses.join(" ");
			// Truncate to terminal width with dim ellipsis for consistency with footer style
			lines.push(truncateToWidth(statusLine, width, theme.fg("dim", "...")));
		}
		return lines;
	}

	/**
	 * A configured footer: items in order, a new line at each `break`. A line too wide for the terminal drops its
	 * lowest-priority items first; the permission badge is never dropped or cut, and sits at the right edge when it
	 * is the last item of its line.
	 */
	private renderItems(entries: readonly FooterItemEntry[], width: number): string[] {
		const stats = this.getSessionStats();
		const separator = theme.fg("dim", " - ");
		const separatorWidth = visibleWidth(separator);
		const groups: FooterItemId[][] = [[]];
		for (const entry of entries) {
			if (entry === FOOTER_LINE_BREAK) groups.push([]);
			else groups.at(-1)!.push(entry);
		}
		const lines: string[] = [];
		for (const group of groups) {
			let segments = group
				.filter((id) => !isFooterElementId(id) || this.shows(id))
				.map((id) => this.renderItem(id, stats))
				.filter((segment): segment is FooterSegment => segment !== undefined);
			if (segments.length === 0) continue;
			const badgeLast = segments.at(-1)?.id === "permissions" && segments.length > 1;
			const lineWidth = (list: FooterSegment[]) =>
				list.reduce((sum, segment) => sum + visibleWidth(segment.text), 0) +
				Math.max(0, list.length - 1 - (badgeLast && list.length > 1 ? 1 : 0)) * separatorWidth +
				(badgeLast && list.length > 1 ? 2 : 0);
			while (segments.length > 1 && lineWidth(segments) > width) {
				let drop = -1;
				for (let index = 0; index < segments.length; index++) {
					const priority = FOOTER_ITEMS[segments[index]!.id].priority;
					if (!Number.isFinite(priority)) continue;
					// The lowest priority goes first; among equals, the one furthest right.
					if (drop < 0 || priority <= FOOTER_ITEMS[segments[drop]!.id].priority) drop = index;
				}
				if (drop < 0) break;
				segments = segments.filter((_, index) => index !== drop);
			}
			lines.push(this.composeLine(segments, width, separator, badgeLast, lines.length));
		}
		return lines;
	}

	private composeLine(
		segments: FooterSegment[],
		width: number,
		separator: string,
		badgeLast: boolean,
		row: number,
	): string {
		const badge = badgeLast && segments.length > 1 ? segments.at(-1)! : undefined;
		const left = badge ? segments.slice(0, -1) : segments;
		const badgeWidth = badge ? visibleWidth(badge.text) : 0;
		const room = badge ? Math.max(0, width - badgeWidth - 2) : width;
		let text = "";
		let column = 0;
		for (const [index, segment] of left.entries()) {
			if (index > 0) {
				text += separator;
				column += visibleWidth(separator);
			}
			const segmentWidth = visibleWidth(segment.text);
			const action = segment.click ?? ITEM_ACTIONS[segment.id];
			if (action && column < room) this.hits.add(row, action, column, Math.min(room, column + segmentWidth));
			text += this.styleClickable(segment.text, action);
			column += segmentWidth;
		}
		// The permission badge alone on a line is never cut; anything else is cut to fit.
		const lone = left.length === 1 && left[0]!.id === "permissions";
		if (!lone && visibleWidth(text) > room) text = truncateToWidth(text, room, theme.fg("dim", "..."));
		if (!badge) return lone ? truncateToWidth(text, width, "") : text;
		const badgeStart = visibleWidth(text) + Math.max(2, width - visibleWidth(text) - badgeWidth);
		this.hits.add(row, "permissions", badgeStart, badgeStart + badgeWidth);
		return `${text}${" ".repeat(badgeStart - visibleWidth(text))}${this.styleClickable(badge.text, "permissions")}`;
	}

	/** The default footer, used while `footer.items` is unset. Rows with nothing left to show are dropped. */
	private renderDefault(width: number): string[] {
		const state = this.session.state;
		const stats = this.getSessionStats();
		const { usageTotals, decisionPrompt, budget } = stats;
		const lines: string[] = [];

		// Directory (home as ~), git branch and session name.
		let pwd = this.shows("cwd")
			? formatCwdForFooter(this.session.sessionManager.getCwd(), process.env.HOME || process.env.USERPROFILE)
			: "";
		const branch = this.shows("branch") ? this.footerData.getGitBranch() : null;
		if (branch) pwd = pwd ? `${pwd} (${branch})` : `(${branch})`;
		const sessionName = this.shows("session") ? this.session.sessionManager.getSessionName() : undefined;
		if (sessionName) pwd = pwd ? `${pwd} - ${sessionName}` : sessionName;
		const showBadge = this.shows("permissions");
		if (pwd || showBadge)
			lines.push(this.withPermissionBadge(pwd, width, branch ?? undefined, showBadge, lines.length));

		// Build stats line: the compact cost meter first (click it, or run /usage, for the breakdown).
		const statsRow = lines.length;
		const statsParts: string[] = [];
		const usingSubscription = this.usingSubscription();
		const cacheTotals = { ...usageTotals, input: Math.max(0, usageTotals.input - decisionPrompt) };
		const statsSeparator = theme.fg("dim", " - ");
		let statsColumn = 0;
		const addStat = (text: string, action: FooterAction | undefined) => {
			if (statsParts.length > 0) statsColumn += visibleWidth(statsSeparator);
			const textWidth = visibleWidth(text);
			if (action) this.hits.add(statsRow, action, statsColumn, statsColumn + textWidth);
			statsColumn += textWidth;
			statsParts.push(this.styleClickable(text, action));
		};
		if (this.shows("cost")) {
			const meter = formatCostMeter(cacheTotals, budget, { cached: this.shows("cache") });
			if (meter || usingSubscription) {
				const text = `${meter ?? usd(0)}${usingSubscription ? " (sub)" : ""}`;
				addStat(this.colorByBudget(text, budget), "usage");
			}
		} else if (this.shows("cache")) {
			const hit = formatCacheHitRate(cacheTotals);
			const prompt = cacheTotals.input + cacheTotals.cacheRead + cacheTotals.cacheWrite;
			if (hit && cacheTotals.cacheRead > 0)
				addStat(theme.fg("dim", `${Math.round((cacheTotals.cacheRead / prompt) * 100)}% cached`), "usage");
		}

		if (this.shows("context")) addStat(this.contextText(stats), "context");
		// The verify loop's last test run (✓ tests, ✗ 3 failing ↻1, ⚠ test command): nothing before the first run.
		const tests = this.shows("tests") ? this.verifyText() : undefined;
		if (tests) addStat(tests, "tests");
		if (areExperimentalFeaturesEnabled() && this.shows("xp")) {
			addStat(theme.bold(theme.fg("warning", "xp")), undefined);
		}
		if (this.shows("todo")) {
			const progress = this.todoProgress(stats);
			if (progress) addStat(theme.fg("dim", `todo ${progress.done}/${progress.total}`), "todo");
		}
		if (this.shows("queue")) {
			const queued = this.queueCount();
			if (queued > 0) addStat(theme.fg("dim", `${queued} queued`), undefined);
		}
		if (this.shows("time")) addStat(theme.fg("dim", formatFooterClock(this.now())), undefined);

		let statsLeft = statsParts.join(statsSeparator);
		let statsLeftWidth = visibleWidth(statsLeft);

		// If statsLeft is too wide, truncate it
		if (statsLeftWidth > width) {
			statsLeft = truncateToWidth(statsLeft, width, "...");
			statsLeftWidth = visibleWidth(statsLeft);
		}

		// Calculate available space for padding (minimum 2 spaces between stats and model)
		const minPadding = 2;
		const rightSideWithoutProvider = this.routeText();
		if (!statsLeft && !rightSideWithoutProvider) return lines;
		const withProvider =
			this.footerData.getAvailableProviderCount() > 1 &&
			state.model &&
			this.shows("provider") &&
			rightSideWithoutProvider
				? `(${state.model.provider}) ${rightSideWithoutProvider}`
				: undefined;

		// Prepend the provider in parentheses if there are multiple providers and there's enough room
		let rightSide = rightSideWithoutProvider;
		if (withProvider) {
			rightSide = withProvider;
			if (statsLeftWidth + minPadding + visibleWidth(rightSide) > width) {
				// Too wide, fall back
				rightSide = rightSideWithoutProvider;
			}
		}

		const rightSideWidth = visibleWidth(rightSide);
		const totalNeeded = statsLeftWidth + minPadding + rightSideWidth;

		// Apply dim to each part separately. statsLeft may contain color codes (for context %)
		// that end with a reset, which would clear an outer dim wrapper. So we dim the parts
		// before and after the colored section independently.
		const dimStatsLeft = theme.fg("dim", statsLeft);
		const routeAction: FooterAction = this.session.isAutoRouting ? "router" : "model";

		if (!rightSide) {
			lines.push(dimStatsLeft);
		} else if (totalNeeded <= width) {
			// Both fit - add padding to right-align the model / route
			const padding = " ".repeat(width - statsLeftWidth - rightSideWidth);
			this.hits.add(statsRow, routeAction, width - rightSideWidth, width);
			lines.push(dimStatsLeft + theme.fg("dim", padding + this.styleClickable(rightSide, routeAction)));
		} else {
			// Too narrow for stats (cost meter included) and the model / route on one line (an auto route
			// reads "auto:<mode> → <model> - <thinking> - <reason>", ~60 columns): give the model / route a
			// line of its own, right-aligned under the stats, instead of cutting the route reason off.
			if (statsLeft) lines.push(dimStatsLeft);
			const routeText =
				withProvider && visibleWidth(withProvider) <= width ? withProvider : rightSideWithoutProvider;
			const routeLine = truncateToWidth(routeText, width, "...");
			const routePadding = " ".repeat(Math.max(0, width - visibleWidth(routeLine)));
			this.hits.add(lines.length, routeAction, routePadding.length, width);
			lines.push(theme.fg("dim", routePadding + this.styleClickable(routeLine, routeAction)));
		}
		return lines;
	}

	/**
	 * The pwd line with the permission mode right-aligned, e.g. `▸ read & write`. The pwd is cut first when the line
	 * is too narrow.
	 */
	private withPermissionBadge(pwd: string, width: number, branch?: string, showBadge = true, row = 0): string {
		const badge = showBadge ? this.permissionBadge() : "";
		const badgeWidth = visibleWidth(badge);
		if (!showBadge || (width < badgeWidth + 12 && pwd)) return this.pwdOnly(pwd, width, branch, row);
		if (!pwd) {
			// The badge alone: flush with the last column.
			const start = Math.max(0, width - badgeWidth);
			this.hits.add(row, "permissions", start, start + badgeWidth);
			return truncateToWidth(`${" ".repeat(start)}${this.styleClickable(badge, "permissions")}`, width, "");
		}
		let left = truncateToWidth(theme.fg("dim", pwd), width - badgeWidth - 2, theme.fg("dim", "..."));
		left = this.branchHit(pwd, left, branch, row);
		const badgeStart = visibleWidth(left) + Math.max(2, width - visibleWidth(left) - badgeWidth);
		this.hits.add(row, "permissions", badgeStart, badgeStart + badgeWidth);
		return `${left}${" ".repeat(badgeStart - visibleWidth(left))}${this.styleClickable(badge, "permissions")}`;
	}

	/** The pwd line without the badge (turned off, or no room for it). */
	private pwdOnly(pwd: string, width: number, branch: string | undefined, row: number): string {
		return this.branchHit(pwd, truncateToWidth(theme.fg("dim", pwd), width, theme.fg("dim", "...")), branch, row);
	}

	/** The "(branch)" part opens /diff when it is shown whole; underlined while hovered. */
	private branchHit(pwd: string, left: string, branch: string | undefined, row: number): string {
		if (!branch) return left;
		const label = `(${branch})`;
		const at = pwd.lastIndexOf(label);
		if (at >= 0 && visibleWidth(pwd.slice(0, at + label.length)) <= visibleWidth(left)) {
			const start = visibleWidth(pwd.slice(0, at));
			this.hits.add(row, "branch", start, start + visibleWidth(label));
			if (this.rows.isHovered("branch") && visibleWidth(left) === visibleWidth(pwd)) {
				return theme.fg("dim", `${pwd.slice(0, at)}${underline(label)}${pwd.slice(at + label.length)}`);
			}
		}
		return left;
	}
}
