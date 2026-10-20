import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createBashTool } from "../../src/core/tools/bash.ts";
import { condenseOutput, isErrorLikeLine } from "../../src/core/tools/condense-output.ts";
import { formatCacheHitRate, formatCost } from "../../src/modes/interactive/components/footer.ts";

function log(lines: number, errorsAt: number[] = []): string {
	const out: string[] = [];
	for (let i = 1; i <= lines; i++) {
		out.push(errorsAt.includes(i) ? `src/app.ts(${i},3): error TS2345: bad argument on line ${i}` : `ok ${i}`);
	}
	return `${out.join("\n")}\n`;
}

describe("condensing long command output", () => {
	it("leaves short output alone", () => {
		const short = log(50);
		const result = condenseOutput(short);
		expect(result.condensed).toBe(false);
		expect(result.text).toBe(short);
	});

	it("keeps the head, the tail and the error-looking lines from the middle, with a note", () => {
		const result = condenseOutput(log(5000, [1234, 2500]), { fullOutputPath: "/tmp/full.log" });
		expect(result.condensed).toBe(true);
		const lines = result.text.split("\n");
		expect(lines[0]).toBe("ok 1");
		expect(lines).toContain("ok 40");
		expect(lines).not.toContain("ok 41");
		expect(lines).toContain("1234: src/app.ts(1234,3): error TS2345: bad argument on line 1234");
		expect(lines).toContain("2500: src/app.ts(2500,3): error TS2345: bad argument on line 2500");
		expect(lines).not.toContain("ok 3000");
		expect(lines).toContain("ok 4881");
		expect(lines).toContain("ok 5000");
		expect(result.text).toContain("[... lines 41-4880 omitted (4840 lines); error-looking lines from them:]");
		expect(lines.at(-1)).toBe(
			"[Output condensed: 5000 lines, 38.1KB. Kept the first 40 lines, the last 120 lines and 2 error-looking lines from the middle. Full output: /tmp/full.log]",
		);
		expect(Buffer.byteLength(result.text)).toBeLessThan(4 * 1024);
	});

	it("stays within the byte budget when lines are very long", () => {
		const wide = `${Array.from({ length: 2000 }, (_, i) => `${i} ${"x".repeat(1000)}`).join("\n")}\n`;
		const result = condenseOutput(wide);
		expect(result.condensed).toBe(true);
		expect(Buffer.byteLength(result.text)).toBeLessThan(26 * 1024);
		expect(result.text).toContain("chars clipped]");
	});

	it("recognizes common failure lines", () => {
		for (const line of [
			"FAIL test/a.test.ts > adds",
			"npm ERR! code ELIFECYCLE",
			"Traceback (most recent call last):",
			"    at Object.<anonymous> (/repo/src/a.ts:10:5)",
			"thread 'main' panicked at src/main.rs:2:5",
			"✗ builds the bundle",
		]) {
			expect(isErrorLikeLine(line), line).toBe(true);
		}
		expect(isErrorLikeLine("compiled 120 modules")).toBe(false);
	});

	it("the bash tool returns the condensed view and saves the full output", async () => {
		const bash = createBashTool(process.cwd());
		const result = await bash.execute("call-1", {
			command:
				'for i in $(seq 1 3000); do if [ $i -eq 1500 ]; then echo "FAILED test $i"; else echo "line $i"; fi; done',
		});
		const text = result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
		expect(text.split("\n")[0]).toBe("line 1");
		expect(text).toContain("1500: FAILED test 1500");
		expect(text).toContain("line 3000");
		expect(text).not.toContain("line 2000\n");
		const note = text.split("\n").at(-1) ?? "";
		expect(note).toMatch(/^\[Output condensed: 3000 lines, .* Full output: (.+\.log)\]$/);
		const fullPath = note.match(/Full output: (.+\.log)\]$/)?.[1] ?? "";
		expect(existsSync(fullPath)).toBe(true);
		expect(readFileSync(fullPath, "utf-8").split("\n")).toHaveLength(3001);
	});
});

describe("footer cost meter", () => {
	it("shows sub-cent amounts with four decimals and the session cache-hit rate", () => {
		expect(formatCost(0.00213)).toBe("$0.0021");
		expect(formatCost(0.0342)).toBe("$0.034");
		expect(formatCost(0)).toBe("$0.000");
		expect(formatCacheHitRate({ input: 900, cacheRead: 9100, cacheWrite: 0 })).toBe("hit 91%");
		expect(formatCacheHitRate({ input: 900, cacheRead: 0, cacheWrite: 0 })).toBeUndefined();
	});
});
