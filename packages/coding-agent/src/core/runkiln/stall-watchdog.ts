/**
 * First-token stall check. A request that has streamed nothing (no text, thinking or tool-call token)
 * after `timeoutMs` is aborted and ends as an error whose message says it timed out, so the session's
 * retry and failover treat it like any other transient provider failure. Once the first token arrives the
 * check is off: a long answer is never cut, and a mid-stream hang is left to the HTTP idle timeout
 * (httpIdleTimeoutMs), which ends the stream with a retryable error too.
 */

import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEvent,
	type AssistantMessageEventStream,
	createAssistantMessageEventStream,
	type Model,
} from "@runkiln/ai";

/** The error text of a stalled request. Contains "timed out" so isRetryableAssistantError retries it. */
export function stallErrorMessage(modelId: string, timeoutMs: number): string {
	return `Request to ${modelId} timed out: no first token within ${Math.round(timeoutMs / 1000)} s (stalled)`;
}

export function isStallError(message: AssistantMessage | undefined): boolean {
	return !!message?.errorMessage && /\(stalled\)$/.test(message.errorMessage);
}

const TOKEN_EVENTS = new Set<AssistantMessageEvent["type"]>([
	"text_start",
	"text_delta",
	"thinking_start",
	"thinking_delta",
	"toolcall_start",
	"toolcall_delta",
	"done",
]);

function emptyMessage(model: Model<Api>): AssistantMessage {
	return {
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
		stopReason: "error",
		timestamp: Date.now(),
	};
}

/**
 * Starts the request with an abort signal linked to `signal` and watches it for a first token. When
 * `timeoutMs` is 0 (or not finite) the request runs unwatched.
 */
export function withFirstTokenTimeout(
	start: (signal: AbortSignal | undefined) => AssistantMessageEventStream,
	options: { model: Model<Api>; timeoutMs: number; signal?: AbortSignal },
): AssistantMessageEventStream {
	const { model, timeoutMs, signal } = options;
	if (!(timeoutMs > 0) || !Number.isFinite(timeoutMs)) return start(signal);
	const controller = new AbortController();
	const onAbort = () => controller.abort(signal?.reason);
	if (signal?.aborted) controller.abort(signal.reason);
	else signal?.addEventListener("abort", onAbort, { once: true });

	const out = createAssistantMessageEventStream();
	let partial: AssistantMessage | undefined;
	let stalled = false;
	const timer = setTimeout(() => {
		stalled = true;
		const base = partial ?? emptyMessage(model);
		const error: AssistantMessage = {
			...base,
			content: [],
			stopReason: "error",
			errorMessage: stallErrorMessage(model.id, timeoutMs),
		};
		// The error ends `out` at once; whatever the aborted request yields after it is dropped.
		out.push({ type: "error", reason: "error", error });
		out.end();
		controller.abort(new Error("stalled"));
	}, timeoutMs);
	const clear = () => {
		clearTimeout(timer);
		signal?.removeEventListener("abort", onAbort);
	};

	let source: AssistantMessageEventStream;
	try {
		source = start(controller.signal);
	} catch (error) {
		clear();
		throw error;
	}
	void (async () => {
		try {
			for await (const event of source) {
				if (stalled) break;
				if (event.type === "start") partial = event.partial;
				if (TOKEN_EVENTS.has(event.type) || event.type === "error") clearTimeout(timer);
				out.push(event);
			}
		} catch (error) {
			if (!stalled) {
				out.push({
					type: "error",
					reason: "error",
					error: {
						...(partial ?? emptyMessage(model)),
						stopReason: "error",
						errorMessage: error instanceof Error ? error.message : String(error),
					},
				});
			}
		} finally {
			clear();
			out.end();
		}
	})();
	return out;
}
