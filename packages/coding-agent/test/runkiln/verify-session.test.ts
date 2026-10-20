import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
} from "@runkiln/ai/compat";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionUIContext } from "../../src/core/extensions/types.ts";
import type { ModelRuntime } from "../../src/core/model-runtime.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { setEditMetricsLogPath } from "../../src/core/verify/edit-metrics.ts";
import { VERIFY_FAILURE_TYPE } from "../../src/core/verify/verify-loop.ts";

/**
 * The verify loop as the session runs it: when a run that wrote files is about to settle, the test command runs;
 * a failure goes back to the model as a hidden follow-up in the same prompt() call, and the loop ends when the
 * tests pass.
 */
describe("verify loop in a session", () => {
	let root: string;
	let agentDir: string;
	let projectDir: string;
	let faux: FauxProviderRegistration;
	/** The text of every user/custom message the model was sent, per request. */
	let seen: string[][];

	const runtime = {
		getModelById: () => undefined,
		hasConfiguredAuth: () => true,
		streamSimple: (model: Model<Api>, context: Context, options?: SimpleStreamOptions) =>
			streamSimple(model, context, options),
	} as unknown as ModelRuntime;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "runkiln-verify-session-"));
		agentDir = join(root, "agent");
		projectDir = join(root, "project");
		for (const dir of [agentDir, projectDir]) mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(projectDir, "check.js"),
			'const fs=require("fs");const v=fs.existsSync("value.txt")?fs.readFileSync("value.txt","utf8").trim():"";' +
				'if(v==="4"){console.log("1 passing");process.exit(0)}' +
				'console.log("AssertionError: expected "+v+" to equal 4");console.log("  1 failing");process.exit(1);',
		);
		seen = [];
		faux = registerFauxProvider();
		setEditMetricsLogPath(false);
	});

	afterEach(() => {
		faux.unregister();
		setEditMetricsLogPath(undefined);
		rmSync(root, { recursive: true, force: true });
	});

	function record(step: ReturnType<typeof fauxAssistantMessage>) {
		return (context: { messages: Array<{ role: string; content: unknown }> }) => {
			seen.push(
				context.messages
					.filter((message) => message.role === "user")
					.map((message) =>
						typeof message.content === "string"
							? message.content
							: (message.content as Array<{ type: string; text?: string }>)
									.map((part) => part.text ?? "")
									.join(""),
					),
			);
			return step;
		};
	}

	async function openSession(settings: object) {
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify(settings));
		const { session } = await createAgentSession({
			cwd: projectDir,
			agentDir,
			modelRuntime: runtime,
			model: faux.getModel(),
			sessionManager: SessionManager.inMemory(projectDir),
			thinkingLevel: "off",
		});
		session.setActiveToolsByName(["read", "write", "edit"]);
		const select = vi.fn(async (_title: string, options: string[]) => options[0]);
		const notify = vi.fn();
		const ui = { select, notify, setWorkingMessage: vi.fn(), setStatus: vi.fn() } as unknown as ExtensionUIContext;
		await session.bindExtensions({ uiContext: ui, mode: "tui" });
		return { session, select, notify };
	}

	it("feeds a failing run back to the model and stops once the tests pass", async () => {
		const { session, notify } = await openSession({
			permissions: { mode: "allow-all" },
			verify: { mode: "auto", command: "node check.js" },
		});
		faux.setResponses([
			record(
				fauxAssistantMessage([fauxToolCall("write", { path: "value.txt", content: "3" })], {
					stopReason: "toolUse",
				}),
			),
			record(fauxAssistantMessage("Done.")),
			record(
				fauxAssistantMessage([fauxToolCall("write", { path: "value.txt", content: "4" })], {
					stopReason: "toolUse",
				}),
			),
			record(fauxAssistantMessage("Fixed.")),
		]);

		await session.prompt("make the value right");

		const custom = session.messages.filter((m) => m.role === "custom");
		expect(custom).toHaveLength(1);
		expect(custom[0]).toMatchObject({ customType: VERIFY_FAILURE_TYPE, display: false });
		// The third request carried the failure to the model.
		expect(seen[2].at(-1)).toContain("The tests fail after your changes (`node check.js`, exit code 1, 1 failing)");
		expect(seen[2].at(-1)).toContain("AssertionError: expected 3 to equal 4");
		expect(seen).toHaveLength(4);
		expect(session.verify.marker).toBe("✓ tests");
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("retry 1/2"), "info");
		session.dispose();
	});

	it("does not run tests for a turn that changed no files, nor in plan mode", async () => {
		const { session } = await openSession({ verify: { mode: "auto", command: "node check.js" } });
		faux.setResponses([record(fauxAssistantMessage("Nothing to change."))]);
		await session.prompt("hello");
		expect(session.verify.status.state).toBe("idle");
		session.dispose();
	});

	it("gives up after verify.maxRetries hidden follow-ups", async () => {
		const { session, notify } = await openSession({
			permissions: { mode: "allow-all" },
			verify: { mode: "auto", command: "node check.js", maxRetries: 1 },
		});
		faux.setResponses([
			record(
				fauxAssistantMessage([fauxToolCall("write", { path: "value.txt", content: "1" })], {
					stopReason: "toolUse",
				}),
			),
			record(fauxAssistantMessage("Done.")),
			record(
				fauxAssistantMessage([fauxToolCall("write", { path: "value.txt", content: "2" })], {
					stopReason: "toolUse",
				}),
			),
			record(fauxAssistantMessage("Tried.")),
		]);
		await session.prompt("make the value right");
		expect(session.messages.filter((m) => m.role === "custom")).toHaveLength(1);
		expect(seen).toHaveLength(4);
		expect(session.verify.marker).toBe("✗ 1 failing ↻1");
		expect(notify).toHaveBeenLastCalledWith(expect.stringContaining("after 1 automatic retries"), "warning");
		session.dispose();
	});
});
