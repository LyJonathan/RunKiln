/**
 * Simple per-model health for one session: a model whose requests kept failing (retries used up, or a
 * stall) sits out a short cooldown. The router skips it while it cools down, failover never picks it,
 * and side tasks (titles, summaries) fall back to their next model. A later success clears it at once.
 */

export interface ModelHealthEntry {
	/** Consecutive failures since the last success. */
	failures: number;
	/** Epoch ms until which the model is avoided. */
	downUntil?: number;
	lastError?: string;
}

export interface ModelHealthOptions {
	/** Cooldown applied by markFailed when none is given. */
	cooldownMs: () => number;
	now?: () => number;
}

export class ModelHealth {
	private readonly entries = new Map<string, ModelHealthEntry>();
	private readonly options: ModelHealthOptions;

	constructor(options: ModelHealthOptions) {
		this.options = options;
	}

	private now(): number {
		return this.options.now?.() ?? Date.now();
	}

	/** The model failed: avoid it for the cooldown. */
	markFailed(modelId: string, error?: string, cooldownMs: number = this.options.cooldownMs()): void {
		const entry = this.entries.get(modelId) ?? { failures: 0 };
		entry.failures++;
		entry.downUntil = this.now() + Math.max(0, cooldownMs);
		if (error) entry.lastError = error;
		this.entries.set(modelId, entry);
	}

	/** A request on the model succeeded: it is healthy again. */
	markOk(modelId: string): void {
		this.entries.delete(modelId);
	}

	isHealthy(modelId: string): boolean {
		const until = this.entries.get(modelId)?.downUntil;
		return until === undefined || until <= this.now();
	}

	/** Milliseconds left in the model's cooldown (0 when healthy). */
	cooldownLeftMs(modelId: string): number {
		const until = this.entries.get(modelId)?.downUntil;
		return until === undefined ? 0 : Math.max(0, until - this.now());
	}

	/** Models currently cooling down. */
	down(): Array<{ modelId: string; leftMs: number; failures: number; lastError?: string }> {
		const result: Array<{ modelId: string; leftMs: number; failures: number; lastError?: string }> = [];
		for (const [modelId, entry] of this.entries) {
			const leftMs = this.cooldownLeftMs(modelId);
			if (leftMs > 0) result.push({ modelId, leftMs, failures: entry.failures, lastError: entry.lastError });
		}
		return result;
	}
}
