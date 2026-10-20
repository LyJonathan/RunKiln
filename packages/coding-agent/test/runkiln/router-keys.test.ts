import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { type AccountCommandIo, parseAccountCommand, runAccountCommand } from "../../src/cli/account-commands.ts";
import { createClassifier, resolveClassifierKey } from "../../src/core/router/classifiers.ts";
import {
	checkRouterKey,
	getActiveRouterClassifier,
	getRouterKeyStatus,
	loadRouterClassifierSettings,
	migrateOpenRouterClassifierModel,
	ROUTER_WINDOWS_ACL_WARNING,
	readRouterKeys,
	removeRouterKey,
	saveRouterClassifier,
	saveRouterKey,
	validateOpenRouterDecisionModel,
	validateOpenRouterModelId,
} from "../../src/core/router/keys.ts";
import { SetupHub, type SetupHubResult } from "../../src/modes/interactive/components/setup/setup-hub.ts";
import { SetupWizard } from "../../src/modes/interactive/components/setup/setup-wizard.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";
import { testCatalog } from "./router-fixtures.ts";

const JEV_SECRET = "ts_jev_secret_do_not_print";
const OR_SECRET = "sk-or-v1-openrouter_secret_do_not_print";
const ENV_SECRET = "env_router_secret_do_not_print";
const RUNINFRA_SECRET = "rp_runinfra_secret_do_not_print";
const BODY_SENTINEL = "ROUTER_BODY_SENTINEL";

const stripAnsi = (text: string) => text.replace(/\x1b\[[0-9;]*m|\x1b\]8;[^\x07\x1b]*(?:\x07|\x1b\\)/g, "");

const dirs: string[] = [];
function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "runkiln-router-keys-"));
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

/** A fetch stub keyed by URL suffix. Records every call with its headers and options. */
function fakeFetch(routes: Record<string, FakeRoute | "network-error" | "timeout">) {
	const calls: Array<{ url: string; headers: Record<string, string>; redirect?: string; method?: string }> = [];
	const impl = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
		calls.push({
			url,
			headers: { ...((init?.headers as Record<string, string>) ?? {}) },
			redirect: init?.redirect,
			method: init?.method,
		});
		// Longest matching suffix wins ("/v1/models" before "/models").
		const suffix = Object.keys(routes)
			.filter((candidate) => url.endsWith(candidate))
			.sort((a, b) => b.length - a.length)[0];
		const route = suffix ? routes[suffix] : { status: 404, body: { error: "not found" } };
		if (route === "network-error") throw new TypeError("fetch failed");
		if (route === "timeout") {
			// Wait for the caller's abort signal.
			await new Promise((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
			});
		}
		const ok = route as FakeRoute;
		return new Response(
			ok.body === undefined ? "" : typeof ok.body === "string" ? ok.body : JSON.stringify(ok.body),
			{
				status: ok.status,
				headers: { "content-type": "application/json", ...(ok.headers ?? {}) },
			},
		);
	}) as typeof fetch;
	return { impl, calls };
}

const JEV_MODELS = { models: [{ name: "jev-latest" }, { name: "jev-preview" }], sentinel: BODY_SENTINEL };
const OR_KEY_BODY = {
	data: {
		label: `sk-or-v1-abc...xyz ${BODY_SENTINEL}`,
		usage: 0.17,
		limit: 1,
		limit_remaining: 0.83,
		is_free_tier: false,
	},
};
const RUNINFRA_MODELS = {
	object: "list",
	data: [{ id: "glm-5-3-flash" }, { id: "deepseek-v4-1-flash" }, { id: "ornith-1-5-35b" }],
};

function assertClean(text: string, secrets: string[]): void {
	for (const secret of secrets) expect(text).not.toContain(secret);
	expect(text).not.toContain(BODY_SENTINEL);
	expect(text).not.toContain("Bearer");
}

// ---------------------------------------------------------------------------------------------

describe("router key storage", () => {
	it("saves 0600 in the agent dir, keeps the other backend's key, and removes per backend", () => {
		const root = tempDir();
		expect(saveRouterKey(root, "jev", JEV_SECRET)).toBeUndefined();
		saveRouterKey(root, "openrouter", OR_SECRET);
		const path = join(root, "router-keys.json");
		expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(statSync(root).mode & 0o777).toBe(0o700);
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
			jev: { apiKey: JEV_SECRET },
			openrouter: { apiKey: OR_SECRET },
		});
		expect(readRouterKeys(root)).toEqual({ jev: JEV_SECRET, openrouter: OR_SECRET });

		// Replacing keeps the file private even if its mode was widened.
		writeFileSync(path, readFileSync(path, "utf8"), { mode: 0o644 });
		saveRouterKey(root, "jev", "ts_new_secret");
		expect(statSync(path).mode & 0o777).toBe(0o600);

		expect(removeRouterKey(root, "jev")).toBe(true);
		expect(removeRouterKey(root, "jev")).toBe(false);
		expect(readRouterKeys(root)).toEqual({ jev: undefined, openrouter: OR_SECRET });
		expect(removeRouterKey(root, "openrouter")).toBe(true);
		expect(existsSync(path)).toBe(false);
	});

	it("refuses malformed keys and an unreadable file, and reads an unreadable file as no keys", () => {
		const root = tempDir();
		expect(() => saveRouterKey(root, "jev", "two words")).toThrow(/one line/);
		expect(() => saveRouterKey(root, "jev", "")).toThrow();
		writeFileSync(join(root, "router-keys.json"), "{not json");
		expect(readRouterKeys(root)).toEqual({});
		expect(() => saveRouterKey(root, "jev", JEV_SECRET)).toThrow(/could not read router-keys.json/);
		expect(readFileSync(join(root, "router-keys.json"), "utf8")).toBe("{not json");
	});

	it("warns (without the path or key) when Windows cannot lock the file", () => {
		const root = tempDir();
		const warning = saveRouterKey(root, "jev", JEV_SECRET, {
			platform: "win32",
			execFile: () => {
				throw new Error("icacls missing");
			},
		});
		expect(warning).toBe(ROUTER_WINDOWS_ACL_WARNING);
		expect(warning).not.toContain(root);
		expect(readRouterKeys(root).jev).toBe(JEV_SECRET);
	});
});

describe("env precedence", () => {
	it("env wins over the saved key, then the file, then none", () => {
		const root = tempDir();
		expect(getRouterKeyStatus(root, "jev", {}).source).toBe("none");
		saveRouterKey(root, "jev", JEV_SECRET);
		const file = getRouterKeyStatus(root, "jev", {});
		expect(file).toMatchObject({
			source: "file",
			hasSavedKey: true,
			label: "saved in ~/.runkiln/agent/router-keys.json",
		});
		const env = getRouterKeyStatus(root, "jev", { TYPESAFE_API_KEY: ENV_SECRET });
		expect(env.source).toBe("environment");
		expect(env.label).toBe("TYPESAFE_API_KEY (environment, overrides the saved key)");
		for (const status of [file, env]) assertClean(status.label, [JEV_SECRET, ENV_SECRET]);
		expect(resolveClassifierKey("jev", { TYPESAFE_API_KEY: ENV_SECRET }, readRouterKeys(root))).toEqual({
			apiKey: ENV_SECRET,
			source: "environment",
		});
		expect(resolveClassifierKey("jev", { TYPESAFE_API_KEY: "  " }, readRouterKeys(root))?.source).toBe("file");
	});

	it("the classifier uses the env key first, then the stored key; auto picks the backend with a key", async () => {
		const cat = testCatalog();
		const catalogInfo = { skills: cat.skills, skillThreshold: 0.12, maxSecondarySkills: 3 };
		const stored = { openrouter: OR_SECRET };
		const auto = createClassifier({}, catalogInfo, {}, undefined, stored);
		expect(auto.classifier?.backend).toBe("openrouter");
		expect(createClassifier({}, catalogInfo, {}, undefined, {}).problem).toMatch(/no classifier key/);
		expect(
			createClassifier({}, catalogInfo, {}, undefined, { jev: JEV_SECRET, openrouter: OR_SECRET }).classifier
				?.backend,
		).toBe("jev");
		expect(createClassifier({ classifier: "off" }, catalogInfo, {}, undefined, stored).classifier).toBeUndefined();
		// A lazy source that throws reads as no saved keys.
		expect(
			createClassifier({}, catalogInfo, {}, undefined, () => {
				throw new Error("unreadable");
			}).problem,
		).toMatch(/no classifier key/);

		const { impl, calls } = fakeFetch({ "/chat/completions": { status: 500, body: "x" } });
		const fromFile = createClassifier({ classifier: "openrouter" }, catalogInfo, {}, impl, stored).classifier;
		await fromFile?.classify(classifierInput()).catch(() => undefined);
		expect(calls[0]?.headers.Authorization).toBe(`Bearer ${OR_SECRET}`);
		const fromEnv = createClassifier(
			{ classifier: "openrouter" },
			catalogInfo,
			{ OPENROUTER_API_KEY: ENV_SECRET },
			impl,
			stored,
		).classifier;
		await fromEnv?.classify(classifierInput()).catch(() => undefined);
		expect(calls[1]?.headers.Authorization).toBe(`Bearer ${ENV_SECRET}`);
	});

	it("reports the active classifier from settings, env and the file", () => {
		const root = tempDir();
		expect(getActiveRouterClassifier(root, {})).toEqual({ choice: "auto" });
		saveRouterKey(root, "openrouter", OR_SECRET);
		expect(getActiveRouterClassifier(root, {})).toMatchObject({
			choice: "auto",
			backend: "openrouter",
			model: "typesafe/jev-1.14",
			key: { source: "file" },
		});
		saveRouterClassifier(root, "jev");
		expect(getActiveRouterClassifier(root, { TYPESAFE_API_KEY: ENV_SECRET })).toMatchObject({
			choice: "jev",
			backend: "jev",
			model: "jev-latest",
			key: { source: "environment" },
		});
		saveRouterClassifier(root, "off");
		expect(getActiveRouterClassifier(root, { TYPESAFE_API_KEY: ENV_SECRET })).toEqual({ choice: "off" });
	});
});

function classifierInput() {
	return {
		request: "hi",
		recentContext: "",
		hasImages: false,
		harness: {
			role: "chat" as const,
			contextTokens: 1,
			toolErrorsThisTurn: 0,
			testFailuresThisTurn: 0,
			filesTouchedThisTurn: 0,
		},
	};
}

describe("live key checks (mocked HTTP)", () => {
	it("Jev: GET /v1/models with only the bearer header and no redirects", async () => {
		const { impl, calls } = fakeFetch({ "/v1/models": { status: 200, body: JEV_MODELS } });
		const ok = await checkRouterKey({ backend: "jev", apiKey: JEV_SECRET, fetchImpl: impl });
		expect(ok).toEqual({ ok: true, message: "✓ Jev key works", detail: undefined });
		expect(calls[0]).toMatchObject({
			url: "https://api.typesafe.ai/v1/models",
			method: "GET",
			redirect: "error",
			headers: { Authorization: `Bearer ${JEV_SECRET}` },
		});
		const missing = await checkRouterKey({ backend: "jev", apiKey: JEV_SECRET, model: "jev-gone", fetchImpl: impl });
		expect(missing.detail).toBe("Jev does not list model jev-gone.");
	});

	it("OpenRouter: GET /key, shows usage but never the key label", async () => {
		const { impl, calls } = fakeFetch({ "/key": { status: 200, body: OR_KEY_BODY } });
		const ok = await checkRouterKey({ backend: "openrouter", apiKey: OR_SECRET, fetchImpl: impl });
		expect(calls[0]?.url).toBe("https://openrouter.ai/api/v1/key");
		expect(ok.ok).toBe(true);
		expect(ok.message).toBe("✓ OpenRouter key works");
		expect(ok.detail).toBe("$0.17 used - $0.83 left on this key");
		assertClean(`${ok.message} ${ok.detail}`, [OR_SECRET, "sk-or-v1-abc"]);
	});

	const cases: Array<[string, FakeRoute | "network-error" | "timeout", RegExp]> = [
		["401", { status: 401, body: `${BODY_SENTINEL} ${JEV_SECRET}` }, /^invalid key: Jev rejected it/],
		["403", { status: 403, body: BODY_SENTINEL }, /Key refused by Jev \(403\)/],
		["402", { status: 402, body: BODY_SENTINEL }, /out of credits \(402\)/],
		[
			"429",
			{ status: 429, body: BODY_SENTINEL, headers: { "retry-after": "7" } },
			/Rate limited by Jev \(429\)\. Retry in 7s\./,
		],
		["500", { status: 500, body: BODY_SENTINEL }, /Jev error 500\. Try again shortly\./],
		["offline", "network-error", /Couldn't reach Jev\. Check your connection\./],
		["timeout", "timeout", /Jev didn't answer in time/],
	];
	for (const [name, route, pattern] of cases) {
		it(`Jev ${name} gives a fixed message without the key or body`, async () => {
			const { impl } = fakeFetch({ "/v1/models": route });
			const result = await checkRouterKey({ backend: "jev", apiKey: JEV_SECRET, fetchImpl: impl, timeoutMs: 50 });
			expect(result.ok).toBe(false);
			expect(result.message).toMatch(pattern);
			assertClean(JSON.stringify(result), [JEV_SECRET]);
		});
	}

	it("OpenRouter 401 and invalid JSON", async () => {
		const unauthorized = await checkRouterKey({
			backend: "openrouter",
			apiKey: OR_SECRET,
			fetchImpl: fakeFetch({ "/key": { status: 401, body: { error: { message: OR_SECRET } } } }).impl,
		});
		expect(unauthorized.message).toBe("invalid key: OpenRouter rejected it (wrong, revoked or expired).");
		const invalid = await checkRouterKey({
			backend: "openrouter",
			apiKey: OR_SECRET,
			fetchImpl: fakeFetch({ "/key": { status: 200, body: "not json" } }).impl,
		});
		expect(invalid.message).toBe("OpenRouter sent an invalid response.");
		assertClean(JSON.stringify([unauthorized, invalid]), [OR_SECRET]);
	});

	it("refuses non-https endpoints and malformed keys before any request", async () => {
		const { impl, calls } = fakeFetch({});
		expect(
			(await checkRouterKey({ backend: "jev", apiKey: JEV_SECRET, baseUrl: "http://evil.example", fetchImpl: impl }))
				.ok,
		).toBe(false);
		expect((await checkRouterKey({ backend: "jev", apiKey: "a b", fetchImpl: impl })).message).toMatch(/one line/);
		expect(calls).toHaveLength(0);
	});

	it("validates OpenRouter model ids", () => {
		expect(validateOpenRouterModelId("typesafe/jev-1.14")).toBeUndefined();
		expect(validateOpenRouterModelId("inception/mercury-decide:free")).toBeUndefined();
		expect(validateOpenRouterModelId("~perplexity/pplx-decider-latest")).toBeUndefined();
		expect(validateOpenRouterModelId("gemini")).toMatch(/vendor\/model/);
		expect(validateOpenRouterModelId("")).toMatch(/Enter a decision model id/);
	});

	it("accepts only decision models for the OpenRouter classifier", () => {
		const live = {
			source: "live" as const,
			entries: [{ id: "typesafe/jev-1.14", canonicalSlug: "typesafe/jev-1.14-20261014" }, { id: "liquid/d1-ultra" }],
		};
		expect(validateOpenRouterDecisionModel("liquid/d1-ultra", live)).toBeUndefined();
		expect(validateOpenRouterDecisionModel("typesafe/jev-1.14-20261014", live)).toBeUndefined();
		expect(validateOpenRouterDecisionModel("google/gemini-2.5-flash-lite", live)).toMatch(
			/not an OpenRouter decision model/,
		);
		expect(validateOpenRouterDecisionModel("acme/new-chat-model", live)).toMatch(/not an OpenRouter decision model/);
		// Offline (built-in list): a new id passes, a known chat model does not.
		const builtin = { source: "builtin" as const, entries: [] };
		expect(validateOpenRouterDecisionModel("acme/new-decider", builtin)).toBeUndefined();
		expect(validateOpenRouterDecisionModel("google/gemini-2.5-flash-lite", builtin)).toMatch(/not an OpenRouter/);
	});

	it("moves a saved chat-model classifier to the decision default, once, with a notice", () => {
		const root = tempDir();
		expect(migrateOpenRouterClassifierModel(root)).toBeUndefined();
		writeFileSync(
			join(root, "settings.json"),
			JSON.stringify({
				theme: "dark",
				router: { classifier: "openrouter", openrouter: { model: "google/gemini-2.5-flash-lite" } },
			}),
		);
		expect(migrateOpenRouterClassifierModel(root)).toBe(
			"Router: google/gemini-2.5-flash-lite is not a decision model, so the OpenRouter classifier now uses typesafe/jev-1.14.",
		);
		expect(JSON.parse(readFileSync(join(root, "settings.json"), "utf8"))).toEqual({
			theme: "dark",
			router: { classifier: "openrouter", openrouter: { model: "typesafe/jev-1.14" } },
		});
		expect(migrateOpenRouterClassifierModel(root)).toBeUndefined();
		// A model missing from the cached live list moves too; a listed one stays.
		const live = { source: "cache" as const, entries: [{ id: "typesafe/jev-1.14" }, { id: "liquid/d1-ultra" }] };
		saveRouterClassifier(root, "openrouter", "liquid/d1-ultra");
		expect(migrateOpenRouterClassifierModel(root, live)).toBeUndefined();
		saveRouterClassifier(root, "openrouter", "mistralai/ministral-8b");
		expect(migrateOpenRouterClassifierModel(root, live)).toMatch(/ministral-8b is not a decision model/);
		expect(loadRouterClassifierSettings(root).openrouterModel).toBe("typesafe/jev-1.14");
	});
});

// ---------------------------------------------------------------------------------------------

describe("classifier setting", () => {
	it("merges router.classifier and the model into settings.json", () => {
		const root = tempDir();
		writeFileSync(
			join(root, "settings.json"),
			JSON.stringify({ theme: "dark", router: { mode: "high", jev: { model: "jev-preview" } } }),
		);
		saveRouterClassifier(root, "openrouter", "openai/gpt-4.1-nano");
		expect(JSON.parse(readFileSync(join(root, "settings.json"), "utf8"))).toEqual({
			theme: "dark",
			router: {
				mode: "high",
				jev: { model: "jev-preview" },
				classifier: "openrouter",
				openrouter: { model: "openai/gpt-4.1-nano" },
			},
		});
		saveRouterClassifier(root, "off");
		expect(loadRouterClassifierSettings(root)).toMatchObject({
			classifier: "off",
			jevModel: "jev-preview",
			openrouterModel: "openai/gpt-4.1-nano",
		});
	});
});

describe("setup router step", () => {
	function setup(root: string, env: NodeJS.ProcessEnv, impl: typeof fetch) {
		const done: { lines?: string[] } = {};
		const screen = new SetupWizard({
			agentDir: root,
			env,
			layout: "inline",
			themes: ["dark"],
			baseUrl: "https://api.runinfra.example/ri",
			fetchImpl: impl,
			spinnerIntervalMs: 0,
			keyAdvanceMs: 0,
			onComplete: (result) => {
				done.lines = result.lines;
			},
			onCancel: () => undefined,
		});
		const text = () => stripAnsi(screen.render(120).join("\n"));
		const type = async (value: string) => {
			for (const char of value) screen.handleInput(char);
			await screen.whenIdle();
		};
		const press = async (key: string) => {
			screen.handleInput(key);
			await screen.whenIdle();
		};
		/** Accept the remaining defaults, then Finish on the review. */
		const finish = async () => {
			for (let i = 0; i < 4 && screen.step !== "summary"; i++) await press("\r");
			expect(text()).toContain("[ Finish ]");
			await press("\r");
		};
		return { screen, text, type, press, finish, done };
	}

	it("Jev: checks the typed key live, then saves it 0600 and sets router.classifier", async () => {
		const root = tempDir();
		const { impl, calls } = fakeFetch({
			"/models": { status: 200, body: RUNINFRA_MODELS },
			"/v1/models": { status: 200, body: JEV_MODELS },
		});
		const s = setup(root, {}, impl);
		await s.type(RUNINFRA_SECRET);
		await s.press("\r");
		await s.press("\r"); // past "✓ Key works"
		await s.press("\x1b[A"); // Auto
		await s.press("\r");
		expect(s.text()).toContain("Classifier");
		expect(s.text()).toContain("Auto routing needs a small classifier key.");
		expect(s.text()).toContain("❯ Jev (TypeSafe)");
		expect(s.text()).toContain("Skip");
		await s.press("\r");
		expect(s.text()).toContain("Jev (TypeSafe) key");
		expect(s.text()).toContain("https://console.typesafe.ai/");
		await s.type(JEV_SECRET);
		expect(s.text()).toContain("•");
		assertClean(s.text(), [JEV_SECRET, RUNINFRA_SECRET]);
		await s.press("\r");
		// The result stays on the step until enter.
		expect(s.screen.step).toBe("router");
		expect(s.text()).toContain("✓ Jev key works");
		await s.press("\r");
		expect(s.screen.step).toBe("permissions");
		expect(existsSync(join(root, "router-keys.json"))).toBe(false);
		await s.finish();
		expect(s.done.lines).toContain("router: Jev (TypeSafe), key saved");
		assertClean(`${s.text()}\n${s.done.lines?.join("\n")}`, [JEV_SECRET, RUNINFRA_SECRET]);

		const path = join(root, "router-keys.json");
		expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(readRouterKeys(root).jev).toBe(JEV_SECRET);
		expect(loadRouterClassifierSettings(root).classifier).toBe("jev");
		const jevCall = calls.find((call) => call.url === "https://api.typesafe.ai/v1/models");
		expect(jevCall?.headers).toEqual({ Authorization: `Bearer ${JEV_SECRET}` });
	});

	it("OpenRouter with an env key: opened from the review, asks for the model, uses the env key, and saves no key", async () => {
		const root = tempDir();
		const { impl, calls } = fakeFetch({
			"/models": { status: 200, body: RUNINFRA_MODELS },
			"/key": { status: 200, body: OR_KEY_BODY },
		});
		const s = setup(root, { OPENROUTER_API_KEY: ENV_SECRET }, impl);
		await s.type(RUNINFRA_SECRET);
		await s.press("\r");
		await s.press("\r"); // past "✓ Key works"
		// The env key already backs a classifier: auto is preselected and the classifier step is skipped.
		expect(s.text()).toContain("❯ Auto");
		await s.press("\r");
		await s.press("\r");
		expect(s.screen.step).toBe("summary");
		await s.press("\x1b[A");
		await s.press("\x1b[A"); // Permissions → Classifier
		await s.press("\r");
		expect(s.text()).toContain("❯ Keep OpenRouter");
		await s.press("\x1b[B");
		await s.press("\x1b[B");
		expect(s.text()).toContain("❯ OpenRouter");
		expect(s.text()).toContain("OPENROUTER_API_KEY is set");
		await s.press("\r");
		// A picker of decision models (built-in list here: the fake /models answer has none), default first.
		expect(s.text()).toContain("Decision model");
		expect(s.text()).toMatch(/❯ typesafe\/jev-1\.14 +\$0\.042\/M in - 256k ctx - recommended/);
		expect(s.text()).toContain("liquid/d1-ultra");
		expect(s.text()).not.toContain("gemini");
		expect(s.text()).toContain("Only decision models");
		await s.press("\x1b[B");
		expect(s.text()).toMatch(/❯ liquid\/d1-ultra/);
		await s.press("\r");
		expect(s.text()).toContain("Using `OPENROUTER_API_KEY` from your environment.");
		expect(s.text()).toContain("✓ OpenRouter key works");
		expect(s.text()).toContain("$0.83 left on this key");
		await s.press("\r");
		await s.finish();
		expect(s.done.lines).toContain("router: OpenRouter (liquid/d1-ultra), using `OPENROUTER_API_KEY`");
		expect(existsSync(join(root, "router-keys.json"))).toBe(false);
		expect(loadRouterClassifierSettings(root)).toMatchObject({
			classifier: "openrouter",
			openrouterModel: "liquid/d1-ultra",
		});
		expect(calls.find((call) => call.url.endsWith("/key"))?.headers.Authorization).toBe(`Bearer ${ENV_SECRET}`);
		assertClean(`${s.text()}\n${s.done.lines?.join("\n")}`, [ENV_SECRET, RUNINFRA_SECRET]);
	});

	it("a rejected router key stays on the step, clears the input, and saves nothing", async () => {
		const root = tempDir();
		const { impl } = fakeFetch({
			"/models": { status: 200, body: RUNINFRA_MODELS },
			"/v1/models": { status: 401, body: `${BODY_SENTINEL} ${JEV_SECRET}` },
		});
		const s = setup(root, {}, impl);
		await s.type(RUNINFRA_SECRET);
		await s.press("\r");
		await s.press("\r"); // past "✓ Key works"
		await s.press("\x1b[A"); // Auto
		await s.press("\r");
		await s.press("\r");
		await s.type(JEV_SECRET);
		await s.press("\r");
		const text = s.text();
		expect(text).toContain("✗ invalid key: Jev rejected it");
		expect(text).toContain("Jev (TypeSafe) key");
		expect(text).not.toContain("•");
		expect(s.screen.step).toBe("router");
		assertClean(text, [JEV_SECRET]);
		// Esc goes back to the choice; Skip then falls back to a manual model with the router off.
		await s.press("\x1b");
		expect(s.text()).toContain("Skip");
		await s.press("\x1b[B");
		await s.press("\x1b[B");
		await s.press("\r");
		expect(s.text()).toContain("No classifier: using");
		await s.finish();
		expect(s.done.lines).toContain("router: off (add a classifier key later with /setup keys)");
		expect(existsSync(join(root, "router-keys.json"))).toBe(false);
		expect(loadRouterClassifierSettings(root).classifier).toBe("off");
	});
});

describe("/setup keys: classifier keys", () => {
	function hub(root: string, env: NodeJS.ProcessEnv, impl: typeof fetch) {
		const result: { closed?: SetupHubResult } = {};
		const screen = new SetupHub({
			agentDir: root,
			env,
			layout: "inline",
			themes: ["dark"],
			previewTheme: () => undefined,
			baseUrl: "https://api.runinfra.example/ri",
			fetchImpl: impl,
			spinnerIntervalMs: 0,
			onClose: (value) => {
				result.closed = value;
			},
		});
		const text = () => stripAnsi(screen.render(120).join("\n"));
		const press = async (...keys: string[]) => {
			for (const key of keys) screen.handleInput(key);
			await screen.whenIdle();
		};
		return { screen, text, press, result };
	}

	it("shows where each key comes from; the env key wins, and t tests the one in use", async () => {
		const root = tempDir();
		saveRouterKey(root, "jev", JEV_SECRET);
		saveRouterClassifier(root, "jev");
		const { impl, calls } = fakeFetch({ "/v1/models": { status: 200, body: JEV_MODELS } });
		const h = hub(root, { TYPESAFE_API_KEY: ENV_SECRET }, impl);
		expect(h.text()).toMatch(/Jev \(TypeSafe\)\s+classifier\s+TYPESAFE_API_KEY/);
		expect(h.text()).toMatch(/OpenRouter\s+classifier\s+not set/);
		await h.press("\x1b[B");
		expect(h.text()).toContain("From TYPESAFE_API_KEY - in use");
		await h.press("t");
		expect(h.text()).toContain("✓ Jev key works");
		expect(h.text()).toMatch(/TYPESAFE_API_KEY - ✓ works/);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.headers.Authorization).toBe(`Bearer ${ENV_SECRET}`);
		assertClean(h.text(), [JEV_SECRET, ENV_SECRET]);
	});

	it("sets an OpenRouter key: checked live, saved 0600 at once, and the router is rebuilt", async () => {
		const root = tempDir();
		const { impl } = fakeFetch({ "/key": { status: 200, body: OR_KEY_BODY } });
		const h = hub(root, {}, impl);
		await h.press("\x1b[B", "\x1b[B", "\r");
		expect(h.text()).toContain("OpenRouter key");
		expect(h.text()).toContain("https://openrouter.ai/settings/keys");
		for (const char of OR_SECRET) h.screen.handleInput(char);
		expect(h.text()).toContain(`${OR_SECRET.length} characters, hidden`);
		await h.press("\r");
		expect(h.text()).toContain("OpenRouter key works");
		expect(h.text()).toContain("saved");
		expect(readRouterKeys(root).openrouter).toBe(OR_SECRET);
		expect(statSync(join(root, "router-keys.json")).mode & 0o777).toBe(0o600);
		assertClean(h.text(), [OR_SECRET]);
		await h.press("\x1b");
		expect(h.result.closed).toMatchObject({ section: "keys", keyChanged: false, routerChanged: true });
	});

	it("a rejected key saves nothing; del asks first, then removes the saved key", async () => {
		const root = tempDir();
		saveRouterKey(root, "jev", JEV_SECRET);
		saveRouterClassifier(root, "jev");
		const impl = (async () =>
			new Response(JSON.stringify({ detail: BODY_SENTINEL }), { status: 429 })) as typeof fetch;
		const h = hub(root, {}, impl);
		await h.press("\x1b[B", "\r");
		for (const char of "ts_replacement_secret") h.screen.handleInput(char);
		await h.press("\r");
		expect(h.text()).toContain("Rate limited by Jev (429).");
		expect(readRouterKeys(root).jev).toBe(JEV_SECRET);
		await h.press("\x1b", "\x1b[3~");
		expect(h.text()).toContain("Remove the saved Jev (TypeSafe) key?");
		expect(h.text()).toContain("y remove - n keep");
		await h.press("y");
		expect(h.text()).toContain("✓ Jev (TypeSafe) key removed");
		expect(existsSync(join(root, "router-keys.json"))).toBe(false);
		assertClean(h.text(), [JEV_SECRET, "ts_replacement_secret"]);
	});

	it("Routing: mode, classifier and decision model each save on enter, nothing before", async () => {
		const root = tempDir();
		const { impl } = fakeFetch({});
		const h = hub(root, {}, impl);
		await h.press("3");
		expect(h.screen.currentSection).toBe("routing");
		await h.press("\x1b[C");
		expect(h.text()).toContain("Not saved yet: enter saves.");
		expect(existsSync(join(root, "settings.json"))).toBe(false);
		await h.press("\r");
		expect(JSON.parse(readFileSync(join(root, "settings.json"), "utf8")).router.mode).toBe("high");
		await h.press("\x1b[B", "\x1b[C", "\r"); // Classifier: Auto -> Jev
		expect(loadRouterClassifierSettings(root).classifier).toBe("jev");
		expect(h.text()).toContain("It has no key yet: add one in Keys.");
		await h.press("\x1b[B", "\r"); // Decision model picker
		expect(h.text()).toContain("OpenRouter decision model");
		await h.press("\x1b[B", "\r");
		const saved = loadRouterClassifierSettings(root);
		expect(saved.classifier).toBe("jev");
		expect(saved.openrouterModel).toBeDefined();
		expect(saved.openrouterModel).not.toBe("typesafe/jev-1.14");
		await h.press("\x1b");
		expect(h.result.closed).toMatchObject({ routerChanged: true, settingsChanged: true });
	});
});

describe("runkiln login / logout --router", () => {
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

	it("parses --router values without treating them as a prompt", () => {
		expect(parseAccountCommand(["login", "--router", "jev", "--stdin"])).toEqual({
			command: "login",
			flags: ["--router", "jev", "--stdin"],
		});
		expect(parseAccountCommand(["login", "--router", "openrouter", "--router-model", "a/b"])).toBeDefined();
		expect(parseAccountCommand(["logout", "--router"])).toEqual({ command: "logout", flags: ["--router"] });
		expect(parseAccountCommand(["login", "please", "--router", "jev"])).toBeUndefined();
	});

	it("login --router openrouter --stdin checks, saves 0600, and sets the classifier and model", async () => {
		const root = tempDir();
		const { impl, calls } = fakeFetch({ "/key": { status: 200, body: OR_KEY_BODY } });
		const login = io({
			readStdin: async () => `${OR_SECRET}\n`,
			fetchImpl: impl,
			env: { OPENROUTER_API_KEY: ENV_SECRET },
		});
		const code = await runAccountCommand(
			"login",
			["--router", "openrouter", "--stdin", "--router-model", "liquid/d1-ultra"],
			root,
			login,
		);
		expect(code).toBe(0);
		// The decision-model list is public: fetched without the key.
		expect(
			calls.find((call) => call.url.includes("output_modalities=decisions"))?.headers.Authorization,
		).toBeUndefined();
		expect(calls.find((call) => call.url.endsWith("/key"))?.headers.Authorization).toBe(`Bearer ${OR_SECRET}`);
		expect(readRouterKeys(root).openrouter).toBe(OR_SECRET);
		expect(statSync(join(root, "router-keys.json")).mode & 0o777).toBe(0o600);
		expect(loadRouterClassifierSettings(root)).toMatchObject({
			classifier: "openrouter",
			openrouterModel: "liquid/d1-ultra",
		});
		const output = stripAnsi(login.out.join("\n"));
		expect(output).toContain("OpenRouter key works and is saved");
		expect(output).toContain("OPENROUTER_API_KEY is set in this shell and overrides the saved router key.");
		assertClean(output, [OR_SECRET, ENV_SECRET]);

		// A chat model is refused before any key check.
		const chat = io({ readStdin: async () => `${OR_SECRET}\n`, fetchImpl: impl });
		expect(
			await runAccountCommand(
				"login",
				["--router", "openrouter", "--stdin", "--router-model", "google/gemini-2.5-flash-lite"],
				root,
				chat,
			),
		).toBe(1);
		expect(stripAnsi(chat.out.join("\n"))).toContain("not an OpenRouter decision model");

		const logout = io();
		expect(await runAccountCommand("logout", ["--router", "openrouter"], root, logout)).toBe(0);
		expect(existsSync(join(root, "router-keys.json"))).toBe(false);
		expect(stripAnsi(logout.out.join("\n"))).toContain("Saved OpenRouter key removed.");
	});

	it("rejects a bad key, an unknown classifier, and a missing terminal; logout --router clears both", async () => {
		const root = tempDir();
		const bad = io({
			readStdin: async () => JEV_SECRET,
			fetchImpl: fakeFetch({ "/v1/models": { status: 401, body: BODY_SENTINEL } }).impl,
		});
		expect(await runAccountCommand("login", ["--router", "jev", "--stdin"], root, bad)).toBe(1);
		expect(stripAnsi(bad.out.join("\n"))).toContain("invalid key: Jev rejected it");
		assertClean(bad.out.join("\n"), [JEV_SECRET]);
		expect(existsSync(join(root, "router-keys.json"))).toBe(false);

		const unknown = io();
		expect(await runAccountCommand("login", ["--router", "gpt"], root, unknown)).toBe(1);
		expect(stripAnsi(unknown.out.join("\n"))).toContain('Unknown classifier "gpt"');

		const noTty = io();
		expect(await runAccountCommand("login", ["--router", "jev"], root, noTty)).toBe(1);
		expect(noTty.out.join("\n")).toContain("key set jev --stdin");

		const tty = io({
			stdinIsTTY: true,
			stdoutIsTTY: true,
			runHub: async (options) => {
				expect(options).toEqual({ section: "keys", keyAction: { key: "jev", action: "set" } });
				return { keyChanged: false, routerChanged: true };
			},
		});
		expect(await runAccountCommand("login", ["--router=jev"], root, tty)).toBe(0);
		expect(tty.out.join("\n")).toContain("`runkiln login` is now `runkiln key set`.");
		expect(tty.out.join("\n")).toContain("Router key updated.");

		saveRouterKey(root, "jev", JEV_SECRET);
		saveRouterKey(root, "openrouter", OR_SECRET);
		const logout = io();
		expect(await runAccountCommand("logout", ["--router"], root, logout)).toBe(0);
		expect(existsSync(join(root, "router-keys.json"))).toBe(false);
		// The RunInfra logout path is untouched by --router.
		writeFileSync(join(root, "runinfra.json"), JSON.stringify({ apiKey: RUNINFRA_SECRET }));
		await runAccountCommand("logout", ["--router"], root, io());
		expect(JSON.parse(readFileSync(join(root, "runinfra.json"), "utf8")).apiKey).toBe(RUNINFRA_SECRET);
	});
});
