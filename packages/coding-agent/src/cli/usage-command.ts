/**
 * `runkiln usage [today|week|month|all] [--since 7d] [--json] [--rebuild]`: spend across saved sessions from the
 * usage ledger (`~/.runkiln/agent/usage.jsonl`), by day, model and category, with a $/day sparkline. `--rebuild`
 * rewrites the ledger from the session files first (sessions saved before the ledger existed).
 */

import { getSessionsDir } from "../config.ts";
import {
	getUsageLedgerPath,
	type LedgerSummary,
	parseSince,
	RANGE_START_NAMES,
	rangeStart,
	readLedger,
	rebuildLedger,
	summarizeLedger,
	type UsageRange,
} from "../core/usage/ledger.ts";
import { utcOffsetString, zonedClock, zonedDay, zonedIso } from "../core/usage/time.ts";
import { historyLines, RANGE_LABELS } from "../core/usage/views.ts";

export interface UsageCommandArgs {
	range: UsageRange;
	since?: string;
	json: boolean;
	rebuild: boolean;
	help: boolean;
}

/** `runkiln usage ...` parsed, or undefined when the arguments are not a usage command (then they are a prompt). */
export function parseUsageCommand(args: readonly string[]): UsageCommandArgs | { error: string } | undefined {
	const [first, ...rest] = args;
	if (first !== "usage") return undefined;
	const parsed: UsageCommandArgs = { range: "week", json: false, rebuild: false, help: false };
	let rangeGiven = false;
	for (let index = 0; index < rest.length; index++) {
		const arg = rest[index]!;
		if (arg === "--json") parsed.json = true;
		else if (arg === "--rebuild") parsed.rebuild = true;
		else if (arg === "--help" || arg === "-h") parsed.help = true;
		else if (arg === "--since") {
			const value = rest[index + 1];
			if (!value) return { error: "--since needs a value, for example --since 7d" };
			parsed.since = value;
			index++;
		} else if (arg.startsWith("--since=")) parsed.since = arg.slice("--since=".length);
		else if ((RANGE_START_NAMES as readonly string[]).includes(arg) && !rangeGiven) {
			parsed.range = arg as UsageRange;
			rangeGiven = true;
		} else return undefined;
	}
	return parsed;
}

export const USAGE_COMMAND_HELP = `Usage: runkiln usage [today|week|month|all] [--since <7d|24h|2w|YYYY-MM-DD>] [--json] [--rebuild]

Spend across saved sessions (from ~/.runkiln/agent/usage.jsonl): total, $/day, by day, model and category.
  today|week|month|all  Range (default: week = the last 7 days)
  --since <when>        Start instead of the range: 7d, 24h, 2w, 30m or a date
  --json                Print the totals as JSON
  --rebuild             Rewrite the ledger from the saved session files first
Inside a session: /usage (tabs: Overview, Models, Turns, Context, History).`;

export interface UsageCommandIo {
	agentDir: string;
	sessionsDir?: string;
	now?: number;
	stdout: (text: string) => void;
	stderr: (text: string) => void;
	columns?: number;
}

export function usageSummaryJson(summary: LedgerSummary, range: UsageRange | "since"): unknown {
	return {
		range,
		// Local wall-clock times with the zone's offset (e.g. 2026-10-17T00:30:00.000+02:00), not UTC "Z" times.
		since: summary.since > 0 ? zonedIso(summary.since, summary.timeZone) : null,
		until: zonedIso(summary.until, summary.timeZone),
		timeZone: summary.timeZone,
		utcOffset: utcOffsetString(summary.until, summary.timeZone),
		costUsd: summary.cost,
		estimatedCostUsd: summary.estimatedCost,
		requests: summary.requests,
		tokens: summary.tokens,
		cacheHitPct: summary.hitPct ?? null,
		sessions: summary.sessions,
		days: summary.days,
		models: summary.models,
		categories: summary.categories,
		dayModels: summary.dayModels,
	};
}

export function runUsageCommand(args: UsageCommandArgs, io: UsageCommandIo): number {
	if (args.help) {
		io.stdout(`${USAGE_COMMAND_HELP}\n`);
		return 0;
	}
	const now = io.now ?? Date.now();
	const path = getUsageLedgerPath(io.agentDir);
	if (args.rebuild) {
		const result = rebuildLedger(path, io.sessionsDir ?? getSessionsDir());
		io.stderr(`Rebuilt ${path}: ${result.rows} rows from ${result.sessions} sessions.\n`);
	}
	let since = rangeStart(args.range, now);
	if (args.since) {
		const parsed = parseSince(args.since, now);
		if (parsed === undefined) {
			io.stderr(`Could not read --since ${args.since} (try 7d, 24h, 2w or 2026-10-01).\n`);
			return 1;
		}
		since = parsed;
	}
	const summary = summarizeLedger(readLedger(path), { since, now });
	if (args.json) {
		io.stdout(`${JSON.stringify(usageSummaryJson(summary, args.since ? "since" : args.range), null, 2)}\n`);
		return 0;
	}
	const width = Math.max(80, Math.min(120, io.columns ?? 100));
	const title = args.since ? `Since ${zonedDay(since)} ${zonedClock(since)}` : RANGE_LABELS[args.range];
	const lines = historyLines(summary, args.since ? "all" : args.range, width, undefined, { ledgerPath: path });
	// The range row is for the TUI; the CLI names its range in the title.
	io.stdout(`RunKiln usage - ${title}\n${lines.slice(1).join("\n")}\n`);
	return 0;
}
