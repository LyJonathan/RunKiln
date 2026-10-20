import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Api,
	type Context,
	type FauxProviderRegistration,
	fauxAssistantMessage,
	fauxToolCall,
	getCurrentTools,
	type Model,
	registerFauxProvider,
	type SimpleStreamOptions,
	streamSimple,
	type ToolResultMessage,
} from "@runkiln/ai/compat";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionUIContext } from "../../src/core/extensions/types.ts";
import type { ModelRuntime } from "../../src/core/model-runtime.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { createBashToolDefinition } from "../../src/core/tools/bash.ts";
import { createBashOutputToolDefinition, JobManager, looksLongRunning } from "../../src/core/tools/bash-jobs.ts";
import { buildJobsMarkdown } from "../../src/modes/interactive/extend-commands.ts";
import { getShellEnv } from "../../src/utils/shell.ts";

let root: string;
let jobs: JobManager;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "runkiln-jobs-"));
	jobs = new JobManager();
});

afterEach(() => {
	jobs.killAll();
	rmSync(root, { recursive: true, force: true });
});

const node = (code: string) => `${JSON.stringify(process.execPath)} -e ${JSON.stringify(code)}`;
const text = (result: { content: Array<{ type: string; text?: string }> }) =>
	result.content.map((part) => part.text ?? "").join("");

describe("long-running command detection", () => {
	it.each([
		"npm run dev",
		"pnpm dev",
		"yarn start",
		"npx vite",
		"vite --port 3000",
		"next dev",
		"tsc --watch",
		"vitest",
		"python -m http.server 8000",
		"uvicorn app:app --reload",
		"docker compose up",
		"tail -f log.txt",
		"cd web && npm run dev",
	])("flags %s", (command) => {
		expect(looksLongRunning(command)).toBe(true);
	});

	it.each([
		"npm test",
		"npm run build",
		"vitest run",
		"npx vitest --run",
		"ls -la",
		"docker compose up -d",
		"npm run dev &",
		"git status",
	])("leaves %s alone", (command) => {
		expect(looksLongRunning(command)).toBe(false);
	});
});

describe("job manager", () => {
	it("reads only new output, filters lines, and reports the exit code", async () => {
		const job = jobs.start(
			node("console.log('one'); console.log('ERROR two'); setTimeout(() => console.log('three'), 300)"),
			root,
			getShellEnv(),
		);
		await jobs.waitForOutput(job.id, 2000);
		await new Promise((resolve) => setTimeout(resolve, 100));
		const first = jobs.read(job.id);
		expect(first.text).toContain("one");
		expect(jobs.read(job.id).text).toBe("");
		await jobs.waitForExit(job.id, 5000);
		expect(jobs.read(job.id, { filter: /three/ }).text).toBe("three");
		expect(jobs.get(job.id)).toMatchObject({ status: "exited", exitCode: 0, lastLine: "three" });
	});

	it("caps the buffer and says how much older output was dropped", async () => {
		const small = new JobManager({ bufferBytes: 1000 });
		const job = small.start(node("for (let i = 0; i < 500; i++) console.log('line ' + i)"), root, getShellEnv());
		await small.waitForExit(job.id, 5000);
		const read = small.read(job.id);
		expect(read.dropped).toBeGreaterThan(1000);
		expect(read.text.length).toBeLessThanOrEqual(1000);
		expect(read.text).toContain("line 499");
	});

	it("kills a job's whole process group", async () => {
		const job = jobs.start(node("setInterval(() => console.log('tick'), 50)"), root, getShellEnv());
		await jobs.waitForOutput(job.id, 2000);
		expect(jobs.runningCount).toBe(1);
		jobs.kill(job.id);
		expect(await jobs.waitForExit(job.id, 3000)).toBe(true);
		expect(jobs.get(job.id)?.status).toBe("killed");
		expect(jobs.get("1")?.id).toBe(job.id);
	});
});

describe("bash background and bash_output", () => {
	it("background: true returns a job id at once; bash_output reads, waits, filters and kills", async () => {
		const bash = createBashToolDefinition(root, { jobs });
		const output = createBashOutputToolDefinition(jobs);
		const started = await bash.execute(
			"c1",
			{
				command: node(
					"let i = 0; console.log('server ready on :5173'); setInterval(() => console.log('req ' + i++), 100)",
				),
				background: true,
			},
			undefined,
			undefined,
			undefined as never,
		);
		expect(text(started)).toMatch(/Started job-1 in the background/);
		expect(text(started)).toContain("server ready on :5173");
		const read = await output.execute(
			"c2",
			{ job_id: "job-1", wait: 2, filter: "req [0-9]+" },
			undefined,
			undefined,
			undefined as never,
		);
		expect(text(read)).toMatch(/\[job-1 running/);
		expect(text(read)).toMatch(/req \d+/);
		expect(text(read).split("\n").slice(1).join("\n")).not.toContain("server ready");
		const killed = await output.execute(
			"c3",
			{ job_id: "job-1", kill: true },
			undefined,
			undefined,
			undefined as never,
		);
		expect(text(killed)).toContain("job-1 killed");
		const missing = await output.execute("c4", { job_id: "job-9" }, undefined, undefined, undefined as never);
		expect(missing.isError).toBe(true);
		expect(text(missing)).toContain("No job job-9");
	});

	it("moves a long-running foreground command to the background after autoBackgroundSeconds", async () => {
		const bash = createBashToolDefinition(root, { jobs, autoBackgroundSeconds: 0.5 });
		const result = await bash.execute(
			"c1",
			{ command: `${node("setInterval(() => console.log('watching'), 100)")} -- --watch` },
			undefined,
			undefined,
			undefined as never,
		);
		expect(text(result)).toContain("moved to the background as job-1");
		expect(text(result)).toContain("Next time pass background: true");
		expect(jobs.get("job-1")).toMatchObject({ status: "running", origin: "auto" });
	});

	it("a long-running-looking command that exits in time returns normally", async () => {
		const bash = createBashToolDefinition(root, { jobs, autoBackgroundSeconds: 5 });
		const ok = await bash.execute(
			"c1",
			{ command: `${node("console.log('built')")} -- --watch` },
			undefined,
			undefined,
			undefined as never,
		);
		expect(text(ok)).toBe("built");
		const failed = await bash.execute(
			"c2",
			{ command: `${node("process.exit(4)")} -- --watch` },
			undefined,
			undefined,
			undefined as never,
		);
		expect(failed.isError).toBe(true);
		expect(text(failed)).toContain("Command exited with code 4");
	});

	it("without a job manager the bash schema has no background parameter", () => {
		const plain = createBashToolDefinition(root);
		expect(Object.keys((plain.parameters as { properties: object }).properties)).toEqual(["command", "timeout"]);
		expect(
			Object.keys((createBashToolDefinition(root, { jobs }).parameters as { properties: object }).properties),
		).toContain("background");
	});

	it("lists jobs for /jobs", async () => {
		const job = jobs.start(node("console.log('hello'); setInterval(() => {}, 1000)"), root, getShellEnv());
		await jobs.waitForOutput(job.id, 2000);
		const md = buildJobsMarkdown(jobs);
		expect(md).toMatch(/\| \*\*job-1\*\* \| running \| \d+s \| \d+ \|/);
		expect(md).toContain("hello");
		expect(buildJobsMarkdown([])).toContain("No background jobs");
	});
});

describe("jobs in a session", () => {
	let faux: FauxProviderRegistration;
	let agentDir: string;
	let projectDir: string;
	const runtime = {
		getModelById: () => undefined,
		hasConfiguredAuth: () => true,
		streamSimple: (model: Model<Api>, context: Context, options?: SimpleStreamOptions) =>
			streamSimple(model, context, options),
	} as unknown as ModelRuntime;

	beforeEach(() => {
		faux = registerFauxProvider();
		agentDir = join(root, "agent");
		projectDir = join(root, "project");
		for (const dir of [agentDir, projectDir]) mkdirSync(dir, { recursive: true });
		writeFileSync(join(agentDir, "settings.json"), "{}");
	});
	afterEach(() => faux.unregister());

	async function open(permissionMode: "allow-all" | "plan" = "allow-all") {
		const { session } = await createAgentSession({
			cwd: projectDir,
			agentDir,
			modelRuntime: runtime,
			model: faux.getModel(),
			settingsManager: SettingsManager.create(projectDir, agentDir),
			sessionManager: SessionManager.inMemory(projectDir),
			thinkingLevel: "off",
			permissionMode,
		});
		const setStatus = vi.fn();
		await session.bindExtensions({
			uiContext: { notify: vi.fn(), select: vi.fn(), confirm: vi.fn(), setStatus } as unknown as ExtensionUIContext,
			mode: "tui",
		});
		return { session, setStatus };
	}

	it("offers bash_output with bash, runs a background job, shows it in the footer, and kills it on dispose", async () => {
		const { session, setStatus } = await open();
		expect(session.getActiveToolNames()).toEqual(expect.arrayContaining(["bash", "bash_output"]));
		const declared: string[] = [];
		faux.setResponses([
			(context) => {
				declared.push(...getCurrentTools(context.messages).map((t) => t.name));
				return fauxAssistantMessage(
					[
						fauxToolCall("bash", {
							command: node("console.log('up'); setInterval(() => {}, 1000)"),
							background: true,
						}),
					],
					{ stopReason: "toolUse" },
				);
			},
			fauxAssistantMessage([fauxToolCall("bash_output", { job_id: "job-1" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("server running"),
		]);
		await session.prompt("start the dev server");
		expect(declared).toContain("bash_output");
		const results = session.messages.filter((m): m is ToolResultMessage => m.role === "toolResult");
		expect(results.map((r) => r.toolName)).toEqual(["bash", "bash_output"]);
		expect(results.every((r) => !r.isError)).toBe(true);
		expect(setStatus).toHaveBeenCalledWith("jobs", expect.stringContaining("job-1 running"));
		expect(session.jobs.runningCount).toBe(1);
		session.dispose();
		expect(session.jobs.runningCount).toBe(0);
	});

	it("plan mode blocks background bash like any bash call", async () => {
		const { session } = await open("plan");
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 100", background: true })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("ok"),
		]);
		await session.prompt("start it");
		const result = session.messages.find((m): m is ToolResultMessage => m.role === "toolResult")!;
		expect(result.isError).toBe(true);
		expect(session.jobs.list()).toHaveLength(0);
		session.dispose();
	});
});
