/**
 * Human-readable router explanations: a short reason for the footer, a full report for /router.
 */

import type { RouterMode } from "./catalog.ts";
import type { RouteDecision, RouterStats } from "./router.ts";

export interface RouterStatus {
	enabled: boolean;
	mode: RouterMode;
	modeDescription?: string;
	/** Where the routable models came from (live RunInfra catalog or models.yaml). */
	catalogInfo?: string;
	/** Routable models without quality curves of their own (unbenched): auto uses them only as a last resort. */
	derivedModels?: string[];
	backend?: string;
	classifierModel?: string;
	problem?: string;
	catalogSources: string[];
	stats?: RouterStats;
	/** Key bound to app.router.cycleMode (interactive mode only). */
	modeCycleKey?: string;
	/** Models sitting out a failure cooldown. */
	coolingDown?: Array<{ modelId: string; leftMs: number }>;
	/** Model failover setting (on by default). */
	failoverEnabled?: boolean;
}

const pct = (value: number) => value.toFixed(2);

function money(value: number | undefined): string {
	if (value === undefined) return "?";
	if (value === 0) return "$0";
	return value < 0.0001 ? `$${value.toExponential(1)}` : `$${value.toFixed(4)}`;
}

/**
 * One short phrase: why this model, e.g. "code.bugfix d0.62" or "held: Jev timed out". Quality selection:
 * the task kind and difficulty, then the markers that changed the route: "↑1" (stepped up after a failure),
 * "follow-up" (inherited the previous turn), "fast" (no classifier call), "cached", "trivial".
 */
export function shortRouteReason(decision: RouteDecision): string {
	switch (decision.source) {
		case "held-fallback":
			return "classifier failed, kept last";
		case "default-fallback":
			return "classifier failed, default";
		case "failover":
			return decision.failoverFrom ? `failover from ${decision.failoverFrom}` : "failover";
		default: {
			if (decision.kind) {
				const parts: string[] = [decision.kind];
				if (decision.difficulty !== undefined) parts.push(`d${pct(decision.difficulty)}`);
				if (decision.escalationSteps) parts.push(`↑${decision.escalationSteps}`);
				if (decision.followUp) parts.push("follow-up");
				if (decision.source === "heuristic" || decision.source === "warm-skip") parts.push("fast");
				if (decision.source === "cache") parts.push("cached");
				if (decision.trivial) parts.push("trivial");
				if (decision.selection?.cause === "held_warm") parts.push("warm");
				return parts.join(" ");
			}
			const primary = decision.classification?.skills[0]?.skill ?? "general";
			const parts = [primary];
			if (decision.difficulty !== undefined) parts.push(`d${pct(decision.difficulty)}`);
			if (decision.source === "escalation" || decision.selection?.escalated) parts.push("↑");
			if (decision.trivial) parts.push("trivial");
			if (decision.source === "cache") parts.push("cached");
			return parts.join(" ");
		}
	}
}

export function formatRouterReport(status: RouterStatus, decision: RouteDecision | undefined): string {
	const lines: string[] = [];
	lines.push(
		status.enabled
			? `Router: auto:${status.mode}${status.modeDescription ? ` (${status.modeDescription})` : ""}`
			: "Router: off: a manual model is selected (/model auto to turn on)",
	);
	const cycleKey = status.modeCycleKey ? `; ${status.modeCycleKey} cycles them` : "";
	lines.push(`Modes: /router low | medium | high (or /model auto:<mode>${cycleKey})`);
	if (status.backend) {
		lines.push(`Classifier: ${status.backend}${status.classifierModel ? ` (${status.classifierModel})` : ""}`);
	} else {
		lines.push(`Classifier: none${status.problem ? ` (${status.problem})` : ""}`);
	}
	lines.push(`Catalog: ${status.catalogSources.join(" + ")}`);
	if (status.catalogInfo) lines.push(`Models: ${status.catalogInfo}`);
	if (status.derivedModels && status.derivedModels.length > 0) {
		lines.push(
			`Unbenched (borrowed, discounted curves; auto picks them only when no benched model fits): ${status.derivedModels.join(", ")}`,
		);
	}
	if (status.failoverEnabled === false) lines.push("Failover: off (settings failover.enabled)");
	if (status.coolingDown && status.coolingDown.length > 0) {
		const list = status.coolingDown.map((entry) => `${entry.modelId} (${Math.ceil(entry.leftMs / 1000)} s left)`);
		lines.push(`Cooling down after failures: ${list.join(", ")}`);
	}
	if (status.stats) {
		const s = status.stats;
		lines.push(
			`Session: ${s.classifierCalls} classifier calls, ${s.cacheHits} cache hits, ${s.continuations} tool continuations, ${s.escalations} escalations, ${s.fallbacks} fallbacks`,
		);
	}
	if (!decision) {
		lines.push("", "No routing decision yet.");
		return lines.join("\n");
	}

	lines.push(
		"",
		`Last decision: ${decision.model.id} - thinking ${decision.thinkingLevel}${decision.thinkingPinned ? " (pinned)" : ""}`,
	);
	const sourceText: Record<RouteDecision["source"], string> = {
		classifier: `fresh ${decision.backend ?? "classifier"} answer${decision.classifierMs !== undefined ? ` in ${decision.classifierMs} ms` : ""}`,
		cache: "cached classifier answer (same request seen recently)",
		heuristic: "obvious trivial turn (ack/greeting): no classifier call",
		"follow-up": "bare follow-up (approval/continue/retry): the previous turn's classification, no classifier call",
		continuation: "tool continuation: kept the turn's decision, no classifier call",
		"warm-skip": "warm pair kept: it wins for every task kind and difficulty, no classifier call",
		escalation: "tool continuation with new failures: re-selected at higher difficulty, no classifier call",
		reselect: "routing mode changed: re-selected with this turn's classification, no classifier call",
		"held-fallback": "classifier unavailable: kept the previous decision",
		"default-fallback": "classifier unavailable and no previous decision: default model",
		failover: `failover: ${decision.failoverFrom ?? "the turn's model"} kept failing, so this turn uses ${decision.model.id} at an equivalent thinking level`,
	};
	lines.push(`Source: ${sourceText[decision.source]}`);
	if (decision.error) lines.push(`Classifier error: ${decision.error}`);
	if (decision.switched && decision.previousModelId) {
		lines.push(`Switched from ${decision.previousModelId} (the new model starts without a warm prompt cache)`);
	}

	const c = decision.classification;
	if (c) {
		const skills =
			c.skills.length > 0 ? c.skills.map((s) => `${s.skill} ${pct(s.prob)}`).join(", ") : "none (out of taxonomy)";
		lines.push(`Skills: ${skills}`);
		lines.push(`Confidence: ${pct(c.confidence)} - needs tools: ${c.needsTools ? "yes" : "no"}`);
		if (decision.kind) {
			const task = [`kind ${decision.kind}`];
			if (decision.followUp) task.push("follow-up (inherits the previous turn)");
			if (c.outputLength !== undefined) task.push(`output length ${c.outputLength.toFixed(1)}/3`);
			if (c.ambiguity !== undefined) task.push(`ambiguity ${pct(c.ambiguity)}`);
			lines.push(`Task: ${task.join(" - ")}`);
		}
	}
	if (decision.difficulty !== undefined) {
		const parts = [];
		if (decision.rawDifficulty !== undefined) parts.push(`classifier ${pct(decision.rawDifficulty)}`);
		if (decision.momentumApplied) parts.push("momentum from earlier turns");
		for (const boost of decision.boosts) parts.push(`+${pct(boost.delta)} ${boost.reason}`);
		lines.push(`Difficulty: ${pct(decision.difficulty)}${parts.length ? ` (${parts.join("; ")})` : ""}`);
	}
	const sel = decision.selection;
	if (sel) {
		lines.push(
			`Selection: ${sel.cause.replace(/_/g, " ")}${sel.escalated ? " (no model clears every bar; least deficient)" : ""} - effective difficulty ${pct(sel.effectiveDifficulty)}`,
		);
		if (sel.required.length > 0) {
			lines.push(`Required: ${sel.required.map((r) => `${r.skill} ≥ ${r.minScore}`).join(", ")}`);
		}
		if (sel.quality) {
			const q = sel.quality;
			const from = q.from
				? ` - stepped up ${q.steps} from ${q.from.model} ${q.from.level} (${pct(q.from.quality)})`
				: "";
			lines.push(
				`Quality: chosen ${pct(q.chosen)} - best ${pct(q.best)} - band ${pct(q.tolerance)} - answer ~${q.answerTokens} tokens${from}`,
			);
		}
		lines.push("", "Candidates: model at its chosen thinking level (est. cost of this request):");
		const rows = [...sel.candidates].sort((a, b) => a.estCostUsd - b.estCostUsd);
		const width = Math.max(...rows.map((r) => r.model.length));
		for (const row of rows) {
			const mark = row.model === decision.model.id ? "→" : " ";
			const status = row.feasible ? "ok" : row.hardFail ? "no fit" : "short";
			const detail = row.failed.length > 0 ? `  ${row.failed.join(", ")}` : "";
			const score =
				row.quality !== undefined
					? `pass ${pct(row.quality)}${row.derived ? "*" : " "}`
					: `margin ${String(row.minMargin).padStart(6)}`;
			lines.push(
				`${mark} ${row.model.padEnd(width)}  ${money(row.estCostUsd).padStart(9)}  ${score}  ${row.thinkingLevel.padEnd(7)} ${status}${detail}`,
			);
			if (row.pairs && row.pairs.length > 1) {
				const pairs = row.pairs.map((pair) =>
					pair.quality !== undefined
						? `${pair.level} ${pct(pair.quality)} ${money(pair.estCostUsd)}`
						: `${pair.level} ${pair.feasible ? "ok" : "short"} ${pair.minMargin >= 0 ? "+" : ""}${pair.minMargin} ${money(pair.estCostUsd)}`,
				);
				lines.push(`    ${" ".repeat(width)}  levels: ${pairs.join(" - ")}`);
			}
		}
	}
	if (sel?.quality && sel.candidates.some((row) => row.derived)) {
		lines.push("* unbenched: curves borrowed from the closest benched model, discounted");
	}
	lines.push("", `Estimated cost of this request: ${money(decision.estCostUsd)}`);
	return lines.join("\n");
}
