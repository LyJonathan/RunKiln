import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
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
import type { ModelRuntime } from "../../src/core/model-runtime.ts";
import {
	CheckpointStore,
	formatChangeSummary,
	formatRestoreNotice,
	formatRestorePlan,
} from "../../src/core/runkiln/checkpoints.ts";
import { setProcessPermissionMode } from "../../src/core/runkiln/permissions.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { BUILTIN_SLASH_COMMANDS } from "../../src/core/slash-commands.ts";

const gitEnv = (): NodeJS.ProcessEnv => {
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(process.env)) if (!key.startsWith("GIT_")) env[key] = value;
	return {
		...env,
		GIT_OPTIONAL_LOCKS: "0",
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_AUTHOR_NAME: "Test",
		GIT_AUTHOR_EMAIL: "test@example.invalid",
		GIT_COMMITTER_NAME: "Test",
		GIT_COMMITTER_EMAIL: "test@example.invalid",
	};
};
const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", args, { cwd, env: gitEnv(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const read = (path: string) => readFileSync(path, "utf8");

/** Everything about the user's repository that checkpoints must never change. */
function userGitState(repo: string) {
	return {
		head: git(repo, "rev-parse", "HEAD"),
		refs: git(repo, "for-each-ref"),
		stash: git(repo, "stash", "list"),
		index: sha(join(repo, ".git", "index")),
		status: git(repo, "status", "--porcelain=v1", "--untracked-files=all", "--ignored"),
	};
}

describe("CheckpointStore", () => {
	let root: string;
	let project: string;
	let checkpointDir: string;
	let clock: number;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "runkiln-checkpoints-"));
		project = join(root, "project");
		checkpointDir = join(root, "checkpoints");
		mkdirSync(project, { recursive: true });
		clock = Date.now();
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	const store = (options: Partial<ConstructorParameters<typeof CheckpointStore>[0]> = {}) =>
		new CheckpointStore({
			rootDir: checkpointDir,
			sessionId: "session-1",
			cwd: project,
			now: () => clock,
			...options,
		});

	function initUserRepo() {
		git(project, "init", "-q", "-b", "main");
		writeFileSync(join(project, ".gitignore"), ".env\nbuild/\n");
		writeFileSync(join(project, "tracked.txt"), "one\ntwo\n");
		writeFileSync(join(project, "staged.txt"), "staged\n");
		git(project, "add", ".gitignore", "tracked.txt");
		git(project, "commit", "-q", "-m", "init");
		git(project, "add", "staged.txt"); // staged but not committed: the user's index has an entry HEAD lacks
		writeFileSync(join(project, "untracked.txt"), "untracked\n");
		writeFileSync(join(project, ".env"), "SECRET=1\n");
		mkdirSync(join(project, "build"));
		writeFileSync(join(project, "build", "out.js"), "built\n");
		writeFileSync(join(project, "image.bin"), Buffer.from([0, 1, 2, 3, 0, 255]));
		writeFileSync(join(project, "big.dat"), "x".repeat(2048));
		git(project, "stash", "list");
	}

	it("restores tracked, untracked, deleted, binary and ignored-but-edited files, and leaves the user's git alone", async () => {
		initUserRepo();
		const before = userGitState(project);
		const checkpoints = store({ maxFileBytes: 1024 });

		// Turn 1: a shell command changes things, then the write tool edits an ignored file.
		await checkpoints.beforeMutation("entry-1", "bash", { command: "do things" });
		clock += 10_000;
		writeFileSync(join(project, "tracked.txt"), "one\nTWO\nthree\n");
		unlinkSync(join(project, "untracked.txt"));
		writeFileSync(join(project, "image.bin"), Buffer.from([9, 9, 0, 9]));
		mkdirSync(join(project, "src", "deep"), { recursive: true });
		writeFileSync(join(project, "src", "deep", "new.ts"), "export {};\n");
		writeFileSync(join(project, "big.dat"), "y".repeat(4096));
		writeFileSync(join(project, "build", "out.js"), "rebuilt\n");
		await checkpoints.beforeMutation("entry-1", "write", { path: ".env" });
		writeFileSync(join(project, ".env"), "SECRET=2\n");
		await checkpoints.finishRun();

		const [record] = checkpoints.list();
		const summary = await checkpoints.summarize(record.id);
		expect(summary?.files.map((file) => `${file.status} ${file.path}`)).toEqual([
			"modified .env",
			"modified image.bin",
			"added src/deep/new.ts",
			"modified tracked.txt",
			"deleted untracked.txt",
		]);
		expect(summary?.files.find((file) => file.path === "tracked.txt")).toMatchObject({ added: 2, removed: 1 });
		expect(summary?.files.find((file) => file.path === "image.bin")?.binary).toBe(true);
		expect(formatChangeSummary(summary)).toBe("5 files  +4 −3");

		const plan = await checkpoints.planRestore([record.id]);
		expect(plan?.items.map((item) => `${item.action} ${item.path}`).sort()).toEqual([
			"delete src/deep/new.ts",
			"recreate untracked.txt",
			"restore .env",
			"restore image.bin",
			"restore tracked.txt",
		]);
		expect(plan?.changedOutside).toEqual([]);
		const result = await checkpoints.applyRestore(plan!);
		expect(result.failed).toEqual([]);

		expect(read(join(project, "tracked.txt"))).toBe("one\ntwo\n");
		expect(read(join(project, "untracked.txt"))).toBe("untracked\n");
		expect(read(join(project, ".env"))).toBe("SECRET=1\n");
		expect([...readFileSync(join(project, "image.bin"))]).toEqual([0, 1, 2, 3, 0, 255]);
		expect(existsSync(join(project, "src"))).toBe(false); // the new file and its empty folders are gone
		// Out of scope: the over-cap file and the ignored build output keep their current content.
		expect(read(join(project, "big.dat"))).toBe("y".repeat(4096));
		expect(read(join(project, "build", "out.js"))).toBe("rebuilt\n");

		expect(userGitState(project)).toEqual(before);
		expect(existsSync(join(project, ".git", "refs", "runkiln"))).toBe(false);
		expect(checkpoints.get(record.id)?.restoredAt).toBeDefined();
	});

	it("rewinds several turns: each restore returns to the state before the chosen turn", async () => {
		initUserRepo();
		const checkpoints = store();
		const file = join(project, "tracked.txt");
		await checkpoints.beforeMutation("entry-1", "edit", { path: "tracked.txt" });
		writeFileSync(file, "turn 1\n");
		await checkpoints.finishRun();
		await checkpoints.beforeMutation("entry-2", "write", { path: "tracked.txt" });
		writeFileSync(file, "turn 2\n");
		await checkpoints.beforeMutation("entry-2", "write", { path: "added.txt" });
		writeFileSync(join(project, "added.txt"), "new\n");
		await checkpoints.finishRun();
		const [first, second] = checkpoints.list();

		await checkpoints.applyRestore((await checkpoints.planRestore([second.id]))!);
		expect(read(file)).toBe("turn 1\n");
		expect(existsSync(join(project, "added.txt"))).toBe(false);

		await checkpoints.applyRestore((await checkpoints.planRestore([first.id, second.id]))!);
		expect(read(file)).toBe("one\ntwo\n");
	});

	it("works without git from the edit/write backups alone", async () => {
		writeFileSync(join(project, "a.txt"), "original\n");
		const checkpoints = store({ git: false });
		await checkpoints.beforeMutation("entry-1", "edit", { path: "a.txt" });
		writeFileSync(join(project, "a.txt"), "changed\n");
		await checkpoints.beforeMutation("entry-1", "write", { path: join(project, "nested", "b.txt") });
		mkdirSync(join(project, "nested"));
		writeFileSync(join(project, "nested", "b.txt"), "created\n");
		await checkpoints.beforeMutation("entry-1", "edit", { path: "a.txt" }); // the second touch keeps the first backup
		writeFileSync(join(project, "a.txt"), "changed again\n");
		await checkpoints.finishRun();

		const [record] = checkpoints.list();
		expect(record.before).toBeUndefined();
		expect(record.note).toContain("git is not available");
		const summary = await checkpoints.summarize(record.id);
		expect(summary?.files.map((file) => `${file.status} ${file.path}`)).toEqual([
			"modified a.txt",
			"added nested/b.txt",
		]);

		const plan = (await checkpoints.planRestore([record.id]))!;
		expect(plan.items.map((item) => `${item.action} ${item.path} ${item.source}`)).toEqual([
			"restore a.txt backup",
			"delete nested/b.txt backup",
		]);
		await checkpoints.applyRestore(plan);
		expect(read(join(project, "a.txt"))).toBe("original\n");
		expect(existsSync(join(project, "nested"))).toBe(false);
	});

	it("snapshots a folder that is not a git repository, honouring its .gitignore and skipping node_modules", async () => {
		writeFileSync(join(project, ".gitignore"), "*.log\n");
		writeFileSync(join(project, "keep.txt"), "keep\n");
		writeFileSync(join(project, "debug.log"), "log\n");
		mkdirSync(join(project, "node_modules", "pkg"), { recursive: true });
		writeFileSync(join(project, "node_modules", "pkg", "index.js"), "module\n");
		const checkpoints = store();
		await checkpoints.beforeMutation("entry-1", "bash", { command: "rm -rf everything" });
		clock += 5_000;
		unlinkSync(join(project, "keep.txt"));
		writeFileSync(join(project, "debug.log"), "changed log\n");
		writeFileSync(join(project, "node_modules", "pkg", "index.js"), "changed module\n");
		await checkpoints.finishRun();
		const [record] = checkpoints.list();
		expect(record.before).toBeDefined();
		expect(existsSync(join(project, ".git"))).toBe(false);

		const plan = (await checkpoints.planRestore([record.id]))!;
		expect(plan.items.map((item) => `${item.action} ${item.path}`)).toEqual(["recreate keep.txt"]);
		await checkpoints.applyRestore(plan);
		expect(read(join(project, "keep.txt"))).toBe("keep\n");
		expect(read(join(project, "debug.log"))).toBe("changed log\n");
		expect(existsSync(join(project, ".git"))).toBe(false);
	});

	it("restores bytes exactly despite the project's .gitattributes (CRLF stays CRLF)", async () => {
		writeFileSync(join(project, ".gitattributes"), "* text=auto eol=lf\n");
		writeFileSync(join(project, "windows.txt"), "a\r\nb\r\n");
		const checkpoints = store();
		await checkpoints.beforeMutation("entry-1", "bash", { command: "unix2dos" });
		writeFileSync(join(project, "windows.txt"), "changed\n");
		await checkpoints.finishRun();
		await checkpoints.applyRestore((await checkpoints.planRestore([checkpoints.list()[0].id]))!);
		expect(readFileSync(join(project, "windows.txt"))).toEqual(Buffer.from("a\r\nb\r\n"));
	});

	it("flags files changed outside the agent since its last turn, and protected files", async () => {
		initUserRepo();
		writeFileSync(join(project, "package.json"), "{}\n");
		const checkpoints = store();
		await checkpoints.beforeMutation("entry-1", "write", { path: "package.json" });
		writeFileSync(join(project, "package.json"), '{"scripts":{}}\n');
		await checkpoints.beforeMutation("entry-1", "edit", { path: "tracked.txt" });
		writeFileSync(join(project, "tracked.txt"), "agent\n");
		await checkpoints.finishRun();
		writeFileSync(join(project, "tracked.txt"), "agent, then the user\n");

		const plan = (await checkpoints.planRestore([checkpoints.list()[0].id]))!;
		expect(plan.changedOutside).toEqual(["tracked.txt"]);
		expect(plan.items.find((item) => item.path === "package.json")?.protected).toBe(true);
	});

	it("never plans a write outside the project, and does not delete files the snapshot left out", async () => {
		initUserRepo();
		const outside = join(root, "outside.txt");
		writeFileSync(outside, "outside\n");
		const checkpoints = store({ maxFileBytes: 1024 });
		await checkpoints.beforeMutation("entry-1", "write", { path: outside });
		writeFileSync(outside, "changed\n");
		await checkpoints.finishRun();
		// big.dat was over the cap before the turn; shrinking it makes it appear in the current snapshot.
		writeFileSync(join(project, "big.dat"), "small now\n");
		const plan = (await checkpoints.planRestore([checkpoints.list()[0].id]))!;
		expect(plan.items).toEqual([]);
		expect(plan.skipped).toContainEqual({ path: outside, reason: "outside the project, not tracked" });
		await checkpoints.applyRestore(plan);
		expect(read(outside)).toBe("changed\n");
		expect(read(join(project, "big.dat"))).toBe("small now\n");
	});

	it("keeps checkpoints across a new store for the same session (resume)", async () => {
		writeFileSync(join(project, "a.txt"), "a\n");
		const first = store({ git: false });
		await first.beforeMutation("entry-1", "edit", { path: "a.txt" });
		writeFileSync(join(project, "a.txt"), "b\n");
		await first.finishRun();
		const resumed = store({ git: false });
		expect(resumed.forEntry("entry-1")?.files[0]).toMatchObject({ path: "a.txt", state: "file" });
		await resumed.applyRestore((await resumed.planRestore([resumed.list()[0].id]))!);
		expect(read(join(project, "a.txt"))).toBe("a\n");
	});
});

describe("checkpoints on the session's turns", () => {
	let root: string;
	let agentDir: string;
	let projectDir: string;
	let sessionDir: string;
	let faux: FauxProviderRegistration;

	const runtime = {
		getModelById: () => undefined,
		hasConfiguredAuth: () => true,
		streamSimple: (model: Model<Api>, context: Context, options?: SimpleStreamOptions) =>
			streamSimple(model, context, options),
	} as unknown as ModelRuntime;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "runkiln-checkpoint-session-"));
		agentDir = join(root, "agent");
		projectDir = join(root, "project");
		sessionDir = join(root, "sessions");
		for (const dir of [agentDir, projectDir, sessionDir]) mkdirSync(dir, { recursive: true });
		writeFileSync(join(projectDir, "notes.txt"), "v0\n");
		faux = registerFauxProvider();
		vi.stubEnv("TYPESAFE_API_KEY", "");
		vi.stubEnv("OPENROUTER_API_KEY", "");
		vi.stubEnv("RUNKILN_CHECKPOINTS", "");
	});

	afterEach(() => {
		faux.unregister();
		setProcessPermissionMode(undefined);
		vi.unstubAllEnvs();
		rmSync(root, { recursive: true, force: true });
	});

	async function openSession(sessionManager = SessionManager.create(projectDir, sessionDir)) {
		const { session } = await createAgentSession({
			cwd: projectDir,
			agentDir,
			modelRuntime: runtime,
			model: faux.getModel(),
			sessionManager,
			thinkingLevel: "off",
			permissionMode: "allow-all",
		});
		session.setActiveToolsByName(["read", "write", "bash"]);
		return session;
	}

	const writeTurn = (path: string, content: string) => [
		fauxAssistantMessage([fauxToolCall("write", { path, content })], { stopReason: "toolUse" }),
		fauxAssistantMessage("done"),
	];

	it("records one checkpoint per turn, restores the files and truncates the conversation", async () => {
		const session = await openSession();
		faux.setResponses([
			...writeTurn("notes.txt", "v1\n"),
			fauxAssistantMessage("just talking"),
			...writeTurn("notes.txt", "v2\n"),
		]);
		await session.prompt("first change");
		await session.prompt("a question");
		await session.prompt("second change");
		expect(read(join(projectDir, "notes.txt"))).toBe("v2\n");

		const points = await session.getRewindPoints();
		expect(points.map((point) => [point.turn, point.text, formatChangeSummary(point.summary)])).toEqual([
			[1, "first change", "1 file  +1 −1"],
			[2, "a question", "no file changes"],
			[3, "second change", "1 file  +1 −1"],
		]);
		expect(points[1].checkpointId).toBeUndefined();
		expect(existsSync(join(agentDir, "checkpoints", session.sessionId, "manifest.json"))).toBe(true);

		// /undo: the last turn's files.
		const undo = (await session.planFileRestore(points[2].entryId))!;
		expect(undo.items.map((item) => `${item.action} ${item.path}`)).toEqual(["restore notes.txt"]);
		await session.applyFileRestore(undo);
		expect(read(join(projectDir, "notes.txt"))).toBe("v1\n");
		expect((await session.getRewindPoints())[2].restored).toBe(true);

		// /rewind to turn 1, files and conversation.
		const plan = (await session.planFileRestore(points[0].entryId))!;
		await session.applyFileRestore(plan);
		expect(read(join(projectDir, "notes.txt"))).toBe("v0\n");
		const rewound = await session.rewindConversation(points[0].entryId);
		expect(rewound.editorText).toBe("first change");
		expect(session.messages.filter((message) => message.role === "user")).toHaveLength(0);
		expect(await session.getRewindPoints()).toEqual([]);
		// The abandoned turns stay in the session tree.
		expect(session.sessionManager.getEntries().filter((entry) => entry.type === "message").length).toBeGreaterThan(3);
		session.dispose();
	});

	it("rewinds only the conversation and leaves the files as they are", async () => {
		const session = await openSession();
		faux.setResponses([...writeTurn("notes.txt", "v1\n"), ...writeTurn("notes.txt", "v2\n")]);
		await session.prompt("one");
		await session.prompt("two");
		const points = await session.getRewindPoints();
		await session.rewindConversation(points[1].entryId);
		expect(read(join(projectDir, "notes.txt"))).toBe("v2\n");
		const userTexts = session.messages
			.filter((message) => message.role === "user")
			.map((message) =>
				typeof message.content === "string"
					? message.content
					: message.content.map((part) => ("text" in part ? part.text : "")).join(""),
			);
		expect(userTexts).toEqual(["one"]);
		session.dispose();
	});

	it("does not checkpoint a denied call, and records nothing for in-memory sessions", async () => {
		const memory = await openSession(SessionManager.inMemory(projectDir));
		faux.setResponses(writeTurn("notes.txt", "v1\n"));
		await memory.prompt("change");
		expect(memory.checkpoints).toBeUndefined();
		expect(existsSync(join(agentDir, "checkpoints"))).toBe(false);
		memory.dispose();

		const session = await openSession();
		session.setPermissionMode("ask");
		session.setApprovalPrompt(async () => ({ choice: "deny" }));
		faux.setResponses(writeTurn("notes.txt", "v1\n"));
		await session.prompt("change");
		expect(session.checkpoints?.list()).toEqual([]);
		session.dispose();
	});
});

describe("checkpoint notices", () => {
	it("lists the plan with protected files and outside changes, and sums up a restore", () => {
		const lines = formatRestorePlan({
			targetId: "c1",
			checkpointIds: ["c1"],
			items: [
				{ path: "src/a.ts", action: "restore", source: "tree" },
				{ path: "package.json", action: "restore", source: "backup", protected: true },
				{ path: "gone.txt", action: "recreate", source: "tree" },
				{ path: "new.ts", action: "delete", source: "tree" },
			],
			skipped: [{ path: "big.bin", reason: "too large to back up" }],
			changedOutside: ["src/a.ts"],
		});
		expect(lines).toEqual([
			"  ~ restore src/a.ts",
			"  ~ restore package.json (protected file)",
			"  + recreate gone.txt",
			"  − delete new.ts",
			"",
			"! Changed outside RunKiln since the agent's last turn, and will be overwritten: src/a.ts",
			"",
			"Not restored: big.bin, too large to back up",
		]);
		expect(
			formatRestoreNotice({ restored: ["a", "b"], recreated: [], deleted: ["c"], failed: [], skipped: [] }),
		).toBe("Restored 3 files (2 reverted, 1 deleted)");
	});

	it("registers /undo and /rewind", () => {
		const names = BUILTIN_SLASH_COMMANDS.map((command) => command.name);
		expect(names).toContain("undo");
		expect(names).toContain("rewind");
	});
});
