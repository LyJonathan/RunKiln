/**
 * Idle compaction, as in Claude Code: when the session sat idle longer than the model's cache TTL (RunInfra's
 * session affinity idle TTL from the live catalog, 900 s by default; see last-request.ts), the next turn pays the
 * full uncached input price anyway. With a large context it is cheaper to compact first (on the chore model) and
 * send the next turn on the short summary. Setting: compaction.idleCompact (on) and compaction.idleMinTokens.
 */

/** The entry fields read to find the last time the cache was refreshed. */
interface ActivityEntry {
	type: string;
	timestamp?: string;
	kind?: string;
	message?: { role?: string; timestamp?: number; stopReason?: string };
}

/**
 * When the session's prompt prefix was last sent (and so refreshed in the cache): the newest assistant reply that
 * reached the provider, or a cache-warming request. Undefined for a session with neither.
 */
export function lastCacheActivityAt(entries: readonly ActivityEntry[]): number | undefined {
	let last: number | undefined;
	for (const entry of entries) {
		let at: number | undefined;
		if (entry.type === "message" && entry.message?.role === "assistant" && entry.message.stopReason !== "error") {
			at = entry.message.timestamp;
		} else if (entry.type === "usage" && entry.kind === "cache_warm" && entry.timestamp) {
			at = Date.parse(entry.timestamp);
		}
		if (typeof at === "number" && Number.isFinite(at) && (last === undefined || at > last)) last = at;
	}
	return last;
}

export interface IdleCompactionInput {
	enabled: boolean;
	now: number;
	lastActivityAt: number | undefined;
	ttlMs: number;
	contextTokens: number;
	minTokens: number;
}

export interface IdleCompactionDecision {
	due: boolean;
	idleMs: number;
}

/** Compact before the next turn when the cache has expired and the context is at least minTokens. */
export function idleCompactionDecision(input: IdleCompactionInput): IdleCompactionDecision {
	const idleMs = input.lastActivityAt === undefined ? 0 : Math.max(0, input.now - input.lastActivityAt);
	const due =
		input.enabled &&
		input.lastActivityAt !== undefined &&
		input.ttlMs > 0 &&
		idleMs > input.ttlMs &&
		input.contextTokens >= input.minTokens;
	return { due, idleMs };
}

function formatDuration(ms: number): string {
	const minutes = Math.round(ms / 60_000);
	if (minutes < 60) return `${Math.max(1, minutes)} min`;
	const hours = Math.floor(minutes / 60);
	if (hours < 48) return `${hours} h${minutes % 60 ? ` ${minutes % 60} min` : ""}`;
	return `${Math.floor(hours / 24)} days`;
}

/** The one-line notice shown before the compaction runs. */
export function idleCompactionNotice(idleMs: number, contextTokens: number, ttlMs: number): string {
	const tokens = contextTokens >= 1000 ? `${Math.round(contextTokens / 1000)}k` : String(contextTokens);
	return `Idle ${formatDuration(idleMs)}, past the ${formatDuration(ttlMs)} cache window: compacting ${tokens} tokens first, since this turn would be billed uncached anyway (compaction.idleCompact).`;
}
