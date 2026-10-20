/**
 * A scrolling list of OpenRouter decision models, shared by setup's classifier step and /key's Router screen.
 * It holds the list, the cursor and the scroll window; each screen draws the rows in its own style.
 */

import {
	type DecisionModelEntry,
	type DecisionModelList,
	decisionModelHint,
	OPENROUTER_DEFAULT_DECISION_MODEL,
} from "../../../core/router/decision-models.ts";

export const DECISION_PICKER_ROWS = 8;

export class DecisionModelPicker {
	private list: DecisionModelList;
	private cursor = 0;
	private scroll = 0;
	private readonly visibleRows: number;

	constructor(list: DecisionModelList, selectedId?: string, visibleRows = DECISION_PICKER_ROWS) {
		this.list = list;
		this.visibleRows = visibleRows;
		this.select(selectedId);
	}

	get entries(): readonly DecisionModelEntry[] {
		return this.list.entries;
	}

	get source(): DecisionModelList["source"] {
		return this.list.source;
	}

	get selected(): DecisionModelEntry | undefined {
		return this.list.entries[this.cursor];
	}

	/** Put the cursor on `id` (else the default, else the first entry). */
	select(id: string | undefined): void {
		const entries = this.list.entries;
		let index = id ? entries.findIndex((entry) => entry.id === id) : -1;
		if (index < 0) index = entries.findIndex((entry) => entry.id === OPENROUTER_DEFAULT_DECISION_MODEL);
		this.cursor = Math.max(0, index);
		this.keepVisible();
	}

	/** A fresher list (live fetch finished): keeps the highlighted model when it is still listed. */
	replace(list: DecisionModelList): void {
		const current = this.selected?.id;
		this.list = list;
		this.select(current);
	}

	move(delta: number): void {
		const count = this.list.entries.length;
		if (count === 0) return;
		if (Math.abs(delta) === 1) this.cursor = (this.cursor + delta + count) % count;
		else this.cursor = Math.min(count - 1, Math.max(0, this.cursor + delta));
		this.keepVisible();
	}

	private keepVisible(): void {
		const count = this.list.entries.length;
		const rows = Math.min(this.visibleRows, count);
		if (this.cursor < this.scroll) this.scroll = this.cursor;
		if (this.cursor >= this.scroll + rows) this.scroll = this.cursor - rows + 1;
		this.scroll = Math.max(0, Math.min(this.scroll, count - rows));
	}

	/** One line about where the list came from, for the screen's footer. */
	sourceLine(): string {
		const count = this.list.entries.length;
		const models = `${count} decision model${count === 1 ? "" : "s"}`;
		switch (this.list.source) {
			case "live":
				return `${models}, live from openrouter.ai`;
			case "cache":
				return `${models} from openrouter.ai (cached for 24 h)`;
			case "stale-cache":
				return `${models} from an older openrouter.ai list (refreshing…)`;
			case "builtin":
				return `${models} built in (openrouter.ai list unavailable)`;
		}
	}

	/**
	 * The visible rows. `row` draws one entry; the id column is padded to the widest visible id. Scroll markers
	 * ("↑ 3 more", "↓ 9 more") are returned as separate lines, drawn by `more`.
	 */
	render(row: (selected: boolean, label: string, hint: string) => string, more: (text: string) => string): string[] {
		const window = this.window();
		const lines: string[] = [];
		lines.push(window.above > 0 ? more(`↑ ${window.above} more`) : "");
		for (const item of window.items) lines.push(row(item.selected, item.label, item.hint));
		lines.push(window.below > 0 ? more(`↓ ${window.below} more`) : "");
		return lines;
	}

	/** The visible entries with their padded labels, and how many are hidden above and below. */
	window(): {
		above: number;
		below: number;
		items: Array<{ id: string; selected: boolean; label: string; hint: string }>;
	} {
		const entries = this.list.entries;
		const rows = Math.min(this.visibleRows, entries.length);
		const visible = entries.slice(this.scroll, this.scroll + rows);
		const width = Math.max(0, ...visible.map((entry) => entry.id.length));
		return {
			above: this.scroll,
			below: entries.length - this.scroll - rows,
			items: visible.map((entry, offset) => ({
				id: entry.id,
				selected: this.scroll + offset === this.cursor,
				label: entry.id.padEnd(width),
				hint: decisionModelHint(entry),
			})),
		};
	}
}
