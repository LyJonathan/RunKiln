/**
 * What clicks do in fullscreen: open file paths in the editor (`editor.open`), open links with fallbacks,
 * card actions (hover strip and menu), and the terminal-specific mouse options (pointer shapes, the native
 * selection hint). The interactive mode supplies the session-specific parts (rerun, revert, rewind).
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import type { MouseModifiers, TUI, TuiMouseEvent } from "@runkiln/tui";
import type { SettingsManager } from "../../core/settings-manager.ts";
import { type FileLocation, formatFileLocation, parseFileLocation, planEditorOpen } from "../../utils/editor-open.ts";
import { launchDetached, openExternal } from "../../utils/open-browser.ts";
import { type ContextMenuItem, showContextMenu } from "./components/context-menu.ts";
import type { CardAction, CardActionHost, ToolExecutionComponent } from "./components/tool-execution.ts";

/** Terminals known to support OSC 22 pointer shapes. Multiplexers do not pass it through. */
export function pointerShapesSupported(env: NodeJS.ProcessEnv = process.env): boolean {
	if (env.TMUX || env.STY || env.ZELLIJ) return false;
	const term = env.TERM?.toLowerCase() ?? "";
	const program = env.TERM_PROGRAM?.toLowerCase() ?? "";
	if (term.startsWith("screen") || term.startsWith("tmux")) return false;
	if (env.KITTY_WINDOW_ID || term === "xterm-kitty") return true;
	if (program === "ghostty" || term === "xterm-ghostty") return true;
	if (term.startsWith("foot")) return true;
	if (program === "wezterm" || env.WEZTERM_PANE) return true;
	if (program === "iterm.app") return true;
	if (env.XTERM_VERSION) return true;
	return false;
}

export function resolvePointerShapes(setting: "auto" | "on" | "off", env: NodeJS.ProcessEnv = process.env): boolean {
	if (setting === "on") return true;
	if (setting === "off") return false;
	return pointerShapesSupported(env);
}

/** The one-time hint after the first drag selection: how to select with the terminal instead. */
export function nativeSelectionHint(env: NodeJS.ProcessEnv = process.env): string {
	const program = env.TERM_PROGRAM?.toLowerCase() ?? "";
	if (program === "iterm.app") return "Hold Option and drag to select with iTerm2 instead";
	if (program === "apple_terminal") return "Hold Fn and drag to select with Terminal instead";
	if (env.WT_SESSION) return "Hold Shift and drag to select with Windows Terminal instead";
	return "Hold Shift and drag to select with your terminal instead";
}

export interface ClickActionsDeps {
	ui: TUI;
	settings: SettingsManager;
	cwd(): string;
	/** A short confirmation (a flash in fullscreen). */
	notify(message: string): void;
	copy(text: string): Promise<void>;
	/** Run a terminal program (nvim) in the foreground with the TUI stopped. */
	runInTerminal(command: string, args: string[]): Promise<void>;
	/** Run a shell command again as a user `!` command. */
	rerunBash(command: string): void;
	/** Put one file back as it was before the card's turn (asks first). */
	revertFile(card: ToolExecutionComponent, file: string): Promise<void>;
	/** Open the rewind flow at the card's turn. */
	rewindFrom(card: ToolExecutionComponent): Promise<void>;
}

const FILE_TOOLS = new Set(["edit", "write", "read"]);

function str(value: unknown): string | undefined {
	return typeof value === "string" && value !== "" ? value : undefined;
}

export class ClickActions implements CardActionHost {
	private readonly deps: ClickActionsDeps;

	constructor(deps: ClickActionsDeps) {
		this.deps = deps;
	}

	// ------------------------------------------------------------------ editor and links

	/** Open a location in the editor, or copy `path:line` and say why. */
	async openLocation(location: FileLocation): Promise<void> {
		const { notify, settings } = this.deps;
		const display = formatFileLocation(location, this.deps.cwd());
		const plan = planEditorOpen(settings.getEditorOpen(), location);
		const copyInstead = async (reason: string) => {
			try {
				await this.deps.copy(formatFileLocation(location));
				notify(`Copied ${display} (${reason})`);
			} catch {
				notify(`Could not open ${display} (${reason})`);
			}
		};
		if (plan.kind === "copy") return copyInstead(plan.reason);
		if (plan.kind === "open") {
			if (await openExternal(plan.target)) notify(`Opened ${display} in ${plan.label}`);
			else await copyInstead("nothing could open it");
			return;
		}
		if (plan.terminal) {
			await this.deps.runInTerminal(plan.command, plan.args);
			return;
		}
		const ok = await launchDetached(plan.command, plan.args, {
			...(plan.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
		});
		if (ok) notify(`Opened ${display} in ${plan.label}`);
		else await copyInstead(`${plan.command} not found`);
	}

	/** A clicked OSC 8 link: file links go to the editor, others to the browser (copied when nothing opens). */
	openUrl = (url: string, _modifiers?: MouseModifiers): void => {
		if (/^file:\/\//i.test(url)) {
			const location = parseFileLocation(url, this.deps.cwd());
			if (location) {
				void this.openLocation(location);
				return;
			}
		}
		void openExternal(url).then(async (ok) => {
			if (ok) return;
			try {
				await this.deps.copy(url);
				this.deps.notify("Copied the link (no browser opened)");
			} catch {
				this.deps.notify("Could not open the link");
			}
		});
	};

	/** Ctrl+click (or Alt+click) on a path in plain text: open it when it is a file that exists. */
	openTextAt = (token: string, _modifiers: MouseModifiers): boolean => {
		if (/^https?:\/\//i.test(token)) {
			this.openUrl(token);
			return true;
		}
		const location = parseFileLocation(token.replace(/^[ab]\//, ""), this.deps.cwd());
		if (!location || !existsSync(location.file)) return false;
		void this.openLocation(location);
		return true;
	};

	// ------------------------------------------------------------------ card actions

	showStrip(): boolean {
		return this.deps.settings.getCardActions() && this.deps.settings.getMouseMode() === "on";
	}

	rightClickOpensMenu(event: TuiMouseEvent): boolean {
		const mode = this.deps.settings.getMouseRightClick();
		return mode === "menu" ? !event.shift : event.shift;
	}

	private cardFile(card: ToolExecutionComponent): string | undefined {
		return FILE_TOOLS.has(card.getToolName()) ? str(card.getArgs()?.path) : undefined;
	}

	private cardLocation(card: ToolExecutionComponent): FileLocation | undefined {
		const file = this.cardFile(card);
		if (!file) return undefined;
		const location = parseFileLocation(file, card.getCwd());
		if (!location) return undefined;
		const details = card.getResultDetails();
		const line =
			card.getToolName() === "edit"
				? details?.firstChangedLine
				: card.getToolName() === "read"
					? card.getArgs()?.offset
					: undefined;
		return typeof line === "number" && line > 0 ? { ...location, line } : location;
	}

	actions(card: ToolExecutionComponent): CardAction[] {
		const name = card.getToolName();
		const actions: CardAction[] = [];
		const file = this.cardFile(card);
		if (file) {
			actions.push({ id: "open", label: "open", key: "o", strip: true });
			if (name === "edit")
				actions.push({ id: "diff", label: card.isExpanded() ? "less" : "diff", key: "d", strip: true });
			actions.push({ id: "copy-path", label: "copy path", key: "c", strip: true });
			if (name === "edit" || name === "write")
				actions.push({ id: "revert", label: "revert file", key: "r", danger: true });
		}
		if (name === "bash" && str(card.getArgs()?.command)) {
			actions.push({ id: "copy-command", label: "copy cmd", key: "c", strip: true });
			actions.push({ id: "copy-output", label: "copy output", key: "y" });
			actions.push({ id: "rerun", label: "rerun", key: "r", strip: true });
		} else if (card.getOutputText()) {
			actions.push({ id: "copy-output", label: "copy output", key: "y", strip: !file });
		}
		actions.push({ id: "rewind", label: "rewind from here", key: "w" });
		return actions;
	}

	run(card: ToolExecutionComponent, actionId: string): void {
		const { copy, notify } = this.deps;
		const copyAndSay = (text: string, what: string) =>
			void copy(text).then(
				() => notify(`Copied ${what}`),
				(error: unknown) => notify(error instanceof Error ? error.message : "Copy failed"),
			);
		switch (actionId) {
			case "open": {
				const location = this.cardLocation(card);
				if (location) void this.openLocation(location);
				return;
			}
			case "diff":
				card.setExpanded(!card.isExpanded());
				this.deps.ui.requestRender();
				return;
			case "copy-path": {
				const location = this.cardLocation(card);
				if (location) copyAndSay(formatFileLocation(location, card.getCwd()), "the path");
				return;
			}
			case "revert": {
				const location = this.cardLocation(card);
				if (location) void this.deps.revertFile(card, location.file);
				return;
			}
			case "copy-command": {
				const command = str(card.getArgs()?.command);
				if (command) copyAndSay(command, "the command");
				return;
			}
			case "copy-output": {
				const output = card.getOutputText();
				if (output) copyAndSay(output, "the output");
				else notify("No output to copy");
				return;
			}
			case "rerun": {
				const command = str(card.getArgs()?.command);
				if (command) this.deps.rerunBash(command);
				return;
			}
			case "rewind":
				void this.deps.rewindFrom(card);
				return;
		}
	}

	openMenu(card: ToolExecutionComponent, x: number, y: number): void {
		const file = this.cardFile(card);
		const title = file ? `${card.getToolName()} ${file.split(/[\\/]/).pop()}` : card.getToolName();
		const items: ContextMenuItem[] = this.actions(card).map((action) => ({
			id: action.id,
			label: action.label,
			...(action.key ? { key: action.key } : {}),
			...(action.danger ? { danger: true } : {}),
		}));
		showContextMenu(this.deps.ui, { title, items, x, y, onPick: (item) => this.run(card, item.id) });
	}

	/** A small menu at a click, for footer items. */
	menu(title: string, items: ContextMenuItem[], event: TuiMouseEvent, onPick: (item: ContextMenuItem) => void): void {
		showContextMenu(this.deps.ui, { title, items, x: event.screenX, y: event.screenY, onPick });
	}
}

/** Run a terminal editor in the foreground and wait for it. */
export function runForeground(command: string, args: string[]): Promise<void> {
	return new Promise((resolve) => {
		const child = spawn(command, args, { stdio: "inherit" });
		child.on("error", () => resolve());
		child.on("close", () => resolve());
	});
}
