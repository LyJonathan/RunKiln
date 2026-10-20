import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../../src/config.ts";
import { approvalRequestForToolCall, isApprovalRefusal } from "../../src/core/runkiln/approval.ts";
import { PermissionGate, type PermissionMode } from "../../src/core/runkiln/permissions.ts";
import { createFindTool } from "../../src/core/tools/find.ts";
import { createGrepTool } from "../../src/core/tools/grep.ts";
import { mentionsEnvFile } from "../../src/core/tools/path-utils.ts";
import { writeOutputFile } from "../../src/utils/output-files.ts";

let root: string;
let project: string;
let outside: string;
let agentDir: string;
let previousAgentDir: string | undefined;
const builtin = { builtin: true };

let symlinks = true;

beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), "runkiln-secret-"));
	project = join(root, "project");
	outside = join(root, "outside");
	agentDir = join(root, "agent");
	mkdirSync(join(project, "src"), { recursive: true });
	mkdirSync(join(outside, ".aws"), { recursive: true });
	mkdirSync(join(outside, "skills", "x"), { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(project, "src", "a.ts"), "const token = 1;\n");
	writeFileSync(join(project, ".env"), "API_TOKEN=abc\n");
	writeFileSync(join(project, ".env.local"), "API_TOKEN=abc\n");
	writeFileSync(join(outside, ".aws", "credentials"), "[default]\n");
	writeFileSync(join(outside, "notes.md"), "hi\n");
	writeFileSync(join(outside, "skills", "x", "SKILL.md"), "skill\n");
	writeFileSync(join(agentDir, "router-keys.json"), "{}");
	try {
		symlinkSync(join(outside, ".aws", "credentials"), join(project, "notes.txt"));
	} catch {
		symlinks = false;
	}
	previousAgentDir = process.env[ENV_AGENT_DIR];
	process.env[ENV_AGENT_DIR] = agentDir;
});
afterAll(() => {
	if (previousAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
	else process.env[ENV_AGENT_DIR] = previousAgentDir;
	rmSync(root, { recursive: true, force: true });
});

const decide = (mode: PermissionMode, tool: string, args: unknown, extra: Record<string, unknown> = {}) =>
	new PermissionGate({ mode, judgeFactory: () => undefined, isAutoAvailable: () => true, ...extra }).decide(
		tool,
		args,
		project,
		builtin,
	);

describe("secret reads", () => {
	it("a read of .env asks in every mode but allow-all", async () => {
		for (const mode of ["ask", "read-write", "plan", "auto"] as const) {
			expect((await decide(mode, "read", { path: ".env" })).action, mode).toBe("ask");
		}
		expect((await decide("allow-all", "read", { path: ".env" })).action).toBe("allow");
	});

	it("is matched on the real path: a link to ~/.aws/credentials inside the project asks", async () => {
		if (!symlinks) return;
		for (const mode of ["read-write", "auto", "plan"] as const) {
			expect((await decide(mode, "read", { path: "notes.txt" })).action, mode).toBe("ask");
		}
	});

	it("a session 'always allow reads' rule does not cover a secrets file", async () => {
		const gate = new PermissionGate({ mode: "read-write" });
		gate.addRules([{ kind: "reads" }]);
		expect((await gate.decide("read", { path: ".env" }, project, builtin)).action).toBe("ask");
		expect((await gate.decide("read", { path: join(outside, "notes.md") }, project, builtin)).action).toBe("allow");
	});

	it("ordinary project reads still run", async () => {
		for (const mode of ["read-write", "auto", "plan"] as const) {
			expect((await decide(mode, "read", { path: "src/a.ts" })).action, mode).toBe("allow");
		}
		expect((await decide("read-write", "read", { path: ".env.example" })).action).toBe("allow");
	});
});

describe("reads outside the project", () => {
	it("ask by default in read & write, auto and plan", async () => {
		for (const mode of ["read-write", "auto", "plan"] as const) {
			const decision = await decide(mode, "read", { path: join(outside, "notes.md") });
			expect(decision.action, mode).toBe("ask");
			if (decision.action === "ask") expect(decision.request.title).toContain("outside the project");
		}
		expect((await decide("read-write", "grep", { pattern: "x", path: outside })).action).toBe("ask");
		expect((await decide("read-write", "ls", { path: "/" })).action).toBe("ask");
	});

	it('run with readsOutsideProject: "allow"', async () => {
		const extra = { readsOutsideProject: () => "allow" as const };
		expect((await decide("read-write", "read", { path: join(outside, "notes.md") }, extra)).action).toBe("allow");
		// A secrets file still asks.
		expect((await decide("read-write", "read", { path: join(outside, ".aws", "credentials") }, extra)).action).toBe(
			"ask",
		);
	});

	it("skill folders and RunKiln's own output files are readable", async () => {
		const extra = { readRoots: () => [join(outside, "skills")] };
		const skill = join(outside, "skills", "x", "SKILL.md");
		expect((await decide("read-write", "read", { path: skill }, extra)).action).toBe("allow");
		const output = await writeOutputFile("runkiln-test", ".log", "full output");
		try {
			expect((await decide("read-write", "read", { path: output })).action).toBe("allow");
		} finally {
			rmSync(output, { force: true });
		}
	});
});

describe("RunKiln's own key files", () => {
	it("are refused for every file tool and in every mode, allow-all included", async () => {
		const keyFile = join(agentDir, "router-keys.json");
		for (const tool of ["read", "grep", "write", "edit"]) {
			const outcome = approvalRequestForToolCall(tool, { path: keyFile, content: "" }, project, builtin);
			expect(isApprovalRefusal(outcome), tool).toBe(true);
		}
		expect((await decide("allow-all", "read", { path: keyFile })).action).toBe("deny");
		expect(
			(await decide("allow-all", "write", { path: join(agentDir, "command-trust.json"), content: "{}" })).action,
		).toBe("deny");
	});

	it("a shell command naming them is refused", async () => {
		for (const command of [
			"cat ~/.runkiln/agent/router-keys.json",
			`cat ${join(agentDir, "runinfra.json")}`,
			"cp x ~/.runkiln/agent/command-trust.json",
		]) {
			expect((await decide("allow-all", "bash", { command })).action, command).toBe("deny");
		}
		expect((await decide("allow-all", "bash", { command: "cat package.json" })).action).toBe("allow");
	});
});

describe(".env files in grep and find", () => {
	it("mentionsEnvFile spots an explicit request", () => {
		expect(mentionsEnvFile(undefined, "*.ts")).toBe(false);
		expect(mentionsEnvFile(".env")).toBe(true);
		expect(mentionsEnvFile("src", ".env*")).toBe(true);
		expect(mentionsEnvFile("config/.env.local")).toBe(true);
		expect(mentionsEnvFile("src/environment.ts")).toBe(false);
	});

	it("grep skips .env files unless they are named", async () => {
		const grep = createGrepTool(project);
		const text = (result: { content: Array<{ type: string; text?: string }> }) =>
			result.content.map((part) => part.text ?? "").join("\n");
		const plain = text(await grep.execute("t1", { pattern: "TOKEN", ignoreCase: true }));
		expect(plain).toContain("a.ts");
		expect(plain).not.toContain(".env");
		const named = text(await grep.execute("t2", { pattern: "API_TOKEN", path: ".env" }));
		expect(named).toContain("API_TOKEN");
	});

	it("find skips .env files unless the pattern names them", async () => {
		const find = createFindTool(project);
		const text = (result: { content: Array<{ type: string; text?: string }> }) =>
			result.content.map((part) => part.text ?? "").join("\n");
		let plain: string;
		try {
			plain = text(await find.execute("f1", { pattern: "*" }));
		} catch {
			return; // fd is not installed and could not be downloaded here.
		}
		expect(plain).not.toContain(".env");
		expect(text(await find.execute("f2", { pattern: ".env*" }))).toContain(".env");
	});
});
