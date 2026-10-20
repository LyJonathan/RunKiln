/**
 * Help after a failed edit: when oldText matches neither exactly nor fuzzily, find the window of lines that comes
 * closest (a difflib-like character ratio) and show it with line numbers and a compact diff of what differs.
 */

import { diffChars, diffLines } from "diff";

export interface ClosestMatch {
	/** 1-based, inclusive. */
	startLine: number;
	endLine: number;
	/** 0..1, like difflib's SequenceMatcher.ratio() (indentation-only differences count as 98%). */
	similarity: number;
	/** The file's text for those lines. */
	text: string;
	/** Another, separate window is about as close (within 0.03): a repair would be a guess. */
	ambiguous: boolean;
}

/** Lines shown from the matched window; longer windows show the head and tail. */
const MAX_WINDOW_LINES = 30;
const MAX_DIFF_LINES = 14;
/** Below this the hint says there is no close match instead of showing one. */
export const MIN_HINT_SIMILARITY = 0.5;
const SCAN_BUDGET = 600_000;

function bigrams(line: string): Map<string, number> {
	const out = new Map<string, number>();
	const text = line.trim().replace(/\s+/g, " ");
	for (let i = 0; i < text.length - 1; i++) {
		const gram = text.slice(i, i + 2);
		out.set(gram, (out.get(gram) ?? 0) + 1);
	}
	return out;
}

function lineSimilarity(a: string, b: string, ga: Map<string, number>, gb: Map<string, number>): number {
	const ta = a.trim();
	const tb = b.trim();
	if (ta === tb) return ta === a.trim() && a === b ? 1 : 0.97;
	if (!ta || !tb) return 0;
	if (ga.size === 0 || gb.size === 0) return 0;
	let shared = 0;
	let total = 0;
	for (const [gram, count] of ga) {
		shared += Math.min(count, gb.get(gram) ?? 0);
		total += count;
	}
	for (const count of gb.values()) total += count;
	return (2 * shared) / total;
}

/**
 * Similarity used for ranking and for the auto-repair threshold: the character ratio, or 98% of the ratio with
 * leading indentation removed when that is higher, so tabs-versus-spaces mismatches score as near misses.
 */
export function windowSimilarity(a: string, b: string): number {
	const strip = (text: string) => text.replace(/^[ \t]+/gm, "");
	return Math.max(similarityRatio(a, b), 0.98 * similarityRatio(strip(a), strip(b)));
}

/** difflib-style ratio: 2 * matched characters / total characters. */
export function similarityRatio(a: string, b: string): number {
	if (a.length + b.length === 0) return 1;
	let matched = 0;
	for (const part of diffChars(a, b)) if (!part.added && !part.removed) matched += part.value.length;
	return (2 * matched) / (a.length + b.length);
}

function splitLines(text: string): string[] {
	const lines = text.split("\n");
	if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
	return lines;
}

/** The window of `content` closest to `oldText`, or undefined for empty input. Both are LF-normalized. */
export function findClosestMatch(content: string, oldText: string): ClosestMatch | undefined {
	const fileLines = splitLines(content);
	const oldLines = splitLines(oldText);
	const n = oldLines.length;
	if (n === 0 || fileLines.length === 0 || !oldText.trim()) return undefined;
	const fileGrams = fileLines.map(bigrams);
	const oldGrams = oldLines.map(bigrams);

	// Candidate window starts: every line when the file is small enough, else anchored on the most distinctive lines.
	let starts: number[];
	const lastStart = Math.max(0, fileLines.length - n);
	if (fileLines.length * n <= SCAN_BUDGET) {
		starts = Array.from({ length: lastStart + 1 }, (_, i) => i);
	} else {
		const anchors = oldLines
			.map((line, index) => ({ index, length: line.trim().length }))
			.sort((a, b) => b.length - a.length)
			.slice(0, 3);
		const set = new Set<number>();
		for (const anchor of anchors) {
			for (let j = 0; j < fileLines.length; j++) {
				const sim = lineSimilarity(oldLines[anchor.index], fileLines[j], oldGrams[anchor.index], fileGrams[j]);
				if (sim >= 0.6) set.add(Math.min(lastStart, Math.max(0, j - anchor.index)));
			}
		}
		starts = [...set];
	}

	// Phase 1: average line similarity for windows of n lines.
	const scored: Array<{ start: number; score: number }> = [];
	for (const start of starts) {
		let sum = 0;
		for (let i = 0; i < n && start + i < fileLines.length; i++) {
			sum += lineSimilarity(oldLines[i], fileLines[start + i], oldGrams[i], fileGrams[start + i]);
		}
		scored.push({ start, score: sum / n });
	}
	scored.sort((a, b) => b.score - a.score || a.start - b.start);
	const top = scored.slice(0, 8);
	if (top.length === 0) return undefined;

	// Phase 2: character ratio for the best starts, with windows one line shorter or longer.
	const candidates: Array<{ start: number; end: number; similarity: number }> = [];
	for (const { start } of top) {
		let best: { start: number; end: number; similarity: number } | undefined;
		for (let size = Math.max(1, n - 1); size <= n + 1; size++) {
			const end = Math.min(fileLines.length, start + size);
			const text = fileLines.slice(start, end).join("\n");
			const similarity = windowSimilarity(oldLines.join("\n"), text);
			if (!best || similarity > best.similarity + 1e-9) best = { start, end, similarity };
		}
		if (best) candidates.push(best);
	}
	candidates.sort((a, b) => b.similarity - a.similarity || a.start - b.start);
	const best = candidates[0];
	const rival = candidates.find((c) => c.start >= best.end || c.end <= best.start);
	return {
		startLine: best.start + 1,
		endLine: best.end,
		similarity: best.similarity,
		text: fileLines.slice(best.start, best.end).join("\n"),
		ambiguous: !!rival && rival.similarity >= best.similarity - 0.03,
	};
}

function visibleWhitespace(line: string): string {
	return line.replace(/^[ \t]+/, (lead) => lead.replace(/\t/g, "→").replace(/ /g, "·"));
}

/** Numbered lines of the window, the middle elided when it is long. */
function numbered(match: ClosestMatch): string[] {
	const lines = match.text.split("\n");
	const width = String(match.endLine).length;
	const fmt = (line: string, index: number) => `${String(match.startLine + index).padStart(width)}\t${line}`;
	if (lines.length <= MAX_WINDOW_LINES) return lines.map(fmt);
	const head = lines.slice(0, 18).map(fmt);
	const tail = lines.slice(-10).map((line, i) => fmt(line, lines.length - 10 + i));
	return [...head, `\t[... ${lines.length - 28} lines ...]`, ...tail];
}

/** A short line diff of oldText against the window: only the changed lines. */
export function compactDiff(oldText: string, fileText: string): string[] {
	const out: string[] = [];
	const parts = diffLines(oldText.endsWith("\n") ? oldText : `${oldText}\n`, `${fileText}\n`);
	const removed: string[] = [];
	const added: string[] = [];
	const flush = () => {
		// Whitespace-only changes are invisible in a plain diff: show leading tabs and spaces.
		const whitespaceOnly =
			removed.length === added.length && removed.every((line, i) => line.trim() === added[i].trim());
		for (const line of removed) out.push(`- ${whitespaceOnly ? visibleWhitespace(line) : line}`);
		for (const line of added) out.push(`+ ${whitespaceOnly ? visibleWhitespace(line) : line}`);
		if (whitespaceOnly && removed.length > 0) out.push("  (only indentation differs: → tab, · space)");
		removed.length = 0;
		added.length = 0;
	};
	for (const part of parts) {
		const lines = splitLines(part.value);
		if (part.removed) removed.push(...lines);
		else if (part.added) added.push(...lines);
		else flush();
	}
	flush();
	if (out.length > MAX_DIFF_LINES) {
		return [...out.slice(0, MAX_DIFF_LINES), `  [... ${out.length - MAX_DIFF_LINES} more diff lines ...]`];
	}
	return out;
}

/** The hint appended to a "could not find" error. */
export function formatEditHint(match: ClosestMatch | undefined, oldText: string): string {
	if (!match || match.similarity < MIN_HINT_SIMILARITY) {
		const where = match
			? ` (best: lines ${match.startLine}-${match.endLine}, ${Math.round(match.similarity * 100)}% similar)`
			: "";
		return `No close match in the file${where}. Re-read the file before editing it again.`;
	}
	const percent = Math.floor(match.similarity * 100);
	const lines = [
		`Closest match: lines ${match.startLine}-${match.endLine} (${percent}% similar${match.ambiguous ? "; another spot is about as close" : ""}). The file has:`,
		...numbered(match),
		"What differs (- your oldText, + the file):",
		...compactDiff(oldText, match.text),
		"Use the file's text above as oldText (without the line numbers).",
	];
	return lines.join("\n");
}
