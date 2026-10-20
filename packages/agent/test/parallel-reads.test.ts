import { type AssistantMessage, createAssistantMessageEventStream, type Message, type Model } from "@runkiln/ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { agentLoop, groupToolCalls } from "../src/agent-loop.ts";
import type { AgentContext, AgentMessage, AgentTool, ToolExecutionMode } from "../src/types.ts";

const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const model: Model<"openai-responses"> = {
	id: "mock",
	name: "mock",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://example.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 8192,
	maxTokens: 2048,
};

function assistant(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage,
		stopReason,
		timestamp: Date.now(),
	};
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("groupToolCalls", () => {
	const modes: Record<string, ToolExecutionMode | undefined> = {
		read: "parallel",
		grep: "parallel",
		bash: "sequential",
		edit: "sequential",
		ext: undefined,
	};
	const group = (names: string[]) =>
		groupToolCalls(names, (name) => modes[name]).map((g) => `${g.sequential ? "S" : "P"}(${g.calls.join(",")})`);

	it("keeps runs of parallel calls together and puts each sequential call on its own", () => {
		expect(group(["read", "grep", "read"])).toEqual(["P(read,grep,read)"]);
		expect(group(["read", "read", "edit", "read", "bash", "bash"])).toEqual([
			"P(read,read)",
			"S(edit)",
			"P(read)",
			"S(bash)",
			"S(bash)",
		]);
		expect(group(["ext", "read"])).toEqual(["P(ext,read)"]);
		expect(group([])).toEqual(["P()"]);
	});
});

describe("read-only calls run concurrently, writes and shell stay in order", () => {
	it("overlaps the reads, waits for them before the write, and runs the write alone", async () => {
		const log: string[] = [];
		let inFlight = 0;
		let maxReads = 0;
		const schema = Type.Object({ id: Type.String() });
		const tool = (name: string, executionMode: ToolExecutionMode, ms: number): AgentTool<typeof schema> => ({
			name,
			label: name,
			description: name,
			parameters: schema,
			executionMode,
			async execute(_id, params) {
				inFlight++;
				if (executionMode === "parallel") maxReads = Math.max(maxReads, inFlight);
				else expect(inFlight).toBe(1);
				log.push(`start ${params.id}`);
				await sleep(ms);
				log.push(`end ${params.id}`);
				inFlight--;
				return { content: [{ type: "text", text: params.id }], details: undefined };
			},
		});
		const context: AgentContext = {
			messages: [],
			tools: [tool("read", "parallel", 30), tool("write", "sequential", 5), tool("bash", "sequential", 5)],
		};
		const calls = [
			{ type: "toolCall" as const, id: "1", name: "read", arguments: { id: "r1" } },
			{ type: "toolCall" as const, id: "2", name: "read", arguments: { id: "r2" } },
			{ type: "toolCall" as const, id: "3", name: "read", arguments: { id: "r3" } },
			{ type: "toolCall" as const, id: "4", name: "write", arguments: { id: "w1" } },
			{ type: "toolCall" as const, id: "5", name: "bash", arguments: { id: "b1" } },
		];
		let request = 0;
		const started = Date.now();
		const stream = agentLoop(
			[{ role: "user", content: [{ type: "text", text: "go" }], timestamp: Date.now() }],
			context,
			{ model, convertToLlm: (messages: AgentMessage[]) => messages as Message[] },
			undefined,
			() => {
				const out = createAssistantMessageEventStream();
				queueMicrotask(() => {
					const message =
						request++ === 0 ? assistant(calls, "toolUse") : assistant([{ type: "text", text: "done" }], "stop");
					out.push({ type: "done", reason: message.stopReason === "toolUse" ? "toolUse" : "stop", message });
					out.end();
				});
				return out;
			},
		);
		const results: string[] = [];
		for await (const event of stream) {
			if (event.type === "message_end" && event.message.role === "toolResult")
				results.push(event.message.toolCallId);
		}
		expect(maxReads).toBe(3);
		// Reads overlapped: three 30 ms reads took about one read's time, not three.
		expect(Date.now() - started).toBeLessThan(85);
		expect(log.slice(0, 3).sort()).toEqual(["start r1", "start r2", "start r3"]);
		expect(log.slice(6)).toEqual(["start w1", "end w1", "start b1", "end b1"]);
		// Results keep the call order.
		expect(results).toEqual(["1", "2", "3", "4", "5"]);
	});
});
