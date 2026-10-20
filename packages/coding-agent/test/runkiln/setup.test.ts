import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Input } from "@runkiln/tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { isPermissionJudgeAvailable } from "../../src/core/runkiln/permission-judge.ts";
import { needsFirstRunSetup, SETUP_DONE } from "../../src/core/runkiln/setup.ts";
import {
	type SetupResult,
	SetupWizard,
	type SetupWizardOptions,
} from "../../src/modes/interactive/components/setup/setup-wizard.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";

const SECRET = "rk_test_key_do_not_print";
const OTHER_SECRET = "rk_old_key_do_not_print";
const ENV_SECRET = "rk_env_key_do_not_print";
const BODY_SENTINEL = "RESPONSE_BODY_SENTINEL";
const HEADER_SENTINEL = "HEADER_SENTINEL";

let dir: string | undefined;
let server: Server | undefined;
const consoleSpies: Array<{ mockRestore: () => void }> = [];
const consoleText: string[] = [];

afterEach(async () => {
	if (dir) rmSync(dir, { recursive: true, force: true });
	dir = undefined;
	if (server) {
		await new Promise<void>((resolve, reject) => server?.close((error) => (error ? reject(error) : resolve())));
		server = undefined;
	}
	for (const spy of consoleSpies) spy.mockRestore();
	consoleSpies.length = 0;
	consoleText.length = 0;
	delete process.env.RUNKILN_SESSION_ID;
	delete process.env.RUNKILN_PARENT_SESSION_ID;
});

function agentDir(): string {
	dir = mkdtempSync(join(tmpdir(), "runkiln-setup-"));
	return dir;
}

function captureConsole(): void {
	for (const method of ["log", "info", "warn", "error", "debug"] as const) {
		consoleSpies.push(
			vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
				consoleText.push(args.map((arg) => String(arg)).join(" "));
			}),
		);
	}
}

interface Reply {
	status: number;
	body: string;
	headers?: Record<string, string>;
}

function serve(reply: Reply | ((requestIndex: number) => Reply)): Promise<{
	baseUrl: string;
	requests: Array<{ method?: string; url?: string; headers: IncomingHttpHeaders }>;
}> {
	const requests: Array<{ method?: string; url?: string; headers: IncomingHttpHeaders }> = [];
	server = createServer((req, res) => {
		const index = requests.length;
		requests.push({ method: req.method, url: req.url, headers: req.headers });
		req.resume();
		const next = typeof reply === "function" ? reply(index) : reply;
		res.writeHead(next.status, next.headers ?? { "content-type": "application/json" });
		res.end(next.body);
	});
	return new Promise((resolve) => {
		server?.listen(0, "127.0.0.1", () => {
			const address = server?.address();
			if (!address || typeof address === "string") throw new Error("no port");
			resolve({ baseUrl: `http://127.0.0.1:${address.port}/v1`, requests });
		});
	});
}

const MODELS_BODY = JSON.stringify({
	sentinel: BODY_SENTINEL,
	data: [
		{ id: "glm-5-3-flash", price: { in: 0.11, out: 0.45 } },
		{ id: "deepseek-v4-1-flash-1017" },
		{ id: "ornith-1-5-35b" },
		{ id: "qwen3-8-27b", status: "paused" },
		{ id: "not-in-catalog", price: { in: 9, out: 9 } },
		{ id: "nemotron-3-5-lightning-30b", available: false },
	],
});

const stripAnsi = (text: string) =>
	text.replace(/\x1b\[[0-9;]*m|\x1b\]8;[^\x07\x1b]*(?:\x07|\x1b\\)|\x1b_[^\x07]*\x07/g, "");

function assertNoSecret(text: string, secrets: string[]): void {
	for (const secret of secrets) {
		expect(text).not.toContain(secret);
	}
	expect(text).not.toContain(BODY_SENTINEL);
	expect(text).not.toContain(HEADER_SENTINEL);
	expect(text).not.toContain("Authorization");
	expect(text).not.toContain("Bearer");
}

type Harness = {
	wizard: SetupWizard;
	text: () => string;
	frame: (width?: number) => string[];
	type: (value: string) => Promise<void>;
	press: (...keys: string[]) => Promise<void>;
	result: { done?: SetupResult; cancelled?: boolean };
	rows: { value: number };
};

function harness(options: Partial<SetupWizardOptions> & { agentDir: string }): Harness {
	const result: Harness["result"] = {};
	const rows = { value: 34 };
	const wizard = new SetupWizard({
		env: {},
		layout: "inline",
		themes: ["system", "dark", "light"],
		previewTheme: () => undefined,
		spinnerIntervalMs: 0,
		keyAdvanceMs: 0,
		getRows: () => rows.value,
		onComplete: (value) => {
			result.done = value;
		},
		onCancel: () => {
			result.cancelled = true;
		},
		...options,
	});
	const frame = (width = 100) => wizard.render(width).map(stripAnsi);
	return {
		wizard,
		frame,
		text: () => frame(120).join("\n"),
		type: async (value) => {
			for (const char of value) wizard.handleInput(char);
			await wizard.whenIdle();
		},
		press: async (...keys) => {
			for (const key of keys) {
				wizard.handleInput(key);
				await wizard.whenIdle();
			}
		},
		result,
		rows,
	};
}

const ENTER = "\r";
const ESC = "\x1b";
const UP = "\x1b[A";
const DOWN = "\x1b[B";
const LEFT = "\x1b[D";
const RIGHT = "\x1b[C";
const CTRL_C = "\x03";

/** A key that checks out stays on the key step with its result; enter moves on. */
async function passKeyStep(h: Harness): Promise<void> {
	expect(h.wizard.step).toBe("key");
	expect(h.text()).toMatch(/✓ Key works - \d+ models?/);
	await h.press(ENTER);
	expect(h.wizard.step).toBe("model");
}

/** From the model step: accept the defaults (manual model, permissions, theme) and land on the review. */
async function toReview(h: Harness): Promise<void> {
	for (let i = 0; i < 4 && h.wizard.step !== "summary"; i++) await h.press(ENTER);
	expect(h.wizard.step).toBe("summary");
}

describe("setup wizard: key step", () => {
	beforeAll(() => initTheme("dark"));

	it("masks the key input and never echoes it", () => {
		const input = new Input({ mask: true, prompt: "Key " });
		for (const char of SECRET) input.handleInput(char);
		const rendered = input.render(60).join("\n");
		expect(rendered).not.toContain(SECRET);
		expect(rendered).toContain("•");
		expect(input.getValue()).toBe(SECRET);
	});

	it("uses RUNINFRA_API_KEY without asking for a key and does not save it", async () => {
		captureConsole();
		const root = agentDir();
		const { baseUrl, requests } = await serve({
			status: 200,
			body: MODELS_BODY,
			headers: { "content-type": "application/json", "x-leak": HEADER_SENTINEL },
		});
		process.env.RUNKILN_SESSION_ID = "session-must-not-be-sent";
		const h = harness({ agentDir: root, env: { RUNINFRA_API_KEY: ENV_SECRET }, baseUrl });
		await h.wizard.whenIdle();
		const checked = h.text();
		expect(checked).toContain("● Key - ○ Model");
		expect(checked).toContain("Using `RUNINFRA_API_KEY` from your environment.");
		expect(checked).toContain("✓ Key works - 3 models");
		assertNoSecret(checked, [ENV_SECRET, SECRET]);

		await h.press(ENTER);
		expect(h.wizard.step).toBe("model");
		await toReview(h);
		expect(h.text()).toContain("RUNINFRA_API_KEY ✓");
		await h.press(ENTER);
		expect(h.result.done?.lines).toContain("Using `RUNINFRA_API_KEY` from your environment.");
		expect(h.result.done?.savedKey).toBe(false);
		assertNoSecret(`${h.result.done?.lines.join("\n")}\n${consoleText.join("\n")}`, [ENV_SECRET]);
		expect(requests).toHaveLength(1);
		expect(requests[0]?.url).toBe("/v1/models");
		expect(requests[0]?.headers.authorization).toBe(`Bearer ${ENV_SECRET}`);
		expect(Object.keys(requests[0]?.headers ?? {}).map((name) => name.toLowerCase())).not.toContain("x-session-id");
		expect(readdirSync(root).includes("runinfra.json")).toBe(false);
	});

	it("shows a clear error on 401, clears the field, and hides the body and headers", async () => {
		captureConsole();
		const root = agentDir();
		const { baseUrl } = await serve({
			status: 401,
			body: `BODYLEAK ${SECRET}`,
			headers: { "content-type": "text/plain", "x-leak": HEADER_SENTINEL },
		});
		const h = harness({ agentDir: root, baseUrl });
		await h.type(SECRET);
		const masked = h.text();
		expect(masked).toContain("•");
		expect(masked).toContain(`${SECRET.length} characters, hidden`);
		assertNoSecret(masked, [SECRET]);

		await h.press(ENTER);
		const failed = h.text();
		expect(failed).toContain("✗ invalid key");
		expect(failed).toContain("https://runinfra.ai");
		expect(failed).not.toContain("401");
		expect(failed).not.toContain("BODYLEAK");
		expect(failed).not.toContain("•");
		expect(h.wizard.step).toBe("key");
		assertNoSecret(`${failed}\n${consoleText.join("\n")}`, [SECRET]);
		expect(readdirSync(root).includes("runinfra.json")).toBe(false);
	});

	it("shows the HTTP status for a non-401 failure and not the body", async () => {
		captureConsole();
		const root = agentDir();
		const { baseUrl } = await serve({
			status: 500,
			body: `BODYLEAK ${SECRET}`,
			headers: { "x-leak": HEADER_SENTINEL },
		});
		const h = harness({ agentDir: root, baseUrl });
		await h.type(SECRET);
		await h.press(ENTER);
		const failed = h.text();
		expect(failed).toContain("500");
		expect(failed).not.toContain("BODYLEAK");
		assertNoSecret(`${failed}\n${consoleText.join("\n")}`, [SECRET]);
	});

	it("checks a pasted key as soon as the paste ends", async () => {
		const root = agentDir();
		const { baseUrl, requests } = await serve({ status: 200, body: MODELS_BODY });
		const h = harness({ agentDir: root, baseUrl });
		await h.press(`\x1b[200~${SECRET}\x1b[201~`);
		expect(requests).toHaveLength(1);
		await passKeyStep(h);
	});

	it("shows a spinner while the key is checked and ignores keys until it ends", async () => {
		const root = agentDir();
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const fetchImpl = (async () => {
			await gate;
			return new Response(MODELS_BODY, { status: 200, headers: { "content-type": "application/json" } });
		}) as typeof fetch;
		const h = harness({ agentDir: root, baseUrl: "https://api.runinfra.example/v1", fetchImpl });
		await h.type("rk_x");
		h.wizard.handleInput(ENTER);
		expect(h.text()).toMatch(/⠋ Checking with RunInfra/);
		h.wizard.handleInput("z");
		expect(h.wizard.step).toBe("key");
		release();
		await h.wizard.whenIdle();
		await passKeyStep(h);
	});

	it("saves a working key and every default, merging settings and keeping files private", async () => {
		captureConsole();
		const root = agentDir();
		writeFileSync(
			join(root, "runinfra.json"),
			`${JSON.stringify({ baseUrl: "https://api.runinfra.ai/v1", note: "keep-endpoint" }, null, 2)}\n`,
		);
		writeFileSync(
			join(root, "settings.json"),
			`${JSON.stringify({ theme: "dark", customNote: "keep-me", models: { fallback: ["glm-5-3-flash"], chat: "deepseek-v4-1-flash-1017" } }, null, 2)}\n`,
		);
		const { baseUrl, requests } = await serve({
			status: 200,
			body: MODELS_BODY,
			headers: { "content-type": "application/json", "x-leak": HEADER_SENTINEL },
		});
		process.env.RUNKILN_SESSION_ID = "session-must-not-be-sent";
		process.env.RUNKILN_PARENT_SESSION_ID = "parent-must-not-be-sent";
		const h = harness({ agentDir: root, baseUrl });
		await h.type(SECRET);
		await h.press(ENTER);
		await passKeyStep(h);
		// No classifier yet: a manual model is preselected, with live prices; paused and unknown models are hidden.
		const model = h.text();
		expect(model).toContain("❯ Manual    ‹ GLM 5.3 Flash ›");
		expect(model).toContain("$0.11 in / $0.45 out");
		expect(model).toContain("1 of 3");
		expect(model).toMatch(/Thinking\s+model default/);
		// Every row keeps its detail line, so the step never changes height.
		expect(model).toContain("needs a classifier key");
		await h.press(RIGHT);
		expect(h.text()).toContain("DeepSeek V4.1 Flash");
		await h.press(DOWN, RIGHT, RIGHT, RIGHT); // thinking: model default → off → minimal → low
		expect(h.text()).toContain("‹ low ›");
		await h.press(ENTER);
		// Manual routing needs no classifier: straight to permissions.
		expect(h.wizard.step).toBe("permissions");
		expect(h.text()).not.toContain("Classifier");
		expect(h.text()).toContain("❯ Read & write");
		await h.press(UP);
		expect(h.text()).toContain("❯ Allow all");
		expect(h.text()).toContain("every tool runs without asking");
		await h.press(DOWN, DOWN, ENTER); // Ask everything
		expect(h.wizard.step).toBe("theme");
		await h.press(ENTER);
		const review = h.text();
		expect(review).toContain("new ✓ - saved 0600");
		expect(review).toMatch(/Classifier\s+none/);
		expect(review).toContain("DeepSeek V4.1 Flash 1017 - thinking low");
		expect(review).toContain("Ask everything");
		expect(review).toContain("dark");
		assertNoSecret(review, [SECRET]);
		// Nothing is written before Finish.
		expect(JSON.parse(readFileSync(join(root, "runinfra.json"), "utf8")).apiKey).toBeUndefined();
		await h.press(ENTER);

		expect(h.result.done?.lines[0]).toBe(SETUP_DONE);
		expect(h.result.done?.lines).toContain("key saved");
		expect(h.result.done?.lines).toContain("model: deepseek-v4-1-flash-1017");
		expect(h.result.done?.lines).toContain("permissions: ask");
		assertNoSecret(`${h.result.done?.lines.join("\n")}\n${consoleText.join("\n")}`, [SECRET]);
		expect(JSON.parse(readFileSync(join(root, "runinfra.json"), "utf8"))).toEqual({
			baseUrl: "https://api.runinfra.ai/v1",
			note: "keep-endpoint",
			apiKey: SECRET,
		});
		expect(statSync(join(root, "runinfra.json")).mode & 0o777).toBe(0o600);
		expect(statSync(join(root, "settings.json")).mode & 0o777).toBe(0o600);
		expect(JSON.parse(readFileSync(join(root, "settings.json"), "utf8"))).toEqual({
			theme: "dark",
			customNote: "keep-me",
			models: { fallback: ["glm-5-3-flash"], chat: "deepseek-v4-1-flash-1017", code: "deepseek-v4-1-flash-1017" },
			defaultThinkingLevel: "low",
			permissions: { mode: "ask" },
		});
		expect(readdirSync(root).includes("router-keys.json")).toBe(false);
		expect(requests).toHaveLength(1);
		const headers = requests[0]?.headers ?? {};
		expect(headers.authorization).toBe(`Bearer ${SECRET}`);
		for (const [name, value] of Object.entries(headers)) {
			expect(name.toLowerCase()).not.toBe("x-session-id");
			expect(name.toLowerCase()).not.toBe("x-parent-session-id");
			if (name.toLowerCase() !== "authorization") expect(String(value)).not.toContain(SECRET);
		}
	});

	it("on a re-run, enter keeps the saved key (checked live); a new key replaces it only on Finish", async () => {
		captureConsole();
		const root = agentDir();
		writeFileSync(
			join(root, "runinfra.json"),
			`${JSON.stringify({ baseUrl: "https://api.runinfra.ai/v1", apiKey: OTHER_SECRET }, null, 2)}\n`,
		);
		writeFileSync(
			join(root, "settings.json"),
			JSON.stringify({ models: { code: "ornith-1-5-35b" }, permissions: "ask" }),
		);
		const { baseUrl, requests } = await serve({ status: 200, body: MODELS_BODY });

		const kept = harness({ agentDir: root, baseUrl });
		expect(kept.text()).toContain("enter keeps the saved key");
		await kept.press(ENTER);
		expect(requests.at(-1)?.headers.authorization).toBe(`Bearer ${OTHER_SECRET}`);
		await passKeyStep(kept);
		// The saved defaults are preselected.
		expect(kept.text()).toContain("‹ Ornith 1.5 35B ›");
		await kept.press(ENTER);
		expect(kept.text()).toContain("❯ Ask everything");
		await kept.press(ENTER, ENTER);
		expect(kept.text()).toMatch(/Key\s+saved ✓/);
		await kept.press(ENTER);
		expect(kept.result.done?.lines).toContain("kept the saved key");
		expect(JSON.parse(readFileSync(join(root, "runinfra.json"), "utf8")).apiKey).toBe(OTHER_SECRET);

		const replaced = harness({ agentDir: root, baseUrl });
		await replaced.type(SECRET);
		await replaced.press(ENTER);
		await passKeyStep(replaced);
		await toReview(replaced);
		expect(replaced.text()).toContain("replaces the saved key");
		// Quitting here leaves the old key in place.
		await replaced.press("q");
		expect(replaced.text()).toContain("Quit setup? Nothing has been saved.");
		await replaced.press("n");
		await replaced.press("f");
		expect(replaced.result.done?.lines).toContain("key saved");
		expect(JSON.parse(readFileSync(join(root, "runinfra.json"), "utf8"))).toEqual({
			baseUrl: "https://api.runinfra.ai/v1",
			apiKey: SECRET,
		});
		assertNoSecret(`${replaced.text()}\n${consoleText.join("\n")}`, [SECRET, OTHER_SECRET]);
	});

	it("still saves the key when Windows icacls fails, and reports the lock warning once", async () => {
		captureConsole();
		const root = agentDir();
		const { baseUrl } = await serve({ status: 200, body: MODELS_BODY });
		const calls: string[][] = [];
		const h = harness({
			agentDir: root,
			baseUrl,
			fileLock: {
				platform: "win32",
				execFile: (command, args) => {
					calls.push([command, ...args]);
					throw new Error("icacls failed");
				},
			},
		});
		await h.type(SECRET);
		await h.press(ENTER);
		await toReview(h);
		await h.press(ENTER);
		const lines = h.result.done?.lines ?? [];
		const warning = "Key saved, but RunKiln couldn't lock the file. Make `runinfra.json` readable only by you.";
		expect(lines).toContain("key saved");
		expect(lines.filter((line) => line === warning)).toEqual([warning]);
		assertNoSecret(`${lines.join("\n")}\n${consoleText.join("\n")}`, [SECRET]);
		expect(lines.join("\n")).not.toContain(root);
		expect(JSON.parse(readFileSync(join(root, "runinfra.json"), "utf8")).apiKey).toBe(SECRET);
		expect(calls[0]?.[0]).toBe("icacls");
		expect(calls[0]?.slice(1).join(" ")).toContain("runinfra.json");
	});

	it("treats a missing env key and a missing file key as first-run", () => {
		const root = agentDir();
		expect(needsFirstRunSetup(root, {})).toBe(true);
		expect(needsFirstRunSetup(root, { RUNINFRA_API_KEY: ENV_SECRET })).toBe(false);
		writeFileSync(join(root, "runinfra.json"), JSON.stringify({ apiKey: OTHER_SECRET }));
		expect(needsFirstRunSetup(root, {})).toBe(false);
	});
});

describe("setup wizard: navigation", () => {
	beforeAll(() => initTheme("dark"));

	async function atModel(options: Partial<SetupWizardOptions> = {}): Promise<Harness> {
		const root = options.agentDir ?? agentDir();
		const { baseUrl } = await serve({ status: 200, body: MODELS_BODY });
		const h = harness({ baseUrl, ...options, agentDir: root });
		if (h.wizard.step === "welcome") await h.press(ENTER);
		await h.type(SECRET);
		await h.press(ENTER);
		await passKeyStep(h);
		return h;
	}

	it("q asks before quitting outside text fields; in the key field q is typed", async () => {
		const root = agentDir();
		const h = harness({ agentDir: root, baseUrl: "https://api.runinfra.example/v1" });
		await h.press("q");
		expect(h.wizard.isQuitConfirmOpen).toBe(false);
		expect(h.text()).toContain("1 characters, hidden");
		const r = await atModel();
		await r.press("q");
		expect(r.wizard.isQuitConfirmOpen).toBe(true);
		await r.press(ESC);
		expect(r.wizard.isQuitConfirmOpen).toBe(false);
		expect(r.result.cancelled).toBeUndefined();
		await r.press("q", "y");
		expect(r.result.cancelled).toBe(true);
		expect(readdirSync(dir as string).includes("settings.json")).toBe(false);
	});

	it("ctrl+c opens the quit prompt, and a second ctrl+c quits, even in a text field", async () => {
		const root = agentDir();
		const h = harness({ agentDir: root, baseUrl: "https://api.runinfra.example/v1" });
		await h.type("rk_partial");
		await h.press(CTRL_C);
		expect(h.text()).toContain("Quit setup? Nothing has been saved.");
		expect(h.result.cancelled).toBeUndefined();
		await h.press(CTRL_C);
		expect(h.result.cancelled).toBe(true);
		expect(readdirSync(root)).toEqual([]);
	});

	it("esc walks back one step; on the first screen it asks to quit", async () => {
		const h = await atModel({ layout: "fullscreen", welcome: true });
		await h.press(ESC);
		expect(h.wizard.step).toBe("key");
		// The checked key is kept: enter on the empty field continues without a new check.
		await h.press(ENTER);
		expect(h.wizard.step).toBe("model");
		await h.press(ESC, ESC);
		expect(h.wizard.step).toBe("welcome");
		await h.press(ESC);
		expect(h.wizard.isQuitConfirmOpen).toBe(true);
	});

	it("enter, enter, enter finishes with the preselected defaults", async () => {
		const root = agentDir();
		const h = await atModel({ agentDir: root });
		await h.press(ENTER, ENTER, ENTER, ENTER); // model, permissions, theme, finish
		expect(h.result.done?.lines).toContain("model: glm-5-3-flash");
		expect(h.result.done?.lines).toContain("permissions: read-write");
		const settings = JSON.parse(readFileSync(join(root, "settings.json"), "utf8"));
		expect(settings).toMatchObject({ models: { code: "glm-5-3-flash" }, permissions: { mode: "read-write" } });
		expect(settings.router).toBeUndefined();
	});

	it("shows one short line per screen and every hint, so moving never changes the layout", async () => {
		const h = await atModel();
		const model = h.frame(100);
		await h.press(UP);
		const auto = h.frame(100);
		expect(auto).toHaveLength(model.length);
		await h.press(DOWN, DOWN);
		expect(h.frame(100)).toHaveLength(model.length);
		await h.press(UP, ENTER);
		const permissions = h.text();
		expect(permissions).toContain("What may run without asking?");
		expect(permissions).toContain("reads and file edits run freely");
		expect(permissions).toContain("asks before every tool call");
		const before = h.frame(100);
		await h.press(DOWN);
		const after = h.frame(100);
		expect(after).toHaveLength(before.length);
		// Hints sit in one column: the same offset on every row.
		const offsets = after
			.filter((line) => /Read & write|Ask everything|Allow all/.test(line))
			.map((line) => line.search(/reads and|asks before|every tool/));
		expect(new Set(offsets).size).toBe(1);
	});

	it("any step can be reopened from the review and returns to it", async () => {
		const h = await atModel();
		await toReview(h);
		expect(h.text()).toContain("❯ [ Finish ]");
		await h.press(UP, UP); // Theme → Permissions
		expect(h.text()).toMatch(/❯ Permissions\s+Read & write\s+change/);
		await h.press(ENTER);
		expect(h.wizard.step).toBe("permissions");
		expect(h.text()).toContain("esc back to review");
		await h.press(DOWN, ENTER); // Ask everything
		expect(h.wizard.step).toBe("summary");
		expect(h.text()).toContain("Ask everything");
		// Esc from a reopened step also returns to the review, keeping the earlier value.
		await h.press(UP, UP, UP, UP, ENTER);
		expect(h.wizard.step).toBe("model");
		await h.press(ESC);
		expect(h.wizard.step).toBe("summary");
		// The classifier step was skipped (manual model), but it can still be opened from the review.
		await h.press(UP, UP, UP);
		expect(h.text()).toMatch(/❯ Classifier\s+none/);
		await h.press(ENTER);
		expect(h.wizard.step).toBe("router");
		expect(h.text()).toContain("Optional.");
	});

	it("tab and shift+tab move like the arrows", async () => {
		const h = await atModel();
		await h.press("\t");
		expect(h.text()).toContain("❯ Thinking");
		await h.press("\x1b[Z");
		expect(h.text()).toContain("❯ Manual");
	});

	it("auto routing without a classifier asks for one next; skipping it falls back to the manual model", async () => {
		const root = agentDir();
		const h = await atModel({ agentDir: root });
		await h.press(UP);
		expect(h.text()).toContain("❯ Auto");
		expect(h.text()).toContain("needs a classifier key (next step)");
		// The classifier step joins the indicator only now.
		expect(h.text()).toContain("Model - ○ Classifier - ○ Permissions");
		await h.press(ENTER);
		expect(h.wizard.step).toBe("router");
		expect(h.text()).toContain("Auto routing needs a small classifier key.");
		await h.press(DOWN, DOWN, ENTER); // Skip
		expect(h.wizard.step).toBe("permissions");
		expect(h.text()).toContain("No classifier: using GLM 5.3 Flash");
		await h.press(ENTER, ENTER);
		expect(h.text()).toMatch(/Model\s+GLM 5\.3 Flash/);
		await h.press(ENTER);
		const settings = JSON.parse(readFileSync(join(root, "settings.json"), "utf8"));
		expect(settings.models.code).toBe("glm-5-3-flash");
		expect(settings.router).toMatchObject({ classifier: "off" });
	});

	it("with a classifier key in the env, auto routing and auto permissions are preselected and no classifier step shows", async () => {
		const env = { OPENROUTER_API_KEY: "sk-or-v1-from-env" };
		const root = agentDir();
		const h = await atModel({ agentDir: root, env });
		expect(h.text()).toMatch(/❯ Auto\s+low\s+‹ medium ›\s+high/);
		expect(h.text()).not.toContain("Classifier");
		await h.press(ENTER);
		expect(h.wizard.step).toBe("permissions");
		expect(h.text()).toContain("❯ Auto");
		await h.press(ENTER, ENTER);
		expect(h.text()).toMatch(/Classifier\s+OpenRouter ✓/);
		await h.press(ENTER);
		const settings = JSON.parse(readFileSync(join(root, "settings.json"), "utf8"));
		expect(settings.models.code).toBe("auto:medium");
		expect(settings.router).toEqual({ mode: "medium" });
		expect(settings.permissions).toEqual({ mode: "auto" });
		expect(isPermissionJudgeAvailable(root, env)).toBe(true);
		expect(isPermissionJudgeAvailable(root, {})).toBe(false);
	});

	it("auto permissions without a key open the classifier step and come back with auto chosen", async () => {
		const root = agentDir();
		const { baseUrl } = await serve((index) =>
			index === 0
				? { status: 200, body: MODELS_BODY }
				: { status: 200, body: JSON.stringify({ data: { usage: 0.17, limit: 1 } }) },
		);
		const h = harness({ agentDir: root, baseUrl, routerBaseUrls: { openrouter: baseUrl } });
		await h.type(SECRET);
		await h.press(ENTER, ENTER, ENTER); // key check, key result, manual model
		expect(h.wizard.step).toBe("permissions");
		await h.press(UP, UP);
		expect(h.text()).toContain("❯ Auto");
		expect(h.text()).toContain("needs a classifier key - enter adds one");
		await h.press(ENTER);
		expect(h.wizard.step).toBe("router");
		expect(h.text()).toContain("Auto permissions need a small classifier key.");
		// Esc goes back to permissions, not to the model step.
		await h.press(ESC);
		expect(h.wizard.step).toBe("permissions");
		await h.press(UP, UP, ENTER);
		await h.press(DOWN, ENTER, ENTER); // OpenRouter, default model id
		await h.type("sk-or-v1-test");
		await h.press(ENTER);
		// The checked key stays on screen until enter.
		expect(h.wizard.step).toBe("router");
		expect(h.text()).toContain("✓ OpenRouter key works");
		await h.press(ENTER);
		expect(h.wizard.step).toBe("permissions");
		expect(h.text()).toContain("❯ Auto");
		await h.press(ENTER, ENTER);
		expect(h.text()).toMatch(/Permissions\s+Auto/);
		await h.press(ENTER);
		const settings = JSON.parse(readFileSync(join(root, "settings.json"), "utf8"));
		expect(settings.permissions).toEqual({ mode: "auto" });
		expect(settings.models.code).toBe("glm-5-3-flash");
		expect(settings.router).toMatchObject({ classifier: "openrouter" });
	});

	it("auto routing with a new classifier key saves the mode, and auto permissions are suggested", async () => {
		const root = agentDir();
		const { baseUrl } = await serve((index) =>
			index === 0
				? { status: 200, body: MODELS_BODY }
				: { status: 200, body: JSON.stringify({ data: { usage: 0.17, limit: 1 } }) },
		);
		const h = harness({
			agentDir: root,
			baseUrl,
			routerBaseUrls: { openrouter: baseUrl },
		});
		await h.type(SECRET);
		await h.press(ENTER, ENTER);
		await h.press(UP);
		expect(h.text()).toContain("‹ medium ›");
		await h.press(RIGHT);
		expect(h.text()).toContain("‹ high ›");
		expect(h.text()).toContain("needs a classifier key");
		await h.press(ENTER);
		await h.press(DOWN, ENTER, ENTER); // OpenRouter, default model id
		await h.type("sk-or-v1-test");
		await h.press(ENTER, ENTER);
		expect(h.wizard.step).toBe("permissions");
		expect(h.text()).toContain("❯ Auto");
		await h.press(ENTER, ENTER);
		expect(h.text()).toContain("Auto - high");
		await h.press(ENTER);
		const settings = JSON.parse(readFileSync(join(root, "settings.json"), "utf8"));
		expect(settings.models.code).toBe("auto:high");
		expect(settings.router).toMatchObject({ mode: "high", classifier: "openrouter" });
		expect(settings.permissions).toEqual({ mode: "auto" });
		expect(settings.defaultThinkingLevel).toBeUndefined();
		expect(h.result.done?.lines).toContain("model: auto (high)");
	});

	it("previews themes while moving and restores the original on quit", async () => {
		const previews: Array<string | undefined> = [];
		const h = await atModel({ previewTheme: (name) => previews.push(name) });
		await h.press(ENTER, ENTER);
		expect(h.wizard.step).toBe("theme");
		await h.press(DOWN, DOWN);
		expect(previews).toEqual(["dark", "light"]);
		expect(h.text()).toContain("Preview");
		await h.press(CTRL_C, "y");
		expect(previews).toEqual(["dark", "light", undefined]);
	});

	it("hides the theme step when there is a single theme", async () => {
		const h = await atModel({ themes: ["dark"] });
		await h.press(ENTER, ENTER);
		expect(h.wizard.step).toBe("summary");
		expect(h.text()).not.toContain("Theme");
	});
});

describe("setup wizard: fullscreen layout", () => {
	beforeAll(() => initTheme("dark"));

	it("fills the terminal exactly, centers the column, pins the hints to the last row", () => {
		const root = agentDir();
		const h = harness({ agentDir: root, layout: "fullscreen", welcome: true, baseUrl: "https://x.example/v1" });
		h.rows.value = 30;
		const welcome = h.frame(100);
		expect(welcome).toHaveLength(30);
		expect(welcome.join("\n")).toContain("██████╗ ██╗  ██╗");
		expect(welcome.join("\n")).toContain("Press enter");
		expect(welcome[29]).toContain("enter start");
		for (const line of welcome) expect(line.length).toBeLessThanOrEqual(100);
		h.wizard.handleInput(ENTER);
		const key = h.frame(100);
		expect(key).toHaveLength(30);
		const indicator = key.find((line) => line.includes("Key - ○ Model - ○ Permissions"));
		expect(indicator).toBeDefined();
		// The 78-column content column is centered in 100 columns.
		expect(indicator?.indexOf("●")).toBe(11);
		expect(key[28]?.trim()).toMatch(/^─+$/);
	});

	it("re-lays out on resize: compact indicator when narrow, a notice when too small", () => {
		const root = agentDir();
		const h = harness({ agentDir: root, layout: "fullscreen", welcome: false, baseUrl: "https://x.example/v1" });
		h.rows.value = 24;
		const narrow = h.frame(50);
		expect(narrow).toHaveLength(24);
		expect(narrow.join("\n")).toContain("● ○ ○ ○ ○  1/5");
		expect(narrow.join("\n")).toContain("RunInfra key");
		for (const line of narrow) expect(line.length).toBeLessThanOrEqual(50);
		h.rows.value = 10;
		const tiny = h.frame(40);
		expect(tiny).toHaveLength(10);
		expect(tiny.join("\n")).toContain("Make the terminal at least 44x14");
		// Only quitting works on the notice; q is not typed into the hidden field.
		h.wizard.handleInput("q");
		expect(h.wizard.isQuitConfirmOpen).toBe(true);
		expect(h.frame(40).join("\n")).toContain("Quit setup?");
	});

	it("drops the banner on short terminals instead of clipping it", () => {
		const root = agentDir();
		const h = harness({ agentDir: root, layout: "fullscreen", welcome: true, baseUrl: "https://x.example/v1" });
		h.rows.value = 18;
		const frame = h.frame(80);
		expect(frame).toHaveLength(18);
		expect(frame.join("\n")).not.toContain("██");
		expect(frame.join("\n")).toContain("Welcome to RunKiln");
		expect(frame.join("\n")).toContain("Press enter");
	});

	it("ends on a done screen with the key shortcuts; settings are saved before it shows", async () => {
		const root = agentDir();
		const { baseUrl } = await serve({ status: 200, body: MODELS_BODY });
		const h = harness({ agentDir: root, layout: "fullscreen", welcome: false, baseUrl });
		h.rows.value = 30;
		await h.type(SECRET);
		await h.press(ENTER, ENTER);
		await toReview(h);
		await h.press(ENTER);
		expect(h.wizard.step).toBe("done");
		const frame = h.frame(100).join("\n");
		expect(frame).toContain("✓ You're set");
		expect(frame).toContain("Alt+R");
		expect(frame).toContain("Alt+M");
		expect(frame).toContain("/help");
		expect(frame).not.toContain("Key - ");
		expect(readFileSync(join(root, "settings.json"), "utf8")).toContain("glm-5-3-flash");
		expect(h.result.done).toBeUndefined();
		await h.press(ENTER);
		expect(h.result.done?.lines[0]).toBe(SETUP_DONE);
		expect(h.result.cancelled).toBeUndefined();
	});
});

/** A left click at the first cell of `text` on screen. */
function clickOn(h: Harness, text: string, width = 100, offset = 0): void {
	const lines = h.frame(width);
	const y = lines.findIndex((line) => line.includes(text));
	expect(y, `"${text}" on screen`).toBeGreaterThanOrEqual(0);
	const x = (lines[y] ?? "").indexOf(text) + offset;
	const event = { button: "left" as const, x, y, screenX: x, screenY: y, width, height: lines.length };
	const base = { shift: false, alt: false, ctrl: false };
	h.wizard.handleMouse({ ...event, ...base, type: "press" });
	h.wizard.handleMouse({ ...event, ...base, type: "click" });
}

describe("setup wizard: spacing, scrolling and the mouse", () => {
	beforeAll(() => initTheme("dark"));

	it("never drops blank lines on a short window: the body scrolls around the cursor", async () => {
		const root = agentDir();
		const { baseUrl } = await serve({ status: 200, body: MODELS_BODY });
		const h = harness({ agentDir: root, layout: "fullscreen", welcome: false, baseUrl });
		h.rows.value = 14;
		await h.type(SECRET);
		await h.press(ENTER, ENTER);
		const frame = h.frame(80);
		expect(frame).toHaveLength(14);
		const indicator = frame.findIndex((line) => line.includes("● Model"));
		// Indicator, blank, title, subtitle, blank: the header keeps its spacing.
		expect(frame[indicator + 1]).toBe("");
		expect(frame[indicator + 2]?.trim()).toBe("Model");
		expect(frame[indicator + 4]).toBe("");
		expect(frame.join("\n")).toContain("❯ Manual");
		expect(frame.join("\n")).toMatch(/[↑↓] \d+ more/);
		expect(frame[13]).toContain("enter next");
	});

	it("the key step stays on screen after the check, then moves on by itself unless a key is pressed", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		try {
			const root = agentDir();
			const fetchImpl = (async () =>
				new Response(MODELS_BODY, {
					status: 200,
					headers: { "content-type": "application/json" },
				})) as typeof fetch;
			const h = harness({
				agentDir: root,
				baseUrl: "https://api.runinfra.example/v1",
				fetchImpl,
				keyAdvanceMs: 1200,
			});
			await h.type(SECRET);
			await h.press(ENTER);
			expect(h.wizard.step).toBe("key");
			expect(h.text()).toContain("✓ Key works - 3 models");
			vi.advanceTimersByTime(1199);
			expect(h.wizard.step).toBe("key");
			vi.advanceTimersByTime(1);
			expect(h.wizard.step).toBe("model");

			// A key pressed while the result shows cancels the move.
			const other = harness({
				agentDir: agentDir(),
				baseUrl: "https://api.runinfra.example/v1",
				fetchImpl,
				keyAdvanceMs: 1200,
			});
			await other.type(SECRET);
			await other.press(ENTER);
			other.wizard.handleInput("\x1b[C");
			vi.advanceTimersByTime(5000);
			expect(other.wizard.step).toBe("key");
		} finally {
			vi.useRealTimers();
		}
	});

	it("options, chips, review rows and key hints are clickable", async () => {
		const root = agentDir();
		const { baseUrl } = await serve({ status: 200, body: MODELS_BODY });
		const h = harness({ agentDir: root, baseUrl, env: { OPENROUTER_API_KEY: "sk-or-v1-from-env" } });
		await h.type(SECRET);
		await h.press(ENTER);
		clickOn(h, "enter next");
		expect(h.wizard.step).toBe("model");
		clickOn(h, "high");
		expect(h.text()).toContain("‹ high ›");
		clickOn(h, "enter next");
		expect(h.wizard.step).toBe("permissions");
		clickOn(h, "Ask everything");
		expect(h.wizard.step).toBe("theme");
		clickOn(h, "esc back");
		expect(h.wizard.step).toBe("permissions");
		await h.press(ENTER, ENTER);
		expect(h.wizard.step).toBe("summary");
		// The indicator is not a button; the review row is.
		clickOn(h, "Ask everything");
		expect(h.wizard.step).toBe("permissions");
		await h.press(ENTER);
		clickOn(h, "[ Finish ]");
		const settings = JSON.parse(readFileSync(join(root, "settings.json"), "utf8"));
		expect(settings.models.code).toBe("auto:high");
		expect(settings.permissions).toEqual({ mode: "ask" });
	});
});
