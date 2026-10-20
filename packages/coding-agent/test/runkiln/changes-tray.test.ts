import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visibleWidth } from "@runkiln/tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { KEYBINDINGS } from "../../src/core/keybindings.ts";
import { CheckpointStore } from "../../src/core/runkiln/checkpoints.ts";
import {
	computeHunks,
	countChanges,
	formatChangeCounts,
	keepHunk,
	revertHunk,
	type SessionChanges,
	type SessionFileChange,
	splitLines,
	totalChanges,
} from "../../src/core/runkiln/session-changes.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { BUILTIN_SLASH_COMMANDS } from "../../src/core/slash-commands.ts";
import {
	ChangesReviewScreen,
	type ChangesReviewSource,
	loadReviewFiles,
} from "../../src/modes/interactive/components/changes-review.ts";
import {
	ChangesTrayComponent,
	layoutTray,
	trayFileNames,
} from "../../src/modes/interactive/components/changes-tray.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";

const strip = (text: string) => text.replace(/\x1b\[[0-9;:]*[A-Za-z]/g, "").replace(/\x1b\]8;[^\x07]*\x07/g, "");
const BANNED = /[·•—]/;

const file = (path: string, added: number, removed: number): SessionFileChange => ({
	path,
	status: "modified",
	added,
	removed,
});

function changesOf(files: SessionFileChange[]): SessionChanges {
	return totalChanges(files);
}

describe("session change hunks", () => {
	const before = "a\nb\nc\nd\ne\nf\ng\nh\n";
	const after = "a\nB\nc\nd\ne\nf\nG\nG2\nh\ni\n";

	it("splits lines with their endings, byte for byte", () => {
		expect(splitLines("x\ny")).toEqual(["x\n", "y"]);
		expect(splitLines("x\r\ny\n").join("")).toBe("x\r\ny\n");
		expect(splitLines("")).toEqual([]);
	});

	it("finds each changed run and counts its lines", () => {
		const hunks = computeHunks(before, after);
		expect(hunks.map((h) => [h.oldStart, h.oldLines.length, h.newStart, h.newLines.length])).toEqual([
			[1, 1, 1, 1],
			[6, 1, 6, 2],
			[8, 0, 9, 1],
		]);
		expect(countChanges(before, after)).toEqual({ added: 4, removed: 2 });
	});

	it("reverting every hunk gives the old text; keeping every hunk gives the new one", () => {
		let reverted = after;
		for (const hunk of [...computeHunks(before, after)].reverse()) reverted = revertHunk(reverted, hunk);
		expect(reverted).toBe(before);
		let kept = before;
		for (const hunk of [...computeHunks(before, after)].reverse()) kept = keepHunk(kept, hunk);
		expect(kept).toBe(after);
	});

	it("reverting one hunk leaves the others", () => {
		const [, middle] = computeHunks(before, after);
		const result = revertHunk(after, middle!);
		expect(result).toBe("a\nB\nc\nd\ne\nf\ng\nh\ni\n");
		expect(computeHunks(before, result)).toHaveLength(2);
	});
});

describe("changes tray", () => {
	beforeAll(() => initTheme("dark"));

	const tray = (files: SessionFileChange[], hint: string | undefined = "alt+c review") => {
		const component = new ChangesTrayComponent({ hint: () => hint, onOpen: () => {} });
		component.setChanges(changesOf(files));
		return component;
	};

	it("is hidden when nothing changed", () => {
		expect(tray([]).render(80)).toEqual([]);
		expect(tray([]).visible).toBe(false);
	});

	it("shows one file with spaced counts, flush with both edges", () => {
		const [line] = tray([file("src/app.ts", 12, 3)]).render(80);
		const text = strip(line!);
		expect(text.startsWith("1 file  +12 -3   app.ts  +12 -3")).toBe(true);
		expect(text.endsWith("alt+c review")).toBe(true);
		expect(visibleWidth(line!)).toBe(80);
		expect(text).not.toMatch(BANNED);
	});

	it("truncates many files with +N more at 80 columns", () => {
		const files = Array.from({ length: 12 }, (_, i) => file(`src/module-${i}.ts`, i + 1, i));
		const [line] = tray(files).render(80);
		const text = strip(line!);
		expect(visibleWidth(line!)).toBe(80);
		expect(text).toMatch(/^12 files {2}\+78 -66 {3}module-0\.ts {2}\+1 -0/);
		const more = text.match(/\+(\d+) more/);
		expect(more).not.toBeNull();
		const shown = (text.match(/module-\d+\.ts/g) ?? []).length;
		expect(shown + Number(more![1])).toBe(12);
		expect(text).toMatch(/ {3}\+\d+ more {3,}alt\+c review$/);
	});

	it("drops the hint before the summary when the row is narrow", () => {
		const files = [file("a.ts", 1, 1), file("b.ts", 2, 2)];
		const layout = layoutTray(changesOf(files), 20, "alt+c review");
		expect(layout.hint).toBe(false);
		const [line] = tray(files).render(20);
		expect(visibleWidth(line!)).toBeLessThanOrEqual(20);
		expect(strip(line!).startsWith("2 files  +3 -3")).toBe(true);
	});

	it("tray counts are the totals of the file counts", () => {
		const files = [file("a.ts", 5, 1), file("b.ts", 7, 2), file("c.ts", 0, 4)];
		expect(formatChangeCounts(changesOf(files))).toBe("3 files  +12 -7");
	});

	it("uses the full path when two files share a base name", () => {
		expect(trayFileNames([file("a/index.ts", 1, 0), file("b/index.ts", 1, 0), file("c/x.ts", 1, 0)])).toEqual([
			"a/index.ts",
			"b/index.ts",
			"x.ts",
		]);
	});

	it("a click opens the review at the clicked file", () => {
		let opened: string | undefined | null = null;
		const component = new ChangesTrayComponent({
			hint: () => undefined,
			onOpen: (path) => {
				opened = path;
			},
		});
		component.setChanges(changesOf([file("src/app.ts", 1, 0)]));
		const line = strip(component.render(80)[0]!);
		const x = line.indexOf("app.ts");
		const event = { button: "left", y: 0, screenX: x, screenY: 0, width: 80, height: 1, shift: false, alt: false };
		component.handleMouse({ ...event, type: "press", x } as never);
		component.handleMouse({ ...event, type: "release", x } as never);
		component.handleMouse({ ...event, type: "click", x } as never);
		expect(opened).toBe("src/app.ts");
	});

	it("turns off with display.changesTray", () => {
		expect(SettingsManager.inMemory({}).getDisplaySettings().changesTray).toBe(true);
		const settings = SettingsManager.inMemory({ display: { changesTray: false } });
		expect(settings.getDisplaySettings().changesTray).toBe(false);
		const component = tray([file("a.ts", 1, 0)]);
		component.setEnabled(settings.getDisplaySettings().changesTray);
		expect(component.visible).toBe(false);
		expect(component.render(80)).toEqual([]);
	});

	it("has a key and the /diff command", () => {
		expect(KEYBINDINGS["app.changes.review"].defaultKeys).toBe("alt+c");
		expect(BUILTIN_SLASH_COMMANDS.find((command) => command.name === "diff")?.description).toMatch(/session/);
	});
});

describe("session changes on the checkpoints", () => {
	let root: string;
	let project: string;
	let clock: number;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "runkiln-tray-"));
		project = join(root, "project");
		mkdirSync(project, { recursive: true });
		clock = Date.now();
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	const makeStore = (git?: false) =>
		new CheckpointStore({
			rootDir: join(root, "checkpoints"),
			sessionId: "s1",
			cwd: project,
			now: () => clock++,
			...(git === false ? { git: false as const } : {}),
		});

	function initRepo() {
		const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1" };
		execFileSync("git", ["init", "-q", "-b", "main"], { cwd: project, env });
	}

	async function turn(
		store: CheckpointStore,
		entry: string,
		changes: Array<[string, string | undefined, "edit" | "bash"]>,
	) {
		for (const [path, content, tool] of changes) {
			await store.beforeMutation(entry, tool, tool === "edit" ? { path } : { command: "x" });
			if (content === undefined) rmSync(join(project, path), { force: true });
			else writeFileSync(join(project, path), content);
		}
		await store.finishRun();
	}

	for (const mode of ["git", "files only"] as const) {
		it(`sums every turn against the session start (${mode})`, async () => {
			if (mode === "git") initRepo();
			writeFileSync(join(project, "app.ts"), "one\ntwo\nthree\n");
			writeFileSync(join(project, "keep.ts"), "same\n");
			const store = makeStore(mode === "git" ? undefined : false);
			await turn(store, "e1", [["app.ts", "one\nTWO\nthree\n", "edit"]]);
			await turn(store, "e2", [
				["app.ts", "one\nTWO\nthree\nfour\n", "edit"],
				["new.ts", "x\ny\n", "edit"],
			]);
			const ids = store.list().map((checkpoint) => checkpoint.id);
			const changes = await store.sessionChanges(ids);
			expect(changes.files.map((f) => [f.path, f.status, f.added, f.removed])).toEqual([
				["app.ts", "modified", 2, 1],
				["new.ts", "added", 2, 0],
			]);
			expect(formatChangeCounts(changes)).toBe("2 files  +4 -1");
			// The counts match the line diff of the two sides.
			const versions = await store.sessionFileVersions(ids, "app.ts");
			expect(countChanges(versions!.before!.toString(), versions!.after!.toString())).toEqual({
				added: 2,
				removed: 1,
			});
		});
	}

	it("counts files a shell command changed (git layer)", async () => {
		initRepo();
		writeFileSync(join(project, "a.txt"), "a\n");
		const store = makeStore();
		await turn(store, "e1", [["made-by-shell.txt", "1\n2\n3\n", "bash"]]);
		const changes = await store.sessionChanges(store.list().map((c) => c.id));
		expect(changes.files).toEqual([{ path: "made-by-shell.txt", status: "added", added: 3, removed: 0 }]);
	});

	it("keep moves the baseline; revert writes the file; reverting an added file deletes it", async () => {
		initRepo();
		writeFileSync(join(project, "app.ts"), "one\n");
		const store = makeStore();
		await turn(store, "e1", [
			["app.ts", "one\ntwo\n", "edit"],
			["new.ts", "n\n", "edit"],
		]);
		const ids = store.list().map((c) => c.id);
		await store.keepBaseline("app.ts", Buffer.from("one\ntwo\n"));
		expect((await store.sessionChanges(ids)).files.map((f) => f.path)).toEqual(["new.ts"]);
		await store.writeProjectFile("new.ts", undefined);
		expect(existsSync(join(project, "new.ts"))).toBe(false);
		expect((await store.sessionChanges(ids)).files).toEqual([]);
		await expect(store.writeProjectFile("../outside.txt", Buffer.from("x"))).rejects.toThrow(/outside/);
	});
});

describe("changes review view", () => {
	beforeAll(() => initTheme("dark"));

	/** An in-memory source: baselines and files in maps. */
	function memorySource(before: Record<string, string>, after: Record<string, string | undefined>) {
		const files = { ...after };
		const base: Record<string, string | undefined> = { ...before };
		const source: ChangesReviewSource = {
			list: async () =>
				totalChanges(
					Object.keys({ ...base, ...files })
						.sort()
						.filter((path) => base[path] !== files[path])
						.map((path) => ({
							path,
							status: base[path] === undefined ? "added" : files[path] === undefined ? "deleted" : "modified",
							...countChanges(base[path] ?? "", files[path] ?? ""),
						})),
				),
			versions: async (path) => ({
				path,
				before: base[path] === undefined ? undefined : Buffer.from(base[path]!),
				after: files[path] === undefined ? undefined : Buffer.from(files[path]!),
			}),
			keep: async (path, content) => {
				base[path] = content?.toString();
			},
			revert: async (path, content) => {
				files[path] = content?.toString();
			},
		};
		return { source, files, base };
	}

	async function screen(source: ChangesReviewSource, initialPath?: string) {
		let closed = false;
		const view = new ChangesReviewScreen({
			source,
			files: await loadReviewFiles(source),
			...(initialPath ? { initialPath } : {}),
			height: () => 30,
			onClose: () => {
				closed = true;
			},
		});
		return { view, closed: () => closed };
	}

	const BEFORE = { "a.ts": "1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n", "b.ts": "x\n" };
	const AFTER = { "a.ts": "1\nTWO\n3\n4\n5\n6\n7\n8\nNINE\n10\n", "b.ts": "x\ny\n" };

	it("moves between hunks with up and down, between files with left and right, and closes on Esc", async () => {
		const { source } = memorySource(BEFORE, AFTER);
		const { view, closed } = await screen(source);
		expect(view.selectedItem).toEqual({ path: "a.ts", hunk: 0 });
		view.handleInput("\x1b[B");
		expect(view.selectedItem).toEqual({ path: "a.ts", hunk: 1 });
		view.handleInput("\x1b[B");
		expect(view.selectedItem).toEqual({ path: "b.ts", hunk: 0 });
		view.handleInput("\x1b[D");
		expect(view.selectedItem).toEqual({ path: "a.ts", hunk: 0 });
		view.handleInput("\x1b[C");
		expect(view.selectedItem).toEqual({ path: "b.ts", hunk: 0 });
		view.handleInput("\x1b");
		expect(closed()).toBe(true);
	});

	it("opens at the file clicked in the tray", async () => {
		const { source } = memorySource(BEFORE, AFTER);
		const { view } = await screen(source, "b.ts");
		expect(view.selectedItem?.path).toBe("b.ts");
	});

	it("renders files apart with a blank line, flush with both edges", async () => {
		const { source } = memorySource(BEFORE, AFTER);
		const { view } = await screen(source);
		const lines = view.render(80).map(strip);
		expect(lines).toHaveLength(30);
		expect(lines[0]).toMatch(/^Changes {3,}2 files {2}\+3 -2$/);
		const bIndex = lines.findIndex((line) => line.startsWith("b.ts"));
		expect(lines[bIndex - 1]).toBe("");
		expect(lines.find((line) => line.startsWith("a.ts"))).toBe("a.ts   +2 -2   modified");
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(80);
			expect(line).not.toMatch(BANNED);
		}
	});

	it("r asks twice, then reverts only the selected hunk", async () => {
		const { source, files } = memorySource(BEFORE, AFTER);
		const { view } = await screen(source);
		view.handleInput("\x1b[B"); // second hunk of a.ts
		view.handleInput("r");
		expect(files["a.ts"]).toBe(AFTER["a.ts"]);
		expect(strip(view.render(80).at(-1)!)).toBe("r again to revert this hunk");
		view.handleInput("r");
		await new Promise((resolve) => setTimeout(resolve, 0));
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(files["a.ts"]).toBe("1\nTWO\n3\n4\n5\n6\n7\n8\n9\n10\n");
		expect(view.fileCount).toBe(2);
	});

	it("R reverts the whole file; k keeps a hunk without touching the file", async () => {
		const { source, files, base } = memorySource(BEFORE, AFTER);
		const { view } = await screen(source);
		await view.act("keep", "hunk");
		expect(files["a.ts"]).toBe(AFTER["a.ts"]);
		expect(base["a.ts"]).toBe("1\nTWO\n3\n4\n5\n6\n7\n8\n9\n10\n");
		view.handleInput("\x1b[C");
		await view.act("revert", "file");
		expect(files["b.ts"]).toBe("x\n");
		expect(view.fileCount).toBe(1);
	});

	it("reverting the only hunk of an added file deletes it", async () => {
		const { source, files } = memorySource({}, { "new.ts": "hello\n" });
		const { view } = await screen(source);
		await view.act("revert", "hunk");
		expect(files["new.ts"]).toBeUndefined();
		expect(view.fileCount).toBe(0);
	});
});

describe("review restores real files", () => {
	it("a reverted hunk is written to disk through the store", async () => {
		const root = mkdtempSync(join(tmpdir(), "runkiln-tray-disk-"));
		try {
			const project = join(root, "p");
			mkdirSync(project);
			writeFileSync(join(project, "f.txt"), "a\nb\nc\n");
			const store = new CheckpointStore({ rootDir: join(root, "cp"), sessionId: "s", cwd: project, git: false });
			await store.beforeMutation("e1", "edit", { path: "f.txt" });
			writeFileSync(join(project, "f.txt"), "a\nB\nc\nd\n");
			await store.finishRun();
			const ids = store.list().map((c) => c.id);
			const source: ChangesReviewSource = {
				list: () => store.sessionChanges(ids),
				versions: (path) => store.sessionFileVersions(ids, path),
				keep: (path, content) => store.keepBaseline(path, content),
				revert: (path, content) => store.writeProjectFile(path, content),
			};
			const view = new ChangesReviewScreen({
				source,
				files: await loadReviewFiles(source),
				height: () => 24,
				onClose: () => {},
			});
			await view.act("revert", "hunk");
			expect(readFileSync(join(project, "f.txt"), "utf8")).toBe("a\nb\nc\nd\n");
			await view.act("revert", "file");
			expect(readFileSync(join(project, "f.txt"), "utf8")).toBe("a\nb\nc\n");
			expect((await store.sessionChanges(ids)).files).toEqual([]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
