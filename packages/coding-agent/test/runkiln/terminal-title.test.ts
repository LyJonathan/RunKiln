import type { ProgramStatus, Terminal } from "@runkiln/tui";
import { describe, expect, it } from "vitest";
import { ProgramStatusReporter } from "../../src/modes/interactive/program-status-reporter.ts";
import { formatTerminalTitle, formatTitleStatus, TerminalTitle } from "../../src/modes/interactive/terminal-title.ts";

describe("terminal title status", () => {
	it("reads RunKiln - <project> - <state>", () => {
		expect(formatTerminalTitle("RunKiln", "api", { state: "working" })).toBe("RunKiln - api - ● working");
		expect(formatTerminalTitle("RunKiln", "api", { state: "done" })).toBe("RunKiln - api - ✓ done");
		expect(formatTerminalTitle("RunKiln", "api", { state: "blocked", kind: "permission", message: "x" })).toBe(
			"RunKiln - api - ⚠ needs approval",
		);
		expect(formatTitleStatus({ state: "blocked", kind: "question", message: "x" })).toBe("⚠ needs input");
		expect(formatTitleStatus({ state: "error", message: "boom" })).toBe("✗ error");
		expect(formatTerminalTitle("RunKiln", "api", { state: "idle" })).toBe("RunKiln - api");
		expect(formatTerminalTitle("RunKiln", "api", undefined)).toBe("RunKiln - api");
	});

	it("keeps control characters out of the title", () => {
		expect(formatTerminalTitle("RunKiln", "evil\x07\x1b]0;pwned\x07dir", { state: "done" })).toBe(
			"RunKiln - evil ]0;pwned dir - ✓ done",
		);
	});

	it("saves the previous title on the title stack, sets OSC 0 and restores on exit", () => {
		const writes: string[] = [];
		const title = new TerminalTitle({ write: (data) => writes.push(data), env: {} });
		title.restore(); // Nothing set yet: nothing to restore.
		expect(writes).toEqual([]);
		title.set("RunKiln - api");
		title.set("RunKiln - api"); // Unchanged: not re-sent.
		title.set("RunKiln - api - ● working");
		title.restore();
		title.restore();
		expect(writes).toEqual([
			"\x1b[22;0t",
			"\x1b]0;RunKiln - api\x07",
			"\x1b]0;RunKiln - api - ● working\x07",
			"\x1b]0;\x07\x1b[23;0t",
		]);
	});

	it("sets the tmux pane title with OSC 2 and writes the old pane title back", () => {
		const writes: string[] = [];
		let reads = 0;
		const title = new TerminalTitle({
			write: (data) => writes.push(data),
			env: { TMUX: "/tmp/tmux-1000/default,123,0" },
			readTmuxPaneTitle: () => {
				reads++;
				return "laptop";
			},
		});
		title.set("RunKiln - api - ✓ done");
		title.set("RunKiln - api - ● working");
		title.restore();
		expect(reads).toBe(1);
		expect(writes).toEqual([
			"\x1b]2;RunKiln - api - ✓ done\x07",
			"\x1b]2;RunKiln - api - ● working\x07",
			"\x1b]2;laptop\x07",
		]);
	});

	it("follows the program status reporter: working, needs approval, done", () => {
		const statuses: ProgramStatus[] = [];
		const terminal = { setProgramStatus: () => {} } as unknown as Terminal;
		const reporter = new ProgramStatusReporter(
			() => terminal,
			() => undefined,
			(status) => statuses.push(status),
		);
		reporter.report();
		reporter.handleEvent({ type: "agent_start" } as never);
		reporter.setBlocked("approval", { kind: "permission", message: "Run npm test?" });
		reporter.setBlocked("approval", undefined);
		reporter.handleEvent({ type: "agent_settled", aborted: false } as never);
		expect(statuses.map((status) => formatTerminalTitle("RunKiln", "api", status))).toEqual([
			"RunKiln - api",
			"RunKiln - api - ● working",
			"RunKiln - api - ⚠ needs approval",
			"RunKiln - api - ● working",
			"RunKiln - api - ✓ done",
		]);
	});
});
