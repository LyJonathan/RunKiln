import type { AgentSessionRuntimeDiagnostic } from "./agent-session-services.ts";
import type { SettingsManager } from "./settings-manager.ts";

export function collectSettingsDiagnostics(settingsManager: SettingsManager): AgentSessionRuntimeDiagnostic[] {
	const diagnostics: AgentSessionRuntimeDiagnostic[] = settingsManager.drainErrors().map(({ scope, path, error }) => ({
		type: "warning",
		message: path ? `Invalid settings file ${path}: ${error.message}` : `Invalid ${scope} settings: ${error.message}`,
	}));
	const ignored = settingsManager.getIgnoredProjectSettings();
	if (ignored.length > 0) {
		diagnostics.push({
			type: "warning",
			message: `Ignored in project settings: ${ignored.join(", ")}. Project settings can't set ${ignored.length === 1 ? "it" : "them"}; use global settings.`,
		});
	}
	return diagnostics;
}

/**
 * Remove duplicate type/message diagnostics while preserving their first occurrence.
 * Startup and runtime settings managers can report the same file error.
 */
export function deduplicateDiagnostics(
	diagnostics: readonly AgentSessionRuntimeDiagnostic[],
): AgentSessionRuntimeDiagnostic[] {
	const seen = new Set<string>();
	return diagnostics.filter((diagnostic) => {
		const key = `${diagnostic.type}\0${diagnostic.message}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}
