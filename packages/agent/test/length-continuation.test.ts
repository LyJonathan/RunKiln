import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	type Message,
	type Model,
	type UserMessage,
} from "@runkiln/ai";
import { describe, expect, it } from "vitest";
import { LENGTH_CONTINUATION_PROMPT, runAgentLoop, shouldContinueTruncatedResponse } from "../src/agent-loop.ts";
import type { AgentContext, AgentEvent, AgentLoopConfig, AgentMessage, StreamFn } from "../src/types.ts";

function usage(output: number, input = 100) {
	return {
		input,
		output,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input + output,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

const model: Model<"openai-completions"> = {
	id: "mock",
	name: "mock",
	api: "openai-completions",
	provider: "runinfra",
	baseUrl: "https://example.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 10_000,
	maxTokens: 64,
};

function reply(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"],
	output = 64,
	input = 100,
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-completions",
		provider: "runinfra",
		model: "mock",
		usage: usage(output, input),
		stopReason,
		timestamp: Date.now(),
	};
}

const text = (t: string) => ({ type: "text" as const, text: t });

/** A stream function that answers with the scripted replies in order and records each request. */
function scripted(replies: AssistantMessage[]) {
	const requests: Message[][] = [];
	const streamFn: StreamFn = (_model, context) => {
		requests.push(context.messages.slice());
		const next = replies.shift();
		if (!next) throw new Error("unexpected extra request");
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() => stream.push({ type: "done", reason: next.stopReason as "stop", message: next }));
		return stream;
	};
	return { streamFn, requests, remaining: () => replies.length };
}

function identity(messages: AgentMessage[]): Message[] {
	return messages as Message[];
}

async function run(replies: AssistantMessage[], extra: Partial<AgentLoopConfig> = {}) {
	const script = scripted(replies);
	const context: AgentContext = { messages: [], tools: [] };
	const events: AgentEvent[] = [];
	const prompt: UserMessage = { role: "user", content: "Write the essay.", timestamp: Date.now() };
	const config: AgentLoopConfig = { model, convertToLlm: identity, ...extra };
	const messages = await runAgentLoop(
		[prompt],
		context,
		config,
		(event) => {
			events.push(event);
		},
		undefined,
		script.streamFn,
	);
	return { ...script, messages, events };
}

describe("continuing an answer cut off at the output token limit", () => {
	it("asks for the rest after a length stop and ends when the answer completes", async () => {
		const { requests, messages } = await run([
			reply([text("Part one, ")], "length"),
			reply([text("part two.")], "stop", 10),
		]);
		expect(requests).toHaveLength(2);
		// The second request repeats the first byte for byte, then appends the cut answer and the ask.
		expect(requests[1].slice(0, requests[0].length)).toEqual(requests[0]);
		const ask = requests[1].at(-1) as UserMessage;
		expect(ask.role).toBe("user");
		expect(ask.content).toBe(LENGTH_CONTINUATION_PROMPT);
		const last = messages.at(-1) as AssistantMessage;
		expect(last.stopReason).toBe("stop");
		expect(last.content).toEqual([text("part two.")]);
	});

	it("stops after two continuations and leaves the last message as a length stop", async () => {
		const { requests, messages, remaining } = await run([
			reply([text("a")], "length"),
			reply([text("b")], "length"),
			reply([text("c")], "length"),
			reply([text("never requested")], "stop"),
		]);
		expect(requests).toHaveLength(3);
		expect(remaining()).toBe(1);
		expect((messages.at(-1) as AssistantMessage).stopReason).toBe("length");
		expect(messages.filter((m) => m.role === "user" && m.content === LENGTH_CONTINUATION_PROMPT)).toHaveLength(2);
	});

	it("honours maxLengthContinuations and a host-supplied continuation message", async () => {
		const disabled = await run([reply([text("a")], "length")], { maxLengthContinuations: 0 });
		expect(disabled.requests).toHaveLength(1);

		const custom = await run([reply([text("a")], "length"), reply([text("b")], "stop", 5)], {
			maxLengthContinuations: 1,
			createLengthContinuationMessage: (_truncated, attempt) => ({
				role: "user",
				content: `continue #${attempt}`,
				timestamp: 0,
			}),
		});
		expect(custom.requests).toHaveLength(2);
		expect((custom.requests[1].at(-1) as UserMessage).content).toBe("continue #1");
	});

	it("does not continue tool calls, empty replies, or a context window that is full", () => {
		const toolCall = reply([{ type: "toolCall", id: "t1", name: "read", arguments: {} }], "length");
		expect(shouldContinueTruncatedResponse(toolCall, 0, 2, 10_000)).toBe(false);
		expect(shouldContinueTruncatedResponse(reply([], "length", 0), 0, 2, 10_000)).toBe(false);
		expect(shouldContinueTruncatedResponse(reply([text("x")], "length", 64, 9_900), 0, 2, 10_000)).toBe(false);
		expect(shouldContinueTruncatedResponse(reply([text("x")], "stop"), 0, 2, 10_000)).toBe(false);
		expect(shouldContinueTruncatedResponse(reply([text("x")], "length"), 0, 2, 10_000)).toBe(true);
	});
});
