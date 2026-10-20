/**
 * The last main-turn request a session sent: its model, the exact transcript context and when it
 * went out. Compaction reuses it to summarize on the session's own warm prefix (same model, same
 * x-session-id, byte-identical system prompt, tools and messages), so RunInfra serves the summary
 * input from cache instead of re-billing the whole conversation at the full input price.
 */

import type { Api, Model, TranscriptContext } from "@runkiln/ai";

export interface LastTurnRequest {
	model: Model<Api>;
	context: TranscriptContext;
	sessionId?: string;
	/** Epoch ms the request was sent. */
	at: number;
}

const lastRequests = new WeakMap<object, LastTurnRequest>();

export function recordLastTurnRequest(owner: object, request: LastTurnRequest): void {
	lastRequests.set(owner, request);
}

export function getLastTurnRequest(owner: object): LastTurnRequest | undefined {
	return lastRequests.get(owner);
}

/** RunInfra's session affinity idle TTL when the catalog does not say. */
export const DEFAULT_SESSION_IDLE_TTL_MS = 900_000;

/** Idle time after which `model`'s warm prefix is gone: the catalog TTL, else RunInfra's 900 s. */
export function sessionIdleTtlMs(model: Pick<Model<Api>, "serviceLimits" | "promptCache">): number {
	return (
		model.serviceLimits?.sessionIdleTtlMs ??
		(model.promptCache?.short !== undefined ? model.promptCache.short * 1000 : DEFAULT_SESSION_IDLE_TTL_MS)
	);
}

/** Margin under the idle TTL: the summary call itself takes time to reach the server. */
const WARM_MARGIN_MS = 30_000;

/**
 * The recorded request when its prefix is still warm on RunInfra for `model`: the same model, sent
 * less than the idle TTL ago.
 */
export function warmTurnRequest(
	owner: object,
	model: Model<Api> | undefined,
	now = Date.now(),
): LastTurnRequest | undefined {
	const last = getLastTurnRequest(owner);
	if (!last || !model) return undefined;
	if (last.model.provider !== model.provider || last.model.id !== model.id) return undefined;
	if (now - last.at > sessionIdleTtlMs(model) - WARM_MARGIN_MS) return undefined;
	return last;
}
