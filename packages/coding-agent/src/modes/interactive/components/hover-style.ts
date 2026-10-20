import { truncateToWidth, visibleWidth } from "@runkiln/tui";
import { theme } from "../theme/theme.ts";

/** A hovered (not selected) row: a subtle background across the full width. */
export function hoverRow(line: string, width: number): string {
	const fitted = truncateToWidth(line, width, "");
	return theme.bg("toolPendingBg", fitted + " ".repeat(Math.max(0, width - visibleWidth(fitted))));
}

/** Underline that works whatever chalk's colour level is (hover must show in every terminal with mouse support). */
export function underline(text: string): string {
	return `\x1b[4m${text}\x1b[24m`;
}

/** A hovered button or link-like label. */
export function hoverLabel(text: string): string {
	return underline(text);
}
