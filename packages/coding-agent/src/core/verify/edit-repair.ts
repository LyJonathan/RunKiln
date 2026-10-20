/**
 * Optional repair of a missed edit by the chore model (setting `edit.autoRepair`, off by default). Only tried when
 * the closest window is at least 90% similar and no other spot is as close. The model rewrites oldText (and newText
 * to match) from the file's real text; the result is used only if its oldText occurs exactly once, inside that
 * window.
 */

import type { ClosestMatch } from "./edit-hint.ts";

export const AUTO_REPAIR_MIN_SIMILARITY = 0.9;

export interface EditRepairRequest {
	path: string;
	/** LF-normalized file content (BOM stripped). */
	content: string;
	oldText: string;
	newText: string;
	closest: ClosestMatch;
	signal?: AbortSignal;
}

export interface EditRepair {
	oldText: string;
	newText: string;
}

/** The chore call: returns the model's raw text, or undefined when no model could run it. */
export type EditRepairCall = (prompt: string, signal?: AbortSignal) => Promise<string | undefined>;

export function canAutoRepair(closest: ClosestMatch | undefined): closest is ClosestMatch {
	return !!closest && closest.similarity >= AUTO_REPAIR_MIN_SIMILARITY && !closest.ambiguous;
}

export function buildRepairPrompt(request: EditRepairRequest): string {
	const fence = "~~~~";
	return [
		"An exact-text edit failed: its oldText is not in the file. The file region it was meant for is below.",
		"Rewrite oldText so it is copied character for character from the file region (same whitespace, same",
		"indentation, same lines), and rewrite newText to make the same intended change against that text, in the",
		"file's style. Change nothing else. Reply with JSON only, no prose:",
		'{"oldText": "...", "newText": "..."}',
		"",
		`File ${request.path}, lines ${request.closest.startLine}-${request.closest.endLine}:`,
		fence,
		request.closest.text,
		fence,
		"oldText (wrong):",
		fence,
		request.oldText,
		fence,
		"newText:",
		fence,
		request.newText,
		fence,
	].join("\n");
}

/** Parses the model's JSON reply (code fences allowed). */
export function parseRepair(text: string): EditRepair | undefined {
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start < 0 || end <= start) return undefined;
	try {
		const parsed = JSON.parse(text.slice(start, end + 1)) as Partial<EditRepair>;
		if (typeof parsed.oldText !== "string" || typeof parsed.newText !== "string" || !parsed.oldText) return undefined;
		return { oldText: parsed.oldText.replace(/\r\n/g, "\n"), newText: parsed.newText.replace(/\r\n/g, "\n") };
	} catch {
		return undefined;
	}
}

/** True when the repaired oldText occurs exactly once in the content and inside the matched window. */
export function validateRepair(content: string, repair: EditRepair, closest: ClosestMatch): boolean {
	const first = content.indexOf(repair.oldText);
	if (first < 0 || content.indexOf(repair.oldText, first + 1) >= 0) return false;
	const startLine = content.slice(0, first).split("\n").length;
	const endLine = startLine + repair.oldText.split("\n").length - 1;
	return startLine >= closest.startLine - 1 && endLine <= closest.endLine + 1;
}

/** Asks the chore model for a repair and validates it. Undefined when it could not be repaired safely. */
export async function repairEdit(request: EditRepairRequest, call: EditRepairCall): Promise<EditRepair | undefined> {
	if (!canAutoRepair(request.closest)) return undefined;
	let reply: string | undefined;
	try {
		reply = await call(buildRepairPrompt(request), request.signal);
	} catch {
		return undefined;
	}
	const repair = reply ? parseRepair(reply) : undefined;
	if (!repair || !validateRepair(request.content, repair, request.closest)) return undefined;
	return repair;
}
