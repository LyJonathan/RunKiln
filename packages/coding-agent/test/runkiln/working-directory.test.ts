import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Api,
	type Context,
	type FauxProviderRegistration,
	type FauxResponseFactory,
	fauxAssistantMessage,
	getCurrentSystemMessage,
	getSystemMessageText,
	type ImageContent,
	type Message,
	type Model,
	registerFauxProvider,
	type SimpleStreamOptions,
	streamSimple,
	type UserMessage,
} from "@runkiln/ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { convertToLlm, withWorkingDirectoryContext, workingDirectoryBlock } from "../../src/core/messages.ts";
import type { ModelRuntime } from "../../src/core/model-runtime.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { buildSystemPrompt, buildSystemPromptSections } from "../../src/core/system-prompt.ts";

const CWD = "E:\\work\\demo";
const CWD_BLOCK = "<cwd>\nE:/work/demo\n</cwd>\n\n";
const SYSTEM: Message = { role: "system", content: "You are a test assistant.", timestamp: 0 };

const base = {
	selectedTools: ["read", "bash", "edit", "write"],
	toolSnippets: {
		read: "Read file contents",
		bash: "Execute bash commands",
		edit: "Edit files",
		write: "Write files",
	},
};

function user(text: string): UserMessage {
	return { role: "user", content: text, timestamp: 1 };
}

/** The system prompt as the model reads it: the replayed system message rendered to text. */
function systemPrompt(messages: Message[]): string {
	return getSystemMessageText(getCurrentSystemMessage(messages)!);
}

/** Text of every user message, with the parts of array content joined. */
function userTexts(messages: readonly { role: string }[]): string[] {
	return messages
		.filter((message): message is UserMessage => message.role === "user")
		.map((message) =>
			typeof message.content === "string"
				? message.content
				: message.content.map((part) => (part.type === "text" ? part.text : "")).join(""),
		);
}

describe("system prompt without the working directory", () => {
	it("is byte-identical for two working directories with the same other options", () => {
		const first = buildSystemPrompt({ ...base, cwd: "E:/work/alpha" });
		const second = buildSystemPrompt({ ...base, cwd: "C:\\work\\beta" });
		expect(second).toBe(first);
		expect(first).not.toContain("<cwd>");
		expect(first).not.toContain("alpha");
		expect(first).not.toContain("beta");
	});

	it("has no cwd section", () => {
		expect(Object.keys(buildSystemPromptSections({ ...base, cwd: "E:/work/alpha" }))).not.toContain("cwd");
	});
});

describe("withWorkingDirectoryContext", () => {
	it("formats the block with forward slashes", () => {
		expect(workingDirectoryBlock(CWD)).toBe(CWD_BLOCK);
	});

	it("prepends the block to the first user message only", () => {
		const messages: Message[] = [SYSTEM, user("first"), fauxAssistantMessage("answer"), user("second")];
		const out = withWorkingDirectoryContext(messages, CWD);
		expect(userTexts(out)).toEqual([`${CWD_BLOCK}first`, "second"]);
		expect(out[0]).toBe(messages[0]);
		expect(out[2]).toBe(messages[2]);
		expect(out[3]).toBe(messages[3]);
	});

	it("does not change the messages it was given", () => {
		const messages: Message[] = [SYSTEM, user("first")];
		const snapshot = structuredClone(messages);
		withWorkingDirectoryContext(messages, CWD);
		expect(messages).toEqual(snapshot);
	});

	it("gives every request the block once and never stacks it", () => {
		const transcript: Message[] = [user("first"), fauxAssistantMessage("answer"), user("second")];
		const request = () => withWorkingDirectoryContext(convertToLlm(transcript), CWD);
		const first = request();
		const second = request();
		expect(userTexts(second)).toEqual(userTexts(first));
		expect(userTexts(second)).toEqual([`${CWD_BLOCK}first`, "second"]);
		expect(userTexts(transcript)).toEqual(["first", "second"]);
	});

	it("adds a text part in front of array content and keeps the images", () => {
		const image: ImageContent = { type: "image", data: "AAAA", mimeType: "image/png" };
		const message: UserMessage = { role: "user", content: [{ type: "text", text: "look" }, image], timestamp: 1 };
		const [out] = withWorkingDirectoryContext([message], CWD);
		expect(out).toMatchObject({
			role: "user",
			content: [{ type: "text", text: CWD_BLOCK }, { type: "text", text: "look" }, image],
		});
	});

	it("puts the block on the compaction summary, the first user message after compaction", () => {
		const session = SessionManager.inMemory(CWD);
		const kept = session.appendMessage(user("kept question"));
		session.appendMessage(fauxAssistantMessage("answer"));
		session.appendCompaction("Earlier work summary.", kept, 1200);
		session.appendMessage(user("new question"));
		const request = withWorkingDirectoryContext(convertToLlm(session.buildSessionContext().messages), CWD);
		const texts = userTexts(request);
		expect(texts[0].startsWith(CWD_BLOCK)).toBe(true);
		expect(texts[0]).toContain("Earlier work summary.");
		expect(texts.slice(1)).toEqual(["kept question", "new question"]);
	});

	it("leaves a transcript whose system prompt already has a cwd section unchanged", () => {
		const legacy: Message[] = [
			{ role: "system", content: "", sections: { cwd: "<cwd>\nE:/old\n</cwd>" }, timestamp: 0 },
			user("first"),
		];
		expect(withWorkingDirectoryContext(legacy, CWD)).toBe(legacy);
	});

	it("returns a request without a user message as it is", () => {
		const messages: Message[] = [SYSTEM];
		expect(withWorkingDirectoryContext(messages, CWD)).toBe(messages);
	});
});

describe("working directory on the model's requests", () => {
	let root: string;
	let agentDir: string;
	let projectDir: string;
	let otherProjectDir: string;
	let sessionDir: string;
	let faux: FauxProviderRegistration;
	let requests: Message[][];

	// The faux provider needs no credentials, and this runtime only routes streams to it.
	const runtime = {
		getModelById: () => undefined,
		hasConfiguredAuth: () => true,
		streamSimple: (model: Model<Api>, context: Context, options?: SimpleStreamOptions) =>
			streamSimple(model, context, options),
	} as unknown as ModelRuntime;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "runkiln-cwd-"));
		agentDir = join(root, "agent");
		projectDir = join(root, "project");
		otherProjectDir = join(root, "other-project");
		sessionDir = join(root, "sessions");
		for (const dir of [agentDir, projectDir, otherProjectDir, sessionDir]) mkdirSync(dir, { recursive: true });
		requests = [];
		const respond: FauxResponseFactory = (context) => {
			requests.push([...context.messages]);
			return fauxAssistantMessage("ok");
		};
		faux = registerFauxProvider();
		faux.setResponses(Array.from({ length: 10 }, () => respond));
	});

	afterEach(() => {
		faux.unregister();
		rmSync(root, { recursive: true, force: true });
	});

	async function openSession(sessionManager: SessionManager, cwd = projectDir) {
		const result = await createAgentSession({
			cwd,
			agentDir,
			modelRuntime: runtime,
			model: faux.getModel(),
			sessionManager,
			thinkingLevel: "off",
		});
		return result.session;
	}

	const projectBlock = () => `<cwd>\n${projectDir.replace(/\\/g, "/")}\n</cwd>\n\n`;

	it("puts the block on the first user message of every request and keeps the transcript and file clean", async () => {
		const manager = SessionManager.create(projectDir, sessionDir);
		const session = await openSession(manager);
		await session.prompt("first question");
		await session.sendUserMessage("second question");
		const [first, second] = requests;

		expect(userTexts(first)).toEqual([`${projectBlock()}first question`]);
		expect(userTexts(second)).toEqual([`${projectBlock()}first question`, "second question"]);
		expect(systemPrompt(first)).not.toContain("<cwd>");
		expect(userTexts(session.messages)).toEqual(["first question", "second question"]);
		expect(readFileSync(manager.getSessionFile()!, "utf8")).not.toContain("<cwd>");
		session.dispose();
	});

	it("gives a resumed session the block once", async () => {
		const manager = SessionManager.create(projectDir, sessionDir);
		const session = await openSession(manager);
		await session.prompt("first question");
		const file = manager.getSessionFile()!;
		session.dispose();

		const resumed = await openSession(SessionManager.open(file, sessionDir));
		await resumed.prompt("after resume");
		expect(userTexts(requests[requests.length - 1])).toEqual([`${projectBlock()}first question`, "after resume"]);
		expect(readFileSync(file, "utf8")).not.toContain("<cwd>");
		resumed.dispose();
	});

	it("keeps the cwd of a legacy session's frozen prompt and does not add a second block", async () => {
		const legacyCwd = `<cwd>\n${projectDir.replace(/\\/g, "/")}\n</cwd>`;
		const manager = SessionManager.inMemory(projectDir);
		manager.appendMessage({
			role: "system",
			content: "",
			sections: { preamble: "Legacy prompt.", cwd: legacyCwd },
			timestamp: 0,
		});
		const session = await openSession(manager);
		const drifts: string[] = [];
		session.subscribe((event) => {
			if (event.type === "prompt_drift") drifts.push(event.message);
		});
		await session.prompt("hello");
		expect(systemPrompt(requests[0])).toContain(legacyCwd);
		// No project block and no update note: the frozen prompt's cwd still holds, so nothing changed to report.
		expect(userTexts(requests[0])).toEqual(["hello"]);
		expect(drifts).toEqual([]);
		session.dispose();
	});

	it("gives two projects the same system prompt", async () => {
		const a = await openSession(SessionManager.create(projectDir, sessionDir));
		const b = await openSession(SessionManager.create(otherProjectDir, sessionDir), otherProjectDir);
		await a.prompt("from project");
		await b.prompt("from other project");
		expect(systemPrompt(requests[1])).toBe(systemPrompt(requests[0]));
		expect(systemPrompt(requests[0])).not.toContain(projectDir.replace(/\\/g, "/"));
		expect(userTexts(requests[1])[0].startsWith(`<cwd>\n${otherProjectDir.replace(/\\/g, "/")}\n</cwd>`)).toBe(true);
		a.dispose();
		b.dispose();
	});
});
