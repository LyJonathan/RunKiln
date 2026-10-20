/**
 * Local user config for the RunInfra endpoint and key: `<agentDir>/runinfra.json`
 * (default `~/.runkiln/agent/runinfra.json`).
 *
 * This is the only place the endpoint can be changed. It is read from the user's agent
 * directory, never from a project, so a repository cannot redirect requests or supply a key.
 * The key may instead come from RUNINFRA_API_KEY, which wins when set.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { RUNINFRA_API_KEY_ENV, RUNINFRA_DEFAULT_BASE_URL } from "@runkiln/ai/providers/runinfra";
import { getAgentDir } from "../../config.ts";

export const RUNINFRA_CONFIG_FILE = "runinfra.json";

export interface RunInfraConfig {
	baseUrl: string;
	apiKey?: string;
	/** Where the config was read from, if a file exists. */
	path?: string;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** https everywhere; plain http only for loopback (local proxies and tests). */
export function validateRunInfraBaseUrl(value: string): string {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error(`Invalid RunInfra baseUrl: ${value}`);
	}
	const loopback = LOOPBACK_HOSTS.has(url.hostname);
	if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
		throw new Error(`RunInfra baseUrl must use https (http is allowed only for localhost): ${value}`);
	}
	if (url.username || url.password) throw new Error("RunInfra baseUrl must not contain credentials");
	return value.replace(/\/+$/, "");
}

export function getRunInfraConfigPath(agentDir: string = getAgentDir()): string {
	return join(agentDir, RUNINFRA_CONFIG_FILE);
}

export function loadRunInfraConfig(agentDir: string = getAgentDir()): RunInfraConfig {
	const path = getRunInfraConfigPath(agentDir);
	if (!existsSync(path)) return { baseUrl: RUNINFRA_DEFAULT_BASE_URL };
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		throw new Error(`${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${path}: expected a JSON object`);
	const config = raw as Record<string, unknown>;
	const baseUrl =
		typeof config.baseUrl === "string" && config.baseUrl.trim()
			? validateRunInfraBaseUrl(config.baseUrl.trim())
			: RUNINFRA_DEFAULT_BASE_URL;
	const apiKey = typeof config.apiKey === "string" && config.apiKey.trim() ? config.apiKey.trim() : undefined;
	return { baseUrl, apiKey, path };
}

/** True when a key is available from RUNINFRA_API_KEY or the user config. */
export function hasRunInfraApiKey(config: RunInfraConfig, env: NodeJS.ProcessEnv = process.env): boolean {
	return !!env[RUNINFRA_API_KEY_ENV]?.trim() || !!config.apiKey;
}
