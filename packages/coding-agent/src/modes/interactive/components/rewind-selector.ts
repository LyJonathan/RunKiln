import {
	type Component,
	Container,
	getKeybindings,
	Spacer,
	Text,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
	visibleWidth,
} from "@runkiln/tui";
import type { RewindPoint } from "../../../core/agent-session.ts";
import type { ChangeSummary, FileChange } from "../../../core/runkiln/checkpoints.ts";
import { theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { ListMouse } from "./list-mouse.ts";

const STATUS_MARK: Record<FileChange["status"], string> = { added: "A", modified: "M", deleted: "D" };

/** "M src/a.ts +3 −1 - A b.ts +12", fitted to `width` with a "+N more" tail. */
export function formatFileChanges(summary: ChangeSummary, width: number): string {
	const parts = summary.files.map((file) => {
		const mark = theme.fg(
			file.status === "added" ? "success" : file.status === "deleted" ? "error" : "warning",
			STATUS_MARK[file.status],
		);
		const counts = file.binary
			? theme.fg("muted", " binary")
			: `${file.added ? theme.fg("toolDiffAdded", ` +${file.added}`) : ""}${file.removed ? theme.fg("toolDiffRemoved", ` −${file.removed}`) : ""}`;
		return `${mark} ${file.path}${counts}`;
	});
	const separator = theme.fg("muted", " - ");
	let line = "";
	for (let i = 0; i < parts.length; i++) {
		const rest = parts.length - i - 1;
		const tail = rest > 0 ? theme.fg("muted", ` - +${rest} more`) : "";
		const candidate = line ? `${line}${separator}${parts[i]}` : parts[i];
		if (visibleWidth(candidate) + visibleWidth(tail) > width && line) {
			return `${line}${theme.fg("muted", ` - +${parts.length - i} more`)}`;
		}
		line = candidate;
	}
	return truncateToWidth(line, width);
}

/** The colored right-hand summary of a turn: "3 files  +42 −7", "no file changes", "undone". */
function summaryLabel(point: RewindPoint): string {
	if (!point.checkpointId || !point.summary || point.summary.files.length === 0) {
		return theme.fg("dim", "no file changes");
	}
	const { files, added, removed } = point.summary;
	const count = `${files.length} file${files.length === 1 ? "" : "s"}`;
	const label = `${count}  ${theme.fg("toolDiffAdded", `+${added}`)} ${theme.fg("toolDiffRemoved", `−${removed}`)}`;
	if (point.restored) return `${theme.fg("dim", "undone -")} ${label}`;
	return point.summary.inProgress ? `${label} ${theme.fg("dim", "(running)")}` : label;
}

class RewindList implements Component {
	private selectedIndex: number;
	private readonly maxVisible = 6;
	private readonly mouse = new ListMouse();
	onSelect?: (point: RewindPoint) => void;
	onCancel?: () => void;

	private readonly points: RewindPoint[];

	constructor(points: RewindPoint[]) {
		this.points = points;
		this.selectedIndex = Math.max(0, points.length - 1);
	}

	invalidate(): void {}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		return this.mouse.handle(event, {
			count: this.points.length,
			selected: this.selectedIndex,
			select: (index) => {
				this.selectedIndex = index;
			},
			activate: (index) => {
				const point = this.points[index];
				if (point) this.onSelect?.(point);
			},
		});
	}

	render(width: number): string[] {
		this.mouse.reset();
		const lines: string[] = [];
		const push = (index: number, selected: boolean, line: string) =>
			lines.push(this.mouse.line(lines.length, index, line, width, selected));
		const start = Math.max(
			0,
			Math.min(this.selectedIndex - Math.floor(this.maxVisible / 2), this.points.length - this.maxVisible),
		);
		const end = Math.min(start + this.maxVisible, this.points.length);
		const numberWidth = String(this.points.length).length;
		for (let i = start; i < end; i++) {
			const point = this.points[i];
			const selected = i === this.selectedIndex;
			const cursor = selected ? theme.fg("accent", "› ") : "  ";
			const number = theme.fg(selected ? "accent" : "muted", String(point.turn).padStart(numberWidth));
			const right = summaryLabel(point);
			const textWidth = Math.max(10, width - 2 - numberWidth - 2 - visibleWidth(right) - 2);
			const text = truncateToWidth(point.text.replace(/\s+/g, " ").trim() || "(empty message)", textWidth);
			const left = `${cursor}${number}  ${selected ? theme.bold(text) : text}`;
			const gap = Math.max(2, width - visibleWidth(left) - visibleWidth(right));
			push(i, selected, truncateToWidth(`${left}${" ".repeat(gap)}${right}`, width));
			const indent = " ".repeat(2 + numberWidth + 2);
			if (point.summary && point.summary.files.length > 0) {
				push(i, selected, `${indent}${formatFileChanges(point.summary, width - indent.length)}`);
			} else if (point.summary?.notes.length) {
				push(
					i,
					selected,
					`${indent}${theme.fg("dim", truncateToWidth(point.summary.notes[0], width - indent.length))}`,
				);
			}
			if (i < end - 1) lines.push("");
		}
		if (start > 0 || end < this.points.length) {
			lines.push(theme.fg("muted", `  (${this.selectedIndex + 1}/${this.points.length})`));
		}
		return lines;
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		if (kb.matches(keyData, "tui.select.up")) {
			this.selectedIndex = this.selectedIndex === 0 ? this.points.length - 1 : this.selectedIndex - 1;
		} else if (kb.matches(keyData, "tui.select.down")) {
			this.selectedIndex = this.selectedIndex === this.points.length - 1 ? 0 : this.selectedIndex + 1;
		} else if (kb.matches(keyData, "tui.select.confirm")) {
			const point = this.points[this.selectedIndex];
			if (point) this.onSelect?.(point);
		} else if (kb.matches(keyData, "tui.select.cancel")) {
			this.onCancel?.();
		}
	}
}

/** /rewind: the user turns of the current branch with what each changed in the files. */
export class RewindSelectorComponent extends Container {
	private readonly list: RewindList;

	constructor(points: RewindPoint[], onSelect: (point: RewindPoint) => void, onCancel: () => void) {
		super();
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.bold("Rewind"), 1, 0));
		this.addChild(
			new Text(
				theme.fg(
					"muted",
					"Go back to before a turn: restore the files, the conversation, or both. Nothing changes until you confirm.",
				),
				1,
				0,
			),
		);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.list = new RewindList(points);
		this.list.onSelect = onSelect;
		this.list.onCancel = onCancel;
		this.addChild(this.list);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
		this.addChild(new Text(theme.fg("dim", "↑↓ move - enter or click choose - esc cancel"), 1, 0));
	}

	getList(): Component {
		return this.list;
	}
}
