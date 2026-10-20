import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StdioTransport } from "../../src/core/mcp/client.ts";
import {
	filterShellEnv,
	getMcpServerBaseEnv,
	getShellEnv,
	hiddenGitHubTokenNotice,
	hiddenShellEnvNames,
	setShellEnvironmentPolicy,
} from "../../src/utils/shell.ts";

const VARS: Record<string, string> = {
	RUNINFRA_API_KEY: "rk-1",
	TYPESAFE_API_KEY: "ts-1",
	OPENROUTER_API_KEY: "or-1",
	GITHUB_TOKEN: "ghp_dummy",
	AWS_SECRET_ACCESS_KEY: "aws-1",
	DB_PASSWORD: "pw",
	MY_APP_FLAG: "1",
};
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
	for (const [name, value] of Object.entries(VARS)) {
		saved[name] = process.env[name];
		process.env[name] = value;
	}
});
afterEach(() => {
	for (const name of Object.keys(VARS)) {
		if (saved[name] === undefined) delete process.env[name];
		else process.env[name] = saved[name];
	}
	setShellEnvironmentPolicy(undefined);
});

describe("shell environment filter", () => {
	it("hides RunKiln's own keys and secret-looking names by default", () => {
		const env = getShellEnv();
		for (const name of [
			"RUNINFRA_API_KEY",
			"TYPESAFE_API_KEY",
			"OPENROUTER_API_KEY",
			"GITHUB_TOKEN",
			"AWS_SECRET_ACCESS_KEY",
			"DB_PASSWORD",
		]) {
			expect(env, name).not.toHaveProperty(name);
		}
		expect(env.MY_APP_FLAG).toBe("1");
		expect(env.PATH ?? env.Path).toBeDefined();
		expect(hiddenShellEnvNames()).toContain("GITHUB_TOKEN");
	});

	it("include is an allowlist, but never for RunKiln's own keys", () => {
		setShellEnvironmentPolicy({ include: ["github_token", "*_API_KEY"] });
		const env = getShellEnv();
		expect(env.GITHUB_TOKEN).toBe("ghp_dummy");
		expect(env).not.toHaveProperty("OPENROUTER_API_KEY");
		expect(env).not.toHaveProperty("TYPESAFE_API_KEY");
		expect(env).not.toHaveProperty("RUNINFRA_API_KEY");
	});

	it("hideSecrets false passes secret-looking names on, exclude hides more, inherit core keeps only core names", () => {
		setShellEnvironmentPolicy({ hideSecrets: false });
		expect(getShellEnv().GITHUB_TOKEN).toBe("ghp_dummy");
		expect(getShellEnv()).not.toHaveProperty("OPENROUTER_API_KEY");
		setShellEnvironmentPolicy({ exclude: ["my_app_*"] });
		expect(getShellEnv()).not.toHaveProperty("MY_APP_FLAG");
		setShellEnvironmentPolicy({ inherit: "core" });
		const core = getShellEnv();
		expect(core).not.toHaveProperty("MY_APP_FLAG");
		expect(core.PATH ?? core.Path).toBeDefined();
	});

	it("matches names case-insensitively (Windows) without changing the input", () => {
		const input = { Github_Token: "x", path: "/bin", runinfra_api_key: "k" };
		const { env, hidden } = filterShellEnv(input, {});
		expect(env).toEqual({ path: "/bin" });
		expect(hidden.sort()).toEqual(["Github_Token", "runinfra_api_key"]);
		expect(input.Github_Token).toBe("x");
	});
});

describe("MCP server environment", () => {
	it("is minimal: core variables only, no tokens or app variables", () => {
		const env = getMcpServerBaseEnv();
		expect(env).not.toHaveProperty("GITHUB_TOKEN");
		expect(env).not.toHaveProperty("MY_APP_FLAG");
		expect(env).not.toHaveProperty("OPENROUTER_API_KEY");
		expect(env.PATH ?? env.Path).toBeDefined();
	});

	it("a stdio server sees its declared env and not the user's tokens", async () => {
		const script =
			"process.stdout.write(JSON.stringify({jsonrpc:'2.0',method:'env',params:{token:process.env.GITHUB_TOKEN??null,flag:process.env.MY_APP_FLAG??null,declared:process.env.DECLARED??null}})+'\\n')";
		const transport = new StdioTransport(process.execPath, ["-e", script], {
			cwd: process.cwd(),
			env: { DECLARED: "yes" },
		});
		const message = await new Promise<unknown>((resolve, reject) => {
			transport.start(resolve, (error) => error && reject(error)).catch(reject);
			setTimeout(() => reject(new Error("timeout")), 10_000);
		});
		await transport.close();
		expect((message as { params: unknown }).params).toEqual({ token: null, flag: null, declared: "yes" });
	});
});

describe("hidden GitHub token notice", () => {
	it("names shellEnvironment.include when GITHUB_TOKEN or GH_TOKEN is set and hidden", () => {
		const env = { GITHUB_TOKEN: "ghp_x", GH_TOKEN: "ghp_y", PATH: "/bin" };
		expect(hiddenGitHubTokenNotice(env, {})).toBe(
			"GITHUB_TOKEN and GH_TOKEN are hidden from commands. To pass them to gh and git, add GITHUB_TOKEN and GH_TOKEN to shellEnvironment.include in global settings.",
		);
		expect(hiddenGitHubTokenNotice({ GH_TOKEN: "ghp_y" }, {})).toBe(
			"GH_TOKEN is hidden from commands. To pass it to gh and git, add GH_TOKEN to shellEnvironment.include in global settings.",
		);
	});

	it("says nothing when the token is unset, included or secrets are not hidden", () => {
		expect(hiddenGitHubTokenNotice({ PATH: "/bin" }, {})).toBeUndefined();
		expect(hiddenGitHubTokenNotice({ GITHUB_TOKEN: "ghp_x" }, { include: ["github_token"] })).toBeUndefined();
		expect(hiddenGitHubTokenNotice({ GITHUB_TOKEN: "ghp_x" }, { hideSecrets: false })).toBeUndefined();
		expect(hiddenGitHubTokenNotice({ GITHUB_TOKEN: "ghp_x", GH_TOKEN: "y" }, { include: ["GITHUB_TOKEN"] })).toBe(
			"GH_TOKEN is hidden from commands. To pass it to gh and git, add GH_TOKEN to shellEnvironment.include in global settings.",
		);
	});
});
