import type { Theme } from "../../../modes/interactive/theme/theme.ts";
import type { PostEditDetails } from "../edit.ts";

/** The post-edit diagnostics under an edit or write result. */
export function formatPostEditDiagnostics(details: PostEditDetails | undefined, theme: Theme): string | undefined {
	if (!details || details.lines.length === 0) return undefined;
	const counts = [
		details.newErrors > 0 ? `${details.newErrors} new error${details.newErrors === 1 ? "" : "s"}` : "",
		details.newWarnings > 0 ? `${details.newWarnings} new warning${details.newWarnings === 1 ? "" : "s"}` : "",
	]
		.filter(Boolean)
		.join(", ");
	const color = details.newErrors > 0 ? "error" : "warning";
	const header = `${theme.fg(color, details.newErrors > 0 ? "✗" : "⚠")} ${theme.fg(color, counts)} ${theme.fg("dim", `after edit - ${details.checkers.join(", ")}`)}`;
	const lines = details.lines.map((line) => {
		const match = /^(\S+) (error|warning)( \S+)?: (.*?)(?: \([^)]+\))?$/.exec(line);
		if (!match) return `  ${theme.fg("muted", line)}`;
		return `  ${theme.fg("dim", match[1])} ${theme.fg(match[2] === "error" ? "error" : "warning", match[2])}${theme.fg("dim", match[3] ?? "")} ${theme.fg("toolOutput", match[4])}`;
	});
	return [header, ...lines].join("\n");
}
