import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
} from "@runkiln/ai/compat";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionUIContext, ToolDefinition } from "../../src/core/extensions/types.ts";
import type { ModelRuntime } from "../../src/core/model-runtime.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";

/**
 * The approval gate as the session runs it: tool calls the model makes go through AgentSession's
 * beforeToolCall hook, so a refused call never reaches the UI and an asked call runs only after a yes.
 */
describe("approval gate on the session's tool calls", () => {
	let root: string;
	let agentDir: string;
	let projectDir: string;
	let sessionDir: string;
	let faux: FauxProviderRegistration;
	/** Patches the apply_patch test tool actually ran. */
	let patches: string[];
	/** Calls the shadowing test tools actually ran, as "name:path". */
	let runs: string[];

	// The faux provider needs no credentials, and this runtime only routes streams to it.
	const runtime = {
		getModelById: () => undefined,
		hasConfiguredAuth: () => true,
		streamSimple: (model: Model<Api>, context: Context, options?: SimpleStreamOptions) =>
			streamSimple(model, context, options),
	} as unknown as ModelRuntime;

	/** A tool no built-in uses, registered the way an SDK or extension tool is. */
	const applyPatch: ToolDefinition = {
		name: "apply_patch",
		label: "apply_patch",
		description: "Apply a patch to the project.",
		parameters: Type.Object({ patch: Type.String() }),
		async execute(_toolCallId, params: { patch: string }) {
			patches.push(params.patch);
			return { content: [{ type: "text", text: "patched" }], details: undefined };
		},
	};

	/** A custom tool that takes a built-in name, as an SDK or extension tool can. It records what it ran. */
	function shadowTool(name: string): ToolDefinition {
		return {
			name,
			label: name,
			description: `A replacement for the built-in ${name} tool.`,
			parameters: Type.Object({ path: Type.String(), content: Type.Optional(Type.String()) }),
			async execute(_toolCallId, params: { path: string }) {
				runs.push(`${name}:${params.path}`);
				return { content: [{ type: "text", text: "replacement ran" }], details: undefined };
			},
		};
	}

	/** A custom tool that calls read through ctx.executeTool, so the nested call goes through the same gate. */
	const outerTool: ToolDefinition = {
		name: "outer",
		label: "outer",
		description: "Calls read through executeTool.",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const outcome = await ctx.executeTool("read", { path: "package.json" });
			const text = outcome.isError ? "nested blocked" : "nested ran";
			return { content: [{ type: "text", text }], details: undefined };
		},
	};

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "runkiln-gate-"));
		agentDir = join(root, "agent");
		projectDir = join(root, "project");
		sessionDir = join(root, "sessions");
		for (const dir of [agentDir, projectDir, sessionDir]) mkdirSync(dir, { recursive: true });
		writeFileSync(join(projectDir, "package.json"), "{}");
		patches = [];
		runs = [];
		faux = registerFauxProvider();
	});

	afterEach(() => {
		faux.unregister();
		rmSync(root, { recursive: true, force: true });
	});

	async function openSession(customTools: ToolDefinition[] = [applyPatch]) {
		const result = await createAgentSession({
			cwd: projectDir,
			agentDir,
			modelRuntime: runtime,
			model: faux.getModel(),
			sessionManager: SessionManager.create(projectDir, sessionDir),
			thinkingLevel: "off",
			customTools,
		});
		const session = result.session;
		session.setActiveToolsByName(["read", "write", ...customTools.map((tool) => tool.name)]);
		return session;
	}

	/**
	 * A UI whose approval prompt answers `answer` (allow once or deny), or answers per title. The session asks through
	 * the UI's select dialog (title on the first line, then the message); `confirm` records every prompt as
	 * (title, message).
	 */
	function attachUI(answer: boolean | ((title: string) => boolean)) {
		const confirm = vi.fn(async (title: string, _message: string, _opts?: unknown) =>
			typeof answer === "function" ? answer(title) : answer,
		);
		const select = vi.fn(async (text: string, options: string[]) => {
			const [title, ...rest] = text.split("\n");
			const yes = await confirm(title, rest.join("\n"));
			return yes ? options[0] : options.find((option) => option === "Deny");
		});
		return { confirm, select, ui: { confirm, select } as unknown as ExtensionUIContext };
	}

	/** The model asks for one tool call, then ends the turn. */
	function scriptToolCall(name: string, args: Record<string, string>) {
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
	}

	function toolResultFor(messages: readonly { role: string }[], toolName: string): ToolResultMessage {
		const result = messages.find(
			(message): message is ToolResultMessage =>
				message.role === "toolResult" && "toolName" in message && message.toolName === toolName,
		);
		if (!result) throw new Error(`no result for ${toolName}`);
		return result;
	}

	function resultText(result: ToolResultMessage): string {
		return result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
	}

	it("refuses a write to a Windows alias name without asking, and leaves the file alone", async () => {
		const session = await openSession();
		const { confirm, ui } = attachUI(true);
		await session.bindExtensions({ uiContext: ui, mode: "tui" });
		scriptToolCall("write", { path: "package.json.", content: "changed" });

		await session.prompt("overwrite the manifest");

		expect(confirm).not.toHaveBeenCalled();
		const result = toolResultFor(session.messages, "write");
		expect(result.isError).toBe(true);
		expect(resultText(result)).toBe(
			'Not run: Refused: path segment "package.json." ends in a dot; ' +
				"Windows would write a different file than the one named.",
		);
		expect(readFileSync(join(projectDir, "package.json"), "utf8")).toBe("{}");
		session.dispose();
	});

	it("asks before a tool outside the built-in set runs, and does not run it when declined", async () => {
		const session = await openSession();
		const { confirm, ui } = attachUI(false);
		await session.bindExtensions({ uiContext: ui, mode: "tui" });
		scriptToolCall("apply_patch", { patch: "*** Update File: src/a.ts" });

		await session.prompt("patch it");

		expect(confirm).toHaveBeenCalledTimes(1);
		const [title, message] = confirm.mock.calls[0] as unknown as [string, string];
		expect(title).toBe("Allow apply_patch?");
		expect(message).toContain("src/a.ts");
		expect(patches).toEqual([]);
		const result = toolResultFor(session.messages, "apply_patch");
		expect(result.isError).toBe(true);
		expect(resultText(result)).toContain("the user denied this apply_patch call");
		session.dispose();
	});

	it("runs an outside-the-built-in-set tool once the user says yes", async () => {
		const session = await openSession();
		const { confirm, ui } = attachUI(true);
		await session.bindExtensions({ uiContext: ui, mode: "tui" });
		scriptToolCall("apply_patch", { patch: "*** Update File: src/a.ts" });

		await session.prompt("patch it");

		expect(confirm).toHaveBeenCalledTimes(1);
		expect(patches).toEqual(["*** Update File: src/a.ts"]);
		expect(toolResultFor(session.messages, "apply_patch").isError).toBe(false);
		session.dispose();
	});

	describe("a custom tool that takes a built-in name", () => {
		it("asks for a custom read and does not run it when declined", async () => {
			const session = await openSession([shadowTool("read")]);
			const { confirm, ui } = attachUI(false);
			await session.bindExtensions({ uiContext: ui, mode: "tui" });
			scriptToolCall("read", { path: "package.json" });

			await session.prompt("show the manifest");

			expect(confirm).toHaveBeenCalledTimes(1);
			expect((confirm.mock.calls[0] as unknown as [string])[0]).toBe("Allow read (replaces a built-in tool)?");
			expect(runs).toEqual([]);
			const result = toolResultFor(session.messages, "read");
			expect(result.isError).toBe(true);
			expect(resultText(result)).toContain("the user denied this read call");
			session.dispose();
		});

		it("runs a custom read once the user says yes", async () => {
			const session = await openSession([shadowTool("read")]);
			const { confirm, ui } = attachUI(true);
			await session.bindExtensions({ uiContext: ui, mode: "tui" });
			scriptToolCall("read", { path: "package.json" });

			await session.prompt("show the manifest");

			expect(confirm).toHaveBeenCalledTimes(1);
			expect(runs).toEqual(["read:package.json"]);
			expect(toolResultFor(session.messages, "read").isError).toBe(false);
			session.dispose();
		});

		it.each(["grep", "find", "ls"])("asks for a custom %s and does not run it when declined", async (name) => {
			const session = await openSession([shadowTool(name)]);
			const { confirm, ui } = attachUI(false);
			await session.bindExtensions({ uiContext: ui, mode: "tui" });
			scriptToolCall(name, { path: "src" });

			await session.prompt("list it");

			expect(confirm).toHaveBeenCalledTimes(1);
			expect((confirm.mock.calls[0] as unknown as [string])[0]).toBe(`Allow ${name} (replaces a built-in tool)?`);
			expect(runs).toEqual([]);
			session.dispose();
		});

		it("asks for a custom write even for a path inside the project", async () => {
			const session = await openSession([shadowTool("write")]);
			const { confirm, ui } = attachUI(false);
			await session.bindExtensions({ uiContext: ui, mode: "tui" });
			scriptToolCall("write", { path: "src/a.ts" });

			await session.prompt("write it");

			expect(confirm).toHaveBeenCalledTimes(1);
			expect(runs).toEqual([]);
			expect(readFileSync(join(projectDir, "package.json"), "utf8")).toBe("{}");
			session.dispose();
		});

		it("gives a nested call to a custom read the same prompt, and does not run it when declined", async () => {
			const session = await openSession([outerTool, shadowTool("read")]);
			const { confirm, ui } = attachUI((title) => title === "Allow outer?");
			await session.bindExtensions({ uiContext: ui, mode: "tui" });
			scriptToolCall("outer", {});

			await session.prompt("read through outer");

			expect(confirm.mock.calls.map((call) => call[0])).toEqual([
				"Allow outer?",
				"Allow read (replaces a built-in tool)?",
			]);
			expect(runs).toEqual([]);
			expect(resultText(toolResultFor(session.messages, "outer"))).toBe("nested blocked");
			session.dispose();
		});

		it("runs a nested call to the built-in read without asking", async () => {
			const session = await openSession([outerTool]);
			const { confirm, ui } = attachUI((title) => title === "Allow outer?");
			await session.bindExtensions({ uiContext: ui, mode: "tui" });
			scriptToolCall("outer", {});

			await session.prompt("read through outer");

			expect(confirm.mock.calls.map((call) => call[0])).toEqual(["Allow outer?"]);
			expect(resultText(toolResultFor(session.messages, "outer"))).toBe("nested ran");
			session.dispose();
		});
	});

	it("runs read without asking", async () => {
		const session = await openSession();
		const { confirm, ui } = attachUI(false);
		await session.bindExtensions({ uiContext: ui, mode: "tui" });
		scriptToolCall("read", { path: "package.json" });

		await session.prompt("show the manifest");

		expect(confirm).not.toHaveBeenCalled();
		expect(toolResultFor(session.messages, "read").isError).toBe(false);
		session.dispose();
	});
});
