/**
 * Headers RunInfra uses to keep a session on one warm cache.
 * One stable `x-session-id` per session. `x-parent-session-id` marks a subagent or a
 * background call (a session title) that must not share that cache route.
 */

export const SESSION_ID_HEADER = "x-session-id";
export const PARENT_SESSION_ID_HEADER = "x-parent-session-id";

export function runInfraSessionHeaders(sessionId?: string, parentSessionId?: string): Record<string, string> {
	const headers: Record<string, string> = {};
	const session = sessionId?.trim();
	const parent = parentSessionId?.trim();
	if (session) headers[SESSION_ID_HEADER] = session;
	if (parent) headers[PARENT_SESSION_ID_HEADER] = parent;
	return headers;
}
