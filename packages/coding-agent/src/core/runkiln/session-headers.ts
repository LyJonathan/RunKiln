/**
 * Session ids sent to RunInfra.
 *
 * Every request of a session carries `x-session-id: <session id>` (one stable id per session, so
 * RunInfra keeps routing it to the same warm cache). A session started as a subagent also carries
 * `x-parent-session-id: <parent session id>`. A RunKiln process is a subagent when
 * RUNKILN_PARENT_SESSION_ID is set, or when it runs inside a parent RunKiln session's shell
 * command, which exports RUNKILN_SESSION_ID.
 */

export const PARENT_SESSION_ID_ENV = "RUNKILN_PARENT_SESSION_ID";
/** Exported by the shell tools to the commands they run. */
export const SESSION_ID_ENV = "RUNKILN_SESSION_ID";

export function resolveParentSessionId(env: NodeJS.ProcessEnv = process.env): string | undefined {
	return env[PARENT_SESSION_ID_ENV]?.trim() || env[SESSION_ID_ENV]?.trim() || undefined;
}

/**
 * Session id for a background call that belongs to a session but must not share its cache route
 * (session titles). The parent header ties it back to the session.
 */
export function backgroundSessionId(sessionId: string, purpose: string): string {
	return `${sessionId}.${purpose}`;
}
