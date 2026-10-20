import type { TuiMouseEvent, TuiMouseEventResult } from "./tui.ts";

/** One clickable area recorded during render: a row, optionally limited to columns [x0, x1). */
export interface HitRegion<T> {
	row: number;
	x0: number;
	x1: number;
	value: T;
}

/**
 * Maps rendered cells to values (an item index, an action id). Components fill it while rendering and read
 * it back in handleMouse, so hit-testing always matches what is on screen.
 */
export class HitMap<T> {
	private regions: HitRegion<T>[] = [];

	/** Forget the previous frame's regions. Call at the start of render. */
	reset(): void {
		this.regions = [];
	}

	/** Make a whole row (or columns [x0, x1) of it) hit `value`. Later regions win where they overlap. */
	add(row: number, value: T, x0 = 0, x1 = Number.POSITIVE_INFINITY): void {
		if (x1 <= x0) return;
		this.regions.push({ row, x0, x1, value });
	}

	/** The value at a cell, or undefined. */
	at(x: number, y: number): T | undefined {
		for (let index = this.regions.length - 1; index >= 0; index--) {
			const region = this.regions[index]!;
			if (region.row === y && x >= region.x0 && x < region.x1) return region.value;
		}
		return undefined;
	}

	/** Shift every region down by `rows` (for a component rendered below others). */
	offset(rows: number): void {
		for (const region of this.regions) region.row += rows;
	}

	get size(): number {
		return this.regions.length;
	}

	values(): T[] {
		return this.regions.map((region) => region.value);
	}
}

export interface ClickableRowsActions<T> {
	/** A completed left click (press and release on the same value). */
	activate(value: T, event: TuiMouseEvent): void;
	/** A left press on a value: move the keyboard selection there. Optional. */
	select?(value: T): void;
	/** Wheel over the component. `delta` is -1 (up) or 1 (down). Optional. */
	wheel?(delta: number): void;
	/** A right click on a value. Optional; without it right clicks fall through. */
	context?(value: T, event: TuiMouseEvent): void;
}

/**
 * Hover, press, click and wheel handling for a list of clickable values. Hover never moves the keyboard
 * selection; a press selects, the matching release activates. `value` is what the event's cell maps to
 * (from a HitMap, or fixed for a per-row MouseRegion); undefined means "not on a clickable value".
 */
export class ClickableRows<T> {
	hovered: T | undefined;
	private pressed: T | undefined;
	private readonly onHoverChange: (() => void) | undefined;

	constructor(onHoverChange?: () => void) {
		this.onHoverChange = onHoverChange;
	}

	isHovered(value: T): boolean {
		return this.hovered !== undefined && this.hovered === value;
	}

	clearHover(): boolean {
		if (this.hovered === undefined) return false;
		this.hovered = undefined;
		this.onHoverChange?.();
		return true;
	}

	handle(
		value: T | undefined,
		event: TuiMouseEvent,
		actions: ClickableRowsActions<T>,
	): TuiMouseEventResult | undefined {
		switch (event.type) {
			case "wheel": {
				if (!actions.wheel || !event.wheelDelta) return undefined;
				actions.wheel(event.wheelDelta < 0 ? -1 : 1);
				return { handled: true, render: true };
			}
			case "move": {
				const changed = this.hovered !== value;
				const hadHover = this.hovered !== undefined;
				if (changed) {
					this.hovered = value;
					this.onHoverChange?.();
				}
				if (value === undefined && !hadHover) return undefined;
				return {
					handled: true,
					render: changed,
					...(value !== undefined ? { pointer: "pointer" as const } : {}),
				};
			}
			case "leave": {
				// A per-row region only clears its own hover; a whole-list map clears any.
				if (value !== undefined && this.hovered !== value) return undefined;
				return this.clearHover() ? { handled: true, render: true } : undefined;
			}
			case "press": {
				if (value === undefined) return undefined;
				if (event.button === "right" && actions.context) return { handled: true };
				if (event.button !== "left") return undefined;
				this.pressed = value;
				actions.select?.(value);
				return { handled: true, render: true };
			}
			case "click": {
				if (value === undefined) {
					this.pressed = undefined;
					return undefined;
				}
				if (event.button === "right" && actions.context) {
					actions.context(value, event);
					return { handled: true, render: true };
				}
				if (event.button !== "left") return undefined;
				const target = this.pressed ?? value;
				this.pressed = undefined;
				if (target !== value) return { handled: true };
				actions.activate(value, event);
				return { handled: true, render: true };
			}
			default:
				return undefined;
		}
	}
}
