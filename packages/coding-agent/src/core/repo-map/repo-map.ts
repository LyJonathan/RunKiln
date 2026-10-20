/**
 * The repo map of one working directory: every source file's definitions and references (tags.ts), ranked by
 * personalized PageRank (rank.ts) and rendered to a token budget (render.ts).
 *
 * The index is built once per process and kept in memory; later calls re-stat the files and parse only the ones whose
 * mtime or size changed. Tags are cached on disk (`<agentDir>/cache/repo-map/<cwd hash>.json`), keyed by git HEAD and
 * every file's mtime and size, so a new session in an unchanged repo parses nothing.
 *
 * The map never goes in the system prompt (that would change the cached prefix whenever the repo changes): it is
 * returned by the `repo_map` tool and `/map`, and optionally appended once to the first user turn.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { type LanguageId, languageForPath } from "./languages.ts";
import { type RankResult, rankRepo } from "./rank.ts";
import { PLAIN_MAP_STYLE, type RenderedMap, type RepoMapStyle, renderRepoMap } from "./render.ts";
import { extractTags, type FileTags } from "./tags.ts";

export const DEFAULT_MAP_TOKENS = 1024;
export const MAX_MAP_TOKENS = 8192;
const CACHE_VERSION = 1;
const MAX_FILES = 5000;
const MAX_FILE_BYTES = 256 * 1024;
const SKIP_DIRS = new Set([
	"node_modules",
	".git",
	"dist",
	"build",
	"out",
	"target",
	"vendor",
	".venv",
	"venv",
	"__pycache__",
	".next",
	".turbo",
	"coverage",
]);

interface FileState {
	mtimeMs: number;
	size: number;
	language: LanguageId;
}

interface CacheFile {
	v: number;
	cwd: string;
	head: string;
	key: string;
	files: Record<string, { m: number; s: number; t: FileTags }>;
}

export interface RepoMapRequest {
	/** Files or directories to center the map on (repo-relative or absolute). */
	focusPaths?: readonly string[];
	/** Words or identifiers to look for (boosts definitions whose names match). */
	query?: string;
	/** Conversation text: file paths and identifiers in it are boosted (Aider's "mentioned" files and idents). */
	conversation?: string;
	/** Token budget for the map. Default 1024. */
	tokens?: number;
	style?: RepoMapStyle;
}

export interface RepoMapResult extends RenderedMap {
	totalFiles: number;
	parsedFiles: number;
	parser: "tree-sitter" | "regex" | "mixed" | "none";
	head: string;
	/** Files and identifiers the map was centered on. */
	focusFiles: string[];
	focusIdents: string[];
	/** Parse work this call: files (re)parsed, and whether the disk cache was used. */
	reparsed: number;
	fromDiskCache: boolean;
	buildMs: number;
}

function git(cwd: string, args: string[]): string | undefined {
	try {
		return execFileSync("git", args, {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 5000,
			maxBuffer: 32 * 1024 * 1024,
		});
	} catch {
		return undefined;
	}
}

function walk(root: string, limit: number): string[] {
	const out: string[] = [];
	const stack = [""];
	while (stack.length > 0 && out.length < limit) {
		const dir = stack.pop()!;
		let entries: import("node:fs").Dirent[];
		try {
			entries = readdirSync(join(root, dir), { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (entry.name.startsWith(".") && entry.name !== ".github") continue;
			const rel = dir ? `${dir}/${entry.name}` : entry.name;
			if (entry.isDirectory()) {
				if (!SKIP_DIRS.has(entry.name)) stack.push(rel);
			} else if (entry.isFile()) out.push(rel);
			if (out.length >= limit) break;
		}
	}
	return out;
}

/** Source files of the repo: git's tracked + untracked-not-ignored files, or a directory walk outside git. */
export function listSourceFiles(cwd: string, limit = MAX_FILES): string[] {
	const listed = git(cwd, ["ls-files", "-co", "--exclude-standard", "-z"]);
	const all = listed !== undefined ? listed.split("\0").filter(Boolean) : walk(cwd, limit * 4);
	const files: string[] = [];
	for (const file of all) {
		if (files.length >= limit) break;
		if (!languageForPath(file)) continue;
		if (/\.min\.(js|css)$/.test(file) || file.endsWith(".d.ts")) continue;
		if (file.split("/").some((part) => SKIP_DIRS.has(part))) continue;
		files.push(file);
	}
	return files.sort();
}

const IDENT_RE = /[A-Za-z_$][\w$]{2,}/g;
const PATHISH_RE = /[\w@./-]*[\w-]+\.[A-Za-z]{1,5}\b/g;

/** Files and identifiers a text mentions, among the repo's files and defined names. */
export function mentionsIn(
	text: string,
	files: readonly string[],
	definedNames: ReadonlySet<string>,
): { files: Set<string>; idents: Set<string> } {
	const fileSet = new Set(files);
	const byBase = new Map<string, string[]>();
	for (const file of files) {
		const base = file.slice(file.lastIndexOf("/") + 1);
		const list = byBase.get(base);
		if (list) list.push(file);
		else byBase.set(base, [file]);
	}
	const found = new Set<string>();
	const recent = text.length > 40_000 ? text.slice(-40_000) : text;
	for (const match of recent.matchAll(PATHISH_RE)) {
		const token = match[0].replace(/^\.\//, "").replace(/^\/+/, "");
		if (fileSet.has(token)) {
			found.add(token);
			continue;
		}
		const suffix = files.find((file) => file.endsWith(`/${token}`));
		if (suffix) {
			found.add(suffix);
			continue;
		}
		const base = token.slice(token.lastIndexOf("/") + 1);
		const candidates = byBase.get(base);
		if (candidates && candidates.length <= 2) for (const file of candidates) found.add(file);
	}
	const idents = new Set<string>();
	for (const match of recent.matchAll(IDENT_RE)) if (definedNames.has(match[0])) idents.add(match[0]);
	return { files: found, idents };
}

export class RepoMap {
	readonly cwd: string;
	private readonly cacheDir: string | undefined;
	private tags = new Map<string, FileTags>();
	private states = new Map<string, FileState>();
	private head = "";
	private loadedDiskCache = false;
	private building: Promise<{ reparsed: number; fromDiskCache: boolean }> | undefined;

	constructor(options: { cwd: string; cacheDir?: string }) {
		this.cwd = options.cwd;
		this.cacheDir = options.cacheDir;
	}

	private cachePath(): string | undefined {
		if (!this.cacheDir) return undefined;
		let real = this.cwd;
		try {
			real = realpathSync(this.cwd);
		} catch {}
		return join(this.cacheDir, `${createHash("sha1").update(real).digest("hex").slice(0, 16)}.json`);
	}

	private cacheKey(head: string, states: Map<string, FileState>): string {
		const hash = createHash("sha1").update(head);
		for (const [file, state] of [...states].sort(([a], [b]) => a.localeCompare(b))) {
			hash.update(`\n${file}:${state.mtimeMs}:${state.size}`);
		}
		return hash.digest("hex");
	}

	private readDiskCache(): CacheFile | undefined {
		const path = this.cachePath();
		if (!path) return undefined;
		try {
			const parsed = JSON.parse(readFileSync(path, "utf8")) as CacheFile;
			return parsed.v === CACHE_VERSION && parsed.files ? parsed : undefined;
		} catch {
			return undefined;
		}
	}

	private writeDiskCache(key: string): void {
		const path = this.cachePath();
		if (!path) return;
		const files: CacheFile["files"] = {};
		for (const [file, state] of this.states) {
			const tags = this.tags.get(file);
			if (tags) files[file] = { m: state.mtimeMs, s: state.size, t: tags };
		}
		const body: CacheFile = { v: CACHE_VERSION, cwd: this.cwd, head: this.head, key, files };
		try {
			mkdirSync(this.cacheDir!, { recursive: true });
			const tmp = `${path}.${process.pid}.tmp`;
			writeFileSync(tmp, JSON.stringify(body));
			renameSync(tmp, path);
		} catch {
			// A read-only agent dir only costs a re-parse next session.
		}
	}

	/** Brings the index up to date: re-stats files, parses new or changed ones. */
	refresh(): Promise<{ reparsed: number; fromDiskCache: boolean }> {
		this.building ??= this.doRefresh().finally(() => {
			this.building = undefined;
		});
		return this.building;
	}

	private async doRefresh(): Promise<{ reparsed: number; fromDiskCache: boolean }> {
		const head = git(this.cwd, ["rev-parse", "HEAD"])?.trim() || "no-git";
		const states = new Map<string, FileState>();
		for (const file of listSourceFiles(this.cwd)) {
			try {
				const stat = statSync(join(this.cwd, file));
				if (!stat.isFile() || stat.size > MAX_FILE_BYTES) continue;
				states.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, language: languageForPath(file)! });
			} catch {}
		}
		const key = this.cacheKey(head, states);
		let fromDiskCache = false;
		if (!this.loadedDiskCache) {
			this.loadedDiskCache = true;
			const disk = this.readDiskCache();
			if (disk) {
				fromDiskCache = true;
				for (const [file, entry] of Object.entries(disk.files)) {
					const state = states.get(file);
					if (state && state.mtimeMs === entry.m && state.size === entry.s) {
						this.tags.set(file, entry.t);
						this.states.set(file, state);
					}
				}
				if (disk.key === key) {
					this.head = head;
					return { reparsed: 0, fromDiskCache };
				}
			}
		}
		let reparsed = 0;
		for (const [file, state] of states) {
			const known = this.states.get(file);
			if (known && known.mtimeMs === state.mtimeMs && known.size === state.size && this.tags.has(file)) continue;
			let source: string;
			try {
				source = readFileSync(join(this.cwd, file), "utf8");
			} catch {
				continue;
			}
			this.tags.set(file, await extractTags(state.language, source));
			this.states.set(file, state);
			reparsed++;
		}
		for (const file of [...this.tags.keys()]) {
			if (!states.has(file)) {
				this.tags.delete(file);
				this.states.delete(file);
			}
		}
		const changed = reparsed > 0 || head !== this.head || this.states.size !== states.size;
		this.head = head;
		if (changed || !fromDiskCache) this.writeDiskCache(key);
		return { reparsed, fromDiskCache };
	}

	private toRepoPath(path: string): string {
		const rel = isAbsolute(path) ? relative(this.cwd, path) : path;
		return rel.split(sep).join("/").replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "");
	}

	/** Ranks the index for a request (call refresh() first). */
	rank(request: RepoMapRequest = {}): { ranked: RankResult; focusFiles: Set<string>; focusIdents: Set<string> } {
		const files = [...this.tags.keys()];
		const defined = new Set<string>();
		for (const tags of this.tags.values()) for (const def of tags.defs) defined.add(def.name);
		const focusFiles = new Set<string>();
		const focusIdents = new Set<string>();
		const pinFiles = new Set<string>();
		for (const path of request.focusPaths ?? []) {
			const rel = this.toRepoPath(path);
			if (!rel) continue;
			for (const file of files) {
				if (file === rel || file.startsWith(`${rel}/`)) {
					focusFiles.add(file);
					pinFiles.add(file);
				}
			}
		}
		if (request.conversation) {
			const mentioned = mentionsIn(request.conversation, files, defined);
			for (const file of mentioned.files) focusFiles.add(file);
			for (const ident of mentioned.idents) focusIdents.add(ident);
		}
		if (request.query) {
			const words = request.query.match(/[A-Za-z_$][\w$]*/g) ?? [];
			const lowerNames = new Map<string, string[]>();
			for (const name of defined) {
				const lower = name.toLowerCase();
				const list = lowerNames.get(lower);
				if (list) list.push(name);
				else lowerNames.set(lower, [name]);
			}
			for (const word of words) {
				const lower = word.toLowerCase();
				for (const name of lowerNames.get(lower) ?? []) focusIdents.add(name);
				if (lower.length >= 4) {
					let added = 0;
					for (const [candidate, names] of lowerNames) {
						if (added >= 25) break;
						if (candidate !== lower && candidate.includes(lower)) {
							for (const name of names) focusIdents.add(name);
							added++;
						}
					}
				}
				// A word that names a file or directory focuses it too.
				for (const file of files) {
					if (lower.length >= 3 && file.toLowerCase().split(/[/.]/).includes(lower)) focusFiles.add(file);
				}
			}
		}
		return { ranked: rankRepo(this.tags, { focusFiles, focusIdents, pinFiles }), focusFiles, focusIdents };
	}

	/** Refreshes the index and renders the map. */
	async render(request: RepoMapRequest = {}): Promise<RepoMapResult> {
		const started = Date.now();
		const work = await this.refresh();
		const tokens = Math.max(64, Math.min(MAX_MAP_TOKENS, Math.round(request.tokens ?? DEFAULT_MAP_TOKENS)));
		const { ranked, focusFiles, focusIdents } = this.rank(request);
		const rendered = renderRepoMap(ranked, tokens, request.style ?? PLAIN_MAP_STYLE);
		const parsers = new Set([...this.tags.values()].map((tags) => tags.parser));
		return {
			...rendered,
			totalFiles: this.tags.size,
			parsedFiles: this.tags.size,
			parser: parsers.size === 0 ? "none" : parsers.size > 1 ? "mixed" : [...parsers][0]!,
			head: this.head,
			focusFiles: [...focusFiles].sort(),
			focusIdents: [...focusIdents].sort(),
			reparsed: work.reparsed,
			fromDiskCache: work.fromDiskCache,
			buildMs: Date.now() - started,
		};
	}
}

const instances = new Map<string, RepoMap>();

/** The process's repo map for a directory (one index per cwd, shared by the tool, /map and the first-turn map). */
export function getRepoMap(cwd: string, cacheDir?: string): RepoMap {
	const key = `${cwd}\u0000${cacheDir ?? ""}`;
	let map = instances.get(key);
	if (!map) {
		map = new RepoMap({ cwd, cacheDir });
		instances.set(key, map);
	}
	return map;
}

/** For tests: forget the in-memory indexes. */
export function resetRepoMaps(): void {
	instances.clear();
}

/** The text of a session's user messages and the paths its tool calls touched, for mention boosting. */
export function conversationText(
	entries: ReadonlyArray<{ type: string; message?: { role?: string; content?: unknown } }>,
): string {
	const parts: string[] = [];
	for (const entry of entries) {
		if (entry.type !== "message" || !entry.message) continue;
		const { role, content } = entry.message;
		if (role === "user") {
			if (typeof content === "string") parts.push(content);
			else if (Array.isArray(content))
				for (const part of content)
					if (part?.type === "text" && typeof part.text === "string") parts.push(part.text);
		} else if (role === "assistant" && Array.isArray(content)) {
			for (const part of content) {
				if (part?.type !== "toolCall" || !part.arguments || typeof part.arguments !== "object") continue;
				const args = part.arguments as Record<string, unknown>;
				for (const key of ["path", "file", "file_path", "pattern"]) {
					if (typeof args[key] === "string") parts.push(args[key] as string);
				}
			}
		}
	}
	return parts.join("\n");
}
