import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	createAssistantMessageEventStream,
	isRetryableAssistantError,
	jitteredRetryDelayMs,
	type Model,
	type ThinkingLevelMap,
	type ToolCall,
} from "@runkiln/ai";
import type { Context, SimpleStreamOptions } from "@runkiln/ai/compat";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../../src/config.ts";
import type { AgentSessionEvent } from "../../src/core/agent-session.ts";
import type { ToolDefinition } from "../../src/core/extensions/types.ts";
import type { ModelRuntime } from "../../src/core/model-runtime.ts";
import { parseRouterCatalog } from "../../src/core/router/catalog.ts";
import { ModelHealth } from "../../src/core/router/health.ts";
import { createAutoModels } from "../../src/core/router/index.ts";
import { ModelRouter } from "../../src/core/router/router.ts";
import { parseChoreModel, resolveChoreModel } from "../../src/core/runkiln/chore-model.ts";
import { isStallError, withFirstTokenTimeout } from "../../src/core/runkiln/stall-watchdog.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import type { Settings } from "../../src/core/settings-schema.ts";
import { classification, MockClassifier, signals, TEST_ROUTER_YAML } from "./router-fixtures.ts";

const request = (overrides: Parameters<typeof signals>[0] = {}) => ({
	signals: signals(overrides),
	role: "code" as const,
	toolsActive: true,
});

const GLM = "glm-5-3-flash";
const DS = "deepseek-v4-1-flash-1017";

/** GLM accepts low/high/max; DeepSeek none/low/high/xhigh/max (models.yaml). */
const GLM_MAP: ThinkingLevelMap = {
	off: null,
	minimal: null,
	low: "low",
	medium: null,
	high: "high",
	xhigh: null,
	max: "max",
};
const DS_MAP: ThinkingLevelMap = {
	off: "none",
	minimal: null,
	low: "low",
	medium: null,
	high: "high",
	xhigh: "xhigh",
	max: "max",
};

function runinfraModel(id: string, map: ThinkingLevelMap, overrides: Partial<Model<"openai-completions">> = {}) {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider: "runinfra",
		baseUrl: "https://api.runinfra.ai/v1",
		reasoning: true,
		thinkingLevelMap: map,
		input: ["text"],
		cost: { input: 0.12, output: 0.5, cacheRead: 0.03, cacheWrite: 0 },
		contextWindow: 1_048_576,
		maxTokens: 16_384,
		...overrides,
	} as Model<"openai-completions">;
}

/** GLM scores higher, so a hard request routes to it; DeepSeek is the other catalog model. */
const PAIR_YAML = TEST_ROUTER_YAML.replace("  cheap:\n", `  ${DS}:\n`).replace("  strong:\n", `  ${GLM}:\n`);

function pairRouter(models: Model<Api>[], options: { now?: () => number; difficulty?: number } = {}) {
	return new ModelRouter({
		catalog: parseRouterCatalog([{ text: PAIR_YAML, path: "pair-router.yaml" }]),
		classifier: new MockClassifier(() => classification({ difficulty: options.difficulty ?? 0.8 })),
		getModels: () => models,
		defaultModelId: () => GLM,
		now: options.now,
	});
}

describe("jittered backoff", () => {
	it("stays between half and all of the exponential delay", () => {
		const policy = { baseDelayMs: 1000, maxAgentDelayMs: 60_000 };
		expect(jitteredRetryDelayMs(policy, 1, () => 0)).toBe(500);
		expect(jitteredRetryDelayMs(policy, 1, () => 1)).toBe(1000);
		expect(jitteredRetryDelayMs(policy, 3, () => 0.5)).toBe(3000);
		for (let i = 0; i < 50; i++) {
			const delay = jitteredRetryDelayMs(policy, 2);
			expect(delay).toBeGreaterThanOrEqual(1000);
			expect(delay).toBeLessThanOrEqual(2000);
		}
	});
});

describe("model health", () => {
	it("cools a failed model down and clears it on success or when the cooldown ends", () => {
		let now = 0;
		const health = new ModelHealth({ cooldownMs: () => 60_000, now: () => now });
		expect(health.isHealthy(GLM)).toBe(true);
		health.markFailed(GLM, "503 Service Unavailable");
		expect(health.isHealthy(GLM)).toBe(false);
		expect(health.down()).toEqual([
			{ modelId: GLM, leftMs: 60_000, failures: 1, lastError: "503 Service Unavailable" },
		]);
		now = 59_999;
		expect(health.isHealthy(GLM)).toBe(false);
		now = 60_000;
		expect(health.isHealthy(GLM)).toBe(true);
		health.markFailed(GLM);
		health.markOk(GLM);
		expect(health.isHealthy(GLM)).toBe(true);
	});
});

describe("router failover", () => {
	const glm = runinfraModel(GLM, GLM_MAP);
	const ds = runinfraModel(DS, DS_MAP);

	it("maps thinking levels to the other model's equivalent", () => {
		const router = pairRouter([glm, ds]);
		const toDs = (level: Parameters<ModelRouter["failoverTarget"]>[1]) =>
			router.failoverTarget(GLM, level)?.thinkingLevel;
		const toGlm = (level: Parameters<ModelRouter["failoverTarget"]>[1]) =>
			router.failoverTarget(DS, level)?.thinkingLevel;
		expect(router.failoverTarget(GLM, "high")?.model.id).toBe(DS);
		expect([toDs("low"), toDs("high"), toDs("max")]).toEqual(["low", "high", "max"]);
		expect([toGlm("off"), toGlm("low"), toGlm("high"), toGlm("xhigh"), toGlm("max")]).toEqual([
			"low",
			"low",
			"high",
			"max",
			"max",
		]);
	});

	it("pins the turn to the target until endFailover, then routes normally while the failed model cools down", async () => {
		let now = 1_000_000;
		const router = pairRouter([glm, ds], { now: () => now });
		const first = await router.route(request());
		expect(first.model.id).toBe(GLM);
		const target = router.failoverTarget(GLM, first.thinkingLevel);
		expect(target?.model.id).toBe(DS);
		router.startFailover(GLM, DS, target!.thinkingLevel, "503");
		// The retry of the same request and the tool continuations after it stay on the target.
		for (const signals of [{}, { isNewUserTurn: false, warmModelId: DS }]) {
			const decision = await router.route(request(signals));
			expect(decision.model.id).toBe(DS);
			expect(decision.source).toBe("failover");
			expect(decision.failoverFrom).toBe(GLM);
			expect(decision.thinkingLevel).toBe(target!.thinkingLevel);
		}
		router.endFailover();
		const next = await router.route(request({ latestUserText: "next hard task" }));
		expect(next.source).not.toBe("failover");
		expect(next.model.id).toBe(DS);
		// After the cooldown (router.yaml failed_model_cooldown_sec: 300) GLM is routable again.
		now += 301_000;
		const later = await router.route(request({ latestUserText: "a later hard task" }));
		expect(later.model.id).toBe(GLM);
	});

	it("never fails over to a disabled model or one without vision when the context has images", () => {
		const router = pairRouter([glm, ds]);
		expect(router.failoverTarget(GLM, "low", { hasImages: true })).toBeUndefined();
		router.setModelFilter((model) => model.id !== DS);
		expect(router.failoverTarget(GLM, "low")).toBeUndefined();
		expect(router.hasAlternative(GLM)).toBe(false);
	});

	it("drops the pin when the target becomes unusable", async () => {
		const router = pairRouter([glm, ds]);
		await router.route(request());
		router.startFailover(GLM, DS, "high");
		router.markModelFailed(DS);
		const decision = await router.route(request({ isNewUserTurn: false }));
		expect(decision.source).not.toBe("failover");
		expect(router.activeFailover).toBeUndefined();
	});
});

describe("chore model", () => {
	const glm = runinfraModel(GLM, GLM_MAP);
	const ds = runinfraModel(DS, DS_MAP);
	const models = new Map<string, Model<Api>>([
		[GLM, glm],
		[DS, ds],
	]);
	const deps = (overrides: { disabled?: string[]; down?: string[] } = {}) => ({
		getModel: (id: string) => models.get(id),
		isUsable: (model: Model<Api>) => !(overrides.disabled ?? []).includes(model.id),
		isHealthy: (id: string) => !(overrides.down ?? []).includes(id),
		session: { model: glm as Model<Api>, thinkingLevel: "high" as const },
	});

	it("parses <model>[:<thinking>]", () => {
		expect(parseChoreModel("deepseek-v4-1-flash-1017:off")).toEqual({ id: DS, level: "off" });
		expect(parseChoreModel("runinfra/glm-5-3-flash:low")).toEqual({ id: GLM, level: "low" });
		expect(parseChoreModel("deepseek-v4-1-flash-1017:none")).toEqual({ id: DS, level: "off" });
		expect(parseChoreModel(GLM)).toEqual({ id: GLM });
		expect(parseChoreModel("session")).toBeUndefined();
	});

	it("defaults to DeepSeek with thinking off", () => {
		const choice = resolveChoreModel(undefined, deps());
		expect([choice?.model.id, choice?.thinkingLevel, choice?.source]).toEqual([DS, "off", "default"]);
		const setting = resolveChoreModel("deepseek-v4-1-flash-1017:off", deps());
		expect([setting?.model.id, setting?.thinkingLevel, setting?.source]).toEqual([DS, "off", "default"]);
	});

	it("falls back to GLM low when DeepSeek is disabled or unhealthy, then to the session model", () => {
		for (const overrides of [{ disabled: [DS] }, { down: [DS] }]) {
			const choice = resolveChoreModel("deepseek-v4-1-flash-1017:off", deps(overrides));
			expect([choice?.model.id, choice?.thinkingLevel]).toEqual([GLM, "low"]);
		}
		const none = resolveChoreModel(undefined, deps({ disabled: [DS, GLM] }));
		expect([none?.model.id, none?.thinkingLevel, none?.source]).toEqual([GLM, "high", "session"]);
	});

	it("honors an override, clamped to the model's levels, and 'session'", () => {
		const glmHigh = resolveChoreModel("glm-5-3-flash:high", deps());
		expect([glmHigh?.model.id, glmHigh?.thinkingLevel, glmHigh?.source]).toEqual([GLM, "high", "setting"]);
		const glmOff = resolveChoreModel("glm-5-3-flash", deps());
		expect(glmOff?.thinkingLevel).toBe("low");
		expect(resolveChoreModel("session", deps())?.source).toBe("session");
		const unknown = resolveChoreModel("no-such-model:low", deps());
		expect(unknown?.model.id).toBe(DS);
		expect(unknown?.skipped).toEqual([{ id: "no-such-model", reason: "unknown model" }]);
	});
});

describe("first-token stall check", () => {
	const model = runinfraModel(GLM, GLM_MAP);

	/** A request that connects (start) and then sends nothing until it is aborted. */
	function hangingStream(signal: AbortSignal | undefined, seen: { aborted: boolean }): AssistantMessageEventStream {
		const stream = createAssistantMessageEventStream();
		const partial = message(GLM, { stopReason: "stop" });
		stream.push({ type: "start", partial });
		signal?.addEventListener("abort", () => {
			seen.aborted = true;
			stream.push({ type: "error", reason: "aborted", error: { ...partial, stopReason: "aborted" } });
			stream.end();
		});
		return stream;
	}

	it("aborts a request with no first token and ends it as a retryable timeout", async () => {
		const seen = { aborted: false };
		const stream = withFirstTokenTimeout((signal) => hangingStream(signal, seen), { model, timeoutMs: 30 });
		const result = await stream.result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("timed out");
		expect(isStallError(result)).toBe(true);
		expect(isRetryableAssistantError(result)).toBe(true);
		expect(seen.aborted).toBe(true);
	});

	it("never cuts a stream once the first token arrived", async () => {
		const stream = withFirstTokenTimeout(
			() => {
				const out = createAssistantMessageEventStream();
				const partial = message(GLM, { stopReason: "stop" });
				out.push({ type: "start", partial });
				out.push({ type: "text_start", contentIndex: 0, partial });
				setTimeout(() => {
					const done = message(GLM, { text: "slow but fine" });
					out.push({ type: "done", reason: "stop", message: done });
					out.end();
				}, 80);
				return out;
			},
			{ model, timeoutMs: 20 },
		);
		const result = await stream.result();
		expect(result.stopReason).toBe("stop");
	});

	it("passes the caller's abort through as an abort", async () => {
		const controller = new AbortController();
		const seen = { aborted: false };
		const stream = withFirstTokenTimeout((signal) => hangingStream(signal, seen), {
			model,
			timeoutMs: 10_000,
			signal: controller.signal,
		});
		controller.abort();
		const result = await stream.result();
		expect(result.stopReason).toBe("aborted");
	});
});

// ---------------------------------------------------------------------------------------------
// The session: retries, failover, pinned models, chores
// ---------------------------------------------------------------------------------------------

function message(
	model: string,
	options: {
		text?: string;
		toolCalls?: ToolCall[];
		stopReason?: AssistantMessage["stopReason"];
		errorMessage?: string;
	} = {},
): AssistantMessage {
	const content: AssistantMessage["content"] = [];
	if (options.text) content.push({ type: "text", text: options.text });
	if (options.toolCalls) content.push(...options.toolCalls);
	return {
		role: "assistant",
		content,
		api: "openai-completions",
		provider: "runinfra",
		model,
		usage: {
			input: 10,
			output: 5,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 15,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: options.stopReason ?? (options.toolCalls ? "toolUse" : "stop"),
		...(options.errorMessage ? { errorMessage: options.errorMessage } : {}),
		timestamp: Date.now(),
	};
}

/** What one scripted request does. */
type Reply =
	| { text: string }
	| { toolCall: { name: string; args: ToolCall["arguments"] } }
	/** Fails before anything streams (HTTP 5xx/429, connection refused). */
	| { error: string }
	/** Streams some text, then the connection drops. */
	| { partial: string; error: string }
	/** Connects and never sends a token. */
	| { stall: true };

interface SentRequest {
	model: string;
	reasoning: string | undefined;
	kind: "turn" | "title" | "summary";
	/** Text of the messages sent, by role, for checking what the retried request carried. */
	transcript: string[];
}

function replyStream(model: string, reply: Reply, signal: AbortSignal | undefined): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	const partial = message(model, { stopReason: "stop" });
	queueMicrotask(() => {
		stream.push({ type: "start", partial });
		if ("stall" in reply) {
			signal?.addEventListener("abort", () => {
				stream.push({ type: "error", reason: "aborted", error: { ...partial, stopReason: "aborted" } });
				stream.end();
			});
			return;
		}
		if ("error" in reply) {
			const text = "partial" in reply ? reply.partial : undefined;
			if (text) {
				stream.push({ type: "text_start", contentIndex: 0, partial });
				stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial });
			}
			stream.push({
				type: "error",
				reason: "error",
				error: message(model, { text, stopReason: "error", errorMessage: reply.error }),
			});
			stream.end();
			return;
		}
		if ("toolCall" in reply) {
			const call: ToolCall = {
				type: "toolCall",
				id: `call-${Math.random().toString(36).slice(2)}`,
				name: reply.toolCall.name,
				arguments: reply.toolCall.args,
			};
			stream.push({ type: "toolcall_start", contentIndex: 0, partial });
			stream.push({ type: "done", reason: "toolUse", message: message(model, { toolCalls: [call] }) });
			stream.end();
			return;
		}
		stream.push({ type: "text_start", contentIndex: 0, partial });
		stream.push({ type: "done", reason: "stop", message: message(model, { text: reply.text }) });
		stream.end();
	});
	return stream;
}

function transcriptOf(context: Context): string[] {
	const lines: string[] = [];
	for (const entry of context.messages) {
		const content = (entry as { content?: unknown }).content;
		const parts = Array.isArray(content) ? content : [{ type: "text", text: String(content ?? "") }];
		for (const part of parts as Array<{ type: string; text?: string; name?: string }>) {
			// The session's <cwd> context block is not part of what these tests check.
			if (part.type === "text" && part.text && !part.text.startsWith("<cwd>"))
				lines.push(`${entry.role}: ${part.text}`);
			if (part.type === "toolCall") lines.push(`${entry.role}: call ${part.name}`);
		}
	}
	return lines;
}

describe("failover in a session", () => {
	let root: string;
	let sent: SentRequest[];
	/** Scripted replies per model; a model with an empty script answers "ok". */
	let scripts: Record<string, Reply[]>;
	let echoes: string[];

	const echo: ToolDefinition = {
		name: "echo",
		label: "echo",
		description: "Echo the text.",
		parameters: Type.Object({ text: Type.String() }),
		async execute(_id, params: { text: string }) {
			echoes.push(params.text);
			return { content: [{ type: "text", text: `echoed ${params.text}` }], details: undefined };
		},
	};

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "runkiln-failover-"));
		for (const dir of ["agent", "project", "sessions"]) mkdirSync(join(root, dir), { recursive: true });
		vi.stubEnv(ENV_AGENT_DIR, join(root, "agent"));
		sent = [];
		scripts = { [GLM]: [], [DS]: [] };
		echoes = [];
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(root, { recursive: true, force: true });
	});

	async function openSession(options: { settings?: Partial<Settings>; auto?: boolean; vision?: boolean } = {}) {
		const glm = runinfraModel(GLM, GLM_MAP, options.vision ? { input: ["text", "image"] } : {});
		const ds = runinfraModel(DS, DS_MAP);
		const models: Model<Api>[] = [glm, ds];
		const autoModels = createAutoModels(models);
		const runtime = {
			catalog: { defaults: { code: GLM, chat: DS, title: DS, fallback: [] } },
			autoModel: autoModels.medium,
			autoModelFor: (mode: "low" | "medium" | "high" = "medium") => autoModels[mode],
			getAvailableSnapshot: () => [...models, ...Object.values(autoModels)],
			getRoutableModels: () => models,
			getModelById: (id: string) => models.find((model) => model.id === id),
			hasConfiguredAuth: () => true,
			checkAuth: async () => ({ type: "api_key" }),
			getAuth: async () => ({ auth: { apiKey: "test" } }),
			isUsingOAuth: () => false,
			streamSimple: (model: Model<Api>, context: Context, streamOptions?: SimpleStreamOptions) => {
				const title = streamOptions?.sessionId?.endsWith(".title") === true;
				const summary = !title && streamOptions?.cacheRetention === "none";
				sent.push({
					model: model.id,
					reasoning: streamOptions?.reasoning,
					kind: title ? "title" : summary ? "summary" : "turn",
					transcript: transcriptOf(context),
				});
				if (title) return replyStream(model.id, { text: "Failover test" }, streamOptions?.signal);
				if (summary) return replyStream(model.id, { text: "## Goal\nsummary" }, streamOptions?.signal);
				const reply = scripts[model.id]?.shift() ?? { text: "ok" };
				return replyStream(model.id, reply, streamOptions?.signal);
			},
		} as unknown as ModelRuntime;
		const router = pairRouter(models);
		const settingsManager = SettingsManager.inMemory({
			retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 },
			...options.settings,
		});
		const { session } = await createAgentSession({
			cwd: join(root, "project"),
			agentDir: join(root, "agent"),
			modelRuntime: runtime,
			model: options.auto === false ? glm : autoModels.medium,
			sessionManager: SessionManager.create(join(root, "project"), join(root, "sessions")),
			settingsManager,
			thinkingLevel: "high",
			customTools: [echo],
			permissionMode: "allow-all",
			router,
		});
		session.setActiveToolsByName(["echo"]);
		const events: AgentSessionEvent[] = [];
		session.subscribe((event) => events.push(event));
		return { session, events, router };
	}

	const turns = () => sent.filter((entry) => entry.kind === "turn");
	const notices = (events: AgentSessionEvent[]) =>
		events.flatMap((event) =>
			event.type === "failover_notice"
				? [event.message]
				: event.type === "model_fallback" && event.scope === "turn"
					? [`${event.from} unavailable, switched to ${event.to} for this turn`]
					: [],
		);

	it("retries GLM twice with backoff, then fails over to DeepSeek at the equivalent level for the turn", async () => {
		const { session, events } = await openSession();
		scripts[GLM] = [
			{ error: "503 Service Unavailable" },
			{ error: "429 Too Many Requests" },
			{ error: "overloaded" },
		];
		await session.prompt("a hard refactor");
		const models = turns().map((entry) => entry.model);
		// 1 try + failover.retries (2) on GLM, then DeepSeek.
		expect(models).toEqual([GLM, GLM, GLM, DS]);
		const glmLevel = turns()[0].reasoning;
		expect(turns()[3].reasoning).toBe(glmLevel);
		expect(notices(events)).toEqual([`${GLM} unavailable, switched to ${DS} for this turn`]);
		const fallback = events.find((event) => event.type === "model_fallback");
		expect(fallback).toMatchObject({ from: GLM, to: DS, scope: "turn", thinkingLevel: glmLevel });
		expect(session.lastRouteDecision?.source).toBe("failover");
		// The answer came from DeepSeek; the failed attempts are not in the conversation sent next.
		expect(turns()[3].transcript).toEqual(["user: a hard refactor"]);
		expect(session.getRouterStatus().coolingDown?.map((entry) => entry.modelId)).toEqual([GLM]);

		// The next turn is routed normally; GLM sits out its cooldown, so DeepSeek takes it.
		await session.prompt("another hard task");
		expect(session.lastRouteDecision?.source).not.toBe("failover");
		expect(turns().at(-1)?.model).toBe(DS);
		session.dispose();
	});

	it("restarts a request that failed mid-stream, keeping the tool results from earlier in the turn", async () => {
		const { session } = await openSession();
		scripts[GLM] = [
			{ toolCall: { name: "echo", args: { text: "one" } } },
			{ partial: "Half an answ", error: "terminated" },
			{ partial: "Half again", error: "socket hang up" },
			{ error: "502 Bad Gateway" },
		];
		await session.prompt("a hard task with tools");
		expect(echoes).toEqual(["one"]);
		const models = turns().map((entry) => entry.model);
		expect(models).toEqual([GLM, GLM, GLM, GLM, DS]);
		// DeepSeek gets the conversation as it stood before the failed request: the tool call and its
		// result, never the partial text of the dropped streams.
		const last = turns().at(-1)!.transcript;
		expect(last).toEqual(["user: a hard task with tools", "assistant: call echo", "toolResult: echoed one"]);
		expect(last.join("\n")).not.toContain("Half");
		session.dispose();
	});

	it("treats a stalled request (no first token) as retryable and fails over", async () => {
		const { session, events } = await openSession({ settings: { failover: { stallTimeoutSec: 0.03 } } });
		scripts[GLM] = [{ stall: true }, { stall: true }, { stall: true }];
		await session.prompt("a hard question");
		expect(turns().map((entry) => entry.model)).toEqual([GLM, GLM, GLM, DS]);
		const retry = events.find((event) => event.type === "auto_retry_start");
		expect(retry && "errorMessage" in retry ? retry.errorMessage : "").toContain("no first token");
		session.dispose();
	});

	it("does not loop: when the failover model fails too, the turn ends with the error", async () => {
		const { session, events } = await openSession();
		scripts[GLM] = Array.from({ length: 10 }, () => ({ error: "503 Service Unavailable" }));
		scripts[DS] = Array.from({ length: 10 }, () => ({ error: "503 Service Unavailable" }));
		await session.prompt("a hard task");
		// GLM: 1 + 2 retries; DeepSeek: 1 + retry.maxRetries (3); then stop.
		expect(turns().map((entry) => entry.model)).toEqual([GLM, GLM, GLM, DS, DS, DS, DS]);
		expect(notices(events).at(-1)).toContain("not switching again");
		session.dispose();
	});

	it("only retries a model the user picked, and says so", async () => {
		const { session, events } = await openSession({ auto: false });
		scripts[GLM] = Array.from({ length: 10 }, () => ({ error: "503 Service Unavailable" }));
		await session.prompt("a task");
		expect(turns().map((entry) => entry.model)).toEqual([GLM, GLM, GLM, GLM]);
		const said = notices(events);
		expect(said[0]).toContain("Retrying it only");
		expect(said.at(-1)).toContain("did not switch");
		session.dispose();
	});

	it("respects disabledModels: no failover target, retries only", async () => {
		const { session, events } = await openSession({ settings: { disabledModels: [DS] } as Partial<Settings> });
		scripts[GLM] = Array.from({ length: 10 }, () => ({ error: "503 Service Unavailable" }));
		await session.prompt("a hard task");
		expect(turns().every((entry) => entry.model === GLM)).toBe(true);
		expect(turns()).toHaveLength(4);
		expect(notices(events).at(-1)).toContain("no other model");
		session.dispose();
	});

	it("can be turned off: failover.enabled false retries the routed model only", async () => {
		const { session, events } = await openSession({ settings: { failover: { enabled: false } } });
		scripts[GLM] = Array.from({ length: 10 }, () => ({ error: "503 Service Unavailable" }));
		await session.prompt("a hard task");
		expect(turns().map((entry) => entry.model)).toEqual([GLM, GLM, GLM, GLM]);
		expect(notices(events).at(-1)).toContain("failover is off");
		session.dispose();
	});

	it("summarizes on the session's warm prefix: the session model, its exact last request, tools off", async () => {
		const { session } = await openSession({ settings: { compaction: { keepRecentTokens: 1 } } });
		await session.prompt("a hard task");
		await session.prompt("a second hard task");
		await session.compact();
		const lastTurn = sent.filter((entry) => entry.kind === "turn").at(-1);
		const summary = sent.filter((entry) => entry.kind === "summary").at(-1);
		// GLM has no "off": the lowest level it accepts.
		expect([summary?.model, summary?.reasoning]).toEqual([GLM, "low"]);
		expect(lastTurn?.transcript.length).toBeGreaterThan(1);
		expect(summary?.transcript.slice(0, lastTurn!.transcript.length)).toEqual(lastTurn?.transcript);
		expect(summary?.transcript.at(-1)).toContain("Stop working on the task now");
		session.dispose();
	});

	it("sends side tasks to DeepSeek with thinking off (title, compaction), GLM low when DeepSeek is down", async () => {
		const { session, router } = await openSession({
			settings: { compaction: { keepRecentTokens: 1, reuseSessionPrefix: false } },
		});
		await session.prompt("a hard task");
		await session.prompt("a second hard task");
		await new Promise((resolve) => setTimeout(resolve, 20));
		const title = sent.find((entry) => entry.kind === "title");
		expect([title?.model, title?.reasoning]).toEqual([DS, undefined]);

		await session.compact();
		const summary = sent.filter((entry) => entry.kind === "summary").at(-1);
		expect([summary?.model, summary?.reasoning]).toEqual([DS, undefined]);

		router.health.markFailed(DS, "503");
		await session.prompt("a third hard task");
		await session.compact();
		const fallback = sent.filter((entry) => entry.kind === "summary").at(-1);
		expect([fallback?.model, fallback?.reasoning]).toEqual([GLM, "low"]);
		session.dispose();
	});
});
