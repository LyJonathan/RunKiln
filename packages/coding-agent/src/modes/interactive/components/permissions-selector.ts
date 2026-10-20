/**
 * `/permissions`: pick the permission mode. Auto is shown greyed out, with a hint, when no decision model key exists.
 * Enter uses the mode and saves it as the default (plan mode is for one task and is never saved); the session's
 * "always allow" rules are listed and can be cleared; r opens the rules view (/permissions rules).
 */

import {
	type Component,
	type Focusable,
	getKeybindings,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@runkiln/tui";
import { PERMISSION_MODES, type PermissionMode, type PermissionModeInfo } from "../../../core/runkiln/permissions.ts";
import { theme } from "../theme/theme.ts";
import { keyText } from "./keybinding-hints.ts";

export interface PermissionsSelectorOptions {
	current: PermissionMode;
	/** The saved default, marked in the list. */
	saved?: PermissionMode;
	autoAvailable: boolean;
	/** Shown under Auto when it is not available. */
	autoHint?: string;
	/** Which decision model auto uses, e.g. "Jev (TypeSafe)". */
	autoBackend?: string;
	/** Human-readable session rules. */
	rules: string[];
	onSelect: (mode: PermissionMode) => void;
	onClearRules: () => void;
	/** Opens /permissions rules. */
	onOpenRules?: () => void;
	onCancel: () => void;
}

export class PermissionsSelectorComponent implements Component, Focusable {
	focused = false;
	private readonly opts: PermissionsSelectorOptions;
	private selected: number;
	private rules: string[];
	private notice: string | undefined;

	constructor(opts: PermissionsSelectorOptions) {
		this.opts = opts;
		this.rules = [...opts.rules];
		this.selected = Math.max(
			0,
			PERMISSION_MODES.findIndex((info) => info.id === opts.current),
		);
	}

	private isEnabled(info: PermissionModeInfo): boolean {
		return info.id !== "auto" || this.opts.autoAvailable;
	}

	private move(step: number): void {
		const count = PERMISSION_MODES.length;
		let index = this.selected;
		for (let i = 0; i < count; i++) {
			index = (index + step + count) % count;
			if (this.isEnabled(PERMISSION_MODES[index])) break;
		}
		this.selected = index;
		this.notice = undefined;
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		if (kb.matches(data, "tui.select.up") || data === "k") this.move(-1);
		else if (kb.matches(data, "tui.select.down") || data === "j") this.move(1);
		else if (kb.matches(data, "tui.select.confirm") || data === "\n") {
			const info = PERMISSION_MODES[this.selected];
			if (!this.isEnabled(info)) {
				this.notice = this.opts.autoHint;
				return;
			}
			this.opts.onSelect(info.id);
		} else if (kb.matches(data, "tui.select.cancel")) this.opts.onCancel();
		else if (data === "r" && this.opts.onOpenRules) this.opts.onOpenRules();
		else if (data === "c" && this.rules.length > 0) {
			this.opts.onClearRules();
			this.notice = `Cleared ${this.rules.length} session rule${this.rules.length === 1 ? "" : "s"}.`;
			this.rules = [];
		} else {
			const digit = Number.parseInt(data, 10);
			if (data.length === 1 && digit >= 1 && digit <= PERMISSION_MODES.length) {
				this.selected = digit - 1;
				this.handleInput("\n");
			}
		}
	}

	invalidate(): void {}

	render(width: number): string[] {
		const lines: string[] = [];
		const border = theme.fg("borderAccent", "─".repeat(Math.max(1, width)));
		lines.push(border);
		lines.push(
			` ${theme.bold(theme.fg("accent", "Permissions"))}  ${theme.fg("muted", "What RunKiln may do without asking")}`,
		);
		lines.push("");
		const labelWidth = Math.max(...PERMISSION_MODES.map((info) => visibleWidth(info.label))) + 2;
		PERMISSION_MODES.forEach((info, index) => {
			const enabled = this.isEnabled(info);
			const active = index === this.selected;
			const current = info.id === this.opts.current;
			const pointer = active ? theme.fg("accent", "›") : " ";
			const check = current ? theme.fg("success", "✓") : " ";
			const number = theme.fg(enabled ? (active ? "accent" : "dim") : "dim", `${index + 1}`);
			let label = info.label.padEnd(labelWidth);
			label = !enabled
				? theme.fg("dim", label)
				: active
					? theme.bold(theme.fg("accent", label))
					: theme.fg("text", label);
			const tags: string[] = [];
			if (info.id === this.opts.saved) tags.push("default");
			if (info.id === "plan") tags.push("this session only");
			if (info.id === "auto" && enabled && this.opts.autoBackend) tags.push(this.opts.autoBackend);
			if (info.id === "auto" && !enabled) tags.push("unavailable");
			const tagText = tags.length > 0 ? theme.fg("dim", ` - ${tags.join(" - ")}`) : "";
			const description = theme.fg(
				enabled ? (info.id === "allow-all" ? "warning" : "muted") : "dim",
				info.description,
			);
			const prefix = ` ${pointer} ${number} ${check} ${label}`;
			const room = Math.max(10, width - visibleWidth(prefix) - 1);
			const wrapped = wrapTextWithAnsi(`${description}${tagText}`, room);
			lines.push(`${prefix}${wrapped[0] ?? ""}`);
			for (const rest of wrapped.slice(1)) lines.push(`${" ".repeat(visibleWidth(prefix))}${rest}`);
			if (info.id === "auto" && !enabled && this.opts.autoHint) {
				lines.push(`${" ".repeat(visibleWidth(prefix))}${theme.fg("dim", this.opts.autoHint)}`);
			}
		});
		lines.push("");
		if (this.rules.length > 0) {
			lines.push(` ${theme.fg("muted", "Always allowed this session:")}`);
			for (const rule of this.rules.slice(0, 6)) lines.push(`   ${theme.fg("dim", "-")} ${theme.fg("text", rule)}`);
			if (this.rules.length > 6) lines.push(`   ${theme.fg("dim", `… ${this.rules.length - 6} more`)}`);
			lines.push("");
		}
		if (this.notice) {
			lines.push(` ${theme.fg("warning", this.notice)}`);
			lines.push("");
		}
		const hints = [
			"↑↓ choose",
			`${keyText("tui.select.confirm")} use and save as default`,
			...(this.rules.length > 0 ? ["c clear session rules"] : []),
			...(this.opts.onOpenRules ? ["r rules"] : []),
			`${keyText("app.permissions.cycle")} cycles in-session`,
			`${keyText("tui.select.cancel")} close`,
		];
		for (const line of wrapTextWithAnsi(theme.fg("dim", hints.join(" - ")), Math.max(10, width - 2)))
			lines.push(` ${line}`);
		lines.push(border);
		return lines.map((line) => truncateToWidth(line, width, ""));
	}
}
