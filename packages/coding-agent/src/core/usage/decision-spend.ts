/**
 * What one decision-model call cost: the auto router's classifier and the auto permission judge, on Jev (TypeSafe) or
 * a decision model on OpenRouter. Both answer the System One shape with a `usage` object:
 * `{ input_tokens, output_tokens, cost? }`. OpenRouter bills `usage.cost` (USD); Jev direct does not say, so the cost
 * is estimated from the input price and marked `estimated`.
 */

import type { Usage } from "@runkiln/ai";
import { BUILTIN_DECISION_MODELS } from "../router/decision-models.ts";

/** Jev direct (TypeSafe) input price, USD per million tokens (decision models bill input only). */
export const JEV_PRICE_PER_M_INPUT = 0.042;

export type DecisionBackend = "jev" | "openrouter";

export interface DecisionSpend {
	backend: DecisionBackend;
	/** Jev model name or OpenRouter model id. */
	model: string;
	inputTokens: number;
	outputTokens: number;
	/** USD. */
	cost: number;
	/** True when the response did not bill a cost and it was estimated from the input price. */
	estimated: boolean;
	/** Request round trip. */
	ms?: number;
}

function finite(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** USD per million input tokens for a decision model: the benched price, else Jev's. */
export function decisionModelPrice(model: string): number {
	const id = model.replace(/^~/, "");
	return (
		BUILTIN_DECISION_MODELS.find((entry) => entry.id === id || id.startsWith(`${entry.id}-`))?.pricePerMTokIn ??
		JEV_PRICE_PER_M_INPUT
	);
}

/**
 * The spend of a System One response, or undefined when it reports no usage at all (nothing to count). A billed
 * `usage.cost` wins; otherwise input tokens × the model's input price, marked estimated.
 */
export function decisionSpendFromResponse(
	response: unknown,
	backend: DecisionBackend,
	model: string,
	ms?: number,
): DecisionSpend | undefined {
	if (!response || typeof response !== "object") return undefined;
	const usage = (response as { usage?: unknown }).usage;
	if (!usage || typeof usage !== "object") return undefined;
	const raw = usage as Record<string, unknown>;
	const inputTokens = finite(raw.input_tokens) ?? finite(raw.prompt_tokens) ?? 0;
	const outputTokens = finite(raw.output_tokens) ?? finite(raw.completion_tokens) ?? 0;
	const billed = finite(raw.cost);
	const responseModel =
		typeof (response as { model?: unknown }).model === "string" ? (response as { model: string }).model : model;
	if (billed === undefined && inputTokens === 0 && outputTokens === 0) return undefined;
	return {
		backend,
		model,
		inputTokens,
		outputTokens,
		cost: billed ?? (inputTokens * decisionModelPrice(responseModel)) / 1_000_000,
		estimated: billed === undefined,
		...(ms !== undefined ? { ms: Math.round(ms) } : {}),
	};
}

/** A decision call as a session `Usage` (for a `usage` entry): input tokens and the cost, all in the input bucket. */
export function decisionSpendToUsage(spend: DecisionSpend): Usage {
	return {
		input: spend.inputTokens,
		output: spend.outputTokens,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: spend.inputTokens + spend.outputTokens,
		cost: { input: spend.cost, output: 0, cacheRead: 0, cacheWrite: 0, total: spend.cost },
		...(spend.estimated ? {} : { costSource: "server" as const }),
	};
}

/** Note on a decision usage entry: `est.` marks an estimated cost, then the round trip. */
export function decisionSpendNote(spend: DecisionSpend): string {
	return [spend.estimated ? "est." : undefined, spend.ms !== undefined ? `${spend.ms}ms` : undefined]
		.filter(Boolean)
		.join(" ");
}
