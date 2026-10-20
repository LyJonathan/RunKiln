/**
 * Session changes for the changes tray and the review view: what the agent changed in the files since the session
 * started (or since the user kept a change), as per-file counts and hunks. The baseline comes from the /undo
 * checkpoints (see checkpoints.ts); this module only holds the text logic, so it can be tested without git.
 *
 * A hunk is one run of changed lines. Reverting a hunk puts its old lines back in the file; keeping it moves the
 * baseline forward, so the hunk leaves the tray without touching the file.
 */

import { diffArrays } from "diff";

export type SessionChangeStatus = "added" | "modified" | "deleted";

export interface SessionFileChange {
	/** Project-relative path with forward slashes. */
	path: string;
	status: SessionChangeStatus;
	added: number;
	removed: number;
	binary?: boolean;
}

export interface SessionChanges {
	files: SessionFileChange[];
	added: number;
	removed: number;
}

/** Both sides of one changed file. Undefined content means the file does not exist on that side. */
export interface SessionFileVersions {
	path: string;
	before: Buffer | undefined;
	after: Buffer | undefined;
}

export interface ChangeHunk {
	/** 0-based index of the first old line the hunk replaces. */
	oldStart: number;
	oldLines: string[];
	/** 0-based index of the first new line. */
	newStart: number;
	newLines: string[];
}

/** Lines of `text`, each with its line ending, so joining them gives the text back byte for byte. */
export function splitLines(text: string): string[] {
	if (text.length === 0) return [];
	return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

export function isBinaryContent(content: Buffer | undefined): boolean {
	return !!content && content.subarray(0, 8000).includes(0);
}

/** The changed runs between two texts, in file order. */
export function computeHunks(before: string, after: string): ChangeHunk[] {
	const oldLines = splitLines(before);
	const newLines = splitLines(after);
	const hunks: ChangeHunk[] = [];
	let oldIndex = 0;
	let newIndex = 0;
	let current: ChangeHunk | undefined;
	for (const part of diffArrays(oldLines, newLines)) {
		const count = part.value.length;
		if (!part.added && !part.removed) {
			current = undefined;
			oldIndex += count;
			newIndex += count;
			continue;
		}
		if (!current) {
			current = { oldStart: oldIndex, oldLines: [], newStart: newIndex, newLines: [] };
			hunks.push(current);
		}
		if (part.removed) {
			current.oldLines.push(...part.value);
			oldIndex += count;
		} else {
			current.newLines.push(...part.value);
			newIndex += count;
		}
	}
	return hunks;
}

/** Line counts of a text change: lines added and removed. */
export function countChanges(before: string, after: string): { added: number; removed: number } {
	let added = 0;
	let removed = 0;
	for (const hunk of computeHunks(before, after)) {
		added += hunk.newLines.length;
		removed += hunk.oldLines.length;
	}
	return { added, removed };
}

/** `after` with one hunk put back as it was in the baseline. */
export function revertHunk(after: string, hunk: ChangeHunk): string {
	const lines = splitLines(after);
	lines.splice(hunk.newStart, hunk.newLines.length, ...hunk.oldLines);
	return lines.join("");
}

/** The baseline `before` with one hunk accepted, so it no longer shows as a change. */
export function keepHunk(before: string, hunk: ChangeHunk): string {
	const lines = splitLines(before);
	lines.splice(hunk.oldStart, hunk.oldLines.length, ...hunk.newLines);
	return lines.join("");
}

/** Hunk lines as the edit tool writes diffs (`-12 text`, `+12 text`, ` 12 text`), with `context` lines around. */
export function hunkDiffText(before: string, after: string, hunk: ChangeHunk, context = 3): string {
	const oldLines = splitLines(before);
	const newLines = splitLines(after);
	const strip = (line: string) => line.replace(/\r?\n$/, "");
	const rows: string[] = [];
	const start = Math.max(0, hunk.oldStart - context);
	for (let i = start; i < hunk.oldStart; i++) rows.push(` ${i + 1} ${strip(oldLines[i] ?? "")}`);
	hunk.oldLines.forEach((line, index) => {
		rows.push(`-${hunk.oldStart + index + 1} ${strip(line)}`);
	});
	hunk.newLines.forEach((line, index) => {
		rows.push(`+${hunk.newStart + index + 1} ${strip(line)}`);
	});
	const oldEnd = hunk.oldStart + hunk.oldLines.length;
	const newEnd = hunk.newStart + hunk.newLines.length;
	for (let i = 0; i < context && newEnd + i < newLines.length; i++) {
		rows.push(` ${oldEnd + i + 1} ${strip(newLines[newEnd + i] ?? "")}`);
	}
	return rows.join("\n");
}

/** "3 files  +27 -8". */
export function formatChangeCounts(changes: Pick<SessionChanges, "files" | "added" | "removed">): string {
	const count = changes.files.length;
	return `${count} file${count === 1 ? "" : "s"}  +${changes.added} -${changes.removed}`;
}

/** "+12 -3", or "bin" for a binary file. */
export function formatFileCounts(change: SessionFileChange): string {
	return change.binary ? "bin" : `+${change.added} -${change.removed}`;
}

export function totalChanges(files: SessionFileChange[]): SessionChanges {
	return {
		files,
		added: files.reduce((sum, file) => sum + file.added, 0),
		removed: files.reduce((sum, file) => sum + file.removed, 0),
	};
}
