/**
 * The diff shown in a write or edit approval prompt (R1): what the call would change, computed before it runs.
 *
 * - edit: the existing computeEditsDiff (the same diff the tool renderer shows), against the file on disk.
 * - write: the file on disk against the new content, or the whole content as added lines for a new file.
 *
 * The preview is display only: the call still runs exactly as the model sent it, and the gate never reads the
 * preview. Text is sanitized for the prompt (see sanitizeForPrompt), and very large previews are cut.
 */

import { constants } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import { splitBom } from "../../utils/text.ts";
import { computeEditsDiff, type Edit, generateDiffString, normalizeToLF } from "../tools/edit-diff.ts";
import { resolveToCwd } from "../tools/path-utils.ts";
import { sanitizeForPrompt, WRITE_TOOLS } from "./approval.ts";

/** What a write or edit would change, in the diff format of generateDiffString ("+12 x", "-12 x", " 12 x"). */
export interface ApprovalDiff {
	/** The diff lines, sanitized. Empty when `error` is set. */
	text: string;
	/** Added and removed line counts over the whole diff, cut lines included. */
	added: number;
	removed: number;
	/** True when the write creates the file. */
	newFile?: boolean;
	/** Lines left out of `text` because the preview was too large. */
	omittedLines?: number;
	/** Why no diff could be computed (the edit text is not in the file, the file cannot be read, ...). */
	error?: string;
}

/** Diff lines kept in a preview; the rest is counted in omittedLines. */
export const MAX_PREVIEW_DIFF_LINES = 400;
/** Existing files larger than this are not read for a write preview. */
const MAX_PREVIEW_FILE_BYTES = 2 * 1024 * 1024;

/** The edits of an edit call, read the way the edit tool reads them (an array, a JSON string, or oldText/newText). */
function editsOf(input: Record<string, unknown>): Edit[] | undefined {
	let edits: unknown = input.edits;
	if (typeof edits === "string") {
		try {
			edits = JSON.parse(edits);
		} catch {
			edits = undefined;
		}
	}
	const isEdit = (value: unknown): value is Edit =>
		!!value &&
		typeof value === "object" &&
		typeof (value as Edit).oldText === "string" &&
		typeof (value as Edit).newText === "string";
	const list: Edit[] = Array.isArray(edits) ? edits.filter(isEdit) : isEdit(edits) ? [edits] : [];
	if (typeof input.oldText === "string" && typeof input.newText === "string") {
		list.push({ oldText: input.oldText, newText: input.newText });
	}
	return list.length > 0 ? list : undefined;
}

/** Count, sanitize and cut a generateDiffString diff. */
export function toApprovalDiff(diff: string, extra: { newFile?: boolean } = {}): ApprovalDiff {
	const lines = diff === "" ? [] : diff.split("\n");
	let added = 0;
	let removed = 0;
	for (const line of lines) {
		if (line.startsWith("+")) added++;
		else if (line.startsWith("-")) removed++;
	}
	const kept = lines.slice(0, MAX_PREVIEW_DIFF_LINES).map((line) => sanitizeForPrompt(line));
	const omitted = lines.length - kept.length;
	return {
		text: kept.join("\n"),
		added,
		removed,
		...(extra.newFile ? { newFile: true } : {}),
		...(omitted > 0 ? { omittedLines: omitted } : {}),
	};
}

async function writeDiff(path: string, content: string, cwd: string): Promise<ApprovalDiff> {
	const absolutePath = resolveToCwd(path, cwd);
	let before: string | undefined;
	try {
		const info = await stat(absolutePath);
		if (!info.isFile()) return { text: "", added: 0, removed: 0, error: "The target exists and is not a file." };
		if (info.size > MAX_PREVIEW_FILE_BYTES) {
			return { text: "", added: 0, removed: 0, error: "The existing file is too large to preview." };
		}
		await access(absolutePath, constants.R_OK);
		before = normalizeToLF(splitBom(await readFile(absolutePath, "utf-8")).text);
	} catch (error) {
		const code = (error as { code?: unknown } | undefined)?.code;
		if (code !== "ENOENT" && code !== "ENOTDIR") {
			return { text: "", added: 0, removed: 0, error: "The existing file could not be read." };
		}
	}
	const after = normalizeToLF(content);
	if (before === undefined) return toApprovalDiff(generateDiffString("", after).diff, { newFile: true });
	return toApprovalDiff(generateDiffString(before, after).diff);
}

/**
 * The diff for a genuine write or edit call, or undefined for any other call. Never throws: a diff that cannot be
 * computed comes back with `error` set, so the prompt can say why it shows none.
 */
export async function computeApprovalDiff(
	toolName: string,
	args: unknown,
	cwd: string,
): Promise<ApprovalDiff | undefined> {
	if (!WRITE_TOOLS.has(toolName)) return undefined;
	const input = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
	const path = typeof input.path === "string" ? input.path : "";
	if (!path) return undefined;
	try {
		if (toolName === "write") {
			if (typeof input.content !== "string") return undefined;
			return await writeDiff(path, input.content, cwd);
		}
		const edits = editsOf(input);
		if (!edits) return undefined;
		const result = await computeEditsDiff(path, edits, cwd);
		if ("error" in result) {
			return { text: "", added: 0, removed: 0, error: sanitizeForPrompt(result.error).slice(0, 300) };
		}
		return toApprovalDiff(result.diff);
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		return { text: "", added: 0, removed: 0, error: sanitizeForPrompt(detail).slice(0, 300) };
	}
}

/** `+3 −1` for a title. */
export function diffStatLabel(diff: Pick<ApprovalDiff, "added" | "removed">): string {
	return `+${diff.added} −${diff.removed}`;
}
