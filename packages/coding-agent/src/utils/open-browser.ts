import { spawn } from "node:child_process";
import { isWSL } from "./wsl.ts";

/** Launcher commands to try in order for a URL or file. */
export function openerCandidates(
	target: string,
	platform: NodeJS.Platform = process.platform,
	env: NodeJS.ProcessEnv = process.env,
	wsl = platform === "linux" && isWSL(env),
): Array<[string, string[]]> {
	if (platform === "darwin") return [["open", [target]]];
	if (platform === "win32") return [["rundll32", ["url.dll,FileProtocolHandler", target]]];
	const candidates: Array<[string, string[]]> = [];
	// WSL: open with Windows first, so a link opens in the Windows browser or editor.
	if (wsl) candidates.push(["wslview", [target]]);
	const browser = env.BROWSER?.split(":")[0]?.trim();
	if (browser && /^https?:/i.test(target)) candidates.push([browser, [target]]);
	candidates.push(["xdg-open", [target]], ["gio", ["open", target]]);
	return candidates;
}

/**
 * Start a GUI program without waiting for it. Resolves false when it could not start or exited non-zero within
 * 1.5 s (no handler, missing CLI); true once it is running or exited cleanly.
 */
export function launchDetached(
	command: string,
	args: string[],
	options: { windowsVerbatimArguments?: boolean } = {},
): Promise<boolean> {
	return tryOpen(command, args, options);
}

function tryOpen(
	command: string,
	args: string[],
	options: { windowsVerbatimArguments?: boolean } = {},
): Promise<boolean> {
	return new Promise((resolve) => {
		let settled = false;
		const done = (ok: boolean) => {
			if (settled) return;
			settled = true;
			resolve(ok);
		};
		try {
			const child = spawn(command, args, {
				stdio: "ignore",
				detached: true,
				...(options.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
			});
			child.on("error", () => done(false));
			// xdg-open exits non-zero when no handler is registered; GUI launchers that stay running count as opened.
			child.on("exit", (code) => done(code === 0));
			setTimeout(() => done(true), 1500).unref();
			child.unref();
		} catch {
			done(false);
		}
	});
}

/**
 * Open a URL or file with the platform's default handler, trying fallbacks on Linux (wslview on WSL, $BROWSER
 * for web links, xdg-open, gio open). Resolves false when nothing could open it, so callers can copy the
 * target and say so instead of failing silently.
 *
 * This intentionally never invokes a shell. On Windows, do not use `cmd /c start`: cmd.exe re-parses
 * metacharacters (&, |, ^, ...) before `start` runs, which would make attacker-controlled URLs injectable.
 */
export async function openExternal(target: string): Promise<boolean> {
	for (const [command, args] of openerCandidates(target)) {
		if (await tryOpen(command, args)) return true;
	}
	return false;
}

/** Fire-and-forget openExternal; `onFail` runs when no opener worked. */
export function openBrowser(target: string, onFail?: (target: string) => void): void {
	void openExternal(target).then((ok) => {
		if (!ok) onFail?.(target);
	});
}
