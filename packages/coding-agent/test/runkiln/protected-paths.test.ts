import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { approvalRequestForToolCall, protectedProjectReason } from "../../src/core/runkiln/approval.ts";
import { autoPrepass } from "../../src/core/runkiln/auto-prepass.ts";
import { PermissionGate } from "../../src/core/runkiln/permissions.ts";

let project: string;
const builtin = { builtin: true };

beforeAll(() => {
	project = mkdtempSync(join(tmpdir(), "runkiln-protected-"));
	mkdirSync(join(project, "src"), { recursive: true });
});
afterAll(() => rmSync(project, { recursive: true, force: true }));

const PROTECTED = [
	// RunKiln's own project config (self-escalation, survey P0-2).
	".runkiln/settings.json",
	".runkiln/settings.local.json",
	".runkiln/SYSTEM.md",
	".runkiln/APPEND_SYSTEM.md",
	".runkiln/skills/x/SKILL.md",
	".runkiln/prompts/review.md",
	".runkiln/mcp.json",
	".RUNKILN/settings.json",
	"packages/app/.runkiln/settings.json",
	".runkiln/worktrees/feature/.runkiln/settings.json",
	".mcp.json",
	"sub/.mcp.json",
	".agents/skills/x/SKILL.md",
	// Other agents' folders and instruction files.
	".gemini/settings.json",
	".codex/config.toml",
	".opencode/agent.md",
	"opencode.json",
	"GEMINI.md",
	"AGENTS.override.md",
	".cursorrules",
	".windsurfrules",
	".github/copilot-instructions.md",
	// Files that test, lint and build runners execute.
	"vitest.config.ts",
	"vite.config.mjs",
	"jest.config.js",
	"eslint.config.cjs",
	"packages/x/webpack.config.ts",
	".eslintrc.js",
	"conftest.py",
	"tests/unit/conftest.py",
	"pyproject.toml",
	"setup.py",
	"Makefile",
	"makefile",
	"GNUmakefile",
	"justfile",
	"Taskfile.yml",
	"build.rs",
	"crates/x/build.rs",
	".cargo/config.toml",
	".pre-commit-config.yaml",
	"lefthook.yml",
	".gitattributes",
	".gitmodules",
	".yarnrc.yml",
	".pnpmfile.cjs",
	".devcontainer/devcontainer.json",
	".devcontainer/Dockerfile",
	".idea/workspace.xml",
	".vscode/launch.json",
	".bashrc",
	".zshrc",
];

const ORDINARY = [
	"src/index.ts",
	"src/config.ts",
	"src/math.test.ts",
	"tsconfig.json",
	"README.md",
	"docs/makefile.md",
	".runkiln-checkpoints/x",
	".runkiln/worktrees/feature/src/index.ts",
	".runkiln/worktrees/feature/README.md",
	"agents/notes.md",
];

describe("protected project paths", () => {
	it("covers RunKiln's config, other agents' folders and runner-executed files", () => {
		for (const path of PROTECTED) expect(protectedProjectReason(path), path).toBeDefined();
	});

	it("leaves ordinary source files and worktree contents alone", () => {
		for (const path of ORDINARY) expect(protectedProjectReason(path), path).toBeUndefined();
	});

	it("Windows separators are matched too", () => {
		expect(protectedProjectReason([".runkiln", "settings.json"].join(sep))).toBeDefined();
	});

	it("a write to .runkiln/settings.json asks in read & write mode (it ran silently before)", async () => {
		const request = approvalRequestForToolCall(
			"write",
			{ path: ".runkiln/settings.json", content: "{}" },
			project,
			builtin,
		);
		expect(request).toBeDefined();
		const gate = new PermissionGate({ mode: "read-write" });
		for (const path of [".runkiln/settings.json", ".mcp.json", "vitest.config.ts", "conftest.py"]) {
			expect((await gate.decide("write", { path, content: "" }, project, builtin)).action, path).toBe("ask");
		}
		expect((await gate.decide("write", { path: "src/a.ts", content: "" }, project, builtin)).action).toBe("allow");
	});

	it("the auto pre-pass does not allow them and session edit rules do not cover them", async () => {
		for (const path of PROTECTED) {
			expect(autoPrepass("write", { path, content: "" }, project, builtin), path).toBeUndefined();
		}
		const gate = new PermissionGate({ mode: "ask" });
		gate.addRules([{ kind: "project-edits" }]);
		expect((await gate.decide("edit", { path: ".runkiln/SYSTEM.md", edits: [] }, project, builtin)).action).toBe(
			"ask",
		);
		expect((await gate.decide("edit", { path: "src/a.ts", edits: [] }, project, builtin)).action).toBe("allow");
	});
});
