/**
 * Plan mode, as in Claude Code: the agent researches read-only and ends its turn with a plan, which the user approves
 * (the session switches back to the permission mode it was in and the agent implements the plan), keeps refining, or
 * discards.
 *
 * The gate (permissions.ts) enforces the read-only part: in mode "plan" only the genuine read, grep, find and ls run,
 * and every other call is blocked with planModeBlockReason. This module holds what the model is told and how a plan
 * is recognized. The instructions travel as a hidden context message on the run, not in the system prompt or as a
 * tool, so switching modes never changes the frozen prompt prefix (prompt-freeze.ts) and the cache stays warm.
 */

import { type PermissionMode, permissionModeInfo } from "./permissions.ts";

/** customType of the hidden messages that tell the model plan mode started, is on, or ended. */
export const PLAN_MODE_MESSAGE_TYPE = "runkiln-plan-mode";

/** Sent with the first run after plan mode is switched on. */
export const PLAN_MODE_INSTRUCTIONS = [
	"<system-reminder>",
	"Plan mode is on (RunKiln permission mode `plan`). It is read-only: RunKiln blocks every file write, every edit,",
	"every shell command and every tool other than read, grep, find and ls, so do not try them and do not change",
	"anything. Research the task with the read-only tools and think it through.",
	"",
	"If you need a decision from the user first, ask it and end your turn.",
	"When you are ready, end your turn with the plan: a section that starts with the heading line `## Plan`,",
	"followed by concrete numbered steps (which files change and how, what to run to verify, risks).",
	"The user then approves it (RunKiln switches back to their previous permission mode and you implement it),",
	"asks you to refine it, or discards it. Do not start implementing until the plan is approved.",
	"</system-reminder>",
].join("\n");

/** Sent with later runs while plan mode stays on. */
export const PLAN_MODE_REMINDER =
	"<system-reminder>Plan mode is still on: read-only (read, grep, find, ls). Update the plan and end your turn with it under a `## Plan` heading; do not implement anything yet.</system-reminder>";

/** Sent with the first run after plan mode ends without an approval (cycle key, /permissions). */
export function planModeEndedNotice(mode: PermissionMode): string {
	const info = permissionModeInfo(mode);
	return `<system-reminder>Plan mode is off. The permission mode is now ${info.label}: ${info.description} Do not act on an earlier plan unless the user asks you to.</system-reminder>`;
}

/**
 * The user message that starts the implementation after an approval. `editedPlan` is the plan as the user edited it
 * before approving: it is sent in full and replaces the model's version.
 */
export function planApprovedPrompt(mode: PermissionMode, editedPlan?: string): string {
	const approved = `Plan approved. Plan mode is off (permissions: ${permissionModeInfo(mode).label}).`;
	const plan = editedPlan?.trim();
	if (!plan) return `${approved} Implement the plan now, step by step, and verify it as the plan says.`;
	return [
		`${approved} The user edited the plan before approving it. Implement this edited plan, not your earlier version, step by step, and verify it as it says:`,
		"",
		plan,
	].join("\n");
}

/** The keep-planning message when the user edited the plan in their editor first. */
export function planEditedFeedback(editedPlan: string, feedback: string | undefined): string {
	const note = feedback?.trim();
	return [
		"I edited your plan. Keep planning from this version (plan mode stays on):",
		"",
		editedPlan.trim(),
		...(note ? ["", note] : []),
	].join("\n");
}

/** Hidden note for the model after the user discards a plan. */
export const PLAN_DISCARDED_NOTICE =
	"<system-reminder>The user discarded the plan above. Plan mode is off. Do not implement that plan; wait for the user's next request.</system-reminder>";

/** A heading that opens the plan: `## Plan`, `# Proposed plan`, `### Implementation plan: …`. */
const PLAN_HEADING =
	/^ {0,3}#{1,6}[ \t]+(?:\*\*)?(?:the[ \t]+)?(?:proposed[ \t]+|implementation[ \t]+|final[ \t]+|updated[ \t]+|revised[ \t]+)?plan\b[^\n]*$/gim;

/**
 * The plan in an assistant message's text: from the last plan heading to the end, or undefined when the message has
 * none (a question or a plain answer, which needs no approval).
 */
export function extractPlan(text: string): string | undefined {
	if (!text) return undefined;
	let last: RegExpExecArray | undefined;
	PLAN_HEADING.lastIndex = 0;
	for (let match = PLAN_HEADING.exec(text); match; match = PLAN_HEADING.exec(text)) last = match;
	if (!last) return undefined;
	const plan = text.slice(last.index).trim();
	// A heading alone is not a plan.
	return plan.split("\n").length > 1 ? plan : undefined;
}

/** The text of the last assistant message, when the session's last message is a finished assistant reply. */
export function lastAssistantText(
	messages: ReadonlyArray<{ role: string; content?: unknown; stopReason?: unknown }>,
): string | undefined {
	const last = messages[messages.length - 1];
	if (!last || last.role !== "assistant") return undefined;
	if (last.stopReason !== undefined && last.stopReason !== "stop") return undefined;
	if (!Array.isArray(last.content)) return typeof last.content === "string" ? last.content : undefined;
	return last.content
		.map((part: { type?: string; text?: string }) =>
			part?.type === "text" && typeof part.text === "string" ? part.text : "",
		)
		.join("");
}

/** What the user can do with a plan. */
export type PlanChoice = "approve" | "refine" | "discard";

export interface PlanAnswer {
	choice: PlanChoice;
	/** The plan as the user edited it in their editor, when they did (approve runs this version). */
	plan?: string;
	/** For refine: what to change (empty means the user will type it in the editor). */
	feedback?: string;
}
