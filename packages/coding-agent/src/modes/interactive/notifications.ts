/**
 * Desktop notifications when the agent needs the user: a turn ended, or an approval or plan prompt is waiting.
 * Only while the terminal is unfocused (focus reporting, CSI ?1004h); when the terminal never reports focus, only
 * for turns that ran at least LONG_TURN_MS (the user has probably switched away).
 *
 * Setting `notifications`: "auto" sends a terminal notification where the terminal supports one (OSC 9 for iTerm2,
 * Apple Terminal and ConEmu; OSC 777 for Ghostty, WezTerm, kitty, foot, VTE terminals, Warp and Windows Terminal)
 * and the bell elsewhere; "bell" always rings the bell; "off" never notifies. Inside tmux the OSC is wrapped in a
 * DCS passthrough (needs `allow-passthrough on`) and the bell is sent too, so tmux can flag the window.
 */

export type NotificationsMode = "auto" | "bell" | "off";
export type NotifyProtocol = "osc9" | "osc777" | "bell";
export type NotifyReason = "turn" | "approval" | "plan";

/** Without focus reporting, turns at least this long notify when they end (the user likely switched away). */
export const LONG_TURN_MS = 30_000;

const BEL = "\x07";

/** The notification escape a terminal understands, from its environment. */
export function detectNotifyProtocol(env: NodeJS.ProcessEnv): NotifyProtocol {
	const program = (env.TERM_PROGRAM ?? "").toLowerCase();
	const term = (env.TERM ?? "").toLowerCase();
	if (program === "iterm.app" || program === "apple_terminal" || env.ConEmuPID || env.ITERM_SESSION_ID) {
		return "osc9";
	}
	if (
		program === "ghostty" ||
		program === "wezterm" ||
		program === "warpterminal" ||
		term.includes("ghostty") ||
		term === "xterm-kitty" ||
		term.startsWith("foot") ||
		env.KITTY_WINDOW_ID ||
		env.WEZTERM_PANE ||
		env.GHOSTTY_RESOURCES_DIR ||
		env.VTE_VERSION ||
		env.WT_SESSION
	) {
		return "osc777";
	}
	return "bell";
}

/** Text safe inside an OSC payload: no control characters, no `;` (field separator), short. */
export function sanitizeNotifyText(text: string, max = 120): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
	const clean = text
		.replace(/[\x00-\x1f\x7f-\x9f]+/g, " ")
		.replace(/;/g, ",")
		.replace(/\s+/g, " ")
		.trim();
	return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/** Wrap an escape sequence for tmux passthrough (DCS tmux; …ST, with ESC doubled). */
export function wrapForTmux(sequence: string): string {
	return `\x1bPtmux;${sequence.replace(/\x1b/g, "\x1b\x1b")}\x1b\\`;
}

/** The bytes to write for one notification. */
export function notificationSequence(
	protocol: NotifyProtocol,
	title: string,
	body: string,
	options: { tmux?: boolean } = {},
): string {
	const safeTitle = sanitizeNotifyText(title, 60) || "RunKiln";
	const safeBody = sanitizeNotifyText(body);
	let osc = "";
	if (protocol === "osc9") {
		// A body that starts with "<digits>;" would read as a ConEmu OSC 9 subcommand (e.g. 9;4 progress).
		const text = `${safeTitle}: ${safeBody}`.replace(/^(\d+);/, "$1,");
		osc = `\x1b]9;${text}${BEL}`;
	} else if (protocol === "osc777") {
		osc = `\x1b]777;notify;${safeTitle};${safeBody}${BEL}`;
	}
	if (!osc) return BEL;
	if (options.tmux) return `${wrapForTmux(osc)}${BEL}`;
	return osc;
}

export interface TurnNotifierOptions {
	mode: () => NotificationsMode;
	write: (data: string) => void;
	/** Terminal focus: true/false when the terminal reports it, undefined when it never has. */
	focused: () => boolean | undefined;
	env?: NodeJS.ProcessEnv;
	now?: () => number;
}

/**
 * Decides when to notify and writes the escape. The interactive mode calls turnStarted/turnEnded and waiting (an
 * approval or plan prompt is shown); everything else stays here so it can be tested without a terminal.
 */
export class TurnNotifier {
	private readonly env: NodeJS.ProcessEnv;
	private readonly now: () => number;
	private turnStartedAt: number | undefined;
	private lastSentAt = 0;
	private readonly options: TurnNotifierOptions;

	constructor(options: TurnNotifierOptions) {
		this.options = options;
		this.env = options.env ?? process.env;
		this.now = options.now ?? Date.now;
	}

	turnStarted(): void {
		this.turnStartedAt ??= this.now();
	}

	/** The run settled. Returns whether a notification went out. */
	turnEnded(body: string, aborted = false): boolean {
		const started = this.turnStartedAt;
		this.turnStartedAt = undefined;
		// The user pressed Escape: they are here.
		if (aborted || started === undefined) return false;
		return this.maybeSend("turn", body, this.now() - started);
	}

	/**
	 * An approval or plan prompt is waiting for the user. `force` notifies even while the terminal has focus (an
	 * approval timeout paused the turn: the user may have walked away from a focused window); "off" still wins.
	 */
	waiting(reason: "approval" | "plan", body: string, options: { force?: boolean } = {}): boolean {
		const started = this.turnStartedAt;
		return this.maybeSend(reason, body, started === undefined ? 0 : this.now() - started, options.force === true);
	}

	/** Whether a notification is due: unfocused, or (focus unknown) a long-running turn. */
	shouldNotify(elapsedMs: number): boolean {
		if (this.options.mode() === "off") return false;
		const focused = this.options.focused();
		if (focused !== undefined) return !focused;
		return elapsedMs >= LONG_TURN_MS;
	}

	private maybeSend(reason: NotifyReason, body: string, elapsedMs: number, force = false): boolean {
		if (force ? this.options.mode() === "off" : !this.shouldNotify(elapsedMs)) return false;
		// Several prompts in a row (parallel approvals) make one notification, not a burst.
		const now = this.now();
		if (!force && now - this.lastSentAt < 2000) return false;
		this.lastSentAt = now;
		const mode = this.options.mode();
		const protocol = mode === "bell" ? "bell" : detectNotifyProtocol(this.env);
		const title =
			reason === "turn" ? "RunKiln: done" : reason === "plan" ? "RunKiln: plan ready" : "RunKiln: approval needed";
		this.options.write(notificationSequence(protocol, title, body, { tmux: !!this.env.TMUX }));
		return true;
	}
}
