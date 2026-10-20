/**
 * Background session titles. The call uses the chore model (DeepSeek, thinking off, by default; see
 * chore-model.ts) and its own session id, so it never joins the main session's cache route.
 * `x-parent-session-id` is the session being named.
 */

import type { Message } from "@runkiln/ai";
import { backgroundSessionId } from "./session-headers.ts";

export const TITLE_INSTRUCTION =
	"Name this coding session in 3 to 6 words. Reply with the title only, no punctuation and no quotes.";

const MAX_EXCERPT = 500;
const MAX_TITLE = 80;

export function titleUserMessage(userText: string): Message {
	const excerpt = userText.replace(/\s+/g, " ").trim().slice(0, MAX_EXCERPT);
	return {
		role: "user",
		content: [{ type: "text", text: `${TITLE_INSTRUCTION}\n\n${excerpt}` }],
		timestamp: 0,
	};
}

/** First non-empty line, quotes stripped, capped so a rambling reply cannot become the name. */
export function parseSessionTitle(text: string): string | undefined {
	const line = text
		.split(/\r?\n/)
		.map((part) => part.trim())
		.find((part) => part.length > 0);
	if (!line) return undefined;
	const cleaned = line
		.replace(/^["'`]+|["'`]+$/g, "")
		.replace(/[.]+$/g, "")
		.trim();
	if (!cleaned) return undefined;
	return cleaned.length > MAX_TITLE ? cleaned.slice(0, MAX_TITLE).trim() : cleaned;
}

export function titleCallRouting(sessionId: string): { sessionId: string; parentSessionId: string } {
	return {
		sessionId: backgroundSessionId(sessionId, "title"),
		parentSessionId: sessionId,
	};
}
