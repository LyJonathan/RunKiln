/**
 * The changes tray: one row above the editor with the files the agent changed this session,
 * `3 files  +27 -8   app.ts  +12 -3   util.ts  +9 -2   +1 more`, and the review key at the right edge. Hidden when
 * nothing differs. A click opens the review view (at the clicked file).
 */

import {
	ClickableRows,
	type Component,
	HitMap,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
	visibleWidth,
} from "@runkiln/tui";
import {
	formatChangeCounts,
	formatFileCounts,
	type SessionChanges,
	type SessionFileChange,
} from "../../../core/runkiln/session-changes.ts";
import { theme } from "../theme/theme.ts";
import { underline } from "./hover-style.ts";

/** Columns between the summary, the files and the hint. */
export const TRAY_GAP = "   ";
/** Columns between a file name and its counts. */
export const TRAY_NAME_GAP = "  ";
/** File names longer than this are cut. */
const MAX_NAME_COLUMNS = 32;
/** Hit value for the parts of the row that are not a file. */
const WHOLE_TRAY = "\0tray";

/** Short names: the base name, or the whole path when two changed files share a base name. */
export function trayFileNames(files: readonly SessionFileChange[]): string[] {
	const base = (path: string) => path.slice(path.lastIndexOf("/") + 1);
	const seen = new Map<string, number>();
	for (const file of files) seen.set(base(file.path), (seen.get(base(file.path)) ?? 0) + 1);
	return files.map((file) => {
		const name = (seen.get(base(file.path)) ?? 0) > 1 ? file.path : base(file.path);
		return visibleWidth(name) > MAX_NAME_COLUMNS ? truncateToWidth(name, MAX_NAME_COLUMNS, "…") : name;
	});
}

interface TrayLayout {
	/** Index of each shown file's entry. */
	shown: number;
	more: number;
	hint: boolean;
}

/** How many files fit in `width` with the summary, the "+N more" label and (if room) the hint. */
export function layoutTray(
	changes: Pick<SessionChanges, "files" | "added" | "removed">,
	width: number,
	hint: string | undefined,
): TrayLayout {
	const names = trayFileNames(changes.files);
	const summary = visibleWidth(formatChangeCounts(changes));
	const entryWidths = changes.files.map(
		(file, index) => visibleWidth(TRAY_GAP) + visibleWidth(names[index]!) + 2 + visibleWidth(formatFileCounts(file)),
	);
	const total = changes.files.length;
	const tryFit = (room: number): number | undefined => {
		for (let shown = total; shown >= 0; shown--) {
			let used = summary;
			for (let i = 0; i < shown; i++) used += entryWidths[i]!;
			if (shown < total) used += visibleWidth(`${TRAY_GAP}+${total - shown} more`);
			if (used <= room) return shown;
		}
		return undefined;
	};
	if (hint) {
		const shown = tryFit(width - visibleWidth(TRAY_GAP) - visibleWidth(hint));
		if (shown !== undefined) return { shown, more: total - shown, hint: true };
	}
	const shown = tryFit(width) ?? 0;
	return { shown, more: total - shown, hint: false };
}

export interface ChangesTrayOptions {
	/** Right-edge hint, e.g. "alt+c review". */
	hint?: () => string | undefined;
	/** Click: open the review view, at `path` when a file was clicked. */
	onOpen?: (path: string | undefined) => void;
	requestRender?: () => void;
}

export class ChangesTrayComponent implements Component {
	private changes: SessionChanges = { files: [], added: 0, removed: 0 };
	private enabled = true;
	private readonly options: ChangesTrayOptions;
	private readonly hits = new HitMap<string>();
	private readonly rows: ClickableRows<string>;

	constructor(options: ChangesTrayOptions = {}) {
		this.options = options;
		this.rows = new ClickableRows<string>(() => options.requestRender?.());
	}

	setChanges(changes: SessionChanges | undefined): void {
		this.changes = changes ?? { files: [], added: 0, removed: 0 };
	}

	getChanges(): SessionChanges {
		return this.changes;
	}

	setEnabled(enabled: boolean): void {
		this.enabled = enabled;
	}

	/** Whether the tray has anything to show. */
	get visible(): boolean {
		return this.enabled && this.changes.files.length > 0;
	}

	invalidate(): void {}

	private styleCounts(text: string): string {
		if (text === "bin") return theme.fg("muted", text);
		const [added, removed] = text.split(" ");
		return `${theme.fg("success", added ?? "")} ${theme.fg("error", removed ?? "")}`;
	}

	render(width: number): string[] {
		this.hits.reset();
		if (!this.visible || width <= 0) return [];
		const changes = this.changes;
		const hint = this.options.hint?.();
		const layout = layoutTray(changes, width, hint);
		const names = trayFileNames(changes.files);
		const count = changes.files.length;
		const countText = `${count} file${count === 1 ? "" : "s"}`;
		let line = `${theme.fg("accent", theme.bold(countText))}  ${this.styleCounts(`+${changes.added} -${changes.removed}`)}`;
		let column = visibleWidth(formatChangeCounts(changes));
		this.hits.add(0, WHOLE_TRAY, 0, width);
		for (let i = 0; i < layout.shown; i++) {
			const file = changes.files[i]!;
			const name = names[i]!;
			const entry = `${name}${TRAY_NAME_GAP}`;
			const start = column + TRAY_GAP.length;
			const styledName = this.rows.isHovered(file.path) ? underline(name) : name;
			line += `${TRAY_GAP}${theme.fg("text", styledName)}${TRAY_NAME_GAP}${this.styleCounts(formatFileCounts(file))}`;
			column = start + visibleWidth(entry) + visibleWidth(formatFileCounts(file));
			this.hits.add(0, file.path, start, column);
		}
		if (layout.more > 0) {
			const more = `+${layout.more} more`;
			line += theme.fg("muted", `${TRAY_GAP}${more}`);
			column += TRAY_GAP.length + more.length;
		}
		if (layout.hint && hint) {
			const pad = width - column - visibleWidth(hint);
			line += `${" ".repeat(Math.max(visibleWidth(TRAY_GAP), pad))}${theme.fg("dim", hint)}`;
		}
		return [truncateToWidth(line, width, "…")];
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (!this.visible) return undefined;
		const value = event.type === "leave" ? undefined : this.hits.at(event.x, event.y);
		return this.rows.handle(this.options.onOpen ? value : undefined, event, {
			activate: (target) => this.options.onOpen?.(target === WHOLE_TRAY ? undefined : target),
		});
	}
}

/**
 * What `/diff <arg>` opens: "review" or "git" when given, else the `display.diffOpens` setting. A review with no
 * session changes falls back to the git panel.
 */
export function resolveDiffTarget(arg: string, setting: "review" | "git"): "review" | "git" {
	const word = arg.trim().toLowerCase();
	return word === "git" || word === "review" ? word : setting;
}
