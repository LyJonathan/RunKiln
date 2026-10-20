/**
 * The review view for the changes tray (`/diff`, a click on the tray, or its key): every file the agent changed this
 * session, one after another, with its hunks. Up and down move between hunks, left and right between files.
 * k keeps a hunk (it leaves the tray, the file stays), r reverts it (the old lines go back into the file); K and R do
 * the same for the whole file. Reverts ask for the key a second time. Esc closes.
 */

import {
	type Component,
	type Focusable,
	getKeybindings,
	matchesKey,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
	visibleWidth,
} from "@runkiln/tui";
import {
	type ChangeHunk,
	computeHunks,
	formatChangeCounts,
	formatFileCounts,
	hunkDiffText,
	isBinaryContent,
	keepHunk,
	revertHunk,
	type SessionChanges,
	type SessionFileChange,
	type SessionFileVersions,
	totalChanges,
} from "../../../core/runkiln/session-changes.ts";
import { theme } from "../theme/theme.ts";
import { renderUnifiedDiffLines } from "./diff.ts";

/** Where the review view reads and writes. */
export interface ChangesReviewSource {
	list(): Promise<SessionChanges | undefined>;
	versions(path: string): Promise<SessionFileVersions | undefined>;
	/** Make `content` (undefined: absent) the file's baseline. */
	keep(path: string, content: Buffer | undefined): Promise<void>;
	/** Write `content` to the file (undefined deletes it). */
	revert(path: string, content: Buffer | undefined): Promise<void>;
}

export interface ReviewFile {
	change: SessionFileChange;
	before: Buffer | undefined;
	after: Buffer | undefined;
	/** Text hunks; empty for binary files, which are kept or reverted whole. */
	hunks: ChangeHunk[];
	text?: { before: string; after: string };
}

/** Text of a file side, or undefined when it is not valid UTF-8 text. */
function asText(content: Buffer | undefined): string | undefined {
	if (!content) return "";
	if (isBinaryContent(content)) return undefined;
	const text = content.toString("utf8");
	return Buffer.from(text, "utf8").equals(content) ? text : undefined;
}

/** Load every changed file with both sides and its hunks. */
export async function loadReviewFiles(source: ChangesReviewSource): Promise<ReviewFile[]> {
	const changes = await source.list();
	const files: ReviewFile[] = [];
	for (const change of changes?.files ?? []) {
		const versions = await source.versions(change.path);
		if (!versions) continue;
		const before = asText(versions.before);
		const after = asText(versions.after);
		const text = before !== undefined && after !== undefined ? { before, after } : undefined;
		files.push({
			change: text ? change : { ...change, binary: true },
			before: versions.before,
			after: versions.after,
			hunks: text ? computeHunks(text.before, text.after) : [],
			...(text ? { text } : {}),
		});
	}
	return files;
}

/** Rows above and below the body: title, rule; rule, hints. */
const CHROME_ROWS = 4;
/** A hunk longer than this shows its first rows and a count of the rest. */
const MAX_HUNK_ROWS = 400;

interface Item {
	file: number;
	/** Hunk index, or -1 for a file without hunks. */
	hunk: number;
}

interface BodyRow {
	text: string;
	/** The item whose header this row is (click selects it). */
	item?: number;
}

export interface ChangesReviewOptions {
	source: ChangesReviewSource;
	files: ReviewFile[];
	/** Open at this file. */
	initialPath?: string;
	height: () => number;
	requestRender?: () => void;
	/** After a keep or revert: refresh the tray. */
	onChanged?: () => void;
	onClose: () => void;
}

export class ChangesReviewScreen implements Component, Focusable {
	private readonly options: ChangesReviewOptions;
	private files: ReviewFile[];
	private items: Item[] = [];
	private selected = 0;
	private scroll = 0;
	/** The revert key pressed once, waiting for the second press. */
	private pendingRevert: "r" | "R" | undefined;
	private message: { text: string; tone: "status" | "warning" | "error" } | undefined;
	private busy = false;
	private lastWidth = 100;
	/** Body row of each item's header, from the last layout. */
	private itemRows: number[] = [];
	focused = false;

	constructor(options: ChangesReviewOptions) {
		this.options = options;
		this.files = options.files;
		this.buildItems();
		if (options.initialPath) {
			const index = this.items.findIndex((item) => this.files[item.file]?.change.path === options.initialPath);
			if (index >= 0) this.selected = index;
		}
	}

	get selectedItem(): { path: string; hunk: number } | undefined {
		const item = this.items[this.selected];
		const file = item ? this.files[item.file] : undefined;
		return item && file ? { path: file.change.path, hunk: item.hunk } : undefined;
	}

	get fileCount(): number {
		return this.files.length;
	}

	invalidate(): void {}

	private buildItems(): void {
		this.items = [];
		for (const [index, file] of this.files.entries()) {
			if (file.hunks.length === 0) this.items.push({ file: index, hunk: -1 });
			for (let hunk = 0; hunk < file.hunks.length; hunk++) this.items.push({ file: index, hunk });
		}
		this.selected = Math.max(0, Math.min(this.selected, this.items.length - 1));
	}

	private bodyHeight(): number {
		return Math.max(3, this.options.height() - CHROME_ROWS);
	}

	private move(delta: number): void {
		if (this.items.length === 0) return;
		this.selected = Math.max(0, Math.min(this.items.length - 1, this.selected + delta));
		this.revealSelected();
	}

	private moveFile(delta: number): void {
		const current = this.items[this.selected]?.file ?? 0;
		const target = Math.max(0, Math.min(this.files.length - 1, current + delta));
		const index = this.items.findIndex((item) => item.file === target);
		if (index >= 0) this.selected = index;
		this.revealSelected();
	}

	private revealSelected(): void {
		const rows = this.bodyRows(this.lastWidth);
		const top = this.itemRows[this.selected] ?? 0;
		// The file header and blank line above the first hunk stay in view with it.
		const item = this.items[this.selected];
		const header = item && (item.hunk <= 0 ? Math.max(0, top - 2) : top);
		const next = this.itemRows[this.selected + 1] ?? rows.length;
		const height = this.bodyHeight();
		if (header !== undefined && header < this.scroll) this.scroll = header;
		else if (next > this.scroll + height) this.scroll = Math.min(header ?? top, next - height);
		this.scroll = Math.max(0, Math.min(this.scroll, Math.max(0, rows.length - height)));
	}

	private scrollBy(delta: number): void {
		const max = Math.max(0, this.bodyRows(this.lastWidth).length - this.bodyHeight());
		this.scroll = Math.max(0, Math.min(max, this.scroll + delta));
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		if (matchesKey(data, "escape") || data === "q" || kb.matches(data, "tui.select.cancel")) {
			this.options.onClose();
			return;
		}
		if (this.busy) return;
		const wasPending = this.pendingRevert;
		this.pendingRevert = undefined;
		this.message = undefined;
		if (matchesKey(data, "up")) this.move(-1);
		else if (matchesKey(data, "down")) this.move(1);
		else if (matchesKey(data, "left") || matchesKey(data, "shift+tab")) this.moveFile(-1);
		else if (matchesKey(data, "right") || matchesKey(data, "tab")) this.moveFile(1);
		else if (matchesKey(data, "pageUp")) this.scrollBy(-this.bodyHeight());
		else if (matchesKey(data, "pageDown") || data === " ") this.scrollBy(this.bodyHeight());
		else if (matchesKey(data, "home") || data === "g") {
			this.selected = 0;
			this.scroll = 0;
		} else if (matchesKey(data, "end") || data === "G") {
			this.selected = Math.max(0, this.items.length - 1);
			this.revealSelected();
		} else if (data === "k") void this.act("keep", "hunk");
		else if (data === "K") void this.act("keep", "file");
		else if (data === "r" || data === "R") {
			if (wasPending === data) void this.act("revert", data === "r" ? "hunk" : "file");
			else {
				this.pendingRevert = data;
				this.message = {
					text: `${data} again to revert ${data === "r" ? "this hunk" : "the whole file"}`,
					tone: "warning",
				};
			}
		} else return;
		this.options.requestRender?.();
	}

	/** Keep or revert the selected hunk (or its whole file), then reload. */
	async act(action: "keep" | "revert", scope: "hunk" | "file"): Promise<void> {
		const item = this.items[this.selected];
		const file = item ? this.files[item.file] : undefined;
		if (!item || !file) return;
		const wholeFile = scope === "file" || item.hunk < 0 || !file.text;
		const hunk = wholeFile ? undefined : file.hunks[item.hunk];
		this.busy = true;
		try {
			if (action === "revert") {
				let content = file.before;
				if (hunk && file.text) {
					const text = revertHunk(file.text.after, hunk);
					content = !file.before && text === file.text.before ? undefined : Buffer.from(text, "utf8");
				}
				await this.options.source.revert(file.change.path, content);
			} else {
				let content = file.after;
				if (hunk && file.text) {
					const text = keepHunk(file.text.before, hunk);
					content = !file.after && text === file.text.after ? undefined : Buffer.from(text, "utf8");
				}
				await this.options.source.keep(file.change.path, content);
			}
			const what = hunk ? `hunk ${item.hunk + 1} of ${file.change.path}` : file.change.path;
			this.message = { text: `${action === "keep" ? "Kept" : "Reverted"} ${what}`, tone: "status" };
			await this.reload();
			this.options.onChanged?.();
		} catch (error) {
			this.message = { text: error instanceof Error ? error.message : String(error), tone: "error" };
		} finally {
			this.busy = false;
			this.options.requestRender?.();
		}
	}

	/** Read the files again (after a keep or revert, or when they changed). The selection stays near where it was. */
	async reload(): Promise<void> {
		this.files = await loadReviewFiles(this.options.source);
		this.buildItems();
		this.revealSelected();
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type === "wheel" && event.wheelDelta) {
			this.scrollBy(event.wheelDelta > 0 ? 3 : -3);
			return { handled: true };
		}
		if (event.type === "click" && event.button === "left") {
			const bodyRow = event.y - 2 + this.scroll;
			if (event.y >= 2 && event.y < 2 + this.bodyHeight()) {
				const row = this.bodyRows(event.width)[bodyRow];
				if (row?.item !== undefined) {
					this.selected = row.item;
					this.pendingRevert = undefined;
					this.message = undefined;
					return { handled: true };
				}
			}
		}
		return undefined;
	}

	private styleCounts(text: string): string {
		if (text === "bin") return theme.fg("muted", text);
		const [added, removed] = text.split(" ");
		return `${theme.fg("success", added ?? "")} ${theme.fg("error", removed ?? "")}`;
	}

	/** Every body row: per file a header, a blank line, its hunks (blank line between), and a blank line after. */
	private bodyRows(width: number): BodyRow[] {
		const rows: BodyRow[] = [];
		this.itemRows = [];
		const itemIndex = new Map(this.items.map((item, index) => [`${item.file}:${item.hunk}`, index]));
		this.files.forEach((file, fileIndex) => {
			if (fileIndex > 0) rows.push({ text: "" });
			const selectedFile = this.items[this.selected]?.file === fileIndex;
			const name = selectedFile ? theme.fg("accent", theme.bold(file.change.path)) : theme.bold(file.change.path);
			rows.push({
				text: `${name}   ${this.styleCounts(formatFileCounts(file.change))}   ${theme.fg("muted", file.change.status)}`,
				item: itemIndex.get(`${fileIndex}:${file.hunks.length === 0 ? -1 : 0}`),
			});
			rows.push({ text: "" });
			if (file.hunks.length === 0) {
				const index = itemIndex.get(`${fileIndex}:-1`) ?? 0;
				this.itemRows[index] = rows.length;
				const label = file.change.binary ? "Binary file, no line diff" : "No line changes";
				rows.push({ text: this.hunkHeader(label, index === this.selected, width), item: index });
				return;
			}
			file.hunks.forEach((hunk, hunkIndex) => {
				if (hunkIndex > 0) rows.push({ text: "" });
				const index = itemIndex.get(`${fileIndex}:${hunkIndex}`) ?? 0;
				this.itemRows[index] = rows.length;
				const line = hunk.newLines.length > 0 ? hunk.newStart + 1 : hunk.oldStart + 1;
				const label = `hunk ${hunkIndex + 1} of ${file.hunks.length}   line ${line}   +${hunk.newLines.length} -${hunk.oldLines.length}`;
				rows.push({ text: this.hunkHeader(label, index === this.selected, width), item: index });
				const diff = renderUnifiedDiffLines(hunkDiffText(file.text!.before, file.text!.after, hunk), {
					filePath: file.change.path,
				});
				for (const text of diff.slice(0, MAX_HUNK_ROWS)) rows.push({ text });
				if (diff.length > MAX_HUNK_ROWS) {
					rows.push({ text: theme.fg("dim", `${diff.length - MAX_HUNK_ROWS} more lines`) });
				}
			});
		});
		return rows;
	}

	private hunkHeader(label: string, selected: boolean, width: number): string {
		if (!selected) return theme.fg("dim", label);
		const padded = label + " ".repeat(Math.max(0, width - visibleWidth(label)));
		return theme.bg("selectedBg", theme.fg("accent", theme.bold(padded)));
	}

	private titleLine(width: number): string {
		const left = theme.bold("Changes");
		const changes = totalChanges(this.files.map((file) => file.change));
		const right =
			changes.files.length === 0
				? theme.fg("muted", "no changes")
				: `${theme.fg("accent", `${changes.files.length} file${changes.files.length === 1 ? "" : "s"}`)}  ${this.styleCounts(
						formatChangeCounts(changes).replace(/^\d+ files?\s+/, ""),
					)}`;
		const gap = width - visibleWidth(left) - visibleWidth(right);
		return gap >= 3 ? `${left}${" ".repeat(gap)}${right}` : truncateToWidth(left, width);
	}

	private hintLine(width: number, scrollInfo: string): string {
		if (this.message) {
			const color =
				this.message.tone === "error" ? "error" : this.message.tone === "warning" ? "warning" : "success";
			return truncateToWidth(theme.fg(color, this.message.text), width, "…");
		}
		const pairs: Array<[string, string]> = [
			["↑↓", "hunk"],
			["←→", "file"],
			["k", "keep"],
			["r", "revert"],
			["K R", "whole file"],
			["esc", "close"],
		];
		const left = pairs
			.map(([key, label]) => `${theme.fg("dim", key)} ${theme.fg("muted", label)}`)
			.join(theme.fg("dim", "   "));
		const right = scrollInfo ? theme.fg("dim", scrollInfo) : "";
		const gap = width - visibleWidth(left) - visibleWidth(right);
		if (right && gap >= 3) return `${left}${" ".repeat(gap)}${right}`;
		return truncateToWidth(left, width, "…");
	}

	render(width: number): string[] {
		this.lastWidth = width;
		const height = Math.max(CHROME_ROWS + 3, this.options.height());
		const rows = this.bodyRows(width);
		const bodyHeight = height - CHROME_ROWS;
		const maxScroll = Math.max(0, rows.length - bodyHeight);
		this.scroll = Math.min(this.scroll, maxScroll);
		const visible = rows.slice(this.scroll, this.scroll + bodyHeight);
		const rule = theme.fg("borderAccent", "─".repeat(Math.max(1, width)));
		const scrollInfo =
			rows.length > bodyHeight
				? `${this.scroll + 1}-${Math.min(rows.length, this.scroll + bodyHeight)} of ${rows.length}`
				: "";
		const lines = [this.titleLine(width), rule];
		if (this.files.length === 0) lines.push(theme.fg("muted", "No changes left to review"));
		else for (const row of visible) lines.push(row.text);
		while (lines.length < height - 2) lines.push("");
		lines.push(rule);
		lines.push(this.hintLine(width, scrollInfo));
		return lines.map((line) => truncateToWidth(line, Math.max(1, width), "…"));
	}
}
