import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setKeybindings } from "@runkiln/tui";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../../src/core/keybindings.ts";
import type { ApprovalAnswer, PermissionPrompt } from "../../src/core/runkiln/permissions.ts";
import { BUILTIN_SLASH_COMMANDS, HIDDEN_SLASH_ALIASES } from "../../src/core/slash-commands.ts";
import { PermissionPromptComponent } from "../../src/modes/interactive/components/permission-prompt.ts";
import { PermissionsSelectorComponent } from "../../src/modes/interactive/components/permissions-selector.ts";
import {
	buildDiffMarkdown,
	buildHelpMarkdown,
	buildInitPrompt,
	buildStatusMarkdown,
	formatDoctorMarkdown,
	runDoctorChecks,
} from "../../src/modes/interactive/runkiln-commands.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../src/utils/ansi.ts";

let keysDir: string;
beforeAll(() => {
	initTheme("dark");
	keysDir = mkdtempSync(join(tmpdir(), "runkiln-keys-"));
	setKeybindings(KeybindingsManager.create(keysDir));
});
afterAll(() => rmSync(keysDir, { recursive: true, force: true }));

const DOWN = "\u001b[B";
const ENTER = "\r";
const ESC = "\u001b";

function prompt(overrides: Partial<PermissionPrompt> = {}): PermissionPrompt {
	return {
		toolName: "bash",
		mode: "read-write",
		title: "Run bash command?",
		message: "npm test\n\nWorking directory: /p",
		risks: [],
		alwaysLabel: "Always allow `npm test` commands this session",
		timeoutMs: 0,
		...overrides,
	};
}

function open(p: PermissionPrompt) {
	const answers: Array<ApprovalAnswer | undefined> = [];
	const component = new PermissionPromptComponent(p, (answer) => answers.push(answer));
	return { component, answers, text: () => stripAnsi(component.render(90).join("\n")) };
}

describe("approval prompt", () => {
	it("shows the call, the four choices and the mode", () => {
		const { text } = open(prompt());
		const shown = text();
		expect(shown).toContain("Run bash command?");
		expect(shown).toContain("Read & write mode");
		expect(shown).toContain("npm test");
		for (const label of [
			"1  Allow once",
			"2  Always allow `npm test` commands this session",
			"3  Deny",
			"4  Deny and tell",
		]) {
			expect(shown).toContain(label);
		}
	});

	it("answers with enter, digits and letter shortcuts", () => {
		const once = open(prompt());
		once.component.handleInput(ENTER);
		expect(once.answers).toEqual([{ choice: "allow-once" }]);
		const always = open(prompt());
		always.component.handleInput("2");
		expect(always.answers).toEqual([{ choice: "allow-always" }]);
		const viaArrow = open(prompt());
		viaArrow.component.handleInput(DOWN);
		viaArrow.component.handleInput(DOWN);
		viaArrow.component.handleInput(ENTER);
		expect(viaArrow.answers).toEqual([{ choice: "deny" }]);
		const esc = open(prompt());
		esc.component.handleInput(ESC);
		expect(esc.answers).toEqual([{ choice: "deny" }]);
		const yes = open(prompt());
		yes.component.handleInput("y");
		expect(yes.answers).toEqual([{ choice: "allow-once" }]);
	});

	it("collects feedback for the model, and esc in the feedback box goes back", () => {
		const { component, answers, text } = open(prompt());
		component.handleInput("f");
		expect(text()).toContain("Tell the model what to do instead");
		component.handleInput(ESC);
		expect(answers).toEqual([]);
		expect(text()).toContain("Allow once");
		component.handleInput("f");
		for (const ch of "use pnpm") component.handleInput(ch);
		component.handleInput(ENTER);
		expect(answers).toEqual([{ choice: "deny-feedback", feedback: "use pnpm" }]);
	});

	it("drops the always option when the call cannot get a rule, and shows risks and the auto reason", () => {
		const { component, answers, text } = open(
			prompt({
				alwaysLabel: undefined,
				risks: ["pushes to a git remote"],
				judgeReason: "changes git history or remotes",
				mode: "auto",
			}),
		);
		const shown = text();
		expect(shown).not.toContain("Always allow");
		expect(shown).toContain("! pushes to a git remote");
		expect(shown).toContain("auto: changes git history or remotes");
		component.handleInput("a");
		expect(answers).toEqual([]);
		component.handleInput("2");
		expect(answers).toEqual([{ choice: "deny" }]);
	});

	it("cuts a long call and expands it on the tool-output key", () => {
		const long = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
		const { component, text } = open(prompt({ message: long }));
		expect(text()).toContain("more lines");
		expect(text()).not.toContain("line 39");
		component.handleInput("\u000f"); // ctrl+o
		expect(text()).toContain("line 39");
	});

	it("denies when the timeout runs out", () => {
		vi.useFakeTimers();
		try {
			const answers: Array<ApprovalAnswer | undefined> = [];
			const tui = { requestRender: () => {} } as never;
			new PermissionPromptComponent(prompt({ timeoutMs: 2000 }), (answer) => answers.push(answer), { tui });
			vi.advanceTimersByTime(2500);
			expect(answers).toEqual([undefined]);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("/permissions picker", () => {
	function picker(autoAvailable: boolean, rules: string[] = []) {
		const onSelect = vi.fn();
		const onClearRules = vi.fn();
		const component = new PermissionsSelectorComponent({
			current: "read-write",
			saved: "read-write",
			autoAvailable,
			autoHint: "Needs a Jev or OpenRouter key: add one in /setup keys.",
			rules,
			onSelect,
			onClearRules,
			onCancel: vi.fn(),
		});
		return { component, onSelect, onClearRules, text: () => stripAnsi(component.render(100).join("\n")) };
	}

	it("lists the five modes and marks the current one", () => {
		const { text } = picker(true);
		const shown = text();
		for (const label of ["Ask everything", "Read & write", "Plan", "Auto", "Allow all"])
			expect(shown).toContain(label);
		expect(shown).toMatch(/✓ Read & write/);
	});

	it("skips auto when it is unavailable and explains why on a direct pick", () => {
		const { component, onSelect, text } = picker(false);
		expect(text()).toContain("unavailable");
		expect(text()).toContain("Needs a Jev or OpenRouter key");
		component.handleInput(DOWN); // read-write -> plan
		component.handleInput(DOWN); // plan -> skips auto -> allow-all
		component.handleInput(ENTER);
		expect(onSelect).toHaveBeenCalledWith("allow-all");
		const direct = picker(false);
		direct.component.handleInput("4");
		expect(direct.onSelect).not.toHaveBeenCalled();
	});

	it("selects auto when available and clears session rules with c", () => {
		const { component, onSelect, onClearRules, text } = picker(true, ["commands starting with `npm test`"]);
		expect(text()).toContain("Always allowed this session");
		component.handleInput("c");
		expect(onClearRules).toHaveBeenCalledTimes(1);
		expect(text()).toContain("Cleared 1 session rule");
		component.handleInput(DOWN);
		component.handleInput(DOWN);
		component.handleInput(ENTER);
		expect(onSelect).toHaveBeenCalledWith("auto");
	});
});

describe("RunKiln commands", () => {
	it("registers the new commands once each", () => {
		const names = BUILTIN_SLASH_COMMANDS.map((command) => command.name);
		for (const name of ["help", "permissions", "status", "usage", "diff", "init", "doctor", "new", "quit", "setup"]) {
			expect(names).toContain(name);
		}
		expect(new Set(names).size).toBe(names.length);
		for (const [alias, target] of [
			["cost", "/usage"],
			["clear", "/new"],
			["exit", "/quit"],
		]) {
			expect(names).not.toContain(alias);
			expect(HIDDEN_SLASH_ALIASES[alias]).toBe(target);
		}
	});

	it("/help lists every built-in command and the input syntax", () => {
		const help = buildHelpMarkdown({ keys: { permissions: "alt+m", thinking: "shift+tab", model: "ctrl+p" } });
		for (const command of BUILTIN_SLASH_COMMANDS) expect(help).toContain(`/${command.name}`);
		expect(help).toContain("`@path`");
		expect(help).toContain("`!command`");
		expect(help).toContain("| `alt+m` | Cycle the permission mode |");
	});

	it("/status shows the permission mode and session rules", () => {
		const status = buildStatusMarkdown({
			version: "0.1.0",
			cwd: "/p",
			gitBranch: "main",
			sessionId: "s",
			model: "runinfra/glm",
			routing: "manual",
			thinking: "low",
			permissionMode: "auto",
			sessionRules: ["commands starting with `npm test`"],
			autoBackend: "Jev jev-latest",
			runInfraKey: true,
			contextPercent: 12.5,
			contextWindow: 200000,
			messages: 4,
			cost: 0.0123,
		});
		expect(status).toContain("| Permissions | Auto:");
		expect(status).toContain("commands starting with `npm test`");
		expect(status).toContain("Jev jev-latest");
		expect(status).toContain("12.5% of 200,000 tokens");
	});

	it("/doctor flags an old Node and a missing key", () => {
		const checks = runDoctorChecks({
			cwd: "/p",
			agentDir: "/nonexistent-agent-dir",
			nodeVersion: "v20.1.0",
			runInfraKey: false,
			permissionMode: "allow-all",
			settingsErrors: [],
			env: { COLORTERM: "truecolor" },
			commandExists: () => true,
		});
		const byName = Object.fromEntries(checks.map((check) => [check.name, check]));
		expect(byName["Node.js"].ok).toBe(false);
		expect(byName["RunInfra key"].ok).toBe(false);
		expect(byName.Permissions.ok).toBe("warn");
		expect(byName["Terminal colors"].ok).toBe(true);
		expect(formatDoctorMarkdown(checks)).toContain("2 problems");
	});

	it("/diff shows staged, unstaged and untracked changes, or says there are none", () => {
		const repo = mkdtempSync(join(tmpdir(), "runkiln-diff-"));
		try {
			const git = (...args: string[]) =>
				execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: repo, stdio: "pipe" });
			git("init", "-q");
			writeFileSync(join(repo, "a.txt"), "one\n");
			git("add", "a.txt");
			git("commit", "-qm", "init");
			expect(buildDiffMarkdown(repo)).toBe("No changes since the last commit.");
			writeFileSync(join(repo, "a.txt"), "two\n");
			writeFileSync(join(repo, "new.txt"), "x\n");
			const diff = buildDiffMarkdown(repo);
			expect(diff).toContain("```diff");
			expect(diff).toContain("+two");
			expect(diff).toContain("`new.txt`");
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
		const plain = mkdtempSync(join(tmpdir(), "runkiln-nodiff-"));
		try {
			expect(buildDiffMarkdown(plain)).toContain("Not a git repository");
		} finally {
			rmSync(plain, { recursive: true, force: true });
		}
	});

	it("/init asks to create or improve AGENTS.md", () => {
		const dir = mkdtempSync(join(tmpdir(), "runkiln-init-"));
		try {
			expect(buildInitPrompt(dir)).toMatch(/^Create an AGENTS\.md file/);
			writeFileSync(join(dir, "CLAUDE.md"), "x");
			expect(buildInitPrompt(dir)).toContain("starting from what CLAUDE.md already says");
			writeFileSync(join(dir, "AGENTS.md"), "x");
			expect(buildInitPrompt(dir)).toMatch(/^Improve the existing AGENTS\.md/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
