/** Text for the /commit prompt (kept out of interactive-mode.ts so it can be rendered and tested alone). */

import type { CommitDraft } from "../../core/agent-session.ts";

const SCOPE_LABEL = { turn: "this turn's changes", session: "this session's changes", all: "all changes" } as const;

export function commitPromptTitle(draft: Pick<CommitDraft, "paths" | "scope">): string {
	const count = draft.paths.length;
	return `Commit ${count} file${count === 1 ? "" : "s"} (${SCOPE_LABEL[draft.scope]}): edit the message, Enter to commit, Esc to cancel`;
}

export function commitPromptDescription(draft: Pick<CommitDraft, "paths" | "costUsd" | "fallback">, max = 8): string {
	const shown = draft.paths.slice(0, max).map((path) => `  ${path}`);
	if (draft.paths.length > max) shown.push(`  … ${draft.paths.length - max} more`);
	const note = draft.fallback
		? "The chore model was unavailable: a generic message, edit it."
		: `Message by the chore model${draft.costUsd > 0 ? ` ($${draft.costUsd.toFixed(5)})` : ""}. Only these files are staged and committed.`;
	return [...shown, "", note].join("\n");
}
