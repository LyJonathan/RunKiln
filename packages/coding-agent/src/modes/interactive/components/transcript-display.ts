/**
 * Transcript display options read by tool renderers at render time.
 *
 * Renderers live in `core/tools/renderers` and receive no settings manager, so interactive mode pushes the
 * `display.*` settings here when it starts and whenever the user changes one. Everything defaults to the
 * values in SETTINGS_DEFAULTS, so a renderer used outside interactive mode (export, tests) still works.
 */

import { visibleWidth } from "@runkiln/tui";
import { resolveTimeZone, zonedClock, zonedDay } from "../../../core/usage/time.ts";

export type EditDiffsMode = "full" | "collapsed" | "summary";
export type DiffLayout = "unified" | "split" | "auto";

export interface TranscriptDisplayOptions {
	/** How edit cards show their diff while collapsed: the whole diff, a few lines, or the header only. */
	editDiffs: EditDiffsMode;
	/** Unified, side-by-side, or side-by-side when the terminal is at least `splitMinColumns` wide. */
	diffLayout: DiffLayout;
	/** Syntax-highlight code inside diffs (language from the file extension). */
	diffSyntax: boolean;
	/** Fold consecutive read/grep/find/ls calls into one expandable line. */
	groupReads: boolean;
	/** One dim line after each turn: time, files changed, tools, cost, router pick. */
	turnSummary: boolean;
	/** A dim timestamp under each user message and assistant reply. */
	timestamps: TimestampsMode;
}

export type TimestampsMode = "off" | "time" | "datetime";

/** Terminal width at which `diffLayout: auto` switches to side-by-side. */
export const SPLIT_DIFF_MIN_COLUMNS = 140;

/** Diff lines kept in a collapsed edit card. */
export const COLLAPSED_DIFF_LINES = 4;

export const DEFAULT_TRANSCRIPT_DISPLAY: Readonly<TranscriptDisplayOptions> = Object.freeze({
	editDiffs: "collapsed",
	diffLayout: "auto",
	diffSyntax: true,
	groupReads: true,
	turnSummary: true,
	timestamps: "off",
});

let current: TranscriptDisplayOptions = { ...DEFAULT_TRANSCRIPT_DISPLAY };

export function getTranscriptDisplay(): Readonly<TranscriptDisplayOptions> {
	return current;
}

export function setTranscriptDisplay(options: Partial<TranscriptDisplayOptions>): void {
	current = { ...current, ...options };
}

export function resetTranscriptDisplay(): void {
	current = { ...DEFAULT_TRANSCRIPT_DISPLAY };
}

/** `14:32` or `2026-10-17 14:32` in `zone` (`TZ`, else the OS zone); undefined when off. */
export function formatMessageTimestamp(
	epochMs: number,
	mode: TimestampsMode,
	zone: string = resolveTimeZone(),
): string | undefined {
	if (mode === "off" || !Number.isFinite(epochMs)) return undefined;
	const clock = zonedClock(epochMs, zone);
	return mode === "datetime" ? `${zonedDay(epochMs, zone)} ${clock}` : clock;
}

/**
 * The timestamp row under a message, ending at the last column; undefined when timestamps are off. `style` colors
 * the text (dim in the transcript).
 */
export function timestampRow(
	epochMs: number | undefined,
	width: number,
	style: (text: string) => string,
	mode: TimestampsMode = current.timestamps,
): string | undefined {
	if (epochMs === undefined) return undefined;
	const text = formatMessageTimestamp(epochMs, mode);
	if (!text || width <= 0) return undefined;
	const shown = visibleWidth(text) > width ? text.slice(-width) : text;
	return `${" ".repeat(width - visibleWidth(shown))}${style(shown)}`;
}
