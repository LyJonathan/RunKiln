import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Api,
	type AssistantMessage,
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
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseReviewCommand } from "../../src/cli/review-command.ts";
import type { ModelRuntime } from "../../src/core/model-runtime.ts";
import { setProcessPermissionMode } from "../../src/core/runkiln/permissions.ts";
import {
	collectReviewMaterial,
	countReviewFindings,
	REVIEW_MESSAGE_TYPE,
	resolveReviewTarget,
	reviewFails,
	reviewInstructions,
	reviewRequestText,
} from "../../src/core/runkiln/review.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";

function initRepo(dir: string): (...args: string[]) => string {
	const git = (...args: string[]) =>
		execFileSync("git", args, {
			cwd: dir,
			encoding: "utf8",
			env: {
				...process.env,
				GIT_AUTHOR_NAME: "t",
				GIT_AUTHOR_EMAIL: "t@example.com",
				GIT_COMMITTER_NAME: "t",
				GIT_COMMITTER_EMAIL: "t@example.com",
			},
		});
	git("init", "-q", "-b", "main");
	writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
	git("add", ".");
	git("commit", "-qm", "init");
	return git;
}

describe("review material", () => {
	let dir: string;
	let git: (...args: string[]) => string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "runkiln-review-"));
		git = initRepo(dir);
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("reviews uncommitted changes, untracked files included", () => {
		writeFileSync(join(dir, "a.ts"), "export const a = 2;\n");
		writeFileSync(join(dir, "b.ts"), "export const b = 3;\n");
		const target = resolveReviewTarget(dir, undefined);
		expect(target).toEqual({ kind: "uncommitted" });
		const material = collectReviewMaterial(dir, target as never);
		if ("error" in material) throw new Error(material.error);
		expect(material.files.sort()).toEqual(["a.ts", "b.ts"]);
		expect(material.diff).toContain("+export const a = 2;");
		expect(material.diff).toContain("+export const b = 3;");
		expect(reviewRequestText(material)).toBe(
			"Review the uncommitted changes (2 files, +2 −1): find bugs and risks, findings by priority P0–P3 with file:line.",
		);
		const instructions = reviewInstructions(material);
		expect(instructions).toContain("## P0");
		expect(instructions).toContain("read-only");
		expect(instructions).toContain("```diff");
	});

	it("reviews one commit and a branch against its base", () => {
		git("checkout", "-qb", "feature");
		writeFileSync(join(dir, "c.ts"), "export const c = 4;\n");
		git("add", ".");
		git("commit", "-qm", "add c");
		const sha = git("rev-parse", "HEAD").trim();
		const commit = resolveReviewTarget(dir, sha.slice(0, 8));
		expect(commit).toMatchObject({ kind: "commit", sha });
		const commitMaterial = collectReviewMaterial(dir, commit as never);
		if ("error" in commitMaterial) throw new Error(commitMaterial.error);
		expect(commitMaterial.label).toBe(`commit ${sha.slice(0, 7)} (add c)`);
		expect(commitMaterial.files).toEqual(["c.ts"]);

		const branch = resolveReviewTarget(dir, "main");
		expect(branch).toMatchObject({ kind: "branch", ref: "main" });
		const branchMaterial = collectReviewMaterial(dir, branch as never);
		if ("error" in branchMaterial) throw new Error(branchMaterial.error);
		expect(branchMaterial.label).toBe("this branch against main");
		expect(branchMaterial.files).toEqual(["c.ts"]);
	});

	it("says when there is nothing to review or the target is unknown", () => {
		expect(collectReviewMaterial(dir, { kind: "uncommitted" })).toEqual({
			error: "No uncommitted changes to review.",
		});
		expect(resolveReviewTarget(dir, "nope")).toMatchObject({
			error: expect.stringContaining("Not a commit or branch"),
		});
		expect(resolveReviewTarget(dir, "--output=x")).toMatchObject({ error: expect.stringContaining("Not a commit") });
		const outside = mkdtempSync(join(tmpdir(), "runkiln-review-nogit-"));
		expect(resolveReviewTarget(outside, undefined)).toMatchObject({ error: expect.stringContaining("Not a git") });
		rmSync(outside, { recursive: true, force: true });
	});
});

describe("review findings", () => {
	const answer = [
		"## P0 (must fix)",
		"- `src/a.ts:3` Division by zero when count is 0.",
		"## P2",
		"- `src/b.ts:10` Missing test.",
		"- `src/b.ts:22` Fragile regex.",
		"## Summary",
		"- not a finding",
		"Verdict: ready after fixes",
	].join("\n");

	it("counts bullets under each priority heading only", () => {
		expect(countReviewFindings(answer)).toEqual({ P0: 1, P1: 0, P2: 2, P3: 0 });
	});

	it("--fail-on matches the priority or anything more severe", () => {
		expect(reviewFails(answer, "P0")).toBe(true);
		expect(reviewFails("## P3\n- nit", "P1")).toBe(false);
		expect(reviewFails("## P1\n- bug", "P2")).toBe(true);
		expect(reviewFails(answer, undefined)).toBe(false);
	});

	it("parses `runkiln review` arguments", () => {
		expect(parseReviewCommand(["-p", "x"])).toBeUndefined();
		expect(parseReviewCommand(["review", "main", "--fail-on", "p1", "--model", "auto", "--no-session"])).toEqual({
			target: "main",
			failOn: "P1",
			rest: ["--model", "auto", "--no-session"],
		});
		expect(parseReviewCommand(["review", "--fail-on=P9"])?.error).toContain("--fail-on");
	});
});

describe("/review on the session", () => {
	let root: string;
	let projectDir: string;
	let faux: FauxProviderRegistration;
	const runtime = {
		getModelById: () => undefined,
		hasConfiguredAuth: () => true,
		streamSimple: (model: Model<Api>, context: Context, options?: SimpleStreamOptions) =>
			streamSimple(model, context, options),
	} as unknown as ModelRuntime;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "runkiln-review-session-"));
		projectDir = join(root, "project");
		for (const dir of [projectDir, join(root, "agent"), join(root, "sessions")]) mkdirSync(dir, { recursive: true });
		initRepo(projectDir);
		faux = registerFauxProvider();
	});
	afterEach(() => {
		faux.unregister();
		setProcessPermissionMode(undefined);
		rmSync(root, { recursive: true, force: true });
	});

	it("runs read-only in allow-all mode: reads run, writes and commands are blocked", async () => {
		writeFileSync(join(projectDir, "a.ts"), "export const a = 1 / 0;\n");
		const { session } = await createAgentSession({
			cwd: projectDir,
			agentDir: join(root, "agent"),
			modelRuntime: runtime,
			model: faux.getModel(),
			sessionManager: SessionManager.create(projectDir, join(root, "sessions")),
			thinkingLevel: "off",
			permissionMode: "allow-all",
		});
		faux.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("read", { path: "a.ts" }),
					fauxToolCall("write", { path: "a.ts", content: "oops" }),
					fauxToolCall("bash", { command: "echo hi" }),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("## P1\n- `a.ts:1` Division by zero.\nVerdict: ready after fixes"),
		]);
		const result = await session.review();
		expect(result.error).toBeUndefined();
		const toolResults = session.messages.filter((m): m is ToolResultMessage => m.role === "toolResult");
		expect(toolResults.find((m) => m.toolName === "read")?.isError).toBe(false);
		for (const name of ["write", "bash"]) {
			const blocked = toolResults.find((m) => m.toolName === name);
			expect(blocked?.isError).toBe(true);
			expect(JSON.stringify(blocked?.content)).toContain("/review is read-only");
		}
		expect(readFileSync(join(projectDir, "a.ts"), "utf8")).toBe("export const a = 1 / 0;\n");
		const user = session.messages.find((m) => m.role === "user");
		expect(JSON.stringify(user?.content)).toContain("Review the uncommitted changes (1 file");
		const hidden = session.messages.find(
			(m) => m.role === "custom" && (m as { customType?: string }).customType === REVIEW_MESSAGE_TYPE,
		);
		expect(JSON.stringify((hidden as { content?: unknown })?.content)).toContain("1 / 0");
		expect(session.isReviewing).toBe(false);

		// The next turn is not read-only any more.
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "echo after" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("ok"),
		]);
		await session.prompt("run it");
		const after = session.messages.filter((m): m is ToolResultMessage => m.role === "toolResult").pop();
		expect(after?.isError).toBe(false);
		session.dispose();
	});

	it("asks once, hidden and still read-only, when the review run ends with an empty message", async () => {
		writeFileSync(join(projectDir, "a.ts"), "export const a = 1 / 0;\n");
		const { session } = await createAgentSession({
			cwd: projectDir,
			agentDir: join(root, "agent"),
			modelRuntime: runtime,
			model: faux.getModel(),
			sessionManager: SessionManager.inMemory(projectDir),
			thinkingLevel: "off",
			permissionMode: "allow-all",
		});
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "node a.ts" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([]),
			fauxAssistantMessage([fauxToolCall("bash", { command: "echo still blocked" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("## P1\n- `a.ts:1` Division by zero."),
		]);
		expect((await session.review()).error).toBeUndefined();
		const last = session.messages[session.messages.length - 1] as AssistantMessage;
		expect(JSON.stringify(last.content)).toContain("Division by zero");
		const blocked = session.messages.filter((m): m is ToolResultMessage => m.role === "toolResult");
		expect(blocked.map((m) => m.isError)).toEqual([true, true]);
		const hidden = session.messages.filter(
			(m) => m.role === "custom" && (m as { customType?: string }).customType === REVIEW_MESSAGE_TYPE,
		);
		expect(hidden).toHaveLength(2);
		expect(JSON.stringify((hidden[1] as { content?: unknown }).content)).toContain("Your last message was empty");
		expect(session.isReviewing).toBe(false);
		session.dispose();
	});

	it("reports nothing to review without calling the model", async () => {
		const { session } = await createAgentSession({
			cwd: projectDir,
			agentDir: join(root, "agent"),
			modelRuntime: runtime,
			model: faux.getModel(),
			sessionManager: SessionManager.inMemory(projectDir),
			thinkingLevel: "off",
			permissionMode: "allow-all",
		});
		expect(await session.review()).toEqual({ error: "No uncommitted changes to review." });
		expect(faux.state.callCount).toBe(0);
		session.dispose();
	});
});
