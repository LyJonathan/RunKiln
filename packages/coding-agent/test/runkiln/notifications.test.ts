import { describe, expect, it } from "vitest";
import {
	detectNotifyProtocol,
	LONG_TURN_MS,
	type NotificationsMode,
	notificationSequence,
	sanitizeNotifyText,
	TurnNotifier,
	wrapForTmux,
} from "../../src/modes/interactive/notifications.ts";

describe("notification protocol per terminal", () => {
	it.each([
		[{ TERM_PROGRAM: "iTerm.app" }, "osc9"],
		[{ TERM_PROGRAM: "Apple_Terminal" }, "osc9"],
		[{ ConEmuPID: "12" }, "osc9"],
		[{ TERM_PROGRAM: "ghostty" }, "osc777"],
		[{ TERM: "xterm-ghostty" }, "osc777"],
		[{ TERM_PROGRAM: "WezTerm" }, "osc777"],
		[{ TERM: "xterm-kitty" }, "osc777"],
		[{ KITTY_WINDOW_ID: "1" }, "osc777"],
		[{ WT_SESSION: "abc" }, "osc777"],
		[{ VTE_VERSION: "7600" }, "osc777"],
		[{ TERM: "xterm-256color" }, "bell"],
		[{}, "bell"],
	] as const)("%o -> %s", (env, protocol) => {
		expect(detectNotifyProtocol(env as NodeJS.ProcessEnv)).toBe(protocol);
	});
});

describe("notification sequences", () => {
	it("builds OSC 9, OSC 777 and the bell, with safe payloads", () => {
		expect(notificationSequence("osc9", "RunKiln: done", "All tests pass")).toBe(
			"\x1b]9;RunKiln: done: All tests pass\x07",
		);
		expect(notificationSequence("osc777", "RunKiln: done", "a;b\x1b]evil\nline")).toBe(
			"\x1b]777;notify;RunKiln: done;a,b ]evil line\x07",
		);
		expect(notificationSequence("bell", "x", "y")).toBe("\x07");
		// Never readable as a ConEmu OSC 9;4 progress command: ";" never survives in the payload.
		expect(notificationSequence("osc9", "4;3", "x")).toBe("\x1b]9;4,3: x\x07");
	});

	it("wraps for tmux passthrough and rings the bell too", () => {
		expect(wrapForTmux("\x1b]9;hi\x07")).toBe("\x1bPtmux;\x1b\x1b]9;hi\x07\x1b\\");
		expect(notificationSequence("osc777", "t", "b", { tmux: true })).toBe(
			"\x1bPtmux;\x1b\x1b]777;notify;t;b\x07\x1b\\\x07",
		);
	});

	it("caps long text", () => {
		expect(sanitizeNotifyText("x".repeat(500)).length).toBe(120);
	});
});

describe("TurnNotifier", () => {
	function setup(options: { mode?: NotificationsMode; focused?: boolean; env?: NodeJS.ProcessEnv } = {}) {
		let now = 1_000_000;
		let focused = options.focused;
		const writes: string[] = [];
		const notifier = new TurnNotifier({
			mode: () => options.mode ?? "auto",
			write: (data) => writes.push(data),
			focused: () => focused,
			env: options.env ?? { TERM_PROGRAM: "ghostty" },
			now: () => now,
		});
		return {
			notifier,
			writes,
			advance: (ms: number) => {
				now += ms;
			},
			setFocused: (value: boolean | undefined) => {
				focused = value;
			},
		};
	}

	it("notifies at turn end only while the terminal is unfocused", () => {
		const t = setup({ focused: true });
		t.notifier.turnStarted();
		t.advance(60_000);
		expect(t.notifier.turnEnded("done")).toBe(false);
		t.setFocused(false);
		t.notifier.turnStarted();
		t.advance(1000);
		expect(t.notifier.turnEnded("Fixed the bug")).toBe(true);
		expect(t.writes).toEqual(["\x1b]777;notify;RunKiln: done;Fixed the bug\x07"]);
	});

	it("without focus reports, only long turns notify; aborted turns never do", () => {
		const t = setup({ env: {} });
		t.notifier.turnStarted();
		t.advance(LONG_TURN_MS - 1);
		expect(t.notifier.turnEnded("short")).toBe(false);
		t.notifier.turnStarted();
		t.advance(LONG_TURN_MS);
		expect(t.notifier.turnEnded("long")).toBe(true);
		expect(t.writes).toEqual(["\x07"]);
		t.notifier.turnStarted();
		t.advance(LONG_TURN_MS * 2);
		expect(t.notifier.turnEnded("stopped", true)).toBe(false);
	});

	it("notifies for a waiting approval, once per burst, and respects bell and off", () => {
		const t = setup({ focused: false });
		t.notifier.turnStarted();
		expect(t.notifier.waiting("approval", "Run npm test?")).toBe(true);
		expect(t.notifier.waiting("approval", "Edit a.ts?")).toBe(false);
		t.advance(2500);
		expect(t.notifier.waiting("plan", "A plan is waiting")).toBe(true);
		expect(t.writes[0]).toContain("approval needed;Run npm test?");
		expect(t.writes[1]).toContain("plan ready");

		const bell = setup({ focused: false, mode: "bell" });
		expect(bell.notifier.waiting("approval", "x")).toBe(true);
		expect(bell.writes).toEqual(["\x07"]);
		const off = setup({ focused: false, mode: "off" });
		expect(off.notifier.waiting("approval", "x")).toBe(false);
		expect(off.writes).toEqual([]);
	});
});
