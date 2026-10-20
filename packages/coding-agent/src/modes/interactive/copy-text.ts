/**
 * Clean copy: the code blocks of a message and the `/copy` sub-commands.
 *
 * `/copy`         last agent message (Markdown source)
 * `/copy md`      same, explicitly as Markdown
 * `/copy code`    the last code block of the last agent message
 * `/copy code 2`  its second code block (1-based; negative counts from the end)
 *
 * TODO(R5 selection): selection copy in fullscreen still copies screen rows. The plan is per-line metadata from
 * components (soft-wrap continuation, indent to drop) consulted by TuiAltScreen.getActiveSelectionText so wrapped
 * rows rejoin and gutters/padding are stripped. Not done in this change.
 */

import { Marked, type Token } from "@runkiln/tui";

export interface CodeBlock {
	lang?: string;
	code: string;
}

const lexer = new Marked();

/** Fenced and indented code blocks in document order, including those nested in lists and quotes. */
export function extractCodeBlocks(markdown: string): CodeBlock[] {
	const blocks: CodeBlock[] = [];
	const walk = (tokens: readonly Token[] | undefined) => {
		for (const token of tokens ?? []) {
			if (token.type === "code") {
				const code = token as Token & { text: string; lang?: string };
				blocks.push({ code: code.text, ...(code.lang ? { lang: code.lang } : {}) });
				continue;
			}
			const nested = token as Token & { tokens?: Token[]; items?: Array<{ tokens?: Token[] }> };
			walk(nested.tokens);
			for (const item of nested.items ?? []) walk(item.tokens);
		}
	};
	walk(lexer.lexer(markdown));
	return blocks;
}

export type CopyCommand =
	| { kind: "message" }
	| { kind: "md" }
	| { kind: "code"; index?: number }
	| { kind: "error"; message: string };

export const COPY_USAGE = "Usage: /copy [md | code [n]]";

export function parseCopyCommand(text: string): CopyCommand {
	const args = text.trim().split(/\s+/).slice(1);
	if (args.length === 0) return { kind: "message" };
	const [sub, arg, ...rest] = args;
	if ((sub === "md" || sub === "markdown") && arg === undefined) return { kind: "md" };
	if (sub === "code" && rest.length === 0) {
		if (arg === undefined) return { kind: "code" };
		const index = Number(arg);
		if (Number.isInteger(index) && index !== 0) return { kind: "code", index };
		return { kind: "error", message: `Code block number must be a non-zero integer. ${COPY_USAGE}` };
	}
	return { kind: "error", message: COPY_USAGE };
}

/** The block a `/copy code [n]` refers to: 1-based, negative from the end, default the last one. */
export function selectCodeBlock(
	blocks: readonly CodeBlock[],
	index: number | undefined,
): { block: CodeBlock; position: number } | { error: string } {
	if (blocks.length === 0) return { error: "The last agent message has no code blocks." };
	const position = index === undefined ? blocks.length : index < 0 ? blocks.length + 1 + index : index;
	if (position < 1 || position > blocks.length) {
		return {
			error: `No code block ${index}: the last agent message has ${blocks.length} code block${blocks.length === 1 ? "" : "s"}.`,
		};
	}
	return { block: blocks[position - 1], position };
}

export function lineCountLabel(text: string): string {
	const lines = text.replace(/\n$/, "").split("\n").length;
	return `${lines} line${lines === 1 ? "" : "s"}`;
}

/** OSC 52 sequence that asks the terminal to set the clipboard; undefined when the text is too large. */
export function osc52Sequence(text: string, maxEncodedLength = 100_000): string | undefined {
	const encoded = Buffer.from(text).toString("base64");
	if (encoded.length > maxEncodedLength) return undefined;
	return `\x1b]52;c;${encoded}\x07`;
}
