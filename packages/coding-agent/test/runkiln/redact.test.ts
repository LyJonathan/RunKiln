import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { callState } from "../../src/core/runkiln/permission-judge.ts";
import { serializeSessionBranch } from "../../src/core/session-export.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import {
	containsSecret,
	redactDeep,
	redactSecrets,
	resetSecretValueCache,
	savedKeyValues,
	secretEnvValues,
} from "../../src/utils/redact.ts";

const none = { values: [] };

// Built from parts so this file does not itself look like it holds live keys.
const fake = {
	openai: `sk-${"proj-"}${"A1b2C3d4E5f6G7h8I9j0K1l2M3n4"}`,
	anthropic: `sk-ant-${"api03-"}${"x".repeat(30)}`,
	openrouter: `sk-or-v1-${"0123456789abcdef".repeat(3)}`,
	ghp: `ghp_${"a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8"}`,
	pat: `github_pat_${"11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz"}`,
	slack: `xoxb-${"1234567890-0987654321-AbCdEfGhIjKl"}`,
	aws: `AKIA${"IOSFODNN7EXAMPLE"}`,
	boat: `boat_${"live_0123456789abcdefXYZ"}`,
	jwt: `eyJ${"hbGciOiJIUzI1NiJ9"}.eyJ${"zdWIiOiIxMjM0NTY3ODkwIn0"}.${"dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"}`,
	pem: `-----BEGIN ${"OPENSSH"} PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\nAAAABG5vbmUAAAAEbm9uZQ\n-----END ${"OPENSSH"} PRIVATE KEY-----`,
};

let dir: string | undefined;
afterEach(() => {
	if (dir) rmSync(dir, { recursive: true, force: true });
	dir = undefined;
	resetSecretValueCache();
	vi.unstubAllEnvs();
});

describe("redactSecrets: token formats", () => {
	it.each([
		["openai", fake.openai, "openai-key"],
		["anthropic", fake.anthropic, "anthropic-key"],
		["openrouter", fake.openrouter, "openrouter-key"],
		["github ghp_", fake.ghp, "github-token"],
		["github_pat_", fake.pat, "github-token"],
		["slack", fake.slack, "slack-token"],
		["aws", fake.aws, "aws-access-key"],
		["boat", fake.boat, "boat-key"],
		["jwt", fake.jwt, "jwt"],
		["pem", fake.pem, "private-key"],
	])("%s", (_name, secret, kind) => {
		const out = redactSecrets(`before ${secret} after`, none);
		expect(out).toBe(`before [redacted:${kind}] after`);
		expect(out).not.toContain(secret);
	});

	it("keeps the scheme and user of URL credentials and the Bearer word", () => {
		expect(redactSecrets("git clone https://john:hunter2pass@example.com/r.git", none)).toBe(
			"git clone https://john:[redacted:url-credentials]@example.com/r.git",
		);
		expect(redactSecrets("Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345", none)).toBe(
			"Authorization: Bearer [redacted:bearer-token]",
		);
	});

	it("leaves ordinary text alone", () => {
		const text = "sk-learn is a library; task-runner; ghp_short; AKIA; eyJ alone; https://example.com/a:b";
		expect(redactSecrets(text, none)).toBe(text);
		expect(containsSecret(text, none)).toBe(false);
	});
});

describe("redactSecrets: exact values", () => {
	it("replaces RunKiln's keys and secret-looking env values by name, not paths or short values", () => {
		vi.stubEnv("RUNINFRA_API_KEY", "rk_live_exact_value_1234");
		vi.stubEnv("MY_SERVICE_TOKEN", "plainvalue-without-format-999");
		vi.stubEnv("SSH_KEY_PATH", "/home/john/.ssh/id_ed25519");
		vi.stubEnv("SHORT_KEY", "abc");
		vi.stubEnv("EDITOR", "nvim-long-enough");
		const names = secretEnvValues().map((entry) => entry.name);
		expect(names).toContain("RUNINFRA_API_KEY");
		expect(names).toContain("MY_SERVICE_TOKEN");
		expect(names).not.toContain("SSH_KEY_PATH");
		expect(names).not.toContain("SHORT_KEY");
		expect(names).not.toContain("EDITOR");
		const out = redactSecrets(
			"key=rk_live_exact_value_1234 t=plainvalue-without-format-999 p=/home/john/.ssh/id_ed25519",
		);
		expect(out).toBe("key=[secret:RUNINFRA_API_KEY] t=[secret:MY_SERVICE_TOKEN] p=/home/john/.ssh/id_ed25519");
	});

	it("reads saved keys from runinfra.json, router-keys.json and auth.json", () => {
		dir = mkdtempSync(join(tmpdir(), "rk-redact-"));
		writeFileSync(join(dir, "runinfra.json"), JSON.stringify({ apiKey: "saved-runinfra-key-123", baseUrl: "x" }));
		writeFileSync(
			join(dir, "router-keys.json"),
			JSON.stringify({ jev: "saved-jev-key-456", openrouter: { apiKey: "or-key-789xyz" } }),
		);
		writeFileSync(
			join(dir, "auth.json"),
			JSON.stringify({ p: { type: "oauth", access: "access-tok-abcdef", refresh: "refresh-tok-ghijkl" } }),
		);
		const values = savedKeyValues(dir).map((entry) => entry.value);
		expect(values).toEqual(
			expect.arrayContaining([
				"saved-runinfra-key-123",
				"saved-jev-key-456",
				"or-key-789xyz",
				"access-tok-abcdef",
				"refresh-tok-ghijkl",
			]),
		);
		expect(values).not.toContain("oauth");
	});
});

describe("redactDeep", () => {
	it("redacts nested strings, keeps images and returns the same object when nothing matches", () => {
		const clean = { a: ["x", { b: "y" }] };
		expect(redactDeep(clean, none)).toBe(clean);
		const image = { type: "image", data: `QUtJQ${"A".repeat(40)}`, mimeType: "image/png" };
		const entry = { message: { content: [{ type: "text", text: `token ${fake.ghp}` }, image] } };
		const out = redactDeep(entry, none);
		expect(JSON.stringify(out)).not.toContain(fake.ghp);
		expect(out.message.content[1]).toBe(image);
		expect(entry.message.content[0]).toEqual({ type: "text", text: `token ${fake.ghp}` });
	});
});

describe("redaction choke points", () => {
	it("session files and JSONL exports are redacted, the in-memory session is not", () => {
		dir = mkdtempSync(join(tmpdir(), "rk-redact-"));
		const manager = SessionManager.create(dir, join(dir, "sessions"));
		manager.appendMessage({ role: "user", content: `use ${fake.openai}`, timestamp: Date.now() });
		manager.appendMessage({ role: "user", content: `and ${fake.aws}`, timestamp: Date.now() });
		const file = readFileSync(manager.getSessionFile()!, "utf8");
		expect(file).not.toContain(fake.openai);
		expect(file).not.toContain(fake.aws);
		expect(file).toContain("[redacted:openai-key]");
		expect(JSON.stringify(manager.getEntries())).toContain(fake.openai);
		const exported = serializeSessionBranch(manager);
		expect(exported).not.toContain(fake.openai);
		expect(exported).toContain("[redacted:aws-access-key]");
	});

	it("decision-model requests are redacted before the arguments are capped", () => {
		const long = `${"a".repeat(3990)} ${fake.ghp}`;
		const state = callState({
			toolName: "bash",
			args: { command: `curl -H "Authorization: token ${fake.ghp}" https://example.com && echo ${long}` },
			cwd: "/p",
			summary: `curl ${fake.ghp}`,
			context: { request: `here is my key ${fake.openai}`, recentTurns: [`set ${fake.aws}`] },
		} as Parameters<typeof callState>[0]);
		const text = JSON.stringify(state);
		for (const secret of [fake.ghp, fake.openai, fake.aws]) expect(text).not.toContain(secret);
		expect(text).toContain("[redacted:github-token]");
	});
});
