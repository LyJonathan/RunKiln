/**
 * The todo list above the editor (see core/runkiln/todo.ts). Hidden when there is no list or every item is done.
 * Collapsed, it shows the item in progress and the next ones; expanded (the tool-output toggle, or /todo), every item.
 */

import type { Component } from "@runkiln/tui";
import { renderTodoLines, type TodoItem, todoSummaryLabel } from "../../../core/runkiln/todo.ts";
import { theme } from "../theme/theme.ts";

/** Lists up to this long are shown whole even when collapsed. */
const COLLAPSED_MAX = 5;

export class TodoPanelComponent implements Component {
	private items: TodoItem[] = [];
	private expanded = false;

	setItems(items: readonly TodoItem[]): void {
		this.items = [...items];
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
	}

	get isExpanded(): boolean {
		return this.expanded;
	}

	/** Whether the panel has anything to show. */
	get visible(): boolean {
		return this.items.length > 0 && this.items.some((item) => item.status !== "done");
	}

	invalidate(): void {}

	render(width: number): string[] {
		if (!this.visible) return [];
		const items = this.items;
		// Flush with the editor's left edge (column 0).
		const pad = "";
		const header = `${pad}${theme.fg("accent", theme.bold(todoSummaryLabel(items)))}`;
		let shown: TodoItem[] = items;
		let hidden = 0;
		if (!this.expanded && items.length > COLLAPSED_MAX) {
			// The item in progress and what follows it; finished items fold into the header count.
			const start = Math.max(
				0,
				items.findIndex((item) => item.status !== "done"),
			);
			shown = items.slice(start, start + COLLAPSED_MAX - 1);
			hidden = items.length - shown.length;
		}
		const lines = renderTodoLines(shown, theme, width - pad.length * 2).map((line) => `${pad}${line}`);
		if (hidden > 0) lines.push(`${pad}${theme.fg("dim", `… ${hidden} more (/todo to expand)`)}`);
		return [header, ...lines];
	}
}
