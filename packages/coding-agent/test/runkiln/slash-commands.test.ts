import { describe, expect, it } from "vitest";
import { BUILTIN_SLASH_COMMANDS } from "../../src/core/slash-commands.ts";

describe("built-in slash commands", () => {
	it("registers every name once (/setup and the /help, /permissions, /status... set)", () => {
		const names = BUILTIN_SLASH_COMMANDS.map((command) => command.name);
		expect(names.filter((name, index) => names.indexOf(name) !== index)).toEqual([]);
		for (const name of ["help", "permissions", "status", "setup", "router", "usage", "new", "quit"]) {
			expect(names).toContain(name);
		}
	});
});
