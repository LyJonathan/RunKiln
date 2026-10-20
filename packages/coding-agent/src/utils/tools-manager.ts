import { type SpawnSyncReturns, spawnSync } from "child_process";
import { createHash } from "crypto";
import { chmodSync, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from "fs";
import { arch, platform } from "os";
import { join } from "path";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import { getBinDir } from "../config.ts";
import { fetchWithRetry } from "./management-http.ts";

const TOOLS_DIR = getBinDir();
const DOWNLOAD_TIMEOUT_MS = 120_000;

function isOfflineModeEnabled(): boolean {
	const value = process.env.RUNKILN_OFFLINE;
	if (!value) return false;
	return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}

interface ToolConfig {
	name: string;
	repo: string; // GitHub repo (e.g., "sharkdp/fd")
	binaryName: string; // Name of the binary inside the archive
	systemBinaryNames?: string[]; // Alternative system command names to try before downloading
	tagPrefix: string; // Prefix for tags (e.g., "v" for v1.0.0, "" for 1.0.0)
	getAssetName: (version: string, plat: string, architecture: string) => string | null;
}

const TOOLS: Record<string, ToolConfig> = {
	fd: {
		name: "fd",
		repo: "sharkdp/fd",
		binaryName: "fd",
		systemBinaryNames: ["fd", "fdfind"],
		tagPrefix: "v",
		getAssetName: (version, plat, architecture) => {
			if (plat === "darwin") {
				const archStr = architecture === "arm64" ? "aarch64" : "x86_64";
				return `fd-v${version}-${archStr}-apple-darwin.tar.gz`;
			} else if (plat === "linux") {
				const archStr = architecture === "arm64" ? "aarch64" : "x86_64";
				return `fd-v${version}-${archStr}-unknown-linux-musl.tar.gz`;
			} else if (plat === "win32") {
				const archStr = architecture === "arm64" ? "aarch64" : "x86_64";
				return `fd-v${version}-${archStr}-pc-windows-msvc.zip`;
			}
			return null;
		},
	},
	rg: {
		name: "ripgrep",
		repo: "BurntSushi/ripgrep",
		binaryName: "rg",
		tagPrefix: "",
		getAssetName: (version, plat, architecture) => {
			if (plat === "darwin") {
				const archStr = architecture === "arm64" ? "aarch64" : "x86_64";
				return `ripgrep-${version}-${archStr}-apple-darwin.tar.gz`;
			} else if (plat === "linux") {
				const archStr = architecture === "arm64" ? "aarch64" : "x86_64";
				return `ripgrep-${version}-${archStr}-unknown-linux-musl.tar.gz`;
			} else if (plat === "win32") {
				const archStr = architecture === "arm64" ? "aarch64" : "x86_64";
				return `ripgrep-${version}-${archStr}-pc-windows-msvc.zip`;
			}
			return null;
		},
	},
};

/** Release asset for `tool` on a platform, or null when there is no prebuilt binary for it. */
export function getToolAssetName(
	tool: "fd" | "rg",
	version: string,
	plat: string,
	architecture: string,
): string | null {
	return TOOLS[tool]?.getAssetName(version, plat, architecture) ?? null;
}

/** File name of the tool binary in the tools directory (`rg.exe` on Windows). */
export function getToolBinaryFileName(tool: "fd" | "rg", plat: string = platform()): string {
	return TOOLS[tool].binaryName + (plat === "win32" ? ".exe" : "");
}

/**
 * Pinned releases with the SHA-256 of every asset RunKiln downloads (from the GitHub release asset digests,
 * cross-checked against ripgrep's own .sha256 files). A download whose hash differs is refused, so a replaced
 * release asset or a redirect cannot install another binary. Bump a version by updating its hashes together.
 */
export const PINNED_TOOL_RELEASES: Record<"fd" | "rg", { version: string; sha256: Record<string, string> }> = {
	rg: {
		version: "15.2.0",
		sha256: {
			"ripgrep-15.2.0-aarch64-apple-darwin.tar.gz":
				"3750b2e93f37e0c692657da574d7019a101c0084da05a790c83fd335bad973e4",
			"ripgrep-15.2.0-x86_64-apple-darwin.tar.gz":
				"af7825fcc69a2afc7a7aea55fc9af90e26421d8f20fe59df32e233c0b8a231c1",
			"ripgrep-15.2.0-aarch64-unknown-linux-musl.tar.gz":
				"800b1e7206afe799dfb5a6901f23147cfaabe0e52210538100f61e86e1740915",
			"ripgrep-15.2.0-x86_64-unknown-linux-musl.tar.gz":
				"33e15bcf1624b25cdd2a55813a47a2f95dbe126268203e76aa6a585d1e7b149c",
			"ripgrep-15.2.0-aarch64-pc-windows-msvc.zip":
				"e4abca10c3a64ebea742667dd7009449d49403db5460dd6873e389fa2945360f",
			"ripgrep-15.2.0-x86_64-pc-windows-msvc.zip":
				"71b2fef860abe467217a538ff31de02f5258807c0129f771846f87bd029aafc5",
		},
	},
	fd: {
		version: "10.5.0",
		sha256: {
			"fd-v10.5.0-aarch64-apple-darwin.tar.gz": "b67e1836c468e42e411984b56e52fa7abec08c2bd22c867398e7cc134aac5e12",
			// fd stays on 10.3.0 for Intel macOS (see FD_DARWIN_X64_VERSION).
			"fd-v10.3.0-x86_64-apple-darwin.tar.gz": "50d30f13fe3d5914b14c4fff5abcbd4d0cdab4b855970a6956f4f006c17117a3",
			"fd-v10.5.0-aarch64-unknown-linux-musl.tar.gz":
				"d76c4317f7d5dba69f8a2a15856c90c777e7f0dd4e85f0de8c76de6992c374d4",
			"fd-v10.5.0-x86_64-unknown-linux-musl.tar.gz":
				"761c72dc8e120d85b22292063be8a796e2eeb20eb3e4f38b8fa2343ccf3514a7",
			"fd-v10.5.0-aarch64-pc-windows-msvc.zip": "a2bcddcfd259b05357a77bbc6cd671fdb30f63fd266a0e748305890a8c5ceaa6",
			"fd-v10.5.0-x86_64-pc-windows-msvc.zip": "a227701b8551c35a9931d9f6da75503cf86d88e182d71fb849a70864c5d57cd7",
		},
	},
};

/** fd is pinned to this version on Intel macOS. */
const FD_DARWIN_X64_VERSION = "10.3.0";

/** The pinned version of `tool` for a platform. */
export function pinnedToolVersion(tool: "fd" | "rg", plat: string, architecture: string): string {
	if (tool === "fd" && plat === "darwin" && architecture === "x64") return FD_DARWIN_X64_VERSION;
	return PINNED_TOOL_RELEASES[tool].version;
}

/** Throws unless `filePath` hashes to the pinned SHA-256 of `assetName`. */
export function verifyToolArchive(tool: "fd" | "rg", assetName: string, filePath: string): void {
	const expected = PINNED_TOOL_RELEASES[tool].sha256[assetName];
	if (!expected) throw new Error(`No pinned checksum for ${assetName}; refusing to install it`);
	const actual = createHash("sha256").update(readFileSync(filePath)).digest("hex");
	if (actual !== expected) {
		throw new Error(
			`Checksum mismatch for ${assetName} (expected ${expected}, got ${actual}); refusing to install it`,
		);
	}
}

// Check if a command exists in PATH by trying to run it
function commandExists(cmd: string): boolean {
	try {
		const result = spawnSync(cmd, ["--version"], { stdio: "pipe" });
		// Check for ENOENT error (command not found)
		return result.error === undefined || result.error === null;
	} catch {
		return false;
	}
}

// Get the path to a tool (system-wide or in our tools dir)
export function getToolPath(tool: "fd" | "rg"): string | null {
	const config = TOOLS[tool];
	if (!config) return null;

	// Check our tools directory first
	const localPath = join(TOOLS_DIR, config.binaryName + (platform() === "win32" ? ".exe" : ""));
	if (existsSync(localPath)) {
		return localPath;
	}

	// Check system PATH - if found, just return the command name (it's in PATH)
	const systemBinaryNames = config.systemBinaryNames ?? [config.binaryName];
	for (const systemBinaryName of systemBinaryNames) {
		if (commandExists(systemBinaryName)) {
			return systemBinaryName;
		}
	}

	return null;
}

// Download a file from URL
async function downloadFile(url: string, dest: string): Promise<void> {
	const response = await fetchWithRetry(url, undefined, { timeoutMs: DOWNLOAD_TIMEOUT_MS });

	if (!response.ok) {
		throw new Error(`Download failed with HTTP ${response.status}: ${url}`);
	}

	if (!response.body) {
		throw new Error("No response body");
	}

	const fileStream = createWriteStream(dest);
	await pipeline(Readable.fromWeb(response.body as any), fileStream);
}

function findBinaryRecursively(rootDir: string, binaryFileName: string): string | null {
	const stack: string[] = [rootDir];

	while (stack.length > 0) {
		const currentDir = stack.pop();
		if (!currentDir) continue;

		const entries = readdirSync(currentDir, { withFileTypes: true });
		for (const entry of entries) {
			const fullPath = join(currentDir, entry.name);
			if (entry.isFile() && entry.name === binaryFileName) {
				return fullPath;
			}
			if (entry.isDirectory()) {
				stack.push(fullPath);
			}
		}
	}

	return null;
}

function formatSpawnFailure(result: SpawnSyncReturns<Buffer>): string {
	if (result.error?.message) {
		return result.error.message;
	}
	const stderr = result.stderr?.toString().trim();
	if (stderr) {
		return stderr;
	}
	const stdout = result.stdout?.toString().trim();
	if (stdout) {
		return stdout;
	}
	return `exit status ${result.status ?? "unknown"}`;
}

function runExtractionCommand(command: string, args: string[]): string | null {
	const result = spawnSync(command, args, { stdio: "pipe" });
	if (!result.error && result.status === 0) {
		return null;
	}
	return `${command}: ${formatSpawnFailure(result)}`;
}

function extractTarGzArchive(archivePath: string, extractDir: string, assetName: string): void {
	const failure = runExtractionCommand("tar", ["xzf", archivePath, "-C", extractDir]);
	if (failure) {
		throw new Error(`Failed to extract ${assetName}: ${failure}`);
	}
}

function getWindowsTarCommand(): string {
	const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
	if (systemRoot) {
		const systemTar = join(systemRoot, "System32", "tar.exe");
		if (existsSync(systemTar)) {
			return systemTar;
		}
	}
	return "tar.exe";
}

function extractZipArchive(archivePath: string, extractDir: string, assetName: string): void {
	const failures: string[] = [];

	if (platform() === "win32") {
		// Windows ships bsdtar as tar.exe, which supports zip files. Prefer the
		// System32 binary over Git Bash's GNU tar, which does not handle zip archives.
		const tarFailure = runExtractionCommand(getWindowsTarCommand(), ["xf", archivePath, "-C", extractDir]);
		if (!tarFailure) return;
		failures.push(tarFailure);

		const script =
			"& { param($archive, $destination) $ErrorActionPreference = 'Stop'; Expand-Archive -LiteralPath $archive -DestinationPath $destination -Force }";
		const powershellFailure = runExtractionCommand("powershell.exe", [
			"-NoLogo",
			"-NoProfile",
			"-NonInteractive",
			"-ExecutionPolicy",
			"Bypass",
			"-Command",
			script,
			archivePath,
			extractDir,
		]);
		if (!powershellFailure) return;
		failures.push(powershellFailure);
	} else {
		const unzipFailure = runExtractionCommand("unzip", ["-q", archivePath, "-d", extractDir]);
		if (!unzipFailure) return;
		failures.push(unzipFailure);

		const tarFailure = runExtractionCommand("tar", ["xf", archivePath, "-C", extractDir]);
		if (!tarFailure) return;
		failures.push(tarFailure);
	}

	throw new Error(`Failed to extract ${assetName}: ${failures.join("; ")}`);
}

// Download and install a tool
async function downloadTool(tool: "fd" | "rg"): Promise<string> {
	const config = TOOLS[tool];
	if (!config) throw new Error(`Unknown tool: ${tool}`);

	const plat = platform();
	const architecture = arch();

	// Pinned versions with checksums: never "latest".
	const version = pinnedToolVersion(tool, plat, architecture);

	// Get asset name for this platform
	const assetName = config.getAssetName(version, plat, architecture);
	if (!assetName) {
		throw new Error(`Unsupported platform: ${plat}/${architecture}`);
	}

	// Create tools directory
	mkdirSync(TOOLS_DIR, { recursive: true });

	const downloadUrl = `https://github.com/${config.repo}/releases/download/${config.tagPrefix}${version}/${assetName}`;
	const archivePath = join(TOOLS_DIR, assetName);
	const binaryExt = plat === "win32" ? ".exe" : "";
	const binaryPath = join(TOOLS_DIR, config.binaryName + binaryExt);

	// Download and verify before anything is extracted or made executable.
	await downloadFile(downloadUrl, archivePath);
	try {
		verifyToolArchive(tool, assetName, archivePath);
	} catch (error) {
		rmSync(archivePath, { force: true });
		throw error;
	}

	// Extract into a unique temp directory. fd and rg downloads can run concurrently
	// during startup, so sharing a fixed directory causes races.
	const extractDir = join(
		TOOLS_DIR,
		`extract_tmp_${config.binaryName}_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
	);
	mkdirSync(extractDir, { recursive: true });

	try {
		if (assetName.endsWith(".tar.gz")) {
			extractTarGzArchive(archivePath, extractDir, assetName);
		} else if (assetName.endsWith(".zip")) {
			extractZipArchive(archivePath, extractDir, assetName);
		} else {
			throw new Error(`Unsupported archive format: ${assetName}`);
		}

		// Find the binary in extracted files. Some archives contain files directly
		// at root, others nest under a versioned subdirectory.
		const binaryFileName = config.binaryName + binaryExt;
		const extractedDir = join(extractDir, assetName.replace(/\.(tar\.gz|zip)$/, ""));
		const extractedBinaryCandidates = [join(extractedDir, binaryFileName), join(extractDir, binaryFileName)];
		let extractedBinary = extractedBinaryCandidates.find((candidate) => existsSync(candidate));

		if (!extractedBinary) {
			extractedBinary = findBinaryRecursively(extractDir, binaryFileName) ?? undefined;
		}

		if (extractedBinary) {
			renameSync(extractedBinary, binaryPath);
		} else {
			throw new Error(`Binary not found in archive: expected ${binaryFileName} under ${extractDir}`);
		}

		// Make executable (Unix only)
		if (plat !== "win32") {
			chmodSync(binaryPath, 0o755);
		}
	} finally {
		// Cleanup
		rmSync(archivePath, { force: true });
		rmSync(extractDir, { recursive: true, force: true });
	}

	return binaryPath;
}

// Termux package names for tools
const TERMUX_PACKAGES: Record<string, string> = {
	fd: "fd",
	rg: "ripgrep",
};

export interface ToolStatus {
	type: "info" | "warning";
	message: string;
}

/**
 * Ensure a tool is available, downloading if necessary.
 * Reports progress through `onStatus`; status messages are otherwise silent.
 * Returns the tool path, or undefined if unavailable.
 */
export async function ensureTool(
	tool: "fd" | "rg",
	onStatus?: (status: ToolStatus) => void,
): Promise<string | undefined> {
	const existingPath = getToolPath(tool);
	if (existingPath) {
		return existingPath;
	}

	const config = TOOLS[tool];
	if (!config) return undefined;

	if (isOfflineModeEnabled()) {
		onStatus?.({ type: "warning", message: `${config.name} not found. Offline mode enabled, skipping download.` });
		return undefined;
	}

	// On Android/Termux, Linux binaries don't work due to Bionic libc incompatibility.
	// Users must install via pkg.
	if (platform() === "android") {
		const pkgName = TERMUX_PACKAGES[tool] ?? tool;
		onStatus?.({ type: "warning", message: `${config.name} not found. Install with: pkg install ${pkgName}` });
		return undefined;
	}

	// Tool not found - download it
	onStatus?.({ type: "info", message: `${config.name} not found. Downloading...` });

	try {
		const path = await downloadTool(tool);
		onStatus?.({ type: "info", message: `${config.name} installed to ${path}` });
		return path;
	} catch (e) {
		// Include the error cause chain: fetch failures surface as a bare
		// "fetch failed" TypeError with the actionable detail (DNS, TLS,
		// timeout) hidden in the cause. Depth-capped to guard against
		// circular cause chains.
		const messages: string[] = [];
		for (
			let current: unknown = e, depth = 0;
			current instanceof Error && depth < 5;
			current = current.cause, depth++
		) {
			if (!messages.includes(current.message)) messages.push(current.message);
		}
		onStatus?.({
			type: "warning",
			message: `Failed to download ${config.name}: ${messages.length > 0 ? messages.join(": ") : String(e)}`,
		});
		return undefined;
	}
}
