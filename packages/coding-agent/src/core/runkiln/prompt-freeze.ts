/**
 * The system prompt and tool declarations are frozen on the first request of a session and never change after
 * that, so every request extends the previous one byte for byte and the provider prefix cache keeps hitting.
 *
 * - Tools: the declared list, descriptions and schemas stay as frozen. Turning a tool off later (settings,
 *   /reload, an extension) is enforced when it is called; a tool turned on later is declared in the next session.
 * - Prompt sections that change later (project instructions, skills, the appended prompt after /reload) reach the
 *   model as one hidden note appended after the next user message, never as an edit of the prefix.
 */

export interface PromptTool {
	name: string;
	description: string;
	parameters: unknown;
}

export interface FrozenPrompt {
	systemText: string;
	toolsKey: string;
	toolNames: string[];
	hiddenTools: string[];
	/** Sections as frozen (structured prompts; empty for a forced or legacy plain prompt). */
	sections: Record<string, string>;
	/** Declarations as frozen: the tools are always sent with these descriptions and schemas. */
	declarations: PromptTool[];
}

/** Stable encoding of the tool declarations a request would send. */
export function toolsSignature(tools: readonly PromptTool[]): string {
	const rows = tools.map((tool) => ({
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters,
	}));
	rows.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	return JSON.stringify(rows);
}

/**
 * Returns a message when `systemText` or `toolsKey` differ from the freeze.
 * Identical inputs return undefined.
 */
export function promptDrift(
	frozen: Pick<FrozenPrompt, "systemText" | "toolsKey">,
	systemText: string,
	toolsKey: string,
): string | undefined {
	const changed: string[] = [];
	if (frozen.systemText !== systemText) changed.push("system prompt");
	if (frozen.toolsKey !== toolsKey) changed.push("tools");
	if (changed.length === 0) return undefined;
	return `Kept the session's frozen ${changed.join(" and ")}; a later change was not sent.`;
}

/**
 * Sections never re-sent as a note: the ones that follow the frozen tool list, and a legacy session's cwd (new
 * prompts carry the cwd in the first user message instead; a session's cwd never changes, so the frozen one holds).
 */
const TOOL_BOUND_SECTIONS = new Set(["preamble", "tools", "rules", "cwd"]);

/**
 * The hidden note for prompt sections that changed after the freeze (`previous`: what the model has, the frozen
 * sections or the last note's), or undefined when nothing it can act on changed.
 */
export function promptUpdateNote(
	previous: Readonly<Record<string, string>>,
	current: Readonly<Record<string, string>>,
): string | undefined {
	const changed: string[] = [];
	const removed: string[] = [];
	for (const [name, text] of Object.entries(current)) {
		if (TOOL_BOUND_SECTIONS.has(name)) continue;
		if (previous[name] !== text) changed.push(text);
	}
	for (const name of Object.keys(previous)) {
		if (TOOL_BOUND_SECTIONS.has(name)) continue;
		if (current[name] === undefined) removed.push(name);
	}
	if (changed.length === 0 && removed.length === 0) return undefined;
	const lines = [
		"[Session update, not from the user] The settings, instructions or skills were reloaded. The parts below replace the matching parts of the system prompt from now on.",
	];
	for (const name of removed) lines.push(`<${name}> no longer applies.`);
	lines.push(...changed);
	return lines.join("\n\n");
}
