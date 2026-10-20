import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Usage } from "@runkiln/ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { runUsageCommand } from "../../src/cli/usage-command.ts";
import type { SessionEntry } from "../../src/core/session-manager.ts";
import { decisionSpendToUsage } from "../../src/core/usage/decision-spend.ts";
import { type LedgerRow, localDay, parseSince, rangeStart, summarizeLedger } from "../../src/core/usage/ledger.ts";
import { buildSessionUsageReport } from "../../src/core/usage/session-usage.ts";
import {
	addDays,
	resolveTimeZone,
	startOfZonedDay,
	utcOffsetString,
	zonedClock,
	zonedDay,
	zonedIso,
	zoneOffsetMs,
} from "../../src/core/usage/time.ts";
import { historyLines, overviewLines, turnLines } from "../../src/core/usage/views.ts";

const HOUR = 3_600_000;
/** 2026-10-16 22:30 UTC = 2026-10-17 00:30 in Paris (CEST) = 2026-10-16 15:30 in Los Angeles (PDT). */
const LATE = Date.UTC(2026, 9, 16, 22, 30);

function usage(input: number, cacheRead: number, output: number): Usage {
	const cost = { input: input * 1e-7, output: output * 4e-7, cacheRead: cacheRead * 3e-8, cacheWrite: 0, total: 0 };
	cost.total = cost.input + cost.output + cost.cacheRead;
	return { input, output, cacheRead, cacheWrite: 0, totalTokens: input + output + cacheRead, cost };
}

let nextId = 0;
function entry<T extends object>(at: number, body: T): SessionEntry {
	nextId++;
	return {
		id: `t${nextId}`,
		parentId: null,
		timestamp: new Date(at).toISOString(),
		...body,
	} as unknown as SessionEntry;
}
const user = (at: number, text: string) =>
	entry(at, { type: "message", message: { role: "user", content: text, timestamp: at } });
function assistant(at: number, u: Usage, durationMs: number | null = 2000): SessionEntry {
	return entry(at, {
		type: "message",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			api: "openai-completions",
			provider: "runinfra",
			model: "glm-5-3-flash",
			thinkingLevel: "low",
			usage: u,
			stopReason: "stop",
			timestamp: at,
			...(durationMs !== null ? { durationMs } : {}),
		},
	});
}
const decision = (at: number, kind: "classifier" | "judge", inputTokens: number) =>
	entry(at, {
		type: "usage",
		kind,
		provider: kind === "classifier" ? "jev" : "openrouter",
		model: kind === "classifier" ? "jev-latest" : "typesafe/jev-1.14",
		usage: decisionSpendToUsage({
			backend: kind === "classifier" ? "jev" : "openrouter",
			model: kind === "classifier" ? "jev-latest" : "typesafe/jev-1.14",
			inputTokens,
			outputTokens: 50,
			cost: inputTokens * 4e-8,
			estimated: kind === "classifier",
		}),
	});

function row(ts: number, cost: number): LedgerRow {
	return {
		v: 1,
		ts: new Date(ts).toISOString(),
		sid: "s1",
		id: `id-${ts}`,
		cat: "main",
		kind: "turn",
		provider: "runinfra",
		model: "glm-5-3-flash",
		thinking: "low",
		in: 100,
		cached: 900,
		out: 50,
		cost,
	};
}

const savedTz = process.env.TZ;
afterEach(() => {
	if (savedTz === undefined) delete process.env.TZ;
	else process.env.TZ = savedTz;
});

describe("usage time zone", () => {
	it("reads the zone from TZ, then Intl, then UTC", () => {
		expect(resolveTimeZone({ TZ: "Europe/Paris" })).toBe("Europe/Paris");
		expect(resolveTimeZone({ TZ: ":America/Los_Angeles" })).toBe("America/Los_Angeles");
		const intl = new Intl.DateTimeFormat().resolvedOptions().timeZone;
		expect(resolveTimeZone({ TZ: "Not/A_Zone" })).toBe(intl);
		expect(resolveTimeZone({})).toBe(intl);
	});

	it("formats days and clocks in the given zone, not UTC", () => {
		expect(zonedDay(LATE, "UTC")).toBe("2026-10-16");
		expect(zonedClock(LATE, "UTC")).toBe("22:30");
		expect(zonedDay(LATE, "Europe/Paris")).toBe("2026-10-17");
		expect(zonedClock(LATE, "Europe/Paris")).toBe("00:30");
		expect(zonedDay(LATE, "America/Los_Angeles")).toBe("2026-10-16");
		expect(zonedClock(LATE, "America/Los_Angeles")).toBe("15:30");
		expect(zoneOffsetMs(LATE, "Europe/Paris")).toBe(2 * HOUR);
		expect(localDay(LATE, "Asia/Tokyo")).toBe("2026-10-17");
		expect(addDays("2026-02-28", 1)).toBe("2026-03-01");
		expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
	});

	it("finds local midnight across the DST change (Paris, 25 Oct 2026)", () => {
		expect(startOfZonedDay(LATE, "Europe/Paris")).toBe(Date.UTC(2026, 9, 16, 22));
		const changeDay = Date.UTC(2026, 9, 25, 12);
		expect(startOfZonedDay(changeDay, "Europe/Paris")).toBe(Date.UTC(2026, 9, 24, 22)); // still CEST at 00:00
		expect(startOfZonedDay(changeDay + 24 * HOUR, "Europe/Paris")).toBe(Date.UTC(2026, 9, 25, 23)); // CET
		// "Last 7 days" starts at local midnight six calendar days back, whatever the offset was then.
		const now = Date.UTC(2026, 9, 27, 9);
		expect(rangeStart("week", now, "Europe/Paris")).toBe(Date.UTC(2026, 9, 20, 22));
		expect(rangeStart("today", LATE, "Europe/Paris")).toBe(Date.UTC(2026, 9, 16, 22));
		expect(rangeStart("today", LATE, "UTC")).toBe(Date.UTC(2026, 9, 16));
		expect(parseSince("2026-10-01", now, "Europe/Paris")).toBe(Date.UTC(2026, 8, 30, 22));
	});

	it("groups History days in the user's zone and labels it", () => {
		const rows = [row(LATE, 0.01), row(LATE - 3 * HOUR, 0.02)];
		const paris = summarizeLedger(rows, { now: LATE + HOUR, since: 0, timeZone: "Europe/Paris" });
		expect(paris.timeZone).toBe("Europe/Paris");
		expect(paris.days.map((d) => [d.day, d.cost])).toEqual([
			["2026-10-16", 0.02],
			["2026-10-17", 0.01],
		]);
		const utc = summarizeLedger(rows, { now: LATE + HOUR, since: 0, timeZone: "UTC" });
		expect(utc.days.map((d) => d.day)).toEqual(["2026-10-16"]);
		// Day axis stays contiguous over the DST change.
		const across = summarizeLedger([row(Date.UTC(2026, 9, 24, 10), 0.01), row(Date.UTC(2026, 9, 27, 10), 0.01)], {
			now: Date.UTC(2026, 9, 27, 12),
			timeZone: "Europe/Paris",
		});
		expect(across.days.map((d) => d.day)).toEqual(["2026-10-24", "2026-10-25", "2026-10-26", "2026-10-27"]);
		process.env.TZ = "Europe/Paris";
		const lines = historyLines(summarizeLedger(rows, { now: LATE + HOUR }), "all", 98);
		expect(lines.find((line) => line.startsWith("By day"))).toContain("Europe/Paris");
		expect(lines.some((line) => line.includes("2026-10-17"))).toBe(true);
	});

	it("shows turn times on the user's clock", () => {
		const entries = [user(LATE, "late night"), assistant(LATE + 500, usage(1000, 0, 10))];
		process.env.TZ = "Europe/Paris";
		const report = buildSessionUsageReport(entries, { now: LATE + 5000 });
		expect(turnLines(report, 98).join("\n")).toContain("#1 00:30");
		process.env.TZ = "America/Los_Angeles";
		expect(turnLines(report, 98).join("\n")).toContain("#1 15:30");
	});
});

describe("usage overview consistency", () => {
	it("keeps the router/judge input out of the token line the cache % is taken over", () => {
		const t = LATE;
		const entries = [
			user(t, "go"),
			decision(t + 100, "classifier", 2400),
			assistant(t + 200, usage(1000, 9000, 100)),
			decision(t + 3000, "judge", 1300),
		];
		const report = buildSessionUsageReport(entries, { now: t + 10_000 });
		const o = report.overview;
		expect(o.decisionInput).toBe(3700);
		expect(o.input).toBe(1000 + 3700);
		expect(o.hitPct).toBeCloseTo(90, 6);
		const lines = overviewLines(report, 78);
		const tokenLine = lines.find((line) => line.startsWith("Tokens"))!;
		expect(tokenLine).toContain("input 1.0k");
		expect(tokenLine).toContain("cached 9.0k");
		expect(lines[lines.indexOf(tokenLine) + 1]).toContain("+ 3.7k router/judge input");
		for (const line of lines) expect([...line].length, line).toBeLessThanOrEqual(78);
	});

	it("measures cache idle time from the last main request only", () => {
		const t = LATE;
		const entries = [
			user(t, "go"),
			assistant(t + 200, usage(1000, 9000, 100), 2000),
			// Decision calls after the main request do not touch the main prompt's cache.
			decision(t + 600_000, "classifier", 2400),
			decision(t + 610_000, "judge", 1300),
		];
		const report = buildSessionUsageReport(entries, { now: t + 700_000 });
		expect(report.cache.idleMs).toBe(700_000 - 2200);
		expect(report.cache.state).toBe("warm");
		expect(buildSessionUsageReport(entries, { now: t + 2200 + 900_001 }).cache.state).toBe("cold");
		// Without durationMs (older sessions), the time the session saved the reply marks the end.
		const reply = assistant(t + 200, usage(10, 0, 1), null);
		const old = [user(t, "go"), { ...reply, timestamp: new Date(t + 5000).toISOString() } as SessionEntry];
		expect(buildSessionUsageReport(old, { now: t + 65_000 }).cache.idleMs).toBe(60_000);
	});
});

describe("usage --json times", () => {
	it("formats local ISO times with the zone offset", () => {
		expect(utcOffsetString(LATE, "Europe/Paris")).toBe("+02:00");
		expect(utcOffsetString(Date.UTC(2026, 11, 1), "Europe/Paris")).toBe("+01:00");
		expect(utcOffsetString(LATE, "America/Los_Angeles")).toBe("-07:00");
		expect(utcOffsetString(LATE, "Asia/Kolkata")).toBe("+05:30");
		expect(utcOffsetString(LATE, "UTC")).toBe("+00:00");
		expect(zonedIso(LATE + 123, "Europe/Paris")).toBe("2026-10-17T00:30:00.123+02:00");
		expect(zonedIso(LATE, "America/Los_Angeles")).toBe("2026-10-16T15:30:00.000-07:00");
		expect(Date.parse(zonedIso(LATE + 123, "Europe/Paris"))).toBe(LATE + 123);
	});

	it("emits since/until on the user's clock with timeZone and utcOffset (TZ=Europe/Paris)", () => {
		process.env.TZ = "Europe/Paris";
		const dir = mkdtempSync(join(tmpdir(), "rk-usage-json-"));
		try {
			writeFileSync(join(dir, "usage.jsonl"), `${JSON.stringify(row(LATE - 600_000, 0.01))}\n`);
			let out = "";
			const io = {
				agentDir: dir,
				now: LATE,
				stdout: (t: string) => {
					out += t;
				},
				stderr: () => {},
			};
			expect(runUsageCommand({ range: "today", json: true, rebuild: false, help: false }, io)).toBe(0);
			const json = JSON.parse(out);
			expect(json.timeZone).toBe("Europe/Paris");
			expect(json.utcOffset).toBe("+02:00");
			expect(json.until).toBe("2026-10-17T00:30:00.000+02:00");
			expect(json.since).toBe("2026-10-17T00:00:00.000+02:00");
			expect(json.since.endsWith("Z")).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
