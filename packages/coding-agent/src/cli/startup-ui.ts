import { ProcessTerminal, setCapabilityOverrides, setKeybindings, type TUI, TuiMainScreen } from "@runkiln/tui";
import { getAgentDir } from "../config.ts";
import { KeybindingsManager } from "../core/keybindings.ts";
import type { SettingsManager } from "../core/settings-manager.ts";
import { ExtensionInputComponent } from "../modes/interactive/components/extension-input.ts";
import { ExtensionSelectorComponent } from "../modes/interactive/components/extension-selector.ts";
import { SYSTEM_THEME_NAME } from "../modes/interactive/theme/system-theme.ts";
import {
	getTerminalTheme,
	initTheme,
	markTerminalColorsPending,
	resolveThemeSetting,
	setRegisteredThemes,
	setTerminalColors,
	setTheme,
} from "../modes/interactive/theme/theme.ts";
import { requestTerminalColors } from "../modes/interactive/theme/theme-controller.ts";

/** Terminal capabilities, theme and keybindings for a screen shown before the session exists. */
export function prepareStartupTerminal(settingsManager: SettingsManager): void {
	setCapabilityOverrides(settingsManager.getTerminalCapabilityOverrides());
	// Built-in themes only: RunKiln has no theme packages.
	setRegisteredThemes([]);
	// The system theme starts in grayscale until the terminal reports its colors.
	markTerminalColorsPending();
	initTheme(resolveThemeSetting(settingsManager.getThemeSetting(), getTerminalTheme()) ?? SYSTEM_THEME_NAME);
	setKeybindings(KeybindingsManager.create());
}

export async function createStartupTui(settingsManager: SettingsManager): Promise<TUI> {
	prepareStartupTerminal(settingsManager);
	const ui: TUI = new TuiMainScreen(new ProcessTerminal(), settingsManager.getShowHardwareCursor(), getAgentDir());
	ui.setClearOnShrink(settingsManager.getClearOnShrink());
	return ui;
}

export function startStartupTui(ui: TUI, settingsManager: SettingsManager): void {
	ui.start();
	const themeSetting = settingsManager.getThemeSetting();
	queryStartupTerminalColors(ui, () => {
		setTheme(resolveThemeSetting(themeSetting, getTerminalTheme()) ?? SYSTEM_THEME_NAME);
	});
}

/**
 * Query the terminal's colors without waiting for them. When they arrive, including after the timeout,
 * record them for the system theme and "" (terminal default) tokens, run `onColors`, and re-render.
 */
function queryStartupTerminalColors(ui: TUI, onColors: () => void): void {
	void requestTerminalColors(ui, (colors) => {
		setTerminalColors(colors);
		onColors();
		ui.invalidate();
		ui.requestRender();
	});
}

async function clearStartupTui(ui: TUI): Promise<void> {
	ui.clear();
	ui.requestRender();
	await new Promise((resolve) => setTimeout(resolve, 25));
}

export async function showStartupSelector<T>(
	settingsManager: SettingsManager,
	title: string,
	options: Array<{ label: string; value: T }>,
): Promise<T | undefined> {
	const ui = await createStartupTui(settingsManager);
	return new Promise((resolve) => {
		let settled = false;
		const finish = async (result: T | undefined) => {
			if (settled) {
				return;
			}
			settled = true;
			await clearStartupTui(ui);
			ui.stop();
			resolve(result);
		};

		const selector = new ExtensionSelectorComponent(
			title,
			options.map((option) => option.label),
			(option) => void finish(options.find((entry) => entry.label === option)?.value),
			() => void finish(undefined),
			{ tui: ui },
		);
		ui.addChild(selector);
		ui.setFocus(selector);
		startStartupTui(ui, settingsManager);
	});
}

export async function showStartupInput(
	settingsManager: SettingsManager,
	title: string,
	placeholder?: string,
): Promise<string | undefined> {
	const ui = await createStartupTui(settingsManager);
	return new Promise((resolve) => {
		let settled = false;
		const finish = async (result: string | undefined) => {
			if (settled) {
				return;
			}
			settled = true;
			input.dispose();
			await clearStartupTui(ui);
			ui.stop();
			resolve(result);
		};

		const input = new ExtensionInputComponent(
			title,
			placeholder,
			(value) => void finish(value),
			() => void finish(undefined),
			{
				tui: ui,
			},
		);
		ui.addChild(input);
		ui.setFocus(input);
		startStartupTui(ui, settingsManager);
	});
}
