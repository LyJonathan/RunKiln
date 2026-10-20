import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import type { ApiKeyAuth } from "../auth/types.ts";
import { createProvider, type Provider } from "../models.ts";
import type { Model } from "../types.ts";

/** The only provider RunKiln talks to. */
export const RUNINFRA_PROVIDER_ID = "runinfra";
export const RUNINFRA_DEFAULT_BASE_URL = "https://api.runinfra.ai/v1";
export const RUNINFRA_API_KEY_ENV = "RUNINFRA_API_KEY";

export interface RunInfraProviderOptions {
	/** Chat models, built by the app from models.yaml. Their `baseUrl` is overwritten with `baseUrl`. */
	models: readonly Model<"openai-completions">[];
	/** Endpoint from the local user config. Defaults to {@link RUNINFRA_DEFAULT_BASE_URL}. */
	baseUrl?: string;
	/** Key from the local user config. `RUNINFRA_API_KEY` wins when set. */
	apiKey?: string;
}

/**
 * Resolves the RunInfra key: `RUNINFRA_API_KEY` from the environment first, then the key from
 * the local user config. Stored credentials and other env vars are never consulted.
 */
function runInfraApiKeyAuth(configKey: string | undefined): ApiKeyAuth {
	return {
		name: "RunInfra API key",
		resolve: async ({ ctx, signal }) => {
			signal.throwIfAborted();
			const envKey = await ctx.env(RUNINFRA_API_KEY_ENV);
			if (envKey) return { auth: { apiKey: envKey }, source: RUNINFRA_API_KEY_ENV };
			if (configKey) return { auth: { apiKey: configKey }, source: "runinfra config" };
			return undefined;
		},
	};
}

export function runInfraProvider(options: RunInfraProviderOptions): Provider<"openai-completions"> {
	const baseUrl = options.baseUrl || RUNINFRA_DEFAULT_BASE_URL;
	return createProvider({
		id: RUNINFRA_PROVIDER_ID,
		name: "RunInfra",
		baseUrl,
		auth: { apiKey: runInfraApiKeyAuth(options.apiKey) },
		models: options.models.map((model) => ({ ...model, provider: RUNINFRA_PROVIDER_ID, baseUrl })),
		api: openAICompletionsApi(),
	});
}
