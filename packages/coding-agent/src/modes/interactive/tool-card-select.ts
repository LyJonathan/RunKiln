/**
 * Card select mode: a key (app.tools.select) moves a cursor over the transcript's tool cards; ↑/↓ (or k/j)
 * move, Enter/Space opens or closes the selected card, Esc leaves. Ctrl+O still toggles every card.
 */

import { matchesKey } from "@runkiln/tui";

export interface SelectableCard {
	/** Per-card toggle (the same as a click). */
	toggleSelected(): void;
	setSelectMarker(marker: string | undefined): void;
}

export type CardSelectKey = "up" | "down" | "toggle" | "exit" | "other";

export function classifyCardSelectKey(data: string): CardSelectKey {
	if (matchesKey(data, "up") || data === "k") return "up";
	if (matchesKey(data, "down") || data === "j") return "down";
	if (matchesKey(data, "enter") || data === " " || data === "\r") return "toggle";
	if (matchesKey(data, "escape") || data === "q") return "exit";
	return "other";
}

/** The cursor over a list of cards; pure, so it can be tested without a terminal. */
export class CardSelection<T extends SelectableCard> {
	private cards: T[];
	private index: number;
	private readonly marker: string;

	constructor(cards: T[], marker: string) {
		this.cards = cards;
		this.marker = marker;
		this.index = cards.length - 1;
		this.cards[this.index]?.setSelectMarker(this.marker);
	}

	get selected(): T | undefined {
		return this.cards[this.index];
	}

	get position(): number {
		return this.index;
	}

	move(delta: number): void {
		if (this.cards.length === 0) return;
		const next = Math.max(0, Math.min(this.cards.length - 1, this.index + delta));
		if (next === this.index) return;
		this.cards[this.index]?.setSelectMarker(undefined);
		this.index = next;
		this.cards[this.index]?.setSelectMarker(this.marker);
	}

	toggle(): void {
		this.selected?.toggleSelected();
	}

	dispose(): void {
		this.cards[this.index]?.setSelectMarker(undefined);
	}
}
