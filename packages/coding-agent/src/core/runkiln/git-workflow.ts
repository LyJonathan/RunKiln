/**
 * Git helpers, as in Aider and Claude Code: /commit (a conventional commit message from the chore model, shown for
 * edit or confirmation), the git.autoCommit setting ("turn": commit each file-changing turn), and --worktree
 * sessions. RunKiln only touches the user's git state when the user asks (a command, a flag, or the opt-in setting).
 * The /undo checkpoints (checkpoints.ts) live in their own shadow repository and are unaffected.
 *
 * Commits are always path-limited (`git commit -- <paths>`), so changes the user staged in other files stay staged
 * and out of the commit.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

export type CommitScope = "turn" | "session" | "all";
export const COMMIT_SCOPES: readonly CommitScope[] = ["turn", "session", "all"];
const MAX_COMMIT_DIFF_CHARS = 12_000;
const MAX_SUBJECT = 72;

interface GitResult {
	ok: boolean;
	stdout: string;
	stderr: string;
}

export function runGit(cwd: string, args: string[], input?: string): GitResult {
	const result = spawnSync("git", args, {
		cwd,
		encoding: "utf8",
		input,
		maxBuffer: 32 * 1024 * 1024,
		timeout: 60_000,
	});
	return {
		ok: result.status === 0,
		stdout: result.stdout ?? "",
		stderr: (result.stderr ?? result.error?.message ?? "").trim(),
	};
}

/** The repository's top-level folder, or undefined outside a git work tree. */
export function gitTopLevel(cwd: string): string | undefined {
	const result = runGit(cwd, ["rev-parse", "--show-toplevel"]);
	return result.ok ? result.stdout.trim() : undefined;
}

/** Changed paths (tracked changes, deletions, untracked files), absolute, from `git status`. */
export function changedPaths(cwd: string): string[] | undefined {
	const top = gitTopLevel(cwd);
	if (!top) return undefined;
	const status = runGit(top, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
	if (!status.ok) return undefined;
	const paths: string[] = [];
	const fields = status.stdout.split("\0");
	for (let i = 0; i < fields.length; i++) {
		const field = fields[i];
		if (field.length < 4) continue;
		const code = field.slice(0, 2);
		paths.push(resolve(top, field.slice(3)));
		// Renames and copies carry the old path in the next field: it is part of the change too.
		if (code.includes("R") || code.includes("C")) {
			const from = fields[++i];
			if (from) paths.push(resolve(top, from));
		}
	}
	return [...new Set(paths)];
}

/**
 * The paths a commit would include: the changed files, limited to `scope` (absolute or cwd-relative paths) when
 * given. Returned relative to the repository top level, sorted.
 */
export function commitCandidates(cwd: string, scope: readonly string[] | undefined): string[] {
	const top = gitTopLevel(cwd);
	const changed = changedPaths(cwd);
	if (!top || !changed) return [];
	const wanted = scope ? new Set(scope.map((path) => (isAbsolute(path) ? path : resolve(cwd, path)))) : undefined;
	return changed
		.filter((path) => !wanted || wanted.has(path))
		.map((path) => relative(top, path))
		.filter((path) => path && !path.startsWith(".."))
		.sort();
}

/** The diff of `paths` (relative to the top level) against HEAD, new files included, capped for the prompt. */
export function diffForCommit(top: string, paths: readonly string[]): { stat: string; diff: string } {
	if (paths.length === 0) return { stat: "", diff: "" };
	const hasHead = runGit(top, ["rev-parse", "--verify", "--quiet", "HEAD"]).ok;
	const tracked = new Set(
		runGit(top, ["ls-files", "-z", "--", ...paths])
			.stdout.split("\0")
			.filter(Boolean),
	);
	const base = hasHead ? ["HEAD"] : ["--cached"];
	let diff = runGit(top, ["diff", "--no-color", "--no-ext-diff", ...base, "--", ...paths]).stdout;
	let stat = runGit(top, ["diff", "--stat", "--no-color", ...base, "--", ...paths]).stdout.trim();
	const untracked = paths.filter((path) => !tracked.has(path) && existsSync(join(top, path)));
	for (const path of untracked) {
		diff += runGit(top, ["diff", "--no-index", "--no-color", "--", "/dev/null", path]).stdout;
		stat += `${stat ? "\n" : ""} ${path} (new)`;
	}
	if (diff.length > MAX_COMMIT_DIFF_CHARS) diff = `${diff.slice(0, MAX_COMMIT_DIFF_CHARS)}\n… (diff cut)`;
	return { stat, diff };
}

/** The prompt for the chore model. */
export function commitMessagePrompt(input: { stat: string; diff: string; request?: string }): string {
	return [
		"Write a git commit message for the change below, in the Conventional Commits format:",
		"`<type>(<optional scope>): <summary>` on the first line (type: feat, fix, refactor, docs, test, chore, perf, build, ci or style; imperative mood, lowercase, no period, at most 72 characters).",
		"Then, only if the change needs it, a blank line and a short body (wrapped at 72) saying what changed and why.",
		"Reply with the commit message only: no quotes, no code fences, no explanations.",
		input.request ? `\nWhat the user asked for: ${input.request.replace(/\s+/g, " ").trim().slice(0, 400)}` : "",
		"\nFiles:",
		input.stat || "(none)",
		"\nDiff:",
		input.diff || "(empty)",
	]
		.filter(Boolean)
		.join("\n");
}

/** A commit message from the model's reply: fences and quotes stripped, subject capped, trailing space trimmed. */
export function parseCommitMessage(text: string): string | undefined {
	let body = text.trim();
	const fenced = /^```[a-z]*\n([\s\S]*?)\n```$/i.exec(body);
	if (fenced) body = fenced[1].trim();
	body = body.replace(/^["'`]+|["'`]+$/g, "").trim();
	const lines = body.split(/\r?\n/).map((line) => line.trimEnd());
	while (lines.length > 0 && !lines[0].trim()) lines.shift();
	if (lines.length === 0) return undefined;
	let subject = lines[0].trim().replace(/\.$/, "");
	if (subject.length > MAX_SUBJECT) subject = `${subject.slice(0, MAX_SUBJECT - 1).trimEnd()}…`;
	const rest = lines.slice(1).join("\n").trim();
	return rest ? `${subject}\n\n${rest}` : subject;
}

/** A fallback message when the chore model is unavailable. */
export function fallbackCommitMessage(paths: readonly string[]): string {
	if (paths.length === 1) return `chore: update ${paths[0]}`;
	return `chore: update ${paths.length} files`;
}

/**
 * The Co-authored-by trailer for the git.coAuthor setting ("Name <email>", or a full "Co-authored-by: ..." line),
 * or undefined when the setting is empty (the default: no trailer).
 */
export function coAuthorTrailer(coAuthor: string | undefined): string | undefined {
	const value = coAuthor
		?.trim()
		.replace(/^co-authored-by:\s*/i, "")
		.trim();
	return value ? `Co-authored-by: ${value}` : undefined;
}

/** Append the co-author trailer once, when git.coAuthor is set; otherwise the message unchanged (trimmed). */
export function withCoAuthor(message: string, coAuthor: string | undefined): string {
	const trimmed = message.trimEnd();
	const trailer = coAuthorTrailer(coAuthor);
	if (!trailer || trimmed.includes(trailer)) return trimmed;
	return `${trimmed}\n\n${trailer}`;
}

/** Stage and commit exactly `paths` (relative to the top level). Other staged files stay staged and out. */
export function commitPaths(
	top: string,
	paths: readonly string[],
	message: string,
): { sha: string; subject: string } | { error: string } {
	if (paths.length === 0) return { error: "Nothing to commit." };
	if (!message.trim()) return { error: "Empty commit message: nothing was committed." };
	const add = runGit(top, ["add", "-A", "--", ...paths]);
	if (!add.ok) return { error: `git add failed: ${add.stderr}` };
	const commit = runGit(top, ["commit", "-q", "-F", "-", "--", ...paths], `${message.trim()}\n`);
	if (!commit.ok) return { error: `git commit failed: ${commit.stderr || commit.stdout.trim()}` };
	const sha = runGit(top, ["rev-parse", "--short", "HEAD"]).stdout.trim();
	return { sha, subject: message.trim().split("\n")[0] };
}

// ---------------------------------------------------------------------------------------------------------------
// Worktrees (--worktree [name])
// ---------------------------------------------------------------------------------------------------------------

export interface WorktreeSession {
	/** The main repository's top level. */
	repo: string;
	/** The worktree folder the session runs in. */
	path: string;
	branch: string;
	/** The branch (or commit) the worktree started from, to merge back into. */
	baseRef: string;
	baseSha: string;
}

/** A branch-safe worktree name: the given one cleaned, or a timestamped default. */
export function worktreeName(input: string | undefined, now = new Date()): string {
	const cleaned = (input ?? "")
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^[-.]+|[-.]+$/g, "")
		.slice(0, 48);
	if (cleaned) return cleaned;
	const stamp = now.toISOString().slice(0, 16).replace(/[-:T]/g, "");
	return `session-${stamp}`;
}

/**
 * Create a worktree and branch `runkiln/<name>` from HEAD under <repo>/.runkiln/worktrees/<name>. The folder is
 * excluded locally (.git/info/exclude) so the main checkout does not list it as untracked.
 */
export function createWorktree(cwd: string, rawName: string | undefined): WorktreeSession | { error: string } {
	const repo = gitTopLevel(cwd);
	if (!repo) return { error: "--worktree needs a git repository." };
	const head = runGit(repo, ["rev-parse", "--verify", "--quiet", "HEAD"]);
	if (!head.ok) return { error: "--worktree needs at least one commit." };
	const name = worktreeName(rawName);
	const branch = `runkiln/${name}`;
	const path = join(repo, ".runkiln", "worktrees", name);
	if (existsSync(path)) return { error: `Worktree folder already exists: ${path}` };
	if (runGit(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).ok) {
		return { error: `Branch ${branch} already exists. Pick another name: --worktree <name>.` };
	}
	const current = runGit(repo, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
	const baseSha = head.stdout.trim();
	const baseRef = current.ok ? current.stdout.trim() : baseSha;
	mkdirSync(join(repo, ".runkiln", "worktrees"), { recursive: true });
	excludeLocally(repo, "/.runkiln/worktrees/");
	const add = runGit(repo, ["worktree", "add", "-q", "-b", branch, path, "HEAD"]);
	if (!add.ok) return { error: `git worktree add failed: ${add.stderr}` };
	return { repo, path, branch, baseRef, baseSha };
}

function excludeLocally(repo: string, pattern: string): void {
	const gitDir = runGit(repo, ["rev-parse", "--git-common-dir"]).stdout.trim();
	if (!gitDir) return;
	const file = join(resolve(repo, gitDir), "info", "exclude");
	try {
		const current = existsSync(file) ? readFileSync(file, "utf8") : "";
		if (current.split(/\r?\n/).includes(pattern)) return;
		mkdirSync(join(resolve(repo, gitDir), "info"), { recursive: true });
		writeFileSync(file, `${current}${current && !current.endsWith("\n") ? "\n" : ""}${pattern}\n`);
	} catch {
		// Only cosmetic: the main checkout would list the folder as untracked.
	}
}

/** What the worktree holds at exit: uncommitted files and commits on its branch since the base. */
export function worktreeState(session: WorktreeSession): { dirty: string[]; commits: number } {
	const dirty = changedPaths(session.path)?.map((path) => relative(session.path, path)) ?? [];
	const count = runGit(session.path, ["rev-list", "--count", `${session.baseSha}..HEAD`]);
	return { dirty, commits: count.ok ? Number.parseInt(count.stdout.trim(), 10) || 0 : 0 };
}

/**
 * Merge the worktree branch into the base branch in the main checkout (fast-forward when possible, else a merge
 * commit). Refuses when the base is a detached commit or the main checkout is on another branch.
 */
export function mergeWorktree(session: WorktreeSession): { ok: true; message: string } | { error: string } {
	if (session.baseRef === session.baseSha)
		return { error: "The worktree started from a detached HEAD: merge it by hand." };
	const current = runGit(session.repo, ["symbolic-ref", "--quiet", "--short", "HEAD"]).stdout.trim();
	if (current !== session.baseRef) {
		return {
			error: `The main checkout is on ${current || "a detached HEAD"}, not ${session.baseRef}: merge by hand.`,
		};
	}
	const merge = runGit(session.repo, ["merge", "--no-edit", session.branch]);
	if (!merge.ok) {
		runGit(session.repo, ["merge", "--abort"]);
		return { error: `git merge failed (aborted): ${merge.stderr || merge.stdout.trim()}` };
	}
	return { ok: true, message: `Merged ${session.branch} into ${session.baseRef}.` };
}

/** Remove the worktree folder and its branch (force: discards uncommitted changes). */
export function removeWorktree(session: WorktreeSession, deleteBranch: boolean): { ok: true } | { error: string } {
	const remove = runGit(session.repo, ["worktree", "remove", "--force", session.path]);
	if (!remove.ok) return { error: `git worktree remove failed: ${remove.stderr}` };
	if (deleteBranch) runGit(session.repo, ["branch", "-D", session.branch]);
	return { ok: true };
}
