import type { MouseMode, MouseModifiers, Terminal, WheelScrollLines } from "@runkiln/tui";
import { ProcessTerminal, type TUI, TuiAltScreen, TuiMainScreen, truncateToWidth, visibleWidth } from "@runkiln/tui";
import { copyToClipboard } from "../../utils/clipboard.ts";
import { openBrowser } from "../../utils/open-browser.ts";
import { keyDisplayText } from "./components/keybinding-hints.ts";
import { theme } from "./theme/theme.ts";

/** Jump button label: `↓ Jump to latest message`, or `3 new ↓ - Jump to latest` once output arrived below. */
export function scrollToEndLabel(newMessages: number): string {
	return newMessages > 0 ? `${newMessages} new ↓ - Jump to latest` : "↓ Jump to latest message";
}

/** The pinned last prompt while scrolled up: `› <prompt>` on a dim full-width row. */
export function stickyPromptHeaderLine(prompt: string, width: number): string {
	const text = truncateToWidth(` › ${prompt}`, Math.max(0, width), "…");
	const padded = text + " ".repeat(Math.max(0, width - visibleWidth(text)));
	return theme.bg("userMessageBg", theme.fg("muted", padded));
}

export interface InteractiveTuiOptions {
	readonly tuiMode: "regular" | "fullscreen";
	readonly showHardwareCursor: boolean;
	readonly logDirectory: string;
	readonly terminal?: Terminal;
	readonly onRightClickPaste?: () => void;
	readonly fullscreenCopyOnSelect?: boolean;
	readonly fullscreenWheelScrollLines?: WheelScrollLines;
	readonly mouse?: MouseMode;
	readonly pointerShapes?: boolean;
	readonly fullRepaint?: boolean;
	/** Open a clicked OSC 8 link; defaults to the OS opener. */
	readonly openUrl?: (url: string, modifiers: MouseModifiers) => void;
	/** Ctrl+click on plain text (a path); true when handled. */
	readonly openTextAt?: (token: string, modifiers: MouseModifiers) => boolean;
	readonly firstSelectionHint?: string;
	readonly onFocusChange?: (focused: boolean) => void;
}

/** Composition root shared by coding-agent presentations. */
export function createInteractiveTui(options: InteractiveTuiOptions & { readonly tuiMode: "fullscreen" }): TuiAltScreen;
export function createInteractiveTui(options: InteractiveTuiOptions & { readonly tuiMode: "regular" }): TuiMainScreen;
export function createInteractiveTui(options: InteractiveTuiOptions): TuiMainScreen | TuiAltScreen;
export function createInteractiveTui(options: InteractiveTuiOptions): TuiMainScreen | TuiAltScreen {
	const terminal = options.terminal ?? new ProcessTerminal();
	if (options.tuiMode === "fullscreen") {
		const styleSearchMatch = (text: string) => theme.bg("searchMatchBg", theme.fg("searchMatchText", text));
		return new TuiAltScreen(terminal, options.showHardwareCursor, options.logDirectory, {
			searchMatchStyle: (text) => theme.underline(styleSearchMatch(text)),
			searchCurrentMatchStyle: (text) => theme.bold(theme.inverse(styleSearchMatch(text))),
			searchNavigationButtonStyle: (text, hovered) => (hovered ? theme.underline(text) : text),
			scrollToEndIndicator: (newMessages) => {
				const shortcut = keyDisplayText("tui.altScreen.bottom");
				const label = ` ${scrollToEndLabel(newMessages)}${shortcut ? ` - ${shortcut}` : ""} `;
				return theme.bg("selectedBg", theme.fg("text", label));
			},
			stickyPromptHeader: (prompt, width) => stickyPromptHeaderLine(prompt, width),
			openUrl: options.openUrl ?? ((url) => openBrowser(url)),
			openTextAt: options.openTextAt,
			mouse: options.mouse,
			pointerShapes: options.pointerShapes,
			fullRepaint: options.fullRepaint,
			firstSelectionHint: options.firstSelectionHint,
			onFocusChange: options.onFocusChange,
			onRightClickPaste: options.onRightClickPaste,
			copyOnSelect: options.fullscreenCopyOnSelect,
			wheelScrollLines: options.fullscreenWheelScrollLines ?? "auto",
			copySelection: async (text) => {
				try {
					await copyToClipboard(text);
					return true;
				} catch (error) {
					return error instanceof Error ? error.message : String(error);
				}
			},
		});
	}
	return new TuiMainScreen(terminal, options.showHardwareCursor, options.logDirectory);
}

/** Stable reference for components while InteractiveMode replaces the active renderer. */
export function createInteractiveTuiReference(getTui: () => TUI): TUI {
	return new Proxy({} as TUI, {
		get: (_target, property) => {
			const tui = getTui();
			const value = Reflect.get(tui, property, tui);
			if (typeof value !== "function") return value;
			let methodTui = tui;
			let method = value;
			return (...args: unknown[]) => {
				const currentTui = getTui();
				if (currentTui !== methodTui) {
					const currentMethod = Reflect.get(currentTui, property, currentTui);
					if (typeof currentMethod !== "function") {
						throw new TypeError(`TUI property ${String(property)} is not callable`);
					}
					methodTui = currentTui;
					method = currentMethod;
				}
				return Reflect.apply(method, methodTui, args);
			};
		},
		set: (_target, property, value) => {
			const tui = getTui();
			return Reflect.set(tui, property, value, tui);
		},
		has: (_target, property) => Reflect.has(getTui(), property),
		getPrototypeOf: () => Reflect.getPrototypeOf(getTui()),
	});
}
