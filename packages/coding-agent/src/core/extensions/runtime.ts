import type { ExtensionRuntime } from "./types.ts";

/**
 * Shared runtime for the internal hook runner. RunKiln loads no extensions, so the runtime only
 * holds the action slots that the session binds; nothing can register tools, providers or
 * commands through it.
 */
export function createExtensionRuntime(): ExtensionRuntime {
	const notInitialized = () => {
		throw new Error("Extension runtime not initialized.");
	};
	const state: { staleMessage?: string } = {};
	const eventBusUnsubscribers = new Set<() => void>();

	return {
		sendMessage: notInitialized,
		sendUserMessage: notInitialized,
		appendEntry: notInitialized,
		setSessionName: notInitialized,
		getSessionName: notInitialized,
		setLabel: notInitialized,
		getActiveTools: notInitialized,
		getAllTools: notInitialized,
		getSettings: notInitialized,
		setActiveTools: notInitialized,
		refreshTools: () => {},
		getCommands: notInitialized,
		setModel: () => Promise.reject(new Error("Extension runtime not initialized")),
		getThinkingLevel: notInitialized,
		setThinkingLevel: notInitialized,
		flagValues: new Map(),
		createContext: notInitialized,
		assertActive: () => {
			if (state.staleMessage) throw new Error(state.staleMessage);
		},
		invalidate: (message) => {
			if (state.staleMessage) return;
			state.staleMessage = message ?? "This context is stale after session replacement or reload.";
			for (const unsubscribe of eventBusUnsubscribers) unsubscribe();
			eventBusUnsubscribers.clear();
		},
		trackEventBusSubscription: (unsubscribe) => {
			let active = true;
			const trackedUnsubscribe = () => {
				if (!active) return;
				active = false;
				eventBusUnsubscribers.delete(trackedUnsubscribe);
				unsubscribe();
			};
			eventBusUnsubscribers.add(trackedUnsubscribe);
			return trackedUnsubscribe;
		},
	};
}
