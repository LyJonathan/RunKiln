import { posix, win32 } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useWindowsKeybindings } from "../../src/core/keybindings.ts";
import { DEFAULT_TOOL_NAMES, platformDefaultToolNames } from "../../src/core/settings-manager.ts";
import { detectLineEnding, normalizeToLF, restoreLineEndings } from "../../src/core/tools/edit-diff.ts";
import { normalizePath, normalizeWindowsShellPath, toPosixRelative } from "../../src/utils/paths.ts";
import { resolveWindowsBash, type WindowsShellProbe, windowsGitBashCandidates } from "../../src/utils/shell.ts";
import { getToolAssetName, getToolBinaryFileName } from "../../src/utils/tools-manager.ts";

/** A simulated Windows machine: the files that exist and what `where` prints. */
function probe(files: string[], where: Record<string, string[]> = {}, env: NodeJS.ProcessEnv = {}): WindowsShellProbe {
	const existing = new Set(files.map((f) => f.toLowerCase()));
	return {
		env: {
			ProgramFiles: "C:\\Program Files",
			"ProgramFiles(x86)": "C:\\Program Files (x86)",
			LOCALAPPDATA: "C:\\Users\\jo\\AppData\\Local",
			USERPROFILE: "C:\\Users\\jo",
			...env,
		},
		exists: (path) => existing.has(path.toLowerCase()),
		where: (name) => where[name] ?? [],
	};
}

describe("Windows bash detection", () => {
	it("finds Git for Windows in Program Files", () => {
		const bash = "C:\\Program Files\\Git\\bin\\bash.exe";
		expect(resolveWindowsBash(probe([bash]))).toEqual({ shell: bash, args: ["-c"] });
	});

	it("finds a per-user Git install under LOCALAPPDATA", () => {
		const bash = "C:\\Users\\jo\\AppData\\Local\\Programs\\Git\\bin\\bash.exe";
		expect(resolveWindowsBash(probe([bash]))?.shell).toBe(bash);
	});

	it("finds Scoop's Git under the user profile and under SCOOP", () => {
		const bash = "C:\\Users\\jo\\scoop\\apps\\git\\current\\bin\\bash.exe";
		expect(resolveWindowsBash(probe([bash]))?.shell).toBe(bash);
		const custom = "D:\\scoop\\apps\\git\\current\\bin\\bash.exe";
		expect(resolveWindowsBash(probe([custom], {}, { SCOOP: "D:\\scoop" }))?.shell).toBe(custom);
	});

	it("derives Git Bash from git.exe on PATH (cmd and mingw64 layouts)", () => {
		const bash = "D:\\tools\\Git\\bin\\bash.exe";
		expect(resolveWindowsBash(probe([bash], { "git.exe": ["D:\\tools\\Git\\cmd\\git.exe"] }))?.shell).toBe(bash);
		expect(resolveWindowsBash(probe([bash], { "git.exe": ["D:\\tools\\Git\\mingw64\\bin\\git.exe"] }))?.shell).toBe(
			bash,
		);
	});

	it("prefers a native bash on PATH over WSL's System32 bash listed first", () => {
		const wsl = "C:\\Windows\\System32\\bash.exe";
		const msys = "C:\\msys64\\usr\\bin\\bash.exe";
		expect(resolveWindowsBash(probe([wsl, msys], { "bash.exe": [wsl, msys] }))).toEqual({
			shell: msys,
			args: ["-c"],
		});
	});

	it("falls back to WSL bash, which takes the command on stdin", () => {
		const wsl = "C:\\Windows\\System32\\bash.exe";
		expect(resolveWindowsBash(probe([wsl], { "bash.exe": [wsl] }))).toEqual({
			shell: wsl,
			args: ["-s"],
			commandTransport: "stdin",
		});
	});

	it("skips the WindowsApps WSL stub and paths `where` lists that do not exist", () => {
		const stub = "C:\\Users\\jo\\AppData\\Local\\Microsoft\\WindowsApps\\bash.exe";
		expect(resolveWindowsBash(probe([stub], { "bash.exe": [stub, "C:\\gone\\bash.exe"] }))).toBeUndefined();
	});

	it("lists each candidate once", () => {
		const candidates = windowsGitBashCandidates(
			probe([], { "git.exe": ["C:\\Program Files\\Git\\cmd\\git.exe"] }, { ProgramW6432: "C:\\Program Files" }),
		);
		expect(candidates.filter((c) => c === "C:\\Program Files\\Git\\bin\\bash.exe")).toHaveLength(1);
	});
});

describe("default tools on Windows", () => {
	it("swaps bash for powershell only on Windows without bash", () => {
		expect(platformDefaultToolNames(() => false, "win32")).toEqual(["read", "powershell", "edit", "write"]);
		expect(platformDefaultToolNames(() => true, "win32")).toBe(DEFAULT_TOOL_NAMES);
		expect(platformDefaultToolNames(() => false, "linux")).toBe(DEFAULT_TOOL_NAMES);
	});
});

describe("Windows paths", () => {
	it("converts Git Bash, Cygwin and WSL drive paths", () => {
		expect(normalizeWindowsShellPath("/c/Users/jo/repo")).toBe("C:\\Users\\jo\\repo");
		expect(normalizeWindowsShellPath("/mnt/d/work")).toBe("D:\\work");
		expect(normalizeWindowsShellPath("/cygdrive/e/")).toBe("E:\\");
		expect(normalizeWindowsShellPath("/d")).toBe("D:\\");
		expect(normalizeWindowsShellPath("/usr/bin")).toBe("/usr/bin");
		expect(normalizeWindowsShellPath("//server/share")).toBe("//server/share");
		expect(normalizeWindowsShellPath("C:\\x")).toBe("C:\\x");
	});

	it("relative paths inside the project use / separators", () => {
		const cwd = "C:\\Users\\jo\\repo";
		expect(toPosixRelative(cwd, "C:\\Users\\jo\\repo\\src\\a.ts", win32)).toBe("src/a.ts");
		expect(toPosixRelative(cwd, "src\\core\\b.ts", win32)).toBe("src/core/b.ts");
		expect(toPosixRelative(cwd, "c:\\users\\JO\\repo\\src", win32)).toBe("src");
		expect(toPosixRelative(cwd, cwd, win32)).toBe(".");
	});

	it("paths outside the project, on another drive or a UNC share are not relative", () => {
		const cwd = "C:\\Users\\jo\\repo";
		expect(toPosixRelative(cwd, "C:\\Users\\jo\\other\\x.ts", win32)).toBeUndefined();
		expect(toPosixRelative(cwd, "D:\\repo\\x.ts", win32)).toBeUndefined();
		expect(toPosixRelative(cwd, "\\\\server\\share\\x.ts", win32)).toBeUndefined();
		expect(toPosixRelative("/home/jo/repo", "/home/jo/repo/src/a.ts", posix)).toBe("src/a.ts");
	});

	describe("with process.platform simulated as win32", () => {
		const original = Object.getOwnPropertyDescriptor(process, "platform")!;
		afterEach(() => Object.defineProperty(process, "platform", original));

		it("expands ~\\ and converts drive paths", () => {
			Object.defineProperty(process, "platform", { value: "win32" });
			expect(normalizePath("~\\.runkiln\\agent", { homeDir: "/home/jo" })).toBe(
				posix.join("/home/jo", ".runkiln\\agent"),
			);
			expect(normalizePath("/c/work/repo")).toBe("C:\\work\\repo");
			expect(normalizePath("@/c/a.ts", { stripAtPrefix: true })).toBe("C:\\a.ts");
		});
	});
});

describe("ripgrep and fd downloads for Windows", () => {
	it("picks the MSVC zip for x64 and arm64", () => {
		expect(getToolAssetName("rg", "14.1.1", "win32", "x64")).toBe("ripgrep-14.1.1-x86_64-pc-windows-msvc.zip");
		expect(getToolAssetName("rg", "14.1.1", "win32", "arm64")).toBe("ripgrep-14.1.1-aarch64-pc-windows-msvc.zip");
		expect(getToolAssetName("fd", "10.2.0", "win32", "x64")).toBe("fd-v10.2.0-x86_64-pc-windows-msvc.zip");
		expect(getToolAssetName("fd", "10.2.0", "win32", "arm64")).toBe("fd-v10.2.0-aarch64-pc-windows-msvc.zip");
	});

	it("uses .exe names on Windows only", () => {
		expect(getToolBinaryFileName("rg", "win32")).toBe("rg.exe");
		expect(getToolBinaryFileName("fd", "linux")).toBe("fd");
		expect(getToolAssetName("rg", "14.1.1", "freebsd", "x64")).toBeNull();
	});
});

describe("Windows keybindings and line endings", () => {
	it("uses Windows keybindings on win32 and inside WSL", () => {
		expect(useWindowsKeybindings("win32", {})).toBe(true);
		expect(useWindowsKeybindings("linux", { WSL_DISTRO_NAME: "Ubuntu" })).toBe(true);
		expect(useWindowsKeybindings("linux", {})).toBe(false);
		expect(useWindowsKeybindings("darwin", {})).toBe(false);
	});

	it("keeps CRLF files CRLF through an edit", () => {
		const original = "a\r\nb\r\nc\r\n";
		const ending = detectLineEnding(original);
		expect(ending).toBe("\r\n");
		const edited = normalizeToLF(original).replace("b", "B");
		expect(restoreLineEndings(edited, ending)).toBe("a\r\nB\r\nc\r\n");
	});
});
