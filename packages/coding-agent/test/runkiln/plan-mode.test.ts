import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import { setKeybindings } from "@runkiln/tui";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../../src/core/keybindings.ts";
import type { ModelRuntime } from "../../src/core/model-runtime.ts";
import type { SavedRule } from "../../src/core/runkiln/permission-rules.ts";
import { parseRule } from "../../src/core/runkiln/permission-rules.ts";
import {
	nextPermissionMode,
	PermissionGate,
	type PermissionMode,
	parsePermissionMode,
	planModeBlockReason,
	setProcessPermissionMode,
} from "../../src/core/runkiln/permissions.ts";
import {
	extractPlan,
	lastAssistantText,
	PLAN_MODE_MESSAGE_TYPE,
	type PlanAnswer,
} from "../../src/core/runkiln/plan-mode.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import {
	PermissionRulesViewComponent,
	type RuleViewEntry,
} from "../../src/modes/interactive/components/permission-rules-view.ts";
import { PlanApprovalComponent } from "../../src/modes/interactive/components/plan-approval.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../src/utils/ansi.ts";

const builtin = { builtin: true };
let project: string;
let keysDir: string;

beforeAll(() => {
	initTheme("dark");
	keysDir = mkdtempSync(join(tmpdir(), "runkiln-plan-keys-"));
	setKeybindings(KeybindingsManager.create(keysDir));
	project = mkdtempSync(join(tmpdir(), "runkiln-plan-gate-"));
	writeFileSync(join(project, "a.ts"), "");
});
afterAll(() => {
	rmSync(keysDir, { recursive: true, force: true });
	rmSync(project, { recursive: true, force: true });
});

describe("plan mode in the gate", () => {
	it("is a mode with aliases, placed after read & write as in Claude Code's cycle", () => {
		expect(parsePermissionMode("plan")).toBe("plan");
		expect(parsePermissionMode("Read Only")).toBe("plan");
		expect(nextPermissionMode("read-write", { autoAvailable: true, includeAllowAll: false })).toBe("plan");
	});

	it("runs the genuine read tools and blocks every write, edit, command and other tool", async () => {
		const gate = new PermissionGate({ mode: "plan" });
		for (const [tool, args] of [
			["read", { path: "a.ts" }],
			["grep", { pattern: "x" }],
			["find", { pattern: "*.ts" }],
			["ls", {}],
		] as const) {
			expect((await gate.decide(tool, args, project, builtin)).action, tool).toBe("allow");
		}
		for (const [tool, args] of [
			["write", { path: "a.ts", content: "x" }],
			["edit", { path: "a.ts", edits: [] }],
			["bash", { command: "ls" }],
			["powershell", { command: "Get-ChildItem" }],
			["mcp__github__create_issue", { title: "x" }],
		] as const) {
			const decision = await gate.decide(tool, args, project, builtin);
			expect(decision, tool).toEqual({ action: "deny", via: "plan", reason: planModeBlockReason(tool) });
		}
		// A read tool replaced by an extension is not trusted in plan mode either.
		expect((await gate.decide("read", { path: "a.ts" }, project, {})).action).toBe("deny");
	});

	it("allow rules do not lift plan mode; deny and ask rules still apply to reads", async () => {
		const rule = (action: SavedRule["action"], text: string): SavedRule => ({
			action,
			scope: "global",
			text,
			rule: parseRule(text) as SavedRule["rule"],
		});
		const gate = new PermissionGate({
			mode: "plan",
			savedRules: () => [rule("allow", "Bash"), rule("deny", "Read(.env)"), rule("ask", "Read(secrets/**)")],
		});
		expect((await gate.decide("bash", { command: "ls" }, project, builtin)).action).toBe("deny");
		const env = await gate.decide("read", { path: ".env" }, project, builtin);
		expect(env.action === "deny" && env.via).toBe("rule");
		expect((await gate.decide("read", { path: "secrets/k" }, project, builtin)).action).toBe("ask");
	});

	it("remembers the mode it was entered from, and starts from the saved mode when it starts in plan", () => {
		const gate = new PermissionGate({ mode: "ask" });
		gate.setMode("plan");
		expect(gate.modeBeforePlan).toBe("ask");
		const started = new PermissionGate({ mode: "plan", planReturnMode: () => "auto" });
		expect(started.modeBeforePlan).toBe("auto");
		expect(new PermissionGate({ mode: "plan", planReturnMode: () => "plan" }).modeBeforePlan).toBe("read-write");
	});
});

describe("recognizing a plan", () => {
	it("takes the last plan heading to the end, and ignores questions", () => {
		const text = "I looked around.\n\n## Plan\n1. Edit a.ts\n2. Run npm test";
		expect(extractPlan(text)).toBe("## Plan\n1. Edit a.ts\n2. Run npm test");
		expect(extractPlan("# Proposed plan: cache\n- step")).toBe("# Proposed plan: cache\n- step");
		expect(extractPlan("Which database should I use?")).toBeUndefined();
		expect(extractPlan("## Plan")).toBeUndefined();
		expect(extractPlan("The planner module is slow.\n## Planning notes")).toBeUndefined();
	});

	it("reads the last finished assistant message", () => {
		const msg = (stopReason: string) => ({
			role: "assistant",
			stopReason,
			content: [{ type: "text", text: "## Plan\n1. x" }],
		});
		expect(lastAssistantText([msg("stop")])).toBe("## Plan\n1. x");
		expect(lastAssistantText([msg("aborted")])).toBeUndefined();
		expect(lastAssistantText([msg("stop"), { role: "user", content: "hi" }])).toBeUndefined();
	});
});

describe("plan-approval prompt", () => {
	function open(plan = "## Plan\n1. Edit a.ts\n2. Run npm test") {
		const answers: Array<PlanAnswer | undefined> = [];
		const component = new PlanApprovalComponent({ plan, returnMode: "read-write", onAnswer: (a) => answers.push(a) });
		return { component, answers, text: () => stripAnsi(component.render(90).join("\n")) };
	}

	it("shows the plan and the three choices with the mode it returns to", () => {
		const shown = open().text();
		expect(shown).toContain("Ready to run this plan?");
		expect(shown).toContain("1. Edit a.ts");
		expect(shown).toContain("Yes, run the plan (switch to Read & write)");
		expect(shown).toContain("No, keep planning");
		expect(shown).toContain("Discard the plan");
	});

	it("approves with y or enter, discards with d, closes with esc", () => {
		const a = open();
		a.component.handleInput("\r");
		expect(a.answers).toEqual([{ choice: "approve" }]);
		const b = open();
		b.component.handleInput("d");
		expect(b.answers).toEqual([{ choice: "discard" }]);
		const c = open();
		c.component.handleInput("\u001b");
		expect(c.answers).toEqual([undefined]);
	});

	it("keep planning asks what to change and sends it", () => {
		const { component, answers, text } = open();
		component.handleInput("r");
		expect(text()).toContain("What should change in the plan?");
		for (const ch of "use a map") component.handleInput(ch);
		component.handleInput("\r");
		expect(answers).toEqual([{ choice: "refine", feedback: "use a map" }]);
	});

	it("cuts a long plan and expands it", () => {
		const long = ["## Plan", ...Array.from({ length: 40 }, (_, i) => `${i + 1}. step`)].join("\n");
		const { component, text } = open(long);
		expect(text()).toContain("more lines");
		component.handleInput("\u000f"); // ctrl+o, the default expand key
		expect(text()).toContain("40. step");
	});
});

describe("/permissions rules view", () => {
	const entries: RuleViewEntry[] = [
		{ scope: "global", action: "allow", text: "Bash(npm test:*)", removable: true },
		{ scope: "session", action: "allow", text: "reads and searches", removable: true, sessionIndex: 0 },
		{ scope: "session", action: "allow", text: "commands starting with `ls`", removable: true, sessionIndex: 1 },
		{ scope: "project-file", action: "deny", text: "Read(.env)", removable: false },
		{
			scope: "project-file",
			action: "allow",
			text: "Bash",
			ignored: "a project's settings can only tighten permissions",
			removable: false,
		},
		{ scope: "global", action: "deny", text: "Bash(rm -rf:*)", removable: true },
	];

	it("groups rules by scope (session first, deny before allow) and removes single rules", () => {
		const removed: RuleViewEntry[] = [];
		const view = new PermissionRulesViewComponent({
			entries,
			onRemove: (entry) => {
				removed.push({ ...entry });
				return true;
			},
			onClose: vi.fn(),
		});
		expect(view.list.map((entry) => `${entry.scope}:${entry.text}`)).toEqual([
			"session:reads and searches",
			"session:commands starting with `ls`",
			"global:Bash(rm -rf:*)",
			"global:Bash(npm test:*)",
			"project-file:Read(.env)",
			"project-file:Bash",
		]);
		const shown = stripAnsi(view.render(110).join("\n"));
		expect(shown).toContain("This session (not saved)");
		expect(shown).toContain("ignored: a project's settings can only tighten");
		view.handleInput("d"); // first session rule
		expect(removed[0]).toMatchObject({ scope: "session", sessionIndex: 0 });
		// The next session rule moved up to index 0.
		view.handleInput("d");
		expect(removed[1]).toMatchObject({ scope: "session", sessionIndex: 0 });
		view.handleInput("\u001b[B");
		view.handleInput("\u001b[B");
		view.handleInput("d"); // project-file rule: read-only
		expect(removed).toHaveLength(2);
		expect(stripAnsi(view.render(110).join("\n"))).toContain("edit that file");
	});
});

/** Plan mode as the session runs it: blocked calls, the hidden instructions, approve and discard. */
describe("plan mode on the session", () => {
	let root: string;
	let agentDir: string;
	let projectDir: string;
	let faux: FauxProviderRegistration;
	const contexts: string[] = [];
	const runtime = {
		getModelById: () => undefined,
		hasConfiguredAuth: () => true,
		streamSimple: (model: Model<Api>, context: Context, options?: SimpleStreamOptions) =>
			streamSimple(model, context, options),
	} as unknown as ModelRuntime;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "runkiln-plan-session-"));
		agentDir = join(root, "agent");
		projectDir = join(root, "project");
		for (const dir of [agentDir, projectDir, join(root, "sessions")]) mkdirSync(dir, { recursive: true });
		writeFileSync(join(projectDir, "notes.txt"), "old");
		faux = registerFauxProvider();
		contexts.length = 0;
		vi.stubEnv("TYPESAFE_API_KEY", "");
		vi.stubEnv("OPENROUTER_API_KEY", "");
	});
	afterEach(() => {
		faux.unregister();
		setProcessPermissionMode(undefined);
		vi.unstubAllEnvs();
		rmSync(root, { recursive: true, force: true });
	});

	async function openSession(mode: PermissionMode) {
		const { session } = await createAgentSession({
			cwd: projectDir,
			agentDir,
			modelRuntime: runtime,
			model: faux.getModel(),
			sessionManager: SessionManager.create(projectDir, join(root, "sessions")),
			thinkingLevel: "off",
			permissionMode: mode,
		});
		session.setActiveToolsByName(["read", "write", "bash"]);
		return session;
	}

	const recording = (message: ReturnType<typeof fauxAssistantMessage>) => (context: unknown) => {
		contexts.push(JSON.stringify(context));
		return message;
	};

	const toolResults = (messages: readonly { role: string }[]) =>
		messages.filter((m): m is ToolResultMessage => m.role === "toolResult");

	it("blocks writes and commands, tells the model it is in plan mode, and approve runs the plan in the previous mode", async () => {
		const session = await openSession("read-write");
		expect(session.setPermissionMode("plan", { persist: true })).toBeUndefined();
		faux.setResponses([
			recording(
				fauxAssistantMessage(
					[fauxToolCall("write", { path: "notes.txt", content: "new" }), fauxToolCall("bash", { command: "ls" })],
					{ stopReason: "toolUse" },
				),
			),
			recording(fauxAssistantMessage("Looked around.\n\n## Plan\n1. Overwrite notes.txt")),
		]);
		await session.prompt("change the notes");
		const [write, bash] = toolResults(session.messages);
		expect(write.isError).toBe(true);
		expect(JSON.stringify(write.content)).toContain("plan mode is on");
		expect(bash.isError).toBe(true);
		expect(readFileSync(join(projectDir, "notes.txt"), "utf8")).toBe("old");
		expect(contexts[0]).toContain("Plan mode is on (RunKiln permission mode `plan`)");
		const hidden = session.messages.find((m) => m.role === "custom") as { customType?: string; display?: boolean };
		expect(hidden).toMatchObject({ customType: PLAN_MODE_MESSAGE_TYPE, display: false });
		expect(extractPlan(lastAssistantText(session.messages as never) ?? "")).toContain("Overwrite notes.txt");
		// Plan mode is never saved as the default.
		await session.settingsManager.flush();
		expect(session.settingsManager.getPermissionMode()).toBeUndefined();

		faux.setResponses([
			recording(
				fauxAssistantMessage([fauxToolCall("write", { path: "notes.txt", content: "new" })], {
					stopReason: "toolUse",
				}),
			),
			fauxAssistantMessage("done"),
		]);
		const result = await session.approvePlan();
		expect(result).toEqual({ mode: "read-write" });
		expect(session.permissionMode).toBe("read-write");
		expect(contexts.at(-1)).toContain("Plan approved. Plan mode is off (permissions: Read & write)");
		expect(readFileSync(join(projectDir, "notes.txt"), "utf8")).toBe("new");
		session.dispose();
	});

	it("discard leaves plan mode and tells the model on the next run; leaving by the cycle key says plan mode is off", async () => {
		const session = await openSession("ask");
		session.setPermissionMode("plan");
		faux.setResponses([recording(fauxAssistantMessage("## Plan\n1. x"))]);
		await session.prompt("plan it");
		expect(session.discardPlan()).toBe("ask");
		faux.setResponses([recording(fauxAssistantMessage("ok"))]);
		await session.prompt("something else");
		expect(contexts.at(-1)).toContain("The user discarded the plan above");

		session.setPermissionMode("plan");
		faux.setResponses([recording(fauxAssistantMessage("q?"))]);
		await session.prompt("again");
		faux.setResponses([recording(fauxAssistantMessage("still?"))]);
		await session.prompt("more");
		expect(contexts.at(-1)).toContain("Plan mode is still on");
		session.setPermissionMode("read-write");
		faux.setResponses([recording(fauxAssistantMessage("ok"))]);
		await session.prompt("go on");
		expect(contexts.at(-1)).toContain("Plan mode is off. The permission mode is now Read & write");
		session.dispose();
	});

	it("allow-project saves the rule to this project's list in global settings", async () => {
		const session = await openSession("read-write");
		session.setApprovalPrompt(async (prompt) => {
			expect(prompt.projectLabel).toBe("Always allow `printf` commands in this project (saved)");
			return { choice: "allow-project" };
		});
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "printf hi" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await session.prompt("print");
		await session.settingsManager.flush();
		const settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
		expect(Object.values(settings.permissions.projects)).toEqual([{ allow: ["Bash(printf:*)"] }]);
		expect(session.getSavedPermissionRules().rules.map((rule) => `${rule.scope} ${rule.text}`)).toEqual([
			"project Bash(printf:*)",
		]);
		expect(session.removeSavedPermissionRule("project", "allow", "Bash(printf:*)")).toBe(true);
		expect(session.getSavedPermissionRules().rules).toEqual([]);
		session.dispose();
	});
});
