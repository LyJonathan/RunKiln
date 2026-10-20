import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ResourceDiscovery } from "../../src/core/resource-discovery.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";

let base: string;
let project: string;
let outside: string;
let agentDir: string;

beforeAll(() => {
	base = mkdtempSync(join(tmpdir(), "runkiln-resources-"));
	project = join(base, "project");
	outside = join(base, "outside");
	agentDir = join(base, "agent");
	mkdirSync(join(project, ".runkiln", "skills", "local"), { recursive: true });
	mkdirSync(join(project, "child"), { recursive: true });
	mkdirSync(join(base, ".agents", "skills", "parent-skill"), { recursive: true });
	mkdirSync(join(outside, "leaked"), { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(project, ".runkiln", "skills", "local", "SKILL.md"), "# local\n");
	writeFileSync(join(base, ".agents", "skills", "parent-skill", "SKILL.md"), "# parent\n");
	writeFileSync(join(outside, "leaked", "SKILL.md"), "# leaked\n");
	writeFileSync(join(outside, "note.md"), "# note\n");
	symlinkSync(join(outside, "leaked"), join(project, ".runkiln", "skills", "escape"), "junction");
});

afterAll(() => {
	rmSync(base, { recursive: true, force: true });
});

function discover(cwd: string, trusted: boolean, projectSkills?: string[]): string[] {
	const settings = SettingsManager.inMemory({}, { projectTrusted: trusted });
	if (projectSkills) settings.setProjectSkillPaths(projectSkills);
	return new ResourceDiscovery({ cwd, agentDir, settingsManager: settings })
		.resolve()
		.skills.filter((skill) => skill.enabled)
		.map((skill) => skill.path);
}

describe("resource discovery", () => {
	it("loads a trusted project's skills and skips a link that leaves the project", () => {
		const paths = discover(project, true);
		expect(paths.some((path) => path.endsWith(join("local", "SKILL.md")))).toBe(true);
		expect(paths.some((path) => path.includes("leaked"))).toBe(false);
	});

	it("does not load project skills when the project is not trusted", () => {
		expect(discover(project, false).some((path) => path.startsWith(project))).toBe(false);
	});

	it("does not walk ancestor skill directories when there is no git root", () => {
		const paths = discover(join(project, "child"), true);
		expect(paths.some((path) => path.includes("parent-skill"))).toBe(false);
	});

	it("rejects a project settings path that resolves outside the project", () => {
		const paths = discover(project, true, [join(outside, "note.md")]);
		expect(paths.some((path) => path.endsWith("note.md"))).toBe(false);
	});

	it("loads ancestor skills inside a git repo", () => {
		mkdirSync(join(base, ".git"), { recursive: true });
		try {
			const paths = discover(join(project, "child"), true);
			expect(paths.some((path) => path.includes("parent-skill"))).toBe(true);
		} finally {
			rmSync(join(base, ".git"), { recursive: true, force: true });
		}
	});
});
