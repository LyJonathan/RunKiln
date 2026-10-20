import { execFileSync } from "node:child_process";
import type { ProgramStatus } from "@runkiln/tui";

/** Push the window and icon titles on the terminal's title stack (xterm, VTE, kitty, WezTerm, iTerm2). */
const PUSH_TITLE = "\x1b[22;0t";
/** Pop them back. Terminals without a title stack ignore it. */
const POP_TITLE = "\x1b[23;0t";

/** Title characters a terminal could read as the end of the sequence or as controls. */
function sanitizeTitle(text: string): string {
	return text
		.replace(/[\x00-\x1f\x7f-\x9f]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

/** The status part of the title: `● working`, `✓ done`, `⚠ needs approval`, or nothing while idle. */
export function formatTitleStatus(status: ProgramStatus | undefined): string | undefined {
	switch (status?.state) {
		case "working":
			return "● working";
		case "done":
			return "✓ done";
		case "blocked":
			return status.kind === "permission" ? "⚠ needs approval" : "⚠ needs input";
		case "error":
			return "✗ error";
		default:
			return undefined;
	}
}

/** `RunKiln - <project> - ● working`. */
export function formatTerminalTitle(app: string, project: string, status: ProgramStatus | undefined): string {
	const parts = [app, project, formatTitleStatus(status)].filter((part): part is string => !!part);
	return sanitizeTitle(parts.join(" - "));
}

export interface TerminalTitleOptions {
	write: (data: string) => void;
	env?: NodeJS.ProcessEnv;
	/** Current tmux pane title (tests stub it). Default: `tmux display-message -p '#{pane_title}'`. */
	readTmuxPaneTitle?: () => string | undefined;
}

function defaultTmuxPaneTitle(env: NodeJS.ProcessEnv): string | undefined {
	try {
		return execFileSync("tmux", ["display-message", "-p", "#{pane_title}"], {
			encoding: "utf8",
			timeout: 500,
			stdio: ["ignore", "pipe", "ignore"],
			env,
		}).replace(/\r?\n$/, "");
	} catch {
		return undefined;
	}
}

/**
 * The terminal title while RunKiln runs: OSC 0 (window and icon title), or OSC 2 for the pane title inside tmux
 * (tmux shows it in its status line and passes it on with `set-titles`). The previous title is saved on the
 * terminal's title stack and put back on exit; tmux has no title stack, so its pane title is read first and
 * written back.
 */
export class TerminalTitle {
	private readonly write: (data: string) => void;
	private readonly env: NodeJS.ProcessEnv;
	private readonly readTmuxPaneTitle: () => string | undefined;
	private readonly inTmux: boolean;
	private saved = false;
	private savedTmuxTitle: string | undefined;
	private last: string | undefined;

	constructor(options: TerminalTitleOptions) {
		this.write = options.write;
		this.env = options.env ?? process.env;
		this.inTmux = !!this.env.TMUX;
		this.readTmuxPaneTitle = options.readTmuxPaneTitle ?? (() => defaultTmuxPaneTitle(this.env));
	}

	/** Set the title (once the previous one is saved). Unchanged titles are not re-sent. */
	set(title: string): void {
		const clean = sanitizeTitle(title);
		if (clean === this.last) return;
		this.save();
		this.last = clean;
		this.write(this.inTmux ? `\x1b]2;${clean}\x07` : `\x1b]0;${clean}\x07`);
	}

	/** Put back the title RunKiln found. No-op when it never set one. */
	restore(): void {
		if (!this.saved) return;
		this.saved = false;
		this.last = undefined;
		if (this.inTmux) {
			// tmux's own default pane title is the host name; an empty one would blank the status line.
			if (this.savedTmuxTitle !== undefined) this.write(`\x1b]2;${sanitizeTitle(this.savedTmuxTitle)}\x07`);
			this.savedTmuxTitle = undefined;
			return;
		}
		// An empty title first: terminals without a title stack fall back to their default title.
		this.write(`\x1b]0;\x07${POP_TITLE}`);
	}

	private save(): void {
		if (this.saved) return;
		this.saved = true;
		if (this.inTmux) this.savedTmuxTitle = this.readTmuxPaneTitle();
		else this.write(PUSH_TITLE);
	}
}
