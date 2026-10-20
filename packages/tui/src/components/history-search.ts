import { fuzzyFilter } from "../fuzzy.ts";
import { getKeybindings } from "../keybindings.ts";
import type { Component, Focusable, TuiMouseEvent, TuiMouseEventResult } from "../tui.ts";
import { truncateToWidth, visibleWidth } from "../utils.ts";
import { Input } from "./input.ts";
import { type SelectItem, SelectList, type SelectListTheme } from "./select-list.ts";

/** One prompt in the history search list, most recent first. */
export interface HistorySearchItem {
	text: string;
	/** Short dim prefix such as "2h" or "3d - api". */
	detail?: string;
}

export interface HistorySearchScope {
	id: string;
	label: string;
}

export interface HistorySearchTheme {
	border: (text: string) => string;
	title: (text: string) => string;
	scopeActive: (text: string) => string;
	scopeInactive: (text: string) => string;
	match: (text: string) => string;
	detail: (text: string) => string;
	hint: (text: string) => string;
	selectList: SelectListTheme;
}

export interface HistorySearchOptions {
	scopes: readonly HistorySearchScope[];
	initialScope?: string;
	/** Entries for a scope, most recent first. Called again whenever the scope changes. */
	load: (scopeId: string) => HistorySearchItem[];
	/** "replace": Enter puts the prompt in the editor. "edit": Tab inserts it at the cursor. */
	onAccept: (text: string, mode: "replace" | "edit") => void;
	onCancel: () => void;
	theme: HistorySearchTheme;
	maxVisible?: number;
	initialQuery?: string;
	/** Hint line text; defaults to one built from the keybindings. */
	hint?: string;
}

/**
 * Positions in `text` that a fuzzy `query` matched, using the same in-order scan as fuzzyMatch for each
 * whitespace-separated token. Used to highlight matches; returns an empty set when nothing matches.
 */
export function fuzzyHighlightIndices(query: string, text: string): Set<number> {
	const indices = new Set<number>();
	const lower = text.toLowerCase();
	for (const token of query.toLowerCase().split(/[\s/]+/)) {
		if (!token) continue;
		const consecutive = lower.indexOf(token);
		if (consecutive !== -1) {
			for (let i = 0; i < token.length; i++) indices.add(consecutive + i);
			continue;
		}
		let from = 0;
		const found: number[] = [];
		for (const char of token) {
			const at = lower.indexOf(char, from);
			if (at === -1) return new Set();
			found.push(at);
			from = at + 1;
		}
		for (const at of found) indices.add(at);
	}
	return indices;
}

function preview(text: string): string {
	return text
		.trim()
		.replace(/\r?\n/g, " ↵ ")
		.replace(/[\t ]+/g, " ");
}

/**
 * Ctrl+R prompt-history search: a fuzzy query over persistent prompt history with a scope that cycles
 * (session → project → all). Meant to be shown as an overlay above the editor.
 */
export class HistorySearch implements Component, Focusable {
	private readonly options: HistorySearchOptions;
	private readonly input: Input;
	private readonly list: SelectList;
	private scopeIndex: number;
	private entries: HistorySearchItem[] = [];
	private filtered: HistorySearchItem[] = [];
	private lastQuery = "";
	private _focused = false;
	private readonly maxVisible: number;

	constructor(options: HistorySearchOptions) {
		this.options = options;
		this.maxVisible = Math.max(3, options.maxVisible ?? 10);
		const initial = options.scopes.findIndex((scope) => scope.id === options.initialScope);
		this.scopeIndex = initial === -1 ? 0 : initial;
		this.input = new Input({ prompt: "" });
		if (options.initialQuery) this.input.setValue(options.initialQuery);
		this.list = new SelectList([], this.maxVisible, options.theme.selectList, {
			minPrimaryColumnWidth: 1000,
			maxPrimaryColumnWidth: 1000,
			truncatePrimary: ({ item, maxWidth }) => this.renderItemLabel(item, maxWidth),
		});
		this.list.onSelect = (item) => this.accept(item, "replace");
		this.reload();
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value;
	}

	getScope(): string {
		return this.options.scopes[this.scopeIndex]?.id ?? "";
	}

	getQuery(): string {
		return this.input.getValue();
	}

	/** The entries shown for the current scope and query, best match first. */
	getMatches(): HistorySearchItem[] {
		return [...this.filtered];
	}

	getSelected(): HistorySearchItem | undefined {
		const item = this.list.getSelectedItem();
		return item ? this.filtered[Number(item.value)] : undefined;
	}

	cycleScope(): void {
		if (this.options.scopes.length === 0) return;
		this.scopeIndex = (this.scopeIndex + 1) % this.options.scopes.length;
		this.reload();
	}

	private reload(): void {
		this.entries = this.options.load(this.getScope());
		this.refilter();
	}

	private refilter(): void {
		this.lastQuery = this.input.getValue();
		this.filtered = fuzzyFilter(this.entries, this.lastQuery, (entry) => entry.text);
		this.list.setItems(
			this.filtered.map<SelectItem>((entry, index) => ({ value: String(index), label: preview(entry.text) })),
		);
	}

	private accept(item: SelectItem | null, mode: "replace" | "edit"): void {
		const entry = item ? this.filtered[Number(item.value)] : undefined;
		if (entry) this.options.onAccept(entry.text, mode);
	}

	private renderItemLabel(item: SelectItem, maxWidth: number): string {
		const entry = this.filtered[Number(item.value)];
		if (!entry) return "";
		const theme = this.options.theme;
		const detail = entry.detail ? `${entry.detail}  ` : "";
		const detailWidth = Math.min(visibleWidth(detail), Math.max(0, maxWidth - 8));
		const prefix = detail ? theme.detail(truncateToWidth(detail, detailWidth, "")) : "";
		const room = Math.max(1, maxWidth - detailWidth);
		const text = truncateToWidth(item.label, room, "…");
		const hits = this.lastQuery.trim() ? fuzzyHighlightIndices(this.lastQuery, item.label) : new Set<number>();
		if (hits.size === 0) return prefix + text;
		let out = "";
		let index = 0;
		for (const char of text) {
			out += hits.has(index) ? theme.match(char) : char;
			index += char.length;
		}
		return prefix + out;
	}

	private defaultHint(): string {
		const kb = getKeybindings();
		const key = (id: Parameters<typeof kb.getKeys>[0]) => (kb.getKeys(id)[0] ?? "").replace(/^escape$/, "esc");
		return [
			`${key("tui.select.confirm")} insert`,
			`${key("tui.historySearch.edit")} edit`,
			`${key("tui.historySearch.cycleScope")} scope`,
			`${key("tui.editor.historySearch")} older`,
			`${key("tui.select.cancel")} close`,
		].join(" - ");
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		if (kb.matches(data, "tui.select.cancel")) {
			this.options.onCancel();
			return;
		}
		if (kb.matches(data, "tui.select.confirm")) {
			this.accept(this.list.getSelectedItem(), "replace");
			return;
		}
		if (kb.matches(data, "tui.historySearch.edit")) {
			this.accept(this.list.getSelectedItem(), "edit");
			return;
		}
		if (kb.matches(data, "tui.historySearch.cycleScope")) {
			this.cycleScope();
			return;
		}
		if (kb.matches(data, "tui.editor.historySearch") || kb.matches(data, "tui.select.down")) {
			// Older match; stop at the end instead of wrapping back to the newest.
			const index = this.list.getSelectedIndex();
			if (index < this.filtered.length - 1) this.list.setSelectedIndex(index + 1);
			return;
		}
		if (kb.matches(data, "tui.select.up")) {
			this.list.setSelectedIndex(Math.max(0, this.list.getSelectedIndex() - 1));
			return;
		}
		if (kb.matches(data, "tui.select.pageDown")) {
			this.list.setSelectedIndex(this.list.getSelectedIndex() + this.maxVisible);
			return;
		}
		if (kb.matches(data, "tui.select.pageUp")) {
			this.list.setSelectedIndex(Math.max(0, this.list.getSelectedIndex() - this.maxVisible));
			return;
		}
		this.input.handleInput(data);
		if (this.input.getValue() !== this.lastQuery) this.refilter();
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		// Rows: 0 top border, 1 query, 2 rule, then the list.
		const listTop = 3;
		if (event.y < listTop || event.y >= listTop + this.maxVisible) return undefined;
		return this.list.handleMouse({ ...event, x: Math.max(0, event.x - 2), y: event.y - listTop });
	}

	invalidate(): void {
		this.input.invalidate();
		this.list.invalidate();
	}

	render(width: number): string[] {
		const theme = this.options.theme;
		const inner = Math.max(1, width - 4);
		const side = theme.border("│");
		const row = (content: string) => {
			const fitted = truncateToWidth(content, inner, "");
			return `${side} ${fitted}${" ".repeat(Math.max(0, inner - visibleWidth(fitted)))} ${side}`;
		};

		// Top border: title on the left, scopes on the right.
		const title = ` ${theme.title("Prompt history")} `;
		const scopes = this.options.scopes
			.map((scope, index) =>
				index === this.scopeIndex ? theme.scopeActive(`[${scope.label}]`) : theme.scopeInactive(scope.label),
			)
			.join(theme.border(" - "));
		const scopesBlock = this.options.scopes.length > 0 ? ` ${scopes} ` : "";
		let fill = width - 2 - visibleWidth(title) - visibleWidth(scopesBlock) - 1;
		const lines: string[] = [];
		if (fill >= 1) {
			lines.push(theme.border("╭─") + title + theme.border("─".repeat(fill)) + scopesBlock + theme.border("╮"));
		} else {
			fill = Math.max(0, width - 3 - visibleWidth(title));
			lines.push(truncateToWidth(theme.border("╭─") + title + theme.border(`${"─".repeat(fill)}╮`), width, ""));
		}

		const queryPrompt = theme.hint("search › ");
		const inputLine = this.input.render(Math.max(1, inner - visibleWidth("search › ")))[0] ?? "";
		lines.push(row(queryPrompt + inputLine));
		lines.push(theme.border(`├${"─".repeat(Math.max(0, width - 2))}┤`));

		const listLines =
			this.filtered.length === 0
				? [theme.selectList.noMatch(this.entries.length === 0 ? "  No prompts saved yet" : "  No matching prompts")]
				: this.list.render(inner);
		for (let i = 0; i < this.maxVisible + 1; i++) lines.push(row(listLines[i] ?? ""));

		const hint = this.options.hint ?? this.defaultHint();
		lines.push(row(theme.hint(truncateToWidth(hint, inner, "…"))));
		lines.push(theme.border(`╰${"─".repeat(Math.max(0, width - 2))}╯`));
		return lines;
	}
}
