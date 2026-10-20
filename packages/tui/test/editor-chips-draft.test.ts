import assert from "node:assert";
import { describe, it } from "node:test";
import { Editor, type EditorChip } from "../src/components/editor.ts";
import type { TUI } from "../src/tui.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { defaultEditorTheme } from "./test-themes.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

function editor(): Editor {
	const tui: TUI = new TuiMainScreen(new VirtualTerminal(80, 24));
	return new Editor(tui, defaultEditorTheme);
}

const LEFT = "\x1b[D";
const ENTER = "\r";
const bigPaste = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join("\n");
const paste = (e: Editor, text: string) => e.handleInput(`\x1b[200~${text}\x1b[201~`);

describe("Editor paste chips", () => {
	it("Enter on a paste chip expands it inline instead of sending", () => {
		const e = editor();
		const submitted: string[] = [];
		e.onSubmit = (text) => submitted.push(text);
		for (const char of "log: ") e.handleInput(char);
		paste(e, bigPaste);
		assert.strictEqual(e.getText(), "log: [paste #1 +12 lines]");
		e.handleInput(LEFT);
		assert.deepStrictEqual(e.getChipAtCursor(), {
			kind: "paste",
			id: 1,
			marker: "[paste #1 +12 lines]",
			content: bigPaste,
		});
		e.handleInput(ENTER);
		assert.deepStrictEqual(submitted, []);
		assert.strictEqual(e.getText(), `log: ${bigPaste}`);
		assert.deepStrictEqual(e.getCursor(), { line: 11, col: 7 });
	});

	it("Enter after the chip still sends the expanded text", () => {
		const e = editor();
		const submitted: string[] = [];
		e.onSubmit = (text) => submitted.push(text);
		paste(e, bigPaste);
		assert.strictEqual(e.getChipAtCursor(), undefined);
		e.handleInput(ENTER);
		assert.deepStrictEqual(submitted, [bigPaste]);
	});

	it("Enter on a chip reached without arrows (Ctrl+A, undo) still sends", () => {
		const e = editor();
		const submitted: string[] = [];
		e.onSubmit = (text) => submitted.push(text);
		paste(e, bigPaste);
		e.handleInput("\x01"); // Ctrl+A puts the cursor on the chip without selecting it
		assert.strictEqual(e.getChipAtCursor()?.kind, "paste");
		assert.strictEqual(e.getSelectedChip(), undefined);
		e.handleInput(ENTER);
		assert.deepStrictEqual(submitted, [bigPaste]);
	});

	it("hands the chip to onOpenChip, and setPasteContent relabels it", () => {
		const e = editor();
		const opened: EditorChip[] = [];
		e.onOpenChip = (chip) => {
			opened.push(chip);
			return true;
		};
		paste(e, bigPaste);
		e.handleInput(" ");
		e.handleInput("x");
		e.handleInput(LEFT);
		e.handleInput(LEFT);
		e.handleInput(LEFT);
		e.handleInput(ENTER);
		assert.strictEqual(opened.length, 1);
		assert.ok(e.setPasteContent(1, "short now"));
		assert.strictEqual(e.getText(), "[paste #1 9 chars] x");
		assert.strictEqual(e.getExpandedText(), "short now x");
		(e as unknown as { undo(): void }).undo();
		assert.strictEqual(e.getText(), "[paste #1 +12 lines] x");
	});

	it("reports image chips under the cursor only when registered", () => {
		const e = editor();
		e.addImageMarker(2, "9 KB");
		e.handleInput(LEFT);
		e.handleInput(LEFT);
		assert.deepStrictEqual(e.getChipAtCursor(), { kind: "image", id: 2, marker: "[image 2 - 9 KB]" });
		e.setText("[image 7 - 1 KB]");
		e.handleInput("\x01");
		assert.strictEqual(e.getChipAtCursor(), undefined);
	});
});

describe("Editor drafts and history", () => {
	it("getDraft/setDraft round-trips text, cursor, pastes and image chips", () => {
		const e = editor();
		for (const char of "ask ") e.handleInput(char);
		paste(e, bigPaste);
		e.addImageMarker(1, "2 KB");
		const draft = e.getDraft();
		e.setText("");
		e.clearImageMarkers();
		e.setDraft(draft);
		assert.strictEqual(e.getText(), draft.text);
		assert.deepStrictEqual(e.getCursor(), { line: draft.cursorLine, col: draft.cursorCol });
		assert.strictEqual(e.getExpandedText(), `ask ${bigPaste} [image 1 - 2 KB] `);
		e.handleInput("\x01");
		for (let i = 0; i < 4; i++) e.handleInput("\x1b[C");
		assert.strictEqual(e.getChipAtCursor()?.kind, "paste");
	});

	it("setHistory seeds Up/Down, newest first, capped at 100", () => {
		const e = editor();
		e.setHistory(["newest", "newest", "older", ...Array.from({ length: 200 }, (_, i) => `p${i}`)]);
		assert.strictEqual(e.getHistory().length, 100);
		e.handleInput("\x1b[A");
		assert.strictEqual(e.getText(), "newest");
		e.handleInput("\x1b[A");
		assert.strictEqual(e.getText(), "older");
	});
});
