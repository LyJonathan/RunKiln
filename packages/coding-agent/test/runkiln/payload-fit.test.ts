/**
 * RunInfra caps a request body at 3.5 MB (413 payload_too_large). Every image in the transcript is re-sent with each
 * request, so a few screenshots used to make every request fail, and the router switched models on each 413.
 * Covers: the read tool's image downscale, the per-request fit (older images stubbed, oldest first), the 413 retry
 * on the same model (never a fallback), the one-line message, and /compact in that state.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	createAssistantMessageEventStream,
	type ImageContent,
	type Message,
	type Model,
	type ToolCall,
} from "@runkiln/ai";
import type { Context, SimpleStreamOptions } from "@runkiln/ai/compat";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../../src/config.ts";
import type { AgentSessionEvent } from "../../src/core/agent-session.ts";
import type { ModelRuntime } from "../../src/core/model-runtime.ts";
import { parseRouterCatalog } from "../../src/core/router/catalog.ts";
import { createAutoModels } from "../../src/core/router/index.ts";
import { ModelRouter } from "../../src/core/router/router.ts";
import {
	createRequestFitState,
	fitRequestSize,
	imageDimensions,
	isPayloadTooLargeError,
	PAYLOAD_TOO_LARGE_FINAL,
	REQUEST_FIT_TARGET_BYTES,
} from "../../src/core/runkiln/request-fit.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { createReadTool } from "../../src/core/tools/read.ts";
import { classification, MockClassifier, TEST_ROUTER_YAML } from "./router-fixtures.ts";

/** RunInfra's max_request_bytes. */
const CAP = 3_670_016;
const GLM = "glm-5-3-flash";
const DS = "deepseek-v4-1-flash-1017";

/** A screenshot-like PNG: smooth bands with mild noise (several MB as PNG, a fraction of that as JPEG). */
function screenshotPng(width: number, height: number, seed: number): Buffer {
	const row = width * 3 + 1;
	const raw = Buffer.alloc(row * height);
	let state = seed * 2654435761;
	const noise = () => {
		state = (state * 1103515245 + 12345) >>> 0;
		return (state >>> 24) % 9;
	};
	for (let y = 0; y < height; y++) {
		raw[y * row] = 0;
		for (let x = 0; x < width; x++) {
			const o = y * row + 1 + x * 3;
			raw[o] = ((x * 255) / width + noise()) & 0xff;
			raw[o + 1] = ((y * 255) / height + noise()) & 0xff;
			raw[o + 2] = (((x + y + seed * 40) % 256) + noise()) & 0xff;
		}
	}
	const chunk = (type: string, data: Buffer) => {
		const length = Buffer.alloc(4);
		length.writeUInt32BE(data.length);
		const body = Buffer.concat([Buffer.from(type), data]);
		const crc = Buffer.alloc(4);
		crc.writeUInt32BE(crc32(body) >>> 0);
		return Buffer.concat([length, body, crc]);
	};
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	header[8] = 8;
	header[9] = 2;
	return Buffer.concat([
		Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
		chunk("IHDR", header),
		chunk("IDAT", deflateSync(raw, { level: 6 })),
		chunk("IEND", Buffer.alloc(0)),
	]);
}

let root: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "runkiln-payload-"));
	for (const dir of ["agent", "project", "sessions"]) mkdirSync(join(root, dir), { recursive: true });
	vi.stubEnv(ENV_AGENT_DIR, join(root, "agent"));
});
afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(root, { recursive: true, force: true });
});

function writeScreenshots(count: number): string[] {
	return Array.from({ length: count }, (_, i) => {
		const path = join(root, "project", `shot-${i + 1}.png`);
		writeFileSync(path, screenshotPng(2400, 1500, i + 1));
		return path;
	});
}

describe("read tool images", () => {
	it("downscales a large PNG screenshot to 1568 px and under 500 KB, and says the original size", async () => {
		const [path] = writeScreenshots(1);
		const tool = createReadTool(join(root, "project"));
		const result = await tool.execute("call-1", { path });
		const image = result.content.find((part) => part.type === "image") as ImageContent;
		const note = result.content.find((part) => part.type === "text")?.text ?? "";
		expect(image).toBeDefined();
		const dims = imageDimensions(image.data)!;
		expect(Math.max(dims.width, dims.height)).toBeLessThanOrEqual(1568);
		expect(image.data.length).toBeLessThanOrEqual(500 * 1024);
		expect(image.mimeType).toBe("image/jpeg");
		expect(note).toMatch(/original 2400x1500 \(\d+(\.\d)? MB\)/);
		expect(note).toContain(`displayed at ${dims.width}x${dims.height} JPEG`);
	}, 30_000);
});

function imageMessage(path: string, id: string, data: string): Message[] {
	return [
		{
			role: "assistant",
			content: [{ type: "toolCall", id, name: "read", arguments: { path } }],
			api: "openai-completions",
			provider: "runinfra",
			model: GLM,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: 1,
		},
		{
			role: "toolResult",
			toolCallId: id,
			toolName: "read",
			content: [
				{ type: "text", text: "Read image file [image/png]" },
				{ type: "image", data, mimeType: "image/png" },
			],
			isError: false,
			timestamp: 2,
		},
	];
}

describe("request fit", () => {
	// 1 MB of base64 behind a real PNG header (1920x1080), so the stub can name the size.
	const header = screenshotPng(1920, 1080, 9).subarray(0, 33);
	const bigImage = Buffer.concat([header, Buffer.alloc(750_000, 7)]).toString("base64");

	it("stubs older images oldest first, keeps the newest, names path and size, and stays stable", () => {
		const messages: Message[] = [
			{ role: "user", content: "look at these", timestamp: 0 },
			...Array.from({ length: 6 }, (_, i) => imageMessage(`shots/${i + 1}.png`, `c${i + 1}`, bigImage)).flat(),
		];
		const state = createRequestFitState();
		const first = fitRequestSize(messages, state);
		expect(first.bytes).toBeLessThanOrEqual(REQUEST_FIT_TARGET_BYTES);
		const kept = first.messages.flatMap((m, i) =>
			m.role === "toolResult" && m.content.some((p) => p.type === "image") ? [i] : [],
		);
		// The oldest go first until it fits (6 x 1 MB against 3.2 MB: three stay), the newest always stay, and the
		// transcript itself is untouched.
		expect(kept).toEqual([8, 10, 12]);
		expect(
			messages.filter((m) => m.role === "toolResult").every((m) => m.content.some((p) => p.type === "image")),
		).toBe(true);
		const stub = (first.messages[2] as Extract<Message, { role: "toolResult" }>).content[1];
		expect(stub).toEqual({ type: "text", text: "[image removed to fit request size: shots/1.png, 1920x1080]" });
		// The next request (one more short message) stubs the same images: the prefix does not move.
		const second = fitRequestSize([...messages, { role: "user", content: "next", timestamp: 9 }], state);
		expect(JSON.stringify(second.messages.slice(0, messages.length))).toBe(JSON.stringify(first.messages));
	});

	it("recognises RunInfra's 413", () => {
		expect(
			isPayloadTooLargeError('413 {"error":{"code":"payload_too_large","message":"Request body too large"}}'),
		).toBe(true);
		expect(isPayloadTooLargeError("503 Service Unavailable")).toBe(false);
	});
});

// ---------------------------------------------------------------------------------------------
// A session against a fake RunInfra that answers 413 over the cap
// ---------------------------------------------------------------------------------------------

type Reply = { text: string } | { toolCall: { name: string; args: ToolCall["arguments"] } } | { error: string };

function message(model: string, reply: Reply): AssistantMessage {
	const content: AssistantMessage["content"] = [];
	if ("text" in reply) content.push({ type: "text", text: reply.text });
	if ("toolCall" in reply) {
		content.push({
			type: "toolCall",
			id: `call-${Math.random().toString(36).slice(2)}`,
			name: reply.toolCall.name,
			arguments: reply.toolCall.args,
		});
	}
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
		stopReason: "error" in reply ? "error" : "toolCall" in reply ? "toolUse" : "stop",
		...("error" in reply ? { errorMessage: reply.error } : {}),
		timestamp: Date.now(),
	};
}

function replyStream(model: string, reply: Reply): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	const done = message(model, reply);
	queueMicrotask(() => {
		stream.push({ type: "start", partial: message(model, { text: "" }) });
		if ("error" in reply) stream.push({ type: "error", reason: "error", error: done });
		else stream.push({ type: "done", reason: "toolCall" in reply ? "toolUse" : "stop", message: done });
		stream.end();
	});
	return stream;
}

const TOO_LARGE = '413 {"error":{"code":"payload_too_large","message":"Request body exceeds 3670016 bytes"}}';

interface Sent {
	model: string;
	kind: "turn" | "title" | "summary";
	bytes: number;
	images: number;
}

async function openSession(options: {
	auto: boolean;
	scripts: Record<string, Reply[]>;
	always413?: boolean;
	/** Flip to make every later turn fail with 413 (a stuck session). */
	stuck?: { now: boolean };
}) {
	const sent: Sent[] = [];
	const model = (id: string) =>
		({
			id,
			name: id,
			api: "openai-completions",
			provider: "runinfra",
			baseUrl: "https://api.runinfra.ai/v1",
			reasoning: false,
			input: ["text", "image"],
			cost: { input: 0.12, output: 0.5, cacheRead: 0.03, cacheWrite: 0 },
			contextWindow: 1_048_576,
			maxTokens: 16_384,
		}) as Model<"openai-completions">;
	const models: Model<Api>[] = [model(GLM), model(DS)];
	const autoModels = createAutoModels(models);
	const runtime = {
		catalog: { defaults: { code: GLM, chat: DS, title: DS, fallback: [] } },
		autoModel: autoModels.medium,
		autoModelFor: (mode: "low" | "medium" | "high" = "medium") => autoModels[mode],
		getAvailableSnapshot: () => [...models, ...Object.values(autoModels)],
		getRoutableModels: () => models,
		getModelById: (id: string) => models.find((m) => m.id === id),
		hasConfiguredAuth: () => true,
		checkAuth: async () => ({ type: "api_key" }),
		getAuth: async () => ({ auth: { apiKey: "test" } }),
		isUsingOAuth: () => false,
		streamSimple: (m: Model<Api>, context: Context, streamOptions?: SimpleStreamOptions) => {
			const title = streamOptions?.sessionId?.endsWith(".title") === true;
			const summary = !title && streamOptions?.cacheRetention === "none";
			const bytes = Buffer.byteLength(JSON.stringify(context.messages));
			const images = context.messages
				.flatMap((entry) =>
					Array.isArray((entry as { content?: unknown }).content)
						? (entry as { content: { type: string }[] }).content
						: [],
				)
				.filter((part) => part.type === "image").length;
			sent.push({ model: m.id, kind: title ? "title" : summary ? "summary" : "turn", bytes, images });
			if (title) return replyStream(m.id, { text: "Payload test" });
			if (bytes > CAP) return replyStream(m.id, { error: TOO_LARGE });
			if (summary) return replyStream(m.id, { text: "## Goal\nsummary" });
			if (options.always413 || options.stuck?.now) return replyStream(m.id, { error: TOO_LARGE });
			return replyStream(m.id, options.scripts[m.id]?.shift() ?? { text: "ok" });
		},
	} as unknown as ModelRuntime;
	const router = new ModelRouter({
		catalog: parseRouterCatalog([
			{
				text: TEST_ROUTER_YAML.replace("  cheap:\n", `  ${DS}:\n`).replace("  strong:\n", `  ${GLM}:\n`),
				path: "r.yaml",
			},
		]),
		classifier: new MockClassifier(() => classification({ difficulty: 0.8 })),
		getModels: () => models,
		defaultModelId: () => GLM,
	});
	const { session } = await createAgentSession({
		cwd: join(root, "project"),
		agentDir: join(root, "agent"),
		modelRuntime: runtime,
		model: options.auto ? autoModels.medium : models[0],
		sessionManager: SessionManager.create(join(root, "project"), join(root, "sessions")),
		settingsManager: SettingsManager.inMemory({
			retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 },
			compaction: { keepRecentTokens: 200 },
		}),
		thinkingLevel: "off",
		permissionMode: "allow-all",
		router,
	});
	session.setActiveToolsByName(["read"]);
	const events: AgentSessionEvent[] = [];
	session.subscribe((event) => events.push(event));
	return { session, events, sent };
}

describe("a session with screenshots", () => {
	it("reads 6 large PNGs and every request stays under the cap", async () => {
		const paths = writeScreenshots(6);
		const scripts = {
			[GLM]: [...paths.map((path) => ({ toolCall: { name: "read", args: { path } } })), { text: "done" }],
		};
		const { session, sent } = await openSession({ auto: false, scripts });
		await session.prompt("compare the screenshots");
		const turns = sent.filter((entry) => entry.kind === "turn");
		expect(turns).toHaveLength(7);
		expect(Math.max(...turns.map((entry) => entry.bytes))).toBeLessThan(CAP);
		expect(turns.at(-1)!.images).toBeGreaterThan(0);
		const reads = session.messages.filter((m) => m.role === "toolResult");
		expect(reads).toHaveLength(6);
		for (const read of reads) {
			const image = (read as { content: ImageContent[] }).content.find((part) => part.type === "image")!;
			expect(image.data.length).toBeLessThanOrEqual(500 * 1024);
		}
	}, 120_000);

	it("retries a 413 once on the same model with a smaller request, never falls back, and says it in one line", async () => {
		const scripts = { [GLM]: [{ error: TOO_LARGE }, { text: "fine" }], [DS]: [] };
		const { session, events, sent } = await openSession({ auto: true, scripts });
		await session.prompt("hello");
		const turns = sent.filter((entry) => entry.kind === "turn");
		expect(turns.map((entry) => entry.model)).toEqual([GLM, GLM]);
		expect(events.some((event) => event.type === "model_fallback")).toBe(false);
		const last = session.messages.at(-1) as AssistantMessage;
		expect(last.stopReason).toBe("stop");

		// Failing again after the shrink: the run ends with one line, still no fallback.
		const again = await openSession({ auto: true, scripts: { [GLM]: [], [DS]: [] }, always413: true });
		await again.session.prompt("hello");
		expect(again.sent.filter((entry) => entry.kind === "turn").map((entry) => entry.model)).toEqual([GLM, GLM]);
		expect(again.events.some((event) => event.type === "model_fallback")).toBe(false);
		const final = again.session.messages.at(-1) as AssistantMessage;
		expect(final.errorMessage).toBe(PAYLOAD_TOO_LARGE_FINAL);
		expect(final.errorMessage).not.toContain("{");
	});

	it("/compact works while turns fail with 413: the summary request carries no image", async () => {
		const paths = writeScreenshots(2);
		const scripts = {
			[GLM]: [...paths.map((path) => ({ toolCall: { name: "read", args: { path } } })), { text: "seen" }],
		};
		const stuck = { now: false };
		const { session, sent } = await openSession({ auto: false, scripts, stuck });
		await session.prompt("look");
		stuck.now = true;
		await session.prompt("and now?");
		expect((session.messages.at(-1) as AssistantMessage).errorMessage).toBe(PAYLOAD_TOO_LARGE_FINAL);
		const result = await session.compact();
		expect(result.summary).toContain("summary");
		const summary = sent.find((entry) => entry.kind === "summary")!;
		expect(summary.images).toBe(0);
		expect(summary.bytes).toBeLessThan(CAP);
	}, 120_000);
});
