import type { KnownProvider, ProviderEnv } from "./types.ts";
import { getProviderEnvValue } from "./utils/provider-env.ts";

/** RunInfra is the only provider; its key comes from this variable (or the local user config). */
const PROVIDER_KEY_ENV: Record<string, string> = { runinfra: "RUNINFRA_API_KEY" };

/** Environment variables currently set that can provide an API key for a provider. */
export function findEnvKeys(provider: KnownProvider, env?: ProviderEnv): string[] | undefined;
export function findEnvKeys(provider: string, env?: ProviderEnv): string[] | undefined;
export function findEnvKeys(provider: string, env?: ProviderEnv): string[] | undefined {
	const envVar = PROVIDER_KEY_ENV[provider];
	return envVar && getProviderEnvValue(envVar, env) ? [envVar] : undefined;
}

/** API key for a provider from its environment variable. */
export function getEnvApiKey(provider: KnownProvider, env?: ProviderEnv): string | undefined;
export function getEnvApiKey(provider: string, env?: ProviderEnv): string | undefined;
export function getEnvApiKey(provider: string, env?: ProviderEnv): string | undefined {
	const envVar = PROVIDER_KEY_ENV[provider];
	return envVar ? getProviderEnvValue(envVar, env) : undefined;
}
