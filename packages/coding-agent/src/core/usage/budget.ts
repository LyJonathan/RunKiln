/**
 * Optional spend budgets (`budget.session`, `budget.daily` in settings, USD). At 80% RunKiln warns; at 100% it asks
 * before sending the next prompt (never a hard stop). The daily budget counts every session today (the ledger).
 */

export const BUDGET_WARN_FRACTION = 0.8;

export interface BudgetSettings {
	/** USD per session. */
	session?: number;
	/** USD per local calendar day, all sessions. */
	daily?: number;
}

export type BudgetLevel = "ok" | "warn" | "over";

export interface BudgetStatus {
	kind: "session" | "daily";
	limit: number;
	spent: number;
	fraction: number;
	level: BudgetLevel;
}

function valid(limit: number | undefined): limit is number {
	return typeof limit === "number" && Number.isFinite(limit) && limit > 0;
}

export function budgetLevel(fraction: number): BudgetLevel {
	return fraction >= 1 ? "over" : fraction >= BUDGET_WARN_FRACTION ? "warn" : "ok";
}

/** Status of each budget that is set, session first. */
export function evaluateBudgets(settings: BudgetSettings, sessionCost: number, todayCost: number): BudgetStatus[] {
	const statuses: BudgetStatus[] = [];
	if (valid(settings.session)) {
		const fraction = sessionCost / settings.session;
		statuses.push({
			kind: "session",
			limit: settings.session,
			spent: sessionCost,
			fraction,
			level: budgetLevel(fraction),
		});
	}
	if (valid(settings.daily)) {
		const fraction = todayCost / settings.daily;
		statuses.push({ kind: "daily", limit: settings.daily, spent: todayCost, fraction, level: budgetLevel(fraction) });
	}
	return statuses;
}

/** The budget closest to (or furthest past) its limit. */
export function tightestBudget(statuses: readonly BudgetStatus[]): BudgetStatus | undefined {
	return [...statuses].sort((a, b) => b.fraction - a.fraction)[0];
}

/** `$0.41 of $0.50 session budget (82%)`. */
export function describeBudget(
	status: BudgetStatus,
	money: (usd: number) => string,
	limitMoney: (usd: number) => string = money,
): string {
	const name = status.kind === "session" ? "session budget" : "daily budget";
	return `${money(status.spent)} of ${limitMoney(status.limit)} ${name} (${Math.round(status.fraction * 100)}%)`;
}

/**
 * The budget whose level rose since the last check (ok → warn, or anything → over), or undefined. `seen` keeps the
 * highest level already announced per budget, so each threshold is announced once.
 */
export function newlyCrossed(
	statuses: readonly BudgetStatus[],
	seen: Map<BudgetStatus["kind"], BudgetLevel>,
): BudgetStatus | undefined {
	const rank: Record<BudgetLevel, number> = { ok: 0, warn: 1, over: 2 };
	let crossed: BudgetStatus | undefined;
	for (const status of statuses) {
		const previous = seen.get(status.kind) ?? "ok";
		if (rank[status.level] > rank[previous]) {
			seen.set(status.kind, status.level);
			if (!crossed || rank[status.level] > rank[crossed.level]) crossed = status;
		} else if (rank[status.level] < rank[previous]) {
			// The limit was raised: announce again when it is crossed again.
			seen.set(status.kind, status.level);
		}
	}
	return crossed;
}
