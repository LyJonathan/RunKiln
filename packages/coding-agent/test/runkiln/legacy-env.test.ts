import { describe, expect, it } from "vitest";
import { applyLegacyEnv } from "../../src/legacy-env.ts";

describe("applyLegacyEnv", () => {
	it("copies a legacy PI_* value into an unset RUNKILN_* variable", () => {
		const env: NodeJS.ProcessEnv = { PI_CODING_AGENT_DIR: "/old/agent", PI_OFFLINE: "1" };
		expect(applyLegacyEnv(env).sort()).toEqual(["RUNKILN_CODING_AGENT_DIR", "RUNKILN_OFFLINE"]);
		expect(env.RUNKILN_CODING_AGENT_DIR).toBe("/old/agent");
		expect(env.RUNKILN_OFFLINE).toBe("1");
	});

	it("never overrides a RUNKILN_* variable that is already set", () => {
		const env: NodeJS.ProcessEnv = { PI_CODING_AGENT_DIR: "/old/agent", RUNKILN_CODING_AGENT_DIR: "/new/agent" };
		expect(applyLegacyEnv(env)).toEqual([]);
		expect(env.RUNKILN_CODING_AGENT_DIR).toBe("/new/agent");
	});

	it("ignores PI_* variables that are not legacy RunKiln settings", () => {
		const env: NodeJS.ProcessEnv = { PI_SESSION_ID: "parent", PI_UNRELATED: "x" };
		expect(applyLegacyEnv(env)).toEqual([]);
		expect(env.RUNKILN_SESSION_ID).toBeUndefined();
	});
});
