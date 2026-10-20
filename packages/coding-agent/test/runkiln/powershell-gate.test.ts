import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { approvalRequestForToolCall, powershellUnsafeReason } from "../../src/core/runkiln/approval.ts";
import { autoPrepass } from "../../src/core/runkiln/auto-prepass.ts";
import { allowRulesCover, parseRule, type SavedRule } from "../../src/core/runkiln/permission-rules.ts";
import { PermissionGate, riskReasons, rulesAllow } from "../../src/core/runkiln/permissions.ts";

let project: string;
const builtin = { builtin: true };

beforeAll(() => {
	project = mkdtempSync(join(tmpdir(), "runkiln-ps-"));
	writeFileSync(join(project, "README.md"), "# x\n");
	writeFileSync(join(project, "package.json"), JSON.stringify({ scripts: { test: "vitest" } }));
});
afterAll(() => rmSync(project, { recursive: true, force: true }));

const ps = (command: string) => ({ command });
const saved = (action: SavedRule["action"], text: string): SavedRule => ({
	action,
	scope: "global",
	text,
	rule: parseRule(text) as SavedRule["rule"],
});

/** The payloads from the security survey (P0-3) and variants of them. */
const PAYLOADS = [
	"npm test (Invoke-Expression 'calc')",
	"git log (iex 'calc')",
	"cat README.md (iex calc)",
	"git log $(iex calc)",
	"git log @(iex calc)",
	"git log {calc}",
	"git log `(calc`)",
	"npm test & calc",
	"npm test; calc",
	"npm test | iex",
	"git log --% & calc",
	"git log \u2018a\u2019(iex calc)",
	'git log "$(calc)"',
	"pwsh -EncodedCommand YwBhAGwAYwA=",
	"powershell -enc YwBhAGwAYwA=",
	"powershell \u2013ec YwBhAGwAYwA=",
];

describe("PowerShell command analysis", () => {
	it("flags expressions, operators, --% and encoded commands", () => {
		for (const command of PAYLOADS) expect(powershellUnsafeReason(command), command).toBeDefined();
	});

	it("leaves plain words and single-quoted literals alone", () => {
		for (const command of [
			"git status",
			"npm test",
			"git commit -m 'fix (x) and {y} for $z'",
			"git log -n 5 --oneline",
			"Get-ChildItem src",
		]) {
			expect(powershellUnsafeReason(command), command).toBeUndefined();
		}
	});

	it("an escaped quote does not end a single-quoted string", () => {
		expect(powershellUnsafeReason("echo 'it''s (fine)'")).toBeUndefined();
		expect(powershellUnsafeReason("echo 'it''s' (iex calc)")).toBeDefined();
	});

	it("double quotes still expand $ and backtick", () => {
		expect(powershellUnsafeReason('echo "(literal)"')).toBeUndefined();
		expect(powershellUnsafeReason('echo "$env:PATH"')).toBeDefined();
	});
});

describe("PowerShell commands in the gate", () => {
	it("a prefix rule never covers a PowerShell expression", () => {
		const rules = [
			{ kind: "command" as const, prefix: "npm test" },
			{ kind: "command" as const, prefix: "git log" },
			{ kind: "command" as const, prefix: "cat" },
		];
		for (const command of PAYLOADS)
			expect(rulesAllow(rules, "powershell", ps(command), project), command).toBe(false);
		expect(rulesAllow(rules, "powershell", ps("npm test"), project)).toBe(true);
	});

	it("saved allow rules, even PowerShell(*), never cover one", () => {
		for (const text of ["PowerShell(*)", "PowerShell(npm test:*)", "PowerShell(git log:*)", "Shell(*)"]) {
			for (const command of PAYLOADS) {
				expect(allowRulesCover([parseRule(text) as SavedRule["rule"]], "powershell", ps(command), project)).toBe(
					false,
				);
			}
		}
		expect(
			allowRulesCover([parseRule("PowerShell(*)") as SavedRule["rule"]], "powershell", ps("npm test"), project),
		).toBe(true);
	});

	it("the auto pre-pass never allows one", () => {
		for (const command of PAYLOADS)
			expect(autoPrepass("powershell", ps(command), project, builtin), command).toBeUndefined();
		expect(autoPrepass("powershell", ps("git status"), project, builtin)?.decision).toBe("allow");
	});

	it("every payload is a risk, so auto mode asks even when the model allows it", async () => {
		const judge = vi.fn(async () => ({ decision: "allow" as const, reason: "fine", confidence: 1 }));
		const gate = new PermissionGate({
			mode: "auto",
			judgeFactory: () => ({ label: "test", judge }),
			savedRules: () => [saved("allow", "PowerShell(*)")],
		});
		for (const command of PAYLOADS) {
			expect(riskReasons("powershell", ps(command), project).length, command).toBeGreaterThan(0);
			expect((await gate.decide("powershell", ps(command), project, builtin)).action, command).toBe("ask");
		}
	});

	it("a session rule from an earlier yes does not run a PowerShell expression in read & write mode", async () => {
		const gate = new PermissionGate({ mode: "read-write" });
		gate.addRules([{ kind: "command", prefix: "npm test" }]);
		expect((await gate.decide("powershell", ps("npm test"), project, builtin)).action).toBe("allow");
		expect(
			(await gate.decide("powershell", ps("npm test (Invoke-Expression 'calc')"), project, builtin)).action,
		).toBe("ask");
	});

	it("the prompt says the command uses PowerShell expressions", () => {
		const request = approvalRequestForToolCall("powershell", ps("git log (iex 'calc')"), project, builtin);
		expect(request && "message" in request ? request.message : "").toContain("uses PowerShell expressions");
	});

	it("the bash tool is not affected by PowerShell syntax checks", () => {
		expect(rulesAllow([{ kind: "command", prefix: "npm test" }], "bash", ps("npm test"), project)).toBe(true);
		expect(riskReasons("bash", ps("echo $HOME"), project)).toEqual([]);
	});
});

describe("PowerShell risk rules", () => {
	const risky = (command: string) => riskReasons("powershell", ps(command), project);

	it("Invoke-Expression, Start-Process, Invoke-Command, Add-Type and execution policy", () => {
		for (const command of [
			"iex calc",
			"Invoke-Expression calc",
			"Start-Process calc",
			"saps calc",
			"start calc",
			"Invoke-Command -ComputerName x -FilePath y",
			"icm x",
			"Add-Type -Path x.cs",
			"Set-ExecutionPolicy Bypass",
		]) {
			expect(risky(command).length, command).toBeGreaterThan(0);
		}
	});

	it("Remove-Item with abbreviated or dash-variant flags and its aliases", () => {
		for (const command of [
			"Remove-Item -Recurse build",
			"Remove-Item -r build",
			"Remove-Item -Rec build",
			"remove-item build -Force",
			"Remove-Item build -fo",
			"ri -r build",
			"rm -r build",
			"del -Recurse build",
			"erase -fo build",
			"rd /s build",
			"rmdir -Recurse build",
			"Remove-Item \u2013Recurse build",
			"Remove-Item -Recurse:$true build",
		]) {
			expect(risky(command).length, command).toBeGreaterThan(0);
		}
		expect(risky("Remove-Item build.log")).toEqual([]);
	});

	it("a nested PowerShell with -Command, -File or an encoded command is risky from bash too", () => {
		for (const command of [
			"pwsh -c 'calc'",
			"powershell.exe -Command calc",
			"pwsh -File x.ps1",
			"powershell -enc YwBhAGwAYwA=",
		]) {
			expect(riskReasons("bash", ps(command), project).length, command).toBeGreaterThan(0);
		}
	});
});
