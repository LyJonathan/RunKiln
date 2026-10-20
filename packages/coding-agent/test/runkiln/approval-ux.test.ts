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
} from "@runkiln/ai/compat";
import { setKeybindings } from "@runkiln/tui";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../../src/core/keybindings.ts";
import type { ModelRuntime } from "../../src/core/model-runtime.ts";
import { approvalRequestForToolCall, isApprovalRefusal } from "../../src/core/runkiln/approval.ts";
import {
	type ApprovalDiff,
	computeApprovalDiff,
	diffStatLabel,
	MAX_PREVIEW_DIFF_LINES,
	toApprovalDiff,
} from "../../src/core/runkiln/approval-preview.ts";
import {
	type ApprovalAnswer,
	approvalTimeoutPolicy,
	type PermissionPrompt,
} from "../../src/core/runkiln/permissions.ts";
import { type PlanAnswer, planApprovedPrompt, planEditedFeedback } from "../../src/core/runkiln/plan-mode.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { PermissionPromptComponent } from "../../src/modes/interactive/components/permission-prompt.ts";
import { PlanApprovalComponent } from "../../src/modes/interactive/components/plan-approval.ts";
import { TurnNotifier } from "../../src/modes/interactive/notifications.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../src/utils/ansi.ts";

let keysDir: string;
let project: string;
beforeAll(() => {
	initTheme("dark");
	keysDir = mkdtempSync(join(tmpdir(), "runkiln-keys-"));
	setKeybindings(KeybindingsManager.create(keysDir));
});
afterAll(() => rmSync(keysDir, { recursive: true, force: true }));
beforeEach(() => {
	project = mkdtempSync(join(tmpdir(), "runkiln-approve-ux-"));
});
afterEach(() => rmSync(project, { recursive: true, force: true }));

const CTRL_O = "\u000f";
const ENTER = "\r";

const ciFile = [
	"name: CI",
	"on:",
	"  push:",
	"    branches: [main]",
	"jobs:",
	"  test:",
	"    runs-on: ubuntu-latest",
	"    steps:",
	"      - uses: actions/checkout@v4",
	"      - run: npm ci",
	"      - run: npm test",
	"",
].join("\n");

describe("approval diff preview", () => {
	it("computes an edit's diff with the edit tool's diff, and counts added and removed lines", async () => {
		writeFileSync(join(project, "ci.yml"), ciFile);
		const diff = await computeApprovalDiff(
			"edit",
			{
				path: "ci.yml",
				edits: [
					{ oldText: "    branches: [main]", newText: "    branches: [main]\n  pull_request:" },
					{ oldText: "      - run: npm test", newText: "      - run: npm run check\n      - run: npm test" },
				],
			},
			project,
		);
		expect(diff?.error).toBeUndefined();
		// Both edits only insert lines.
		expect(diff).toMatchObject({ added: 2, removed: 0 });
		expect(diff?.newFile).toBeUndefined();
		expect(diff?.text).toContain("+ 5   pull_request:");
		expect(diff?.text).toMatch(/\+\d+ {7}- run: npm run check/);
		expect(diffStatLabel(diff as ApprovalDiff)).toBe("+2 −0");
	});

	it("reads edits the way the edit tool does: a JSON string, a single object, or oldText/newText", async () => {
		writeFileSync(join(project, "a.txt"), "one\ntwo\n");
		const asString = await computeApprovalDiff(
			"edit",
			{ path: "a.txt", edits: JSON.stringify([{ oldText: "two", newText: "2" }]) },
			project,
		);
		const legacy = await computeApprovalDiff("edit", { path: "a.txt", oldText: "one", newText: "1" }, project);
		expect(asString).toMatchObject({ added: 1, removed: 1 });
		expect(legacy).toMatchObject({ added: 1, removed: 1 });
	});

	it("says why there is no diff when the edit text is not in the file", async () => {
		writeFileSync(join(project, "a.txt"), "one\n");
		const diff = await computeApprovalDiff(
			"edit",
			{ path: "a.txt", edits: [{ oldText: "missing", newText: "x" }] },
			project,
		);
		expect(diff?.error).toBeTruthy();
		expect(diff?.text).toBe("");
	});

	it("diffs a write against the file on disk, and shows a new file whole", async () => {
		writeFileSync(join(project, "notes.md"), "a\nb\nc\n");
		const overwrite = await computeApprovalDiff("write", { path: "notes.md", content: "a\nB\nc\n" }, project);
		expect(overwrite).toMatchObject({ added: 1, removed: 1 });
		expect(overwrite?.newFile).toBeUndefined();
		const created = await computeApprovalDiff("write", { path: "new/file.md", content: "x\ny\n" }, project);
		expect(created).toMatchObject({ added: 2, removed: 0, newFile: true });
		expect(created?.text.split("\n")).toEqual(["+1 x", "+2 y"]);
	});

	it("previews a write outside the project too", async () => {
		const outside = mkdtempSync(join(tmpdir(), "runkiln-outside-"));
		try {
			writeFileSync(join(outside, "x.txt"), "old\n");
			const diff = await computeApprovalDiff("write", { path: join(outside, "x.txt"), content: "new\n" }, project);
			expect(diff).toMatchObject({ added: 1, removed: 1 });
		} finally {
			rmSync(outside, { recursive: true, force: true });
		}
	});

	it("sanitizes terminal escapes in the diff and cuts a huge preview", async () => {
		const evil = await computeApprovalDiff(
			"write",
			{ path: "e.txt", content: "ok\x1b]0;pwned\x07\x1b[2J\n" },
			project,
		);
		expect(evil?.text).not.toContain("\x1b");
		const huge = toApprovalDiff(Array.from({ length: MAX_PREVIEW_DIFF_LINES + 50 }, (_, i) => `+${i} x`).join("\n"));
		expect(huge.text.split("\n")).toHaveLength(MAX_PREVIEW_DIFF_LINES);
		expect(huge).toMatchObject({ added: MAX_PREVIEW_DIFF_LINES + 50, omittedLines: 50 });
	});

	it("has no preview for other tools or calls without a path", async () => {
		expect(await computeApprovalDiff("bash", { command: "ls" }, project)).toBeUndefined();
		expect(await computeApprovalDiff("write", { content: "x" }, project)).toBeUndefined();
		expect(await computeApprovalDiff("edit", { path: "a.txt" }, project)).toBeUndefined();
	});
});

describe("approval request code", () => {
	it("marks a shell command as bash code, still in the message", () => {
		const request = approvalRequestForToolCall("bash", { command: "git status && npm test" }, project);
		if (!request || isApprovalRefusal(request)) throw new Error("expected a request");
		expect(request.code).toEqual({ text: "git status && npm test", language: "bash" });
		expect(request.message.startsWith("git status && npm test")).toBe(true);
	});

	it("shows an MCP call's arguments as compact JSON, as json code", () => {
		const args = { query: "approval prompts", limit: 5, filters: { lang: ["ts", "md"] } };
		const request = approvalRequestForToolCall("mcp__docs__search", args, project);
		if (!request || isApprovalRefusal(request)) throw new Error("expected a request");
		const compact = JSON.stringify(args);
		expect(request.message).toContain(compact);
		expect(request.code).toEqual({ text: compact, language: "json" });
		// Other tools keep pretty JSON.
		const other = approvalRequestForToolCall("apply_patch", { patch: "x" }, project);
		if (!other || isApprovalRefusal(other)) throw new Error("expected a request");
		expect(other.message).toContain('{\n  "patch": "x"\n}');
		expect(other.code).toBeUndefined();
	});
});

describe("approval timeout policy", () => {
	it("waits indefinitely by default and reads promptTimeoutSec and timeoutAction", () => {
		expect(approvalTimeoutPolicy(undefined)).toEqual({ timeoutMs: 0, action: "deny" });
		expect(approvalTimeoutPolicy({ promptTimeoutSec: 0 })).toEqual({ timeoutMs: 0, action: "deny" });
		expect(approvalTimeoutPolicy({ promptTimeoutSec: 45 })).toEqual({ timeoutMs: 45_000, action: "deny" });
		expect(approvalTimeoutPolicy({ promptTimeoutSec: 10, timeoutAction: "pause" })).toEqual({
			timeoutMs: 10_000,
			action: "pause",
		});
		for (const bad of [-5, Number.NaN, "30", null]) {
			expect(approvalTimeoutPolicy({ promptTimeoutSec: bad, timeoutAction: "explode" })).toEqual({
				timeoutMs: 0,
				action: "deny",
			});
		}
		expect(approvalTimeoutPolicy({ promptTimeoutSec: 10 ** 9 }).timeoutMs).toBe(86_400_000);
	});

	it("comes from settings", () => {
		const settings = SettingsManager.inMemory({ permissions: { promptTimeoutSec: 30, timeoutAction: "pause" } });
		expect(settings.getApprovalTimeoutPolicy()).toEqual({ timeoutMs: 30_000, action: "pause" });
		expect(SettingsManager.inMemory({}).getApprovalTimeoutPolicy()).toEqual({ timeoutMs: 0, action: "deny" });
	});
});

function prompt(overrides: Partial<PermissionPrompt> = {}): PermissionPrompt {
	return {
		toolName: "edit",
		mode: "read-write",
		title: "Allow edit to modify a protected file?",
		message: "edit wants to write /p/.github/workflows/ci.yml\n\nProject folder: /p",
		risks: [],
		timeoutMs: 0,
		...overrides,
	};
}

function open(p: PermissionPrompt, opts: { rows?: number; onTimeout?: () => void; timers?: boolean } = {}) {
	const answers: Array<ApprovalAnswer | undefined> = [];
	const tui = { requestRender: () => {}, ...(opts.rows ? { terminal: { rows: opts.rows } } : {}) } as never;
	const component = new PermissionPromptComponent(p, (answer) => answers.push(answer), {
		tui,
		...(opts.onTimeout ? { onTimeout: opts.onTimeout } : {}),
	});
	return {
		component,
		answers,
		text: (width = 100) => stripAnsi(component.render(width).join("\n")),
		lines: (width = 100) => component.render(width),
	};
}

const longDiff = (): ApprovalDiff =>
	toApprovalDiff(
		[
			"  1 name: CI",
			"  2 on:",
			"  3   push:",
			"  4     branches: [main]",
			"+ 5   pull_request:",
			...Array.from({ length: 20 }, (_, i) => `+${String(i + 6).padStart(2)} added ${i + 6}`),
			"-26 removed line",
		].join("\n"),
	);

describe("approval prompt with a diff", () => {
	it("shows +a −r in the title and the diff collapsed to 8 lines, starting just above the first change", () => {
		const view = open(prompt({ diff: longDiff() }));
		const shown = view.text();
		const title = shown.split("\n").find((line) => line.includes("Allow edit"));
		expect(title).toContain("+21 −1");
		expect(shown).toContain("4     branches: [main]");
		expect(shown).not.toContain("1 name: CI");
		expect(shown).toContain("+ 5   pull_request:");
		expect(shown).toContain("added 11");
		expect(shown).not.toContain("added 12");
		expect(shown).toMatch(/… 1\d more diff lines \(ctrl\+o to show all\)/);
		view.component.handleInput(CTRL_O);
		const expanded = view.text();
		expect(expanded).toContain("1 name: CI");
		expect(expanded).toContain("-26 removed line");
		expect(expanded).not.toContain("more diff lines");
	});

	it("labels a new file, and says why there is no diff", () => {
		const created = open(
			prompt({ title: "Allow write outside the project?", diff: toApprovalDiff("+1 x", { newFile: true }) }),
		);
		expect(created.text()).toContain("Allow write outside the project? +1 −0 new file");
		const failed = open(prompt({ diff: { text: "", added: 0, removed: 0, error: "Could not find the edit text." } }));
		expect(failed.text()).toContain("No diff preview: Could not find the edit text.");
		expect(failed.text()).not.toContain("+0 −0");
	});

	it("still answers with the usual keys", () => {
		const view = open(prompt({ diff: longDiff() }));
		view.component.handleInput(ENTER);
		expect(view.answers).toEqual([{ choice: "allow-once" }]);
	});

	it("fits a short terminal: the title and every choice stay on screen at 80x24", () => {
		const view = open(
			prompt({
				diff: longDiff(),
				alwaysLabel: "Always allow edits to this file this session",
				message:
					"edit wants to write /tmp/project/.github/workflows/ci.yml\nWorkflow files run code in CI with the repository's secrets.\n\nProject folder: /tmp/project",
			}),
			{ rows: 24 },
		);
		const lines = view.lines(80);
		expect(lines.length).toBeLessThanOrEqual(20);
		const shown = stripAnsi(lines.join("\n"));
		expect(shown).toContain("Allow edit to modify a protected file?");
		for (const label of ["Allow once", "Always allow edits", "Deny", "Deny and tell"]) expect(shown).toContain(label);
		expect(shown).toContain("pull_request");
		for (const line of lines) expect(stripAnsi(line).length).toBeLessThanOrEqual(80);
		// Expanded, nothing is cut.
		view.component.handleInput(CTRL_O);
		expect(stripAnsi(view.lines(80).join("\n"))).toContain("-26 removed line");
	});
});

describe("approval prompt code", () => {
	it("shows a long shell command whole, with syntax colour", () => {
		const command = `npm run build && ${Array.from({ length: 12 }, (_, i) => `echo step-${i}`).join(" && ")}`;
		const request = approvalRequestForToolCall("bash", { command }, project);
		if (!request || isApprovalRefusal(request)) throw new Error("expected a request");
		const view = open(
			prompt({ toolName: "bash", title: request.title, message: request.message, code: request.code }),
		);
		const raw = view.lines(80).join("\n");
		const shown = stripAnsi(raw);
		expect(shown.replace(/\n {2}│ /g, " ")).toContain("echo step-11");
		// The analysis below the command is cut first; expanded, all of it shows.
		expect(shown).toContain("more lines");
		view.component.handleInput(CTRL_O);
		expect(view.text(80)).toContain("Working directory:");
		// Highlighted: the command's lines carry more colours than plain text.
		expect(raw).toMatch(/\x1b\[[0-9;]*m(npm|echo)/);
	});

	it("keeps the message order when the code sits in the middle (MCP arguments)", () => {
		const args = { q: "x", n: 1 };
		const request = approvalRequestForToolCall("mcp__docs__search", args, project);
		if (!request || isApprovalRefusal(request)) throw new Error("expected a request");
		const view = open(prompt({ toolName: "mcp__docs__search", ...request }));
		const shown = view.text().split("\n");
		const intro = shown.findIndex((line) => line.includes("will run with these arguments"));
		const json = shown.findIndex((line) => line.includes('{"q":"x","n":1}'));
		expect(intro).toBeGreaterThan(0);
		expect(json).toBe(intro + 1);
	});

	it("falls back to the plain message when the code is not in it", () => {
		const view = open(prompt({ message: "plain message", code: { text: "missing", language: "bash" } }));
		expect(view.text()).toContain("plain message");
		expect(view.text()).not.toContain("missing");
	});
});

describe("approval prompt timeout", () => {
	it("waits indefinitely with no timeout", () => {
		vi.useFakeTimers();
		try {
			const view = open(prompt({ timeoutMs: 0 }));
			vi.advanceTimersByTime(10 * 60_000);
			expect(view.answers).toEqual([]);
			expect(view.text()).not.toMatch(/\d+s\b/);
		} finally {
			vi.useRealTimers();
		}
	});

	it("denies when a deny timeout runs out", () => {
		vi.useFakeTimers();
		try {
			const view = open(prompt({ timeoutMs: 3000, timeoutAction: "deny" }));
			expect(view.text()).toContain(" 3s");
			vi.advanceTimersByTime(3500);
			expect(view.answers).toEqual([undefined]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("pauses: the prompt stays open, says paused, fires onTimeout once, and still takes an answer", () => {
		vi.useFakeTimers();
		try {
			const onTimeout = vi.fn();
			const view = open(prompt({ timeoutMs: 2000, timeoutAction: "pause" }), { onTimeout });
			vi.advanceTimersByTime(2500);
			expect(view.answers).toEqual([]);
			expect(onTimeout).toHaveBeenCalledTimes(1);
			expect(view.component.isPaused).toBe(true);
			expect(view.text()).toContain("paused");
			vi.advanceTimersByTime(60_000);
			expect(onTimeout).toHaveBeenCalledTimes(1);
			view.component.handleInput("y");
			expect(view.answers).toEqual([{ choice: "allow-once" }]);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("notifications for a paused approval", () => {
	function notifier(focused: boolean, mode: "auto" | "off" = "auto") {
		const writes: string[] = [];
		const n = new TurnNotifier({
			mode: () => mode,
			write: (data) => writes.push(data),
			focused: () => focused,
			env: { TERM_PROGRAM: "ghostty" },
			now: () => 1_000_000,
		});
		return { n, writes };
	}

	it("force notifies even while the terminal has focus, but never when notifications are off", () => {
		const focused = notifier(true);
		expect(focused.n.waiting("approval", "Allow edit?")).toBe(false);
		expect(focused.n.waiting("approval", "Still waiting: Allow edit?", { force: true })).toBe(true);
		expect(focused.writes.join("")).toContain("Still waiting: Allow edit?");
		const off = notifier(false, "off");
		expect(off.n.waiting("approval", "x", { force: true })).toBe(false);
		expect(off.writes).toEqual([]);
	});
});

describe("plan approval: edit the plan in the editor", () => {
	function openPlan(edit?: (plan: string) => Promise<string | undefined>) {
		const answers: Array<PlanAnswer | undefined> = [];
		const renders = vi.fn();
		const component = new PlanApprovalComponent({
			plan: "## Plan\n1. Edit a.ts\n2. Run npm test",
			returnMode: "read-write",
			onAnswer: (answer) => answers.push(answer),
			...(edit ? { onEditPlan: edit, tui: { requestRender: renders } } : {}),
		});
		return { component, answers, renders, text: () => stripAnsi(component.render(90).join("\n")) };
	}

	it("offers the edit option and the e key only when an editor is wired", () => {
		const withEditor = openPlan(async (plan) => plan);
		expect(withEditor.text()).toContain("2  Edit the plan in your editor, then decide");
		expect(withEditor.text()).toContain("e edit");
		const without = openPlan();
		expect(without.text()).not.toContain("Edit the plan");
		without.component.handleInput("e");
		expect(without.text()).toContain("What should change in the plan?");
	});

	it("e opens the editor; the edited plan is shown and is what approve returns", async () => {
		const edit = vi.fn(async (plan: string) => `${plan}\n3. Update the changelog\n`);
		const view = openPlan(edit);
		view.component.handleInput("e");
		await vi.waitFor(() => expect(view.component.isEdited).toBe(true));
		expect(edit).toHaveBeenCalledWith("## Plan\n1. Edit a.ts\n2. Run npm test");
		expect(view.renders).toHaveBeenCalled();
		const shown = view.text();
		expect(shown).toContain("(edited by you)");
		expect(shown).toContain("3. Update the changelog");
		view.component.handleInput("y");
		expect(view.answers).toEqual([
			{ choice: "approve", plan: "## Plan\n1. Edit a.ts\n2. Run npm test\n3. Update the changelog" },
		]);
	});

	it("keeps the plan when the editor fails, returns nothing or the same text, and ignores keys while it is open", async () => {
		let release: (value: string | undefined) => void = () => {};
		const view = openPlan(
			() =>
				new Promise<string | undefined>((resolve) => {
					release = resolve;
				}),
		);
		view.component.handleInput("e");
		view.component.handleInput("y"); // the editor has the terminal
		expect(view.answers).toEqual([]);
		release(undefined);
		await vi.waitFor(() => expect(view.renders).toHaveBeenCalled());
		expect(view.component.isEdited).toBe(false);
		view.component.handleInput("y");
		expect(view.answers).toEqual([{ choice: "approve" }]);

		const same = openPlan(async (plan) => `${plan}\n`);
		same.component.handleInput("e");
		await vi.waitFor(() => expect(same.renders).toHaveBeenCalled());
		expect(same.component.isEdited).toBe(false);

		const failing = openPlan(async () => {
			throw new Error("no editor");
		});
		failing.component.handleInput("2");
		await vi.waitFor(() => expect(failing.renders).toHaveBeenCalled());
		expect(failing.component.currentPlan).toBe("## Plan\n1. Edit a.ts\n2. Run npm test");
	});

	it("keep planning after an edit carries the edited plan; discard does not", async () => {
		const refine = openPlan(async () => "## Plan\n1. Mine");
		refine.component.handleInput("e");
		await vi.waitFor(() => expect(refine.component.isEdited).toBe(true));
		refine.component.handleInput("r");
		for (const ch of "check it") refine.component.handleInput(ch);
		refine.component.handleInput(ENTER);
		expect(refine.answers).toEqual([{ choice: "refine", feedback: "check it", plan: "## Plan\n1. Mine" }]);

		const discard = openPlan(async () => "## Plan\n1. Mine");
		discard.component.handleInput("e");
		await vi.waitFor(() => expect(discard.component.isEdited).toBe(true));
		discard.component.handleInput("d");
		expect(discard.answers).toEqual([{ choice: "discard" }]);
	});

	it("sends the edited plan to the model in full", () => {
		expect(planApprovedPrompt("read-write")).not.toContain("edited");
		const prompt = planApprovedPrompt("read-write", "## Plan\n1. Mine\n2. Also mine");
		expect(prompt).toContain("Plan approved. Plan mode is off (permissions: Read & write).");
		expect(prompt).toContain("The user edited the plan before approving it");
		expect(prompt.endsWith("## Plan\n1. Mine\n2. Also mine")).toBe(true);
		expect(planApprovedPrompt("read-write", "   ")).toBe(planApprovedPrompt("read-write"));
		const feedback = planEditedFeedback("## Plan\n1. Mine", "  add tests ");
		expect(feedback).toContain("I edited your plan");
		expect(feedback).toContain("## Plan\n1. Mine");
		expect(feedback.endsWith("add tests")).toBe(true);
	});
});

describe("approval UX on the session", () => {
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
		root = mkdtempSync(join(tmpdir(), "runkiln-approve-ux-session-"));
		agentDir = join(root, "agent");
		projectDir = join(root, "project");
		for (const dir of [agentDir, projectDir]) mkdirSync(dir, { recursive: true });
		writeFileSync(join(projectDir, "notes.txt"), "old\n");
		contexts.length = 0;
		faux = registerFauxProvider();
		vi.stubEnv("TYPESAFE_API_KEY", "");
		vi.stubEnv("OPENROUTER_API_KEY", "");
	});

	afterEach(() => {
		faux.unregister();
		vi.unstubAllEnvs();
		rmSync(root, { recursive: true, force: true });
	});

	async function openSession(settings: Record<string, unknown> = {}) {
		const { session } = await createAgentSession({
			cwd: projectDir,
			agentDir,
			modelRuntime: runtime,
			model: faux.getModel(),
			sessionManager: SessionManager.create(projectDir, join(root, "sessions")),
			settingsManager: SettingsManager.inMemory(settings),
			thinkingLevel: "off",
			permissionMode: "ask",
		});
		session.setActiveToolsByName(["read", "write", "edit", "bash"]);
		return session;
	}

	const recording = (message: ReturnType<typeof fauxAssistantMessage>) => (context: unknown) => {
		contexts.push(JSON.stringify(context));
		return message;
	};

	it("gives a write and an edit approval their diff, and a bash approval its code", async () => {
		const session = await openSession();
		const prompts: PermissionPrompt[] = [];
		session.setApprovalPrompt(async (p) => {
			prompts.push(p);
			return { choice: "deny" };
		});
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("write", { path: "notes.txt", content: "new\n" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage(
				[fauxToolCall("edit", { path: "notes.txt", edits: [{ oldText: "old", newText: "older\nstill" }] })],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage([fauxToolCall("bash", { command: "echo hi && ls" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await session.prompt("change the notes");
		expect(prompts.map((p) => p.toolName)).toEqual(["write", "edit", "bash"]);
		expect(prompts[0].diff).toMatchObject({ added: 1, removed: 1, text: "-1 old\n+1 new" });
		expect(prompts[1].diff).toMatchObject({ added: 2, removed: 1 });
		expect(prompts[2].code).toEqual({ text: "echo hi && ls", language: "bash" });
		// Display only: a denied write leaves the file alone.
		expect(readFileSync(join(projectDir, "notes.txt"), "utf8")).toBe("old\n");
		// Waits indefinitely by default.
		expect(prompts.every((p) => p.timeoutMs === 0 && p.timeoutAction === "deny")).toBe(true);
		session.dispose();
	});

	it("passes the timeout policy from settings to the prompt", async () => {
		const session = await openSession({ permissions: { promptTimeoutSec: 15, timeoutAction: "pause" } });
		const prompts: PermissionPrompt[] = [];
		session.setApprovalPrompt(async (p) => {
			prompts.push(p);
			return { choice: "allow-once" };
		});
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("read", { path: "notes.txt" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await session.prompt("read");
		expect(prompts[0]).toMatchObject({ timeoutMs: 15_000, timeoutAction: "pause" });
		session.dispose();
	});

	it("approving an edited plan sends the edited plan to the model", async () => {
		const session = await openSession();
		session.setPermissionMode("plan");
		faux.setResponses([recording(fauxAssistantMessage("## Plan\n1. Rewrite notes.txt"))]);
		await session.prompt("plan it");
		faux.setResponses([recording(fauxAssistantMessage("ok"))]);
		const result = await session.approvePlan("## Plan\n1. Append a line to notes.txt\n2. Nothing else");
		expect(result).toEqual({ mode: "ask" });
		const last = contexts.at(-1) ?? "";
		expect(last).toContain("The user edited the plan before approving it");
		expect(last).toContain("1. Append a line to notes.txt");
		session.dispose();
	});
});
