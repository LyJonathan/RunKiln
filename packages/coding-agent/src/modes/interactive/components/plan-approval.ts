/**
 * The plan-approval prompt, shown in the editor slot when a run in plan mode ends with a plan (plan-mode.ts): the
 * plan, and three answers as in Claude Code's plan mode. Approve switches back to the permission mode the session was
 * in before plan mode and starts the implementation; keep planning opens a box for what to change (sent to the model,
 * plan mode stays on); discard leaves plan mode without running anything.
 *
 * Edit the plan opens it in the external editor ($VISUAL/$EDITOR, see onEditPlan); the edited text replaces the plan
 * shown here, and approving runs that version (PlanAnswer.plan).
 *
 * Keys: ↑↓ (or j/k) and enter, or 1-4; y approves, e edits the plan in the editor, r keeps planning, d discards, esc
 * closes and stays in plan mode. The tool-output expand key shows the whole plan when it was cut.
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
import { type PermissionMode, permissionModeInfo } from "../../../core/runkiln/permissions.ts";
import type { PlanAnswer, PlanChoice } from "../../../core/runkiln/plan-mode.ts";
import { theme } from "../theme/theme.ts";
import { hoverLabel, hoverRow } from "./hover-style.ts";
import { keyText } from "./keybinding-hints.ts";

/** Plan lines shown before it is cut. */
const COLLAPSED_PLAN_LINES = 16;

export interface PlanApprovalOptions {
	plan: string;
	/** The mode approving returns to. */
	returnMode: PermissionMode;
	onAnswer: (answer: PlanAnswer | undefined) => void;
	/**
	 * Open the plan in the external editor and resolve with the edited text, or undefined when the editor failed or
	 * was closed without saving. Without it, the edit option is not offered.
	 */
	onEditPlan?: (plan: string) => Promise<string | undefined>;
	/** Re-rendered after an edit. */
	tui?: Pick<TUI, "requestRender">;
}

/** A row of the prompt: an answer, or "edit", which opens the editor and comes back here. */
type PlanOption = PlanChoice | "edit";

interface Option {
	choice: PlanOption;
	label: string;
}

export class PlanApprovalComponent implements Component, Focusable {
	private readonly opts: PlanApprovalOptions;
	private readonly options: Option[];
	private selected = 0;
	private expanded = false;
	private feedbackInput: Input | undefined;
	/** The plan shown and approved: the model's, or the user's edited version. */
	private plan: string;
	private edited = false;
	private editing = false;
	private answered = false;
	private _focused = false;
	private readonly hits = new HitMap<number | "send" | "back" | "expand">();
	private readonly rows = new ClickableRows<number | "send" | "back" | "expand">();

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		if (this.feedbackInput) this.feedbackInput.focused = value;
	}

	constructor(opts: PlanApprovalOptions) {
		this.opts = opts;
		this.plan = opts.plan;
		const mode = permissionModeInfo(opts.returnMode).label;
		this.options = [
			{ choice: "approve", label: `Yes, run the plan (switch to ${mode})` },
			...(opts.onEditPlan ? [{ choice: "edit" as const, label: "Edit the plan in your editor, then decide" }] : []),
			{ choice: "refine", label: "No, keep planning: tell the model what to change" },
			{ choice: "discard", label: `Discard the plan (leave plan mode for ${mode}, run nothing)` },
		];
	}

	/** The plan that approving runs (the edited version after an edit). */
	get currentPlan(): string {
		return this.plan;
	}

	/** Whether the user edited the plan. */
	get isEdited(): boolean {
		return this.edited;
	}

	private finish(answer: PlanAnswer | undefined): void {
		if (this.answered) return;
		this.answered = true;
		// After an edit, approve and keep planning carry the edited plan.
		this.opts.onAnswer(
			answer && this.edited && answer.choice !== "discard" ? { ...answer, plan: this.plan } : answer,
		);
	}

	/** Open the plan in the editor; a non-empty result replaces it. */
	private async editPlan(): Promise<void> {
		const edit = this.opts.onEditPlan;
		if (!edit || this.editing || this.answered) return;
		this.editing = true;
		try {
			const result = await edit(this.plan);
			const next = result?.replace(/\s+$/, "");
			if (next?.trim() && next !== this.plan) {
				this.plan = next;
				this.edited = true;
			}
		} catch {
			// The editor failed: the plan stays as it was.
		} finally {
			this.editing = false;
			this.opts.tui?.requestRender();
		}
	}

	private choose(index: number): void {
		const option = this.options[index];
		if (!option) return;
		if (option.choice === "edit") {
			void this.editPlan();
			return;
		}
		if (option.choice === "refine") {
			this.feedbackInput = new Input();
			this.feedbackInput.focused = this._focused;
			this.feedbackInput.onSubmit = (value) => this.finish({ choice: "refine", feedback: value });
			return;
		}
		this.finish({ choice: option.choice });
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		// While the editor is open the terminal belongs to it.
		if (this.editing) return;
		if (this.feedbackInput) {
			if (kb.matches(data, "tui.select.cancel")) {
				this.feedbackInput = undefined;
				return;
			}
			if (kb.matches(data, "tui.select.confirm") || data === "\n") {
				this.finish({ choice: "refine", feedback: this.feedbackInput.getValue() });
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
			this.finish(undefined);
			return;
		}
		const digit = Number.parseInt(data, 10);
		if (data.length === 1 && digit >= 1 && digit <= this.options.length) {
			this.choose(digit - 1);
			return;
		}
		const shortcut: Record<string, PlanOption> = {
			y: "approve",
			r: "refine",
			// Without an editor, e keeps its old meaning (keep planning).
			e: this.opts.onEditPlan ? "edit" : "refine",
			d: "discard",
		};
		const choice = shortcut[data.toLowerCase()];
		if (choice) this.choose(this.options.findIndex((option) => option.choice === choice));
	}

	invalidate(): void {
		this.feedbackInput?.invalidate();
	}

	/** Click an answer to pick it; hover highlights it; the wheel moves the selection. */
	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (this.answered || this.editing) return undefined;
		const value = event.type === "leave" ? undefined : this.hits.at(event.x, event.y);
		return this.rows.handle(value, event, {
			select: (target) => {
				if (typeof target === "number") this.selected = target;
			},
			activate: (target) => {
				if (target === "send") this.finish({ choice: "refine", feedback: this.feedbackInput?.getValue() ?? "" });
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

	render(width: number): string[] {
		this.hits.reset();
		const inner = Math.max(10, width - 4);
		const lines: string[] = [];
		const pad = (text: string) => `  ${text}`;
		const border = theme.fg("borderAccent", "─".repeat(Math.max(1, width)));
		lines.push(border);
		const edited = this.edited ? theme.fg("warning", " (edited by you)") : "";
		const title = ` ${theme.fg("accent", "‖")} ${theme.bold(theme.fg("accent", "Ready to run this plan?"))}${edited}`;
		const mode = theme.fg("dim", "Plan mode - read-only");
		const gap = Math.max(1, width - visibleWidth(title) - visibleWidth(mode) - 1);
		lines.push(truncateToWidth(`${title}${" ".repeat(gap)}${mode}`, width, "…"));
		lines.push("");

		const planLines = this.plan
			.split("\n")
			.flatMap((line) => (line === "" ? [""] : wrapTextWithAnsi(line, inner - 2)));
		const shown = this.expanded ? planLines : planLines.slice(0, COLLAPSED_PLAN_LINES);
		for (const line of shown) lines.push(pad(`${theme.fg("borderMuted", "│")} ${theme.fg("text", line)}`));
		if (shown.length < planLines.length) {
			this.hits.add(lines.length, "expand", 2);
			lines.push(
				pad(
					theme.fg(
						"dim",
						`… ${planLines.length - shown.length} more lines (${keyText("app.tools.expand")} to show all)`,
					),
				),
			);
		}
		lines.push("");

		if (this.feedbackInput) {
			lines.push(pad(theme.fg("accent", "What should change in the plan? (plan mode stays on)")));
			for (const line of this.feedbackInput.render(inner)) lines.push(pad(line));
			lines.push("");
			const send = `${keyText("tui.select.confirm")} send`;
			const back = `${keyText("tui.select.cancel")} back`;
			const style = (text: string, target: "send" | "back") =>
				theme.fg("dim", this.rows.isHovered(target) ? hoverLabel(text) : text);
			this.hits.add(lines.length, "send", 2, 2 + visibleWidth(send));
			this.hits.add(
				lines.length,
				"back",
				2 + visibleWidth(send) + 3,
				2 + visibleWidth(send) + 3 + visibleWidth(back),
			);
			lines.push(pad(`${style(send, "send")}${theme.fg("dim", " - ")}${style(back, "back")}`));
		} else {
			this.options.forEach((option, index) => {
				const active = index === this.selected;
				const number = theme.fg(active ? "accent" : "dim", `${index + 1}`);
				const pointer = active ? theme.fg("accent", "›") : " ";
				const color = option.choice === "discard" ? (active ? "error" : "muted") : active ? "accent" : "text";
				const label = theme.fg(color, option.label);
				const row = truncateToWidth(` ${pointer} ${number}  ${active ? theme.bold(label) : label}`, width, "…");
				this.hits.add(lines.length, index);
				lines.push(!active && this.rows.isHovered(index) ? hoverRow(row, width) : row);
			});
			lines.push("");
			const hints = [
				"↑↓ choose",
				`${keyText("tui.select.confirm")} confirm`,
				"y run",
				...(this.opts.onEditPlan ? ["e edit"] : []),
				"r keep planning",
				"d discard",
				`${keyText("tui.select.cancel")} close (stay in plan mode)`,
			];
			for (const line of wrapTextWithAnsi(theme.fg("dim", hints.join(" - ")), inner)) lines.push(pad(line));
		}
		lines.push(border);
		return lines.map((line) => truncateToWidth(line, width, ""));
	}
}
