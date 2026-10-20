import assert from "node:assert";
import { describe, it } from "node:test";
import { ScrollView } from "../src/components/scroll-view.ts";
import { Text } from "../src/components/text.ts";
import { VStack } from "../src/components/v-stack.ts";
import { USER_PROMPT_ZONE_START } from "../src/semantic-zones.ts";
import type { Component } from "../src/tui.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

const ZONE = "\x1b]133;A\x07";
const END = "\x1b]133;B\x07\x1b]133;C\x07";

/** A transcript of messages: user prompts are marked as prompt zones, padded like the real user message. */
class Transcript implements Component {
	lines: string[] = [];
	user(text: string): void {
		this.lines.push(`${USER_PROMPT_ZONE_START}`, ` ${text}`, `${END}`);
	}
	assistant(count: number, label: string): void {
		for (let index = 0; index < count; index++) {
			this.lines.push(`${index === 0 ? ZONE : ""}${label} ${index + 1}${index === count - 1 ? END : ""}`);
		}
	}
	render(): string[] {
		return [...this.lines];
	}
	invalidate(): void {}
}

function setup(transcript: Transcript) {
	const terminal = new VirtualTerminal(40, 8);
	const tui = new TuiAltScreen(terminal, undefined, undefined, {
		scrollToEndIndicator: (count) => (count > 0 ? `[${count} new ↓]` : "[↓ latest]"),
		stickyPromptHeader: (prompt, width) => `» ${prompt}`.padEnd(width, "."),
	});
	const view = new ScrollView(transcript, { follow: "end", primary: true });
	tui.setLayoutRoot(
		new VStack([
			{ component: view, basis: 0, grow: 1, minSize: 1 },
			{ component: new Text("editor", 0, 0), basis: "auto", minSize: 1 },
		]),
	);
	return { terminal, tui, view };
}

describe("sticky prompt header", () => {
	it("pins the last prompt above the view while scrolled up and counts new messages below", async () => {
		const transcript = new Transcript();
		transcript.user("first question");
		transcript.assistant(6, "answer A");
		transcript.user("fix the parser please");
		transcript.assistant(12, "answer B");
		const { terminal, tui, view } = setup(transcript);
		tui.start();
		try {
			await terminal.waitForRender();
			// Following the end: no header, no jump button.
			assert.ok(!terminal.getViewport().some((line) => line.includes("»")));

			view.scrollTo(view.scrollTop - 4);
			tui.requestRender();
			await terminal.waitForRender();
			const viewport = terminal.getViewport();
			assert.strictEqual(viewport[0], "» fix the parser please".padEnd(40, "."));
			assert.match(viewport[6] ?? "", /\[↓ latest\]/);

			// Two new messages arrive below: the jump button counts them, the header stays.
			transcript.assistant(2, "tool");
			transcript.assistant(1, "answer C");
			tui.requestRender();
			await terminal.waitForRender();
			assert.match(terminal.getViewport()[6] ?? "", /\[2 new ↓\]/);
			assert.match(terminal.getViewport()[0] ?? "", /^» fix the parser please/);

			// Scrolled into the first exchange, the header names the first prompt.
			view.scrollTo(4);
			tui.requestRender();
			await terminal.waitForRender();
			assert.match(terminal.getViewport()[0] ?? "", /^» first question/);

			// A click on the header jumps to that prompt (the header goes: nothing above the view).
			terminal.sendInput("\x1b[<0;5;1M");
			terminal.sendInput("\x1b[<0;5;1m");
			await terminal.waitForRender();
			assert.strictEqual(view.scrollTop, 0);
			assert.strictEqual(terminal.getViewport()[1]?.trimEnd(), " first question");

			// Back at the end: header and count reset.
			tui.scrollToBottom();
			await terminal.waitForRender();
			assert.ok(!terminal.getViewport().some((line) => line.includes("»") || line.includes("new ↓")));
			view.scrollTo(view.scrollTop - 2);
			tui.requestRender();
			await terminal.waitForRender();
			assert.match(terminal.getViewport()[6] ?? "", /\[↓ latest\]/);
		} finally {
			tui.stop();
		}
	});

	it("shows no header when the prompt above is an assistant message only", async () => {
		const transcript = new Transcript();
		transcript.assistant(20, "log");
		const { terminal, tui, view } = setup(transcript);
		tui.start();
		try {
			await terminal.waitForRender();
			view.scrollTo(5);
			tui.requestRender();
			await terminal.waitForRender();
			assert.strictEqual(terminal.getViewport()[0]?.trimEnd(), "log 6");
		} finally {
			tui.stop();
		}
	});
});
