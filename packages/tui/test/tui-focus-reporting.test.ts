import assert from "node:assert";
import { describe, it } from "node:test";
import type { Component } from "../src/tui.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

class InputRecorder implements Component {
	readonly inputs: string[] = [];
	render(): string[] {
		return [""];
	}
	handleInput(data: string): void {
		this.inputs.push(data);
	}
	invalidate(): void {}
}

class RecordingTerminal extends VirtualTerminal {
	readonly writes: string[] = [];
	override write(data: string): void {
		this.writes.push(data);
		super.write(data);
	}
}

describe("terminal focus reporting", () => {
	it("enables CSI ?1004h on start, tracks focus, and keeps the reports away from components", () => {
		const terminal = new RecordingTerminal(80, 24);
		const tui = new TuiMainScreen(terminal);
		const recorder = new InputRecorder();
		const changes: boolean[] = [];
		tui.onTerminalFocusChange((focused) => changes.push(focused));
		tui.setFocusReporting(true);
		tui.setFocus(recorder);
		tui.start();
		assert.ok(terminal.writes.includes("\x1b[?1004h"));
		assert.strictEqual(tui.terminalFocused, undefined);

		terminal.sendInput("\x1b[O");
		assert.strictEqual(tui.terminalFocused, false);
		terminal.sendInput("\x1b[I");
		assert.strictEqual(tui.terminalFocused, true);
		terminal.sendInput("x");
		assert.deepStrictEqual(recorder.inputs, ["x"]);
		assert.deepStrictEqual(changes, [false, true]);

		tui.stop();
		assert.ok(terminal.writes.includes("\x1b[?1004l"));
	});

	it("stays off and unknown unless asked", () => {
		const terminal = new RecordingTerminal(80, 24);
		const tui = new TuiMainScreen(terminal);
		tui.start();
		assert.ok(!terminal.writes.includes("\x1b[?1004h"));
		assert.strictEqual(tui.terminalFocused, undefined);
		tui.stop();
	});
});
