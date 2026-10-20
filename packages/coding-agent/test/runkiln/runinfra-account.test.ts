import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { type AccountCommandIo, parseAccountCommand, runAccountCommand } from "../../src/cli/account-commands.ts";
import { ModelRuntime } from "../../src/core/model-runtime.ts";
import { loadModelsCatalog } from "../../src/core/runkiln/models-catalog.ts";
import {
	buildModelRows,
	describeRunInfraFailure,
	fetchRunInfraAccount,
	filterDisabledModels,
	getActiveRunInfraKey,
	getCatalogCachePath,
	getRunInfraKeyStatus,
	loadRunInfraCatalog,
	normalizeDisabledModels,
	removeRunInfraApiKey,
	runInfraErrorHint,
} from "../../src/core/runkiln/runinfra-account.ts";
import { checkRunInfraKey, saveRunInfraApiKey } from "../../src/core/runkiln/setup.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import {
	ModelsManagerScreen,
	type ModelsSettingsStore,
} from "../../src/modes/interactive/components/models-manager-screen.ts";
import {
	SetupHub,
	type SetupHubOptions,
	type SetupHubResult,
} from "../../src/modes/interactive/components/setup/setup-hub.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";

const SECRET = "rp_test_secret_do_not_print";
const ENV_SECRET = "rp_env_secret_do_not_print";
const BASE_URL = "https://api.runinfra.example/v1";
const catalog = loadModelsCatalog();

const stripAnsi = (text: string) => text.replace(/\x1b\[[0-9;]*m|\x1b\]8;[^\x07\x1b]*(?:\x07|\x1b\\)/g, "");

const dirs: string[] = [];
function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "runkiln-account-"));
	dirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

beforeAll(() => initTheme("dark"));

interface FakeRoute {
	status: number;
	body?: unknown;
	headers?: Record<string, string>;
}

/** A fetch stub keyed by path suffix. Records every call. */
function fakeFetch(routes: Record<string, FakeRoute | "network-error">) {
	const calls: Array<{ url: string; headers: Record<string, string> }> = [];
	const impl = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
		calls.push({ url, headers: { ...((init?.headers as Record<string, string>) ?? {}) } });
		const path = Object.keys(routes).find((suffix) => url.endsWith(suffix));
		const route = path ? routes[path] : { status: 404, body: { error: { code: "unknown_endpoint" } } };
		if (route === "network-error") throw new TypeError("fetch failed");
		return new Response(route.body === undefined ? "" : JSON.stringify(route.body), {
			status: route.status,
			headers: { "content-type": "application/json", ...(route.headers ?? {}) },
		});
	}) as typeof fetch;
	return { impl, calls };
}

const MODELS_BODY = {
	object: "list",
	data: [
		{
			id: "glm-5-3-flash",
			display_name: "GLM 5.3 Flash",
			availability: "available",
			pricing: { input: 0.11, output: 0.45 },
			context_window: 1048576,
			input_modalities: ["text", "image"],
			reasoning_efforts: ["low", "high", "max"],
		},
		{ id: "deepseek-v4-1-flash-1017", availability: "available", pricing: { input: 0.14, output: 0.58 } },
		{ id: "qwen3-8-27b", availability: "paused", paused_until: "2026-10-16T10:00:00.000Z" },
		{ id: "ornith-1-5-35b", availability: "available" },
	],
};

const CREDITS_BODY = {
	object: "credits",
	balance_cents: 5476,
	held_cents: 34,
	available_cents: 5476,
	currency: "usd",
	period: { start: "2026-10-01T00:00:00.000Z", spent_cents: 1500 },
	plan_tier: "core",
};

describe("key storage", () => {
	it("saves the key with 0600 in a 0700 directory and removes only the key", () => {
		const root = join(tempDir(), "agent");
		saveRunInfraApiKey(root, SECRET);
		const path = join(root, "runinfra.json");
		if (process.platform !== "win32") {
			expect(statSync(path).mode & 0o777).toBe(0o600);
			expect(statSync(root).mode & 0o777).toBe(0o700);
		}
		writeFileSync(path, JSON.stringify({ baseUrl: BASE_URL, apiKey: SECRET }));
		expect(removeRunInfraApiKey(root)).toBe(true);
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ baseUrl: BASE_URL });
		expect(removeRunInfraApiKey(root)).toBe(false);
	});

	it("deletes runinfra.json when the key was the only field", () => {
		const root = tempDir();
		saveRunInfraApiKey(root, SECRET);
		expect(removeRunInfraApiKey(root)).toBe(true);
		expect(existsSync(join(root, "runinfra.json"))).toBe(false);
	});
});

describe("env override", () => {
	it("RUNINFRA_API_KEY wins over the saved key, and the status says so", () => {
		const root = tempDir();
		expect(getRunInfraKeyStatus(root, {}).source).toBe("none");
		saveRunInfraApiKey(root, SECRET);
		const saved = getRunInfraKeyStatus(root, {});
		expect(saved).toMatchObject({ source: "config", hasSavedKey: true });
		expect(getActiveRunInfraKey(root, {})).toBe(SECRET);

		const env = { RUNINFRA_API_KEY: ENV_SECRET };
		const overridden = getRunInfraKeyStatus(root, env);
		expect(overridden.source).toBe("environment");
		expect(overridden.label).toContain("overrides the saved key");
		expect(overridden.label).not.toContain(ENV_SECRET);
		expect(getActiveRunInfraKey(root, env)).toBe(ENV_SECRET);
	});

	it("ModelRuntime reports the environment as the auth source", async () => {
		const root = tempDir();
		saveRunInfraApiKey(root, SECRET);
		const runtime = await ModelRuntime.create({ agentDir: root });
		const previous = process.env.RUNINFRA_API_KEY;
		process.env.RUNINFRA_API_KEY = ENV_SECRET;
		try {
			expect(runtime.getProviderAuthStatus("runinfra")).toMatchObject({ configured: true, source: "environment" });
		} finally {
			if (previous === undefined) delete process.env.RUNINFRA_API_KEY;
			else process.env.RUNINFRA_API_KEY = previous;
		}
	});
});

describe("key validation (mocked HTTP)", () => {
	it("accepts a working key and sends it only as a bearer token", async () => {
		const { impl, calls } = fakeFetch({ "/models": { status: 200, body: MODELS_BODY } });
		const result = await checkRunInfraKey({ baseUrl: BASE_URL, apiKey: SECRET, catalog, fetchImpl: impl });
		expect(result.ok).toBe(true);
		expect(result.remote.map((model) => model.id)).toContain("qwen3-8-27b");
		expect(result.models.map((model) => model.id)).not.toContain("qwen3-8-27b");
		expect(calls[0]?.url).toBe(`${BASE_URL}/models`);
		expect(calls[0]?.headers).toEqual({ Authorization: `Bearer ${SECRET}` });
	});

	it.each([
		[{ status: 401, body: { error: { code: "invalid_api_key", message: SECRET } } }, "invalid key"],
		[{ status: 403, body: { error: { code: "auth_error" } } }, "deactivated"],
		[{ status: 402, body: { error: { code: "insufficient_credits" } } }, "Out of credits"],
		[
			{ status: 429, body: { error: { code: "rate_limit_exceeded" } }, headers: { "retry-after": "12" } },
			"Retry in 12s",
		],
		[{ status: 503, body: {} }, "RunInfra error 503"],
	])("explains HTTP %j clearly without leaking the body", async (route, expected) => {
		const { impl } = fakeFetch({ "/models": route });
		const result = await checkRunInfraKey({ baseUrl: BASE_URL, apiKey: SECRET, catalog, fetchImpl: impl });
		expect(result.ok).toBe(false);
		expect(result.message).toContain(expected);
		expect(result.message).not.toContain(SECRET);
	});

	it("explains a network failure", async () => {
		const { impl } = fakeFetch({ "/models": "network-error" });
		const result = await checkRunInfraKey({ baseUrl: BASE_URL, apiKey: SECRET, catalog, fetchImpl: impl });
		expect(result.message).toBe("Couldn't reach RunInfra. Check your connection.");
	});

	it("reads the account status from GET /credits", async () => {
		const { impl } = fakeFetch({ "/credits": { status: 200, body: CREDITS_BODY } });
		const result = await fetchRunInfraAccount({ baseUrl: BASE_URL, apiKey: SECRET, fetchImpl: impl });
		expect(result).toEqual({
			ok: true,
			status: { availableCents: 5476, balanceCents: 5476, periodSpentCents: 1500, planTier: "core" },
		});
	});

	it("turns chat errors into fixes", () => {
		expect(runInfraErrorHint("401 Invalid API key")).toContain("/setup keys");
		expect(runInfraErrorHint("429 rate_limit_exceeded")).toContain("Rate limited");
		expect(runInfraErrorHint("402 Out of credits")).toContain("Top up");
		expect(runInfraErrorHint("Context window exceeded")).toBeUndefined();
		expect(describeRunInfraFailure({ status: 401 })).not.toContain("401");
	});
});

describe("catalog cache", () => {
	it("caches a live catalog (0600) and falls back to it offline, then to the bundled catalog", async () => {
		const root = tempDir();
		const live = fakeFetch({ "/models": { status: 200, body: MODELS_BODY } });
		const first = await loadRunInfraCatalog({
			agentDir: root,
			baseUrl: BASE_URL,
			apiKey: SECRET,
			fetchImpl: live.impl,
		});
		expect(first.source).toBe("live");
		const cachePath = getCatalogCachePath(root);
		if (process.platform !== "win32") expect(statSync(cachePath).mode & 0o777).toBe(0o600);
		expect(readFileSync(cachePath, "utf8")).not.toContain(SECRET);

		const down = fakeFetch({ "/models": "network-error" });
		const second = await loadRunInfraCatalog({
			agentDir: root,
			baseUrl: BASE_URL,
			apiKey: SECRET,
			fetchImpl: down.impl,
		});
		expect(second.source).toBe("cache");
		expect(second.models.map((model) => model.id)).toContain("glm-5-3-flash");
		expect(second.error).toContain("Couldn't reach RunInfra");

		const offline = await loadRunInfraCatalog({ agentDir: tempDir(), baseUrl: BASE_URL, apiKey: undefined });
		expect(offline.source).toBe("bundled");
	});
});

describe("disabledModels", () => {
	it("round-trips through settings as a clean string array", () => {
		const root = tempDir();
		const settings = SettingsManager.create(tempDir(), root);
		expect(settings.getDisabledModels()).toEqual([]);
		settings.setDisabledModels(["qwen3-8-27b", " qwen3-8-27b ", "ornith-1-5-35b"]);
		expect(settings.getDisabledModels()).toEqual(["qwen3-8-27b", "ornith-1-5-35b"]);
		expect(normalizeDisabledModels(["a", 3, null, "", "a"])).toEqual(["a"]);
	});

	it("hides disabled models from the available list but keeps lookups working", async () => {
		const runtime = await ModelRuntime.create({ catalog, runInfraConfig: { baseUrl: BASE_URL, apiKey: SECRET } });
		runtime.setDisabledModels(["qwen3-8-27b", "nemotron-3-5-lightning-30b"]);
		const ids = runtime.getAvailableSnapshot().map((model) => model.id);
		expect(ids).not.toContain("qwen3-8-27b");
		expect(ids).not.toContain("nemotron-3-5-lightning-30b");
		expect(ids).toContain("glm-5-3-flash");
		expect(runtime.getModelById("qwen3-8-27b")?.id).toBe("qwen3-8-27b");
	});

	it("never filters every model away", () => {
		const models = [{ id: "a" }, { id: "b" }];
		expect(filterDisabledModels(models, ["a"])).toEqual([{ id: "b" }]);
		expect(filterDisabledModels(models, ["a", "b"])).toEqual(models);
	});

	it("builds rows with price, context, vision and thinking levels", () => {
		const rows = buildModelRows(catalog, undefined, ["qwen3-8-27b"]);
		const glm = rows.find((row) => row.id === "glm-5-3-flash");
		expect(glm).toMatchObject({ vision: true, efforts: ["low", "high", "max"], status: "unknown", enabled: true });
		expect(glm?.priceIn).toBe(0.11);
		expect(rows.find((row) => row.id === "qwen3-8-27b")?.enabled).toBe(false);
	});
});

function memoryStore(initial: Partial<{ disabled: string[]; model: string }> = {}): ModelsSettingsStore & {
	state: { disabled: string[]; model: string; thinking?: string };
} {
	const state = {
		disabled: initial.disabled ?? [],
		model: initial.model ?? "glm-5-3-flash",
		thinking: undefined as string | undefined,
	};
	return {
		state,
		getDisabledModels: () => [...state.disabled],
		setDisabledModels: (ids) => {
			state.disabled = [...ids];
		},
		getDefaultModel: () => state.model,
		setDefaultModel: (id) => {
			state.model = id;
		},
		getDefaultThinkingLevel: () => state.thinking as never,
		setDefaultThinkingLevel: (level) => {
			state.thinking = level;
		},
	};
}

describe("/models screen", () => {
	const preloaded = { source: "live" as const, models: [], fetchedAt: Date.now() };

	it("toggles models, protects the default, sets the default and thinking level", async () => {
		const store = memoryStore();
		let changes = 0;
		const screen = new ModelsManagerScreen({
			catalog,
			store,
			agentDir: tempDir(),
			baseUrl: BASE_URL,
			apiKey: undefined,
			preloaded,
			onChange: () => changes++,
			onClose: () => undefined,
		});
		// Cursor starts on the default model; disabling it is refused.
		screen.handleInput(" ");
		await screen.whenIdle();
		expect(store.state.disabled).toEqual([]);
		expect(stripAnsi(screen.render(140).join("\n"))).toContain("is the default model");

		screen.handleInput("\x1b[B"); // down: deepseek
		screen.handleInput(" ");
		await screen.whenIdle();
		expect(store.state.disabled).toEqual(["deepseek-v4-1-flash-1017"]);

		screen.handleInput("\r"); // make deepseek default: re-enables it
		await screen.whenIdle();
		expect(store.state.model).toBe("deepseek-v4-1-flash-1017");
		expect(store.state.disabled).toEqual([]);

		screen.handleInput("t");
		await screen.whenIdle();
		expect(store.state.thinking).toBe("off");
		expect(changes).toBeGreaterThanOrEqual(3);

		const text = stripAnsi(screen.render(140).join("\n"));
		expect(text).toContain("GLM 5.3 Flash");
		expect(text).toContain("$0.11/$0.45");
		expect(text).toContain("1M");
		expect(text).toContain("vision");
		expect(text).toContain("low high max");
		expect(text).toContain("Default thinking off");
	});

	it("shows paused models and the offline source", async () => {
		const root = tempDir();
		const { impl } = fakeFetch({ "/models": "network-error" });
		const screen = new ModelsManagerScreen({
			catalog,
			store: memoryStore(),
			agentDir: root,
			baseUrl: BASE_URL,
			apiKey: SECRET,
			fetchImpl: impl,
			onClose: () => undefined,
		});
		await screen.whenIdle();
		expect(stripAnsi(screen.render(140).join("\n"))).toContain("offline - bundled catalog");
	});
});

describe("/setup keys: RunInfra key", () => {
	function hub(root: string, env: NodeJS.ProcessEnv, impl: typeof fetch, options: Partial<SetupHubOptions> = {}) {
		const result: { closed?: SetupHubResult } = {};
		const screen = new SetupHub({
			agentDir: root,
			catalog,
			env,
			layout: "inline",
			themes: ["dark"],
			previewTheme: () => undefined,
			baseUrl: BASE_URL,
			fetchImpl: impl,
			spinnerIntervalMs: 0,
			onClose: (value) => {
				result.closed = value;
			},
			...options,
		});
		const text = () => stripAnsi(screen.render(120).join("\n"));
		const press = async (...keys: string[]) => {
			for (const key of keys) screen.handleInput(key);
			await screen.whenIdle();
		};
		return { screen, text, press, result };
	}

	it("tests, replaces, and removes the key without rendering it", async () => {
		const root = tempDir();
		saveRunInfraApiKey(root, SECRET);
		const { impl, calls } = fakeFetch({ "/models": { status: 200, body: MODELS_BODY } });
		const h = hub(root, {}, impl);
		expect(h.text()).toMatch(/❯ RunInfra\s+models\s+saved/);
		expect(h.text()).toContain("Saved in ~/.runkiln/agent/runinfra.json");
		await h.press("t");
		expect(h.text()).toMatch(/✓ Key works - \d+ models/);

		// Enter opens the field; a key that checks out is saved right away.
		await h.press("\r");
		for (const char of "rp_new_secret_do_not_print") h.screen.handleInput(char);
		await h.press("\r");
		expect(h.text()).toMatch(/✓ Key works - \d+ models - saved/);
		expect(JSON.parse(readFileSync(join(root, "runinfra.json"), "utf8")).apiKey).toBe("rp_new_secret_do_not_print");

		// Del asks first.
		await h.press("\x1b[3~");
		expect(h.text()).toContain("Remove the saved RunInfra key?");
		await h.press("y");
		expect(h.text()).toContain("✓ RunInfra key removed");
		expect(h.text()).toMatch(/RunInfra\s+models\s+not set/);
		expect(existsSync(join(root, "runinfra.json"))).toBe(false);

		await h.press("\x1b");
		expect(h.result.closed).toEqual({
			section: "keys",
			open: undefined,
			keyChanged: true,
			routerChanged: false,
			settingsChanged: false,
		});
		for (const secret of [SECRET, "rp_new_secret_do_not_print"]) expect(h.text()).not.toContain(secret);
		expect(calls.every((call) => Object.keys(call.headers).join() === "Authorization")).toBe(true);
	});

	it("shows that RUNINFRA_API_KEY wins, and refuses a bad replacement", async () => {
		const root = tempDir();
		const { impl } = fakeFetch({ "/models": { status: 401, body: { error: { code: "invalid_api_key" } } } });
		const h = hub(root, { RUNINFRA_API_KEY: ENV_SECRET }, impl, { keyAction: { key: "runinfra", action: "set" } });
		expect(h.text()).toMatch(/RunInfra\s+models\s+RUNINFRA_API_KEY/);
		for (const char of SECRET) h.screen.handleInput(char);
		await h.press("\r");
		const text = h.text();
		expect(text).toContain("invalid key");
		expect(text).not.toContain(SECRET);
		expect(text).not.toContain(ENV_SECRET);
		expect(existsSync(join(root, "runinfra.json"))).toBe(false);
	});
});

describe("runkiln setup / login / logout", () => {
	function io(overrides: Partial<AccountCommandIo> = {}): AccountCommandIo & { out: string[] } {
		const out: string[] = [];
		return {
			out,
			stdinIsTTY: false,
			stdoutIsTTY: false,
			readStdin: async () => "",
			log: (line) => out.push(line),
			error: (line) => out.push(line),
			env: {},
			runSetup: async () => undefined,
			runHub: async () => ({ keyChanged: false, routerChanged: false }),
			...overrides,
		};
	}

	it("parses only bare subcommands", () => {
		expect(parseAccountCommand(["login", "--stdin"])).toEqual({ command: "login", flags: ["--stdin"] });
		expect(parseAccountCommand(["setup"])).toEqual({ command: "setup", flags: [] });
		expect(parseAccountCommand(["setup", "the", "repo"])).toBeUndefined();
		expect(parseAccountCommand(["fix", "login"])).toBeUndefined();
	});

	it("login --stdin checks and saves; logout removes", async () => {
		const root = tempDir();
		writeFileSync(join(root, "runinfra.json"), JSON.stringify({ baseUrl: BASE_URL }));
		const { impl } = fakeFetch({ "/models": { status: 200, body: MODELS_BODY } });
		const login = io({ readStdin: async () => `${SECRET}\n`, fetchImpl: impl });
		expect(await runAccountCommand("login", ["--stdin"], root, login)).toBe(0);
		expect(JSON.parse(readFileSync(join(root, "runinfra.json"), "utf8"))).toEqual({
			baseUrl: BASE_URL,
			apiKey: SECRET,
		});
		expect(login.out.join("\n")).not.toContain(SECRET);

		const logout = io({ env: { RUNINFRA_API_KEY: ENV_SECRET } });
		expect(await runAccountCommand("logout", [], root, logout)).toBe(0);
		expect(JSON.parse(readFileSync(join(root, "runinfra.json"), "utf8"))).toEqual({ baseUrl: BASE_URL });
		expect(logout.out.join("\n")).toContain("RUNINFRA_API_KEY is set");
	});

	it("rejects a bad key on stdin and needs a terminal for the screens", async () => {
		const root = tempDir();
		const { impl } = fakeFetch({ "/models": { status: 401, body: {} } });
		const bad = io({ readStdin: async () => SECRET, fetchImpl: impl });
		expect(await runAccountCommand("login", ["--stdin"], root, bad)).toBe(1);
		expect(existsSync(join(root, "runinfra.json"))).toBe(false);
		const noTty = io();
		expect(await runAccountCommand("setup", [], root, noTty)).toBe(1);
		expect(noTty.out.join("\n")).toContain("needs a terminal");
	});
});
