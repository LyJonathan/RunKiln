/**
 * Ranking, after Aider's repo map: a graph with an edge from each file that references an identifier to each file that
 * defines it, weighted by how telling the identifier is, then personalized PageRank. Files the conversation mentions
 * (or the caller focuses on) get the restart mass and their outgoing edges count 50x; identifiers the conversation
 * mentions count 10x. Each file's rank is then shared out over the definitions its references point at.
 */

import { languageForPath } from "./languages.ts";
import type { DefTag, FileTags } from "./tags.ts";

export interface RankOptions {
	/** Files the conversation mentions or the caller focuses on (repo-relative). */
	focusFiles?: ReadonlySet<string>;
	/** Identifiers the conversation mentions or the query names. */
	focusIdents?: ReadonlySet<string>;
	/** Files the caller asked for by path: their own definitions are listed first. */
	pinFiles?: ReadonlySet<string>;
	iterations?: number;
	damping?: number;
}

export interface RankedDef {
	file: string;
	def: DefTag;
	rank: number;
}

export interface RankResult {
	/** Definitions, best first. */
	defs: RankedDef[];
	/** Every file's PageRank, best first. */
	files: Array<{ file: string; rank: number }>;
}

/**
 * Names that are mostly calls to built-in methods (`list.push`, `map.get`, `str.replace`): a definition of `push`
 * somewhere should not collect every array push in the repo.
 */
const COMMON_NAMES = new Set(
	(
		"get set has add delete clear push pop shift unshift slice splice map filter reduce find findIndex some every " +
		"includes indexOf join split replace replaceAll trim keys values entries forEach sort reverse concat toString " +
		"valueOf then catch finally emit on off once send write read close open start stop run init reset update " +
		"append extend insert remove copy format print log error warn info debug next len str int list dict items " +
		"apply call bind render parse dispose destroy create new main test now resolve reject rank words size length " +
		"value name type id key String Error Map Set Array Object Promise"
	).split(" "),
);

/** Files that can reference each other's symbols: TS and JS together, C and C++ together, else one language. */
function languageFamily(file: string): string {
	const language = languageForPath(file) ?? "other";
	if (language === "typescript" || language === "tsx" || language === "javascript") return "js";
	if (language === "c" || language === "cpp") return "c";
	return language;
}

function isTellingName(name: string): boolean {
	if (name.length < 8) return false;
	return /[a-z][A-Z]/.test(name) || name.includes("_") || /^[A-Z][a-z]+[A-Z]/.test(name);
}

export function rankRepo(tags: ReadonlyMap<string, FileTags>, options: RankOptions = {}): RankResult {
	const focusFiles = options.focusFiles ?? new Set<string>();
	const focusIdents = options.focusIdents ?? new Set<string>();
	const files = [...tags.keys()].sort();
	const index = new Map(files.map((file, i) => [file, i]));
	const definers = new Map<string, string[]>();
	// `.name` (a method call): files defining a method `name`.
	const add = (key: string, file: string) => {
		const list = definers.get(key);
		if (!list) definers.set(key, [file]);
		else if (list[list.length - 1] !== file) list.push(file);
	};
	for (const file of files) {
		for (const def of tags.get(file)!.defs) {
			add(def.name, file);
			if (def.kind === "method") add(`.${def.name}`, file);
		}
	}

	const family = files.map((file) => languageFamily(file));
	// edges[src] = Map(dst -> Map(ident -> weight))
	const edges: Array<Map<number, Map<string, number>>> = files.map(() => new Map());
	for (const file of files) {
		const src = index.get(file)!;
		const refs = tags.get(file)!.refs;
		for (const [key, count] of Object.entries(refs)) {
			const defined = definers.get(key);
			if (!defined) continue;
			const name = key.startsWith(".") ? key.slice(1) : key;
			let mul = 1;
			if (focusIdents.has(name)) mul *= 10;
			if (isTellingName(name)) mul *= 10;
			if (name.startsWith("_")) mul *= 0.1;
			if (defined.length > 5) mul *= 0.1;
			if (COMMON_NAMES.has(name)) mul *= 0.1;
			if (focusFiles.has(file)) mul *= 50;
			const weight = mul * Math.sqrt(count);
			for (const definer of defined) {
				const dst = index.get(definer)!;
				// No self-loops (a file using its own helpers would trap its rank), and no links across languages
				// (a TS `resolve(` call is not a Python `def resolve`).
				if (dst === src || family[dst] !== family[src]) continue;
				const edgeWeight = weight;
				let byIdent = edges[src]!.get(dst);
				if (!byIdent) {
					byIdent = new Map();
					edges[src]!.set(dst, byIdent);
				}
				byIdent.set(name, (byIdent.get(name) ?? 0) + edgeWeight);
			}
		}
	}
	// A focused identifier pulls its defining files even when nothing references it.
	const personalization = new Float64Array(files.length);
	for (const file of focusFiles) {
		const i = index.get(file);
		if (i !== undefined) personalization[i]! += 1;
	}
	for (const name of focusIdents) {
		for (const file of definers.get(name) ?? []) personalization[index.get(file)!]! += 0.5;
	}
	let personalSum = personalization.reduce((sum, value) => sum + value, 0);
	if (personalSum === 0) {
		personalization.fill(1);
		personalSum = files.length;
	}
	for (let i = 0; i < files.length; i++) personalization[i]! /= personalSum;

	const outWeight = edges.map((out) => {
		let total = 0;
		for (const byIdent of out.values()) for (const weight of byIdent.values()) total += weight;
		return total;
	});
	const damping = options.damping ?? 0.85;
	let rank = Float64Array.from(personalization);
	const iterations = options.iterations ?? 40;
	for (let iteration = 0; iteration < iterations; iteration++) {
		const next = new Float64Array(files.length);
		let dangling = 0;
		for (let src = 0; src < files.length; src++) {
			const total = outWeight[src]!;
			if (total <= 0) {
				dangling += rank[src]!;
				continue;
			}
			for (const [dst, byIdent] of edges[src]!) {
				let weight = 0;
				for (const value of byIdent.values()) weight += value;
				next[dst]! += damping * rank[src]! * (weight / total);
			}
		}
		for (let i = 0; i < files.length; i++) {
			next[i]! += (1 - damping + damping * dangling) * personalization[i]!;
		}
		let delta = 0;
		for (let i = 0; i < files.length; i++) delta += Math.abs(next[i]! - rank[i]!);
		rank = next;
		if (delta < 1e-9) break;
	}

	// Share each file's rank out over the (definer, identifier) pairs it points at.
	const defRank = new Map<string, number>(); // `${dst}\0${ident}` -> rank
	for (let src = 0; src < files.length; src++) {
		const total = outWeight[src]!;
		if (total <= 0) continue;
		for (const [dst, byIdent] of edges[src]!) {
			for (const [ident, weight] of byIdent) {
				const key = `${dst}\u0000${ident}`;
				defRank.set(key, (defRank.get(key) ?? 0) + (rank[src]! * weight) / total);
			}
		}
	}
	const ranked: RankedDef[] = [];
	for (const file of files) {
		const i = index.get(file)!;
		const fileRank = rank[i]!;
		for (const def of tags.get(file)!.defs) {
			const fromRefs = defRank.get(`${i}\u0000${def.name}`) ?? 0;
			// Unreferenced definitions still order by their file's rank (tiny weight).
			ranked.push({ file, def, rank: fromRefs + fileRank * 1e-3 });
		}
	}
	// Definitions of focused names (the query, identifiers the conversation mentions) and of files asked for by path
	// come first, then the rest.
	const pinFiles = options.pinFiles ?? new Set<string>();
	const tier = (item: RankedDef) => (focusIdents.has(item.def.name) || pinFiles.has(item.file) ? 0 : 1);
	ranked.sort(
		(a, b) => tier(a) - tier(b) || b.rank - a.rank || a.file.localeCompare(b.file) || a.def.line - b.def.line,
	);
	return {
		defs: ranked,
		files: files.map((file) => ({ file, rank: rank[index.get(file)!]! })).sort((a, b) => b.rank - a.rank),
	};
}
