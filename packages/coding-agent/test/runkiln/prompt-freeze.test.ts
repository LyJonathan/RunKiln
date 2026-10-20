import { describe, expect, it } from "vitest";
import { nextFallbackModel } from "../../src/core/runkiln/model-roles.ts";
import { promptDrift, promptUpdateNote, toolsSignature } from "../../src/core/runkiln/prompt-freeze.ts";
import { parseSessionTitle } from "../../src/core/runkiln/session-title.ts";
import { buildSystemPrompt, buildSystemPromptSections } from "../../src/core/system-prompt.ts";

const base = {
	cwd: "E:/work/demo",
	selectedTools: ["read", "bash", "edit", "write"],
	toolSnippets: {
		read: "Read file contents",
		bash: "Execute bash commands",
		edit: "Edit files",
		write: "Write files",
	},
	toolGuidelines: {
		bash: ["You can inspect RUNKILN_* environment variables for current model and session details."],
	},
};

describe("frozen prompt", () => {
	it("is byte-identical across turns and carries no date or upstream docs", () => {
		const first = buildSystemPrompt(base);
		const second = buildSystemPrompt({ ...base, cwd: "E:/work/other" });
		expect(second).toBe(first);
		expect(first).toContain("coding assistant in RunKiln");
		expect(first).not.toMatch(/\b20\d{2}-\d{2}-\d{2}\b/);
		expect(first.toLowerCase()).not.toContain("pi documentation");
		expect(first).not.toContain("custom tools");
		expect(first).not.toContain("PI_*");
	});

	it("tells the model to reply in the user's language, as one fixed rule", () => {
		const prompt = buildSystemPrompt(base);
		expect(prompt).toContain("- Reply in the language the user writes in");
		expect(prompt.split("Reply in the language the user writes in")).toHaveLength(2);
		// Same text whatever the tools are, so the cached prefix does not change with it.
		expect(buildSystemPrompt({ ...base, selectedTools: ["read"] })).toContain(
			"- Reply in the language the user writes in",
		);
	});

	it("reports a drift when the prompt or the tools change", () => {
		const frozen = { systemText: buildSystemPrompt(base), toolsKey: toolsSignature([]) };
		expect(promptDrift(frozen, frozen.systemText, frozen.toolsKey)).toBeUndefined();
		// The working directory is not part of the prompt, so moving to another project is not a drift.
		expect(
			promptDrift(frozen, buildSystemPrompt({ ...base, cwd: "E:/work/other" }), frozen.toolsKey),
		).toBeUndefined();
		expect(
			promptDrift(
				frozen,
				buildSystemPrompt({ ...base, appendSystemPrompt: "Answer in metric units." }),
				frozen.toolsKey,
			),
		).toMatch(/system prompt/);
		const changedTools = toolsSignature([{ name: "read", description: "Read", parameters: { type: "object" } }]);
		expect(promptDrift(frozen, frozen.systemText, changedTools)).toMatch(/tools/);
	});
});

describe("prompt update note", () => {
	const context = (content: string) => [{ path: "/repo/AGENTS.md", content }];

	it("sends only the sections that changed, never the tool-bound ones", () => {
		const before = buildSystemPromptSections({ ...base, contextFiles: context("Use tabs.") });
		expect(promptUpdateNote(before, before)).toBeUndefined();
		const after = buildSystemPromptSections({
			...base,
			selectedTools: ["read"],
			contextFiles: context("Use spaces."),
		});
		const note = promptUpdateNote(before, after);
		expect(note).toContain("[Session update, not from the user]");
		expect(note).toContain("Use spaces.");
		expect(note).not.toContain("Use tabs.");
		// The tool list and rules follow the frozen tools: not repeated in the note.
		expect(note).not.toContain("<tools>");
		expect(note).not.toContain("<rules>");
	});

	it("says when a section was removed", () => {
		const before = buildSystemPromptSections({ ...base, contextFiles: context("Use tabs.") });
		const after = buildSystemPromptSections(base);
		expect(promptUpdateNote(before, after)).toContain("<project_context> no longer applies.");
	});
});

describe("fallback order", () => {
	const fallback = ["glm-5-3-flash", "deepseek-v4-1-flash", "qwen3-8-27b"];
	const lookup = (id: string) => (id === "missing" ? undefined : { id });

	it("skips the current model and anything already tried", () => {
		expect(nextFallbackModel("glm-5-3-flash", fallback, new Set(), lookup)?.id).toBe("deepseek-v4-1-flash");
		expect(nextFallbackModel("glm-5-3-flash", fallback, new Set(["deepseek-v4-1-flash"]), lookup)?.id).toBe(
			"qwen3-8-27b",
		);
		expect(
			nextFallbackModel("qwen3-8-27b", fallback, new Set(["glm-5-3-flash", "deepseek-v4-1-flash"]), lookup),
		).toBe(undefined);
	});
});

describe("session titles", () => {
	it("keeps the first line and drops wrapping quotes", () => {
		expect(parseSessionTitle(' "Fix the login bug" \nmore')).toBe("Fix the login bug");
		expect(parseSessionTitle("   ")).toBeUndefined();
	});
});
