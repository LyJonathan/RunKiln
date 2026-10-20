/**
 * The approval prompt for one tool call: what will run, why it asks (risk rules, a saved ask rule, the auto decision
 * model's reason), and the answers, as in Claude Code, Codex and opencode: allow once, always allow this (this
 * session), always allow it in this project (saved to settings), deny, and deny with feedback for the model.
 *
 * A shell command and an MCP call's arguments are shown with syntax colour (bash, JSON). A write or edit shows its diff
 * (approval-preview.ts), cut to COLLAPSED_DIFF_LINES (fewer on a short terminal), with `+a −r` in the title.
 *
 * Keys: ↑↓ (or j/k) and enter, or 1-5 directly; y allows once, a always allows (session), p always allows in this
 * project, n or esc denies, f opens the feedback box. The tool-output expand key shows the full call and diff when they
 * were cut. permissions.promptTimeoutSec sets a timeout (none by default): then the call is denied, or with
 * timeoutAction "pause" the prompt stays open and onTimeout fires (a notification).
 */

import {
	ClickableRows,
	type Component,
	type Focusable,
	getKeybindings,
	HitMap,
	Input,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@runkiln/tui";
import {
	APPROVAL_OPTION_LABELS,
	type ApprovalAnswer,
	type ApprovalChoice,
	type PermissionPrompt,
	permissionModeInfo,
} from "../../../core/runkiln/permissions.ts";
import { highlightCode, theme } from "../theme/theme.ts";
import { CountdownTimer } from "./countdown-timer.ts";
import { renderDiff } from "./diff.ts";
import { hoverLabel, hoverRow } from "./hover-style.ts";
import { keyText } from "./keybinding-hints.ts";

/** Lines of the call shown before it is cut (expand to see the rest). */
const COLLAPSED_MESSAGE_LINES = 14;
/** Diff lines shown before the diff is cut (expand to see the rest). */
export const COLLAPSED_DIFF_LINES = 8;
/** Command (code) lines shown before they are cut; a shell command is shown whole up to this many lines. */
const COLLAPSED_CODE_LINES = 30;
/** Rows kept free for the footer and the line above the prompt when the prompt is fitted to the terminal. */
const RESERVED_ROWS = 4;

/** How much of the call, the diff and the hints a collapsed prompt shows. */
interface FitLevel {
	/** Message lines (code included) before the rest of the message is cut. */
	message: number;
	/** Fewest message lines after the code that are always shown. */
	minMessage: number;
	/** Diff lines shown. */
	diff: number;
	/** Key hints without the arrow and enter keys (one line). */
	shortHints: boolean;
}

/** Tried in order until the prompt fits the terminal; the first is the default. */
const FIT_LEVELS: readonly FitLevel[] = [
	{ message: COLLAPSED_MESSAGE_LINES, minMessage: 2, diff: COLLAPSED_DIFF_LINES, shortHints: false },
	{ message: COLLAPSED_MESSAGE_LINES, minMessage: 2, diff: COLLAPSED_DIFF_LINES, shortHints: true },
	{ message: COLLAPSED_MESSAGE_LINES, minMessage: 2, diff: 6, shortHints: true },
	{ message: 8, minMessage: 2, diff: 6, shortHints: true },
	{ message: 6, minMessage: 1, diff: 5, shortHints: true },
	{ message: 6, minMessage: 1, diff: 4, shortHints: true },
	{ message: 4, minMessage: 0, diff: 3, shortHints: true },
];

interface Option {
	choice: ApprovalChoice;
	label: string;
}

export interface PermissionPromptOptions {
	tui?: TUI;
	/** Seconds left are shown in the title; no answer by then denies (or pauses, see the prompt's timeoutAction). */
	timeoutMs?: number;
	/** Called once when a "pause" timeout runs out; the prompt stays open. */
	onTimeout?: () => void;
}

export class PermissionPromptComponent implements Component, Focusable {
	private readonly prompt: PermissionPrompt;
	private readonly options: Option[];
	private readonly onAnswer: (answer: ApprovalAnswer | undefined) => void;
	private selected = 0;
	private expanded = false;
	private secondsLeft: number | undefined;
	private countdown: CountdownTimer | undefined;
	private feedbackInput: Input | undefined;
	private readonly tui: TUI | undefined;
	private paused = false;
	private answered = false;
	private _focused = false;
	/** Option index, or "send"/"back" in the feedback box. */
	private readonly hits = new HitMap<number | "send" | "back" | "expand">();
	private readonly rows = new ClickableRows<number | "send" | "back" | "expand">();

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		if (this.feedbackInput) this.feedbackInput.focused = value;
	}

	/** Click an answer to pick it; hover highlights it; the wheel moves the selection. */
	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (this.answered) return undefined;
		const value = event.type === "leave" ? undefined : this.hits.at(event.x, event.y);
		return this.rows.handle(value, event, {
			select: (target) => {
				if (typeof target === "number") this.selected = target;
			},
			activate: (target) => {
				if (target === "send")
					this.finish({ choice: "deny-feedback", feedback: this.feedbackInput?.getValue() ?? "" });
				else if (target === "back") this.feedbackInput = undefined;
				else if (target === "expand") this.expanded = !this.expanded;
				else this.choose(target);
			},
			wheel: this.feedbackInput
				? undefined
				: (delta) => {
						this.selected = Math.max(0, Math.min(this.options.length - 1, this.selected + delta));
					},
		});
	}

	constructor(
		prompt: PermissionPrompt,
		onAnswer: (answer: ApprovalAnswer | undefined) => void,
		opts: PermissionPromptOptions = {},
	) {
		this.prompt = prompt;
		this.onAnswer = onAnswer;
		this.tui = opts.tui;
		this.options = [{ choice: "allow-once", label: APPROVAL_OPTION_LABELS.once }];
		if (prompt.alwaysLabel) this.options.push({ choice: "allow-always", label: prompt.alwaysLabel });
		if (prompt.projectLabel) this.options.push({ choice: "allow-project", label: prompt.projectLabel });
		this.options.push(
			{ choice: "deny", label: APPROVAL_OPTION_LABELS.deny },
			{ choice: "deny-feedback", label: APPROVAL_OPTION_LABELS.feedback },
		);
		const timeout = opts.timeoutMs ?? prompt.timeoutMs;
		if (timeout > 0 && opts.tui) {
			this.countdown = new CountdownTimer(
				timeout,
				opts.tui,
				(seconds) => {
					this.secondsLeft = seconds;
				},
				() => {
					if (prompt.timeoutAction !== "pause") {
						this.finish(undefined);
						return;
					}
					this.paused = true;
					this.secondsLeft = undefined;
					opts.onTimeout?.();
					opts.tui?.requestRender();
				},
			);
		}
	}

	private finish(answer: ApprovalAnswer | undefined): void {
		if (this.answered) return;
		this.answered = true;
		this.countdown?.dispose();
		this.onAnswer(answer);
	}

	private choose(index: number): void {
		const option = this.options[index];
		if (!option) return;
		if (option.choice === "deny-feedback") {
			this.feedbackInput = new Input();
			this.feedbackInput.focused = this._focused;
			this.feedbackInput.onSubmit = (value) => this.finish({ choice: "deny-feedback", feedback: value });
			// While typing, the timeout no longer applies: the user is answering.
			this.countdown?.dispose();
			this.secondsLeft = undefined;
			return;
		}
		this.finish({ choice: option.choice });
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		if (this.feedbackInput) {
			if (kb.matches(data, "tui.select.cancel")) {
				this.feedbackInput = undefined;
				return;
			}
			if (kb.matches(data, "tui.select.confirm") || data === "\n") {
				this.finish({ choice: "deny-feedback", feedback: this.feedbackInput.getValue() });
				return;
			}
			this.feedbackInput.handleInput(data);
			return;
		}
		if (kb.matches(data, "app.tools.expand")) {
			this.expanded = !this.expanded;
			return;
		}
		if (kb.matches(data, "tui.select.up") || data === "k") {
			this.selected = (this.selected - 1 + this.options.length) % this.options.length;
			return;
		}
		if (kb.matches(data, "tui.select.down") || data === "j") {
			this.selected = (this.selected + 1) % this.options.length;
			return;
		}
		if (kb.matches(data, "tui.select.confirm") || data === "\n") {
			this.choose(this.selected);
			return;
		}
		if (kb.matches(data, "tui.select.cancel")) {
			this.finish({ choice: "deny" });
			return;
		}
		const digit = Number.parseInt(data, 10);
		if (data.length === 1 && digit >= 1 && digit <= this.options.length) {
			this.choose(digit - 1);
			return;
		}
		const index = (choice: ApprovalChoice) => this.options.findIndex((option) => option.choice === choice);
		const shortcut: Record<string, ApprovalChoice> = {
			y: "allow-once",
			a: "allow-always",
			p: "allow-project",
			n: "deny",
			f: "deny-feedback",
		};
		const choice = shortcut[data.toLowerCase()];
		if (choice && index(choice) >= 0) this.choose(index(choice));
	}

	invalidate(): void {
		this.feedbackInput?.invalidate();
	}

	/** Whether a "pause" timeout ran out and the prompt is waiting. */
	get isPaused(): boolean {
		return this.paused;
	}

	/** The message around its code part (see ApprovalRequest.code); all of it is `after` (cut when long) when there is none. */
	private splitMessage(): { before?: string; code?: string; after?: string } {
		const message = this.prompt.message;
		const code = this.prompt.code?.text;
		const at = code ? message.indexOf(code) : -1;
		if (!code || at < 0) return { after: message };
		const before = message.slice(0, at).replace(/\n$/, "");
		const after = message.slice(at + code.length).replace(/^\n/, "");
		return {
			...(before !== "" ? { before } : {}),
			code,
			...(after !== "" ? { after } : {}),
		};
	}

	/** The code part with syntax colour, wrapped to the width. */
	private codeLines(code: string, width: number): string[] {
		const language = this.prompt.code?.language;
		let highlighted: string[];
		try {
			highlighted = highlightCode(code, language);
		} catch {
			highlighted = code.split("\n");
		}
		return highlighted.flatMap((line) => (line === "" ? [""] : wrapTextWithAnsi(line, Math.max(4, width))));
	}

	dispose(): void {
		this.countdown?.dispose();
	}

	/**
	 * The prompt, fitted to the terminal: when the collapsed prompt is taller than the rows left above the footer, the
	 * diff and the message are cut further and the key hints shortened, so the title and the choices stay on screen.
	 * The expand key always shows everything.
	 */
	render(width: number): string[] {
		const rows = this.tui?.terminal?.rows;
		if (this.expanded || !rows || rows <= 0) return this.renderWith(width, FIT_LEVELS[0]);
		const maxLines = Math.max(8, rows - RESERVED_ROWS);
		let lines: string[] = [];
		for (const level of FIT_LEVELS) {
			lines = this.renderWith(width, level);
			if (lines.length <= maxLines) return lines;
		}
		return lines;
	}

	private renderWith(width: number, fit: FitLevel): string[] {
		this.hits.reset();
		const inner = Math.max(10, width - 4);
		const lines: string[] = [];
		const border = (text: string) => theme.fg("borderAccent", text);
		const pad = (text: string) => `  ${text}`;
		const risky = this.prompt.risks.length > 0;

		lines.push(border("─".repeat(Math.max(1, width))));
		const icon = risky ? theme.fg("warning", "▲") : theme.fg("accent", "◆");
		const timer =
			this.secondsLeft !== undefined
				? theme.fg("dim", ` ${this.secondsLeft}s`)
				: this.paused
					? theme.fg("warning", " paused")
					: "";
		const diff = this.prompt.diff;
		const stat =
			diff && !diff.error
				? ` ${theme.fg("toolDiffAdded", `+${diff.added}`)} ${theme.fg("toolDiffRemoved", `−${diff.removed}`)}${diff.newFile ? theme.fg("dim", " new file") : ""}`
				: "";
		const title = `${icon} ${theme.bold(theme.fg("accent", this.prompt.title))}${stat}`;
		const mode = theme.fg("dim", `${permissionModeInfo(this.prompt.mode).label} mode`);
		const left = truncateToWidth(
			` ${title}`,
			Math.max(10, width - visibleWidth(mode) - visibleWidth(timer) - 2),
			"…",
		);
		const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(mode) - visibleWidth(timer) - 1);
		lines.push(`${left}${" ".repeat(gap)}${mode}${timer}`);
		lines.push("");

		// The call itself, in a muted gutter so it reads as data, not as RunKiln's own text.
		const gutter = (line: string) => pad(`${theme.fg("borderMuted", "│")} ${line}`);
		const more = (count: number, what: string) =>
			pad(theme.fg("dim", `… ${count} more ${what} (${keyText("app.tools.expand")} to show all)`));
		const pushMore = (count: number, what: string) => {
			this.hits.add(lines.length, "expand", 2);
			lines.push(more(count, what));
		};
		const { before, code, after } = this.splitMessage();
		const plain = (text: string) =>
			text.split("\n").flatMap((line) => (line === "" ? [""] : wrapTextWithAnsi(theme.fg("text", line), inner - 2)));
		const beforeLines = before === undefined ? [] : plain(before);
		const codeLines = code === undefined ? [] : this.codeLines(code, inner - 2);
		const afterLines = after === undefined ? [] : plain(after);
		const shownCode = this.expanded ? codeLines : codeLines.slice(0, COLLAPSED_CODE_LINES);
		const budget = Math.max(fit.minMessage, fit.message - beforeLines.length - shownCode.length);
		const shownAfter = this.expanded ? afterLines : afterLines.slice(0, budget);
		for (const line of beforeLines) lines.push(gutter(line));
		for (const line of shownCode) lines.push(gutter(line));
		if (shownCode.length < codeLines.length) pushMore(codeLines.length - shownCode.length, "lines");
		for (const line of shownAfter) lines.push(gutter(line));
		if (shownAfter.length < afterLines.length) pushMore(afterLines.length - shownAfter.length, "lines");

		if (diff) {
			lines.push("");
			if (diff.error) {
				for (const line of wrapTextWithAnsi(theme.fg("warning", `No diff preview: ${diff.error}`), inner)) {
					lines.push(pad(line));
				}
			} else if (diff.text === "") {
				lines.push(pad(theme.fg("dim", "No changes.")));
			} else {
				const diffLines = renderDiff(diff.text).split("\n");
				// Collapsed, the diff starts one context line above the first change, so the cut keeps changes.
				const firstChange = diff.text.split("\n").findIndex((line) => line.startsWith("+") || line.startsWith("-"));
				const start = this.expanded || firstChange < 0 ? 0 : Math.max(0, firstChange - 1);
				const shownDiff = this.expanded ? diffLines : diffLines.slice(start, start + fit.diff);
				for (const line of shownDiff) lines.push(truncateToWidth(gutter(line), width, "…"));
				const hidden = diffLines.length - shownDiff.length;
				if (hidden > 0) pushMore(hidden, "diff lines");
				if (this.expanded && diff.omittedLines) {
					lines.push(pad(theme.fg("dim", `… ${diff.omittedLines} more diff lines not shown (preview limit)`)));
				}
			}
		}

		if (risky || this.prompt.judgeReason || this.prompt.askRule) lines.push("");
		for (const risk of this.prompt.risks) {
			for (const line of wrapTextWithAnsi(`${theme.fg("warning", "!")} ${theme.fg("warning", risk)}`, inner))
				lines.push(pad(line));
		}
		if (this.prompt.askRule) {
			for (const line of wrapTextWithAnsi(
				`${theme.fg("accent", "rule:")} ${theme.fg("muted", `asks because of the ask rule ${this.prompt.askRule}`)}`,
				inner,
			)) {
				lines.push(pad(line));
			}
		}
		if (this.prompt.judgeReason) {
			for (const line of wrapTextWithAnsi(
				`${theme.fg("accent", "auto:")} ${theme.fg("muted", this.prompt.judgeReason)}`,
				inner,
			)) {
				lines.push(pad(line));
			}
		}
		lines.push("");

		if (this.feedbackInput) {
			lines.push(pad(theme.fg("accent", "Tell the model what to do instead:")));
			for (const line of this.feedbackInput.render(inner)) lines.push(pad(line));
			lines.push("");
			const send = `${keyText("tui.select.confirm")} deny and send`;
			const back = `${keyText("tui.select.cancel")} back`;
			const style = (text: string, target: "send" | "back") =>
				theme.fg("dim", this.rows.isHovered(target) ? hoverLabel(text) : text);
			const row = lines.length;
			this.hits.add(row, "send", 2, 2 + visibleWidth(send));
			this.hits.add(row, "back", 2 + visibleWidth(send) + 3, 2 + visibleWidth(send) + 3 + visibleWidth(back));
			lines.push(pad(`${style(send, "send")}${theme.fg("dim", " - ")}${style(back, "back")}`));
		} else {
			this.options.forEach((option, index) => {
				const active = index === this.selected;
				const number = theme.fg(active ? "accent" : "dim", `${index + 1}`);
				const pointer = active ? theme.fg("accent", "›") : " ";
				const color = option.choice.startsWith("deny") ? (active ? "error" : "muted") : active ? "accent" : "text";
				const label = theme.fg(color, option.label);
				const row = truncateToWidth(` ${pointer} ${number}  ${active ? theme.bold(label) : label}`, width, "…");
				this.hits.add(lines.length, index);
				lines.push(!active && this.rows.isHovered(index) ? hoverRow(row, width) : row);
			});
			lines.push("");
			const hints = [
				...(fit.shortHints ? [] : ["↑↓ choose", `${keyText("tui.select.confirm")} confirm`]),
				`1-${this.options.length} pick`,
				"y allow",
				...(this.prompt.alwaysLabel ? ["a always"] : []),
				...(this.prompt.projectLabel ? ["p project"] : []),
				fit.shortHints ? "n deny" : `n/${keyText("tui.select.cancel")} deny`,
				"f feedback",
			];
			// Wrap between hints, never inside one ("f feedback" stays together).
			const hintLines: string[] = [];
			for (const hint of hints) {
				const last = hintLines.length - 1;
				if (last >= 0 && visibleWidth(`${hintLines[last]} - ${hint}`) <= inner) hintLines[last] += ` - ${hint}`;
				else hintLines.push(hint);
			}
			for (const hintLine of hintLines)
				for (const line of wrapTextWithAnsi(theme.fg("dim", hintLine), inner)) lines.push(pad(line));
		}
		lines.push(border("─".repeat(Math.max(1, width))));
		return lines.map((line) => truncateToWidth(line, width, ""));
	}
}
