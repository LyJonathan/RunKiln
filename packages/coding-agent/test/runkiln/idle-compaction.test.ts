import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
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
} from "@runkiln/ai/compat";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CACHE_TTL_MS } from "../../src/core/cache-stats.ts";
import type { ModelRuntime } from "../../src/core/model-runtime.ts";
import {
	idleCompactionDecision,
	idleCompactionNotice,
	lastCacheActivityAt,
} from "../../src/core/runkiln/idle-compaction.ts";
import { DEFAULT_SESSION_IDLE_TTL_MS } from "../../src/core/runkiln/last-request.ts";
import { setProcessPermissionMode } from "../../src/core/runkiln/permissions.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";

describe("idle compaction decision", () => {
	const base = { enabled: true, now: 2_000_000, ttlMs: 900_000, contextTokens: 50_000, minTokens: 40_000 };

	it("is due only past the TTL, with a large context, when on", () => {
		expect(idleCompactionDecision({ ...base, lastActivityAt: 2_000_000 - 901_000 }).due).toBe(true);
		expect(idleCompactionDecision({ ...base, lastActivityAt: 2_000_000 - 899_000 }).due).toBe(false);
		expect(idleCompactionDecision({ ...base, lastActivityAt: 0, contextTokens: 39_999 }).due).toBe(false);
		expect(idleCompactionDecision({ ...base, lastActivityAt: 0, enabled: false }).due).toBe(false);
		expect(idleCompactionDecision({ ...base, lastActivityAt: undefined }).due).toBe(false);
	});

	it("takes the newest assistant reply or cache-warming request as the last cache refresh", () => {
		const at = lastCacheActivityAt([
			{ type: "message", message: { role: "assistant", timestamp: 1000, stopReason: "stop" } },
			{ type: "message", message: { role: "assistant", timestamp: 5000, stopReason: "error" } },
			{ type: "usage", kind: "cache_warm", timestamp: new Date(3000).toISOString() },
			{ type: "message", message: { role: "user", timestamp: 9000 } },
		]);
		expect(at).toBe(3000);
		expect(lastCacheActivityAt([])).toBeUndefined();
	});

	it("says why in one line", () => {
		expect(idleCompactionNotice(40 * 60_000, 52_300, 900_000)).toBe(
			"Idle 40 min, past the 15 min cache window: compacting 52k tokens first, since this turn would be billed uncached anyway (compaction.idleCompact).",
		);
	});

	it("uses RunInfra's 900 s idle TTL, not a 5-minute one, as the fallback cache TTL", () => {
		expect(DEFAULT_SESSION_IDLE_TTL_MS).toBe(900_000);
		expect(CACHE_TTL_MS).toBe(900_000);
	});
});

describe("idle compaction on the session", () => {
	let root: string;
	let faux: FauxProviderRegistration;
	const runtime = {
		getModelById: () => undefined,
		hasConfiguredAuth: () => true,
		streamSimple: (model: Model<Api>, context: Context, options?: SimpleStreamOptions) =>
			streamSimple(model, context, options),
	} as unknown as ModelRuntime;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "runkiln-idle-"));
		for (const dir of ["agent", "project", "sessions"]) mkdirSync(join(root, dir), { recursive: true });
		faux = registerFauxProvider();
	});

	afterEach(() => {
		faux.unregister();
		setProcessPermissionMode(undefined);
		vi.restoreAllMocks();
		rmSync(root, { recursive: true, force: true });
	});

	async function run(settings: Record<string, unknown>, idleMs: number) {
		const { session } = await createAgentSession({
			cwd: join(root, "project"),
			agentDir: join(root, "agent"),
			modelRuntime: runtime,
			model: faux.getModel(),
			settingsManager: SettingsManager.inMemory(settings as never),
			sessionManager: SessionManager.create(join(root, "project"), join(root, "sessions")),
			thinkingLevel: "off",
			permissionMode: "allow-all",
		});
		const events: string[] = [];
		session.subscribe((event) => {
			if (event.type === "idle_compaction" || event.type === "compaction_start") events.push(event.type);
		});
		faux.setResponses([
			fauxAssistantMessage(`first answer ${"lorem ipsum ".repeat(400)}`),
			fauxAssistantMessage(`second answer ${"dolor sit ".repeat(400)}`),
			fauxAssistantMessage("## Goal\nsummary of the session"),
			fauxAssistantMessage("third answer"),
		]);
		await session.prompt(`first question ${"alpha ".repeat(400)}`);
		await session.prompt("second question");
		const realNow = Date.now();
		vi.spyOn(Date, "now").mockImplementation(() => realNow + idleMs);
		await session.prompt("third question after a break");
		const compactions = session.sessionManager.getEntries().filter((entry) => entry.type === "compaction");
		session.dispose();
		return { events, compactions: compactions.length };
	}

	const settings = { compaction: { idleMinTokens: 100, keepRecentTokens: 50 } };

	it("compacts before the next turn after an idle gap past the TTL", async () => {
		const result = await run(settings, 16 * 60_000);
		expect(result.events).toEqual(["idle_compaction", "compaction_start"]);
		expect(result.compactions).toBe(1);
	});

	it("does nothing inside the TTL or when compaction.idleCompact is off", async () => {
		expect((await run(settings, 60_000)).events).toEqual([]);
		const off = await run({ compaction: { ...settings.compaction, idleCompact: false } }, 60 * 60_000);
		expect(off.events).toEqual([]);
		expect(off.compactions).toBe(0);
	});
});
