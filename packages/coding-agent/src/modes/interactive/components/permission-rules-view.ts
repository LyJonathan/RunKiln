/**
 * `/permissions rules`: every permission rule in effect, grouped by where it lives, with removal.
 *
 * - This session: the "always allow … this session" rules (in memory, gone when the session ends).
 * - This project (your settings): rules saved by "always allow in this project", or `/permissions allow … --project`.
 * - Global (your settings): permissions.allow / ask / deny.
 * - Project file (.runkiln/settings.json): ask and deny rules the repository ships. Shown read-only (edit the file);
 *   its allow rules are listed as ignored, because a project can only tighten permissions.
 *
 * Keys: ↑↓ (or j/k) choose, d / x / delete removes the selected rule, esc closes.
 */

import {
	type Component,
	type Focusable,
	getKeybindings,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@runkiln/tui";
import type { RuleAction, RuleScope } from "../../../core/runkiln/permission-rules.ts";
import { theme } from "../theme/theme.ts";
import { keyText } from "./keybinding-hints.ts";

export type RuleViewScope = "session" | RuleScope;

export interface RuleViewEntry {
	scope: RuleViewScope;
	action: RuleAction;
	/** The rule as written (saved rules) or described (session rules). */
	text: string;
	/** A short plain-words reading of the rule. */
	description?: string;
	/** Why the rule is not applied, for ignored entries. */
	ignored?: string;
	/** Whether this view can remove it. */
	removable: boolean;
	/** Index of a session rule in the gate's list (session entries only). */
	sessionIndex?: number;
}

export interface PermissionRulesViewOptions {
	entries: RuleViewEntry[];
	/** Remove one entry; return false when it could not be removed. */
	onRemove: (entry: RuleViewEntry) => boolean;
	onClose: () => void;
}

const SCOPE_TITLES: Record<RuleViewScope, string> = {
	session: "This session (not saved)",
	project: "This project (your settings)",
	global: "Global (your settings)",
	"project-file": "Project file (.runkiln/settings.json, read-only here)",
};

const SCOPE_ORDER: readonly RuleViewScope[] = ["session", "project", "global", "project-file"];

/** Rows shown at once before the list scrolls. */
const MAX_ROWS = 14;

export class PermissionRulesViewComponent implements Component, Focusable {
	focused = false;
	private readonly opts: PermissionRulesViewOptions;
	private entries: RuleViewEntry[];
	private selected = 0;
	private notice: string | undefined;

	constructor(opts: PermissionRulesViewOptions) {
		this.opts = opts;
		this.entries = sortEntries(opts.entries);
		const first = this.entries.findIndex((entry) => entry.removable);
		this.selected = Math.max(0, first);
	}

	/** The entries in display order (for tests). */
	get list(): readonly RuleViewEntry[] {
		return this.entries;
	}

	private move(step: number): void {
		if (this.entries.length === 0) return;
		this.selected = (this.selected + step + this.entries.length) % this.entries.length;
		this.notice = undefined;
	}

	private removeSelected(): void {
		const entry = this.entries[this.selected];
		if (!entry) return;
		if (!entry.removable) {
			this.notice =
				entry.scope === "project-file"
					? "Rules in .runkiln/settings.json belong to the project: edit that file to change them."
					: "This rule cannot be removed here.";
			return;
		}
		if (!this.opts.onRemove(entry)) {
			this.notice = "That rule was already gone.";
			return;
		}
		// Later session rules move up by one in the gate's list.
		const removedIndex = entry.sessionIndex;
		this.entries.splice(this.selected, 1);
		if (removedIndex !== undefined) {
			for (const other of this.entries) {
				if (other.sessionIndex !== undefined && other.sessionIndex > removedIndex) other.sessionIndex--;
			}
		}
		this.selected = Math.min(this.selected, Math.max(0, this.entries.length - 1));
		this.notice = `Removed ${entry.action} rule ${entry.text}.`;
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		if (kb.matches(data, "tui.select.up") || data === "k") this.move(-1);
		else if (kb.matches(data, "tui.select.down") || data === "j") this.move(1);
		else if (data === "d" || data === "x" || data === "\u001b[3~") this.removeSelected();
		else if (kb.matches(data, "tui.select.cancel") || data === "q") this.opts.onClose();
	}

	invalidate(): void {}

	render(width: number): string[] {
		const lines: string[] = [];
		const border = theme.fg("borderAccent", "─".repeat(Math.max(1, width)));
		lines.push(border);
		lines.push(
			` ${theme.bold(theme.fg("accent", "Permission rules"))}  ${theme.fg("muted", "deny beats ask, ask beats allow - deny applies in every mode")}`,
		);
		lines.push("");
		if (this.entries.length === 0) {
			lines.push(`   ${theme.fg("dim", "No rules yet. “Always allow” in an approval prompt adds one, or:")}`);
		} else {
			// Scroll so the selected row stays visible.
			const start = Math.max(0, Math.min(this.selected - Math.floor(MAX_ROWS / 2), this.entries.length - MAX_ROWS));
			const end = Math.min(this.entries.length, start + MAX_ROWS);
			let lastScope: RuleViewScope | undefined;
			if (start > 0) lines.push(`   ${theme.fg("dim", `↑ ${start} more`)}`);
			for (let index = start; index < end; index++) {
				const entry = this.entries[index];
				if (entry.scope !== lastScope) {
					if (lastScope !== undefined) lines.push("");
					lines.push(` ${theme.fg("muted", SCOPE_TITLES[entry.scope])}`);
					lastScope = entry.scope;
				}
				const active = index === this.selected;
				const pointer = active ? theme.fg("accent", "›") : " ";
				const color = entry.action === "deny" ? "error" : entry.action === "ask" ? "warning" : "success";
				const badge = theme.fg(entry.ignored ? "dim" : color, entry.action.padEnd(5));
				const text = entry.ignored
					? theme.fg("dim", entry.text)
					: active
						? theme.bold(theme.fg("accent", entry.text))
						: theme.fg("text", entry.text);
				const extra = entry.ignored ? `ignored: ${entry.ignored}` : (entry.description ?? "");
				const prefix = ` ${pointer} ${badge} `;
				const head = `${prefix}${text}`;
				const room = Math.max(10, width - visibleWidth(head) - 3);
				const tail = extra ? `  ${theme.fg("dim", truncateToWidth(extra, room, "…"))}` : "";
				lines.push(truncateToWidth(`${head}${tail}`, width, "…"));
			}
			if (end < this.entries.length) lines.push(`   ${theme.fg("dim", `↓ ${this.entries.length - end} more`)}`);
		}
		lines.push("");
		const addHint =
			"Add: /permissions allow|ask|deny <rule> [--project] - e.g. Bash(npm test:*), Edit(src/**), Read(.env), mcp__github__*";
		for (const line of wrapTextWithAnsi(theme.fg("dim", addHint), Math.max(10, width - 2))) lines.push(` ${line}`);
		if (this.notice) {
			lines.push("");
			lines.push(` ${theme.fg("warning", this.notice)}`);
		}
		lines.push("");
		const hints = ["↑↓ choose", "d remove", `${keyText("tui.select.cancel")} close`];
		for (const line of wrapTextWithAnsi(theme.fg("dim", hints.join(" - ")), Math.max(10, width - 2)))
			lines.push(` ${line}`);
		lines.push(border);
		return lines.map((line) => truncateToWidth(line, width, ""));
	}
}

function sortEntries(entries: readonly RuleViewEntry[]): RuleViewEntry[] {
	const actionOrder: Record<RuleAction, number> = { deny: 0, ask: 1, allow: 2 };
	return entries
		.map((entry, order) => ({ entry, order }))
		.sort(
			(a, b) =>
				SCOPE_ORDER.indexOf(a.entry.scope) - SCOPE_ORDER.indexOf(b.entry.scope) ||
				(a.entry.scope === "session" ? 0 : actionOrder[a.entry.action] - actionOrder[b.entry.action]) ||
				a.order - b.order,
		)
		.map(({ entry }) => ({ ...entry }));
}
