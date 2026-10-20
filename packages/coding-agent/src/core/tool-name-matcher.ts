/** Tool name matching for `--tools` and `--exclude-tools`: exact names or patterns where `*` matches any characters. */

function toolPatternRegExp(pattern: string): RegExp {
	const source = pattern
		.split("*")
		.map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
		.join(".*");
	return new RegExp(`^${source}$`);
}

/** Whether a tool name matches any of the entries, each an exact name or a pattern. */
export function createToolNameMatcher(entries: readonly string[]): (name: string) => boolean {
	const names = new Set(entries.filter((entry) => !entry.includes("*")));
	const patterns = entries.filter((entry) => entry.includes("*")).map(toolPatternRegExp);
	return (name) => names.has(name) || patterns.some((pattern) => pattern.test(name));
}
