/**
 * Edit outcomes per model: how often a model's edit missed (oldText not found), and how often the miss was
 * repaired automatically. Appended to `<agentDir>/logs/edits.jsonl` and kept in memory for /status.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "../../config.ts";

export type EditOutcomeKind = "ok" | "miss" | "repaired";

export interface EditOutcome {
	tool: "edit" | "write";
	model?: string;
	outcome: EditOutcomeKind;
	/** Closest-match similarity of a miss. */
	similarity?: number;
	/** New errors the post-edit checks found. */
	newErrors?: number;
}

export interface EditStats {
	edits: number;
	misses: number;
	repaired: number;
	newErrors: number;
}

const stats = new Map<string, EditStats>();
let logPathOverride: string | false | undefined;

/** Tests: a different log file, or false for none. */
export function setEditMetricsLogPath(path: string | false | undefined): void {
	logPathOverride = path;
}

export function getEditMetricsLogPath(agentDir: string = getAgentDir()): string {
	return join(agentDir, "logs", "edits.jsonl");
}

export function recordEditOutcome(outcome: EditOutcome): void {
	const model = outcome.model ?? "unknown";
	const entry = stats.get(model) ?? { edits: 0, misses: 0, repaired: 0, newErrors: 0 };
	entry.edits++;
	if (outcome.outcome === "miss") entry.misses++;
	if (outcome.outcome === "repaired") entry.repaired++;
	entry.newErrors += outcome.newErrors ?? 0;
	stats.set(model, entry);
	const path = logPathOverride === undefined ? getEditMetricsLogPath() : logPathOverride;
	if (!path) return;
	try {
		mkdirSync(dirname(path), { recursive: true });
		appendFileSync(path, `${JSON.stringify({ ts: new Date().toISOString(), ...outcome, model })}\n`);
	} catch {
		// Metrics never break an edit.
	}
}

export function getEditStats(): ReadonlyMap<string, EditStats> {
	return stats;
}

export function resetEditStats(): void {
	stats.clear();
}
