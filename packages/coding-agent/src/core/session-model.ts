import type { SessionEntry } from "./session-manager.ts";

/**
 * The model a session branch last selected: the latest `model_change` entry, or the model of the
 * latest assistant message when it comes later.
 */
export function getBranchSelection(branch: readonly SessionEntry[]): { provider: string; modelId: string } | undefined {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type === "model_change") {
			return { provider: entry.provider, modelId: entry.modelId };
		}
		if (entry.type === "message" && entry.message.role === "assistant") {
			return { provider: entry.message.provider, modelId: entry.message.model };
		}
	}
	return undefined;
}
