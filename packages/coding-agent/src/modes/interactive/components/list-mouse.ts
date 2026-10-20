import { ClickableRows, HitMap, type TuiMouseEvent, type TuiMouseEventResult } from "@runkiln/tui";
import { hoverRow } from "./hover-style.ts";

/**
 * Mouse support for a windowed picker list: rows map to item indexes while rendering; a click picks the item,
 * hover highlights it without moving the selection, the wheel moves the selection.
 */
export class ListMouse {
	readonly hits = new HitMap<number>();
	readonly rows: ClickableRows<number>;

	constructor(onHoverChange?: () => void) {
		this.rows = new ClickableRows<number>(onHoverChange);
	}

	/** Call at the start of render. */
	reset(): void {
		this.hits.reset();
	}

	/** Record `line` as row `row` of item `index`; returns it with the hover style when hovered and not selected. */
	line(row: number, index: number, line: string, width: number, selected: boolean): string {
		this.hits.add(row, index);
		return !selected && this.rows.isHovered(index) ? hoverRow(line, width) : line;
	}

	handle(
		event: TuiMouseEvent,
		list: { count: number; selected: number; select(index: number): void; activate(index: number): void },
	): TuiMouseEventResult | undefined {
		if (list.count === 0) return undefined;
		const value = event.type === "leave" ? undefined : this.hits.at(event.x, event.y);
		return this.rows.handle(value, event, {
			select: (index) => list.select(index),
			activate: (index) => list.activate(index),
			wheel: (delta) => list.select(Math.max(0, Math.min(list.count - 1, list.selected + delta))),
		});
	}
}
