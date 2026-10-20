import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visibleWidth } from "@runkiln/tui";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { type AccountCommandIo, parseAccountCommand, runAccountCommand } from "../../src/cli/account-commands.ts";
import { saveRouterKey } from "../../src/core/router/keys.ts";
import { loadModelsCatalog } from "../../src/core/runkiln/models-catalog.ts";
import {
	BUILTIN_SLASH_COMMAND_NAMES,
	BUILTIN_SLASH_COMMANDS,
	HIDDEN_SLASH_ALIASES,
} from "../../src/core/slash-commands.ts";
import {
	HUB_SECTIONS,
	parseHubSection,
	SetupHub,
	type SetupHubOptions,
	type SetupHubResult,
} from "../../src/modes/interactive/components/setup/setup-hub.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";

const stripAnsi = (text: string) => text.replace(/\x1b\[[0-9;]*m|\x1b\]8;[^\x07\x1b]*(?:\x07|\x1b\\)/g, "");
const ENTER = "\r";
const ESC = "\x1b";
const UP = "\x1b[A";
const DOWN = "\x1b[B";
const LEFT = "\x1b[D";
const RIGHT = "\x1b[C";

const dirs: string[] = [];
function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "runkiln-hub-"));
	dirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

beforeAll(() => initTheme("dark"));

const catalog = loadModelsCatalog();

function hub(options: Partial<SetupHubOptions> & { agentDir: string }) {
	const result: { closed?: SetupHubResult } = {};
	const rows = { value: 24 };
	const previews: Array<string | undefined> = [];
	const screen = new SetupHub({
		env: {},
		catalog,
		layout: "fullscreen",
		themes: ["system", "dark", "light"],
		previewTheme: (name) => previews.push(name),
		spinnerIntervalMs: 0,
		getRows: () => rows.value,
		onClose: (value) => {
			result.closed = value;
		},
		...options,
	});
	const frame = (width = 80) => screen.render(width).map(stripAnsi);
	const text = (width = 80) => frame(width).join("\n");
	const press = async (...keys: string[]) => {
		for (const key of keys) screen.handleInput(key);
		await screen.whenIdle();
	};
	const click = (needle: string, width = 80) => {
		const lines = frame(width);
		const y = lines.findIndex((line) => line.includes(needle));
		expect(y, `"${needle}" on screen`).toBeGreaterThanOrEqual(0);
		const x = (lines[y] ?? "").indexOf(needle);
		const event = { button: "left" as const, x, y, screenX: x, screenY: y, width, height: lines.length };
		const keys = { shift: false, alt: false, ctrl: false };
		screen.handleMouse({ ...event, ...keys, type: "press" });
		screen.handleMouse({ ...event, ...keys, type: "click" });
	};
	return { screen, frame, text, press, click, result, rows, previews };
}

function settings(root: string): Record<string, any> {
	return JSON.parse(readFileSync(join(root, "settings.json"), "utf8"));
}

describe("/setup hub: sections", () => {
	it("opens on a section by name (with short forms) and walks them with tab and digits", async () => {
		expect(parseHubSection("keys")).toBe("keys");
		expect(parseHubSection("key")).toBe("keys");
		expect(parseHubSection("theme")).toBe("look");
		expect(parseHubSection("statusline")).toBe("footer");
		expect(parseHubSection("nope")).toBeUndefined();
		const h = hub({ agentDir: tempDir(), section: "permissions" });
		expect(h.screen.currentSection).toBe("permissions");
		await h.press("\t");
		expect(h.screen.currentSection).toBe("look");
		await h.press("\x1b[Z", "\x1b[Z");
		expect(h.screen.currentSection).toBe("routing");
		await h.press("1");
		expect(h.screen.currentSection).toBe("keys");
		h.click("Footer");
		expect(h.screen.currentSection).toBe("footer");
	});

	it("Keys: a RunInfra key that checks out is saved, with its model count and credits", async () => {
		const root = tempDir();
		writeFileSync(join(root, "runinfra.json"), JSON.stringify({ baseUrl: "https://api.runinfra.example/v1" }));
		const models = JSON.stringify({ data: [{ id: catalog.models[0]?.id }] });
		const fetchImpl = (async (url: string | URL) =>
			String(url).endsWith("/credits")
				? new Response(JSON.stringify({ available_cents: 5476 }), { status: 200 })
				: new Response(models, { status: 200 })) as typeof fetch;
		const h = hub({ agentDir: root, section: "keys", fetchImpl });
		await h.press(ENTER);
		for (const char of "rk_hub_key_never_shown") h.screen.handleInput(char);
		await h.press(ENTER);
		await new Promise((resolve) => setTimeout(resolve, 0));
		const shown = h.text();
		expect(shown).toContain("✓ Key works - 1 model - saved");
		expect(shown).toContain("$54.76 available");
		expect(shown).not.toContain("rk_hub_key_never_shown");
		expect(JSON.parse(readFileSync(join(root, "runinfra.json"), "utf8")).apiKey).toBe("rk_hub_key_never_shown");
	});

	it("Model: arrows change but only enter saves; auto needs a classifier key", async () => {
		const root = tempDir();
		const h = hub({ agentDir: root, section: "model" });
		expect(h.text()).toContain("❯ Manual");
		await h.press(RIGHT);
		expect(h.text()).toContain("Not saved yet: enter saves.");
		expect(existsSync(join(root, "settings.json"))).toBe(false);
		await h.press(DOWN, RIGHT, RIGHT); // thinking: model default -> off -> minimal
		await h.press(ENTER);
		const saved = settings(root);
		expect(saved.models.code).toBe(catalog.models[1]?.id);
		expect(saved.defaultThinkingLevel).toBe("minimal");
		expect(h.text()).toContain("Saved:");
		await h.press(UP, UP); // Auto
		await h.press(ENTER);
		expect(h.text()).toContain("Auto needs a Jev or OpenRouter key: add one in Keys.");
		expect(settings(root).models.code).toBe(catalog.models[1]?.id);
		saveRouterKey(root, "jev", "ts_jev_key_never_shown");
		await h.press(ENTER);
		expect(settings(root).models.code).toBe("auto:medium");
		expect(settings(root).defaultThinkingLevel).toBeUndefined();
		await h.press(ESC);
		expect(h.result.closed).toMatchObject({ section: "model", settingsChanged: true });
		expect(h.text()).not.toContain("ts_jev_key_never_shown");
	});

	it("Model and Footer rows hand their screens to the host, or say where to find them", async () => {
		const standalone = hub({ agentDir: tempDir(), section: "footer" });
		await standalone.press(ENTER);
		expect(standalone.result.closed).toBeUndefined();
		expect(standalone.text()).toContain("Open /setup footer inside a session for this.");

		const session = hub({
			agentDir: tempDir(),
			section: "model",
			screens: ["models", "scoped-models", "statusline"],
		});
		await session.press(DOWN, DOWN, ENTER); // Manual -> Thinking -> Enabled models
		expect(session.result.closed).toMatchObject({ open: "models", section: "model" });

		const footer = hub({ agentDir: tempDir(), section: "footer", screens: ["statusline"] });
		footer.click("Footer items");
		expect(footer.result.closed).toMatchObject({ open: "statusline", section: "footer" });
	});

	it("Permissions: enter saves the mode; auto is refused without a classifier key", async () => {
		const root = tempDir();
		const h = hub({ agentDir: root, section: "permissions" });
		await h.press(DOWN);
		await h.press(ENTER);
		expect(settings(root).permissions).toEqual({ mode: "ask" });
		expect(h.text()).toMatch(/● Ask everything/);
		await h.press(DOWN, ENTER); // wraps to Auto
		expect(h.text()).toContain("Auto needs a Jev or OpenRouter key");
		expect(settings(root).permissions).toEqual({ mode: "ask" });
	});

	it("Look: moving previews, enter saves, leaving unsaved restores the theme", async () => {
		const root = tempDir();
		const h = hub({ agentDir: root, section: "look" });
		await h.press(DOWN);
		expect(h.previews).toEqual(["dark"]);
		expect(h.text()).toContain("Preview: enter saves.");
		await h.press("1");
		expect(h.previews).toEqual(["dark", undefined]);
		expect(existsSync(join(root, "settings.json"))).toBe(false);
		await h.press("5", DOWN, DOWN, ENTER);
		expect(settings(root).theme).toBe("light");
		await h.press(ESC);
		expect(h.result.closed).toMatchObject({ section: "look", settingsChanged: true });
	});
});

describe("/setup hub: layout", () => {
	it("fills the window at 100x30, 80x24 and 80x20 with the tabs and hints pinned, in every section", async () => {
		const root = tempDir();
		const h = hub({ agentDir: root });
		for (const [width, height] of [
			[100, 30],
			[80, 24],
			[80, 20],
		] as const) {
			h.rows.value = height;
			const tabRows = new Set<number>();
			for (const section of HUB_SECTIONS) {
				await h.press(String(HUB_SECTIONS.indexOf(section) + 1));
				const lines = h.screen.render(width);
				expect(lines).toHaveLength(height);
				for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
				const plain = lines.map(stripAnsi);
				const tabs = plain.findIndex((line) => line.includes("Keys") && line.includes("Footer"));
				tabRows.add(tabs);
				// Tabs, blank, one line, blank: the header keeps its spacing.
				expect(plain[tabs + 1]).toBe("");
				expect(plain[tabs + 2]?.trim().length).toBeGreaterThan(0);
				expect(plain[tabs + 3]).toBe("");
				expect(plain[height - 2]?.trim()).toMatch(/^─+$/);
				expect(plain[height - 1]).toContain("esc");
			}
			// The header never moves between sections.
			expect(tabRows.size).toBe(1);
		}
	});

	it("moving the cursor never changes the height of a section", async () => {
		const h = hub({ agentDir: tempDir(), section: "model" });
		// Every row keeps its place: the last row and the hints sit on the same lines whatever has the cursor.
		const rows = new Set<string>();
		const where = () => {
			const lines = h.frame();
			return `${lines.findIndex((line) => line.includes("Ctrl+P cycle"))}:${lines.findIndex((line) => line.includes("esc close"))}`;
		};
		for (let i = 0; i < 6; i++) {
			rows.add(where());
			await h.press(DOWN);
		}
		expect(rows.size).toBe(1);
	});

	it("buttons and hints are clickable", async () => {
		const root = tempDir();
		writeFileSync(join(root, "runinfra.json"), JSON.stringify({ apiKey: "rk_saved_never_shown" }));
		const h = hub({ agentDir: root });
		h.click("[ Remove ]");
		expect(h.text()).toContain("Remove the saved RunInfra key?");
		h.click("n keep");
		expect(h.text()).not.toContain("Remove the saved");
		h.click("[ Set ]");
		expect(h.text()).toContain("RunInfra key");
		expect(h.text()).toContain("paste the key");
		h.click("esc cancel");
		h.click("tab section");
		expect(h.screen.currentSection).toBe("model");
		h.click("esc close");
		expect(h.result.closed).toMatchObject({ section: "model" });
		expect(h.text()).not.toContain("rk_saved_never_shown");
	});
});

describe("command consolidation", () => {
	it("lists one name per job; the old names are hidden aliases that point at the new one", () => {
		const names = BUILTIN_SLASH_COMMANDS.map((command) => command.name);
		expect(names.filter((name, index) => names.indexOf(name) !== index)).toEqual([]);
		for (const hidden of ["key", "login", "logout", "runinfra", "models", "scoped-models", "statusline"]) {
			expect(names).not.toContain(hidden);
			expect(HIDDEN_SLASH_ALIASES[hidden]).toMatch(/^\/setup/);
		}
		expect(HIDDEN_SLASH_ALIASES.cost).toBe("/usage");
		expect(HIDDEN_SLASH_ALIASES.stats).toBe("/usage");
		expect(HIDDEN_SLASH_ALIASES.hotkeys).toBe("/help");
		expect(HIDDEN_SLASH_ALIASES.clear).toBe("/new");
		expect(HIDDEN_SLASH_ALIASES.exit).toBe("/quit");
		expect(HIDDEN_SLASH_ALIASES.clone).toBe("/fork");
		expect(HIDDEN_SLASH_ALIASES.session).toBe("/status");
		for (const target of Object.values(HIDDEN_SLASH_ALIASES)) expect(names).toContain(target.slice(1).split(" ")[0]);
		// Aliases stay reserved against extensions.
		for (const name of Object.keys(HIDDEN_SLASH_ALIASES)) expect(BUILTIN_SLASH_COMMAND_NAMES.has(name)).toBe(true);
		expect(names.length).toBeLessThanOrEqual(37);
		expect(BUILTIN_SLASH_COMMANDS.find((command) => command.name === "setup")?.argumentHint).toContain("keys");
	});

	it("runkiln key: status, set from stdin, test, remove; login and logout still work and say the new name", async () => {
		const root = tempDir();
		const out: string[] = [];
		const io = (overrides: Partial<AccountCommandIo> = {}): AccountCommandIo => ({
			stdinIsTTY: false,
			stdoutIsTTY: false,
			readStdin: async () => "",
			log: (line) => out.push(line),
			error: (line) => out.push(line),
			env: {},
			runSetup: async () => undefined,
			runHub: async () => ({ keyChanged: false, routerChanged: false }),
			...overrides,
		});
		expect(parseAccountCommand(["key"])).toEqual({ command: "key", flags: [] });
		expect(parseAccountCommand(["key", "set", "jev", "--stdin"])).toEqual({
			command: "key",
			flags: ["--stdin"],
			positionals: ["set", "jev"],
		});
		expect(parseAccountCommand(["key", "the", "door"])).toBeUndefined();
		expect(parseAccountCommand(["setup", "keys"])).toEqual({ command: "setup", flags: [], positionals: ["keys"] });
		expect(parseAccountCommand(["setup", "the", "repo"])).toBeUndefined();

		expect(await runAccountCommand("key", [], root, io())).toBe(0);
		expect(stripAnsi(out.join("\n"))).toMatch(/RunInfra\s+no key/);
		out.length = 0;

		const models = JSON.stringify({ data: [{ id: catalog.models[0]?.id }] });
		const fetchImpl = (async () => new Response(models, { status: 200 })) as typeof fetch;
		writeFileSync(join(root, "runinfra.json"), JSON.stringify({ baseUrl: "https://api.runinfra.example/v1" }));
		const set = io({ readStdin: async () => "rk_from_stdin_never_shown\n", fetchImpl });
		expect(await runAccountCommand("key", ["--stdin"], root, set, ["set"])).toBe(0);
		expect(JSON.parse(readFileSync(join(root, "runinfra.json"), "utf8")).apiKey).toBe("rk_from_stdin_never_shown");
		expect(await runAccountCommand("key", [], root, io({ fetchImpl }), ["test", "runinfra"])).toBe(0);
		expect(stripAnsi(out.join("\n"))).toContain("✓ RunInfra - 1 models");

		expect(await runAccountCommand("key", [], root, io(), ["remove"])).toBe(1);
		expect(out.join("\n")).toContain("Name the key: runinfra, jev or openrouter.");
		expect(await runAccountCommand("key", [], root, io(), ["remove", "runinfra"])).toBe(0);
		expect(JSON.parse(readFileSync(join(root, "runinfra.json"), "utf8")).apiKey).toBeUndefined();

		out.length = 0;
		expect(await runAccountCommand("logout", [], root, io())).toBe(0);
		expect(stripAnsi(out.join("\n"))).toContain("`runkiln logout` is now `runkiln key remove`.");
		expect(out.join("\n")).not.toContain("rk_from_stdin_never_shown");

		const hubCalls: unknown[] = [];
		const tty = io({
			stdinIsTTY: true,
			stdoutIsTTY: true,
			runHub: async (options) => {
				hubCalls.push(options);
				return { keyChanged: true, routerChanged: false };
			},
		});
		expect(await runAccountCommand("setup", [], root, tty, ["keys"])).toBe(0);
		expect(await runAccountCommand("key", [], root, tty, ["set"])).toBe(0);
		expect(hubCalls).toEqual([
			{ section: "keys" },
			{ section: "keys", keyAction: { key: "runinfra", action: "set" } },
		]);
	});
});
