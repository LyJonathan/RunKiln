import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	allowRulesCover,
	evaluateSavedRules,
	formatRule,
	globToRegExp,
	loadRuleLists,
	type ParsedRule,
	parseRule,
	restrictiveRuleMatches,
	type SavedRule,
	savedRulesForSuggestion,
} from "../../src/core/runkiln/permission-rules.ts";
import { PermissionGate, suggestAlwaysRule } from "../../src/core/runkiln/permissions.ts";

let project: string;
const builtin = { builtin: true };

beforeAll(() => {
	project = mkdtempSync(join(tmpdir(), "runkiln-rules-"));
	mkdirSync(join(project, "src", "core"), { recursive: true });
	mkdirSync(join(project, "secrets"), { recursive: true });
	writeFileSync(join(project, "src", "core", "a.ts"), "");
	writeFileSync(join(project, ".env"), "X=1");
});
afterAll(() => rmSync(project, { recursive: true, force: true }));

function parsed(text: string): ParsedRule {
	const rule = parseRule(text);
	if ("error" in rule) throw new Error(rule.error);
	return rule;
}

function saved(action: SavedRule["action"], text: string, scope: SavedRule["scope"] = "global"): SavedRule {
	return { action, scope, text, rule: parsed(text) };
}

describe("parsing rules", () => {
	it("reads shell, path and tool rules in Claude Code's syntax", () => {
		expect(parsed("Bash")).toEqual({ kind: "shell", tools: ["bash"], match: "any", words: [] });
		expect(parsed("Bash(npm run test:*)")).toEqual({
			kind: "shell",
			tools: ["bash"],
			match: "prefix",
			words: ["npm", "run", "test"],
		});
		expect(parsed("bash(git status *)")).toMatchObject({ match: "prefix", words: ["git", "status"] });
		expect(parsed("Bash(npm test)")).toMatchObject({ match: "exact", words: ["npm", "test"] });
		expect(parsed("Shell(ls)")).toMatchObject({ tools: ["bash", "powershell"] });
		expect(parsed("Read(src/**)")).toEqual({
			kind: "path",
			tools: ["read", "grep", "find", "ls"],
			pattern: "src/**",
		});
		expect(parsed("Write(docs/*.md)")).toMatchObject({ tools: ["write", "edit"] });
		expect(parsed("mcp__github__*")).toEqual({ kind: "tool", pattern: "mcp__github__*" });
	});

	it("rejects broken rules with a reason", () => {
		expect(parseRule("")).toHaveProperty("error");
		expect(parseRule("Bash(npm test")).toHaveProperty("error", "missing closing parenthesis");
		expect(parseRule("Bash(np* test)")).toHaveProperty("error");
		expect(parseRule("mcp__x(arg)")).toHaveProperty("error");
		expect(parseRule("rm -rf")).toHaveProperty("error");
	});

	it("formats rules back to their canonical text", () => {
		for (const text of [
			"Bash",
			"Bash(npm test:*)",
			"Bash(git status)",
			"Read",
			"Edit(src/**)",
			"mcp__x__y",
			"Shell(ls)",
		]) {
			expect(formatRule(parsed(text))).toBe(text);
		}
	});

	it("ignores a project file's allow rules: a project can only tighten", () => {
		const loaded = loadRuleLists(
			{ allow: ["Bash"], deny: ["Read(.env)"], ask: ["Bash(git push:*)", 7] },
			"project-file",
		);
		expect(loaded.rules.map((rule) => `${rule.action} ${rule.text}`)).toEqual([
			"deny Read(.env)",
			"ask Bash(git push:*)",
		]);
		expect(loaded.ignored).toEqual([
			{ action: "ask", scope: "project-file", text: "7", reason: "a rule must be a string" },
			{
				action: "allow",
				scope: "project-file",
				text: "Bash",
				reason: "a project's settings can only tighten permissions",
			},
		]);
		expect(loadRuleLists({ allow: ["Bash"] }, "global").rules).toHaveLength(1);
	});
});

describe("matching rules", () => {
	it("globs: * stays in one folder, ** crosses folders, bare names match at any depth", () => {
		expect(globToRegExp("src/*.ts", false).test("src/a.ts")).toBe(true);
		expect(globToRegExp("src/*.ts", false).test("src/core/a.ts")).toBe(false);
		expect(globToRegExp("src/**/*.ts", false).test("src/core/a.ts")).toBe(true);
		expect(globToRegExp("src/**/*.ts", false).test("src/a.ts")).toBe(true);
		const env = parsed("Read(.env)");
		expect(restrictiveRuleMatches(env, "read", { path: ".env" }, project)).toBe(true);
		expect(restrictiveRuleMatches(env, "read", { path: "src/.env" }, project)).toBe(true);
		expect(restrictiveRuleMatches(env, "read", { path: "src/core/a.ts" }, project)).toBe(false);
	});

	it("a folder pattern covers what is inside it; absolute and ~ patterns match absolute paths", () => {
		expect(restrictiveRuleMatches(parsed("Read(secrets)"), "read", { path: "secrets/key.txt" }, project)).toBe(true);
		expect(restrictiveRuleMatches(parsed("Edit(src/**)"), "write", { path: "src/core/a.ts" }, project)).toBe(true);
		expect(
			restrictiveRuleMatches(parsed(`Edit(${project}/src/**)`), "edit", { path: "src/core/a.ts" }, project),
		).toBe(true);
		expect(
			restrictiveRuleMatches(
				parsed("Read(~/.ssh/**)"),
				"read",
				{ path: join(homedir(), ".ssh", "id_rsa") },
				project,
			),
		).toBe(true);
	});

	it("deny and ask rules match any part of a shell command, nested commands, env prefixes and full paths", () => {
		const rm = parsed("Bash(rm -rf:*)");
		expect(restrictiveRuleMatches(rm, "bash", { command: "rm -rf build" }, project)).toBe(true);
		expect(restrictiveRuleMatches(rm, "bash", { command: "npm test && rm -rf build" }, project)).toBe(true);
		expect(restrictiveRuleMatches(rm, "bash", { command: "echo $(rm -rf build)" }, project)).toBe(true);
		expect(restrictiveRuleMatches(rm, "bash", { command: "FOO=1 /bin/rm -rf build" }, project)).toBe(true);
		expect(restrictiveRuleMatches(rm, "bash", { command: "rm -r build" }, project)).toBe(false);
		expect(restrictiveRuleMatches(rm, "powershell", { command: "rm -rf build" }, project)).toBe(false);
		const exact = parsed("Bash(git push)");
		expect(restrictiveRuleMatches(exact, "bash", { command: "git  push" }, project)).toBe(true);
		expect(restrictiveRuleMatches(exact, "bash", { command: "git push origin" }, project)).toBe(false);
	});

	it("allow rules must cover every part of a chain, never with substitution, and only genuine built-ins", () => {
		const rules = [parsed("Bash(npm test:*)"), parsed("Bash(git status)")];
		expect(allowRulesCover(rules, "bash", { command: "npm test -- --watch=false" }, project, builtin)).toBe(true);
		expect(allowRulesCover(rules, "bash", { command: "npm test && git status" }, project, builtin)).toBe(true);
		expect(allowRulesCover(rules, "bash", { command: "npm test && curl x" }, project, builtin)).toBe(false);
		expect(allowRulesCover(rules, "bash", { command: "npm test $(curl x)" }, project, builtin)).toBe(false);
		expect(allowRulesCover([parsed("Edit(src/**)")], "edit", { path: "src/core/a.ts" }, project, builtin)).toBe(true);
		expect(allowRulesCover([parsed("Edit(src/**)")], "edit", { path: "src/core/a.ts" }, project, {})).toBe(false);
		// A bare tool rule named like a built-in never covers the genuine built-in.
		expect(allowRulesCover([parsed("mcp__docs__search")], "mcp__docs__search", {}, project, {})).toBe(true);
		expect(allowRulesCover([parsed("mcp__*")], "bash", { command: "ls" }, project, builtin)).toBe(false);
	});

	it("deny beats ask beats allow", () => {
		const rules = [
			saved("allow", "Bash"),
			saved("ask", "Bash(git push:*)"),
			saved("deny", "Bash(git push --force:*)"),
		];
		expect(evaluateSavedRules(rules, "bash", { command: "ls" }, project, builtin)?.action).toBe("allow");
		expect(evaluateSavedRules(rules, "bash", { command: "git push" }, project, builtin)?.action).toBe("ask");
		expect(evaluateSavedRules(rules, "bash", { command: "git push --force origin" }, project, builtin)?.action).toBe(
			"deny",
		);
	});
});

describe("saved rules in the gate", () => {
	const gate = (mode: "ask" | "read-write" | "plan" | "auto" | "allow-all", rules: SavedRule[]) =>
		new PermissionGate({ mode, savedRules: () => rules });

	it("deny rules block in every mode, allow-all and plan included", async () => {
		const rules = [saved("deny", "Bash(curl:*)"), saved("deny", "Read(.env)", "project-file")];
		for (const mode of ["ask", "read-write", "plan", "auto", "allow-all"] as const) {
			const curl = await gate(mode, rules).decide("bash", { command: "curl https://x.dev" }, project, builtin);
			expect(curl.action, mode).toBe("deny");
			if (curl.action === "deny") expect(curl.reason).toContain("deny rule `Bash(curl:*)`");
			expect((await gate(mode, rules).decide("read", { path: ".env" }, project, builtin)).action, mode).toBe("deny");
		}
	});

	it("allow rules skip the prompt in ask and read-write, but never for a risky call", async () => {
		const rules = [saved("allow", "Bash(npm test:*)", "project"), saved("allow", "Bash(git push:*)")];
		expect(await gate("read-write", rules).decide("bash", { command: "npm test" }, project, builtin)).toEqual({
			action: "allow",
			via: "saved-rule",
		});
		expect((await gate("ask", rules).decide("bash", { command: "npm test" }, project, builtin)).action).toBe("allow");
		expect((await gate("read-write", rules).decide("bash", { command: "git push" }, project, builtin)).action).toBe(
			"ask",
		);
	});

	it("ask rules ask where the mode would run, offer no always option, and say why", async () => {
		const rules = [saved("ask", "Edit(migrations/**)")];
		const decision = await gate("read-write", rules).decide(
			"write",
			{ path: "migrations/1.sql", content: "" },
			project,
			builtin,
		);
		expect(decision.action).toBe("ask");
		if (decision.action === "ask") {
			expect(decision.askRule).toBe("Edit(migrations/**)");
			expect(decision.suggestion).toBeUndefined();
		}
		expect(
			(await gate("allow-all", rules).decide("write", { path: "migrations/1.sql" }, project, builtin)).action,
		).toBe("allow");
	});

	it("removes a single session rule", () => {
		const g = gate("ask", []);
		g.addRules([{ kind: "reads" }, { kind: "command", prefix: "npm test" }, { kind: "tool", name: "x" }]);
		expect(g.removeRule(1)).toBe(true);
		expect(g.rules).toEqual([{ kind: "reads" }, { kind: "tool", name: "x" }]);
		expect(g.removeRule(5)).toBe(false);
	});
});

describe("always allow in this project", () => {
	it("turns the session suggestion into saved rules", () => {
		const shell = suggestAlwaysRule("read-write", "bash", { command: "npm test && git status" }, project, builtin);
		expect(shell?.projectRules).toEqual(["Bash(npm test:*)", "Bash(git status:*)"]);
		expect(shell?.projectLabel).toBe("Always allow `npm test`, `git status` commands in this project (saved)");
		const read = suggestAlwaysRule("ask", "read", { path: "src/core/a.ts" }, project, builtin);
		expect(read?.projectRules).toEqual(["Read"]);
		const edits = suggestAlwaysRule("ask", "write", { path: "src/core/a.ts" }, project, builtin);
		expect(edits?.projectRules).toEqual(["Edit(**)"]);
		expect(savedRulesForSuggestion([{ kind: "file", path: join(project, "notes.md") }], "write", project)).toEqual([
			"Edit(./notes.md)",
		]);
		expect(
			savedRulesForSuggestion([{ kind: "file", path: join(project, "a*.md") }], "write", project),
		).toBeUndefined();
		expect(suggestAlwaysRule("ask", "mcp__docs__search", {}, project)?.projectRules).toEqual(["mcp__docs__search"]);
	});

	it("a saved project rule reproduces the session rule's decision", async () => {
		const suggestion = suggestAlwaysRule("read-write", "bash", { command: "npm test" }, project, builtin);
		const rules = (suggestion?.projectRules ?? []).map((text) => saved("allow", text, "project"));
		const g = new PermissionGate({ mode: "read-write", savedRules: () => rules });
		expect((await g.decide("bash", { command: "npm test -- -t x" }, project, builtin)).action).toBe("allow");
		expect((await g.decide("bash", { command: "npm install" }, project, builtin)).action).toBe("ask");
	});
});
