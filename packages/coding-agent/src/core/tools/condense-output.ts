/**
 * Lean view of long command output: the head, the tail, and the error-looking lines in between.
 *
 * Build and test logs put the command line and setup at the top, the summary at the bottom, and the
 * failures somewhere in the middle. A plain tail keeps only the summary; this keeps all three and
 * says what it dropped, so the model can open the full log (saved to a file) when it needs more.
 */

import { formatSize } from "./truncate.ts";

/** Output above either limit is condensed. */
export const CONDENSE_MAX_LINES = 400;
export const CONDENSE_MAX_BYTES = 24 * 1024;

export const CONDENSE_HEAD_LINES = 40;
export const CONDENSE_TAIL_LINES = 120;
export const CONDENSE_MAX_ERROR_LINES = 40;
/** Kept lines longer than this are clipped. */
export const CONDENSE_MAX_LINE_CHARS = 400;

/** Lines worth keeping from the omitted middle: compiler errors, failed tests, stack traces. */
const ERROR_LINE =
	/\b(error|errors|fail|failed|failure|failing|fatal|panic|panicked|exception|traceback|segmentation fault|assert(ion)?(error)?|cannot|undefined reference|not found|denied|refused|timed? ?out)\b|\berr!|✗|✘|×|^\s*at .+:\d+:\d+\)?$|^E\s{2,}|^\s*\^+\s*$/i;

export function isErrorLikeLine(line: string): boolean {
	return ERROR_LINE.test(line);
}

export interface CondensedOutput {
	text: string;
	condensed: boolean;
	totalLines: number;
	totalBytes: number;
	headLines: number;
	tailLines: number;
	errorLines: number;
}

export interface CondenseOptions {
	maxLines?: number;
	maxBytes?: number;
	headLines?: number;
	tailLines?: number;
	maxErrorLines?: number;
	/** Where the full output was saved, named in the note. */
	fullOutputPath?: string;
	/** False when `output` itself already had a middle cut out, so line numbers are not exact. */
	exactLineNumbers?: boolean;
}

function clip(line: string): string {
	return line.length > CONDENSE_MAX_LINE_CHARS
		? `${line.slice(0, CONDENSE_MAX_LINE_CHARS)}… [${line.length - CONDENSE_MAX_LINE_CHARS} chars clipped]`
		: line;
}

function splitLines(output: string): string[] {
	const lines = output.split("\n");
	if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	return lines;
}

function build(lines: string[], head: number, tail: number, maxErrors: number, numbered: boolean) {
	const middleStart = head;
	const middleEnd = lines.length - tail;
	const errors: string[] = [];
	let errorCount = 0;
	for (let i = middleStart; i < middleEnd; i++) {
		if (!isErrorLikeLine(lines[i])) continue;
		errorCount++;
		if (errors.length < maxErrors) errors.push(numbered ? `${i + 1}: ${clip(lines[i])}` : clip(lines[i]));
	}
	const parts = lines.slice(0, head).map(clip);
	const omitted = middleEnd - middleStart;
	if (omitted <= 0) return { text: lines.map(clip).join("\n"), errorLines: 0 };
	const range = numbered ? `lines ${middleStart + 1}-${middleEnd}` : "lines";
	if (errors.length > 0) {
		const more = errorCount > errors.length ? ` (first ${errors.length} of ${errorCount})` : "";
		parts.push(`[... ${range} omitted (${omitted} lines); error-looking lines from them${more}:]`);
		parts.push(...errors);
		parts.push("[... end of omitted section ...]");
	} else {
		parts.push(`[... ${range} omitted (${omitted} lines), none of them error-looking ...]`);
	}
	parts.push(...lines.slice(middleEnd).map(clip));
	return { text: parts.join("\n"), errorLines: errors.length };
}

/**
 * Condense `output` when it is longer than the limits; return it unchanged otherwise.
 * The result stays within `maxBytes` (plus the note) by shrinking the head and tail if needed.
 */
export function condenseOutput(output: string, options: CondenseOptions = {}): CondensedOutput {
	const maxLines = options.maxLines ?? CONDENSE_MAX_LINES;
	const maxBytes = options.maxBytes ?? CONDENSE_MAX_BYTES;
	const lines = splitLines(output);
	const totalBytes = Buffer.byteLength(output, "utf-8");
	const unchanged: CondensedOutput = {
		text: output,
		condensed: false,
		totalLines: lines.length,
		totalBytes,
		headLines: lines.length,
		tailLines: 0,
		errorLines: 0,
	};
	if (lines.length <= maxLines && totalBytes <= maxBytes) return unchanged;

	let head = Math.min(options.headLines ?? CONDENSE_HEAD_LINES, lines.length);
	let tail = Math.min(options.tailLines ?? CONDENSE_TAIL_LINES, Math.max(0, lines.length - head));
	let maxErrors = options.maxErrorLines ?? CONDENSE_MAX_ERROR_LINES;
	const numbered = options.exactLineNumbers !== false;
	let result = build(lines, head, tail, maxErrors, numbered);
	// Long lines can still overshoot the byte budget: halve the kept sections until it fits.
	for (let i = 0; i < 6 && Buffer.byteLength(result.text, "utf-8") > maxBytes; i++) {
		head = Math.max(5, Math.floor(head / 2));
		tail = Math.max(10, Math.floor(tail / 2));
		maxErrors = Math.max(10, Math.floor(maxErrors / 2));
		result = build(lines, head, tail, maxErrors, numbered);
	}

	const where = options.fullOutputPath ? ` Full output: ${options.fullOutputPath}` : "";
	const note = `[Output condensed: ${lines.length} lines, ${formatSize(totalBytes)}. Kept the first ${head} lines, the last ${tail} lines and ${result.errorLines} error-looking lines from the middle.${where}]`;
	return {
		text: `${result.text}\n\n${note}`,
		condensed: true,
		totalLines: lines.length,
		totalBytes,
		headLines: head,
		tailLines: tail,
		errorLines: result.errorLines,
	};
}
