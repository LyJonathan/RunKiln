import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
	type ToolResultMessage,
} from "@runkiln/ai/compat";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionUIContext } from "../../src/core/extensions/types.ts";
import { loadHooks, matcherMatches, parseHooksObject, projectHooksFingerprint } from "../../src/core/hooks/config.ts";
import { interpretHookRun, parseHookStdout, runCommandHook } from "../../src/core/hooks/exec.ts";
import { HookManager } from "../../src/core/hooks/manager.ts";
import { CommandTrustStore } from "../../src/core/hooks/trust.ts";
import type { ModelRuntime } from "../../src/core/model-runtime.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { buildHooksMarkdown } from "../../src/modes/interactive/extend-commands.ts";

let root: string;
let agentDir: string;
let projectDir: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "runkiln-hooks-"));
	agentDir = join(root, "agent");
	projectDir = join(root, "project");
	for (const dir of [agentDir, projectDir, join(projectDir, ".runkiln")]) mkdirSync(dir, { recursive: true });
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

/** A hook script (node) in the temp folder; returns the command that runs it. */
function script(name: string, body: string): string {
	const path = join(root, `${name}.mjs`);
	writeFileSync(
		path,
		`import { readFileSync, appendFileSync } from "node:fs";\nconst input = JSON.parse(readFileSync(0, "utf8"));\n${body}\n`,
	);
	return `node ${JSON.stringify(path)}`;
}

describe("hook config (Claude Code format)", () => {
	it("reads command hooks per event and matcher group, skips other types and reports unknown events", () => {
		const parsed = parseHooksObject(
			{
				PreToolUse: [
					{ matcher: "Bash", hooks: [{ type: "command", command: "./a.sh", timeout: 5, if: "Bash(git *)" }] },
					{
						hooks: [
							{ type: "http", url: "http://x" },
							{ type: "prompt", prompt: "?" },
						],
					},
				],
				Stop: [{ hooks: [{ type: "command", command: "./stop.sh", onFailure: "block" }] }],
				FileChanged: [{ hooks: [{ type: "command", command: "x" }] }],
				PostToolUse: "nope",
			},
			"global",
			"settings",
		);
		expect(parsed.entries.map((e) => [e.event, e.matcher, e.hook.command])).toEqual([
			["PreToolUse", "Bash", "./a.sh"],
			["Stop", "", "./stop.sh"],
		]);
		expect(parsed.entries[0]!.hook).toMatchObject({ timeout: 5, if: "Bash(git *)" });
		expect(parsed.entries[1]!.hook.onFailure).toBe("block");
		expect(parsed.skipped).toBe(2);
		expect(parsed.problems.map((p) => p.message)).toEqual([
			expect.stringContaining("FileChanged: not an event RunKiln runs"),
			"PostToolUse: expected an array of matcher groups",
		]);
	});

	it("matches like Claude Code: all, exact lists, regexes, and Claude's tool names for RunKiln's tools", () => {
		expect(matcherMatches("", ["bash"])).toBe(true);
		expect(matcherMatches("*", ["bash"])).toBe(true);
		expect(matcherMatches("Bash", ["bash", "Bash"])).toBe(true);
		expect(matcherMatches("Edit|Write", ["write", "Write"])).toBe(true);
		expect(matcherMatches("Edit, Write", ["read", "Read"])).toBe(false);
		expect(matcherMatches("mcp__memory__.*", ["mcp__memory__create"])).toBe(true);
		// Exact-character matchers are exact: a server prefix without .* matches nothing.
		expect(matcherMatches("mcp__memory", ["mcp__memory__create"])).toBe(false);
		expect(matcherMatches("^Notebook", ["NotebookEdit"])).toBe(true);
		expect(matcherMatches("(", ["x"])).toBe(false);
	});

	it("reads project hooks only in a trusted folder, .claude ones only with claudeHooks, and dedupes", () => {
		const hooks = { PostToolUse: [{ matcher: "edit", hooks: [{ type: "command", command: "fmt" }] }] };
		writeFileSync(join(projectDir, ".runkiln", "settings.json"), JSON.stringify({ hooks }));
		writeFileSync(join(projectDir, ".runkiln", "settings.local.json"), JSON.stringify({ hooks }));
		mkdirSync(join(projectDir, ".claude"));
		writeFileSync(
			join(projectDir, ".claude", "settings.json"),
			JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "claude-stop" }] }] } }),
		);
		const global = { hooks: { SessionStart: [{ hooks: [{ type: "command", command: "hello" }] }] } };
		expect(loadHooks({ globalSettings: global, cwd: projectDir, projectTrusted: false }).entries).toHaveLength(1);
		const trusted = loadHooks({ globalSettings: global, cwd: projectDir, projectTrusted: true });
		expect(trusted.entries.map((e) => `${e.scope}:${e.hook.command}`)).toEqual(["global:hello", "project:fmt"]);
		const claude = loadHooks({
			globalSettings: { ...global, claudeHooks: true },
			cwd: projectDir,
			projectTrusted: true,
		});
		expect(claude.entries.map((e) => `${e.scope}:${e.hook.command}`)).toContain("claude:claude-stop");
		expect(
			loadHooks({ globalSettings: { ...global, disableAllHooks: true }, cwd: projectDir, projectTrusted: true }),
		).toMatchObject({
			disabled: true,
			entries: [],
		});
	});

	it("fingerprints project hooks only, so a changed command asks again", () => {
		const entries = parseHooksObject(
			{ Stop: [{ hooks: [{ type: "command", command: "a" }] }] },
			"project",
			"p",
		).entries;
		const changed = parseHooksObject(
			{ Stop: [{ hooks: [{ type: "command", command: "b" }] }] },
			"project",
			"p",
		).entries;
		const global = parseHooksObject(
			{ Stop: [{ hooks: [{ type: "command", command: "a" }] }] },
			"global",
			"g",
		).entries;
		expect(projectHooksFingerprint(entries)).toMatch(/^[0-9a-f]{32}$/);
		expect(projectHooksFingerprint(changed)).not.toBe(projectHooksFingerprint(entries));
		expect(projectHooksFingerprint(global)).toBeUndefined();
	});
});

describe("running one hook", () => {
	const hook = (command: string, extra: object = {}) => ({ type: "command" as const, command, ...extra });

	it("sends the input as JSON on stdin and sets RUNKILN_PROJECT_DIR / CLAUDE_PROJECT_DIR", async () => {
		const cmd = script(
			"env",
			`process.stdout.write(JSON.stringify({ hookSpecificOutput: { additionalContext: input.tool_name + " " + process.env.RUNKILN_PROJECT_DIR + " " + process.env.CLAUDE_PROJECT_DIR } }));`,
		);
		const run = await runCommandHook(hook(cmd), { tool_name: "bash" }, { cwd: projectDir, event: "PreToolUse" });
		const outcome = interpretHookRun(hook(cmd), run);
		expect(outcome.kind).toBe("success");
		expect(outcome.json?.hookSpecificOutput?.additionalContext).toBe(`bash ${projectDir} ${projectDir}`);
	});

	it("exit 2 blocks with stderr; another code is a non-blocking error; onFailure block turns it into a block", async () => {
		const blocker = script("block", `process.stderr.write("no rm please"); process.exit(2);`);
		const failing = script("fail", `process.stderr.write("broken\\nmore"); process.exit(1);`);
		const blocked = interpretHookRun(
			hook(blocker),
			await runCommandHook(hook(blocker), {}, { cwd: root, event: "PreToolUse" }),
		);
		expect(blocked).toMatchObject({ kind: "block", reason: "no rm please" });
		const error = interpretHookRun(
			hook(failing),
			await runCommandHook(hook(failing), {}, { cwd: root, event: "PreToolUse" }),
		);
		expect(error.kind).toBe("error");
		expect(error.error).toContain("non-blocking status code 1: broken");
		const strict = hook(failing, { onFailure: "block" });
		expect(interpretHookRun(strict, await runCommandHook(strict, {}, { cwd: root, event: "PreToolUse" })).kind).toBe(
			"block",
		);
		const missing = hook("definitely-not-a-command-xyz");
		const notFound = interpretHookRun(missing, await runCommandHook(missing, {}, { cwd: root, event: "PreToolUse" }));
		expect(notFound.kind).toBe("error");
	});

	it("kills a hook at its timeout", async () => {
		const slow = hook(script("slow", "setTimeout(() => {}, 60_000);"), { timeout: 0.3 });
		const started = Date.now();
		const run = await runCommandHook(slow, {}, { cwd: root, event: "PreToolUse" });
		expect(run.timedOut).toBe(true);
		expect(Date.now() - started).toBeLessThan(5000);
		expect(interpretHookRun(slow, run)).toMatchObject({ kind: "error" });
	});

	it("reads stdout as JSON only when it is one object", () => {
		expect(parseHookStdout('{"decision":"block"}')).toEqual({ json: { decision: "block" } });
		expect(parseHookStdout("plain words")).toEqual({ text: "plain words" });
		expect(parseHookStdout("[1,2]")).toEqual({ text: "[1,2]" });
		expect(parseHookStdout("{not json}").parseError).toBeTruthy();
	});
});

describe("hook manager", () => {
	function manager(global: Record<string, unknown>, projectTrusted = true) {
		return new HookManager({
			cwd: projectDir,
			trust: new CommandTrustStore(agentDir),
			globalSettings: () => global,
			projectTrusted: () => projectTrusted,
			commonInput: () => ({ session_id: "s1", permission_mode: "default" }),
		});
	}

	it("folds a JSON deny, updatedInput and additionalContext for PreToolUse, filtered by matcher and if", async () => {
		const deny = script(
			"deny",
			`process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "no pushes" } }));`,
		);
		const rewrite = script(
			"rewrite",
			`process.stdout.write(JSON.stringify({ hookSpecificOutput: { updatedInput: { command: "echo safe" }, additionalContext: "rewritten" } }));`,
		);
		const m = manager({
			hooks: {
				PreToolUse: [
					{ matcher: "Bash", hooks: [{ type: "command", command: deny, if: "Bash(git push *)" }] },
					{ matcher: "bash", hooks: [{ type: "command", command: rewrite, if: "Bash(rm *)" }] },
					{ matcher: "Edit", hooks: [{ type: "command", command: deny }] },
				],
			},
		});
		const push = await m.run("PreToolUse", {}, { tool: { name: "bash", input: { command: "git push origin" } } });
		expect(push).toMatchObject({ ran: 1, blocked: true, reason: "no pushes" });
		const rm = await m.run("PreToolUse", {}, { tool: { name: "bash", input: { command: "rm -rf build" } } });
		expect(rm).toMatchObject({
			ran: 1,
			blocked: false,
			updatedInput: { command: "echo safe" },
			context: ["rewritten"],
		});
		const ls = await m.run("PreToolUse", {}, { tool: { name: "bash", input: { command: "ls" } } });
		expect(ls.ran).toBe(0);
	});

	it("runs project hooks only after trust, and asks again when they change", async () => {
		const marker = join(root, "ran.txt");
		const cmd = script("mark", `appendFileSync(${JSON.stringify(marker)}, input.hook_event_name + "\\n");`);
		const settingsPath = join(projectDir, ".runkiln", "settings.json");
		writeFileSync(
			settingsPath,
			JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: cmd }] }] } }),
		);
		const m = manager({});
		expect(m.projectHooksTrusted).toBe(false);
		expect(m.untrustedProjectHooks).toHaveLength(1);
		expect((await m.run("Stop", {})).ran).toBe(0);
		m.trustProjectHooks(true);
		expect((await m.run("Stop", {})).ran).toBe(1);
		expect(readFileSync(marker, "utf8")).toBe("Stop\n");
		// Remembered across managers (sessions)...
		expect(manager({}).projectHooksTrusted).toBe(true);
		// ...until a command changes.
		writeFileSync(
			settingsPath,
			JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: `${cmd} --changed` }] }] } }),
		);
		expect(manager({}).projectHooksTrusted).toBe(false);
	});

	it("lists hooks for /hooks with where they come from and whether they run", () => {
		writeFileSync(
			join(projectDir, ".runkiln", "settings.json"),
			JSON.stringify({
				hooks: {
					PostToolUse: [{ matcher: "edit|write", hooks: [{ type: "command", command: "npx biome format" }] }],
				},
			}),
		);
		const md = buildHooksMarkdown(
			manager({ hooks: { Stop: [{ hooks: [{ type: "command", command: "say done", timeout: 9 }] }] } }),
		);
		expect(md).toContain("| PostToolUse | `edit\\|write` | `npx biome format` | 600s | project | ◇ |");
		expect(md).toContain("| Stop | `*` | `say done` | 9s | global | ✓ |");
		expect(md).toContain("Project hooks from `.runkiln/settings.json`.");
		expect(md).toContain("/hooks trust");
	});
});

describe("hooks in a session", () => {
	let faux: FauxProviderRegistration;
	const runtime = {
		getModelById: () => undefined,
		hasConfiguredAuth: () => true,
		streamSimple: (model: Model<Api>, context: Context, options?: SimpleStreamOptions) =>
			streamSimple(model, context, options),
	} as unknown as ModelRuntime;

	beforeEach(() => {
		faux = registerFauxProvider();
		writeFileSync(join(projectDir, "package.json"), "{}");
	});
	afterEach(() => faux.unregister());

	async function open(hooks: Record<string, unknown>, ui?: Partial<ExtensionUIContext>) {
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ hooks, permissions: { mode: "allow-all" } }));
		const { session } = await createAgentSession({
			cwd: projectDir,
			agentDir,
			modelRuntime: runtime,
			model: faux.getModel(),
			settingsManager: SettingsManager.create(projectDir, agentDir),
			sessionManager: SessionManager.inMemory(projectDir),
			thinkingLevel: "off",
			permissionMode: "allow-all",
		});
		const notify = vi.fn();
		await session.bindExtensions({
			uiContext: {
				notify,
				select: vi.fn(),
				confirm: vi.fn(async () => false),
				setStatus: vi.fn(),
				...ui,
			} as unknown as ExtensionUIContext,
			mode: "tui",
		});
		return { session, notify };
	}

	const toolResult = (messages: readonly { role: string }[], name: string) =>
		messages.find(
			(m): m is ToolResultMessage => m.role === "toolResult" && (m as ToolResultMessage).toolName === name,
		)!;
	const text = (r: ToolResultMessage) => r.content.map((p) => (p.type === "text" ? p.text : "")).join("");

	it("PreToolUse exit 2 blocks the bash call and the model sees the reason; the command never runs", async () => {
		const marker = join(projectDir, "should-not-exist");
		const guard = script(
			"guard",
			`if (input.tool_input.command.includes("touch")) { process.stderr.write("touch is off limits"); process.exit(2); }`,
		);
		const { session } = await open({
			PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: guard }] }],
		});
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: `touch ${marker}` })], { stopReason: "toolUse" }),
			fauxAssistantMessage("ok"),
		]);
		await session.prompt("make the file");
		const result = toolResult(session.messages, "bash");
		expect(result.isError).toBe(true);
		expect(text(result)).toContain("PreToolUse:bash hook error: touch is off limits");
		expect(existsSync(marker)).toBe(false);
		session.dispose();
	});

	it("PostToolUse feedback and UserPromptSubmit / SessionStart context reach the model", async () => {
		const post = script(
			"post",
			`process.stderr.write("lint: 2 warnings in " + input.tool_input.file_path); process.exit(2);`,
		);
		const submit = script("submit", `process.stdout.write("Current branch is feature-x");`);
		const start = script(
			"start",
			`process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "started via " + input.source } }));`,
		);
		const { session } = await open({
			PostToolUse: [{ matcher: "Write", hooks: [{ type: "command", command: post }] }],
			UserPromptSubmit: [{ hooks: [{ type: "command", command: submit }] }],
			SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: start }] }],
		});
		const seen: string[] = [];
		faux.setResponses([
			(context) => {
				seen.push(JSON.stringify(context.messages));
				return fauxAssistantMessage([fauxToolCall("write", { path: "a.txt", content: "x" })], {
					stopReason: "toolUse",
				});
			},
			fauxAssistantMessage("done"),
		]);
		await session.prompt("write a file");
		expect(seen[0]).toContain("Current branch is feature-x");
		expect(seen[0]).toContain("started via startup");
		const result = toolResult(session.messages, "write");
		expect(text(result)).toContain("PostToolUse:write hook feedback: lint: 2 warnings in a.txt");
		// Context goes in a hidden message, never the system prompt (the cached prefix stays the same).
		expect(session.systemPrompt).not.toContain("feature-x");
		session.dispose();
	});

	it("UserPromptSubmit exit 2 blocks the prompt and tells the user", async () => {
		const gate = script(
			"gate",
			`if (input.prompt.includes("secret")) { process.stderr.write("prompt mentions a secret"); process.exit(2); }`,
		);
		const { session, notify } = await open({ UserPromptSubmit: [{ hooks: [{ type: "command", command: gate }] }] });
		faux.setResponses([fauxAssistantMessage("should not be asked")]);
		await session.prompt("print the secret");
		expect(session.messages.filter((m) => m.role === "assistant")).toHaveLength(0);
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("prompt mentions a secret"), "warning");
		session.dispose();
	});

	it("a blocking Stop hook keeps the agent going once, with stop_hook_active on the next check", async () => {
		const stop = script(
			"stop",
			`if (!input.stop_hook_active) { process.stdout.write(JSON.stringify({ decision: "block", reason: "run the tests first" })); }`,
		);
		const { session } = await open({ Stop: [{ hooks: [{ type: "command", command: stop }] }] });
		faux.setResponses([fauxAssistantMessage("finished"), fauxAssistantMessage("tests pass now")]);
		await session.prompt("do it");
		const assistants = session.messages.filter((m) => m.role === "assistant");
		expect(assistants).toHaveLength(2);
		expect(JSON.stringify(session.messages)).toContain("Stop hook feedback:\\nrun the tests first");
		session.dispose();
	});

	it("does not run untrusted project hooks; the trust prompt approves them", async () => {
		const marker = join(root, "project-hook-ran");
		const cmd = script("p", `appendFileSync(${JSON.stringify(marker)}, "x");`);
		writeFileSync(
			join(projectDir, ".runkiln", "settings.json"),
			JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: cmd }] }] } }),
		);
		const select = vi.fn(async (_title: string, options: string[]) => options[2]); // "Not now"
		const first = await open({}, { select });
		expect(String(select.mock.calls[0]?.[0])).toContain("This project defines hooks");
		faux.setResponses([fauxAssistantMessage("a")]);
		await first.session.prompt("hi");
		expect(existsSync(marker)).toBe(false);
		first.session.dispose();

		const yes = vi.fn(async (_title: string, options: string[]) => options[0]); // "Trust (remember)"
		const second = await open({}, { select: yes });
		faux.setResponses([fauxAssistantMessage("b")]);
		await second.session.prompt("hi");
		expect(readFileSync(marker, "utf8")).toBe("x");
		second.session.dispose();
	});

	it("runs Notification hooks when an approval prompt opens", async () => {
		const marker = join(root, "notified.json");
		const cmd = script("n", `appendFileSync(${JSON.stringify(marker)}, JSON.stringify(input) + "\\n");`);
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({
				hooks: { Notification: [{ matcher: "permission_prompt", hooks: [{ type: "command", command: cmd }] }] },
			}),
		);
		const { session } = await createAgentSession({
			cwd: projectDir,
			agentDir,
			modelRuntime: runtime,
			model: faux.getModel(),
			settingsManager: SettingsManager.create(projectDir, agentDir),
			sessionManager: SessionManager.inMemory(projectDir),
			thinkingLevel: "off",
			permissionMode: "ask",
		});
		await session.bindExtensions({
			uiContext: {
				notify: vi.fn(),
				select: vi.fn(async () => undefined),
				setStatus: vi.fn(),
			} as unknown as ExtensionUIContext,
			mode: "tui",
		});
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "echo hi" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("ok"),
		]);
		await session.prompt("say hi");
		await vi.waitFor(() => expect(existsSync(marker)).toBe(true), { timeout: 5000 });
		const input = JSON.parse(readFileSync(marker, "utf8").split("\n")[0]!);
		expect(input).toMatchObject({
			hook_event_name: "Notification",
			notification_type: "permission_prompt",
			permission_mode: "default",
		});
		expect(input.message).toContain("Run bash command?");
		session.dispose();
	});
});
