import { existsSync } from "node:fs";
import { delimiter, join, win32 } from "node:path";
import { RUNINFRA_API_KEY_ENV } from "@runkiln/ai/providers/runinfra";
import { spawn, spawnSync } from "child_process";
import { getBinDir } from "../config.ts";

export interface ShellConfig {
	shell: string;
	args: string[];
	commandTransport?: "argv" | "stdin";
}

/**
 * Find bash executable on PATH (cross-platform)
 */
function isLegacyWslBashPath(path: string): boolean {
	const normalized = path.replace(/\//g, "\\").toLowerCase();
	return /^[a-z]:\\windows\\(?:system32|sysnative)\\bash\.exe$/.test(normalized);
}

function getBashShellConfig(shell: string): ShellConfig {
	return isLegacyWslBashPath(shell) ? { shell, args: ["-s"], commandTransport: "stdin" } : { shell, args: ["-c"] };
}

function findExecutableOnPath(executable: string): string | null {
	if (process.platform === "win32") {
		// Windows: Use 'where' and verify file exists (where can return non-existent paths)
		try {
			const result = spawnSync("where", [executable], {
				encoding: "utf-8",
				timeout: 5000,
				windowsHide: true,
			});
			if (result.status === 0 && result.stdout) {
				const firstMatch = result.stdout.trim().split(/\r?\n/)[0];
				if (firstMatch && existsSync(firstMatch)) {
					return firstMatch;
				}
			}
		} catch {
			// Ignore errors
		}
		return null;
	}

	// Unix: Use 'which' and trust its output (handles Termux and special filesystems)
	try {
		const result = spawnSync("which", [executable], { encoding: "utf-8", timeout: 5000 });
		if (result.status === 0 && result.stdout) {
			const firstMatch = result.stdout.trim().split(/\r?\n/)[0];
			if (firstMatch) {
				return firstMatch;
			}
		}
	} catch {
		// Ignore errors
	}
	return null;
}

/** What Windows shell detection reads, injectable so tests can simulate win32 on any host. */
export interface WindowsShellProbe {
	env: NodeJS.ProcessEnv;
	exists: (path: string) => boolean;
	/** Every match of `where <name>`, in PATH order. */
	where: (name: string) => string[];
}

function whereAll(executable: string): string[] {
	try {
		const result = spawnSync("where", [executable], { encoding: "utf-8", timeout: 5000, windowsHide: true });
		if (result.status !== 0 || !result.stdout) return [];
		return result.stdout
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter(Boolean);
	} catch {
		return [];
	}
}

const defaultWindowsProbe = (): WindowsShellProbe => ({ env: process.env, exists: existsSync, where: whereAll });

/** The WSL launcher stub from the Microsoft Store (`...\WindowsApps\bash.exe`). */
function isWindowsAppsStub(path: string): boolean {
	return /\\microsoft\\windowsapps\\[^\\]+$/i.test(path.replace(/\//g, "\\"));
}

/**
 * Git Bash locations to try, in order: machine-wide and per-user installers, Scoop, then the Git
 * install that owns the `git.exe` on PATH (`<root>\cmd\git.exe` or `<root>\mingw64\bin\git.exe`).
 */
export function windowsGitBashCandidates(probe: WindowsShellProbe): string[] {
	const { env } = probe;
	const candidates: string[] = [];
	const add = (root: string | undefined) => {
		if (root) candidates.push(win32.join(root, "bin", "bash.exe"));
	};
	add(env.ProgramFiles && win32.join(env.ProgramFiles, "Git"));
	add(env["ProgramFiles(x86)"] && win32.join(env["ProgramFiles(x86)"], "Git"));
	add(env.ProgramW6432 && win32.join(env.ProgramW6432, "Git"));
	add(env.LOCALAPPDATA && win32.join(env.LOCALAPPDATA, "Programs", "Git"));
	add(env.SCOOP && win32.join(env.SCOOP, "apps", "git", "current"));
	add(env.USERPROFILE && win32.join(env.USERPROFILE, "scoop", "apps", "git", "current"));
	for (const git of probe.where("git.exe")) {
		const dir = win32.dirname(git);
		const name = win32.basename(dir).toLowerCase();
		if (name === "cmd") add(win32.dirname(dir));
		else if (name === "bin" && win32.basename(win32.dirname(dir)).toLowerCase().startsWith("mingw")) {
			add(win32.dirname(win32.dirname(dir)));
		} else if (name === "bin") add(win32.dirname(dir));
	}
	return Array.from(new Set(candidates.map((c) => win32.normalize(c))));
}

/**
 * Pick the bash for Windows: Git Bash first, then a bash on PATH that is not WSL (MSYS2, Cygwin), then
 * WSL's legacy `System32\bash.exe`. Returns undefined when there is none; the WindowsApps stub is skipped.
 */
export function resolveWindowsBash(probe: WindowsShellProbe = defaultWindowsProbe()): ShellConfig | undefined {
	for (const candidate of windowsGitBashCandidates(probe)) {
		if (probe.exists(candidate)) return getBashShellConfig(candidate);
	}
	const onPath = probe.where("bash.exe").filter((path) => probe.exists(path) && !isWindowsAppsStub(path));
	const native = onPath.find((path) => !isLegacyWslBashPath(path));
	if (native) return getBashShellConfig(native);
	const wsl = onPath.find((path) => isLegacyWslBashPath(path));
	return wsl ? getBashShellConfig(wsl) : undefined;
}

/** True when a bash shell is available (always on Unix; Git Bash, MSYS2, Cygwin or WSL on Windows). */
export function hasBashShell(customShellPath?: string): boolean {
	try {
		getShellConfig(customShellPath);
		return true;
	} catch {
		return false;
	}
}

/**
 * Resolve shell configuration based on platform and an optional explicit shell path.
 * Resolution order:
 * 1. User-specified shellPath
 * 2. On Windows: Git Bash (see resolveWindowsBash), then bash on PATH
 * 3. On Unix: /bin/bash, then bash on PATH, then fallback to sh
 */
export function getShellConfig(customShellPath?: string): ShellConfig {
	// 1. Check user-specified shell path
	if (customShellPath) {
		if (existsSync(customShellPath)) {
			return getBashShellConfig(customShellPath);
		}
		throw new Error(`Custom shell path not found: ${customShellPath}`);
	}

	if (process.platform === "win32") {
		const probe = defaultWindowsProbe();
		const bash = resolveWindowsBash(probe);
		if (bash) return bash;
		throw new Error(
			`No bash shell found. Options:\n` +
				`  1. Install Git for Windows: https://git-scm.com/download/win\n` +
				`  2. Add your bash to PATH (MSYS2, Cygwin, etc.)\n` +
				"  3. Set shellPath in settings.json\n" +
				"  4. Use the powershell tool instead (--tools -bash,+powershell)\n\n" +
				`Searched Git Bash in:\n${windowsGitBashCandidates(probe)
					.map((p) => `  ${p}`)
					.join("\n")}`,
		);
	}

	// Unix: try /bin/bash, then bash on PATH, then fallback to sh
	if (existsSync("/bin/bash")) {
		return getBashShellConfig("/bin/bash");
	}

	const bashOnPath = findExecutableOnPath("bash");
	if (bashOnPath) {
		return getBashShellConfig(bashOnPath);
	}

	return { shell: "sh", args: ["-c"] };
}

export const POWERSHELL_ARGS = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"] as const;

/** Resolve PowerShell on Windows, preferring PowerShell 7 when available. */
export function getPowerShellConfig(): ShellConfig {
	if (process.platform !== "win32") {
		throw new Error("The powershell tool is only available on Windows.");
	}

	const shell = findExecutableOnPath("pwsh.exe") ?? findExecutableOnPath("powershell.exe");
	if (!shell) {
		throw new Error("No PowerShell executable found. Install PowerShell or add powershell.exe/pwsh.exe to PATH.");
	}

	return { shell, args: [...POWERSHELL_ARGS] };
}

/**
 * RunKiln's own keys: secrets the agent uses in-process but must never expose to a spawned command (bash, hooks, MCP
 * servers), where the model or a user `!` command could print them. They are stripped whatever shellEnvironment says.
 * Stored uppercase, since Windows environment names are case-insensitive. The classifier key names are written out
 * here (core/router/classifiers.ts defines them) so this module does not import the router.
 */
export const SHELL_SECRET_ENV_NAMES: ReadonlySet<string> = new Set([
	RUNINFRA_API_KEY_ENV,
	"TYPESAFE_API_KEY",
	"OPENROUTER_API_KEY",
]);

/** The `shellEnvironment` setting (global settings only): which variables spawned commands inherit. */
export interface ShellEnvironmentPolicy {
	/** "all" (the default) passes the environment on; "core" passes only CORE_ENV_NAMES (and LC_*). */
	inherit?: "all" | "core";
	/** Hide variables whose name looks like a secret (SECRET_ENV_PATTERNS). Default true. */
	hideSecrets?: boolean;
	/** More names to hide, as case-insensitive globs (`AWS_*`). */
	exclude?: string[];
	/** Names to pass on anyway, as case-insensitive globs (`GITHUB_TOKEN`). RunKiln's own keys are never passed. */
	include?: string[];
}

/** Names that look like secrets: hidden from spawned commands unless shellEnvironment.include lists them. */
export const SECRET_ENV_PATTERNS: readonly string[] = Object.freeze([
	"*KEY*",
	"*SECRET*",
	"*TOKEN*",
	"*PASSWORD*",
	"*PASSWD*",
	"*CREDENTIAL*",
]);

/** The variables a command needs to run at all (POSIX and Windows), for inherit "core" and for MCP servers. */
export const CORE_ENV_NAMES: readonly string[] = Object.freeze([
	"PATH",
	"HOME",
	"USER",
	"LOGNAME",
	"SHELL",
	"TERM",
	"COLORTERM",
	"LANG",
	"LANGUAGE",
	"TZ",
	"TMPDIR",
	"TEMP",
	"TMP",
	"PATHEXT",
	"SYSTEMROOT",
	"SYSTEMDRIVE",
	"COMSPEC",
	"WINDIR",
	"USERPROFILE",
	"USERNAME",
	"USERDOMAIN",
	"APPDATA",
	"LOCALAPPDATA",
	"HOMEDRIVE",
	"HOMEPATH",
	"PROGRAMDATA",
	"PROGRAMFILES",
	"PROGRAMFILES(X86)",
	"PROGRAMW6432",
	"COMMONPROGRAMFILES",
	"NUMBER_OF_PROCESSORS",
	"PROCESSOR_ARCHITECTURE",
	"OS",
]);

let shellEnvironmentPolicy: ShellEnvironmentPolicy = {};

/** Set the process-wide policy from global settings (called at session start). */
export function setShellEnvironmentPolicy(policy: ShellEnvironmentPolicy | undefined): void {
	shellEnvironmentPolicy = policy ? { ...policy } : {};
}

export function getShellEnvironmentPolicy(): ShellEnvironmentPolicy {
	return { ...shellEnvironmentPolicy };
}

function globMatches(glob: string, name: string): boolean {
	const pattern = glob
		.toUpperCase()
		.split("*")
		.map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
		.join(".*");
	return new RegExp(`^${pattern}$`).test(name.toUpperCase());
}

function isCoreName(name: string): boolean {
	const upper = name.toUpperCase();
	return CORE_ENV_NAMES.includes(upper) || upper.startsWith("LC_");
}

/**
 * `env` filtered by a policy: RunKiln's own keys always go; with inherit "core" only core names stay; names that
 * look like secrets (unless hideSecrets is false) and `exclude` names go unless `include` lists them.
 * Returns the filtered copy and the names it hid. The input object is not modified.
 */
export function filterShellEnv(
	env: NodeJS.ProcessEnv,
	policy: ShellEnvironmentPolicy = shellEnvironmentPolicy,
): { env: NodeJS.ProcessEnv; hidden: string[] } {
	const result: NodeJS.ProcessEnv = {};
	const hidden: string[] = [];
	const include = policy.include ?? [];
	const exclude = [...(policy.hideSecrets === false ? [] : SECRET_ENV_PATTERNS), ...(policy.exclude ?? [])];
	for (const [name, value] of Object.entries(env)) {
		if (SHELL_SECRET_ENV_NAMES.has(name.toUpperCase())) {
			hidden.push(name);
			continue;
		}
		const allowed = include.some((glob) => globMatches(glob, name));
		const dropped =
			!allowed &&
			((policy.inherit === "core" && !isCoreName(name)) || exclude.some((glob) => globMatches(glob, name)));
		if (dropped) hidden.push(name);
		else result[name] = value;
	}
	return { env: result, hidden };
}

/** Returns a copy of `env` without RunKiln's own keys (SHELL_SECRET_ENV_NAMES). The input object is not modified. */
export function withoutShellSecrets(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const result: NodeJS.ProcessEnv = { ...env };
	for (const key of Object.keys(result)) {
		if (SHELL_SECRET_ENV_NAMES.has(key.toUpperCase())) delete result[key];
	}
	return result;
}

/** process.env with RunKiln's bin folder on PATH. */
function processEnvWithBin(): NodeJS.ProcessEnv {
	const binDir = getBinDir();
	const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path") ?? "PATH";
	const currentPath = process.env[pathKey] ?? "";
	const pathEntries = currentPath.split(delimiter).filter(Boolean);
	const hasBinDir = pathEntries.includes(binDir);
	const updatedPath = hasBinDir ? currentPath : [binDir, currentPath].filter(Boolean).join(delimiter);
	return { ...process.env, [pathKey]: updatedPath };
}

/** The environment of shell commands and hooks: process.env filtered by the shellEnvironment policy. */
export function getShellEnv(): NodeJS.ProcessEnv {
	return filterShellEnv(processEnvWithBin()).env;
}

/** The names getShellEnv hides now (for /permissions). */
export function hiddenShellEnvNames(): string[] {
	return filterShellEnv(processEnvWithBin()).hidden;
}

/** Tokens that gh and git use: hidden by default like any *TOKEN*, so a startup notice names the opt-in. */
export const GITHUB_TOKEN_ENV_NAMES: readonly string[] = Object.freeze(["GITHUB_TOKEN", "GH_TOKEN"]);

/**
 * A one-line notice when GITHUB_TOKEN or GH_TOKEN is set but hidden from commands, naming the setting that passes
 * it on. Undefined when neither is set or both are passed on.
 */
export function hiddenGitHubTokenNotice(
	env: NodeJS.ProcessEnv = process.env,
	policy: ShellEnvironmentPolicy = shellEnvironmentPolicy,
): string | undefined {
	const hidden = new Set(filterShellEnv(env, policy).hidden.map((name) => name.toUpperCase()));
	const names = GITHUB_TOKEN_ENV_NAMES.filter((name) => hidden.has(name) && env[name]);
	if (names.length === 0) return undefined;
	const list = names.join(" and ");
	return `${list} ${names.length === 1 ? "is" : "are"} hidden from commands. To pass ${names.length === 1 ? "it" : "them"} to gh and git, add ${list} to shellEnvironment.include in global settings.`;
}

/**
 * The base environment of a stdio MCP server: only the core variables a program needs (CORE_ENV_NAMES, LC_*), as the
 * MCP SDK's getDefaultEnvironment does. The server's declared `env` is added on top by the caller.
 */
export function getMcpServerBaseEnv(): NodeJS.ProcessEnv {
	return filterShellEnv(processEnvWithBin(), { inherit: "core", hideSecrets: true }).env;
}

/**
 * Sanitize binary output for display/storage.
 * Removes characters that crash string-width or cause display issues:
 * - Control characters (except tab, newline, carriage return)
 * - Unicode interlinear annotation characters U+FFF9..U+FFFB (crash string-width due to a bug)
 */
export function sanitizeBinaryOutput(str: string): string {
	// All removed characters are single UTF-16 code units, so surrogate pairs are never split.
	return str.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\uFFF9-\uFFFB]/g, "");
}

/**
 * Detached child processes must be tracked so they can be killed on parent
 * shutdown signals (SIGHUP/SIGTERM).
 */
const trackedDetachedChildPids = new Set<number>();

export function trackDetachedChildPid(pid: number): void {
	trackedDetachedChildPids.add(pid);
}

export function untrackDetachedChildPid(pid: number): void {
	trackedDetachedChildPids.delete(pid);
}

export function killTrackedDetachedChildren(): void {
	for (const pid of trackedDetachedChildPids) {
		killProcessTree(pid);
	}
	trackedDetachedChildPids.clear();
}

/**
 * Kill a process and all its children (cross-platform)
 */
export function killProcessTree(pid: number): void {
	if (process.platform === "win32") {
		// Use the trusted System32 executable so cleanup does not depend on PATH.
		try {
			const child = spawn(
				join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"),
				["/F", "/T", "/PID", String(pid)],
				{
					stdio: "ignore",
					detached: true,
					windowsHide: true,
				},
			);
			// A failed spawn emits "error" asynchronously; consume it to avoid crashing Node.
			child.once("error", () => {});
		} catch {
			// Ignore errors if taskkill fails.
		}
	} else {
		// Use SIGKILL on Unix/Linux/Mac
		try {
			process.kill(-pid, "SIGKILL");
		} catch {
			// Fallback to killing just the child if process group kill fails
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				// Process already dead
			}
		}
	}
}
