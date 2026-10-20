/**
 * The dim key-hint line under the editor: the three to five keys that matter in the current state
 * (idle, a draft, streaming, an approval, a selection, a chip under the cursor, an image attached).
 * Hidden when the setting `ui.hints` is off and on terminals shorter than {@link KEY_HINT_MIN_ROWS}.
 */

import type { Component } from "@runkiln/tui";
import { truncateToWidth, visibleWidth } from "@runkiln/tui";
import type { AppKeybinding } from "../../../core/keybindings.ts";
import { theme } from "../theme/theme.ts";
import { formatKeyText, keyText } from "./keybinding-hints.ts";

export const KEY_HINT_MIN_ROWS = 20;

export type KeyHintMode =
	| "approval"
	| "selection"
	| "autocomplete"
	| "history-search"
	| "chip"
	| "streaming"
	| "image"
	| "draft"
	| "idle";

export interface KeyHintState {
	mode: KeyHintMode;
	/** For "approval": a tool permission prompt (default) or the plan-mode approval. */
	approvalKind?: "permission" | "plan";
	/** For "chip": which kind of chip the cursor is on. */
	chipKind?: "paste" | "image";
	/** For a paste chip: Enter opens $EDITOR (true) or expands inline (false). */
	pasteOpensEditor?: boolean;
	/** Messages are queued (Alt+Up edits them). */
	queued?: boolean;
	/** A draft is stashed (the stash key brings it back). */
	stashed?: boolean;
}

export interface KeyHint {
	key: string;
	label: string;
}

type KeyLookup = (id: AppKeybinding | Parameters<typeof keyText>[0]) => string;

const ARROWS: Record<string, string> = { left: "←", right: "→", up: "↑", down: "↓", escape: "esc" };
const first = (keys: string): string => {
	const key = keys.split("/")[0] ?? keys;
	return ARROWS[key] ?? key;
};

/** The hints for a state, most important first. A pure function so tests and renders agree. */
export function selectKeyHints(state: KeyHintState, lookup: KeyLookup = keyText): KeyHint[] {
	const key = (id: Parameters<KeyLookup>[0]) => first(lookup(id));
	const hints: KeyHint[] = [];
	const add = (k: string, label: string) => {
		if (k) hints.push({ key: k, label });
	};
	switch (state.mode) {
		case "approval":
			// The same letters as the open prompt (permission-prompt.ts / plan-approval.ts).
			if (state.approvalKind === "plan") {
				add("y", "approve");
				add("e", "edit plan");
				add("r", "keep planning");
				add("d", "discard");
				add(key("tui.select.cancel"), "close");
			} else {
				add("↑↓", "choose");
				add(key("tui.select.confirm"), "confirm");
				add("y", "allow");
				add("f", "feedback");
				add(`n/${key("tui.select.cancel")}`, "deny");
			}
			break;
		case "selection":
			add(key("app.message.copy"), "copy");
			add("click", "clear");
			add(key("app.interrupt"), "interrupt");
			break;
		case "autocomplete":
			add("↑↓", "select");
			add(key("tui.input.tab"), "complete");
			add(key("tui.select.confirm"), "accept");
			add(key("tui.select.cancel"), "close");
			break;
		case "history-search":
			add(key("tui.select.confirm"), "insert");
			add(key("tui.historySearch.edit"), "edit");
			add(key("tui.historySearch.cycleScope"), "scope");
			add(key("tui.editor.historySearch"), "older");
			add(key("tui.select.cancel"), "close");
			break;
		case "chip":
			if (state.chipKind === "paste") {
				add(key("tui.input.submit"), state.pasteOpensEditor ? "edit paste in $EDITOR" : "expand paste");
			} else {
				add(key("tui.input.submit"), "image details");
			}
			add(key("tui.editor.deleteCharForward"), "remove");
			add(key("tui.editor.cursorRight"), "move past");
			break;
		case "streaming":
			add(key("app.interrupt"), "interrupt");
			add(key("app.message.followUp"), "queue");
			if (state.queued) add(key("app.message.dequeue"), "edit queue");
			add(key("app.tools.expand"), "expand");
			add(key("app.router.cycleMode"), "mode");
			break;
		case "image":
			add(key("tui.input.submit"), "send with image");
			add(`${key("tui.editor.cursorLeft")} ${key("tui.input.submit")}`, "on a chip: open");
			add(key("app.clipboard.pasteImage"), "add image");
			add(key("app.editor.stash"), "stash");
			break;
		case "draft":
			add(key("tui.input.submit"), "send");
			add(key("tui.input.newLine"), "newline");
			add(key("app.editor.stash"), "stash");
			add(key("app.editor.external"), "editor");
			break;
		case "idle":
			if (state.stashed) add(key("app.editor.stash"), "restore draft");
			add("/", "commands");
			add("@", "files");
			add(key("tui.editor.historySearch"), "history");
			add("?", "shortcuts");
			break;
	}
	if (state.stashed && state.mode !== "idle" && state.mode !== "approval" && hints.length < 5) {
		add(key("app.editor.stash"), "draft stashed");
	}
	return hints.slice(0, 5);
}

/** Lay hints out on one line, dropping trailing hints (never cutting one) until it fits. */
export function formatKeyHints(hints: KeyHint[], width: number, styled = true): string {
	const separator = styled ? theme.fg("dim", " - ") : " - ";
	const render = (hint: KeyHint) => {
		const k = formatKeyText(hint.key);
		return styled ? theme.fg("muted", k) + theme.fg("dim", ` ${hint.label}`) : `${k} ${hint.label}`;
	};
	// Flush with the editor's left edge (column 0), like the footer rows under it.
	for (let count = hints.length; count > 0; count--) {
		const line = hints.slice(0, count).map(render).join(separator);
		if (visibleWidth(line) <= width) return line;
	}
	return "";
}

export class KeyHintRow implements Component {
	private readonly getState: () => KeyHintState | undefined;
	private readonly getRows: () => number;
	private readonly isEnabled: () => boolean;

	constructor(options: {
		getState: () => KeyHintState | undefined;
		getRows: () => number;
		isEnabled: () => boolean;
	}) {
		this.getState = options.getState;
		this.getRows = options.getRows;
		this.isEnabled = options.isEnabled;
	}

	invalidate(): void {}

	render(width: number): string[] {
		if (!this.isEnabled() || this.getRows() < KEY_HINT_MIN_ROWS || width < 20) return [];
		const state = this.getState();
		if (!state) return [];
		const line = formatKeyHints(selectKeyHints(state), width);
		return line ? [truncateToWidth(line, width, "")] : [];
	}
}
