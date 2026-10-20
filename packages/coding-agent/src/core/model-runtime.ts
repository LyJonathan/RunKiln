import {
	type AnyModel,
	type Api,
	type AssistantImages,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type AuthCheck,
	type AuthOperationOptions,
	type AuthResult,
	type ClassifierApi,
	type ClassifierContext,
	type ClassifierModel,
	type ClassifierResult,
	type Context,
	type Credential,
	type CredentialInfo,
	createModels,
	type DeferredHandle,
	type ImageApi,
	type ImageModel,
	type ImagesContext,
	InMemoryCredentialStore,
	type Model,
	type Models,
	type ModelsApiStreamOptions,
	type ModelsClassifierOptions,
	type ModelsDeferredCancelOptions,
	type ModelsDeferredFetchOptions,
	type ModelsImagesOptions,
	type ModelsRefreshOptions,
	type ModelsRefreshResult,
	type ModelsSimpleStreamOptions,
	type ModelType,
	type ModelTypeMap,
	type MutableModels,
	type Provider,
} from "@runkiln/ai";
import { RUNINFRA_API_KEY_ENV, RUNINFRA_PROVIDER_ID, runInfraProvider } from "@runkiln/ai/providers/runinfra";
import { getAgentDir } from "../config.ts";
import { loadRouterCatalog } from "./router/catalog.ts";
import { createAutoModels, isAutoModel, type RouterMode } from "./router/index.ts";
import {
	applyCatalogOverrides,
	type CatalogOverride,
	getLiveCatalogCachePath,
	LIVE_CATALOG_CACHE_TTL_MS,
	type LiveModelEntry,
	loadLiveCatalogCache,
	mergeLiveCatalog,
	parseLiveModels,
	saveLiveCatalogCache,
} from "./runkiln/live-catalog.ts";
import { canonicalModelId, loadModelsCatalog, type ModelsCatalog } from "./runkiln/models-catalog.ts";
import { filterDisabledModels, normalizeDisabledModels } from "./runkiln/runinfra-account.ts";
import { hasRunInfraApiKey, loadRunInfraConfig, type RunInfraConfig } from "./runkiln/runinfra-config.ts";

export type AuthStatus = {
	configured: boolean;
	source?: "environment" | "config";
	label?: string;
};

export interface CreateModelRuntimeOptions {
	/** Agent directory holding runinfra.json. Defaults to getAgentDir(). */
	agentDir?: string;
	/** Pre-loaded catalog (tests). Defaults to the bundled models.yaml. */
	catalog?: ModelsCatalog;
	/** Pre-loaded endpoint/key config (tests). Defaults to `<agentDir>/runinfra.json`. */
	runInfraConfig?: RunInfraConfig;
	/** Fetch for the live catalog (tests). */
	fetch?: typeof globalThis.fetch;
	/** Skip network (live catalog). Default: RUNKILN_OFFLINE. */
	offline?: boolean;
	/**
	 * On-disk cache of the live catalog. Default: `<agentDir>/cache/runinfra-catalog.json` when the runtime
	 * loads the bundled models.yaml itself (no `catalog` option); off otherwise. `false` turns it off.
	 */
	catalogCachePath?: string | false;
	/** How long the cached catalog stands in for a fetch (default 24 h). */
	catalogCacheTtlMs?: number;
	/**
	 * router.yaml `models.<id>.catalog` overrides (price, context, max output, reasoning efforts), applied over
	 * the live catalog and models.yaml. Default: read from the bundled + user router.yaml when the runtime
	 * loads models.yaml itself; none otherwise.
	 */
	catalogOverrides?: Record<string, CatalogOverride>;
	/** Clock (tests). */
	now?: () => number;
}

/** What the last live-catalog refresh found. */
export interface LiveCatalogStatus {
	fetchedAt?: number;
	/** "live": fetched in this process; "cache": read from the on-disk cache (fetchedAt is the cache's time). */
	source?: "live" | "cache";
	error?: string;
	/** Ids the key can call, available now. */
	available: string[];
	paused: string[];
	/** Live ids models.yaml does not list. */
	added: string[];
	/** models.yaml ids the key cannot reach. */
	missing: string[];
}

/** Availability (paused models) is re-read this often while RunKiln runs; prices and limits change rarely. */
const LIVE_CATALOG_TTL_MS = 10 * 60 * 1000;
const LIVE_CATALOG_RETRY_MS = 60 * 1000;
const LIVE_CATALOG_TIMEOUT_MS = 4000;

/** router.yaml `models.<id>.catalog` overrides (bundled + user file). A broken router.yaml yields none here. */
function readCatalogOverrides(agentDir: string): Record<string, CatalogOverride> {
	try {
		const catalog = loadRouterCatalog({ agentDir });
		const overrides: Record<string, CatalogOverride> = {};
		for (const [id, model] of Object.entries(catalog.models)) if (model.catalog) overrides[id] = model.catalog;
		return overrides;
	} catch {
		return {};
	}
}

function envOffline(): boolean {
	const value = process.env.RUNKILN_OFFLINE?.trim().toLowerCase();
	return value === "1" || value === "true" || value === "yes";
}

/**
 * RunKiln's model collection: exactly one provider (RunInfra), models from models.yaml (updated
 * from RunInfra's live catalog when it can be read), endpoint and key from the local user config
 * or RUNINFRA_API_KEY. Interactive setup writes the key; {@link login} is not that screen.
 */
export class ModelRuntime implements Models {
	readonly catalog: ModelsCatalog;
	private runInfraConfigState: RunInfraConfig;
	/** The "auto:<mode>" routing placeholders offered in model lists. Never sent to a provider. */
	private autoModels: Record<RouterMode, Model<Api>>;
	private readonly models: MutableModels;
	private readonly fetchImpl?: typeof globalThis.fetch;
	private readonly offline: boolean;
	private live?: LiveCatalogStatus;
	private liveRefresh?: Promise<LiveCatalogStatus>;
	/** Chat models the provider currently serves (models.yaml, or the live catalog once read). */
	private chatModels: readonly Model<"openai-completions">[] = [];
	/** Model ids from the `disabledModels` setting, hidden from every "available" list. */
	private disabledModelIds: string[] = [];
	private readonly cachePath?: string;
	private readonly cacheTtlMs: number;
	private readonly overrides: Record<string, CatalogOverride>;
	private readonly now: () => number;
	/** Background revalidation of a cached catalog (stale-while-revalidate). */
	private backgroundRefresh?: Promise<LiveCatalogStatus>;

	private constructor(catalog: ModelsCatalog, runInfraConfig: RunInfraConfig, options: CreateModelRuntimeOptions) {
		this.catalog = catalog;
		this.runInfraConfigState = runInfraConfig;
		this.fetchImpl = options.fetch;
		this.offline = options.offline ?? envOffline();
		this.now = options.now ?? Date.now;
		this.cacheTtlMs = options.catalogCacheTtlMs ?? LIVE_CATALOG_CACHE_TTL_MS;
		const agentDir = options.agentDir ?? getAgentDir();
		this.cachePath =
			options.catalogCachePath === false
				? undefined
				: (options.catalogCachePath ?? (options.catalog ? undefined : getLiveCatalogCachePath(agentDir)));
		this.overrides = options.catalogOverrides ?? (options.catalog ? {} : readCatalogOverrides(agentDir));
		this.models = createModels({ credentials: new InMemoryCredentialStore() });
		const base = applyCatalogOverrides(catalog.chatModels, this.overrides);
		this.setChatModels(base);
		this.autoModels = createAutoModels(base);
		this.loadCachedCatalog();
	}

	/** Startup: apply the on-disk catalog for this endpoint, if any, without touching the network. */
	private loadCachedCatalog(): void {
		if (!this.cachePath) return;
		const cache = loadLiveCatalogCache(this.cachePath, this.runInfraConfig.baseUrl);
		if (!cache) return;
		try {
			this.applyLive(cache.entries, cache.fetchedAt, "cache");
		} catch {
			// An unusable cache (no chat model) is ignored: models.yaml stays until a live fetch.
		}
	}

	/** Rebuild the model list from live entries (fetched or cached). Throws when no chat model is left. */
	private applyLive(
		entries: readonly LiveModelEntry[],
		fetchedAt: number,
		source: "live" | "cache",
	): LiveCatalogStatus {
		// An aliased id (an old model models.yaml now maps to its successor) is not offered on its own.
		const live = entries.filter((entry) => this.catalog.aliases?.[entry.id] === undefined);
		const merged = mergeLiveCatalog(this.catalog.chatModels, live, this.runInfraConfig.baseUrl);
		if (merged.models.length === 0) throw new Error("RunInfra /models lists no chat model this key can call");
		const models = applyCatalogOverrides(merged.models, this.overrides);
		this.setChatModels(models);
		this.autoModels = createAutoModels(models);
		const paused = new Set(merged.paused);
		this.live = {
			fetchedAt,
			source,
			available: models.map((model) => model.id).filter((id) => !paused.has(id)),
			paused: merged.paused,
			added: merged.added,
			missing: merged.missing,
		};
		return this.live;
	}

	get runInfraConfig(): RunInfraConfig {
		return this.runInfraConfigState;
	}

	/**
	 * Reload `runinfra.json` after setup so later requests use the saved key. The live catalog is
	 * read again on the next refresh, since the new key may reach different models.
	 */
	reloadRunInfraConfig(agentDir?: string): void {
		this.runInfraConfigState = loadRunInfraConfig(agentDir ?? getAgentDir());
		this.live = undefined;
		this.setChatModels(this.chatModels);
	}

	static async create(options: CreateModelRuntimeOptions = {}): Promise<ModelRuntime> {
		const catalog = options.catalog ?? loadModelsCatalog();
		const runInfraConfig = options.runInfraConfig ?? loadRunInfraConfig(options.agentDir ?? getAgentDir());
		return new ModelRuntime(catalog, runInfraConfig, options);
	}

	private setChatModels(models: readonly Model<"openai-completions">[]): void {
		this.chatModels = models;
		this.models.setProvider(
			runInfraProvider({ models, baseUrl: this.runInfraConfig.baseUrl, apiKey: this.runInfraConfig.apiKey }),
		);
	}

	/** The "auto" placeholder for a routing mode (default medium). */
	autoModelFor(mode: RouterMode = "medium"): Model<Api> {
		return this.autoModels[mode];
	}

	/** The "auto:medium" placeholder. */
	get autoModel(): Model<Api> {
		return this.autoModels.medium;
	}

	get liveCatalogStatus(): LiveCatalogStatus | undefined {
		return this.live;
	}

	/**
	 * Reads RunInfra's live catalog (GET /models) and rebuilds the model list from it: models.yaml
	 * entries the key can reach, with live prices and limits, plus new live models. On failure the
	 * models.yaml list stays and the error is kept in liveCatalogStatus.
	 */
	async refreshLiveCatalog(options: { signal?: AbortSignal; force?: boolean } = {}): Promise<LiveCatalogStatus> {
		const now = this.now();
		if (!options.force && this.live?.fetchedAt !== undefined) {
			const age = now - this.live.fetchedAt;
			// A cached catalog younger than the cache TTL answers at once (startup never waits on the
			// network); once it is older than the availability TTL it is revalidated in the background.
			if (this.live.source === "cache" && !this.live.error && age < this.cacheTtlMs) {
				if (age >= LIVE_CATALOG_TTL_MS && !this.liveRefresh && !this.backgroundRefresh) {
					this.backgroundRefresh = this.fetchLiveCatalog().finally(() => {
						this.backgroundRefresh = undefined;
					});
				}
				return this.live;
			}
			if (age < (this.live.error ? LIVE_CATALOG_RETRY_MS : LIVE_CATALOG_TTL_MS)) return this.live;
		}
		if (this.liveRefresh) return this.liveRefresh;
		this.liveRefresh = this.fetchLiveCatalog(options.signal).finally(() => {
			this.liveRefresh = undefined;
		});
		return this.liveRefresh;
	}

	private async fetchLiveCatalog(signal?: AbortSignal): Promise<LiveCatalogStatus> {
		const empty = { available: [], paused: [], added: [], missing: [] };
		const apiKey = process.env[RUNINFRA_API_KEY_ENV]?.trim() || this.runInfraConfig.apiKey;
		if (this.offline || !apiKey) {
			// A cached catalog stays in use offline; only its status records why it was not refreshed.
			const status: LiveCatalogStatus = {
				...(this.live ?? empty),
				fetchedAt: this.live?.fetchedAt ?? this.now(),
				error: this.offline ? "offline" : "no RunInfra key",
			};
			this.live = status;
			return status;
		}
		try {
			const timeout = AbortSignal.timeout(LIVE_CATALOG_TIMEOUT_MS);
			const response = await (this.fetchImpl ?? globalThis.fetch)(`${this.runInfraConfig.baseUrl}/models`, {
				headers: { Authorization: `Bearer ${apiKey}` },
				signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
			});
			if (!response.ok) throw new Error(`RunInfra /models ${response.status}`);
			const entries = parseLiveModels((await response.json()) as unknown);
			const fetchedAt = this.now();
			const status = this.applyLive(entries, fetchedAt, "live");
			if (this.cachePath) saveLiveCatalogCache(this.cachePath, this.runInfraConfig.baseUrl, entries, fetchedAt);
			return status;
		} catch (error) {
			// Keep whatever list is in use (live, cached or models.yaml); retry after LIVE_CATALOG_RETRY_MS.
			const status: LiveCatalogStatus = {
				...(this.live ?? empty),
				fetchedAt: this.now(),
				error: error instanceof Error ? error.message : String(error),
			};
			this.live = status;
			return status;
		}
	}

	getProviders(): readonly Provider[] {
		return this.models.getProviders();
	}

	getProvider(providerId: string): Provider | undefined {
		return this.models.getProvider(providerId);
	}

	getModels(providerId?: string): readonly Model<Api>[] {
		return this.models.getModels(providerId);
	}

	getModel(providerId: string, modelId: string): Model<Api> | undefined {
		return this.models.getModel(providerId, this.canonicalId(modelId));
	}

	/** Catalog model by id (RunInfra is the only provider); an alias resolves to its model. */
	getModelById(modelId: string): Model<Api> | undefined {
		return this.models.getModel(RUNINFRA_PROVIDER_ID, this.canonicalId(modelId));
	}

	/** `modelId`, or the model a models.yaml alias stands for (an old id kept working after a refresh). */
	canonicalId(modelId: string): string {
		return this.catalog.aliases ? canonicalModelId(this.catalog, modelId) : modelId;
	}

	getModelsOfType<TType extends ModelType>(type: TType, providerId?: string): readonly ModelTypeMap[TType][] {
		return this.models.getModelsOfType(type, providerId);
	}

	getModelOfType<TType extends ModelType>(
		type: TType,
		providerId: string,
		modelId: string,
	): ModelTypeMap[TType] | undefined {
		return this.models.getModelOfType(type, providerId, modelId);
	}

	getAllModels(providerId?: string): readonly AnyModel[] {
		return this.models.getAllModels(providerId);
	}

	getAvailableOfType<TType extends ModelType>(
		type: TType,
		providerId?: string,
		options?: AuthOperationOptions,
	): Promise<readonly ModelTypeMap[TType][]> {
		return this.models.getAvailableOfType(type, providerId, options);
	}

	getAllAvailable(providerId?: string, options?: AuthOperationOptions): Promise<readonly AnyModel[]> {
		return this.models.getAllAvailable(providerId, options);
	}

	checkAuth(providerId: string, options?: AuthOperationOptions): Promise<AuthCheck | undefined> {
		return this.models.checkAuth(providerId, options);
	}

	async getAvailable(providerId?: string, _options?: AuthOperationOptions): Promise<readonly Model<Api>[]> {
		return this.getAvailableSnapshot().filter((model) => !providerId || model.provider === providerId);
	}

	/**
	 * Catalog models when a RunInfra key is configured, otherwise none, followed by the "auto"
	 * routing entries. Models in `disabledModels` are left out, so the selector, cycling, `/model`
	 * and `--list-models` skip them; the "auto" entries always stay. Lookups by id ({@link getModel},
	 * {@link getModelById}) still find disabled models. Use getRoutableModels() for concrete models only.
	 */
	getAvailableSnapshot(): readonly Model<Api>[] {
		if (!this.hasConfiguredAuth(RUNINFRA_PROVIDER_ID)) return [];
		const models = filterDisabledModels(this.models.getModels(), this.disabledModelIds);
		return models.length > 0 ? [...models, ...Object.values(this.autoModels)] : [];
	}

	/**
	 * Concrete models the router may pick: every catalog model with a configured key, minus models the
	 * live catalog reports as paused (no "auto" entries). The session's router filter drops
	 * `disabledModels` on top of this.
	 */
	getRoutableModels(): readonly Model<Api>[] {
		if (!this.hasConfiguredAuth(RUNINFRA_PROVIDER_ID)) return [];
		const paused = new Set(this.live?.error ? [] : (this.live?.paused ?? []));
		return this.models.getModels().filter((model) => !paused.has(model.id));
	}

	/** Apply the `disabledModels` setting. */
	setDisabledModels(modelIds: readonly string[]): void {
		this.disabledModelIds = normalizeDisabledModels([...modelIds]);
	}

	getDisabledModels(): readonly string[] {
		return this.disabledModelIds;
	}

	getError(): string | undefined {
		return undefined;
	}

	isUsingOAuth(_providerId: string): boolean {
		return false;
	}

	isUsingSubscription(_providerId: string): boolean {
		return false;
	}

	hasConfiguredAuth(providerId: string): boolean {
		return providerId === RUNINFRA_PROVIDER_ID && hasRunInfraApiKey(this.runInfraConfig);
	}

	getAuth(providerId: string, overrides?: AuthOperationOptions): Promise<AuthResult | undefined>;
	getAuth(model: AnyModel, overrides?: AuthOperationOptions): Promise<AuthResult | undefined>;
	getAuth(providerOrModel: string | AnyModel, overrides?: AuthOperationOptions): Promise<AuthResult | undefined> {
		return typeof providerOrModel === "string"
			? this.models.getAuth(providerOrModel, overrides)
			: this.models.getAuth(providerOrModel, overrides);
	}

	async listCredentials(_options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
		return [];
	}

	getProviderAuthStatus(providerId: string): AuthStatus {
		if (providerId !== RUNINFRA_PROVIDER_ID) return { configured: false };
		if (process.env[RUNINFRA_API_KEY_ENV]?.trim()) {
			return { configured: true, source: "environment", label: RUNINFRA_API_KEY_ENV };
		}
		if (this.runInfraConfig.apiKey) return { configured: true, source: "config", label: this.runInfraConfig.path };
		return { configured: false };
	}

	stream<TApi extends Api>(
		model: Model<TApi>,
		context: Context,
		options?: ModelsApiStreamOptions<TApi>,
	): AssistantMessageEventStream {
		return this.models.stream(model, context, options);
	}

	complete<TApi extends Api>(
		model: Model<TApi>,
		context: Context,
		options?: ModelsApiStreamOptions<TApi>,
	): Promise<AssistantMessage> {
		return this.models.complete(model, context, options);
	}

	streamSimple(model: Model<Api>, context: Context, options?: ModelsSimpleStreamOptions): AssistantMessageEventStream {
		if (isAutoModel(model)) {
			throw new Error(
				'"auto" is a routing mode, not a model; the session resolves it to a concrete model per request',
			);
		}
		return this.models.streamSimple(model, context, options);
	}

	completeSimple(model: Model<Api>, context: Context, options?: ModelsSimpleStreamOptions): Promise<AssistantMessage> {
		return this.models.completeSimple(model, context, options);
	}

	streamDeferred(
		model: Model<Api>,
		handle: DeferredHandle,
		options?: ModelsDeferredFetchOptions,
	): AssistantMessageEventStream {
		return this.models.streamDeferred(model, handle, options);
	}

	fetchDeferred(
		model: Model<Api>,
		handle: DeferredHandle,
		options?: ModelsDeferredFetchOptions,
	): Promise<AssistantMessage> {
		return this.models.fetchDeferred(model, handle, options);
	}

	cancelDeferred(model: Model<Api>, handle: DeferredHandle, options?: ModelsDeferredCancelOptions): Promise<void> {
		return this.models.cancelDeferred(model, handle, options);
	}

	generateImages(
		model: ImageModel<ImageApi>,
		context: ImagesContext,
		options?: ModelsImagesOptions,
	): Promise<AssistantImages> {
		return this.models.generateImages(model, context, options);
	}

	classify(
		model: ClassifierModel<ClassifierApi>,
		context: ClassifierContext,
		options?: ModelsClassifierOptions,
	): Promise<ClassifierResult> {
		return this.models.classify(model, context, options);
	}

	async login(): Promise<Credential> {
		throw new Error(
			`RunKiln has no login flow. Set ${RUNINFRA_API_KEY_ENV} or put "apiKey" in ${this.runInfraConfig.path ?? "~/.runkiln/agent/runinfra.json"}.`,
		);
	}

	async logout(): Promise<void> {}

	/** Refreshes the live RunInfra catalog (see refreshLiveCatalog). */
	async refresh(options: ModelsRefreshOptions = {}): Promise<ModelsRefreshResult> {
		if (options.allowNetwork === false) return { aborted: false, errors: new Map() };
		const status = await this.refreshLiveCatalog({ signal: options.signal, force: options.force });
		const errors = new Map<string, Error>();
		if (status.error && status.error !== "offline" && status.error !== "no RunInfra key") {
			errors.set(RUNINFRA_PROVIDER_ID, new Error(status.error));
		}
		return { aborted: options.signal?.aborted ?? false, errors };
	}

	/** Every catalog model is a physical model. */
	getPhysicalModel(providerId: string, modelId: string): Model<Api> | undefined {
		return this.getModel(providerId, modelId);
	}
}
