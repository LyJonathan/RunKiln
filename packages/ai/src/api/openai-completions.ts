import OpenAI from "openai";
import type {
	ChatCompletionAssistantMessageParam,
	ChatCompletionChunk,
	ChatCompletionContentPart,
	ChatCompletionContentPartImage,
	ChatCompletionContentPartText,
	ChatCompletionMessageParam,
	ChatCompletionMessageToolCall,
	ChatCompletionToolMessageParam,
} from "openai/resources/chat/completions.js";
import { calculateCost, clampThinkingLevel } from "../models.ts";
import type {
	AssistantMessage,
	ImageContent,
	JsonValue,
	Message,
	Model,
	ModelThinkingLevel,
	OpenAICompletionsCompat,
	ProviderHeaders,
	SimpleStreamOptions,
	StopReason,
	StreamFunction,
	StreamOptions,
	TextContent,
	ThinkingContent,
	Tool,
	ToolCall,
	ToolResultMessage,
} from "../types.ts";
import { formatProviderError, normalizeProviderError } from "../utils/error-body.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { shortHash } from "../utils/hash.ts";
import { headersToRecord } from "../utils/headers.ts";
import { parseStreamingJson } from "../utils/json-parse.ts";
import { retryProviderRequest } from "../utils/provider-retry.ts";
import { getRunKilnUserAgent } from "../utils/runkiln-user-agent.ts";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.ts";
import { getSystemMessageText, renderSystemMessageUpdate } from "../utils/text.ts";
import {
	getDeclaredTools,
	resolveTranscript,
	resolveTranscriptTools,
	type TranscriptContext,
} from "../utils/transcript.ts";
import {
	appendGrammarToolInputJsonDelta,
	createGrammarToolInputProperties,
	type GrammarToolInputJsonBuffer,
	getGrammarToolInput,
	getJsonSchemaToolParameters,
	resolveGrammarConstrainedSampling,
	resolveJsonSchemaStrictSampling,
} from "./constrained-sampling.ts";
import { runInfraSessionHeaders } from "./runinfra-headers.ts";
import { fitRunInfraRequestSize, runInfraGateKey, runInfraMaxTokens, runInfraRequestGate } from "./runinfra-request.ts";
import { buildBaseOptions, resolveSamplingParams } from "./simple-options.ts";
import { transformMessages } from "./transform-messages.ts";

/**
 * Check if conversation messages contain tool calls or tool results.
 * This is needed because Anthropic (via proxy) requires the tools param
 * to be present when messages include tool_calls or tool role messages.
 */
function hasHeader(headers: ProviderHeaders | undefined, name: string): boolean {
	if (!headers) return false;
	const expected = name.toLowerCase();
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === expected && value !== null && value.trim().length > 0) return true;
	}
	return false;
}

function getClientApiKey(provider: string, apiKey: string | undefined, headers: ProviderHeaders | undefined): string {
	if (apiKey) return apiKey;
	if (hasHeader(headers, "authorization") || hasHeader(headers, "cf-aig-authorization")) return "unused";
	throw new Error(`No API key for provider: ${provider}`);
}

function hasToolHistory(messages: Message[]): boolean {
	for (const msg of messages) {
		if (msg.role === "toolResult") {
			return true;
		}
		if (msg.role === "assistant") {
			if (msg.content.some((block) => block.type === "toolCall")) {
				return true;
			}
		}
	}
	return false;
}

function isTextContentBlock(block: { type: string }): block is TextContent {
	return block.type === "text";
}

function isThinkingContentBlock(block: { type: string }): block is ThinkingContent {
	return block.type === "thinking";
}

function isToolCallBlock(block: { type: string }): block is ToolCall {
	return block.type === "toolCall";
}

function isImageContentBlock(block: { type: string }): block is ImageContent {
	return block.type === "image";
}

function isReasoningDetailObject(detail: unknown): detail is Record<string, unknown> {
	return typeof detail === "object" && detail !== null && !Array.isArray(detail);
}

function hasValidCommonReasoningDetailFields(candidate: Record<string, unknown>): boolean {
	return (
		(candidate.id === undefined || candidate.id === null || typeof candidate.id === "string") &&
		(candidate.format === undefined || typeof candidate.format === "string") &&
		(candidate.index === undefined || typeof candidate.index === "number")
	);
}

function isOpenAIReasoningDetail(detail: unknown): detail is OpenAIReasoningDetail {
	if (!isReasoningDetailObject(detail) || !hasValidCommonReasoningDetailFields(detail)) {
		return false;
	}
	switch (detail.type) {
		case "reasoning.summary":
			return typeof detail.summary === "string";
		case "reasoning.encrypted":
			return typeof detail.data === "string";
		case "reasoning.text":
			return (
				typeof detail.text === "string" &&
				(detail.signature === undefined || detail.signature === null || typeof detail.signature === "string")
			);
		default:
			return false;
	}
}

export interface OpenAICompletionsOptions extends StreamOptions {
	toolChoice?: OpenAI.Chat.Completions.ChatCompletionToolChoiceOption;
	/**
	 * RunKiln: thinking level for this request. Models with a `thinkingLevelMap` send the mapped
	 * provider effort (clamped to a supported level); models without one keep `model.reasoningEffort`.
	 */
	thinkingLevel?: ModelThinkingLevel;
}

/**
 * RunKiln: the `reasoning_effort` value for one request. A model with selectable thinking levels sends
 * the effort its map gives for the (clamped) level; otherwise the model's fixed harness effort.
 */
export function resolveReasoningEffort(
	model: Model<"openai-completions">,
	thinkingLevel: ModelThinkingLevel | undefined,
): string | undefined {
	const map = model.thinkingLevelMap;
	if (thinkingLevel !== undefined && model.reasoning && map) {
		const level = clampThinkingLevel(model, thinkingLevel);
		const mapped = map[level];
		if (typeof mapped === "string") return mapped;
	}
	return model.reasoningEffort;
}

export interface ConvertCompletionsMessagesOptions {
	grammarToolInputProperties?: ReadonlyMap<string, string>;
}

type ResolvedOpenAICompletionsCompat = Omit<
	Required<OpenAICompletionsCompat>,
	| "cacheControlFormat"
	| "supportsThinkingTokenBudget"
	| "thinkingTokenBudgetField"
	| "supportsMidConvoSystemMessages"
	| "supportsMidConvoToolAdditions"
	| "vllmPriority"
	| "sessionAffinityFormat"
> & {
	cacheControlFormat?: OpenAICompletionsCompat["cacheControlFormat"];
	supportsThinkingTokenBudget?: OpenAICompletionsCompat["supportsThinkingTokenBudget"];
	thinkingTokenBudgetField?: OpenAICompletionsCompat["thinkingTokenBudgetField"];
	supportsMidConvoSystemMessages?: OpenAICompletionsCompat["supportsMidConvoSystemMessages"];
	supportsMidConvoToolAdditions?: OpenAICompletionsCompat["supportsMidConvoToolAdditions"];
	vllmPriority?: OpenAICompletionsCompat["vllmPriority"];
	sessionAffinityFormat?: OpenAICompletionsCompat["sessionAffinityFormat"];
};

type KimiToolSystemMessageParam = {
	role: "system";
	tools: OpenAI.Chat.Completions.ChatCompletionTool[];
};

type OpenAIReasoningDetailBase = Record<string, JsonValue> & {
	id?: string | null;
	format?: string;
	index?: number;
};

type OpenAIReasoningSummaryDetail = OpenAIReasoningDetailBase & {
	type: "reasoning.summary";
	summary: string;
};

type OpenAIEncryptedReasoningDetail = OpenAIReasoningDetailBase & {
	type: "reasoning.encrypted";
	data: string;
};

type OpenAIReasoningTextDetail = OpenAIReasoningDetailBase & {
	type: "reasoning.text";
	text: string;
	signature?: string | null;
};

type OpenAIReasoningDetail = OpenAIReasoningSummaryDetail | OpenAIEncryptedReasoningDetail | OpenAIReasoningTextDetail;

function parseOpenAIReasoningDetails(signature: string | undefined): OpenAIReasoningDetail[] | undefined {
	if (!signature) return undefined;
	try {
		const parsed = JSON.parse(signature) as unknown;
		return Array.isArray(parsed) && parsed.length > 0 && parsed.every(isOpenAIReasoningDetail) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

function parseLegacyEncryptedReasoningDetail(
	signature: string | undefined,
): OpenAIEncryptedReasoningDetail | undefined {
	if (!signature) return undefined;
	try {
		const parsed = JSON.parse(signature) as unknown;
		return isOpenAIReasoningDetail(parsed) &&
			parsed.type === "reasoning.encrypted" &&
			typeof parsed.id === "string" &&
			parsed.id.length > 0 &&
			parsed.data.length > 0
			? parsed
			: undefined;
	} catch {
		return undefined;
	}
}

function fillMissingCommonReasoningDetailFields(
	target: OpenAIReasoningDetailBase,
	source: OpenAIReasoningDetail,
): void {
	target.id ??= source.id;
	target.format ||= source.format;
	target.index ??= source.index;
}

function appendOpenAIReasoningDetail(details: OpenAIReasoningDetail[], detail: OpenAIReasoningDetail): void {
	const lastDetail = details[details.length - 1];
	if (detail.type === "reasoning.text" && lastDetail?.type === "reasoning.text") {
		lastDetail.text += detail.text;
		lastDetail.signature ||= detail.signature;
		fillMissingCommonReasoningDetailFields(lastDetail, detail);
		return;
	}
	if (detail.type === "reasoning.summary" && lastDetail?.type === "reasoning.summary") {
		lastDetail.summary += detail.summary;
		fillMissingCommonReasoningDetailFields(lastDetail, detail);
		return;
	}
	details.push({ ...detail });
}

const OPENAI_COMPLETIONS_REASONING_FIELDS = ["reasoning", "reasoning_content", "reasoning_text"] as const;

type OpenAICompletionsReasoningField = (typeof OPENAI_COMPLETIONS_REASONING_FIELDS)[number];

function isOpenAICompletionsReasoningField(field: string): field is OpenAICompletionsReasoningField {
	return OPENAI_COMPLETIONS_REASONING_FIELDS.includes(field as OpenAICompletionsReasoningField);
}

type ChatCompletionAssistantMessageParamWithReasoning = ChatCompletionAssistantMessageParam &
	Partial<Record<OpenAICompletionsReasoningField, string>> & {
		reasoning_details?: JsonValue[];
	};

export const stream: StreamFunction<"openai-completions", OpenAICompletionsOptions> = (
	model: Model<"openai-completions">,
	context: TranscriptContext,
	options?: OpenAICompletionsOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();
	const normalizedContext = resolveTranscript(context, getCompat(model).supportsMidConvoSystemMessages);

	(async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "pending",
			timestamp: Date.now(),
		};

		// `reasoning_details` are replay metadata, not user-visible stream deltas.
		// Keep them in memory during streaming and serialize once when the block is finalized.
		let streamedReasoningDetails: OpenAIReasoningDetail[] | undefined;
		const applyStreamedReasoningDetails = (block: ThinkingContent): void => {
			if (streamedReasoningDetails !== undefined) {
				block.thinkingSignature = JSON.stringify(streamedReasoningDetails);
			}
		};

		let releaseGate: (() => void) | undefined;
		try {
			const apiKey = getClientApiKey(model.provider, options?.apiKey, options?.headers);
			const compat = getCompat(model);
			const grammarToolInputProperties = createGrammarToolInputProperties(
				getDeclaredTools(normalizedContext.messages),
				compat.supportsOpenAIGrammarTools,
			);
			const client = createClient(
				model,
				apiKey,
				options?.headers,
				options?.fetch,
				options?.sessionId,
				options?.parentSessionId,
			);
			let params = buildParams(model, normalizedContext, options, compat, grammarToolInputProperties);
			const nextParams = await options?.onPayload?.(params, model);
			if (nextParams !== undefined) {
				params = nextParams as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming;
			}
			// Trim oldest tool output before RunInfra would answer 413 (catalog max_request_bytes).
			const fit = fitRunInfraRequestSize(
				params as unknown as Parameters<typeof fitRunInfraRequestSize>[0],
				model.inputLimits?.maxRequestBytes,
			);
			if (fit.trimmed > 0) {
				output.diagnostics = [
					...(output.diagnostics ?? []),
					{
						type: "request_trimmed",
						timestamp: Date.now(),
						details: {
							trimmedToolResults: fit.trimmed,
							maxRequestBytes: model.inputLimits?.maxRequestBytes ?? 0,
						},
					},
				];
			}
			// Client-side pacing: concurrency cap per key + model, and hold when the window is spent.
			const gateKey = runInfraGateKey(apiKey, model.id);
			releaseGate = await runInfraRequestGate.acquire(
				gateKey,
				model.serviceLimits?.maxConcurrentRequests,
				options?.signal,
			);
			const requestOptions = {
				...(options?.signal ? { signal: options.signal } : {}),
				...(options?.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
				maxRetries: 0,
			};
			const { data: openaiStream, response } = await retryProviderRequest(
				() => client.chat.completions.create(params, requestOptions).withResponse(),
				{
					maxRetries: options?.maxRetries,
					maxRetryDelayMs: options?.maxRetryDelayMs,
					signal: options?.signal,
				},
			);
			const responseHeaders = headersToRecord(response.headers);
			runInfraRequestGate.observe(gateKey, responseHeaders);
			await options?.onResponse?.({ status: response.status, headers: responseHeaders }, model);
			stream.push({ type: "start", partial: output });

			interface StreamingToolCallBlock extends ToolCall {
				partialArgs?: string;
				customInput?: {
					property: string;
					jsonBuffer: GrammarToolInputJsonBuffer;
				};
				streamIndex?: number;
			}
			type StreamingBlock = TextContent | ThinkingContent | StreamingToolCallBlock;
			type StreamingToolCallDelta = {
				index?: number;
				id?: string;
				type?: string;
				function?: { name?: string; arguments?: string };
				custom?: { name?: string; input?: string };
			};

			let textBlock: TextContent | null = null;
			let thinkingBlock: ThinkingContent | null = null;
			let hasFinishReason = false;
			const toolCallBlocksByIndex = new Map<number, StreamingToolCallBlock>();
			const toolCallBlocksById = new Map<string, StreamingToolCallBlock>();
			const blocks = output.content as StreamingBlock[];
			const getContentIndex = (block: StreamingBlock) => blocks.indexOf(block);
			const getCustomToolCallInput = (block: StreamingToolCallBlock): string => {
				const property = block.customInput?.property;
				if (property === undefined) return "";
				const value = block.arguments[property];
				return typeof value === "string" ? value : "";
			};
			const appendCustomToolCallInput = (
				block: StreamingToolCallBlock,
				nextInput: string,
				close: boolean,
			): string | undefined => {
				const customInput = block.customInput;
				if (!customInput) return undefined;
				const delta = appendGrammarToolInputJsonDelta(
					customInput.jsonBuffer,
					customInput.property,
					nextInput,
					close,
				);
				block.arguments = { [customInput.property]: nextInput };
				return delta;
			};
			const finishBlock = (block: StreamingBlock) => {
				const contentIndex = getContentIndex(block);
				if (contentIndex === -1) {
					return;
				}
				if (block.type === "text") {
					stream.push({
						type: "text_end",
						contentIndex,
						content: block.text,
						partial: output,
					});
				} else if (block.type === "thinking") {
					applyStreamedReasoningDetails(block);
					stream.push({
						type: "thinking_end",
						contentIndex,
						content: block.thinking,
						partial: output,
					});
				} else if (block.type === "toolCall") {
					if (block.customInput) {
						const delta = appendCustomToolCallInput(block, getCustomToolCallInput(block), true);
						if (delta !== undefined) {
							stream.push({
								type: "toolcall_delta",
								contentIndex,
								delta,
								partial: output,
							});
						}
					} else {
						block.arguments = parseStreamingJson(block.partialArgs);
					}
					// Finalize in-place and strip the scratch buffers so replay only
					// carries parsed arguments.
					delete block.partialArgs;
					delete block.customInput;
					delete block.streamIndex;
					stream.push({
						type: "toolcall_end",
						contentIndex,
						toolCall: block,
						partial: output,
					});
				}
			};
			const ensureTextBlock = () => {
				if (!textBlock) {
					textBlock = { type: "text", text: "" };
					blocks.push(textBlock);
					stream.push({ type: "text_start", contentIndex: getContentIndex(textBlock), partial: output });
				}
				return textBlock;
			};
			const ensureThinkingBlock = (thinkingSignature: string) => {
				if (!thinkingBlock) {
					thinkingBlock = {
						type: "thinking",
						thinking: "",
						thinkingSignature,
					};
					blocks.push(thinkingBlock);
					stream.push({ type: "thinking_start", contentIndex: getContentIndex(thinkingBlock), partial: output });
				}
				return thinkingBlock;
			};
			const ensureToolCallBlock = (toolCall: StreamingToolCallDelta) => {
				const streamIndex = typeof toolCall.index === "number" ? toolCall.index : undefined;
				const name = toolCall.function?.name ?? toolCall.custom?.name ?? "";
				let block = streamIndex !== undefined ? toolCallBlocksByIndex.get(streamIndex) : undefined;
				if (!block && toolCall.id) {
					block = toolCallBlocksById.get(toolCall.id);
				}
				if (!block) {
					// Note: the "input" fallback here should/must not be taken.  in case the LLM makes up
					// a tool we don't knwo about, we at least have a place to stash our stuff.
					const customInputProperty =
						toolCall.custom && !toolCall.function ? (grammarToolInputProperties.get(name) ?? "input") : undefined;
					const hasCustomInput = customInputProperty !== undefined;
					block = {
						type: "toolCall",
						id: toolCall.id || "",
						name,
						arguments: hasCustomInput ? { [customInputProperty]: "" } : {},
						partialArgs: hasCustomInput ? undefined : "",
						customInput: hasCustomInput
							? { property: customInputProperty, jsonBuffer: { input: "", started: false, closed: false } }
							: undefined,
						streamIndex,
					};
					if (streamIndex !== undefined) {
						toolCallBlocksByIndex.set(streamIndex, block);
					}
					if (toolCall.id) {
						toolCallBlocksById.set(toolCall.id, block);
					}
					blocks.push(block);
					stream.push({
						type: "toolcall_start",
						contentIndex: getContentIndex(block),
						partial: output,
					});
				}
				if (streamIndex !== undefined && block.streamIndex === undefined) {
					block.streamIndex = streamIndex;
					toolCallBlocksByIndex.set(streamIndex, block);
				}
				if (toolCall.id) {
					toolCallBlocksById.set(toolCall.id, block);
				}
				if (!block.name && name) {
					block.name = name;
				}
				if (toolCall.custom && !toolCall.function && !block.customInput) {
					const customInputProperty = grammarToolInputProperties.get(block.name) ?? "input";
					block.arguments = { [customInputProperty]: "" };
					block.customInput = {
						property: customInputProperty,
						jsonBuffer: { input: "", started: false, closed: false },
					};
					delete block.partialArgs;
				}
				return block;
			};

			for await (const chunk of openaiStream) {
				await options?.onProviderStreamEvent?.(chunk, model);
				if (!chunk || typeof chunk !== "object") continue;

				// OpenAI documents ChatCompletionChunk.id as the unique chat completion identifier,
				// and each chunk in a streamed completion carries the same id.
				output.responseId ||= chunk.id;
				if (typeof chunk.model === "string" && chunk.model.length > 0 && chunk.model !== model.id) {
					output.responseModel ||= chunk.model;
				}
				if (chunk.usage) {
					output.usage = parseChunkUsage(chunk.usage, model);
				}

				const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : undefined;
				if (!choice) continue;

				// Fallback: some providers (e.g., Moonshot) return usage
				// in choice.usage instead of the standard chunk.usage
				if (!chunk.usage && (choice as any).usage) {
					output.usage = parseChunkUsage((choice as any).usage, model);
				}

				if (choice.finish_reason) {
					output.rawStopReason = choice.finish_reason;
					const finishReasonResult = mapStopReason(choice.finish_reason);
					output.stopReason = finishReasonResult.stopReason;
					if (finishReasonResult.errorMessage) {
						output.errorMessage = finishReasonResult.errorMessage;
					}
					hasFinishReason = true;
				}

				if (choice.delta) {
					if (
						choice.delta.content !== null &&
						choice.delta.content !== undefined &&
						choice.delta.content.length > 0
					) {
						const block = ensureTextBlock();
						block.text += choice.delta.content;
						stream.push({
							type: "text_delta",
							contentIndex: getContentIndex(block),
							delta: choice.delta.content,
							partial: output,
						});
					}

					// Some endpoints return reasoning in reasoning_content (llama.cpp),
					// or reasoning (other openai compatible endpoints)
					// Use the first non-empty reasoning field to avoid duplication
					// (e.g., chutes.ai returns both reasoning_content and reasoning with same content)
					const reasoningFields = ["reasoning_content", "reasoning", "reasoning_text"];
					const deltaFields = choice.delta as Record<string, unknown>;
					let foundReasoningField: string | null = null;
					for (const field of reasoningFields) {
						const value = deltaFields[field];
						if (typeof value === "string" && value.length > 0) {
							foundReasoningField = field;
							break;
						}
					}

					if (foundReasoningField) {
						const delta = deltaFields[foundReasoningField];
						if (typeof delta === "string" && delta.length > 0) {
							const block = ensureThinkingBlock(foundReasoningField);
							block.thinking += delta;
							stream.push({
								type: "thinking_delta",
								contentIndex: getContentIndex(block),
								delta,
								partial: output,
							});
						}
					}

					if (choice?.delta?.tool_calls) {
						for (const toolCall of choice.delta.tool_calls as StreamingToolCallDelta[]) {
							const block = ensureToolCallBlock(toolCall);
							if (!block.id && toolCall.id) {
								block.id = toolCall.id;
								toolCallBlocksById.set(toolCall.id, block);
							}
							const name = toolCall.function?.name ?? toolCall.custom?.name;
							if (!block.name && name) {
								block.name = name;
							}

							let delta = "";
							if (toolCall.function?.arguments) {
								delta = toolCall.function.arguments;
								block.partialArgs = (block.partialArgs ?? "") + toolCall.function.arguments;
								block.arguments = parseStreamingJson(block.partialArgs);
							} else if (toolCall.custom?.input) {
								const nextInput = getCustomToolCallInput(block) + toolCall.custom.input;
								delta = appendCustomToolCallInput(block, nextInput, false) ?? "";
							}
							stream.push({
								type: "toolcall_delta",
								contentIndex: getContentIndex(block),
								delta,
								partial: output,
							});
						}
					}

					const reasoningDetails = (choice.delta as { reasoning_details?: unknown }).reasoning_details;
					if (Array.isArray(reasoningDetails)) {
						for (const detail of reasoningDetails) {
							if (!isOpenAIReasoningDetail(detail)) continue;
							ensureThinkingBlock("");
							streamedReasoningDetails ??= [];
							// Keep provider replay data in the existing signature slot. Some providers stream
							// reasoning_details as deltas: consecutive text/summary deltas are merged into
							// logical entries, while encrypted entries remain opaque and discrete.
							appendOpenAIReasoningDetail(streamedReasoningDetails, detail);
						}
					}
				}
			}

			for (const block of blocks) {
				finishBlock(block);
			}
			if (options?.signal?.aborted) {
				throw new Error("Request was aborted");
			}

			if (output.stopReason === "aborted") {
				throw new Error("Request was aborted");
			}
			if (!hasFinishReason && !compat.supportsFinishReason) {
				output.stopReason = output.content.some((block) => block.type === "toolCall") ? "toolUse" : "stop";
			}
			if (output.stopReason === "error") {
				throw new Error(output.errorMessage || "Provider returned an error stop reason");
			}
			if ((compat.supportsFinishReason && !hasFinishReason) || output.stopReason === "pending") {
				throw new Error("Stream ended without finish_reason");
			}

			releaseGate?.();
			stream.push({ type: "done", reason: output.stopReason, message: output });
			stream.end();
		} catch (error) {
			releaseGate?.();
			for (const block of output.content) {
				if (block.type === "thinking") {
					applyStreamedReasoningDetails(block);
				}
				delete (block as { index?: number }).index;
				// Streaming scratch buffers are only used during parsing; never persist them.
				delete (block as { partialArgs?: string }).partialArgs;
				delete (block as { customInput?: unknown }).customInput;
				delete (block as { streamIndex?: number }).streamIndex;
			}
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = formatProviderError(normalizeProviderError(error));
			// Some providers attach additional information under error.metadata.raw.
			// normalizeProviderError already stringifies the parsed body (error.error)
			// into errorMessage, so only append the raw metadata when it is not already
			// present to avoid double-printing it.
			const rawMetadata = (error as any)?.error?.metadata?.raw;
			if (rawMetadata && !output.errorMessage.includes(String(rawMetadata))) {
				output.errorMessage += `\n${rawMetadata}`;
			}
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
};

export const streamSimple: StreamFunction<"openai-completions", SimpleStreamOptions> = (
	model: Model<"openai-completions">,
	context: TranscriptContext,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
	getClientApiKey(model.provider, options?.apiKey, options?.headers);

	const thinkingLevel = options?.reasoning ?? "off";
	// No explicit cap: the model default, raised for deep thinking (see runInfraMaxTokens).
	const maxTokens = options?.maxTokens ?? runInfraMaxTokens(model, clampThinkingLevel(model, thinkingLevel));
	const base = {
		...buildBaseOptions(model, context, { ...options, maxTokens }, options?.apiKey),
		toolChoice: options?.toolChoice,
		thinkingLevel,
	} satisfies OpenAICompletionsOptions;
	return stream(model, context, base satisfies OpenAICompletionsOptions);
};

function createClient(
	model: Model<"openai-completions">,
	apiKey: string,
	optionsHeaders?: ProviderHeaders,
	fetch?: typeof globalThis.fetch,
	sessionId?: string,
	parentSessionId?: string,
) {
	const headers: ProviderHeaders = {
		"User-Agent": getRunKilnUserAgent(),
		...model.headers,
		...runInfraSessionHeaders(sessionId, parentSessionId),
	};
	// Merge options headers last so they can override defaults
	if (optionsHeaders) {
		Object.assign(headers, optionsHeaders);
	}

	return new OpenAI({
		apiKey,
		baseURL: model.baseUrl,
		dangerouslyAllowBrowser: true,
		fetch,
		defaultHeaders: headers,
	});
}

/**
 * The request body sent for `context`, without sending it. Exposed so tests can check that the
 * prompt prefix (system prompt, tools, earlier messages) stays byte-identical across turns.
 */
export function buildOpenAICompletionsParams(
	model: Model<"openai-completions">,
	context: TranscriptContext,
	options?: OpenAICompletionsOptions,
) {
	return buildParams(model, context, options);
}

function buildParams(
	model: Model<"openai-completions">,
	context: TranscriptContext,
	options?: OpenAICompletionsOptions,
	compat: ResolvedOpenAICompletionsCompat = getCompat(model),
	grammarToolInputProperties: ReadonlyMap<string, string> = createGrammarToolInputProperties(
		getDeclaredTools(context.messages),
		compat.supportsOpenAIGrammarTools,
	),
) {
	const transcriptTools = resolveTranscriptTools(
		context.messages,
		compat.supportsMidConvoSystemMessages === true && compat.supportsMidConvoToolAdditions === true,
	);
	const messages = convertMessages(model, context, compat, {
		grammarToolInputProperties,
	});

	const params: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming = {
		model: model.id,
		messages,
		stream: true,
		stream_options: { include_usage: true },
	};

	if (options?.maxTokens) {
		params.max_completion_tokens = options.maxTokens;
	}

	if (options?.temperature !== undefined) {
		params.temperature = options.temperature;
	}

	if (transcriptTools.requestTools.length > 0) {
		params.tools = convertTools(transcriptTools.requestTools, compat);
	} else if (hasToolHistory(context.messages)) {
		params.tools = [];
	}

	if (options?.toolChoice) {
		params.tool_choice = options.toolChoice;
	}

	// RunKiln: the effort for the requested thinking level, or the model's fixed harness effort.
	const reasoningEffort = resolveReasoningEffort(model, options?.thinkingLevel);
	if (reasoningEffort) {
		(params as { reasoning_effort?: string }).reasoning_effort = reasoningEffort;
	}

	// Last so model and request sampling parameters override named request fields.
	const samplingParams = resolveSamplingParams(model, "off", options?.samplingParams);
	if (samplingParams) {
		Object.assign(params, samplingParams);
	}

	return params;
}

export function convertMessages(
	model: Model<"openai-completions">,
	context: TranscriptContext,
	compat: ResolvedOpenAICompletionsCompat,
	options?: ConvertCompletionsMessagesOptions,
): ChatCompletionMessageParam[] {
	const normalizedContext = resolveTranscript(context, compat.supportsMidConvoSystemMessages);
	const params: ChatCompletionMessageParam[] = [];

	const normalizeToolCallId = (id: string): string => {
		// Handle pipe-separated IDs from OpenAI Responses API
		// Format: {call_id}|{id} where {id} can be 400+ chars with special chars (+, /, =)
		// These come from providers like github-copilot, openai-codex, opencode
		// Extract just the call_id part and normalize it
		// Multiple tool calls in the same turn can share call_id but differ by item_id.
		// Preserve item-level uniqueness when replaying into Chat Completions, which
		// requires distinct tool call ids.
		if (id.includes("|")) {
			// Sanitize to allowed chars and truncate to 40 chars (OpenAI limit)
			const separatorIndex = id.indexOf("|");
			const callId = id.slice(0, separatorIndex).replace(/[^a-zA-Z0-9_-]/g, "_");
			const itemId = id.slice(separatorIndex + 1).replace(/[^a-zA-Z0-9_-]/g, "_");
			const combinedId = itemId.length > 0 ? `${callId}_${itemId}` : callId;
			if (combinedId.length <= 40) {
				return combinedId;
			}
			const hash = shortHash(id).slice(0, 8);
			const prefix = callId.slice(0, Math.max(1, 40 - hash.length - 1));
			return `${prefix}_${hash}`;
		}

		return id;
	};

	const transformedMessages = transformMessages(normalizedContext.messages, model, (id) => normalizeToolCallId(id));
	const transcriptTools = resolveTranscriptTools(
		normalizedContext.messages,
		compat.supportsMidConvoSystemMessages === true && compat.supportsMidConvoToolAdditions === true,
	);
	const instructionRole = model.reasoning && compat.supportsDeveloperRole ? "developer" : "system";

	let lastRole: string | null = null;

	for (let i = 0; i < transformedMessages.length; i++) {
		const msg = transformedMessages[i];
		// Some providers don't allow user messages directly after tool results
		// Insert a synthetic assistant message to bridge the gap
		if (compat.requiresAssistantAfterToolResult && lastRole === "toolResult" && msg.role === "user") {
			params.push({
				role: "assistant",
				content: "I have processed the tool results.",
			});
		}

		if (msg.role === "system") {
			const addedTools = i > 0 && transcriptTools.anchorsAdditions ? (msg.toolsAdded ?? []) : [];
			if (addedTools.length > 0) {
				const kimiToolMessage: KimiToolSystemMessageParam = {
					role: "system",
					tools: convertTools(addedTools, compat),
				};
				params.push(kimiToolMessage as unknown as ChatCompletionMessageParam);
			}
			const text = i === 0 ? getSystemMessageText(msg) : renderSystemMessageUpdate(msg);
			if (text.length > 0) {
				params.push({ role: instructionRole, content: sanitizeSurrogates(text) });
			}
		} else if (msg.role === "user") {
			if (typeof msg.content === "string") {
				params.push({
					role: "user",
					content: sanitizeSurrogates(msg.content),
				});
			} else {
				const content: ChatCompletionContentPart[] = msg.content
					.filter((item) => item.type !== "text" || item.text.length > 0)
					.map((item): ChatCompletionContentPart => {
						if (item.type === "text") {
							return {
								type: "text",
								text: sanitizeSurrogates(item.text),
							} satisfies ChatCompletionContentPartText;
						} else {
							return {
								type: "image_url",
								image_url: {
									url: `data:${item.mimeType};base64,${item.data}`,
								},
							} satisfies ChatCompletionContentPartImage;
						}
					});
				if (content.length === 0) continue;
				params.push({
					role: "user",
					content,
				});
			}
		} else if (msg.role === "assistant") {
			// Some providers don't accept null content, use empty string instead
			const assistantMsg: ChatCompletionAssistantMessageParamWithReasoning = {
				role: "assistant",
				content: compat.requiresAssistantAfterToolResult ? "" : null,
			};

			const assistantTextParts = msg.content
				.filter(isTextContentBlock)
				.filter((block) => block.text.trim().length > 0)
				.map(
					(block) =>
						({
							type: "text",
							text: sanitizeSurrogates(block.text),
						}) satisfies ChatCompletionContentPartText,
				);
			const assistantText = assistantTextParts.map((part) => part.text).join("");

			const thinkingBlocks = msg.content.filter(isThinkingContentBlock);
			const toolCalls = msg.content.filter(isToolCallBlock);
			const signedReasoningDetails = thinkingBlocks
				.map((block) => parseOpenAIReasoningDetails(block.thinkingSignature))
				.find((details) => details !== undefined);
			const legacyReasoningDetails = toolCalls
				.map((toolCall) => parseLegacyEncryptedReasoningDetail(toolCall.thoughtSignature))
				.filter((detail): detail is OpenAIEncryptedReasoningDetail => detail !== undefined);
			const preservedReasoningDetails =
				signedReasoningDetails ?? (legacyReasoningDetails.length > 0 ? legacyReasoningDetails : undefined);

			const nonEmptyThinkingBlocks = thinkingBlocks.filter((block) => block.thinking.trim().length > 0);
			if (nonEmptyThinkingBlocks.length > 0) {
				if (compat.requiresThinkingAsText) {
					// Convert thinking blocks to plain text (no tags to avoid model mimicking them)
					const thinkingText = nonEmptyThinkingBlocks
						.map((block) => sanitizeSurrogates(block.thinking))
						.join("\n\n");
					assistantMsg.content = [{ type: "text", text: thinkingText }, ...assistantTextParts];
				} else {
					// Always send assistant content as a plain string (OpenAI Chat Completions
					// API standard format). Sending as an array of {type:"text", text:"..."}
					// objects is non-standard and causes some models (e.g. DeepSeek V3.2 via
					// NVIDIA NIM) to mirror the content-block structure literally in their
					// output, producing recursive nesting like [{'type':'text','text':'[{...}]'}].
					if (assistantText.length > 0) {
						assistantMsg.content = assistantText;
					}

					// reasoning_details is the structured alternative to a raw reasoning field.
					if (!preservedReasoningDetails) {
						// Use the signature from the first thinking block if available (for llama.cpp server + gpt-oss)
						const signature = nonEmptyThinkingBlocks[0].thinkingSignature;
						if (signature && isOpenAICompletionsReasoningField(signature)) {
							assistantMsg[signature] = nonEmptyThinkingBlocks.map((block) => block.thinking).join("\n");
						}
					}
				}
			} else if (assistantText.length > 0) {
				// Always send assistant content as a plain string (OpenAI Chat Completions
				// API standard format). Sending as an array of {type:"text", text:"..."}
				// objects is non-standard and causes some models (e.g. DeepSeek V3.2 via
				// NVIDIA NIM) to mirror the content-block structure literally in their
				// output, producing recursive nesting like [{'type':'text','text':'[{...}]'}].
				assistantMsg.content = assistantText;
			}

			if (toolCalls.length > 0) {
				assistantMsg.tool_calls = toolCalls.map((tc): ChatCompletionMessageToolCall => {
					const customInputProperty = options?.grammarToolInputProperties?.get(tc.name);
					if (customInputProperty !== undefined) {
						return {
							id: tc.id,
							type: "custom",
							custom: {
								name: tc.name,
								input: sanitizeSurrogates(getGrammarToolInput(tc.name, tc.arguments, customInputProperty)),
							},
						};
					}
					return {
						id: tc.id,
						type: "function",
						function: {
							name: tc.name,
							arguments: JSON.stringify(tc.arguments),
						},
					};
				});
			}
			if (preservedReasoningDetails) {
				assistantMsg.reasoning_details = preservedReasoningDetails;
			}
			if (
				compat.requiresReasoningContentOnAssistantMessages &&
				model.reasoning &&
				assistantMsg.reasoning_content === undefined
			) {
				assistantMsg.reasoning_content = "";
			}
			// Skip assistant messages that have no content and no tool calls.
			// Some providers require "either content or tool_calls, but not none".
			// Other providers also don't accept empty assistant messages.
			// This handles aborted assistant responses that got no content.
			const content = assistantMsg.content;
			const hasContent =
				content !== null &&
				content !== undefined &&
				(typeof content === "string" ? content.length > 0 : content.length > 0);
			if (!hasContent && !assistantMsg.tool_calls) {
				continue;
			}
			params.push(assistantMsg);
		} else if (msg.role === "toolResult") {
			const imageBlocks: Array<{ type: "image_url"; image_url: { url: string } }> = [];
			let j = i;

			for (; j < transformedMessages.length && transformedMessages[j].role === "toolResult"; j++) {
				const toolMsg = transformedMessages[j] as ToolResultMessage;

				// Extract text and image content
				const textResult = toolMsg.content
					.filter(isTextContentBlock)
					.map((block) => block.text)
					.join("\n");
				const hasImages = toolMsg.content.some((c) => c.type === "image");

				// Always send tool result with text (or placeholder if only images)
				const hasText = textResult.length > 0;
				const toolResultText = hasText ? textResult : hasImages ? "(see attached image)" : "(no tool output)";
				// Some providers require the 'name' field in tool results
				const toolResultMsg: ChatCompletionToolMessageParam = {
					role: "tool",
					content: sanitizeSurrogates(toolResultText),
					tool_call_id: toolMsg.toolCallId,
				};
				if (compat.requiresToolResultName && toolMsg.toolName) {
					(toolResultMsg as any).name = toolMsg.toolName;
				}
				params.push(toolResultMsg);

				if (hasImages && model.input.includes("image")) {
					for (const block of toolMsg.content) {
						if (isImageContentBlock(block)) {
							imageBlocks.push({
								type: "image_url",
								image_url: {
									url: `data:${block.mimeType};base64,${block.data}`,
								},
							});
						}
					}
				}
			}

			i = j - 1;

			if (imageBlocks.length > 0) {
				if (compat.requiresAssistantAfterToolResult) {
					params.push({
						role: "assistant",
						content: "I have processed the tool results.",
					});
				}

				params.push({
					role: "user",
					content: [
						{
							type: "text",
							text: "Attached image(s) from tool result:",
						},
						...imageBlocks,
					],
				});
				lastRole = "user";
			} else {
				lastRole = "toolResult";
			}

			continue;
		}

		lastRole = msg.role;
	}

	return params;
}

function convertTools(
	tools: Tool[],
	compat: ResolvedOpenAICompletionsCompat,
): OpenAI.Chat.Completions.ChatCompletionTool[] {
	return tools.map((tool) => {
		const grammar = resolveGrammarConstrainedSampling(tool, compat.supportsOpenAIGrammarTools);
		if (grammar) {
			return {
				type: "custom",
				custom: {
					name: tool.name,
					description: tool.description,
					format: {
						type: "grammar",
						grammar: {
							syntax: grammar.format,
							definition: grammar.definition,
						},
					},
				},
			};
		}

		const strict = resolveJsonSchemaStrictSampling(tool, compat.supportsStrictMode !== false);
		return {
			type: "function",
			function: {
				name: tool.name,
				description: tool.description,
				parameters: getJsonSchemaToolParameters(tool, strict) as Record<string, unknown>,
				// Only include strict if provider supports it. Some reject unknown fields.
				...(compat.supportsStrictMode !== false && { strict: strict ?? false }),
			},
		};
	});
}

/** Raw `usage` object of a Chat Completions response or final stream chunk. */
export interface OpenAICompletionsRawUsage {
	prompt_tokens?: number;
	completion_tokens?: number;
	cached_tokens?: number;
	prompt_cache_hit_tokens?: number;
	prompt_tokens_details?: {
		cached_tokens?: number | null;
		cache_write_tokens?: number;
		/**
		 * RunInfra: prompt tokens written to the prefix cache by this request. Informational only:
		 * they are billed at the normal input rate (no write premium), so they stay in `input`.
		 */
		created_cache_tokens?: number | null;
	} | null;
	completion_tokens_details?: { reasoning_tokens?: number } | null;
	/** RunInfra: its own accounting, `cached_input_tokens` mirrors `prompt_tokens_details.cached_tokens`. */
	runinfra?: { cached_input_tokens?: number; cost_microcents?: number } | null;
	/** RunInfra and OpenRouter: what the request was billed, in USD. */
	cost?: number | null;
}

/** USD the server billed for the request: `usage.cost`, else `usage.runinfra.cost_microcents` (1e-8 USD each). */
export function serverBilledCost(rawUsage: OpenAICompletionsRawUsage): number | undefined {
	const direct = rawUsage.cost;
	if (typeof direct === "number" && Number.isFinite(direct) && direct >= 0) return direct;
	const microcents = rawUsage.runinfra?.cost_microcents;
	if (typeof microcents === "number" && Number.isFinite(microcents) && microcents >= 0) return microcents / 1e8;
	return undefined;
}

/**
 * Normalize a Chat Completions usage object into token buckets and cost.
 *
 * RunInfra reports prefix-cache hits in `prompt_tokens_details.cached_tokens` (and again in
 * `usage.runinfra.cached_input_tokens`); hits are counted in 128-token blocks and billed at the
 * model's cached-input price (`cost.cacheRead`).
 */
export function parseOpenAICompletionsUsage(
	rawUsage: OpenAICompletionsRawUsage,
	model: Model<"openai-completions">,
): AssistantMessage["usage"] {
	return parseChunkUsage(rawUsage, model);
}

function parseChunkUsage(
	rawUsage: OpenAICompletionsRawUsage,
	model: Model<"openai-completions">,
): AssistantMessage["usage"] {
	const promptTokens = rawUsage.prompt_tokens || 0;
	const cacheReadTokens = Math.min(
		promptTokens,
		rawUsage.prompt_tokens_details?.cached_tokens ??
			rawUsage.prompt_cache_hit_tokens ??
			rawUsage.cached_tokens ??
			rawUsage.runinfra?.cached_input_tokens ??
			0,
	);
	const cacheWriteTokens = rawUsage.prompt_tokens_details?.cache_write_tokens || 0;

	// Follow documented OpenAI semantics: cached_tokens is cache-read
	// tokens (hits). Providers disagree on placement: OpenAI uses
	// prompt_tokens_details.cached_tokens, DeepSeek uses prompt_cache_hit_tokens,
	// and Kimi documents top-level usage.cached_tokens on the final usage chunk.
	// OpenAI does not document or emit cache_write_tokens, but
	// some OpenAI-compatible providers include it as a separate write count.
	// Do not subtract writes from cached_tokens, otherwise spec-compliant
	// providers are under-reported. DS4 mirrors this contract too:
	// https://github.com/antirez/ds4/pull/29
	const input = Math.max(0, promptTokens - cacheReadTokens - cacheWriteTokens);
	// OpenAI completion_tokens already includes reasoning_tokens.
	const outputTokens = rawUsage.completion_tokens || 0;
	const usage: AssistantMessage["usage"] = {
		input,
		output: outputTokens,
		cacheRead: cacheReadTokens,
		cacheWrite: cacheWriteTokens,
		reasoning: rawUsage.completion_tokens_details?.reasoning_tokens || 0,
		totalTokens: input + outputTokens + cacheReadTokens + cacheWriteTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	calculateCost(model, usage);
	applyServerCost(usage, serverBilledCost(rawUsage));
	return usage;
}

/**
 * Prefer what the server billed over the catalog estimate: `cost.total` becomes the billed amount and the buckets are
 * scaled to sum to it (an unpriced model puts it all in `input`). Marks the usage `costSource: "server"`.
 */
export function applyServerCost(usage: AssistantMessage["usage"], billed: number | undefined): void {
	if (billed === undefined) return;
	const estimate = usage.cost.total;
	if (estimate > 0) {
		const scale = billed / estimate;
		usage.cost.input *= scale;
		usage.cost.output *= scale;
		usage.cost.cacheRead *= scale;
		usage.cost.cacheWrite *= scale;
	} else {
		usage.cost.input = billed;
		usage.cost.output = 0;
		usage.cost.cacheRead = 0;
		usage.cost.cacheWrite = 0;
	}
	usage.cost.total = billed;
	usage.costSource = "server";
}

function mapStopReason(reason: ChatCompletionChunk.Choice["finish_reason"] | string): {
	stopReason: StopReason;
	errorMessage?: string;
} {
	if (reason === null) return { stopReason: "stop" };
	switch (reason) {
		case "stop":
		case "end":
			return { stopReason: "stop" };
		case "length":
			return { stopReason: "length" };
		case "function_call":
		case "tool_calls":
			return { stopReason: "toolUse" };
		case "content_filter":
			return { stopReason: "error", errorMessage: "Provider finish_reason: content_filter" };
		case "network_error":
			return { stopReason: "error", errorMessage: "Provider finish_reason: network_error" };
		default:
			return {
				stopReason: "error",
				errorMessage: `Provider finish_reason: ${reason}`,
			};
	}
}

/** RunInfra is the only endpoint: one fixed, verified compatibility profile. */
const RUNINFRA_COMPAT: ResolvedOpenAICompletionsCompat = {
	supportsStore: false,
	supportsDeveloperRole: false,
	supportsReasoningEffort: true,
	supportsUsageInStreaming: true,
	supportsFinishReason: true,
	maxTokensField: "max_completion_tokens",
	requiresToolResultName: false,
	requiresAssistantAfterToolResult: false,
	requiresThinkingAsText: false,
	requiresReasoningContentOnAssistantMessages: false,
	thinkingFormat: "openai",
	chatTemplateKwargs: {},
	chatTemplateArgs: {},
	zaiToolStream: false,
	supportsStrictMode: false,
	supportsOpenAIGrammarTools: false,
	supportsMidConvoSystemMessages: false,
	supportsMidConvoToolAdditions: false,
	// RunInfra's x-session-id comes from runInfraSessionHeaders, so no session-affinity format is set.
	supportsLongCacheRetention: false,
};

function getCompat(_model: Model<"openai-completions">): ResolvedOpenAICompletionsCompat {
	return RUNINFRA_COMPAT;
}
