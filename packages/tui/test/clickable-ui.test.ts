import assert from "node:assert";
import { describe, it } from "node:test";
import { ClickableRows, HitMap } from "../src/clickable-rows.ts";
import { MouseRegion } from "../src/components/mouse-region.ts";
import { Text } from "../src/components/text.ts";
import type { Component, TuiMouseEvent } from "../src/tui.ts";
import { pointerShapeSequence, resolveMouseMode, TuiAltScreen, tokenAtColumn } from "../src/tui-alt-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

function mouse(type: TuiMouseEvent["type"], x: number, y: number, extra: Partial<TuiMouseEvent> = {}): TuiMouseEvent {
	return {
		type,
		button: type === "move" || type === "leave" || type === "wheel" ? "none" : "left",
		x,
		y,
		screenX: x,
		screenY: y,
		width: 40,
		height: 10,
		shift: false,
		alt: false,
		ctrl: false,
		...extra,
	};
}

class RecordingTerminal extends VirtualTerminal {
	readonly writes: string[] = [];
	override write(data: string): void {
		this.writes.push(data);
		super.write(data);
	}
}

describe("HitMap", () => {
	it("maps rows and column ranges, later regions winning", () => {
		const hits = new HitMap<string>();
		hits.add(0, "row");
		hits.add(2, "left", 0, 5);
		hits.add(2, "right", 5, 10);
		hits.add(2, "middle", 4, 6);
		assert.strictEqual(hits.at(30, 0), "row");
		assert.strictEqual(hits.at(1, 2), "left");
		assert.strictEqual(hits.at(4, 2), "middle");
		assert.strictEqual(hits.at(5, 2), "middle");
		assert.strictEqual(hits.at(6, 2), "right");
		assert.strictEqual(hits.at(10, 2), undefined);
		assert.strictEqual(hits.at(0, 1), undefined);
	});

	it("ignores empty ranges, shifts with offset and resets", () => {
		const hits = new HitMap<number>();
		hits.add(0, 1, 3, 3);
		assert.strictEqual(hits.size, 0);
		hits.add(0, 7);
		hits.offset(4);
		assert.strictEqual(hits.at(0, 0), undefined);
		assert.strictEqual(hits.at(0, 4), 7);
		hits.reset();
		assert.strictEqual(hits.at(0, 4), undefined);
	});
});

describe("ClickableRows", () => {
	it("hovers without selecting and clears on leave", () => {
		let hoverChanges = 0;
		const rows = new ClickableRows<number>(() => hoverChanges++);
		const selected: number[] = [];
		const actions = { activate: () => {}, select: (index: number) => selected.push(index) };
		const first = rows.handle(2, mouse("move", 0, 2), actions);
		assert.deepStrictEqual(first, { handled: true, render: true, pointer: "pointer" });
		assert.ok(rows.isHovered(2));
		assert.deepStrictEqual(rows.handle(2, mouse("move", 1, 2), actions), {
			handled: true,
			render: false,
			pointer: "pointer",
		});
		// Moving off every value still answers once, so the old hover clears.
		assert.deepStrictEqual(rows.handle(undefined, mouse("move", 0, 9), actions), { handled: true, render: true });
		assert.strictEqual(rows.handle(undefined, mouse("move", 0, 9), actions), undefined);
		rows.handle(1, mouse("move", 0, 1), actions);
		// A per-row region only clears its own hover.
		assert.strictEqual(rows.handle(3, mouse("leave", 0, 0), actions), undefined);
		assert.ok(rows.isHovered(1));
		assert.deepStrictEqual(rows.handle(1, mouse("leave", 0, 0), actions), { handled: true, render: true });
		assert.ok(!rows.isHovered(1));
		assert.deepStrictEqual(selected, []);
		assert.strictEqual(hoverChanges, 4);
	});

	it("selects on press and activates when the release lands on the same value", () => {
		const rows = new ClickableRows<number>();
		const activated: number[] = [];
		const selected: number[] = [];
		const actions = {
			activate: (index: number) => activated.push(index),
			select: (index: number) => selected.push(index),
		};
		rows.handle(1, mouse("press", 0, 1), actions);
		rows.handle(1, mouse("click", 0, 1), actions);
		rows.handle(2, mouse("press", 0, 2), actions);
		rows.handle(3, mouse("click", 0, 3), actions);
		assert.deepStrictEqual(selected, [1, 2]);
		assert.deepStrictEqual(activated, [1]);
		// A click with no press first (synthesized by the renderer) still activates.
		rows.handle(4, mouse("click", 0, 4), actions);
		assert.deepStrictEqual(activated, [1, 4]);
	});

	it("routes right clicks to context only when it is given, and wheel steps", () => {
		const rows = new ClickableRows<string>();
		const context: string[] = [];
		const wheel: number[] = [];
		assert.strictEqual(
			rows.handle("a", mouse("press", 0, 0, { button: "right" }), { activate: () => {} }),
			undefined,
		);
		const actions = {
			activate: () => {},
			context: (value: string) => context.push(value),
			wheel: (delta: number) => wheel.push(delta),
		};
		assert.deepStrictEqual(rows.handle("a", mouse("press", 0, 0, { button: "right" }), actions), { handled: true });
		rows.handle("a", mouse("click", 0, 0, { button: "right" }), actions);
		rows.handle(undefined, mouse("wheel", 0, 0, { wheelDelta: -3 }), actions);
		rows.handle(undefined, mouse("wheel", 0, 0, { wheelDelta: 2 }), actions);
		assert.deepStrictEqual(context, ["a"]);
		assert.deepStrictEqual(wheel, [-1, 1]);
	});
});

describe("tokenAtColumn", () => {
	it("finds the path under the pointer with its line suffix", () => {
		const text = "See src/foo.ts:42:3. Then run it.";
		assert.strictEqual(tokenAtColumn(text, 6), "src/foo.ts:42:3");
		assert.strictEqual(tokenAtColumn(text, 4), "src/foo.ts:42:3");
		assert.strictEqual(tokenAtColumn(text, 3), undefined);
		assert.strictEqual(tokenAtColumn("(packages/a b.ts)", 3), "packages/a");
		assert.strictEqual(tokenAtColumn("open C:\\Users\\John\\a.ts:7", 8), "C:\\Users\\John\\a.ts:7");
		assert.strictEqual(tokenAtColumn("x", 5), undefined);
	});
});

describe("mouse options", () => {
	it("resolves the mouse mode from booleans and names", () => {
		assert.strictEqual(resolveMouseMode(undefined), "on");
		assert.strictEqual(resolveMouseMode(true), "on");
		assert.strictEqual(resolveMouseMode(false), "off");
		assert.strictEqual(resolveMouseMode("wheel"), "wheel");
	});

	it("enables only button reports in wheel mode and ignores clicks", async () => {
		const terminal = new RecordingTerminal(20, 3);
		const tui = new TuiAltScreen(terminal, false, undefined, { mouse: "wheel" });
		const events: string[] = [];
		tui.addChild(new MouseRegion(new Text("row", 0, 0), (event) => (events.push(event.type), { handled: true })));
		tui.start();
		await terminal.waitForRender();
		const start = terminal.writes.join("");
		assert.ok(start.includes("\x1b[?1000h\x1b[?1004h\x1b[?1006h"));
		assert.ok(!start.includes("\x1b[?1003h"));
		terminal.sendInput("\x1b[<0;1;1M");
		terminal.sendInput("\x1b[<0;1;1m");
		terminal.sendInput("\x1b[<64;1;1M");
		await terminal.waitForRender();
		assert.deepStrictEqual(events, ["wheel"]);
		tui.stop();
	});

	it("does not enable mouse reporting when off", async () => {
		const terminal = new RecordingTerminal(20, 3);
		const tui = new TuiAltScreen(terminal, false, undefined, { mouse: "off" });
		tui.addChild(new Text("row", 0, 0));
		tui.start();
		await terminal.waitForRender();
		assert.ok(!terminal.writes.join("").includes("\x1b[?1000h"));
		tui.stop();
	});
});

describe("hover tracking", () => {
	it("sends leave to the previous hover target and sets pointer shapes", async () => {
		const terminal = new RecordingTerminal(20, 3);
		const tui = new TuiAltScreen(terminal, false, undefined, { pointerShapes: true });
		const log: string[] = [];
		const region = (name: string): Component =>
			new MouseRegion(new Text(name, 0, 0), (event) => {
				if (event.type === "move") {
					log.push(`move ${name}`);
					return { handled: true, pointer: "pointer" };
				}
				if (event.type === "leave") log.push(`leave ${name}`);
				return undefined;
			});
		tui.addChild(region("a"));
		tui.addChild(region("b"));
		tui.addChild(new Text("plain", 0, 0));
		tui.start();
		await terminal.waitForRender();
		terminal.writes.length = 0;
		terminal.sendInput("\x1b[<35;1;1M");
		terminal.sendInput("\x1b[<35;1;2M");
		terminal.sendInput("\x1b[<35;1;3M");
		await terminal.waitForRender();
		// The new target gets its move first; the old one then hears it left.
		assert.deepStrictEqual(log, ["move a", "move b", "leave a", "leave b"]);
		const written = terminal.writes.join("");
		assert.strictEqual(written.split(pointerShapeSequence("pointer")).length - 1, 1);
		assert.ok(written.includes(pointerShapeSequence("default")));
		tui.stop();
	});

	it("does not send pointer shapes unless enabled", async () => {
		const terminal = new RecordingTerminal(20, 2);
		const tui = new TuiAltScreen(terminal);
		tui.addChild(new MouseRegion(new Text("a", 0, 0), () => ({ handled: true, pointer: "pointer" })));
		tui.start();
		await terminal.waitForRender();
		terminal.sendInput("\x1b[<35;1;1M");
		await terminal.waitForRender();
		assert.ok(!terminal.writes.join("").includes("\x1b]22;"));
		tui.stop();
	});
});

describe("clicks on text and overlays", () => {
	it("passes the token under a Ctrl+click to openTextAt", async () => {
		const terminal = new VirtualTerminal(40, 2);
		const tokens: string[] = [];
		const tui = new TuiAltScreen(terminal, false, undefined, {
			openTextAt: (token, modifiers) => {
				tokens.push(`${token} ${modifiers.ctrl}`);
				return true;
			},
		});
		tui.addChild(new Text("edit src/app.ts:12 now", 0, 0));
		tui.start();
		await terminal.waitForRender();
		// Plain click: no lookup. Ctrl (bit 16) click on column 8.
		terminal.sendInput("\x1b[<0;20;1M");
		terminal.sendInput("\x1b[<0;20;1m");
		terminal.sendInput("\x1b[<16;8;1M");
		terminal.sendInput("\x1b[<16;8;1m");
		await terminal.waitForRender();
		assert.deepStrictEqual(tokens, ["src/app.ts:12 true"]);
		tui.stop();
	});

	it("calls onOutsidePress for a press outside an overlay", async () => {
		const terminal = new VirtualTerminal(30, 6);
		const tui = new TuiAltScreen(terminal);
		tui.addChild(new Text("base", 0, 0));
		let outside = 0;
		tui.showOverlay(new Text("menu", 0, 0), { row: 2, col: 2, width: 8, onOutsidePress: () => outside++ });
		tui.start();
		await terminal.waitForRender();
		terminal.sendInput("\x1b[<0;4;3M");
		terminal.sendInput("\x1b[<0;4;3m");
		assert.strictEqual(outside, 0);
		terminal.sendInput("\x1b[<0;20;6M");
		terminal.sendInput("\x1b[<0;20;6m");
		assert.strictEqual(outside, 1);
		tui.stop();
	});

	it("rewrites every row in full repaint mode", async () => {
		const terminal = new RecordingTerminal(20, 3);
		const tui = new TuiAltScreen(terminal, false, undefined, { fullRepaint: true });
		const text = new Text("same", 0, 0);
		tui.addChild(text);
		tui.addChild(new Text("other", 0, 0));
		tui.start();
		await terminal.waitForRender();
		terminal.writes.length = 0;
		tui.requestRender();
		await terminal.waitForRender();
		const frame = terminal.writes.join("");
		assert.ok(frame.includes("same"));
		assert.ok(frame.includes("other"));
		assert.ok(!frame.includes("\x1b[2J"));
		tui.stop();
	});
});
