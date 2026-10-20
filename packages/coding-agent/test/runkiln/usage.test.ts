import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Api,
	type Context,
	type FauxProviderRegistration,
	fauxAssistantMessage,
	type Model,
	registerFauxProvider,
	type SimpleStreamOptions,
	streamSimple,
	type Usage,
} from "@runkiln/ai/compat";
import { visibleWidth } from "@runkiln/tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { parseUsageCommand, runUsageCommand } from "../../src/cli/usage-command.ts";
import type { ModelRuntime } from "../../src/core/model-runtime.ts";
import { JevClassifier, OpenRouterClassifier } from "../../src/core/router/classifiers.ts";
import { createAutoModels } from "../../src/core/router/index.ts";
import { ModelRouter } from "../../src/core/router/router.ts";
import { JevPermissionJudge, OpenRouterPermissionJudge } from "../../src/core/runkiln/permission-judge.ts";
import { PermissionGate } from "../../src/core/runkiln/permissions.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import type { SessionEntry } from "../../src/core/session-manager.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { evaluateBudgets, newlyCrossed, tightestBudget } from "../../src/core/usage/budget.ts";
import {
	decisionSpendFromResponse,
	decisionSpendToUsage,
	JEV_PRICE_PER_M_INPUT,
} from "../../src/core/usage/decision-spend.ts";
import {
	type LedgerRow,
	ledgerRowsFromSessionText,
	localDay,
	parseLedger,
	parseSince,
	rangeStart,
	readLedger,
	rebuildLedger,
	sparkline,
	summarizeLedger,
	UsageLedgerWriter,
} from "../../src/core/usage/ledger.ts";
import {
	buildSessionUsageReport,
	collectUsageRecords,
	ROUTE_ENTRY_TYPE,
	type UsagePriceSource,
} from "../../src/core/usage/session-usage.ts";
import {
	contextLines,
	historyLines,
	modelLines,
	overviewLines,
	parseUsageArgument,
	turnLines,
	usageText,
	usd,
} from "../../src/core/usage/views.ts";
import { FooterComponent, formatCostMeter } from "../../src/modes/interactive/components/footer.ts";
import { UsageScreen } from "../../src/modes/interactive/components/usage-screen.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";
import { classification, MockClassifier, testCatalog } from "./router-fixtures.ts";

const strip = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, "");

/** glm-5-3-flash and deepseek-v4-1-flash prices from models.yaml, USD per million tokens. */
const PRICES: UsagePriceSource = {
	getModel: (_provider, id) =>
		id === "glm-5-3-flash"
			? { cost: { input: 0.11, output: 0.45, cacheRead: 0.03 }, contextWindow: 1_048_576 }
			: id === "deepseek-v4-1-flash"
				? { cost: { input: 0.14, output: 0.58, cacheRead: 0.03 }, contextWindow: 1_048_576 }
				: undefined,
};

function priced(model: string, input: number, cacheRead: number, output: number, reasoning = 0): Usage {
	const price = PRICES.getModel("runinfra", model)!.cost;
	const cost = {
		input: (input * price.input) / 1e6,
		output: (output * price.output) / 1e6,
		cacheRead: (cacheRead * price.cacheRead) / 1e6,
		cacheWrite: 0,
		total: 0,
	};
	cost.total = cost.input + cost.output + cost.cacheRead;
	return { input, output, cacheRead, cacheWrite: 0, reasoning, totalTokens: input + output + cacheRead, cost };
}

let nextId = 0;
const T0 = Date.parse("2026-10-17T10:00:00Z");

function entry<T extends object>(at: number, body: T): T & { id: string; parentId: null; timestamp: string } {
	nextId++;
	return { id: `e${nextId}`, parentId: null, timestamp: new Date(at).toISOString(), ...body };
}

function user(at: number, text: string): SessionEntry {
	return entry(at, { type: "message", message: { role: "user", content: text, timestamp: at } }) as SessionEntry;
}

function assistant(
	at: number,
	model: string,
	thinking: string,
	usage: Usage,
	extra: { durationMs?: number; ttftMs?: number; stopReason?: string } = {},
): SessionEntry {
	return entry(at, {
		type: "message",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			api: "openai-completions",
			provider: "runinfra",
			model,
			thinkingLevel: thinking,
			usage,
			stopReason: extra.stopReason ?? "stop",
			timestamp: at,
			durationMs: extra.durationMs ?? 2000,
			ttftMs: extra.ttftMs ?? 500,
		},
	}) as SessionEntry;
}

function usageEntry(at: number, kind: string, provider: string, model: string, usage: Usage): SessionEntry {
	return entry(at, { type: "usage", kind, provider, model, usage }) as SessionEntry;
}

function route(at: number, data: Record<string, unknown>): SessionEntry {
	return entry(at, { type: "custom", customType: ROUTE_ENTRY_TYPE, data }) as SessionEntry;
}

/** A scripted five-turn session: routed turns, a subagent task, a title, classifier and judge calls, a compaction. */
function scriptedSession(): SessionEntry[] {
	nextId = 0;
	const classifierUsage = decisionSpendToUsage({
		backend: "jev",
		model: "jev-latest",
		inputTokens: 2400,
		outputTokens: 700,
		cost: (2400 * JEV_PRICE_PER_M_INPUT) / 1e6,
		estimated: true,
	});
	const judgeUsage = decisionSpendToUsage({
		backend: "openrouter",
		model: "typesafe/jev-1.14",
		inputTokens: 1285,
		outputTokens: 169,
		cost: 5.397e-5,
		estimated: false,
	});
	const serverUsage = priced("glm-5-3-flash", 182, 2816, 6, 3);
	serverUsage.cost.total = 0.0001072;
	serverUsage.costSource = "server";
	return [
		user(T0, "explain the parser"),
		usageEntry(T0 + 100, "classifier", "jev", "jev-latest", classifierUsage),
		route(T0 + 200, {
			model: "glm-5-3-flash",
			thinking: "low",
			source: "classifier",
			reason: "explain d10",
			cause: "cheapest_within_band",
		}),
		assistant(T0 + 300, "glm-5-3-flash", "low", priced("glm-5-3-flash", 6000, 0, 400, 100)),
		usageEntry(T0 + 4000, "title", "runinfra", "deepseek-v4-1-flash", priced("deepseek-v4-1-flash", 120, 0, 8)),
		user(T0 + 60_000, "now fix the bug"),
		route(T0 + 60_100, { model: "glm-5-3-flash", thinking: "low", source: "cache", reason: "edit d40 cached" }),
		assistant(T0 + 60_200, "glm-5-3-flash", "low", priced("glm-5-3-flash", 200, 5888, 300)),
		usageEntry(T0 + 61_000, "judge", "openrouter", "typesafe/jev-1.14", judgeUsage),
		assistant(T0 + 62_000, "glm-5-3-flash", "low", serverUsage),
		user(T0 + 120_000, "a hard refactor across files"),
		route(T0 + 120_100, {
			model: "deepseek-v4-1-flash",
			thinking: "high",
			source: "classifier",
			reason: "multi_file d80",
			switched: true,
			from: "glm-5-3-flash",
		}),
		// Model switch: a full miss.
		assistant(T0 + 120_200, "deepseek-v4-1-flash", "high", priced("deepseek-v4-1-flash", 7000, 0, 900, 600)),
		entry(T0 + 125_000, {
			type: "message",
			message: {
				role: "toolResult",
				toolCallId: "t1",
				toolName: "task",
				content: [{ type: "text", text: "done" }],
				isError: false,
				timestamp: T0 + 125_000,
				details: {
					agents: [
						{
							id: "sub-1",
							name: "alpha",
							goal: "a",
							status: "done",
							model: "glm-5-3-flash",
							thinking: "low",
							turns: 2,
							toolCalls: 1,
							toolErrors: 0,
							input: 1000,
							output: 200,
							cacheRead: 3000,
							costUsd: 0.0005,
							decisionCostUsd: 0.0001,
							filesChanged: ["a.txt"],
							failovers: 0,
						},
					],
				},
				usage: {
					input: 1000,
					output: 200,
					cacheRead: 3000,
					cacheWrite: 0,
					totalTokens: 4200,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.0005 },
				},
			},
		}) as SessionEntry,
		entry(T0 + 130_000, {
			type: "compaction",
			summary: "s",
			firstKeptEntryId: "e1",
			tokensBefore: 9000,
			usage: priced("deepseek-v4-1-flash", 500, 8000, 600),
		}) as SessionEntry,
		user(T0 + 180_000, "continue"),
		// After the compaction the prompt changed: a miss blamed on the compaction.
		assistant(T0 + 180_200, "deepseek-v4-1-flash", "high", priced("deepseek-v4-1-flash", 3000, 0, 100)),
		user(T0 + 2_000_000, "and the docs"),
		// Idle 30 min > 15 min TTL: a miss blamed on the idle time.
		assistant(T0 + 2_000_200, "deepseek-v4-1-flash", "high", priced("deepseek-v4-1-flash", 3300, 0, 100)),
	];
}

describe("decision-model spend", () => {
	it("prefers OpenRouter's billed usage.cost and estimates Jev from the input price", () => {
		const billed = decisionSpendFromResponse(
			{ usage: { input_tokens: 1285, output_tokens: 169, cost: 5.397e-5 } },
			"openrouter",
			"typesafe/jev-1.14",
			654,
		);
		expect(billed).toEqual({
			backend: "openrouter",
			model: "typesafe/jev-1.14",
			inputTokens: 1285,
			outputTokens: 169,
			cost: 5.397e-5,
			estimated: false,
			ms: 654,
		});
		const estimated = decisionSpendFromResponse(
			{ model: "jev-1.13.0", usage: { input_tokens: 2403, output_tokens: 707 } },
			"jev",
			"jev-latest",
		);
		expect(estimated?.estimated).toBe(true);
		expect(estimated?.cost).toBeCloseTo((2403 * 0.042) / 1e6, 12);
		expect(decisionSpendFromResponse({ answers: {} }, "jev", "jev-latest")).toBeUndefined();
		expect(decisionSpendToUsage(billed!).costSource).toBe("server");
		expect(decisionSpendToUsage(estimated!).costSource).toBeUndefined();
	});

	it("attaches the spend to classifier answers and judge verdicts", async () => {
		const catalog = testCatalog();
		const answer = {
			answers: {
				skill: { type: "choice", choice: "code.bugfix", confidence: 0.8, probabilities: { "code.bugfix": 0.9 } },
				difficulty: { type: "score", score: 2, confidence: 0.7 },
				needs_tools: { type: "noul", noul: 0.9 },
			},
		};
		const fetchWith = (usage: unknown) =>
			vi.fn(async () => new Response(JSON.stringify({ ...answer, usage }))) as unknown as typeof fetch;
		const common = { apiKey: "k", skills: catalog.skills, skillThreshold: 0.1, maxSecondarySkills: 2 };
		const jev = await new JevClassifier({ ...common, fetch: fetchWith({ input_tokens: 1000 }) }).classify({
			request: "fix it",
			recentContext: "",
			hasImages: false,
			harness: {
				role: "code",
				contextTokens: 0,
				toolErrorsThisTurn: 0,
				testFailuresThisTurn: 0,
				filesTouchedThisTurn: 0,
			},
		});
		expect(jev.spend).toMatchObject({ backend: "jev", estimated: true, inputTokens: 1000 });
		const openrouter = await new OpenRouterClassifier({
			...common,
			fetch: fetchWith({ input_tokens: 1000, cost: 0.00004 }),
		}).classify({
			request: "fix it",
			recentContext: "",
			hasImages: false,
			harness: {
				role: "code",
				contextTokens: 0,
				toolErrorsThisTurn: 0,
				testFailuresThisTurn: 0,
				filesTouchedThisTurn: 0,
			},
		});
		expect(openrouter.spend).toMatchObject({ backend: "openrouter", estimated: false, cost: 0.00004 });

		const verdictBody = {
			answers: { decision: { choice: "allow", confidence: 0.95 }, reason: { choice: "routine project work" } },
			usage: { input_tokens: 900, output_tokens: 20 },
		};
		const judgeFetch = vi.fn(async () => new Response(JSON.stringify(verdictBody))) as unknown as typeof fetch;
		const input = { toolName: "bash", args: { command: "npm test" }, cwd: "/p", summary: "npm test" };
		const verdict = await new JevPermissionJudge({ apiKey: "k", fetch: judgeFetch }).judge(input);
		expect(verdict.spend).toMatchObject({ backend: "jev", estimated: true, inputTokens: 900 });
		const billedFetch = vi.fn(
			async () => new Response(JSON.stringify({ ...verdictBody, usage: { input_tokens: 900, cost: 0.00003 } })),
		) as unknown as typeof fetch;
		const billed = await new OpenRouterPermissionJudge({ apiKey: "k", fetch: billedFetch }).judge(input);
		expect(billed.spend).toMatchObject({ backend: "openrouter", estimated: false, cost: 0.00003 });
	});

	it("reports each billed judge call once to the gate's listener (cached verdicts are free)", async () => {
		const spends: number[] = [];
		const judge = {
			label: "Jev",
			judge: vi.fn(async () => ({
				decision: "allow" as const,
				reason: "routine",
				confidence: 0.99,
				spend: {
					backend: "jev" as const,
					model: "jev",
					inputTokens: 10,
					outputTokens: 0,
					cost: 1e-6,
					estimated: true,
				},
			})),
		};
		const gate = new PermissionGate({
			mode: "auto",
			judgeFactory: () => judge,
			onJudgeSpend: (s) => spends.push(s.cost),
		});
		const args = { command: "make deploy-docs" };
		await gate.decide("bash", args, "/tmp/project");
		await gate.decide("bash", args, "/tmp/project");
		expect(judge.judge.mock.calls.length).toBe(spends.length);
		expect(spends.length).toBeLessThanOrEqual(1);
	});
});

describe("session usage report", () => {
	it("collects every billed call by category, with subagents split by catalog price", () => {
		const records = collectUsageRecords(scriptedSession(), PRICES);
		const byCategory = (category: string) => records.filter((record) => record.category === category);
		expect(byCategory("main")).toHaveLength(6);
		expect(byCategory("classifier")).toHaveLength(1);
		expect(byCategory("judge")).toHaveLength(1);
		expect(byCategory("chore").map((record) => record.kind)).toEqual(["title", "compaction"]);
		const [sub] = byCategory("subagent");
		expect(sub).toMatchObject({ model: "glm-5-3-flash", thinking: "low", requests: 2, cost: 0.0005 });
		expect(sub!.costInput + sub!.costCached + sub!.costOutput).toBeCloseTo(0.0005, 12);
		expect(byCategory("classifier")[0]!.estimated).toBe(true);
		expect(byCategory("judge")[0]!.estimated).toBe(false);
		expect(byCategory("judge")[0]!.server).toBe(true);
	});

	it("builds the overview: totals, cache savings, billing sources, timing", () => {
		const report = buildSessionUsageReport(scriptedSession(), { prices: PRICES, now: T0 + 2_000_000 });
		const o = report.overview;
		const records = collectUsageRecords(scriptedSession(), PRICES);
		expect(o.cost).toBeCloseTo(
			records.reduce((sum, record) => sum + record.cost, 0),
			12,
		);
		expect(o.costInput + o.costCached + o.costOutput).toBeCloseTo(o.cost, 12);
		// Cache savings: cached tokens at (input - cacheRead) price.
		// The compaction record has no model of its own, so its cached tokens are not priced.
		const saved = ((2816 + 5888 + 3000) * (0.11 - 0.03)) / 1e6;
		expect(o.savedByCache).toBeCloseTo(saved, 12);
		expect(o.serverCost).toBeCloseTo(0.0001072 + 5.397e-5, 12);
		expect(o.estimatedCost).toBeCloseTo((2400 * 0.042) / 1e6, 12);
		expect(o.turns).toBe(5);
		expect(o.requests).toBe(6 + 1 + 1 + 2 + 2);
		expect(o.avgTtftMs).toBe(500);
		expect(o.apiMs).toBe(6 * 2000);
		expect(o.wallMs).toBe(2_000_200);
		expect(o.reasoning).toBe(703);
		expect(o.costReasoning).toBeGreaterThan(0);
		expect(o.hitPct).toBeGreaterThan(30);
	});

	it("groups by model•thinking and category, newest turn with the router's pick", () => {
		const report = buildSessionUsageReport(scriptedSession(), { prices: PRICES, now: T0 + 2_000_000 });
		const labels = report.models.map((row) => row.label);
		expect(labels).toContain("glm-5-3-flash•low");
		expect(labels).toContain("deepseek-v4-1-flash•high");
		expect(labels).toContain("jev-latest (router)");
		expect(labels).toContain("typesafe/jev-1.14 (judge)");
		const glm = report.models.find((row) => row.label === "glm-5-3-flash•low")!;
		expect(glm.turns).toBe(3); // turns 1, 2 and the subagent in turn 3
		expect(report.categories.map((row) => row.category)).toEqual([
			"main",
			"subagent",
			"chore",
			"classifier",
			"judge",
		]);
		const [first, second, third] = report.turns;
		expect(first).toMatchObject({
			prompt: "explain the parser",
			route: "classifier - explain d10",
			cause: "cheapest_within_band",
		});
		expect(first!.decisionCost).toBeCloseTo((2400 * 0.042) / 1e6, 12);
		expect(first!.choreCost).toBeGreaterThan(0);
		expect(second).toMatchObject({ route: "cache - edit d40 cached", requests: 2 });
		expect(third).toMatchObject({ model: "deepseek-v4-1-flash", thinking: "high", cause: "from glm-5-3-flash" });
		expect(third!.subagentCost).toBe(0.0005);
		expect(report.turns[4]!.route).toBe("manual");
	});

	it("tells warm from cold and names the last miss", () => {
		const entries = scriptedSession();
		const warm = buildSessionUsageReport(entries, { prices: PRICES, now: T0 + 2_000_200 + 2200 + 60_000 });
		expect(warm.cache.state).toBe("warm");
		expect(warm.cache.misses).toBe(3);
		expect(warm.cache.lastMiss).toMatchObject({ turn: 5, reason: "idle past the TTL" });
		const cold = buildSessionUsageReport(entries, { prices: PRICES, now: T0 + 2_000_200 + 20 * 60_000 });
		expect(cold.cache.state).toBe("cold");
		// The earlier misses: a model switch, then the compaction.
		const upToCompaction = entries.slice(0, entries.findIndex((e) => e.type === "compaction") + 3);
		expect(buildSessionUsageReport(upToCompaction, { prices: PRICES }).cache.lastMiss?.reason).toBe("compaction");
		const upToSwitch = entries.slice(0, 13);
		expect(buildSessionUsageReport(upToSwitch, { prices: PRICES }).cache.lastMiss).toMatchObject({
			reason: "model switch",
			detail: "glm-5-3-flash → deepseek-v4-1-flash",
		});
	});
});

describe("ledger", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "runkiln-usage-"));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	function row(ts: number, model: string, cost: number, extra: Partial<LedgerRow> = {}): LedgerRow {
		return {
			v: 1,
			ts: new Date(ts).toISOString(),
			sid: "s1",
			id: `id-${ts}-${model}`,
			cat: "main",
			kind: "turn",
			provider: "runinfra",
			model,
			thinking: "low",
			in: 100,
			cached: 900,
			out: 50,
			cost,
			...extra,
		};
	}

	it("drops bad lines and duplicates, totals by day, model and category with quiet days filled", () => {
		const now = new Date(2026, 9, 17, 18, 0).getTime();
		const day = 86_400_000;
		const rows = [
			row(now - 1000, "glm-5-3-flash", 0.002),
			row(now - 2 * day, "deepseek-v4-1-flash", 0.004, { thinking: "high" }),
			row(now - 2 * day + 10, "jev-latest", 0.0001, { cat: "classifier", est: true, cached: 0 }),
			row(now - 40 * day, "glm-5-3-flash", 1),
		];
		const text = [...rows.map((r) => JSON.stringify(r)), "not json", JSON.stringify(rows[0]), '{"v":2}'].join("\n");
		const parsed = parseLedger(text);
		expect(parsed).toHaveLength(4);
		const week = summarizeLedger(parsed, { since: rangeStart("week", now), now });
		expect(week.cost).toBeCloseTo(0.0061, 12);
		expect(week.days).toHaveLength(7);
		expect(week.days.at(-1)!.day).toBe(localDay(now));
		expect(week.days.filter((d) => d.requests > 0)).toHaveLength(2);
		expect(week.models.map((m) => m.key)).toEqual([
			"deepseek-v4-1-flash•high",
			"glm-5-3-flash•low",
			"jev-latest (router)",
		]);
		expect(week.estimatedCost).toBeCloseTo(0.0001, 12);
		expect(week.categories.map((c) => c.key)).toEqual(["Main turns", "Router classifier"]);
		expect(summarizeLedger(parsed, { since: rangeStart("today", now), now }).cost).toBeCloseTo(0.002, 12);
		expect(summarizeLedger(parsed, { now }).cost).toBeCloseTo(1.0061, 12);
	});

	it("parses --since and draws a sparkline", () => {
		const now = Date.parse("2026-10-17T12:00:00Z");
		expect(parseSince("7d", now)).toBe(now - 7 * 86_400_000);
		expect(parseSince("24h", now)).toBe(now - 86_400_000);
		expect(parseSince("2w", now)).toBe(now - 14 * 86_400_000);
		expect(parseSince("week", now)).toBe(rangeStart("week", now));
		expect(parseSince("2026-10-01", now)).toBe(new Date("2026-10-01T00:00:00").getTime());
		expect(parseSince("soon", now)).toBeUndefined();
		expect(sparkline([0, 1, 2, 4, 8])).toBe(".▁▂▄█");
		expect(sparkline([0, 0])).toBe("..");
	});

	it("rebuilds from session files and keeps today's total while appending", () => {
		const sessions = join(dir, "sessions", "--p--");
		mkdirSync(sessions, { recursive: true });
		const header = { type: "session", version: 3, id: "abc", timestamp: new Date(T0).toISOString(), cwd: "/p" };
		const lines = [header, ...scriptedSession()].map((e) => JSON.stringify(e)).join("\n");
		writeFileSync(join(sessions, "s.jsonl"), lines);
		const fromText = ledgerRowsFromSessionText(lines);
		expect(fromText.length).toBe(11);
		expect(fromText.every((r) => r.sid === "abc" && r.cwd === "/p")).toBe(true);
		const ledgerPath = join(dir, "usage.jsonl");
		expect(rebuildLedger(ledgerPath, join(dir, "sessions"))).toEqual({ rows: 11, sessions: 1 });
		expect(readLedger(ledgerPath)).toHaveLength(11);

		const writer = new UsageLedgerWriter(join(dir, "fresh.jsonl"));
		const now = Date.now();
		expect(writer.costToday(now)).toBe(0);
		writer.append([row(now, "glm-5-3-flash", 0.003)]);
		writer.append([row(now - 3 * 86_400_000, "glm-5-3-flash", 0.5)]);
		expect(writer.costToday(now)).toBeCloseTo(0.003, 12);
		expect(readFileSync(join(dir, "fresh.jsonl"), "utf8").trim().split("\n")).toHaveLength(2);
	});

	it("runkiln usage: parses its arguments and prints text or JSON", () => {
		expect(parseUsageCommand(["usage"])).toMatchObject({ range: "week", json: false });
		expect(parseUsageCommand(["usage", "month", "--json"])).toMatchObject({ range: "month", json: true });
		expect(parseUsageCommand(["usage", "--since", "7d"])).toMatchObject({ since: "7d" });
		expect(parseUsageCommand(["usage", "--since"])).toEqual({ error: expect.stringContaining("--since") });
		expect(parseUsageCommand(["usage", "tell", "me", "about", "x"])).toBeUndefined();
		expect(parseUsageCommand(["fix", "usage"])).toBeUndefined();

		const now = Date.now();
		writeFileSync(join(dir, "usage.jsonl"), `${JSON.stringify(row(now - 1000, "glm-5-3-flash", 0.0123))}\n`);
		let out = "";
		const io = {
			agentDir: dir,
			now,
			stdout: (t: string) => {
				out += t;
			},
			stderr: () => {},
		};
		expect(runUsageCommand({ range: "today", json: true, rebuild: false, help: false }, io)).toBe(0);
		const json = JSON.parse(out);
		expect(json).toMatchObject({ range: "today", costUsd: 0.0123, requests: 1, sessions: 1 });
		// Machine-readable keys keep their format (model•thinking, no " - "); only rendered text uses " - ".
		const keys = JSON.stringify(json).match(/glm-5-3-flash[^"]*/g) ?? [];
		expect(keys.length).toBeGreaterThan(0);
		for (const key of keys) expect(key).toBe("glm-5-3-flash\u2022low");
		expect(out).not.toContain("glm-5-3-flash - low");
		out = "";
		expect(runUsageCommand({ range: "week", json: false, rebuild: false, help: false }, io)).toBe(0);
		expect(out).toContain("RunKiln usage - Last 7 days");
		expect(out).toContain("$0.0123");
		expect(out).toContain("glm-5-3-flash - low");
		for (const line of out.trimEnd().split("\n")) expect([...line].length).toBeLessThanOrEqual(100);
		expect(runUsageCommand({ range: "week", since: "later", json: false, rebuild: false, help: false }, io)).toBe(1);
	});
});

describe("budgets", () => {
	it("warns at 80%, asks at 100%, and announces each threshold once", () => {
		const statuses = evaluateBudgets({ session: 0.5, daily: 2 }, 0.41, 0.5);
		expect(statuses.map((s) => [s.kind, s.level])).toEqual([
			["session", "warn"],
			["daily", "ok"],
		]);
		expect(tightestBudget(statuses)?.kind).toBe("session");
		const seen = new Map();
		expect(newlyCrossed(statuses, seen)?.kind).toBe("session");
		expect(newlyCrossed(statuses, seen)).toBeUndefined();
		expect(newlyCrossed(evaluateBudgets({ session: 0.5 }, 0.6, 0), seen)?.level).toBe("over");
		expect(evaluateBudgets({}, 1, 1)).toEqual([]);
		expect(evaluateBudgets({ session: -1, daily: Number.NaN }, 1, 1)).toEqual([]);
	});
});

describe("usage views", () => {
	beforeAll(() => initTheme("dark"));

	const context = {
		tokens: 42_000,
		contextWindow: 1_048_576,
		parts: { systemPrompt: 3100, tools: 2000, messages: 12_000, toolResults: 24_900 },
		estimated: true,
		autoCompact: true,
		compactAt: 196_608,
		model: "glm-5-3-flash",
	};

	it("fits every tab in 80 and 100 columns", () => {
		const report = buildSessionUsageReport(scriptedSession(), { prices: PRICES, now: T0 + 2_000_400 });
		const budgets = evaluateBudgets({ session: 0.02, daily: 1 }, report.overview.cost, 0.5);
		const now = Date.now();
		const summary = summarizeLedger(
			ledgerRowsFromSessionText(
				[{ type: "session", id: "x" }, ...scriptedSession()].map((e) => JSON.stringify(e)).join("\n"),
			),
			{ now: T0 + 3_000_000 },
		);
		for (const width of [80, 100]) {
			const all = [
				...overviewLines(report, width - 2, undefined, { budgets }),
				...modelLines(report, width - 2),
				...turnLines(report, width - 2),
				...contextLines(context, width - 2),
				...historyLines(summary, "all", width - 2),
			];
			for (const line of all) expect([...line].length, line).toBeLessThanOrEqual(width - 2);
		}
		const text = usageText({ report, context, budgets, history: { range: "week", summary } }, 80);
		expect(text).toContain("== Overview ==");
		expect(text).toContain("cache saved");
		expect(text).toContain("est.");
		expect(text).toContain("last miss: turn 5");
		expect(text).toContain("Auto-compaction".length > 0 ? "auto at 197k" : "");
		expect(now).toBeGreaterThan(0);
	});

	it("reads /usage arguments as a tab or a History range", () => {
		expect(parseUsageArgument("")).toEqual({});
		expect(parseUsageArgument("models")).toEqual({ tab: "models" });
		expect(parseUsageArgument("ctx")).toEqual({});
		expect(parseUsageArgument("con")).toEqual({ tab: "context" });
		expect(parseUsageArgument("3")).toEqual({ tab: "turns" });
		expect(parseUsageArgument("month")).toEqual({ tab: "history", range: "month" });
		expect(usd(0.012345)).toBe("$0.0123");
		expect(usd(12.345)).toBe("$12.35");
		expect(usd(0.0012345)).toBe("$0.0012");
		expect(usd(0.00001)).toBe("<$0.0001");
	});

	it("draws the overlay at the terminal height with tabs, scrolling and Esc", () => {
		const report = buildSessionUsageReport(scriptedSession(), { prices: PRICES, now: T0 + 2_000_400 });
		let closed = false;
		const screen = new UsageScreen({
			data: {
				report: () => report,
				context: () => context,
				history: () => undefined,
				budgets: () => [],
				title: "demo",
			},
			height: () => 24,
			onClose: () => {
				closed = true;
			},
		});
		for (const tab of ["1", "2", "3", "4", "5"]) {
			screen.handleInput(tab);
			const lines = screen.render(80);
			expect(lines).toHaveLength(24);
			for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(80);
			expect(strip(lines[1]!)).toContain("Overview");
		}
		expect(screen.activeTab).toBe("history");
		screen.handleInput("\t");
		expect(screen.activeTab).toBe("overview");
		screen.handleInput("m");
		expect(screen.activeTab).toBe("history");
		expect(screen.activeRange).toBe("month");
		screen.handleInput("3");
		screen.handleInput("\x1b[B");
		expect(strip(screen.render(80).join("\n"))).toContain("▸ #4");
		screen.handleInput("\x1b");
		expect(closed).toBe(true);
	});
});

describe("footer cost meter", () => {
	beforeAll(() => initTheme("dark"));

	it("is compact, shows the tightest budget and opens /usage on click", () => {
		expect(formatCostMeter({ input: 900, cacheRead: 9100, cacheWrite: 0, cost: 0.0123 })).toBe(
			"$0.0123 - 91% cached",
		);
		expect(formatCostMeter({ input: 0, cacheRead: 0, cacheWrite: 0, cost: 0 })).toBeUndefined();
		expect(formatCostMeter({ input: 100, cacheRead: 0, cacheWrite: 0, cost: 0.41 }, { limit: 0.5 })).toBe(
			"$0.4100/$0.50",
		);

		const entries = [
			{ id: "1", type: "message", message: { role: "user", content: "x" } },
			{
				id: "2",
				type: "message",
				message: {
					role: "assistant",
					usage: { input: 1000, output: 10, cacheRead: 9000, cacheWrite: 0, cost: { total: 0.45 } },
				},
			},
		];
		const session = {
			sessionManager: {
				getEntryCount: () => entries.length,
				getSessionId: () => "s",
				getLeafId: () => "2",
				getEntries: () => entries,
				getCwd: () => "/tmp",
				getSessionName: () => undefined,
			},
			state: { model: { id: "glm-5-3-flash", provider: "runinfra", reasoning: false, contextWindow: 1_048_576 } },
			getContextUsage: () => ({ tokens: 10_000, contextWindow: 1_048_576, percent: 1 }),
			getBudgetStatuses: () => evaluateBudgets({ session: 0.5 }, 0.45, 0),
			modelRuntime: { isUsingSubscription: () => false },
			isAutoRouting: false,
			permissionMode: "read-write",
		};
		const footerData = {
			getGitBranch: () => null,
			getAvailableProviderCount: () => 1,
			getExtensionStatuses: () => new Map(),
		};
		// biome-ignore lint/suspicious/noExplicitAny: scripted session stand-in
		const footer = new FooterComponent(session as any, footerData as any);
		let clicks = 0;
		footer.onUsageClick = () => clicks++;
		const line = strip(footer.render(80)[1]!);
		expect(line).toMatch(/^\$0\.4500\/\$0\.50 - 90% cached - /);
		const click = (x: number) =>
			footer.handleMouse({
				type: "click",
				button: "left",
				x,
				y: 1,
				screenX: x,
				screenY: 20,
				width: 80,
				height: 2,
				shift: false,
				alt: false,
				ctrl: false,
			});
		expect(click(3)).toMatchObject({ handled: true });
		expect(click(60)).toBeUndefined();
		expect(clicks).toBe(1);
	});
});

describe("usage in a session", () => {
	let root: string;
	let faux: FauxProviderRegistration;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "runkiln-usage-session-"));
		for (const dir of ["agent", "project", "sessions"]) mkdirSync(join(root, dir), { recursive: true });
		faux = registerFauxProvider({
			models: [
				{ id: "cheap", reasoning: true, cost: { input: 0.1, output: 0.4, cacheRead: 0.01, cacheWrite: 0 } },
				{ id: "strong", reasoning: true, cost: { input: 0.3, output: 1.2, cacheRead: 0.03, cacheWrite: 0 } },
			],
		});
	});

	afterEach(() => {
		faux.unregister();
		rmSync(root, { recursive: true, force: true });
	});

	it("records classifier spend, the route and every call in the ledger", async () => {
		const spend = {
			backend: "jev" as const,
			model: "jev-mock",
			inputTokens: 1000,
			outputTokens: 0,
			cost: 0.000042,
			estimated: true,
		};
		const classifier = new MockClassifier((input) =>
			classification({ difficulty: input.request.includes("hard") ? 0.8 : 0.1, spend }),
		);
		const autoModels = createAutoModels(faux.models as Model<Api>[]);
		const runtime = {
			autoModel: autoModels.medium,
			autoModelFor: (mode: "low" | "medium" | "high" = "medium") => autoModels[mode],
			getAvailableSnapshot: () => [...(faux.models as Model<Api>[]), ...Object.values(autoModels)],
			getModelById: () => undefined,
			hasConfiguredAuth: () => true,
			checkAuth: async () => ({ type: "api_key" }),
			streamSimple: (model: Model<Api>, ctx: Context, options?: SimpleStreamOptions) =>
				streamSimple(model, ctx, options),
		} as unknown as ModelRuntime;
		const router = new ModelRouter({
			catalog: testCatalog(),
			classifier,
			getModels: () => faux.models as Model<Api>[],
			defaultModelId: () => "cheap",
		});
		const { session } = await createAgentSession({
			cwd: join(root, "project"),
			agentDir: join(root, "agent"),
			modelRuntime: runtime,
			model: faux.getModel("cheap"),
			sessionManager: SessionManager.create(join(root, "project"), join(root, "sessions")),
			thinkingLevel: "off",
			noTools: "all",
			router,
		});
		await session.setModel(autoModels.medium);
		faux.setResponses([fauxAssistantMessage("done")]);
		await session.prompt("a hard refactor");
		faux.setResponses([fauxAssistantMessage("ok")]);
		await session.prompt("an easy question");

		const entries = session.sessionManager.getEntries();
		expect(entries.filter((e) => e.type === "usage" && e.kind === "classifier")).toHaveLength(2);
		expect(entries.filter((e) => e.type === "custom" && e.customType === ROUTE_ENTRY_TYPE)).toHaveLength(2);
		const report = session.getUsageReport();
		expect(report.categories.find((c) => c.category === "classifier")).toMatchObject({
			requests: 2,
			estimated: true,
		});
		expect(report.turns[0]!.route).toMatch(/^classifier - /);
		expect(report.turns[0]!.model).toBe("strong");
		expect(session.getSessionStats().cost).toBeCloseTo(2 * 0.000042 + report.overview.cost - 2 * 0.000042, 12);

		const ledger = readLedger(join(root, "agent", "usage.jsonl"));
		expect(ledger.filter((r) => r.cat === "classifier")).toHaveLength(2);
		expect(ledger.filter((r) => r.cat === "main")).toHaveLength(2);
		expect(ledger.every((r) => r.sid === session.sessionManager.getSessionId())).toBe(true);
		expect(session.usageLedgerPath).toBe(join(root, "agent", "usage.jsonl"));

		const breakdown = session.getContextBreakdown();
		expect(breakdown?.contextWindow).toBeGreaterThan(0);
		expect(breakdown?.parts.systemPrompt).toBeGreaterThan(0);
		session.dispose();
	});
});
