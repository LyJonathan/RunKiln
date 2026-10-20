import { type Component, MouseRegion, Text, truncateToWidth, visibleWidth } from "@runkiln/tui";
import type { ChangeSummary } from "../../../core/runkiln/checkpoints.ts";
import { SETTINGS_DEFAULTS } from "../../../core/settings-defaults.ts";
import type { TurnSummaryFields } from "../../../core/settings-manager.ts";
import { theme } from "../theme/theme.ts";
import { diffStats } from "./diff.ts";

/**
 * The line written into the transcript when a turn ends:
 * `✓ 41s - 3 files +27 −8 - 9 tools - $0.0031 - glm-5-3-flash - low`, with the router's reason on expand.
 */

export interface TurnRoutePick {
	model: string;
	thinking?: string;
	/** "auto:medium" in auto mode; undefined for a manual model. */
	mode?: string;
	/** shortRouteReason(): "code.bugfix d0.62 ↑1". */
	reason?: string;
	/** Escalation steps (↑n) this turn. */
	escalation?: number;
}

export interface TurnSummaryData {
	status: "done" | "aborted" | "error";
	durationMs: number;
	files?: { count: number; added: number; removed: number };
	tools: number;
	toolErrors: number;
	cost: number;
	route?: TurnRoutePick;
	/** When the turn ended (epoch ms), for the clock field. */
	endedAt?: number;
}

/** `display.turnSummaryFields` defaults: everything but the clock. */
export const DEFAULT_TURN_SUMMARY_FIELDS: Readonly<TurnSummaryFields> = SETTINGS_DEFAULTS.display.turnSummaryFields;

/** Turns shorter than this with no tool call (plain chat) get no summary line. */
export const TURN_SUMMARY_MIN_CHAT_MS = 3000;

/** Entries as the session stores them; only the fields the summary reads. */
export interface TurnEntryLike {
	type: string;
	id?: string;
	message?: {
		role: string;
		content?: unknown;
		stopReason?: string;
		usage?: { cost?: { total?: number } };
		isError?: boolean;
		toolName?: string;
		toolCallId?: string;
		details?: { diff?: unknown };
	};
}

export function formatTurnDuration(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const rest = seconds % 60;
	if (minutes < 60) return `${minutes}m${String(rest).padStart(2, "0")}s`;
	return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

export function formatTurnCost(cost: number): string {
	if (cost <= 0) return "$0";
	if (cost < 0.0001) return "<$0.0001";
	return cost < 1 ? `$${cost.toFixed(4)}` : `$${cost.toFixed(2)}`;
}

/**
 * Tools, errors, cost and status of the last user turn in `branch`, plus the files its edit results changed
 * (used when the turn has no checkpoint summary).
 */
export function collectTurnStats(branch: readonly TurnEntryLike[]): Omit<TurnSummaryData, "durationMs" | "route"> & {
	userEntryId?: string;
	editFiles: { count: number; added: number; removed: number };
} {
	let start = branch.length;
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type === "message" && entry.message?.role === "user") {
			start = i;
			break;
		}
	}
	const userEntryId = branch[start]?.id;
	let tools = 0;
	let toolErrors = 0;
	let cost = 0;
	let status: TurnSummaryData["status"] = "done";
	const editAdded = new Map<string, { added: number; removed: number }>();
	const callPaths = new Map<string, string>();
	for (const entry of branch.slice(start + 1)) {
		const message = entry.message;
		if (entry.type !== "message" || !message) continue;
		if (message.role === "assistant") {
			cost += message.usage?.cost?.total ?? 0;
			if (Array.isArray(message.content)) {
				for (const c of message.content as Array<{ type?: string; id?: string; name?: string; arguments?: any }>) {
					if (c?.type !== "toolCall") continue;
					tools++;
					const p = c.arguments?.path ?? c.arguments?.file_path;
					if (typeof p === "string" && c.id) callPaths.set(c.id, p);
					if (c.name === "write" && typeof p === "string" && !editAdded.has(p)) {
						editAdded.set(p, { added: 0, removed: 0 });
					}
				}
			}
			status = message.stopReason === "aborted" ? "aborted" : message.stopReason === "error" ? "error" : "done";
		} else if (message.role === "toolResult") {
			if (message.isError) toolErrors++;
			const diff = message.details?.diff;
			if (!message.isError && typeof diff === "string" && message.toolName === "edit") {
				const key = (message.toolCallId && callPaths.get(message.toolCallId)) ?? `#${editAdded.size}`;
				const stats = diffStats(diff);
				const prev = editAdded.get(key) ?? { added: 0, removed: 0 };
				editAdded.set(key, { added: prev.added + stats.added, removed: prev.removed + stats.removed });
			}
		}
	}
	let added = 0;
	let removed = 0;
	for (const stats of editAdded.values()) {
		added += stats.added;
		removed += stats.removed;
	}
	return {
		userEntryId,
		status,
		tools,
		toolErrors,
		cost,
		editFiles: { count: editAdded.size, added, removed },
	};
}

export function filesFromChangeSummary(summary: ChangeSummary | undefined): TurnSummaryData["files"] {
	if (!summary || summary.files.length === 0) return undefined;
	return { count: summary.files.length, added: summary.added, removed: summary.removed };
}

/** Whether a finished turn gets a summary line (plain chat under 3 s does not). */
export function shouldShowTurnSummary(data: TurnSummaryData): boolean {
	if (data.status !== "done") return true;
	return data.tools > 0 || data.durationMs >= TURN_SUMMARY_MIN_CHAT_MS;
}

function routeText(route: TurnRoutePick): string {
	let text = route.thinking ? `${route.model} - ${route.thinking}` : route.model;
	if (route.escalation) text += ` ↑${route.escalation}`;
	return text;
}

function clockText(epochMs: number): string {
	const at = new Date(epochMs);
	return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
}

/**
 * The summary as plain parts, most important first; the line drops parts from the end to fit. The first part is the
 * status mark, with the clock or the duration when either is on.
 */
export function turnSummaryParts(
	data: TurnSummaryData,
	fields: Readonly<TurnSummaryFields> = DEFAULT_TURN_SUMMARY_FIELDS,
): string[] {
	const mark = data.status === "done" ? "✓" : data.status === "aborted" ? "⏸" : "✗";
	const lead: string[] = [];
	if (fields.clock && data.endedAt !== undefined) lead.push(clockText(data.endedAt));
	if (fields.time) lead.push(formatTurnDuration(data.durationMs));
	const parts = [lead.length > 0 ? `${mark} ${lead.shift()}` : mark, ...lead];
	if (fields.files && data.files && data.files.count > 0) {
		parts.push(
			`${data.files.count} file${data.files.count === 1 ? "" : "s"} +${data.files.added} −${data.files.removed}`,
		);
	}
	if (fields.tools && data.tools > 0) {
		let tools = `${data.tools} tool${data.tools === 1 ? "" : "s"}`;
		if (data.toolErrors > 0) tools += ` (${data.toolErrors} failed)`;
		parts.push(tools);
	}
	if (fields.cost) parts.push(formatTurnCost(data.cost));
	if (fields.model && data.route) parts.push(routeText(data.route));
	return parts;
}

export function formatTurnSummaryLine(
	data: TurnSummaryData,
	width: number,
	fields: Readonly<TurnSummaryFields> = DEFAULT_TURN_SUMMARY_FIELDS,
): string {
	const parts = turnSummaryParts(data, fields);
	const sep = " - ";
	// A bare mark reads "✓ 3 files", not "✓ - 3 files".
	const joined = (list: string[]) =>
		list.length > 1 && list[0]!.length === 1 ? `${list[0]} ${list.slice(1).join(sep)}` : list.join(sep);
	while (parts.length > 1 && visibleWidth(joined(parts)) > width) parts.pop();
	const markColor = data.status === "done" ? "success" : data.status === "aborted" ? "warning" : "error";
	const text = joined(parts);
	const line = `${theme.fg(markColor, text.slice(0, 1))}${theme.fg("dim", text.slice(1))}`;
	return truncateToWidth(line, width, "…");
}

/** Second line when expanded: why the router picked this model. */
export function formatTurnRouteDetail(route: TurnRoutePick | undefined): string | undefined {
	if (!route) return undefined;
	const who = route.mode ? `${route.mode} picked ${routeText(route)}` : `${routeText(route)} (manual)`;
	return route.reason ? `${who}: ${route.reason}` : who;
}

/** One dim line after a turn; click (or the tool expand key) shows the router's reason. */
export class TurnSummaryComponent implements Component {
	private data: TurnSummaryData;
	private expanded = false;
	private outputPad: number;
	private readonly region: MouseRegion;
	private readonly onToggle?: () => void;
	private readonly fields: () => Readonly<TurnSummaryFields>;

	constructor(
		data: TurnSummaryData,
		outputPad = 1,
		onToggle?: () => void,
		fields: () => Readonly<TurnSummaryFields> = () => DEFAULT_TURN_SUMMARY_FIELDS,
	) {
		this.data = data;
		this.outputPad = outputPad;
		this.onToggle = onToggle;
		this.fields = fields;
		this.region = new MouseRegion(new Text("", 0, 0), (event) => {
			if (event.type !== "click" || event.button !== "left") return undefined;
			this.expanded = !this.expanded;
			this.onToggle?.();
			return { handled: true };
		});
	}

	getData(): TurnSummaryData {
		return this.data;
	}

	setData(data: TurnSummaryData): void {
		this.data = data;
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
	}

	setOutputPad(outputPad: number): void {
		this.outputPad = outputPad;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const pad = " ".repeat(this.outputPad);
		const inner = Math.max(1, width - this.outputPad * 2);
		const lines = ["", pad + formatTurnSummaryLine(this.data, inner, this.fields())];
		const detail = this.expanded ? formatTurnRouteDetail(this.data.route) : undefined;
		if (detail) lines.push(pad + truncateToWidth(theme.fg("dim", `  ${detail}`), inner, "…"));
		return lines;
	}

	handleMouse(event: Parameters<NonNullable<Component["handleMouse"]>>[0]) {
		if (event.y < 1) return undefined;
		return this.region.handleMouse({ ...event, y: 0, height: 1 });
	}
}
