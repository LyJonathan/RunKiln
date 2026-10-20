import { type Component, getKeybindings, matchesKey, truncateToWidth, visibleWidth } from "@runkiln/tui";
import { theme } from "../theme/theme.ts";
import {
	FOOTER_ITEM_IDS,
	FOOTER_ITEMS,
	FOOTER_LINE_BREAK,
	type FooterItemEntry,
	type FooterItemId,
	normalizeFooterItems,
} from "./footer.ts";
import { keyDisplayText } from "./keybinding-hints.ts";

/** The default layout as items, used as the starting point when `footer.items` is unset. */
export const DEFAULT_FOOTER_ITEMS: readonly FooterItemEntry[] = [
	"cwd",
	"branch",
	"session",
	"permissions",
	FOOTER_LINE_BREAK,
	"cost",
	"cache",
	"context",
	"router",
	"model",
	"thinking",
];

interface PickerRow {
	entry: FooterItemEntry;
	enabled: boolean;
}

export interface StatusLinePickerOptions {
	/** The current `footer.items` setting (undefined: default layout). */
	items: readonly string[] | undefined;
	/** The footer as it would render with these items (undefined: the default layout). */
	preview: (items: FooterItemEntry[] | undefined, width: number) => string[];
	onSave: (items: FooterItemEntry[] | undefined) => void;
	onCancel: () => void;
}

/**
 * `/statusline`: toggle and reorder footer items with a live preview, then save `footer.items`.
 * Space/Enter toggles, Alt+Up/Down moves, r goes back to the default layout, Ctrl+S saves, Esc cancels.
 */
export class StatusLinePickerComponent implements Component {
	private rows: PickerRow[];
	private selected = 0;
	/** True while the picker shows the untouched default layout (saving keeps `footer.items` unset). */
	private isDefault: boolean;
	private dirty = false;
	private readonly options: StatusLinePickerOptions;

	constructor(options: StatusLinePickerOptions) {
		this.options = options;
		const current = normalizeFooterItems(options.items);
		this.isDefault = current === undefined;
		this.rows = StatusLinePickerComponent.rowsFor(current ?? DEFAULT_FOOTER_ITEMS);
	}

	private static rowsFor(entries: readonly FooterItemEntry[]): PickerRow[] {
		const rows: PickerRow[] = entries.map((entry) => ({ entry, enabled: true }));
		for (const id of FOOTER_ITEM_IDS) {
			if (!entries.includes(id)) rows.push({ entry: id, enabled: false });
		}
		if (!entries.includes(FOOTER_LINE_BREAK)) rows.push({ entry: FOOTER_LINE_BREAK, enabled: false });
		return rows;
	}

	/** The items the picker would save (undefined: default layout). */
	get value(): FooterItemEntry[] | undefined {
		if (this.isDefault) return undefined;
		return normalizeFooterItems(this.rows.filter((row) => row.enabled).map((row) => row.entry));
	}

	invalidate(): void {}

	private changed(): void {
		this.isDefault = false;
		this.dirty = true;
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		if (kb.matches(data, "app.models.reorderUp") || kb.matches(data, "app.models.reorderDown")) {
			const delta = kb.matches(data, "app.models.reorderUp") ? -1 : 1;
			const target = this.selected + delta;
			if (target < 0 || target >= this.rows.length) return;
			[this.rows[this.selected], this.rows[target]] = [this.rows[target]!, this.rows[this.selected]!];
			this.selected = target;
			this.changed();
			return;
		}
		if (kb.matches(data, "tui.select.up")) {
			this.selected = this.selected === 0 ? this.rows.length - 1 : this.selected - 1;
			return;
		}
		if (kb.matches(data, "tui.select.down")) {
			this.selected = this.selected === this.rows.length - 1 ? 0 : this.selected + 1;
			return;
		}
		if (kb.matches(data, "app.models.save")) {
			this.options.onSave(this.value);
			return;
		}
		if (kb.matches(data, "tui.select.cancel")) {
			this.options.onCancel();
			return;
		}
		if (kb.matches(data, "tui.select.confirm") || matchesKey(data, "space")) {
			const row = this.rows[this.selected];
			if (!row) return;
			row.enabled = !row.enabled;
			this.changed();
			return;
		}
		if (data === "r" || data === "R") {
			this.rows = StatusLinePickerComponent.rowsFor(DEFAULT_FOOTER_ITEMS);
			this.selected = 0;
			this.isDefault = true;
			this.dirty = true;
		}
	}

	render(width: number): string[] {
		const lines: string[] = [];
		const rule = theme.fg("borderMuted", "─".repeat(Math.max(0, width)));
		lines.push(rule);
		const title = theme.bold(theme.fg("accent", " Status line"));
		const state = this.isDefault
			? theme.fg("muted", " - default layout")
			: theme.fg("muted", ` - ${this.value?.filter((entry) => entry !== FOOTER_LINE_BREAK).length ?? 0} items`);
		lines.push(truncateToWidth(`${title}${state}${this.dirty ? theme.fg("warning", " (unsaved)") : ""}`, width, ""));
		lines.push("");
		const labelWidth = Math.max(...FOOTER_ITEM_IDS.map((id) => visibleWidth(FOOTER_ITEMS[id].label)), 10);
		for (const [index, row] of this.rows.entries()) {
			const selected = index === this.selected;
			const pointer = selected ? theme.fg("accent", "→ ") : "  ";
			const check = row.enabled ? theme.fg("success", "[x]") : theme.fg("dim", "[ ]");
			let label: string;
			let description: string;
			if (row.entry === FOOTER_LINE_BREAK) {
				label = "Line break";
				description = "Start a new footer line here";
			} else {
				const info = FOOTER_ITEMS[row.entry as FooterItemId];
				label = info.label;
				description = info.description;
			}
			const name = selected ? theme.fg("accent", label.padEnd(labelWidth)) : label.padEnd(labelWidth);
			const text = `${pointer}${check} ${name}  ${theme.fg("muted", description)}`;
			lines.push(truncateToWidth(text, width, theme.fg("dim", "…")));
		}
		lines.push("");
		lines.push(truncateToWidth(theme.fg("muted", " Preview"), width, ""));
		for (const line of this.options.preview(this.value, width)) lines.push(line);
		lines.push("");
		const hints = [
			`${keyDisplayText("tui.select.confirm")}/space toggle`,
			`${keyDisplayText("app.models.reorderUp")}/${keyDisplayText("app.models.reorderDown")} move`,
			"r default",
			`${keyDisplayText("app.models.save")} save`,
			`${keyDisplayText("tui.select.cancel")} cancel`,
		];
		lines.push(truncateToWidth(theme.fg("dim", ` ${hints.join(" - ")}`), width, ""));
		lines.push(rule);
		return lines;
	}
}
