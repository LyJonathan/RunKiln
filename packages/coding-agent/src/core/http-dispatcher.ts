import { EventEmitter } from "node:events";
import type * as Undici from "undici";

export const DEFAULT_HTTP_IDLE_TIMEOUT_MS = 300_000;
/**
 * How long an idle connection stays open for reuse. Undici's default (4 s) closes it during any
 * pause longer than that (the user typing, a slow test run), and the next request then pays a new
 * TCP + TLS handshake: ~400 ms more time to first token measured against api.runinfra.ai. RunInfra
 * kept idle connections open for at least 90 s in testing.
 */
export const HTTP_KEEP_ALIVE_TIMEOUT_MS = 90_000;
// Node's 250ms default can terminate valid connection attempts on high-latency routes.
const DEFAULT_AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS = 2_000;

export const HTTP_IDLE_TIMEOUT_CHOICES = [
	{ label: "30 sec", timeoutMs: 30_000 },
	{ label: "1 min", timeoutMs: 60_000 },
	{ label: "2 min", timeoutMs: 120_000 },
	{ label: "5 min", timeoutMs: 300_000 },
	{ label: "disabled", timeoutMs: 0 },
] as const;

const originalGlobalFetch = globalThis.fetch;
/** undici, loaded on first use: about 35 ms of module evaluation that commands without HTTP never pay. */
let undiciModule: typeof Undici | undefined;

async function loadUndici(): Promise<typeof Undici> {
	if (!undiciModule) {
		// CommonJS: the bundle's dynamic import exposes it as the default export only.
		const loaded = (await import("undici")) as typeof Undici & { default?: typeof Undici };
		undiciModule = typeof loaded.EnvHttpProxyAgent === "function" ? loaded : (loaded.default ?? loaded);
	}
	return undiciModule;
}
let installedGlobalFetch: typeof globalThis.fetch | undefined;

export function parseHttpIdleTimeoutMs(value: unknown): number | undefined {
	if (typeof value === "string") {
		const trimmed = value.trim();
		if (trimmed.toLowerCase() === "disabled") {
			return 0;
		}
		if (trimmed.length === 0) {
			return undefined;
		}
		return parseHttpIdleTimeoutMs(Number(trimmed));
	}

	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		return undefined;
	}
	return Math.floor(value);
}

export function formatHttpIdleTimeoutMs(timeoutMs: number): string {
	const choice = HTTP_IDLE_TIMEOUT_CHOICES.find((item) => item.timeoutMs === timeoutMs);
	if (choice) {
		return choice.label;
	}
	return `${timeoutMs / 1000} sec`;
}

export function applyHttpProxySettings(httpProxy: string | undefined): void {
	const proxy = httpProxy?.trim();
	if (!proxy) return;
	process.env.HTTP_PROXY ??= proxy;
	process.env.HTTPS_PROXY ??= proxy;
}

const ignoreUndiciDispatcherError = (_error: unknown): void => {};

// Undici can emit an internal Client "error" while terminating a mid-stream
// fetch body. The body stream still rejects through reader.read(); this listener
// only prevents EventEmitter's unhandled "error" special case from crashing RunKiln.
function withUndiciErrorListener<T extends Undici.Dispatcher>(dispatcher: T): T {
	if (dispatcher instanceof EventEmitter) {
		EventEmitter.prototype.on.call(dispatcher, "error", ignoreUndiciDispatcherError);
	}
	return dispatcher;
}

function createUndiciClient(origin: string | URL, options: object): Undici.Dispatcher {
	return withUndiciErrorListener(new undiciModule!.Client(origin, options as Undici.Client.Options));
}

function createUndiciOriginDispatcher(origin: string | URL, options: object): Undici.Dispatcher {
	const dispatcherOptions = options as Undici.Pool.Options;
	if (dispatcherOptions.connections === 1) {
		return createUndiciClient(origin, dispatcherOptions);
	}
	return withUndiciErrorListener(
		new undiciModule!.Pool(origin, {
			...dispatcherOptions,
			factory: createUndiciClient,
		}),
	);
}

/** Installs the tuned undici dispatcher (and its fetch) globally; loads undici on the first call. */
export async function configureHttpDispatcher(timeoutMs: number = DEFAULT_HTTP_IDLE_TIMEOUT_MS): Promise<void> {
	const normalizedTimeoutMs = parseHttpIdleTimeoutMs(timeoutMs);
	if (normalizedTimeoutMs === undefined) {
		throw new Error(`Invalid HTTP idle timeout: ${String(timeoutMs)}`);
	}
	const undici = await loadUndici();
	const dispatcher = withUndiciErrorListener(
		new undici.EnvHttpProxyAgent({
			allowH2: false,
			// Keep HTTP origins on CONNECT tunnels as they were before Undici 8.7.
			proxyTunnel: true,
			bodyTimeout: normalizedTimeoutMs,
			connect: {
				autoSelectFamilyAttemptTimeout: DEFAULT_AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS,
			},
			headersTimeout: normalizedTimeoutMs,
			keepAliveTimeout: HTTP_KEEP_ALIVE_TIMEOUT_MS,
			keepAliveMaxTimeout: HTTP_KEEP_ALIVE_TIMEOUT_MS,
			clientFactory: createUndiciClient,
			factory: createUndiciOriginDispatcher,
		}),
	);
	undici.setGlobalDispatcher(dispatcher);
	// Keep fetch and the dispatcher on the same undici implementation. Node 26.0's
	// bundled fetch can otherwise consume compressed responses through npm undici's
	// dispatcher without decompressing them, causing response.json() failures.
	// If a caller replaced fetch after module load, preserve that deliberate override.
	const shouldInstallGlobals =
		installedGlobalFetch === undefined
			? globalThis.fetch === originalGlobalFetch
			: globalThis.fetch === installedGlobalFetch;
	if (shouldInstallGlobals) {
		undici.install?.();
		installedGlobalFetch = globalThis.fetch;
	}
}

/**
 * Opens (and pools) a connection to `baseUrl` ahead of the first request, so the TCP + TLS
 * handshake overlaps startup instead of delaying the first token. An unauthenticated GET of
 * `/models` (answered 401, nothing billed); every failure is ignored.
 */
export function preconnect(baseUrl: string, timeoutMs = 5_000): void {
	if (!/^https?:\/\//.test(baseUrl)) return;
	void fetch(`${baseUrl.replace(/\/+$/, "")}/models`, { method: "GET", signal: AbortSignal.timeout(timeoutMs) })
		.then((response) => response.body?.cancel())
		.catch(() => {});
}
