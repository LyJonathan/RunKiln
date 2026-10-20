import type { Component } from "@runkiln/tui";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@runkiln/tui";
import * as Diff from "diff";
import { getLanguageFromPath, highlightCode, theme } from "../theme/theme.ts";
import { SPLIT_DIFF_MIN_COLUMNS } from "./transcript-display.ts";

/**
 * Diffs as the edit tool writes them: one line per row, `+12 text`, `-12 text`, ` 12 text`, or `    ...` for
 * a gap. Context rows carry the old line number; the new one is derived from the rows before it.
 */

export type DiffRowKind = "context" | "removed" | "added" | "gap" | "other";

export interface DiffRow {
	kind: DiffRowKind;
	/** Line number on the old side (context and removed rows). */
	oldNum?: number;
	/** Line number on the new side (context and added rows). */
	newNum?: number;
	/** Line text with tabs expanded. */
	content: string;
	/** The original diff line. */
	raw: string;
}

const LINE_RE = /^([+-\s])(\s*\d*)\s(.*)$/;

function replaceTabs(text: string): string {
	return text.replace(/\t/g, "   ");
}

export function parseDiffRows(diffText: string): DiffRow[] {
	const rows: DiffRow[] = [];
	let delta = 0;
	for (const raw of diffText.split("\n")) {
		const match = raw.match(LINE_RE);
		if (!match) {
			rows.push({ kind: "other", content: replaceTabs(raw), raw });
			continue;
		}
		const [, prefix, numText, text] = match;
		const num = numText.trim() === "" ? undefined : Number(numText.trim());
		if (prefix === "-") {
			rows.push({ kind: "removed", oldNum: num, content: replaceTabs(text), raw });
			delta--;
		} else if (prefix === "+") {
			rows.push({ kind: "added", newNum: num, content: replaceTabs(text), raw });
			delta++;
		} else if (num === undefined) {
			rows.push({ kind: "gap", content: text, raw });
		} else {
			rows.push({ kind: "context", oldNum: num, newNum: num + delta, content: replaceTabs(text), raw });
		}
	}
	return rows;
}

export interface DiffStats {
	added: number;
	removed: number;
}

export function diffStats(diffText: string): DiffStats {
	let added = 0;
	let removed = 0;
	for (const line of diffText.split("\n")) {
		if (LINE_RE.test(line)) {
			if (line.startsWith("+")) added++;
			else if (line.startsWith("-")) removed++;
		}
	}
	return { added, removed };
}

/** `+12 −4`, coloured, for card headers and summaries. */
export function formatDiffStats(stats: DiffStats): string {
	return `${theme.fg("toolDiffAdded", `+${stats.added}`)} ${theme.fg("toolDiffRemoved", `−${stats.removed}`)}`;
}

// ---------------------------------------------------------------------------------------------------------
// Word-level changes

interface Range {
	start: number;
	end: number;
}

/** Changed character ranges of a modified line pair, or undefined when the lines have too little in common. */
export function wordChangeRanges(oldText: string, newText: string): { old: Range[]; new: Range[] } | undefined {
	const parts = Diff.diffWords(oldText, newText);
	const oldRanges: Range[] = [];
	const newRanges: Range[] = [];
	let oldPos = 0;
	let newPos = 0;
	let common = 0;
	const push = (ranges: Range[], start: number, value: string) => {
		// Leave leading whitespace out of a highlight, so indentation changes do not light up a bar.
		const lead = value.length - value.trimStart().length;
		const trail = value.length - value.trimEnd().length;
		if (value.trim().length === 0) return;
		ranges.push({ start: start + lead, end: start + value.length - trail });
	};
	for (const part of parts) {
		if (part.removed) {
			push(oldRanges, oldPos, part.value);
			oldPos += part.value.length;
		} else if (part.added) {
			push(newRanges, newPos, part.value);
			newPos += part.value.length;
		} else {
			common += part.value.trim().length;
			oldPos += part.value.length;
			newPos += part.value.length;
		}
	}
	const longest = Math.max(oldText.trim().length, newText.trim().length);
	if (longest === 0 || common / longest < 0.3) return undefined;
	return { old: oldRanges, new: newRanges };
}

const ESC_RE = /\x1b\[[0-9;]*m/y;

/** Whether an SGR sequence clears the background (full reset or 49), skipping 38/48 colour arguments. */
export function resetsBackground(sgr: string): boolean {
	const body = sgr.slice(2, -1);
	if (body === "") return true;
	const params = body.split(";");
	for (let i = 0; i < params.length; i++) {
		const p = params[i];
		if (p === "38" || p === "48" || p === "58") {
			i += params[i + 1] === "5" ? 2 : params[i + 1] === "2" ? 4 : 0;
			continue;
		}
		if (p === "0" || p === "" || p === "49") return true;
	}
	return false;
}

/**
 * Wrap visible character ranges of an ANSI-styled line in a background colour. A background reset inside a
 * range (from nested styling) reopens the range colour, so the highlight does not end early.
 */
export function applyBackgroundRanges(line: string, ranges: Range[], bgOpen: string): string {
	if (ranges.length === 0) return line;
	const sorted = [...ranges].sort((a, b) => a.start - b.start);
	let out = "";
	let visible = 0;
	let rangeIndex = 0;
	let inRange = false;
	let i = 0;
	while (i <= line.length) {
		while (rangeIndex < sorted.length && inRange && visible >= sorted[rangeIndex].end) {
			out += "\x1b[49m";
			inRange = false;
			rangeIndex++;
		}
		if (!inRange && rangeIndex < sorted.length && visible >= sorted[rangeIndex].start) {
			if (visible < sorted[rangeIndex].end) {
				out += bgOpen;
				inRange = true;
			} else {
				rangeIndex++;
				continue;
			}
		}
		if (i === line.length) break;
		ESC_RE.lastIndex = i;
		const esc = ESC_RE.exec(line);
		if (esc) {
			out += esc[0];
			if (inRange && resetsBackground(esc[0])) out += bgOpen;
			i += esc[0].length;
			continue;
		}
		out += line[i];
		visible++;
		i++;
	}
	if (inRange) out += "\x1b[49m";
	return out;
}

// ---------------------------------------------------------------------------------------------------------
// Styling one row's content

export interface RenderDiffOptions {
	/** File path; its extension picks the syntax highlighting language. */
	filePath?: string;
	/** Syntax highlighting inside the diff (default true when a language is known). */
	syntax?: boolean;
}

interface StyledRow {
	row: DiffRow;
	/** Content with syntax and word-level styling, without the gutter. */
	styled: string;
}

function highlightLines(lines: string[], language: string): string[] {
	const highlighted = highlightCode(lines.join("\n"), language);
	return lines.map((line, index) => highlighted[index] ?? line);
}

/**
 * Style each row's content. Removed lines keep the red diff colour so the old text reads as old; added and
 * context lines get syntax colours (context dimmed). Paired modified lines get word-level backgrounds.
 */
function styleRows(rows: DiffRow[], options: RenderDiffOptions): StyledRow[] {
	const language = options.syntax === false || !options.filePath ? undefined : getLanguageFromPath(options.filePath);
	// Highlight the new side as one text so multi-line constructs keep their colours where possible.
	let newSide: Map<DiffRow, string> | undefined;
	if (language) {
		const sideRows = rows.filter((row) => row.kind === "context" || row.kind === "added");
		const highlighted = highlightLines(
			sideRows.map((row) => row.content),
			language,
		);
		newSide = new Map(sideRows.map((row, index) => [row, highlighted[index]]));
	}
	const ranges = new Map<DiffRow, Range[]>();
	for (let i = 0; i < rows.length; ) {
		if (rows[i].kind !== "removed") {
			i++;
			continue;
		}
		const removed: DiffRow[] = [];
		while (i < rows.length && rows[i].kind === "removed") removed.push(rows[i++]);
		const added: DiffRow[] = [];
		while (i < rows.length && rows[i].kind === "added") added.push(rows[i++]);
		const pairs = Math.min(removed.length, added.length);
		for (let p = 0; p < pairs; p++) {
			const change = wordChangeRanges(removed[p].content, added[p].content);
			if (!change) continue;
			ranges.set(removed[p], change.old);
			ranges.set(added[p], change.new);
		}
	}
	const removedBg = theme.getBgAnsi("toolDiffRemovedBg");
	const addedBg = theme.getBgAnsi("toolDiffAddedBg");
	return rows.map((row) => {
		const rowRanges = ranges.get(row) ?? [];
		switch (row.kind) {
			case "removed":
				return {
					row,
					styled: theme.fg("toolDiffRemoved", applyBackgroundRanges(row.content, rowRanges, removedBg)),
				};
			case "added": {
				const base = newSide?.get(row);
				const styled =
					base !== undefined
						? applyBackgroundRanges(base, rowRanges, addedBg)
						: theme.fg("toolDiffAdded", applyBackgroundRanges(row.content, rowRanges, addedBg));
				return { row, styled };
			}
			case "context": {
				const base = newSide?.get(row);
				return {
					row,
					styled: base !== undefined ? `\x1b[2m${base}\x1b[22m` : theme.fg("toolDiffContext", row.content),
				};
			}
			default:
				return { row, styled: theme.fg("toolDiffContext", row.content) };
		}
	});
}

function gutterWidth(rows: DiffRow[]): number {
	let width = 1;
	for (const row of rows) {
		const n = Math.max(row.oldNum ?? 0, row.newNum ?? 0);
		width = Math.max(width, String(n).length);
	}
	return width;
}

function gutter(row: DiffRow, width: number, side?: "old" | "new"): string {
	const num = side === "new" ? row.newNum : side === "old" ? row.oldNum : (row.oldNum ?? row.newNum);
	const numText = num === undefined ? "".padStart(width) : String(num).padStart(width);
	switch (row.kind) {
		case "removed":
			return theme.fg("toolDiffRemoved", `-${numText}`);
		case "added":
			return theme.fg("toolDiffAdded", `+${numText}`);
		default:
			return theme.fg("toolDiffContext", ` ${numText}`);
	}
}

// ---------------------------------------------------------------------------------------------------------
// Unified and split layouts

/**
 * Render a diff string, unified, with coloured gutters, syntax colours and word-level change highlighting.
 * Returns newline-joined lines; long lines are left for the caller to wrap.
 */
export function renderDiff(diffText: string, options: RenderDiffOptions = {}): string {
	return renderUnifiedDiffLines(diffText, options).join("\n");
}

export function renderUnifiedDiffLines(diffText: string, options: RenderDiffOptions = {}): string[] {
	const rows = parseDiffRows(diffText);
	const width = gutterWidth(rows);
	return styleRows(rows, options).map(({ row, styled }) => {
		if (row.kind === "other") return styled;
		return `${gutter(row, width)} ${styled}`;
	});
}

interface SplitCell {
	row?: DiffRow;
	styled?: string;
}

function wrapCell(cell: SplitCell, side: "old" | "new", numWidth: number, columnWidth: number): string[] {
	const gutterCols = numWidth + 2;
	const textWidth = Math.max(1, columnWidth - gutterCols);
	if (!cell.row || cell.styled === undefined) return [" ".repeat(columnWidth)];
	if (cell.row.kind === "gap" || cell.row.kind === "other") {
		return [truncateToWidth(`${" ".repeat(gutterCols)}${cell.styled}`, columnWidth, "…", true)];
	}
	const wrapped = wrapTextWithAnsi(cell.styled, textWidth);
	const lines = wrapped.length > 0 ? wrapped : [""];
	return lines.map((line, index) => {
		const prefix = index === 0 ? `${gutter(cell.row!, numWidth, side)} ` : " ".repeat(gutterCols);
		return truncateToWidth(`${prefix}${line}`, columnWidth, "…", true);
	});
}

/** Side-by-side layout: old text on the left, new on the right, modified lines on the same row. */
export function renderSplitDiffLines(diffText: string, width: number, options: RenderDiffOptions = {}): string[] {
	const styledRows = styleRows(parseDiffRows(diffText), options);
	const numWidth = gutterWidth(styledRows.map((s) => s.row));
	const separator = theme.fg("borderMuted", " │ ");
	const columnWidth = Math.max(10, Math.floor((width - 3) / 2));
	const pairs: Array<[SplitCell, SplitCell]> = [];
	for (let i = 0; i < styledRows.length; ) {
		const current = styledRows[i];
		if (current.row.kind === "removed" || current.row.kind === "added") {
			const removed: StyledRow[] = [];
			while (i < styledRows.length && styledRows[i].row.kind === "removed") removed.push(styledRows[i++]);
			const added: StyledRow[] = [];
			while (i < styledRows.length && styledRows[i].row.kind === "added") added.push(styledRows[i++]);
			for (let p = 0; p < Math.max(removed.length, added.length); p++) {
				pairs.push([removed[p] ?? {}, added[p] ?? {}]);
			}
			continue;
		}
		pairs.push([current, current]);
		i++;
	}
	const lines: string[] = [];
	for (const [left, right] of pairs) {
		const leftLines = wrapCell(left, "old", numWidth, columnWidth);
		const rightLines = wrapCell(right, "new", numWidth, columnWidth);
		const height = Math.max(leftLines.length, rightLines.length);
		for (let k = 0; k < height; k++) {
			lines.push(
				`${leftLines[k] ?? " ".repeat(columnWidth)}${separator}${rightLines[k] ?? " ".repeat(columnWidth)}`,
			);
		}
	}
	return lines;
}

export type ResolvedDiffLayout = "unified" | "split";

/** `auto` is split when the terminal (render width plus the card's side padding) is wide enough. */
export function resolveDiffLayout(
	layout: "unified" | "split" | "auto",
	width: number,
	horizontalPadding = 0,
): ResolvedDiffLayout {
	if (layout === "auto") return width + horizontalPadding >= SPLIT_DIFF_MIN_COLUMNS ? "split" : "unified";
	return layout;
}

export interface DiffViewOptions extends RenderDiffOptions {
	layout?: "unified" | "split" | "auto";
	/** Columns of padding around the view (both sides), counted toward the `auto` threshold. */
	horizontalPadding?: number;
	/** Keep only the first N rows (counting from the first change) and add a "more lines" note. */
	maxRows?: number;
	/** Line appended when maxRows hides rows; receives the hidden count. */
	moreLine?: (hidden: number) => string;
}

/** Selects only the rows around the first change, for collapsed cards. */
export function previewDiffText(diffText: string, maxRows: number): { text: string; hidden: number } {
	const lines = diffText.split("\n");
	if (lines.length <= maxRows) return { text: diffText, hidden: 0 };
	const firstChange = lines.findIndex((line) => /^[+-]\s*\d/.test(line));
	const start = Math.max(0, Math.min(firstChange < 0 ? 0 : firstChange - 1, lines.length - maxRows));
	const kept = lines.slice(start, start + maxRows);
	return { text: kept.join("\n"), hidden: lines.length - kept.length };
}

/** A diff that picks unified or side-by-side layout from the width it is rendered at. */
export class DiffView implements Component {
	private cache?: { width: number; lines: string[] };
	private diffText: string;
	private options: DiffViewOptions;

	constructor(diffText: string, options: DiffViewOptions = {}) {
		this.diffText = diffText;
		this.options = options;
	}

	setDiff(diffText: string, options?: DiffViewOptions): void {
		this.diffText = diffText;
		if (options) this.options = options;
		this.cache = undefined;
	}

	invalidate(): void {
		this.cache = undefined;
	}

	render(width: number): string[] {
		if (this.cache?.width === width) return this.cache.lines;
		let text = this.diffText;
		let hidden = 0;
		if (this.options.maxRows !== undefined) {
			const preview = previewDiffText(text, this.options.maxRows);
			text = preview.text;
			hidden = preview.hidden;
		}
		const layout = resolveDiffLayout(this.options.layout ?? "unified", width, this.options.horizontalPadding ?? 0);
		let lines: string[];
		if (layout === "split") {
			lines = renderSplitDiffLines(text, width, this.options);
		} else {
			lines = [];
			for (const line of renderUnifiedDiffLines(text, this.options)) {
				if (visibleWidth(line) <= width) lines.push(line);
				else lines.push(...wrapTextWithAnsi(line, width));
			}
		}
		if (hidden > 0 && this.options.moreLine) lines.push(truncateToWidth(this.options.moreLine(hidden), width, "…"));
		this.cache = { width, lines };
		return lines;
	}
}
