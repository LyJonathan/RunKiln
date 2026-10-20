import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setKeybindings, type TUI, type TuiMouseEvent } from "@runkiln/tui";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../../src/core/keybindings.ts";
import type { ApprovalAnswer, PermissionPrompt } from "../../src/core/runkiln/permissions.ts";
import { editRenderers } from "../../src/core/tools/renderers/edit.ts";
import {
	nativeSelectionHint,
	pointerShapesSupported,
	resolvePointerShapes,
} from "../../src/modes/interactive/click-actions.ts";
import { ContextMenu } from "../../src/modes/interactive/components/context-menu.ts";
import { FooterComponent } from "../../src/modes/interactive/components/footer.ts";
import { PermissionPromptComponent } from "../../src/modes/interactive/components/permission-prompt.ts";
import { PlanApprovalComponent } from "../../src/modes/interactive/components/plan-approval.ts";
import { type CardActionHost, ToolExecutionComponent } from "../../src/modes/interactive/components/tool-execution.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";
import { primarySelectionCommands } from "../../src/utils/clipboard.ts";
import {
	editorUrl,
	formatFileLocation,
	parseFileLocation,
	planEditorOpen,
	resolveAutoPreset,
	splitCommandLine,
	windowsCmdInvocation,
} from "../../src/utils/editor-open.ts";
import { openerCandidates } from "../../src/utils/open-browser.ts";
import { footerStandIns } from "./footer-fixtures.ts";

const strip = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, "");

function mouse(type: TuiMouseEvent["type"], x: number, y: number, extra: Partial<TuiMouseEvent> = {}): TuiMouseEvent {
	return {
		type,
		button: type === "move" || type === "leave" || type === "wheel" ? "none" : "left",
		x,
		y,
		screenX: x,
		screenY: y,
		width: 80,
		height: 30,
		shift: false,
		alt: false,
		ctrl: false,
		...extra,
	};
}

const linux = { platform: "linux" as const, env: {} };
const win = { platform: "win32" as const, env: {} };

describe("parseFileLocation", () => {
	it("reads path:line:col, path(line,col), #L and file URLs", () => {
		expect(parseFileLocation("src/a.ts:42:7", "/repo", "linux")).toEqual({
			file: "/repo/src/a.ts",
			line: 42,
			col: 7,
		});
		expect(parseFileLocation("src/a.ts:42", "/repo", "linux")).toEqual({ file: "/repo/src/a.ts", line: 42 });
		expect(parseFileLocation("src/a.ts(9,3)", "/repo", "linux")).toEqual({ file: "/repo/src/a.ts", line: 9, col: 3 });
		expect(parseFileLocation("/abs/b.md#L12", "/repo", "linux")).toEqual({ file: "/abs/b.md", line: 12 });
		expect(parseFileLocation("file:///abs/c%20d.ts#L5C2", "/repo", "linux")).toEqual({
			file: "/abs/c d.ts",
			line: 5,
			col: 2,
		});
		expect(parseFileLocation("README.md", "/repo", "linux")).toEqual({ file: "/repo/README.md" });
		expect(parseFileLocation("  ", "/repo", "linux")).toBeUndefined();
	});

	it("keeps Windows drive letters and spaces", () => {
		expect(parseFileLocation("C:\\Users\\John Ly\\My Proj\\a b.ts:12:4", "C:\\x", "win32")).toEqual({
			file: "C:\\Users\\John Ly\\My Proj\\a b.ts",
			line: 12,
			col: 4,
		});
		expect(parseFileLocation("C:\\only\\file.ts", "C:\\x", "win32")).toEqual({ file: "C:\\only\\file.ts" });
		expect(parseFileLocation("src\\b.ts:3", "C:\\Repo Dir", "win32")).toEqual({
			file: "C:\\Repo Dir\\src\\b.ts",
			line: 3,
		});
		expect(parseFileLocation("file:///C:/Users/John%20Ly/a.ts#L8", "C:\\x", "win32")).toEqual({
			file: "C:\\Users\\John Ly\\a.ts",
			line: 8,
		});
	});

	it("formats relative to cwd for toasts", () => {
		expect(formatFileLocation({ file: "/repo/src/a.ts", line: 3 }, "/repo")).toBe("src/a.ts:3");
		expect(formatFileLocation({ file: "/other/a.ts", line: 3, col: 1 }, "/repo")).toBe("/other/a.ts:3:1");
	});
});

describe("planEditorOpen", () => {
	const location = { file: "/repo/src/a.ts", line: 42, col: 7 };

	it("builds the preset commands", () => {
		expect(planEditorOpen("vscode", location, linux)).toMatchObject({
			kind: "spawn",
			command: "code",
			args: ["-g", "/repo/src/a.ts:42:7"],
			label: "VS Code",
		});
		expect(planEditorOpen("cursor", location, linux)).toMatchObject({
			command: "cursor",
			args: ["-g", "/repo/src/a.ts:42:7"],
		});
		expect(planEditorOpen("zed", location, linux)).toMatchObject({ command: "zed", args: ["/repo/src/a.ts:42:7"] });
		expect(planEditorOpen("subl", location, linux)).toMatchObject({ command: "subl", args: ["/repo/src/a.ts:42:7"] });
		expect(planEditorOpen("idea", location, linux)).toMatchObject({
			command: "idea",
			args: ["--line", "42", "--column", "7", "/repo/src/a.ts"],
		});
		expect(planEditorOpen("nvim", location, linux)).toMatchObject({
			command: "nvim",
			args: ["+42", "/repo/src/a.ts"],
			terminal: true,
		});
		expect(planEditorOpen("system", location, linux)).toEqual({
			kind: "open",
			target: "/repo/src/a.ts",
			label: "the default app",
		});
	});

	it("talks to the surrounding Neovim when $NVIM is set", () => {
		const plan = planEditorOpen(
			"nvim",
			{ file: "/repo/a b.ts", line: 3 },
			{ platform: "linux", env: { NVIM: "/tmp/nvim.sock" } },
		);
		expect(plan).toMatchObject({
			kind: "spawn",
			command: "nvim",
			args: ["--server", "/tmp/nvim.sock", "--remote-send", "<C-\\><C-N>:edit +3 /repo/a\\ b.ts<CR>"],
		});
		expect(plan).not.toHaveProperty("terminal");
	});

	it("uses editor URLs on Windows, with spaces encoded", () => {
		const spaced = { file: "C:\\Users\\John Ly\\My Proj\\a b.ts", line: 12, col: 4 };
		expect(planEditorOpen("vscode", spaced, win)).toEqual({
			kind: "open",
			target: "vscode://file/C:/Users/John%20Ly/My%20Proj/a%20b.ts:12:4",
			label: "VS Code",
		});
		expect(planEditorOpen("cursor", spaced, win)).toMatchObject({
			target: "cursor://file/C:/Users/John%20Ly/My%20Proj/a%20b.ts:12:4",
		});
		expect(planEditorOpen("idea", spaced, win)).toMatchObject({
			kind: "open",
			target: `idea://open?file=${encodeURIComponent(spaced.file)}&line=12`,
		});
		expect(editorUrl("vscode", { file: "/repo/a.ts" })).toBe("vscode://file/repo/a.ts");
	});

	it("fills a custom template per argument, so spaces stay inside one argument", () => {
		const spaced = { file: "C:\\Users\\John Ly\\a b.ts", line: 12 };
		expect(planEditorOpen('"C:\\Program Files\\Zed\\zed.exe" {file}:{line}', spaced, win)).toMatchObject({
			kind: "spawn",
			command: "C:\\Program Files\\Zed\\zed.exe",
			args: ["C:\\Users\\John Ly\\a b.ts:12"],
		});
		expect(planEditorOpen("hx {file}:{line}:{col}", { file: "/r/a.ts", line: 2 }, linux)).toMatchObject({
			command: "hx",
			args: ["/r/a.ts:2:1"],
			terminal: true,
		});
	});

	it("runs a Windows .cmd template through cmd.exe with quotes, and refuses metacharacters", () => {
		const spaced = { file: "C:\\Users\\John Ly\\a b.ts", line: 12 };
		expect(planEditorOpen("code.cmd -g {file}:{line}", spaced, win)).toMatchObject({
			kind: "spawn",
			command: "cmd.exe",
			args: ["/d", "/s", "/c", '""code.cmd" "-g" "C:\\Users\\John Ly\\a b.ts:12""'],
			windowsVerbatimArguments: true,
		});
		expect(planEditorOpen("code.cmd -g {file}", { file: "C:\\a&calc.ts" }, win)).toMatchObject({ kind: "copy" });
		expect(windowsCmdInvocation("x.cmd", ["100%"])).toBeUndefined();
	});

	it("copies instead over SSH and for network paths", () => {
		const ssh = { platform: "linux" as const, env: { SSH_CONNECTION: "1 2 3 4" } };
		expect(planEditorOpen("zed", location, ssh)).toEqual({
			kind: "copy",
			text: "/repo/src/a.ts:42:7",
			reason: "no local editor",
		});
		// VS Code's remote terminal opens files in the client window.
		expect(
			planEditorOpen("vscode", location, {
				platform: "linux",
				env: { SSH_CONNECTION: "1", TERM_PROGRAM: "vscode" },
			}),
		).toMatchObject({
			kind: "spawn",
			command: "code",
		});
		expect(planEditorOpen("vscode", { file: "\\\\server\\share\\a.ts", line: 1 }, win)).toMatchObject({
			kind: "copy",
		});
	});

	it("auto picks the editor RunKiln runs in, then $VISUAL/$EDITOR, then system", () => {
		expect(resolveAutoPreset({ TERM_PROGRAM: "vscode" })).toBe("vscode");
		expect(resolveAutoPreset({ TERM_PROGRAM: "vscode", CURSOR_TRACE_ID: "x" })).toBe("cursor");
		expect(resolveAutoPreset({ ZED_TERM: "true" })).toBe("zed");
		expect(resolveAutoPreset({ TERMINAL_EMULATOR: "JetBrains-JediTerm" })).toBe("idea");
		expect(resolveAutoPreset({ NVIM: "/tmp/s" })).toBe("nvim");
		expect(resolveAutoPreset({ EDITOR: "vim" })).toBe("editor");
		expect(resolveAutoPreset({ VISUAL: "code --wait" })).toBe("editor");
		expect(resolveAutoPreset({ EDITOR: "my-thing" })).toBe("system");
		expect(resolveAutoPreset({})).toBe("system");
		expect(planEditorOpen("auto", location, { platform: "linux", env: { VISUAL: "code --wait" } })).toMatchObject({
			command: "code",
			args: ["-g", "/repo/src/a.ts:42:7"],
		});
		expect(planEditorOpen("auto", location, { platform: "linux", env: { EDITOR: "nano" } })).toMatchObject({
			command: "nano",
			args: ["+42,7", "/repo/src/a.ts"],
			terminal: true,
		});
		expect(planEditorOpen("bogus", location, linux)).toMatchObject({ kind: "open" });
	});

	it("splits command lines with quotes", () => {
		expect(splitCommandLine(`a "b c" 'd e' f`)).toEqual(["a", "b c", "d e", "f"]);
		expect(splitCommandLine(`x ""`)).toEqual(["x", ""]);
	});
});

describe("openers and clipboard", () => {
	it("tries wslview, $BROWSER, xdg-open and gio on Linux", () => {
		expect(
			openerCandidates("https://x.dev", "linux", { BROWSER: "firefox" }, false).map(([command]) => command),
		).toEqual(["firefox", "xdg-open", "gio"]);
		expect(openerCandidates("/a.ts", "linux", { BROWSER: "firefox" }, true).map(([command]) => command)).toEqual([
			"wslview",
			"xdg-open",
			"gio",
		]);
		expect(openerCandidates("x", "darwin", {})).toEqual([["open", ["x"]]]);
		expect(openerCandidates("x", "win32", {})).toEqual([["rundll32", ["url.dll,FileProtocolHandler", "x"]]]);
	});

	it("writes PRIMARY with wl-copy or xclip/xsel", () => {
		expect(primarySelectionCommands({ WAYLAND_DISPLAY: "w" })).toEqual([["wl-copy", ["--primary"]]]);
		expect(primarySelectionCommands({ DISPLAY: ":0" })).toEqual([
			["xclip", ["-selection", "primary"]],
			["xsel", ["--primary", "--input"]],
		]);
		expect(primarySelectionCommands({})).toEqual([]);
	});

	it("sends pointer shapes only where supported, and names the selection modifier", () => {
		expect(pointerShapesSupported({ TERM_PROGRAM: "ghostty" })).toBe(true);
		expect(pointerShapesSupported({ KITTY_WINDOW_ID: "1" })).toBe(true);
		expect(pointerShapesSupported({ TERM_PROGRAM: "ghostty", TMUX: "/tmp/t" })).toBe(false);
		expect(pointerShapesSupported({ WT_SESSION: "x" })).toBe(false);
		expect(resolvePointerShapes("on", {})).toBe(true);
		expect(resolvePointerShapes("off", { KITTY_WINDOW_ID: "1" })).toBe(false);
		expect(nativeSelectionHint({ WT_SESSION: "x" })).toBe(
			"Hold Shift and drag to select with Windows Terminal instead",
		);
		expect(nativeSelectionHint({ TERM_PROGRAM: "iTerm.app" })).toContain("Option");
	});
});

describe("clickable prompts", () => {
	let keysDir: string;
	beforeAll(() => {
		initTheme("dark");
		keysDir = mkdtempSync(join(tmpdir(), "runkiln-click-keys-"));
		setKeybindings(KeybindingsManager.create(keysDir));
	});
	afterAll(() => rmSync(keysDir, { recursive: true, force: true }));

	const prompt: PermissionPrompt = {
		title: "Run a shell command",
		message: "npm test",
		mode: "read-write",
		risks: [],
		alwaysLabel: "Yes, and don't ask again for npm test (this session)",
		projectLabel: "Yes, and don't ask again in this project",
		timeoutMs: 0,
		timeoutAction: "deny",
	} as unknown as PermissionPrompt;

	it("picks an approval answer on click and highlights it on hover", () => {
		const answers: Array<ApprovalAnswer | undefined> = [];
		const component = new PermissionPromptComponent(prompt, (answer) => answers.push(answer));
		const lines = component.render(80).map(strip);
		const row = lines.findIndex((line) => line.includes("don't ask again in this project"));
		expect(row).toBeGreaterThan(0);
		const before = component.render(80)[row];
		expect(component.handleMouse(mouse("move", 10, row))).toMatchObject({
			handled: true,
			render: true,
			pointer: "pointer",
		});
		expect(component.render(80)[row]).not.toBe(before);
		expect(strip(component.render(80)[row]!)).toBe(lines[row]!.padEnd(80));
		component.handleMouse(mouse("press", 10, row));
		component.handleMouse(mouse("click", 10, row));
		expect(answers).toEqual([{ choice: "allow-project" }]);
	});

	it("moves the selection with the wheel and opens the feedback box on click", () => {
		const answers: Array<ApprovalAnswer | undefined> = [];
		const component = new PermissionPromptComponent(prompt, (answer) => answers.push(answer));
		component.handleMouse(mouse("wheel", 0, 0, { wheelDelta: 1 }));
		component.handleMouse(mouse("wheel", 0, 0, { wheelDelta: 1 }));
		const lines = component.render(80).map(strip);
		expect(lines.find((line) => line.includes("›"))).toContain("don't ask again in this project");
		const feedbackRow = lines.findIndex((line) => /^\s+›?\s*5\s/.test(line));
		component.handleMouse(mouse("click", 6, feedbackRow));
		const withBox = component.render(80).map(strip);
		expect(withBox.some((line) => line.includes("Tell the model what to do instead"))).toBe(true);
		const hintRow = withBox.findIndex((line) => line.includes("deny and send"));
		expect(withBox[hintRow]).toContain(" - ");
		// "back" closes the box again.
		const backColumn = withBox[hintRow]!.indexOf("back");
		component.handleMouse(mouse("click", backColumn, hintRow));
		expect(
			component
				.render(80)
				.map(strip)
				.some((line) => line.includes("Tell the model")),
		).toBe(false);
		expect(answers).toEqual([]);
	});

	it("wraps the key hints between hints, never inside one", () => {
		const component = new PermissionPromptComponent(prompt, () => {});
		for (const width of [60, 80, 100]) {
			const lines = component.render(width).map(strip);
			const start = lines.findIndex((line) => line.includes("pick"));
			const hintLines = lines.slice(start, -1).map((line) => line.trim());
			expect(hintLines.some((line) => line.endsWith("f feedback"))).toBe(true);
			for (const line of hintLines) expect(line.startsWith("- ") || line.endsWith(" -")).toBe(false);
			expect(hintLines.includes("feedback")).toBe(false);
		}
	});

	it("picks a plan answer on click", () => {
		const answers: unknown[] = [];
		const component = new PlanApprovalComponent({
			plan: "1. Do it",
			returnMode: "read-write",
			onAnswer: (answer) => answers.push(answer),
		});
		const lines = component.render(80).map(strip);
		const row = lines.findIndex((line) => line.includes("Discard the plan"));
		component.handleMouse(mouse("click", 8, row));
		expect(answers).toEqual([{ choice: "discard" }]);
	});

	it("context menu: hover, click and keys", () => {
		const picked: string[] = [];
		let closed = 0;
		const menu = new ContextMenu(
			"edit a.ts",
			[
				{ id: "open", label: "open", key: "o" },
				{ id: "revert", label: "revert file", key: "r", danger: true },
			],
			(item) => picked.push(item.id),
			() => closed++,
		);
		const lines = menu.render(menu.preferredWidth).map(strip);
		expect(lines[0]).toContain("edit a.ts");
		expect(lines[2]).toContain("revert file");
		expect(menu.handleMouse(mouse("move", 3, 2))).toMatchObject({ handled: true, pointer: "pointer" });
		// Off the items but inside the menu: swallowed.
		expect(menu.handleMouse(mouse("press", 0, 0))).toEqual({ handled: true });
		menu.handleMouse(mouse("click", 3, 2));
		expect(picked).toEqual(["revert"]);
		menu.handleInput("o");
		expect(picked).toEqual(["revert"]);
		const second = new ContextMenu(
			undefined,
			[{ id: "a", label: "a", key: "a" }],
			(item) => picked.push(item.id),
			() => closed++,
		);
		second.handleInput("a");
		const third = new ContextMenu(
			undefined,
			[{ id: "b", label: "b" }],
			() => {},
			() => closed++,
		);
		third.handleInput("\x1b");
		expect(picked).toEqual(["revert", "a"]);
		expect(closed).toBe(1);
	});
});

describe("clickable footer", () => {
	beforeAll(() => initTheme("dark"));

	it("maps every item to its action and underlines the hovered one", () => {
		const { session, footerData } = footerStandIns({ name: "x" });
		const footer = new FooterComponent(session, footerData, [
			"model",
			"context",
			"branch",
			"todo",
			"cost",
			"permissions",
		]);
		const actions: string[] = [];
		footer.onAction = (action) => actions.push(action);
		footer.onUsageClick = () => actions.push("usage");
		const line = strip(footer.render(100)[0]!);
		const at = (text: string) => line.indexOf(text) + 1;
		for (const target of ["deepseek", "4.3%", "main", "$0.0024", "read & write"]) {
			footer.handleMouse(mouse("click", at(target), 0));
		}
		expect(actions).toEqual(["model", "context", "branch", "usage", "permissions"]);
		expect(footer.handleMouse(mouse("move", at("main"), 0))).toMatchObject({ pointer: "pointer", render: true });
		expect(footer.render(100)[0]).toContain("\x1b[4m");
		expect(footer.handleMouse(mouse("leave", 0, 5))).toMatchObject({ render: true });
		expect(footer.render(100)[0]).not.toContain("\x1b[4m");
	});

	it("default layout: badge, branch, context and route are clickable", () => {
		const { session, footerData } = footerStandIns({ name: "x" });
		const footer = new FooterComponent(session, footerData);
		const actions: string[] = [];
		footer.onAction = (action) => actions.push(action);
		const lines = footer.render(100).map(strip);
		footer.handleMouse(mouse("click", lines[0]!.indexOf("(main)") + 1, 0));
		footer.handleMouse(mouse("click", lines[0]!.indexOf("read & write") + 1, 0));
		footer.handleMouse(mouse("click", lines[1]!.indexOf("4.3%") + 1, 1));
		footer.handleMouse(mouse("click", 98, 1));
		expect(actions).toEqual(["branch", "permissions", "context", "model"]);
	});
});

describe("tool card actions", () => {
	beforeAll(() => initTheme("dark"));

	const uiStub = { requestRender: () => {} } as unknown as TUI;
	const DIFF = ["-1 a", "+1 b"].join("\n");

	function card(): ToolExecutionComponent {
		const component = new ToolExecutionComponent(
			"edit",
			"call-1",
			{ path: "src/x.ts", edits: [{ oldText: "a", newText: "b" }] },
			{ outputPad: 1 },
			{ ...editRenderers, renderShell: "self" },
			uiStub,
			"/project",
		);
		component.updateResult({
			content: [{ type: "text", text: "ok" }],
			details: { diff: DIFF, firstChangedLine: 1 },
			isError: false,
		});
		return component;
	}

	function host(log: string[], rightClick: "menu" | "paste" = "menu"): CardActionHost {
		return {
			showStrip: () => true,
			rightClickOpensMenu: (event) => (rightClick === "menu" ? !event.shift : event.shift),
			actions: () => [
				{ id: "open", label: "open", strip: true },
				{ id: "diff", label: "diff", strip: true },
				{ id: "revert", label: "revert file" },
			],
			run: (_card, id) => log.push(`run ${id}`),
			openMenu: (_card, x, y) => log.push(`menu ${x},${y}`),
		};
	}

	afterAll(() => {
		ToolExecutionComponent.actionHost = undefined;
	});

	it("shows the strip on hover above the card and runs its actions", () => {
		const log: string[] = [];
		ToolExecutionComponent.actionHost = host(log);
		const component = card();
		expect(component.render(80)[0]).toBe("");
		const height = component.render(80).length;
		expect(component.handleMouse({ ...mouse("move", 5, 1), height })).toMatchObject({ handled: true, render: true });
		const strip0 = strip(component.render(80)[0]!);
		expect(strip0.trimStart()).toBe("open  diff  ⋯");
		expect(strip0).toHaveLength(79);
		component.handleMouse({ ...mouse("click", strip0.indexOf("diff") + 1, 0), height });
		component.handleMouse({ ...mouse("click", strip0.indexOf("⋯"), 0, { screenX: 70, screenY: 9 }), height });
		expect(log).toEqual(["run diff", "menu 70,9"]);
		expect(component.handleMouse({ ...mouse("leave", 0, 40), height })).toMatchObject({ render: true });
		expect(component.render(80)[0]).toBe("");
	});

	it("right click opens the menu, or falls through to paste mode unless Shift is held", () => {
		const log: string[] = [];
		ToolExecutionComponent.actionHost = host(log);
		const component = card();
		const height = component.render(80).length;
		expect(component.handleMouse({ ...mouse("press", 4, 2, { button: "right" }), height })).toEqual({
			handled: true,
		});
		component.handleMouse({ ...mouse("click", 4, 2, { button: "right", screenX: 4, screenY: 12 }), height });
		expect(log).toEqual(["menu 4,12"]);
		ToolExecutionComponent.actionHost = host(log, "paste");
		expect(component.handleMouse({ ...mouse("press", 4, 2, { button: "right" }), height })).toBeUndefined();
		expect(component.handleMouse({ ...mouse("press", 4, 2, { button: "right", shift: true }), height })).toEqual({
			handled: true,
		});
	});

	it("no host: no strip, no hover handling", () => {
		ToolExecutionComponent.actionHost = undefined;
		const component = card();
		expect(component.handleMouse(mouse("move", 5, 1))).toBeUndefined();
		expect(component.render(80)[0]).toBe("");
	});
});
