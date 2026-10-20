import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBashTool, createLocalShellOperations } from "../../src/core/tools/bash.ts";
import { getShellEnv, withoutShellSecrets } from "../../src/utils/shell.ts";

const DUMMY_KEY = "dummy-runinfra-key-for-test";
let savedKey: string | undefined;

beforeEach(() => {
	savedKey = process.env.RUNINFRA_API_KEY;
	process.env.RUNINFRA_API_KEY = DUMMY_KEY;
});

afterEach(() => {
	if (savedKey === undefined) delete process.env.RUNINFRA_API_KEY;
	else process.env.RUNINFRA_API_KEY = savedKey;
});

describe("shell environment", () => {
	it("drops RUNINFRA_API_KEY from the shell env and keeps it in process.env", () => {
		expect(getShellEnv()).not.toHaveProperty("RUNINFRA_API_KEY");
		expect(process.env.RUNINFRA_API_KEY).toBe(DUMMY_KEY);
	});

	it("matches secret names case-insensitively without mutating the input", () => {
		const input = {
			runinfra_api_key: "k1",
			Runinfra_Api_Key: "k2",
			RUNINFRA_API_KEY: "k3",
			PATH: "/bin",
			RUNINFRA_API_KEY_OTHER: "kept",
		};
		expect(withoutShellSecrets(input)).toEqual({ PATH: "/bin", RUNINFRA_API_KEY_OTHER: "kept" });
		expect(input.RUNINFRA_API_KEY).toBe("k3");
	});

	it("does not pass RUNINFRA_API_KEY to the command the bash tool spawns", async () => {
		let spawnedEnv: NodeJS.ProcessEnv | undefined;
		const tool = createBashTool(process.cwd(), {
			operations: {
				exec: async (_command, _cwd, options) => {
					spawnedEnv = options.env;
					return { exitCode: 0 };
				},
			},
		});

		await tool.execute("call-1", { command: "echo hi" });

		expect(spawnedEnv).toBeDefined();
		expect(spawnedEnv).not.toHaveProperty("RUNINFRA_API_KEY");
		expect(process.env.RUNINFRA_API_KEY).toBe(DUMMY_KEY);
	});

	it("does not leak RUNINFRA_API_KEY into a real child process started without an explicit env", async () => {
		// User `!` commands pass no env, so the local shell operations fall back to getShellEnv().
		const ops = createLocalShellOperations("node", () => ({ shell: process.execPath, args: ["-e"] }));
		let output = "";
		await ops.exec(
			`process.stdout.write(process.env.RUNINFRA_API_KEY === undefined ? "absent" : "present")`,
			process.cwd(),
			{
				onData: (data) => {
					output += data.toString();
				},
			},
		);

		expect(output).toBe("absent");
		expect(process.env.RUNINFRA_API_KEY).toBe(DUMMY_KEY);
	});
});
