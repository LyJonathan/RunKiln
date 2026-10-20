import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseArgs } from "../../src/cli/args.ts";
import { offerWorktreeExit } from "../../src/cli/worktree-exit.ts";
import type { ModelRuntime } from "../../src/core/model-runtime.ts";
import {
	coAuthorTrailer,
	commitCandidates,
	commitPaths,
	createWorktree,
	parseCommitMessage,
	withCoAuthor,
	worktreeName,
	worktreeState,
} from "../../src/core/runkiln/git-workflow.ts";
import { setProcessPermissionMode } from "../../src/core/runkiln/permissions.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { commitPromptDescription, commitPromptTitle } from "../../src/modes/interactive/workflow-text.ts";

const GIT_ENV = {
	GIT_AUTHOR_NAME: "t",
	GIT_AUTHOR_EMAIL: "t@example.com",
	GIT_COMMITTER_NAME: "t",
	GIT_COMMITTER_EMAIL: "t@example.com",
};

function repo(): { dir: string; git: (...args: string[]) => string } {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "runkiln-git-")));
	const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
	git("init", "-q", "-b", "main");
	git("config", "user.name", "t");
	git("config", "user.email", "t@example.com");
	writeFileSync(join(dir, "a.ts"), "a\n");
	writeFileSync(join(dir, "b.ts"), "b\n");
	git("add", ".");
	git("commit", "-qm", "init");
	return { dir, git };
}

describe("commit helpers", () => {
	let dir: string;
	let git: (...args: string[]) => string;
	beforeEach(() => {
		({ dir, git } = repo());
		Object.assign(process.env, GIT_ENV);
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("limits candidates to the scope and commits only those paths", () => {
		writeFileSync(join(dir, "a.ts"), "a2\n");
		writeFileSync(join(dir, "b.ts"), "b2\n");
		writeFileSync(join(dir, "new.ts"), "n\n");
		git("add", "b.ts");
		expect(commitCandidates(dir, undefined)).toEqual(["a.ts", "b.ts", "new.ts"]);
		const scoped = commitCandidates(dir, [join(dir, "a.ts"), "new.ts", join(dir, "untouched.ts")]);
		expect(scoped).toEqual(["a.ts", "new.ts"]);
		const result = commitPaths(dir, scoped, "feat: a and new\n\nbody");
		expect("sha" in result && result.subject).toBe("feat: a and new");
		expect(git("show", "--name-only", "--format=", "HEAD").trim().split("\n").sort()).toEqual(["a.ts", "new.ts"]);
		// The user's own staged change stays staged and out of the commit.
		expect(git("diff", "--cached", "--name-only").trim()).toBe("b.ts");
	});

	it("commits deletions and refuses an empty message", () => {
		rmSync(join(dir, "a.ts"));
		expect(commitPaths(dir, ["a.ts"], "  ")).toEqual({ error: "Empty commit message: nothing was committed." });
		const result = commitPaths(dir, ["a.ts"], "chore: remove a");
		expect("sha" in result).toBe(true);
		expect(git("show", "--name-status", "--format=", "HEAD").trim()).toBe("D\ta.ts");
	});

	it("cleans the model's message and adds the co-author trailer once", () => {
		expect(parseCommitMessage("```\nfeat(ui): add todo panel.\n\nShows the list.\n```")).toBe(
			"feat(ui): add todo panel\n\nShows the list.",
		);
		expect(parseCommitMessage(`"fix: ${"x".repeat(100)}"`)?.length).toBe(72);
		expect(parseCommitMessage("   ")).toBeUndefined();
		// git.coAuthor empty (the default): no trailer.
		expect(withCoAuthor("fix: a\n", "")).toBe("fix: a");
		expect(withCoAuthor("fix: a", undefined)).toBe("fix: a");
		expect(coAuthorTrailer("  ")).toBeUndefined();
		const once = withCoAuthor("fix: a", "Bot <bot@example.com>");
		expect(once).toBe("fix: a\n\nCo-authored-by: Bot <bot@example.com>");
		expect(withCoAuthor(once, "Bot <bot@example.com>")).toBe(once);
		expect(coAuthorTrailer("co-authored-by: Bot <bot@example.com>")).toBe("Co-authored-by: Bot <bot@example.com>");
	});

	it("titles the /commit prompt with the scope and files", () => {
		const draft = { paths: ["a.ts", "b.ts"], scope: "session" as const, costUsd: 0.00004, fallback: false };
		expect(commitPromptTitle(draft)).toBe(
			"Commit 2 files (this session's changes): edit the message, Enter to commit, Esc to cancel",
		);
		expect(commitPromptDescription(draft)).toContain("  a.ts\n  b.ts");
		expect(commitPromptDescription(draft)).toContain("$0.00004");
	});
});

describe("worktree sessions", () => {
	let dir: string;
	let git: (...args: string[]) => string;
	beforeEach(() => {
		({ dir, git } = repo());
		Object.assign(process.env, GIT_ENV);
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("parses --worktree with an optional one-word name", () => {
		expect(parseArgs(["--worktree"]).worktree).toBe(true);
		expect(parseArgs(["--worktree", "fix-login"]).worktree).toBe("fix-login");
		expect(parseArgs(["--worktree", "fix the login bug"])).toMatchObject({
			worktree: true,
			messages: ["fix the login bug"],
		});
		expect(parseArgs(["--worktree=x"]).worktree).toBe("x");
		expect(worktreeName("Fix Login!")).toBe("fix-login");
		expect(worktreeName(undefined, new Date("2026-10-17T09:30:00Z"))).toBe("session-202610170930");
	});

	it("creates the worktree, merges its commits back, and removes it", async () => {
		const session = createWorktree(dir, "feat-x");
		if ("error" in session) throw new Error(session.error);
		expect(session.path).toBe(join(dir, ".runkiln", "worktrees", "feat-x"));
		expect(session.branch).toBe("runkiln/feat-x");
		expect(session.baseRef).toBe("main");
		expect(git("status", "--porcelain").trim()).toBe("");
		writeFileSync(join(session.path, "c.ts"), "c\n");
		execFileSync("git", ["add", "c.ts"], { cwd: session.path });
		execFileSync("git", ["commit", "-qm", "add c"], { cwd: session.path });
		expect(worktreeState(session)).toEqual({ dirty: [], commits: 1 });
		const printed: string[] = [];
		await offerWorktreeExit(session, { ask: async () => "m", print: (line) => printed.push(line) });
		expect(readFileSync(join(dir, "c.ts"), "utf8")).toBe("c\n");
		expect(existsSync(session.path)).toBe(false);
		expect(git("branch", "--list", "runkiln/feat-x").trim()).toBe("");
		expect(printed.join("\n")).toContain("Merged runkiln/feat-x into main");
	});

	it("removes an untouched worktree without asking, and keeps a dirty one by default", async () => {
		const clean = createWorktree(dir, "clean");
		if ("error" in clean) throw new Error(clean.error);
		let asked = 0;
		await offerWorktreeExit(clean, {
			ask: async () => {
				asked++;
				return "";
			},
			print: () => {},
		});
		expect(asked).toBe(0);
		expect(existsSync(clean.path)).toBe(false);

		const dirty = createWorktree(dir, "dirty");
		if ("error" in dirty) throw new Error(dirty.error);
		writeFileSync(join(dirty.path, "a.ts"), "changed\n");
		await offerWorktreeExit(dirty, { ask: async () => "", print: () => {} });
		expect(existsSync(dirty.path)).toBe(true);
		expect(createWorktree(dir, "dirty")).toMatchObject({ error: expect.stringContaining("already exists") });
	});
});

describe("/commit and git.autoCommit on the session", () => {
	let dir: string;
	let git: (...args: string[]) => string;
	let root: string;
	let faux: FauxProviderRegistration;
	const runtime = {
		getModelById: () => undefined,
		hasConfiguredAuth: () => true,
		streamSimple: (model: Model<Api>, context: Context, options?: SimpleStreamOptions) =>
			streamSimple(model, context, options),
	} as unknown as ModelRuntime;

	beforeEach(() => {
		({ dir, git } = repo());
		Object.assign(process.env, GIT_ENV);
		root = mkdtempSync(join(tmpdir(), "runkiln-commit-session-"));
		for (const sub of ["agent", "sessions"]) mkdirSync(join(root, sub), { recursive: true });
		faux = registerFauxProvider();
	});
	afterEach(() => {
		faux.unregister();
		setProcessPermissionMode(undefined);
		rmSync(dir, { recursive: true, force: true });
		rmSync(root, { recursive: true, force: true });
	});

	async function open(settings: Record<string, unknown> = {}) {
		const { session } = await createAgentSession({
			cwd: dir,
			agentDir: join(root, "agent"),
			modelRuntime: runtime,
			model: faux.getModel(),
			settingsManager: SettingsManager.inMemory(settings as never),
			sessionManager: SessionManager.create(dir, join(root, "sessions")),
			thinkingLevel: "off",
			permissionMode: "allow-all",
		});
		return session;
	}

	it("drafts a message on the chore model for the session's files only, then commits them", async () => {
		const session = await open();
		writeFileSync(join(dir, "b.ts"), "user edit\n");
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("write", { path: "a.ts", content: "agent edit\n" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("Edited a.ts."),
			fauxAssistantMessage("fix(a): update a"),
		]);
		await session.prompt("change a");
		const draft = await session.draftCommit(undefined);
		if ("error" in draft) throw new Error(draft.error);
		expect(draft.scope).toBe("session");
		expect(draft.paths).toEqual(["a.ts"]);
		// No git.coAuthor: no trailer.
		expect(draft.message).toBe("fix(a): update a");
		// Nothing staged until the user confirms.
		expect(git("diff", "--cached", "--name-only").trim()).toBe("");
		const result = session.commitFiles(draft, draft.message);
		expect("sha" in result).toBe(true);
		expect(git("log", "-1", "--format=%B").trim()).toBe("fix(a): update a");
		expect(git("status", "--porcelain").trim()).toBe("M b.ts");

		const all = await session.draftCommit("all");
		expect("error" in all ? all.error : all.paths).toEqual(["b.ts"]);
		session.dispose();
	});

	it("falls back to all changes when the session changed nothing, and says when there is nothing", async () => {
		const session = await open();
		expect(await session.draftCommit(undefined)).toEqual({ error: "No changes to commit." });
		writeFileSync(join(dir, "b.ts"), "user edit\n");
		expect(await session.draftCommit("turn")).toMatchObject({ error: expect.stringContaining("this turn") });
		faux.setResponses([fauxAssistantMessage("chore: update b")]);
		const draft = await session.draftCommit(undefined);
		expect("error" in draft ? draft.error : [draft.scope, draft.paths]).toEqual(["all", ["b.ts"]]);
		session.dispose();
	});

	it("git.autoCommit turn commits each file-changing turn with the git.coAuthor trailer; off never commits", async () => {
		const off = await open();
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("write", { path: "x.ts", content: "x\n" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await off.prompt("write x");
		expect(git("rev-list", "--count", "HEAD").trim()).toBe("1");
		off.dispose();
		git("add", "x.ts");
		git("commit", "-qm", "x");

		const auto = await open({ git: { autoCommit: "turn", coAuthor: "Bot <bot@example.com>" } });
		const events: unknown[] = [];
		auto.subscribe((event) => {
			if (event.type === "auto_commit") events.push(event);
		});
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("write", { path: "y.ts", content: "y\n" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
			fauxAssistantMessage("feat: add y"),
		]);
		await auto.prompt("write y");
		expect(git("log", "-1", "--format=%B").trim()).toBe("feat: add y\n\nCo-authored-by: Bot <bot@example.com>");
		expect(git("show", "--name-only", "--format=", "HEAD").trim()).toBe("y.ts");
		expect(events).toEqual([{ type: "auto_commit", files: 1, sha: expect.any(String), subject: "feat: add y" }]);

		// A turn that changes nothing makes no commit.
		faux.setResponses([fauxAssistantMessage("just talking")]);
		await auto.prompt("hello");
		expect(events).toHaveLength(1);
		auto.dispose();
	});
});
