import { join } from "node:path";
import {
	Agent,
	type AgentMessage,
	LENGTH_CONTINUATION_PROMPT,
	setDefaultStreamFn,
	type ThinkingLevel,
} from "@runkiln/agent-core";
import type { ModelsSimpleStreamOptions } from "@runkiln/ai";
import { clampThinkingLevel, type Message, type Model, streamSimple } from "@runkiln/ai/compat";
import { getAgentDir } from "../config.ts";
import { resolvePath } from "../utils/paths.ts";
import { hasBashShell } from "../utils/shell.ts";
import { AgentSession, ROUTER_STATE_ENTRY } from "./agent-session.ts";
import { formatNoModelsAvailableMessage } from "./auth-guidance.ts";
import { DEFAULT_THINKING_LEVEL } from "./defaults.ts";
import type { ExtensionRunner, LoadExtensionsResult, SessionStartEvent, ToolDefinition } from "./extensions/index.ts";
import { convertToLlm, withWorkingDirectoryContext } from "./messages.ts";
import { findInitialModel } from "./model-resolver.ts";
import { ModelRuntime } from "./model-runtime.ts";
import type { ResourceLoader } from "./resource-loader.ts";
import { DefaultResourceLoader } from "./resource-loader.ts";
import {
	harnessThinkingLevel,
	isAutoModel,
	isAutoModelId,
	isRouterMode,
	type ModelRouter,
	parseAutoMode,
	type RouterMode,
	type RouterOverrides,
} from "./router/index.ts";
import { observeCallMetrics } from "./runkiln/call-metrics.ts";
import { recordLastTurnRequest } from "./runkiln/last-request.ts";
import { effectiveRoleDefaults } from "./runkiln/model-roles.ts";
import type { ModelRole } from "./runkiln/models-catalog.ts";
import type { PermissionJudge, PermissionMode } from "./runkiln/permissions.ts";
import { createRequestFitState, fitRequestSize } from "./runkiln/request-fit.ts";
import { resolveParentSessionId } from "./runkiln/session-headers.ts";
import { withFirstTokenTimeout } from "./runkiln/stall-watchdog.ts";
import { getDefaultSessionDir, SessionManager } from "./session-manager.ts";
import { getBranchSelection } from "./session-model.ts";
import {
	applyToolModifiers,
	getToolListError,
	isToolModifier,
	platformDefaultToolNames,
	SettingsManager,
} from "./settings-manager.ts";
import { time } from "./timings.ts";
import { createToolNameMatcher } from "./tool-name-matcher.ts";
import {
	createBashTool,
	createCodingTools,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createPowerShellTool,
	createReadOnlyTools,
	createReadTool,
	createWriteTool,
	withFileMutationQueue,
} from "./tools/index.ts";
import { getUsageLedgerPath } from "./usage/ledger.ts";

// Preserve the pre-0.81 fallback for extensions that construct Agent instances
// or invoke low-level agent loops without supplying streamFn. Agent core remains
// provider-agnostic and does not import @runkiln/ai/compat itself.
setDefaultStreamFn(streamSimple);

export interface CreateAgentSessionOptions {
	/** Working directory for project-local discovery. Default: process.cwd() */
	cwd?: string;
	/** Global config directory. Default: ~/.runkiln/agent */
	agentDir?: string;
	/**
	 * Turn checkpoints for /undo and /rewind (persisted sessions only). Default: agentDir/checkpoints, unless
	 * RUNKILN_CHECKPOINTS is 0, off or false. False turns them off.
	 */
	checkpointDir?: string | false;
	/**
	 * Usage ledger for `/usage` history and `runkiln usage` (persisted sessions only). Default: agentDir/usage.jsonl,
	 * unless RUNKILN_USAGE_LEDGER is 0, off or false. False turns it off.
	 */
	usageLedger?: string | false;

	/** RunInfra model runtime. Defaults to models.yaml plus agentDir/runinfra.json. */
	modelRuntime?: ModelRuntime;

	/** Session role: picks the code or chat model from settings / models.yaml. Default: "code". */
	role?: ModelRole;
	/**
	 * Parent session id for subagents, sent as `x-parent-session-id`. Default: from the
	 * environment a parent RunKiln session gives its shell commands.
	 */
	parentSessionId?: string;

	/** Model to use. Default: from settings, else first available */
	model?: Model<any>;
	/** Thinking level. Default: from settings, else the model's harness effort (clamped to model capabilities) */
	thinkingLevel?: ThinkingLevel;
	/** Router classifier overrides from the CLI (--router-classifier, --router-model). */
	routerOverrides?: RouterOverrides;
	/** Router for the "auto" model (SDK/tests). Default: built from router.yaml and settings on first use. */
	router?: ModelRouter;
	/** Routing mode for auto (low, medium, high). Default: from the model id ("auto:high"), the session, or settings. */
	routerMode?: RouterMode;
	/** Permission mode (ask, read-write, auto, allow-all). Default: the process mode set by the CLI, else read-write. */
	permissionMode?: PermissionMode;
	/** Decision model for auto permissions (SDK/tests). Default: Jev or OpenRouter from the router classifier keys. */
	permissionJudgeFactory?: () => PermissionJudge | undefined;
	/** Models available for cycling (Ctrl+P in interactive mode) */
	scopedModels?: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>;

	/**
	 * Optional default tool suppression mode when no explicit allowlist is provided.
	 *
	 * - "all": start with no tools enabled
	 * - "builtin": disable the default built-in tools (read, bash, edit, write)
	 *   but keep extension/custom tools enabled
	 */
	noTools?: "all" | "builtin";
	/**
	 * Optional allowlist of tool names or patterns, where `*` matches any characters.
	 *
	 * When omitted, RunKiln uses the resolved `defaultTools` setting for the initial
	 * selection when configured. Otherwise it enables the default built-in tools
	 * (read, bash, edit, write). Extension/custom tools remain enabled unless
	 * `noTools` changes that default. When provided, only matching tools are
	 * enabled. MCP tools stay registered for codemode and tool search unless an
	 * entry starts with `mcp__`; then only matching MCP tools are kept. An empty
	 * list, like `noTools: "all"`, disables MCP tools too.
	 *
	 * A list of only `+name` and `-name` entries is not an allowlist: it adds tools
	 * to or removes them from the default selection, like the `defaultTools` setting.
	 * These entries take exact names. Mixing them with plain entries throws.
	 */
	tools?: string[];
	/**
	 * Optional denylist of tool names or patterns to disable. Applies after `tools` when both are
	 * provided, MCP tools included.
	 */
	excludeTools?: string[];
	/** Custom tools to register (in addition to built-in tools). */
	customTools?: ToolDefinition[];

	/** Resource loader. When omitted, DefaultResourceLoader is used. */
	resourceLoader?: ResourceLoader;

	/** Session manager. Default: SessionManager.create(cwd) */
	sessionManager?: SessionManager;

	/** Settings manager. Default: SettingsManager.create(cwd, agentDir) */
	settingsManager?: SettingsManager;
	/** Session start event metadata for extension runtime startup. */
	sessionStartEvent?: SessionStartEvent;
}

/** Result from createAgentSession */
export interface CreateAgentSessionResult {
	/** The created session */
	session: AgentSession;
	/** Extensions result (for UI context setup in interactive mode) */
	extensionsResult: LoadExtensionsResult;
	/** Warning if session was restored with a different model than saved */
	modelFallbackMessage?: string;
}

// Re-exports

export * from "./agent-session-runtime.ts";
export type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	SlashCommandInfo,
	SlashCommandSource,
	ToolDefinition,
} from "./extensions/index.ts";
export type { PromptTemplate } from "./prompt-templates.ts";
export type { Skill } from "./skills.ts";
export type { Tool } from "./tools/index.ts";

export {
	withFileMutationQueue,
	// Tool factories (for custom cwd)
	createCodingTools,
	createReadOnlyTools,
	createReadTool,
	createBashTool,
	createEditTool,
	createWriteTool,
	createGrepTool,
	createFindTool,
	createLsTool,
	createPowerShellTool,
};

// Helper Functions

/** Where the usage ledger is written, or false when it is off. */
function usageLedgerFor(option: string | false | undefined, agentDir: string): string | false {
	if (option === false) return false;
	if (option) return resolvePath(option);
	const env = process.env.RUNKILN_USAGE_LEDGER?.trim().toLowerCase();
	if (env === "0" || env === "off" || env === "false") return false;
	return getUsageLedgerPath(agentDir);
}

/** Where turn checkpoints are kept, or false when they are off. */
function checkpointDirFor(option: string | false | undefined, agentDir: string): string | false {
	if (option === false) return false;
	if (option) return resolvePath(option);
	const env = process.env.RUNKILN_CHECKPOINTS?.trim().toLowerCase();
	if (env === "0" || env === "off" || env === "false") return false;
	return join(agentDir, "checkpoints");
}

function getDefaultAgentDir(): string {
	return getAgentDir();
}

/**
 * Create an AgentSession with the specified options.
 *
 * @example
 * ```typescript
 * // Minimal - uses defaults
 * const { session } = await createAgentSession();
 *
 * // With explicit model
 * import { getModel } from '@runkiln/ai';
 * const { session } = await createAgentSession({
 *   model: getModel('anthropic', 'claude-opus-4-5'),
 *   thinkingLevel: 'high',
 * });
 *
 * // Continue previous session
 * const { session, modelFallbackMessage } = await createAgentSession({
 *   continueSession: true,
 * });
 *
 * // Full control
 * const loader = new DefaultResourceLoader({
 *   cwd: process.cwd(),
 *   agentDir: getAgentDir(),
 *   settingsManager: SettingsManager.create(),
 * });
 * await loader.reload();
 * const { session } = await createAgentSession({
 *   model: myModel,
 *   tools: ["read", "bash"],
 *   resourceLoader: loader,
 *   sessionManager: SessionManager.inMemory(),
 * });
 * ```
 */
export async function createAgentSession(options: CreateAgentSessionOptions = {}): Promise<CreateAgentSessionResult> {
	const cwd = resolvePath(options.cwd ?? options.sessionManager?.getCwd() ?? process.cwd());
	const agentDir = options.agentDir ? resolvePath(options.agentDir) : getDefaultAgentDir();
	let resourceLoader = options.resourceLoader;

	const modelRuntime = options.modelRuntime ?? (await ModelRuntime.create({ agentDir }));
	const parentSessionId = options.parentSessionId ?? resolveParentSessionId();

	const settingsManager = options.settingsManager ?? SettingsManager.create(cwd, agentDir);
	// Optional call: SDK callers may pass a duck-typed runtime.
	modelRuntime.setDisabledModels?.(settingsManager.getDisabledModels());
	const sessionManager = options.sessionManager ?? SessionManager.create(cwd, getDefaultSessionDir(cwd, agentDir));

	if (!resourceLoader) {
		resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
		await resourceLoader.reload();
		time("resourceLoader.reload");
	}

	// Check if session has existing data to restore
	const existingSession = sessionManager.buildSessionContext();
	const hasExistingSession = existingSession.messages.length > 0;
	const hasThinkingEntry = sessionManager.getBranch().some((entry) => entry.type === "thinking_level_change");

	// "auto" is a routing mode: the session starts on a concrete model and the router takes over.
	const roleDefaults = modelRuntime.catalog
		? effectiveRoleDefaults(modelRuntime.catalog, settingsManager.getModelRoles())
		: undefined;
	const role = options.role ?? "code";
	let autoRouting = false;
	let routerMode = options.routerMode;
	let model = options.model;
	if (model && isAutoModel(model)) {
		autoRouting = true;
		routerMode ??= parseAutoMode(model.id);
		model = undefined;
	} else if (!model && hasExistingSession) {
		const restored = restoredRouterState(sessionManager.getBranch());
		autoRouting = restored?.enabled ?? false;
		routerMode ??= restored?.mode;
	} else if (!model && !hasExistingSession) {
		autoRouting = isAutoModelId(roleDefaults?.[role]);
		routerMode ??= parseAutoMode(roleDefaults?.[role]);
	}
	const modelRoles = settingsManager.getModelRoles();
	if (isAutoModelId(modelRoles[role])) delete modelRoles[role];
	let modelFallbackMessage: string | undefined;

	const sessionModel = getBranchSelection(sessionManager.getBranch());

	// If session has data, try to restore model from it
	if (!model && hasExistingSession && sessionModel) {
		const restoredModel = modelRuntime.getModel(sessionModel.provider, sessionModel.modelId);
		if (restoredModel && modelRuntime.hasConfiguredAuth(restoredModel.provider)) {
			model = restoredModel;
		}
		if (!model) {
			modelFallbackMessage = `Could not restore model ${sessionModel.provider}/${sessionModel.modelId}`;
		}
	}

	// If still no model, use the role model (settings, then models.yaml), then the fallback order
	if (!model) {
		const result = await findInitialModel({
			scopedModels: [],
			isContinuing: hasExistingSession,
			role: options.role,
			modelRoles,
			defaultThinkingLevel: settingsManager.getDefaultThinkingLevel(),
			modelThinkingLevels: settingsManager.getAllModelThinkingLevels(),
			modelRuntime,
		});
		model = result.model;
		if (!model) {
			modelFallbackMessage = formatNoModelsAvailableMessage();
		} else if (result.fallbackMessage && !modelFallbackMessage) {
			modelFallbackMessage = result.fallbackMessage;
		} else if (modelFallbackMessage) {
			modelFallbackMessage += `. Using ${model.provider}/${model.id}`;
		}
	}

	let thinkingLevel = options.thinkingLevel;

	// If session has data, restore thinking level from it
	if (thinkingLevel === undefined && hasExistingSession) {
		thinkingLevel = hasThinkingEntry
			? (existingSession.thinkingLevel as ThinkingLevel)
			: (settingsManager.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL);
	}

	// Fall back to per-model override, then global default
	if (thinkingLevel === undefined && model) {
		const perModel = settingsManager.getModelThinkingLevel(model.provider, model.id);
		if (perModel) {
			thinkingLevel = perModel;
		}
	}
	if (thinkingLevel === undefined) {
		thinkingLevel =
			settingsManager.getDefaultThinkingLevel() ??
			(model ? harnessThinkingLevel(model) : undefined) ??
			DEFAULT_THINKING_LEVEL;
	}

	// Clamp to model capabilities
	if (!model) {
		thinkingLevel = "off";
	} else {
		thinkingLevel = clampThinkingLevel(model, thinkingLevel) as ThinkingLevel;
	}

	const toolListError = options.tools ? getToolListError(options.tools) : undefined;
	if (toolListError) throw new Error(`Invalid tools option: ${toolListError}`);
	const configuredTools =
		settingsManager.getDefaultTools() ?? platformDefaultToolNames(() => hasBashShell(settingsManager.getShellPath()));
	// repoMap.enabled adds the built-in repo_map tool to the default selection.
	const defaultToolNames = options.noTools
		? []
		: settingsManager.getRepoMapSettings().enabled && !configuredTools.includes("repo_map")
			? [...configuredTools, "repo_map"]
			: configuredTools;
	// A `tools` list of only `+name`/`-name` entries changes the default selection instead of
	// replacing it, like the `defaultTools` setting.
	const toolModifiers = options.tools?.some(isToolModifier) ? options.tools : undefined;
	const selectedToolNames = toolModifiers ? applyToolModifiers(defaultToolNames, toolModifiers) : options.tools;
	const allowedToolNames = toolModifiers
		? options.noTools === "all"
			? selectedToolNames
			: undefined
		: (options.tools ?? (options.noTools === "all" ? [] : undefined));
	const excludedToolNames = options.excludeTools;
	const isExcludedTool = excludedToolNames ? createToolNameMatcher(excludedToolNames) : undefined;
	const initialActiveToolNames = (selectedToolNames ?? defaultToolNames).filter((name) => !isExcludedTool?.(name));

	// Create convertToLlm wrapper that adds the working directory to each request and filters images
	// if blockImages is enabled (defense-in-depth)
	// Per request, on a copy: older images and tool output make room under RunInfra's request size cap.
	const requestFit = createRequestFitState();
	const convertToLlmWithBlockImages = (messages: AgentMessage[]): Message[] =>
		fitRequestSize(blockImagesIfSet(messages), requestFit).messages;
	const blockImagesIfSet = (messages: AgentMessage[]): Message[] => {
		// Per request, on a copy: the working directory is never stored in the transcript or the session file.
		const converted = withWorkingDirectoryContext(convertToLlm(messages), cwd);
		// Check setting dynamically so mid-session changes take effect
		if (!settingsManager.getBlockImages()) {
			return converted;
		}
		// Filter out ImageContent from all messages, replacing with text placeholder
		return converted.map((msg) => {
			if (msg.role === "user" || msg.role === "toolResult") {
				const content = msg.content;
				if (Array.isArray(content)) {
					const hasImages = content.some((c) => c.type === "image");
					if (hasImages) {
						const filteredContent = content
							.map((c) =>
								c.type === "image" ? { type: "text" as const, text: "Image reading is disabled." } : c,
							)
							.filter(
								(c, i, arr) =>
									// Dedupe consecutive "Image reading is disabled." texts
									!(
										c.type === "text" &&
										c.text === "Image reading is disabled." &&
										i > 0 &&
										arr[i - 1].type === "text" &&
										(arr[i - 1] as { type: "text"; text: string }).text === "Image reading is disabled."
									),
							);
						return { ...msg, content: filteredContent };
					}
				}
			}
			return msg;
		});
	};

	const extensionRunnerRef: { current?: ExtensionRunner } = {};
	const buildRequestOptions = (
		requestModel: Model<any>,
		options: ModelsSimpleStreamOptions = {},
	): ModelsSimpleStreamOptions => {
		const providerRetrySettings = settingsManager.getProviderRetrySettings();
		const httpIdleTimeoutMs = settingsManager.getHttpIdleTimeoutMs();
		const effectiveTimeoutMs = httpIdleTimeoutMs === 0 ? 2147483647 : httpIdleTimeoutMs;
		const headerRunner = extensionRunnerRef.current;
		return {
			...options,
			parentSessionId: options.parentSessionId ?? parentSessionId,
			timeoutMs: options.timeoutMs ?? providerRetrySettings.timeoutMs ?? effectiveTimeoutMs,
			websocketConnectTimeoutMs: options.websocketConnectTimeoutMs ?? settingsManager.getWebSocketConnectTimeoutMs(),
			maxRetries: options.maxRetries ?? providerRetrySettings.maxRetries,
			maxRetryDelayMs: options.maxRetryDelayMs ?? providerRetrySettings.maxRetryDelayMs,
			transformHeaders: async (requestHeaders) =>
				headerRunner?.hasHandlers("before_provider_headers")
					? headerRunner.emitBeforeProviderHeaders(requestHeaders)
					: requestHeaders,
		};
	};
	const transformProviderPayload = async (payload: unknown) => {
		const runner = extensionRunnerRef.current;
		if (!runner?.hasHandlers("before_provider_request")) return payload;
		return runner.emitBeforeProviderRequest(payload);
	};
	const handleProviderResponse: NonNullable<ModelsSimpleStreamOptions["onResponse"]> = async (response) => {
		const runner = extensionRunnerRef.current;
		if (!runner?.hasHandlers("after_provider_response")) return;
		await runner.emit({
			type: "after_provider_response",
			status: response.status,
			headers: response.headers,
		});
	};
	const handleProviderStreamEvent: NonNullable<ModelsSimpleStreamOptions["onProviderStreamEvent"]> = async (
		data,
		model,
	) => {
		const runner = extensionRunnerRef.current;
		if (!runner?.hasHandlers("provider_stream_event")) return;
		await runner.emit({
			data,
			type: "provider_stream_event",
			provider: model.provider,
			api: model.api,
			model: model.id,
		});
	};

	const agent = new Agent({
		initialState: {
			systemPrompt: "",
			model,
			thinkingLevel,
			tools: [],
			messages: existingSession.messages,
		},
		convertToLlm: convertToLlmWithBlockImages,
		streamFn: async (model, context, options) => {
			const requestOptions = buildRequestOptions(model, options);
			// Main-session turns only (summaries use cacheRetention "none"; background calls pass their own
			// session and parent id per call): compaction summarizes on this exact warm prefix
			// (see runkiln/last-request.ts). A session that itself has a parent (RUNKILN_PARENT_SESSION_ID) still records.
			if (!options?.parentSessionId && requestOptions.cacheRetention !== "none") {
				recordLastTurnRequest(agent, { model, context, sessionId: requestOptions.sessionId, at: Date.now() });
			}
			// No first token within failover.stallTimeoutSec: abort and end as a retryable "timed out" error.
			const stream = withFirstTokenTimeout(
				(signal) => modelRuntime.streamSimple(model, context, { ...requestOptions, signal }),
				{ model, timeoutMs: settingsManager.getFailoverSettings().stallTimeoutMs, signal: requestOptions.signal },
			);
			return observeCallMetrics(stream, {
				model,
				sessionId: requestOptions.sessionId,
				parentSessionId: requestOptions.parentSessionId,
				kind: "turn",
			});
		},
		onPayload: transformProviderPayload,
		onResponse: handleProviderResponse,
		onProviderStreamEvent: handleProviderStreamEvent,
		sessionId: sessionManager.getSessionId(),
		transformContext: async (messages) => {
			const runner = extensionRunnerRef.current;
			if (!runner) return messages;
			return runner.emitContext(messages);
		},
		steeringMode: settingsManager.getSteeringMode(),
		followUpMode: settingsManager.getFollowUpMode(),
		transport: settingsManager.getTransport(),
		thinkingBudgets: settingsManager.getThinkingBudgets(),
		maxRetryDelayMs: settingsManager.getProviderRetrySettings().maxRetryDelayMs,
		// An answer cut off at max_tokens is continued (at most twice) with a hidden custom message,
		// which convertToLlm sends as a user turn. The transcript shows one continuous answer.
		createLengthContinuationMessage: (_truncated, attempt) => ({
			role: "custom",
			customType: "length-continuation",
			content: LENGTH_CONTINUATION_PROMPT,
			display: false,
			details: { attempt },
			timestamp: Date.now(),
		}),
	});

	// Restore missing settings metadata for older sessions.
	if (hasExistingSession) {
		if (!hasThinkingEntry) {
			sessionManager.appendThinkingLevelChange(thinkingLevel);
		}
	} else {
		// Save initial model and thinking level for new sessions so they can be restored on resume
		if (model) {
			sessionManager.appendModelChange(model.provider, model.id);
		}
		sessionManager.appendThinkingLevelChange(thinkingLevel);
	}

	const session = new AgentSession({
		agent,
		sessionManager,
		settingsManager,
		cwd,
		scopedModels: options.scopedModels,
		resourceLoader,
		customTools: options.customTools,
		modelRuntime,
		role,
		autoRouting,
		routerMode,
		pinnedThinking: autoRouting ? options.thinkingLevel : undefined,
		manualThinking: autoRouting ? undefined : options.thinkingLevel,
		routerOverrides: options.routerOverrides,
		router: options.router,
		permissionMode: options.permissionMode,
		permissionJudgeFactory: options.permissionJudgeFactory,
		permissionAgentDir: agentDir,
		checkpointDir: checkpointDirFor(options.checkpointDir, agentDir),
		usageLedgerPath: usageLedgerFor(options.usageLedger, agentDir),
		initialActiveToolNames,
		usesDefaultTools: (options.tools === undefined || toolModifiers !== undefined) && !options.noTools,
		defaultToolModifiers: toolModifiers,
		allowedToolNames,
		excludedToolNames,
		extensionRunnerRef,
		sessionStartEvent: options.sessionStartEvent,
		requestFit,
	});

	const extensionsResult = resourceLoader.getExtensions();

	return {
		session,
		extensionsResult,
		modelFallbackMessage,
	};
}

/** Auto mode and routing mode as last recorded in the session branch, if ever recorded. */
function restoredRouterState(
	branch: readonly { type: string; customType?: string; data?: unknown }[],
): { enabled: boolean; mode?: RouterMode } | undefined {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type === "custom" && entry.customType === ROUTER_STATE_ENTRY) {
			const data = entry.data as { enabled?: unknown; mode?: unknown } | undefined;
			return { enabled: data?.enabled === true, mode: isRouterMode(data?.mode) ? data.mode : undefined };
		}
	}
	return undefined;
}
