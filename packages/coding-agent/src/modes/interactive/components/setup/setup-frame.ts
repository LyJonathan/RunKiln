/**
 * The layout shared by the setup wizard and the /setup hub.
 *
 * A frame has fixed slots, top to bottom:
 *
 *   blank
 *   header lines (step indicator or section tabs, blank, title, subtitle)
 *   blank
 *   body (options, fields)
 *   blank
 *   status slot (always reserved, empty when there is nothing to say)
 *   ...filler...
 *   rule
 *   key hints
 *
 * Blank lines never collapse. When the body is taller than the room left, the body scrolls around its
 * focused line and shows "N more" markers instead; the header, status and hints stay where they are.
 * Every line can carry click targets, so the same frame serves the mouse and the keyboard.
 */

import { foregroundAnsi, rgbColor, truncateToWidth, visibleWidth } from "@runkiln/tui";
import { theme } from "../../theme/theme.ts";

/** A click target on one line. x is in columns from the start of the line. */
export interface Hit {
	x0: number;
	x1: number;
	run: () => void;
}

export interface FrameLine {
	text: string;
	hits?: Hit[];
	/** The body keeps this line in view when it has to scroll. */
	focus?: boolean;
}

export interface HintItem {
	key: string;
	label: string;
	/** Input sent when the hint is clicked. No data: the hint is not clickable. */
	data?: string;
}

export interface FrameSpec {
	width: number;
	rows: number;
	header: FrameLine[];
	body: FrameLine[];
	/** The status slot. Empty string: reserved but blank. */
	status: string;
	hints: HintItem[];
	/** Center the content vertically (welcome and done screens). */
	centered?: boolean;
	/** Run when a hint is clicked. */
	send: (data: string) => void;
}

export interface Frame {
	lines: string[];
	/** Click targets by screen row, x in screen columns. */
	hits: Map<number, Hit[]>;
}

export const MAX_COLUMN = 78;
export const MIN_COLUMNS = 44;
export const MIN_ROWS = 14;

/** Ember brand colors, fixed across themes like the banner (#FF6A1A to #C9420A). */
const EMBER = { r: 255, g: 106, b: 26 };
const EMBER_DEEP = { r: 201, g: 66, b: 10 };
const RESET_FG = "\x1b[39m";

export function ember(text: string, deep = false): string {
	const color = deep ? EMBER_DEEP : EMBER;
	return `${foregroundAnsi(rgbColor(color.r, color.g, color.b), theme.getColorMode())}${text}${RESET_FG}`;
}

export function columnWidth(width: number): number {
	return Math.max(20, Math.min(MAX_COLUMN, width - 4));
}

/** Cut text to `width` columns with a single-cell ellipsis that keeps the surrounding color. */
export function clip(text: string, width: number): string {
	if (visibleWidth(text) <= width) return text;
	if (width <= 1) return "…".slice(0, Math.max(0, width));
	return `${truncateToWidth(text, width - 1, "")}…`;
}

export function center(line: string, width: number): string {
	const gap = Math.max(0, Math.floor((width - visibleWidth(line)) / 2));
	return `${" ".repeat(gap)}${line}`;
}

/** `enter next - esc back`, with the x range of every clickable hint. */
export function renderHints(hints: readonly HintItem[], send: (data: string) => void): FrameLine {
	const separator = theme.fg("dim", " - ");
	const parts: string[] = [];
	const hits: Hit[] = [];
	let x = 0;
	for (const [index, hint] of hints.entries()) {
		if (index > 0) {
			parts.push(separator);
			x += 3;
		}
		const text = `${theme.fg("dim", hint.key)} ${theme.fg("muted", hint.label)}`;
		const width = visibleWidth(text);
		const data = hint.data;
		if (data !== undefined) hits.push({ x0: x, x1: x + width, run: () => send(data) });
		parts.push(text);
		x += width;
	}
	return { text: parts.join(""), hits };
}

/**
 * The visible part of a body that does not fit: a window around the focused line, with "↑ N more" and
 * "↓ N more" in place of its first and last rows when lines are hidden there.
 */
export function windowBody(body: FrameLine[], room: number): FrameLine[] {
	if (body.length <= room) return body;
	if (room <= 0) return [];
	const focus = Math.max(
		0,
		body.findIndex((line) => line.focus),
	);
	let top = Math.max(0, Math.min(focus - Math.floor((room - 1) / 2), body.length - room));
	// Keep the focused line clear of the markers.
	if (top > 0 && focus === top) top = Math.max(0, top - 1);
	if (top + room < body.length && focus === top + room - 1) top = Math.min(body.length - room, top + 1);
	const shown = body.slice(top, top + room);
	const above = top;
	const below = body.length - top - room;
	if (above > 0) shown[0] = { text: theme.fg("dim", `↑ ${above + 1} more`) };
	if (below > 0) shown[shown.length - 1] = { text: theme.fg("dim", `↓ ${below + 1} more`) };
	return shown;
}

/** The fullscreen frame: fills `rows` exactly, content in a centered column. */
export function renderFrame(spec: FrameSpec): Frame {
	const { width, rows } = spec;
	const column = columnWidth(width);
	const left = Math.max(0, Math.floor((width - column) / 2));
	const hints = renderHints(spec.hints, spec.send);
	const footer: FrameLine[] = [{ text: theme.fg("borderMuted", "─".repeat(column)) }, hints];
	// blank + header + blank + body + blank + status + footer
	const fixed = 1 + spec.header.length + 1 + 1 + 1 + footer.length;
	const room = Math.max(0, rows - fixed);
	const body = windowBody(spec.body, room);
	const used = fixed + body.length;
	const free = Math.max(0, rows - used);
	// A fixed top margin per window size, so the header never moves between steps or sections.
	const top = spec.centered ? Math.floor(free / 2) : Math.min(free, rows >= 24 ? 1 : 0);

	const placed: FrameLine[] = [];
	for (let i = 0; i < 1 + top; i++) placed.push({ text: "" });
	placed.push(...spec.header, { text: "" }, ...body, { text: "" }, { text: spec.status });
	while (placed.length < rows - footer.length) placed.push({ text: "" });
	placed.push(...footer);

	const pad = " ".repeat(left);
	const lines: string[] = [];
	const hits = new Map<number, Hit[]>();
	for (const [row, line] of placed.slice(0, rows).entries()) {
		lines.push(line.text ? truncateToWidth(pad + clip(line.text, column), width) : "");
		if (line.hits?.length) {
			hits.set(
				row,
				line.hits.map((hit) => ({ ...hit, x0: hit.x0 + left, x1: hit.x1 + left })),
			);
		}
	}
	return { lines, hits };
}

/** The inline frame: the same slots as plain lines, no filler, nothing hidden. */
export function renderInlineFrame(spec: Omit<FrameSpec, "rows" | "centered">): Frame {
	const column = Math.max(20, Math.min(MAX_COLUMN, spec.width));
	const placed: FrameLine[] = [
		...spec.header,
		{ text: "" },
		...spec.body,
		{ text: "" },
		{ text: spec.status },
		{ text: "" },
		renderHints(spec.hints, spec.send),
	];
	const lines: string[] = [];
	const hits = new Map<number, Hit[]>();
	for (const [row, line] of placed.entries()) {
		lines.push(truncateToWidth(clip(line.text, column), spec.width));
		if (line.hits?.length) hits.set(row, line.hits);
	}
	return { lines, hits };
}

/** "Make the terminal larger" notice for windows below MIN_COLUMNS x MIN_ROWS. */
export function renderTooSmall(width: number, rows: number, message: string[]): string[] {
	const lines: string[] = [];
	const top = Math.max(0, Math.floor((rows - message.length) / 2));
	for (let i = 0; i < top; i++) lines.push("");
	for (const line of message) lines.push(truncateToWidth(center(line, width), width));
	while (lines.length < rows) lines.push("");
	return lines.slice(0, rows);
}

/** The click target under (x, y), if any. */
export function hitAt(frame: Frame | undefined, x: number, y: number): Hit | undefined {
	return frame?.hits.get(y)?.find((hit) => x >= hit.x0 && x < hit.x1);
}

/** One choice: pointer, label padded to the step's label column, hint at a fixed column. */
export function optionLine(options: {
	selected: boolean;
	label: string;
	labelWidth: number;
	hint?: string;
	column: number;
	disabled?: boolean;
	hintTone?: "dim" | "warning";
	/** A marker before the label, such as "●" for the saved value. */
	mark?: string;
	run?: () => void;
	focus?: boolean;
}): FrameLine {
	const { selected, label, labelWidth, column } = options;
	const pointer = selected ? ember("❯") : " ";
	const padded = label.padEnd(labelWidth);
	const name = options.disabled
		? theme.fg("dim", padded)
		: selected
			? ember(theme.bold(padded))
			: theme.fg("text", padded);
	const mark = options.mark ?? "";
	const head = `${pointer} ${mark}${name}`;
	const room = Math.max(0, column - visibleWidth(head) - 2);
	const hintTone = options.hintTone ?? "dim";
	const hintColor = hintTone === "warning" ? "warning" : selected ? "muted" : "dim";
	const hint = options.hint ? `  ${theme.fg(hintColor, clip(options.hint, room))}` : "";
	const text = `${head}${hint}`;
	return {
		text,
		focus: options.focus ?? selected,
		hits: options.run ? [{ x0: 0, x1: Math.max(visibleWidth(text), labelWidth + 2), run: options.run }] : undefined,
	};
}

/**
 * A label followed by chips (`‹ medium ›` for the current one). Clicking the label runs `onFocus`, clicking a
 * chip picks it.
 */
export function chipLine(options: {
	selected: boolean;
	label: string;
	labelWidth: number;
	chips: readonly string[];
	current: number;
	/** The chips are dimmed: this row is not the active choice. */
	inactive?: boolean;
	indent?: number;
	onFocus?: () => void;
	onPick?: (index: number) => void;
}): FrameLine {
	const { selected, label, labelWidth, chips, current } = options;
	const pointer = selected ? ember("❯") : " ";
	const indent = " ".repeat(options.indent ?? 0);
	const padded = label.padEnd(labelWidth);
	const name = selected ? ember(theme.bold(padded)) : theme.fg(options.inactive ? "muted" : "text", padded);
	let text = `${pointer} ${indent}${name}  `;
	const hits: Hit[] = [];
	if (options.onFocus) hits.push({ x0: 0, x1: visibleWidth(text), run: options.onFocus });
	for (const [index, chip] of chips.entries()) {
		if (index > 0) text += " ";
		const shown =
			index === current
				? selected
					? ember(theme.bold(`‹ ${chip} ›`))
					: options.inactive
						? theme.fg("muted", `  ${chip}  `)
						: theme.bold(`  ${chip}  `)
				: theme.fg("dim", `  ${chip}  `);
		const x0 = visibleWidth(text);
		text += shown;
		const pick = options.onPick;
		if (pick) hits.push({ x0, x1: visibleWidth(text), run: () => pick(index) });
	}
	return { text, hits, focus: selected };
}

/** A dim detail line under a row, indented to the value column. Always present so rows never jump. */
export function detailLine(text: string, indent: number, column: number, tone: "dim" | "muted" = "dim"): FrameLine {
	return { text: text ? `${" ".repeat(indent)}${theme.fg(tone, clip(text, Math.max(4, column - indent)))}` : "" };
}

/** A one-line input in a rounded box; the border lights up while it has focus. */
export function fieldLines(options: {
	body: string;
	empty: boolean;
	placeholder?: string;
	label: string;
	column: number;
	focused: boolean;
	run?: () => void;
}): FrameLine[] {
	const inner = Math.max(8, Math.min(options.column, 64) - 4);
	const border = (text: string) => (options.focused ? ember(text, true) : theme.fg("borderMuted", text));
	let body = options.body.trimEnd();
	if (options.empty && options.placeholder) body = `${body}${theme.fg("dim", options.placeholder)}`;
	const pad = Math.max(0, inner - visibleWidth(body));
	const title = ` ${options.label} `;
	const topRule = Math.max(0, inner + 2 - visibleWidth(title) - 1);
	const hit = options.run ? [{ x0: 0, x1: inner + 4, run: options.run }] : undefined;
	return [
		{ text: border(`╭─${title}${"─".repeat(topRule)}╮`), hits: hit },
		{
			text: `${border("│")} ${truncateToWidth(body, inner)}${" ".repeat(pad)} ${border("│")}`,
			hits: hit,
			focus: true,
		},
		{ text: border(`╰${"─".repeat(inner + 2)}╯`), hits: hit },
	];
}

export type Tone = "success" | "error" | "warning" | "muted";

export interface StatusMessage {
	tone: Tone | "checking";
	text: string;
}

/** A status line: icon by tone, spinner frame while checking. */
export function statusText(line: StatusMessage | undefined, spinner: string): string {
	if (!line) return "";
	if (line.tone === "checking") return `${ember(spinner)} ${theme.fg("muted", line.text)}`;
	const icon = line.tone === "success" ? "✓ " : line.tone === "error" ? "✗ " : line.tone === "warning" ? "! " : "";
	const text = /^[✓✗!]/.test(line.text) ? line.text : `${icon}${line.text}`;
	return theme.fg(line.tone, text);
}
