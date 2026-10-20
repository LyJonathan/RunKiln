import assert from "node:assert";
import { describe, it } from "node:test";
import { Editor, imageMarkerIds } from "../src/components/editor.ts";
import type { TUI } from "../src/tui.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { defaultEditorTheme } from "./test-themes.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

function editor(): Editor {
	const tui: TUI = new TuiMainScreen(new VirtualTerminal(80, 24));
	return new Editor(tui, defaultEditorTheme);
}

const BACKSPACE = "\x7f";
const LEFT = "\x1b[D";

describe("Editor image chips", () => {
	it("inserts a chip with spacing and lists its id", () => {
		const e = editor();
		for (const char of "look") e.handleInput(char);
		const marker = e.addImageMarker(1, "240 KB");
		assert.strictEqual(marker, "[image 1 - 240 KB]");
		assert.strictEqual(e.getText(), "look [image 1 - 240 KB] ");
		assert.deepStrictEqual(imageMarkerIds(e.getText()), [1]);
	});

	it("backspace removes the whole chip, so the image is dropped", () => {
		const e = editor();
		e.addImageMarker(1, "240 KB");
		e.addImageMarker(2, "1.2 MB");
		assert.strictEqual(e.getText(), "[image 1 - 240 KB] [image 2 - 1.2 MB] ");
		e.handleInput(BACKSPACE); // the trailing space
		e.handleInput(BACKSPACE); // chip 2 in one keystroke
		assert.strictEqual(e.getText(), "[image 1 - 240 KB] ");
		assert.deepStrictEqual(imageMarkerIds(e.getText()), [1]);
	});

	it("the cursor steps over a chip as one unit", () => {
		const e = editor();
		e.addImageMarker(3, "9 KB");
		e.handleInput(LEFT); // before the trailing space
		e.handleInput(LEFT); // before the chip
		assert.deepStrictEqual(e.getCursor(), { line: 0, col: 0 });
	});

	it("text that only looks like a chip is ordinary text", () => {
		const e = editor();
		e.setText("[image 7 - 1 KB]");
		e.handleInput(BACKSPACE);
		assert.strictEqual(e.getText(), "[image 7 - 1 KB");
	});

	it("a bracketed paste the host takes (a dropped image path) inserts nothing", () => {
		const e = editor();
		const seen: string[] = [];
		e.onPasteText = (text) => {
			seen.push(text);
			return text.endsWith(".png");
		};
		e.handleInput("\x1b[200~/tmp/shot.png\x1b[201~");
		assert.strictEqual(e.getText(), "");
		e.handleInput("\x1b[200~hello\x1b[201~");
		assert.strictEqual(e.getText(), "hello");
		assert.deepStrictEqual(seen, ["/tmp/shot.png", "hello"]);
	});

	it("submit keeps the chips in the text and clearImageMarkers forgets them", () => {
		const e = editor();
		let submitted = "";
		e.onSubmit = (text) => {
			submitted = text;
		};
		for (const char of "what is") e.handleInput(char);
		e.addImageMarker(1, "2 KB");
		e.handleInput("\r");
		assert.strictEqual(submitted, "what is [image 1 - 2 KB]");
		e.clearImageMarkers();
		e.setText("[image 1 - 2 KB]");
		e.handleInput(BACKSPACE);
		assert.strictEqual(e.getText(), "[image 1 - 2 KB");
	});
});
