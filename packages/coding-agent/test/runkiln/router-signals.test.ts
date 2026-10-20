import { describe, expect, it } from "vitest";
import { extractTurnSignals, type SignalMessage } from "../../src/core/router/signals.ts";

const user = (content: unknown): SignalMessage => ({ role: "user", content });
const assistant = (content: unknown, extra: Partial<SignalMessage> = {}): SignalMessage => ({
	role: "assistant",
	content,
	stopReason: "toolUse",
	model: "glm-5-3-flash",
	...extra,
});
const call = (id: string, name: string, args: Record<string, unknown>) => ({
	type: "toolCall",
	id,
	name,
	arguments: args,
});
const result = (toolCallId: string, text: string, isError = false): SignalMessage => ({
	role: "toolResult",
	toolCallId,
	content: [{ type: "text", text }],
	isError,
});

describe("router turn signals", () => {
	it("marks a new user turn and reads its text and images", () => {
		const signals = extractTurnSignals(
			[
				user("earlier question"),
				assistant([{ type: "text", text: "earlier answer" }], { stopReason: "stop" }),
				user([
					{ type: "text", text: "what is in this screenshot?" },
					{ type: "image", data: "", mimeType: "image/png" },
				]),
			],
			{ contextTokens: 4321 },
		);
		expect(signals.isNewUserTurn).toBe(true);
		expect(signals.latestUserText).toBe("what is in this screenshot?");
		expect(signals.hasImages).toBe(true);
		expect(signals.recentContext).toBe("user: earlier question\nassistant: earlier answer");
		expect(signals.warmModelId).toBe("glm-5-3-flash");
		expect(signals.contextTokens).toBe(4321);
		expect(signals.toolCallsThisTurn).toBe(0);
	});

	it("counts tool calls, errors, failing tests and edited files since the last user message", () => {
		const signals = extractTurnSignals(
			[
				user("make the tests pass"),
				assistant([
					call("1", "edit", { path: "src/a.ts" }),
					call("2", "write", { path: "src/b.ts" }),
					call("3", "edit", { path: "src/a.ts" }),
				]),
				result("1", "ok"),
				result("2", "ok"),
				result("3", "old text not found", true),
				assistant([call("4", "bash", { command: "npx vitest --run" })]),
				result("4", "Test Files  1 failed | 3 passed"),
				assistant([call("5", "bash", { command: "ls" })]),
				result("5", "FAILED.txt"),
			],
			{ contextTokens: 0 },
		);
		expect(signals.isNewUserTurn).toBe(false);
		expect(signals.toolCallsThisTurn).toBe(5);
		expect(signals.toolErrorsThisTurn).toBe(1);
		// Only test commands count, and "ls" printing FAILED.txt is not a test failure.
		expect(signals.testFailuresThisTurn).toBe(1);
		expect(signals.filesTouchedThisTurn).toBe(2);
	});

	it("does not count passing test output", () => {
		const signals = extractTurnSignals(
			[
				user("run tests"),
				assistant([call("1", "bash", { command: "npm test" })]),
				result("1", "Tests 12 passed, 0 failed"),
			],
			{ contextTokens: 0 },
		);
		expect(signals.testFailuresThisTurn).toBe(0);
	});

	it("notices when the user says the last attempt failed", () => {
		for (const text of [
			"it still fails",
			"That doesn't work",
			"same error again",
			"try again please",
			"ça ne marche pas",
		]) {
			expect(extractTurnSignals([user(text)], { contextTokens: 0 }).userRetry).toBe(true);
		}
		expect(extractTurnSignals([user("add a feature")], { contextTokens: 0 }).userRetry).toBe(false);
	});

	it("skips failed replies when finding the warm model", () => {
		const signals = extractTurnSignals(
			[
				user("hi"),
				assistant([{ type: "text", text: "hello" }], { stopReason: "stop", model: "deepseek-v4-1-flash" }),
				user("next"),
				assistant([], { stopReason: "error", model: "glm-5-3-flash" }),
			],
			{ contextTokens: 0 },
		);
		expect(signals.warmModelId).toBe("deepseek-v4-1-flash");
	});
});
