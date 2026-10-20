import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Terminal } from "@runkiln/tui";
import { Compile } from "typebox/compile";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { chooseSetupDisplay, runSetup } from "../../src/cli/run-setup.ts";
import { parsePermissionMode, permissionModeInfo } from "../../src/core/runkiln/permissions.ts";
import {
	availablePermissionModes,
	loadStoredSetupDefaults,
	modelChoiceFromId,
	modelChoiceId,
	PERMISSION_LABELS,
	PERMISSION_MODES,
	saveSetupDefaults,
} from "../../src/core/runkiln/setup-settings.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { SettingsSchema } from "../../src/core/settings-schema.ts";
import { SetupFlow } from "../../src/modes/interactive/components/setup/setup-flow.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";

const dirs: string[] = [];
function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "runkiln-setup-flow-"));
	dirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	vi.restoreAllMocks();
});

describe("setup flow", () => {
	it("walks welcome → key → model → classifier → permissions → theme → review → done", () => {
		const flow = new SetupFlow({ done: true });
		expect(flow.steps).toEqual(["welcome", "key", "model", "router", "permissions", "theme", "summary", "done"]);
		expect(flow.current).toBe("welcome");
		expect(flow.position).toBe(0);
		expect(flow.total).toBe(6);
		expect(flow.next()).toBe("key");
		expect(flow.position).toBe(1);
		for (const step of ["model", "router", "permissions", "theme", "summary", "done"]) expect(flow.next()).toBe(step);
		expect(flow.position).toBe(0);
		// Next on the last screen stays there; there is no going back from done.
		expect(flow.next()).toBe("done");
		expect(flow.back()).toBe("quit");
	});

	it("skips steps the include rule leaves out, and follows the rule as it changes", () => {
		let needClassifier = false;
		const flow = new SetupFlow({ welcome: false, include: (step) => step !== "router" || needClassifier });
		expect(flow.steps).toEqual(["key", "model", "permissions", "theme", "summary"]);
		expect(flow.total).toBe(5);
		flow.next();
		expect(flow.next()).toBe("permissions");
		expect(flow.back()).toBe("moved");
		expect(flow.current).toBe("model");
		needClassifier = true;
		expect(flow.total).toBe(6);
		expect(flow.next()).toBe("router");
		needClassifier = false;
		// The step on screen always counts, even once the rule drops it.
		expect(flow.steps).toContain("router");
		expect(flow.next()).toBe("permissions");
		expect(flow.steps).not.toContain("router");
	});

	it("back moves one step and reports quit on the first screen", () => {
		const flow = new SetupFlow({ welcome: false });
		expect(flow.current).toBe("key");
		expect(flow.back()).toBe("quit");
		flow.next();
		expect(flow.back()).toBe("moved");
		expect(flow.current).toBe("key");
	});

	it("marks reached steps done, even after going back", () => {
		const flow = new SetupFlow({ welcome: false });
		flow.next();
		flow.next();
		expect(flow.stateOf("key")).toBe("done");
		expect(flow.stateOf("model")).toBe("done");
		expect(flow.stateOf("router")).toBe("current");
		expect(flow.stateOf("permissions")).toBe("upcoming");
		flow.back();
		flow.back();
		expect(flow.stateOf("key")).toBe("current");
		expect(flow.stateOf("router")).toBe("done");
	});

	it("a step reopened from the review returns to it on next and on back, even one the rule skips", () => {
		const flow = new SetupFlow({ welcome: false, include: (step) => step !== "router" });
		while (flow.current !== "summary") flow.next();
		flow.edit("router");
		expect(flow.current).toBe("router");
		expect(flow.isEditing).toBe(true);
		expect(flow.next()).toBe("summary");
		expect(flow.isEditing).toBe(false);
		flow.edit("permissions");
		expect(flow.back()).toBe("moved");
		expect(flow.current).toBe("summary");
	});

	it("jump moves to a step without leaving edit mode", () => {
		const flow = new SetupFlow({ welcome: false });
		while (flow.current !== "summary") flow.next();
		flow.edit("permissions");
		flow.jump("router");
		expect(flow.current).toBe("router");
		expect(flow.next()).toBe("summary");
	});

	it("leaves the theme step out when asked", () => {
		const flow = new SetupFlow({ welcome: false, theme: false });
		expect(flow.steps).not.toContain("theme");
		expect(flow.total).toBe(5);
		flow.edit("theme");
		expect(flow.current).toBe("key");
	});
});

describe("setup settings", () => {
	it("offers auto permissions only with a router key", () => {
		expect(availablePermissionModes(true)).toEqual([...PERMISSION_MODES]);
		expect(availablePermissionModes(false)).toEqual(["allow-all", "read-write", "ask"]);
	});

	it("maps model choices to ids and back", () => {
		expect(modelChoiceId({ kind: "auto", mode: "low" })).toBe("auto:low");
		expect(modelChoiceId({ kind: "manual", id: "glm-5-3-flash" })).toBe("glm-5-3-flash");
		expect(modelChoiceFromId("auto:high")).toEqual({ kind: "auto", mode: "high" });
		expect(modelChoiceFromId("auto", "low")).toEqual({ kind: "auto", mode: "low" });
		expect(modelChoiceFromId("runinfra/glm-5-3-flash")).toEqual({ kind: "manual", id: "glm-5-3-flash" });
		expect(modelChoiceFromId("  ")).toBeUndefined();
	});

	it("merges the defaults into settings.json and keeps every other field", () => {
		const root = tempDir();
		writeFileSync(
			join(root, "settings.json"),
			JSON.stringify({
				customNote: "keep",
				theme: "light",
				defaultThinkingLevel: "high",
				models: { chat: "deepseek-v4-1-flash", fallback: ["a"] },
				router: { classifier: "jev", jev: { model: "jev-latest" } },
			}),
		);
		saveSetupDefaults(root, {
			model: { kind: "auto", mode: "low" },
			thinking: undefined,
			permissions: "auto",
			theme: undefined,
		});
		const saved = JSON.parse(readFileSync(join(root, "settings.json"), "utf8"));
		expect(saved).toEqual({
			customNote: "keep",
			theme: "light",
			models: { chat: "deepseek-v4-1-flash", fallback: ["a"], code: "auto:low" },
			router: { classifier: "jev", jev: { model: "jev-latest" }, mode: "low" },
			permissions: { mode: "auto" },
		});
		expect(statSync(join(root, "settings.json")).mode & 0o777).toBe(0o600);

		saveSetupDefaults(root, {
			model: { kind: "manual", id: "glm-5-3-flash" },
			thinking: "minimal",
			permissions: "read-write",
			theme: "dark",
		});
		const again = JSON.parse(readFileSync(join(root, "settings.json"), "utf8"));
		expect(again.models.code).toBe("glm-5-3-flash");
		expect(again.router.mode).toBe("low");
		expect(again.defaultThinkingLevel).toBe("minimal");
		expect(again.permissions).toEqual({ mode: "read-write" });
		expect(again.theme).toBe("dark");
		expect(loadStoredSetupDefaults(root)).toEqual({
			model: { kind: "manual", id: "glm-5-3-flash" },
			thinking: "minimal",
			permissions: "read-write",
			theme: "dark",
			routerMode: "low",
		});
	});

	it("uses the permissions.mode setting that /permissions and startup read", () => {
		const root = tempDir();
		writeFileSync(join(root, "settings.json"), JSON.stringify({ permissions: "ask" }));
		// A bare string from pre-release setup builds is read, then replaced by the object form.
		expect(loadStoredSetupDefaults(root).permissions).toBe("ask");
		saveSetupDefaults(root, {
			model: { kind: "auto", mode: "medium" },
			thinking: undefined,
			permissions: "allow-all",
			theme: undefined,
		});
		expect(JSON.parse(readFileSync(join(root, "settings.json"), "utf8")).permissions).toEqual({ mode: "allow-all" });
		const manager = SettingsManager.create(tempDir(), root);
		expect(manager.getPermissionMode()).toBe("allow-all");
		expect(Compile(SettingsSchema).Check(JSON.parse(readFileSync(join(root, "settings.json"), "utf8")))).toBe(true);
		for (const mode of PERMISSION_MODES) expect(parsePermissionMode(mode)).toBe(mode);
		expect(PERMISSION_LABELS["read-write"]).toBe(permissionModeInfo("read-write").label);
	});

	it("creates the agent dir and reads invalid or missing values as unset", () => {
		const root = join(tempDir(), "nested", "agent");
		expect(loadStoredSetupDefaults(root)).toEqual({});
		saveSetupDefaults(root, {
			model: { kind: "auto", mode: "medium" },
			thinking: "max",
			permissions: "ask",
			theme: "system",
		});
		expect(loadStoredSetupDefaults(root).model).toEqual({ kind: "auto", mode: "medium" });
		writeFileSync(
			join(root, "settings.json"),
			JSON.stringify({ permissions: "yolo", defaultThinkingLevel: "huge", models: { code: 3 } }),
		);
		expect(loadStoredSetupDefaults(root)).toEqual({
			model: undefined,
			thinking: undefined,
			permissions: undefined,
			theme: undefined,
			routerMode: undefined,
		});
		writeFileSync(join(root, "settings.json"), "{ not json");
		expect(loadStoredSetupDefaults(root)).toEqual({});
		expect(() =>
			saveSetupDefaults(root, {
				model: { kind: "auto", mode: "medium" },
				thinking: undefined,
				permissions: "ask",
				theme: undefined,
			}),
		).toThrow("could not read settings.json");
	});
});

describe("setup display", () => {
	it("is fullscreen on a terminal, inline on a dumb one or on request, and absent without a TTY", () => {
		expect(chooseSetupDisplay({ stdinIsTTY: true, stdoutIsTTY: true, env: { TERM: "xterm-256color" } })).toBe(
			"fullscreen",
		);
		expect(chooseSetupDisplay({ stdinIsTTY: true, stdoutIsTTY: true, env: { TERM: "dumb" } })).toBe("inline");
		expect(chooseSetupDisplay({ stdinIsTTY: true, stdoutIsTTY: true, env: { RUNKILN_SETUP_INLINE: "1" } })).toBe(
			"inline",
		);
		expect(chooseSetupDisplay({ stdinIsTTY: true, stdoutIsTTY: true, env: { RUNKILN_SETUP_INLINE: "0" } })).toBe(
			"fullscreen",
		);
		expect(chooseSetupDisplay({ stdinIsTTY: false, stdoutIsTTY: true, env: {} })).toBeUndefined();
		expect(chooseSetupDisplay({ stdinIsTTY: true, stdoutIsTTY: false, env: {} })).toBeUndefined();
	});
});

/** Records everything written; feeds input like a terminal would. */
class RecordingTerminal implements Terminal {
	output = "";
	private onInput?: (data: string) => void;
	private onResize?: () => void;
	columns = 100;
	rows = 30;
	readonly kittyProtocolActive = false;
	start(onInput: (data: string) => void, onResize: () => void): void {
		this.onInput = onInput;
		this.onResize = onResize;
	}
	stop(): void {
		this.onInput = undefined;
	}
	async drainInput(): Promise<void> {}
	write(data: string): void {
		this.output += data;
	}
	moveBy(): void {}
	hideCursor(): void {
		this.output += "\x1b[?25l";
	}
	showCursor(): void {
		this.output += "\x1b[?25h";
	}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(): void {}
	setProgress(): void {}
	setProgramStatus(): void {}
	send(data: string): void {
		this.onInput?.(data);
	}
	resize(columns: number, rows: number): void {
		this.columns = columns;
		this.rows = rows;
		this.onResize?.();
	}
}

describe("fullscreen setup host", () => {
	beforeAll(() => initTheme("dark"));

	const ENTER_ALT = "\x1b[?1049h";
	const EXIT_ALT = "\x1b[?1049l";

	function start(terminal: RecordingTerminal) {
		const root = tempDir();
		const settingsManager = SettingsManager.inMemory();
		const result = runSetup({
			settingsManager,
			agentDir: root,
			display: "fullscreen",
			initializeTerminal: false,
			terminal,
			wizard: { env: {}, baseUrl: "https://api.runinfra.example/v1", themes: ["dark"], spinnerIntervalMs: 0 },
		});
		return { root, result };
	}

	it("enters the alternate screen, and on ctrl+c ctrl+c leaves it with the cursor back and nothing saved", async () => {
		const sigterm = process.listenerCount("SIGTERM");
		const exit = process.listenerCount("exit");
		const terminal = new RecordingTerminal();
		const { root, result } = start(terminal);
		expect(terminal.output).toContain(ENTER_ALT);
		expect(process.listenerCount("SIGTERM")).toBe(sigterm + 1);
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(terminal.output).toContain("Welcome to RunKiln");
		terminal.resize(70, 20);
		await new Promise((resolve) => setTimeout(resolve, 30));
		terminal.send("\x03");
		terminal.send("\x03");
		await expect(result).resolves.toBeUndefined();
		const exitAt = terminal.output.lastIndexOf(EXIT_ALT);
		expect(exitAt).toBeGreaterThan(terminal.output.lastIndexOf(ENTER_ALT));
		expect(terminal.output.slice(exitAt)).toContain("\x1b[?25h");
		expect(process.listenerCount("SIGTERM")).toBe(sigterm);
		expect(process.listenerCount("exit")).toBe(exit);
		expect(() => readFileSync(join(root, "settings.json"))).toThrow();
	});

	it("restores the terminal when the process is signalled mid-setup", async () => {
		const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
		const terminal = new RecordingTerminal();
		start(terminal);
		await new Promise((resolve) => setTimeout(resolve, 20));
		process.emit("SIGTERM", "SIGTERM");
		expect(terminal.output.lastIndexOf(EXIT_ALT)).toBeGreaterThan(terminal.output.lastIndexOf(ENTER_ALT));
		expect(exitSpy).toHaveBeenCalledWith(143);
		// Quit the wizard so its listeners go away.
		terminal.send("\x03");
		terminal.send("\x03");
	});
});
