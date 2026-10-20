import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildOpenAICompletionsParams } from "@runkiln/ai/api/openai-completions";
import {
	type Api,
	type Context,
	type FauxProviderRegistration,
	fauxAssistantMessage,
	fauxToolCall,
	type Model,
	registerFauxProvider,
	type SimpleStreamOptions,
	streamSimple,
	type ToolResultMessage,
	type TranscriptContext,
} from "@runkiln/ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ModelRuntime } from "../../src/core/model-runtime.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";

/** The wire model the captured contexts are serialized for: RunInfra's Chat Completions API. */
const runInfraModel = {
	id: "glm-5-3-flash",
	name: "GLM 5.3 Flash",
	api: "openai-completions",
	provider: "runinfra",
	baseUrl: "https://api.runinfra.ai/v1",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0.11, output: 0.45, cacheRead: 0.03, cacheWrite: 0 },
	contextWindow: 1048576,
	maxTokens: 32768,
} as Model<"openai-completions">;

/**
 * Cache-first context: every request of a session must start with the previous request byte for
 * byte (system prompt, tool definitions, earlier messages), or RunInfra's prefix cache misses and the
 * whole prompt is billed at the full input price.
 */
describe("prompt prefix across turns", () => {
	let root: string;
	let projectDir: string;
	let faux: FauxProviderRegistration;
	/** The context of every request the session sent, in order. */
	let requests: TranscriptContext[];

	const runtime = {
		getModelById: () => undefined,
		hasConfiguredAuth: () => true,
		streamSimple: (model: Model<Api>, context: Context, options?: SimpleStreamOptions) =>
			streamSimple(model, context, options),
	} as unknown as ModelRuntime;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "runkiln-prefix-"));
		projectDir = join(root, "project");
		for (const dir of [join(root, "agent"), projectDir, join(root, "sessions")]) mkdirSync(dir, { recursive: true });
		writeFileSync(join(projectDir, "notes.txt"), "line one\nline two\n");
		requests = [];
		// A large window so long turns do not trigger auto-compaction mid-test.
		faux = registerFauxProvider({ models: [{ id: "faux-large", contextWindow: 1_000_000 }] });
	});

	afterEach(() => {
		faux.unregister();
		rmSync(root, { recursive: true, force: true });
	});

	async function openSession() {
		const { session } = await createAgentSession({
			cwd: projectDir,
			agentDir: join(root, "agent"),
			modelRuntime: runtime,
			model: faux.getModel(),
			sessionManager: SessionManager.create(projectDir, join(root, "sessions")),
			thinkingLevel: "off",
		});
		session.setActiveToolsByName(["read", "bash", "edit", "write"]);
		return session;
	}

	/** A scripted reply that also records the request context it answers. */
	function capture(reply: ReturnType<typeof fauxAssistantMessage>) {
		return (context: TranscriptContext) => {
			requests.push(structuredClone(context));
			return reply;
		};
	}

	function wire(context: TranscriptContext) {
		const params = buildOpenAICompletionsParams(runInfraModel, context);
		return {
			tools: JSON.stringify(params.tools ?? []),
			messages: params.messages.map((message) => JSON.stringify(message)),
		};
	}

	it("keeps the system prompt, the tools and the history byte-identical between two turns", async () => {
		const session = await openSession();
		faux.setResponses([
			capture(fauxAssistantMessage([fauxToolCall("read", { path: "notes.txt" })], { stopReason: "toolUse" })),
			capture(fauxAssistantMessage("It has two lines.")),
		]);
		await session.prompt("What is in notes.txt?");
		// Time passes between turns: nothing time-dependent may reach the prefix.
		await new Promise((resolve) => setTimeout(resolve, 20));
		faux.appendResponses([capture(fauxAssistantMessage("Done."))]);
		await session.prompt("Thanks, anything else?");

		expect(requests).toHaveLength(3);
		const [first, second, third] = requests.map(wire);
		expect(first.messages[0]).toContain("RunKiln");
		for (const [earlier, later] of [
			[first, second],
			[second, third],
		]) {
			expect(later.tools).toBe(earlier.tools);
			expect(later.messages.length).toBeGreaterThan(earlier.messages.length);
			expect(later.messages.slice(0, earlier.messages.length)).toEqual(earlier.messages);
		}
		// The tool definitions are serialized the same way every time: no reordered keys.
		expect(JSON.parse(third.tools).map((tool: { function: { name: string } }) => tool.function.name)).toEqual(
			JSON.parse(first.tools).map((tool: { function: { name: string } }) => tool.function.name),
		);
	});

	it("keeps the system prompt and tools as the cached prefix after compaction", async () => {
		const session = await openSession();
		// Long enough answers that compaction has older turns to summarize.
		const long = (label: string) => `${label} ${"word ".repeat(30_000)}`;
		faux.setResponses([capture(fauxAssistantMessage(long("First")))]);
		await session.prompt("Turn one");
		faux.appendResponses([capture(fauxAssistantMessage(long("Second")))]);
		await session.prompt("Turn two");
		faux.appendResponses([capture(fauxAssistantMessage(long("Third")))]);
		await session.prompt("Turn three");
		// The compaction's own summary requests (history and split-turn prefix), then a turn after it.
		faux.appendResponses([
			fauxAssistantMessage("## Summary\nTwo short turns."),
			fauxAssistantMessage("## Summary\nTwo short turns."),
		]);
		await session.compact();
		faux.setResponses([capture(fauxAssistantMessage("Fourth answer."))]);
		await session.prompt("Turn four");

		const before = wire(requests[2]);
		const after = wire(requests.at(-1) as TranscriptContext);
		expect(after.tools).toBe(before.tools);
		// Same leading system message: only the history after it is replaced by the summary.
		expect(after.messages[0]).toBe(before.messages[0]);
		expect(after.messages.join("\n")).toContain("Two short turns.");
	});

	it("re-reading an unchanged file returns a short stub; a change or another range reads it again", async () => {
		const session = await openSession();
		const readTurn = (args: Parameters<typeof fauxToolCall>[1]) => [
			fauxAssistantMessage([fauxToolCall("read", args)], { stopReason: "toolUse" }),
			fauxAssistantMessage("ok"),
		];
		const readResults = () =>
			session.messages.filter(
				(message): message is ToolResultMessage => message.role === "toolResult" && message.toolName === "read",
			);
		const text = (result: ToolResultMessage) =>
			result.content.map((part) => (part.type === "text" ? part.text : "")).join("");

		faux.setResponses(readTurn({ path: "notes.txt" }));
		await session.prompt("read it");
		faux.appendResponses(readTurn({ path: "notes.txt" }));
		await session.prompt("read it again");
		faux.appendResponses(readTurn({ path: "notes.txt", offset: 2 }));
		await session.prompt("just line two");
		writeFileSync(join(projectDir, "notes.txt"), "line one\nline 2 changed\n");
		faux.appendResponses(readTurn({ path: "notes.txt" }));
		await session.prompt("read it after the change");

		const [firstRead, repeat, otherRange, afterChange] = readResults();
		expect(text(firstRead)).toBe("line one\nline two\n");
		expect(text(repeat)).toMatch(/^\[notes\.txt is unchanged since an earlier read/);
		expect((repeat.details as { unchangedSinceEarlierRead?: boolean }).unchangedSinceEarlierRead).toBe(true);
		expect(text(otherRange)).toBe("line two\n");
		expect(text(afterChange)).toBe("line one\nline 2 changed\n");
	});
});
