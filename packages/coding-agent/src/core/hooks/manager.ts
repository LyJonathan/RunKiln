/**
 * Hook manager: which hooks are configured and trusted, and running the ones that match an event.
 *
 * Results of all matching hooks (run in parallel) are folded into one {@link HookEventResult}: any block wins, the
 * first JSON permission decision wins, context strings are joined. The session-side bridge (bridge.ts) maps the
 * result onto RunKiln's extension events.
 */

import { parseRule, restrictiveRuleMatches } from "../runkiln/permission-rules.ts";
import {
	type HookEntry,
	type HookEventName,
	type LoadedHooks,
	loadHooks,
	matcherMatches,
	projectHooksFingerprint,
	toolMatchValues,
} from "./config.ts";
import {
	type HookOutcome,
	type HookOutputJson,
	interpretHookRun,
	runCommandHook,
	sanitizeHookContext,
} from "./exec.ts";
import type { CommandTrustStore } from "./trust.ts";

export interface HookEventResult {
	/** Hooks that ran. */
	ran: number;
	/** A hook blocked (exit 2, decision "block"/"deny", or a failure with onFailure "block"). */
	blocked: boolean;
	/** The block reasons, joined. */
	reason?: string;
	/** PreToolUse: "ask" from a hook. */
	ask?: { reason: string };
	/** PreToolUse: replacement tool input. */
	updatedInput?: Record<string, unknown>;
	/** PostToolUse: replacement tool output. */
	updatedToolOutput?: unknown;
	/** additionalContext strings and plain stdout of events that add it (UserPromptSubmit, SessionStart). */
	context: string[];
	/** systemMessage strings, shown to the user. */
	messages: string[];
	/** Non-blocking errors (one line each), shown to the user. */
	errors: string[];
	/** `continue: false`: stop the agent. */
	stop?: { reason?: string };
}

export interface HookRunContext {
	/** The value matchers are tested against (tool name, source, trigger, notification type, agent name). */
	matchValues?: readonly string[];
	/** Tool events: the tool call, for `if` filters. */
	tool?: { name: string; input: unknown };
	signal?: AbortSignal;
}

/** Events where plain stdout on exit 0 becomes context for the model. */
const STDOUT_IS_CONTEXT: ReadonlySet<HookEventName> = new Set(["UserPromptSubmit", "SessionStart"]);

export interface HookManagerOptions {
	cwd: string;
	trust: CommandTrustStore;
	globalSettings: () => Record<string, unknown>;
	projectTrusted: () => boolean;
	/** Fields every hook input carries (session_id, transcript_path, permission_mode). */
	commonInput: () => Record<string, unknown>;
}

export class HookManager {
	private loaded: LoadedHooks = { entries: [], problems: [], skipped: 0, disabled: false };
	private readonly options: HookManagerOptions;

	constructor(options: HookManagerOptions) {
		this.options = options;
		this.reload();
	}

	get cwd(): string {
		return this.options.cwd;
	}

	/** Re-read the settings files. */
	reload(): void {
		this.loaded = loadHooks({
			globalSettings: this.options.globalSettings(),
			cwd: this.options.cwd,
			projectTrusted: this.options.projectTrusted(),
		});
	}

	get config(): LoadedHooks {
		return this.loaded;
	}

	/** Fingerprint of the project hooks, or undefined when the project has none. */
	get projectFingerprint(): string | undefined {
		return projectHooksFingerprint(this.loaded.entries);
	}

	/** Whether the project's hooks are approved (true when it has none). */
	get projectHooksTrusted(): boolean {
		const fingerprint = this.projectFingerprint;
		return fingerprint === undefined || this.options.trust.isHooksTrusted(this.options.cwd, fingerprint);
	}

	/** The project hooks waiting for approval. */
	get untrustedProjectHooks(): HookEntry[] {
		return this.projectHooksTrusted ? [] : this.loaded.entries.filter((entry) => entry.scope !== "global");
	}

	trustProjectHooks(remember: boolean): void {
		const fingerprint = this.projectFingerprint;
		if (fingerprint) this.options.trust.trustHooks(this.options.cwd, fingerprint, remember);
	}

	/** Hooks that run now: global ones, plus project ones once approved. */
	activeEntries(): HookEntry[] {
		const trusted = this.projectHooksTrusted;
		return this.loaded.entries.filter((entry) => entry.scope === "global" || trusted);
	}

	hasHooks(event: HookEventName): boolean {
		return this.activeEntries().some((entry) => entry.event === event);
	}

	/** The hooks that match an event. */
	matching(event: HookEventName, context: HookRunContext = {}): HookEntry[] {
		const values = context.matchValues ?? (context.tool ? toolMatchValues(context.tool.name) : []);
		return this.activeEntries().filter((entry) => {
			if (entry.event !== event) return false;
			if (context.matchValues || context.tool) {
				if (!matcherMatches(entry.matcher, values)) return false;
			}
			if (entry.hook.if) {
				// `if` only applies to tool events; elsewhere a hook with `if` never runs (Claude Code).
				if (!context.tool) return false;
				const rule = parseRule(entry.hook.if);
				if ("error" in rule) return false;
				if (!restrictiveRuleMatches(rule, context.tool.name, context.tool.input, this.options.cwd)) return false;
			}
			return true;
		});
	}

	/** Run every matching hook of an event in parallel and fold the results. */
	async run(
		event: HookEventName,
		fields: Record<string, unknown>,
		context: HookRunContext = {},
	): Promise<HookEventResult> {
		const result: HookEventResult = { ran: 0, blocked: false, context: [], messages: [], errors: [] };
		const entries = this.matching(event, context);
		if (entries.length === 0) return result;
		const input = { ...this.options.commonInput(), cwd: this.options.cwd, hook_event_name: event, ...fields };
		const outcomes = await Promise.all(
			entries.map(async (entry) => {
				const run = await runCommandHook(entry.hook, input, {
					cwd: this.options.cwd,
					event,
					signal: context.signal,
				});
				return interpretHookRun(entry.hook, run);
			}),
		);
		result.ran = outcomes.length;
		const reasons: string[] = [];
		for (const outcome of outcomes) foldOutcome(event, outcome, result, reasons);
		if (reasons.length > 0) result.reason = reasons.join("\n");
		return result;
	}
}

function foldOutcome(event: HookEventName, outcome: HookOutcome, result: HookEventResult, reasons: string[]): void {
	if (outcome.kind === "error") {
		if (outcome.error) result.errors.push(`${event} hook error: ${outcome.error}`);
		return;
	}
	const json: HookOutputJson | undefined = outcome.json;
	if (outcome.kind === "block") {
		result.blocked = true;
		if (outcome.reason) reasons.push(outcome.reason);
	}
	if (!json) {
		if (outcome.kind === "success" && outcome.text && STDOUT_IS_CONTEXT.has(event)) {
			result.context.push(sanitizeHookContext(outcome.text));
		}
		return;
	}
	if (typeof json.systemMessage === "string" && json.systemMessage.trim()) {
		result.messages.push(sanitizeHookContext(json.systemMessage));
	}
	if (json.continue === false) {
		result.stop = { ...(json.stopReason ? { reason: json.stopReason } : {}) };
	}
	const specific = json.hookSpecificOutput;
	if (specific?.additionalContext && typeof specific.additionalContext === "string") {
		result.context.push(sanitizeHookContext(specific.additionalContext));
	}
	if (event === "PreToolUse") {
		const decision = specific?.permissionDecision;
		const reason = specific?.permissionDecisionReason ?? json.reason;
		if (decision === "deny" || json.decision === "block" || json.decision === "deny") {
			result.blocked = true;
			if (outcome.kind !== "block") reasons.push(reason ?? "denied by a PreToolUse hook");
		} else if (decision === "ask" && !result.ask) {
			result.ask = { reason: reason ?? "a PreToolUse hook asks for confirmation" };
		}
		if (specific?.updatedInput && typeof specific.updatedInput === "object" && !result.updatedInput) {
			result.updatedInput = specific.updatedInput;
		}
		return;
	}
	if (
		event === "PostToolUse" &&
		specific &&
		"updatedToolOutput" in specific &&
		result.updatedToolOutput === undefined
	) {
		result.updatedToolOutput = specific.updatedToolOutput;
	}
	if (json.decision === "block") {
		result.blocked = true;
		if (outcome.kind !== "block") reasons.push(json.reason ?? `blocked by a ${event} hook`);
	}
}
