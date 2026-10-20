import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { autoPrepass, isRunnerCommand, isRunnerInput } from "../../src/core/runkiln/auto-prepass.ts";
import { parseRule, type SavedRule } from "../../src/core/runkiln/permission-rules.ts";
import {
	type JudgeInput,
	type JudgeVerdict,
	PermissionGate,
	type PermissionJudge,
} from "../../src/core/runkiln/permissions.ts";

let project: string;
const builtin = { builtin: true };

beforeAll(() => {
	project = mkdtempSync(join(tmpdir(), "runkiln-wtr-"));
	mkdirSync(join(project, "src"), { recursive: true });
	writeFileSync(join(project, "package.json"), JSON.stringify({ scripts: { test: "vitest", build: "tsc" } }));
});
afterAll(() => rmSync(project, { recursive: true, force: true }));

function fakeJudge(verdict: JudgeVerdict) {
	const judge = vi.fn(async (_input: JudgeInput) => verdict);
	const impl: PermissionJudge = { label: "test", judge };
	return { judge, factory: () => impl };
}

const bash = (command: string) => ({ command });

describe("runner inputs and runner commands", () => {
	it("test files, runner config and build scripts are runner inputs; ordinary sources are not", () => {
		for (const path of [
			"src/math.test.ts",
			"src/math.spec.js",
			"tests/helpers.ts",
			"__tests__/x.js",
			"test_app.py",
			"pkg/app_test.go",
			"vitest.config.ts",
			"jest.config.js",
			"conftest.py",
			"pyproject.toml",
			"Makefile",
			"build.rs",
			"package.json",
			"src\\math.test.ts",
		]) {
			expect(isRunnerInput(path), path).toBe(true);
		}
		for (const path of ["src/math.ts", "README.md", "docs/testing.md", "src/latest.ts"]) {
			expect(isRunnerInput(path), path).toBe(false);
		}
	});

	it("recognizes test, lint and build runners", () => {
		for (const command of [
			"npm test",
			"npm run build",
			"pnpm lint",
			"yarn test",
			"npx vitest run",
			"cargo test",
			"go test ./...",
			"pytest -q",
			"python -m pytest",
			"make",
			"make test",
			"git status && npm test",
			"node scripts/x.js",
		]) {
			expect(isRunnerCommand(command, project), command).toBe(true);
		}
		for (const command of ["git status", "ls src", "cat package.json", "echo hi"]) {
			expect(isRunnerCommand(command, project), command).toBe(false);
		}
	});

	it("npx, pnpx and bunx are never pre-allowed", () => {
		for (const command of [
			"npx vitest run",
			"npx tsc --noEmit",
			"npx prettier --check src",
			"bunx jest",
			"pnpx eslint src",
			"pnpm dlx cowsay hi",
		]) {
			expect(autoPrepass("bash", bash(command), project, builtin), command).toBeUndefined();
		}
	});
});

describe("write-then-run in auto mode", () => {
	it("a runner after an edit to a test file goes to the decision model, with the changed file named", async () => {
		const { judge, factory } = fakeJudge({ decision: "allow", reason: "fine", confidence: 1 });
		const gate = new PermissionGate({ mode: "auto", judgeFactory: factory });
		expect(await gate.decide("bash", bash("npm test"), project, builtin)).toMatchObject({ via: "prepass" });
		const edit = await gate.decide("edit", { path: "src/math.test.ts", edits: [] }, project, builtin);
		expect(edit).toMatchObject({ action: "allow", via: "prepass" });
		expect(gate.changedRunnerInputs).toEqual(["src/math.test.ts"]);
		const run = await gate.decide("bash", bash("npm test"), project, builtin);
		expect(run).toMatchObject({ action: "allow", via: "judge" });
		expect(judge).toHaveBeenCalledTimes(1);
		expect(judge.mock.calls[0][0].summary).toContain("The agent changed files this command runs (src/math.test.ts)");
		// The runner ran, so the change has been seen; the next run is routine again.
		expect(gate.changedRunnerInputs).toEqual([]);
		expect(await gate.decide("bash", bash("npm test"), project, builtin)).toMatchObject({ via: "prepass" });
	});

	it("an edit to an ordinary source file does not stop the pre-pass", async () => {
		const { judge, factory } = fakeJudge({ decision: "allow", reason: "fine" });
		const gate = new PermissionGate({ mode: "auto", judgeFactory: factory });
		await gate.decide("edit", { path: "src/math.ts", edits: [] }, project, builtin);
		expect(await gate.decide("bash", bash("npm test"), project, builtin)).toMatchObject({ via: "prepass" });
		expect(judge).not.toHaveBeenCalled();
	});

	it("a cached verdict from before the change does not cover the runner after it", async () => {
		const { judge, factory } = fakeJudge({ decision: "allow", reason: "fine", confidence: 1 });
		const gate = new PermissionGate({ mode: "auto", judgeFactory: factory });
		await gate.decide("bash", bash("node scripts/check.js"), project, builtin);
		expect(judge).toHaveBeenCalledTimes(1);
		gate.noteRunning("write", { path: "vitest.config.ts" }, project);
		await gate.decide("bash", bash("node scripts/check.js"), project, builtin);
		expect(judge).toHaveBeenCalledTimes(2);
	});

	it("a user-approved write to a protected runner file counts too", async () => {
		const { judge, factory } = fakeJudge({ decision: "ask", reason: "changed config" });
		const gate = new PermissionGate({ mode: "auto", judgeFactory: factory });
		const write = await gate.decide("write", { path: "vitest.config.ts", content: "" }, project, builtin);
		expect(write.action).toBe("ask");
		gate.noteRunning("write", { path: "vitest.config.ts" }, project);
		expect((await gate.decide("bash", bash("npm test"), project, builtin)).action).toBe("ask");
		// Once for the risky write, once for the runner.
		expect(judge).toHaveBeenCalledTimes(2);
	});

	it("without a decision model the runner asks", async () => {
		const gate = new PermissionGate({ mode: "auto", judgeFactory: () => undefined, isAutoAvailable: () => true });
		gate.noteRunning("edit", { path: "conftest.py" }, project);
		const run = await gate.decide("bash", bash("pytest"), project, builtin);
		expect(run.action).toBe("ask");
		expect(run.action === "ask" ? run.judgeReason : "").toContain("conftest.py");
	});
});

describe("write-then-run with rules", () => {
	const saved = (text: string): SavedRule => ({
		action: "allow",
		scope: "global",
		text,
		rule: parseRule(text) as SavedRule["rule"],
	});

	it("a session 'always allow npm test' rule does not cover npm test right after a test file changed", async () => {
		const gate = new PermissionGate({ mode: "read-write" });
		gate.addRules([{ kind: "command", prefix: "npm test" }]);
		expect((await gate.decide("bash", bash("npm test"), project, builtin)).action).toBe("allow");
		await gate.decide("write", { path: "src/a.test.ts", content: "" }, project, builtin);
		const run = await gate.decide("bash", bash("npm test"), project, builtin);
		expect(run.action).toBe("ask");
		// Once the user approves it, the rule applies again.
		gate.noteRunning("bash", bash("npm test"), project);
		expect((await gate.decide("bash", bash("npm test"), project, builtin)).action).toBe("allow");
	});

	it("a saved allow rule does not cover it either", async () => {
		const gate = new PermissionGate({ mode: "read-write", savedRules: () => [saved("Bash(npm test)")] });
		expect((await gate.decide("bash", bash("npm test"), project, builtin)).action).toBe("allow");
		gate.noteRunning("edit", { path: "package.json" }, project);
		expect((await gate.decide("bash", bash("npm test"), project, builtin)).action).toBe("ask");
	});

	it("allow-all is unchanged", async () => {
		const gate = new PermissionGate({ mode: "allow-all" });
		gate.noteRunning("edit", { path: "Makefile" }, project);
		expect((await gate.decide("bash", bash("make"), project, builtin)).action).toBe("allow");
	});
});
