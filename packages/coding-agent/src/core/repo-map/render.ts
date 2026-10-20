/**
 * Renders ranked definitions as a token-budgeted map: files in rank order, each with the signatures of its best
 * definitions, then bare paths of other relevant files. The number of entries is found by binary search so the
 * plain text fits the budget (tokens estimated at 4 characters each).
 */

import type { RankResult } from "./rank.ts";
import type { DefTag } from "./tags.ts";

export interface RepoMapStyle {
	path(text: string): string;
	gutter(text: string): string;
	signature(text: string, def: DefTag): string;
	dim(text: string): string;
}

export const PLAIN_MAP_STYLE: RepoMapStyle = {
	path: (text) => text,
	gutter: (text) => text,
	signature: (text) => text,
	dim: (text) => text,
};

export function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

type Entry = { kind: "def"; file: string; def: DefTag } | { kind: "file"; file: string };

function entriesOf(ranked: RankResult): Entry[] {
	const entries: Entry[] = ranked.defs.map((item) => ({ kind: "def", file: item.file, def: item.def }));
	const withDefs = new Set(ranked.defs.map((item) => item.file));
	for (const { file } of ranked.files) if (!withDefs.has(file)) entries.push({ kind: "file", file });
	return entries;
}

function renderEntries(entries: readonly Entry[], style: RepoMapStyle): { plain: string; styled: string } {
	const order: string[] = [];
	const byFile = new Map<string, DefTag[]>();
	for (const entry of entries) {
		if (!byFile.has(entry.file)) {
			byFile.set(entry.file, []);
			order.push(entry.file);
		}
		if (entry.kind === "def") byFile.get(entry.file)!.push(entry.def);
	}
	const plain: string[] = [];
	const styled: string[] = [];
	for (const file of order) {
		const defs = byFile.get(file)!.sort((a, b) => a.line - b.line);
		plain.push(defs.length > 0 ? `${file}:` : file);
		styled.push(defs.length > 0 ? `${style.path(file)}${style.dim(":")}` : style.dim(file));
		let lastContainer: string | undefined;
		const shown = new Set(defs.map((def) => def.name));
		for (const def of defs) {
			if (def.container && def.container !== lastContainer && !shown.has(def.container)) {
				plain.push(`│ ${def.container} …`);
				styled.push(`${style.gutter("│")} ${style.dim(`${def.container} …`)}`);
			}
			lastContainer = def.container ?? (def.kind === "class" || def.kind === "interface" ? def.name : undefined);
			const indent = def.container ? "  " : "";
			plain.push(`│ ${indent}${def.signature}`);
			styled.push(`${style.gutter("│")} ${indent}${style.signature(def.signature, def)}`);
		}
	}
	return { plain: plain.join("\n"), styled: styled.join("\n") };
}

export interface RenderedMap {
	text: string;
	styled: string;
	tokens: number;
	files: number;
	symbols: number;
}

/** The largest prefix of the ranked entries whose rendering fits `maxTokens`. */
export function renderRepoMap(
	ranked: RankResult,
	maxTokens: number,
	style: RepoMapStyle = PLAIN_MAP_STYLE,
): RenderedMap {
	const entries = entriesOf(ranked);
	let lo = 0;
	let hi = entries.length;
	let best = { plain: "", styled: "" };
	let bestCount = 0;
	// Binary search on the entry count (the rendering grows with it).
	while (lo <= hi) {
		const mid = Math.floor((lo + hi) / 2);
		const rendered = renderEntries(entries.slice(0, mid), PLAIN_MAP_STYLE);
		if (estimateTokens(rendered.plain) <= maxTokens) {
			best = rendered;
			bestCount = mid;
			lo = mid + 1;
		} else hi = mid - 1;
	}
	const chosen = entries.slice(0, bestCount);
	const styled = style === PLAIN_MAP_STYLE ? best.plain : renderEntries(chosen, style).styled;
	return {
		text: best.plain,
		styled,
		tokens: estimateTokens(best.plain),
		files: new Set(chosen.map((entry) => entry.file)).size,
		symbols: chosen.filter((entry) => entry.kind === "def").length,
	};
}
