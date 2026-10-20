import { visibleWidth } from "@runkiln/tui";
import { beforeAll, describe, expect, it } from "vitest";
import { FooterComponent } from "../../src/modes/interactive/components/footer.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";

const strip = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, "");

function usage(input: number, output: number, cacheRead: number, cost: number) {
	return { input, output, cacheRead, cacheWrite: 0, totalTokens: input + output + cacheRead, cost: { total: cost } };
}

function footer(options: { permissionMode: string; autoRouting: boolean; providers?: number; classifier?: boolean }) {
	const model = { id: "deepseek-v4-1-flash", provider: "runinfra", reasoning: true, contextWindow: 1048576 };
	const entries: Array<Record<string, unknown>> = [
		{ id: "1", type: "message", message: { role: "user", content: "fix the parser" } },
		{ id: "2", type: "message", message: { role: "assistant", usage: usage(6900, 1100, 37000, 0.0024) } },
	];
	if (options.classifier)
		entries.push({
			id: "3",
			type: "usage",
			kind: "classifier",
			provider: "jev",
			model: "jev",
			usage: usage(20000, 0, 0, 0.0008),
		});
	const session = {
		sessionManager: {
			getEntryCount: () => entries.length,
			getSessionId: () => "s",
			getLeafId: () => "2",
			getEntries: () => entries,
			getCwd: () => "/home/john/code/RunKiln",
			getSessionName: () => undefined,
		},
		state: { model, thinkingLevel: "high" },
		getContextUsage: () => ({ tokens: 45000, contextWindow: 1048576, percent: 4.3 }),
		modelRuntime: { isUsingSubscription: () => false },
		isAutoRouting: options.autoRouting,
		isThinkingAuto: true,
		routerMode: "medium",
		permissionMode: options.permissionMode,
		lastRouteDecision: { source: "classifier", kind: "algo", difficulty: 0.75, escalationSteps: 1, followUp: true },
	};
	const footerData = {
		getGitBranch: () => "main",
		getAvailableProviderCount: () => options.providers ?? 1,
		getExtensionStatuses: () => new Map(),
	};
	// biome-ignore lint/suspicious/noExplicitAny: scripted session stand-in
	return new FooterComponent(session as any, footerData as any);
}

describe("footer layout", () => {
	beforeAll(() => initTheme("dark"));

	it("shows the permission badge, the cost meter and the full route reason at 80 columns", () => {
		for (const permissionMode of ["read-write", "allow-all", "ask", "auto"]) {
			const lines = footer({ permissionMode, autoRouting: true }).render(80);
			for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(80);
			const text = lines.map(strip);
			expect(text[0]).toMatch(/RunKiln \(main\)/);
			expect(text[0]).toMatch(/▸/);
			// The compact cost meter: session $ and cache hit rate (37000 / (6900 + 37000) = 84%).
			expect(text[1]).toMatch(/^\$0\.0024 - 84% cached - /);
			expect(text.join("\n")).toContain("auto:medium → deepseek-v4-1-flash - high - algo d0.75 ↑1 follow-up");
			expect(text.join("\n")).not.toContain("...");
		}
	});

	it("leaves decision-model input out of the cache hit rate, as /usage does", () => {
		const lines = footer({ permissionMode: "read-write", autoRouting: false, classifier: true }).render(120);
		// $0.0024 + $0.0008 classifier; hit stays 37000 / (6900 + 37000) = 84%, not 37000 / 63900 = 58%.
		expect(strip(lines[1])).toMatch(/^\$0\.0032 - 84% cached /);
	});

	it("keeps stats and the model on one line when they fit", () => {
		const lines = footer({ permissionMode: "read-write", autoRouting: false }).render(120);
		expect(lines).toHaveLength(2);
		expect(strip(lines[1])).toMatch(/^\$0\.0024 - 84% cached .*deepseek-v4-1-flash - high$/);
	});

	it("never overflows on narrow terminals", () => {
		for (const width of [40, 60, 72]) {
			for (const line of footer({ permissionMode: "allow-all", autoRouting: true, providers: 2 }).render(width)) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			}
		}
	});
});
