import { type Static, type TProperties, type TSchemaOptions, Type } from "typebox";
import { ModelCostSchema } from "./model-schema.ts";

function sessionAffinityFormat(options?: TSchemaOptions) {
	return Type.Union([Type.Literal("openai"), Type.Literal("openai-nosession")], options);
}

export const SessionAffinityFormatSchema = sessionAffinityFormat({
	description: "Session-affinity header format used to route related requests consistently.",
});

function thinkingTokenBudgetField(options?: TSchemaOptions) {
	return Type.Union(
		[Type.Literal("thinking_token_budget"), Type.Literal("thinking_budget"), Type.Literal("thinking_budget_tokens")],
		options,
	);
}

export const ThinkingTokenBudgetFieldSchema = thinkingTokenBudgetField({
	description:
		'Top-level request field name used by OpenAI-compatible endpoints to cap reasoning tokens. "thinking_token_budget" is used by vLLM, "thinking_budget" by Qwen, DashScope, or SGLang, and "thinking_budget_tokens" by llama.cpp.',
});

export const ChatTemplateKwargValueSchema = Type.Union([
	Type.String(),
	Type.Number(),
	Type.Boolean(),
	Type.Null(),
	Type.Object({
		$var: Type.Union([
			Type.Literal("thinking.enabled"),
			Type.Literal("thinking.effort"),
			Type.Literal("thinking.budget"),
		]),
		omitWhenOff: Type.Optional(Type.Boolean()),
	}),
]);

export const AnthropicAllowedFallbackModelSchema = Type.Object(
	{
		provider: Type.String({ minLength: 1 }),
		model: Type.String({ minLength: 1 }),
		cost: ModelCostSchema,
	},
	{ description: "An Anthropic server-side refusal fallback model with local pricing metadata." },
);

function optionalCompatBoolean(options?: TSchemaOptions) {
	return Type.Optional(Type.Boolean(options));
}

function optionalSessionAffinityFormat(options?: TSchemaOptions) {
	return Type.Optional(sessionAffinityFormat(options));
}

export const OpenAICompletionsCompatSchema = Type.Object(
	{
		supportsStore: Type.Optional(
			Type.Boolean({
				description: "Whether the provider supports the store field. Default: auto-detected from URL.",
			}),
		),
		supportsDeveloperRole: optionalCompatBoolean({
			description:
				"Whether the provider supports the developer role instead of system. Default: auto-detected from URL.",
		}),
		supportsReasoningEffort: Type.Optional(
			Type.Boolean({
				description: "Whether the provider supports reasoning_effort. Default: auto-detected from URL.",
			}),
		),
		supportsUsageInStreaming: Type.Optional(
			Type.Boolean({
				description:
					"Whether the provider supports stream_options.include_usage for token usage in streaming responses.",
				default: true,
			}),
		),
		supportsFinishReason: Type.Optional(
			Type.Boolean({
				description:
					"Whether streamed responses include finish_reason. When false, RunKiln infers stop or toolUse when the stream ends.",
				default: true,
			}),
		),
		maxTokensField: Type.Optional(
			Type.Union([Type.Literal("max_completion_tokens"), Type.Literal("max_tokens")], {
				description: "Which field to use for max tokens. Default: auto-detected from URL.",
			}),
		),
		requiresToolResultName: Type.Optional(
			Type.Boolean({ description: "Whether tool results require the name field. Default: auto-detected from URL." }),
		),
		requiresAssistantAfterToolResult: Type.Optional(
			Type.Boolean({
				description:
					"Whether a user message after tool results requires an assistant message in between. Default: auto-detected from URL.",
			}),
		),
		requiresThinkingAsText: Type.Optional(
			Type.Boolean({
				description:
					"Whether thinking blocks must be converted to text blocks with <thinking> delimiters. Default: auto-detected from URL.",
			}),
		),
		requiresReasoningContentOnAssistantMessages: Type.Optional(
			Type.Boolean({
				description:
					"Whether all replayed assistant messages must include an empty reasoning_content field when reasoning is enabled. Default: auto-detected from URL.",
			}),
		),
		thinkingFormat: Type.Optional(
			Type.Union(
				[
					Type.Literal("openai"),
					Type.Literal("deepseek"),
					Type.Literal("together"),
					Type.Literal("baseten"),
					Type.Literal("zai"),
					Type.Literal("qwen"),
					Type.Literal("chat-template"),
					Type.Literal("qwen-chat-template"),
					Type.Literal("string-thinking"),
					Type.Literal("ant-ling"),
				],
				{
					description:
						'Format for reasoning or thinking parameters. When omitted, RunKiln auto-detects the format from the provider URL. "openai" uses reasoning_effort, "deepseek" uses thinking.type plus reasoning_effort when supported, "together" uses reasoning.enabled plus reasoning_effort when supported, "baseten" uses configurable chat_template_args plus reasoning_effort when supported, "zai" uses thinking.type, "qwen" uses top-level enable_thinking, "qwen-chat-template" uses chat_template_kwargs.enable_thinking and preserve_thinking, "chat-template" uses configurable chat_template_kwargs, "string-thinking" uses top-level thinking, and "ant-ling" uses reasoning.effort only when the mapped effort is non-null.',
				},
			),
		),
		chatTemplateKwargs: Type.Optional(
			Type.Record(Type.String(), ChatTemplateKwargValueSchema, {
				description:
					'Kwargs sent as chat_template_kwargs when thinkingFormat is "chat-template". Use $var with "thinking.enabled", "thinking.effort", or "thinking.budget" for RunKiln-controlled values.',
			}),
		),
		chatTemplateArgs: Type.Optional(
			Type.Record(Type.String(), ChatTemplateKwargValueSchema, {
				description:
					'Arguments sent as chat_template_args when thinkingFormat is "baseten". Use $var with "thinking.enabled", "thinking.effort", or "thinking.budget" for RunKiln-controlled values.',
			}),
		),
		zaiToolStream: Type.Optional(
			Type.Boolean({
				description: "Whether z.ai supports top-level tool_stream for streaming tool call deltas.",
				default: false,
			}),
		),
		thinkingTokenBudgetField: Type.Optional(
			thinkingTokenBudgetField({
				description:
					'Top-level request field used to cap reasoning tokens from thinkingBudgets. Reasoning and the answer share max_tokens on these endpoints. "thinking_token_budget" is vLLM, "thinking_budget" is Qwen, DashScope, or SGLang, and "thinking_budget_tokens" is llama.cpp. Off by default and not set on the generated catalog.',
			}),
		),
		supportsThinkingTokenBudget: Type.Optional(
			Type.Boolean({
				description:
					'Alias for thinkingTokenBudgetField: "thinking_token_budget" (vLLM). Prefer thinkingTokenBudgetField.',
				default: false,
			}),
		),
		supportsOpenAIGrammarTools: optionalCompatBoolean({
			description:
				"Whether the provider supports OpenAI custom tools with Lark or regex grammar formats. When false, grammar-constrained tools fall back to normal function tools. The generated catalog enables this for capable models.",
			default: false,
		}),
		supportsMidConvoSystemMessages: optionalCompatBoolean({
			description:
				"Whether the exact model accepts system or developer messages after the conversation has started. When false, later system messages are folded into the leading system message. The generated catalog enables this for verified models.",
			default: false,
		}),
		supportsMidConvoToolAdditions: Type.Optional(
			Type.Boolean({
				description:
					"Whether system messages can introduce additional tools mid-conversation. Requires supportsMidConvoSystemMessages. The generated catalog enables this for capable models.",
				default: false,
			}),
		),
		supportsStrictMode: optionalCompatBoolean({
			description:
				"Whether the provider supports the strict field in tool definitions. Generated capable models enable it explicitly.",
			default: false,
		}),
		cacheControlFormat: Type.Optional(
			Type.Literal("anthropic", {
				description:
					"Cache control convention for prompt caching. Anthropic applies cache_control markers to the system prompt, last tool definition, and last user, assistant, or tool-result text content.",
			}),
		),
		sessionAffinityFormat: optionalSessionAffinityFormat({
			description:
				"Session-affinity header format. openai sends session_id, x-client-request-id, and x-session-affinity; openai-nosession sends x-client-request-id and x-session-affinity. Does not affect prompt_cache_key. Default: auto-detected.",
		}),
		supportsLongCacheRetention: optionalCompatBoolean({
			description:
				'Whether the provider supports long prompt cache retention (prompt_cache_retention: "24h" or Anthropic-style cache_control.ttl: "1h", depending on format). Default: auto-detected from provider and URL.',
		}),
		vllmPriority: Type.Optional(
			Type.Number({
				description:
					"vLLM scheduler priority sent as the top-level priority request field. Lower values are handled earlier and the server default is 0. Only meaningful with --scheduling-policy priority. Off by default and not set on the generated catalog.",
			}),
		),
	},
	{
		description:
			"Compatibility settings for OpenAI-compatible completions APIs. Use this to override URL-based auto-detection for custom providers.",
		additionalProperties: true,
	},
);

export const OpenAIResponsesCompatSchema = Type.Object(
	{
		supportsDeveloperRole: optionalCompatBoolean({
			description: "Whether the provider supports the developer role instead of system.",
			default: true,
		}),
		supportsMidConvoSystemMessages: optionalCompatBoolean({
			description:
				"Whether the exact model accepts developer or system messages after the conversation has started. When false, later system messages are folded into the leading system message. The generated catalog enables this for verified models.",
			default: false,
		}),
		sessionAffinityFormat: optionalSessionAffinityFormat({
			description:
				"Session-affinity header format. openai sends session_id and x-client-request-id; openai-nosession sends x-client-request-id. Does not affect prompt_cache_key. Default: auto-detected.",
		}),
		supportsLongCacheRetention: optionalCompatBoolean({
			description:
				'Whether the provider supports long prompt cache retention. This uses prompt_cache_options.ttl: "30m" on GPT-5.6+ and prompt_cache_retention: "24h" on earlier models.',
			default: true,
		}),
		supportsStrictMode: optionalCompatBoolean({
			description:
				"Whether the provider supports strict JSON-schema function tools. Defaults are API-specific; generated OpenAI models enable it explicitly.",
		}),
		supportsOpenAIGrammarTools: optionalCompatBoolean({
			description:
				"Whether to emit OpenAI custom tools with Lark or regex grammar formats. When false, grammar-constrained tools fall back to normal function tools. The generated catalog enables this for capable models.",
			default: false,
		}),
		supportsAdditionalTools: Type.Optional(
			Type.Boolean({
				description: "Whether the model supports message-anchored additional_tools input items.",
				default: false,
			}),
		),
		supportsToolSearch: Type.Optional(
			Type.Boolean({
				description: "Whether the model supports client-executed tool search for transcript-anchored additions.",
				default: false,
			}),
		),
		supportsExplicitPromptCacheMode: Type.Optional(
			Type.Boolean({
				description: "Whether the model accepts prompt_cache_options. Older OpenAI models reject the parameter.",
				default: false,
			}),
		),
		supportsMaxOutputTokens: Type.Optional(
			Type.Boolean({
				description: "Whether the provider accepts max_output_tokens. Some Codex-protocol gateways reject it.",
				default: true,
			}),
		),
	},
	{ description: "Compatibility settings for OpenAI Responses APIs.", additionalProperties: true },
);

export const AnthropicMessagesCompatSchema = Type.Object(
	{
		supportsEagerToolInputStreaming: Type.Optional(
			Type.Boolean({
				description:
					"Whether the provider accepts per-tool eager_input_streaming. When false, the Anthropic provider omits tools[].eager_input_streaming and sends the legacy fine-grained-tool-streaming-2025-05-14 beta header for tool-enabled requests.",
				default: true,
			}),
		),
		supportsLongCacheRetention: optionalCompatBoolean({
			description: "Whether the provider supports Anthropic long cache retention through cache_control.ttl.",
			default: true,
		}),
		supportsCacheControlOnTools: Type.Optional(
			Type.Boolean({
				description:
					"Whether the provider supports Anthropic-style cache_control markers on tool definitions. When false, cache_control is omitted from tool parameters. Some Anthropic-compatible providers, such as Fireworks, do not support this field on tools and may reject or ignore it.",
				default: true,
			}),
		),
		supportsTemperature: Type.Optional(
			Type.Boolean({
				description:
					"Whether the model accepts the Anthropic temperature request field. Claude Opus 4.7+ rejects non-default values.",
				default: true,
			}),
		),
		forceAdaptiveThinking: Type.Optional(
			Type.Boolean({
				description:
					"Whether to force adaptive thinking (thinking.type: adaptive plus output_config.effort) regardless of model ID. Built-in models that require adaptive thinking set this in generated metadata. Custom Anthropic-compatible providers can set this to true for any model whose upstream requires the adaptive format. Set false to opt out on overridden built-in models.",
				default: false,
			}),
		),
		allowEmptySignature: Type.Optional(
			Type.Boolean({
				description: "Whether to replay empty thinking signatures instead of converting thinking to text.",
				default: false,
			}),
		),
		supportsStrictTools: Type.Optional(
			Type.Boolean({
				description:
					"Whether the provider supports Anthropic strict tool schemas. Generated Anthropic models enable it explicitly.",
				default: false,
			}),
		),
		supportsMidConvoEffort: Type.Optional(
			Type.Boolean({
				description:
					"Whether the exact model transport supports effort-only system messages and thinking binding controls.",
				default: false,
			}),
		),
		supportsMidConvoSystemMessages: optionalCompatBoolean({
			description:
				"Whether the exact model accepts system-role messages inside the conversation. When false, later system messages are folded into the top-level system prompt.",
			default: false,
		}),
		supportsMidConvoToolChanges: Type.Optional(
			Type.Boolean({
				description:
					"Whether the exact model accepts mid-conversation tool_addition and tool_removal blocks. Requires supportsMidConvoSystemMessages.",
				default: false,
			}),
		),
		allowedFallbackModels: Type.Optional(
			Type.Array(AnthropicAllowedFallbackModelSchema, {
				maxItems: 3,
				description:
					"Models Anthropic accepts for server-side refusal fallback, with local pricing metadata for returned fallback responses. When absent or empty, callers must omit fallbacks; Anthropic rejects the field for models with no permitted fallback targets.",
			}),
		),
	},
	{ description: "Compatibility settings for Anthropic Messages-compatible APIs.", additionalProperties: true },
);

export const BedrockCompatSchema = Type.Object(
	{
		supportsStrictMode: optionalCompatBoolean({
			description: "Whether the model supports Bedrock strict tool schemas.",
			default: false,
		}),
	},
	{ description: "Compatibility settings for Amazon Bedrock models.", additionalProperties: true },
);

export const MistralConversationsCompatSchema = Type.Object(
	{
		supportsMidConvoSystemMessages: optionalCompatBoolean({
			description:
				"Whether the exact model accepts system messages after the conversation has started. When false, later system messages are folded into the leading system message.",
			default: false,
		}),
	},
	{ description: "Compatibility settings for the Mistral chat API.", additionalProperties: true },
);

const ProviderCompatPropertyOverrides = {
	supportsDeveloperRole: optionalCompatBoolean({
		description: "Whether the provider supports the developer role instead of system. Defaults are API-specific.",
	}),
	supportsMidConvoSystemMessages: optionalCompatBoolean({
		description:
			"Whether the exact model accepts system or developer messages after the conversation has started. When false, later system messages are folded into the leading system message.",
		default: false,
	}),
	sessionAffinityFormat: optionalSessionAffinityFormat({
		description: "Session-affinity header format. Defaults are API-specific or auto-detected.",
	}),
	supportsLongCacheRetention: optionalCompatBoolean({
		description:
			"Whether the provider supports long prompt cache retention. Defaults are API-specific or auto-detected.",
	}),
	supportsStrictMode: optionalCompatBoolean({
		description: "Whether the provider supports strict tool schemas. Defaults are API-specific.",
	}),
	supportsOpenAIGrammarTools: optionalCompatBoolean({
		description:
			"Whether the provider supports OpenAI custom tools with Lark or regex grammar formats. When false, grammar-constrained tools fall back to normal function tools.",
		default: false,
	}),
} satisfies TProperties;

type UnionToIntersection<Union> = (Union extends unknown ? (value: Union) => void : never) extends (
	value: infer Intersection,
) => void
	? Intersection
	: never;

type MergedCompatProperties<PropertyGroups extends readonly TProperties[], Overrides extends TProperties> = Omit<
	UnionToIntersection<PropertyGroups[number]>,
	keyof Overrides
> &
	Overrides;

/**
 * Provider-level models.json compatibility is API-agnostic, so it needs one superset. Every
 * duplicate property requires explicit generic metadata, while API-specific schemas retain their
 * own defaults and descriptions.
 */
function mergeCompatProperties<
	const PropertyGroups extends readonly TProperties[],
	const Overrides extends TProperties,
>(propertyGroups: PropertyGroups, overrides: Overrides): MergedCompatProperties<PropertyGroups, Overrides> {
	const merged: TProperties = {};
	const duplicateNames = new Set<string>();

	for (const properties of propertyGroups) {
		for (const [name, schema] of Object.entries(properties)) {
			if (merged[name] !== undefined) {
				duplicateNames.add(name);
				if (!(name in overrides)) {
					throw new Error(`Duplicate compatibility schema property requires an override: ${name}`);
				}
			}
			merged[name] = schema;
		}
	}

	for (const name of Object.keys(overrides)) {
		if (!duplicateNames.has(name)) {
			throw new Error(`Compatibility schema override does not resolve a duplicate property: ${name}`);
		}
	}

	return { ...merged, ...overrides } as MergedCompatProperties<PropertyGroups, Overrides>;
}

const CompatSchemasByApi = {
	"openai-completions": OpenAICompletionsCompatSchema,
	"openai-responses": OpenAIResponsesCompatSchema,
	"anthropic-messages": AnthropicMessagesCompatSchema,
	"bedrock-converse-stream": BedrockCompatSchema,
	"mistral-conversations": MistralConversationsCompatSchema,
} as const;

const ProviderCompatProperties = mergeCompatProperties(
	Object.values(CompatSchemasByApi).map((schema) => schema.properties),
	ProviderCompatPropertyOverrides,
);

export const ProviderCompatSchema = Type.Object(ProviderCompatProperties, {
	description: "Provider and model compatibility overrides.",
	additionalProperties: true,
});

export type ChatTemplateKwargValue = Static<typeof ChatTemplateKwargValueSchema>;
/** Top-level request field used to cap reasoning tokens on OpenAI-compatible servers. */
export type ThinkingTokenBudgetField = Static<typeof ThinkingTokenBudgetFieldSchema>;
export type SessionAffinityFormat = Static<typeof SessionAffinityFormatSchema>;
/** An Anthropic server-side refusal fallback model with local pricing metadata. */
export interface AnthropicAllowedFallbackModel extends Static<typeof AnthropicAllowedFallbackModelSchema> {}

/** Compatibility settings for OpenAI-compatible completions APIs. */
export interface OpenAICompletionsCompat extends Static<typeof OpenAICompletionsCompatSchema> {}
/** Compatibility settings for OpenAI Responses APIs. */
export interface OpenAIResponsesCompat extends Static<typeof OpenAIResponsesCompatSchema> {}
/** Compatibility settings for Anthropic Messages-compatible APIs. */
export interface AnthropicMessagesCompat extends Static<typeof AnthropicMessagesCompatSchema> {}
/** Compatibility settings for Amazon Bedrock models. */
export interface BedrockCompat extends Static<typeof BedrockCompatSchema> {}
/** Compatibility settings for the Mistral chat API. */
export interface MistralConversationsCompat extends Static<typeof MistralConversationsCompatSchema> {}
