import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { extractTurnSignals, type SignalMessage } from "../../src/core/router/signals.ts";
import {
	commandSetupFailure,
	countFailing,
	detectTestCommand,
	failureSignature,
} from "../../src/core/verify/test-command.ts";
import {
	VERIFY_FAILURE_TYPE,
	VERIFY_OPTIONS,
	VerifyController,
	type VerifyHost,
	type VerifyProjectEntry,
	type VerifySettings,
	type VerifyUI,
	verifyMarker,
} from "../../src/core/verify/verify-loop.ts";

describe("test command detection", () => {
	let root: string;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "runkiln-testcmd-"));
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	it("reads the package.json test script and the package manager from the lockfile", () => {
		writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { test: "vitest --run" } }));
		expect(detectTestCommand(root)).toEqual({ command: "npm test", source: "package.json" });
		writeFileSync(join(root, "pnpm-lock.yaml"), "");
		expect(detectTestCommand(root)?.command).toBe("pnpm test");
	});

	it("skips npm's placeholder script and falls back to pytest, cargo and go", () => {
		writeFileSync(
			join(root, "package.json"),
			JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }),
		);
		expect(detectTestCommand(root)).toBeUndefined();
		mkdirSync(join(root, "tests"));
		writeFileSync(join(root, "tests", "test_app.py"), "def test_x(): pass\n");
		expect(detectTestCommand(root)?.source).toBe("pytest");
		rmSync(join(root, "tests"), { recursive: true });
		writeFileSync(join(root, "Cargo.toml"), "[package]\n");
		expect(detectTestCommand(root)).toEqual({ command: "cargo test -q", source: "cargo" });
		rmSync(join(root, "Cargo.toml"));
		writeFileSync(join(root, "go.mod"), "module x\n");
		expect(detectTestCommand(root)).toEqual({ command: "go test ./...", source: "go" });
	});

	it("counts failing tests from common runners", () => {
		expect(countFailing(" Tests  3 failed | 10 passed (13)\n Tests  1 failed | 2 passed (3)")).toBe(4);
		expect(countFailing("Tests:       2 failed, 5 passed, 7 total")).toBe(2);
		expect(countFailing("=========== 3 failed, 2 passed, 1 error in 0.12s ===========")).toBe(4);
		expect(countFailing("test result: FAILED. 10 passed; 3 failed; 0 ignored")).toBe(3);
		expect(countFailing("# tests 5\n# pass 3\n# fail 2")).toBe(2);
		expect(countFailing("  4 passing\n  1 failing\n")).toBe(1);
		expect(countFailing("--- FAIL: TestA (0.00s)\n--- FAIL: TestB (0.00s)\nFAIL")).toBe(2);
		expect(countFailing("Segmentation fault")).toBeUndefined();
	});

	it("gives the same signature when only timings change", () => {
		const a = "FAIL src/a.test.ts > adds (12ms)\nAssertionError: expected 3 to be 4\nDuration 1.23s";
		const b = "FAIL src/a.test.ts > adds (40ms)\nAssertionError: expected 3 to be 4\nDuration 2.5s";
		const c = "FAIL src/a.test.ts > adds (40ms)\nAssertionError: expected 3 to be 5";
		expect(failureSignature(a)).toBe(failureSignature(b));
		expect(failureSignature(a)).not.toBe(failureSignature(c));
	});
});

describe("verify loop", () => {
	let root: string;
	let settings: VerifySettings;
	let saved: VerifyProjectEntry | undefined;
	let ui: VerifyUI & { select: ReturnType<typeof vi.fn>; notify: ReturnType<typeof vi.fn> };
	let anyUi: any;
	let hasUI: boolean;
	let plan: boolean;

	/** A test command that passes once `state.txt` says "ok", with a stable failure otherwise. */
	const TEST_SCRIPT = `const fs = require("fs");
const state = fs.existsSync("state.txt") ? fs.readFileSync("state.txt", "utf8").trim() : "";
if (state === "ok") { console.log(" Tests  2 passed (2)"); process.exit(0); }
console.log("FAIL test/math.test.js > adds");
console.log("AssertionError: expected " + (state || "3") + " to be 4");
console.log(" Tests  1 failed | 1 passed (2)");
process.exit(1);
`;

	function controller(): VerifyController {
		const host: VerifyHost = {
			cwd: () => root,
			settings: () => settings,
			project: () => saved,
			saveProject: (entry) => {
				saved = entry;
			},
			ui: () => (hasUI ? ui : undefined),
			isPlanMode: () => plan,
		};
		return new VerifyController(host);
	}

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "runkiln-verify-"));
		writeFileSync(join(root, "run-tests.js"), TEST_SCRIPT);
		writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { test: "node run-tests.js" } }));
		settings = { mode: "ask", commandTrusted: false, maxRetries: 2, timeoutMs: 20000 };
		saved = undefined;
		hasUI = true;
		plan = false;
		anyUi = {
			select: vi.fn(async () => VERIFY_OPTIONS.always),
			input: vi.fn(async () => undefined),
			notify: vi.fn(),
			setWorkingMessage: vi.fn(),
		};
		ui = anyUi;
	});

	afterEach(() => rmSync(root, { recursive: true, force: true }));

	it("does nothing until a turn changed files, then offers once and saves the answer for the project", async () => {
		const verify = controller();
		expect(await verify.beforeSettle()).toBeUndefined();
		expect(ui.select).not.toHaveBeenCalled();

		verify.noteToolEnd("read", false);
		verify.noteToolEnd("edit", true);
		expect(await verify.beforeSettle()).toBeUndefined();

		verify.noteToolEnd("edit", false);
		const message = await verify.beforeSettle();
		expect(ui.select).toHaveBeenCalledTimes(1);
		expect(ui.select.mock.calls[0][0]).toContain(
			"Run the tests after changes? `npm test` (the package.json test script)",
		);
		expect(saved).toEqual({ command: "npm test", decision: "always" });
		expect(message).toMatchObject({ role: "custom", customType: VERIFY_FAILURE_TYPE, display: false });
		const text = (message!.content as Array<{ text: string }>)[0].text;
		expect(text).toContain("The tests fail after your changes (`npm test`, exit code 1, 1 failing).");
		expect(text).toContain("AssertionError: expected 3 to be 4");
		expect(text).toContain("Automatic retry 1 of 2.");
		expect(verify.marker).toBe("✗ 1 failing ↻1");

		// The saved choice is not asked again.
		writeFileSync(join(root, "state.txt"), "ok");
		verify.noteToolEnd("write", false);
		expect(await verify.beforeSettle()).toBeUndefined();
		expect(ui.select).toHaveBeenCalledTimes(1);
		expect(verify.marker).toBe("✓ tests");
	});

	it("stops when the same failure repeats, and after maxRetries", async () => {
		saved = { command: "node run-tests.js", decision: "always" };
		const verify = controller();
		verify.noteToolEnd("edit", false);
		expect(await verify.beforeSettle()).toBeDefined();
		verify.noteToolEnd("edit", false);
		// Same output: the model made no progress.
		expect(await verify.beforeSettle()).toBeUndefined();
		expect(verify.status.stopped).toBe("same-failure");
		expect(ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("same failure"), "warning");

		verify.noteUserTurn();
		settings = { ...settings, maxRetries: 2 };
		for (const value of ["5", "6"]) {
			writeFileSync(join(root, "state.txt"), value);
			verify.noteToolEnd("edit", false);
			expect(await verify.beforeSettle()).toBeDefined();
		}
		writeFileSync(join(root, "state.txt"), "7");
		verify.noteToolEnd("edit", false);
		expect(await verify.beforeSettle()).toBeUndefined();
		expect(verify.status.stopped).toBe("max-retries");
		expect(verify.marker).toBe("✗ 1 failing ↻2");
	});

	it("respects off, never, not now, plan mode and the absence of a UI", async () => {
		const verify = controller();
		settings = { ...settings, mode: "off" };
		verify.noteToolEnd("edit", false);
		expect(await verify.beforeSettle()).toBeUndefined();

		settings = { ...settings, mode: "ask" };
		plan = true;
		verify.noteToolEnd("edit", false);
		expect(await verify.beforeSettle()).toBeUndefined();
		plan = false;

		hasUI = false;
		verify.noteToolEnd("edit", false);
		expect(await verify.beforeSettle()).toBeUndefined();
		hasUI = true;

		ui.select.mockResolvedValueOnce(VERIFY_OPTIONS.notNow);
		verify.noteToolEnd("edit", false);
		expect(await verify.beforeSettle()).toBeUndefined();
		verify.noteToolEnd("edit", false);
		expect(await verify.beforeSettle()).toBeUndefined();
		expect(ui.select).toHaveBeenCalledTimes(1);

		const other = controller();
		ui.select.mockResolvedValueOnce(VERIFY_OPTIONS.never);
		other.noteToolEnd("edit", false);
		expect(await other.beforeSettle()).toBeUndefined();
		expect(saved).toEqual({ decision: "never" });
	});

	it("auto mode runs a detected command without the offer; forced (--verify) runs without a UI", async () => {
		settings = { ...settings, mode: "auto" };
		const verify = controller();
		verify.noteToolEnd("edit", false);
		expect(await verify.beforeSettle()).toBeDefined();
		expect(ui.select).not.toHaveBeenCalled();

		hasUI = false;
		settings = { ...settings, mode: "off" };
		const forced = controller();
		forced.forced = true;
		forced.noteToolEnd("edit", false);
		expect(await forced.beforeSettle()).toBeDefined();
	});

	it("trusts a global verify.command, but confirms one from project settings", async () => {
		settings = { ...settings, command: "node run-tests.js", commandTrusted: true };
		expect(await controller().resolveCommand()).toBe("node run-tests.js");
		expect(ui.select).not.toHaveBeenCalled();
		settings = { ...settings, commandTrusted: false };
		expect(await controller().resolveCommand()).toBe("node run-tests.js");
		expect(ui.select.mock.calls[0][0]).toContain("from this project's settings");
	});

	it("reports a timeout without feeding it back", async () => {
		saved = { command: "sleep 5", decision: "always" };
		settings = { ...settings, timeoutMs: 1000 };
		const verify = controller();
		verify.noteToolEnd("edit", false);
		expect(await verify.beforeSettle()).toBeUndefined();
		expect(verify.status.state).toBe("timeout");
		expect(verify.marker).toBe("⏱ tests");
	});

	it("does not feed a test command that cannot run back to the model", async () => {
		// The A/B bench case: node --test naming a test file that does not exist.
		saved = { command: "node --test missing.test.js", decision: "always" };
		const verify = controller();
		verify.noteToolEnd("write", false);
		expect(await verify.beforeSettle()).toBeUndefined();
		expect(verify.status).toMatchObject({ state: "fail", stopped: "not-runnable" });
		expect(verify.status.setupError).toContain("missing.test.js does not exist");
		expect(verify.marker).toBe("⚠ test command");
		expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining("could not run"), "warning");
		expect(verify.status.retries).toBe(0);

		// An unknown command: same.
		saved = { command: "definitely-not-a-runkiln-test-runner", decision: "always" };
		verify.noteToolEnd("edit", false);
		expect(await verify.beforeSettle()).toBeUndefined();
		expect(verify.status.setupError).toBe("the test command was not found");

		// A real failure still goes back.
		saved = { command: "node run-tests.js", decision: "always" };
		verify.noteToolEnd("edit", false);
		const message = await verify.beforeSettle();
		expect(message).toMatchObject({ customType: VERIFY_FAILURE_TYPE });
		expect(verify.status.setupError).toBeUndefined();
		expect(verify.status.stopped).toBeUndefined();
	});

	it("tells a command that could not run from a failing one", () => {
		writeFileSync(join(root, "there.test.ts"), "");
		expect(commandSetupFailure("Could not find '/x/slug.test.ts'\n", 1, root)).toBe(
			"the test file /x/slug.test.ts does not exist",
		);
		expect(commandSetupFailure("Could not find 'there.test.ts'\n", 1, root)).toBeUndefined();
		expect(commandSetupFailure("sh: 1: vitest: not found\n", 127, root)).toBe("the test command was not found");
		expect(commandSetupFailure("bash: jest: command not found\n", 1, root)).toBe("the test command was not found");
		expect(commandSetupFailure("ERROR: file or directory not found: tests/test_x.py\n", 4, root)).toBe(
			"the test file tests/test_x.py does not exist",
		);
		expect(commandSetupFailure("\nno tests ran in 0.01s\n", 5, root)).toBe("no tests were collected");
		const unittest = (mod: string, missing: string) =>
			`ImportError: Failed to import test module: ${mod}\nTraceback (most recent call last):\n  ...\nModuleNotFoundError: No module named '${missing}'\n`;
		expect(commandSetupFailure(unittest("test_shop", "test_shop"), 1, root)).toBe(
			"the test module test_shop does not exist",
		);
		// The test module exists but the code under test is missing an import: a real failure for the model.
		expect(commandSetupFailure(unittest("test_shop", "shop_utils"), 1, root)).toBeUndefined();
		expect(commandSetupFailure("No tests found, exiting with code 1\n", 1, root)).toBe("no tests were collected");
		expect(
			commandSetupFailure(
				"# Subtest: adds\nnot ok 1 - adds\n  AssertionError: expected 3 to be 4\n# fail 1\n",
				1,
				root,
			),
		).toBeUndefined();
	});

	it("draws the footer markers", () => {
		expect(verifyMarker({ state: "idle", retries: 0 })).toBeUndefined();
		expect(verifyMarker({ state: "running", retries: 0 })).toBe("… tests");
		expect(verifyMarker({ state: "pass", retries: 0 })).toBe("✓ tests");
		expect(verifyMarker({ state: "fail", failing: 3, retries: 0 })).toBe("✗ 3 failing");
		expect(verifyMarker({ state: "fail", retries: 1 })).toBe("✗ tests ↻1");
		expect(verifyMarker({ state: "fail", retries: 0, setupError: "x" })).toBe("⚠ test command");
	});
});

describe("router signals from the post-edit pipeline and the verify loop", () => {
	const user: SignalMessage = { role: "user", content: "fix the bug" };
	const call = (id: string): SignalMessage => ({
		role: "assistant",
		content: [{ type: "toolCall", id, name: "edit", arguments: { path: "a.ts" } }],
	});

	it("counts new diagnostic errors as tool errors, and warnings alone not at all", () => {
		const messages: SignalMessage[] = [
			user,
			call("1"),
			{
				role: "toolResult",
				toolCallId: "1",
				content: [
					{
						type: "text",
						text: "Successfully replaced 1 block(s) in a.ts.\nDiagnostics after edit (biome): 2 new errors in a.ts. Fix them unless they are expected.\n...",
					},
				],
			},
			call("2"),
			{
				role: "toolResult",
				toolCallId: "2",
				content: [
					{
						type: "text",
						text: "Successfully wrote to a.ts\nDiagnostics after edit (biome): 1 new warning in a.ts.",
					},
				],
			},
		];
		const signals = extractTurnSignals(messages, { contextTokens: 0 });
		expect(signals.toolErrorsThisTurn).toBe(1);
	});

	it("counts each verify follow-up as a failing test in the current turn", () => {
		const messages: SignalMessage[] = [
			user,
			call("1"),
			{ role: "toolResult", toolCallId: "1", content: [{ type: "text", text: "ok" }] },
			{ role: "assistant", content: [{ type: "text", text: "Done." }] },
			{ role: "custom", customType: VERIFY_FAILURE_TYPE, content: [{ type: "text", text: "The tests fail" }] },
		];
		const signals = extractTurnSignals(messages, { contextTokens: 0 });
		expect(signals.isNewUserTurn).toBe(false);
		expect(signals.testFailuresThisTurn).toBe(1);
		expect(signals.latestUserText).toBe("fix the bug");
	});
});
