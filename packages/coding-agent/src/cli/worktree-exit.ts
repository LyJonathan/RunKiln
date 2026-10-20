/**
 * `--worktree [name]`: the session runs in a new git worktree and branch (git-workflow.ts createWorktree). On exit
 * from the interactive session, offer to merge the branch back, keep the worktree, or remove it. A worktree with
 * no commits and no changes is removed without asking.
 */

import { createInterface } from "node:readline/promises";
import chalk from "chalk";
import { mergeWorktree, removeWorktree, type WorktreeSession, worktreeState } from "../core/runkiln/git-workflow.ts";

export interface WorktreeExitIo {
	ask(question: string): Promise<string>;
	print(line: string): void;
}

function defaultIo(): WorktreeExitIo {
	return {
		ask: async (question) => {
			if (!process.stdin.isTTY) return "";
			const rl = createInterface({ input: process.stdin, output: process.stdout });
			try {
				return await rl.question(question);
			} finally {
				rl.close();
			}
		},
		print: (line) => process.stdout.write(`${line}\n`),
	};
}

export async function offerWorktreeExit(session: WorktreeSession, io: WorktreeExitIo = defaultIo()): Promise<void> {
	const { dirty, commits } = worktreeState(session);
	const where = `${chalk.bold(session.branch)} in ${session.path}`;
	if (dirty.length === 0 && commits === 0) {
		const removed = removeWorktree(session, true);
		io.print(
			"error" in removed
				? chalk.yellow(`Worktree ${where} kept: ${removed.error}`)
				: chalk.dim(`Worktree ${session.branch} had no changes and was removed.`),
		);
		return;
	}
	const parts = [
		commits > 0 ? `${commits} commit${commits === 1 ? "" : "s"}` : "",
		dirty.length > 0 ? `${dirty.length} uncommitted file${dirty.length === 1 ? "" : "s"}` : "",
	].filter(Boolean);
	io.print(`Worktree ${where}: ${parts.join(", ")}.`);
	const canMerge = commits > 0 && session.baseRef !== session.baseSha;
	const choices = [canMerge ? `[m]erge into ${session.baseRef}` : "", "[k]eep", "[r]emove"].filter(Boolean).join(", ");
	const answer = (await io.ask(`${choices}? (default: keep) `)).trim().toLowerCase();
	if (answer.startsWith("m") && canMerge) {
		if (dirty.length > 0) io.print(chalk.yellow("Uncommitted files are not merged; the worktree is kept for them."));
		const merged = mergeWorktree(session);
		if ("error" in merged) {
			io.print(chalk.red(merged.error));
			io.print(`Worktree kept: ${session.path}`);
			return;
		}
		io.print(chalk.green(merged.message));
		if (dirty.length === 0) {
			const removed = removeWorktree(session, true);
			if ("error" in removed) io.print(chalk.yellow(removed.error));
			else io.print(chalk.dim("Worktree and branch removed."));
		}
		return;
	}
	if (answer.startsWith("r")) {
		const confirm = (await io.ask(`Discard ${parts.join(" and ")} on ${session.branch}? [y/N] `))
			.trim()
			.toLowerCase();
		if (confirm === "y" || confirm === "yes") {
			const removed = removeWorktree(session, true);
			io.print("error" in removed ? chalk.red(removed.error) : chalk.dim("Worktree and branch removed."));
			return;
		}
	}
	io.print(
		`Worktree kept: ${session.path} (branch ${session.branch}). Remove it later with: git worktree remove "${session.path}"`,
	);
}
