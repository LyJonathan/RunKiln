/**
 * The `?` shortcut sheet: every key that works at the prompt, grouped, built from the keybinding
 * registry's descriptions (so rebinds in keybindings.json show up). Type to filter, ↑↓ / PgUp / PgDn to
 * scroll, Esc or ? to close. On macOS without the kitty keyboard protocol it warns that Alt chords need
 * Option-as-Meta and says where to turn it on for the detected terminal (TERM_PROGRAM).
 */

import {
	type Component,
	type Focusable,
	fuzzyFilter,
	getKeybindings,
	Input,
	type KeyId,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@runkiln/tui";
import { theme } from "../theme/theme.ts";
import { formatKeyText } from "./keybinding-hints.ts";

export interface ShortcutRow {
	group: string;
	keys: string;
	description: string;
	/** Uses an Alt chord (needs Option-as-Meta on macOS terminals without the kitty protocol). */
	alt: boolean;
}

/** Keybinding ids per group, in display order. Selector-only bindings are left out on purpose. */
export const SHORTCUT_GROUPS: ReadonlyArray<{ group: string; ids: readonly string[] }> = [
	{
		group: "Prompt",
		ids: [
			"tui.input.submit",
			"tui.input.newLine",
			"tui.input.tab",
			"tui.editor.historySearch",
			"app.editor.stash",
			"app.editor.external",
			"app.clipboard.pasteImage",
			"app.clear",
			"app.exit",
		],
	},
	{
		group: "Agent",
		ids: [
			"app.interrupt",
			"app.message.followUp",
			"app.message.dequeue",
			"app.tools.expand",
			"app.thinking.toggle",
			"app.message.copy",
		],
	},
	{
		group: "Models & modes",
		ids: [
			"app.router.cycleMode",
			"app.permissions.cycle",
			"app.thinking.cycle",
			"app.model.select",
			"app.model.cycleForward",
			"app.model.cycleBackward",
		],
	},
	{
		group: "Session",
		ids: ["app.session.new", "app.session.tree", "app.session.fork", "app.session.resume", "app.suspend"],
	},
	{
		group: "Editing",
		ids: [
			"tui.editor.cursorWordLeft",
			"tui.editor.cursorWordRight",
			"tui.editor.cursorLineStart",
			"tui.editor.cursorLineEnd",
			"tui.editor.deleteWordBackward",
			"tui.editor.deleteWordForward",
			"tui.editor.deleteToLineStart",
			"tui.editor.deleteToLineEnd",
			"tui.editor.yank",
			"tui.editor.yankPop",
			"tui.editor.undo",
			"tui.editor.jumpForward",
			"tui.editor.jumpBackward",
		],
	},
	{
		group: "Transcript",
		ids: [
			"tui.altScreen.pageUp",
			"tui.altScreen.pageDown",
			"tui.altScreen.previousPrompt",
			"tui.altScreen.nextPrompt",
			"tui.altScreen.top",
			"tui.altScreen.bottom",
			"tui.altScreen.search",
		],
	},
	{
		group: "History search (Ctrl+R)",
		ids: ["tui.historySearch.cycleScope", "tui.historySearch.edit"],
	},
];

const PREFIX_ROWS: ReadonlyArray<Omit<ShortcutRow, "alt">> = [
	{ group: "Prompt", keys: "/", description: "Slash commands (/help lists them)" },
	{ group: "Prompt", keys: "@", description: "Mention a file" },
	{ group: "Prompt", keys: "!  !!", description: "Run a bash command (!! keeps it out of context)" },
	{ group: "Prompt", keys: "?", description: "This sheet (on an empty prompt)" },
	{ group: "Prompt", keys: "← then enter", description: "On a paste or image chip: open it" },
];

interface KeyLookup {
	getKeys(id: never): KeyId[];
	getDefinition(id: never): { description?: string } | undefined;
}

/** The rows of the sheet, from the live keybindings (unbound actions are skipped). */
export function buildShortcutRows(keybindings: KeyLookup = getKeybindings() as unknown as KeyLookup): ShortcutRow[] {
	const rows: ShortcutRow[] = [];
	for (const { group, ids } of SHORTCUT_GROUPS) {
		if (group === "Prompt") for (const row of PREFIX_ROWS) rows.push({ ...row, alt: false });
		for (const id of ids) {
			let keys: KeyId[] = [];
			let description: string | undefined;
			try {
				keys = keybindings.getKeys(id as never);
				description = keybindings.getDefinition(id as never)?.description;
			} catch {
				continue;
			}
			if (keys.length === 0 || !description) continue;
			rows.push({
				group,
				keys: formatKeyText(keys.slice(0, 2).join("/")),
				description,
				alt: keys.some((key) => /(^|\+)alt\+/.test(key) || key.startsWith("alt+")),
			});
		}
	}
	return rows;
}

export interface OptionAsMetaContext {
	platform: NodeJS.Platform;
	env: NodeJS.ProcessEnv;
	/** Kitty keyboard protocol (or modifyOtherKeys) is active, so Alt arrives as Alt anyway. */
	enhancedKeys: boolean;
}

/** The Option-as-Meta warning for macOS terminals that need it, naming where to turn it on. */
export function optionAsMetaWarning(context: OptionAsMetaContext): string | undefined {
	if (context.platform !== "darwin" || context.enhancedKeys) return undefined;
	const program = context.env.TERM_PROGRAM ?? "";
	const where: Record<string, string> = {
		Apple_Terminal: "Terminal ▸ Settings ▸ Profiles ▸ Keyboard ▸ “Use Option as Meta key”",
		"iTerm.app": "iTerm2 ▸ Settings ▸ Profiles ▸ Keys ▸ Left Option key: Esc+",
		vscode: 'VS Code setting "terminal.integrated.macOptionIsMeta": true',
		WezTerm: "WezTerm config: send_composed_key_when_left_alt_is_pressed = false",
		ghostty: "Ghostty config: macos-option-as-alt = true",
		Alacritty: 'Alacritty config: [window] option_as_alt = "Both"',
	};
	const fix = where[program] ?? "your terminal's “Use Option as Meta” setting";
	return `Option (Alt) shortcuts marked * need Option as Meta: ${fix}.`;
}

export interface ShortcutSheetOptions {
	rows: ShortcutRow[];
	warning?: string;
	onClose: () => void;
	/** Rows of the list area (the box adds 5 more). */
	maxVisible?: number;
}

/** Overlay listing shortcuts by group. */
export class ShortcutSheet implements Component, Focusable {
	private readonly options: ShortcutSheetOptions;
	private readonly input = new Input({ prompt: "" });
	private scroll = 0;
	private _focused = false;
	private lastQuery = "";
	private lastPageSize = 10;

	constructor(options: ShortcutSheetOptions) {
		this.options = options;
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value;
	}

	/** Display lines (group headers and rows) for the current filter, before scrolling. */
	getLines(width: number): string[] {
		const query = this.input.getValue();
		const rows = query.trim()
			? fuzzyFilter(this.options.rows, query, (row) => `${row.keys} ${row.description} ${row.group}`)
			: this.options.rows;
		const keyWidth = Math.min(
			22,
			Math.max(8, ...rows.map((row) => visibleWidth(row.keys) + (row.alt && this.options.warning ? 1 : 0))),
		);
		const lines: string[] = [];
		let group = "";
		for (const row of query.trim() ? [...rows].sort((a, b) => groupIndex(a) - groupIndex(b)) : rows) {
			if (row.group !== group) {
				group = row.group;
				if (lines.length > 0) lines.push("");
				lines.push(theme.bold(theme.fg("accent", group)));
			}
			const mark = row.alt && this.options.warning ? "*" : "";
			const keys = truncateToWidth(`${row.keys}${mark}`, keyWidth, "…");
			const pad = " ".repeat(Math.max(1, keyWidth - visibleWidth(keys) + 2));
			const description = truncateToWidth(row.description, Math.max(4, width - keyWidth - 4), "…");
			lines.push(`  ${theme.fg("text", keys)}${pad}${theme.fg("muted", description)}`);
		}
		if (lines.length === 0) lines.push(theme.fg("dim", "  No matching shortcuts"));
		return lines;
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		if (kb.matches(data, "tui.select.cancel") || (data === "?" && this.input.getValue() === "")) {
			this.options.onClose();
			return;
		}
		if (kb.matches(data, "tui.select.down")) {
			this.scroll++;
			return;
		}
		if (kb.matches(data, "tui.select.up")) {
			this.scroll = Math.max(0, this.scroll - 1);
			return;
		}
		if (kb.matches(data, "tui.select.pageDown")) {
			this.scroll += this.lastPageSize;
			return;
		}
		if (kb.matches(data, "tui.select.pageUp")) {
			this.scroll = Math.max(0, this.scroll - this.lastPageSize);
			return;
		}
		if (kb.matches(data, "tui.select.confirm")) return;
		this.input.handleInput(data);
		if (this.input.getValue() !== this.lastQuery) {
			this.lastQuery = this.input.getValue();
			this.scroll = 0;
		}
	}

	invalidate(): void {
		this.input.invalidate();
	}

	render(width: number): string[] {
		const inner = Math.max(1, width - 4);
		const border = (text: string) => theme.fg("border", text);
		const row = (content: string) => {
			const fitted = truncateToWidth(content, inner, "");
			return `${border("│")} ${fitted}${" ".repeat(Math.max(0, inner - visibleWidth(fitted)))} ${border("│")}`;
		};
		const title = ` ${theme.bold(theme.fg("accent", "Keyboard shortcuts"))} `;
		const lines: string[] = [];
		lines.push(border("╭─") + title + border(`${"─".repeat(Math.max(0, width - 3 - visibleWidth(title)))}╮`));
		if (this.options.warning) {
			for (const line of wrapTextWithAnsi(theme.fg("warning", this.options.warning), inner)) lines.push(row(line));
		}
		lines.push(row(theme.fg("dim", "filter › ") + (this.input.render(Math.max(1, inner - 9))[0] ?? "")));
		lines.push(border(`├${"─".repeat(Math.max(0, width - 2))}┤`));

		const body = this.getLines(inner);
		const pageSize = Math.max(3, this.options.maxVisible ?? 16);
		this.lastPageSize = pageSize;
		const maxScroll = Math.max(0, body.length - pageSize);
		this.scroll = Math.min(this.scroll, maxScroll);
		const visible = body.slice(this.scroll, this.scroll + pageSize);
		for (let i = 0; i < pageSize; i++) lines.push(row(visible[i] ?? ""));

		const position =
			body.length > pageSize
				? `${this.scroll + 1}-${Math.min(body.length, this.scroll + pageSize)}/${body.length} - `
				: "";
		lines.push(
			row(theme.fg("dim", `${position}type to filter - ↑↓ scroll - esc close - rebind in keybindings.json`)),
		);
		lines.push(border(`╰${"─".repeat(Math.max(0, width - 2))}╯`));
		return lines;
	}
}

function groupIndex(row: ShortcutRow): number {
	const index = SHORTCUT_GROUPS.findIndex((group) => group.group === row.group);
	return index === -1 ? SHORTCUT_GROUPS.length : index;
}
