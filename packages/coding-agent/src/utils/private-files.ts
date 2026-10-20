/**
 * Private storage for the agent folder: session transcripts, checkpoints (which hold copies of files such as .env),
 * the usage ledger, prompt history, crash logs and settings can all contain secrets, so only the user may read them.
 *
 * POSIX: folders 0700 and files 0600. `mode` applies only when a file or folder is created, so existing ones are
 * fixed with chmod (hardenPrivateTree), and folders are chmodded after mkdir so the umask cannot widen them.
 * Windows: one `icacls <dir> /inheritance:r /grant:r *<SID>:(OI)(CI)F` per folder, so every file created inside
 * inherits an ACL that grants only the current user. The SID is used rather than the user name, which can resolve to
 * another principal on domain-joined and Azure AD machines.
 */

import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const PRIVATE_DIR_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;

export interface PrivateFileOptions {
	/** Defaults to the current platform. */
	platform?: NodeJS.Platform;
	/** Defaults to execFileSync; returns stdout. Tests pass a fake. */
	execFile?: (command: string, args: readonly string[]) => string;
}

function defaultExecFile(command: string, args: readonly string[]): string {
	return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
}

let cachedSid: string | undefined | null = null;

/** The current user's SID (S-1-5-...), or undefined when it cannot be read. Cached per process. */
export function currentUserSid(options: PrivateFileOptions = {}): string | undefined {
	if (cachedSid !== null && !options.execFile) return cachedSid;
	let sid: string | undefined;
	try {
		const output = (options.execFile ?? defaultExecFile)("whoami", ["/user", "/fo", "csv", "/nh"]);
		sid = output.match(/S-1-[0-9-]+/)?.[0];
	} catch {
		sid = undefined;
	}
	if (!options.execFile) cachedSid = sid;
	return sid;
}

/**
 * The icacls arguments that limit `path` to one SID in a single call. `inherit` adds (OI)(CI) so files and folders
 * created inside get the same ACL.
 */
export function icaclsArgs(path: string, sid: string, inherit: boolean): string[] {
	return [path, "/inheritance:r", "/grant:r", `*${sid}:${inherit ? "(OI)(CI)" : ""}F`];
}

/**
 * Limit a file or folder to the current user on Windows by SID. Returns false when icacls or the SID lookup failed
 * (the caller decides whether to warn).
 */
export function restrictWindowsAcl(path: string, inherit: boolean, options: PrivateFileOptions = {}): boolean {
	const sid = currentUserSid(options);
	if (!sid) return false;
	try {
		(options.execFile ?? defaultExecFile)("icacls", icaclsArgs(path, sid, inherit));
		return true;
	} catch {
		return false;
	}
}

const hardenedDirs = new Set<string>();

/**
 * Create `dir` (and parents) if needed and make it private: 0700 on POSIX (an existing 0755 folder is fixed), an
 * inherited user-only ACL on Windows (applied once per folder per process). Never throws.
 */
export function ensurePrivateDir(dir: string, options: PrivateFileOptions = {}): void {
	const platform = options.platform ?? process.platform;
	try {
		mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
		if (platform === "win32") {
			if (!hardenedDirs.has(dir) || options.execFile) {
				restrictWindowsAcl(dir, true, options);
				hardenedDirs.add(dir);
			}
			return;
		}
		chmodSync(dir, PRIVATE_DIR_MODE);
	} catch {
		// Best effort: a folder we cannot harden still works.
	}
}

/** Most entries hardenPrivateTree visits, so a huge session folder cannot stall startup. */
const MAX_HARDEN_ENTRIES = 50_000;

/**
 * Fix the modes of an existing tree on POSIX: folders 0700, files lose group and other access (0644 becomes 0600,
 * 0755 becomes 0700), links left alone. Only entries that are open
 * to group or others are changed. Returns how many were fixed. Windows is handled by the inherited folder ACL.
 */
export function hardenPrivateTree(root: string, options: PrivateFileOptions = {}): number {
	const platform = options.platform ?? process.platform;
	if (platform === "win32") {
		ensurePrivateDir(root, options);
		return 0;
	}
	let fixed = 0;
	let visited = 0;
	const walk = (path: string): void => {
		if (visited++ > MAX_HARDEN_ENTRIES) return;
		let stats: ReturnType<typeof lstatSync>;
		try {
			stats = lstatSync(path);
		} catch {
			return;
		}
		if (stats.isSymbolicLink()) return;
		if ((stats.mode & 0o077) !== 0) {
			try {
				// Files keep their owner bits (downloaded tools in bin/ stay executable); group and others lose access.
				chmodSync(path, stats.isDirectory() ? PRIVATE_DIR_MODE : stats.mode & 0o700);
				fixed++;
			} catch {
				// Not ours, or read-only: leave it.
			}
		}
		if (!stats.isDirectory()) return;
		let names: string[];
		try {
			names = readdirSync(path);
		} catch {
			return;
		}
		for (const name of names) walk(join(path, name));
	};
	walk(root);
	return fixed;
}

/** Marker written in a folder once its Windows ACL is set, so later starts skip whoami and icacls. */
export const WINDOWS_ACL_MARKER = ".private-acl";

/**
 * Make the agent folder private at startup. On POSIX the folder becomes 0700; its existing contents are walked only
 * when the folder itself was open to group or others (an install from before this change), since a private folder
 * already hides everything inside it. On Windows the folder gets an inherited user-only ACL once (a marker file
 * records it). `extraDirs` are other folders that hold transcripts, such as a custom session folder: only the folder
 * itself is made private, never walked, because it may be a folder the user shares with other things.
 */
export function hardenAgentStorage(
	agentDir: string,
	extraDirs: readonly string[] = [],
	options: PrivateFileOptions = {},
): void {
	const platform = options.platform ?? process.platform;
	for (const [index, dir] of [agentDir, ...extraDirs].entries()) {
		const isAgentDir = index === 0;
		if (platform === "win32") {
			const marker = join(dir, WINDOWS_ACL_MARKER);
			if (existsSync(marker)) continue;
			mkdirSafe(dir);
			if (restrictWindowsAcl(dir, true, options)) {
				try {
					writeFileSync(marker, "");
				} catch {
					// The ACL is set; the marker only saves time on the next start.
				}
			}
			continue;
		}
		let wasOpen = true;
		try {
			wasOpen = (statSync(dir).mode & 0o077) !== 0;
		} catch {
			// Missing: created below, nothing inside to fix.
			wasOpen = false;
		}
		ensurePrivateDir(dir, options);
		if (isAgentDir && wasOpen) hardenPrivateTree(dir, options);
	}
}

function mkdirSafe(dir: string): void {
	try {
		mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
	} catch {
		// restrictWindowsAcl reports the failure.
	}
}
