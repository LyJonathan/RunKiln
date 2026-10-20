import { type Component, type Focusable, ProcessTerminal, type Terminal, type TUI, TuiAltScreen } from "@runkiln/tui";
import type { SettingsManager } from "../core/settings-manager.ts";
import {
	SetupHub,
	type SetupHubOptions,
	type SetupHubResult,
} from "../modes/interactive/components/setup/setup-hub.ts";
import {
	type SetupResult,
	SetupWizard,
	type SetupWizardOptions,
} from "../modes/interactive/components/setup/setup-wizard.ts";
import { readClipboardText } from "../utils/clipboard.ts";
import { createStartupTui, prepareStartupTerminal, startStartupTui } from "./startup-ui.ts";

/** Show one screen in a standalone TUI (no agent session yet) and resolve with its result. */
async function runStartupScreen<T>(
	settingsManager: SettingsManager,
	build: (ui: TUI, finish: (result: T) => void) => Component & Focusable,
): Promise<T> {
	const ui = await createStartupTui(settingsManager);
	return new Promise((resolve) => {
		let settled = false;
		const finish = async (result: T) => {
			if (settled) return;
			settled = true;
			ui.clear();
			ui.requestRender();
			await new Promise((done) => setTimeout(done, 25));
			ui.stop();
			resolve(result);
		};
		const screen = build(ui, (result) => void finish(result));
		ui.addChild(screen);
		ui.setFocus(screen);
		startStartupTui(ui, settingsManager);
	});
}

export type SetupDisplay = "fullscreen" | "inline";

/**
 * How setup can be shown: full screen on a real terminal, inline on a dumb one or when
 * `RUNKILN_SETUP_INLINE=1`, and not at all without a terminal (the caller points at
 * `runkiln key set --stdin` and `RUNINFRA_API_KEY` instead).
 */
export function chooseSetupDisplay(io: {
	stdinIsTTY: boolean;
	stdoutIsTTY: boolean;
	env: NodeJS.ProcessEnv;
}): SetupDisplay | undefined {
	if (!io.stdinIsTTY || !io.stdoutIsTTY) return undefined;
	const inline = io.env.RUNKILN_SETUP_INLINE?.trim().toLowerCase();
	if (inline && inline !== "0" && inline !== "false") return "inline";
	if ((io.env.TERM ?? "").toLowerCase() === "dumb") return "inline";
	return "fullscreen";
}

export interface RunSetupOptions {
	settingsManager: SettingsManager;
	agentDir: string;
	/** Default: chosen from the terminal (see chooseSetupDisplay); fullscreen when unknown. */
	display?: SetupDisplay;
	/**
	 * Set up theme and keybindings for a TUI that is not running yet (first run, `runkiln setup`).
	 * Pass false from a live session, which already has them. Default true.
	 */
	initializeTerminal?: boolean;
	/** Tests: the terminal for the fullscreen renderer (default: the process terminal). */
	terminal?: Terminal;
	/** Tests: extra wizard options (env, endpoints, fetch). */
	wizard?: Partial<Omit<SetupWizardOptions, "onComplete" | "onCancel">>;
}

/**
 * One setup screen on the alternate screen, with the mouse on (clicks, wheel, right-click paste). The
 * terminal is restored on finish, on quit, and if the process is signalled or exits while it is up, so the
 * shell gets back its screen and cursor.
 */
function runFullscreenScreen<T>(
	options: { settingsManager: SettingsManager; agentDir: string; initializeTerminal?: boolean; terminal?: Terminal },
	build: (ui: TuiAltScreen, finish: (result: T) => void) => Component & Focusable & { dispose(): void },
): Promise<T> {
	const { settingsManager, agentDir } = options;
	// Same theme and keybinding setup as the other startup screens, on an alternate-screen renderer.
	if (options.initializeTerminal ?? true) prepareStartupTerminal(settingsManager);
	let screen: (Component & Focusable & { dispose(): void }) | undefined;
	const ui: TuiAltScreen = new TuiAltScreen(
		options.terminal ?? new ProcessTerminal(),
		settingsManager.getShowHardwareCursor(),
		agentDir,
		{
			onRightClickPaste: () => {
				void readClipboardText()
					.then((text) => {
						if (text && screen && !text.includes("\x1b")) screen.handleInput?.(`\x1b[200~${text}\x1b[201~`);
					})
					.catch(() => {});
			},
		},
	);
	return new Promise((resolve) => {
		let stopped = false;
		const restore = () => {
			if (stopped) return;
			stopped = true;
			try {
				ui.stop({ preserveScreen: true });
			} catch {
				// The terminal may already be gone.
			}
		};
		const onSignal = (signal: NodeJS.Signals) => {
			restore();
			detach();
			process.exit(signal === "SIGINT" ? 130 : signal === "SIGHUP" ? 129 : 143);
		};
		const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
		for (const signal of signals) process.on(signal, onSignal);
		process.on("exit", restore);
		const detach = () => {
			for (const signal of signals) process.off(signal, onSignal);
			process.off("exit", restore);
		};

		let settled = false;
		const finish = (result: T) => {
			if (settled) return;
			settled = true;
			screen?.dispose();
			restore();
			detach();
			resolve(result);
		};
		screen = build(ui, finish);
		ui.addChild(screen);
		ui.setFocus(screen);
		if (options.initializeTerminal ?? true) startStartupTui(ui, settingsManager);
		else ui.start();
	});
}

/** The setup wizard on the alternate screen. */
function runFullscreenSetup(options: RunSetupOptions): Promise<SetupResult | undefined> {
	return runFullscreenScreen<SetupResult | undefined>(
		options,
		(ui, finish) =>
			new SetupWizard({
				agentDir: options.agentDir,
				layout: "fullscreen",
				getRows: () => ui.terminal.rows,
				requestRender: () => ui.requestRender(),
				...options.wizard,
				onComplete: (result) => finish(result),
				onCancel: () => finish(undefined),
			}),
	);
}

/** The wizard inline, for terminals without an alternate screen. */
function runInlineSetup(options: RunSetupOptions): Promise<SetupResult | undefined> {
	return runStartupScreen<SetupResult | undefined>(
		options.settingsManager,
		(ui, finish) =>
			new SetupWizard({
				agentDir: options.agentDir,
				layout: "inline",
				requestRender: () => ui.requestRender(),
				...options.wizard,
				onComplete: (result) => finish(result),
				onCancel: () => finish(undefined),
			}),
	);
}

/** Interactive setup (first run, `runkiln setup`, `/setup`). Resolves undefined when the user quits. */
export function runSetup(options: RunSetupOptions): Promise<SetupResult | undefined> {
	const display =
		options.display ??
		chooseSetupDisplay({
			stdinIsTTY: !!process.stdin.isTTY,
			stdoutIsTTY: !!process.stdout.isTTY,
			env: process.env,
		}) ??
		"fullscreen";
	return display === "inline" ? runInlineSetup(options) : runFullscreenSetup(options);
}

/** First-run setup before the agent session exists. Quitting resolves undefined. */
export function runFirstRunSetup(options: {
	settingsManager: SettingsManager;
	agentDir: string;
}): Promise<SetupResult | undefined> {
	return runSetup(options);
}

export interface RunSetupHubOptions extends Omit<RunSetupOptions, "wizard"> {
	section?: SetupHubOptions["section"];
	keyAction?: SetupHubOptions["keyAction"];
	/** Screens the caller can open after the hub closes (a live session). */
	screens?: SetupHubOptions["screens"];
	/** Tests and the session: extra hub options (env, endpoints, catalog, fetch). */
	hub?: Partial<Omit<SetupHubOptions, "onClose">>;
}

/** The /setup hub (`/setup`, `runkiln setup <section>`, `runkiln key`). Resolves when it closes. */
export function runSetupHub(options: RunSetupHubOptions): Promise<SetupHubResult> {
	const display =
		options.display ??
		chooseSetupDisplay({
			stdinIsTTY: !!process.stdin.isTTY,
			stdoutIsTTY: !!process.stdout.isTTY,
			env: process.env,
		}) ??
		"fullscreen";
	const build = (layout: "fullscreen" | "inline", ui: TUI, finish: (result: SetupHubResult) => void) =>
		new SetupHub({
			agentDir: options.agentDir,
			layout,
			section: options.section,
			keyAction: options.keyAction,
			screens: options.screens,
			getRows: () => ui.terminal.rows,
			requestRender: () => ui.requestRender(),
			...options.hub,
			onClose: (result) => finish(result),
		});
	if (display === "inline") {
		return runStartupScreen<SetupHubResult>(options.settingsManager, (ui, finish) => build("inline", ui, finish));
	}
	return runFullscreenScreen<SetupHubResult>(options, (ui, finish) => build("fullscreen", ui, finish));
}
