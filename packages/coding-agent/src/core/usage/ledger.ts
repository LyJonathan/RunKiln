/**
 * The usage ledger, `<agentDir>/usage.jsonl`: one line per billed call of every saved session (main turns,
 * subagents, chores, router classifier, permission judge), appended as the session writes the entry. `/usage
 * today|week|month|all` and `runkiln usage` total it by day, model and category. Session files stay the source of
 * truth: `runkiln usage --rebuild` rewrites the ledger from them.
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { PRIVATE_DIR_MODE, PRIVATE_FILE_MODE } from "../../utils/private-files.ts";
import type { SessionEntry } from "../session-manager.ts";
import {
	CATEGORY_LABELS,
	collectUsageRecords,
	MODEL_KEY_SEPARATOR,
	type UsageCategory,
	type UsagePriceSource,
	type UsageRecord,
} from "./session-usage.ts";

export { displayModelKey, MODEL_KEY_SEPARATOR } from "./session-usage.ts";

import { addDays, resolveTimeZone, startOfZonedDayFromString, zonedDay } from "./time.ts";

export const USAGE_LEDGER_FILE = "usage.jsonl";

export function getUsageLedgerPath(agentDir: string): string {
	return join(agentDir, USAGE_LEDGER_FILE);
}

/** One ledger line. Short keys: the file grows by one line per request. */
export interface LedgerRow {
	v: 1;
	/** ISO time of the call. */
	ts: string;
	/** Session id. */
	sid: string;
	/** Session entry id (dedupe key with sid and model). */
	id: string;
	cwd?: string;
	cat: UsageCategory;
	kind: string;
	provider: string;
	model: string;
	thinking?: string;
	/** Uncached prompt tokens. */
	in: number;
	cached: number;
	out: number;
	reasoning?: number;
	requests?: number;
	cost: number;
	/** Estimated cost (decision model without a billed cost). */
	est?: true;
	/** Server-billed cost. */
	srv?: true;
}

export function ledgerRowFromRecord(record: UsageRecord, sessionId: string, cwd?: string): LedgerRow {
	return {
		v: 1,
		ts: new Date(record.ts).toISOString(),
		sid: sessionId,
		id: record.entryId,
		...(cwd ? { cwd } : {}),
		cat: record.category,
		kind: record.kind,
		provider: record.provider,
		model: record.model,
		...(record.thinking ? { thinking: record.thinking } : {}),
		in: record.input,
		cached: record.cached,
		out: record.output,
		...(record.reasoning ? { reasoning: record.reasoning } : {}),
		...(record.requests > 1 ? { requests: record.requests } : {}),
		cost: record.cost,
		...(record.estimated ? { est: true as const } : {}),
		...(record.server ? { srv: true as const } : {}),
	};
}

/** Ledger rows for one newly appended session entry (none when it bills nothing). */
export function ledgerRowsForEntry(
	entry: SessionEntry,
	sessionId: string,
	cwd: string | undefined,
	prices?: UsagePriceSource,
	thinking?: string,
): LedgerRow[] {
	return collectUsageRecords([entry], prices).map((record) =>
		ledgerRowFromRecord(
			record.thinking || !thinking || record.category !== "main" ? record : { ...record, thinking },
			sessionId,
			cwd,
		),
	);
}

export function appendLedgerRows(path: string, rows: readonly LedgerRow[]): void {
	if (rows.length === 0) return;
	try {
		mkdirSync(dirname(path), { recursive: true, mode: PRIVATE_DIR_MODE });
		appendFileSync(path, rows.map((row) => `${JSON.stringify(row)}\n`).join(""), { mode: PRIVATE_FILE_MODE });
	} catch {
		// Accounting must never break a turn.
	}
}

function isRow(value: unknown): value is LedgerRow {
	if (!value || typeof value !== "object") return false;
	const row = value as Record<string, unknown>;
	return (
		row.v === 1 &&
		typeof row.ts === "string" &&
		typeof row.sid === "string" &&
		typeof row.model === "string" &&
		typeof row.cost === "number" &&
		Number.isFinite(row.cost)
	);
}

/** Every valid row, duplicates (same session, entry and model) dropped. Bad lines are skipped. */
export function readLedger(path: string): LedgerRow[] {
	if (!existsSync(path)) return [];
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		return [];
	}
	return parseLedger(text);
}

export function parseLedger(text: string): LedgerRow[] {
	const rows: LedgerRow[] = [];
	const seen = new Set<string>();
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			continue;
		}
		if (!isRow(parsed)) continue;
		const key = `${parsed.sid}\u0000${parsed.id}\u0000${parsed.model}\u0000${parsed.cat}`;
		if (seen.has(key)) continue;
		seen.add(key);
		rows.push({
			...parsed,
			in: Number(parsed.in) || 0,
			cached: Number(parsed.cached) || 0,
			out: Number(parsed.out) || 0,
		});
	}
	return rows;
}

// ---------------------------------------------------------------------------------------------
// Ranges and totals
// ---------------------------------------------------------------------------------------------

export type UsageRange = "today" | "week" | "month" | "all";
export const USAGE_RANGES: readonly UsageRange[] = ["today", "week", "month", "all"];
/** Range names `runkiln usage` accepts as its first word. */
export const RANGE_START_NAMES = USAGE_RANGES;

/** Calendar day in the user's time zone (`TZ`, else the OS zone), `YYYY-MM-DD`. */
export function localDay(ms: number, timeZone: string = resolveTimeZone()): string {
	return zonedDay(ms, timeZone);
}

/**
 * Start of a range in the user's time zone: today since local midnight, week = the last 7 calendar days, month = the
 * last 30, all = everything.
 */
export function rangeStart(range: UsageRange, now: number = Date.now(), timeZone: string = resolveTimeZone()): number {
	const today = zonedDay(now, timeZone);
	switch (range) {
		case "today":
			return startOfZonedDayFromString(today, timeZone);
		case "week":
			return startOfZonedDayFromString(addDays(today, -6), timeZone);
		case "month":
			return startOfZonedDayFromString(addDays(today, -29), timeZone);
		case "all":
			return 0;
	}
}

const DURATION = /^(\d+(?:\.\d+)?)\s*(m|min|h|d|w)$/i;

/** `--since`: `7d`, `24h`, `2w`, `30m`, a range name, or a date (`2026-10-01`). Undefined when it does not parse. */
export function parseSince(
	value: string,
	now: number = Date.now(),
	timeZone: string = resolveTimeZone(),
): number | undefined {
	const text = value.trim().toLowerCase();
	if ((USAGE_RANGES as readonly string[]).includes(text)) return rangeStart(text as UsageRange, now, timeZone);
	const match = DURATION.exec(text);
	if (match) {
		const amount = Number(match[1]);
		const unit = match[2]!;
		const ms = unit === "w" ? 7 * 86_400_000 : unit === "d" ? 86_400_000 : unit === "h" ? 3_600_000 : 60_000;
		return now - amount * ms;
	}
	if (/^\d{4}-\d{2}-\d{2}/.test(text)) {
		const parsed = /^\d{4}-\d{2}-\d{2}$/.test(text) ? startOfZonedDayFromString(text, timeZone) : Date.parse(text);
		return Number.isFinite(parsed) ? parsed : undefined;
	}
	return undefined;
}

export interface DayTotal {
	day: string;
	cost: number;
	requests: number;
	tokens: number;
}

export interface LedgerGroupTotal {
	key: string;
	cost: number;
	requests: number;
	tokens: number;
	cached: number;
	input: number;
	estimated: boolean;
}

export interface LedgerSummary {
	since: number;
	until: number;
	/** IANA zone the days are bucketed in. */
	timeZone: string;
	cost: number;
	requests: number;
	tokens: number;
	/** cached / prompt over LLM calls. */
	hitPct: number | undefined;
	sessions: number;
	estimatedCost: number;
	/** One entry per local day from `since` (or the first row) to `until`, gaps filled with zeros. */
	days: DayTotal[];
	models: LedgerGroupTotal[];
	categories: LedgerGroupTotal[];
	/** day → model•thinking key (MODEL_KEY_SEPARATOR) → cost. */
	dayModels: Array<{ day: string; model: string; cost: number; requests: number }>;
}

const MAX_DAYS = 120;

export function modelKey(row: Pick<LedgerRow, "model" | "thinking" | "cat">): string {
	if (row.cat === "classifier" || row.cat === "judge")
		return `${row.model} (${row.cat === "judge" ? "judge" : "router"})`;
	return row.thinking ? `${row.model}${MODEL_KEY_SEPARATOR}${row.thinking}` : row.model;
}

function group(map: Map<string, LedgerGroupTotal>, key: string, row: LedgerRow): void {
	let total = map.get(key);
	if (!total) {
		total = { key, cost: 0, requests: 0, tokens: 0, cached: 0, input: 0, estimated: false };
		map.set(key, total);
	}
	total.cost += row.cost;
	total.requests += row.requests ?? 1;
	total.tokens += row.in + row.cached + row.out;
	total.cached += row.cached;
	total.input += row.in;
	total.estimated ||= row.est === true;
}

export function summarizeLedger(
	rows: readonly LedgerRow[],
	options: { since?: number; until?: number; now?: number; timeZone?: string } = {},
): LedgerSummary {
	const now = options.now ?? Date.now();
	const timeZone = options.timeZone ?? resolveTimeZone();
	const since = options.since ?? 0;
	const until = options.until ?? now;
	const selected = rows.filter((row) => {
		const ts = Date.parse(row.ts);
		return ts >= since && ts <= until;
	});
	const models = new Map<string, LedgerGroupTotal>();
	const categories = new Map<string, LedgerGroupTotal>();
	const days = new Map<string, DayTotal>();
	const dayModels = new Map<string, { day: string; model: string; cost: number; requests: number }>();
	const sessions = new Set<string>();
	let cost = 0;
	let requests = 0;
	let tokens = 0;
	let estimatedCost = 0;
	let prompt = 0;
	let cached = 0;
	for (const row of selected) {
		const ts = Date.parse(row.ts);
		const day = localDay(ts, timeZone);
		cost += row.cost;
		requests += row.requests ?? 1;
		tokens += row.in + row.cached + row.out;
		if (row.est) estimatedCost += row.cost;
		if (row.cat !== "classifier" && row.cat !== "judge") {
			prompt += row.in + row.cached;
			cached += row.cached;
		}
		sessions.add(row.sid);
		group(models, modelKey(row), row);
		group(categories, row.cat, row);
		const dayTotal = days.get(day) ?? { day, cost: 0, requests: 0, tokens: 0 };
		dayTotal.cost += row.cost;
		dayTotal.requests += row.requests ?? 1;
		dayTotal.tokens += row.in + row.cached + row.out;
		days.set(day, dayTotal);
		const dm = `${day}\u0000${modelKey(row)}`;
		const dmTotal = dayModels.get(dm) ?? { day, model: modelKey(row), cost: 0, requests: 0 };
		dmTotal.cost += row.cost;
		dmTotal.requests += row.requests ?? 1;
		dayModels.set(dm, dmTotal);
	}
	// Fill the day axis so the chart shows quiet days.
	const firstTs = selected.length > 0 ? Math.min(...selected.map((row) => Date.parse(row.ts))) : until;
	const lastDay = localDay(until, timeZone);
	let cursor = localDay(since > 0 ? since : firstTs, timeZone);
	const earliest = addDays(lastDay, -(MAX_DAYS - 1));
	if (cursor < earliest) cursor = earliest;
	const filled: DayTotal[] = [];
	while (cursor <= lastDay) {
		filled.push(days.get(cursor) ?? { day: cursor, cost: 0, requests: 0, tokens: 0 });
		cursor = addDays(cursor, 1);
	}
	const sortTotals = (map: Map<string, LedgerGroupTotal>) => [...map.values()].sort((a, b) => b.cost - a.cost);
	return {
		since,
		until,
		timeZone,
		cost,
		requests,
		tokens,
		hitPct: prompt > 0 && cached > 0 ? (cached / prompt) * 100 : undefined,
		sessions: sessions.size,
		estimatedCost,
		days: filled,
		models: sortTotals(models),
		categories: sortTotals(categories).map((total) => ({
			...total,
			key: CATEGORY_LABELS[total.key as UsageCategory] ?? total.key,
		})),
		dayModels: [...dayModels.values()].sort((a, b) => a.day.localeCompare(b.day) || b.cost - a.cost),
	};
}

/** Today's spend in the ledger (local day). */
export function ledgerCostSince(rows: readonly LedgerRow[], since: number): number {
	let cost = 0;
	for (const row of rows) if (Date.parse(row.ts) >= since) cost += row.cost;
	return cost;
}

const BARS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

/** A one-line bar chart: `▁▃█` scaled to the largest value; a zero is `.`. */
export function sparkline(values: readonly number[]): string {
	const max = Math.max(0, ...values);
	return values
		.map((value) => {
			if (value <= 0 || max <= 0) return ".";
			const index = Math.min(BARS.length - 1, Math.max(0, Math.ceil((value / max) * BARS.length) - 1));
			return BARS[index]!;
		})
		.join("");
}

// ---------------------------------------------------------------------------------------------
// Rebuild from session files
// ---------------------------------------------------------------------------------------------

function sessionFiles(dir: string): string[] {
	const files: string[] = [];
	if (!existsSync(dir)) return files;
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) files.push(...sessionFiles(path));
		else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(path);
	}
	return files;
}

/** Ledger rows of one session file (header line first). */
export function ledgerRowsFromSessionText(text: string, prices?: UsagePriceSource): LedgerRow[] {
	const lines = text.split("\n").filter((line) => line.trim());
	let sessionId: string | undefined;
	let cwd: string | undefined;
	const entries: SessionEntry[] = [];
	for (const line of lines) {
		let parsed: Record<string, unknown>;
		try {
			parsed = JSON.parse(line) as Record<string, unknown>;
		} catch {
			continue;
		}
		if (parsed.type === "session") {
			sessionId = typeof parsed.id === "string" ? parsed.id : undefined;
			cwd = typeof parsed.cwd === "string" ? parsed.cwd : undefined;
			continue;
		}
		if (typeof parsed.type === "string" && typeof parsed.id === "string" && typeof parsed.timestamp === "string") {
			entries.push(parsed as unknown as SessionEntry);
		}
	}
	if (!sessionId) return [];
	return collectUsageRecords(entries, prices).map((record) => ledgerRowFromRecord(record, sessionId!, cwd));
}

/** Rewrite the ledger from every session file under `sessionsDir`. Returns the rows written and files read. */
export function rebuildLedger(
	path: string,
	sessionsDir: string,
	prices?: UsagePriceSource,
): { rows: number; sessions: number } {
	const rows: LedgerRow[] = [];
	let sessions = 0;
	for (const file of sessionFiles(sessionsDir)) {
		try {
			const fileRows = ledgerRowsFromSessionText(readFileSync(file, "utf8"), prices);
			if (fileRows.length > 0) sessions++;
			rows.push(...fileRows);
		} catch {
			// An unreadable session file is skipped.
		}
	}
	rows.sort((a, b) => a.ts.localeCompare(b.ts));
	mkdirSync(dirname(path), { recursive: true, mode: PRIVATE_DIR_MODE });
	const tmp = `${path}.tmp-${process.pid}`;
	writeFileSync(tmp, rows.map((row) => `${JSON.stringify(row)}\n`).join(""), { mode: PRIVATE_FILE_MODE });
	renameSync(tmp, path);
	return { rows: rows.length, sessions };
}

/** Appends a session's rows and keeps today's total without re-reading the file on every prompt. */
export class UsageLedgerWriter {
	readonly path: string;
	private day: string | undefined;
	private today = 0;

	constructor(path: string) {
		this.path = path;
	}

	append(rows: readonly LedgerRow[]): void {
		if (rows.length === 0) return;
		appendLedgerRows(this.path, rows);
		if (this.day === undefined) return;
		for (const row of rows) if (localDay(Date.parse(row.ts)) === this.day) this.today += row.cost;
	}

	/** Spend today (local day) across every session in the ledger. */
	costToday(now: number = Date.now()): number {
		const day = localDay(now);
		if (this.day !== day) {
			this.day = day;
			this.today = ledgerCostSince(readLedger(this.path), rangeStart("today", now));
		}
		return this.today;
	}
}
