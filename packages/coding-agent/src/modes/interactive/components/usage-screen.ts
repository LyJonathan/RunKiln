/**
 * `/usage` (also `/cost`, `/stats`): a full-height overlay with five tabs, Overview - Models - Turns - Context -
 * History, in the RK ember theme. Tab / ←→ / 1-5 switch tabs, ↑↓ PgUp PgDn Home End scroll (Turns moves a cursor),
 * t w m a pick the History range, r refreshes, Esc or q closes. The numbers come from core/usage (the same views
 * print mode and `runkiln usage` print), so every surface agrees.
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
import type { BudgetStatus } from "../../../core/usage/budget.ts";
import type { LedgerSummary, UsageRange } from "../../../core/usage/ledger.ts";
import type { ContextBreakdown, SessionUsageReport } from "../../../core/usage/session-usage.ts";
import {
	contextLines,
	historyLines,
	modelLines,
	overviewLines,
	percent,
	turnLines,
	USAGE_TAB_LABELS,
	USAGE_TABS,
	type UsageStyle,
	type UsageTab,
	usd,
} from "../../../core/usage/views.ts";
import { theme } from "../theme/theme.ts";

export interface UsageScreenData {
	report(): SessionUsageReport;
	context(): ContextBreakdown | undefined;
	history(range: UsageRange): LedgerSummary | undefined;
	budgets(): BudgetStatus[];
	ledgerPath?: string;
	/** Session name or id for the title. */
	title?: string;
}

export interface UsageScreenOptions {
	data: UsageScreenData;
	initialTab?: UsageTab;
	initialRange?: UsageRange;
	/** Terminal rows; the screen fills them. */
	height: () => number;
	requestRender?: () => void;
	onClose: () => void;
}

const RANGE_KEYS: Record<string, UsageRange> = { t: "today", w: "week", m: "month", a: "all" };
const PART_COLORS = ["accent", "warning", "mdLink", "success"] as const;

export function themeUsageStyle(): UsageStyle {
	return {
		accent: (text) => theme.fg("accent", text),
		strong: (text) => theme.bold(text),
		muted: (text) => theme.fg("muted", text),
		dim: (text) => theme.fg("dim", text),
		success: (text) => theme.fg("success", text),
		warning: (text) => theme.fg("warning", text),
		error: (text) => theme.fg("error", text),
		part: (index, text) => theme.fg(PART_COLORS[index] ?? "accent", text),
		bar: (text) => theme.fg("accent", text),
	};
}

/** Rows the chrome takes: title, tabs, rule above the body; rule and hints below it. */
const CHROME_ROWS = 5;

export class UsageScreen implements Component, Focusable {
	private readonly options: UsageScreenOptions;
	private tab: UsageTab;
	private range: UsageRange;
	private readonly scroll = new Map<UsageTab, number>();
	private turnCursor = 0;
	private report: SessionUsageReport;
	private context: ContextBreakdown | undefined;
	private budgets: BudgetStatus[];
	private readonly historyCache = new Map<UsageRange, LedgerSummary | undefined>();
	/** Columns of each tab label on the tab row, for mouse clicks. */
	private tabSpans: Array<{ tab: UsageTab; from: number; to: number }> = [];
	focused = false;

	constructor(options: UsageScreenOptions) {
		this.options = options;
		this.tab = options.initialTab ?? "overview";
		this.range = options.initialRange ?? "week";
		this.report = options.data.report();
		this.context = options.data.context();
		this.budgets = options.data.budgets();
	}

	get activeTab(): UsageTab {
		return this.tab;
	}

	get activeRange(): UsageRange {
		return this.range;
	}

	invalidate(): void {}

	refresh(): void {
		this.report = this.options.data.report();
		this.context = this.options.data.context();
		this.budgets = this.options.data.budgets();
		this.historyCache.clear();
	}

	private history(): LedgerSummary | undefined {
		if (!this.historyCache.has(this.range)) this.historyCache.set(this.range, this.options.data.history(this.range));
		return this.historyCache.get(this.range);
	}

	private bodyHeight(): number {
		return Math.max(3, this.options.height() - CHROME_ROWS);
	}

	private setTab(tab: UsageTab): void {
		this.tab = tab;
	}

	private moveTab(delta: number): void {
		const index = USAGE_TABS.indexOf(this.tab);
		this.setTab(USAGE_TABS[(index + delta + USAGE_TABS.length) % USAGE_TABS.length]!);
	}

	private scrollBy(delta: number, width = 100): void {
		if (this.tab === "turns") {
			const count = this.report.turns.length;
			if (count === 0) return;
			this.turnCursor = Math.max(0, Math.min(count - 1, this.turnCursor + delta));
			// Two lines per turn: keep the cursor in view.
			const top = this.scroll.get("turns") ?? 0;
			const cursorTop = this.turnCursor * 2;
			const height = this.bodyHeight();
			if (cursorTop < top) this.scroll.set("turns", cursorTop);
			else if (cursorTop + 2 > top + height) this.scroll.set("turns", cursorTop + 2 - height);
			return;
		}
		const max = Math.max(0, this.bodyLines(width).length - this.bodyHeight());
		const next = Math.max(0, Math.min(max, (this.scroll.get(this.tab) ?? 0) + delta));
		this.scroll.set(this.tab, next);
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		if (matchesKey(data, "escape") || data === "q" || kb.matches(data, "tui.select.cancel")) {
			this.options.onClose();
			return;
		}
		if (matchesKey(data, "tab") || matchesKey(data, "right") || data === "l") this.moveTab(1);
		else if (matchesKey(data, "shift+tab") || matchesKey(data, "left") || data === "h") this.moveTab(-1);
		else if (/^[1-5]$/.test(data)) this.setTab(USAGE_TABS[Number(data) - 1]!);
		else if (matchesKey(data, "up") || data === "k") this.scrollBy(-1);
		else if (matchesKey(data, "down") || data === "j") this.scrollBy(1);
		else if (matchesKey(data, "pageUp")) this.scrollBy(this.tab === "turns" ? -5 : -this.bodyHeight());
		else if (matchesKey(data, "pageDown") || data === " ")
			this.scrollBy(this.tab === "turns" ? 5 : this.bodyHeight());
		else if (matchesKey(data, "home") || data === "g") this.scrollBy(-1_000_000);
		else if (matchesKey(data, "end") || data === "G") this.scrollBy(1_000_000);
		else if (data === "r") this.refresh();
		else if (RANGE_KEYS[data]) {
			this.range = RANGE_KEYS[data]!;
			this.setTab("history");
			this.scroll.set("history", 0);
		} else return;
		this.options.requestRender?.();
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type === "wheel" && event.wheelDelta) {
			this.scrollBy(event.wheelDelta > 0 ? 3 : -3, event.width);
			return { handled: true };
		}
		if (event.type === "click" && event.button === "left" && event.y === 1) {
			const span = this.tabSpans.find((entry) => event.x >= entry.from && event.x < entry.to);
			if (span) {
				this.setTab(span.tab);
				return { handled: true };
			}
		}
		return undefined;
	}

	private bodyLines(width: number): string[] {
		const style = themeUsageStyle();
		const inner = Math.max(40, width - 2);
		switch (this.tab) {
			case "overview":
				return overviewLines(this.report, inner, style, { budgets: this.budgets });
			case "models":
				return modelLines(this.report, inner, style);
			case "turns":
				return turnLines(this.report, inner, style, { selected: this.turnCursor });
			case "context":
				return contextLines(this.context, inner, style);
			case "history":
				return historyLines(this.history(), this.range, inner, style, {
					ledgerPath: this.options.data.ledgerPath,
					rangeHint: "t w m a",
				});
		}
	}

	private titleLine(width: number): string {
		const o = this.report.overview;
		const left = `${theme.fg("accent", theme.bold("RK"))} ${theme.bold("Usage")}${
			this.options.data.title ? theme.fg("dim", `  ${this.options.data.title}`) : ""
		}`;
		const right = `${theme.fg("accent", theme.bold(usd(o.cost)))}${theme.fg("muted", ` - ${percent(o.hitPct)} cached`)}${
			this.report.cache.state === "warm"
				? theme.fg("success", " - warm")
				: this.report.cache.state === "cold"
					? theme.fg("warning", " - cold")
					: ""
		}`;
		const gap = width - visibleWidth(left) - visibleWidth(right);
		return gap >= 2 ? `${left}${" ".repeat(gap)}${right}` : truncateToWidth(left, width);
	}

	private tabLine(width: number): string {
		let line = "";
		let column = 0;
		this.tabSpans = [];
		for (const [index, tab] of USAGE_TABS.entries()) {
			const text = ` ${index + 1} ${USAGE_TAB_LABELS[tab]} `;
			const styled =
				tab === this.tab ? theme.bg("selectedBg", theme.fg("accent", theme.bold(text))) : theme.fg("muted", text);
			this.tabSpans.push({ tab, from: column, to: column + text.length });
			line += styled;
			column += text.length;
			if (index < USAGE_TABS.length - 1) {
				line += theme.fg("dim", ".");
				column += 1;
			}
		}
		return truncateToWidth(line, width);
	}

	private hintLine(scrollInfo: string): string {
		const pairs: Array<[string, string]> = [
			["tab/←→", "switch"],
			["↑↓", this.tab === "turns" ? "select" : "scroll"],
			...(this.tab === "history" ? ([["t w m a", "range"]] as Array<[string, string]>) : []),
			["r", "refresh"],
			["esc", "close"],
		];
		return (
			pairs
				.map(([key, labelText]) => `${theme.fg("dim", key)} ${theme.fg("muted", labelText)}`)
				.join(theme.fg("dim", " - ")) + (scrollInfo ? theme.fg("dim", `   ${scrollInfo}`) : "")
		);
	}

	render(width: number): string[] {
		const height = Math.max(CHROME_ROWS + 3, this.options.height());
		const body = this.bodyLines(width);
		const bodyHeight = height - CHROME_ROWS;
		const maxScroll = Math.max(0, body.length - bodyHeight);
		const offset = Math.min(this.scroll.get(this.tab) ?? 0, maxScroll);
		const visible = body.slice(offset, offset + bodyHeight);
		const rule = theme.fg("borderAccent", "─".repeat(Math.max(1, width)));
		const scrollInfo =
			body.length > bodyHeight
				? `${offset + 1}-${Math.min(body.length, offset + bodyHeight)} of ${body.length}${offset < maxScroll ? " ↓" : ""}`
				: "";
		const lines = [this.titleLine(width), this.tabLine(width), rule];
		for (const line of visible) lines.push(` ${line}`);
		while (lines.length < height - 2) lines.push("");
		lines.push(rule);
		lines.push(this.hintLine(scrollInfo));
		return lines.map((line) => truncateToWidth(line, Math.max(1, width)));
	}
}
