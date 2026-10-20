import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { pruneSessionCheckpoints, sessionCheckpointDir } from "../../src/core/runkiln/checkpoints.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { appendLedgerRows, type LedgerRow } from "../../src/core/usage/ledger.ts";
import {
	currentUserSid,
	ensurePrivateDir,
	hardenAgentStorage,
	hardenPrivateTree,
	icaclsArgs,
	WINDOWS_ACL_MARKER,
} from "../../src/utils/private-files.ts";

const posix = process.platform !== "win32";
const mode = (path: string) => statSync(path).mode & 0o777;

let root: string | undefined;
function tmp(): string {
	root = mkdtempSync(join(tmpdir(), "rk-private-"));
	return root;
}
afterEach(() => {
	if (root) rmSync(root, { recursive: true, force: true });
	root = undefined;
});

describe.runIf(posix)("private agent storage on POSIX", () => {
	it("ensurePrivateDir creates 0700 folders and fixes an existing 0755 one", () => {
		const base = tmp();
		const fresh = join(base, "a", "b");
		ensurePrivateDir(fresh);
		expect(mode(fresh)).toBe(0o700);
		const open = join(base, "open");
		mkdirSync(open, { mode: 0o755 });
		chmodSync(open, 0o755);
		ensurePrivateDir(open);
		expect(mode(open)).toBe(0o700);
	});

	it("hardenPrivateTree strips group and other access, keeps owner bits and leaves links alone", () => {
		const base = tmp();
		const dir = join(base, "agent");
		mkdirSync(join(dir, "sessions"), { recursive: true });
		chmodSync(join(dir, "sessions"), 0o755);
		writeFileSync(join(dir, "sessions", "s.jsonl"), "{}\n");
		chmodSync(join(dir, "sessions", "s.jsonl"), 0o644);
		mkdirSync(join(dir, "bin"));
		writeFileSync(join(dir, "bin", "rg"), "");
		chmodSync(join(dir, "bin", "rg"), 0o755);
		const outside = join(base, "outside.txt");
		writeFileSync(outside, "");
		chmodSync(outside, 0o644);
		symlinkSync(outside, join(dir, "link"));
		const fixed = hardenPrivateTree(dir);
		expect(fixed).toBeGreaterThanOrEqual(3);
		expect(mode(join(dir, "sessions"))).toBe(0o700);
		expect(mode(join(dir, "sessions", "s.jsonl"))).toBe(0o600);
		expect(mode(join(dir, "bin", "rg"))).toBe(0o700);
		expect(mode(outside)).toBe(0o644);
	});

	it("hardenAgentStorage walks an open agent folder, skips the walk once private, and never walks extra folders", () => {
		const base = tmp();
		const agent = join(base, "agent");
		mkdirSync(agent, { mode: 0o755 });
		chmodSync(agent, 0o755);
		writeFileSync(join(agent, "settings.json"), "{}");
		chmodSync(join(agent, "settings.json"), 0o644);
		const shared = join(base, "shared-sessions");
		mkdirSync(shared, { mode: 0o755 });
		chmodSync(shared, 0o755);
		writeFileSync(join(shared, "other.txt"), "");
		chmodSync(join(shared, "other.txt"), 0o644);

		hardenAgentStorage(agent, [shared]);
		expect(mode(agent)).toBe(0o700);
		expect(mode(join(agent, "settings.json"))).toBe(0o600);
		expect(mode(shared)).toBe(0o700);
		expect(mode(join(shared, "other.txt"))).toBe(0o644);

		// Already private: the contents are hidden by the folder, so the walk is skipped.
		chmodSync(join(agent, "settings.json"), 0o644);
		hardenAgentStorage(agent);
		expect(mode(join(agent, "settings.json"))).toBe(0o644);
	});

	it("session files are 0600 in a 0700 folder", () => {
		const base = tmp();
		const sessions = join(base, "sessions");
		const manager = SessionManager.create(base, sessions);
		manager.appendMessage({ role: "user", content: "hi", timestamp: Date.now() });
		manager.appendMessage({ role: "user", content: "again", timestamp: Date.now() });
		const file = manager.getSessionFile();
		expect(file && existsSync(file)).toBe(true);
		expect(mode(sessions)).toBe(0o700);
		expect(mode(file!)).toBe(0o600);
	});

	it("ledger rows are written 0600", () => {
		const base = tmp();
		const path = join(base, "usage", "ledger.jsonl");
		const row = {
			v: 1,
			ts: new Date().toISOString(),
			sid: "s",
			id: "e",
			cat: "main",
			kind: "turn",
			provider: "p",
			model: "m",
			in: 1,
			out: 1,
			cr: 0,
			cw: 0,
			cost: 0,
		} as unknown as LedgerRow;
		appendLedgerRows(path, [row]);
		expect(mode(path)).toBe(0o600);
		expect(mode(join(base, "usage"))).toBe(0o700);
	});
});

describe("private agent storage on Windows (simulated)", () => {
	it("reads the SID from whoami and builds one icacls call with inheritance for folders", () => {
		const calls: string[][] = [];
		const execFile = (command: string, args: readonly string[]) => {
			calls.push([command, ...args]);
			return command === "whoami" ? '"host\\\\john","S-1-5-21-111-222-333-1001"\r\n' : "";
		};
		expect(currentUserSid({ execFile })).toBe("S-1-5-21-111-222-333-1001");
		expect(icaclsArgs("C:\\a", "S-1-5-21-1", true)).toEqual([
			"C:\\a",
			"/inheritance:r",
			"/grant:r",
			"*S-1-5-21-1:(OI)(CI)F",
		]);
		expect(icaclsArgs("C:\\a\\f", "S-1-5-21-1", false)[3]).toBe("*S-1-5-21-1:F");

		const base = tmp();
		const agent = join(base, "agent");
		hardenAgentStorage(agent, [], { platform: "win32", execFile });
		const icacls = calls.filter((call) => call[0] === "icacls");
		expect(icacls).toEqual([["icacls", agent, "/inheritance:r", "/grant:r", "*S-1-5-21-111-222-333-1001:(OI)(CI)F"]]);
		expect(existsSync(join(agent, WINDOWS_ACL_MARKER))).toBe(true);

		// Later starts skip whoami and icacls.
		calls.length = 0;
		hardenAgentStorage(agent, [], { platform: "win32", execFile });
		expect(calls).toEqual([]);
	});

	it("does not write the marker when icacls fails, so the next start tries again", () => {
		const base = tmp();
		const agent = join(base, "agent");
		const execFile = (command: string) => {
			if (command === "whoami") return "S-1-5-21-9";
			throw new Error("icacls failed");
		};
		hardenAgentStorage(agent, [], { platform: "win32", execFile });
		expect(existsSync(join(agent, WINDOWS_ACL_MARKER))).toBe(false);
	});
});

describe("checkpoint pruning", () => {
	it("removes a deleted session's checkpoints and refuses names that resolve to the root", () => {
		const base = tmp();
		const rootDir = join(base, "checkpoints");
		const dir = sessionCheckpointDir(rootDir, "abc-123");
		mkdirSync(join(dir, "blobs"), { recursive: true });
		writeFileSync(join(dir, "blobs", "x"), "SECRET=1");
		mkdirSync(join(rootDir, "other"), { recursive: true });

		expect(pruneSessionCheckpoints(rootDir, "abc-123")).toBe(true);
		expect(existsSync(dir)).toBe(false);
		expect(pruneSessionCheckpoints(rootDir, "abc-123")).toBe(false);
		expect(pruneSessionCheckpoints(rootDir, "..")).toBe(false);
		expect(pruneSessionCheckpoints(rootDir, "")).toBe(false);
		expect(pruneSessionCheckpoints(rootDir, "../..")).toBe(false);
		expect(readdirSync(rootDir)).toEqual(["other"]);
	});
});
