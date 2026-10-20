/**
 * A small action menu (right click or "..." on a card, a click on a footer badge). Keys: up/down and enter, the
 * item's key letter, esc closes. Mouse: hover highlights, click picks, a press outside closes it.
 */

import {
	ClickableRows,
	type Component,
	type Focusable,
	getKeybindings,
	HitMap,
	type OverlayHandle,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
	visibleWidth,
} from "@runkiln/tui";
import { theme } from "../theme/theme.ts";

export interface ContextMenuItem {
	id: string;
	label: string;
	/** A single key that picks it, shown on the right. */
	key?: string;
	/** Shown in the error colour (destructive or risky). */
	danger?: boolean;
}

const MAX_LABEL = 32;

export class ContextMenu implements Component, Focusable {
	focused = false;
	private selected = 0;
	private readonly hits = new HitMap<number>();
	private readonly rows = new ClickableRows<number>();
	private readonly title: string | undefined;
	private readonly items: ContextMenuItem[];
	private readonly onPick: (item: ContextMenuItem) => void;
	private readonly onClose: () => void;
	private done = false;

	constructor(
		title: string | undefined,
		items: ContextMenuItem[],
		onPick: (item: ContextMenuItem) => void,
		onClose: () => void,
	) {
		this.title = title;
		this.items = items;
		this.onPick = onPick;
		this.onClose = onClose;
	}

	/** Columns the menu wants, borders included. */
	get preferredWidth(): number {
		const labels = this.items.map((item) => Math.min(MAX_LABEL, visibleWidth(item.label)));
		const keys = this.items.map((item) => (item.key ? visibleWidth(item.key) + 3 : 0));
		const body = Math.max(...labels.map((label, index) => label + keys[index]!), 8);
		const title = this.title ? Math.min(MAX_LABEL, visibleWidth(this.title)) + 2 : 0;
		return Math.max(body, title) + 4;
	}

	get preferredHeight(): number {
		return this.items.length + 2;
	}

	private pick(index: number): void {
		const item = this.items[index];
		if (!item || this.done) return;
		this.done = true;
		this.onPick(item);
	}

	close(): void {
		if (this.done) return;
		this.done = true;
		this.onClose();
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		if (kb.matches(data, "tui.select.up")) {
			this.selected = (this.selected - 1 + this.items.length) % this.items.length;
		} else if (kb.matches(data, "tui.select.down")) {
			this.selected = (this.selected + 1) % this.items.length;
		} else if (kb.matches(data, "tui.select.confirm")) {
			this.pick(this.selected);
		} else if (kb.matches(data, "tui.select.cancel")) {
			this.close();
		} else if (data.length === 1) {
			const index = this.items.findIndex((item) => item.key?.toLowerCase() === data.toLowerCase());
			if (index >= 0) this.pick(index);
		}
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		const value = event.type === "leave" ? undefined : this.hits.at(event.x, event.y);
		const result = this.rows.handle(value, event, {
			select: (index) => {
				this.selected = index;
			},
			activate: (index) => this.pick(index),
			wheel: (delta) => {
				this.selected = Math.max(0, Math.min(this.items.length - 1, this.selected + delta));
			},
		});
		// Inside the menu but not on an item: keep the event so nothing behind the menu reacts.
		return result ?? (event.type === "press" || event.type === "click" ? { handled: true } : undefined);
	}

	invalidate(): void {}

	render(width: number): string[] {
		this.hits.reset();
		const inner = Math.max(4, width - 2);
		const border = (text: string) => theme.fg("borderAccent", text);
		const lines: string[] = [];
		const title = this.title ? ` ${truncateToWidth(this.title, inner - 2, "…")} ` : "";
		lines.push(border(`╭${theme.bold(title)}${"─".repeat(Math.max(0, inner - visibleWidth(title)))}╮`));
		this.items.forEach((item, index) => {
			const active = index === this.selected;
			const hovered = !active && this.rows.isHovered(index);
			const key = item.key ? theme.fg("dim", item.key) : "";
			const keyWidth = item.key ? visibleWidth(item.key) : 0;
			const labelRoom = Math.max(1, inner - 2 - (keyWidth ? keyWidth + 2 : 0));
			const labelText = truncateToWidth(item.label, labelRoom, "…");
			const label = theme.fg(item.danger ? "error" : active ? "accent" : "text", labelText);
			const gap = " ".repeat(Math.max(1, inner - 2 - visibleWidth(labelText) - keyWidth));
			let row = ` ${active ? theme.bold(label) : label}${gap}${key} `;
			row = truncateToWidth(row, inner, "");
			row += " ".repeat(Math.max(0, inner - visibleWidth(row)));
			if (active) row = theme.bg("selectedBg", row);
			else if (hovered) row = theme.bg("toolPendingBg", row);
			this.hits.add(lines.length, index, 1, 1 + inner);
			lines.push(`${border("│")}${row}${border("│")}`);
		});
		lines.push(border(`╰${"─".repeat(inner)}╯`));
		return lines;
	}
}

/**
 * Show a menu at a screen position (a click), kept inside the terminal. Closes on pick, esc or a press outside.
 * Returns the overlay handle.
 */
export function showContextMenu(
	ui: TUI,
	options: {
		title?: string;
		items: ContextMenuItem[];
		x: number;
		y: number;
		onPick: (item: ContextMenuItem) => void;
	},
): OverlayHandle {
	let handle: OverlayHandle | undefined;
	const hide = () => {
		handle?.hide();
		ui.requestRender();
	};
	const menu = new ContextMenu(
		options.title,
		options.items,
		(item) => {
			hide();
			options.onPick(item);
		},
		hide,
	);
	const columns = Math.max(1, ui.terminal.columns);
	const rows = Math.max(1, ui.terminal.rows);
	const width = Math.min(columns, menu.preferredWidth);
	const height = menu.preferredHeight;
	const col = Math.max(0, Math.min(options.x, columns - width));
	// Open below the pointer when it fits, else above it.
	const row = options.y + 1 + height <= rows ? options.y + 1 : Math.max(0, options.y - height);
	handle = ui.showOverlay(menu, { width, row, col, onOutsidePress: () => menu.close() });
	ui.requestRender();
	return handle;
}
