/**
 * Input-area UX: persistent prompt history (scopes, cap and rotation, secret skipping), the key-hint
 * row, the `?` shortcut sheet, the stash key, the `ui.hints` setting, and image stash support.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setKeybindings, visibleWidth } from "@runkiln/tui";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { KEYBINDINGS, KeybindingsManager } from "../../src/core/keybindings.ts";
import { formatAge, looksLikeSecret, PromptHistoryStore } from "../../src/core/prompt-history.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { CustomEditor } from "../../src/modes/interactive/components/custom-editor.ts";
import {
	formatKeyHints,
	KEY_HINT_MIN_ROWS,
	KeyHintRow,
	selectKeyHints,
} from "../../src/modes/interactive/components/key-hint-row.ts";
import {
	buildShortcutRows,
	optionAsMetaWarning,
	ShortcutSheet,
} from "../../src/modes/interactive/components/shortcut-sheet.ts";
import { ImageAttachments } from "../../src/modes/interactive/image-attachments.ts";
import { getEditorTheme, initTheme } from "../../src/modes/interactive/theme/theme.ts";

const dirs: string[] = [];
function tempFile(): string {
	const dir = mkdtempSync(join(tmpdir(), "rk-history-"));
	dirs.push(dir);
	return join(dir, "history.jsonl");
}

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

beforeAll(() => {
	initTheme("dark");
	setKeybindings(KeybindingsManager.create(mkdtempSync(join(tmpdir(), "rk-keys-"))));
});

describe("PromptHistoryStore", () => {
	it("appends JSONL with ts, cwd, sessionId and text, and survives a restart", () => {
		const path = tempFile();
		let clock = 1000;
		const store = new PromptHistoryStore({ path, now: () => clock++ });
		expect(store.append("fix the failing test", "/work/api", "s1")).toBe(true);
		expect(store.append("  explain the router  ", "/work/api", "s1")).toBe(true);
		const lines = readFileSync(path, "utf-8").trim().split("\n");
		expect(JSON.parse(lines[0]!)).toEqual({
			ts: 1000,
			cwd: "/work/api",
			sessionId: "s1",
			text: "fix the failing test",
		});
		const reopened = new PromptHistoryStore({ path });
		expect(reopened.recentForCwd("/work/api")).toEqual(["explain the router", "fix the failing test"]);
		expect(statSync(path).mode & 0o777).toBe(0o600);
	});

	it("scopes: session, project (folder) and all, newest first without repeats", () => {
		const store = new PromptHistoryStore({ path: tempFile() });
		store.append("a", "/p1", "s1");
		store.append("b", "/p1", "s2");
		store.append("c", "/p2", "s3");
		store.append("a", "/p1", "s2");
		const texts = (scope: "session" | "project" | "all") =>
			store.query(scope, { cwd: "/p1", sessionId: "s2" }).map((entry) => entry.text);
		expect(texts("session")).toEqual(["a", "b"]);
		expect(texts("project")).toEqual(["a", "b"]);
		expect(texts("all")).toEqual(["a", "c", "b"]);
		expect(store.query("session", { cwd: "/p1" })).toEqual([]);
	});

	it("loads the last 100 prompts for the folder only", () => {
		const store = new PromptHistoryStore({ path: tempFile() });
		for (let i = 0; i < 150; i++) store.append(`prompt ${i}`, i % 2 ? "/a" : "/b");
		const recent = store.recentForCwd("/a");
		expect(recent).toHaveLength(75);
		expect(recent[0]).toBe("prompt 149");
		expect(store.recentForCwd("/a", 10)).toHaveLength(10);
	});

	it("rotates to the newest maxLines once the file passes rotateAt", () => {
		const path = tempFile();
		const store = new PromptHistoryStore({ path, maxLines: 50, rotateAt: 60 });
		for (let i = 0; i < 61; i++) store.append(`p${i}`, "/w");
		const lines = readFileSync(path, "utf-8").trim().split("\n");
		expect(lines).toHaveLength(50);
		expect(JSON.parse(lines.at(-1)!).text).toBe("p60");
		expect(existsSync(`${path}.${process.pid}.tmp`)).toBe(false);
	});

	it("trims an oversized file on load and ignores corrupt lines", () => {
		const path = tempFile();
		const good = Array.from({ length: 30 }, (_, i) => JSON.stringify({ ts: i, cwd: "/w", text: `t${i}` }));
		writeFileSync(path, `${good.join("\n")}\nnot json\n{"ts":1}\n`);
		const store = new PromptHistoryStore({ path, maxLines: 10, rotateAt: 20 });
		expect(store.recentForCwd("/w", 100)).toEqual(Array.from({ length: 10 }, (_, i) => `t${29 - i}`));
		expect(readFileSync(path, "utf-8").trim().split("\n")).toHaveLength(10);
	});

	it("never saves prompts that look like secrets, or empty and huge ones", () => {
		const path = tempFile();
		const store = new PromptHistoryStore({ path });
		const skipped = [
			"use sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123",
			"my token is ghp_abcdefghijklmnopqrstuvwxyz0123456789",
			"export AWS_ACCESS_KEY_ID=AKIAABCDEFGHIJKLMNOP",
			"password: hunter2hunter2",
			"curl -H 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456'",
			"-----BEGIN OPENSSH PRIVATE KEY-----",
			"connect to postgres://admin:s3cretpass@db:5432/app",
			"   ",
			"x".repeat(10_001),
		];
		for (const text of skipped) expect(store.append(text, "/w")).toBe(false);
		expect(existsSync(path)).toBe(false);
		for (const text of [
			"rename the token parser",
			"fix auth: handleLoginFlow",
			"set password field to type=password",
		]) {
			expect(looksLikeSecret(text)).toBe(false);
		}
	});

	it("formats ages compactly", () => {
		const now = 10 * 86_400_000;
		expect(formatAge(now - 5_000, now)).toBe("now");
		expect(formatAge(now - 5 * 60_000, now)).toBe("5m");
		expect(formatAge(now - 3 * 3_600_000, now)).toBe("3h");
		expect(formatAge(now - 3 * 86_400_000, now)).toBe("3d");
		expect(formatAge(now - 30 * 86_400_000, now)).toBe("4w");
	});
});

describe("key-hint row", () => {
	const lookup = (id: string) => (KEYBINDINGS as Record<string, { defaultKeys: string | string[] }>)[id]?.defaultKeys;
	const key = (id: string) => {
		const keys = lookup(id);
		return Array.isArray(keys) ? keys.join("/") : (keys ?? "");
	};

	it("picks 3–5 hints per state", () => {
		const states = [
			{ mode: "idle" },
			{ mode: "idle", stashed: true },
			{ mode: "draft" },
			{ mode: "streaming", queued: true },
			{ mode: "approval" },
			{ mode: "approval", approvalKind: "plan" },
			{ mode: "selection" },
			{ mode: "autocomplete" },
			{ mode: "history-search" },
			{ mode: "chip", chipKind: "paste", pasteOpensEditor: true },
			{ mode: "chip", chipKind: "image" },
			{ mode: "image" },
		] as const;
		for (const state of states) {
			const hints = selectKeyHints(state, key);
			expect(hints.length, state.mode).toBeGreaterThanOrEqual(3);
			expect(hints.length, state.mode).toBeLessThanOrEqual(5);
		}
	});

	it("names the keys that matter in each state", () => {
		const labels = (state: Parameters<typeof selectKeyHints>[0]) =>
			selectKeyHints(state, key).map((hint) => `${hint.key} ${hint.label}`);
		expect(labels({ mode: "idle" })).toEqual(["/ commands", "@ files", "ctrl+r history", "? shortcuts"]);
		expect(labels({ mode: "streaming" })[0]).toBe("esc interrupt");
		// Same letters as the open prompt: permission-prompt.ts and plan-approval.ts.
		expect(labels({ mode: "approval" })).toEqual([
			"↑↓ choose",
			"enter confirm",
			"y allow",
			"f feedback",
			"n/esc deny",
		]);
		expect(labels({ mode: "approval", approvalKind: "plan" })).toEqual([
			"y approve",
			"e edit plan",
			"r keep planning",
			"d discard",
			"esc close",
		]);
		expect(labels({ mode: "streaming", queued: true })).toContain("alt+up edit queue");
		expect(labels({ mode: "chip", chipKind: "paste", pasteOpensEditor: false })[0]).toBe("enter expand paste");
		expect(labels({ mode: "idle", stashed: true })[0]).toMatch(/^ctrl\+[qs] restore draft$/);
	});

	it("drops trailing hints instead of cutting one, and hides on short terminals or when off", () => {
		const hints = selectKeyHints({ mode: "streaming", queued: true }, key);
		const wide = formatKeyHints(hints, 120, false);
		const narrow = formatKeyHints(hints, 40, false);
		expect(wide.split(" - ")).toHaveLength(5);
		expect(visibleWidth(narrow)).toBeLessThanOrEqual(39);
		expect(narrow.split(" - ").length).toBeLessThan(5);
		expect(formatKeyHints(hints, 5, false)).toBe("");

		let rows = 30;
		let enabled = true;
		const row = new KeyHintRow({ getState: () => ({ mode: "idle" }), getRows: () => rows, isEnabled: () => enabled });
		expect(row.render(80)).toHaveLength(1);
		expect(visibleWidth(row.render(80)[0]!)).toBeLessThanOrEqual(80);
		rows = KEY_HINT_MIN_ROWS - 1;
		expect(row.render(80)).toEqual([]);
		rows = 30;
		enabled = false;
		expect(row.render(80)).toEqual([]);
	});
});

describe("? shortcut sheet", () => {
	it("is built from the keybinding descriptions, grouped, without selector-only keys", () => {
		const rows = buildShortcutRows();
		const groups = [...new Set(rows.map((row) => row.group))];
		expect(groups.slice(0, 4)).toEqual(["Prompt", "Agent", "Models & modes", "Session"]);
		const descriptions = rows.map((row) => row.description);
		expect(descriptions).toContain("Search prompt history (again: older match)");
		expect(descriptions).toContain("Queue follow-up message");
		expect(descriptions).not.toContain("Save model selection");
		expect(rows.find((row) => row.keys.endsWith("+r") && row.group === "Models & modes")?.alt).toBe(true);
	});

	it("warns about Option-as-Meta on macOS without the kitty protocol, naming the terminal's setting", () => {
		expect(
			optionAsMetaWarning({ platform: "darwin", env: { TERM_PROGRAM: "Apple_Terminal" }, enhancedKeys: false }),
		).toMatch(/Use Option as Meta key/);
		expect(
			optionAsMetaWarning({ platform: "darwin", env: { TERM_PROGRAM: "iTerm.app" }, enhancedKeys: false }),
		).toMatch(/Esc\+/);
		expect(optionAsMetaWarning({ platform: "darwin", env: {}, enhancedKeys: true })).toBeUndefined();
		expect(optionAsMetaWarning({ platform: "linux", env: {}, enhancedKeys: false })).toBeUndefined();
	});

	it("filters as you type, scrolls, fits the width and closes on Esc or ?", () => {
		let closed = 0;
		const sheet = new ShortcutSheet({
			rows: buildShortcutRows(),
			warning: "Option (Alt) shortcuts marked * need Option as Meta.",
			onClose: () => closed++,
			maxVisible: 8,
		});
		for (const width of [60, 80, 100]) {
			const lines = sheet.render(width);
			for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
		for (const char of "routing") sheet.handleInput(char);
		expect(sheet.render(80).join("\n")).toMatch(/alt\+r\*|option\+r\*/);
		for (let i = 0; i < 7; i++) sheet.handleInput("\x7f");
		for (const char of "stash") sheet.handleInput(char);
		const filtered = sheet.getLines(76).join("\n");
		expect(filtered).toMatch(/Stash the draft/);
		expect(filtered).not.toMatch(/Queue follow-up/);
		sheet.handleInput("?"); // a literal ? while filtering
		expect(closed).toBe(0);
		sheet.handleInput("\x1b");
		expect(closed).toBe(1);
	});
});

describe("stash key and settings", () => {
	it("binds the stash key without clashing with other prompt keys", () => {
		const manager = KeybindingsManager.create(mkdtempSync(join(tmpdir(), "rk-keys-")));
		const stash = manager.getKeys("app.editor.stash");
		expect(stash).toHaveLength(1);
		const promptIds = [
			...Object.keys(KEYBINDINGS).filter(
				(id) => id.startsWith("tui.editor.") || id.startsWith("tui.input.") || id.startsWith("app."),
			),
		].filter(
			(id) =>
				id !== "app.editor.stash" &&
				!/^app\.(session\.(togglePath|toggleSort|rename|delete|deleteNoninvasive|toggleNamedFilter)|models\.|tree\.|thinking\.save)/.test(
					id,
				),
		);
		for (const id of promptIds) {
			expect(manager.getKeys(id as never), id).not.toContain(stash[0]);
		}
		expect(manager.getKeys("tui.editor.historySearch")).toEqual(["ctrl+r"]);
	});

	it("ui.hints defaults to on and can be turned off", () => {
		const settings = SettingsManager.inMemory({});
		expect(settings.getUiHints()).toBe(true);
		settings.setUiHints(false);
		expect(settings.getUiHints()).toBe(false);
		expect(SettingsManager.inMemory({ ui: { hints: false } }).getUiHints()).toBe(false);
	});

	it("takes stashed images out of the attachments so a send does not clear them", () => {
		const attachments = new ImageAttachments();
		const prepared = {
			image: { type: "image" as const, data: "AA==", mimeType: "image/png" },
			bytes: 1,
			label: "1 B",
		};
		const first = attachments.add(prepared);
		const second = attachments.add(prepared);
		const taken = attachments.take([first.id, 99]);
		expect(taken.map((item) => item.id)).toEqual([first.id]);
		expect(attachments.size).toBe(1);
		expect(attachments.get(second.id)).toBeDefined();
		attachments.clear();
		const again = attachments.add(taken[0]!);
		expect(again.id).toBe(1);
	});
});

describe("prompt editor keys", () => {
	function makeEditor() {
		const keybindings = KeybindingsManager.create(mkdtempSync(join(tmpdir(), "rk-keys-")));
		setKeybindings(keybindings);
		const tui = { terminal: { rows: 24, columns: 80 }, requestRender() {} };
		const editor = new CustomEditor(tui as never, getEditorTheme(), keybindings);
		const calls: string[] = [];
		editor.onShowShortcuts = () => calls.push("sheet");
		editor.onHistorySearch = () => calls.push("history");
		editor.onAction("app.editor.stash", () => calls.push("stash"));
		return { editor, calls, keybindings };
	}

	it("? on an empty prompt opens the sheet; mid-text it is a literal ?", () => {
		const { editor, calls } = makeEditor();
		editor.handleInput("?");
		expect(calls).toEqual(["sheet"]);
		expect(editor.getText()).toBe("");
		editor.handleInput("w");
		editor.handleInput("?");
		expect(editor.getText()).toBe("w?");
		expect(calls).toEqual(["sheet"]);
	});

	it("Ctrl+R opens history search and the stash key reaches its action", () => {
		const { editor, calls, keybindings } = makeEditor();
		editor.handleInput("\x12");
		const stashKey = keybindings.getKeys("app.editor.stash")[0];
		editor.handleInput(stashKey === "ctrl+s" ? "\x13" : "\x11");
		expect(calls).toEqual(["history", "stash"]);
	});
});
