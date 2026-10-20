/**
 * Small shared pieces for the RunInfra screens (setup, /key, /models): a title row, status lines,
 * and key hints, all in the active theme so they match the rest of the TUI.
 */

import { type Input, truncateToWidth } from "@runkiln/tui";
import { theme } from "../theme/theme.ts";

export type StatusKind = "success" | "error" | "warning" | "muted";

export function fit(line: string, width: number): string {
	return truncateToWidth(line, Math.max(1, width));
}

export function rule(width: number): string {
	return theme.fg("borderMuted", "─".repeat(Math.max(1, Math.min(width, 72))));
}

/** "RunInfra - Models" with an accent title and a muted trail. */
export function titleLine(title: string, trail?: string): string {
	const head = theme.fg("accent", theme.bold(title));
	return trail ? `${head}${theme.fg("muted", `  ${trail}`)}` : head;
}

export function statusLine(kind: StatusKind, text: string): string {
	const icon = kind === "success" ? "✓ " : kind === "error" ? "✗ " : kind === "warning" ? "! " : "";
	const body = text.startsWith("✓") || text.startsWith("✗") ? text : `${icon}${text}`;
	return theme.fg(kind, body);
}

/** `enter save - esc close`: keys dim, words muted. */
export function hintLine(pairs: ReadonlyArray<readonly [string, string]>): string {
	return pairs
		.map(([key, label]) => `${theme.fg("dim", key)} ${theme.fg("muted", label)}`)
		.join(theme.fg("dim", " - "));
}

export function labelValue(label: string, value: string, labelWidth = 10): string {
	return `${theme.fg("muted", label.padEnd(labelWidth))}${value}`;
}

/** Put `value` in an input with the cursor at the end, ready to edit. */
export function prefill(input: Input, value: string): void {
	input.setValue("");
	if (value) input.handleInput(value);
}
