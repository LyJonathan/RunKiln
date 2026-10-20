/**
 * Persistent prompt history: every prompt sent from the interactive editor is appended to
 * `~/.runkiln/agent/history.jsonl` as `{ts, cwd, sessionId, text}`. Startup seeds Up/Down with the last
 * 100 prompts for the current folder, and Ctrl+R searches it by session, project (folder) or all.
 *
 * The file is capped: once it passes {@link PROMPT_HISTORY_ROTATE_AT} lines (or
 * {@link PROMPT_HISTORY_MAX_BYTES}) it is rewritten to the newest {@link PROMPT_HISTORY_MAX_LINES}
 * through a temp file and a rename. Prompts that look like they carry a secret are never written.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { getAgentDir } from "../config.ts";

export const PROMPT_HISTORY_FILE = "history.jsonl";
export const PROMPT_HISTORY_MAX_LINES = 5000;
export const PROMPT_HISTORY_ROTATE_AT = 5500;
export const PROMPT_HISTORY_MAX_BYTES = 8 * 1024 * 1024;
/** Longer prompts (big pastes) are not saved: recalling half of one would be worse than none. */
export const PROMPT_HISTORY_MAX_TEXT = 10_000;

export interface PromptHistoryEntry {
	ts: number;
	cwd: string;
	sessionId?: string;
	text: string;
}

export type PromptHistoryScope = "session" | "project" | "all";

const SECRET_PATTERNS: RegExp[] = [
	/-----BEGIN [A-Z ]*PRIVATE KEY-----/,
	/\bsk-(?:ant-|proj-|or-|live-|test-)?[A-Za-z0-9_-]{20,}/,
	/\bgh[pousr]_[A-Za-z0-9]{30,}/,
	/\bgithub_pat_[A-Za-z0-9_]{30,}/,
	/\bglpat-[A-Za-z0-9_-]{20,}/,
	/\bxox[abposr]-[A-Za-z0-9-]{10,}/,
	/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
	/\bAIza[0-9A-Za-z_-]{35}\b/,
	/\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{20,}/,
	/\bnpm_[A-Za-z0-9]{36}\b/,
	/\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
	/\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s@/]{3,}@/i,
	/\b(?:api[_-]?key|secret|token|passw(?:or)?d|pwd|client[_-]?secret|access[_-]?key)\b["']?\s*[:=]\s*["']?(?=[^\s"']*\d)[^\s"']{8,}/i,
	/\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/,
];

/** Whether a prompt looks like it contains a credential (API key, token, password assignment, private key). */
export function looksLikeSecret(text: string): boolean {
	return SECRET_PATTERNS.some((pattern) => pattern.test(text));
}

function parseLine(line: string): PromptHistoryEntry | undefined {
	if (!line.trim()) return undefined;
	try {
		const value = JSON.parse(line) as Partial<PromptHistoryEntry>;
		if (typeof value.text !== "string" || typeof value.cwd !== "string" || typeof value.ts !== "number") {
			return undefined;
		}
		return {
			ts: value.ts,
			cwd: value.cwd,
			text: value.text,
			...(typeof value.sessionId === "string" ? { sessionId: value.sessionId } : {}),
		};
	} catch {
		return undefined;
	}
}

export interface PromptHistoryStoreOptions {
	path?: string;
	maxLines?: number;
	rotateAt?: number;
	maxBytes?: number;
	now?: () => number;
}

export class PromptHistoryStore {
	readonly path: string;
	private readonly maxLines: number;
	private readonly rotateAt: number;
	private readonly maxBytes: number;
	private readonly now: () => number;
	private cache: PromptHistoryEntry[] | undefined;
	private lineCount = 0;

	constructor(options: PromptHistoryStoreOptions = {}) {
		this.path = options.path ?? join(getAgentDir(), PROMPT_HISTORY_FILE);
		this.maxLines = options.maxLines ?? PROMPT_HISTORY_MAX_LINES;
		this.rotateAt = Math.max(this.maxLines, options.rotateAt ?? PROMPT_HISTORY_ROTATE_AT);
		this.maxBytes = options.maxBytes ?? PROMPT_HISTORY_MAX_BYTES;
		this.now = options.now ?? Date.now;
	}

	/** All entries, oldest first. Read once, then kept in memory and appended to. */
	load(): PromptHistoryEntry[] {
		if (this.cache) return this.cache;
		const entries: PromptHistoryEntry[] = [];
		let lines = 0;
		try {
			if (existsSync(this.path)) {
				for (const line of readFileSync(this.path, "utf-8").split("\n")) {
					if (!line.trim()) continue;
					lines++;
					const entry = parseLine(line);
					if (entry) entries.push(entry);
				}
			}
		} catch {
			// Unreadable history is treated as empty; the next append starts it again.
		}
		this.cache = entries;
		this.lineCount = lines;
		if (lines > this.rotateAt) this.rotate();
		return this.cache;
	}

	/**
	 * Save a prompt. Returns false when it was skipped: empty, too long, or looking like a secret.
	 * A write failure is swallowed (history is best effort) but the entry stays in memory.
	 */
	append(text: string, cwd: string, sessionId?: string): boolean {
		const trimmed = text.trim();
		if (!trimmed || trimmed.length > PROMPT_HISTORY_MAX_TEXT || looksLikeSecret(trimmed)) return false;
		const entries = this.load();
		const entry: PromptHistoryEntry = {
			ts: this.now(),
			cwd: resolve(cwd),
			...(sessionId ? { sessionId } : {}),
			text: trimmed,
		};
		entries.push(entry);
		this.lineCount++;
		try {
			mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
			appendFileSync(this.path, `${JSON.stringify(entry)}\n`, { encoding: "utf-8", mode: 0o600 });
			if (this.lineCount > this.rotateAt || statSync(this.path).size > this.maxBytes) this.rotate();
		} catch {
			// Best effort.
		}
		return true;
	}

	/** Rewrite the file to the newest maxLines entries (fewer when it is over the byte cap). */
	private rotate(): void {
		const entries = this.cache ?? [];
		let kept = entries.slice(-this.maxLines);
		let body = kept.map((entry) => JSON.stringify(entry)).join("\n");
		while (kept.length > 1 && Buffer.byteLength(body) > this.maxBytes * 0.75) {
			kept = kept.slice(Math.ceil(kept.length / 4));
			body = kept.map((entry) => JSON.stringify(entry)).join("\n");
		}
		try {
			const tmp = `${this.path}.${process.pid}.tmp`;
			writeFileSync(tmp, body ? `${body}\n` : "", { encoding: "utf-8", mode: 0o600 });
			renameSync(tmp, this.path);
			this.cache = kept;
			this.lineCount = kept.length;
		} catch {
			// Keep appending; the next start tries again.
		}
	}

	/**
	 * Entries for a scope, newest first, without repeated texts (the newest copy wins). "project" is
	 * the folder the prompt was sent from.
	 */
	query(
		scope: PromptHistoryScope,
		context: { cwd: string; sessionId?: string },
		limit?: number,
	): PromptHistoryEntry[] {
		const cwd = resolve(context.cwd);
		const seen = new Set<string>();
		const result: PromptHistoryEntry[] = [];
		const entries = this.load();
		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i]!;
			if (scope === "project" && entry.cwd !== cwd) continue;
			if (scope === "session" && (!context.sessionId || entry.sessionId !== context.sessionId)) continue;
			if (seen.has(entry.text)) continue;
			seen.add(entry.text);
			result.push(entry);
			if (limit !== undefined && result.length >= limit) break;
		}
		return result;
	}

	/** The last `limit` prompts sent from `cwd`, newest first: what Up/Down starts with. */
	recentForCwd(cwd: string, limit = 100): string[] {
		return this.query("project", { cwd }, limit).map((entry) => entry.text);
	}
}

/** "now", "5m", "3h", "2d", "6w": how long ago a prompt was sent. */
export function formatAge(ts: number, now: number = Date.now()): string {
	const seconds = Math.max(0, Math.floor((now - ts) / 1000));
	if (seconds < 60) return "now";
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 48) return `${hours}h`;
	const days = Math.floor(hours / 24);
	if (days < 14) return `${days}d`;
	return `${Math.floor(days / 7)}w`;
}
