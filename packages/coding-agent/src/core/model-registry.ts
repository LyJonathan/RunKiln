import type {
	Api,
	AssistantImages,
	AssistantMessage,
	AssistantMessageEventStream,
	AuthOperationOptions,
	AuthResult,
	ClassifierApi,
	ClassifierContext,
	ClassifierModel,
	ClassifierResult,
	Context,
	ImageApi,
	ImageModel,
	ImagesContext,
	Model,
	ModelsApiStreamOptions,
	ModelsClassifierOptions,
	ModelsImagesOptions,
	ModelsRefreshOptions,
	ModelsRefreshResult,
	ModelsSimpleStreamOptions,
	ModelType,
	ModelTypeMap,
	Provider,
	ProviderHeaders,
} from "@runkiln/ai";
import type { AuthStatus, ModelRuntime } from "./model-runtime.ts";

export type ResolvedRequestAuth =
	| {
			ok: true;
			apiKey?: string;
			headers?: ProviderHeaders;
			baseUrl?: string;
			env?: Record<string, string>;
	  }
	| { ok: false; error: string };

/** Synchronous read-only view of the RunInfra model catalog. Internals use ModelRuntime directly. */
export class ModelRegistry {
	private readonly runtime: ModelRuntime;

	constructor(runtime: ModelRuntime) {
		this.runtime = runtime;
	}

	refresh(options?: ModelsRefreshOptions): Promise<ModelsRefreshResult> {
		return this.runtime.refresh(options);
	}

	getError(): string | undefined {
		return this.runtime.getError();
	}

	getAll(): Model<Api>[] {
		return [...this.runtime.getModels()];
	}

	getAvailable(): Model<Api>[] {
		return [...this.runtime.getAvailableSnapshot()];
	}

	find(provider: string, modelId: string): Model<Api> | undefined {
		return this.runtime.getModel(provider, modelId);
	}

	/** Find a model of a non-chat type, e.g. `findOfType("classifier", "typesafe", "jev-latest")`. */
	findOfType<TType extends ModelType>(
		type: TType,
		provider: string,
		modelId: string,
	): ModelTypeMap[TType] | undefined {
		return this.runtime.getModelOfType(type, provider, modelId);
	}

	hasConfiguredAuth(model: Model<Api>): boolean {
		return this.runtime.hasConfiguredAuth(model.provider);
	}

	async getApiKeyAndHeaders(model: Model<Api>): Promise<ResolvedRequestAuth> {
		try {
			const resolution = await this.runtime.getAuth(model);
			if (!resolution) return { ok: false, error: `No API key found for "${model.provider}"` };
			return {
				ok: true,
				apiKey: resolution.auth.apiKey,
				headers: resolution.auth.headers,
				...(resolution.auth.baseUrl ? { baseUrl: resolution.auth.baseUrl } : {}),
				env: resolution.env,
			};
		} catch (error) {
			const cause = error instanceof Error ? error.cause : undefined;
			const message =
				cause instanceof Error ? cause.message : error instanceof Error ? error.message : String(error);
			return { ok: false, error: message };
		}
	}

	getProviderAuthStatus(provider: string): AuthStatus {
		return this.runtime.getProviderAuthStatus(provider);
	}

	getProvider(provider: string): Provider | undefined {
		return this.runtime.getProvider(provider);
	}

	/** Stream through the configured provider with request-time authentication. */
	stream<TApi extends Api>(
		model: Model<TApi>,
		context: Context,
		options?: ModelsApiStreamOptions<TApi>,
	): AssistantMessageEventStream {
		return this.runtime.stream(model, context, options);
	}

	/** Stream with provider-neutral options and request-time authentication. */
	streamSimple(model: Model<Api>, context: Context, options?: ModelsSimpleStreamOptions): AssistantMessageEventStream {
		return this.runtime.streamSimple(model, context, options);
	}

	complete<TApi extends Api>(
		model: Model<TApi>,
		context: Context,
		options?: ModelsApiStreamOptions<TApi>,
	): Promise<AssistantMessage> {
		return this.runtime.complete(model, context, options);
	}

	/** Every known model of a type (chat, image, classifier), optionally for one provider. */
	getModelsOfType<TType extends ModelType>(type: TType, provider?: string): readonly ModelTypeMap[TType][] {
		return this.runtime.getModelsOfType(type, provider);
	}

	/** Models of a type whose provider has working credentials. */
	getAvailableOfType<TType extends ModelType>(
		type: TType,
		provider?: string,
		options?: AuthOperationOptions,
	): Promise<readonly ModelTypeMap[TType][]> {
		return this.runtime.getAvailableOfType(type, provider, options);
	}

	getModelOfType<TType extends ModelType>(
		type: TType,
		provider: string,
		modelId: string,
	): ModelTypeMap[TType] | undefined {
		return this.runtime.getModelOfType(type, provider, modelId);
	}

	/** Classify structured state with request-time authentication. Never rejects. */
	classify(
		model: ClassifierModel<ClassifierApi>,
		context: ClassifierContext,
		options?: ModelsClassifierOptions,
	): Promise<ClassifierResult> {
		return this.runtime.classify(model, context, options);
	}

	/** Generate images with request-time authentication. Never rejects. */
	generateImages(
		model: ImageModel<ImageApi>,
		context: ImagesContext,
		options?: ModelsImagesOptions,
	): Promise<AssistantImages> {
		return this.runtime.generateImages(model, context, options);
	}

	getProviderDisplayName(provider: string): string {
		return this.runtime.getProvider(provider)?.name ?? provider;
	}

	getProviderAuth(provider: string): Promise<AuthResult | undefined> {
		return this.runtime.getAuth(provider);
	}

	async getApiKeyForProvider(provider: string): Promise<string | undefined> {
		try {
			return (await this.runtime.getAuth(provider))?.auth.apiKey;
		} catch {
			return undefined;
		}
	}

	isUsingOAuth(model: Model<Api>): boolean {
		return this.runtime.isUsingOAuth(model.provider);
	}
}
