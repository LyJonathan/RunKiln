/**
 * Scripted footer scenarios. `footer-default-golden.json` holds what the footer rendered for each of them before
 * it became configurable (main c793bf3): the default layout (no `footer.items`) must render them byte for byte.
 */
import { join } from "node:path";
import { getThemesDir } from "../../src/config.ts";
import { FooterComponent } from "../../src/modes/interactive/components/footer.ts";
import { loadThemeFromPath, setThemeInstance } from "../../src/modes/interactive/theme/theme.ts";

/** The dark theme in truecolor, whatever the terminal running the tests reports. */
export function useTruecolorTheme(name = "dark"): void {
	setThemeInstance(loadThemeFromPath(join(getThemesDir(), `${name}.json`), "truecolor"));
}

export interface FooterScenario {
	name: string;
	permissionMode?: string;
	autoRouting?: boolean;
	thinkingAuto?: boolean;
	decision?: "none" | "ok" | "error";
	providers?: number;
	reasoning?: boolean;
	thinkingLevel?: string;
	noModel?: boolean;
	branch?: string | null;
	sessionName?: string;
	cwd?: string;
	statuses?: Record<string, string>;
	budget?: "none" | "ok" | "warn" | "over";
	subscription?: boolean;
	contextPercent?: number | null;
	noUsage?: boolean;
	autoCompact?: boolean;
}

function usage(input: number, output: number, cacheRead: number, cost: number) {
	return { input, output, cacheRead, cacheWrite: 0, totalTokens: input + output + cacheRead, cost: { total: cost } };
}

export const FOOTER_SCENARIOS: FooterScenario[] = [
	{ name: "manual" },
	{ name: "auto-route", autoRouting: true },
	{ name: "auto-route-pending", autoRouting: true, decision: "none" },
	{ name: "auto-route-error", autoRouting: true, decision: "error" },
	{ name: "auto-pinned-thinking", autoRouting: true, thinkingAuto: false },
	{ name: "allow-all", permissionMode: "allow-all", autoRouting: true, providers: 2 },
	{ name: "ask", permissionMode: "ask" },
	{ name: "plan", permissionMode: "plan" },
	{ name: "auto-perm", permissionMode: "auto" },
	{ name: "two-providers", providers: 2 },
	{ name: "no-reasoning", reasoning: false },
	{ name: "thinking-off", thinkingLevel: "off" },
	{ name: "no-model", noModel: true },
	{ name: "no-branch", branch: null },
	{ name: "session-name", sessionName: "parser fix" },
	{ name: "outside-home", cwd: "/srv/app/very/long/path/to/the/project/repository" },
	{ name: "statuses", statuses: { jobs: "2 jobs (/jobs)", zeta: "z-ext ok", alpha: "lint\tclean\n" } },
	{ name: "budget-ok", budget: "ok" },
	{ name: "budget-warn", budget: "warn" },
	{ name: "budget-over", budget: "over" },
	{ name: "subscription", subscription: true },
	{ name: "subscription-no-usage", subscription: true, noUsage: true },
	{ name: "no-usage", noUsage: true },
	{ name: "context-unknown", contextPercent: null },
	{ name: "context-warn", contextPercent: 75.25 },
	{ name: "context-error", contextPercent: 95.5 },
	{ name: "no-autocompact", autoCompact: false },
	{
		name: "everything",
		permissionMode: "allow-all",
		autoRouting: true,
		providers: 3,
		sessionName: "big refactor",
		statuses: { jobs: "job: npm test", tests: "tests ✓ 412" },
		budget: "warn",
		contextPercent: 81,
	},
];

export const FOOTER_WIDTHS = [12, 24, 40, 60, 72, 80, 100, 120, 160, 220];

export interface FooterStandIns {
	session: any;
	footerData: any;
}

export function footerStandIns(scenario: FooterScenario, extra: Record<string, unknown> = {}): FooterStandIns {
	const model = scenario.noModel
		? undefined
		: {
				id: "deepseek-v4-1-flash",
				provider: "runinfra",
				reasoning: scenario.reasoning ?? true,
				contextWindow: 1048576,
			};
	const entries: Array<Record<string, unknown>> = [
		{ id: "1", type: "message", message: { role: "user", content: "fix the parser" } },
	];
	if (!scenario.noUsage)
		entries.push({
			id: "2",
			type: "message",
			message: { role: "assistant", usage: usage(6900, 1100, 37000, 0.0024) },
		});
	const budgetLevel = scenario.budget ?? "none";
	const budgets =
		budgetLevel === "none"
			? []
			: [
					{
						kind: "session",
						limit: 0.5,
						spent: budgetLevel === "over" ? 0.6 : budgetLevel === "warn" ? 0.45 : 0.1,
						level: budgetLevel === "ok" ? "ok" : budgetLevel,
						fraction: budgetLevel === "over" ? 1.2 : budgetLevel === "warn" ? 0.9 : 0.2,
					},
				];
	const contextPercent = scenario.contextPercent === undefined ? 4.3 : scenario.contextPercent;
	const decision =
		scenario.decision === "none"
			? undefined
			: {
					source: "classifier",
					kind: "algo",
					difficulty: 0.75,
					escalationSteps: 1,
					followUp: true,
					...(scenario.decision === "error" ? { error: "classifier timeout" } : {}),
				};
	const session = {
		sessionManager: {
			getEntryCount: () => entries.length,
			getSessionId: () => "s",
			getLeafId: () => String(entries.length),
			getEntries: () => entries,
			getCwd: () => scenario.cwd ?? "/home/john/code/RunKiln",
			getSessionName: () => scenario.sessionName,
		},
		state: { model, thinkingLevel: scenario.thinkingLevel ?? "high" },
		model,
		getContextUsage: () => ({
			tokens: 45000,
			contextWindow: 1048576,
			percent: contextPercent,
		}),
		getBudgetStatuses: () => budgets,
		modelRuntime: { isUsingSubscription: () => scenario.subscription ?? false },
		isAutoRouting: scenario.autoRouting ?? false,
		isThinkingAuto: scenario.thinkingAuto ?? true,
		routerMode: "medium",
		permissionMode: scenario.permissionMode ?? "read-write",
		lastRouteDecision: decision,
		...extra,
	};
	const footerData = {
		getGitBranch: () => (scenario.branch === undefined ? "main" : scenario.branch),
		getAvailableProviderCount: () => scenario.providers ?? 1,
		getExtensionStatuses: () => new Map(Object.entries(scenario.statuses ?? {})),
	};
	return { session, footerData };
}

export function scenarioFooter(scenario: FooterScenario): FooterComponent {
	const { session, footerData } = footerStandIns(scenario);
	const footer = new FooterComponent(session, footerData);
	if (scenario.autoCompact === false) footer.setAutoCompactEnabled(false);
	return footer;
}

/** Every scenario at every width: `{ "<name>@<width>": lines }`. */
export function renderFooterMatrix(): Record<string, string[]> {
	const result: Record<string, string[]> = {};
	for (const scenario of FOOTER_SCENARIOS) {
		for (const width of FOOTER_WIDTHS) {
			result[`${scenario.name}@${width}`] = scenarioFooter(scenario).render(width);
		}
	}
	return result;
}
