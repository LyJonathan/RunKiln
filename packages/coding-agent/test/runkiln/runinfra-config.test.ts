import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	hasRunInfraApiKey,
	loadRunInfraConfig,
	validateRunInfraBaseUrl,
} from "../../src/core/runkiln/runinfra-config.ts";

let dir: string | undefined;

afterEach(() => {
	if (dir) rmSync(dir, { recursive: true, force: true });
	dir = undefined;
});

function agentDir(): string {
	dir = mkdtempSync(join(tmpdir(), "runkiln-config-"));
	return dir;
}

describe("runinfra config", () => {
	it("uses the default endpoint when no file exists", () => {
		expect(loadRunInfraConfig(agentDir())).toEqual({ baseUrl: "https://api.runinfra.ai/v1" });
	});

	it("reads the endpoint and key from the agent directory", () => {
		const root = agentDir();
		writeFileSync(
			join(root, "runinfra.json"),
			JSON.stringify({ baseUrl: "https://proxy.example/v1/", apiKey: "secret-key" }),
		);
		expect(loadRunInfraConfig(root)).toMatchObject({
			baseUrl: "https://proxy.example/v1",
			apiKey: "secret-key",
		});
	});

	it("lets RUNINFRA_API_KEY satisfy the key check", () => {
		expect(hasRunInfraApiKey({ baseUrl: "https://api.runinfra.ai/v1" }, {})).toBe(false);
		expect(hasRunInfraApiKey({ baseUrl: "https://api.runinfra.ai/v1", apiKey: "file" }, {})).toBe(true);
		expect(hasRunInfraApiKey({ baseUrl: "https://api.runinfra.ai/v1" }, { RUNINFRA_API_KEY: "env" })).toBe(true);
	});

	it("allows https and loopback http, and rejects everything else", () => {
		expect(validateRunInfraBaseUrl("https://api.runinfra.ai/v1")).toBe("https://api.runinfra.ai/v1");
		expect(validateRunInfraBaseUrl("http://127.0.0.1:9/v1/")).toBe("http://127.0.0.1:9/v1");
		expect(validateRunInfraBaseUrl("http://localhost:9")).toBe("http://localhost:9");
		expect(() => validateRunInfraBaseUrl("http://evil.example/v1")).toThrow(/https/);
		expect(() => validateRunInfraBaseUrl("https://user:pass@api.runinfra.ai/v1")).toThrow(/credentials/);
		expect(() => validateRunInfraBaseUrl("not a url")).toThrow(/Invalid/);
	});

	it("rejects a file that is not an object", () => {
		const root = agentDir();
		writeFileSync(join(root, "runinfra.json"), "[]");
		expect(() => loadRunInfraConfig(root)).toThrow(/JSON object/);
	});
});
