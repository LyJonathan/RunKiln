/**
 * Classifier-free pre-pass for turns whose route is obvious from the text (router v2).
 *
 * - ack: thanks / ok / hi / lgtm / merci ... (a few words, nothing else) -> a trivial chat turn.
 *   "ok" or "sure" right after the assistant asked a question is an approval, not an ack.
 * - approval: yes / go ahead / do it / continue / sounds good ... -> a follow-up: the previous turn's
 *   classification is reused (the work being approved is the previous turn's).
 * - retry: a short "try again" / "still failing" -> a follow-up too; the router also counts it as a
 *   failure of the previous turn and steps up.
 *
 * Anything else, or a follow-up with no previous decision to inherit, goes to the classifier.
 */

const ACK_WORDS = new Set([
	"thanks",
	"thank",
	"you",
	"thx",
	"ty",
	"tks",
	"cheers",
	"ok",
	"okay",
	"k",
	"kk",
	"cool",
	"great",
	"nice",
	"perfect",
	"awesome",
	"excellent",
	"lgtm",
	"got",
	"it",
	"hi",
	"hello",
	"hey",
	"yo",
	"good",
	"morning",
	"afternoon",
	"evening",
	"night",
	"merci",
	"beaucoup",
	"parfait",
	"super",
	"génial",
	"genial",
	"top",
	"brb",
	"np",
	"wow",
	"neat",
	"much",
	"so",
	"a",
	"lot",
	"bonjour",
	"salut",
	"noted",
	"done",
]);

const APPROVAL_WORDS = new Set([
	"yes",
	"yeah",
	"yep",
	"yup",
	"y",
	"sure",
	"ok",
	"okay",
	"go",
	"ahead",
	"on",
	"do",
	"it",
	"that",
	"please",
	"pls",
	"proceed",
	"continue",
	"keep",
	"going",
	"sounds",
	"good",
	"ship",
	"lgtm",
	"finish",
	"alright",
	"right",
	"fine",
	"oui",
	"vas",
	"y",
	"vas-y",
	"go-ahead",
	"absolutely",
	"definitely",
	"let's",
	"lets",
	"then",
	"and",
	"both",
	"all",
	"of",
	"them",
	"the",
	"plan",
	"carry",
]);

const RETRY =
	/\b(try again|again please|retry|still (fails?|failing|broken|wrong|not working|the same)|same error|(does ?n[o']?t|did ?n[o']?t) work|not working|didn'?t fix|marche (toujours )?pas|réessaie)\b/i;

const MAX_ACK_WORDS = 6;
const MAX_APPROVAL_WORDS = 8;
const MAX_RETRY_WORDS = 8;

export type FastPathKind = "ack" | "approval" | "retry";

function words(text: string): string[] {
	return text
		.toLowerCase()
		.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, " ")
		.replace(/[!.,;:?'"()*_~`-]+/g, (match) => (match.includes("-") ? "-" : " "))
		.split(/\s+/)
		.map((word) => word.replace(/^-+|-+$/g, ""))
		.filter(Boolean);
}

/** The obvious route for this text, or undefined when the classifier should judge it. */
export function fastPath(text: string, assistantAsked: boolean): FastPathKind | undefined {
	const trimmed = text.trim();
	if (!trimmed || trimmed.length > 120 || trimmed.includes("\n") || trimmed.includes("`")) {
		return trimmed ? undefined : "ack";
	}
	const list = words(trimmed);
	if (list.length === 0) return "ack";
	if (list.length <= MAX_RETRY_WORDS && RETRY.test(trimmed)) return "retry";
	const approval = list.length <= MAX_APPROVAL_WORDS && list.every((word) => APPROVAL_WORDS.has(word));
	const ack = list.length <= MAX_ACK_WORDS && list.every((word) => ACK_WORDS.has(word));
	// "ok" / "sure" / "yes" after a question approve what was offered; otherwise they acknowledge.
	if (approval && (assistantAsked || !ack)) return "approval";
	if (ack) return "ack";
	return undefined;
}
