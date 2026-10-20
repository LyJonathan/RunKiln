/**
 * AgentSession - Core abstraction for agent lifecycle and session management.
 *
 * This class is shared between all run modes (interactive, print, rpc).
 * It encapsulates:
 * - Agent state access
 * - Event subscription with automatic session persistence
 * - Model and thinking level management
 * - Compaction (manual and auto)
 * - Bash execution
 * - Session switching and branching
 *
 * Modes use this class and add their own I/O layer on top.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve as resolvePath } from "node:path";
import {
	type AfterToolCallContext,
	type AfterToolCallResult,
	type Agent,
	type AgentContext,
	type AgentEvent,
	type AgentMessage,
	type AgentState,
	type AgentTool,
	type AgentToolCallOutcome,
	type BeforeToolCallContext,
	type BeforeToolCallResult,
	type PrepareNextTurnContext,
	runToolCall,
	type ThinkingLevel,
} from "@runkiln/agent-core";
import { contentText, getCurrentSystemMessage, getSystemMessageText, jitteredRetryDelayMs } from "@runkiln/ai";
import type {
	AssistantMessage,
	AuthResult,
	ImageContent,
	Model,
	ProviderHeaders,
	SystemMessage,
	TextContent,
	ToolResultMessage,
	Usage,
} from "@runkiln/ai/compat";
import {
	clampThinkingLevel,
	cleanupSessionResources,
	getSupportedThinkingLevels,
	isContextOverflow,
	isRecoverableLength,
	isRetryableAssistantError,
	modelsAreEqual,
	type RetryCallbacks,
	resetApiProviders,
	streamSimple,
} from "@runkiln/ai/compat";
import { RUNINFRA_PROVIDER_ID } from "@runkiln/ai/providers/runinfra";
import { getAgentDir } from "../config.ts";
import { getThemeByName, theme } from "../modes/interactive/theme/theme.ts";
import { stripFrontmatter } from "../utils/frontmatter.ts";
import { processImage } from "../utils/image-process.ts";
import { hasBashShell, setShellEnvironmentPolicy } from "../utils/shell.ts";
import { sleep } from "../utils/sleep.ts";
import { normalizeToolResultImages } from "../utils/tool-result-images.ts";
import { AsyncMutex } from "./async-mutex.ts";
import { formatNoApiKeyFoundMessage, formatNoModelSelectedMessage } from "./auth-guidance.ts";
import { type BashResult, executeBashWithOperations } from "./bash-executor.ts";
import {
	type CompactionPreparation,
	type CompactionResult,
	calculateContextTokens,
	collectEntriesForBranchSummary,
	compact,
	compactionTriggerTokens,
	compactOnSessionPrefix,
	estimateContextTokens,
	estimateProjectedContextTokens,
	estimateTokens,
	generateBranchSummary,
	prepareCompaction,
	shouldCompact,
} from "./compaction/index.ts";
import { DEFAULT_THINKING_LEVEL, THINKING_LEVEL_OPTIONS } from "./defaults.ts";
import { exportSessionToHtml, type ToolHtmlRenderer } from "./export-html/index.ts";
import { createToolHtmlRenderer } from "./export-html/tool-renderer.ts";
import {
	type AgentActivityOutcome,
	type BoundaryContextPreview,
	type ContextUsage,
	type ExecuteToolOptions,
	type ExtensionCommandContextActions,
	type ExtensionErrorListener,
	type ExtensionMode,
	ExtensionRunner,
	type ExtensionUIContext,
	type InputSource,
	type MessageEndEvent,
	type MessageStartEvent,
	type MessageUpdateEvent,
	type ReplacedSessionContext,
	type SessionBeforeCompactResult,
	type SessionBeforeTreeResult,
	type SessionBoundaryDraft,
	type SessionCompactFailedEvent,
	type SessionStartEvent,
	type ShutdownHandler,
	type ToolDefinition,
	type ToolExecutionEndEvent,
	type ToolExecutionStartEvent,
	type ToolExecutionUpdateEvent,
	type ToolExposure,
	type ToolInfo,
	type ToolLoadout,
	type TreePreparation,
	type TurnStartEvent,
	wrapRegisteredTools,
} from "./extensions/index.ts";
import { type BeforeAgentStartTrigger, emitSessionShutdownEvent } from "./extensions/runner.ts";
import { claudePermissionMode, createHooksBridge, type HooksBridge } from "./hooks/bridge.ts";
import { HookManager } from "./hooks/manager.ts";
import { CommandTrustStore } from "./hooks/trust.ts";
import { McpManager } from "./mcp/manager.ts";
import { createMcpExtension, createMcpToolDefinition, MCP_TOOL_NAME } from "./mcp/tools.ts";
import { type BashExecutionMessage, type CustomMessage, convertToLlm } from "./messages.ts";
import { ModelRegistry } from "./model-registry.ts";
import type { ModelRuntime } from "./model-runtime.ts";
import { NestedToolCallRunner } from "./nested-tool-calls.ts";
import { expandPromptTemplate, type PromptTemplate } from "./prompt-templates.ts";
import { conversationText, getRepoMap } from "./repo-map/repo-map.ts";
import { createRepoMapToolDefinition, REPO_MAP_TOOL_NAME, repoMapCacheDir } from "./repo-map/tool.ts";
import type { ResourceExtensionPaths, ResourceLoader } from "./resource-loader.ts";
import { ModelHealth } from "./router/health.ts";
import {
	applyRouterOverrides,
	autoModelId,
	createModelRouter,
	DEFAULT_ROUTER_MODE,
	extractTurnSignals,
	formatRouterReport,
	harnessThinkingLevel,
	isAutoModel,
	isRouterMode,
	loadRouterCatalog,
	type ModelRouter,
	parseAutoMode,
	ROUTER_MODES,
	type RouteDecision,
	type RouterMode,
	type RouterOverrides,
	type RouterStatus,
	shortRouteReason,
} from "./router/index.ts";
import type { ToolCallOptions } from "./runkiln/approval.ts";
import { type ApprovalDiff, computeApprovalDiff } from "./runkiln/approval-preview.ts";
import { observeCallMetrics } from "./runkiln/call-metrics.ts";
import {
	type ChangeSummary,
	CheckpointStore,
	isCheckpointTool,
	type RestorePlan,
	type RestoreResult,
} from "./runkiln/checkpoints.ts";
import { type ChoreKind, type ChoreModelChoice, resolveChoreModel } from "./runkiln/chore-model.ts";
import {
	type CommitScope,
	commitCandidates,
	commitMessagePrompt,
	commitPaths,
	diffForCommit,
	fallbackCommitMessage,
	gitTopLevel,
	parseCommitMessage,
	withCoAuthor,
} from "./runkiln/git-workflow.ts";
import { idleCompactionDecision, lastCacheActivityAt } from "./runkiln/idle-compaction.ts";
import { DEFAULT_SESSION_IDLE_TTL_MS, sessionIdleTtlMs, warmTurnRequest } from "./runkiln/last-request.ts";
import { effectiveRoleDefaults, nextFallbackModel } from "./runkiln/model-roles.ts";
import type { ModelRole } from "./runkiln/models-catalog.ts";
import { createPermissionJudge, isPermissionJudgeAvailable } from "./runkiln/permission-judge.ts";
import {
	type IgnoredRule,
	type LoadedRules,
	loadRuleLists,
	parseRule,
	type RuleAction,
	type RuleScope,
} from "./runkiln/permission-rules.ts";
import {
	APPROVAL_OPTION_LABELS,
	type ApprovalAnswer,
	DEFAULT_PERMISSION_MODE,
	denialReason,
	getProcessPermissionMode,
	headlessDenialReason,
	isReadOnlyToolCall,
	PermissionGate,
	type PermissionJudge,
	type PermissionMode,
	type PermissionPrompt,
	parsePermissionMode,
	setProcessPermissionMode,
} from "./runkiln/permissions.ts";
import {
	PLAN_DISCARDED_NOTICE,
	PLAN_MODE_INSTRUCTIONS,
	PLAN_MODE_MESSAGE_TYPE,
	PLAN_MODE_REMINDER,
	planApprovedPrompt,
	planModeEndedNotice,
} from "./runkiln/plan-mode.ts";
import { type FrozenPrompt, type PromptTool, promptUpdateNote, toolsSignature } from "./runkiln/prompt-freeze.ts";
import {
	createRequestFitState,
	isPayloadTooLargeError,
	PAYLOAD_TOO_LARGE_FINAL,
	PAYLOAD_TOO_LARGE_RETRYING,
	type RequestFitState,
	stripImages,
} from "./runkiln/request-fit.ts";
import {
	collectReviewMaterial,
	REVIEW_MESSAGE_TYPE,
	REVIEW_WRITE_NOW,
	type ReviewMaterial,
	resolveReviewTarget,
	reviewBlockReason,
	reviewInstructions,
	reviewRequestText,
} from "./runkiln/review.ts";
import type { SessionChanges, SessionFileVersions } from "./runkiln/session-changes.ts";
import { backgroundSessionId } from "./runkiln/session-headers.ts";
import { parseSessionTitle, titleCallRouting, titleUserMessage } from "./runkiln/session-title.ts";
import {
	createTodoToolDefinition,
	currentTodoItems,
	TODO_NUDGE_MESSAGE_TYPE,
	TODO_TOOL_NAME,
	type TodoItem,
	todoNudgeText,
	unfinishedTodos,
} from "./runkiln/todo.ts";
import { exportSessionToJsonl } from "./session-export.ts";
import {
	type BranchSummaryEntry,
	type CompactionEntry,
	type ContextEditEntry,
	getLatestCompactionEntry,
	type SessionEntry,
	SessionManager,
	type SessionProjection,
} from "./session-manager.ts";
import { applyToolModifiers, platformDefaultToolNames, type SettingsManager } from "./settings-manager.ts";
import type { SlashCommandInfo } from "./slash-commands.ts";
import { BUILTIN_PATH_PREFIX, createSyntheticSourceInfo, isSyntheticPath, type SourceInfo } from "./source-info.ts";
import {
	buildSystemPrompt,
	buildSystemPromptSections,
	diffSystemPromptSections,
	type NormalizedBuildSystemPromptOptions,
	normalizeBuildSystemPromptOptions,
} from "./system-prompt.ts";
import { createToolNameMatcher } from "./tool-name-matcher.ts";
import { type BashOperations, createLocalBashOperations } from "./tools/bash.ts";
import { BASH_OUTPUT_TOOL_NAME, createBashOutputToolDefinition, describeJob, JobManager } from "./tools/bash-jobs.ts";
import { createAllToolDefinitions } from "./tools/index.ts";
import { createToolDefinitionFromAgentTool } from "./tools/tool-definition-wrapper.ts";
import { type BudgetStatus, evaluateBudgets } from "./usage/budget.ts";
import { type DecisionSpend, decisionSpendNote, decisionSpendToUsage } from "./usage/decision-spend.ts";
import { ledgerRowsForEntry, UsageLedgerWriter } from "./usage/ledger.ts";
import {
	buildSessionUsageReport,
	type ContextBreakdown,
	ROUTE_ENTRY_TYPE,
	type RouteEntryData,
	type SessionUsageReport,
	type UsagePriceSource,
} from "./usage/session-usage.ts";
import { addUsageToTotals, combineUsage, createUsageTotals } from "./usage-totals.ts";
import { PostEditChecks } from "./verify/post-edit.ts";
import { VerifyController } from "./verify/verify-loop.ts";

// ============================================================================
// Skill Block Parsing
// ============================================================================

/** Parsed skill block from a user message */
/** A user turn on the current branch, for /rewind and /undo. */

/** A /commit proposal: the files (relative to the repository top level) and the message to edit or confirm. */
export interface CommitDraft {
	scope: CommitScope;
	top: string;
	paths: string[];
	message: string;
	/** Chore-model cost of the message, USD. */
	costUsd: number;
	/** The chore model was unavailable: a generic message. */
	fallback: boolean;
}

export interface RewindPoint {
	/** Session entry id of the user message. */
	entryId: string;
	/** 1-based position among the branch's user messages. */
	turn: number;
	text: string;
	timestamp?: string;
	/** Set when the turn mutated files (or ran a shell command). */
	checkpointId?: string;
	summary?: ChangeSummary;
	/** The turn's file changes were already undone. */
	restored?: boolean;
}

export interface ParsedSkillBlock {
	name: string;
	location: string;
	content: string;
	userMessage: string | undefined;
}

/**
 * Parse a skill block from message text.
 * Returns null if the text doesn't contain a skill block.
 */
export function parseSkillBlock(text: string): ParsedSkillBlock | null {
	const match = text.match(/^<skill name="([^"]+)" location="([^"]+)">\n([\s\S]*?)\n<\/skill>(?:\n\n([\s\S]+))?$/);
	if (!match) return null;
	return {
		name: match[1],
		location: match[2],
		content: match[3],
		userMessage: match[4]?.trim() || undefined,
	};
}

/** Tool execution events of calls a tool made through `ctx.executeTool()` carry `parentToolCallId`. */
type WithParentToolCallId<E> = E extends {
	type: "tool_execution_start" | "tool_execution_update" | "tool_execution_end";
}
	? E & { parentToolCallId?: string }
	: E;

/** Session-specific events that extend the core AgentEvent */
export type AgentSessionEvent =
	| WithParentToolCallId<Exclude<AgentEvent, { type: "agent_end" }>>
	| {
			type: "agent_end";
			messages: AgentMessage[];
			willRetry: boolean;
	  }
	| { type: "agent_settled"; aborted: boolean }
	| {
			type: "queue_update";
			steering: readonly string[];
			followUp: readonly string[];
	  }
	| { type: "compaction_start"; reason: "manual" | "threshold" | "overflow" }
	/** git.autoCommit "turn" committed the turn's files (or failed to). */
	| { type: "auto_commit"; files: number; sha?: string; subject?: string; error?: string }
	/** The session sat idle past the cache TTL with a large context: it compacts before this turn. */
	| { type: "idle_compaction"; idleMs: number; contextTokens: number; ttlMs: number }
	| { type: "entry_appended"; entry: SessionEntry }
	| { type: "session_info_changed"; name: string | undefined }
	| { type: "thinking_level_changed"; level: ThinkingLevel }
	| {
			type: "compaction_end";
			reason: "manual" | "threshold" | "overflow";
			result: CompactionResult | undefined;
			aborted: boolean;
			willRetry: boolean;
			errorMessage?: string;
	  }
	| { type: "auto_retry_start"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
	| { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string }
	| {
			type: "model_fallback";
			from: string;
			to: string;
			errorMessage: string;
			/** Failover: the equivalent thinking level used on `to`. */
			thinkingLevel?: ThinkingLevel;
			/** Failover: the switch holds for the rest of this turn. */
			scope?: "turn";
	  }
	/** Failover did not switch models (pinned model, failover off, nothing else available); the text says why. */
	| { type: "failover_notice"; model: string; message: string }
	/** Auto mode routed a request: model, thinking level and why. */
	| { type: "router_decision"; decision: RouteDecision }
	/** Auto mode was turned on or off. */
	| { type: "router_mode_changed"; enabled: boolean }
	| { type: "prompt_drift"; message: string }
	| {
			type: "summarization_retry_scheduled";
			attempt: number;
			maxAttempts: number;
			delayMs: number;
			errorMessage: string;
	  }
	| { type: "summarization_retry_attempt_start"; source: "branchSummary" }
	| {
			type: "summarization_retry_attempt_start";
			source: "compaction";
			reason: "manual" | "threshold" | "overflow";
	  }
	| { type: "summarization_retry_finished" }
	| { type: "bash_execution_update"; id?: string; delta: string };

/** Listener function for agent session events */
export type AgentSessionEventListener = (event: AgentSessionEvent) => void;

// ============================================================================
// Types
// ============================================================================

function withoutDeletedHeaders(headers: ProviderHeaders | undefined): Record<string, string> | undefined {
	return headers
		? Object.fromEntries(Object.entries(headers).filter((entry): entry is [string, string] => entry[1] !== null))
		: undefined;
}

/** Session entry recording that auto mode was turned on or off (restored on resume). */
export const ROUTER_STATE_ENTRY = "runkiln-router";

export interface AgentSessionConfig {
	agent: Agent;
	sessionManager: SessionManager;
	settingsManager: SettingsManager;
	cwd: string;
	/** Models to cycle through with Ctrl+P (from --models flag) */
	scopedModels?: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>;
	/** Resource loader for extensions, skills, prompts, themes, context files, and system prompt */
	resourceLoader: ResourceLoader;
	/** SDK custom tools registered outside extensions */
	customTools?: ToolDefinition[];
	/** Canonical model/auth runtime used by coding-agent internals. */
	modelRuntime: ModelRuntime;
	/** Keeps the prompt cache entry of the last session request warm. */
	/** RunKiln session role (code or chat). */
	role?: ModelRole;
	/** Start in auto mode: the router picks model and thinking level per request. */
	autoRouting?: boolean;
	/** Thinking level the user pinned for auto mode (overrides the router's level). */
	pinnedThinking?: ThinkingLevel;
	/**
	 * Thinking level the user chose for manual models (SDK `thinkingLevel`, `--thinking`). Without it,
	 * manual models follow the per-model level, then `defaultThinkingLevel`, clamped to the model.
	 */
	manualThinking?: ThinkingLevel;
	/** Routing mode for auto: low, medium (default) or high. */
	routerMode?: RouterMode;
	/** Router instance (tests). Default: built lazily from router.yaml and settings. */
	router?: ModelRouter;
	/** CLI overrides for the router classifier (--router-classifier, --router-model). */
	routerOverrides?: RouterOverrides;
	/**
	 * Permission mode the session starts in. Default: the process mode (set by the CLI from --permissions,
	 * RUNKILN_PERMISSIONS or the saved setting), else read & write.
	 */
	permissionMode?: PermissionMode;
	/** Decision model for auto permissions (tests). Default: Jev or OpenRouter from the router classifier keys. */
	permissionJudgeFactory?: () => PermissionJudge | undefined;
	/** Agent dir whose router-keys.json and settings the default decision model reads. Default: getAgentDir(). */
	permissionAgentDir?: string;
	/**
	 * Directory for turn checkpoints (/undo, /rewind), e.g. ~/.runkiln/agent/checkpoints. Checkpoints are only
	 * recorded for persisted sessions. Undefined or false: none.
	 */
	checkpointDir?: string | false;
	/**
	 * Usage ledger (`/usage` history, `runkiln usage`), e.g. ~/.runkiln/agent/usage.jsonl. One line per billed call
	 * of a persisted session. Undefined or false: none.
	 */
	usageLedgerPath?: string | false;
	/** Initial active built-in tool names. Default: [read, bash, edit, write] */
	initialActiveToolNames?: string[];
	/**
	 * Whether the initial tools come from the `defaultTools` setting. When true, a resumed session
	 * replaces them with the loadout its transcript records, with `defaultToolModifiers` applied, and
	 * reload activates tools newly added to the setting. Tools removed from it stay active.
	 */
	usesDefaultTools?: boolean;
	/**
	 * `+name`/`-name` entries applied on top of the `defaultTools` setting, from `--tools`. Reload
	 * applies them to the reloaded setting too, so a removed tool stays removed.
	 */
	defaultToolModifiers?: string[];
	/**
	 * Optional allowlist of tool names or patterns (`*` matches any characters). When provided, only
	 * matching tools are exposed. A non-empty list without `mcp__` entries also keeps MCP tools
	 * registered for codemode and tool_search; only tool_search can declare them. An empty list
	 * exposes no tools.
	 */
	allowedToolNames?: string[];
	/** Optional denylist of tool names or patterns. When provided, matching tools are not exposed. */
	excludedToolNames?: string[];
	/**
	 * Override base tools (useful for custom runtimes).
	 *
	 * These are synthesized into minimal ToolDefinitions internally so AgentSession can keep
	 * a definition-first registry even when callers provide plain AgentTool instances.
	 */
	baseToolsOverride?: Record<string, AgentTool>;
	/** Mutable ref used by Agent to access the current ExtensionRunner */
	extensionRunnerRef?: { current?: ExtensionRunner };
	/** Session start event metadata emitted when extensions bind to this runtime. */
	sessionStartEvent?: SessionStartEvent;
	/** Request size fitting shared with the request builder (sdk convertToLlm); a 413 switches it to strict. */
	requestFit?: RequestFitState;
}

export interface ExtensionBindings {
	uiContext?: ExtensionUIContext;
	mode?: ExtensionMode;
	commandContextActions?: ExtensionCommandContextActions;
	abortHandler?: () => void;
	shutdownHandler?: ShutdownHandler;
	onError?: ExtensionErrorListener;
}

export type QueuedInputDisposition = "handled" | "queued";
export type PromptDisposition = QueuedInputDisposition | "started";

/** Options for AgentSession.prompt() */
export interface PromptOptions {
	/** Whether to dispatch extension commands and expand skill commands and prompt templates (default: true) */
	expandPromptTemplates?: boolean;
	/** Image attachments */
	images?: ImageContent[];
	/** When streaming, how to queue the message: "steer" (interrupt) or "followUp" (wait). Required if streaming. */
	streamingBehavior?: "steer" | "followUp";
	/** Source of input for extension input event handlers. Defaults to "interactive". */
	source?: InputSource;
	/**
	 * Name the session from this prompt's answer, once it has finished, if the session has no name yet (default: true).
	 * Print mode passes false: its process exits after the answer, which would otherwise wait for the title call.
	 */
	nameSession?: boolean;
	/** Internal hook used by RPC mode to observe how an accepted prompt was dispatched. Not called if the prompt is rejected. */
	preflightResult?: (disposition: PromptDisposition) => void;
}

/** Options for model/thinking mutations. */
export interface ModelMutationOptions {
	/** Persist the new value to global defaults. Defaults to session-only. */
	persist?: boolean;
}

/** Result from cycleModel() */
export interface ModelCycleResult {
	model: Model<any>;
	thinkingLevel: ThinkingLevel;
	/** Whether cycling through scoped models (--models flag) or all available */
	isScoped: boolean;
}

/** Session statistics for /session command */
export interface SessionStats {
	sessionFile: string | undefined;
	sessionId: string;
	userMessages: number;
	assistantMessages: number;
	toolCalls: number;
	toolResults: number;
	totalMessages: number;
	tokens: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
	cost: number;
	contextUsage?: ContextUsage;
}

interface ToolDefinitionEntry {
	definition: ToolDefinition;
	sourceInfo: SourceInfo;
}

/**
 * Static repo map appended once after the first user message (repoMap.firstTurnTokens). It is a conversation message,
 * never part of the system prompt, and later requests carry it unchanged, so the cached prefix holds.
 */
export const REPO_MAP_HINT_TYPE = "repo-map";

/** Hidden note with prompt sections changed after the freeze (/reload): appended, never a prefix edit. */
export const PROMPT_UPDATE_MESSAGE_TYPE = "prompt-update";

/** A tool's declaration as the model sees it. */
function promptTool(tool: PromptTool): PromptTool {
	return { name: tool.name, description: tool.description, parameters: tool.parameters };
}

function estimateMessagesTokens(messages: AgentMessage[]): number {
	let tokens = 0;
	for (const message of messages) {
		tokens += estimateTokens(message);
	}
	return tokens;
}

// ============================================================================
// AgentSession Class
// ============================================================================

/** "3h ago" for a catalog timestamp. */
function formatCatalogAge(fetchedAt: number | undefined): string {
	if (fetchedAt === undefined) return "age unknown";
	const minutes = Math.max(0, Math.round((Date.now() - fetchedAt) / 60000));
	return minutes < 60 ? `${minutes}m ago` : `${Math.round(minutes / 60)}h ago`;
}

export class AgentSession {
	readonly agent: Agent;
	readonly sessionManager: SessionManager;
	readonly settingsManager: SettingsManager;

	private _scopedModels: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>;

	// Event subscription state
	private _unsubscribeAgent?: () => void;
	private _eventListeners: AgentSessionEventListener[] = [];
	private _isAgentRunActive = false;
	private _agentRunAbortRequested = false;
	private _idleWaitPromise: Promise<void> | undefined;
	private _resolveIdleWait: (() => void) | undefined;

	/** Tracks pending steering messages for UI display. Removed when delivered. */
	private _steeringMessages: string[] = [];
	/** Tracks pending follow-up messages for UI display. Removed when delivered. */
	private _followUpMessages: string[] = [];
	/** Messages queued to be included with the next user prompt as context ("asides"). */
	private _pendingNextTurnMessages: CustomMessage[] = [];
	/** Context-only custom messages queued during a run, flushed once the current turn's tool results are in. */
	private _pendingCustomMessages: CustomMessage[] = [];

	// Compaction state
	private _compactionAbortController: AbortController | undefined = undefined;
	private _autoCompactionAbortController: AbortController | undefined = undefined;
	private _overflowRecoveryAttempted = false;
	/** A 413 in this run was retried once with a strict request fit (see _handlePostAgentRun). */
	private _payloadShrinkRetried = false;
	private readonly _requestFit: RequestFitState;

	// Branch summarization state
	private _branchSummaryAbortController: AbortController | undefined = undefined;

	// Retry state
	private _retryAbortController: AbortController | undefined = undefined;
	private _retryAttempt = 0;
	/** Model ids already tried after a failed request, so fallback does not return to them. */
	private _fallbackTried = new Set<string>();
	/** Failovers in the current run (one per run: the model it switched to is not switched away from). */
	private _failoversThisRun = 0;
	/** The pinned-model "retrying only" notice was shown in this run. */
	private _pinnedNoticeShown = false;
	/**
	 * Model health shared by the router, failover and side tasks: a model whose requests kept failing sits
	 * out a short cooldown (failover.cooldownSec, else router.yaml failed_model_cooldown_sec).
	 */
	private readonly _modelHealth = new ModelHealth({
		cooldownMs: () =>
			this.settingsManager.getFailoverSettings().cooldownMs ??
			(this._router?.catalog.tuning.failedModelCooldownSec ?? 300) * 1000,
	});
	/** System prompt and tool declarations captured for this session. Later turns must match. */
	private _frozenPrompt: FrozenPrompt | undefined;
	/** Prompt-change notices already shown (each once per session). */
	private readonly _promptDriftReported = new Set<string>();
	/**
	 * After the freeze: the tools the session wants on. Declared tools outside it are refused when called
	 * (the declarations themselves never change mid-session).
	 */
	private _enabledToolNames: Set<string> | undefined;
	/** After the freeze: the prompt sections the model has (frozen, then as updated by the last note). */
	private _notedSections: Record<string, string> | undefined;
	/** A hidden prompt-update note waiting for the next user message. */
	private _pendingPromptNote: string | undefined;
	private _titleRequested = false;
	private _titleAbortController: AbortController | undefined;
	/**
	 * Failed response that the next request repeats, set by auto-retry and overflow recovery. The
	 * retry is routed with it as `failed`, since the context no longer contains it.
	 */
	private _failedResponse: AssistantMessage | undefined;

	// Bash execution state
	private readonly _bashAbortControllers = new Set<AbortController>();
	private _pendingBashMessages: BashExecutionMessage[] = [];

	// Extension system
	private _extensionRunner!: ExtensionRunner;
	private _turnIndex = 0;
	private readonly _entryIdsByMessage = new WeakMap<object, string>();
	private readonly _boundaryDispatchedMessages = new WeakSet<object>();
	private _lastAssistantMessage: AssistantMessage | undefined;
	private _lastAssistantToolResults: AgentMessage[] = [];
	private _lastActivityOutcome: AgentActivityOutcome = "completed";
	private _isBeforeSettle = false;
	private _abortDuringBeforeSettle = false;
	private _isEmittingAgentSettled = false;
	/** Diagnostics after edit/write (core/verify/post-edit.ts). */
	private _postEdit!: PostEditChecks;
	/** The verify loop: tests after file-changing turns (core/verify/verify-loop.ts). */
	verify!: VerifyController;
	private readonly _deferredSettledActions: Array<() => Promise<void>> = [];

	private _resourceLoader: ResourceLoader;
	private _customTools: ToolDefinition[];
	private _baseToolDefinitions: Map<string, ToolDefinition> = new Map();
	private _cwd: string;
	private _extensionRunnerRef?: { current?: ExtensionRunner };
	private _initialActiveToolNames?: string[];
	/**
	 * Tools of the restored or reloaded loadout that are not registered yet, such as tools of MCP
	 * servers that are still connecting. They are activated when they are registered, and dropped when
	 * `setActiveToolsByName()` deactivates a tool or the next agent run starts.
	 */
	private _pendingToolNames = new Set<string>();
	private _usesDefaultTools: boolean;
	private _defaultToolModifiers: string[];
	/** Matches the `--tools` entries: tool names or patterns. */
	private _allowedTools?: (name: string) => boolean;
	/**
	 * Whether the allowlist filters MCP tools: it is empty (`--no-tools`) or names an MCP tool
	 * (`mcp__*`). Otherwise it keeps MCP tools registered for codemode and tool_search.
	 */
	private _excludedTools?: (name: string) => boolean;
	private _baseToolsOverride?: Record<string, AgentTool>;
	private _sessionStartEvent: SessionStartEvent;
	private readonly _permissionGate: PermissionGate;
	private readonly _checkpointDir: string | false;
	private _usageLedger: UsageLedgerWriter | undefined;
	private _checkpointStore: CheckpointStore | undefined;
	/** Interactive approval UI (set by interactive mode). Without it, the extension UI's select/input are used. */
	private _approvalPrompt?: (prompt: PermissionPrompt, signal?: AbortSignal) => Promise<ApprovalAnswer | undefined>;
	/**
	 * What the next run tells the model about plan mode: the full instructions after it is switched on, a short
	 * reminder while it stays on, or a notice that it ended (see plan-mode.ts). Undefined once delivered off plan mode.
	 */
	private _planNotice: "enter" | "exit" | "discarded" | undefined;
	private _extensionUIContext?: ExtensionUIContext;
	private _extensionMode: ExtensionMode = "print";
	private _extensionCommandContextActions?: ExtensionCommandContextActions;
	private _extensionAbortHandler?: () => void;
	private _extensionShutdownHandler?: ShutdownHandler;
	private _extensionErrorListener?: ExtensionErrorListener;
	private _extensionErrorUnsubscriber?: () => void;

	private _modelRuntime: ModelRuntime;
	private readonly _role: ModelRole;

	// Model router ("auto" model)
	private _autoRouting = false;
	/** True once any request in this session was routed: the one-model rule no longer applies. */
	private _routedThisSession = false;
	/** The session's first routing decision (router.sessionModel keeps it). */
	private _sessionRoute?: RouteDecision;
	/** Thinking level the user pinned while in auto mode; undefined lets the router decide. */
	private _pinnedThinking: ThinkingLevel | undefined;
	/**
	 * Thinking level the user set for manual models (/thinking, cycling, --thinking); undefined
	 * follows the per-model level, then the `defaultThinkingLevel` setting.
	 */
	private _manualThinking: ThinkingLevel | undefined;
	private _router: ModelRouter | undefined;
	private _routerError: string | undefined;
	/** True when the router came from the session config (SDK): it is never rebuilt here. */
	private _routerInjected = false;
	private _routerMode: RouterMode;
	private readonly _routerOverrides: RouterOverrides | undefined;

	/** The todo nudge was sent for the current user prompt. */
	private _todoNudged = false;
	/** A /review run is going: only read-only tools run (the plan-mode gate). */
	private _readOnlyReview = false;
	/** Background shell jobs (bash `background: true`, bash_output, /jobs). */
	private readonly _jobs: JobManager;
	private readonly _permissionAgentDir: string;
	/** Shell hooks from settings (Claude Code format), bridged into extension events. */
	private readonly _hooks: HookManager;
	private _hooksBridge: HooksBridge | undefined;
	/** MCP servers from config; their tools are deferred and reached through the `mcp` tool. */
	private readonly _mcp: McpManager;
	private readonly _mcpExtension: ReturnType<typeof createMcpExtension>;
	/** One approval prompt at a time: parallel tool calls queue theirs. */
	private readonly _approvalQueue = new AsyncMutex();

	// Tool registry for extension getTools/setTools
	private _toolRegistry: Map<string, AgentTool> = new Map();
	/** Created on the first `ctx.executeTool()` call. */
	private _nestedToolCalls: NestedToolCallRunner | undefined;
	/** Declared tools whose declarations requests leave out, from `prepareLoadout` hooks. */
	private _hiddenDeclarations: ReadonlySet<string> = new Set();
	private _toolDefinitions: Map<string, ToolDefinitionEntry> = new Map();
	private _toolPromptSnippets: Map<string, string> = new Map();
	private _toolPromptGuidelines: Map<string, string[]> = new Map();

	private _baseSystemPromptOptions!: NormalizedBuildSystemPromptOptions;
	/** Prompt options after before_agent_start mutations for the active run. */
	private _runSystemPromptOptions?: NormalizedBuildSystemPromptOptions;

	constructor(config: AgentSessionConfig) {
		this.agent = config.agent;
		this.sessionManager = config.sessionManager;
		this.settingsManager = config.settingsManager;
		this._scopedModels = config.scopedModels ?? [];
		this._resourceLoader = config.resourceLoader;
		this._customTools = config.customTools ?? [];
		this._cwd = config.cwd;
		this._modelRuntime = config.modelRuntime;
		this._role = config.role ?? "code";
		this._router = config.router;
		this._routerInjected = !!config.router;
		if (this._router) this._router.onClassifierSpend = (spend) => this._recordDecisionSpend("classifier", spend);
		this._router?.setModelFilter(this._isModelEnabled);
		this._router?.setHealth(this._modelHealth);
		this._routerOverrides = config.routerOverrides;
		this._autoRouting = config.autoRouting ?? false;
		this._routerMode = config.routerMode ?? this.settingsManager.getRouterSettings().mode ?? DEFAULT_ROUTER_MODE;
		this._pinnedThinking = config.autoRouting ? config.pinnedThinking : undefined;
		this._manualThinking = config.manualThinking;
		this._extensionRunnerRef = config.extensionRunnerRef;
		this._initialActiveToolNames = config.initialActiveToolNames;
		this._usesDefaultTools = config.usesDefaultTools ?? false;
		this._defaultToolModifiers = config.defaultToolModifiers ?? [];
		if (config.allowedToolNames) {
			this._allowedTools = createToolNameMatcher(config.allowedToolNames);
		}
		this._excludedTools = config.excludedToolNames ? createToolNameMatcher(config.excludedToolNames) : undefined;
		this._baseToolsOverride = config.baseToolsOverride;
		this._sessionStartEvent = config.sessionStartEvent ?? { type: "session_start", reason: "startup" };
		this._requestFit = config.requestFit ?? createRequestFitState();
		this._checkpointDir = config.checkpointDir ?? false;
		if (config.usageLedgerPath) {
			const ledger = new UsageLedgerWriter(config.usageLedgerPath);
			this._usageLedger = ledger;
			this.sessionManager.onEntryAppended((entry) => {
				if (!this.sessionManager.isPersisted()) return;
				ledger.append(
					ledgerRowsForEntry(
						entry,
						this.sessionManager.getSessionId(),
						this._cwd,
						this._usagePrices,
						this.agent.state.thinkingLevel,
					),
				);
			});
		}
		const judgeFactory = config.permissionJudgeFactory;
		this._permissionGate = new PermissionGate({
			mode: config.permissionMode ?? getProcessPermissionMode() ?? DEFAULT_PERMISSION_MODE,
			judgeFactory: judgeFactory ?? (() => createPermissionJudge(config.permissionAgentDir)),
			isAutoAvailable: judgeFactory
				? () => judgeFactory() !== undefined
				: () => isPermissionJudgeAvailable(config.permissionAgentDir),
			savedRules: () => this.getSavedPermissionRules().rules,
			judgeContext: () => this._judgeContext(),
			onJudgeSpend: (spend) => this._recordDecisionSpend("judge", spend),
			planReturnMode: () => parsePermissionMode(this.settingsManager.getPermissionMode()),
			readsOutsideProject: () => this.settingsManager.getReadsOutsideProject(),
			readRoots: () => this._readRoots(),
		});
		if (this._permissionGate.mode === "plan") this._planNotice = "enter";
		this._permissionAgentDir = config.permissionAgentDir ?? getAgentDir();
		const commandTrust = new CommandTrustStore(this._permissionAgentDir);
		const globalSettings = () => this.settingsManager.getGlobalSettings() as Record<string, unknown>;
		const projectTrusted = () => this.settingsManager.isProjectTrusted();
		// The shellEnvironment policy (global settings) applies to every command, hook and job this process spawns.
		setShellEnvironmentPolicy(this.settingsManager.getShellEnvironment());
		this._jobs = new JobManager({ shellPath: this.settingsManager.getShellPath() });
		this._jobs.onChange(() => this._showJobsStatus());
		this._hooks = new HookManager({
			cwd: this._cwd,
			trust: commandTrust,
			globalSettings,
			projectTrusted,
			commonInput: () => ({
				session_id: this.sessionManager.getSessionId(),
				transcript_path: this.sessionManager.getSessionFile() ?? "",
				permission_mode: claudePermissionMode(this._permissionGate.mode),
			}),
		});
		this._mcp = new McpManager({
			cwd: this._cwd,
			trust: commandTrust,
			globalSettings,
			settings: () => this.settingsManager.getSettings() as Record<string, unknown>,
			projectTrusted,
		});
		this._mcpExtension = createMcpExtension(this._mcp);
		this._mcp.onChange(() => {
			if (this._mcpExtension.sync()) this._refreshToolRegistry();
		});
		this._permissionGate.onModeChange((mode, previous) => {
			if (mode === "plan") this._planNotice = "enter";
			else if (previous === "plan") this._planNotice = "exit";
		});

		this._postEdit = new PostEditChecks({
			cwd: () => this._cwd,
			settings: () => this.settingsManager.getChecksSettings(),
			isActive: () => this._permissionGate.mode !== "plan",
			// Configured check commands pass the gate like any bash call; auto-detected checkers are read-only.
			approveCommand: async (command, signal) => !(await this._approveToolCall("bash", { command }, signal)),
		});
		this.verify = new VerifyController({
			cwd: () => this._cwd,
			settings: () => this.settingsManager.getVerifySettings(),
			project: () => this.settingsManager.getVerifyProject(this._cwd),
			saveProject: (entry) => this.settingsManager.setVerifyProject(this._cwd, entry),
			ui: () => {
				const ctx = this._extensionRunner.createContext();
				return ctx.hasUI ? ctx.ui : undefined;
			},
			isPlanMode: () => this._permissionGate.mode === "plan",
		});

		// Always subscribe to agent events for internal handling
		// (session persistence, extensions, auto-compaction, retry logic)
		this._unsubscribeAgent = this.agent.subscribe(this._handleAgentEvent);
		this._installAgentToolHooks();
		this._installAgentNextTurnRefresh();
		this._installAgentRequestProjection();
		this._installAgentBoundaryHooks();
		this._installHiddenDeclarationsProjection();
		this._installAgentForcedPromptProjection();

		this._buildRuntime({
			activeToolNames: this._initialActiveToolNames,
			includeAllExtensionTools: true,
		});
		if (this._usesDefaultTools) this._restoreToolsFromTranscript(this._defaultToolModifiers);
		this._syncTodoTool();
		this._activateMcpTool();
	}

	// =========================================================================
	// Hooks, MCP servers and background jobs
	// =========================================================================

	/** Shell hooks (settings `hooks`, Claude Code format). */
	get hooks(): HookManager {
		return this._hooks;
	}

	/** MCP servers from config. */
	get mcp(): McpManager {
		return this._mcp;
	}

	/** Background shell jobs. */
	get jobs(): JobManager {
		return this._jobs;
	}

	/** Forget the approval of this project's hooks (/hooks untrust). */
	revokeProjectHooks(): void {
		new CommandTrustStore(this._permissionAgentDir).revoke(this._cwd, "hooks");
	}

	/** The `mcp` tool is offered whenever MCP servers are configured (decided at startup and reload). */
	private _activateMcpTool(): void {
		if (!this._mcp.hasServers || !this._toolRegistry.has(MCP_TOOL_NAME)) return;
		const active = this._wantedToolNames();
		if (!active.includes(MCP_TOOL_NAME)) this._setActiveTools([...active, MCP_TOOL_NAME]);
	}

	/** settings.backgroundJobs.autoBackgroundSeconds (0 turns auto-background off). */
	private _autoBackgroundSeconds(): number | undefined {
		const value = (this.settingsManager.getSettings() as { backgroundJobs?: { autoBackgroundSeconds?: unknown } })
			.backgroundJobs?.autoBackgroundSeconds;
		return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
	}

	/** Running jobs in the footer ("2 jobs"). */
	private _showJobsStatus(): void {
		const running = this._jobs.list().filter((job) => job.status === "running");
		const text =
			running.length === 0
				? undefined
				: running.length === 1
					? `job: ${describeJob(running[0]!).slice(0, 48)}`
					: `${running.length} jobs (/jobs)`;
		try {
			this._extensionUIContext?.setStatus("jobs", text);
		} catch {
			// No UI.
		}
	}

	/** Post-edit checkers left out for the rest of the session because they were slow. */
	get postEditSkipped(): readonly string[] {
		return this._postEdit.skippedCheckers;
	}

	get modelRuntime(): ModelRuntime {
		return this._modelRuntime;
	}

	private async _getRequiredRequestAuth(
		model: Model<any>,
		signal?: AbortSignal,
	): Promise<{
		model: Model<any>;
		apiKey?: string;
		headers?: Record<string, string>;
		env?: Record<string, string>;
	}> {
		let result: AuthResult | undefined;
		try {
			result = await this._modelRuntime.getAuth(model, { signal });
		} catch (error) {
			const cause = error instanceof Error ? error.cause : undefined;
			if (cause instanceof Error && cause.message === "authHeader requires a resolved API key") {
				throw new Error(formatNoApiKeyFoundMessage(model.provider));
			}
			throw error;
		}
		if (result && (result.auth.apiKey || result.auth.headers)) {
			const requestModel = result.auth.baseUrl ? { ...model, baseUrl: result.auth.baseUrl } : model;
			return {
				model: requestModel,
				apiKey: result.auth.apiKey,
				headers: withoutDeletedHeaders(result.auth.headers),
				env: result.env,
			};
		}

		const isOAuth = this._modelRuntime.isUsingOAuth(model.provider);
		if (isOAuth) {
			throw new Error(
				`Authentication failed for "${model.provider}". ` +
					`Credentials may have expired or network is unavailable. ` +
					`Check the key in /setup keys (${model.provider}).`,
			);
		}
		throw new Error(formatNoApiKeyFoundMessage(model.provider));
	}

	private async _getSummarizationRequestAuth(
		selectedModel: Model<any>,
		signal?: AbortSignal,
		thinkingLevelOverride?: ThinkingLevel,
	): Promise<{
		model: Model<any>;
		apiKey?: string;
		headers?: Record<string, string>;
		env?: Record<string, string>;
		thinkingLevel: ThinkingLevel;
	}> {
		const model = selectedModel;
		const thinkingLevel = thinkingLevelOverride ?? this.thinkingLevel;
		if (this.agent.streamFunction === streamSimple) {
			return { ...(await this._getRequiredRequestAuth(model, signal)), thinkingLevel };
		}

		try {
			const result = await this._modelRuntime.getAuth(model, { signal });
			if (!result) return { model, thinkingLevel };
			const requestModel = result.auth.baseUrl ? { ...model, baseUrl: result.auth.baseUrl } : model;
			return {
				model: requestModel,
				apiKey: result.auth.apiKey,
				headers: withoutDeletedHeaders(result.auth.headers),
				env: result.env,
				thinkingLevel,
			};
		} catch (error) {
			if (signal?.aborted) throw error;
			return { model, thinkingLevel };
		}
	}

	/** The model whose limits apply to `message`, or undefined when the message came from another model. */
	private _modelForMessage(message: AssistantMessage): Model<any> | undefined {
		const model = this.model;
		return model?.provider === message.provider && model.id === message.model ? model : undefined;
	}

	/** The model whose limits apply to the conversation. */
	private _limitsModel(): Model<any> | undefined {
		return this.model;
	}

	/**
	 * Install tool hooks once on the Agent instance.
	 *
	 * The callbacks read `this._extensionRunner` at execution time, so extension reload swaps in the
	 * new runner without reinstalling hooks. Extension-specific tool wrappers are still used to adapt
	 * registered tool execution to the extension context. Tool call and tool result interception now
	 * happens here instead of in wrappers.
	 */
	private _installAgentToolHooks(): void {
		this.agent.beforeToolCall = (context, signal) => this._beforeToolCall(context, undefined, signal);
		this.agent.afterToolCall = (context) => this._afterToolCall(context);
	}

	/**
	 * What the approval gate needs to know about the tool that will run under `toolName`. The tool is the genuine
	 * built-in only when the definition the registry runs under the name is the very object the session created
	 * from core/tools, and the session has no base tool overrides. Nothing a tool declares is consulted. A custom,
	 * extension or SDK tool that takes a built-in name is a replacement.
	 */
	private _toolCallOptions(toolName: string): ToolCallOptions {
		const builtin = this._baseToolDefinitions.get(toolName);
		const running = this._toolDefinitions.get(toolName)?.definition;
		const genuine = builtin !== undefined && running === builtin && this._baseToolsOverride === undefined;
		const replacesBuiltin = builtin !== undefined && running !== undefined && running !== builtin;
		return { builtin: genuine, replacesBuiltin };
	}

	// =========================================================================
	// Permissions
	// =========================================================================

	/** The permission mode: ask, read-write, auto or allow-all (see core/runkiln/permissions.ts). */
	get permissionMode(): PermissionMode {
		return this._permissionGate.mode;
	}

	/** Mode, session "always allow" rules and the auto decision cache. */
	get permissions(): PermissionGate {
		return this._permissionGate;
	}

	/**
	 * Switch the permission mode for this session and for sessions this process starts later. `persist` also saves
	 * it as the default in the global settings. Returns an error message when the mode is not available.
	 */
	setPermissionMode(mode: PermissionMode, options: { persist?: boolean } = {}): string | undefined {
		const error = this._permissionGate.setMode(mode);
		if (error) return error;
		setProcessPermissionMode(mode);
		// Plan mode is for one task: it is never saved as the default (use --permissions plan to start in it).
		if (options.persist && mode !== "plan") this.settingsManager.setPermissionMode(mode);
		return undefined;
	}

	/** Whether plan mode (read-only, see core/runkiln/plan-mode.ts) is on. */
	get isPlanMode(): boolean {
		return this._permissionGate.mode === "plan";
	}

	/**
	 * Approve the plan: switch back to the mode the session was in before plan mode and start implementing. Returns
	 * the mode it switched to, or an error message (the mode before plan mode is no longer available). `editedPlan` is
	 * the plan as the user edited it (plan-approval's edit key): it is sent in full and is what gets implemented.
	 */
	async approvePlan(editedPlan?: string): Promise<{ mode: PermissionMode } | { error: string }> {
		const mode = this._permissionGate.modeBeforePlan;
		const error = this.setPermissionMode(mode === "plan" ? DEFAULT_PERMISSION_MODE : mode);
		if (error) {
			const fallback = this.setPermissionMode(DEFAULT_PERMISSION_MODE);
			if (fallback) return { error };
		}
		const now = this._permissionGate.mode;
		// The approval prompt itself tells the model that plan mode is off.
		this._planNotice = undefined;
		await this.prompt(planApprovedPrompt(now, editedPlan));
		return { mode: now };
	}

	/** Discard the plan: leave plan mode for the mode before it, and tell the model (on the next run) not to act on it. */
	discardPlan(): PermissionMode {
		const mode = this._permissionGate.modeBeforePlan;
		if (this.setPermissionMode(mode)) this.setPermissionMode(DEFAULT_PERMISSION_MODE);
		this._planNotice = "discarded";
		return this._permissionGate.mode;
	}

	private _gitSummaryCache: { at: number; text: string | undefined } | undefined;

	/** Branch and changed files, from `git status` (cached 15 s, 1 s timeout), for the auto decision model. */
	private _gitSummary(): string | undefined {
		const now = Date.now();
		if (this._gitSummaryCache && now - this._gitSummaryCache.at < 15_000) return this._gitSummaryCache.text;
		let text: string | undefined;
		try {
			const out = execFileSync("git", ["status", "--porcelain=v1", "-b"], {
				cwd: this._cwd,
				timeout: 1000,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
			});
			const lines = out.split("\n").filter(Boolean);
			const branch = lines[0]?.startsWith("## ") ? lines.shift()?.slice(3) : undefined;
			const shown = lines.slice(0, 12).join(", ");
			text = `branch ${branch ?? "unknown"}; ${lines.length} changed file(s)${shown ? `: ${shown}` : ""}${lines.length > 12 ? ", …" : ""}`;
		} catch {
			text = undefined;
		}
		this._gitSummaryCache = { at: now, text };
		return text;
	}

	/**
	 * The work around a tool call for the auto decision model: the latest user request and a few recent turns (user
	 * messages and the agent's tool calls only, never tool output, which may hold injected text).
	 */
	private _judgeContext(): { request?: string; recentTurns?: string[]; git?: string } {
		const messages = this.agent.state.messages;
		const turns: string[] = [];
		let request: string | undefined;
		for (let i = messages.length - 1; i >= 0 && turns.length < 8; i--) {
			const message = messages[i] as { role: string; content?: unknown };
			if (message.role === "user") {
				const text = contentText(message.content as never, "").trim();
				if (!text) continue;
				if (request === undefined) request = text.slice(0, 1500);
				turns.push(`user: ${text.slice(0, 300)}`);
			} else if (message.role === "assistant" && Array.isArray(message.content)) {
				for (const part of message.content as Array<{ type?: string; name?: string; arguments?: unknown }>) {
					if (part?.type !== "toolCall") continue;
					let args = "";
					try {
						args = JSON.stringify(part.arguments) ?? "";
					} catch {
						args = "";
					}
					turns.push(`agent called ${part.name}: ${args.slice(0, 200)}`);
				}
			}
		}
		const git = this._gitSummary();
		return {
			...(request ? { request } : {}),
			...(turns.length > 0 ? { recentTurns: turns.reverse() } : {}),
			...(git ? { git } : {}),
		};
	}

	// =========================================================================
	// Git helpers (/commit, git.autoCommit)
	// =========================================================================

	/** Paths the edit and write tools touched on the current branch: since the last user message, or all. */
	private _toolEditedPaths(scope: "turn" | "session"): string[] {
		const paths = new Set<string>();
		const branch = this.sessionManager.getBranch();
		let start = 0;
		if (scope === "turn") {
			for (let i = branch.length - 1; i >= 0; i--) {
				const entry = branch[i];
				if (entry.type === "message" && entry.message.role === "user") {
					start = i;
					break;
				}
			}
		}
		for (const entry of branch.slice(start)) {
			if (entry.type !== "message" || entry.message.role !== "assistant") continue;
			for (const part of entry.message.content) {
				if (part.type !== "toolCall" || !isCheckpointTool(part.name)) continue;
				const path = (part.arguments as { path?: unknown }).path;
				if (typeof path === "string" && path.trim()) paths.add(resolvePath(this._cwd, path.trim()));
			}
		}
		return [...paths];
	}

	/**
	 * Files the agent changed: in the last user turn, or in the whole session (current branch). From the /undo
	 * checkpoints (every change, shell commands included), plus the paths edit and write touched.
	 */
	async getAgentChangedPaths(scope: "turn" | "session"): Promise<string[]> {
		const paths = new Set(this._toolEditedPaths(scope));
		const store = this.checkpoints;
		if (store) {
			await store.idle();
			const turns = this.sessionManager
				.getBranch()
				.filter((entry) => entry.type === "message" && entry.message.role === "user");
			for (const entry of scope === "turn" ? turns.slice(-1) : turns) {
				const checkpoint = store.forEntry(entry.id);
				const summary = checkpoint ? await store.summarize(checkpoint.id) : undefined;
				for (const file of summary?.files ?? []) paths.add(resolvePath(this._cwd, file.path));
			}
		}
		return [...paths];
	}

	/** One side-task completion on the chore model (with fallbacks); the text and its cost. */
	private async _choreText(
		kind: ChoreKind,
		prompt: string,
		maxTokens: number,
		signal: AbortSignal,
	): Promise<{ text: string; costUsd: number }> {
		const sessionId = this.sessionId;
		const routing = { sessionId: backgroundSessionId(sessionId, kind), parentSessionId: sessionId };
		const message = await this._withChoreModel(
			kind,
			signal,
			async (model, thinkingLevel) =>
				await observeCallMetrics(
					this._modelRuntime.streamSimple(
						model,
						{ messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }] },
						{ ...routing, maxTokens, signal, reasoning: thinkingLevel === "off" ? undefined : thinkingLevel },
					),
					{ model, kind: "other", sessionId: routing.sessionId, parentSessionId: routing.parentSessionId },
				).result(),
			(result) => (result.stopReason === "error" ? (result.errorMessage ?? "error") : undefined),
		);
		if (message.stopReason === "error" || message.stopReason === "aborted") {
			throw new Error(message.errorMessage ?? `Request ${message.stopReason}`);
		}
		return { text: contentText(message.content, ""), costUsd: message.usage?.cost?.total ?? 0 };
	}

	/**
	 * /commit: the files to commit (scope "turn", "session", or "all" changed files; "session" falls back to "all"
	 * outside a session that changed files) and a conventional commit message from the chore model, ending with the
	 * co-author trailer (git.coAuthor, none by default). Nothing is staged or committed here; see commitFiles.
	 */
	async draftCommit(
		scope: CommitScope | undefined,
		signal: AbortSignal = new AbortController().signal,
	): Promise<CommitDraft | { error: string }> {
		const top = gitTopLevel(this._cwd);
		if (!top) return { error: "Not a git repository: nothing to commit." };
		let used: CommitScope = scope ?? "session";
		let scoped = used === "all" ? undefined : await this.getAgentChangedPaths(used);
		let paths = commitCandidates(this._cwd, scoped);
		if (paths.length === 0 && scope === undefined) {
			used = "all";
			scoped = undefined;
			paths = commitCandidates(this._cwd, undefined);
		}
		if (paths.length === 0) {
			return {
				error:
					used === "all"
						? "No changes to commit."
						: `No uncommitted changes from this ${used === "turn" ? "turn" : "session"}. /commit all commits every changed file.`,
			};
		}
		const { stat, diff } = diffForCommit(top, paths);
		const request = this._currentTurnEntry()?.text;
		let message: string | undefined;
		let costUsd = 0;
		let fallback = false;
		try {
			const reply = await this._choreText("commit", commitMessagePrompt({ stat, diff, request }), 400, signal);
			message = parseCommitMessage(reply.text);
			costUsd = reply.costUsd;
		} catch {
			// The fallback message below; the user edits it anyway.
		}
		if (!message) {
			message = fallbackCommitMessage(paths);
			fallback = true;
		}
		return {
			scope: used,
			top,
			paths,
			message: withCoAuthor(message, this.settingsManager.getGitCoAuthor()),
			costUsd,
			fallback,
		};
	}

	/** Stage and commit exactly the draft's files with `message` (path-limited: other staged files stay out). */
	commitFiles(draft: Pick<CommitDraft, "top" | "paths">, message: string) {
		return commitPaths(draft.top, draft.paths, message);
	}

	/** git.autoCommit "turn": after a run that changed files, commit them (no prompt; the setting is the ask). */
	private async _autoCommitTurn(): Promise<void> {
		if (this.settingsManager.getGitAutoCommit() !== "turn" || this._readOnlyReview) return;
		if (this._permissionGate.mode === "plan" || !gitTopLevel(this._cwd)) return;
		const changed = await this.getAgentChangedPaths("turn");
		if (changed.length === 0) return;
		const draft = await this.draftCommit("turn");
		if ("error" in draft) return;
		const result = this.commitFiles(draft, draft.message);
		this._emit(
			"error" in result
				? { type: "auto_commit", files: draft.paths.length, error: result.error }
				: { type: "auto_commit", files: draft.paths.length, sha: result.sha, subject: result.subject },
		);
	}

	/** The hidden plan-mode message for the next run, if one is due (consumed). */
	private _takePlanNotice(): CustomMessage | undefined {
		const planOn = this._permissionGate.mode === "plan";
		let text: string | undefined;
		if (planOn) text = this._planNotice === "enter" ? PLAN_MODE_INSTRUCTIONS : PLAN_MODE_REMINDER;
		else if (this._planNotice === "exit") text = planModeEndedNotice(this._permissionGate.mode);
		else if (this._planNotice === "discarded") text = PLAN_DISCARDED_NOTICE;
		this._planNotice = undefined;
		if (!text) return undefined;
		return {
			role: "custom",
			customType: PLAN_MODE_MESSAGE_TYPE,
			content: [{ type: "text", text }],
			display: false,
			timestamp: Date.now(),
		};
	}

	/**
	 * The saved permission rules for this session's project: global, per-project (in global settings) and the
	 * project's own file (ask and deny only), plus the entries that were ignored and why.
	 */
	getSavedPermissionRules(): LoadedRules {
		const scopes: Array<[RuleScope, ReturnType<SettingsManager["getPermissionRuleLists"]>]> = [
			["project-file", this.settingsManager.getPermissionRuleLists("project-file")],
			["project", this.settingsManager.getPermissionRuleLists("project", this._cwd)],
			["global", this.settingsManager.getPermissionRuleLists("global")],
		];
		const rules: LoadedRules["rules"] = [];
		const ignored: IgnoredRule[] = [];
		for (const [scope, lists] of scopes) {
			const loaded = loadRuleLists(lists, scope);
			rules.push(...loaded.rules);
			ignored.push(...loaded.ignored);
		}
		return { rules, ignored };
	}

	/**
	 * Save rules to the global or this project's rule list (both in global settings). Returns an error message for the
	 * first rule that does not parse; nothing is saved then.
	 */
	addSavedPermissionRules(
		scope: "global" | "project",
		action: RuleAction,
		texts: readonly string[],
	): string | undefined {
		for (const text of texts) {
			const parsed = parseRule(text);
			if ("error" in parsed) return `Invalid rule "${text}": ${parsed.error}.`;
		}
		const lists = this.settingsManager.getPermissionRuleLists(scope, this._cwd);
		const current = Array.isArray(lists[action])
			? (lists[action] as unknown[]).filter((x) => typeof x === "string")
			: [];
		const next = [...(current as string[])];
		for (const text of texts) if (!next.includes(text.trim())) next.push(text.trim());
		this.settingsManager.setPermissionRuleList(scope, action, next, this._cwd);
		return undefined;
	}

	/** Remove one saved rule (global or this project's). Returns whether it was there. */
	removeSavedPermissionRule(scope: "global" | "project", action: RuleAction, text: string): boolean {
		const lists = this.settingsManager.getPermissionRuleLists(scope, this._cwd);
		const current = Array.isArray(lists[action]) ? (lists[action] as unknown[]) : [];
		const next = current.filter((entry) => entry !== text);
		if (next.length === current.length) return false;
		this.settingsManager.setPermissionRuleList(
			scope,
			action,
			next.filter((x): x is string => typeof x === "string"),
			this._cwd,
		);
		return true;
	}

	/** Install (or remove) the interactive approval prompt. */
	setApprovalPrompt(
		prompt: ((prompt: PermissionPrompt, signal?: AbortSignal) => Promise<ApprovalAnswer | undefined>) | undefined,
	): void {
		this._approvalPrompt = prompt;
	}

	/**
	 * Ask the user. Undefined means no answer: no UI (print/json mode), dismissal, abort, timeout or an error. With
	 * no dedicated prompt installed, the extension UI's select (and input for feedback) asks instead, so RPC clients
	 * get the same four choices.
	 */
	private async _askForApproval(
		prompt: PermissionPrompt,
		signal?: AbortSignal,
	): Promise<{ answer?: ApprovalAnswer; headless: boolean }> {
		if (signal?.aborted) return { headless: false };
		this._hooksBridge?.notify("permission_prompt", `RunKiln needs your permission: ${prompt.title}`, "Permission");
		try {
			if (this._approvalPrompt) {
				const answer = await this._approvalPrompt(prompt, signal);
				return { answer: signal?.aborted ? undefined : answer, headless: false };
			}
			const ctx = this._extensionRunner.createContext();
			if (!ctx.hasUI) return { headless: true };
			const options: string[] = [APPROVAL_OPTION_LABELS.once];
			if (prompt.alwaysLabel) options.push(prompt.alwaysLabel);
			if (prompt.projectLabel) options.push(prompt.projectLabel);
			options.push(APPROVAL_OPTION_LABELS.deny, APPROVAL_OPTION_LABELS.feedback);
			const details = [prompt.message];
			if (prompt.risks.length > 0) details.push("", ...prompt.risks.map((risk) => `! ${risk}`));
			if (prompt.judgeReason) details.push("", `Auto: ${prompt.judgeReason}`);
			if (prompt.askRule) details.push("", `Asks because of the rule ${prompt.askRule}`);
			if (prompt.diff?.text) details.push("", prompt.diff.text);
			// A "pause" timeout cannot keep a generic dialog open, so that dialog waits instead.
			const timeout = prompt.timeoutAction === "pause" || prompt.timeoutMs <= 0 ? undefined : prompt.timeoutMs;
			const choice = await ctx.ui.select(`${prompt.title}\n${details.join("\n")}`, options, {
				signal,
				...(timeout ? { timeout } : {}),
			});
			if (signal?.aborted || choice === undefined) return { headless: false };
			if (choice === APPROVAL_OPTION_LABELS.once) return { answer: { choice: "allow-once" }, headless: false };
			if (choice === prompt.alwaysLabel) return { answer: { choice: "allow-always" }, headless: false };
			if (prompt.projectLabel && choice === prompt.projectLabel) {
				return { answer: { choice: "allow-project" }, headless: false };
			}
			if (choice === APPROVAL_OPTION_LABELS.feedback) {
				const feedback = await ctx.ui.input("What should the model do instead?", undefined, { signal });
				return { answer: { choice: "deny-feedback", feedback }, headless: false };
			}
			return { answer: { choice: "deny" }, headless: false };
		} catch {
			return { headless: false };
		}
	}

	/**
	 * RunKiln permission gate, then `tool_call` handlers. The mode (core/runkiln/permissions.ts) decides on top of the
	 * approval rules in core/runkiln/approval.ts: a write whose path names a different file on Windows is refused in
	 * every mode; allow-all runs everything else; read-write runs reads and in-project edits and asks for the rest;
	 * ask asks for everything; auto asks a decision model and always asks for risky calls. Nested
	 * `ctx.executeTool` calls pass through here too. No answer (no UI, dismissal, timeout) blocks the call.
	 */
	private async _approveToolCall(
		toolName: string,
		args: unknown,
		signal?: AbortSignal,
	): Promise<BeforeToolCallResult | undefined> {
		const options = this._toolCallOptions(toolName);
		// /review: the plan-mode read-only gate, whatever the permission mode.
		if (this._readOnlyReview && !isReadOnlyToolCall(toolName, options)) {
			return { block: true, reason: reviewBlockReason(toolName) };
		}
		let decision: Awaited<ReturnType<PermissionGate["decide"]>>;
		try {
			decision = await this._permissionGate.decide(toolName, args, this._cwd, options, signal);
		} catch {
			return { block: true, reason: denialReason(toolName, undefined) };
		}
		if (decision.action === "allow") return undefined;
		if (decision.action === "deny") {
			const reason =
				decision.via === "judge"
					? `Not run: the auto permission check denied this ${toolName} call (${decision.reason}). Ask the user if it is really needed.`
					: decision.via === "refusal"
						? `Not run: ${decision.reason}`
						: decision.reason;
			return { block: true, reason };
		}
		const timeout = this.settingsManager.getApprovalTimeoutPolicy();
		const prompt: PermissionPrompt = {
			toolName,
			mode: this._permissionGate.mode,
			title: decision.request.title,
			message: decision.request.message,
			risks: decision.risks,
			...(decision.judgeReason ? { judgeReason: decision.judgeReason } : {}),
			...(decision.suggestion ? { alwaysLabel: decision.suggestion.label } : {}),
			...(decision.suggestion?.projectLabel ? { projectLabel: decision.suggestion.projectLabel } : {}),
			...(decision.askRule ? { askRule: decision.askRule } : {}),
			...(decision.request.code ? { code: decision.request.code } : {}),
			...(await this._approvalDiff(toolName, args, options)),
			timeoutMs: timeout.timeoutMs,
			timeoutAction: timeout.action,
		};
		const { answer, headless } = await this._approvalQueue.run(() => this._askForApproval(prompt, signal));
		const approved =
			!signal?.aborted &&
			(answer?.choice === "allow-once" || answer?.choice === "allow-always" || answer?.choice === "allow-project");
		if (approved) this._permissionGate.noteRunning(toolName, args, this._cwd);
		if (answer?.choice === "allow-once" && !signal?.aborted) return undefined;
		if (answer?.choice === "allow-always" && !signal?.aborted) {
			if (decision.suggestion) this._permissionGate.addRules(decision.suggestion.rules);
			return undefined;
		}
		if (answer?.choice === "allow-project" && !signal?.aborted) {
			const suggestion = decision.suggestion;
			if (suggestion) {
				// Saved for the next sessions, and in effect now even if saving fails.
				this._permissionGate.addRules(suggestion.rules);
				if (suggestion.projectRules) {
					try {
						this.addSavedPermissionRules("project", "allow", suggestion.projectRules);
					} catch {
						// The session rule still applies; /permissions rules shows what was saved.
					}
				}
			}
			return undefined;
		}
		return {
			block: true,
			reason: headless ? headlessDenialReason(toolName, this._permissionGate.mode) : denialReason(toolName, answer),
		};
	}

	/**
	 * Folders outside the project the model may read without asking: the loaded skills' folders (the system prompt
	 * points at their SKILL.md files) and the user's skill and prompt folders.
	 */
	private _readRoots(): string[] {
		const agentDir = this._permissionAgentDir;
		const roots = [join(agentDir, "skills"), join(agentDir, "prompts"), join(homedir(), ".agents", "skills")];
		try {
			for (const skill of this._resourceLoader.getSkills().skills) roots.push(skill.baseDir);
		} catch {
			// No skills loaded yet.
		}
		return roots;
	}

	/** The diff preview for a genuine write or edit approval (approval-preview.ts); display only, never throws. */
	private async _approvalDiff(
		toolName: string,
		args: unknown,
		options: ToolCallOptions,
	): Promise<{ diff?: ApprovalDiff }> {
		if (!options.builtin) return {};
		try {
			const diff = await computeApprovalDiff(toolName, args, this._cwd);
			return diff ? { diff } : {};
		} catch {
			return {};
		}
	}

	/** `tool_call` handlers. `parentToolCallId` is set for calls another tool made. */
	private async _beforeToolCall(
		{ toolCall, args }: BeforeToolCallContext,
		parentToolCallId?: string,
		signal?: AbortSignal,
	): Promise<BeforeToolCallResult | undefined> {
		// The built-in todo tool only edits the session's checklist: no prompt in any mode, plan mode included.
		const todo = toolCall.name === TODO_TOOL_NAME && this._toolCallOptions(toolCall.name).builtin;
		// The built-in mcp tool only searches, and its calls run through ctx.executeTool, where each passes this gate
		// under its own mcp__server__tool name. bash_output only reads or stops jobs that an approved bash call started.
		const passThrough =
			(toolCall.name === MCP_TOOL_NAME || toolCall.name === BASH_OUTPUT_TOOL_NAME) &&
			this._toolCallOptions(toolCall.name).builtin;
		// Turned off after the session's tool list was frozen: still declared (prompt cache), refused here.
		if (parentToolCallId === undefined && this._isTurnedOff(toolCall.name)) {
			return { block: true, reason: `${toolCall.name} is turned off for this session. Do not call it again.` };
		}
		const denied = todo || passThrough ? undefined : await this._approveToolCall(toolCall.name, args, signal);
		if (denied) return denied;
		const runner = this._extensionRunner;
		if (!runner.hasHandlers("tool_call")) {
			await this._recordCheckpoint(toolCall.name, args);
			return undefined;
		}

		let result: BeforeToolCallResult | undefined;
		try {
			result = await runner.emitToolCall({
				type: "tool_call",
				toolName: toolCall.name,
				toolCallId: toolCall.id,
				...(parentToolCallId ? { parentToolCallId } : {}),
				input: args as Record<string, unknown>,
			});
		} catch (err) {
			if (err instanceof Error) {
				throw err;
			}
			throw new Error(`Extension failed, blocking execution: ${String(err)}`);
		}
		if (!result?.block) await this._recordCheckpoint(toolCall.name, args);
		return result;
	}

	// =========================================================================
	// Checkpoints (/undo, /rewind)
	// =========================================================================

	/** The checkpoint store for the current session and folder, or undefined when checkpoints are off. */
	get checkpoints(): CheckpointStore | undefined {
		if (!this._checkpointDir || !this.sessionManager.isPersisted()) return undefined;
		const sessionId = this.sessionManager.getSessionId();
		const store = this._checkpointStore;
		if (store && store.sessionId === sessionId && store.cwd === resolvePath(this._cwd)) return store;
		this._checkpointStore = new CheckpointStore({ rootDir: this._checkpointDir, sessionId, cwd: this._cwd });
		return this._checkpointStore;
	}

	/** The user message entry of the turn running now: the last user message on the current branch. */
	private _currentTurnEntry(): { id: string; text: string } | undefined {
		const branch = this.sessionManager.getBranch();
		for (let i = branch.length - 1; i >= 0; i--) {
			const entry = branch[i];
			if (entry.type === "message" && entry.message.role === "user") {
				return { id: entry.id, text: contentText(entry.message.content, "") };
			}
		}
		return undefined;
	}

	/** Before an approved mutating call: record the turn's checkpoint (and the edit/write target's old content). */
	private async _recordCheckpoint(toolName: string, args: unknown): Promise<void> {
		if (!isCheckpointTool(toolName)) return;
		const store = this.checkpoints;
		const turn = store ? this._currentTurnEntry() : undefined;
		if (!store || !turn) return;
		await store.beforeMutation(turn.id, toolName, args);
	}

	/**
	 * The user turns on the current branch, oldest first, each with its checkpoint and what the turn changed in the
	 * files. Turns without a checkpoint made no file mutation.
	 */
	async getRewindPoints(): Promise<RewindPoint[]> {
		const store = this.checkpoints;
		await store?.idle();
		const points: RewindPoint[] = [];
		let turn = 0;
		for (const entry of this.sessionManager.getBranch()) {
			if (entry.type !== "message" || entry.message.role !== "user") continue;
			turn++;
			const checkpoint = store?.forEntry(entry.id);
			points.push({
				entryId: entry.id,
				turn,
				text: contentText(entry.message.content, ""),
				timestamp: entry.timestamp,
				...(checkpoint
					? {
							checkpointId: checkpoint.id,
							summary: await store!.summarize(checkpoint.id),
							...(checkpoint.restoredAt ? { restored: true } : {}),
						}
					: {}),
			});
		}
		return points;
	}

	/**
	 * What restoring the files to before the turn of `entryId` would change. Covers every checkpoint from that turn
	 * to the end of the current branch. Undefined when checkpoints are off or no turn from there changed files.
	 */
	async planFileRestore(entryId: string): Promise<RestorePlan | undefined> {
		const store = this.checkpoints;
		if (!store) return undefined;
		await store.idle();
		const ids: string[] = [];
		let reached = false;
		for (const entry of this.sessionManager.getBranch()) {
			if (entry.id === entryId) reached = true;
			if (!reached || entry.type !== "message" || entry.message.role !== "user") continue;
			const checkpoint = store.forEntry(entry.id);
			if (checkpoint) ids.push(checkpoint.id);
		}
		if (!reached || ids.length === 0) return undefined;
		return store.planRestore(ids);
	}

	/** Checkpoint ids of the current branch's turns, oldest first. */
	private _branchCheckpointIds(store: CheckpointStore): string[] {
		const ids: string[] = [];
		for (const entry of this.sessionManager.getBranch()) {
			if (entry.type !== "message" || entry.message.role !== "user") continue;
			const checkpoint = store.forEntry(entry.id);
			if (checkpoint) ids.push(checkpoint.id);
		}
		return ids;
	}

	/**
	 * What the agent changed in the files this session (current branch) that still differs, per file: the changes
	 * tray and the review view. Undefined when checkpoints are off.
	 */
	async getSessionChanges(): Promise<SessionChanges | undefined> {
		const store = this.checkpoints;
		if (!store) return undefined;
		await store.idle();
		return store.sessionChanges(this._branchCheckpointIds(store));
	}

	/** Old and new content of one file in getSessionChanges(), or undefined when it no longer differs. */
	async getSessionFileVersions(path: string): Promise<SessionFileVersions | undefined> {
		const store = this.checkpoints;
		if (!store) return undefined;
		await store.idle();
		return store.sessionFileVersions(this._branchCheckpointIds(store), path);
	}

	/** Review view "keep": `content` becomes the file's baseline, so the change leaves the tray. */
	async keepSessionChange(path: string, content: Buffer | undefined): Promise<void> {
		const store = this.checkpoints;
		if (!store) throw new Error("Checkpoints are off for this session.");
		await store.keepBaseline(path, content);
	}

	/** Review view "revert": write `content` (undefined deletes the file). Refused while the agent is running. */
	async revertSessionChange(path: string, content: Buffer | undefined): Promise<void> {
		if (this.isStreaming) throw new Error("Wait for the current response to finish before reverting files.");
		const store = this.checkpoints;
		if (!store) throw new Error("Checkpoints are off for this session.");
		await store.writeProjectFile(path, content);
	}

	/** Apply a plan from planFileRestore. Refused while the agent is running. */
	async applyFileRestore(plan: RestorePlan): Promise<RestoreResult> {
		if (this.isStreaming) throw new Error("Wait for the current response to finish before restoring files.");
		const store = this.checkpoints;
		if (!store) throw new Error("Checkpoints are off for this session.");
		return store.applyRestore(plan);
	}

	/**
	 * Rewind the conversation to just before the user message `entryId` (the turn and everything after it leave
	 * the active branch; they stay in the session tree). Returns the message text for the editor.
	 */
	async rewindConversation(entryId: string): Promise<{ editorText?: string; cancelled: boolean }> {
		return this.navigateTree(entryId);
	}

	/** `tool_result` handlers and image normalization. `parentToolCallId` is set for calls another tool made. */
	private async _afterToolCall(
		{ toolCall, args, result, isError }: AfterToolCallContext,
		parentToolCallId?: string,
	): Promise<AfterToolCallResult | undefined> {
		const runner = this._extensionRunner;
		const hookResult = runner.hasHandlers("tool_result")
			? await runner.emitToolResult({
					type: "tool_result",
					toolName: toolCall.name,
					toolCallId: toolCall.id,
					...(parentToolCallId ? { parentToolCallId } : {}),
					input: args as Record<string, unknown>,
					content: result.content,
					details: result.details,
					...(result.structuredContent === undefined ? {} : { structuredContent: result.structuredContent }),
					isError,
					usage: result.usage,
				})
			: undefined;

		const content = hookResult?.content ?? result.content ?? [];
		// Runs after the extension hook so images injected or replaced by extensions are normalized too.
		const resizeOptions = this._limitsModel()?.inputLimits?.images?.resize;
		const normalizedContent = await normalizeToolResultImages(content, {
			autoResizeImages: this.settingsManager.getImageAutoResize(),
			...(resizeOptions ? { resizeOptions } : {}),
		});

		if (!hookResult && normalizedContent === content) {
			return undefined;
		}

		// The hook result already dropped structured content that replaced content no longer matches.
		return {
			content: normalizedContent,
			details: hookResult?.details,
			structuredContent: hookResult ? hookResult.structuredContent : result.structuredContent,
			isError: hookResult?.isError ?? isError,
			usage: hookResult?.usage,
		};
	}

	/**
	 * Run a call that the tool call `parentToolCallId` made through `ctx.executeTool()`. It goes
	 * through the agent's tool pipeline with the session's hooks, against the callable tools.
	 */
	private async _executeNestedToolCall(
		parentToolCallId: string,
		name: string,
		args: unknown,
		options: ExecuteToolOptions,
	): Promise<AgentToolCallOutcome> {
		this._nestedToolCalls ??= new NestedToolCallRunner({
			getTools: () => this._getCallableTools(),
			isSequential: () => this.agent.toolExecution === "sequential",
			runToolCall: (toolCall, parentId, signal, onUpdate) => {
				const assistantMessage = this._findLastAssistantMessage();
				if (!assistantMessage) {
					return Promise.resolve({
						toolCall,
						result: { content: [{ type: "text", text: "No assistant message issued this call" }], details: {} },
						isError: true,
					});
				}
				return runToolCall(toolCall, {
					tools: this._getCallableTools(),
					assistantMessage,
					context: { messages: this.agent.state.messages, tools: this.agent.state.tools },
					beforeToolCall: (context, signal) => this._beforeToolCall(context, parentId, signal),
					afterToolCall: (context) => this._afterToolCall(context, parentId),
					signal,
					onUpdate,
				});
			},
			emit: async (event) => {
				await this._extensionRunner.emit(event);
				this._emit(event);
			},
		});
		return this._nestedToolCalls.execute(parentToolCallId, name, args, options);
	}

	/** Whether `projection`, the current session projection, exceeds the compaction threshold of `model`. */
	private _exceedsCompactionThreshold(model: Model<any>, projection: SessionProjection): boolean {
		if (model.contextWindow <= 0) return false;
		return shouldCompact(
			estimateProjectedContextTokens(projection, this.sessionManager.getBranch()).tokens,
			model.contextWindow,
			this.settingsManager.getCompactionSettings(this.model),
			model,
		);
	}

	private async _compactBeforeNextAssistantResponse(context: AgentContext): Promise<AgentContext> {
		const projection = this.sessionManager.buildSessionProjection();
		const model = this.model;
		if (!model || !this._exceedsCompactionThreshold(model, projection)) {
			return { ...context, messages: projection.messages };
		}
		await this._runAutoCompaction("threshold", false);
		return { ...context, messages: this.sessionManager.buildSessionProjection().messages };
	}

	private _installAgentRequestProjection(): void {
		const previousPrepareRequest = this.agent.prepareRequest;
		this.agent.prepareRequest = async (request, signal) => {
			this._failedResponse = undefined;
			const projection = this.sessionManager.buildSessionProjection();
			const canonicalContext = {
				...request.context,
				messages: projection.messages,
				// Messages declare the provider-visible loadout; context.tools keeps executable implementations.
				tools: this.agent.state.tools.slice(),
			};
			if (await this._appendFirstTurnRepoMap(projection.messages, signal)) {
				canonicalContext.messages = this.sessionManager.buildSessionProjection().messages;
			}
			if (this._autoRouting) {
				const tokens = estimateProjectedContextTokens(projection, this.sessionManager.getBranch()).tokens;
				await this._routeRequest(projection.messages, tokens, signal);
			}
			const previous = await previousPrepareRequest?.(
				{
					...request,
					context: canonicalContext,
					model: this.agent.state.model,
					thinkingLevel: this.agent.state.thinkingLevel,
				},
				signal,
			);
			const context = previous?.context ?? canonicalContext;
			const model = previous?.model ?? this.agent.state.model;
			const thinkingLevel = previous?.thinkingLevel ?? this.agent.state.thinkingLevel;
			return { ...previous, context, model, thinkingLevel };
		};
	}

	private async _dispatchTurnEndBoundary(
		message: AssistantMessage,
		toolResults: ToolResultMessage[],
	): Promise<boolean> {
		this._lastActivityOutcome =
			message.stopReason === "aborted" ? "aborted" : message.stopReason === "error" ? "error" : "completed";
		const messageEntryId = this._findPersistedMessageEntryId(message);
		if (!this._extensionRunner.hasHandlers("turn_end")) return false;
		if (!messageEntryId) {
			this._extensionRunner.emitError({
				extensionPath: "<boundary>",
				event: "turn_end",
				error: "turn_end could not resolve the persisted assistant entry ID",
			});
			return false;
		}
		const toolResultEntryIds = toolResults.flatMap((result) => {
			const entryId = this._findPersistedMessageEntryId(result);
			return entryId ? [entryId] : [];
		});
		const boundary = await this._extensionRunner.emitBoundary(
			{
				type: "turn_end",
				turnIndex: this._turnIndex,
				message,
				toolResults,
				messageEntryId,
				toolResultEntryIds,
				outcome: this._lastActivityOutcome,
			},
			(entries) => this._buildBoundaryContext(entries, "turn_end"),
		);
		this._commitBoundaryDrafts(boundary.entries);
		if (boundary.continue && !this._buildBoundaryContext([], "turn_end").canContinue) {
			this._reportInvalidBoundaryContinuation("turn_end");
			return false;
		}
		return boundary.continue;
	}

	private _installAgentBoundaryHooks(): void {
		const previousFinishTurn = this.agent.finishTurn;
		this.agent.finishTurn = async (turn, signal) => {
			this._boundaryDispatchedMessages.add(turn.message);
			const extensionContinue = await this._dispatchTurnEndBoundary(turn.message, turn.toolResults);
			const previousDecision = await previousFinishTurn?.(turn, signal);
			if (previousDecision?.action === "end") return previousDecision;
			if (extensionContinue || previousDecision?.action === "continue") return { action: "continue" };
			return undefined;
		};
	}

	private _installAgentNextTurnRefresh(): void {
		const previousPrepareNextTurnWithContext =
			this.agent.prepareNextTurnWithContext ??
			(this.agent.prepareNextTurn
				? async (_turn: PrepareNextTurnContext, signal?: AbortSignal) => await this.agent.prepareNextTurn?.(signal)
				: undefined);
		this.agent.prepareNextTurnWithContext = async (turn, signal) => {
			const context = await this._compactBeforeNextAssistantResponse(turn.context);
			const previousSnapshot = await previousPrepareNextTurnWithContext?.({ ...turn, context }, signal);
			const nextContext = previousSnapshot?.context ?? context;
			const runOptions = this._runSystemPromptOptions ?? this._baseSystemPromptOptions;
			const options = normalizeBuildSystemPromptOptions({
				...runOptions,
				selectedTools: this.getActiveToolNames(),
				toolSnippets: { ...this._baseSystemPromptOptions.toolSnippets, ...runOptions.toolSnippets },
				toolGuidelines: { ...this._baseSystemPromptOptions.toolGuidelines, ...runOptions.toolGuidelines },
			});
			const updateMessage = this._preparePromptAndToolLoadout(options, nextContext.messages);
			// Keep session.systemPrompt and ctx.getSystemPrompt() in step with what the provider sees.
			this._runSystemPromptOptions = options;

			return {
				...previousSnapshot,
				context: {
					...nextContext,
					tools: this.agent.state.tools.slice(),
				},
				messages: updateMessage
					? [...(previousSnapshot?.messages ?? []), updateMessage]
					: previousSnapshot?.messages,
				model: this.agent.state.model,
				thinkingLevel: this.agent.state.thinkingLevel,
			};
		};
	}

	// =========================================================================
	// Event Subscription
	// =========================================================================

	private _refreshFinalizedContext(): void {
		const projection = this.sessionManager.buildSessionProjection();
		for (const entry of projection.entries) {
			for (const message of entry.messages) this._entryIdsByMessage.set(message, entry.sourceEntry.id);
		}
		this.agent.state.messages = projection.messages;
	}

	private _applyBoundaryDrafts(manager: SessionManager, drafts: SessionBoundaryDraft[]): SessionEntry[] {
		const appended: SessionEntry[] = [];
		for (const draft of drafts) {
			let entryId: string;
			switch (draft.type) {
				case "custom":
					entryId = manager.appendCustomEntry(draft.customType, draft.data);
					break;
				case "custom_message":
					entryId = manager.appendCustomMessageEntry(
						draft.customType,
						draft.content,
						draft.display,
						draft.details,
					);
					break;
				case "context_edit":
					entryId = manager.appendContextEdit(draft.targetId, draft.replacement);
					break;
				case "compaction": {
					const tokensBefore = estimateProjectedContextTokens(
						manager.buildSessionProjection(),
						manager.getBranch(),
					).tokens;
					entryId = manager.appendCompaction(
						draft.summary,
						draft.firstKeptEntryId,
						tokensBefore,
						draft.details,
						true,
						draft.usage,
					);
					break;
				}
			}
			const entry = manager.getEntry(entryId);
			if (entry) appended.push(entry);
		}
		return appended;
	}

	private _createBoundaryPreviewManager(drafts: SessionBoundaryDraft[]): SessionManager {
		const header = this.sessionManager.getHeader();
		if (!header) throw new Error("Session header is missing");
		const manager = SessionManager.inMemory(this._cwd, undefined, [header, ...this.sessionManager.getBranch()]);
		this._applyBoundaryDrafts(manager, drafts);
		return manager;
	}

	private _getPendingBoundaryMessages(): AgentMessage[] {
		return [...this.agent.peekQueuedMessages(), ...this._pendingCustomMessages];
	}

	private _buildBoundaryContext(
		drafts: SessionBoundaryDraft[],
		boundary: "turn_end" | "agent_before_settle",
	): BoundaryContextPreview {
		const projection = this._createBoundaryPreviewManager(drafts).buildSessionProjection();
		const pendingMessages = this._getPendingBoundaryMessages();
		const llmMessages = convertToLlm(projection.messages);
		const finalRole = llmMessages[llmMessages.length - 1]?.role;
		const hasNonSystemContext = llmMessages.some((message) => message.role !== "system");
		const contextCanContinue = hasNonSystemContext && finalRole !== "assistant";
		const pendingCustomContext = this._pendingCustomMessages.length > 0;
		return {
			contextEntries: projection.entries,
			contextMessages: projection.messages,
			llmMessages,
			pendingMessages,
			canContinue:
				contextCanContinue ||
				pendingCustomContext ||
				(boundary === "turn_end"
					? this.agent.hasQueuedMessages()
					: finalRole === "assistant" && this.agent.hasQueuedMessages()),
		};
	}

	private _commitBoundaryDrafts(drafts: SessionBoundaryDraft[]): void {
		const appended = this._applyBoundaryDrafts(this.sessionManager, drafts);
		this._refreshFinalizedContext();
		for (const entry of appended) this._emit({ type: "entry_appended", entry });
	}

	private _reportInvalidBoundaryContinuation(event: "turn_end" | "agent_before_settle"): void {
		this._extensionRunner.emitError({
			extensionPath: "<boundary>",
			event,
			error: `${event} requested continuation without runnable model context`,
		});
	}

	/** Emit an event to all listeners */
	private _emit(event: AgentSessionEvent): void {
		// A finished compaction replaced the prompt prefix: every pair's cache is cold, so the router may switch for free.
		if (event.type === "compaction_end" && event.result && !event.aborted) this._router?.cacheLost();
		for (const l of this._eventListeners) {
			l(event);
		}
	}

	private _emitQueueUpdate(): void {
		this._emit({
			type: "queue_update",
			steering: [...this._steeringMessages],
			followUp: [...this._followUpMessages],
		});
	}

	private async _emitSessionCompactFailed(event: Omit<SessionCompactFailedEvent, "type">): Promise<void> {
		if (this._extensionRunner.hasHandlers("session_compact_failed")) {
			await this._extensionRunner.emit({ type: "session_compact_failed", ...event });
		}
	}

	private _getIdleWaitPromise(): Promise<void> {
		if (!this._idleWaitPromise) {
			this._idleWaitPromise = new Promise((resolve) => {
				this._resolveIdleWait = resolve;
			});
		}
		return this._idleWaitPromise;
	}

	private _resolveIdleWaitIfIdle(): void {
		if (!this.isIdle || !this._resolveIdleWait) {
			return;
		}
		const resolve = this._resolveIdleWait;
		this._idleWaitPromise = undefined;
		this._resolveIdleWait = undefined;
		resolve();
	}

	private async _emitAgentSettled(): Promise<void> {
		this._isAgentRunActive = false;
		this._isEmittingAgentSettled = true;
		try {
			const aborted = this._agentRunAbortRequested;
			await this._extensionRunner.emit({ type: "agent_settled", aborted });
			this._emit({ type: "agent_settled", aborted });
		} finally {
			this._isEmittingAgentSettled = false;
		}

		const deferred = this._deferredSettledActions.splice(0);
		if (deferred.length > 0) {
			try {
				for (const action of deferred) await action();
			} finally {
				this._resolveIdleWaitIfIdle();
			}
			return;
		}
		this._resolveIdleWaitIfIdle();
	}

	/** Internal handler for agent events - shared by subscribe and reconnect */
	private _handleAgentEvent = async (event: AgentEvent): Promise<void> => {
		// Auto permissions: start judging a tool call as soon as the model has written it.
		if (
			event.type === "message_update" &&
			event.assistantMessageEvent.type === "toolcall_end" &&
			this._permissionGate.mode === "auto"
		) {
			const call = event.assistantMessageEvent.toolCall;
			this._permissionGate.prefetch(call.name, call.arguments, this._cwd, this._toolCallOptions(call.name));
		}
		// Queued before anything else, so a restore asked for right after the run waits for the end snapshot.
		if (event.type === "agent_end") void this._checkpointStore?.finishRun();
		if (event.type === "tool_execution_end") this.verify.noteToolEnd(event.toolName, event.isError);
		if (event.type === "message_start" && event.message.role === "user") this.verify.noteUserTurn();
		// An abort requested while the run was starting, e.g. during before_agent_start, stops it
		// here. agent_start is awaited before the first request.
		if (event.type === "agent_start" && this._agentRunAbortRequested) this.agent.abort();
		// Record the calls a tool made through ctx.executeTool() and their usage on its result message.
		if (this._nestedToolCalls) {
			if (event.type === "message_start" && event.message.role === "toolResult") {
				const message = event.message;
				const summary = this._nestedToolCalls.takeRecord(message.toolCallId);
				if (summary?.calls) message.nestedCalls = summary.calls;
				if (summary?.usage) {
					message.usage = message.usage ? combineUsage(message.usage, summary.usage) : summary.usage;
				}
			} else if (event.type === "agent_end") {
				this._nestedToolCalls.clear();
			}
		}
		// When a user message starts, check if it's from either queue and remove it BEFORE emitting
		// This ensures the UI sees the updated queue state
		if (event.type === "message_start" && event.message.role === "user") {
			this._overflowRecoveryAttempted = false;
			const messageText = contentText(event.message.content, "");
			if (messageText) {
				// Check steering queue first
				const steeringIndex = this._steeringMessages.indexOf(messageText);
				if (steeringIndex !== -1) {
					this._steeringMessages.splice(steeringIndex, 1);
					this._emitQueueUpdate();
				} else {
					// Check follow-up queue
					const followUpIndex = this._followUpMessages.indexOf(messageText);
					if (followUpIndex !== -1) {
						this._followUpMessages.splice(followUpIndex, 1);
						this._emitQueueUpdate();
					}
				}
			}
		}

		// A 413 payload_too_large: one terse line instead of the raw error (the retry shrinks the request).
		if (event.type === "message_end" && event.message.role === "assistant") {
			const assistant = event.message as AssistantMessage;
			if (assistant.stopReason === "error" && isPayloadTooLargeError(assistant.errorMessage)) {
				assistant.errorMessage = this._payloadShrinkRetried ? PAYLOAD_TOO_LARGE_FINAL : PAYLOAD_TOO_LARGE_RETRYING;
			}
		}

		// Emit to extensions first, then notify public listeners.
		await this._emitExtensionEvent(event);
		this._emit(event.type === "agent_end" ? { ...event, willRetry: this._willRetryAfterAgentEnd(event) } : event);

		// Handle session persistence
		if (event.type === "message_end") {
			let entryId: string | undefined;
			// Check if this is a custom message from extensions
			if (event.message.role === "custom") {
				// Persist as CustomMessageEntry
				entryId = this.sessionManager.appendCustomMessageEntry(
					event.message.customType,
					event.message.content,
					event.message.display,
					event.message.details,
				);
			} else if (
				event.message.role === "system" ||
				event.message.role === "user" ||
				event.message.role === "assistant" ||
				event.message.role === "toolResult"
			) {
				// Regular LLM message - persist as SessionMessageEntry
				entryId = this.sessionManager.appendMessage(event.message);
			}
			if (entryId) this._entryIdsByMessage.set(event.message, entryId);
			// Other message types (bashExecution, compactionSummary, branchSummary) are persisted elsewhere

			if (event.message.role === "assistant") {
				const assistantMsg = event.message as AssistantMessage;
				this._lastAssistantMessage = assistantMsg;
				if (assistantMsg.stopReason !== "error" && assistantMsg.stopReason !== "length") {
					this._overflowRecoveryAttempted = false;
				}
				if (assistantMsg.stopReason !== "error" && assistantMsg.stopReason !== "aborted") {
					this._modelHealth.markOk(assistantMsg.model);
				}

				// Reset retry counter immediately on successful assistant response
				// This prevents accumulation across multiple LLM calls within a turn
				if (assistantMsg.stopReason !== "error" && this._retryAttempt > 0) {
					this._emit({
						type: "auto_retry_end",
						success: true,
						attempt: this._retryAttempt,
					});
					this._retryAttempt = 0;
				}
			}
		}

		// A turn ends after its assistant message and every tool result has been appended,
		// so this is the first point in the run where a context-only custom message can be
		// inserted without landing between a tool call and its result. Flushing after the
		// extension and listener dispatch above also picks up messages that turn_end
		// handlers queued.
		if (event.type === "turn_end") {
			this._lastAssistantToolResults = event.toolResults;
			this._flushPendingCustomMessages();
		}
	};

	private _willRetryAfterAgentEnd(event: Extract<AgentEvent, { type: "agent_end" }>): boolean {
		if (this._agentRunAbortRequested) return false;
		const settings = this.settingsManager.getRetrySettings();
		if (!settings.enabled) return false;
		const retriesLeft = this._retryAttempt < this._maxRetriesForCurrentModel();
		for (let i = event.messages.length - 1; i >= 0; i--) {
			const message = event.messages[i];
			if (message.role === "assistant") {
				if (!this._isRetryableError(message as AssistantMessage)) return false;
				return retriesLeft || this._canFailover();
			}
		}
		return false;
	}

	private _findPersistedMessageEntryId(message: AgentMessage): string | undefined {
		const mapped = this._entryIdsByMessage.get(message);
		if (mapped) return mapped;
		for (const entry of [...this.sessionManager.getBranch()].reverse()) {
			if (entry.type === "message" && entry.message === message) return entry.id;
		}

		const messageIndex = this.agent.state.messages.indexOf(message);
		if (messageIndex < 0) return undefined;
		const projection = this.sessionManager.buildSessionProjection();
		let projectedIndex = 0;
		for (const entry of projection.entries) {
			for (let i = 0; i < entry.messages.length; i++) {
				if (projectedIndex === messageIndex) {
					this._entryIdsByMessage.set(message, entry.sourceEntry.id);
					return entry.sourceEntry.id;
				}
				projectedIndex++;
			}
		}
		return undefined;
	}

	private _omitRecoveryAttempt(message: AssistantMessage, toolResults: AgentMessage[] = []): void {
		const targets = [message, ...toolResults];
		const targetIds = targets.map((target) => this._findPersistedMessageEntryId(target));
		const unresolvedProjectedTarget = targets.some(
			(target, index) => targetIds[index] === undefined && this.agent.state.messages.includes(target),
		);
		if (unresolvedProjectedTarget) {
			throw new Error("Cannot persist recovery omission because a projected message has no source entry");
		}
		for (const targetId of targetIds) {
			if (!targetId) continue;
			const editId = this.sessionManager.appendContextEdit(targetId, null);
			const entry = this.sessionManager.getEntry(editId);
			if (entry) this._emit({ type: "entry_appended", entry });
		}
		this._refreshFinalizedContext();
	}

	/** Find the last assistant message in agent state (including aborted ones) */
	private _findLastAssistantMessage(): AssistantMessage | undefined {
		const messages = this.agent.state.messages;
		for (let i = messages.length - 1; i >= 0; i--) {
			const msg = messages[i];
			if (msg.role === "assistant") {
				return msg as AssistantMessage;
			}
		}
		return undefined;
	}

	private _replaceMessageInPlace(target: AgentMessage, replacement: AgentMessage): void {
		// Agent-core stores the finalized message object in its state before emitting message_end.
		// SessionManager persistence happens later in _handleAgentEvent() with event.message.
		// Mutating this object in place keeps agent state, later turn/agent events, listeners,
		// and the eventual SessionManager.appendMessage(event.message) persistence in sync.
		if (target === replacement) {
			return;
		}

		const targetRecord = target as unknown as Record<string, unknown>;
		for (const key of Object.keys(targetRecord)) {
			delete targetRecord[key];
		}
		Object.assign(targetRecord, replacement);
	}

	/** Emit extension events based on agent events */
	private async _emitExtensionEvent(event: AgentEvent): Promise<void> {
		if (event.type === "agent_start") {
			this._turnIndex = 0;
			await this._extensionRunner.emit({ type: "agent_start" });
		} else if (event.type === "agent_end") {
			await this._extensionRunner.emit({ type: "agent_end", messages: event.messages });
		} else if (event.type === "turn_start") {
			const extensionEvent: TurnStartEvent = {
				type: "turn_start",
				turnIndex: this._turnIndex,
				timestamp: Date.now(),
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "turn_end") {
			if (event.message.role === "assistant" && !this._boundaryDispatchedMessages.delete(event.message)) {
				await this._dispatchTurnEndBoundary(event.message, event.toolResults);
			}
			this._turnIndex++;
		} else if (event.type === "message_start") {
			const extensionEvent: MessageStartEvent = {
				type: "message_start",
				message: event.message,
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "message_update") {
			const extensionEvent: MessageUpdateEvent = {
				type: "message_update",
				message: event.message,
				assistantMessageEvent: event.assistantMessageEvent,
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "message_end") {
			const extensionEvent: MessageEndEvent = {
				type: "message_end",
				message: event.message,
			};
			const replacement = await this._extensionRunner.emitMessageEnd(extensionEvent);
			if (replacement) {
				// Untyped extension handlers can return messages with null/missing content;
				// normalize so it never enters agent state or session history.
				const normalized =
					(replacement.role === "user" ||
						replacement.role === "assistant" ||
						replacement.role === "toolResult" ||
						replacement.role === "custom") &&
					replacement.content == null
						? ({ ...replacement, content: [] } as AgentMessage)
						: replacement;
				this._replaceMessageInPlace(event.message, normalized);
			}
		} else if (event.type === "tool_execution_start") {
			const extensionEvent: ToolExecutionStartEvent = {
				type: "tool_execution_start",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "tool_execution_update") {
			const extensionEvent: ToolExecutionUpdateEvent = {
				type: "tool_execution_update",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
				partialResult: event.partialResult,
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "tool_execution_end") {
			const extensionEvent: ToolExecutionEndEvent = {
				type: "tool_execution_end",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				result: event.result,
				isError: event.isError,
				...(event.durationMs === undefined ? {} : { durationMs: event.durationMs }),
			};
			await this._extensionRunner.emit(extensionEvent);
		}
	}

	/**
	 * Subscribe to agent events.
	 * Session persistence is handled internally (saves messages on message_end).
	 * Multiple listeners can be added. Returns unsubscribe function for this listener.
	 */
	subscribe(listener: AgentSessionEventListener): () => void {
		this._eventListeners.push(listener);

		// Return unsubscribe function for this specific listener
		return () => {
			const index = this._eventListeners.indexOf(listener);
			if (index !== -1) {
				this._eventListeners.splice(index, 1);
			}
		};
	}

	/** Disconnect from agent events during disposal. */
	private _disconnectFromAgent(): void {
		if (this._unsubscribeAgent) {
			this._unsubscribeAgent();
			this._unsubscribeAgent = undefined;
		}
	}

	/**
	 * Remove all listeners and disconnect from agent.
	 * Call this when completely done with the session.
	 */
	dispose(): void {
		try {
			this.abortRetry();
			this.abortCompaction();
			this.abortBranchSummary();
			this.abortBash();
			this._titleAbortController?.abort();
			this.agent.abort();
			this._jobs.killAll();
			void this._mcp.dispose();
		} catch {
			// Dispose must succeed even if an abort hook throws.
		}

		this._extensionRunner.invalidate(
			"This extension ctx is stale after session replacement or reload. Do not use a captured extension API or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload(). For newSession, fork, and switchSession, move post-replacement work into withSession and use the ctx passed to withSession. For reload, do not use the old ctx after await ctx.reload().",
		);
		this._disconnectFromAgent();
		this._eventListeners = [];
		cleanupSessionResources(this.sessionId);
	}

	// =========================================================================
	// Read-only State Access
	// =========================================================================

	/** Refresh the public finalized transcript from the canonical session projection. */
	refreshContext(): void {
		this._refreshFinalizedContext();
	}

	/** Full agent state */
	get state(): AgentState {
		return this.agent.state;
	}

	/** Current model (may be undefined if not yet selected) */
	get model(): Model<any> | undefined {
		return this.agent.state.model;
	}

	/** Current thinking level */
	get thinkingLevel(): ThinkingLevel {
		return this.agent.state.thinkingLevel;
	}

	/** In auto mode: the model and thinking level the router chose for the latest request. */
	get routedModel(): { model: Model<any>; thinkingLevel?: ThinkingLevel } | undefined {
		if (!this._autoRouting) return undefined;
		const model = this.agent.state.model;
		return model ? { model, thinkingLevel: this.agent.state.thinkingLevel } : undefined;
	}

	// =========================================================================
	// Model router ("auto")
	// =========================================================================

	/** True when the router picks the model and thinking level per request. */
	get isAutoRouting(): boolean {
		return this._autoRouting;
	}

	/** The model as the user selected it: the "auto" entry in auto mode, else the current model. */
	get selectedModel(): Model<any> | undefined {
		return this._autoRouting ? this._modelRuntime.autoModelFor(this._routerMode) : this.model;
	}

	/** Routing mode for auto: low (cost-efficient), medium (balanced), high (deepest). */
	get routerMode(): RouterMode {
		return this._routerMode;
	}

	/** Change the routing mode. Takes effect on the next request, without a classifier call mid-turn. */
	setRouterMode(mode: RouterMode, options: ModelMutationOptions = {}): void {
		if (!isRouterMode(mode)) throw new Error(`Unknown routing mode "${mode}" (use ${ROUTER_MODES.join(", ")})`);
		const changed = this._routerMode !== mode;
		this._routerMode = mode;
		if (options.persist && this._autoRouting) this.settingsManager.setModelRole(this._role, autoModelId(mode));
		if (changed) {
			if (this._autoRouting) this.sessionManager.appendCustomEntry(ROUTER_STATE_ENTRY, { enabled: true, mode });
			this._emit({ type: "router_mode_changed", enabled: this._autoRouting });
		}
	}

	/**
	 * The mode-cycle keybinding (app.router.cycleMode): auto:low → auto:medium → auto:high → auto:low.
	 * On a manual model it turns auto routing on at the current mode instead. A pinned thinking level
	 * stays pinned while cycling. Throws when auto routing is unavailable (no router.yaml).
	 */
	cycleRouterMode(options: ModelMutationOptions = {}): RouterMode {
		if (!this._autoRouting) {
			this.setAutoRouting(true, { ...options, mode: this._routerMode });
			return this._routerMode;
		}
		const next = ROUTER_MODES[(ROUTER_MODES.indexOf(this._routerMode) + 1) % ROUTER_MODES.length];
		this.setRouterMode(next, options);
		return next;
	}

	/** True in auto mode when the router also picks the thinking level (nothing pinned). */
	get isThinkingAuto(): boolean {
		return this._autoRouting && this._pinnedThinking === undefined;
	}

	get pinnedThinkingLevel(): ThinkingLevel | undefined {
		return this._autoRouting ? this._pinnedThinking : undefined;
	}

	get lastRouteDecision(): RouteDecision | undefined {
		return this._router?.lastDecision;
	}

	/**
	 * Rebuild the router on next use, after the router settings or a classifier key changed (setup, /key).
	 * A router passed in through the session config is kept as is.
	 */
	reloadRouter(): void {
		if (this._routerInjected) return;
		this._router = undefined;
		this._routerError = undefined;
	}

	/** The session's router, built on first use. Undefined when router.yaml cannot be loaded. */
	getRouter(): ModelRouter | undefined {
		if (this._router || this._routerError) return this._router;
		try {
			const catalog = loadRouterCatalog();
			const settings = applyRouterOverrides(this.settingsManager.getRouterSettings(), this._routerOverrides);
			const defaults = effectiveRoleDefaults(this._modelRuntime.catalog, this.settingsManager.getModelRoles());
			this._router = createModelRouter({
				catalog,
				settings,
				getModels: () => this._modelRuntime.getRoutableModels(),
				defaultModelId: () => {
					const preferred = defaults[this._role];
					return isAutoModel({ id: preferred }) ? this._modelRuntime.catalog.defaults[this._role] : preferred;
				},
			});
			this._router.setModelFilter(this._isModelEnabled);
			this._router.setHealth(this._modelHealth);
			this._router.onClassifierSpend = (spend) => this._recordDecisionSpend("classifier", spend);
		} catch (error) {
			this._routerError = error instanceof Error ? error.message : String(error);
		}
		return this._router;
	}

	/** Model filter every router gets: false for a model hidden by the `disabledModels` setting. */
	private readonly _isModelEnabled = (model: Model<any>): boolean => !this._disabledModelIds().has(model.id);

	/**
	 * RunInfra model ids hidden by the `disabledModels` setting, when that setting exists. Read
	 * defensively: anything other than a list of strings is ignored.
	 */
	private _disabledModelIds(): Set<string> {
		const value = (this.settingsManager.getSettings() as Record<string, unknown>).disabledModels;
		if (!Array.isArray(value)) return new Set();
		return new Set(value.filter((id): id is string => typeof id === "string").map((id) => id.trim()));
	}

	getRouterStatus(): RouterStatus {
		const router = this.getRouter();
		const live = this._modelRuntime.liveCatalogStatus;
		const disabled = this._disabledModelIds();
		const routable = (this._modelRuntime.getRoutableModels?.() ?? []).filter((model) => !disabled.has(model.id));
		const catalogInfo = !live
			? `models.yaml (${routable.length} routable; live RunInfra catalog not read yet)`
			: live.error
				? `models.yaml (${routable.length} routable; live catalog unavailable: ${live.error})`
				: `${live.source === "cache" ? `cached RunInfra catalog (${formatCatalogAge(live.fetchedAt)})` : "live RunInfra catalog"}: ${live.available.join(", ") || "none"}${live.paused.length ? `; paused: ${live.paused.join(", ")}` : ""}${live.added.length ? `; new: ${live.added.join(", ")}` : ""}`;
		return {
			enabled: this._autoRouting,
			mode: this._routerMode,
			modeDescription: router?.catalog.modes[this._routerMode].description,
			catalogInfo,
			derivedModels: router ? router.unbenchedModelIds(routable) : undefined,
			backend: router?.classifier?.backend,
			classifierModel: router?.classifier?.modelId,
			problem: this._routerError ?? router?.classifierProblem,
			catalogSources: router?.catalog.sources ?? [],
			stats: router?.stats,
			coolingDown: this._modelHealth.down().map(({ modelId, leftMs }) => ({ modelId, leftMs })),
			failoverEnabled: this.settingsManager.getFailoverSettings().enabled,
		};
	}

	/**
	 * Text for /router: status, last decision, scores and cost estimate. `modeCycleKey` is the key bound to
	 * app.router.cycleMode, as the interactive mode displays it.
	 */
	formatRouterReport(options: { modeCycleKey?: string } = {}): string {
		return formatRouterReport(
			{ ...this.getRouterStatus(), modeCycleKey: options.modeCycleKey },
			this.lastRouteDecision,
		);
	}

	/**
	 * Turn auto mode on or off. Turning it on clears any pinned thinking level (the router decides);
	 * turning it off keeps the current concrete model as the manual choice.
	 */
	setAutoRouting(
		enabled: boolean,
		options: ModelMutationOptions & { pinnedThinking?: ThinkingLevel; mode?: RouterMode } = {},
	): void {
		const wasAuto = this._autoRouting;
		this._setAutoRouting(enabled, options);
		// Back on a manual model: drop the router's last level for the user's level or the defaults.
		if (wasAuto && !enabled && this.model) this._applyThinkingLevel(this._getThinkingLevelForModelSwitch(this.model));
	}

	/** setAutoRouting without re-applying the thinking level (callers that switch models apply it). */
	private _setAutoRouting(
		enabled: boolean,
		options: ModelMutationOptions & { pinnedThinking?: ThinkingLevel; mode?: RouterMode } = {},
	): void {
		if (enabled && !this.getRouter()) {
			throw new Error(`Auto routing is unavailable: ${this._routerError ?? "router.yaml could not be loaded"}`);
		}
		const changed = this._autoRouting !== enabled || (enabled && !!options.mode && options.mode !== this._routerMode);
		// A level pinned in auto mode stays the user's choice on the manual model.
		if (!enabled && this._autoRouting && this._pinnedThinking !== undefined) {
			this._manualThinking = this._pinnedThinking;
		}
		this._autoRouting = enabled;
		if (changed) this._sessionRoute = undefined;
		if (enabled && options.mode) this._routerMode = options.mode;
		this._pinnedThinking = enabled ? options.pinnedThinking : undefined;
		if (enabled) void this._modelRuntime.refreshLiveCatalog?.().catch(() => undefined);
		if (options.persist) {
			const roles = this.settingsManager.getModelRoles();
			if (enabled) this.settingsManager.setModelRole(this._role, autoModelId(this._routerMode));
			else if (isAutoModel({ id: roles[this._role] ?? "" }) && this.model) {
				this.settingsManager.setModelRole(this._role, this.model.id);
			}
		}
		if (changed) {
			this.sessionManager.appendCustomEntry(ROUTER_STATE_ENTRY, { enabled, mode: this._routerMode });
			this._emit({ type: "router_mode_changed", enabled });
		}
	}

	// =========================================================================
	// Review (/review, runkiln review)
	// =========================================================================

	/** Whether a /review run is going (read-only gate on). */
	get isReviewing(): boolean {
		return this._readOnlyReview;
	}

	/**
	 * /review [uncommitted|<commit>|<branch>]: a read-only review turn. RunKiln collects the diff, sends a one-line
	 * user message plus the instructions and diff as a hidden message, and runs the turn under the read-only gate.
	 * Routed like any turn. Resolves when the review answer is in, with an error when there is nothing to review.
	 */
	async review(arg?: string): Promise<{ error?: string; material?: ReviewMaterial }> {
		if (this.isStreaming) return { error: "Wait for the current response to finish before /review." };
		const cwd = this._cwd;
		const target = resolveReviewTarget(cwd, arg);
		if ("error" in target) return { error: target.error };
		const material = collectReviewMaterial(cwd, target);
		if ("error" in material) return { error: material.error };
		await this.sendCustomMessage(
			{
				customType: REVIEW_MESSAGE_TYPE,
				content: [{ type: "text", text: reviewInstructions(material) }],
				display: false,
				details: { label: material.label, files: material.files.length },
			},
			{ deliverAs: "nextTurn" },
		);
		this._readOnlyReview = true;
		try {
			await this.prompt(reviewRequestText(material), { expandPromptTemplates: false });
			// Some models end the run with an empty message after a blocked call (seen live on `runkiln review`):
			// ask once, hidden, for the written review.
			if (this._lastAssistantEndedEmpty()) {
				await this.sendCustomMessage(
					{
						customType: REVIEW_MESSAGE_TYPE,
						content: [{ type: "text", text: REVIEW_WRITE_NOW }],
						display: false,
					},
					{ triggerTurn: true },
				);
			}
		} finally {
			this._readOnlyReview = false;
		}
		return { material };
	}

	/** The last message is an assistant message that ended normally with no text and no tool call. */
	private _lastAssistantEndedEmpty(): boolean {
		const last = this.state.messages[this.state.messages.length - 1];
		if (last?.role !== "assistant") return false;
		const message = last as AssistantMessage;
		if (message.stopReason !== "stop") return false;
		return !message.content.some((part) => (part.type === "text" && part.text.trim()) || part.type === "toolCall");
	}

	// =========================================================================
	// Todo list (todo tool)
	// =========================================================================

	/** Activate or deactivate the todo tool to match the todo.enabled setting. */
	private _syncTodoTool(): void {
		if (!this._toolRegistry.has(TODO_TOOL_NAME) || !this._isAllowedTool(TODO_TOOL_NAME)) return;
		const active = this._wantedToolNames();
		const has = active.includes(TODO_TOOL_NAME);
		const want = this.settingsManager.getTodoSettings().enabled;
		if (want === has) return;
		this._setActiveTools(want ? [...active, TODO_TOOL_NAME] : active.filter((name) => name !== TODO_TOOL_NAME));
	}

	/** The current todo list: the newest todo result on the current branch (empty when there is none). */
	get todoItems(): TodoItem[] {
		const messages: Array<{ role: string; toolName?: string; isError?: boolean; details?: unknown }> = [];
		for (const entry of this.sessionManager.getBranch()) {
			if (entry.type === "message") messages.push(entry.message as never);
		}
		return currentTodoItems(messages);
	}

	/**
	 * After a run that ended normally with unfinished todo items: queue one hidden reminder and continue (once per
	 * user prompt; never in plan mode, where the turn ends with a plan, or when todo.nudge is off).
	 */
	private _queueTodoNudge(message: AssistantMessage): boolean {
		if (this._todoNudged || message.stopReason !== "stop") return false;
		if (this._permissionGate.mode === "plan" || this._readOnlyReview) return false;
		const settings = this.settingsManager.getTodoSettings();
		if (!settings.enabled || !settings.nudge || !this.getActiveToolNames().includes(TODO_TOOL_NAME)) return false;
		if (this.agent.hasQueuedMessages()) return false;
		const items = this.todoItems;
		if (unfinishedTodos(items).length === 0) return false;
		this._todoNudged = true;
		this.agent.followUp({
			role: "custom",
			customType: TODO_NUDGE_MESSAGE_TYPE,
			content: [{ type: "text", text: todoNudgeText(items) }],
			display: false,
			timestamp: Date.now(),
		});
		return true;
	}

	/** Auto mode: let the router pick the thinking level again. */
	setThinkingAuto(): void {
		if (!this._autoRouting || this._pinnedThinking === undefined) return;
		this._pinnedThinking = undefined;
		this._emit({ type: "thinking_level_changed", level: this.agent.state.thinkingLevel });
	}

	/**
	 * repoMap.firstTurnTokens: before the first request of a session, a static repo map centered on the first prompt is
	 * appended once as a hidden message. True when it was appended.
	 */
	private async _appendFirstTurnRepoMap(messages: readonly AgentMessage[], signal?: AbortSignal): Promise<boolean> {
		const settings = this.settingsManager.getRepoMapSettings();
		if (settings.firstTurnTokens <= 0 || this._baseToolsOverride) return false;
		const users = messages.filter((message) => message.role === "user");
		if (users.length !== 1 || messages.some((message) => message.role === "assistant")) return false;
		if (messages.some((message) => message.role === "custom" && message.customType === REPO_MAP_HINT_TYPE)) {
			return false;
		}
		try {
			const result = await getRepoMap(this._cwd, repoMapCacheDir()).render({
				conversation: conversationText(this.sessionManager.getBranch() as never),
				tokens: settings.firstTurnTokens,
			});
			if (signal?.aborted || result.text.length === 0) return false;
			this._appendCustomMessage({
				role: "custom",
				customType: REPO_MAP_HINT_TYPE,
				content: `[Repo map, not from the user: the repository's files and key symbols, ranked by relevance. Read the files you need; ${this.getActiveToolNames().includes(REPO_MAP_TOOL_NAME) ? "repo_map gives a bigger or more focused map." : "it may be incomplete."}]\n${result.text}`,
				display: false,
				details: { files: result.files, symbols: result.symbols, tokens: result.tokens },
				timestamp: Date.now(),
			});
			return true;
		} catch {
			return false;
		}
	}

	/** Routes one request: sets the agent's model and thinking level to the router's choice. */
	private async _routeRequest(messages: readonly AgentMessage[], tokens: number, signal?: AbortSignal) {
		const router = this.getRouter();
		if (!router) return undefined;
		// router.sessionModel: the first decision holds for the whole session (failover still switches).
		const pinned = this._sessionRoute;
		if (pinned && this.settingsManager.getRouterSettings().sessionModel === true && !router.failingOver) {
			this.agent.state.model = pinned.model;
			this.agent.state.thinkingLevel = pinned.thinkingLevel as ThinkingLevel;
			return undefined;
		}
		const signals = extractTurnSignals(messages as never, { contextTokens: tokens });
		const routeRequest = {
			signals,
			role: this._role === "chat" ? ("chat" as const) : ("code" as const),
			toolsActive: this.agent.state.tools.length > 0,
			pinnedThinking: this._pinnedThinking,
			mode: this._routerMode,
		};
		let decision: RouteDecision;
		try {
			// The classifier does not need the live catalog: start it first so the two waits overlap.
			router.prefetch(routeRequest, signal);
			// Which RunInfra models this key can call now (cached; bounded wait; models.yaml on failure).
			await this._modelRuntime.refreshLiveCatalog?.({ signal });
			decision = await router.route(routeRequest, signal);
		} catch {
			// Aborted, or no routable model at all: keep the current model; the request reports its own error.
			return undefined;
		}
		this._routedThisSession = true;
		if (!decision.failoverFrom) this._sessionRoute ??= decision;
		this.agent.state.model = decision.model;
		this.agent.state.thinkingLevel = decision.thinkingLevel as ThinkingLevel;
		this._recordRouteDecision(decision, signals.isNewUserTurn);
		this._emit({ type: "router_decision", decision });
		return decision;
	}

	/** The router's pick for /usage → Turns: once per new user turn, and on every switch inside a turn. */
	private _recordRouteDecision(decision: RouteDecision, newTurn: boolean): void {
		if (!newTurn && !decision.switched) return;
		try {
			const data: RouteEntryData = {
				model: decision.model.id,
				thinking: decision.thinkingLevel,
				mode: decision.mode,
				source: decision.source,
				reason: shortRouteReason(decision),
				...(decision.selection?.cause ? { cause: decision.selection.cause } : {}),
				...(decision.switched ? { switched: true } : {}),
				...(decision.switched && decision.previousModelId ? { from: decision.previousModelId } : {}),
				...(decision.estCostUsd !== undefined ? { estCostUsd: decision.estCostUsd } : {}),
			};
			this.sessionManager.appendCustomEntry(ROUTE_ENTRY_TYPE, data);
		} catch {
			// Accounting never changes a route.
		}
	}

	/**
	 * A billed decision-model call (router classifier or permission judge) as a `usage` entry, so the session total,
	 * the footer and /usage count it. A cost the response did not bill is estimated and noted `est.`.
	 */
	private _recordDecisionSpend(kind: "classifier" | "judge", spend: DecisionSpend): void {
		try {
			const entry = this.sessionManager.appendUsage(
				kind,
				spend.backend,
				spend.model,
				decisionSpendToUsage(spend),
				decisionSpendNote(spend) || undefined,
			);
			this._emit({ type: "entry_appended", entry });
		} catch {
			// Accounting must never break a turn.
		}
	}

	/** RunKiln session role (code or chat). */
	get role(): ModelRole {
		return this._role;
	}

	/** Whether the session is currently processing an agent run or post-run continuation. */
	get isStreaming(): boolean {
		return this._isAgentRunActive;
	}

	/** Whether the session has no active agent run, compaction, branch summary, retry, or queued continuation. */
	get isIdle(): boolean {
		return !this._isAgentRunActive && !this.isCompacting;
	}

	/** Current effective system prompt, including changes not yet sent to the model. */
	get systemPrompt(): string {
		return buildSystemPrompt(this._runSystemPromptOptions ?? this._baseSystemPromptOptions);
	}

	/** Current retry attempt (0 if not retrying) */
	get retryAttempt(): number {
		return this._retryAttempt;
	}

	/**
	 * Get the names of currently active tools, which are the tools declared to the model.
	 * Tools with `codemode` or `deferred` exposure are callable from other tools without being active.
	 */
	getActiveToolNames(): string[] {
		return this.agent.state.tools.map((t) => t.name);
	}

	/** Get the names of the tools that tools can call through `ctx.executeTool()`. */
	getCallableToolNames(): string[] {
		return this._getCallableTools().map((t) => t.name);
	}

	/**
	 * Get all configured tools with name, description, parameter schema, prompt guidelines, and source metadata.
	 */
	getAllTools(): ToolInfo[] {
		return Array.from(this._toolDefinitions.values()).map(({ definition, sourceInfo }) => ({
			name: definition.name,
			description: definition.description,
			parameters: definition.parameters,
			promptGuidelines: definition.promptGuidelines,
			exposure: this._getToolExposure(definition.name),
			...(definition.namespace ? { namespace: definition.namespace } : {}),
			...(definition.annotations ? { annotations: { ...definition.annotations } } : {}),
			...(definition.reachesTools ? { reachesTools: definition.reachesTools } : {}),
			sourceInfo,
		}));
	}

	getToolDefinition(name: string): ToolDefinition | undefined {
		return this._toolDefinitions.get(name)?.definition;
	}

	/**
	 * Set active tools by name.
	 * Only tools in the registry can be enabled. Unknown and hidden tool names are ignored.
	 * Also rebuilds the system prompt to reflect the new tool set.
	 * Changes take effect on the next agent turn.
	 */
	setActiveToolsByName(toolNames: string[]): void {
		const previous = this.getActiveToolNames();
		this._setActiveTools(toolNames);
		// A loadout that deactivates a tool replaces the restored one, whose pending tools are dropped.
		// One that only adds tools, like activating tool_search, keeps them.
		const active = new Set(this.getActiveToolNames());
		if (previous.some((name) => !active.has(name))) this._pendingToolNames.clear();
	}

	private _setActiveTools(toolNames: string[]): void {
		// bash_output comes with bash (it reads the jobs bash starts).
		if (
			toolNames.includes("bash") &&
			!toolNames.includes(BASH_OUTPUT_TOOL_NAME) &&
			this._toolRegistry.has(BASH_OUTPUT_TOOL_NAME)
		) {
			toolNames = [...toolNames, BASH_OUTPUT_TOOL_NAME];
		}
		const frozen = this._frozenPrompt;
		if (frozen) {
			// Frozen: keep declaring the session's tools; turning one off is enforced at call time.
			const wanted = [...new Set(toolNames)].filter(
				(name) => this._toolRegistry.has(name) && this._getToolExposure(name) !== "hidden",
			);
			for (const name of wanted) this._pendingToolNames.delete(name);
			this._enabledToolNames = new Set(wanted);
			const added = wanted.filter((name) => !frozen.toolNames.includes(name) && this._isDeclarable(name));
			if (added.length > 0) {
				this._reportPromptDrift(
					`${added.join(", ")}: available from the next session (/new); this one keeps its tool list so the prompt cache holds.`,
				);
			}
			this._declareFrozenTools(frozen);
			this._rebuildSystemPrompt([...frozen.toolNames]);
			return;
		}
		const tools = this._applyToolLoadout(toolNames);
		for (const tool of tools) this._pendingToolNames.delete(tool.name);
		this._rebuildSystemPrompt(tools.map((tool) => tool.name));
	}

	/**
	 * Declare exactly the frozen tools, with their frozen descriptions and schemas. A frozen tool that is no longer
	 * registered stays declared and answers with an error.
	 */
	private _declareFrozenTools(frozen: FrozenPrompt): void {
		this._hiddenDeclarations = new Set(frozen.hiddenTools);
		this.agent.state.tools = frozen.declarations.map((declaration): AgentTool => {
			const tool = this._toolRegistry.get(declaration.name);
			if (tool) {
				return {
					...tool,
					description: declaration.description,
					parameters: declaration.parameters as AgentTool["parameters"],
				};
			}
			return {
				name: declaration.name,
				label: declaration.name,
				description: declaration.description,
				parameters: declaration.parameters as AgentTool["parameters"],
				execute: async () => {
					throw new Error(`${declaration.name} is not available in this session.`);
				},
			};
		});
	}

	/** The tools the session wants on: the declared ones, or after the freeze the ones not turned off. */
	private _wantedToolNames(): string[] {
		return this._enabledToolNames ? [...this._enabledToolNames] : this.getActiveToolNames();
	}

	/** After the freeze, a declared tool the session turned off (settings, /reload, an extension). */
	private _isTurnedOff(name: string): boolean {
		const frozen = this._frozenPrompt;
		if (!frozen || !this._enabledToolNames || this._enabledToolNames.has(name)) return false;
		return frozen.toolNames.includes(name);
	}

	/** Whether `--tools` and `--exclude-tools` keep the tool registered. */
	private _isAllowedTool(name: string): boolean {
		if (this._excludedTools?.(name)) return false;
		return !this._allowedTools || this._allowedTools(name);
	}

	/** Whether the tool may be active, which declares it to the model. */
	private _isActivatable(_name: string): boolean {
		return true;
	}

	private _getToolExposure(name: string): ToolExposure {
		return this._toolDefinitions.get(name)?.definition.exposure ?? "direct";
	}

	/**
	 * Tools callable through `ctx.executeTool()`: the active `direct` tools and every registered
	 * `codemode` or `deferred` tool.
	 */
	private _getCallableTools(active: ReadonlySet<string> = new Set(this.getActiveToolNames())): AgentTool[] {
		return [...this._toolRegistry.values()].filter((tool) => {
			const exposure = this._getToolExposure(tool.name);
			return exposure === "codemode" || exposure === "deferred" || (exposure === "direct" && active.has(tool.name));
		});
	}

	/**
	 * Set the agent's tools for the given active tool names and return them. The active tools are
	 * the registered, non-hidden ones; they are declared to the model. Active tools with a
	 * `prepareLoadout` hook can change the declared descriptions and hide declarations from
	 * requests (see {@link _installHiddenDeclarationsProjection}).
	 */
	private _applyToolLoadout(toolNames: string[]): AgentTool[] {
		const tools = [...new Set(toolNames)].flatMap((name) => {
			const tool = this._toolRegistry.get(name);
			return tool && this._getToolExposure(name) !== "hidden" && this._isActivatable(name) ? [tool] : [];
		});
		const hooks = tools.flatMap((tool) => {
			const entry = this._toolDefinitions.get(tool.name);
			return entry?.definition.prepareLoadout ? [entry] : [];
		});
		const hidden = new Set<string>();
		let declared = tools;
		if (hooks.length > 0) {
			const loadout: ToolLoadout = {
				declared: tools,
				callable: this._getCallableTools(new Set(tools.map((tool) => tool.name))),
				registered: [...this._toolRegistry.values()],
				getExposure: (name) => this._getToolExposure(name),
				getNamespace: (name) => this._toolDefinitions.get(name)?.definition.namespace,
				getPromptGuidelines: (name) => this._toolPromptGuidelines.get(name) ?? [],
			};
			const descriptions = new Map<string, string>();
			for (const { definition, sourceInfo } of hooks) {
				try {
					const changes = definition.prepareLoadout?.(loadout);
					for (const [name, description] of Object.entries(changes?.descriptions ?? {})) {
						descriptions.set(name, description);
					}
					for (const name of changes?.hiddenDeclarations ?? []) hidden.add(name);
				} catch (error) {
					this._extensionRunner.emitError({
						extensionPath: sourceInfo.path,
						event: "prepare_loadout",
						error: error instanceof Error ? error.message : String(error),
						stack: error instanceof Error ? error.stack : undefined,
					});
				}
			}
			declared = tools.map((tool) => {
				const description = descriptions.get(tool.name);
				return description === undefined ? tool : { ...tool, description };
			});
		}
		this._hiddenDeclarations = hidden;
		this.agent.state.tools = declared;
		return declared;
	}

	/** Whether compaction or branch summarization is currently running */
	get isCompacting(): boolean {
		return (
			this._autoCompactionAbortController !== undefined ||
			this._compactionAbortController !== undefined ||
			this._branchSummaryAbortController !== undefined
		);
	}

	/** All messages including custom types like BashExecutionMessage */
	get messages(): AgentMessage[] {
		return this.agent.state.messages;
	}

	/** Current steering mode */
	get steeringMode(): "all" | "one-at-a-time" {
		return this.agent.steeringMode;
	}

	/** Current follow-up mode */
	get followUpMode(): "all" | "one-at-a-time" {
		return this.agent.followUpMode;
	}

	/** Current session file path, or undefined if sessions are disabled */
	get sessionFile(): string | undefined {
		return this.sessionManager.getSessionFile();
	}

	/** Current session ID */
	get sessionId(): string {
		return this.sessionManager.getSessionId();
	}

	/** Current session display name, if set */
	get sessionName(): string | undefined {
		return this.sessionManager.getSessionName();
	}

	/** Scoped models for cycling (from --models flag) */
	get scopedModels(): ReadonlyArray<{ model: Model<any>; thinkingLevel?: ThinkingLevel }> {
		return this._scopedModels;
	}

	/** Update scoped models for cycling */
	setScopedModels(scopedModels: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>): void {
		this._scopedModels = scopedModels;
	}

	/** File-based prompt templates */
	get promptTemplates(): ReadonlyArray<PromptTemplate> {
		return this._resourceLoader.getPrompts().prompts;
	}

	private _normalizePromptSnippet(text: string | undefined): string | undefined {
		if (!text) return undefined;
		const oneLine = text
			.replace(/[\r\n]+/g, " ")
			.replace(/\s+/g, " ")
			.trim();
		return oneLine.length > 0 ? oneLine : undefined;
	}

	private _normalizePromptGuidelines(guidelines: string[] | undefined): string[] {
		if (!guidelines || guidelines.length === 0) {
			return [];
		}

		const unique = new Set<string>();
		for (const guideline of guidelines) {
			const normalized = guideline.trim();
			if (normalized.length > 0) {
				unique.add(normalized);
			}
		}
		return Array.from(unique);
	}

	private _rebuildSystemPrompt(toolNames: string[]): void {
		const validToolNames = toolNames.filter((name) => this._toolRegistry.has(name));
		const toolSnippets: Record<string, string> = {};
		for (const name of this._toolRegistry.keys()) {
			const snippet = this._toolPromptSnippets.get(name);
			// Tools without a snippet are not listed.
			if (snippet) toolSnippets[name] = snippet;
		}

		const loaderSystemPrompt = this._resourceLoader.getSystemPrompt();
		const loaderAppendSystemPrompt = this._resourceLoader.getAppendSystemPrompt();
		const appendSystemPrompt = loaderAppendSystemPrompt.length > 0 ? loaderAppendSystemPrompt.join("\n\n") : "";
		const loadedSkills = this._resourceLoader.getSkills().skills;
		const loadedContextFiles = this._resourceLoader.getAgentsFiles().agentsFiles;

		this._baseSystemPromptOptions = normalizeBuildSystemPromptOptions({
			cwd: this._cwd,
			skills: loadedSkills,
			contextFiles: loadedContextFiles,
			customPrompt: loaderSystemPrompt,
			appendSystemPrompt,
			selectedTools: validToolNames,
			hiddenTools: [...this._hiddenDeclarations],
			toolSnippets,
			toolGuidelines: Object.fromEntries(this._toolPromptGuidelines),
		});
	}

	/**
	 * Apply a prompt and tool loadout for the next request. Sets the executable tools and
	 * returns a system message patching the prompt sections the model currently has (replayed
	 * from `messages`), or undefined when the prompt is unchanged. Tool changes are declared by
	 * the agent loop before the request.
	 *
	 * A forced prompt does not affect the transcript: the structured sections are still diffed
	 * and persisted, and the forced text is projected onto the request by
	 * {@link _installAgentForcedPromptProjection}.
	 */
	private _preparePromptAndToolLoadout(
		options: NormalizedBuildSystemPromptOptions,
		messages: AgentMessage[] = this.agent.state.messages,
	): SystemMessage | undefined {
		this._captureTranscriptPrompt(messages);
		const frozen = this._frozenPrompt;
		if (frozen) {
			// Never a system message after the freeze: the declared tools and the prompt stay byte for byte.
			this._declareFrozenTools(frozen);
			options.selectedTools = [...frozen.toolNames];
			options.hiddenTools = [...frozen.hiddenTools];
			if (options.forceSystemPrompt === undefined && Object.keys(frozen.sections).length > 0) {
				const sections = buildSystemPromptSections(options);
				const note = promptUpdateNote(this._notedSections ?? frozen.sections, sections);
				if (note) {
					this._pendingPromptNote = note;
					this._notedSections = sections;
				}
			}
			return undefined;
		}

		options.selectedTools = this._applyToolLoadout(options.selectedTools).map((tool) => tool.name);
		// The tool list and rules must match the declarations the request carries.
		options.hiddenTools = [...this._hiddenDeclarations];
		const sections = buildSystemPromptSections(options);
		const systemText = buildSystemPrompt(options);
		const declared = this.agent.state.tools.filter((tool) => !options.hiddenTools.includes(tool.name));
		this._frozenPrompt = {
			systemText,
			toolsKey: toolsSignature(declared),
			toolNames: [...options.selectedTools],
			hiddenTools: [...options.hiddenTools],
			sections: options.forceSystemPrompt === undefined ? { ...sections } : {},
			declarations: this.agent.state.tools.map((tool) => promptTool(tool)),
		};
		this._enabledToolNames = new Set(options.selectedTools);

		const patch = diffSystemPromptSections(getCurrentSystemMessage(messages)?.sections ?? {}, sections);
		return patch ? { role: "system", content: "", sections: patch, timestamp: Date.now() } : undefined;
	}

	/** The prompt-update note for the next user message (hidden; appended, so the cached prefix holds). */
	private _takePromptNote(): CustomMessage | undefined {
		const text = this._pendingPromptNote;
		this._pendingPromptNote = undefined;
		if (!text) return undefined;
		return {
			role: "custom",
			customType: PROMPT_UPDATE_MESSAGE_TYPE,
			content: [{ type: "text", text }],
			display: false,
			timestamp: Date.now(),
		};
	}

	/** Freeze whatever prompt and tools the transcript already has, so a resume cannot rewrite them. */
	private _captureTranscriptPrompt(messages: AgentMessage[]): void {
		if (this._frozenPrompt) return;
		const current = getCurrentSystemMessage(messages);
		if (!current) return;
		const systemText = getSystemMessageText(current);
		const tools = current.toolsAdded ?? [];
		if (!systemText && tools.length === 0) return;
		const sections: Record<string, string> = {};
		for (const [name, text] of Object.entries(current.sections ?? {}))
			if (typeof text === "string") sections[name] = text;
		this._frozenPrompt = {
			systemText,
			toolsKey: toolsSignature(tools),
			toolNames: tools.map((tool) => tool.name),
			hiddenTools: [],
			sections,
			declarations: tools.map((tool) => promptTool(tool)),
		};
		this._enabledToolNames = new Set(this.getActiveToolNames());
	}

	private _reportPromptDrift(message: string): void {
		if (this._promptDriftReported.has(message)) return;
		this._promptDriftReported.add(message);
		this._emit({ type: "prompt_drift", message });
	}

	/**
	 * Send a forced prompt as the provider's leading system prompt without recording it.
	 *
	 * A `before_agent_start` handler that returns `systemPrompt` needs that exact text at the
	 * head of the request; a mid-conversation system message would leave the original prompt
	 * in place. The forced text is a rendering of the current prompt, so the transcript keeps
	 * its structured sections and the request is projected instead: the system messages
	 * collapse into one head holding the forced text and the current tools. Runs after the
	 * `context` extension handlers.
	 */
	/**
	 * Remove the declarations that `prepareLoadout` hooks hide from every request. The whole
	 * transcript is filtered with the current set, so the projected declarations stay consistent
	 * across requests and only change when the loadout does.
	 */
	private _installHiddenDeclarationsProjection(): void {
		const previousTransformContext = this.agent.transformContext;
		this.agent.transformContext = async (messages, signal) => {
			const transformed = previousTransformContext ? await previousTransformContext(messages, signal) : messages;
			const hidden = this._hiddenDeclarations;
			if (hidden.size === 0) return transformed;
			return transformed.map((message) => {
				if (message.role !== "system" || (!message.toolsAdded && !message.toolsRemoved)) return message;
				const { toolsAdded, toolsRemoved, ...rest } = message;
				const added = toolsAdded?.filter((tool) => !hidden.has(tool.name)) ?? [];
				const removed = toolsRemoved?.filter((tool) => !hidden.has(tool.name)) ?? [];
				return {
					...rest,
					...(added.length > 0 ? { toolsAdded: added } : {}),
					...(removed.length > 0 ? { toolsRemoved: removed } : {}),
				};
			});
		};
	}

	private _installAgentForcedPromptProjection(): void {
		const previousTransformContext = this.agent.transformContext;
		this.agent.transformContext = async (messages, signal) => {
			const transformed = previousTransformContext ? await previousTransformContext(messages, signal) : messages;
			const forced = this._runSystemPromptOptions?.forceSystemPrompt;
			if (forced === undefined) return transformed;
			const current = getCurrentSystemMessage(transformed);
			const head: SystemMessage = {
				role: "system",
				content: forced,
				...(current?.toolsAdded ? { toolsAdded: current.toolsAdded } : {}),
				timestamp: current?.timestamp ?? Date.now(),
			};
			return [head, ...transformed.filter((message) => message.role !== "system")];
		};
	}

	/**
	 * Restore the active tool loadout declared by the session transcript, if it declares one.
	 * Tools reachable only from other tools are never declared, but they do not depend on the active
	 * set, so the transcript's declarations are the whole loadout.
	 * @param modifiers `+name`/`-name` entries applied to the restored loadout.
	 */
	private _restoreToolsFromTranscript(modifiers: readonly string[] = []): void {
		this._pendingToolNames.clear();
		const current = getCurrentSystemMessage(this.sessionManager.buildSessionContext().messages);
		if (!current) return;
		const names = applyToolModifiers(
			(current.toolsAdded ?? []).map((tool) => tool.name),
			modifiers,
		);
		this._pendingToolNames = new Set(names.filter((name) => this._isAllowedTool(name)));
		this._setActiveTools(names);
	}

	// =========================================================================
	// Prompting
	// =========================================================================

	/**
	 * Start a run from a user or custom message. The session counts as busy from here on, so
	 * messages sent while before_agent_start handlers run are queued into this run instead of
	 * starting another, and an abort requested meanwhile aborts the run as soon as it exists.
	 * @param onStarted Called once the run's messages are prepared, before the first request.
	 */
	private async _startRun(trigger: BeforeAgentStartTrigger, onStarted?: () => void): Promise<void> {
		this._isAgentRunActive = true;
		if (trigger.messageType === "user") this._todoNudged = false;
		this._agentRunAbortRequested = false;
		let messages: AgentMessage[];
		try {
			messages = await this._prepareRun(trigger);
		} catch (error) {
			this._isAgentRunActive = false;
			this._flushPendingBashMessages();
			this._flushPendingCustomMessages();
			this._resolveIdleWaitIfIdle();
			throw error;
		}
		// Messages held while the run was starting go before its starting messages, as they would
		// have while idle. No run exists yet, so they cannot split a tool call from its result.
		this._flushPendingBashMessages();
		this._flushPendingCustomMessages();
		onStarted?.();

		// Compaction before the prompt may have scheduled a retry; the new prompt replaces it.
		this._failedResponse = undefined;
		// A failover holds for one run (the user's turn); the next run is routed normally again.
		this._endFailover();
		// The run records the loadout in the transcript; restored tools that did not register by now
		// are dropped, so a tool that never registers does not stay pending.
		this._pendingToolNames.clear();
		try {
			await this.agent.prompt(messages);
			while (!this._agentRunAbortRequested) {
				if (await this._handlePostAgentRun()) {
					if (this._agentRunAbortRequested) break;
					await this.agent.continue();
					continue;
				}
				if (this._agentRunAbortRequested || !(await this._runBeforeSettleBoundary())) break;
				if (this._agentRunAbortRequested) break;
				await this.agent.continue();
			}
		} finally {
			if (this._agentRunAbortRequested) this._finishCancelledRetry();
			this._failedResponse = undefined;
			this._endFailover();
			this._runSystemPromptOptions = undefined;
			this._flushPendingBashMessages();
			this._flushPendingCustomMessages();
			if (!this._agentRunAbortRequested) await this._autoCommitTurn().catch(() => {});
			await this._emitAgentSettled();
		}
	}

	/**
	 * Prepare a run and return its starting messages: compact first when needed, emit
	 * before_agent_start, apply the run's prompt options and tool loadout, and build the starting
	 * message followed by pending nextTurn messages (consumed here) and handler messages, with a
	 * system patch first when the prompt changed.
	 */
	private async _prepareRun(trigger: BeforeAgentStartTrigger): Promise<AgentMessage[]> {
		// Check if we need to compact before sending (catches aborted responses).
		// The starting message is sent below, so do not call agent.continue() here.
		const lastAssistant = this._findLastAssistantMessage();
		if (lastAssistant) {
			await this._checkCompaction(lastAssistant, false);
			if (trigger.messageType === "user") await this._maybeIdleCompact(lastAssistant);
		}

		const selectedToolsBefore = this._baseSystemPromptOptions.selectedTools;
		const result = await this._extensionRunner.emitBeforeAgentStart(trigger, this._baseSystemPromptOptions);
		// Handlers may edit event.systemPromptOptions.selectedTools or call setActiveTools(),
		// which updates the live loadout instead. An explicit edit wins; otherwise the live
		// loadout is authoritative, so a setActiveTools() call is not undone here.
		const handlerEditedTools =
			result.systemPromptOptions.selectedTools.length !== selectedToolsBefore.length ||
			result.systemPromptOptions.selectedTools.some((name, index) => name !== selectedToolsBefore[index]);
		if (!handlerEditedTools) result.systemPromptOptions.selectedTools = this.getActiveToolNames();

		const messages: AgentMessage[] = [];
		if (trigger.messageType === "custom") {
			messages.push(trigger.message);
		} else {
			// Normalize images after before_agent_start so extension-driven model selection
			// determines the resize profile used for the request and history.
			const normalized = await this._normalizePromptImages(trigger.images);
			const text =
				normalized.hints.length > 0 ? `${trigger.prompt}\n\n${normalized.hints.join("\n")}` : trigger.prompt;
			messages.push({
				role: "user",
				content: [{ type: "text", text }, ...normalized.images],
				timestamp: Date.now(),
			});
		}
		// Inject any pending "nextTurn" messages as context alongside the starting message
		messages.push(...this._pendingNextTurnMessages);
		this._pendingNextTurnMessages = [];
		const planNotice = this._takePlanNotice();
		if (planNotice) messages.push(planNotice);
		for (const msg of result.messages) {
			messages.push({
				role: "custom",
				customType: msg.customType,
				// Untyped extensions can pass null/missing content; normalize at ingestion.
				content: msg.content ?? [],
				display: msg.display,
				details: msg.details,
				timestamp: Date.now(),
			});
		}
		const updateMessage = this._preparePromptAndToolLoadout(result.systemPromptOptions);
		this._runSystemPromptOptions = result.systemPromptOptions;
		if (updateMessage) messages.unshift(updateMessage);
		const promptNote = this._takePromptNote();
		if (promptNote) messages.push(promptNote);
		return messages;
	}

	private async _handlePostAgentRun(): Promise<boolean> {
		const message = this._lastAssistantMessage;
		const toolResults = this._lastAssistantToolResults;
		this._lastAssistantMessage = undefined;
		this._lastAssistantToolResults = [];
		if (this._agentRunAbortRequested) {
			this._finishCancelledRetry();
			return false;
		}
		if (!message) return this.agent.hasQueuedMessages();

		if (message.stopReason !== "error") {
			this._payloadShrinkRetried = false;
			this._requestFit.strict = false;
		} else if (isPayloadTooLargeError(message.errorMessage)) {
			// The same payload fails on every model: never fall back. Shrink harder (strict fit) and retry once on the
			// same model; after that the run ends with the one-line hint.
			if (this._payloadShrinkRetried || this._agentRunAbortRequested) return false;
			this._payloadShrinkRetried = true;
			this._requestFit.strict = true;
			this._omitRecoveryAttempt(message);
			return true;
		}

		if (this._isRetryableError(message) && (await this._prepareRetry(message))) {
			if (this._agentRunAbortRequested) this._finishCancelledRetry();
			this._failedResponse = message;
			return !this._agentRunAbortRequested;
		}
		if (await this._prepareModelFallback(message)) {
			return !this._agentRunAbortRequested;
		}
		if (this._agentRunAbortRequested) {
			this._finishCancelledRetry();
			return false;
		}

		if (message.stopReason === "error" && this._retryAttempt > 0) {
			this._emit({
				type: "auto_retry_end",
				success: false,
				attempt: this._retryAttempt,
				finalError: message.errorMessage,
			});
			this._retryAttempt = 0;
		}

		if (await this._checkCompaction(message, true, toolResults)) {
			return !this._agentRunAbortRequested;
		}
		if (this._queueTodoNudge(message)) return !this._agentRunAbortRequested;

		// The low-level loop drains both queues before agent_end. Messages queued by
		// agent_end handlers require a fresh run before pre-settlement handlers fire.
		return !this._agentRunAbortRequested && this.agent.hasQueuedMessages();
	}

	private async _runBeforeSettleBoundary(): Promise<boolean> {
		// The verify loop first: failing tests go back to the model as a hidden follow-up.
		const verifyFailure = await this.verify.beforeSettle().catch(() => undefined);
		if (verifyFailure && !this._agentRunAbortRequested) {
			this.agent.followUp(verifyFailure);
			return true;
		}
		if (!this._extensionRunner.hasHandlers("agent_before_settle")) return this.agent.hasQueuedMessages();
		this._isBeforeSettle = true;
		this._abortDuringBeforeSettle = false;
		try {
			const result = await this._extensionRunner.emitBoundary(
				{ type: "agent_before_settle", outcome: this._lastActivityOutcome },
				(entries) => this._buildBoundaryContext(entries, "agent_before_settle"),
			);
			this._commitBoundaryDrafts(result.entries);
			this._flushPendingCustomMessages();
			const finalContext = this._buildBoundaryContext([], "agent_before_settle");
			if (this._abortDuringBeforeSettle) return false;
			const shouldContinue = result.continue || this.agent.hasQueuedMessages();
			if (shouldContinue && !finalContext.canContinue) {
				if (result.continue) this._reportInvalidBoundaryContinuation("agent_before_settle");
				return false;
			}
			return shouldContinue;
		} finally {
			this._isBeforeSettle = false;
		}
	}

	private async _runInputHandlers(
		text: string,
		images: ImageContent[] | undefined,
		source: InputSource,
		streamingBehavior?: "steer" | "followUp",
	): Promise<{ text: string; images: ImageContent[] | undefined } | undefined> {
		if (!this._extensionRunner.hasHandlers("input")) {
			return { text, images };
		}

		const inputResult = await this._extensionRunner.emitInput(text, images, source, streamingBehavior);
		if (inputResult.action === "handled") {
			return undefined;
		}
		if (inputResult.action === "transform") {
			return { text: inputResult.text, images: inputResult.images ?? images };
		}
		return { text, images };
	}

	private async _normalizePromptImages(
		images: ImageContent[] | undefined,
	): Promise<{ images: ImageContent[]; hints: string[] }> {
		if (!images) return { images: [], hints: [] };

		const normalizedImages: ImageContent[] = [];
		const hints: string[] = [];
		for (const image of images) {
			const processed = await processImage(Buffer.from(image.data, "base64"), image.mimeType, {
				autoResizeImages: this.settingsManager.getImageAutoResize(),
				resizeOptions: this._limitsModel()?.inputLimits?.images?.resize,
			});
			if (!processed.ok) {
				hints.push(processed.message);
				continue;
			}
			normalizedImages.push({ type: "image", data: processed.data, mimeType: processed.mimeType });
			hints.push(...processed.hints);
		}
		return { images: normalizedImages, hints };
	}

	/**
	 * Send a prompt to the agent.
	 * - Handles extension commands (registered via api.registerCommand) immediately, even during streaming
	 * - Expands file-based prompt templates by default
	 * - During streaming, queues via steer() or followUp() based on streamingBehavior option
	 * - Validates model and API key before sending (when not streaming)
	 * @throws Error if streaming and no streamingBehavior specified
	 * @throws Error if no model selected or no API key available (when not streaming)
	 */
	async prompt(text: string, options?: PromptOptions): Promise<void> {
		if (this._isEmittingAgentSettled) {
			this._deferredSettledActions.push(async () => await this.prompt(text, options));
			return;
		}
		const expandPromptTemplates = options?.expandPromptTemplates ?? true;
		const preflightResult = options?.preflightResult;
		// Handle extension commands first (execute immediately, even during streaming)
		// Extension commands manage their own LLM interaction via api.sendMessage()
		if (expandPromptTemplates && text.startsWith("/")) {
			const handled = await this._tryExecuteExtensionCommand(text);
			if (handled) {
				// Extension command executed, no prompt to send
				preflightResult?.("handled");
				return;
			}
		}

		if (this._compactionAbortController !== undefined) {
			throw new Error(
				"Cannot submit a prompt while compaction is in progress. Wait for compaction to finish and retry.",
			);
		}

		// Emit input event for extension interception (before skill/template expansion)
		const processedInput = await this._runInputHandlers(
			text,
			options?.images,
			options?.source ?? "interactive",
			this.isStreaming ? options?.streamingBehavior : undefined,
		);
		if (!processedInput) {
			preflightResult?.("handled");
			return;
		}
		const { text: currentText, images: currentImages } = processedInput;

		// Expand skill commands (/skill:name args) and prompt templates (/template args)
		let expandedText = currentText;
		if (expandPromptTemplates) {
			expandedText = this._expandSkillCommand(expandedText);
			expandedText = expandPromptTemplate(expandedText, [...this.promptTemplates]);
		}

		// If streaming, queue via steer() or followUp() based on option
		if (this.isStreaming) {
			if (!options?.streamingBehavior) {
				throw new Error(
					"Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.",
				);
			}
			if (options.streamingBehavior === "followUp") {
				await this._queueFollowUp(expandedText, currentImages);
			} else {
				await this._queueSteer(expandedText, currentImages);
			}
			preflightResult?.("queued");
			return;
		}

		// Validate model
		if (!this.model) {
			throw new Error(formatNoModelSelectedMessage());
		}

		const hasConfiguredAuth =
			this._modelRuntime.hasConfiguredAuth(this.model.provider) ||
			(await this._modelRuntime.checkAuth(this.model.provider)) !== undefined;
		if (!hasConfiguredAuth) {
			const isOAuth = this._modelRuntime.isUsingOAuth(this.model.provider);
			if (isOAuth) {
				throw new Error(
					`Authentication failed for "${this.model.provider}". ` +
						`Credentials may have expired or network is unavailable. ` +
						`Check the key in /setup keys (${this.model.provider}).`,
				);
			}
			throw new Error(formatNoApiKeyFoundMessage(this.model.provider));
		}

		try {
			await this._startRun({ messageType: "user", prompt: expandedText, images: currentImages }, () =>
				preflightResult?.("started"),
			);
		} finally {
			// The run has settled: the answer, its tool calls and any retries are done, or it failed or was
			// aborted. Only now is the title requested, so it never shares prefill with this turn's request.
			if (options?.nameSession !== false) this._scheduleSessionTitle(expandedText);
		}
	}

	/**
	 * Name the session in the background with the title model, once its first answer has finished. The
	 * call has its own session id, so it does not share the main turn's cache route, and a failure here
	 * does not fail the turn. It is not awaited, so the next prompt does not wait for it.
	 */
	private _scheduleSessionTitle(userText: string): void {
		if (this._titleRequested || this.sessionManager.getSessionName()) return;
		// Another run is still active, so a request is in flight. Leave the title for a later prompt.
		if (!this.isIdle) return;
		const excerpt = userText.trim();
		if (!excerpt) return;
		this._titleRequested = true;
		const sessionId = this.sessionId;
		this._titleAbortController = new AbortController();
		void this._generateSessionTitle(sessionId, excerpt, this._titleAbortController.signal);
	}

	/**
	 * Model and thinking level for a side task (see runkiln/chore-model.ts): the `choreModel` setting,
	 * default deepseek-v4-1-flash-1017 with thinking off, then glm-5-3-flash at low, then the session model.
	 * Titles honor a `models.title` setting. Disabled, paused and cooling-down models are skipped, and so
	 * are `exclude`d ones and, for summaries, models with a smaller context window than the session model.
	 */
	private _resolveChoreModel(kind: ChoreKind, exclude: ReadonlySet<string> = new Set()): ChoreModelChoice | undefined {
		const titleSetting = kind === "title" ? this.settingsManager.getModelRoles().title : undefined;
		const session = this.model;
		const paused = new Set(
			this._modelRuntime.liveCatalogStatus?.error ? [] : (this._modelRuntime.liveCatalogStatus?.paused ?? []),
		);
		const minContext =
			kind === "title" || kind === "commit" || kind === "edit-repair" ? 0 : (session?.contextWindow ?? 0);
		return resolveChoreModel(titleSetting ?? this.settingsManager.getChoreModel(), {
			getModel: (id) => this._modelRuntime.getModelById(id),
			isUsable: (model) =>
				this._isModelEnabled(model) &&
				!paused.has(model.id) &&
				!exclude.has(model.id) &&
				model.contextWindow >= minContext,
			isHealthy: (id) => this._modelHealth.isHealthy(id),
			session: { model: session, thinkingLevel: this.thinkingLevel },
		});
	}

	/**
	 * Runs a summary side task on the chore model; when that call fails, on the next chore model, ending with
	 * the session model. A transient failure also marks the model unhealthy. Aborts are not retried.
	 */
	private async _withChoreModel<T>(
		kind: ChoreKind,
		signal: AbortSignal,
		run: (model: Model<any>, thinkingLevel: ThinkingLevel) => Promise<T>,
		failed: (result: T) => string | undefined = () => undefined,
	): Promise<T> {
		const tried = new Set<string>();
		for (;;) {
			const choice = this._resolveChoreModel(kind, tried);
			const model = choice?.model ?? this.model;
			if (!model) throw new Error(formatNoModelSelectedMessage());
			const thinkingLevel = (choice?.thinkingLevel ?? this.thinkingLevel) as ThinkingLevel;
			const last = !choice || choice.source === "session";
			let error: string | undefined;
			try {
				const result = await run(model, thinkingLevel);
				error = failed(result);
				if (error === undefined || last || signal.aborted) return result;
			} catch (caught) {
				if (last || signal.aborted) throw caught;
				error = caught instanceof Error ? caught.message : String(caught);
			}
			tried.add(model.id);
			if (isRetryableAssistantError({ stopReason: "error", errorMessage: error } as AssistantMessage)) {
				this._modelHealth.markFailed(model.id, error);
			}
		}
	}

	/** Edit repair (setting edit.autoRepair): one call on the chore model, never the session model. */
	private async _runEditRepairChore(prompt: string, signal?: AbortSignal): Promise<string | undefined> {
		const choice = this._resolveChoreModel("edit-repair");
		if (!choice || choice.source === "session") return undefined;
		const { model, thinkingLevel } = choice;
		const routing = {
			sessionId: backgroundSessionId(this.sessionId, "edit-repair"),
			parentSessionId: this.sessionId,
		};
		const message = await observeCallMetrics(
			this._modelRuntime.streamSimple(
				model,
				{ messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }] },
				{ ...routing, maxTokens: 2048, signal, reasoning: thinkingLevel === "off" ? undefined : thinkingLevel },
			),
			{ model, kind: "other", sessionId: routing.sessionId, parentSessionId: routing.parentSessionId },
		).result();
		if (message.stopReason === "error" || message.stopReason === "aborted") return undefined;
		return contentText(message.content, "");
	}

	private async _generateSessionTitle(sessionId: string, userText: string, signal: AbortSignal): Promise<void> {
		try {
			// A side task: the chore model (DeepSeek, thinking off, by default), never the session model.
			const choice = this._resolveChoreModel("title");
			if (!choice || choice.source === "session") return;
			const { model, thinkingLevel } = choice;
			const routing = titleCallRouting(sessionId);
			const message = await observeCallMetrics(
				this._modelRuntime.streamSimple(
					model,
					{ messages: [titleUserMessage(userText)] },
					{ ...routing, maxTokens: 64, signal, reasoning: thinkingLevel === "off" ? undefined : thinkingLevel },
				),
				{
					model,
					kind: "title",
					sessionId: routing.sessionId,
					parentSessionId: routing.parentSessionId,
				},
			).result();
			if (
				this.sessionId === sessionId &&
				message.usage.cost.total + message.usage.input + message.usage.output > 0
			) {
				// The title call is billed even when it fails: count it as a chore.
				const entry = this.sessionManager.appendUsage("title", model.provider, model.id, message.usage);
				this._emit({ type: "entry_appended", entry });
			}
			if (message.stopReason === "error" || message.stopReason === "aborted") return;
			if (this.sessionId !== sessionId || this.sessionManager.getSessionName()) return;
			const title = parseSessionTitle(contentText(message.content, ""));
			if (title) this.setSessionName(title);
		} catch {
			// A title is optional. The session keeps going without one.
		}
	}

	/**
	 * Try to execute an extension command. Returns true if command was found and executed.
	 */
	private async _tryExecuteExtensionCommand(text: string): Promise<boolean> {
		// Parse command name and args
		const spaceIndex = text.indexOf(" ");
		const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
		const args = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1);

		const command = this._extensionRunner.getCommand(commandName);
		if (!command) return false;

		// Get command context from extension runner (includes session control methods)
		const ctx = this._extensionRunner.createCommandContext();

		try {
			await command.handler(args, ctx);
			return true;
		} catch (err) {
			// Emit error via extension runner
			this._extensionRunner.emitError({
				extensionPath: `command:${commandName}`,
				event: "command",
				error: err instanceof Error ? err.message : String(err),
			});
			return true;
		}
	}

	/**
	 * Expand skill commands (/skill:name args) to their full content.
	 * Returns the expanded text, or the original text if not a skill command or skill not found.
	 * Emits errors via extension runner if file read fails.
	 */
	private _expandSkillCommand(text: string): string {
		if (!text.startsWith("/skill:")) return text;

		const spaceIndex = text.indexOf(" ");
		const skillName = spaceIndex === -1 ? text.slice(7) : text.slice(7, spaceIndex);
		const args = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1).trim();

		const skill = this.resourceLoader.getSkills().skills.find((s) => s.name === skillName);
		if (!skill) return text; // Unknown skill, pass through

		try {
			const content = readFileSync(skill.filePath, "utf-8");
			const body = stripFrontmatter(content).trim();
			const skillBlock = `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
			return args ? `${skillBlock}\n\n${args}` : skillBlock;
		} catch (err) {
			// Emit error like extension commands do
			this._extensionRunner.emitError({
				extensionPath: skill.filePath,
				event: "skill_expansion",
				error: err instanceof Error ? err.message : String(err),
			});
			return text; // Return original on error
		}
	}

	private async _queueUserInput(
		text: string,
		images: ImageContent[] | undefined,
		behavior: "steer" | "followUp",
		source: InputSource,
	): Promise<QueuedInputDisposition> {
		if (text.startsWith("/")) {
			this._throwIfExtensionCommand(text);
		}

		const processedInput = await this._runInputHandlers(
			text,
			images,
			source,
			this.isStreaming ? behavior : undefined,
		);
		if (!processedInput) return "handled";

		let expandedText = this._expandSkillCommand(processedInput.text);
		expandedText = expandPromptTemplate(expandedText, [...this.promptTemplates]);

		if (behavior === "steer") {
			await this._queueSteer(expandedText, processedInput.images);
		} else {
			await this._queueFollowUp(expandedText, processedInput.images);
		}
		return "queued";
	}

	/**
	 * Queue a steering message while the agent is running.
	 * Delivered after the current assistant turn finishes executing its tool calls,
	 * before the next LLM call.
	 * Expands skill commands and prompt templates. Errors on extension commands.
	 * @param images Optional image attachments to include with the message
	 * @param options Input source; defaults to interactive
	 * @throws Error if text is an extension command
	 */
	async steer(
		text: string,
		images?: ImageContent[],
		options?: { source?: InputSource },
	): Promise<QueuedInputDisposition> {
		return this._queueUserInput(text, images, "steer", options?.source ?? "interactive");
	}

	/**
	 * Queue a follow-up message to be processed after the agent finishes.
	 * Delivered only when agent has no more tool calls or steering messages.
	 * Expands skill commands and prompt templates. Errors on extension commands.
	 * @param images Optional image attachments to include with the message
	 * @param options Input source; defaults to interactive
	 * @throws Error if text is an extension command
	 */
	async followUp(
		text: string,
		images?: ImageContent[],
		options?: { source?: InputSource },
	): Promise<QueuedInputDisposition> {
		return this._queueUserInput(text, images, "followUp", options?.source ?? "interactive");
	}

	/**
	 * Internal: Queue a steering message (already expanded, no extension command check).
	 */
	private async _queueSteer(text: string, images?: ImageContent[]): Promise<void> {
		this._steeringMessages.push(text);
		this._emitQueueUpdate();
		const content: (TextContent | ImageContent)[] = [{ type: "text", text }];
		if (images) {
			content.push(...images);
		}
		this.agent.steer({
			role: "user",
			content,
			timestamp: Date.now(),
		});
	}

	/**
	 * Internal: Queue a follow-up message (already expanded, no extension command check).
	 */
	private async _queueFollowUp(text: string, images?: ImageContent[]): Promise<void> {
		this._followUpMessages.push(text);
		this._emitQueueUpdate();
		const content: (TextContent | ImageContent)[] = [{ type: "text", text }];
		if (images) {
			content.push(...images);
		}
		this.agent.followUp({ role: "user", content, timestamp: Date.now() });
	}

	/**
	 * Throw an error if the text is an extension command.
	 */
	private _throwIfExtensionCommand(text: string): void {
		const spaceIndex = text.indexOf(" ");
		const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
		const command = this._extensionRunner.getCommand(commandName);

		if (command) {
			throw new Error(
				`Extension command "/${commandName}" cannot be queued. Use prompt() or execute the command when not streaming.`,
			);
		}
	}

	/**
	 * Send a custom message to the session. Creates a CustomMessageEntry.
	 *
	 * Handles four cases:
	 * - Streaming: queues message, processed when loop pulls from queue
	 * - Streaming + triggerTurn false: appended to state/session once the current turn ends
	 * - Not streaming + triggerTurn: appends to state/session, starts new turn
	 * - Not streaming + no trigger: appends to state/session, no turn
	 *
	 * @param message Custom message with customType, content, display, details
	 * @param options.triggerTurn If true and not streaming, triggers a new LLM turn
	 * @param options.deliverAs Delivery mode: "steer", "followUp", or "nextTurn"
	 */
	async sendCustomMessage<T = unknown>(
		message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">,
		options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
	): Promise<void> {
		const appMessage = {
			role: "custom" as const,
			customType: message.customType,
			// Untyped extensions can pass null/missing content; normalize at ingestion.
			content: message.content ?? [],
			display: message.display,
			details: message.details,
			timestamp: Date.now(),
		} satisfies CustomMessage<T>;
		if (options?.deliverAs === "nextTurn") {
			this._pendingNextTurnMessages.push(appMessage);
		} else if (this.isStreaming && options?.triggerTurn !== false) {
			if (options?.deliverAs === "followUp") {
				this.agent.followUp(appMessage);
			} else {
				this.agent.steer(appMessage);
			}
		} else if (options?.triggerTurn) {
			if (this._isEmittingAgentSettled) {
				this._deferredSettledActions.push(async () => await this.sendCustomMessage(message, options));
				return;
			}
			await this._startRun({ messageType: "custom", message: appMessage });
		} else if (this.isStreaming) {
			// Appending now would put the message between an assistant tool call and its
			// result, which providers that validate message order reject on replay. Defer
			// to the end of the turn. Nothing is emitted yet: message events must not
			// describe messages the session tree does not contain.
			this._pendingCustomMessages.push(appMessage);
		} else {
			this._appendCustomMessage(appMessage);
		}
	}

	private _appendCustomMessage(appMessage: CustomMessage): void {
		this.sessionManager.appendCustomMessageEntry(
			appMessage.customType,
			appMessage.content,
			appMessage.display,
			appMessage.details,
		);
		this._refreshFinalizedContext();
		this._emit({ type: "message_start", message: appMessage });
		this._emit({ type: "message_end", message: appMessage });
	}

	/**
	 * Append custom messages queued while the agent was running.
	 * Called once the current turn's tool results are in agent state and session history.
	 */
	private _flushPendingCustomMessages(): void {
		if (this._pendingCustomMessages.length === 0) return;

		const pending = this._pendingCustomMessages;
		this._pendingCustomMessages = [];
		for (const appMessage of pending) {
			this._appendCustomMessage(appMessage);
		}
	}

	/**
	 * Send a user message to the agent. Always triggers a turn.
	 * When the agent is streaming, use deliverAs to specify how to queue the message.
	 *
	 * @param content User message content (string or content array)
	 * @param options.deliverAs Delivery mode when streaming: "steer" or "followUp"
	 * @param options.expandPromptTemplates Whether to dispatch extension commands and expand skill commands and prompt templates. Default: false.
	 */
	async sendUserMessage(
		content: string | (TextContent | ImageContent)[],
		options?: { deliverAs?: "steer" | "followUp"; expandPromptTemplates?: boolean },
	): Promise<void> {
		// Normalize content to text string + optional images
		let text: string;
		let images: ImageContent[] | undefined;

		if (typeof content === "string") {
			text = content;
		} else {
			const textParts: string[] = [];
			images = [];
			for (const part of content) {
				if (part.type === "text") {
					textParts.push(part.text);
				} else {
					images.push(part);
				}
			}
			text = textParts.join("\n");
			if (images.length === 0) images = undefined;
		}

		await this.prompt(text, {
			expandPromptTemplates: options?.expandPromptTemplates ?? false,
			streamingBehavior: options?.deliverAs,
			images,
			source: "extension",
		});
	}

	/**
	 * Clear all queued messages and return them.
	 * Useful for restoring to editor when user aborts.
	 * @returns Object with steering and followUp arrays
	 */
	clearQueue(): { steering: string[]; followUp: string[] } {
		const steering = [...this._steeringMessages];
		const followUp = [...this._followUpMessages];
		this._steeringMessages = [];
		this._followUpMessages = [];
		this.agent.clearAllQueues();
		this._emitQueueUpdate();
		return { steering, followUp };
	}

	/** Number of pending messages (includes both steering and follow-up) */
	get pendingMessageCount(): number {
		return this._steeringMessages.length + this._followUpMessages.length;
	}

	/** Get pending steering messages (read-only) */
	getSteeringMessages(): readonly string[] {
		return this._steeringMessages;
	}

	/** Get pending follow-up messages (read-only) */
	getFollowUpMessages(): readonly string[] {
		return this._followUpMessages;
	}

	get resourceLoader(): ResourceLoader {
		return this._resourceLoader;
	}

	/**
	 * Abort current operation and wait for agent to become idle.
	 */
	async abort(): Promise<void> {
		if (this._isAgentRunActive) {
			this._agentRunAbortRequested = true;
		}
		this.abortRetry();
		this.abortCompaction();
		this.abortBranchSummary();
		this.verify.abort();
		if (this._isBeforeSettle) this._abortDuringBeforeSettle = true;
		this.agent.abort();
		await this.waitForIdle();
	}

	async waitForIdle(): Promise<void> {
		if (this.isIdle) {
			return;
		}
		await this._getIdleWaitPromise();
	}

	// =========================================================================
	// Model Management
	// =========================================================================

	private async _emitModelSelect(
		nextModel: Model<any>,
		previousModel: Model<any> | undefined,
		source: "set" | "cycle" | "restore",
	): Promise<void> {
		if (modelsAreEqual(previousModel, nextModel)) return;
		await this._extensionRunner.emit({
			type: "model_select",
			model: nextModel,
			previousModel,
			source,
		});
	}

	/** A reply the session should stick to. Errors and aborts are not replies. */
	private _hasSuccessfulReply(): boolean {
		return this.agent.state.messages.some(
			(message) =>
				message.role === "assistant" && message.stopReason !== "error" && message.stopReason !== "aborted",
		);
	}

	/**
	 * RunKiln keeps one model per session: switching after the first reply would drop the
	 * RunInfra prompt cache. Returns an error message when a switch is not allowed.
	 */
	private _modelSwitchBlockedReason(model: Model<any>): string | undefined {
		const current = this.model;
		if (!current || modelsAreEqual(current, model)) return undefined;
		if (!this._hasSuccessfulReply()) return undefined;
		// Auto mode already switches models per request; leaving it for a manual pick is allowed.
		if (this._autoRouting || this._routedThisSession) return undefined;
		return `This session already uses ${current.id}; RunKiln keeps one model per session. Start a new session (/new) to use ${model.id}.`;
	}

	/**
	 * Set model directly.
	 * Validates that auth is configured and saves to the session transcript.
	 * Persists to global defaults only when options.persist is true.
	 * @throws Error if no auth is configured for the model, or if the session already has a reply.
	 */
	async setModel(model: Model<any>, options: ModelMutationOptions = {}): Promise<void> {
		if (isAutoModel(model)) {
			this.setAutoRouting(true, { ...options, mode: parseAutoMode(model.id) });
			return;
		}
		const blocked = this._modelSwitchBlockedReason(model);
		if (blocked) throw new Error(blocked);
		if (!(await this._modelRuntime.checkAuth(model.provider))) {
			throw new Error(`No API key for ${model.provider}/${model.id}`);
		}

		const previousModel = this.model;
		// A manual pick overrides routing.
		if (this._autoRouting) this._setAutoRouting(false);
		const thinkingLevel = this._getThinkingLevelForModelSwitch(model);
		this.agent.state.model = model;
		this.sessionManager.appendModelChange(model.provider, model.id);
		if (options.persist) {
			this.settingsManager.setDefaultModelAndProvider(model.provider, model.id);
			if (isAutoModel({ id: this.settingsManager.getModelRoles()[this._role] ?? "" })) {
				this.settingsManager.setModelRole(this._role, model.id);
			}
			this._addPersistedDefaultToNonEmptyScope(model);
		}

		// Apply thinking level for the new model.
		// Per-model thinking level overrides take priority over the global default.
		// Model persistence does not implicitly rewrite the global thinking default.
		this._applyThinkingLevel(thinkingLevel);

		await this._emitModelSelect(model, previousModel, "set");
	}

	private _addPersistedDefaultToNonEmptyScope(model: Model<any>): void {
		if (this._scopedModels.length === 0) return;
		if (this._scopedModels.some((scoped) => modelsAreEqual(scoped.model, model))) return;

		this._scopedModels = [...this._scopedModels, { model }];

		const enabledModels = this.settingsManager.getEnabledModels();
		if (!enabledModels?.length) return;

		const modelReference = `${model.provider}/${model.id}`;
		if (enabledModels.some((pattern) => pattern.toLowerCase() === modelReference.toLowerCase())) return;
		this.settingsManager.setEnabledModels([...enabledModels, modelReference]);
	}

	/**
	 * Cycle to next/previous model.
	 * Uses scoped models (from --models flag) if available, otherwise all available models.
	 * @param direction - "forward" (default) or "backward"
	 * @returns The new model info, or undefined if only one model available
	 */
	async cycleModel(
		direction: "forward" | "backward" = "forward",
		options: ModelMutationOptions = {},
	): Promise<ModelCycleResult | undefined> {
		// One model per session: no cycling once the session has a reply (auto mode switches anyway).
		if (this._hasSuccessfulReply() && !this._autoRouting && !this._routedThisSession) return undefined;
		if (this._scopedModels.length > 0) {
			return this._cycleScopedModel(direction, options);
		}
		return this._cycleAvailableModel(direction, options);
	}

	private async _cycleScopedModel(
		direction: "forward" | "backward",
		options: ModelMutationOptions,
	): Promise<ModelCycleResult | undefined> {
		const availableIds = new Set(
			this._modelRuntime.getAvailableSnapshot().map((model) => `${model.provider}\0${model.id}`),
		);
		const scopedModels = this._scopedModels.filter((scoped) =>
			availableIds.has(`${scoped.model.provider}\0${scoped.model.id}`),
		);
		if (scopedModels.length <= 1) return undefined;

		const currentModel = this.selectedModel;
		let currentIndex = scopedModels.findIndex((sm) => modelsAreEqual(sm.model, currentModel));

		if (currentIndex === -1) currentIndex = 0;
		const len = scopedModels.length;
		const nextIndex = direction === "forward" ? (currentIndex + 1) % len : (currentIndex - 1 + len) % len;
		const next = scopedModels[nextIndex];
		if (isAutoModel(next.model)) {
			this.setAutoRouting(true, {
				...options,
				pinnedThinking: next.thinkingLevel,
				mode: parseAutoMode(next.model.id),
			});
			return { model: next.model, thinkingLevel: this.thinkingLevel, isScoped: true };
		}
		if (this._autoRouting) this._setAutoRouting(false);
		const thinkingLevel = this._getThinkingLevelForModelSwitch(next.model, next.thinkingLevel);

		// Apply model
		this.agent.state.model = next.model;
		this.sessionManager.appendModelChange(next.model.provider, next.model.id);
		if (options.persist) {
			this.settingsManager.setDefaultModelAndProvider(next.model.provider, next.model.id);
			this._addPersistedDefaultToNonEmptyScope(next.model);
		}

		// Apply thinking level for the new model.
		// - Explicit scoped model thinking level overrides defaults
		// - Per-model thinking level overrides take priority over the global default
		// setThinkingLevel clamps to model capabilities.
		// Model persistence does not implicitly rewrite the global thinking default.
		this._applyThinkingLevel(thinkingLevel);

		await this._emitModelSelect(next.model, currentModel, "cycle");

		return { model: next.model, thinkingLevel: this.thinkingLevel, isScoped: true };
	}

	private async _cycleAvailableModel(
		direction: "forward" | "backward",
		options: ModelMutationOptions,
	): Promise<ModelCycleResult | undefined> {
		const availableModels = this._modelRuntime.getAvailableSnapshot();
		if (availableModels.length <= 1) return undefined;

		const currentModel = this.selectedModel;
		let currentIndex = availableModels.findIndex((m) => modelsAreEqual(m, currentModel));

		if (currentIndex === -1) currentIndex = 0;
		const len = availableModels.length;
		const nextIndex = direction === "forward" ? (currentIndex + 1) % len : (currentIndex - 1 + len) % len;
		const nextModel = availableModels[nextIndex];
		if (isAutoModel(nextModel)) {
			this.setAutoRouting(true, { ...options, mode: parseAutoMode(nextModel.id) });
			return { model: nextModel, thinkingLevel: this.thinkingLevel, isScoped: false };
		}
		if (this._autoRouting) this._setAutoRouting(false);

		const thinkingLevel = this._getThinkingLevelForModelSwitch(nextModel);
		this.agent.state.model = nextModel;
		this.sessionManager.appendModelChange(nextModel.provider, nextModel.id);
		if (options.persist) {
			this.settingsManager.setDefaultModelAndProvider(nextModel.provider, nextModel.id);
			this._addPersistedDefaultToNonEmptyScope(nextModel);
		}

		// Apply thinking level for the new model.
		// Model persistence does not implicitly rewrite the global thinking default.
		this._applyThinkingLevel(thinkingLevel);

		await this._emitModelSelect(nextModel, currentModel, "cycle");

		return { model: nextModel, thinkingLevel: this.thinkingLevel, isScoped: false };
	}

	// =========================================================================
	// Thinking Level Management
	// =========================================================================

	/**
	 * Set thinking level.
	 * Clamps to model capabilities based on available thinking levels.
	 * Saves the clamped level to the session transcript only if the level actually changes.
	 * Persists the requested level to global defaults only when options.persist is true.
	 */
	setThinkingLevel(level: ThinkingLevel, options: ModelMutationOptions = {}): void {
		// Auto mode: a level the user sets is pinned and overrides the router's choice on every model.
		// Manual mode: it replaces `defaultThinkingLevel` for the rest of the session.
		if (this._autoRouting) this._pinnedThinking = level;
		else this._manualThinking = level;
		this._applyThinkingLevel(level, options);
	}

	/**
	 * Re-apply the default thinking level to the current manual model, after the
	 * `defaultThinkingLevel` or per-model setting changed (for example in /models). Does nothing in
	 * auto mode or when the user set a level this session.
	 */
	applyDefaultThinkingLevel(): void {
		if (this._autoRouting || this._manualThinking !== undefined || !this.model) return;
		this._applyThinkingLevel(this._getThinkingLevelForModelSwitch(this.model));
	}

	/** Set the level on the agent (clamped to the model) without recording it as the user's choice. */
	private _applyThinkingLevel(level: ThinkingLevel, options: ModelMutationOptions = {}): void {
		const availableLevels = this.getAvailableThinkingLevels();
		const effectiveLevel = availableLevels.includes(level) ? level : this._clampThinkingLevel(level, availableLevels);

		// Only persist if actually changing
		const previousLevel = this.agent.state.thinkingLevel;
		const isChanging = effectiveLevel !== previousLevel;

		this.agent.state.thinkingLevel = effectiveLevel;

		if (options.persist) {
			this.settingsManager.setDefaultThinkingLevel(level);
		}

		if (isChanging) {
			this.sessionManager.appendThinkingLevelChange(effectiveLevel);
			this._emit({ type: "thinking_level_changed", level: effectiveLevel });
			void this._extensionRunner.emit({
				type: "thinking_level_select",
				level: effectiveLevel,
				previousLevel,
			});
		}
	}

	/**
	 * Cycle to next thinking level.
	 * @returns New level, or undefined if model doesn't support thinking
	 */
	cycleThinkingLevel(options: ModelMutationOptions = {}): ThinkingLevel | "auto" | undefined {
		if (this._autoRouting) {
			// auto → each level of the current model → auto
			const levels = this.getAvailableThinkingLevels();
			if (this._pinnedThinking === undefined) {
				this.setThinkingLevel(levels[0] ?? "off", options);
				return this._pinnedThinking;
			}
			const index = levels.indexOf(this.thinkingLevel);
			if (index === -1 || index === levels.length - 1) {
				this.setThinkingAuto();
				return "auto";
			}
			this.setThinkingLevel(levels[index + 1], options);
			return levels[index + 1];
		}
		if (!this.supportsThinking()) return undefined;

		const levels = this.getAvailableThinkingLevels();
		const currentIndex = levels.indexOf(this.thinkingLevel);
		const nextIndex = (currentIndex + 1) % levels.length;
		const nextLevel = levels[nextIndex];

		this.setThinkingLevel(nextLevel, options);
		return nextLevel;
	}

	/**
	 * Get available thinking levels for current model.
	 * The provider will clamp to what the specific model supports internally.
	 */
	getAvailableThinkingLevels(): ThinkingLevel[] {
		if (!this.model) return [...THINKING_LEVEL_OPTIONS];
		return getSupportedThinkingLevels(this.model) as ThinkingLevel[];
	}

	/**
	 * Check if current model supports thinking/reasoning.
	 */
	supportsThinking(): boolean {
		return !!this.model?.reasoning;
	}

	private _getThinkingLevelForModelSwitch(targetModel?: Model<any>, explicitLevel?: ThinkingLevel): ThinkingLevel {
		if (explicitLevel !== undefined) {
			return explicitLevel;
		}
		// Per-model default takes priority when switching to a model that has one
		if (targetModel) {
			const perModel = this.settingsManager.getModelThinkingLevel(targetModel.provider, targetModel.id);
			if (perModel !== undefined) {
				return perModel;
			}
		}
		return (
			this._manualThinking ??
			this.settingsManager.getDefaultThinkingLevel() ??
			(targetModel ? harnessThinkingLevel(targetModel) : undefined) ??
			this.thinkingLevel ??
			DEFAULT_THINKING_LEVEL
		);
	}

	private _clampThinkingLevel(level: ThinkingLevel, _availableLevels: ThinkingLevel[]): ThinkingLevel {
		return this.model ? (clampThinkingLevel(this.model, level) as ThinkingLevel) : "off";
	}

	// =========================================================================
	// Queue Mode Management
	// =========================================================================

	private syncQueueModesFromSettings(): void {
		this.agent.steeringMode = this.settingsManager.getSteeringMode();
		this.agent.followUpMode = this.settingsManager.getFollowUpMode();
	}

	/**
	 * Set steering message mode.
	 * Saves to settings.
	 */
	setSteeringMode(mode: "all" | "one-at-a-time"): void {
		this.agent.steeringMode = mode;
		this.settingsManager.setSteeringMode(mode);
	}

	/**
	 * Set follow-up message mode.
	 * Saves to settings.
	 */
	setFollowUpMode(mode: "all" | "one-at-a-time"): void {
		this.agent.followUpMode = mode;
		this.settingsManager.setFollowUpMode(mode);
	}

	// =========================================================================
	// Compaction
	// =========================================================================

	/** Generate RunKiln's built-in compaction summary for manual and automatic compaction. */
	private async _runDefaultCompaction(
		preparation: CompactionPreparation,
		model: Model<any>,
		customInstructions: string | undefined,
		signal: AbortSignal,
		reason: "manual" | "threshold" | "overflow",
	): Promise<CompactionResult> {
		// RunInfra: summarize on the session's own warm prefix when it is still cached (same model,
		// same x-session-id, byte-identical prompt); the summary input then bills at the cached price.
		const warm = this.settingsManager.getCompactionReuseSessionPrefix()
			? warmTurnRequest(this.agent, this.model)
			: undefined;
		if (warm && this.model?.provider === RUNINFRA_PROVIDER_ID && !signal.aborted) {
			try {
				const sessionModel = this.model;
				const request = await this._getSummarizationRequestAuth(
					sessionModel,
					signal,
					clampThinkingLevel(sessionModel, "off") as ThinkingLevel,
				);
				return await compactOnSessionPrefix(
					preparation,
					// Images out: the summary needs the text, and a session stuck on 413 must still compact.
					{ ...warm.context, messages: stripImages(warm.context.messages) },
					request.model,
					request.apiKey,
					request.headers,
					customInstructions,
					signal,
					request.thinkingLevel,
					this.agent.streamFunction,
					request.env,
					this.settingsManager.getRetrySettings(),
					this._summarizationRetryCallbacks({ source: "compaction", reason }),
					warm.sessionId ?? this.sessionId,
				);
			} catch (error) {
				if (signal.aborted) throw error;
				// Fall back to the standalone summary on the chore model.
			}
		}
		// A side task: the chore model summarizes (see _resolveChoreModel), not the session model.
		return this._withChoreModel("compaction", signal, async (choreModel, choreThinking) => {
			// Resolve the request only when RunKiln summarizes itself: routing may call models or fail.
			const request = await this._getSummarizationRequestAuth(choreModel, signal, choreThinking);
			return compact(
				preparation,
				request.model,
				request.apiKey,
				request.headers,
				customInstructions,
				signal,
				request.thinkingLevel,
				this.agent.streamFunction,
				request.env,
				this.settingsManager.getRetrySettings(),
				this._summarizationRetryCallbacks({ source: "compaction", reason }),
				undefined, // sessionId
			);
		});
	}

	private _clearManualCompactionState(): void {
		this._compactionAbortController = undefined;
		this._resolveIdleWaitIfIdle();
	}

	/**
	 * Manually compact the session context.
	 *
	 * This is the manual entry point used by `/compact`, RPC, and extensions. It is
	 * separate from automatic threshold/overflow compaction, which enters through
	 * `_checkCompaction()` and `_runAutoCompaction()`. After preparation and the
	 * `session_before_compact` hook, both paths call the lower-level `compact()`
	 * function imported from `./compaction/index.ts`, unless the hook cancels or
	 * supplies a custom result.
	 *
	 * Aborts the current agent operation first. Manual compaction never retries or
	 * continues the interrupted agent turn.
	 *
	 * @param customInstructions Optional instructions for the compaction summary
	 */
	async compact(customInstructions?: string): Promise<CompactionResult> {
		await this.abort();
		this._compactionAbortController = new AbortController();
		this._emit({ type: "compaction_start", reason: "manual" });
		let fromExtension = false;
		let cancelledByExtension = false;

		try {
			const model = this.model;
			if (!model) {
				throw new Error(formatNoModelSelectedMessage());
			}

			const settings = this.settingsManager.getCompactionSettings(model);
			const pathEntries = this.sessionManager.getBranch();

			const preparation = prepareCompaction(pathEntries, settings);
			if (!preparation) {
				// Check why we can't compact
				const lastEntry = pathEntries[pathEntries.length - 1];
				if (lastEntry?.type === "compaction") {
					throw new Error("Already compacted");
				}
				throw new Error("Nothing to compact (session too small)");
			}

			let extensionCompaction: CompactionResult | undefined;

			if (this._extensionRunner.hasHandlers("session_before_compact")) {
				const result = (await this._extensionRunner.emit({
					type: "session_before_compact",
					preparation,
					branchEntries: pathEntries,
					customInstructions,
					reason: "manual",
					willRetry: false,
					signal: this._compactionAbortController.signal,
				})) as SessionBeforeCompactResult | undefined;

				if (result?.cancel) {
					cancelledByExtension = true;
					throw new Error("Compaction cancelled");
				}

				if (result?.compaction) {
					extensionCompaction = result.compaction;
					fromExtension = true;
				}
			}

			let summary: string;
			let firstKeptEntryId: string;
			let tokensBefore: number;
			let usage: Usage | undefined;
			let details: unknown;

			if (extensionCompaction) {
				// Extension provided compaction content
				summary = extensionCompaction.summary;
				firstKeptEntryId = extensionCompaction.firstKeptEntryId;
				tokensBefore = extensionCompaction.tokensBefore;
				usage = extensionCompaction.usage;
				details = extensionCompaction.details;
			} else {
				// Shared default summary generator, also used by automatic compaction.
				const result = await this._runDefaultCompaction(
					preparation,
					model,
					customInstructions,
					this._compactionAbortController.signal,
					"manual",
				);
				summary = result.summary;
				firstKeptEntryId = result.firstKeptEntryId;
				tokensBefore = result.tokensBefore;
				usage = result.usage;
				details = result.details;
			}

			if (this._compactionAbortController.signal.aborted) {
				throw new Error("Compaction cancelled");
			}

			this.sessionManager.appendCompaction(summary, firstKeptEntryId, tokensBefore, details, fromExtension, usage);
			const newEntries = this.sessionManager.getEntries();
			this._refreshFinalizedContext();
			const estimatedTokensAfter = estimateMessagesTokens(this.sessionManager.buildSessionProjection().messages);

			// Get the saved compaction entry for the extension event
			const savedCompactionEntry = newEntries.find((e) => e.type === "compaction" && e.summary === summary) as
				| CompactionEntry
				| undefined;

			if (this._extensionRunner && savedCompactionEntry) {
				await this._extensionRunner.emit({
					type: "session_compact",
					compactionEntry: savedCompactionEntry,
					fromExtension,
					reason: "manual",
					willRetry: false,
				});
			}

			const compactionResult: CompactionResult = {
				summary,
				firstKeptEntryId,
				tokensBefore,
				estimatedTokensAfter,
				usage,
				details,
			};
			// compaction_end listeners may submit queued prompts, so expose idle state before notifying them.
			this._clearManualCompactionState();
			this._emit({
				type: "compaction_end",
				reason: "manual",
				result: compactionResult,
				aborted: false,
				willRetry: false,
			});
			return compactionResult;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const aborted = this._compactionAbortController.signal.aborted || cancelledByExtension;
			const errorMessage = aborted ? undefined : `Compaction failed: ${message}`;
			this._clearManualCompactionState();
			this._emit({
				type: "compaction_end",
				reason: "manual",
				result: undefined,
				aborted,
				willRetry: false,
				errorMessage,
			});
			await this._emitSessionCompactFailed({
				reason: "manual",
				errorMessage,
				aborted,
				willRetry: false,
				fromExtension,
			});
			throw error;
		} finally {
			this._clearManualCompactionState();
		}
	}

	/**
	 * Cancel in-progress compaction (manual or auto).
	 */
	abortCompaction(): void {
		this._compactionAbortController?.abort();
		this._autoCompactionAbortController?.abort();
	}

	/**
	 * Cancel in-progress branch summarization.
	 */
	abortBranchSummary(): void {
		this._branchSummaryAbortController?.abort();
	}

	/**
	 * Dispatch automatic compaction after `agent_end` or before prompt submission.
	 * Manual compaction does not call this method; it enters through `compact()`.
	 *
	 * Automatic cases:
	 * 1. Overflow with retry: a context-overflow error or recoverable length stop;
	 *    remove the failed assistant message, compact, and retry the turn once.
	 * 2. Overflow without retry: a successful response exceeded the configured
	 *    context window; compact but preserve the completed response.
	 * 3. Threshold without retry: valid or estimated context usage crossed the
	 *    configured threshold; compact without retrying the completed response.
	 *
	 * Each case calls `_runAutoCompaction()`. After preparation and the
	 * `session_before_compact` hook, that method calls the lower-level `compact()`
	 * function imported from `./compaction/index.ts`, unless the hook cancels or
	 * supplies a custom result.
	 *
	 * @param assistantMessage The assistant message to check
	 * @param skipAbortedCheck If false, include aborted messages (for pre-prompt check). Default: true
	 * @returns Whether the post-run loop should call `agent.continue()` for overflow recovery or queued messages
	 */
	/**
	 * Idle compaction (runkiln/idle-compaction.ts): before a new user turn, when the session sat idle longer than the
	 * cache TTL of the model that served it and the context is large, compact first. That turn pays full price anyway.
	 */
	private async _maybeIdleCompact(lastAssistant: AssistantMessage): Promise<void> {
		const settings = this.settingsManager.getIdleCompactionSettings();
		const model = this._modelForMessage(lastAssistant) ?? this.model;
		if (!settings.enabled || !model) return;
		const branch = this.sessionManager.getBranch();
		const contextTokens = estimateProjectedContextTokens(this.sessionManager.buildSessionProjection(), branch).tokens;
		const ttlMs = sessionIdleTtlMs(model);
		const decision = idleCompactionDecision({
			enabled: true,
			now: Date.now(),
			lastActivityAt: lastCacheActivityAt(branch as never),
			ttlMs,
			contextTokens,
			minTokens: settings.minTokens,
		});
		if (!decision.due) return;
		this._emit({ type: "idle_compaction", idleMs: decision.idleMs, contextTokens, ttlMs });
		await this._runAutoCompaction("threshold", false);
	}

	private async _checkCompaction(
		assistantMessage: AssistantMessage,
		skipAbortedCheck = true,
		toolResults: AgentMessage[] = [],
	): Promise<boolean> {
		const settings = this.settingsManager.getCompactionSettings(this.model);
		if (!settings.enabled) return false;

		// Skip if message was aborted (user cancelled) - unless skipAbortedCheck is false
		if (skipAbortedCheck && assistantMessage.stopReason === "aborted") return false;

		// Skip overflow check if the message came from a different model.
		// This handles the case where user switched from a smaller-context model (e.g. opus)
		// to a larger-context model (e.g. codex) - the overflow error from the old model
		// shouldn't trigger compaction for the new model. Under a virtual selection, the
		// physical model that produced the message supplies the limits.
		const messageModel = this._modelForMessage(assistantMessage);
		const sameModel = messageModel !== undefined;
		const contextWindow = (messageModel ?? this.model)?.contextWindow ?? 0;

		// Skip compaction checks if this assistant message is older than the latest
		// compaction boundary. This prevents a stale pre-compaction usage/error
		// from retriggering compaction on the first prompt after compaction.
		const compactionEntry = getLatestCompactionEntry(this.sessionManager.getBranch());
		const assistantIsFromBeforeCompaction =
			compactionEntry !== null && assistantMessage.timestamp <= new Date(compactionEntry.timestamp).getTime();
		if (assistantIsFromBeforeCompaction) {
			return false;
		}

		// Automatic cases 1 and 2: context overflow.
		// A length stop is recoverable when output ended below the model's original desired limit,
		// independent of the configured context size or any context-clamped provider request limit.
		const currentProjection = this.sessionManager.buildSessionProjection();
		const assistantEntryId = this._findPersistedMessageEntryId(assistantMessage);
		const assistantIsProjected =
			assistantEntryId === undefined ||
			currentProjection.entries.some(
				(entry) =>
					entry.sourceEntry.id === assistantEntryId &&
					entry.messages.some((message) => message.role === "assistant"),
			);
		const branch = this.sessionManager.getBranch();
		const assistantIndex = assistantEntryId ? branch.findIndex((entry) => entry.id === assistantEntryId) : -1;
		const entriesAfterAssistant = assistantIndex >= 0 ? branch.slice(assistantIndex + 1) : [];
		const hasPostAssistantContextEdit = entriesAfterAssistant.some((entry) => entry.type === "context_edit");
		const latestAssistantEdit = entriesAfterAssistant
			.filter(
				(entry): entry is ContextEditEntry => entry.type === "context_edit" && entry.targetId === assistantEntryId,
			)
			.at(-1);
		const assistantRetainedForExplicitRecovery =
			assistantEntryId === undefined ||
			(!entriesAfterAssistant.some((entry) => entry.type === "compaction") &&
				latestAssistantEdit?.replacement !== null);
		const assistantUsageMatchesProjection = assistantIsProjected && !hasPostAssistantContextEdit;
		const explicitOverflow = assistantMessage.stopReason === "error" && isContextOverflow(assistantMessage);
		const contextOverflow =
			sameModel &&
			((explicitOverflow && assistantRetainedForExplicitRecovery) ||
				(assistantUsageMatchesProjection && isContextOverflow(assistantMessage, contextWindow)));
		const recoverableLength =
			sameModel && assistantIsProjected && isRecoverableLength(assistantMessage, messageModel.maxTokens);
		if (contextOverflow || recoverableLength) {
			const willRetry = assistantMessage.stopReason !== "stop";

			// Case 2: the response completed successfully. Compact, but do not retry because
			// agent.continue() cannot continue from a completed assistant response.
			if (!willRetry) {
				return await this._runAutoCompaction("overflow", false);
			}

			if (this._overflowRecoveryAttempted) {
				const errorMessage = contextOverflow
					? "Context overflow recovery failed after one compact-and-retry attempt. Try reducing context or switching to a larger-context model."
					: "Truncated response recovery failed after one compact-and-retry attempt.";
				this._emit({
					type: "compaction_end",
					reason: "overflow",
					result: undefined,
					aborted: false,
					willRetry: false,
					errorMessage,
				});
				await this._emitSessionCompactFailed({
					reason: "overflow",
					errorMessage,
					aborted: false,
					willRetry: false,
					fromExtension: false,
				});
				return false;
			}

			// Persistently omit the selected final attempt before post-run recovery compaction.
			this._overflowRecoveryAttempted = true;
			this._omitRecoveryAttempt(assistantMessage, toolResults);
			const retry = await this._runAutoCompaction("overflow", willRetry);
			if (retry) this._failedResponse = assistantMessage;
			return retry;
		}

		// Case 3: threshold compaction without retry.
		// For error messages or all-zero usage messages, estimate from the last valid response.
		// This ensures sessions that hit persistent API errors (e.g. 529) or malformed zero-usage
		// responses can still compact and do not reset context accounting.
		let contextTokens: number;
		const projection = currentProjection;
		const hasContextEdits = projection.entries.some((entry) => entry.sourceEntry.type === "context_edit");
		const directContextTokens = assistantMessage.usage ? calculateContextTokens(assistantMessage.usage) : 0;
		if (hasContextEdits) {
			contextTokens = estimateProjectedContextTokens(projection, branch).tokens;
		} else if (assistantMessage.stopReason === "error" || directContextTokens === 0) {
			const messages = this.agent.state.messages;
			const estimate = estimateContextTokens(messages);
			// Without provider usage, estimate.tokens is the pure message-size estimate.
			// Only usage-backed estimates need the stale pre-compaction check.
			if (estimate.lastUsageIndex !== null) {
				// Verify the usage source is post-compaction. Kept pre-compaction messages
				// have stale usage reflecting the old (larger) context and would falsely
				// trigger compaction right after one just finished.
				const usageMsg = messages[estimate.lastUsageIndex];
				if (
					compactionEntry &&
					usageMsg.role === "assistant" &&
					(usageMsg as AssistantMessage).timestamp <= new Date(compactionEntry.timestamp).getTime()
				) {
					return false;
				}
			}
			contextTokens = estimate.tokens;
		} else {
			contextTokens = directContextTokens;
		}
		if (shouldCompact(contextTokens, contextWindow, settings, messageModel ?? this.model)) {
			return await this._runAutoCompaction("threshold", false);
		}
		return false;
	}

	/**
	 * Execute threshold or overflow compaction. Manual compaction uses
	 * `AgentSession.compact()` instead. Both paths call the lower-level `compact()`
	 * function imported from `./compaction/index.ts` after preparation and extension
	 * interception.
	 *
	 * @param reason Automatic trigger selected by `_checkCompaction()`
	 * @param willRetry Whether to continue the interrupted turn after overflow compaction
	 * @returns Whether the post-run loop should call `agent.continue()`
	 */
	private async _runAutoCompaction(reason: "overflow" | "threshold", willRetry: boolean): Promise<boolean> {
		const model = this.model;
		const settings = this.settingsManager.getCompactionSettings(model);
		let abortController: AbortController | undefined;
		let started = false;
		let fromExtension = false;
		let cancelledByExtension = false;

		try {
			if (!model) {
				return false;
			}

			const pathEntries = this.sessionManager.getBranch();
			const preparation = prepareCompaction(pathEntries, settings);
			if (!preparation) {
				return false;
			}

			abortController = new AbortController();
			this._autoCompactionAbortController = abortController;
			started = true;
			this._emit({ type: "compaction_start", reason });
			abortController.signal.throwIfAborted();

			let extensionCompaction: CompactionResult | undefined;

			if (this._extensionRunner.hasHandlers("session_before_compact")) {
				const extensionResult = (await this._extensionRunner.emit({
					type: "session_before_compact",
					preparation,
					branchEntries: pathEntries,
					customInstructions: undefined,
					reason,
					willRetry,
					signal: abortController.signal,
				})) as SessionBeforeCompactResult | undefined;

				if (extensionResult?.cancel) {
					cancelledByExtension = true;
					throw new Error("Compaction cancelled");
				}

				if (extensionResult?.compaction) {
					extensionCompaction = extensionResult.compaction;
					fromExtension = true;
				}
			}
			abortController.signal.throwIfAborted();

			let summary: string;
			let firstKeptEntryId: string;
			let tokensBefore: number;
			let usage: Usage | undefined;
			let details: unknown;

			if (extensionCompaction) {
				// Extension provided compaction content
				summary = extensionCompaction.summary;
				firstKeptEntryId = extensionCompaction.firstKeptEntryId;
				tokensBefore = extensionCompaction.tokensBefore;
				usage = extensionCompaction.usage;
				details = extensionCompaction.details;
			} else {
				// Shared default summary generator, also used by manual compaction.
				const compactResult = await this._runDefaultCompaction(
					preparation,
					model,
					undefined,
					abortController.signal,
					reason,
				);
				summary = compactResult.summary;
				firstKeptEntryId = compactResult.firstKeptEntryId;
				tokensBefore = compactResult.tokensBefore;
				usage = compactResult.usage;
				details = compactResult.details;
			}
			abortController.signal.throwIfAborted();

			this.sessionManager.appendCompaction(summary, firstKeptEntryId, tokensBefore, details, fromExtension, usage);
			const newEntries = this.sessionManager.getEntries();
			this._refreshFinalizedContext();
			const estimatedTokensAfter = estimateMessagesTokens(this.sessionManager.buildSessionProjection().messages);

			// Get the saved compaction entry for the extension event
			const savedCompactionEntry = newEntries.find((e) => e.type === "compaction" && e.summary === summary) as
				| CompactionEntry
				| undefined;

			if (this._extensionRunner && savedCompactionEntry) {
				await this._extensionRunner.emit({
					type: "session_compact",
					compactionEntry: savedCompactionEntry,
					fromExtension,
					reason,
					willRetry,
				});
			}

			const result: CompactionResult = {
				summary,
				firstKeptEntryId,
				tokensBefore,
				estimatedTokensAfter,
				usage,
				details,
			};
			this._emit({ type: "compaction_end", reason, result, aborted: false, willRetry });

			if (willRetry) return true;

			// Auto-compaction can complete while follow-up/steering/custom messages are waiting.
			// Continue once so queued messages are delivered.
			return this.agent.hasQueuedMessages();
		} catch (error) {
			const message = error instanceof Error ? error.message : "compaction failed";
			const aborted = abortController?.signal.aborted === true || cancelledByExtension;
			if (started) {
				const errorMessage = aborted
					? undefined
					: reason === "overflow"
						? `Context overflow recovery failed: ${message}`
						: `Auto-compaction failed: ${message}`;
				this._emit({
					type: "compaction_end",
					reason,
					result: undefined,
					aborted,
					willRetry: false,
					errorMessage,
				});
				await this._emitSessionCompactFailed({
					reason,
					errorMessage,
					aborted,
					willRetry: false,
					fromExtension,
				});
			}
			return false;
		} finally {
			if (this._autoCompactionAbortController === abortController) {
				this._autoCompactionAbortController = undefined;
			}
			this._resolveIdleWaitIfIdle();
		}
	}

	/**
	 * Toggle auto-compaction setting.
	 */
	setAutoCompactionEnabled(enabled: boolean): void {
		this.settingsManager.setCompactionEnabled(enabled);
	}

	/** Whether auto-compaction is enabled */
	get autoCompactionEnabled(): boolean {
		return this.settingsManager.getCompactionEnabled();
	}

	async bindExtensions(bindings: ExtensionBindings): Promise<void> {
		if (bindings.uiContext !== undefined) {
			this._extensionUIContext = bindings.uiContext;
		}
		if (bindings.mode !== undefined) {
			this._extensionMode = bindings.mode;
		}
		if (bindings.commandContextActions !== undefined) {
			this._extensionCommandContextActions = bindings.commandContextActions;
		}
		if (bindings.abortHandler !== undefined) {
			this._extensionAbortHandler = bindings.abortHandler;
		}
		if (bindings.shutdownHandler !== undefined) {
			this._extensionShutdownHandler = bindings.shutdownHandler;
		}
		if (bindings.onError !== undefined) {
			this._extensionErrorListener = bindings.onError;
		}

		this._applyExtensionBindings(this._extensionRunner);
		await this._extensionRunner.emit(this._sessionStartEvent);
		await this.extendResourcesFromExtensions(this._sessionStartEvent.reason === "reload" ? "reload" : "startup");
	}

	private async extendResourcesFromExtensions(reason: "startup" | "reload"): Promise<void> {
		if (!this._extensionRunner.hasHandlers("resources_discover")) {
			return;
		}

		const { skillPaths, promptPaths } = await this._extensionRunner.emitResourcesDiscover(this._cwd, reason);

		if (skillPaths.length === 0 && promptPaths.length === 0) {
			return;
		}

		const extensionPaths: ResourceExtensionPaths = {
			skillPaths: this.buildExtensionResourcePaths(skillPaths),
			promptPaths: this.buildExtensionResourcePaths(promptPaths),
		};

		this._resourceLoader.extendResources(extensionPaths);
		this._rebuildSystemPrompt(this.getActiveToolNames());
	}

	private buildExtensionResourcePaths(entries: Array<{ path: string; extensionPath: string }>): Array<{
		path: string;
		metadata: { source: string; scope: "temporary"; origin: "top-level"; baseDir?: string };
	}> {
		return entries.map((entry) => {
			const source = this.getExtensionSourceLabel(entry.extensionPath);
			const baseDir = isSyntheticPath(entry.extensionPath) ? undefined : dirname(entry.extensionPath);
			return {
				path: entry.path,
				metadata: {
					source,
					scope: "temporary",
					origin: "top-level",
					baseDir,
				},
			};
		});
	}

	private getExtensionSourceLabel(extensionPath: string): string {
		if (isSyntheticPath(extensionPath)) {
			return `extension:${extensionPath.replace(/[<>]/g, "")}`;
		}
		const base = basename(extensionPath);
		const name = base.replace(/\.(ts|js)$/, "");
		return `extension:${name}`;
	}

	private _applyExtensionBindings(runner: ExtensionRunner): void {
		runner.setUIContext(this._extensionUIContext, this._extensionMode);
		runner.bindCommandContext(this._extensionCommandContextActions);

		this._extensionErrorUnsubscriber?.();
		this._extensionErrorUnsubscriber = this._extensionErrorListener
			? runner.onError(this._extensionErrorListener)
			: undefined;
	}

	private _refreshCurrentModelFromRegistry(): void {
		const currentModel = this.model;
		if (!currentModel) {
			return;
		}

		const refreshedModel = this._modelRuntime.getModel(currentModel.provider, currentModel.id);
		if (!refreshedModel || refreshedModel === currentModel) {
			return;
		}

		this.agent.state.model = refreshedModel;
	}

	private _bindExtensionCore(runner: ExtensionRunner): void {
		const getCommands = (): SlashCommandInfo[] => {
			const extensionCommands: SlashCommandInfo[] = runner.getRegisteredCommands().map((command) => ({
				name: command.invocationName,
				description: command.description,
				source: "extension",
				sourceInfo: command.sourceInfo,
			}));

			const templates: SlashCommandInfo[] = this.promptTemplates.map((template) => ({
				name: template.name,
				description: template.description,
				source: "prompt",
				sourceInfo: template.sourceInfo,
			}));

			const skills: SlashCommandInfo[] = this._resourceLoader.getSkills().skills.map((skill) => ({
				name: `skill:${skill.name}`,
				description: skill.description,
				source: "skill",
				sourceInfo: skill.sourceInfo,
			}));

			return [...extensionCommands, ...templates, ...skills];
		};

		runner.bindCore(
			{
				sendMessage: (message, options) => {
					this.sendCustomMessage(message, options).catch((err) => {
						runner.emitError({
							extensionPath: "<runtime>",
							event: "send_message",
							error: err instanceof Error ? err.message : String(err),
						});
					});
				},
				sendUserMessage: (content, options) => {
					this.sendUserMessage(content, options).catch((err) => {
						runner.emitError({
							extensionPath: "<runtime>",
							event: "send_user_message",
							error: err instanceof Error ? err.message : String(err),
						});
					});
				},
				appendEntry: (customType, data) => {
					const entryId = this.sessionManager.appendCustomEntry(customType, data);
					const entry = this.sessionManager.getEntry(entryId);
					if (entry) {
						this._emit({ type: "entry_appended", entry });
					}
				},
				setSessionName: (name) => {
					this.setSessionName(name);
				},
				getSessionName: () => {
					return this.sessionManager.getSessionName();
				},
				setLabel: (entryId, label) => {
					this.sessionManager.appendLabelChange(entryId, label);
				},
				getActiveTools: () => this.getActiveToolNames(),
				getAllTools: () => this.getAllTools(),
				getSettings: () => this.settingsManager.getSettings(),
				setActiveTools: (toolNames) => this.setActiveToolsByName(toolNames),
				refreshTools: () => this._refreshToolRegistry(),
				getCommands,
				setModel: async (model) => {
					if (!this._modelRuntime.hasConfiguredAuth(model.provider)) return false;
					await this.setModel(model);
					return true;
				},
				getThinkingLevel: () => this.thinkingLevel,
				setThinkingLevel: (level) => this.setThinkingLevel(level),
			},
			{
				getModel: () => this.model,
				getScopedModels: () => this._scopedModels,
				isIdle: () => this.isIdle,
				isProjectTrusted: () => this.settingsManager.isProjectTrusted(),
				getSignal: () => this.agent.signal,
				abort: () => {
					if (this._extensionAbortHandler) {
						this._extensionAbortHandler();
						return;
					}
					void this.abort();
				},
				hasPendingMessages: () => this.pendingMessageCount > 0,
				shutdown: () => {
					this._extensionShutdownHandler?.();
				},
				getContextUsage: () => this.getContextUsage(),
				compact: (options) => {
					void (async () => {
						try {
							const result = await this.compact(options?.customInstructions);
							options?.onComplete?.(result);
						} catch (error) {
							const err = error instanceof Error ? error : new Error(String(error));
							options?.onError?.(err);
						}
					})();
				},
				getSystemPrompt: () => this.systemPrompt,
				getSystemPromptOptions: () => this._baseSystemPromptOptions,
				executeTool: (callerId, name, args, options) => this._executeNestedToolCall(callerId, name, args, options),
				getCallableTools: () => this._getCallableTools(),
			},
		);
	}

	private _refreshToolRegistry(options?: { activeToolNames?: string[]; includeAllExtensionTools?: boolean }): void {
		// Tools that were already activated on registration. A tool whose exposure changes to
		// `direct` or `model-only` (for example from `hidden`) is activated like a new tool.
		const previousActivatedOnRegistration = new Set(
			[...this._toolRegistry.keys()].filter((name) => this._isActivatedOnRegistration(name)),
		);
		const previousActiveToolNames = this.getActiveToolNames();
		const allowedTools = this._allowedTools;

		const registeredTools = this._extensionRunner.getAllRegisteredTools();
		const allCustomTools = [
			...registeredTools,
			...this._customTools.map((definition) => ({
				definition,
				sourceInfo: createSyntheticSourceInfo(`<sdk:${definition.name}>`, { source: "sdk" }),
			})),
		].filter((tool) => this._isAllowedTool(tool.definition.name));
		const definitionRegistry = new Map<string, ToolDefinitionEntry>(
			Array.from(this._baseToolDefinitions.entries())
				.filter(([name]) => this._isAllowedTool(name))
				.map(([name, definition]) => [
					name,
					{
						definition,
						sourceInfo: createSyntheticSourceInfo(`${BUILTIN_PATH_PREFIX}${name}`, { source: "builtin" }),
					},
				]),
		);
		for (const tool of allCustomTools) {
			definitionRegistry.set(tool.definition.name, {
				definition: tool.definition,
				sourceInfo: tool.sourceInfo,
			});
		}
		this._toolDefinitions = definitionRegistry;
		this._toolPromptSnippets = new Map(
			Array.from(definitionRegistry.values())
				.map(({ definition }) => {
					const snippet = this._normalizePromptSnippet(definition.promptSnippet);
					return snippet ? ([definition.name, snippet] as const) : undefined;
				})
				.filter((entry): entry is readonly [string, string] => entry !== undefined),
		);
		this._toolPromptGuidelines = new Map(
			Array.from(definitionRegistry.values())
				.map(({ definition }) => {
					const guidelines = this._normalizePromptGuidelines(definition.promptGuidelines);
					return guidelines.length > 0 ? ([definition.name, guidelines] as const) : undefined;
				})
				.filter((entry): entry is readonly [string, string[]] => entry !== undefined),
		);
		const runner = this._extensionRunner;
		const wrappedExtensionTools = wrapRegisteredTools(allCustomTools, runner);
		const wrappedBuiltInTools = wrapRegisteredTools(
			Array.from(this._baseToolDefinitions.values())
				.filter((definition) => this._isAllowedTool(definition.name))
				.map((definition) => ({
					definition,
					sourceInfo: createSyntheticSourceInfo(`${BUILTIN_PATH_PREFIX}${definition.name}`, {
						source: "builtin",
					}),
				})),
			runner,
		);

		const toolRegistry = new Map(wrappedBuiltInTools.map((tool) => [tool.name, tool]));
		for (const tool of wrappedExtensionTools as AgentTool[]) {
			toolRegistry.set(tool.name, tool);
		}
		this._toolRegistry = toolRegistry;

		const nextActiveToolNames = (
			options?.activeToolNames ? [...options.activeToolNames] : [...previousActiveToolNames]
		).filter((name) => this._isAllowedTool(name));

		if (allowedTools) {
			for (const toolName of this._toolRegistry.keys()) {
				// Naming or matching a tool activates it even when it is not active by default. MCP tools
				// kept registered without being named stay inactive.
				if (allowedTools(toolName) && this._isDeclarable(toolName)) {
					nextActiveToolNames.push(toolName);
				}
			}
		} else if (options?.includeAllExtensionTools) {
			for (const tool of wrappedExtensionTools) {
				if (this._isActivatedOnRegistration(tool.name)) nextActiveToolNames.push(tool.name);
			}
		} else if (!options?.activeToolNames) {
			for (const toolName of this._toolRegistry.keys()) {
				if (!previousActivatedOnRegistration.has(toolName) && this._isActivatedOnRegistration(toolName)) {
					nextActiveToolNames.push(toolName);
				}
			}
		}
		// Pending tools that are registered now become active.
		nextActiveToolNames.push(...this._pendingToolNames);

		this._setActiveTools([...new Set(nextActiveToolNames)]);
	}

	/** Whether activating the tool declares it to the model. */
	private _isDeclarable(name: string): boolean {
		const exposure = this._getToolExposure(name);
		return exposure === "direct" || exposure === "model-only";
	}

	/** Whether registering the tool activates it, which declares it to the model. */
	private _isActivatedOnRegistration(name: string): boolean {
		return this._isDeclarable(name) && this._toolDefinitions.get(name)?.definition.defaultActive !== false;
	}

	private _buildRuntime(options: {
		activeToolNames?: string[];
		flagValues?: Map<string, boolean | string>;
		includeAllExtensionTools?: boolean;
	}): void {
		const autoResizeImages = this.settingsManager.getImageAutoResize();
		const shellCommandPrefix = this.settingsManager.getShellCommandPrefix();
		const shellPath = this.settingsManager.getShellPath();
		const baseToolDefinitions = this._baseToolsOverride
			? Object.fromEntries(
					Object.entries(this._baseToolsOverride).map(([name, tool]) => [
						name,
						createToolDefinitionFromAgentTool(tool),
					]),
				)
			: createAllToolDefinitions(this._cwd, {
					read: { autoResizeImages },
					bash: {
						commandPrefix: shellCommandPrefix,
						shellPath,
						jobs: this._jobs,
						autoBackgroundSeconds: this._autoBackgroundSeconds(),
					},
					edit: {
						postEdit: this._postEdit,
						repair: (prompt, signal) => this._runEditRepairChore(prompt, signal),
						autoRepair: () => this.settingsManager.getEditAutoRepair(),
						currentModel: () => this.agent.state.model?.id,
					},
					write: { postEdit: this._postEdit, currentModel: () => this.agent.state.model?.id },
				});

		this._baseToolDefinitions = new Map(
			Object.entries(baseToolDefinitions).map(([name, tool]) => [name, tool as ToolDefinition]),
		);
		if (!this._baseToolsOverride) {
			// The todo tool: built in, activated by _syncTodoTool (setting todo.enabled).
			this._baseToolDefinitions.set(TODO_TOOL_NAME, createTodoToolDefinition() as unknown as ToolDefinition);
			this._baseToolDefinitions.set(
				BASH_OUTPUT_TOOL_NAME,
				createBashOutputToolDefinition(this._jobs) as unknown as ToolDefinition,
			);
			// repo_map: built in, active when repoMap.enabled (or --tools +repo_map).
			this._baseToolDefinitions.set(
				REPO_MAP_TOOL_NAME,
				createRepoMapToolDefinition(this._cwd) as unknown as ToolDefinition,
			);
		}
		// Hooks and MCP servers come from settings files: re-read them on every build (startup and reload).
		this._hooks.reload();
		this._mcp.loadConfig();
		this._hooksBridge = this._hooks.config.entries.length > 0 ? createHooksBridge(this._hooks) : undefined;
		const builtinExtensions = [];
		if (this._hooksBridge) builtinExtensions.push(this._hooksBridge.extension);
		if (this._mcp.hasServers) {
			this._mcpExtension.sync();
			builtinExtensions.push(this._mcpExtension.extension);
			if (!this._baseToolsOverride) {
				this._baseToolDefinitions.set(
					MCP_TOOL_NAME,
					createMcpToolDefinition(
						this._mcp,
						this._mcp.servers().map((state) => state.config.name),
					) as unknown as ToolDefinition,
				);
			}
		}

		const extensionsResult = this._resourceLoader.getExtensions();
		if (options.flagValues) {
			for (const [name, value] of options.flagValues) {
				extensionsResult.runtime.flagValues.set(name, value);
			}
		}

		this._extensionRunner = new ExtensionRunner(
			[...extensionsResult.extensions, ...builtinExtensions],
			extensionsResult.runtime,
			this._cwd,
			this.sessionManager,
			new ModelRegistry(this._modelRuntime),
		);
		if (this._extensionRunnerRef) {
			this._extensionRunnerRef.current = this._extensionRunner;
		}
		this._bindExtensionCore(this._extensionRunner);
		this._applyExtensionBindings(this._extensionRunner);

		const defaultActiveToolNames = this._baseToolsOverride
			? Object.keys(this._baseToolsOverride)
			: ["read", "bash", "edit", "write"];
		const baseActiveToolNames = options.activeToolNames ?? defaultActiveToolNames;
		this._refreshToolRegistry({
			activeToolNames: baseActiveToolNames,
			includeAllExtensionTools: options.includeAllExtensionTools,
		});
	}

	async reload(options?: { beforeSessionStart?: () => void | Promise<void> }): Promise<void> {
		const oldRunner = this._extensionRunner;
		const previousFlagValues = oldRunner.getFlagValues();
		await emitSessionShutdownEvent(oldRunner, { type: "session_shutdown", reason: "reload" });
		oldRunner.invalidate();
		const getDefaultTools = () =>
			this._usesDefaultTools
				? applyToolModifiers(
						this.settingsManager.getDefaultTools() ??
							platformDefaultToolNames(() => hasBashShell(this.settingsManager.getShellPath())),
						this._defaultToolModifiers,
					)
				: [];
		const previousDefaultTools = new Set(getDefaultTools());
		await this.settingsManager.reload();
		this.syncQueueModesFromSettings();
		resetApiProviders();
		await this._resourceLoader.reload();
		// Activate tools newly added to defaultTools. Removed ones stay active, and tools disabled
		// during the session stay disabled unless the setting newly adds them.
		const addedDefaultTools = getDefaultTools().filter((name) => !previousDefaultTools.has(name));
		// Tools the new extensions register later, such as MCP tools, are pending until then.
		for (const name of this._wantedToolNames()) this._pendingToolNames.add(name);
		this._buildRuntime({
			activeToolNames: [...this._wantedToolNames(), ...addedDefaultTools],
			flagValues: previousFlagValues,
			includeAllExtensionTools: true,
		});
		// Settings may have turned the todo tool or MCP servers on or off. After the freeze this only changes what
		// may be called; the declared tools stay as they are.
		this._syncTodoTool();
		this._activateMcpTool();

		const hasBindings =
			this._extensionUIContext ||
			this._extensionCommandContextActions ||
			this._extensionShutdownHandler ||
			this._extensionErrorListener;
		if (hasBindings) {
			await options?.beforeSessionStart?.();
			await this._extensionRunner.emit({ type: "session_start", reason: "reload" });
			await this.extendResourcesFromExtensions("reload");
		}
	}

	// =========================================================================
	// Auto-Retry
	// =========================================================================

	/**
	 * Check if an error is retryable (overloaded, rate limit, server errors).
	 * Context overflow errors are NOT retryable (handled by compaction instead).
	 */
	private _isRetryableError(message: AssistantMessage): boolean {
		// Context overflow is handled by compaction, not retry.
		if (isContextOverflow(message, (this._modelForMessage(message) ?? this.model)?.contextWindow ?? 0)) return false;
		return isRetryableAssistantError(message);
	}

	/**
	 * Retry policy + callbacks shared by compaction and branch-summary summarization calls.
	 * Uses the same `settings.retry` budget/backoff as agent-turn retries so a single transient
	 * stream drop no longer fails the whole operation. `source` carries the context
	 * the TUI needs to render the retry and recreate the underlying indicator.
	 */
	private _summarizationRetryCallbacks(
		source: { source: "branchSummary" } | { source: "compaction"; reason: "manual" | "threshold" | "overflow" },
	): RetryCallbacks {
		return {
			onRetryScheduled: (attempt, maxAttempts, delayMs, errorMessage) => {
				this._emit({
					type: "summarization_retry_scheduled",
					attempt,
					maxAttempts,
					delayMs,
					errorMessage,
				});
			},
			onRetryAttemptStart: () => {
				this._emit({
					type: "summarization_retry_attempt_start",
					...source,
				});
			},
			onRetryFinished: () => {
				this._emit({ type: "summarization_retry_finished" });
			},
		};
	}

	private _finishCancelledRetry(): void {
		if (this._retryAttempt === 0) return;
		const attempt = this._retryAttempt;
		this._retryAttempt = 0;
		this._emit({
			type: "auto_retry_end",
			success: false,
			attempt,
			finalError: "Retry cancelled",
		});
	}

	/** End the current run's failover: the router routes normally again and the next run may fail over. */
	private _endFailover(): void {
		this._failoversThisRun = 0;
		this._pinnedNoticeShown = false;
		this._router?.endFailover();
	}

	/**
	 * Retries allowed on the current model. In auto mode, with failover on and another model to switch to,
	 * failover.retries (capped by retry.maxRetries) so the switch comes quickly; otherwise retry.maxRetries.
	 */
	private _maxRetriesForCurrentModel(): number {
		const maxRetries = this.settingsManager.getRetrySettings().maxRetries;
		if (!this._autoRouting || this._failoversThisRun > 0) return maxRetries;
		const failover = this.settingsManager.getFailoverSettings();
		const current = this.model;
		if (!failover.enabled || !current || !this._router?.hasAlternative(current.id)) return maxRetries;
		return Math.min(maxRetries, failover.retries);
	}

	/** Auto mode would fail over the current model now (failover on, none yet this run, another model fits). */
	private _canFailover(): boolean {
		const current = this.model;
		return (
			this._autoRouting &&
			this._failoversThisRun === 0 &&
			this.settingsManager.getFailoverSettings().enabled &&
			!!current &&
			!!this._router?.failoverTarget(current.id, this.agent.state.thinkingLevel, {
				hasImages: this._contextHasImages(),
			})
		);
	}

	/** Any image in the conversation (it is re-sent with every request, so the failover target needs vision). */
	private _contextHasImages(): boolean {
		return this.agent.state.messages.some(
			(message) =>
				(message.role === "user" || message.role === "toolResult") &&
				Array.isArray(message.content) &&
				message.content.some((part) => (part as { type?: string }).type === "image"),
		);
	}

	private _emitFailoverNotice(model: string, message: string): void {
		this._emit({ type: "failover_notice", model, message });
	}

	/** Close the retry indicator before switching models: the new model starts its own retry budget. */
	private _endRetriesForSwitch(message: AssistantMessage): void {
		if (this._retryAttempt > 0) {
			this._emit({
				type: "auto_retry_end",
				success: false,
				attempt: this._retryAttempt,
				finalError: message.errorMessage,
			});
		}
		this._retryAttempt = 0;
	}

	/**
	 * After retries are exhausted. Auto mode: fail over to another model (see _prepareRouterFallback). A model
	 * the user picked is only retried, never switched, unless they configured a fallback list themselves
	 * (settings `models.fallback`), which is tried before the session's first successful reply.
	 * @returns true if the caller should continue the agent on the new model.
	 */
	private async _prepareModelFallback(message: AssistantMessage): Promise<boolean> {
		if (this._agentRunAbortRequested || message.stopReason !== "error") return false;
		const current = this.model;
		if (this._autoRouting) return this._prepareRouterFallback(message);
		if (current && this._isRetryableError(message)) this._modelHealth.markFailed(current.id, message.errorMessage);
		const configured = this.settingsManager.getModelRoles().fallback;
		if (!current || !configured?.length || this._hasSuccessfulReply()) {
			if (current && this._isRetryableError(message) && this.settingsManager.getFailoverSettings().enabled) {
				this._emitFailoverNotice(
					current.id,
					`${current.id} still failing after retries. It is the model you picked, so RunKiln did not switch (pick auto to allow failover).`,
				);
			}
			return false;
		}
		this._fallbackTried.add(current.id);
		const defaults = effectiveRoleDefaults(this._modelRuntime.catalog, this.settingsManager.getModelRoles());
		const next = nextFallbackModel(current.id, defaults.fallback, this._fallbackTried, (id) =>
			this._modelRuntime.getModelById(id),
		);
		if (!next) return false;
		try {
			await this.setModel(next);
		} catch {
			return false;
		}
		this._omitRecoveryAttempt(message);
		this._endRetriesForSwitch(message);
		this._emit({
			type: "model_fallback",
			from: current.id,
			to: next.id,
			errorMessage: message.errorMessage || "Unknown error",
		});
		return true;
	}

	/**
	 * Auto mode. A transient failure (5xx, 429, overloaded, timeout, reset, stall) that outlived the retries
	 * fails over: the model cools down and the rest of the run goes to another routable model at an
	 * equivalent thinking level, with the conversation and tools unchanged. Once per run: if the second
	 * model fails too, the run ends with the error. Other errors keep the older behavior: the model cools
	 * down and the router picks again.
	 */
	private _prepareRouterFallback(message: AssistantMessage): boolean {
		const router = this.getRouter();
		const current = this.model;
		if (!router || !current) return false;
		const failover = this.settingsManager.getFailoverSettings();
		if (this._isRetryableError(message)) {
			if (!failover.enabled) {
				this._modelHealth.markFailed(current.id, message.errorMessage);
				this._emitFailoverNotice(
					current.id,
					`${current.id} still failing after retries; failover is off (settings failover.enabled).`,
				);
				return false;
			}
			if (this._failoversThisRun > 0) {
				router.markModelFailed(current.id, message.errorMessage);
				this._emitFailoverNotice(
					current.id,
					`${current.id} failed too after failover; not switching again this turn.`,
				);
				return false;
			}
			const target = router.failoverTarget(current.id, this.agent.state.thinkingLevel, {
				hasImages: this._contextHasImages(),
			});
			if (!target) {
				router.markModelFailed(current.id, message.errorMessage);
				this._emitFailoverNotice(current.id, `${current.id} unavailable and no other model can take this turn.`);
				return false;
			}
			router.startFailover(current.id, target.model.id, target.thinkingLevel, message.errorMessage);
			this._failoversThisRun++;
			this._omitRecoveryAttempt(message);
			this._endRetriesForSwitch(message);
			this._emit({
				type: "model_fallback",
				from: current.id,
				to: target.model.id,
				thinkingLevel: target.thinkingLevel as ThinkingLevel,
				scope: "turn",
				errorMessage: message.errorMessage || "Unknown error",
			});
			return true;
		}
		if (isContextOverflow(message, current.contextWindow ?? 0)) return false;
		if (!router.hasAlternative(current.id)) return false;
		router.markModelFailed(current.id, message.errorMessage);
		this._omitRecoveryAttempt(message);
		this._endRetriesForSwitch(message);
		this._emit({
			type: "model_fallback",
			from: current.id,
			to: "auto",
			errorMessage: message.errorMessage || "Unknown error",
		});
		return true;
	}

	/**
	 * Prepare a retryable error for continuation with exponential backoff.
	 * @returns true if the caller should continue the agent, false otherwise
	 */
	private async _prepareRetry(message: AssistantMessage): Promise<boolean> {
		const settings = this.settingsManager.getRetrySettings();
		if (!settings.enabled) {
			return false;
		}

		this._retryAttempt++;
		const maxRetries = this._maxRetriesForCurrentModel();

		if (this._retryAttempt > maxRetries) {
			// Preserve the completed attempt count so post-run handling can emit the final failure.
			this._retryAttempt--;
			return false;
		}

		// Jittered exponential backoff: clients that failed together do not retry together.
		const delayMs = jitteredRetryDelayMs(settings, this._retryAttempt);

		// A model the user picked is retried, never switched: say so once per run.
		const current = this.model;
		if (
			!this._autoRouting &&
			current &&
			!this._pinnedNoticeShown &&
			this.settingsManager.getFailoverSettings().enabled &&
			!this.settingsManager.getModelRoles().fallback?.length
		) {
			this._pinnedNoticeShown = true;
			this._emitFailoverNotice(
				current.id,
				`${current.id} failed (${message.errorMessage || "error"}). Retrying it only: it is the model you picked, so RunKiln will not switch models.`,
			);
		}

		this._emit({
			type: "auto_retry_start",
			attempt: this._retryAttempt,
			maxAttempts: maxRetries,
			delayMs,
			errorMessage: message.errorMessage || "Unknown error",
		});

		// Keep the failed attempt in raw history while durably omitting it from model projection.
		this._omitRecoveryAttempt(message);

		// Wait with exponential backoff (abortable)
		this._retryAbortController = new AbortController();
		try {
			await sleep(delayMs, this._retryAbortController.signal);
		} catch {
			// Aborted during sleep - emit end event so UI can clean up
			this._finishCancelledRetry();
			return false;
		} finally {
			this._retryAbortController = undefined;
		}

		return true;
	}

	/**
	 * Cancel in-progress retry.
	 */
	abortRetry(): void {
		this._retryAbortController?.abort();
	}

	/** Whether auto-retry is currently in progress */
	get isRetrying(): boolean {
		return this._retryAbortController !== undefined;
	}

	/** Whether auto-retry is enabled */
	get autoRetryEnabled(): boolean {
		return this.settingsManager.getRetryEnabled();
	}

	/**
	 * Toggle auto-retry setting.
	 */
	setAutoRetryEnabled(enabled: boolean): void {
		this.settingsManager.setRetryEnabled(enabled);
	}

	// =========================================================================
	// Bash Execution
	// =========================================================================

	/**
	 * Execute a bash command.
	 * Adds result to agent context and session.
	 * @param command The bash command to execute
	 * @param onChunk Optional streaming callback for output
	 * @param options.excludeFromContext If true, command output won't be sent to LLM (!! prefix)
	 * @param options.id Optional identifier included in bash execution update events
	 * @param options.operations Custom BashOperations for remote execution
	 */
	async executeBash(
		command: string,
		onChunk?: (chunk: string) => void,
		options?: { excludeFromContext?: boolean; id?: string; operations?: BashOperations },
	): Promise<BashResult> {
		const abortController = new AbortController();
		this._bashAbortControllers.add(abortController);

		// Apply command prefix if configured (e.g., "shopt -s expand_aliases" for alias support)
		const prefix = this.settingsManager.getShellCommandPrefix();
		const shellPath = this.settingsManager.getShellPath();
		const resolvedCommand = prefix ? `${prefix}\n${command}` : command;

		try {
			const result = await executeBashWithOperations(
				resolvedCommand,
				this.sessionManager.getCwd(),
				options?.operations ?? createLocalBashOperations({ shellPath }),
				{
					onChunk: (delta) => {
						onChunk?.(delta);
						this._emit({ type: "bash_execution_update", id: options?.id, delta });
					},
					signal: abortController.signal,
				},
			);

			this.recordBashResult(command, result, options);
			return result;
		} finally {
			this._bashAbortControllers.delete(abortController);
		}
	}

	/**
	 * Record a bash execution result in session history.
	 * Used by executeBash and by extensions that handle bash execution themselves.
	 */
	recordBashResult(command: string, result: BashResult, options?: { excludeFromContext?: boolean }): void {
		const bashMessage: BashExecutionMessage = {
			role: "bashExecution",
			command,
			output: result.output,
			exitCode: result.exitCode,
			cancelled: result.cancelled,
			truncated: result.truncated,
			fullOutputPath: result.fullOutputPath,
			timestamp: Date.now(),
			excludeFromContext: options?.excludeFromContext,
		};

		// If agent is streaming, defer adding to avoid breaking tool_use/tool_result ordering
		if (this.isStreaming) {
			// Queue for later - will be flushed on agent_end
			this._pendingBashMessages.push(bashMessage);
		} else {
			this.sessionManager.appendMessage(bashMessage);
			this._refreshFinalizedContext();
		}
	}

	/**
	 * Cancel running bash command.
	 */
	abortBash(): void {
		for (const abortController of [...this._bashAbortControllers]) {
			abortController.abort();
		}
	}

	/** Whether a bash command is currently running */
	get isBashRunning(): boolean {
		return this._bashAbortControllers.size > 0;
	}

	/** Whether there are pending bash messages waiting to be flushed */
	get hasPendingBashMessages(): boolean {
		return this._pendingBashMessages.length > 0;
	}

	/**
	 * Flush pending bash messages to agent state and session.
	 * Called after agent turn completes to maintain proper message ordering.
	 */
	private _flushPendingBashMessages(): void {
		if (this._pendingBashMessages.length === 0) return;

		for (const bashMessage of this._pendingBashMessages) {
			this.sessionManager.appendMessage(bashMessage);
		}
		this._pendingBashMessages = [];
		this._refreshFinalizedContext();
	}

	// =========================================================================
	// Session Management
	// =========================================================================

	/**
	 * Set a display name for the current session.
	 */
	setSessionName(name: string): void {
		this.sessionManager.appendSessionInfo(name);
		const event = { type: "session_info_changed", name: this.sessionManager.getSessionName() } as const;
		this._emit(event);
		void this._extensionRunner.emit(event);
	}

	// =========================================================================
	// Tree Navigation
	// =========================================================================

	/**
	 * Navigate to a different node in the session tree.
	 * Unlike fork() which creates a new session file, this stays in the same file.
	 *
	 * @param targetId The entry ID to navigate to
	 * @param options.summarize Whether user wants to summarize abandoned branch
	 * @param options.customInstructions Custom instructions for summarizer
	 * @param options.replaceInstructions If true, customInstructions replaces the default prompt
	 * @param options.label Label to attach to the branch summary entry
	 * @returns Result with editorText (if user message) and cancelled status
	 */
	async navigateTree(
		targetId: string,
		options: { summarize?: boolean; customInstructions?: string; replaceInstructions?: boolean; label?: string } = {},
	): Promise<{ editorText?: string; cancelled: boolean; aborted?: boolean; summaryEntry?: BranchSummaryEntry }> {
		if (this.isStreaming) {
			throw new Error("Wait for the current response to finish before navigating the session tree.");
		}
		if (this.isCompacting) {
			throw new Error(
				"Wait for the current compaction or tree navigation to finish before navigating the session tree.",
			);
		}

		const oldLeafId = this.sessionManager.getLeafId();

		// No-op if already at target
		if (targetId === oldLeafId) {
			return { cancelled: false };
		}

		// Model required for summarization
		if (options.summarize && !this.model) {
			throw new Error("No model available for summarization");
		}

		const targetEntry = this.sessionManager.getEntry(targetId);
		if (!targetEntry) {
			throw new Error(`Entry ${targetId} not found`);
		}

		// Collect entries to summarize (from old leaf to common ancestor)
		const { entries: entriesToSummarize, commonAncestorId } = collectEntriesForBranchSummary(
			this.sessionManager,
			oldLeafId,
			targetId,
		);

		// Prepare event data - mutable so extensions can override
		let customInstructions = options.customInstructions;
		let replaceInstructions = options.replaceInstructions;
		let label = options.label;

		const preparation: TreePreparation = {
			targetId,
			oldLeafId,
			commonAncestorId,
			entriesToSummarize,
			userWantsSummary: options.summarize ?? false,
			customInstructions,
			replaceInstructions,
			label,
		};

		// Set up abort controller for summarization
		this._branchSummaryAbortController = new AbortController();

		try {
			let extensionSummary: { summary: string; details?: unknown; usage?: Usage } | undefined;
			let fromExtension = false;

			// Emit session_before_tree event
			if (this._extensionRunner.hasHandlers("session_before_tree")) {
				const result = (await this._extensionRunner.emit({
					type: "session_before_tree",
					preparation,
					signal: this._branchSummaryAbortController.signal,
				})) as SessionBeforeTreeResult | undefined;

				if (result?.cancel) {
					return { cancelled: true };
				}

				if (result?.summary && options.summarize) {
					extensionSummary = result.summary;
					fromExtension = true;
				}

				// Allow extensions to override instructions and label
				if (result?.customInstructions !== undefined) {
					customInstructions = result.customInstructions;
				}
				if (result?.replaceInstructions !== undefined) {
					replaceInstructions = result.replaceInstructions;
				}
				if (result?.label !== undefined) {
					label = result.label;
				}
			}

			// Run default summarizer if needed
			let summaryText: string | undefined;
			let summaryDetails: unknown;
			let summaryUsage: Usage | undefined;
			if (options.summarize && entriesToSummarize.length > 0 && !extensionSummary) {
				const signal = this._branchSummaryAbortController.signal;
				const branchSummarySettings = this.settingsManager.getBranchSummarySettings();
				// A side task: the chore model summarizes, falling back like compaction.
				const result = await this._withChoreModel(
					"branch-summary",
					signal,
					async (choreModel, choreThinking) =>
						generateBranchSummary(entriesToSummarize, {
							...(await this._getSummarizationRequestAuth(choreModel, signal, choreThinking)),
							signal,
							customInstructions,
							replaceInstructions,
							reserveTokens: branchSummarySettings.reserveTokens,
							streamFn: this.agent.streamFunction,
							retry: this.settingsManager.getRetrySettings(),
							callbacks: this._summarizationRetryCallbacks({ source: "branchSummary" }),
						}),
					(summary) => (summary.aborted ? undefined : summary.error),
				);
				if (result.aborted) {
					return { cancelled: true, aborted: true };
				}
				if (result.error) {
					throw new Error(result.error);
				}
				summaryText = result.summary;
				summaryUsage = result.usage;
				summaryDetails = {
					readFiles: result.readFiles || [],
					modifiedFiles: result.modifiedFiles || [],
				};
			} else if (extensionSummary) {
				summaryText = extensionSummary.summary;
				summaryDetails = extensionSummary.details;
				summaryUsage = extensionSummary.usage;
			}

			// Determine the new leaf position based on target type
			let newLeafId: string | null;
			let editorText: string | undefined;

			if (targetEntry.type === "message" && targetEntry.message.role === "user") {
				// User message: leaf = parent (null if root), text goes to editor
				newLeafId = targetEntry.parentId;
				editorText = contentText(targetEntry.message.content, "");
			} else if (targetEntry.type === "custom_message") {
				// Custom message: leaf = parent (null if root), text goes to editor
				newLeafId = targetEntry.parentId;
				editorText = contentText(targetEntry.content, "");
			} else {
				// Non-user message: leaf = selected node
				newLeafId = targetId;
			}

			// Switch leaf (with or without summary)
			// Summary is attached at the navigation target position (newLeafId), not the old branch
			let summaryEntry: BranchSummaryEntry | undefined;
			if (summaryText) {
				// Create summary at target position (can be null for root)
				const summaryId = this.sessionManager.branchWithSummary(
					newLeafId,
					summaryText,
					summaryDetails,
					fromExtension,
					summaryUsage,
				);
				summaryEntry = this.sessionManager.getEntry(summaryId) as BranchSummaryEntry;

				// Attach label to the summary entry
				if (label) {
					this.sessionManager.appendLabelChange(summaryId, label);
				}
			} else if (newLeafId === null) {
				// No summary, navigating to root - reset leaf
				this.sessionManager.resetLeaf();
			} else {
				// No summary, navigating to non-root
				this.sessionManager.branch(newLeafId);
			}

			// Attach label to target entry when not summarizing (no summary entry to label)
			if (label && !summaryText) {
				this.sessionManager.appendLabelChange(targetId, label);
			}

			// Update finalized context from the canonical session projection.
			this._refreshFinalizedContext();
			this._restoreToolsFromTranscript();

			// Emit session_tree event
			await this._extensionRunner.emit({
				type: "session_tree",
				newLeafId: this.sessionManager.getLeafId(),
				oldLeafId,
				summaryEntry,
				fromExtension: summaryText ? fromExtension : undefined,
			});

			// Emit to custom tools

			return { editorText, cancelled: false, summaryEntry };
		} finally {
			this._branchSummaryAbortController = undefined;
			this._resolveIdleWaitIfIdle();
		}
	}

	/**
	 * Get all user messages from session for fork selector.
	 */
	getUserMessagesForForking(): Array<{ entryId: string; text: string }> {
		const entries = this.sessionManager.getEntries();
		const result: Array<{ entryId: string; text: string }> = [];

		for (const entry of entries) {
			if (entry.type !== "message") continue;
			if (entry.message.role !== "user") continue;

			const text = contentText(entry.message.content, "");
			if (text) {
				result.push({ entryId: entry.id, text });
			}
		}

		return result;
	}

	/**
	 * Get session statistics. Aggregates over ALL session entries (including
	 * history that was compacted away), so token/cost totals reflect what was
	 * actually billed across the session.
	 */
	getSessionStats(): SessionStats {
		let userMessages = 0;
		let assistantMessages = 0;
		let toolResults = 0;
		let totalMessages = 0;
		let toolCalls = 0;
		const usageTotals = createUsageTotals();

		for (const entry of this.sessionManager.getEntries()) {
			if (entry.type === "usage") {
				addUsageToTotals(usageTotals, entry.usage);
			} else if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
				addUsageToTotals(usageTotals, entry.usage);
			}
			if (entry.type !== "message") continue;
			totalMessages++;
			const message = entry.message;
			if (message.role === "user") {
				userMessages++;
			} else if (message.role === "toolResult") {
				toolResults++;
				if (message.usage) {
					addUsageToTotals(usageTotals, message.usage);
				}
			} else if (message.role === "assistant") {
				assistantMessages++;
				const assistantMsg = message as AssistantMessage;
				if (Array.isArray(assistantMsg.content)) {
					toolCalls += assistantMsg.content.filter((c) => c.type === "toolCall").length;
				}
				addUsageToTotals(usageTotals, assistantMsg.usage);
			}
		}

		return {
			sessionFile: this.sessionFile,
			sessionId: this.sessionId,
			userMessages,
			assistantMessages,
			toolCalls,
			toolResults,
			totalMessages,
			tokens: {
				input: usageTotals.input,
				output: usageTotals.output,
				cacheRead: usageTotals.cacheRead,
				cacheWrite: usageTotals.cacheWrite,
				total: usageTotals.input + usageTotals.output + usageTotals.cacheRead + usageTotals.cacheWrite,
			},
			cost: usageTotals.cost,
			contextUsage: this.getContextUsage(),
		};
	}

	/** /usage: the session's billed calls, by model, category and turn, with cache health (all branches). */
	getUsageReport(now: number = Date.now()): SessionUsageReport {
		return buildSessionUsageReport(this.sessionManager.getEntries(), {
			prices: this._usagePrices,
			ttlMs: (provider, modelId) => {
				const model = this._usagePrices.getModel(provider, modelId);
				return model ? sessionIdleTtlMs(model as Model<any>) : DEFAULT_SESSION_IDLE_TTL_MS;
			},
			now,
		});
	}

	/** Catalog prices for usage math; a runtime without a model lookup (tests) prices nothing. */
	private readonly _usagePrices: UsagePriceSource = {
		getModel: (provider, modelId) => {
			const runtime = this._modelRuntime as { getModel?: ModelRuntime["getModel"] };
			try {
				return typeof runtime.getModel === "function" ? runtime.getModel(provider, modelId) : undefined;
			} catch {
				return undefined;
			}
		},
	};

	/** The usage ledger file, when this session writes one. */
	get usageLedgerPath(): string | undefined {
		return this._usageLedger?.path;
	}

	/** Spend today across sessions (the ledger), or this session's cost when there is no ledger. */
	getCostToday(now: number = Date.now()): number {
		return this._usageLedger ? this._usageLedger.costToday(now) : this.getSessionStats().cost;
	}

	/** `budget.session` / `budget.daily` against this session's cost and today's spend. Empty when none is set. */
	getBudgetStatuses(now: number = Date.now()): BudgetStatus[] {
		const settings = this.settingsManager.getBudgetSettings();
		if (settings.session === undefined && settings.daily === undefined) return [];
		const sessionCost = this.getSessionStats().cost;
		return evaluateBudgets(settings, sessionCost, settings.daily !== undefined ? this.getCostToday(now) : 0);
	}

	/**
	 * /usage → Context: the current context against the model window, split into system prompt, tools, messages and
	 * tool results (chars/4 estimates scaled to the last reported prompt size), and where auto-compaction triggers.
	 */
	getContextBreakdown(): ContextBreakdown | undefined {
		const model = this._limitsModel();
		if (!model || !(model.contextWindow > 0)) return undefined;
		const usage = this.getContextUsage();
		const projection = this.sessionManager.buildSessionProjection();
		const parts = { systemPrompt: 0, tools: 0, messages: 0, toolResults: 0 };
		let declaredTools = false;
		for (const message of projection.messages) {
			if (message.role === "system") {
				const system = message as SystemMessage;
				if (system.toolsAdded) {
					declaredTools = true;
					parts.tools += Math.ceil(JSON.stringify(system.toolsAdded).length / 4);
				}
				parts.systemPrompt += Math.max(0, estimateTokens({ ...system, toolsAdded: undefined } as SystemMessage));
			} else if (message.role === "toolResult" || message.role === "bashExecution") {
				parts.toolResults += estimateTokens(message);
			} else {
				parts.messages += estimateTokens(message);
			}
		}
		if (!declaredTools) {
			parts.tools = Math.ceil(
				JSON.stringify(
					this.agent.state.tools.map((tool) => ({
						name: tool.name,
						description: tool.description,
						parameters: tool.parameters,
					})),
				).length / 4,
			);
		}
		if (parts.systemPrompt === 0) parts.systemPrompt = Math.ceil(this.systemPrompt.length / 4);
		const estimate = parts.systemPrompt + parts.tools + parts.messages + parts.toolResults;
		const tokens = usage?.tokens ?? null;
		if (tokens !== null && estimate > 0) {
			const scale = tokens / estimate;
			parts.systemPrompt = Math.round(parts.systemPrompt * scale);
			parts.tools = Math.round(parts.tools * scale);
			parts.messages = Math.round(parts.messages * scale);
			parts.toolResults = Math.max(0, tokens - parts.systemPrompt - parts.tools - parts.messages);
		}
		const settings = this.settingsManager.getCompactionSettings(model);
		return {
			tokens,
			contextWindow: model.contextWindow,
			parts,
			estimated: true,
			autoCompact: settings.enabled,
			...(settings.enabled ? { compactAt: compactionTriggerTokens(model.contextWindow, settings, model) } : {}),
			model: model.id,
		};
	}

	getContextUsage(): ContextUsage | undefined {
		const model = this._limitsModel();
		if (!model) return undefined;

		const contextWindow = model.contextWindow ?? 0;
		if (contextWindow <= 0) return undefined;

		// After compaction, the last assistant usage reflects pre-compaction context size.
		// We can only trust usage from an assistant that responded after the latest compaction.
		// If no such assistant exists, context token count is unknown until the next LLM response.
		const projection = this.sessionManager.buildSessionProjection();
		const branch = this.sessionManager.getBranch();
		const latestCompaction = getLatestCompactionEntry(branch);

		if (latestCompaction) {
			const projectedAssistants = new Set(
				projection.entries.flatMap((entry) =>
					entry.messages.some(
						(message) =>
							message.role === "assistant" &&
							message.stopReason !== "aborted" &&
							message.stopReason !== "error" &&
							calculateContextTokens(message.usage) > 0,
					)
						? [entry.sourceEntry.id]
						: [],
				),
			);
			const compactionIndex = branch.findIndex((entry) => entry.id === latestCompaction.id);
			const hasPostCompactionUsage = branch
				.slice(compactionIndex + 1)
				.some((entry) => projectedAssistants.has(entry.id));
			if (!hasPostCompactionUsage) return { tokens: null, contextWindow, percent: null };
		}

		const estimate = estimateProjectedContextTokens(projection, branch);
		const percent = (estimate.tokens / contextWindow) * 100;

		return {
			tokens: estimate.tokens,
			contextWindow,
			percent,
		};
	}

	/**
	 * Export session to HTML.
	 * @param outputPath Optional output path (defaults to session directory)
	 * @param options Optional export presentation settings
	 * @returns Path to exported file
	 */
	async exportToHtml(outputPath?: string, options: { themeName?: string } = {}): Promise<string> {
		const themeName = [options.themeName, this.settingsManager.getTheme()].find(
			(candidate) => candidate !== undefined && getThemeByName(candidate) !== undefined,
		);

		// Create tool renderer if we have an extension runner (for custom tool HTML rendering)
		const toolRenderer: ToolHtmlRenderer = createToolHtmlRenderer({
			getToolRenderers: (name) =>
				this._extensionRunner.resolveToolRenderers(name, () => this.getToolDefinition(name)),
			theme,
			cwd: this.sessionManager.getCwd(),
		});

		return await exportSessionToHtml(this.sessionManager, this.state, {
			outputPath,
			themeName,
			toolRenderer,
		});
	}

	/**
	 * Export the current session branch to a JSONL file.
	 * Writes the session header followed by all entries on the current branch path.
	 * @param outputPath Target file path. If omitted, generates a timestamped file in cwd.
	 * @returns The resolved output file path.
	 */
	exportToJsonl(outputPath?: string): string {
		return exportSessionToJsonl(this.sessionManager, outputPath);
	}

	// =========================================================================
	// Utilities
	// =========================================================================

	/**
	 * Get text content of last assistant message.
	 * Useful for /copy command.
	 * @returns Text content, or undefined if no assistant message exists
	 */
	getLastAssistantText(): string | undefined {
		const lastAssistant = this.messages
			.slice()
			.reverse()
			.find((m) => {
				if (m.role !== "assistant") return false;
				const msg = m as AssistantMessage;
				// Skip aborted messages with no content
				if (msg.stopReason === "aborted" && msg.content.length === 0) return false;
				return true;
			});

		if (!lastAssistant) return undefined;

		let text = "";
		for (const content of (lastAssistant as AssistantMessage).content) {
			if (content.type === "text") {
				text += content.text;
			}
		}

		return text.trim() || undefined;
	}

	// =========================================================================
	// Extension System
	// =========================================================================

	createReplacedSessionContext(): ReplacedSessionContext {
		const context = Object.defineProperties(
			{},
			Object.getOwnPropertyDescriptors(this._extensionRunner.createCommandContext()),
		) as ReplacedSessionContext;
		context.sendMessage = (message, options) => this.sendCustomMessage(message, options);
		context.sendUserMessage = (content, options) => this.sendUserMessage(content, options);
		return context;
	}

	/**
	 * Check if extensions have handlers for a specific event type.
	 */
	hasExtensionHandlers(eventType: string): boolean {
		return this._extensionRunner.hasHandlers(eventType);
	}

	/**
	 * Get the extension runner (for setting UI context and error handlers).
	 */
	get extensionRunner(): ExtensionRunner {
		return this._extensionRunner;
	}
}
