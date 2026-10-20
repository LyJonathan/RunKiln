/**
 * The `/usage` tabs as lines of text: Overview, Models, Turns, Context, History. The TUI screen draws them in the
 * theme (ember accents); print mode, `runkiln usage` and tests use the same views with plain styling, so every
 * surface shows the same numbers. Every line fits `width` columns (80 and up) before styling.
 */

import { type BudgetStatus, describeBudget } from "./budget.ts";
import { displayModelKey, type LedgerSummary, sparkline, type UsageRange } from "./ledger.ts";
import type { ContextBreakdown, SessionUsageReport, TurnUsageRow, UsageCategory } from "./session-usage.ts";
import { zonedClock } from "./time.ts";

export type UsageTab = "overview" | "models" | "turns" | "context" | "history";
export const USAGE_TABS: readonly UsageTab[] = ["overview", "models", "turns", "context", "history"];
export const USAGE_TAB_LABELS: Record<UsageTab, string> = {
	overview: "Overview",
	models: "Models",
	turns: "Turns",
	context: "Context",
	history: "History",
};

/** Colors for the views. Plain output passes identity functions. */
export interface UsageStyle {
	accent(text: string): string;
	strong(text: string): string;
	muted(text: string): string;
	dim(text: string): string;
	success(text: string): string;
	warning(text: string): string;
	error(text: string): string;
	/** Context bar segments, in order: system prompt, tools, messages, tool results. */
	part(index: number, text: string): string;
	/** Sparkline / bar fill. */
	bar(text: string): string;
}

const identity = (text: string) => text;
export const PLAIN_STYLE: UsageStyle = {
	accent: identity,
	strong: identity,
	muted: identity,
	dim: identity,
	success: identity,
	warning: identity,
	error: identity,
	part: (_index, text) => text,
	bar: identity,
};

// ---------------------------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------------------------

/** `$0.0123` below a dollar, `$12.35` above; `<$0.0001` for a tiny non-zero amount. */
export function usd(value: number): string {
	if (value > 0 && value < 0.00005) return "<$0.0001";
	if (value < 1) return `$${value.toFixed(4)}`;
	return `$${value.toFixed(2)}`;
}

/** A budget limit as set: `$0.50`, `$2.00` (more decimals only when the setting has them). */
export function usdLimit(value: number): string {
	return Math.abs(value * 100 - Math.round(value * 100)) < 1e-9 ? `$${value.toFixed(2)}` : usd(value);
}

export function tokens(count: number): string {
	if (count < 1000) return String(Math.round(count));
	if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
	if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	return `${Math.round(count / 1_000_000)}M`;
}

export function percent(value: number | undefined): string {
	return value === undefined ? "–" : `${Math.round(value)}%`;
}

export function duration(ms: number): string {
	if (ms < 1000) return `${Math.round(ms)}ms`;
	const seconds = ms / 1000;
	if (seconds < 60) return `${seconds.toFixed(1)}s`;
	const minutes = Math.floor(seconds / 60);
	const rest = Math.round(seconds % 60);
	if (minutes < 60) return rest === 0 ? `${minutes}m` : `${minutes}m ${String(rest).padStart(2, "0")}s`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** `HH:MM` in the user's time zone (`TZ`, else the OS zone). */
function clock(ms: number): string {
	return zonedClock(ms);
}

/** Cut a plain string to `width` columns with an ellipsis. */
export function cut(text: string, width: number): string {
	if (width <= 0) return "";
	const chars = [...text];
	return chars.length <= width ? text : `${chars.slice(0, Math.max(0, width - 1)).join("")}…`;
}

function padEnd(text: string, width: number): string {
	const clipped = cut(text, width);
	return clipped + " ".repeat(Math.max(0, width - [...clipped].length));
}

function padStart(text: string, width: number): string {
	const clipped = cut(text, width);
	return " ".repeat(Math.max(0, width - [...clipped].length)) + clipped;
}

/** A proportional bar: `███░░░` of `width` cells. */
function meter(fraction: number, width: number, style: UsageStyle): string {
	const filled = Math.max(0, Math.min(width, Math.round(fraction * width)));
	const nonZero = fraction > 0 && filled === 0 ? 1 : filled;
	return style.bar("█".repeat(nonZero)) + style.dim("░".repeat(width - nonZero));
}

function label(text: string, style: UsageStyle, width = 9): string {
	return style.muted(padEnd(text, width));
}

function heading(text: string, style: UsageStyle): string {
	return style.accent(style.strong(text));
}

// ---------------------------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------------------------

export interface OverviewExtras {
	budgets?: readonly BudgetStatus[];
	/** Session id or name, for the title. */
	session?: string;
}

const CATEGORY_SHORT: Record<UsageCategory, string> = {
	main: "Main turns",
	subagent: "Subagents",
	chore: "Chores",
	classifier: "Router classifier",
	judge: "Permission judge",
	tool: "Other tools",
};

export function overviewLines(
	report: SessionUsageReport,
	width: number,
	style: UsageStyle = PLAIN_STYLE,
	extras: OverviewExtras = {},
): string[] {
	const o = report.overview;
	const lines: string[] = [];
	const hit = o.hitPct !== undefined ? ` - ${percent(o.hitPct)} cached` : "";
	lines.push(
		`${label("Session", style)}${style.accent(style.strong(usd(o.cost)))}${style.muted(hit)}${
			o.savedByCache > 0
				? style.success(` - cache saved ${usd(o.savedByCache)}`) +
					style.dim(` (no cache: ${usd(o.cost + o.savedByCache)})`)
				: ""
		}`,
	);
	const reasoning = o.costReasoning > 0 ? style.dim(` (reasoning ${usd(o.costReasoning)})`) : "";
	lines.push(
		`${label("Cost", style)}${style.muted("input ")}${usd(o.costInput)}  ${style.muted("cached ")}${usd(o.costCached)}  ${style.muted("output ")}${usd(o.costOutput)}${reasoning}`,
	);
	const reasoningTokens = o.reasoning > 0 ? style.dim(` (reasoning ${tokens(o.reasoning)})`) : "";
	// input + cached here is the prompt the cache % is taken over; the decision models' input (never cached) is
	// counted on its own so the two agree.
	lines.push(
		`${label("Tokens", style)}${style.muted("input ")}${tokens(o.input - o.decisionInput)}  ${style.muted("cached ")}${tokens(o.cached)}  ${style.muted("output ")}${tokens(o.output)}${reasoningTokens}`,
	);
	if (o.decisionInput > 0) {
		lines.push(
			`${label("", style)}${style.dim(`+ ${tokens(o.decisionInput)} router/judge input (never cached, not in the %)`)}`,
		);
	}
	const calls = [
		`${o.requests} request${o.requests === 1 ? "" : "s"}`,
		`${o.turns} turn${o.turns === 1 ? "" : "s"}`,
		...(o.wallMs > 0 ? [`wall ${duration(o.wallMs)}`] : []),
		...(o.apiMs > 0 ? [`API ${duration(o.apiMs)}`] : []),
		...(o.avgTtftMs !== undefined ? [`avg TTFT ${duration(o.avgTtftMs)}`] : []),
	];
	lines.push(`${label("Calls", style)}${calls.join(style.dim(" - "))}`);
	if (o.cost > 0) {
		const billed = [
			o.serverCost > 0 ? `${usd(o.serverCost)} server-billed` : undefined,
			o.cost - o.serverCost - o.estimatedCost > 0.0000005
				? `${usd(o.cost - o.serverCost - o.estimatedCost)} at catalog prices`
				: undefined,
			o.estimatedCost > 0 ? style.warning(`${usd(o.estimatedCost)} est.`) : undefined,
		].filter((part): part is string => part !== undefined);
		if (billed.length > 0) lines.push(`${label("Billing", style)}${billed.join(style.dim(" - "))}`);
	}
	for (const [index, budget] of (extras.budgets ?? []).entries()) {
		const text = describeBudget(budget, usd, usdLimit);
		const colored =
			budget.level === "over" ? style.error(text) : budget.level === "warn" ? style.warning(text) : text;
		lines.push(`${label(index === 0 ? "Budget" : "", style)}${colored}`);
	}
	lines.push(...cacheLines(report, style));
	lines.push("");
	lines.push(heading("By category", style));
	const total = report.categories.reduce((sum, row) => sum + row.cost, 0);
	const barWidth = Math.max(6, Math.min(20, width - 62));
	for (const row of report.categories) {
		const share = total > 0 ? row.cost / total : 0;
		lines.push(
			`  ${padEnd(CATEGORY_SHORT[row.category], 18)}${style.muted(padStart(`${row.requests} req`, 8))}${style.muted(padStart(`${tokens(row.tokens)} tok`, 10))}${padStart(usd(row.cost), 10)}${row.estimated ? style.warning(" est") : "    "} ${meter(share, barWidth, style)} ${style.dim(padStart(percent(share * 100), 4))}`,
		);
	}
	return lines;
}

function cacheLines(report: SessionUsageReport, style: UsageStyle): string[] {
	const cache = report.cache;
	const lines: string[] = [];
	if (cache.state === "unknown") {
		lines.push(`${label("Cache", style)}${style.dim("no request yet")}`);
		return lines;
	}
	const pair = `${cache.model ?? "?"}${cache.thinking ? ` - ${cache.thinking}` : ""}`;
	const idle =
		cache.idleMs !== undefined && cache.ttlMs !== undefined
			? cache.state === "warm"
				? ` - idle ${cache.idleMs < 1000 ? "<1s" : duration(cache.idleMs)} of ${duration(cache.ttlMs)} TTL`
				: ` - idle ${duration(cache.idleMs)} > ${duration(cache.ttlMs)} TTL`
			: "";
	const state = cache.state === "warm" ? style.success("warm") : style.warning("cold (next request re-reads all)");
	lines.push(`${label("Cache", style)}${state}${style.muted(idle)}${style.dim(` - ${pair}`)}`);
	if (cache.lastMiss) {
		const miss = cache.lastMiss;
		const cost = miss.missedCost > 0 ? ` (+${usd(miss.missedCost)})` : "";
		lines.push(
			`${label("", style)}${style.muted(`last miss: turn ${miss.turn}, ${tokens(miss.missedTokens)} tokens re-read${cost}`)}${cache.misses > 1 ? style.dim(` - ${cache.misses} misses`) : ""}`,
		);
		lines.push(
			`${label("", style)}${style.muted("cause: ")}${style.warning(miss.reason)}${miss.detail ? style.dim(` (${miss.detail})`) : ""}`,
		);
	} else {
		lines.push(`${label("", style)}${style.dim("no cache misses this session")}`);
	}
	return lines;
}

// ---------------------------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------------------------

export function modelLines(report: SessionUsageReport, width: number, style: UsageStyle = PLAIN_STYLE): string[] {
	const nameWidth = Math.max(18, Math.min(40, width - 51));
	const header = `${padEnd("Model - thinking", nameWidth)}${padStart("Turns", 6)}${padStart("Req", 6)}${padStart("Prompt", 9)}${padStart("Cache", 7)}${padStart("Output", 8)}${padStart("$", 11)}  `;
	const lines = [style.dim(header)];
	if (report.models.length === 0) {
		lines.push(style.dim("No billed requests yet."));
		return lines;
	}
	const total = report.models.reduce((sum, row) => sum + row.cost, 0);
	for (const row of report.models) {
		const decision = row.categories.includes("classifier") || row.categories.includes("judge");
		const name = padEnd(displayModelKey(row.label), nameWidth);
		lines.push(
			`${decision ? style.muted(name) : style.strong(name)}${padStart(String(row.turns), 6)}${padStart(String(row.requests), 6)}${padStart(tokens(row.input + row.cached), 9)}${padStart(percent(row.hitPct), 7)}${padStart(tokens(row.output), 8)}${style.accent(padStart(usd(row.cost), 11))}${row.estimated ? style.warning(" est") : ""}`,
		);
	}
	lines.push(style.dim("─".repeat(Math.min(width, nameWidth + 47))));
	lines.push(
		`${padEnd("Total", nameWidth)}${padStart("", 12)}${padStart(tokens(report.overview.input + report.overview.cached), 9)}${padStart(percent(report.overview.hitPct), 7)}${padStart(tokens(report.overview.output), 8)}${style.accent(style.strong(padStart(usd(total), 11)))}`,
	);
	lines.push("");
	lines.push(style.dim("Prompt = uncached + cached input tokens. Cache = cached / prompt."));
	lines.push(style.dim("Decision models (classifier, judge): input only, no cache, not in the Total %."));
	return lines;
}

// ---------------------------------------------------------------------------------------------
// Turns
// ---------------------------------------------------------------------------------------------

/** Two lines per turn, newest first: the numbers, then the request and the router's pick. */
export function turnLines(
	report: SessionUsageReport,
	width: number,
	style: UsageStyle = PLAIN_STYLE,
	options: { selected?: number; limit?: number } = {},
): string[] {
	const turns = [...report.turns].reverse().slice(0, options.limit ?? report.turns.length);
	if (turns.length === 0) return [style.dim("No turns yet.")];
	const lines: string[] = [];
	for (const [index, turn] of turns.entries()) {
		lines.push(...turnRow(turn, width, style, index === options.selected));
	}
	return lines;
}

function turnRow(turn: TurnUsageRow, width: number, style: UsageStyle, selected: boolean): string[] {
	const pointer = selected ? style.accent("▸ ") : "  ";
	const pair = turn.model ? `${turn.model}${turn.thinking ? ` - ${turn.thinking}` : ""}` : "no request";
	const extras = [
		turn.subagentCost > 0 ? `sub ${usd(turn.subagentCost)}` : undefined,
		turn.decisionCost > 0 ? `dec ${usd(turn.decisionCost)}` : undefined,
		turn.choreCost > 0 ? `chore ${usd(turn.choreCost)}` : undefined,
	].filter(Boolean);
	const right = `${padStart(usd(turn.cost), 9)}${padStart(percent(turn.hitPct), 5)}${padStart(`${turn.requests} req`, 7)}${padStart(turn.durationMs > 0 ? duration(turn.durationMs) : "", 8)}`;
	const leftWidth = Math.max(10, width - 2 - [...right].length - 1);
	const left = padEnd(`#${turn.turn} ${clock(turn.ts)}  ${pair}`, leftWidth);
	const first = `${pointer}${selected ? style.accent(style.strong(left)) : style.strong(left)} ${style.accent(right.slice(0, 9))}${style.muted(right.slice(9))}`;
	const why = [
		turn.route,
		turn.cause,
		turn.switches > 0 ? `${turn.switches} switch${turn.switches > 1 ? "es" : ""}` : undefined,
		...extras,
	]
		.filter(Boolean)
		.join(" - ");
	const prompt = turn.prompt ? `“${turn.prompt}”` : "";
	const budget = width - 6;
	const whyText = cut(why, Math.max(12, Math.floor(budget / 2)));
	const promptText = cut(prompt, Math.max(0, budget - [...whyText].length - 3));
	const second = `    ${style.muted(promptText)}${promptText ? style.dim(" ← ") : ""}${style.dim(whyText)}`;
	return [first, second];
}

// ---------------------------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------------------------

const PART_NAMES = ["System prompt", "Tools", "Messages", "Tool results"] as const;
const PART_CHARS = ["█", "▓", "▒", "░"] as const;

export function contextLines(
	context: ContextBreakdown | undefined,
	width: number,
	style: UsageStyle = PLAIN_STYLE,
): string[] {
	if (!context) return [style.dim("No model selected, so there is no context window to show.")];
	const lines: string[] = [];
	const used = context.tokens;
	const window = context.contextWindow;
	const usedText =
		used === null
			? "unknown until the next reply (after a compaction)"
			: `${tokens(used)} of ${tokens(window)} tokens (${((used / window) * 100).toFixed(1)}%)`;
	lines.push(
		`${label("Context", style)}${style.accent(style.strong(usedText))}${context.model ? style.dim(`  ${context.model}`) : ""}`,
	);
	const parts = context.parts;
	const values = [parts.systemPrompt, parts.tools, parts.messages, parts.toolResults];
	const sum = values.reduce((a, b) => a + b, 0);
	const barWidth = Math.max(20, Math.min(64, width - 4));
	// The bar is the whole window; a part that is used gets at least one cell.
	let cells = values.map((value) =>
		window > 0 && value > 0 ? Math.max(1, Math.round((value / window) * barWidth)) : 0,
	);
	const usedCells = cells.reduce((a, b) => a + b, 0);
	if (usedCells > barWidth) cells = cells.map((cell) => Math.floor((cell * barWidth) / usedCells));
	const compactCell =
		context.compactAt && window > 0
			? Math.min(barWidth - 1, Math.round((context.compactAt / window) * barWidth))
			: undefined;
	let bar = "";
	let position = 0;
	for (const [index, count] of cells.entries()) {
		bar += style.part(index, PART_CHARS[index]!.repeat(count));
		position += count;
	}
	const free = Math.max(0, barWidth - position);
	if (compactCell !== undefined && compactCell >= position) {
		bar +=
			style.dim(".".repeat(compactCell - position)) +
			style.warning("|") +
			style.dim(".".repeat(Math.max(0, free - (compactCell - position) - 1)));
	} else {
		bar += style.dim(".".repeat(free));
	}
	lines.push(`  ${bar}`);
	lines.push("");
	for (const [index, name] of PART_NAMES.entries()) {
		const value = values[index]!;
		lines.push(
			`  ${style.part(index, PART_CHARS[index]!.repeat(2))} ${padEnd(name, 15)}${padStart(tokens(value), 8)}${style.muted(padStart(sum > 0 ? percent((value / sum) * 100) : "–", 6))}`,
		);
	}
	if (used !== null) {
		lines.push(`  ${style.dim("..")} ${padEnd("Free", 15)}${padStart(tokens(Math.max(0, window - used)), 8)}`);
	}
	lines.push("");
	if (!context.autoCompact) {
		lines.push(`${label("Compact", style)}${style.dim("auto-compaction is off (/compact runs it by hand)")}`);
	} else if (context.compactAt !== undefined) {
		const left = used === null ? undefined : context.compactAt - used;
		lines.push(
			`${label("Compact", style)}auto at ${tokens(context.compactAt)}${
				left === undefined
					? ""
					: left > 0
						? style.muted(` - ${tokens(left)} to go (${((left / context.compactAt) * 100).toFixed(0)}% headroom)`)
						: style.warning(" - compacts before the next request")
			}${style.dim("  (marked | on the bar)")}`,
		);
	}
	if (context.estimated) {
		lines.push(style.dim("Parts are chars/4 estimates scaled to the last reported prompt size."));
	}
	return lines;
}

// ---------------------------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------------------------

export const RANGE_LABELS: Record<UsageRange, string> = {
	today: "Today",
	week: "Last 7 days",
	month: "Last 30 days",
	all: "All time",
};

function shortDay(day: string): string {
	const [, month, date] = day.split("-");
	const names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
	return `${names[Number(month) - 1] ?? month} ${Number(date)}`;
}

export function historyLines(
	summary: LedgerSummary | undefined,
	range: UsageRange,
	width: number,
	style: UsageStyle = PLAIN_STYLE,
	options: { ledgerPath?: string; rangeHint?: string } = {},
): string[] {
	const lines: string[] = [];
	const tabs = (["today", "week", "month", "all"] as const)
		.map((name) =>
			name === range ? style.accent(style.strong(`[${RANGE_LABELS[name]}]`)) : style.muted(RANGE_LABELS[name]),
		)
		.join("  ");
	lines.push(`${tabs}${options.rangeHint ? style.dim(`   ${options.rangeHint}`) : ""}`);
	if (!summary || summary.requests === 0) {
		lines.push("");
		lines.push(style.dim("No usage recorded in this range."));
		if (options.ledgerPath) {
			lines.push(style.dim(`Ledger: ${options.ledgerPath}`));
			lines.push(style.dim("runkiln usage --rebuild fills it from saved sessions."));
		}
		return lines;
	}
	lines.push("");
	const est = summary.estimatedCost > 0 ? style.warning(` (${usd(summary.estimatedCost)} est.)`) : "";
	lines.push(
		`${label("Total", style)}${style.accent(style.strong(usd(summary.cost)))}${est}${style.muted(` - ${summary.sessions} session${summary.sessions === 1 ? "" : "s"}`)}`,
	);
	lines.push(
		`${label("Volume", style)}${style.muted(`${summary.requests} requests - ${tokens(summary.tokens)} tokens${summary.hitPct !== undefined ? ` - ${percent(summary.hitPct)} cached` : ""}`)}`,
	);
	const days = summary.days.slice(-Math.max(7, width - 50));
	const max = Math.max(...days.map((day) => day.cost));
	if (days.length > 1) {
		lines.push(
			`${label("$ / day", style)}${style.bar(sparkline(days.map((day) => day.cost)))}${style.dim(`  ${shortDay(days[0]!.day)} → ${shortDay(days[days.length - 1]!.day)} - peak ${usd(max)}`)}`,
		);
	}
	lines.push("");
	lines.push(`${heading("By day", style)}${style.dim(`  ${summary.timeZone}`)}`);
	const nameWidth = Math.max(16, Math.min(36, width - 44));
	lines.push(
		style.dim(`  ${padEnd("Day", 12)}${padStart("$", 10)}${padStart("Req", 7)}  ${padEnd("Top model", nameWidth)}`),
	);
	const activeDays = summary.days.filter((day) => day.requests > 0).reverse();
	for (const day of activeDays.slice(0, 31)) {
		const top = summary.dayModels.filter((entry) => entry.day === day.day).sort((a, b) => b.cost - a.cost)[0];
		const bar = meter(max > 0 ? day.cost / max : 0, 8, style);
		lines.push(
			`  ${padEnd(day.day, 12)}${style.accent(padStart(usd(day.cost), 10))}${style.muted(padStart(String(day.requests), 7))}  ${padEnd(displayModelKey(top?.model ?? ""), nameWidth)} ${bar}`,
		);
	}
	lines.push("");
	lines.push(heading("By model", style));
	for (const model of summary.models.slice(0, 12)) {
		const hit =
			model.input + model.cached > 0 && model.cached > 0
				? percent((model.cached / (model.input + model.cached)) * 100)
				: "–";
		lines.push(
			`  ${padEnd(displayModelKey(model.key), nameWidth + 12)}${style.accent(padStart(usd(model.cost), 10))}${style.muted(padStart(`${model.requests} req`, 9))}${style.muted(padStart(hit, 6))}${model.estimated ? style.warning(" est") : ""}`,
		);
	}
	lines.push("");
	lines.push(heading("By category", style));
	for (const category of summary.categories) {
		lines.push(
			`  ${padEnd(category.key, nameWidth + 12)}${style.accent(padStart(usd(category.cost), 10))}${style.muted(padStart(`${category.requests} req`, 9))}`,
		);
	}
	return lines;
}

// ---------------------------------------------------------------------------------------------
// Plain text (print mode, CLI) and JSON
// ---------------------------------------------------------------------------------------------

export interface UsageTextInput {
	report: SessionUsageReport;
	context?: ContextBreakdown;
	budgets?: readonly BudgetStatus[];
	history?: { range: UsageRange; summary: LedgerSummary; ledgerPath?: string };
	/** Turns shown in the Turns section (newest first). Default 10. */
	turns?: number;
}

/** Every tab as plain text, one section after another. */
export function usageText(input: UsageTextInput, width = 80): string {
	const sections: string[] = [];
	const add = (title: string, lines: string[]) =>
		sections.push([`== ${title} ==`, ...lines.map((line) => cut(line, width))].join("\n"));
	add("Overview", overviewLines(input.report, width, PLAIN_STYLE, { budgets: input.budgets }));
	add("Models", modelLines(input.report, width));
	add(
		`Turns (last ${Math.min(input.turns ?? 10, input.report.turns.length)})`,
		turnLines(input.report, width, PLAIN_STYLE, { limit: input.turns ?? 10 }),
	);
	if (input.context) add("Context", contextLines(input.context, width));
	if (input.history)
		add(
			"History",
			historyLines(input.history.summary, input.history.range, width, PLAIN_STYLE, {
				ledgerPath: input.history.ledgerPath,
			}),
		);
	return `${sections.join("\n\n")}\n`;
}

/** `/usage <arg>`: a tab name (or its number), or a History range. Unknown words are ignored. */
export function parseUsageArgument(arg: string): { tab?: UsageTab; range?: UsageRange } {
	const word = arg.trim().toLowerCase().split(/\s+/)[0] ?? "";
	if (!word) return {};
	if ((["today", "week", "month", "all"] as const).includes(word as UsageRange))
		return { tab: "history", range: word as UsageRange };
	if (/^[1-5]$/.test(word)) return { tab: USAGE_TABS[Number(word) - 1] };
	const tab = USAGE_TABS.find((name) => name.startsWith(word));
	return tab ? { tab } : {};
}
