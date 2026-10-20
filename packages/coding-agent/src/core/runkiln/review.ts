/**
 * /review and `runkiln review`, as Codex's /review: a read-only review of uncommitted changes, one commit, or the
 * current branch against another, with findings grouped by priority (P0 to P3) and file:line references.
 *
 * RunKiln collects the diff itself (git), so the model never needs a shell: the review run uses the plan-mode
 * read-only gate (only read, grep, find and ls run) and is routed like any other turn. The visible user message is
 * one line; the instructions and the diff travel in a hidden message after it.
 */

import { spawnSync } from "node:child_process";

export const REVIEW_MESSAGE_TYPE = "runkiln-review";
/** Hidden follow-up when a review run ended with an empty message. */
export const REVIEW_WRITE_NOW =
	"<system-reminder>\nYour last message was empty. Write the review now from the diff and the files you read: findings by priority P0–P3 with file:line, or say there are none. No more tool calls.\n</system-reminder>";
/** Diff text sent to the model; past it the model reads the files it needs. */
export const REVIEW_MAX_DIFF_CHARS = 60_000;
const MAX_UNTRACKED_FILE_CHARS = 8_000;

export type ReviewTarget =
	| { kind: "uncommitted" }
	| { kind: "commit"; ref: string; sha: string }
	| { kind: "branch"; ref: string; base: string };

export interface ReviewMaterial {
	target: ReviewTarget;
	/** "the uncommitted changes", "commit abc1234 (subject)", "this branch against main". */
	label: string;
	files: string[];
	stat: string;
	diff: string;
	truncated: boolean;
	insertions: number;
	deletions: number;
}

export const PRIORITIES = ["P0", "P1", "P2", "P3"] as const;
export type Priority = (typeof PRIORITIES)[number];

interface GitResult {
	ok: boolean;
	stdout: string;
	stderr: string;
}

function git(cwd: string, args: string[]): GitResult {
	const result = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: 20_000 });
	return { ok: result.status === 0, stdout: result.stdout ?? "", stderr: (result.stderr ?? "").trim() };
}

/** A safe ref argument: no option injection, no whitespace. */
function validRef(ref: string): boolean {
	return /^[A-Za-z0-9._/@^~{}:+-]+$/.test(ref) && !ref.startsWith("-");
}

/** What `/review <arg>` means: nothing or "uncommitted", a branch (local or remote), or a commit. */
export function resolveReviewTarget(cwd: string, arg: string | undefined): ReviewTarget | { error: string } {
	if (!git(cwd, ["rev-parse", "--is-inside-work-tree"]).ok) {
		return { error: "Not a git repository: /review needs git to find the changes." };
	}
	const value = (arg ?? "").trim();
	if (!value || value === "uncommitted" || value === "working" || value === "changes") return { kind: "uncommitted" };
	if (!validRef(value)) return { error: `Not a commit or branch name: ${value}` };
	const isBranch =
		git(cwd, ["rev-parse", "--verify", "--quiet", `refs/heads/${value}`]).ok ||
		git(cwd, ["rev-parse", "--verify", "--quiet", `refs/remotes/${value}`]).ok;
	if (isBranch) {
		const base = git(cwd, ["merge-base", "HEAD", value]);
		if (!base.ok) return { error: `No common ancestor between HEAD and ${value}.` };
		return { kind: "branch", ref: value, base: base.stdout.trim() };
	}
	const commit = git(cwd, ["rev-parse", "--verify", "--quiet", `${value}^{commit}`]);
	if (commit.ok) return { kind: "commit", ref: value, sha: commit.stdout.trim() };
	return { error: `Not a commit or branch: ${value}. Use /review, /review <commit> or /review <branch>.` };
}

function countChanges(numstat: string): { files: string[]; insertions: number; deletions: number } {
	const files: string[] = [];
	let insertions = 0;
	let deletions = 0;
	for (const line of numstat.split("\n")) {
		const [add, del, ...rest] = line.split("\t");
		if (!rest.length) continue;
		files.push(rest.join("\t"));
		insertions += Number.parseInt(add, 10) || 0;
		deletions += Number.parseInt(del, 10) || 0;
	}
	return { files, insertions, deletions };
}

/** The diff to review, or an error (nothing to review, git failed). */
export function collectReviewMaterial(cwd: string, target: ReviewTarget): ReviewMaterial | { error: string } {
	let range: string[];
	let label: string;
	if (target.kind === "uncommitted") {
		const hasHead = git(cwd, ["rev-parse", "--verify", "--quiet", "HEAD"]).ok;
		range = hasHead ? ["HEAD"] : ["--cached"];
		label = "the uncommitted changes";
	} else if (target.kind === "commit") {
		const subject = git(cwd, ["log", "-1", "--format=%s", target.sha]).stdout.trim();
		range = [`${target.sha}^!`];
		if (!git(cwd, ["rev-parse", "--verify", "--quiet", `${target.sha}^`]).ok) {
			// A root commit has no parent: diff against the empty tree.
			range = ["4b825dc642cb6eb9a060e54bf8d69288fbee4904", target.sha];
		}
		label = `commit ${target.sha.slice(0, 7)}${subject ? ` (${subject})` : ""}`;
	} else {
		range = [target.base, "HEAD"];
		label = `this branch against ${target.ref}`;
	}
	const numstat = git(cwd, ["diff", "--numstat", "--no-color", ...range]);
	if (!numstat.ok) return { error: `git diff failed: ${numstat.stderr || "unknown error"}` };
	const counted = countChanges(numstat.stdout);
	const stat = git(cwd, ["diff", "--stat", "--no-color", ...range]).stdout.trim();
	let diff = git(cwd, ["diff", "--no-color", "--no-ext-diff", "-U3", ...range]).stdout;

	if (target.kind === "uncommitted") {
		const untracked = git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"])
			.stdout.split("\0")
			.filter(Boolean)
			.slice(0, 50);
		for (const file of untracked) {
			const shown = git(cwd, ["diff", "--no-index", "--no-color", "--", "/dev/null", file]).stdout;
			diff +=
				shown.length > MAX_UNTRACKED_FILE_CHARS
					? `${shown.slice(0, MAX_UNTRACKED_FILE_CHARS)}\n… (new file cut)\n`
					: shown;
			counted.files.push(file);
			counted.insertions += shown
				.split("\n")
				.filter((line) => line.startsWith("+") && !line.startsWith("+++")).length;
		}
	}
	if (counted.files.length === 0 || !diff.trim()) {
		return {
			error: target.kind === "uncommitted" ? "No uncommitted changes to review." : `Nothing to review in ${label}.`,
		};
	}
	const truncated = diff.length > REVIEW_MAX_DIFF_CHARS;
	return {
		target,
		label,
		files: counted.files,
		stat,
		diff: truncated ? diff.slice(0, REVIEW_MAX_DIFF_CHARS) : diff,
		truncated,
		insertions: counted.insertions,
		deletions: counted.deletions,
	};
}

/** The one-line user message the transcript shows (and the router classifies). */
export function reviewRequestText(material: ReviewMaterial): string {
	const count = material.files.length;
	return `Review ${material.label} (${count} file${count === 1 ? "" : "s"}, +${material.insertions} −${material.deletions}): find bugs and risks, findings by priority P0–P3 with file:line.`;
}

/** The hidden instructions and diff that follow the user message. */
export function reviewInstructions(material: ReviewMaterial): string {
	return [
		"<system-reminder>",
		`Code review of ${material.label}. This is read-only: RunKiln blocks every write, edit, shell command and tool other than read, grep, find and ls. Do not change anything.`,
		"Look for real problems: bugs, wrong logic, edge cases, security issues, data loss, races, broken error handling, missing tests for risky code, API or behaviour changes callers will trip on. Skip style nits a formatter would fix. Read the surrounding code with the read tools when the diff alone is not enough to be sure.",
		"",
		"Answer in this format (omit empty priorities, keep each finding to 1-3 lines):",
		"## P0 (must fix: breaks the build, data loss, security)",
		"- `path/to/file.ts:42` What is wrong and why it matters. Suggested fix.",
		"## P1 (should fix before merging: a real bug or regression)",
		"## P2 (worth fixing: edge case, fragile code, missing test)",
		"## P3 (minor: clarity, naming, small cleanup)",
		"End with one line: `Verdict: ` followed by ready to merge, ready after fixes, or needs rework. If you found nothing, say so and give the verdict.",
		"Line numbers refer to the new version of the file (the + side of the hunk).",
		"</system-reminder>",
		"",
		"Changed files:",
		"```",
		material.stat || material.files.join("\n"),
		"```",
		"",
		"```diff",
		material.diff.trimEnd(),
		"```",
		material.truncated
			? `(Diff cut at ${REVIEW_MAX_DIFF_CHARS.toLocaleString("en-US")} characters: read the remaining files listed above with the read tool.)`
			: "",
	]
		.filter((line, index, all) => line !== "" || all[index - 1] !== "")
		.join("\n");
}

/** Findings per priority in a review answer (counts the bullets under each `## Pn` heading). */
export function countReviewFindings(text: string): Record<Priority, number> {
	const counts: Record<Priority, number> = { P0: 0, P1: 0, P2: 0, P3: 0 };
	let current: Priority | undefined;
	for (const line of text.split("\n")) {
		const heading = /^\s{0,3}#{1,6}\s*\**\s*(P[0-3])\b/i.exec(line);
		if (heading) {
			current = heading[1].toUpperCase() as Priority;
			continue;
		}
		if (/^\s{0,3}#{1,6}\s/.test(line)) {
			current = undefined;
			continue;
		}
		if (current && /^\s{0,3}(?:[-*+]|\d+[.)])\s+\S/.test(line)) counts[current]++;
	}
	return counts;
}

/** `--fail-on P1`: whether the review has a finding at that priority or a more severe one. */
export function reviewFails(text: string, failOn: Priority | undefined): boolean {
	if (!failOn) return false;
	const counts = countReviewFindings(text);
	return PRIORITIES.slice(0, PRIORITIES.indexOf(failOn) + 1).some((priority) => counts[priority] > 0);
}

export function parsePriority(value: string | undefined): Priority | undefined {
	const upper = value?.trim().toUpperCase();
	return PRIORITIES.find((priority) => priority === upper);
}

/** The block reason for a non-read call during a review. */
export function reviewBlockReason(toolName: string): string {
	return `Not run: /review is read-only, so RunKiln blocks this ${toolName} call (only read, grep, find and ls run). Finish the review from the diff and the files you can read.`;
}
