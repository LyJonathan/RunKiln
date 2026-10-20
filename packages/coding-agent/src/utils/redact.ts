/**
 * Secret redaction for what leaves the running process: session files, exports and decision-model requests.
 *
 * Two kinds of match:
 * - exact values: RunKiln's own keys (RUNINFRA_API_KEY, TYPESAFE_API_KEY, OPENROUTER_API_KEY, the saved runinfra.json
 *   and router-keys.json keys, auth.json tokens) and the values of environment variables whose names look like
 *   secrets (SECRET_ENV_PATTERNS plus shellEnvironment.exclude). Shown as `[secret:NAME]`.
 * - common token formats: OpenAI/Anthropic/OpenRouter `sk-`, GitHub `ghp_`/`gho_`/`ghu_`/`ghs_`/`ghr_` and
 *   `github_pat_`, GitLab `glpat-`, Slack `xox?-`, AWS `AKIA`/`ASIA` access key ids, Google `AIza`, Stripe
 *   `sk_live_`/`rk_live_`, boat `boat_`, JWTs, PEM private key blocks, `Authorization: Bearer` values and URL
 *   credentials. Shown as `[redacted:KIND]`.
 *
 * The in-memory session keeps the originals so the current turn works; only what is written or sent is redacted.
 * A resumed session therefore no longer contains the secret, and the model cannot echo a key back from it.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "../config.ts";
import { getShellEnvironmentPolicy, SECRET_ENV_PATTERNS, SHELL_SECRET_ENV_NAMES } from "./shell.ts";

/** Values shorter than this are never redacted as exact values (too many false matches). */
const MIN_EXACT_LENGTH = 8;

interface TokenPattern {
	kind: string;
	regex: RegExp;
	/** Replace only this capture group (1-based), keeping the rest of the match. */
	group?: number;
}

/** High-confidence token formats. Order matters: specific prefixes before generic ones. */
const TOKEN_PATTERNS: readonly TokenPattern[] = [
	{
		kind: "private-key",
		regex: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----|$)/g,
	},
	{ kind: "anthropic-key", regex: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
	{ kind: "openrouter-key", regex: /\bsk-or-[A-Za-z0-9_-]{20,}/g },
	{ kind: "openai-key", regex: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g },
	{ kind: "stripe-key", regex: /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}/g },
	{ kind: "github-token", regex: /\bgithub_pat_[A-Za-z0-9_]{22,}/g },
	{ kind: "github-token", regex: /\bgh[pousr]_[A-Za-z0-9]{30,}/g },
	{ kind: "gitlab-token", regex: /\bglpat-[A-Za-z0-9_-]{20,}/g },
	{ kind: "slack-token", regex: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g },
	{ kind: "aws-access-key", regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
	{ kind: "google-api-key", regex: /\bAIza[0-9A-Za-z_-]{35}/g },
	{ kind: "boat-key", regex: /\bboat_[A-Za-z0-9_-]{16,}/g },
	{ kind: "jwt", regex: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{10,}/g },
	{ kind: "bearer-token", regex: /\b(Bearer\s+)([A-Za-z0-9._~+/-]{20,}=*)/g, group: 2 },
	{ kind: "url-credentials", regex: /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)([^\s@/]{3,})(@)/gi, group: 2 },
];

export interface SecretValue {
	name: string;
	value: string;
}

function globMatches(glob: string, name: string): boolean {
	const pattern = glob
		.toUpperCase()
		.split("*")
		.map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
		.join(".*");
	return new RegExp(`^${pattern}$`).test(name.toUpperCase());
}

/** Paths and phrases (SSH_KEY_PATH=/home/me/.ssh/id, GPG_KEY_NAME="John Ly") are not secrets worth hiding. */
function looksLikePathOrText(value: string): boolean {
	return /^(?:[~/.]|[A-Za-z]:[\\/]|\\\\)/.test(value) || /\s/.test(value);
}

/** Environment variables whose values are redacted: RunKiln's keys and names that look like secrets. */
export function secretEnvValues(env: NodeJS.ProcessEnv = process.env): SecretValue[] {
	const policy = getShellEnvironmentPolicy();
	const patterns = [...SECRET_ENV_PATTERNS, ...(policy.exclude ?? [])];
	const values: SecretValue[] = [];
	for (const [name, value] of Object.entries(env)) {
		if (!value || value.length < MIN_EXACT_LENGTH || looksLikePathOrText(value)) continue;
		if (SHELL_SECRET_ENV_NAMES.has(name.toUpperCase()) || patterns.some((glob) => globMatches(glob, name))) {
			values.push({ name, value });
		}
	}
	return values;
}

const SECRET_FIELD = /key|token|secret|password|access|refresh/i;

function collectFileSecrets(value: unknown, path: string, out: SecretValue[], fileName: string, depth = 0): void {
	if (depth > 6) return;
	if (typeof value === "string") {
		const field = path.split(".").pop() ?? "";
		if (value.length >= MIN_EXACT_LENGTH && SECRET_FIELD.test(path))
			out.push({ name: `${fileName}:${field}`, value });
		return;
	}
	if (!value || typeof value !== "object") return;
	for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
		collectFileSecrets(child, path ? `${path}.${key}` : key, out, fileName, depth + 1);
	}
}

/** Keys saved in the agent folder: runinfra.json, router-keys.json and auth.json. Unreadable files are skipped. */
export function savedKeyValues(agentDir: string = getAgentDir()): SecretValue[] {
	const values: SecretValue[] = [];
	for (const file of ["runinfra.json", "router-keys.json", "auth.json"]) {
		const path = join(agentDir, file);
		if (!existsSync(path)) continue;
		try {
			const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
			// router-keys.json may hold a bare string per backend: every leaf there is a key.
			collectFileSecrets(parsed, file === "router-keys.json" ? "key" : "", values, file.replace(/\.json$/, ""));
		} catch {
			// A broken file holds nothing usable.
		}
	}
	return values;
}

let cached: { at: number; values: SecretValue[] } | undefined;
const CACHE_MS = 30_000;

/** Every exact value to redact now, longest first. Cached briefly: sessions write often. */
export function knownSecretValues(): SecretValue[] {
	const now = Date.now();
	if (cached && now - cached.at < CACHE_MS) return cached.values;
	const seen = new Set<string>();
	const values = [...secretEnvValues(), ...savedKeyValues()]
		.filter((entry) => {
			if (seen.has(entry.value)) return false;
			seen.add(entry.value);
			return true;
		})
		.sort((a, b) => b.value.length - a.value.length);
	cached = { at: now, values };
	return values;
}

/** Forget cached values (tests, and after a key is saved). */
export function resetSecretValueCache(): void {
	cached = undefined;
}

export interface RedactOptions {
	/** Exact values to redact. Defaults to knownSecretValues(). */
	values?: readonly SecretValue[];
}

/** `text` with known secret values and common token formats replaced. */
export function redactSecrets(text: string, options: RedactOptions = {}): string {
	if (!text) return text;
	let result = text;
	for (const { name, value } of options.values ?? knownSecretValues()) {
		if (value.length >= MIN_EXACT_LENGTH && result.includes(value))
			result = result.split(value).join(`[secret:${name}]`);
	}
	for (const { kind, regex, group } of TOKEN_PATTERNS) {
		regex.lastIndex = 0;
		if (!regex.test(result)) continue;
		regex.lastIndex = 0;
		result = result.replace(regex, (...match: string[]) => {
			if (!group) return `[redacted:${kind}]`;
			const parts = match.slice(1, -2);
			return parts.map((part, index) => (index + 1 === group ? `[redacted:${kind}]` : (part ?? ""))).join("");
		});
	}
	return result;
}

/** Whether `text` holds something redactSecrets would replace. */
export function containsSecret(text: string, options: RedactOptions = {}): boolean {
	return redactSecrets(text, options) !== text;
}

const MAX_DEPTH = 64;

/**
 * A deep copy of `value` with every string redacted. Image payloads (`{type: "image", data}`) are left as they are:
 * base64 never matches a token format by design of the patterns, and walking megabytes of it costs time. Objects with
 * nothing to redact are returned as they are (same reference), so callers can cheaply tell nothing changed.
 */
export function redactDeep<T>(value: T, options: RedactOptions = {}): T {
	const values = options.values ?? knownSecretValues();
	const walk = (node: unknown, depth: number): unknown => {
		if (typeof node === "string") return redactSecrets(node, { values });
		if (!node || typeof node !== "object" || depth > MAX_DEPTH) return node;
		if (Array.isArray(node)) {
			let changed = false;
			const next = node.map((item) => {
				const out = walk(item, depth + 1);
				if (out !== item) changed = true;
				return out;
			});
			return changed ? next : node;
		}
		const record = node as Record<string, unknown>;
		if (record.type === "image" && typeof record.data === "string") return node;
		let changed = false;
		const next: Record<string, unknown> = {};
		for (const [key, child] of Object.entries(record)) {
			const out = walk(child, depth + 1);
			if (out !== child) changed = true;
			next[key] = out;
		}
		return changed ? next : node;
	};
	return walk(value, 0) as T;
}

/** JSON.stringify of `value` after redactDeep. */
export function stringifyRedacted(value: unknown, options: RedactOptions = {}): string {
	return JSON.stringify(redactDeep(value, options));
}
