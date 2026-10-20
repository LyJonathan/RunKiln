import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Api,
	type AssistantMessage,
	type Context,
	type FauxProviderRegistration,
	type FauxResponseStep,
	fauxAssistantMessage,
	type Model,
	registerFauxProvider,
	type SimpleStreamOptions,
	streamSimple,
	type TranscriptContext,
} from "@runkiln/ai/compat";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../../src/config.ts";
import type { ModelRuntime } from "../../src/core/model-runtime.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";

/** The title the faux title call answers with. */
const TITLE = "Fix the login null check";

/**
 * When the session title is requested. The faux provider records the answer's start and end and the
 * title call's start, in order, so each test can see whether the title overlapped the first answer.
 */
describe("session title timing", () => {
	let root: string;
	let agentDir: string;
	let projectDir: string;
	let sessionDir: string;
	let faux: FauxProviderRegistration;
	/** "answer:start", "answer:end" and "title:start", in the order they happened. */
	let timeline: string[];

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "runkiln-title-"));
		agentDir = join(root, "agent");
		projectDir = join(root, "project");
		sessionDir = join(root, "sessions");
		for (const dir of [agentDir, projectDir, sessionDir]) mkdirSync(dir, { recursive: true });
		// Per-call metrics are written under the agent dir; keep them out of the real one.
		vi.stubEnv(ENV_AGENT_DIR, agentDir);
		timeline = [];
		faux = registerFauxProvider();
	});

	afterEach(() => {
		faux.unregister();
		rmSync(root, { recursive: true, force: true });
	});

	/** The title call is routed to `<session id>.title` (see titleCallRouting). */
	function isTitleCall(options: SimpleStreamOptions | undefined): boolean {
		return options?.sessionId?.endsWith(".title") === true;
	}

	/**
	 * One faux response. A title call gets TITLE at once. A turn records its start, waits for `gate` when
	 * given, then records its end and gets `answer()`.
	 */
	function reply(answer: () => AssistantMessage, gate?: Promise<void>): FauxResponseStep {
		return async (_context: TranscriptContext, options?: SimpleStreamOptions) => {
			if (isTitleCall(options)) {
				timeline.push("title:start");
				return fauxAssistantMessage(TITLE);
			}
			timeline.push("answer:start");
			await gate;
			timeline.push("answer:end");
			return answer();
		};
	}

	/** A gate the test opens by calling the returned function. */
	function gateFor(): { gate: Promise<void>; open: () => void } {
		let open!: () => void;
		const gate = new Promise<void>((resolve) => {
			open = resolve;
		});
		return { gate, open };
	}

	/** Lets any stray background work start before the test checks what has been requested. */
	const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

	async function openSession(sessionManager = SessionManager.create(projectDir, sessionDir)) {
		const model = faux.getModel();
		// The title model (the chore model, deepseek-v4-1-flash-1017 by default) is the faux model, and the
		// streams go to the faux provider.
		const runtime = {
			catalog: { defaults: { code: model.id, chat: model.id, title: model.id, fallback: [] } },
			getModelById: (id: string) => (id === model.id || id === "deepseek-v4-1-flash-1017" ? model : undefined),
			hasConfiguredAuth: () => true,
			streamSimple: (m: Model<Api>, context: Context, options?: SimpleStreamOptions) =>
				streamSimple(m, context, options),
		} as unknown as ModelRuntime;
		const { session } = await createAgentSession({
			cwd: projectDir,
			agentDir,
			modelRuntime: runtime,
			model,
			sessionManager,
			thinkingLevel: "off",
		});
		return session;
	}

	it("requests the title only after the first answer has finished", async () => {
		const session = await openSession();
		const { gate, open } = gateFor();
		// The turn takes the first entry; the title call takes the second.
		faux.setResponses([
			reply(() => fauxAssistantMessage("The password check ran before the null check."), gate),
			reply(() => fauxAssistantMessage("unused")),
		]);

		const turn = session.prompt("Why does login crash on an empty password?");
		await vi.waitFor(() => expect(timeline).toContain("answer:start"));
		await settle();
		// The answer is still in flight: no title request has been made.
		expect(timeline).toEqual(["answer:start"]);
		expect(faux.state.callCount).toBe(1);

		open();
		await turn;
		await vi.waitFor(() => expect(session.sessionManager.getSessionName()).toBe(TITLE));
		expect(timeline).toEqual(["answer:start", "answer:end", "title:start"]);
		expect(faux.state.callCount).toBe(2);
	});

	it("requests one title for the session, however many prompts follow", async () => {
		const session = await openSession();
		faux.setResponses([
			reply(() => fauxAssistantMessage("The null check is in login.ts.")),
			reply(() => fauxAssistantMessage("unused")),
		]);

		await session.prompt("Why does login crash on an empty password?");
		await vi.waitFor(() => expect(session.sessionManager.getSessionName()).toBe(TITLE));

		faux.appendResponses([reply(() => fauxAssistantMessage("Added a regression test."))]);
		await session.prompt("Add a regression test for it.");
		await settle();

		expect(timeline.filter((event) => event === "title:start")).toHaveLength(1);
		expect(faux.state.callCount).toBe(3);
		expect(session.sessionManager.getSessionName()).toBe(TITLE);
	});

	it("titles a session whose first answer failed, once the failed run has ended", async () => {
		const session = await openSession();
		const { gate, open } = gateFor();
		faux.setResponses([
			reply(
				() => fauxAssistantMessage("", { stopReason: "error", errorMessage: "Bad request: unsupported prompt" }),
				gate,
			),
			reply(() => fauxAssistantMessage("unused")),
		]);

		const turn = session.prompt("Why does the build fail?");
		await vi.waitFor(() => expect(timeline).toContain("answer:start"));
		await settle();
		expect(timeline).toEqual(["answer:start"]);

		open();
		await turn;
		await vi.waitFor(() => expect(session.sessionManager.getSessionName()).toBe(TITLE));
		expect(timeline).toEqual(["answer:start", "answer:end", "title:start"]);
	});

	it("does not request a title for a prompt that says not to name the session (print mode)", async () => {
		const session = await openSession();
		faux.setResponses([reply(() => fauxAssistantMessage("4"))]);

		await session.prompt("What is 2 + 2?", { nameSession: false });
		await settle();

		expect(timeline).toEqual(["answer:start", "answer:end"]);
		expect(faux.state.callCount).toBe(1);
		expect(session.sessionManager.getSessionName()).toBeUndefined();
	});

	it("does not title a resumed session that was already titled", async () => {
		const first = await openSession();
		faux.setResponses([
			reply(() => fauxAssistantMessage("The null check is in login.ts.")),
			reply(() => fauxAssistantMessage("unused")),
		]);
		await first.prompt("Why does login crash on an empty password?");
		await vi.waitFor(() => expect(first.sessionManager.getSessionName()).toBe(TITLE));
		const sessionFile = first.sessionFile as string;
		first.dispose();

		timeline = [];
		const callsBefore = faux.state.callCount;
		const resumed = await openSession(SessionManager.open(sessionFile, sessionDir));
		expect(resumed.sessionManager.getSessionName()).toBe(TITLE);
		faux.appendResponses([reply(() => fauxAssistantMessage("Checked the login page."))]);

		await resumed.prompt("Check the login page.");
		await settle();

		expect(timeline).toEqual(["answer:start", "answer:end"]);
		expect(faux.state.callCount - callsBefore).toBe(1);
		expect(resumed.sessionManager.getSessionName()).toBe(TITLE);
	});

	it("does not hold up the next prompt while a title is in flight, and dispose aborts it", async () => {
		const session = await openSession();
		let titleSignal: AbortSignal | undefined;
		faux.setResponses([
			reply(() => fauxAssistantMessage("First answer.")),
			async (_context: TranscriptContext, options?: SimpleStreamOptions) => {
				// The title call stays open until it is aborted.
				titleSignal = options?.signal;
				timeline.push("title:start");
				await new Promise<void>((resolve) => titleSignal?.addEventListener("abort", () => resolve()));
				return fauxAssistantMessage("", { stopReason: "aborted" });
			},
		]);
		faux.appendResponses([reply(() => fauxAssistantMessage("Second answer."))]);

		await session.prompt("Explain the build layout.");
		await vi.waitFor(() => expect(timeline).toContain("title:start"));
		// The title call has not returned. The next prompt must still run and finish.
		await session.prompt("And the test layout?");
		expect(timeline.filter((event) => event === "answer:end")).toHaveLength(2);
		expect(titleSignal?.aborted).toBe(false);

		session.dispose();
		expect(titleSignal?.aborted).toBe(true);
	});
});
