/**
 * Interactive mode for the coding agent.
 * Handles TUI rendering and user interaction, delegating business logic to AgentSession.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage, ThinkingLevel } from "@runkiln/agent-core";
import type { AuthEvent, AuthPrompt } from "@runkiln/ai";
import {
	type AssistantMessage,
	type ImageContent,
	isRetryableAssistantError,
	type Message,
	type Model,
	type Usage,
} from "@runkiln/ai/compat";
import type {
	AutocompleteItem,
	AutocompleteProvider,
	EditorChip,
	EditorComponent,
	EditorDraft,
	Keybinding,
	KeyId,
	MarkdownTheme,
	OverlayHandle,
	OverlayOptions,
	ProgramStatus,
	SlashCommand,
	TuiMainScreenRenderState,
} from "@runkiln/tui";
import * as TuiLayouts from "@runkiln/tui";
import {
	CombinedAutocompleteProvider,
	type Component,
	Container,
	fuzzyFilter,
	getCapabilities,
	HistorySearch,
	hyperlink,
	IMAGE_MARKER_REGEX,
	Markdown,
	MouseRegion,
	matchesKey,
	Spacer,
	setCapabilityOverrides,
	setKeybindings,
	setReducedMotion,
	type Terminal,
	Text,
	TruncatedText,
	type TUI,
	TuiAltScreen,
	TuiMainScreen,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	visibleWidth,
} from "@runkiln/tui";
import chalk from "chalk";
import { spawn } from "child_process";
import { chooseSetupDisplay, runSetup, runSetupHub } from "../../cli/run-setup.ts";
import {
	APP_NAME,
	APP_TITLE,
	CONFIG_DIR_NAME,
	detectInstallChange,
	getAgentDir,
	getAuthPath,
	getDebugLogPath,
	getDocsPath,
	VERSION,
} from "../../config.ts";
import {
	type AgentSession,
	type AgentSessionEvent,
	parseSkillBlock,
	type RewindPoint,
} from "../../core/agent-session.ts";
import { type AgentSessionRuntime, SessionImportFileNotFoundError } from "../../core/agent-session-runtime.ts";
import type { AgentSessionRuntimeDiagnostic } from "../../core/agent-session-services.ts";
import { CACHE_TTL_MS, type CacheMiss, collectCacheMisses, detectCacheMiss } from "../../core/cache-stats.ts";
import { findExtensionStackMatches, recordCrash, takeUnnotifiedCrash } from "../../core/crash-log.ts";
import { DEFAULT_THINKING_LEVEL, THINKING_LEVEL_OPTIONS } from "../../core/defaults.ts";
import type {
	AutocompleteProviderFactory,
	EditorFactory,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionRunner,
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	ExtensionWidgetOptions,
	MarkdownTransformer,
	ProjectTrustContext,
	UserBashEventResult,
	WorkingIndicatorOptions,
} from "../../core/extensions/index.ts";
import { FooterDataProvider, type ReadonlyFooterDataProvider } from "../../core/footer-data-provider.ts";
import { configureHttpDispatcher, formatHttpIdleTimeoutMs } from "../../core/http-dispatcher.ts";
import { type AppKeybinding, KeybindingsManager } from "../../core/keybindings.ts";
import { createCompactionSummaryMessage, createCustomMessage } from "../../core/messages.ts";
import { findExactModelReferenceMatch, resolveModelScopeFromModels } from "../../core/model-resolver.ts";
import { formatAge, type PromptHistoryScope, PromptHistoryStore } from "../../core/prompt-history.ts";
import { renderRepoMap } from "../../core/repo-map/render.ts";
import { conversationText, getRepoMap } from "../../core/repo-map/repo-map.ts";
import { repoMapCacheDir } from "../../core/repo-map/tool.ts";
import type { ResourceDiagnostic } from "../../core/resource-loader.ts";
import { isAutoModelId, isRouterMode, parseAutoMode, shortRouteReason } from "../../core/router/index.ts";
import { formatRestoreNotice, formatRestorePlan, type RestorePlan } from "../../core/runkiln/checkpoints.ts";
import { COMMIT_SCOPES } from "../../core/runkiln/git-workflow.ts";
import { idleCompactionNotice } from "../../core/runkiln/idle-compaction.ts";
import { sessionIdleTtlMs } from "../../core/runkiln/last-request.ts";
import { effectiveRoleDefaults, resolveRoleModel } from "../../core/runkiln/model-roles.ts";
import { createPermissionJudge, isPermissionJudgeAvailable } from "../../core/runkiln/permission-judge.ts";
import { describeSavedRule, type RuleAction } from "../../core/runkiln/permission-rules.ts";
import {
	type ApprovalAnswer,
	describeRule,
	nextPermissionMode,
	PERMISSION_MODES,
	type PermissionMode,
	type PermissionPrompt,
	parsePermissionMode,
	permissionModeInfo,
} from "../../core/runkiln/permissions.ts";
import { extractPlan, lastAssistantText, planEditedFeedback } from "../../core/runkiln/plan-mode.ts";
import { isPayloadTooLargeError } from "../../core/runkiln/request-fit.ts";
import { getActiveRunInfraKey, runInfraErrorHint } from "../../core/runkiln/runinfra-account.ts";
import { formatMissingSessionCwdPrompt, MissingSessionCwdError } from "../../core/session-cwd.ts";
import {
	type SessionEntry,
	SessionManager,
	sessionEntryToContextMessages,
	type UsageEntry,
} from "../../core/session-manager.ts";
import type { FullscreenExitOutput, TuiMode } from "../../core/settings-manager.ts";
import {
	BUILTIN_SLASH_COMMAND_NAMES,
	BUILTIN_SLASH_COMMANDS,
	HIDDEN_SLASH_ALIASES,
} from "../../core/slash-commands.ts";
import type { SourceInfo } from "../../core/source-info.ts";
import { withBuiltInRenderers } from "../../core/tools/renderers/index.ts";
import type { TruncationResult } from "../../core/tools/truncate.ts";
import { hasTrustRequiringProjectResources, ProjectTrustStore } from "../../core/trust-manager.ts";
import {
	type BudgetLevel,
	type BudgetStatus,
	describeBudget,
	newlyCrossed,
	tightestBudget,
} from "../../core/usage/budget.ts";
import { rangeStart, readLedger, summarizeLedger, type UsageRange } from "../../core/usage/ledger.ts";
import { parseUsageArgument, usageText, usd, usdLimit } from "../../core/usage/views.ts";
import { getEditStats } from "../../core/verify/edit-metrics.ts";
import { getChangelogPath, getNewEntries, normalizeChangelogLinks, parseChangelog } from "../../utils/changelog.ts";
import {
	copyToClipboard,
	readClipboardFilePaths,
	readClipboardText,
	setTerminalFocused,
} from "../../utils/clipboard.ts";
import { readClipboardImageResult } from "../../utils/clipboard-image.ts";
import { parseGitUrl } from "../../utils/git.ts";
import { ensurePngTranscoder } from "../../utils/image-convert.ts";
import { getCwdRelativePath } from "../../utils/paths.ts";
import { getRunKilnUserAgent } from "../../utils/runkiln-user-agent.ts";
import { killTrackedDetachedChildren } from "../../utils/shell.ts";
import { loadAllHighlightLanguages } from "../../utils/syntax-highlight.ts";
import { ensureTool, type ToolStatus } from "../../utils/tools-manager.ts";
import { isWSL } from "../../utils/wsl.ts";
import { createChatViewport } from "./chat-viewport.ts";
import { ClickActions, nativeSelectionHint, resolvePointerShapes, runForeground } from "./click-actions.ts";
import { ArminComponent } from "./components/armin.ts";
import { AssistantMessageComponent } from "./components/assistant-message.ts";
import { BashExecutionComponent } from "./components/bash-execution.ts";
import { BranchSummaryMessageComponent } from "./components/branch-summary-message.ts";
import { ChangesReviewScreen, type ChangesReviewSource, loadReviewFiles } from "./components/changes-review.ts";
import { ChangesTrayComponent, resolveDiffTarget } from "./components/changes-tray.ts";
import { CompactionSummaryMessageComponent } from "./components/compaction-summary-message.ts";
import { showContextMenu } from "./components/context-menu.ts";
import { CustomEditor } from "./components/custom-editor.ts";
import { CustomEntryComponent } from "./components/custom-entry.ts";
import { CustomMessageComponent } from "./components/custom-message.ts";
import { DynamicBorder } from "./components/dynamic-border.ts";
import { playArmin3d } from "./components/easter-egg-3d.lazy.ts";
import { ExtensionEditorComponent, type ExtensionEditorOptions } from "./components/extension-editor.ts";
import { ExtensionInputComponent } from "./components/extension-input.ts";
import { ExtensionSelectorComponent } from "./components/extension-selector.ts";
import { type FooterAction, FooterComponent, footerShowForPreset, formatTokens } from "./components/footer.ts";
import { KeyHintRow, type KeyHintState } from "./components/key-hint-row.ts";
import { formatKeyText, keyDisplayText, keyHint, keyText, rawKeyHint } from "./components/keybinding-hints.ts";
import { createMermaidMarkdownTransformer } from "./components/mermaid.ts";
import { ModelSelectorComponent } from "./components/model-selector.ts";
import {
	type ModelsManagerResult,
	ModelsManagerScreen,
	settingsModelsStore,
} from "./components/models-manager-screen.ts";
import { runkilnOnboardingLine } from "./components/onboarding-line.ts";
import { PermissionPromptComponent } from "./components/permission-prompt.ts";
import { PermissionRulesViewComponent, type RuleViewEntry } from "./components/permission-rules-view.ts";
import { PermissionsSelectorComponent } from "./components/permissions-selector.ts";
import { PlanApprovalComponent } from "./components/plan-approval.ts";
import { buildRepoMapPanel, parseMapArgs, themedRepoMapStyle } from "./components/repo-map-view.ts";
import { RewindSelectorComponent } from "./components/rewind-selector.ts";
import { rkBannerLines } from "./components/rk-banner.ts";
import { ScopedModelsSelectorComponent } from "./components/scoped-models-selector.ts";
import { SessionSelectorComponent } from "./components/session-selector.ts";
import { isOn, SettingsSelectorComponent } from "./components/settings-selector.ts";
import {
	type HubKey,
	type HubScreen,
	type HubSection,
	parseHubSection,
	SetupHub,
	type SetupHubResult,
} from "./components/setup/setup-hub.ts";
import { type SetupResult, SetupWizard } from "./components/setup/setup-wizard.ts";
import { buildShortcutRows, optionAsMetaWarning, ShortcutSheet } from "./components/shortcut-sheet.ts";
import { SkillInvocationMessageComponent } from "./components/skill-invocation-message.ts";
import {
	BranchSummaryStatusIndicator,
	CompactionStatusIndicator,
	IdleStatus,
	RetryStatusIndicator,
	type StatusIndicator,
	WorkingStatusIndicator,
} from "./components/status-indicator.ts";
import { StatusLinePickerComponent } from "./components/statusline-picker.ts";
import { ThemedText } from "./components/themed-text.ts";
import { type ThinkingChoice, ThinkingSelectorComponent } from "./components/thinking-selector.ts";
import { TodoPanelComponent } from "./components/todo-panel.ts";
import { ToolExecutionComponent } from "./components/tool-execution.ts";
import { isGroupableTool, ToolGroupComponent } from "./components/tool-group.ts";
import { setTranscriptDisplay } from "./components/transcript-display.ts";
import { TreeSelectorComponent } from "./components/tree-selector.ts";
import { TrustSelectorComponent } from "./components/trust-selector.ts";
import {
	collectTurnStats,
	filesFromChangeSummary,
	shouldShowTurnSummary,
	type TurnEntryLike,
	type TurnRoutePick,
	TurnSummaryComponent,
	type TurnSummaryData,
} from "./components/turn-summary.ts";
import { UsageScreen } from "./components/usage-screen.ts";
import { UserMessageComponent } from "./components/user-message.ts";
import { UserMessageSelectorComponent } from "./components/user-message-selector.ts";
import { extractCodeBlocks, lineCountLabel, osc52Sequence, parseCopyCommand, selectCodeBlock } from "./copy-text.ts";
import { buildHooksMarkdown, buildJobsMarkdown, buildMcpMarkdown } from "./extend-commands.ts";
import { editInExternalEditor } from "./external-editor.ts";
import {
	acceptsImages,
	ImageAttachments,
	isImagePath,
	mentionedImagePaths,
	nonVisionWarning,
	type PendingImage,
	type PreparedImage,
	parsePastedImagePaths,
	prepareImageBytes,
	prepareImageFile,
} from "./image-attachments.ts";
import { getModelSearchText } from "./model-search.ts";
import { TurnNotifier } from "./notifications.ts";
import { type BlockedStatus, ProgramStatusReporter } from "./program-status-reporter.ts";
import {
	buildDiffMarkdown,
	buildHelpMarkdown,
	buildInitPrompt,
	buildStatusMarkdown,
	buildTestMarkdown,
	formatDoctorMarkdown,
	formatEditMisses,
	runDoctorChecks,
} from "./runkiln-commands.ts";
import { formatTerminalTitle, TerminalTitle } from "./terminal-title.ts";
import {
	getAvailableThemes,
	getAvailableThemesWithPaths,
	getEditorTheme,
	getMarkdownTheme,
	getSelectListTheme,
	getThemeByName,
	onThemeChange,
	SYSTEM_THEME_NAME,
	setRegisteredThemes,
	stopThemeWatcher,
	Theme,
	type ThemeColor,
	theme,
} from "./theme/theme.ts";
import { InteractiveThemeController } from "./theme/theme-controller.ts";
import { CardSelection, classifyCardSelectKey, type SelectableCard } from "./tool-card-select.ts";
import { createInteractiveTui, createInteractiveTuiReference } from "./tui-renderer.ts";
import { commitPromptDescription, commitPromptTitle } from "./workflow-text.ts";

export { createInteractiveTui, createInteractiveTuiReference } from "./tui-renderer.ts";

/** Interface for components that can be expanded/collapsed */
interface Expandable {
	setExpanded(expanded: boolean): void;
}

interface ActiveEditor extends EditorComponent {
	getCursor?(): { line: number; col: number };
}

interface WorkingStatusEditor extends EditorComponent {
	readonly embedWorkingStatus: boolean;
	setWorkingStatusIndicator(indicator: StatusIndicator | undefined): void;
}

function isEmbeddedStatus(editor: EditorComponent): editor is WorkingStatusEditor {
	return (
		"embedWorkingStatus" in editor &&
		editor.embedWorkingStatus === true &&
		"setWorkingStatusIndicator" in editor &&
		typeof editor.setWorkingStatusIndicator === "function"
	);
}

function isExpandable(obj: unknown): obj is Expandable {
	return typeof obj === "object" && obj !== null && "setExpanded" in obj && typeof obj.setExpanded === "function";
}

class ExpandableText extends ThemedText implements Expandable {
	private readonly state: { expanded: boolean };

	constructor(
		getCollapsedText: () => string,
		getExpandedText: () => string,
		expanded = false,
		paddingX = 0,
		paddingY = 0,
	) {
		const state = { expanded };
		super(() => (state.expanded ? getExpandedText() : getCollapsedText()), paddingX, paddingY);
		this.state = state;
	}

	setExpanded(expanded: boolean): void {
		this.state.expanded = expanded;
		this.invalidate();
	}
}

/** The built-in header. Clicking its logo (the first two lines, after one column of padding) plays an easter egg. */
class BuiltInHeader extends ExpandableText {
	onLogoClick: ((column: number, row: number) => void) | undefined;

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type !== "click" || event.y > 1 || event.x < 1 || event.x > 4 || !this.onLogoClick) return undefined;
		this.onLogoClick(event.screenX - event.x + 1, event.screenY - event.y);
		return { handled: true };
	}
}

type CompactionQueuedMessage = {
	text: string;
	mode: "steer" | "followUp";
};

type CompactionCostNotice = {
	type: "compaction_cost";
	kind: "compaction" | "branch_summary";
	usage: Usage;
};

type RenderSessionItem = AgentMessage | Extract<SessionEntry, { type: "custom" | "usage" }> | CompactionCostNotice;

function isCustomSessionEntry(item: RenderSessionItem): item is Extract<SessionEntry, { type: "custom" }> {
	return "type" in item && item.type === "custom";
}

function isCompactionCostNotice(item: RenderSessionItem): item is CompactionCostNotice {
	return "type" in item && item.type === "compaction_cost";
}

function isUsageSessionEntry(item: RenderSessionItem): item is Extract<SessionEntry, { type: "usage" }> {
	return "type" in item && item.type === "usage";
}

// EIO: tty reads/ioctls from an orphaned background process group, or writes after hangup.
// ENOTTY: the tty was revoked (macOS) and stdin is no longer a terminal.
const DEAD_TERMINAL_ERROR_CODES = new Set(["EIO", "EPIPE", "ENOTCONN", "ENOTTY"]);

function isDeadTerminalError(error: unknown): boolean {
	if (!error || typeof error !== "object" || !("code" in error)) {
		return false;
	}
	const code = (error as NodeJS.ErrnoException).code;
	return code !== undefined && DEAD_TERMINAL_ERROR_CODES.has(code);
}

export function formatCrashExtensionHint(extensionMatches: readonly string[] | undefined): string | undefined {
	const matches = Array.isArray(extensionMatches)
		? extensionMatches.filter((match): match is string => typeof match === "string" && match.length > 0)
		: [];
	if (matches.length === 0) return undefined;
	const quoted = matches.map((match) => `\`${match}\``);
	const labels =
		quoted.length === 1
			? quoted[0]
			: quoted.length === 2
				? quoted.join(" and ")
				: `${quoted.slice(0, -1).join(", ")}, and ${quoted[quoted.length - 1]}`;
	const noun = matches.length === 1 ? "extension" : "extensions";
	const pronoun = matches.length === 1 ? "it" : "them";
	return `A stack frame came from loaded ${noun} ${labels}, which may be involved. Try disabling ${pronoun} with \`${APP_NAME} config\`, or run \`${APP_NAME} -ne\` to confirm.`;
}

const ANTHROPIC_SUBSCRIPTION_AUTH_WARNING =
	"Anthropic subscription auth is active. Third-party harness usage draws from extra usage and is billed per token, not your Claude plan limits. Manage extra usage at https://claude.ai/settings/usage. Disable this warning in /settings.";

function isAnthropicSubscriptionAuthKey(apiKey: string | undefined): boolean {
	return typeof apiKey === "string" && apiKey.startsWith("sk-ant-oat");
}

function isUnknownModel(model: Model<any> | undefined): boolean {
	return !!model && model.provider === "unknown" && model.id === "unknown" && model.api === "unknown";
}

function quoteIfNeeded(value: string): string {
	if (value.length > 0 && !/[^a-zA-Z0-9_\-./~:@]/.test(value)) {
		return value;
	}
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function formatResumeCommand(sessionManager: SessionManager): string | undefined {
	if (!process.stdout.isTTY) return undefined;
	if (!sessionManager.isPersisted()) return undefined;

	const sessionFile = sessionManager.getSessionFile();
	if (!sessionFile || !fs.existsSync(sessionFile)) return undefined;

	const args = [APP_NAME];
	if (!sessionManager.usesDefaultSessionDir()) {
		args.push("--session-dir", quoteIfNeeded(sessionManager.getSessionDir()));
	}
	args.push("--session", sessionManager.getSessionId());
	return args.join(" ");
}

function createFuzzyAutocompleteItems<T>(
	items: T[],
	prefix: string,
	getSearchText: (item: T) => string,
	toAutocompleteItem: (item: T) => AutocompleteItem,
): AutocompleteItem[] | null {
	const filtered = fuzzyFilter(items, prefix, getSearchText);
	if (filtered.length === 0) return null;
	return filtered.map(toAutocompleteItem);
}

/**
 * Options for InteractiveMode initialization.
 */
/** The /fork picker entry that copies the session at its current position. */
const FORK_HERE_ID = "\u0000fork-here";

export interface InteractiveModeOptions {
	/** Providers that were migrated to auth.json (shows warning) */
	migratedProviders?: string[];
	/** Diagnostics collected before the interactive TUI was initialized. */
	startupDiagnostics?: AgentSessionRuntimeDiagnostic[];
	/** Warning message if session model couldn't be restored */
	modelFallbackMessage?: string;
	/** Lines from a first-run setup that finished before this session started. */
	setupNotice?: string;
	/** Cwd to trust after reload if it gained a project config directory during this implicitly trusted session. */
	autoTrustOnReloadCwd?: string;
	/** Initial message to send on startup (can include @file content) */
	initialMessage?: string;
	/** Images to attach to the initial message */
	initialImages?: ImageContent[];
	/** Additional messages to send after the initial message */
	initialMessages?: string[];
	/** Force verbose startup (overrides quietStartup setting) */
	verbose?: boolean;
	/** TUI layout mode. */
	tuiMode?: TuiMode;
	/** Initial interactive theme setting for this invocation. */
	initialThemeSetting?: string;
	/** Terminal implementation. Defaults to the current process terminal. */
	terminal?: Terminal;
	/** Runs after an interactive quit, once the TUI is stopped (--worktree: merge, keep or remove). */
	onExit?: () => Promise<void>;
}

/** Default key of the review view (`app.changes.review`). */
const REVIEW_KEY_DEFAULT = "alt+c";
/** Keys /settings offers for the review view; ones another action uses are left out. */
const REVIEW_KEY_CANDIDATES: readonly KeyId[] = [
	"alt+c",
	"alt+g",
	"alt+e",
	"alt+k",
	"alt+j",
	"alt+x",
	"ctrl+alt+c",
	"ctrl+alt+d",
	"ctrl+alt+r",
];

export class InteractiveMode {
	private runtimeHost: AgentSessionRuntime;
	private renderer: TuiMainScreen | TuiAltScreen;
	private ui: TUI;
	private mainScreenRenderState: TuiMainScreenRenderState | undefined;
	private loadedResourcesContainer: Container;
	private chatContainer: Container;
	private documentContainer: Container;
	private transcriptScrollView: TuiLayouts.ScrollView | undefined;
	private fullscreenLayoutRoot: Component | undefined;
	private pendingMessagesContainer: Container;
	private statusContainer: Container;
	private defaultEditor: CustomEditor;
	private editor: ActiveEditor;
	private editorComponentFactory: EditorFactory | undefined;
	private autocompleteProvider: AutocompleteProvider | undefined;
	private autocompleteProviderWrappers: AutocompleteProviderFactory[] = [];
	private fdPath: string | undefined;
	private editorContainer: Container;
	/** The dim key-hint line under the editor. */
	private keyHintContainer: Container;
	/** Prompts sent from this editor, saved across runs (Up/Down and Ctrl+R). */
	private readonly promptHistory = new PromptHistoryStore();
	/** A draft parked with the stash key; it comes back after the next send. */
	private promptStash: { draft: EditorDraft; images: PendingImage[] } | undefined;
	private historySearchOverlay: OverlayHandle | undefined;
	private shortcutSheetOverlay: OverlayHandle | undefined;
	private activeSelectorToken?: object;
	private activeSelectorDispose?: () => void;
	private footer: FooterComponent;
	/** Clicks: open paths in the editor, card actions, footer items. */
	private clickActions!: ClickActions;
	private footerContainer: Container;
	private footerDataProvider: FooterDataProvider;
	// Stored so the same manager can be injected into custom editors, selectors, and extension UI.
	private keybindings: KeybindingsManager;
	private version: string;
	private isInitialized = false;
	private onInputCallback?: (text: string) => void;
	private pendingUserInputs: string[] = [];
	/** Images attached in the editor (Ctrl+V, a pasted or dragged-in path), shown as `[image N - size]` chips. */
	private readonly imageAttachments = new ImageAttachments();
	/** Images bound to a submitted prompt's exact text, taken when that prompt is sent. */
	private readonly promptImages = new Map<string, ImageContent[]>();
	private activeStatusIndicator: StatusIndicator | undefined = undefined;
	private activeWorkingIndicatorEmbedded = false;
	private readonly idleStatus = new IdleStatus();
	private workingMessage: string | undefined = undefined;
	private workingVisible = true;
	private workingIndicatorOptions: WorkingIndicatorOptions | undefined = undefined;
	private readonly defaultWorkingMessage = "Working";
	private readonly defaultHiddenThinkingLabel = "Thinking...";
	private hiddenThinkingLabel = this.defaultHiddenThinkingLabel;

	private lastSigintTime = 0;
	private lastEscapeTime = 0;
	private changelogMarkdown: string | undefined = undefined;
	private startupNoticesShown = false;
	private anthropicSubscriptionWarningShown = false;
	/** Last router error shown, so a failing classifier warns once per streak, not every turn. */
	private lastRouterWarning: string | undefined;

	// Status line tracking (for mutating immediately-sequential status updates)
	private lastStatusSpacer: Spacer | undefined = undefined;
	private lastStatusText: ThemedText | undefined = undefined;
	private lastStatusMessage = "";
	private managedToolStatusStarted = false;

	// Streaming message tracking
	private streamingComponent: AssistantMessageComponent | undefined = undefined;
	private readonly entriesRenderedByBoundaryCompaction = new Set<string>();
	private streamingMessage: AssistantMessage | undefined = undefined;

	// Tool execution tracking: toolCallId -> component
	private pendingTools = new Map<string, ToolExecutionComponent>();

	// Tool output expansion state
	private toolOutputExpanded = false;
	/** Card select mode (app.tools.select): the cursor over tool cards and its input listener. */
	private toolCardSelection: { selection: CardSelection<SelectableCard>; unsubscribe: () => void } | undefined;
	/** When the running agent turn started, for the turn summary line. */
	private turnStartedAt: number | undefined;
	/** The todo list above the editor. */
	private readonly todoPanel = new TodoPanelComponent();
	/** Files the agent changed this session, above the editor. */
	private readonly changesTray = new ChangesTrayComponent({
		hint: () => {
			const key = this.getAppKeyDisplay("app.changes.review");
			return key ? `${key} review` : "/diff review";
		},
		onOpen: (path) => void this.openChangesReview(path),
		requestRender: () => this.ui.requestRender(),
	});
	/** Desktop notifications (setting `notifications`). */
	private readonly notifier = new TurnNotifier({
		mode: () => this.settingsManager.getNotificationsMode(),
		write: (data) => this.ui.terminal.write(data),
		focused: () => this.ui.terminalFocused,
	});

	// Thinking block visibility state
	private hideThinkingBlock = false;
	private outputPad = 1;
	private readonly mermaidMarkdownTransformer: MarkdownTransformer = createMermaidMarkdownTransformer({
		getMode: () => this.settingsManager.getMermaidRenderingMode(),
		theme,
	});

	// Skill commands: command name -> skill file path
	private skillCommands = new Map<string, string>();

	// Agent subscription unsubscribe function
	private unsubscribe?: () => void;
	private signalCleanupHandlers: Array<() => void> = [];

	// Track if editor is in bash mode (text starts with !)
	private isBashMode = false;

	// Track current bash execution component
	private bashComponent: BashExecutionComponent | undefined = undefined;

	// Track pending bash components (shown in pending area, moved to chat on submit)
	private pendingBashComponents: BashExecutionComponent[] = [];

	// Auto-compaction state
	private autoCompactionEscapeHandler?: () => void;

	// Auto-retry state
	private retryEscapeHandler?: () => void;

	// Messages queued while compaction is running
	private compactionQueuedMessages: CompactionQueuedMessage[] = [];

	// Shutdown state
	private shutdownRequested = false;

	/** Terminal title with the agent's state (`terminal.dynamicTitle`), restored on exit. */
	private readonly terminalTitle = new TerminalTitle({ write: (data) => this.ui.terminal.write(data) });
	/** Latest program status, for the terminal title. */
	private titleStatus: ProgramStatus | undefined;
	/** An extension set its own title: the dynamic title stays out of its way. */
	private extensionTitle = false;

	/** Reports working, blocked, done, and error states to terminals that support OSC 7501. */
	private readonly programStatus = new ProgramStatusReporter(
		() => this.ui.terminal,
		() => this.sessionManager.getSessionName(),
		(status) => {
			this.titleStatus = status;
			if (this.isInitialized) this.updateTerminalTitle();
		},
	);

	/** The `/bug` hint is shown at most once per session so error output stays readable. */
	private bugReportHintShown = false;
	private installChangeWarningShown = false;

	// Extension UI state
	private extensionSelector: ExtensionSelectorComponent | undefined = undefined;
	private extensionInput: ExtensionInputComponent | undefined = undefined;
	private extensionEditor: ExtensionEditorComponent | undefined = undefined;
	private extensionTerminalInputSubscriptions = new Set<{
		handler: (data: string) => { consume?: boolean; data?: string } | undefined;
		unsubscribe: () => void;
	}>();

	// Extension widgets (components rendered above/below the editor)
	private extensionWidgetsAbove = new Map<string, Component & { dispose?(): void }>();
	private extensionWidgetsBelow = new Map<string, Component & { dispose?(): void }>();
	private widgetContainerAbove!: Container;
	private widgetContainerBelow!: Container;

	// Custom footer from extension (undefined = use built-in footer)
	private customFooter: (Component & { dispose?(): void }) | undefined = undefined;

	// Header container that holds the built-in or custom header
	private headerContainer: Container;

	// Built-in header (logo + keybinding hints + changelog)
	private builtInHeader: Component | undefined = undefined;

	// Custom header from extension (undefined = use built-in header)
	private customHeader: (Component & { dispose?(): void }) | undefined = undefined;

	private options: InteractiveModeOptions;
	private readonly onRightClickPaste = (): void => {
		void this.handleRightClickPaste();
	};
	private autoTrustOnReloadCwd: string | undefined;
	private themeController: InteractiveThemeController;

	// Convenience accessors
	private get session(): AgentSession {
		return this.runtimeHost.session;
	}
	private get agent() {
		return this.session.agent;
	}
	private get sessionManager() {
		return this.session.sessionManager;
	}
	private get settingsManager() {
		return this.session.settingsManager;
	}

	constructor(runtimeHost: AgentSessionRuntime, options: InteractiveModeOptions = {}) {
		this.runtimeHost = runtimeHost;
		setCapabilityOverrides(this.settingsManager.getTerminalCapabilityOverrides());
		const tuiMode = options.tuiMode ?? this.settingsManager.getTuiMode();
		this.options = { ...options, tuiMode };
		this.autoTrustOnReloadCwd = options.autoTrustOnReloadCwd;
		this.runtimeHost.setBeforeSessionInvalidate(() => {
			this.resetExtensionUI();
		});
		this.runtimeHost.setRebindSession(async () => {
			await this.rebindCurrentSession({ renderBeforeBind: true });
			this.themeController.applyFromSettings();
		});
		this.version = VERSION;
		this.renderer = createInteractiveTui({
			tuiMode,
			showHardwareCursor: this.settingsManager.getShowHardwareCursor(),
			logDirectory: getAgentDir(),
			terminal: options.terminal,
			onRightClickPaste: this.onRightClickPaste,
			fullscreenCopyOnSelect: this.settingsManager.getFullscreenCopyOnSelect(),
			fullscreenWheelScrollLines: this.settingsManager.getFullscreenWheelScrollLines(),
			...this.clickTuiOptions(),
		});
		this.ui = createInteractiveTuiReference(() => this.renderer);
		this.clickActions = this.createClickActions();
		ToolExecutionComponent.actionHost = this.clickActions;
		this.ui.setClearOnShrink(this.settingsManager.getClearOnShrink());
		this.headerContainer = new Container();
		this.loadedResourcesContainer = new Container();
		this.chatContainer = new Container();
		this.documentContainer = new Container();
		this.documentContainer.addChild(this.headerContainer);
		this.documentContainer.addChild(this.loadedResourcesContainer);
		this.documentContainer.addChild(this.chatContainer);
		this.pendingMessagesContainer = new Container();
		this.statusContainer = new Container();
		this.widgetContainerAbove = new Container();
		this.widgetContainerBelow = new Container();
		this.keybindings = KeybindingsManager.create();
		setKeybindings(this.keybindings);
		const editorPaddingX = this.settingsManager.getEditorPaddingX();
		const autocompleteMaxVisible = this.settingsManager.getAutocompleteMaxVisible();
		this.defaultEditor = new CustomEditor(this.ui, getEditorTheme(), this.keybindings, {
			paddingX: editorPaddingX,
			autocompleteMaxVisible,
			embedWorkingStatus: true,
		});
		this.editor = this.defaultEditor;
		this.editorContainer = new Container();
		this.editorContainer.addChild(this.editor as Component);
		this.defaultEditor.setHistory(this.promptHistory.recentForCwd(this.sessionManager.getCwd()));
		this.keyHintContainer = new Container();
		this.keyHintContainer.addChild(
			new KeyHintRow({
				getState: () => this.keyHintState(),
				getRows: () => this.ui.terminal.rows,
				isEnabled: () => this.settingsManager.getUiHints(),
			}),
		);
		setReducedMotion(this.settingsManager.getReducedMotion());
		this.footerDataProvider = new FooterDataProvider(this.sessionManager.getCwd());
		this.footer = new FooterComponent(this.session, this.footerDataProvider, this.settingsManager.getFooterItems());
		this.footer.setShow(this.settingsManager.getFooterShow());
		this.footer.queueCount = () => {
			const queued = this.getAllQueuedMessages();
			return queued.steering.length + queued.followUp.length;
		};
		this.footer.setAutoCompactEnabled(this.session.autoCompactionEnabled);
		this.applyFooterTurnSummary();
		this.toolOutputExpanded = this.settingsManager.getDisplaySettings().toolOutput === "expanded";
		this.footer.onUsageClick = () => this.openUsageScreen("");
		this.footer.onAction = (action, event) => this.handleFooterAction(action, event);
		this.footerContainer = new Container();
		this.footerContainer.addChild(this.footer);

		// Load hide thinking block setting
		this.hideThinkingBlock = this.settingsManager.getHideThinkingBlock();
		this.outputPad = this.settingsManager.getOutputPad();

		// Register themes from resource loader and initialize
		setRegisteredThemes(this.session.resourceLoader.getThemes().themes);
		this.themeController = new InteractiveThemeController(this.ui, {
			getSettingsManager: () => this.settingsManager,
			showError: (message) => this.showError(message),
			onChanged: () => this.updateEditorBorderColor(),
			initialThemeSetting: options.initialThemeSetting,
		});
	}

	private getAutocompleteSourceTag(sourceInfo?: SourceInfo): string | undefined {
		// Built-in extension commands are untagged, like built-in commands.
		if (!sourceInfo || sourceInfo.source === "builtin") {
			return undefined;
		}

		const scopePrefix = sourceInfo.scope === "user" ? "u" : sourceInfo.scope === "project" ? "p" : "t";
		const source = sourceInfo.source.trim();

		if (source === "auto" || source === "local" || source === "cli") {
			return scopePrefix;
		}

		if (source.startsWith("npm:")) {
			return `${scopePrefix}:${source}`;
		}

		const gitSource = parseGitUrl(source);
		if (gitSource) {
			const ref = gitSource.ref ? `@${gitSource.ref}` : "";
			return `${scopePrefix}:git:${gitSource.host}/${gitSource.path}${ref}`;
		}

		return scopePrefix;
	}

	private prefixAutocompleteDescription(description: string | undefined, sourceInfo?: SourceInfo): string | undefined {
		const sourceTag = this.getAutocompleteSourceTag(sourceInfo);
		if (!sourceTag) {
			return description;
		}
		return description ? `[${sourceTag}] ${description}` : `[${sourceTag}]`;
	}

	private getBuiltInCommandConflictDiagnostics(extensionRunner: ExtensionRunner): ResourceDiagnostic[] {
		return extensionRunner
			.getRegisteredCommands()
			.filter((command) => BUILTIN_SLASH_COMMAND_NAMES.has(command.name))
			.map((command) => ({
				type: "warning" as const,
				message:
					command.invocationName === command.name
						? `Extension command '/${command.name}' conflicts with built-in interactive command. Skipping in autocomplete.`
						: `Extension command '/${command.name}' conflicts with built-in interactive command. Available as '/${command.invocationName}'.`,
				path: command.sourceInfo.path,
			}));
	}

	private createBaseAutocompleteProvider(): AutocompleteProvider {
		// Define commands for autocomplete
		const slashCommands: SlashCommand[] = BUILTIN_SLASH_COMMANDS.map((command) => ({
			name: command.name,
			description: command.description,
			...(command.argumentHint && { argumentHint: command.argumentHint }),
		}));

		const modelCommand = slashCommands.find((command) => command.name === "model");
		if (modelCommand) {
			modelCommand.getArgumentCompletions = (prefix: string): AutocompleteItem[] | null => {
				const models =
					this.session.scopedModels.length > 0
						? this.session.scopedModels.map((s) => s.model)
						: this.session.modelRuntime.getAvailableSnapshot();

				if (models.length === 0) return null;

				// Create items with provider/id format
				const items = models.map((m) => ({
					id: m.id,
					provider: m.provider,
					name: m.name,
					label: `${m.provider}/${m.id}`,
				}));

				return createFuzzyAutocompleteItems(items, prefix, getModelSearchText, (item) => ({
					value: item.label,
					label: item.id,
					description: item.provider,
				}));
			};
		}

		const permissionsCommand = slashCommands.find((command) => command.name === "permissions");
		if (permissionsCommand) {
			permissionsCommand.getArgumentCompletions = (prefix: string): AutocompleteItem[] | null => {
				const autoAvailable = this.session.permissions.isAutoAvailable();
				const items = [
					...PERMISSION_MODES.filter((info) => info.id !== "auto" || autoAvailable).map((info) => ({
						value: info.id,
						label: info.id,
						description: info.description,
					})),
					{ value: "clear", label: "clear", description: "Forget this session's “always allow” rules" },
					{ value: "rules", label: "rules", description: "List and remove allow, ask and deny rules" },
					{
						value: "allow ",
						label: "allow <rule>",
						description: "Save an allow rule, e.g. Bash(npm test:*) [--project]",
					},
					{
						value: "ask ",
						label: "ask <rule>",
						description: "Save an ask rule, e.g. Bash(git push:*) [--project]",
					},
					{
						value: "deny ",
						label: "deny <rule>",
						description: "Save a deny rule (every mode), e.g. Read(.env) [--project]",
					},
				];
				return createFuzzyAutocompleteItems(
					items,
					prefix,
					(item) => item.value,
					(item) => item,
				);
			};
		}

		const thinkingCommand = slashCommands.find((command) => command.name === "thinking");
		if (thinkingCommand) {
			thinkingCommand.getArgumentCompletions = (prefix: string): AutocompleteItem[] | null => {
				return createFuzzyAutocompleteItems(
					this.session.getAvailableThinkingLevels(),
					prefix,
					(level) => level,
					(level) => ({
						value: level,
						label: level,
					}),
				);
			};
		}

		// Convert prompt templates to SlashCommand format for autocomplete
		const templateCommands: SlashCommand[] = this.session.promptTemplates.map((cmd) => ({
			name: cmd.name,
			description: this.prefixAutocompleteDescription(cmd.description, cmd.sourceInfo),
			...(cmd.argumentHint && { argumentHint: cmd.argumentHint }),
		}));

		// Convert extension commands to SlashCommand format
		const builtinCommandNames = new Set(slashCommands.map((c) => c.name));
		const extensionCommands: SlashCommand[] = this.session.extensionRunner
			.getRegisteredCommands()
			.filter((cmd) => !builtinCommandNames.has(cmd.name))
			.map((cmd) => ({
				name: cmd.invocationName,
				description: this.prefixAutocompleteDescription(cmd.description, cmd.sourceInfo),
				getArgumentCompletions: cmd.getArgumentCompletions,
			}));

		// Build skill commands from session.skills (if enabled)
		this.skillCommands.clear();
		const skillCommandList: SlashCommand[] = [];
		if (this.settingsManager.getEnableSkillCommands()) {
			for (const skill of this.session.resourceLoader.getSkills().skills) {
				const commandName = `skill:${skill.name}`;
				this.skillCommands.set(commandName, skill.filePath);
				skillCommandList.push({
					name: commandName,
					description: this.prefixAutocompleteDescription(skill.description, skill.sourceInfo),
				});
			}
		}

		return new CombinedAutocompleteProvider(
			[...slashCommands, ...templateCommands, ...extensionCommands, ...skillCommandList],
			this.sessionManager.getCwd(),
			this.fdPath,
		);
	}

	private setupAutocompleteProvider(): void {
		let provider = this.createBaseAutocompleteProvider();
		const triggerCharacters: string[] = [];
		for (const wrapProvider of this.autocompleteProviderWrappers) {
			provider = wrapProvider(provider);
			triggerCharacters.push(...(provider.triggerCharacters ?? []));
		}
		if (triggerCharacters.length > 0) {
			provider.triggerCharacters = [...new Set(triggerCharacters)];
		}

		this.autocompleteProvider = provider;
		this.defaultEditor.setAutocompleteProvider(provider);
		if (this.editor !== this.defaultEditor) {
			this.editor.setAutocompleteProvider?.(provider);
		}
	}

	private showStartupNoticesIfNeeded(): void {
		if (this.startupNoticesShown) {
			return;
		}
		this.startupNoticesShown = true;

		if (!this.changelogMarkdown) {
			return;
		}

		if (this.chatContainer.children.length > 0) {
			this.chatContainer.addChild(new Spacer(1));
		}
		this.chatContainer.addChild(new DynamicBorder());
		if (this.settingsManager.getCollapseChangelog()) {
			const versionMatch = this.changelogMarkdown.match(/##\s+\[?(\d+\.\d+\.\d+)\]?/);
			const latestVersion = versionMatch ? versionMatch[1] : this.version;
			const condensedText = `Updated to v${latestVersion}. Use ${theme.bold("/changelog")} to view full changelog.`;
			this.chatContainer.addChild(new Text(condensedText, 1, 0));
		} else {
			this.chatContainer.addChild(new ThemedText(() => theme.bold(theme.fg("accent", "What's New")), 1, 0));
			this.chatContainer.addChild(new Spacer(1));
			this.chatContainer.addChild(
				new Markdown(this.changelogMarkdown.trim(), 1, 0, this.getMarkdownThemeWithSettings()),
			);
			this.chatContainer.addChild(new Spacer(1));
		}
		this.chatContainer.addChild(new DynamicBorder());
	}

	private mountInteractiveTui(tui: TuiMainScreen | TuiAltScreen, components: readonly Component[]): void {
		for (const component of components) tui.addChild(component);
		if (TuiLayouts.isViewportTUI(tui)) {
			if (!this.fullscreenLayoutRoot) throw new Error("Fullscreen layout is not initialized");
			tui.setLayoutRoot(this.fullscreenLayoutRoot);
		}
	}

	private stopInteractiveTui(fullscreenExitOutput: FullscreenExitOutput): void {
		if (this.renderer.mode === "fullscreen" && fullscreenExitOutput === "transcript") {
			while (this.renderer.hasOverlayEntries) this.renderer.hideOverlay();
			this.switchTuiMode("regular", false, false);
			this.renderer.renderNow();
		}
		this.ui.stop({ preserveScreen: this.renderer.mode === "fullscreen" });
	}

	private switchTuiMode(mode: TuiMode, restoreProgress = true, startRenderer = true): boolean {
		const previousUi = this.renderer;
		if (mode === previousUi.mode) return true;
		if (previousUi.hasOverlayEntries) return false;

		const components = [...previousUi.children];
		const focus = previousUi.getFocusedComponent();
		const terminal = previousUi.terminal;
		const showHardwareCursor = previousUi.getShowHardwareCursor();
		const clearOnShrink = previousUi.getClearOnShrink();
		const onDebug = previousUi.onDebug;
		if (previousUi instanceof TuiMainScreen) {
			this.mainScreenRenderState = previousUi.captureRenderState();
		}

		previousUi.stop({ preserveScreen: true });
		previousUi.setFocus(null);
		previousUi.clear();
		if (TuiLayouts.isViewportTUI(previousUi)) previousUi.setLayoutRoot(undefined);

		const nextUi = createInteractiveTui({
			tuiMode: mode,
			showHardwareCursor,
			logDirectory: getAgentDir(),
			terminal,
			onRightClickPaste: this.onRightClickPaste,
			fullscreenCopyOnSelect: this.settingsManager.getFullscreenCopyOnSelect(),
			fullscreenWheelScrollLines: this.settingsManager.getFullscreenWheelScrollLines(),
			...this.clickTuiOptions(),
		});
		nextUi.setClearOnShrink(clearOnShrink);
		nextUi.onDebug = onDebug;
		if (nextUi instanceof TuiMainScreen && this.mainScreenRenderState) {
			nextUi.restoreRenderState(this.mainScreenRenderState);
		}
		this.renderer = nextUi;
		this.options.tuiMode = mode;
		this.mountInteractiveTui(nextUi, components);
		nextUi.invalidate();
		nextUi.setFocus(focus);
		if (!startRenderer) return true;
		nextUi.start();
		this.themeController.rebindTui();
		this.rebindExtensionTerminalInputListeners();
		if (
			restoreProgress &&
			this.settingsManager.getShowTerminalProgress() &&
			(this.session.isStreaming || this.session.isCompacting)
		) {
			terminal.setProgress(true);
		}
		return true;
	}

	async init(): Promise<void> {
		if (this.isInitialized) return;

		this.registerSignalHandlers();

		// Load changelog (only show new entries, skip for resumed sessions)
		this.changelogMarkdown = this.getChangelogForDisplay();

		if (this.session.scopedModels.length > 0 && this.shouldShowStartupDetails()) {
			const modelList = this.session.scopedModels
				.map((sm) => {
					const thinkingStr = sm.thinkingLevel ? `:${sm.thinkingLevel}` : "";
					return `${sm.model.id}${thinkingStr}`;
				})
				.join(", ");
			const cycleKeys = this.keybindings.getKeys("app.model.cycleForward");
			const cycleHint =
				cycleKeys.length > 0
					? theme.fg("muted", ` (${formatKeyText(cycleKeys.join("/"), { capitalize: true })} to cycle)`)
					: "";
			console.log(theme.fg("dim", `Model scope: ${modelList}${cycleHint}`));
		}

		this.applyTranscriptDisplaySettings();
		AssistantMessageComponent.onCopyCode = (code) => this.copyCodeBlock(code);
		// Keep one component tree and remount it when changing renderers.
		this.renderWidgets(); // Initialize with default spacer
		const viewport = createChatViewport({
			document: this.documentContainer,
			pendingMessages: this.pendingMessagesContainer,
			status: this.statusContainer,
			widgetsAbove: this.widgetContainerAbove,
			editor: this.editorContainer,
			hints: this.keyHintContainer,
			widgetsBelow: this.widgetContainerBelow,
			footer: this.footerContainer,
			scrollbar: this.settingsManager.getFullscreenScrollbar(),
			scrollbarTrackStyle: (text) => theme.fg("scrollbarTrack", text),
			scrollbarThumbStyle: (text) => theme.fg("scrollbarThumb", text),
		});
		this.transcriptScrollView = viewport.transcript;
		this.fullscreenLayoutRoot = viewport.root;
		this.mountInteractiveTui(this.renderer, [
			this.documentContainer,
			this.pendingMessagesContainer,
			this.statusContainer,
			this.widgetContainerAbove,
			this.editorContainer,
			this.keyHintContainer,
			this.widgetContainerBelow,
			this.footerContainer,
		]);
		// Accept text while startup completes, but only enable interrupt, exit, and submission feedback.
		this.defaultEditor.onAction("app.clear", () => this.handleCtrlC());
		this.defaultEditor.onCtrlD = () => this.handleCtrlD();
		this.defaultEditor.onSubmit = (text) => this.handleStartupSubmit(text);
		this.ui.setFocus(this.editor);

		// Start the UI before initializing extensions so session_start handlers can use interactive dialogs
		// Focus reports tell notifications whether the user is looking at this terminal.
		this.ui.setFocusReporting?.(this.settingsManager.getNotificationsMode() !== "off");
		this.ui.start();
		this.isInitialized = true;
		this.programStatus.report();
		this.ensurePngTranscoder();

		this.themeController.applyFromSettings();
		// The header and startup notices bake theme colors into their text, so build them once the terminal
		// reported its colors. This ends at the terminal's DA1 reply, or after 100 ms if it answers nothing.
		await this.themeController.waitForTerminalColors();

		// Add header with keybindings from config (unless silenced)
		if (this.shouldShowStartupHeader()) {
			const showDetails = this.shouldShowStartupDetails();
			// Built on demand so the header follows theme changes. The RK banner is plain-text block art
			// (5 lines) with the name and version beside it; the key hints follow below it.
			const withLogo = (hints: string) => `${rkBannerLines(this.version).join("\n")}\n\n${hints}`;

			// Build startup instructions using keybinding hint helpers
			const hint = (keybinding: AppKeybinding, description: string) => keyHint(keybinding, description);

			const expandedInstructions = () =>
				[
					hint("app.interrupt", "to interrupt"),
					hint("app.clear", "to clear"),
					rawKeyHint(`${keyText("app.clear")} twice`, "to exit"),
					hint("app.exit", "to exit (empty)"),
					hint("app.suspend", "to suspend"),
					keyHint("tui.editor.deleteToLineEnd", "to delete to end"),
					hint("app.thinking.cycle", "to cycle thinking level"),
					hint("app.permissions.cycle", "to cycle permissions"),
					rawKeyHint(
						`${keyText("app.model.cycleForward")}/${keyText("app.model.cycleBackward")}`,
						"to cycle models",
					),
					hint("app.model.select", "to select model"),
					hint("app.router.cycleMode", "to cycle auto:low/medium/high"),
					hint("app.tools.expand", "to expand tools"),
					hint("app.thinking.toggle", "to expand thinking"),
					hint("app.editor.external", "for external editor"),
					rawKeyHint("/", "for commands"),
					rawKeyHint("!", "to run bash"),
					rawKeyHint("!!", "to run bash (no context)"),
					hint("app.message.followUp", "to queue follow-up"),
					hint("app.message.dequeue", "to edit all queued messages"),
					hint("app.clipboard.pasteImage", "to attach a clipboard image (or paste files and text)"),
					rawKeyHint("drop files", "to attach"),
				].join("\n");
			const compactInstructions = () =>
				[
					hint("app.interrupt", "interrupt"),
					rawKeyHint(`${keyText("app.clear")}/${keyText("app.exit")}`, "clear/exit"),
					rawKeyHint("/", "commands"),
					rawKeyHint("@", "files"),
					rawKeyHint("!", "bash"),
					hint("app.permissions.cycle", "permissions"),
					hint("app.tools.expand", "more"),
				].join(theme.fg("muted", " - "));
			const compactOnboarding = () =>
				theme.fg(
					"dim",
					`Press ${keyText("app.tools.expand")} to show full startup help${showDetails ? " and loaded resources" : ""}.`,
				);
			// RunKiln's own onboarding line (replaces the upstream "Pi can explain its own features" hint).
			const onboarding = () => theme.fg("dim", runkilnOnboardingLine(keyText("app.router.cycleMode")));
			const header = new BuiltInHeader(
				() => `${withLogo(compactInstructions())}\n${compactOnboarding()}\n\n${onboarding()}`,
				() => `${withLogo(expandedInstructions())}\n\n${onboarding()}`,
				this.getStartupExpansionState(),
				1,
				0,
			);
			this.builtInHeader = header;

			// Setup UI layout
			this.headerContainer.addChild(new Spacer(1));
			this.headerContainer.addChild(this.builtInHeader);
			this.headerContainer.addChild(new Spacer(1));
		} else {
			// Minimal header when silenced
			this.builtInHeader = new Text("", 0, 0);
			this.headerContainer.addChild(this.builtInHeader);
		}
		this.ui.requestRender();

		// Ensure fd and rg are available after mounting the TUI (downloads if missing, adds to PATH via getBinDir)
		// so slow downloads do not make startup appear frozen.
		// Both are needed: fd for autocomplete, rg for grep tool and bash commands.
		const [fdPath] = await Promise.all([
			ensureTool("fd", (status) => this.showManagedToolStatus(status)),
			ensureTool("rg", (status) => this.showManagedToolStatus(status)),
		]);
		this.fdPath = fdPath;

		// Enable the remaining input handlers only after managed-tool setup completes.
		this.setupKeyHandlers();
		this.setupEditorSubmitHandler();
		this.ui.requestRender();

		// Initialize extensions first so resources are shown before messages
		await this.rebindCurrentSession();

		// Render initial messages AFTER showing loaded resources
		this.renderInitialMessages();

		// Set up theme file watcher
		onThemeChange(() => {
			this.ui.invalidate();
			this.updateEditorBorderColor();
			this.ui.requestRender();
		});

		// Set up git branch watcher (uses provider instead of footer)
		this.footerDataProvider.onBranchChange(() => {
			this.ui.requestRender();
		});

		// Initialize available provider count for footer display
		await this.updateAvailableProviderCount();

		// Flush the completed startup state before loading the remaining syntax grammars.
		this.ui.renderNow();
		void loadAllHighlightLanguages().then(() => {
			if (!this.isInitialized) return;
			this.ui.invalidate();
			this.ui.requestRender();
		});
	}

	/**
	 * Update terminal title with session name and cwd.
	 */
	private updateTerminalTitle(): void {
		if (this.extensionTitle) return;
		const cwdBasename = path.basename(this.sessionManager.getCwd());
		if (this.settingsManager.getDynamicTitle()) {
			this.terminalTitle.set(formatTerminalTitle(APP_TITLE, cwdBasename, this.titleStatus));
			return;
		}
		this.terminalTitle.restore();
		const sessionName = this.sessionManager.getSessionName();
		if (sessionName) {
			this.ui.terminal.setTitle(`${APP_TITLE} - ${sessionName} - ${cwdBasename}`);
		} else {
			this.ui.terminal.setTitle(`${APP_TITLE} - ${cwdBasename}`);
		}
	}

	/**
	 * Run the interactive mode. This is the main entry point.
	 * Initializes the UI, shows warnings, processes initial messages, and starts the interactive loop.
	 */
	async run(): Promise<void> {
		await this.init();

		// Check tmux keyboard setup asynchronously
		this.checkTmuxKeyboardSetup().then((warning) => {
			if (warning) {
				this.showWarning(warning);
			}
		});

		// Show startup warnings
		const {
			migratedProviders,
			startupDiagnostics,
			modelFallbackMessage,
			initialMessage,
			initialImages,
			initialMessages,
		} = this.options;

		for (const diagnostic of startupDiagnostics ?? []) {
			if (diagnostic.type === "error") {
				this.showError(diagnostic.message);
			} else if (diagnostic.type === "warning") {
				this.showWarning(diagnostic.message);
			} else {
				this.showStatus(diagnostic.message);
			}
		}

		if (migratedProviders && migratedProviders.length > 0) {
			this.showWarning(`Migrated credentials to auth.json: ${migratedProviders.join(", ")}`);
		}

		const modelsJsonError = this.session.modelRuntime.getError();
		if (modelsJsonError) {
			this.showError(`models.json error: ${modelsJsonError}`);
		}

		if (modelFallbackMessage) {
			this.showWarning(modelFallbackMessage);
		}

		if (this.options.setupNotice) {
			this.showStatus(this.options.setupNotice);
		}

		const crash = takeUnnotifiedCrash();
		if (crash) {
			const when = new Date(crash.timestamp).toLocaleString();
			this.showWarning(
				`${APP_NAME} crashed on ${when} (${crash.message}). Run /bug to report it; the crash details are attached automatically.`,
			);
		}

		void this.maybeWarnAboutAnthropicSubscriptionAuth();

		// Process initial messages
		if (initialMessage) {
			try {
				await this.session.prompt(initialMessage, { images: initialImages });
			} catch (error: unknown) {
				const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
				this.showError(errorMessage);
			}
		}

		if (initialMessages) {
			for (const message of initialMessages) {
				try {
					await this.session.prompt(message);
				} catch (error: unknown) {
					const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
					this.showError(errorMessage);
				}
			}
		}

		// Main interactive loop
		while (true) {
			const userInput = await this.getUserInput();
			try {
				await this.session.prompt(userInput, { images: this.takePromptImages(userInput) });
			} catch (error: unknown) {
				const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
				this.showError(errorMessage);
			}
		}
	}

	private async checkTmuxKeyboardSetup(): Promise<string | undefined> {
		if (!process.env.TMUX) return undefined;

		const runTmuxShow = (option: string): Promise<string | undefined> => {
			return new Promise((resolve) => {
				const proc = spawn("tmux", ["show", "-gv", option], {
					stdio: ["ignore", "pipe", "ignore"],
				});
				let stdout = "";
				const timer = setTimeout(() => {
					proc.kill();
					resolve(undefined);
				}, 2000);

				proc.stdout?.on("data", (data) => {
					stdout += data.toString();
				});
				proc.on("error", () => {
					clearTimeout(timer);
					resolve(undefined);
				});
				proc.on("close", (code) => {
					clearTimeout(timer);
					resolve(code === 0 ? stdout.trim() : undefined);
				});
			});
		};

		const [extendedKeys, extendedKeysFormat] = await Promise.all([
			runTmuxShow("extended-keys"),
			runTmuxShow("extended-keys-format"),
		]);

		// If we couldn't query tmux (timeout, sandbox, etc.), don't warn
		if (extendedKeys === undefined) return undefined;

		if (extendedKeys !== "on" && extendedKeys !== "always") {
			return "tmux extended-keys is off. Modified Enter keys may not work. Add `set -g extended-keys on` to ~/.tmux.conf and restart tmux.";
		}

		if (extendedKeysFormat === "xterm") {
			return "tmux extended-keys-format is xterm. RunKiln works best with csi-u. Add `set -g extended-keys-format csi-u` to ~/.tmux.conf and restart tmux.";
		}

		return undefined;
	}

	/** RunKiln does not show a changelog on startup. */
	private getChangelogForDisplay(): string | undefined {
		return undefined;
	}

	private getMarkdownThemeWithSettings(): MarkdownTheme {
		return {
			...getMarkdownTheme(),
			codeBlockIndent: this.settingsManager.getCodeBlockIndent(),
		};
	}

	/** Assistant text: prose wraps at `ui.maxProseWidth` on wide terminals; code blocks keep the full width. */
	private getAssistantMarkdownTheme(): MarkdownTheme {
		const maxProseWidth = this.settingsManager.getMaxProseWidth();
		return maxProseWidth > 0
			? { ...this.getMarkdownThemeWithSettings(), maxProseWidth }
			: this.getMarkdownThemeWithSettings();
	}

	// =========================================================================
	// Extension System
	// =========================================================================

	private formatDisplayPath(p: string): string {
		const home = os.homedir();
		let result = p;

		// Replace home directory with ~
		if (result.startsWith(home)) {
			result = `~${result.slice(home.length)}`;
		}

		return result;
	}

	private formatExtensionDisplayPath(path: string): string {
		let result = this.formatDisplayPath(path);
		result = result.replace(/\/index\.ts$/, "").replace(/\/index\.js$/, "");
		return result;
	}

	private formatContextPath(p: string): string {
		const cwd = path.resolve(this.sessionManager.getCwd());
		const absolutePath = path.isAbsolute(p) ? path.resolve(p) : path.resolve(cwd, p);
		const relativePath = getCwdRelativePath(absolutePath, cwd);
		if (relativePath !== undefined) {
			return relativePath;
		}

		return this.formatDisplayPath(absolutePath);
	}

	private getStartupExpansionState(): boolean {
		return this.options.verbose || this.toolOutputExpanded;
	}

	/** Startup header (logo, version, key hints). Hidden only by quietStartup: true. */
	private shouldShowStartupHeader(): boolean {
		return this.options.verbose === true || this.settingsManager.getQuietStartup() !== true;
	}

	/** Startup details (model scope, loaded resources). Hidden by quietStartup: true or "header". */
	private shouldShowStartupDetails(): boolean {
		return this.options.verbose === true || this.settingsManager.getQuietStartup() === false;
	}

	/**
	 * Get a short path relative to the package root for display.
	 */
	private getShortPath(fullPath: string, sourceInfo?: SourceInfo): string {
		const normalizedFullPath = fullPath.replace(/\\/g, "/");
		const baseDir = sourceInfo?.baseDir;
		if (baseDir && this.isPackageSource(sourceInfo)) {
			const normalizedBaseDir = baseDir.replace(/\\/g, "/");
			const npmRootMatch = normalizedBaseDir.match(/^(.*\/node_modules)\/(@?[^/]+(?:\/[^/]+)?)$/);
			// If fullPath is under the same node_modules root as baseDir, preserve that relative topology.
			if (npmRootMatch?.[1] && normalizedFullPath.startsWith(`${npmRootMatch[1]}/`)) {
				return path.posix.relative(normalizedBaseDir, normalizedFullPath);
			}

			const relativePath = path.relative(path.resolve(baseDir), path.resolve(fullPath));
			if (
				relativePath &&
				relativePath !== "." &&
				!relativePath.startsWith("..") &&
				!relativePath.startsWith(`..${path.sep}`) &&
				!path.isAbsolute(relativePath)
			) {
				return relativePath.replace(/\\/g, "/");
			}
		}

		const source = sourceInfo?.source ?? "";
		const npmMatch = normalizedFullPath.match(/node_modules\/(@?[^/]+(?:\/[^/]+)?)\/(.*)/);
		if (npmMatch && source.startsWith("npm:")) {
			return npmMatch[2];
		}

		const gitMatch = normalizedFullPath.match(/git\/[^/]+\/[^/]+\/(.*)/);
		if (gitMatch && source.startsWith("git:")) {
			return gitMatch[1];
		}

		return this.formatDisplayPath(fullPath);
	}

	private getCompactPathLabel(resourcePath: string, sourceInfo?: SourceInfo): string {
		const shortPath = this.getShortPath(resourcePath, sourceInfo);
		const normalizedPath = shortPath.replace(/\\/g, "/");
		const segments = normalizedPath.split("/").filter((segment) => segment.length > 0 && segment !== "~");
		if (segments.length > 0) {
			return segments[segments.length - 1]!;
		}
		return shortPath;
	}

	private getCompactPackageSourceLabel(sourceInfo?: SourceInfo): string {
		const source = sourceInfo?.source ?? "";
		if (source.startsWith("npm:")) {
			return source.slice("npm:".length) || source;
		}

		const gitSource = parseGitUrl(source);
		if (gitSource) {
			return gitSource.path || source;
		}

		return source;
	}

	private getCompactExtensionLabel(resourcePath: string, sourceInfo?: SourceInfo): string {
		if (!this.isPackageSource(sourceInfo)) {
			return this.getCompactPathLabel(resourcePath, sourceInfo);
		}

		const sourceLabel = this.getCompactPackageSourceLabel(sourceInfo);
		if (!sourceLabel) {
			return this.getCompactPathLabel(resourcePath, sourceInfo);
		}

		const shortPath = this.getShortPath(resourcePath, sourceInfo).replace(/\\/g, "/");
		const packagePath = shortPath.startsWith("extensions/") ? shortPath.slice("extensions/".length) : shortPath;
		const parsedPath = path.posix.parse(packagePath);

		if (parsedPath.name === "index") {
			return !parsedPath.dir || parsedPath.dir === "." ? sourceLabel : `${sourceLabel}:${parsedPath.dir}`;
		}

		return `${sourceLabel}:${packagePath}`;
	}

	private getCompactDisplayPathSegments(resourcePath: string): string[] {
		return this.formatDisplayPath(resourcePath)
			.replace(/\\/g, "/")
			.split("/")
			.filter((segment) => segment.length > 0 && segment !== "~");
	}

	private getCompactNonPackageExtensionLabel(
		resourcePath: string,
		index: number,
		allPaths: Array<{ path: string; segments: string[] }>,
	): string {
		const segments = allPaths[index]?.segments;
		if (!segments || segments.length === 0) {
			return this.getCompactPathLabel(resourcePath);
		}

		for (let segmentCount = 1; segmentCount <= segments.length; segmentCount += 1) {
			const candidate = segments.slice(-segmentCount).join("/");
			const isUnique = allPaths.every((item, itemIndex) => {
				if (itemIndex === index) {
					return true;
				}
				return item.segments.slice(-segmentCount).join("/") !== candidate;
			});

			if (isUnique) {
				return candidate;
			}
		}

		return segments.join("/");
	}

	private getCompactExtensionLabels(extensions: Array<{ path: string; sourceInfo?: SourceInfo }>): string[] {
		const nonPackageExtensions = extensions
			.map((extension) => {
				const segments = this.getCompactDisplayPathSegments(extension.path);
				const lastSegment = segments[segments.length - 1];
				if (segments.length > 1 && (lastSegment === "index.ts" || lastSegment === "index.js")) {
					segments.pop();
				}
				return {
					path: extension.path,
					sourceInfo: extension.sourceInfo,
					segments,
				};
			})
			.filter((extension) => !this.isPackageSource(extension.sourceInfo));

		return extensions.map((extension) => {
			if (this.isPackageSource(extension.sourceInfo)) {
				return this.getCompactExtensionLabel(extension.path, extension.sourceInfo);
			}

			const nonPackageIndex = nonPackageExtensions.findIndex((item) => item.path === extension.path);
			if (nonPackageIndex === -1) {
				return this.getCompactPathLabel(extension.path, extension.sourceInfo);
			}

			return this.getCompactNonPackageExtensionLabel(extension.path, nonPackageIndex, nonPackageExtensions);
		});
	}

	private getDisplaySourceInfo(sourceInfo?: SourceInfo): {
		label: string;
		scopeLabel?: string;
		color: "accent" | "muted";
	} {
		const source = sourceInfo?.source ?? "local";
		const scope = sourceInfo?.scope ?? "project";
		if (source === "local") {
			if (scope === "user") {
				return { label: "user", color: "muted" };
			}
			if (scope === "project") {
				return { label: "project", color: "muted" };
			}
			if (scope === "temporary") {
				return { label: "path", scopeLabel: "temp", color: "muted" };
			}
			return { label: "path", color: "muted" };
		}

		if (source === "cli") {
			return { label: "path", scopeLabel: scope === "temporary" ? "temp" : undefined, color: "muted" };
		}

		const scopeLabel =
			scope === "user" ? "user" : scope === "project" ? "project" : scope === "temporary" ? "temp" : undefined;
		return { label: source, scopeLabel, color: "accent" };
	}

	private getScopeGroup(sourceInfo?: SourceInfo): "user" | "project" | "path" {
		const source = sourceInfo?.source ?? "local";
		const scope = sourceInfo?.scope ?? "project";
		if (source === "cli" || scope === "temporary") return "path";
		if (scope === "user") return "user";
		if (scope === "project") return "project";
		return "path";
	}

	private isPackageSource(sourceInfo?: SourceInfo): boolean {
		const source = sourceInfo?.source ?? "";
		return source.startsWith("npm:") || source.startsWith("git:");
	}

	private buildScopeGroups(items: Array<{ path: string; sourceInfo?: SourceInfo }>): Array<{
		scope: "user" | "project" | "path";
		paths: Array<{ path: string; sourceInfo?: SourceInfo }>;
		packages: Map<string, Array<{ path: string; sourceInfo?: SourceInfo }>>;
	}> {
		const groups: Record<
			"user" | "project" | "path",
			{
				scope: "user" | "project" | "path";
				paths: Array<{ path: string; sourceInfo?: SourceInfo }>;
				packages: Map<string, Array<{ path: string; sourceInfo?: SourceInfo }>>;
			}
		> = {
			user: { scope: "user", paths: [], packages: new Map() },
			project: { scope: "project", paths: [], packages: new Map() },
			path: { scope: "path", paths: [], packages: new Map() },
		};

		for (const item of items) {
			const groupKey = this.getScopeGroup(item.sourceInfo);
			const group = groups[groupKey];
			const source = item.sourceInfo?.source ?? "local";

			if (this.isPackageSource(item.sourceInfo)) {
				const list = group.packages.get(source) ?? [];
				list.push(item);
				group.packages.set(source, list);
			} else {
				group.paths.push(item);
			}
		}

		return [groups.project, groups.user, groups.path].filter(
			(group) => group.paths.length > 0 || group.packages.size > 0,
		);
	}

	private formatScopeGroups(
		groups: Array<{
			scope: "user" | "project" | "path";
			paths: Array<{ path: string; sourceInfo?: SourceInfo }>;
			packages: Map<string, Array<{ path: string; sourceInfo?: SourceInfo }>>;
		}>,
		options: {
			formatPath: (item: { path: string; sourceInfo?: SourceInfo }) => string;
			formatPackagePath: (item: { path: string; sourceInfo?: SourceInfo }, source: string) => string;
		},
	): string {
		const lines: string[] = [];

		for (const group of groups) {
			lines.push(`  ${theme.fg("accent", group.scope)}`);

			const sortedPaths = [...group.paths].sort((a, b) => a.path.localeCompare(b.path));
			for (const item of sortedPaths) {
				lines.push(theme.fg("dim", `    ${options.formatPath(item)}`));
			}

			const sortedPackages = Array.from(group.packages.entries()).sort(([a], [b]) => a.localeCompare(b));
			for (const [source, items] of sortedPackages) {
				lines.push(`    ${theme.fg("mdLink", source)}`);
				const sortedPackagePaths = [...items].sort((a, b) => a.path.localeCompare(b.path));
				for (const item of sortedPackagePaths) {
					lines.push(theme.fg("dim", `      ${options.formatPackagePath(item, source)}`));
				}
			}
		}

		return lines.join("\n");
	}

	private findSourceInfoForPath(p: string, sourceInfos: Map<string, SourceInfo>): SourceInfo | undefined {
		const exact = sourceInfos.get(p);
		if (exact) return exact;

		let current = p;
		while (current.includes("/")) {
			current = current.substring(0, current.lastIndexOf("/"));
			const parent = sourceInfos.get(current);
			if (parent) return parent;
		}

		return undefined;
	}

	private formatPathWithSource(p: string, sourceInfo?: SourceInfo): string {
		if (sourceInfo) {
			const shortPath = this.getShortPath(p, sourceInfo);
			const { label, scopeLabel } = this.getDisplaySourceInfo(sourceInfo);
			const labelText = scopeLabel ? `${label} (${scopeLabel})` : label;
			return `${labelText} ${shortPath}`;
		}
		return this.formatDisplayPath(p);
	}

	private formatDiagnostics(diagnostics: readonly ResourceDiagnostic[], sourceInfos: Map<string, SourceInfo>): string {
		const lines: string[] = [];

		// Group collision diagnostics by name
		const collisions = new Map<string, ResourceDiagnostic[]>();
		const otherDiagnostics: ResourceDiagnostic[] = [];

		for (const d of diagnostics) {
			if (d.type === "collision" && d.collision) {
				const list = collisions.get(d.collision.name) ?? [];
				list.push(d);
				collisions.set(d.collision.name, list);
			} else {
				otherDiagnostics.push(d);
			}
		}

		// Format collision diagnostics grouped by name
		for (const [name, collisionList] of collisions) {
			const first = collisionList[0]?.collision;
			if (!first) continue;
			lines.push(theme.fg("warning", `  "${name}" collision:`));
			lines.push(
				theme.fg(
					"dim",
					`    ${theme.fg("success", "✓")} ${this.formatPathWithSource(first.winnerPath, this.findSourceInfoForPath(first.winnerPath, sourceInfos))}`,
				),
			);
			for (const d of collisionList) {
				if (d.collision) {
					lines.push(
						theme.fg(
							"dim",
							`    ${theme.fg("warning", "✗")} ${this.formatPathWithSource(d.collision.loserPath, this.findSourceInfoForPath(d.collision.loserPath, sourceInfos))} (skipped)`,
						),
					);
				}
			}
		}

		for (const d of otherDiagnostics) {
			if (d.path) {
				const formattedPath = this.formatPathWithSource(d.path, this.findSourceInfoForPath(d.path, sourceInfos));
				lines.push(theme.fg(d.type === "error" ? "error" : "warning", `  ${formattedPath}`));
				lines.push(theme.fg(d.type === "error" ? "error" : "warning", `    ${d.message}`));
			} else {
				lines.push(theme.fg(d.type === "error" ? "error" : "warning", `  ${d.message}`));
			}
		}

		return lines.join("\n");
	}

	private showLoadedResources(options?: {
		extensions?: Array<{ path: string; sourceInfo?: SourceInfo }>;
		force?: boolean;
		showDiagnosticsWhenQuiet?: boolean;
	}): void {
		// Resource rendering is idempotent; chat clears no longer clear this separate container.
		this.loadedResourcesContainer.clear();

		const showListing = options?.force || this.shouldShowStartupDetails();
		const showDiagnostics = showListing || options?.showDiagnosticsWhenQuiet === true;
		if (!showListing && !showDiagnostics) {
			return;
		}

		const sectionHeader = (name: string, color: ThemeColor = "mdHeading") => theme.fg(color, `[${name}]`);
		const formatCompactList = (items: string[], options?: { sort?: boolean }): string => {
			const labels = items.map((item) => item.trim()).filter((item) => item.length > 0);
			if (options?.sort !== false) {
				labels.sort((a, b) => a.localeCompare(b));
			}
			return theme.fg("dim", `  ${labels.join(", ")}`);
		};
		// Bodies are built on demand so the listing follows theme changes.
		const addLoadedSection = (
			name: string,
			collapsedBody: () => string,
			expandedBody = collapsedBody,
			color: ThemeColor = "mdHeading",
		): void => {
			const section = new ExpandableText(
				() => `${sectionHeader(name, color)}\n${collapsedBody()}`,
				() => `${sectionHeader(name, color)}\n${expandedBody()}`,
				this.getStartupExpansionState(),
				0,
				0,
			);
			this.loadedResourcesContainer.addChild(section);
			this.loadedResourcesContainer.addChild(new Spacer(1));
		};

		const skillsResult = this.session.resourceLoader.getSkills();
		const promptsResult = this.session.resourceLoader.getPrompts();
		const themesResult = this.session.resourceLoader.getThemes();
		const extensions =
			options?.extensions ??
			this.session.resourceLoader
				.getExtensions()
				.extensions.filter((extension) => !extension.hidden)
				.map((extension) => ({
					path: extension.path,
					sourceInfo: extension.sourceInfo,
				}));
		const sourceInfos = new Map<string, SourceInfo>();
		for (const extension of extensions) {
			if (extension.sourceInfo) {
				sourceInfos.set(extension.path, extension.sourceInfo);
			}
		}
		for (const skill of skillsResult.skills) {
			if (skill.sourceInfo) {
				sourceInfos.set(skill.filePath, skill.sourceInfo);
			}
		}
		for (const prompt of promptsResult.prompts) {
			if (prompt.sourceInfo) {
				sourceInfos.set(prompt.filePath, prompt.sourceInfo);
			}
		}
		for (const loadedTheme of themesResult.themes) {
			if (loadedTheme.sourcePath && loadedTheme.sourceInfo) {
				sourceInfos.set(loadedTheme.sourcePath, loadedTheme.sourceInfo);
			}
		}

		if (showListing) {
			const systemPromptSource = this.session.resourceLoader.getSystemPromptSource();
			const contextFiles = [
				...(systemPromptSource ? [systemPromptSource] : []),
				...this.session.resourceLoader.getAppendSystemPromptSources(),
				...this.session.resourceLoader.getAgentsFiles().agentsFiles,
			];
			if (contextFiles.length > 0) {
				this.loadedResourcesContainer.addChild(new Spacer(1));
				const contextList = () =>
					contextFiles.map((f) => theme.fg("dim", `  ${this.formatDisplayPath(f.path)}`)).join("\n");
				const contextCompactList = () =>
					formatCompactList(
						contextFiles.map((contextFile) => this.formatContextPath(contextFile.path)),
						{ sort: false },
					);
				addLoadedSection("Context", contextCompactList, contextList);
			}

			const skills = skillsResult.skills;
			if (skills.length > 0) {
				const groups = this.buildScopeGroups(
					skills.map((skill) => ({ path: skill.filePath, sourceInfo: skill.sourceInfo })),
				);
				const skillList = () =>
					this.formatScopeGroups(groups, {
						formatPath: (item) => this.formatDisplayPath(item.path),
						formatPackagePath: (item) => this.getShortPath(item.path, item.sourceInfo),
					});
				const skillCompactList = () => formatCompactList(skills.map((skill) => skill.name));
				addLoadedSection("Skills", skillCompactList, skillList);
			}

			const templates = this.session.promptTemplates;
			if (templates.length > 0) {
				const groups = this.buildScopeGroups(
					templates.map((template) => ({ path: template.filePath, sourceInfo: template.sourceInfo })),
				);
				const templateByPath = new Map(templates.map((t) => [t.filePath, t]));
				const templateList = () =>
					this.formatScopeGroups(groups, {
						formatPath: (item) => {
							const template = templateByPath.get(item.path);
							return template ? `/${template.name}` : this.formatDisplayPath(item.path);
						},
						formatPackagePath: (item) => {
							const template = templateByPath.get(item.path);
							return template ? `/${template.name}` : this.formatDisplayPath(item.path);
						},
					});
				const promptCompactList = () => formatCompactList(templates.map((template) => `/${template.name}`));
				addLoadedSection("Prompts", promptCompactList, templateList);
			}

			if (extensions.length > 0) {
				const groups = this.buildScopeGroups(extensions);
				const extList = () =>
					this.formatScopeGroups(groups, {
						formatPath: (item) => this.formatExtensionDisplayPath(item.path),
						formatPackagePath: (item) =>
							this.formatExtensionDisplayPath(this.getShortPath(item.path, item.sourceInfo)),
					});
				const extensionLabels = this.getCompactExtensionLabels(extensions);
				const extensionCompactList = () => formatCompactList(extensionLabels);
				addLoadedSection("Extensions", extensionCompactList, extList, "mdHeading");
			}
		}

		if (showDiagnostics) {
			const skillDiagnostics = skillsResult.diagnostics;
			if (skillDiagnostics.length > 0) {
				const warningLines = () => this.formatDiagnostics(skillDiagnostics, sourceInfos);
				this.loadedResourcesContainer.addChild(
					new ThemedText(() => `${theme.fg("warning", "[Skill conflicts]")}\n${warningLines()}`, 0, 0),
				);
				this.loadedResourcesContainer.addChild(new Spacer(1));
			}

			const promptDiagnostics = promptsResult.diagnostics;
			if (promptDiagnostics.length > 0) {
				const warningLines = () => this.formatDiagnostics(promptDiagnostics, sourceInfos);
				this.loadedResourcesContainer.addChild(
					new ThemedText(() => `${theme.fg("warning", "[Prompt conflicts]")}\n${warningLines()}`, 0, 0),
				);
				this.loadedResourcesContainer.addChild(new Spacer(1));
			}

			const extensionDiagnostics: ResourceDiagnostic[] = [];
			const extensionsResult = this.session.resourceLoader.getExtensions();
			for (const error of extensionsResult.errors) {
				extensionDiagnostics.push({ type: "error", message: error.error, path: error.path });
			}
			for (const warning of extensionsResult.warnings ?? []) {
				extensionDiagnostics.push({ type: "warning", message: warning.warning, path: warning.path });
			}

			const commandDiagnostics = this.session.extensionRunner.getCommandDiagnostics();
			extensionDiagnostics.push(...commandDiagnostics);
			extensionDiagnostics.push(...this.getBuiltInCommandConflictDiagnostics(this.session.extensionRunner));

			const shortcutDiagnostics = this.session.extensionRunner.getShortcutDiagnostics();
			extensionDiagnostics.push(...shortcutDiagnostics);

			if (extensionDiagnostics.length > 0) {
				const warningLines = () => this.formatDiagnostics(extensionDiagnostics, sourceInfos);
				this.loadedResourcesContainer.addChild(
					new ThemedText(() => `${theme.fg("warning", "[Extension issues]")}\n${warningLines()}`, 0, 0),
				);
				this.loadedResourcesContainer.addChild(new Spacer(1));
			}

			const themeDiagnostics = themesResult.diagnostics;
			if (themeDiagnostics.length > 0) {
				const warningLines = () => this.formatDiagnostics(themeDiagnostics, sourceInfos);
				this.loadedResourcesContainer.addChild(
					new ThemedText(() => `${theme.fg("warning", "[Theme conflicts]")}\n${warningLines()}`, 0, 0),
				);
				this.loadedResourcesContainer.addChild(new Spacer(1));
			}
		}
	}

	/**
	 * Initialize the extension system with TUI-based UI context.
	 */
	private async bindCurrentSessionExtensions(): Promise<void> {
		this.session.setApprovalPrompt((prompt, signal) => this.showPermissionPrompt(prompt, signal));
		const uiContext = this.createExtensionUIContext();
		await this.session.bindExtensions({
			uiContext,
			mode: "tui",
			abortHandler: () => {
				this.restoreQueuedMessagesToEditor({ abort: true });
			},
			commandContextActions: {
				waitForIdle: () => this.session.waitForIdle(),
				newSession: async (options) => {
					this.clearStatusIndicator();
					try {
						return await this.runtimeHost.newSession(options);
					} catch (error: unknown) {
						return this.handleFatalRuntimeError("Failed to create session", error);
					}
				},
				fork: async (entryId, options) => {
					try {
						const result = await this.runtimeHost.fork(entryId, options);
						if (!result.cancelled) {
							this.editor.setText(result.selectedText ?? "");
							this.showStatus("Forked to new session");
						}
						return { cancelled: result.cancelled };
					} catch (error: unknown) {
						return this.handleFatalRuntimeError("Failed to fork session", error);
					}
				},
				navigateTree: async (targetId, options) => {
					const result = await this.session.navigateTree(targetId, {
						summarize: options?.summarize,
						customInstructions: options?.customInstructions,
						replaceInstructions: options?.replaceInstructions,
						label: options?.label,
					});
					if (result.cancelled) {
						return { cancelled: true };
					}

					this.chatContainer.clear();
					this.renderInitialMessages();
					if (result.editorText && !this.editor.getText().trim()) {
						this.editor.setText(result.editorText);
					}
					this.showStatus("Navigated to selected point");
					void this.flushCompactionQueue({ willRetry: false });
					return { cancelled: false };
				},
				switchSession: async (sessionPath, options) => {
					return this.handleResumeSession(sessionPath, options);
				},
				reload: async () => {
					await this.handleReloadCommand();
				},
			},
			shutdownHandler: () => {
				this.shutdownRequested = true;
				if (this.session.isIdle) {
					void this.shutdown();
				}
			},
			onError: (error) => {
				this.showExtensionError(error.extensionPath, error.error, error.stack);
			},
		});

		setRegisteredThemes(this.session.resourceLoader.getThemes().themes);
		this.setupAutocompleteProvider();

		const extensionRunner = this.session.extensionRunner;
		this.setupExtensionShortcuts(extensionRunner);
		this.showLoadedResources({ force: false, showDiagnosticsWhenQuiet: true });
		this.showStartupNoticesIfNeeded();
	}

	private applyFullscreenScrollbarSetting(): void {
		this.transcriptScrollView?.setScrollbar(this.settingsManager.getFullscreenScrollbar());
	}

	/** Lets extension images use the PNG transcoder; tool results register it themselves. */
	private ensurePngTranscoder(): void {
		ensurePngTranscoder(() => {
			this.ui.invalidate();
			this.ui.requestRender();
		});
	}

	private applyRuntimeSettings(): void {
		setCapabilityOverrides(this.settingsManager.getTerminalCapabilityOverrides());
		setReducedMotion(this.settingsManager.getReducedMotion());
		this.ensurePngTranscoder();
		void configureHttpDispatcher(this.settingsManager.getHttpIdleTimeoutMs());
		this.applyFullscreenScrollbarSetting();
		if (this.renderer instanceof TuiAltScreen) {
			this.renderer.setCopyOnSelect(this.settingsManager.getFullscreenCopyOnSelect());
			this.renderer.setWheelScrollLines(this.settingsManager.getFullscreenWheelScrollLines());
		}
		this.footer.setSession(this.session);
		this.footer.setAutoCompactEnabled(this.session.autoCompactionEnabled);
		this.footer.setItems(this.settingsManager.getFooterItems());
		this.footer.setShow(this.settingsManager.getFooterShow());
		this.footer.setLastTurn(undefined);
		this.applyFooterTurnSummary();
		this.footerDataProvider.setCwd(this.sessionManager.getCwd());
		this.hideThinkingBlock = this.settingsManager.getHideThinkingBlock();
		this.outputPad = this.settingsManager.getOutputPad();
		this.ui.setShowHardwareCursor(this.settingsManager.getShowHardwareCursor());
		const clearOnShrink = this.settingsManager.getClearOnShrink();
		this.ui.setClearOnShrink(clearOnShrink);
		if (!clearOnShrink && !this.activeStatusIndicator) {
			this.statusContainer.clear();
		}
		const editorPaddingX = this.settingsManager.getEditorPaddingX();
		const autocompleteMaxVisible = this.settingsManager.getAutocompleteMaxVisible();
		this.defaultEditor.setPaddingX(editorPaddingX);
		this.defaultEditor.setAutocompleteMaxVisible(autocompleteMaxVisible);
		if (this.editor !== this.defaultEditor) {
			this.editor.setPaddingX?.(editorPaddingX);
			this.editor.setAutocompleteMaxVisible?.(autocompleteMaxVisible);
		}
	}

	private async rebindCurrentSession(options: { renderBeforeBind?: boolean } = {}): Promise<void> {
		const session = this.session;

		this.unsubscribe?.();
		this.unsubscribe = undefined;
		this.programStatus.reset();
		this.applyRuntimeSettings();

		if (options.renderBeforeBind) {
			this.renderCurrentSessionState();
			this.subscribeToAgent();
		}

		await this.bindCurrentSessionExtensions();

		if (this.session !== session) {
			return;
		}

		if (!options.renderBeforeBind) {
			this.subscribeToAgent();
		}

		await this.updateAvailableProviderCount();
		this.updateEditorBorderColor();
		this.updateTerminalTitle();
		void this.refreshChangesTray();
	}

	private async handleFatalRuntimeError(prefix: string, error: unknown): Promise<never> {
		const message = error instanceof Error ? error.message : String(error);
		this.showError(`${prefix}: ${message}`);
		const extensionHint = this.getCrashExtensionHint(error);
		if (extensionHint) {
			this.chatContainer.addChild(new ThemedText(() => theme.fg("warning", extensionHint), this.outputPad, 0));
		}
		if (this.recordCrash("fatal_error", error)) {
			const instructions = this.crashReportInstructions();
			this.chatContainer.addChild(new ThemedText(() => theme.fg("muted", instructions), this.outputPad, 0));
		}
		stopThemeWatcher();
		this.stop("transcript");
		process.exit(1);
	}

	private getCrashExtensionHint(error: unknown): string | undefined {
		try {
			return formatCrashExtensionHint(
				findExtensionStackMatches(
					error instanceof Error ? error.stack : undefined,
					this.session.resourceLoader.getExtensions().extensions,
				),
			);
		} catch {
			return undefined;
		}
	}

	/** Persist a crash so the next start can point the user at `/bug`. Returns false when nothing was written. */
	private recordCrash(kind: "uncaught_exception" | "fatal_error", error: unknown): boolean {
		try {
			return (
				recordCrash({
					kind,
					error,
					sessionFile: this.session.sessionFile,
					cwd: this.session.sessionManager.getCwd(),
				}) !== undefined
			);
		} catch {
			return false;
		}
	}

	private crashReportInstructions(): string {
		const resume = this.session.sessionFile
			? `run \`${APP_NAME} -r\` to resume the session, then`
			: `start ${APP_NAME} and`;
		return `To report this crash: ${resume} run /bug. The crash details are attached automatically.`;
	}

	private suggestBugReport(): void {
		if (this.bugReportHintShown) return;
		this.bugReportHintShown = true;
		this.chatContainer.addChild(
			new ThemedText(
				() => theme.fg("muted", `If this looks like a ${APP_NAME} bug, /bug sends a report to the developers.`),
				this.outputPad,
				0,
			),
		);
		this.ui.requestRender();
	}

	private maybeSuggestBugReport(message: AssistantMessage): void {
		if (message.stopReason !== "error" || isRetryableAssistantError(message)) return;
		if (/\b(?:abort(?:ed)?|cancel(?:l?ed)?)\b/i.test(message.errorMessage ?? "")) return;
		// A 413 already says what to do (/compact, /rewind).
		if (isPayloadTooLargeError(message.errorMessage)) return;
		// RunInfra key, credit, and rate-limit errors get a fix instead of a bug-report prompt.
		const runInfraHint = runInfraErrorHint(message.errorMessage);
		if (runInfraHint) {
			this.showWarning(runInfraHint);
			return;
		}
		if (this.maybeShowInstallChangeWarning()) return;
		this.suggestBugReport();
	}

	/**
	 * After an error, check whether an update replaced or removed this install while the session ran.
	 * Code loaded on demand then fails with missing modules until restart (#10439). Returns true when
	 * the install changed.
	 */
	private maybeShowInstallChangeWarning(): boolean {
		if (this.installChangeWarningShown) return true;
		const change = detectInstallChange();
		if (!change) return false;
		this.installChangeWarningShown = true;
		const cause =
			change.kind === "updated"
				? `${APP_NAME} was updated to ${change.version} while this session was running (${VERSION})`
				: `The ${APP_NAME} installation this session runs from was removed or replaced`;
		const resumeCommand = formatResumeCommand(this.sessionManager);
		const restart = resumeCommand
			? `Restart with \`${resumeCommand}\` to continue this session.`
			: `Restart ${APP_NAME}.`;
		this.showWarning(`${cause}. Features that load code on demand can fail until restart. ${restart}`);
		return true;
	}

	private renderCurrentSessionState(): void {
		this.loadedResourcesContainer.clear();
		this.chatContainer.clear();
		this.pendingMessagesContainer.clear();
		this.compactionQueuedMessages = [];
		this.streamingComponent = undefined;
		this.streamingMessage = undefined;
		this.pendingTools.clear();
		this.renderInitialMessages();
	}

	/**
	 * Get a registered tool definition by name (for custom rendering).
	 */
	/**
	 * Extension-registered definition, falling back to the built-in one. The renderer components take
	 * whatever this returns, so they never reach into the tool registry themselves.
	 */
	private getRegisteredToolDefinition(toolName: string) {
		return this.session.extensionRunner.resolveToolRenderers(toolName, () =>
			withBuiltInRenderers(toolName, this.session.getToolDefinition(toolName)),
		);
	}

	private getMarkdownTransformers(): MarkdownTransformer[] {
		return [this.mermaidMarkdownTransformer, ...this.session.extensionRunner.getMarkdownTransformers()];
	}

	/**
	 * Set up keyboard shortcuts registered by extensions.
	 */
	private setupExtensionShortcuts(extensionRunner: ExtensionRunner): void {
		const shortcuts = extensionRunner.getShortcuts(this.keybindings.getEffectiveConfig());
		if (shortcuts.size === 0) return;

		// Create a context for shortcut handlers
		const createContext = (): ExtensionContext => ({
			ui: this.createExtensionUIContext(),
			mode: "tui",
			hasUI: true,
			cwd: this.sessionManager.getCwd(),
			sessionManager: this.sessionManager,
			modelRegistry: extensionRunner.getModelRegistry(),
			model: this.session.model,
			scopedModels: this.session.scopedModels,
			thinkingLevel: this.session.thinkingLevel,
			isIdle: () => this.session.isIdle,
			isProjectTrusted: () => this.settingsManager.isProjectTrusted(),
			signal: this.session.agent.signal,
			abort: () => {
				this.restoreQueuedMessagesToEditor({ abort: true });
			},
			hasPendingMessages: () => this.session.pendingMessageCount > 0,
			shutdown: () => {
				this.shutdownRequested = true;
			},
			getContextUsage: () => this.session.getContextUsage(),
			compact: (options) => {
				void (async () => {
					try {
						const result = await this.session.compact(options?.customInstructions);
						options?.onComplete?.(result);
					} catch (error) {
						const err = error instanceof Error ? error : new Error(String(error));
						options?.onError?.(err);
					}
				})();
			},
			getSystemPrompt: () => this.session.systemPrompt,
		});

		// Set up the extension shortcut handler on the default editor
		this.defaultEditor.onExtensionShortcut = (data: string) => {
			for (const [shortcutStr, shortcut] of shortcuts) {
				// Cast to KeyId - extension shortcuts use the same format
				if (matchesKey(data, shortcutStr as KeyId)) {
					// Run handler async, don't block input
					Promise.resolve(shortcut.handler(createContext())).catch((err) => {
						this.showError(`Shortcut handler error: ${err instanceof Error ? err.message : String(err)}`);
					});
					return true;
				}
			}
			return false;
		};
	}

	/**
	 * Set extension status text in the footer.
	 */
	private setExtensionStatus(key: string, text: string | undefined): void {
		this.footerDataProvider.setExtensionStatus(key, text);
		this.ui.requestRender();
	}

	private setEditorWorkingStatusIndicator(indicator: StatusIndicator | undefined): boolean {
		this.defaultEditor.setWorkingStatusIndicator(undefined);
		if (!isEmbeddedStatus(this.editor)) return false;
		this.editor.setWorkingStatusIndicator(indicator);
		return true;
	}

	private showStatusIndicator(indicator: StatusIndicator): void {
		this.activeStatusIndicator?.dispose();
		this.activeStatusIndicator = indicator;
		this.activeWorkingIndicatorEmbedded = false;
		this.statusContainer.clear();
		this.setEditorWorkingStatusIndicator(undefined);
		if (this.setEditorWorkingStatusIndicator(indicator)) {
			this.activeWorkingIndicatorEmbedded = true;
			return;
		}
		this.statusContainer.addChild(indicator);
	}

	private clearStatusIndicator(kind?: StatusIndicator["kind"]): void {
		if (kind && this.activeStatusIndicator?.kind !== kind) {
			return;
		}
		const clearedIndicator = this.activeStatusIndicator;
		const clearedIndicatorWasEmbedded = this.activeWorkingIndicatorEmbedded;
		clearedIndicator?.dispose();
		this.activeStatusIndicator = undefined;
		this.activeWorkingIndicatorEmbedded = false;
		this.statusContainer.clear();
		this.setEditorWorkingStatusIndicator(undefined);
		if (
			clearedIndicator &&
			!clearedIndicatorWasEmbedded &&
			this.options.tuiMode === "regular" &&
			this.ui.getClearOnShrink()
		) {
			this.statusContainer.addChild(this.idleStatus);
		}
	}

	private showWorkingStatusIndicator(): void {
		const colorFn = isEmbeddedStatus(this.editor)
			? (text: string) =>
					(this.editor.borderColor ?? theme.getThinkingBorderColor(this.session.thinkingLevel || "off"))(text)
			: undefined;
		this.showStatusIndicator(
			new WorkingStatusIndicator(
				this.ui,
				this.workingMessage ?? this.defaultWorkingMessage,
				this.workingIndicatorOptions,
				colorFn,
			),
		);
	}

	private setWorkingVisible(visible: boolean): void {
		this.workingVisible = visible;
		if (!visible) {
			this.clearStatusIndicator("working");
			this.ui.requestRender();
			return;
		}
		if (this.session.isStreaming && this.activeStatusIndicator?.kind !== "working") {
			this.showWorkingStatusIndicator();
		}
		this.ui.requestRender();
	}

	private setWorkingIndicator(options?: WorkingIndicatorOptions): void {
		this.workingIndicatorOptions = options;
		if (this.activeStatusIndicator?.kind === "working") {
			this.activeStatusIndicator.setIndicator(options);
		}
		this.ui.requestRender();
	}

	private setHiddenThinkingLabel(label?: string): void {
		this.hiddenThinkingLabel = label ?? this.defaultHiddenThinkingLabel;
		for (const child of this.chatContainer.children) {
			if (child instanceof AssistantMessageComponent) {
				child.setHiddenThinkingLabel(this.hiddenThinkingLabel);
			}
		}
		if (this.streamingComponent) {
			this.streamingComponent.setHiddenThinkingLabel(this.hiddenThinkingLabel);
		}
		this.ui.requestRender();
	}

	/**
	 * Set an extension widget (string array or custom component).
	 */
	private setExtensionWidget(
		key: string,
		content: string[] | ((tui: TUI, thm: Theme) => Component & { dispose?(): void }) | undefined,
		options?: ExtensionWidgetOptions,
	): void {
		const placement = options?.placement ?? "aboveEditor";
		const removeExisting = (map: Map<string, Component & { dispose?(): void }>) => {
			const existing = map.get(key);
			if (existing?.dispose) existing.dispose();
			map.delete(key);
		};

		removeExisting(this.extensionWidgetsAbove);
		removeExisting(this.extensionWidgetsBelow);

		if (content === undefined) {
			this.renderWidgets();
			return;
		}

		let component: Component & { dispose?(): void };

		if (Array.isArray(content)) {
			// Wrap string array in a Container with Text components
			const container = new Container();
			for (const line of content.slice(0, InteractiveMode.MAX_WIDGET_LINES)) {
				container.addChild(new Text(line, 1, 0));
			}
			if (content.length > InteractiveMode.MAX_WIDGET_LINES) {
				container.addChild(new ThemedText(() => theme.fg("muted", "... (widget truncated)"), 1, 0));
			}
			component = container;
		} else {
			// Factory function - create component
			component = content(this.ui, theme);
		}

		const targetMap = placement === "belowEditor" ? this.extensionWidgetsBelow : this.extensionWidgetsAbove;
		targetMap.set(key, component);
		this.renderWidgets();
	}

	private clearExtensionWidgets(): void {
		for (const widget of this.extensionWidgetsAbove.values()) {
			widget.dispose?.();
		}
		for (const widget of this.extensionWidgetsBelow.values()) {
			widget.dispose?.();
		}
		this.extensionWidgetsAbove.clear();
		this.extensionWidgetsBelow.clear();
		this.renderWidgets();
	}

	private resetExtensionUI(): void {
		if (this.extensionSelector) {
			this.hideExtensionSelector();
		}
		if (this.extensionInput) {
			this.hideExtensionInput();
		}
		if (this.extensionEditor) {
			this.hideExtensionEditor();
		}
		this.ui.hideOverlay();
		this.clearExtensionTerminalInputListeners();
		this.setExtensionFooter(undefined);
		this.setExtensionHeader(undefined);
		this.clearExtensionWidgets();
		this.footerDataProvider.clearExtensionStatuses();
		this.footer.invalidate();
		this.autocompleteProviderWrappers = [];
		this.setCustomEditorComponent(undefined);
		this.setupAutocompleteProvider();
		this.defaultEditor.onExtensionShortcut = undefined;
		this.updateTerminalTitle();
		this.workingMessage = undefined;
		this.workingVisible = true;
		this.setWorkingIndicator();
		if (this.activeStatusIndicator?.kind === "working") {
			this.activeStatusIndicator.setMessage(
				`${this.defaultWorkingMessage} (${keyText("app.interrupt")} to interrupt)`,
			);
		}
		this.setHiddenThinkingLabel();
	}

	// Maximum total widget lines to prevent viewport overflow
	private static readonly MAX_WIDGET_LINES = 10;

	/**
	 * Render all extension widgets to the widget container.
	 */
	private renderWidgets(): void {
		if (!this.widgetContainerAbove || !this.widgetContainerBelow) return;
		const trayAbove =
			this.changesTray.visible && this.settingsManager.getDisplaySettings().changesTrayPosition === "editor";
		const trayBelow = this.changesTray.visible && !trayAbove;
		const above =
			this.todoPanel.visible || trayAbove
				? new Map<string, Component & { dispose?(): void }>([
						...(this.todoPanel.visible ? ([["runkiln:todo", this.todoPanel]] as const) : []),
						...this.extensionWidgetsAbove,
						// Last, so it sits right above the editor.
						...(trayAbove ? ([["runkiln:changes", this.changesTray]] as const) : []),
					])
				: this.extensionWidgetsAbove;
		// display.changesTrayPosition "footer": under the editor, first, so it sits right above the footer rows.
		const below = trayBelow
			? new Map<string, Component & { dispose?(): void }>([
					...this.extensionWidgetsBelow,
					["runkiln:changes", this.changesTray],
				])
			: this.extensionWidgetsBelow;
		this.renderWidgetContainer(this.widgetContainerAbove, above, true, true);
		this.renderWidgetContainer(this.widgetContainerBelow, below, false, false);
		this.ui.requestRender();
	}

	private renderWidgetContainer(
		container: Container,
		widgets: Map<string, Component & { dispose?(): void }>,
		spacerWhenEmpty: boolean,
		leadingSpacer: boolean,
	): void {
		container.clear();

		if (widgets.size === 0) {
			if (spacerWhenEmpty) {
				container.addChild(new Spacer(1));
			}
			return;
		}

		if (leadingSpacer) {
			container.addChild(new Spacer(1));
		}
		for (const component of widgets.values()) {
			container.addChild(component);
		}
	}

	/**
	 * Set a custom footer component, or restore the built-in footer.
	 */
	private setExtensionFooter(
		factory:
			| ((tui: TUI, thm: Theme, footerData: ReadonlyFooterDataProvider) => Component & { dispose?(): void })
			| undefined,
	): void {
		// Dispose existing custom footer
		if (this.customFooter?.dispose) {
			this.customFooter.dispose();
		}

		this.footerContainer.clear();
		if (factory) {
			// Create and add custom footer, passing the data provider
			this.customFooter = factory(this.ui, theme, this.footerDataProvider);
			this.footerContainer.addChild(this.customFooter);
		} else {
			// Restore built-in footer
			this.customFooter = undefined;
			this.footerContainer.addChild(this.footer);
		}

		this.ui.requestRender();
	}

	/**
	 * Set a custom header component, or restore the built-in header.
	 */
	private setExtensionHeader(factory: ((tui: TUI, thm: Theme) => Component & { dispose?(): void }) | undefined): void {
		// Header may not be initialized yet if called during early initialization
		if (!this.builtInHeader) {
			return;
		}

		// Dispose existing custom header
		if (this.customHeader?.dispose) {
			this.customHeader.dispose();
		}

		// Find the index of the current header in the header container
		const currentHeader = this.customHeader || this.builtInHeader;
		const index = this.headerContainer.children.indexOf(currentHeader);

		if (factory) {
			// Create and add custom header
			this.customHeader = factory(this.ui, theme);
			if (isExpandable(this.customHeader)) {
				this.customHeader.setExpanded(this.toolOutputExpanded);
			}
			if (index !== -1) {
				this.headerContainer.children[index] = this.customHeader;
			} else {
				// If not found (e.g. builtInHeader was never added), add at the top
				this.headerContainer.children.unshift(this.customHeader);
			}
		} else {
			// Restore built-in header
			this.customHeader = undefined;
			if (isExpandable(this.builtInHeader)) {
				this.builtInHeader.setExpanded(this.toolOutputExpanded);
			}
			if (index !== -1) {
				this.headerContainer.children[index] = this.builtInHeader;
			}
		}

		this.ui.requestRender();
	}

	private addExtensionTerminalInputListener(
		handler: (data: string) => { consume?: boolean; data?: string } | undefined,
	): () => void {
		const subscription = { handler, unsubscribe: this.ui.addInputListener(handler) };
		this.extensionTerminalInputSubscriptions.add(subscription);
		return () => {
			subscription.unsubscribe();
			this.extensionTerminalInputSubscriptions.delete(subscription);
		};
	}

	private rebindExtensionTerminalInputListeners(): void {
		for (const subscription of this.extensionTerminalInputSubscriptions) {
			subscription.unsubscribe();
			subscription.unsubscribe = this.ui.addInputListener(subscription.handler);
		}
	}

	private clearExtensionTerminalInputListeners(): void {
		for (const subscription of this.extensionTerminalInputSubscriptions) subscription.unsubscribe();
		this.extensionTerminalInputSubscriptions.clear();
	}

	/**
	 * Create the ExtensionUIContext for extensions.
	 */
	private createProjectTrustContext(cwd: string): ProjectTrustContext {
		const ui = this.createExtensionUIContext();
		return {
			cwd,
			mode: "tui",
			hasUI: true,
			ui: {
				select: ui.select,
				confirm: ui.confirm,
				input: ui.input,
				notify: ui.notify,
			},
		};
	}

	private createExtensionUIContext(): ExtensionUIContext {
		return {
			select: (title, options, opts) => this.showExtensionSelector(title, options, opts),
			confirm: (title, message, opts) => this.showExtensionConfirm(title, message, opts),
			input: (title, placeholder, opts) => this.showExtensionInput(title, placeholder, opts),
			notify: (message, type) => this.showExtensionNotify(message, type),
			onTerminalInput: (handler) => this.addExtensionTerminalInputListener(handler),
			setStatus: (key, text) => this.setExtensionStatus(key, text),
			setWorkingMessage: (message) => {
				this.workingMessage = message;
				if (this.activeStatusIndicator?.kind === "working") {
					this.activeStatusIndicator.setMessage(message ?? this.defaultWorkingMessage);
				}
			},
			setWorkingVisible: (visible) => this.setWorkingVisible(visible),
			setWorkingIndicator: (options) => this.setWorkingIndicator(options),
			setHiddenThinkingLabel: (label) => this.setHiddenThinkingLabel(label),
			setWidget: (key, content, options) => this.setExtensionWidget(key, content, options),
			setFooter: (factory) => this.setExtensionFooter(factory),
			setHeader: (factory) => this.setExtensionHeader(factory),
			setTitle: (title) => {
				this.extensionTitle = true;
				this.ui.terminal.setTitle(title);
			},
			custom: (factory, options) => this.showExtensionCustom(factory, options),
			pasteToEditor: (text) => this.editor.handleInput(`\x1b[200~${text}\x1b[201~`),
			setEditorText: (text) => this.editor.setText(text),
			getEditorText: () => this.editor.getExpandedText?.() ?? this.editor.getText(),
			editor: (title, prefill) => this.showExtensionEditor(title, prefill),
			addAutocompleteProvider: (factory) => {
				this.autocompleteProviderWrappers.push(factory);
				this.setupAutocompleteProvider();
			},
			setEditorComponent: (factory) => this.setCustomEditorComponent(factory),
			getEditorComponent: () => this.editorComponentFactory,
			get theme() {
				return theme;
			},
			getAllThemes: () => getAvailableThemesWithPaths(),
			getTheme: (name) => getThemeByName(name),
			setTheme: (themeOrName) => {
				if (themeOrName instanceof Theme) {
					return this.themeController.setThemeInstance(themeOrName);
				}
				const result = this.themeController.setThemeName(themeOrName);
				if (result.success) {
					if (this.settingsManager.getTheme() !== themeOrName) {
						this.settingsManager.setTheme(themeOrName);
					}
				}
				return result;
			},
			getToolsExpanded: () => this.toolOutputExpanded,
			setToolsExpanded: (expanded) => this.setToolsExpanded(expanded),
		};
	}

	/**
	 * Show a selector for extensions.
	 */
	private showExtensionSelector(
		title: string,
		options: string[],
		opts?: ExtensionUIDialogOptions,
		blocked: BlockedStatus = { kind: "question", message: title },
	): Promise<string | undefined> {
		return new Promise((resolve) => {
			if (opts?.signal?.aborted) {
				resolve(undefined);
				return;
			}

			const onAbort = () => {
				this.hideExtensionSelector();
				resolve(undefined);
			};
			opts?.signal?.addEventListener("abort", onAbort, { once: true });

			this.extensionSelector = new ExtensionSelectorComponent(
				title,
				options,
				(option) => {
					opts?.signal?.removeEventListener("abort", onAbort);
					this.hideExtensionSelector();
					resolve(option);
				},
				() => {
					opts?.signal?.removeEventListener("abort", onAbort);
					this.hideExtensionSelector();
					resolve(undefined);
				},
				{ tui: this.ui, timeout: opts?.timeout, onToggleToolsExpanded: () => this.toggleToolOutputExpansion() },
			);

			this.disposeActiveSelector();
			this.editorContainer.clear();
			this.editorContainer.addChild(this.extensionSelector);
			this.ui.setFocus(this.extensionSelector);
			// Extension dialogs share the editor slot: opening one replaces the status of a displaced one.
			this.programStatus.setBlocked("extension-dialog", blocked);
			this.ui.requestRender();
		});
	}

	/**
	 * Hide the extension selector.
	 */
	private hideExtensionSelector(): void {
		this.extensionSelector?.dispose();
		this.editorContainer.clear();
		this.editorContainer.addChild(this.editor);
		this.extensionSelector = undefined;
		this.programStatus.setBlocked("extension-dialog", undefined);
		this.ui.setFocus(this.editor);
		this.ui.requestRender();
	}

	/**
	 * Show a confirmation dialog for extensions.
	 */
	private async showExtensionConfirm(
		title: string,
		message: string,
		opts?: ExtensionUIDialogOptions,
	): Promise<boolean> {
		const result = await this.showExtensionSelector(`${title}\n${message}`, ["Yes", "No"], opts, {
			kind: "permission",
			message: title,
		});
		return result === "Yes";
	}

	private async promptForMissingSessionCwd(error: MissingSessionCwdError): Promise<string | undefined> {
		const confirmed = await this.showExtensionConfirm(
			"Session cwd not found",
			formatMissingSessionCwdPrompt(error.issue),
		);
		return confirmed ? error.issue.fallbackCwd : undefined;
	}

	/**
	 * Show a text input for extensions.
	 */
	private showExtensionInput(
		title: string,
		placeholder?: string,
		opts?: ExtensionUIDialogOptions,
	): Promise<string | undefined> {
		return new Promise((resolve) => {
			if (opts?.signal?.aborted) {
				resolve(undefined);
				return;
			}

			const onAbort = () => {
				this.hideExtensionInput();
				resolve(undefined);
			};
			opts?.signal?.addEventListener("abort", onAbort, { once: true });

			this.extensionInput = new ExtensionInputComponent(
				title,
				placeholder,
				(value) => {
					opts?.signal?.removeEventListener("abort", onAbort);
					this.hideExtensionInput();
					resolve(value);
				},
				() => {
					opts?.signal?.removeEventListener("abort", onAbort);
					this.hideExtensionInput();
					resolve(undefined);
				},
				{ tui: this.ui, timeout: opts?.timeout },
			);

			this.disposeActiveSelector();
			this.editorContainer.clear();
			this.editorContainer.addChild(this.extensionInput);
			this.ui.setFocus(this.extensionInput);
			this.programStatus.setBlocked("extension-dialog", { kind: "question", message: title });
			this.ui.requestRender();
		});
	}

	/**
	 * Hide the extension input.
	 */
	private hideExtensionInput(): void {
		this.extensionInput?.dispose();
		this.editorContainer.clear();
		this.editorContainer.addChild(this.editor);
		this.extensionInput = undefined;
		this.programStatus.setBlocked("extension-dialog", undefined);
		this.ui.setFocus(this.editor);
		this.ui.requestRender();
	}

	/**
	 * Show a multi-line editor for extensions (with Ctrl+G support).
	 */
	private showExtensionEditor(
		title: string,
		prefill?: string,
		options?: ExtensionEditorOptions,
	): Promise<string | undefined> {
		return new Promise((resolve) => {
			this.extensionEditor = new ExtensionEditorComponent(
				this.ui,
				this.keybindings,
				title,
				prefill,
				(value) => {
					this.hideExtensionEditor();
					resolve(value);
				},
				() => {
					this.hideExtensionEditor();
					resolve(undefined);
				},
				options,
				this.settingsManager.getExternalEditorCommand(),
			);

			this.disposeActiveSelector();
			this.editorContainer.clear();
			this.editorContainer.addChild(this.extensionEditor);
			this.ui.setFocus(this.extensionEditor);
			this.programStatus.setBlocked("extension-dialog", { kind: "question", message: title });
			this.ui.requestRender();
		});
	}

	/**
	 * Hide the extension editor.
	 */
	private hideExtensionEditor(): void {
		this.editorContainer.clear();
		this.editorContainer.addChild(this.editor);
		this.extensionEditor = undefined;
		this.programStatus.setBlocked("extension-dialog", undefined);
		this.ui.setFocus(this.editor);
		this.ui.requestRender();
	}

	/**
	 * Set a custom editor component from an extension.
	 * Pass undefined to restore the default editor.
	 */
	private setCustomEditorComponent(factory: EditorFactory | undefined): void {
		this.editorComponentFactory = factory;

		// Save text from current editor before switching
		const currentText = this.editor.getText();

		this.disposeActiveSelector();
		this.editorContainer.clear();

		if (factory) {
			// Create the custom editor with tui, theme, and keybindings
			const newEditor = factory(this.ui, getEditorTheme(), this.keybindings);

			// Wire up callbacks from the default editor
			newEditor.onSubmit = this.defaultEditor.onSubmit;
			newEditor.onChange = this.defaultEditor.onChange;

			// Copy text from previous editor
			newEditor.setText(currentText);

			// Copy appearance settings if supported
			if (newEditor.borderColor !== undefined) {
				newEditor.borderColor = this.defaultEditor.borderColor;
			}
			if (newEditor.setPaddingX !== undefined) {
				newEditor.setPaddingX(this.defaultEditor.getPaddingX());
			}
			if (newEditor.setAutocompleteMaxVisible !== undefined) {
				newEditor.setAutocompleteMaxVisible(this.defaultEditor.getAutocompleteMaxVisible());
			}

			// Set autocomplete if supported
			if (newEditor.setAutocompleteProvider && this.autocompleteProvider) {
				newEditor.setAutocompleteProvider(this.autocompleteProvider);
			}

			// If extending CustomEditor, copy app-level handlers
			// Use duck typing since instanceof fails across jiti module boundaries
			const customEditor = newEditor as unknown as Record<string, unknown>;
			if ("actionHandlers" in customEditor && customEditor.actionHandlers instanceof Map) {
				if (!customEditor.onEscape) {
					customEditor.onEscape = () => this.defaultEditor.onEscape?.();
				}
				if (!customEditor.onCtrlD) {
					customEditor.onCtrlD = () => this.defaultEditor.onCtrlD?.();
				}
				if (!customEditor.onPasteImage) {
					customEditor.onPasteImage = () => this.defaultEditor.onPasteImage?.();
				}
				if (!customEditor.onExtensionShortcut) {
					customEditor.onExtensionShortcut = (data: string) => this.defaultEditor.onExtensionShortcut?.(data);
				}
				// Copy action handlers (clear, suspend, model switching, etc.)
				for (const [action, handler] of this.defaultEditor.actionHandlers) {
					(customEditor.actionHandlers as Map<string, () => void>).set(action, handler);
				}
			}

			this.editor = newEditor;
		} else {
			// Restore default editor with text from custom editor
			this.defaultEditor.setText(currentText);
			this.editor = this.defaultEditor;
		}

		this.editorContainer.addChild(this.editor as Component);
		if (this.activeStatusIndicator) {
			this.statusContainer.clear();
			this.activeWorkingIndicatorEmbedded = this.setEditorWorkingStatusIndicator(this.activeStatusIndicator);
			if (!this.activeWorkingIndicatorEmbedded) {
				this.statusContainer.addChild(this.activeStatusIndicator);
			}
		}
		this.ui.setFocus(this.editor as Component);
		this.ui.requestRender();
	}

	/**
	 * Show a notification for extensions.
	 */
	private showExtensionNotify(message: string, type?: "info" | "warning" | "error"): void {
		if (type === "error") {
			this.showError(message);
		} else if (type === "warning") {
			this.showWarning(message);
		} else {
			this.showStatus(message);
		}
	}

	/** Show a custom component with keyboard focus. Overlay mode renders on top of existing content. */
	private async showExtensionCustom<T>(
		factory: (
			tui: TUI,
			theme: Theme,
			keybindings: KeybindingsManager,
			done: (result: T) => void,
		) => (Component & { dispose?(): void }) | Promise<Component & { dispose?(): void }>,
		options?: {
			overlay?: boolean;
			overlayOptions?: OverlayOptions | (() => OverlayOptions);
			onHandle?: (handle: OverlayHandle) => void;
		},
	): Promise<T> {
		const savedText = this.editor.getText();
		const isOverlay = options?.overlay ?? false;

		const restoreEditor = () => {
			this.editorContainer.clear();
			this.editorContainer.addChild(this.editor);
			this.editor.setText(savedText);
			this.ui.setFocus(this.editor);
			this.ui.requestRender();
		};

		return new Promise((resolve, reject) => {
			let component: Component & { dispose?(): void };
			let closed = false;

			const close = (result: T) => {
				if (closed) return;
				closed = true;
				if (isOverlay) this.ui.hideOverlay();
				else restoreEditor();
				// Note: both branches above already call requestRender
				resolve(result);
				try {
					component?.dispose?.();
				} catch {
					/* ignore dispose errors */
				}
			};

			Promise.resolve(factory(this.ui, theme, this.keybindings, close))
				.then((c) => {
					if (closed) return;
					component = c;
					if (isOverlay) {
						// Resolve overlay options - can be static or dynamic function
						const resolveOptions = (): OverlayOptions | undefined => {
							if (options?.overlayOptions) {
								const opts =
									typeof options.overlayOptions === "function"
										? options.overlayOptions()
										: options.overlayOptions;
								return opts;
							}
							// Fallback: use component's width property if available
							const w = (component as { width?: number }).width;
							return w ? { width: w } : undefined;
						};
						const handle = this.ui.showOverlay(component, resolveOptions());
						// Expose handle to caller for visibility control
						options?.onHandle?.(handle);
					} else {
						this.disposeActiveSelector();
						this.editorContainer.clear();
						this.editorContainer.addChild(component);
						this.ui.setFocus(component);
						this.ui.requestRender();
					}
				})
				.catch((err) => {
					if (closed) return;
					if (!isOverlay) restoreEditor();
					reject(err);
				});
		});
	}

	/**
	 * Show an extension error in the UI.
	 */
	private showExtensionError(extensionPath: string, error: string, stack?: string): void {
		const errorMsg = `Extension "${extensionPath}" error: ${error}`;
		const errorText = new ThemedText(() => theme.fg("error", errorMsg), 1, 0);
		this.chatContainer.addChild(errorText);
		if (stack) {
			// Show stack trace in dim color, indented
			const stackLines = stack.split("\n").slice(1); // Skip first line (duplicates error message)
			if (stackLines.length > 0) {
				const renderStack = () => stackLines.map((line) => theme.fg("dim", `  ${line.trim()}`)).join("\n");
				this.chatContainer.addChild(new ThemedText(renderStack, 1, 0));
			}
		}
		this.ui.requestRender();
	}

	// =========================================================================
	// Key Handlers
	// =========================================================================

	private setupKeyHandlers(): void {
		// Set up handlers on defaultEditor - they use this.editor for text access
		// so they work correctly regardless of which editor is active
		this.defaultEditor.onEscape = () => {
			if (this.session.isStreaming) {
				this.restoreQueuedMessagesToEditor({ abort: true });
			} else if (this.session.isBashRunning) {
				this.session.abortBash();
			} else if (this.isBashMode) {
				this.editor.setText("");
				this.isBashMode = false;
				this.updateEditorBorderColor();
			} else if (!this.editor.getText().trim()) {
				// Double-escape with empty editor triggers /tree, /fork, or nothing based on setting
				const action = this.settingsManager.getDoubleEscapeAction();
				if (action !== "none") {
					const now = Date.now();
					if (now - this.lastEscapeTime < 500) {
						if (action === "tree") {
							this.showTreeSelector();
						} else if (action === "rewind") {
							void this.showRewindSelector();
						} else {
							this.showUserMessageSelector();
						}
						this.lastEscapeTime = 0;
					} else {
						this.lastEscapeTime = now;
					}
				}
			}
		};

		// Register app action handlers
		this.defaultEditor.onAction("app.clear", () => this.handleCtrlC());
		this.defaultEditor.onCtrlD = () => this.handleCtrlD();
		this.defaultEditor.onAction("app.suspend", () => this.handleCtrlZ());
		this.defaultEditor.onAction("app.thinking.cycle", () => this.cycleThinkingLevel());
		this.defaultEditor.onAction("app.permissions.cycle", () => this.cyclePermissionMode());
		this.defaultEditor.onAction("app.model.cycleForward", () => this.cycleModel("forward"));
		this.defaultEditor.onAction("app.model.cycleBackward", () => this.cycleModel("backward"));
		this.defaultEditor.onAction("app.router.cycleMode", () => this.cycleRouterMode());

		// Global debug handler on TUI (works regardless of focus)
		this.ui.onDebug = () => this.handleDebugCommand();
		this.defaultEditor.onAction("app.model.select", () => this.showModelSelector());
		this.defaultEditor.onAction("app.tools.expand", () => this.toggleToolOutputExpansion());
		this.defaultEditor.onAction("app.tools.select", () => this.toggleToolSelectMode());
		this.defaultEditor.onAction("app.changes.review", () => void this.openChangesReview());
		this.defaultEditor.onAction("app.thinking.toggle", () => this.toggleThinkingBlockVisibility());
		this.defaultEditor.onAction("app.editor.external", () => void this.handleOpenExternalEditor());
		this.defaultEditor.onAction(
			"app.message.copy",
			() => void this.handleCopyCommand({ flashConfirmation: true, preferSelection: true }),
		);
		this.defaultEditor.onAction("app.message.followUp", () => this.handleFollowUp());
		this.defaultEditor.onAction("app.message.dequeue", () => this.handleDequeue());
		this.defaultEditor.onAction("app.session.new", () => this.handleClearCommand());
		this.defaultEditor.onAction("app.session.tree", () => this.showTreeSelector());
		this.defaultEditor.onAction("app.session.fork", () => this.showUserMessageSelector());
		this.defaultEditor.onAction("app.session.resume", () => this.showSessionSelector());
		this.defaultEditor.onAction("app.editor.stash", () => this.toggleStash());
		this.defaultEditor.onHistorySearch = () => this.openHistorySearch();
		this.defaultEditor.onShowShortcuts = () => this.openShortcutSheet();
		this.defaultEditor.onOpenChip = (chip) => this.openEditorChip(chip);

		this.defaultEditor.onChange = (text: string) => {
			const wasBashMode = this.isBashMode;
			this.isBashMode = text.trimStart().startsWith("!");
			if (wasBashMode !== this.isBashMode) {
				this.updateEditorBorderColor();
			}
		};

		// Handle clipboard paste (triggered on Ctrl+V). Copied files use their original paths,
		// images are attached via temporary files, and plain text is the final fallback.
		this.defaultEditor.onPasteImage = () => {
			void this.handleClipboardPaste();
		};
		// A dragged-in or pasted image path attaches the image instead of inserting the path.
		this.defaultEditor.onPasteText = (text: string) => this.handlePastedImagePaths(text);
	}

	private pathOptions() {
		return { cwd: this.sessionManager.getCwd(), wsl: process.platform === "linux" && isWSL() };
	}

	/** Bracketed paste of image file paths (what terminals send for a drag-and-drop): attach them. */
	private handlePastedImagePaths(text: string): boolean {
		if (this.editor !== this.defaultEditor) return false;
		const parsed = parsePastedImagePaths(text, this.pathOptions());
		if (!parsed) return false;
		void (async () => {
			for (const imagePath of parsed.images) await this.attachImageFile(imagePath);
			if (parsed.others.length > 0) this.defaultEditor.insertTextAtCursor(`${parsed.others.join(" ")} `);
			this.ui.requestRender();
		})();
		return true;
	}

	private async attachImageFile(imagePath: string): Promise<boolean> {
		const prepared = await prepareImageFile(imagePath);
		if (!prepared.ok) {
			this.showWarning(prepared.message);
			return false;
		}
		this.attachPreparedImage(prepared, path.basename(imagePath));
		return true;
	}

	/** Add a chip for an image and say what was attached, with a warning when the model can't see it. */
	private attachPreparedImage(prepared: PreparedImage, source: string): void {
		if (this.settingsManager.getBlockImages()) {
			this.showWarning("Images are blocked in settings (images.blockImages): the image was not attached.");
			return;
		}
		const item = this.imageAttachments.add(prepared);
		const marker = this.defaultEditor.addImageMarker(item.id, item.label);
		const note = prepared.note ? ` (${prepared.note})` : "";
		this.showStatus(`Attached ${marker} from ${source}${note}. Delete the chip to drop it.`);
		const warning = this.imageModelWarning();
		if (warning) this.showWarning(warning);
		this.ui.requestRender();
	}

	/** A manual model without image input gets a clear warning; auto routes image turns to a vision model. */
	private imageModelWarning(): string | undefined {
		const model = this.session.model;
		if (!model || isAutoModelId(model.id) || acceptsImages(model)) return undefined;
		const vision = this.session.modelRuntime.getRoutableModels().filter((entry) => entry.input.includes("image"));
		return nonVisionWarning(model, vision);
	}

	/**
	 * The images a submitted prompt carries: its chips that are still in the text, then `@path` mentions
	 * of image files. Returns the warnings to show for files that could not be attached.
	 */
	private async collectPromptImages(text: string): Promise<ImageContent[]> {
		const images = this.imageAttachments.resolve(text).map((item) => item.image);
		for (const imagePath of mentionedImagePaths(text, this.pathOptions())) {
			const prepared = await prepareImageFile(imagePath);
			if (prepared.ok) images.push(prepared.image);
			else this.showWarning(prepared.message);
		}
		return images;
	}

	/** Bind the prompt's images to its text for the send that follows, and clear the chips. */
	private async bindPromptImages(text: string): Promise<ImageContent[] | undefined> {
		if (this.promptImages.has(text)) return this.promptImages.get(text);
		const images = await this.collectPromptImages(text);
		this.imageAttachments.clear();
		this.defaultEditor.clearImageMarkers();
		if (images.length === 0) return undefined;
		this.promptImages.set(text, images);
		const warning = this.imageModelWarning();
		if (warning) this.showWarning(warning);
		return images;
	}

	private takePromptImages(text: string): ImageContent[] | undefined {
		const images = this.promptImages.get(text);
		this.promptImages.delete(text);
		return images;
	}

	private async handleRightClickPaste(): Promise<void> {
		const target = this.renderer.getFocusedComponent();
		const handleInput = target?.handleInput;
		if (!target || !handleInput) return;
		try {
			const text = await readClipboardText();
			if (!text || this.renderer.getFocusedComponent() !== target) return;
			handleInput.call(target, `\x1b[200~${text}\x1b[201~`);
			this.ui.requestRender();
		} catch {
			// Silently ignore clipboard errors (may not have permission, etc.)
		}
	}

	private async handleClipboardPaste(): Promise<void> {
		try {
			const filePaths = await readClipboardFilePaths();
			if (filePaths) {
				if (filePaths.some((filePath) => /\p{Cc}/u.test(filePath))) {
					throw new Error("Clipboard file path contains control characters");
				}
				// Copied image files attach as images; other files are inserted as paths.
				const imageFiles =
					this.editor === this.defaultEditor ? filePaths.filter((filePath) => isImagePath(filePath)) : [];
				for (const imagePath of imageFiles) await this.attachImageFile(imagePath);
				const rest = filePaths.filter((filePath) => !imageFiles.includes(filePath));
				if (rest.length === 0) return;
				const paths = this.isBashMode ? rest.map(quoteIfNeeded).join(" ") : rest.join("\n");
				const cursor = this.editor.getCursor?.();
				const currentLine = cursor ? (this.editor.getText().split("\n")[cursor.line] ?? "") : "";
				const characterBeforeCursor = cursor && cursor.col > 0 ? currentLine[cursor.col - 1] : "";
				const characterAfterCursor = cursor ? currentLine[cursor.col] : "";
				const leadingSpace = characterBeforeCursor && !/\s/.test(characterBeforeCursor) ? " " : "";
				const trailingSpace = characterAfterCursor && !/\s/.test(characterAfterCursor) ? " " : "";
				this.editor.insertTextAtCursor?.(`${leadingSpace}${paths}${trailingSpace}`);
				this.ui.requestRender();
				return;
			}

			const clipboard = await readClipboardImageResult();
			if (clipboard.kind === "image") {
				if (this.editor !== this.defaultEditor) {
					this.showWarning("This editor can't take image attachments.");
					return;
				}
				const prepared = await prepareImageBytes(clipboard.image.bytes, "The clipboard image");
				if (!prepared.ok) {
					this.showWarning(prepared.message);
					return;
				}
				this.attachPreparedImage(prepared, "the clipboard");
				return;
			}

			const text = await readClipboardText();
			if (text) {
				// A copied image path attaches the image, like a drag-and-drop.
				if (this.handlePastedImagePaths(text)) return;
				this.editor.insertTextAtCursor?.(text);
				this.ui.requestRender();
				return;
			}
			this.showWarning(
				clipboard.kind === "unavailable"
					? clipboard.message
					: "No image on the clipboard. Copy an image or a screenshot first, or drag an image file in.",
			);
		} catch (error) {
			this.showError(`Failed to paste from clipboard: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private handleStartupSubmit(text: string): void {
		this.editor.setText(text);
		this.showStatus("Startup is still in progress");
	}

	/**
	 * `/setup` and `/login`: the setup wizard. Full screen on a capable terminal (the chat TUI pauses
	 * while it runs, like the external editor), inline otherwise. Saves into the user config, then
	 * returns to this chat with the new key, router, model, thinking and theme applied.
	 */
	private async openSetup(): Promise<void> {
		const display =
			chooseSetupDisplay({
				stdinIsTTY: !!process.stdin.isTTY,
				stdoutIsTTY: !!process.stdout.isTTY,
				env: process.env,
			}) ?? "inline";
		let result: SetupResult | undefined;
		if (display === "fullscreen") {
			this.ui.stop();
			try {
				result = await runSetup({
					settingsManager: this.settingsManager,
					agentDir: getAgentDir(),
					display,
					initializeTerminal: false,
				});
			} finally {
				this.ui.start();
				this.ui.requestRender(true);
			}
		} else {
			result = await this.showExtensionCustom<SetupResult | undefined>((tui, _theme, _keybindings, done) => {
				return new SetupWizard({
					agentDir: getAgentDir(),
					layout: "inline",
					catalog: this.session.modelRuntime.catalog,
					requestRender: () => tui.requestRender(),
					onComplete: (value) => done(value),
					onCancel: () => done(undefined),
				});
			});
		}
		if (!result) {
			// A theme previewed in the wizard is undone.
			this.themeController.applyFromSettings();
			return;
		}

		this.session.modelRuntime.reloadRunInfraConfig(getAgentDir());
		await this.settingsManager.reload();
		this.session.reloadRouter();
		const themeSetting = this.settingsManager.getThemeSetting();
		if (themeSetting) this.themeController.setThemeSetting(themeSetting);
		else this.themeController.applyFromSettings();
		const runtime = this.session.modelRuntime;
		const defaults = effectiveRoleDefaults(runtime.catalog, this.settingsManager.getModelRoles());
		const resolved = resolveRoleModel(this.session.role, defaults, (id) =>
			isAutoModelId(id) ? runtime.autoModelFor(parseAutoMode(id) ?? "medium") : runtime.getModelById(id),
		);
		if (resolved.model) {
			try {
				await this.session.setModel(resolved.model);
			} catch (error) {
				const message = error instanceof Error ? error.message : "Could not switch model";
				this.showWarning(message);
			}
		}
		this.session.applyDefaultThinkingLevel();
		// Setup saved `permissions.mode`; like /permissions, the choice applies to this session too.
		const savedPermissions = parsePermissionMode(this.settingsManager.getPermissionMode());
		if (savedPermissions && savedPermissions !== this.session.permissionMode) {
			const error = this.session.setPermissionMode(savedPermissions);
			if (error) this.showWarning(error);
		}
		this.footer.invalidate();
		this.showStatus(result.lines.join("\n"));
	}

	/**
	 * `/setup [section]` (and the old /key, /login, /logout, /runinfra): the setup hub. Full screen on a capable
	 * terminal (the chat pauses while it is up, like the wizard), inline otherwise. When the hub hands back a
	 * screen it cannot show itself (/models, Ctrl+P cycle, footer items), that screen opens here and the hub
	 * comes back on the same section once it closes.
	 */
	private async openSetupHub(
		options: { section?: HubSection; keyAction?: { key: HubKey; action: "set" | "remove" } } = {},
	): Promise<void> {
		let section = options.section;
		let keyAction = options.keyAction;
		for (;;) {
			const result = await this.runSetupHubOnce(section, keyAction);
			keyAction = undefined;
			await this.applySetupHubResult(result);
			if (!result.open) return;
			await this.openHubScreen(result.open);
			section = result.section;
		}
	}

	private async runSetupHubOnce(
		section: HubSection | undefined,
		keyAction: { key: HubKey; action: "set" | "remove" } | undefined,
	): Promise<SetupHubResult> {
		const display =
			chooseSetupDisplay({
				stdinIsTTY: !!process.stdin.isTTY,
				stdoutIsTTY: !!process.stdout.isTTY,
				env: process.env,
			}) ?? "inline";
		const screens: HubScreen[] = ["models", "scoped-models", "statusline"];
		const catalog = this.session.modelRuntime.catalog;
		if (display === "fullscreen") {
			this.ui.stop();
			try {
				return await runSetupHub({
					settingsManager: this.settingsManager,
					agentDir: getAgentDir(),
					display,
					initializeTerminal: false,
					section,
					keyAction,
					screens,
					hub: { catalog },
				});
			} finally {
				this.ui.start();
				this.ui.requestRender(true);
			}
		}
		return this.showExtensionCustom<SetupHubResult>((tui, _theme, _keybindings, done) => {
			return new SetupHub({
				agentDir: getAgentDir(),
				layout: "inline",
				section,
				keyAction,
				screens,
				catalog,
				requestRender: () => tui.requestRender(),
				onClose: (value) => done(value),
			});
		});
	}

	/** Bring this session in line with what the hub saved: key, router, theme, permissions, footer. */
	private async applySetupHubResult(result: SetupHubResult): Promise<void> {
		if (result.keyChanged) {
			try {
				this.session.modelRuntime.reloadRunInfraConfig(getAgentDir());
			} catch (error) {
				this.showWarning(error instanceof Error ? error.message : "Could not reload runinfra.json");
			}
			this.updateAvailableProviderCount();
		}
		if (result.routerChanged || result.settingsChanged) {
			await this.settingsManager.reload();
			this.session.reloadRouter();
		}
		// A theme previewed but not saved is undone; a saved one applies.
		const themeSetting = this.settingsManager.getThemeSetting();
		if (themeSetting) this.themeController.setThemeSetting(themeSetting);
		else this.themeController.applyFromSettings();
		if (result.settingsChanged) {
			const savedPermissions = parsePermissionMode(this.settingsManager.getPermissionMode());
			if (savedPermissions && savedPermissions !== this.session.permissionMode) {
				const error = this.session.setPermissionMode(savedPermissions);
				if (error) this.showWarning(error);
			}
		}
		this.footer.setItems(this.settingsManager.getFooterItems());
		this.footer.setShow(this.settingsManager.getFooterShow());
		this.footer.invalidate();
		if (result.keyChanged && !this.session.modelRuntime.hasConfiguredAuth("runinfra")) {
			this.showWarning("No RunInfra key is set. /setup keys adds one.");
		}
	}

	/** A screen the hub asked for. Resolves when it closes. */
	private openHubScreen(screen: HubScreen): Promise<void> {
		if (screen === "models") return this.openModelsManager();
		return new Promise((resolve) => {
			if (screen === "scoped-models") this.showModelsSelector(resolve);
			else this.showStatusLinePicker(resolve);
		});
	}

	/** Hidden aliases (/key, /cost, /clear...) say their new name once per session. */
	private readonly announcedAliases = new Set<string>();

	private noteAlias(name: string): void {
		const target = HIDDEN_SLASH_ALIASES[name];
		if (!target || this.announcedAliases.has(name)) return;
		this.announcedAliases.add(name);
		this.showStatus(`/${name} is now ${target}`);
	}

	/** `/models`: enable or disable models, pick the default model and thinking level. */
	private async openModelsManager(): Promise<void> {
		const runtime = this.session.modelRuntime;
		const agentDir = getAgentDir();
		const result = await this.showExtensionCustom<ModelsManagerResult>((tui, _theme, _keybindings, done) => {
			return new ModelsManagerScreen({
				catalog: runtime.catalog,
				store: settingsModelsStore(this.settingsManager, runtime.catalog),
				unbenched: this.session.getRouterStatus().derivedModels,
				agentDir,
				baseUrl: runtime.runInfraConfig.baseUrl,
				apiKey: getActiveRunInfraKey(agentDir),
				offline: process.env.RUNKILN_OFFLINE === "1",
				requestRender: () => tui.requestRender(),
				onChange: () => runtime.setDisabledModels(this.settingsManager.getDisabledModels()),
				onClose: (value) => done(value),
			});
		});
		if (!result.changed) return;
		runtime.setDisabledModels(this.settingsManager.getDisabledModels());
		// A new defaultThinkingLevel applies to the current manual model unless /thinking set one.
		this.session.applyDefaultThinkingLevel();
		this.updateAvailableProviderCount();
		this.footer.invalidate();
		this.updateEditorBorderColor();
		this.showStatus("Model settings saved. The default model applies to new sessions (/new).");
	}

	private setupEditorSubmitHandler(): void {
		this.defaultEditor.onSubmit = async (text: string) => {
			text = text.trim();
			if (!text) return;
			const hasImages = this.imageAttachments.size > 0 || text.includes("@");

			// Handle commands
			if (text === "/help" || text === "/hotkeys") {
				this.editor.setText("");
				if (text === "/hotkeys") this.noteAlias("hotkeys");
				this.handleHelpCommand();
				return;
			}
			if (text === "/permissions" || text.startsWith("/permissions ")) {
				const arg = text.slice("/permissions".length).trim();
				this.editor.setText("");
				this.handlePermissionsCommand(arg);
				return;
			}
			if (text === "/status" || text === "/session") {
				this.editor.setText("");
				if (text === "/session") this.noteAlias("session");
				this.handleStatusCommand();
				return;
			}
			if (/^\/(usage|cost|stats)(\s|$)/.test(text)) {
				this.editor.setText("");
				if (!text.startsWith("/usage")) this.noteAlias(text.startsWith("/cost") ? "cost" : "stats");
				this.openUsageScreen(text.replace(/^\/\S+/, "").trim());
				return;
			}
			if (text === "/hooks" || text.startsWith("/hooks ")) {
				this.editor.setText("");
				this.handleHooksCommand(text.slice("/hooks".length).trim());
				return;
			}
			if (text === "/mcp" || text.startsWith("/mcp ")) {
				this.editor.setText("");
				await this.handleMcpCommand(text.slice("/mcp".length).trim());
				return;
			}
			if (text === "/jobs" || text.startsWith("/jobs ")) {
				this.editor.setText("");
				this.handleJobsCommand(text.slice("/jobs".length).trim());
				return;
			}
			if (text === "/diff" || text.startsWith("/diff ")) {
				this.editor.setText("");
				void this.handleDiffCommand(text.slice("/diff".length).trim());
				return;
			}
			if (text === "/map" || text.startsWith("/map ")) {
				this.editor.setText("");
				void this.handleMapCommand(text.slice("/map".length).trim());
				return;
			}
			if (text === "/doctor") {
				this.editor.setText("");
				this.handleDoctorCommand();
				return;
			}
			if (text === "/init") {
				this.editor.setText("");
				this.handleInitCommand();
				return;
			}
			if (text === "/settings") {
				this.showSettingsSelector();
				this.editor.setText("");
				return;
			}
			if (text === "/statusline") {
				this.noteAlias("statusline");
				this.showStatusLinePicker();
				this.editor.setText("");
				return;
			}
			if (text === "/setup" || text.startsWith("/setup ")) {
				const arg = text.slice("/setup".length).trim().toLowerCase();
				this.editor.setText("");
				if (arg === "wizard") {
					await this.openSetup();
					return;
				}
				const section = parseHubSection(arg);
				if (arg && !section) {
					this.showError(
						`Unknown section "${arg}". Use keys, model, routing, permissions, look, footer or wizard.`,
					);
					return;
				}
				await this.openSetupHub({ section });
				return;
			}
			if (/^\/(key|login|logout|runinfra)(\s|$)/.test(text)) {
				const name = text.slice(1).split(/\s/)[0] ?? "key";
				this.editor.setText("");
				this.noteAlias(name);
				await this.openSetupHub(
					name === "logout" ? { keyAction: { key: "runinfra", action: "remove" } } : { section: "keys" },
				);
				return;
			}
			if (text === "/models") {
				this.editor.setText("");
				this.noteAlias("models");
				await this.openModelsManager();
				return;
			}
			if (text === "/scoped-models") {
				this.editor.setText("");
				this.noteAlias("scoped-models");
				this.showModelsSelector();
				return;
			}
			if (text === "/thinking" || text.startsWith("/thinking ")) {
				const searchTerm = text.startsWith("/thinking ") ? text.slice(10).trim() : undefined;
				this.editor.setText("");
				this.handleThinkingCommand(searchTerm || undefined);
				return;
			}
			if (text === "/router" || text.startsWith("/router ")) {
				const arg = text.slice("/router".length).trim().toLowerCase();
				this.editor.setText("");
				this.handleRouterCommand(arg);
				return;
			}
			if (text === "/model" || text.startsWith("/model ")) {
				const searchTerm = text.startsWith("/model ") ? text.slice(7).trim() : undefined;
				this.editor.setText("");
				await this.handleModelCommand(searchTerm);
				return;
			}
			if (text === "/export" || text.startsWith("/export ")) {
				await this.handleExportCommand(text);
				this.editor.setText("");
				return;
			}
			if (text === "/import" || text.startsWith("/import ")) {
				await this.handleImportCommand(text);
				this.editor.setText("");
				return;
			}
			if (text === "/copy" || text.startsWith("/copy ")) {
				await this.handleCopySubcommand(text);
				this.editor.setText("");
				return;
			}
			if (text === "/name" || text.startsWith("/name ")) {
				this.handleNameCommand(text);
				this.editor.setText("");
				return;
			}
			if (text === "/fork") {
				this.showUserMessageSelector();
				this.editor.setText("");
				return;
			}
			if (text === "/clone") {
				this.editor.setText("");
				this.noteAlias("clone");
				await this.handleCloneCommand();
				return;
			}
			if (text === "/tree") {
				this.showTreeSelector();
				this.editor.setText("");
				return;
			}
			if (text === "/review" || text.startsWith("/review ")) {
				this.editor.setText("");
				this.rememberPrompt(text);
				void this.handleReviewCommand(text.slice("/review".length).trim());
				return;
			}
			if (text === "/commit" || text.startsWith("/commit ")) {
				this.editor.setText("");
				this.rememberPrompt(text);
				void this.handleCommitCommand(text.slice("/commit".length).trim().toLowerCase());
				return;
			}
			if (text === "/todo") {
				this.editor.setText("");
				this.handleTodoCommand();
				return;
			}
			if (text === "/undo") {
				this.editor.setText("");
				await this.handleUndoCommand();
				return;
			}
			if (text === "/test" || text.startsWith("/test ")) {
				this.editor.setText("");
				await this.handleTestCommand(text.slice(5).trim());
				return;
			}
			if (/^\/(delegate|subagents)(\s|$)/.test(text)) {
				this.editor.setText("");
				this.showError("Subagents were removed: one agent per session is cheaper and keeps the prompt cache.");
				return;
			}
			if (text === "/rewind") {
				this.editor.setText("");
				await this.showRewindSelector();
				return;
			}
			if (text === "/trust") {
				this.showTrustSelector();
				this.editor.setText("");
				return;
			}
			if (text === "/new" || text === "/clear") {
				this.editor.setText("");
				if (text === "/clear") this.noteAlias("clear");
				await this.handleClearCommand();
				return;
			}
			if (text === "/compact" || text.startsWith("/compact ")) {
				const customInstructions = text.startsWith("/compact ") ? text.slice(9).trim() : undefined;
				this.editor.setText("");
				await this.handleCompactCommand(customInstructions);
				return;
			}
			if (text === "/reload") {
				this.editor.setText("");
				await this.handleReloadCommand();
				return;
			}
			if (text === "/debug") {
				this.handleDebugCommand();
				this.editor.setText("");
				return;
			}
			if (text === "/arminsayshi") {
				this.handleArminSaysHi();
				this.editor.setText("");
				return;
			}
			if (text === "/resume") {
				this.showSessionSelector();
				this.editor.setText("");
				return;
			}
			if (text === "/quit" || text === "/exit") {
				this.editor.setText("");
				await this.shutdown();
				return;
			}

			// Handle bash command (! for normal, !! for excluded from context)
			if (text.startsWith("!")) {
				const isExcluded = text.startsWith("!!");
				const command = isExcluded ? text.slice(2).trim() : text.slice(1).trim();
				if (command) {
					if (this.session.isBashRunning) {
						this.showWarning("A bash command is already running. Press Esc to cancel it first.");
						this.editor.setText(text);
						return;
					}
					this.rememberPrompt(text);
					await this.handleBashCommand(command, isExcluded);
					this.isBashMode = false;
					this.updateEditorBorderColor();
					return;
				}
			}

			// Queue input during compaction (extension commands execute immediately)
			if (this.session.isCompacting) {
				if (this.isExtensionCommand(text)) {
					this.rememberPrompt(text);
					this.editor.setText("");
					await this.session.prompt(text);
				} else if (this.imageAttachments.resolve(text).length > 0) {
					// Queued messages are text only: keep the chips and send once compaction ends.
					this.editor.setText(text);
					this.showWarning("Compaction is running: send the image once it finishes.");
				} else {
					this.queueCompactionMessage(text, "steer");
				}
				return;
			}

			// A budget at 100% asks before the next prompt (never a hard stop).
			if (!this.session.isStreaming && !text.startsWith("/") && !(await this.confirmBudget())) {
				this.editor.setText(text);
				return;
			}

			const images = hasImages ? await this.bindPromptImages(text) : undefined;

			// If streaming, use prompt() with steer behavior
			// This handles extension commands (execute immediately), prompt template expansion, and queueing
			if (this.session.isStreaming) {
				this.rememberPrompt(text);
				this.editor.setText("");
				this.takePromptImages(text);
				await this.session.prompt(text, { streamingBehavior: "steer", images });
				this.updatePendingMessagesDisplay();
				this.ui.requestRender();
				return;
			}

			// Normal message submission
			// First, move any pending bash components to chat
			this.flushPendingBashComponents();

			if (this.onInputCallback) {
				this.onInputCallback(text);
			} else {
				this.pendingUserInputs.push(text);
			}
			this.rememberPrompt(text);
		};
	}

	private subscribeToAgent(): void {
		const unsubscribeEvents = this.session.subscribe(async (event) => {
			await this.handleEvent(event);
		});
		// The footer's test marker changes outside agent events (the verify loop, /test).
		const unsubscribeVerify = this.session.verify?.onChange(() => this.ui.requestRender());
		this.unsubscribe = () => {
			unsubscribeEvents();
			unsubscribeVerify?.();
		};
	}

	private async handleEvent(event: AgentSessionEvent): Promise<void> {
		if (!this.isInitialized) {
			await this.init();
		}

		this.footer.invalidate();
		this.programStatus.handleEvent(event);

		switch (event.type) {
			case "agent_start":
				this.notifier.turnStarted();
				this.turnStartedAt = Date.now();
				this.pendingTools.clear();
				// Restore main escape handler if retry handler is still active
				// (retry success event fires later, but we need main handler now)
				if (this.retryEscapeHandler) {
					this.defaultEditor.onEscape = this.retryEscapeHandler;
					this.retryEscapeHandler = undefined;
				}
				break;

			case "turn_start":
				if (this.settingsManager.getShowTerminalProgress()) {
					this.ui.terminal.setProgress(true);
				}
				if (this.workingVisible) {
					if (this.activeStatusIndicator?.kind !== "working") {
						this.showWorkingStatusIndicator();
					}
				} else {
					this.clearStatusIndicator();
				}
				this.ui.requestRender();
				break;

			case "queue_update":
				this.updatePendingMessagesDisplay();
				this.ui.requestRender();
				break;

			case "entry_appended":
				if (this.entriesRenderedByBoundaryCompaction.delete(event.entry.id)) break;
				if (event.entry.type === "custom") {
					this.addCustomEntryToChat(event.entry);
					this.ui.requestRender();
				} else if (event.entry.type === "usage" && event.entry.kind === "cache_warm") {
					this.addCacheWarmingUsage(event.entry);
					this.ui.requestRender();
				} else if (event.entry.type === "custom_message" && event.entry.display) {
					this.addMessageToChat(
						createCustomMessage(
							event.entry.customType,
							event.entry.content,
							event.entry.display,
							event.entry.details,
							event.entry.timestamp,
						),
					);
					this.ui.requestRender();
				} else if (event.entry.type === "compaction") {
					const entries = this.sessionManager.buildContextEntries();
					if (entries[0]?.id !== event.entry.id) break;
					this.chatContainer.clear();
					const branch = this.sessionManager.getBranch();
					const compactionIndex = branch.findIndex((entry) => entry.id === event.entry.id);
					const entriesAfterCompaction = new Set(branch.slice(compactionIndex + 1).map((entry) => entry.id));
					const retainedEntries = entries.slice(1);
					this.renderSessionEntries(retainedEntries.filter((entry) => !entriesAfterCompaction.has(entry.id)));
					this.addMessageToChat(
						createCompactionSummaryMessage(event.entry.summary, event.entry.tokensBefore, event.entry.timestamp),
					);
					if (event.entry.usage) {
						this.addCompactionCostNotice({
							type: "compaction_cost",
							kind: "compaction",
							usage: event.entry.usage,
						});
					}
					this.renderSessionEntries(retainedEntries.filter((entry) => entriesAfterCompaction.has(entry.id)));
					for (const entryId of entriesAfterCompaction) this.entriesRenderedByBoundaryCompaction.add(entryId);
					this.footer.invalidate();
					this.ui.requestRender();
				}
				break;

			case "session_info_changed":
				this.updateTerminalTitle();
				this.footer.invalidate();
				this.ui.requestRender();
				break;

			case "thinking_level_changed":
				this.footer.invalidate();
				this.updateEditorBorderColor();
				break;

			case "message_start":
				if (event.message.role === "custom") {
					this.addMessageToChat(event.message);
					this.ui.requestRender();
				} else if (event.message.role === "user") {
					this.addMessageToChat(event.message);
					this.updatePendingMessagesDisplay();
					this.ui.requestRender();
				} else if (event.message.role === "assistant") {
					this.streamingComponent = new AssistantMessageComponent(
						undefined,
						this.hideThinkingBlock,
						this.getAssistantMarkdownTheme(),
						this.hiddenThinkingLabel,
						this.outputPad,
						this.getMarkdownTransformers(),
					);
					this.streamingMessage = event.message;
					this.chatContainer.addChild(this.streamingComponent);
					this.streamingComponent.updateContent(this.streamingMessage, true);
					this.ui.requestRender();
				}
				break;

			case "message_update":
				if (this.streamingComponent && event.message.role === "assistant") {
					this.streamingMessage = event.message;
					this.streamingComponent.updateContent(this.streamingMessage, true);

					for (const content of this.streamingMessage.content) {
						if (content.type === "toolCall") {
							if (!this.pendingTools.has(content.id)) {
								const component = new ToolExecutionComponent(
									content.name,
									content.id,
									content.arguments,
									{
										showImages: this.settingsManager.getShowImages(),
										imageWidthCells: this.settingsManager.getImageWidthCells(),
										outputPad: this.outputPad,
									},
									this.getRegisteredToolDefinition(content.name),
									this.ui,
									this.sessionManager.getCwd(),
								);
								component.setExpanded(this.toolOutputExpanded);
								this.addToolComponentToChat(component);
								this.pendingTools.set(content.id, component);
							} else {
								const component = this.pendingTools.get(content.id);
								if (component) {
									component.updateArgs(content.arguments);
								}
							}
						}
					}
					this.ui.requestRender();
				}
				break;

			case "message_end":
				if (event.message.role === "user") break;
				if (this.streamingComponent && event.message.role === "assistant") {
					this.streamingMessage = event.message;
					let errorMessage: string | undefined;
					if (this.streamingMessage.stopReason === "aborted") {
						const retryAttempt = this.session.retryAttempt;
						errorMessage =
							retryAttempt > 0
								? `Aborted after ${retryAttempt} retry attempt${retryAttempt > 1 ? "s" : ""}`
								: "Operation aborted";
						this.streamingMessage.errorMessage = errorMessage;
					}
					this.streamingComponent.updateContent(this.streamingMessage, false);

					if (this.streamingMessage.stopReason === "aborted" || this.streamingMessage.stopReason === "error") {
						if (!errorMessage) {
							errorMessage = this.streamingMessage.errorMessage || "Error";
						}
						for (const [, component] of this.pendingTools.entries()) {
							component.updateResult({
								content: [{ type: "text", text: errorMessage }],
								isError: true,
							});
						}
						this.pendingTools.clear();
						this.maybeSuggestBugReport(this.streamingMessage);
					} else {
						// Args are now complete - trigger diff computation for edit tools
						for (const [, component] of this.pendingTools.entries()) {
							component.setArgsComplete();
						}
						this.maybeShowThinkingDropNotice(this.streamingMessage);
						this.maybeShowCacheMissNotice(this.streamingMessage);
					}
					this.streamingComponent = undefined;
					this.streamingMessage = undefined;
					this.footer.invalidate();
				}
				this.ui.requestRender();
				break;

			case "bash_execution_update":
				// The bash execution callback handles TUI output rendering.
				break;

			case "tool_execution_start": {
				// Nested calls (from codemode scripts) are shown inside their parent's row.
				if (event.parentToolCallId) break;
				let component = this.pendingTools.get(event.toolCallId);
				if (!component) {
					component = new ToolExecutionComponent(
						event.toolName,
						event.toolCallId,
						event.args,
						{
							showImages: this.settingsManager.getShowImages(),
							imageWidthCells: this.settingsManager.getImageWidthCells(),
							outputPad: this.outputPad,
						},
						this.getRegisteredToolDefinition(event.toolName),
						this.ui,
						this.sessionManager.getCwd(),
					);
					component.setExpanded(this.toolOutputExpanded);
					this.addToolComponentToChat(component);
					this.pendingTools.set(event.toolCallId, component);
				}
				component.markExecutionStarted();
				this.ui.requestRender();
				break;
			}

			case "tool_execution_update": {
				const component = this.pendingTools.get(event.toolCallId);
				if (component) {
					component.updateResult({ ...event.partialResult, isError: false }, true);
					this.ui.requestRender();
				}
				break;
			}

			case "tool_execution_end": {
				if (event.isError) this.maybeShowInstallChangeWarning();
				if (event.toolName === "todo") this.refreshTodoPanel();
				const component = this.pendingTools.get(event.toolCallId);
				if (component) {
					component.updateResult({ ...event.result, isError: event.isError, durationMs: event.durationMs });
					this.pendingTools.delete(event.toolCallId);
					this.ui.requestRender();
				}
				break;
			}

			case "agent_end":
				this.announceBudget();
				if (this.settingsManager.getShowTerminalProgress()) {
					this.ui.terminal.setProgress(false);
				}
				this.clearStatusIndicator("working");
				if (this.streamingComponent) {
					this.chatContainer.removeChild(this.streamingComponent);
					this.streamingComponent = undefined;
					this.streamingMessage = undefined;
				}
				this.pendingTools.clear();
				this.addTurnSummary();
				void this.refreshChangesTray();

				this.ui.requestRender();
				break;

			case "agent_settled":
				this.refreshTodoPanel();
				await this.checkShutdownRequested();
				this.maybeShowPlanApproval();
				this.notifier.turnEnded(this.turnEndNotice(), event.aborted);
				break;

			case "auto_commit":
				if (event.error) this.showWarning(`Auto-commit failed: ${event.error}`);
				else
					this.showStatus(
						`Auto-commit ${event.sha} ${event.subject} (${event.files} file${event.files === 1 ? "" : "s"})`,
					);
				break;

			case "idle_compaction":
				this.showStatus(idleCompactionNotice(event.idleMs, event.contextTokens, event.ttlMs));
				break;

			case "compaction_start": {
				if (this.settingsManager.getShowTerminalProgress()) {
					this.ui.terminal.setProgress(true);
				}
				// Keep editor active; submissions are queued during compaction.
				this.autoCompactionEscapeHandler = this.defaultEditor.onEscape;
				this.defaultEditor.onEscape = () => {
					this.session.abortCompaction();
				};
				const colorFn = isEmbeddedStatus(this.editor)
					? (text: string) =>
							(this.editor.borderColor ?? theme.getThinkingBorderColor(this.session.thinkingLevel || "off"))(
								text,
							)
					: undefined;
				this.showStatusIndicator(new CompactionStatusIndicator(this.ui, event.reason, colorFn));
				this.ui.requestRender();
				break;
			}

			case "compaction_end": {
				if (this.settingsManager.getShowTerminalProgress()) {
					this.ui.terminal.setProgress(false);
				}
				if (this.autoCompactionEscapeHandler) {
					this.defaultEditor.onEscape = this.autoCompactionEscapeHandler;
					this.autoCompactionEscapeHandler = undefined;
				}
				this.clearStatusIndicator("compaction");
				if (event.aborted) {
					if (event.reason === "manual") {
						this.showError("Compaction cancelled");
					} else {
						this.showStatus("Auto-compaction cancelled");
					}
				} else if (event.result) {
					const entries = this.sessionManager.buildContextEntries();
					if (entries[0]?.type !== "compaction") {
						throw new Error("Completed compaction is missing from the session context");
					}
					this.chatContainer.clear();
					// The latest compaction is prepended for model context; append it below at its chronological position.
					this.renderSessionEntries(entries.slice(1));
					this.addMessageToChat(
						createCompactionSummaryMessage(
							event.result.summary,
							event.result.tokensBefore,
							new Date().toISOString(),
						),
					);
					if (event.result.usage) {
						this.addCompactionCostNotice({
							type: "compaction_cost",
							kind: "compaction",
							usage: event.result.usage,
						});
					}
					this.footer.invalidate();
				} else if (event.errorMessage) {
					if (event.reason === "manual") {
						this.showError(event.errorMessage);
					} else {
						this.chatContainer.addChild(new Spacer(1));
						const errorMessage = event.errorMessage;
						this.chatContainer.addChild(new ThemedText(() => theme.fg("error", errorMessage), 1, 0));
					}
				}
				void this.flushCompactionQueue({ willRetry: event.willRetry });
				this.ui.requestRender();
				break;
			}

			case "auto_retry_start": {
				// Set up escape to abort retry
				this.retryEscapeHandler = this.defaultEditor.onEscape;
				this.defaultEditor.onEscape = () => {
					this.session.abortRetry();
				};
				this.showStatusIndicator(
					new RetryStatusIndicator(this.ui, event.attempt, event.maxAttempts, event.delayMs),
				);
				this.ui.requestRender();
				break;
			}

			case "model_fallback":
				if (event.scope === "turn") {
					this.showWarning(
						`${event.from} unavailable, switched to ${event.to}${event.thinkingLevel ? ` (thinking ${event.thinkingLevel})` : ""} for this turn`,
					);
				} else {
					this.showStatus(
						event.to === "auto"
							? `Request failed on ${event.from}; the router will pick another model`
							: `Request failed on ${event.from}; trying ${event.to}`,
					);
				}
				break;

			case "failover_notice":
				this.showWarning(event.message);
				break;

			case "router_decision": {
				this.footer.invalidate();
				this.updateEditorBorderColor();
				const { decision } = event;
				if (decision.error) {
					if (this.lastRouterWarning !== decision.error) {
						this.lastRouterWarning = decision.error;
						this.showWarning(
							`Router: ${decision.error}. ${decision.source === "held-fallback" ? `Kept ${decision.model.id}` : `Using default ${decision.model.id}`} (/router for details).`,
						);
					}
				} else {
					this.lastRouterWarning = undefined;
				}
				break;
			}

			case "router_mode_changed":
				this.footer.invalidate();
				this.updateEditorBorderColor();
				break;

			case "prompt_drift":
				this.showStatus(event.message);
				break;

			case "auto_retry_end": {
				// Restore escape handler
				if (this.retryEscapeHandler) {
					this.defaultEditor.onEscape = this.retryEscapeHandler;
					this.retryEscapeHandler = undefined;
				}
				this.clearStatusIndicator("retry");
				// Show error only on final failure (success shows normal response)
				if (!event.success) {
					this.showError(`Retry failed after ${event.attempt} attempts: ${event.finalError || "Unknown error"}`);
				}
				this.ui.requestRender();
				break;
			}

			case "summarization_retry_scheduled": {
				this.showError(event.errorMessage);
				this.showStatusIndicator(
					new RetryStatusIndicator(this.ui, event.attempt, event.maxAttempts, event.delayMs),
				);
				this.ui.requestRender();
				break;
			}

			case "summarization_retry_attempt_start": {
				this.clearStatusIndicator("retry");
				if (event.source === "branchSummary") {
					this.showStatusIndicator(new BranchSummaryStatusIndicator(this.ui));
				} else {
					const colorFn = isEmbeddedStatus(this.editor)
						? (text: string) =>
								(this.editor.borderColor ?? theme.getThinkingBorderColor(this.session.thinkingLevel || "off"))(
									text,
								)
						: undefined;
					this.showStatusIndicator(new CompactionStatusIndicator(this.ui, event.reason, colorFn));
				}
				this.ui.requestRender();
				break;
			}

			case "summarization_retry_finished": {
				this.clearStatusIndicator("retry");
				this.ui.requestRender();
				break;
			}
		}
	}

	/** Extract text content from a user message */
	private getUserMessageText(message: Message): string {
		if (message.role !== "user") return "";
		const textBlocks =
			typeof message.content === "string"
				? [{ type: "text", text: message.content }]
				: message.content.filter((c: { type: string }) => c.type === "text");
		return textBlocks.map((c) => (c as { text: string }).text).join("");
	}

	/** Show a managed-tool status update in the chat. */
	private showManagedToolStatus(status: ToolStatus): void {
		if (!this.managedToolStatusStarted) {
			this.chatContainer.addChild(new Spacer(1));
			this.managedToolStatusStarted = true;
		}
		const message = status.type === "warning" ? `Warning: ${status.message}` : status.message;
		const color = status.type === "warning" ? "warning" : "dim";
		this.chatContainer.addChild(new ThemedText(() => theme.fg(color, message), 1, 0));
		this.lastStatusSpacer = undefined;
		this.lastStatusText = undefined;
		this.ui.requestRender();
	}

	/**
	 * Show a status message in the chat.
	 *
	 * If multiple status messages are emitted back-to-back (without anything else being added to the chat),
	 * we update the previous status line instead of appending new ones to avoid log spam.
	 */
	private showStatus(message: string): void {
		const children = this.chatContainer.children;
		const last = children.length > 0 ? children[children.length - 1] : undefined;
		const secondLast = children.length > 1 ? children[children.length - 2] : undefined;

		if (last && secondLast && last === this.lastStatusText && secondLast === this.lastStatusSpacer) {
			this.lastStatusMessage = message;
			this.lastStatusText.invalidate();
			this.ui.requestRender();
			return;
		}

		const spacer = new Spacer(1);
		this.lastStatusMessage = message;
		const text = new ThemedText(() => theme.fg("dim", this.lastStatusMessage), 1, 0);
		this.chatContainer.addChild(spacer);
		this.chatContainer.addChild(text);
		this.lastStatusSpacer = spacer;
		this.lastStatusText = text;
		this.ui.requestRender();
	}

	private addCustomEntryToChat(entry: Extract<SessionEntry, { type: "custom" }>): void {
		const renderer = this.session.extensionRunner.getEntryRenderer(entry.customType);
		if (!renderer) {
			return;
		}
		const component = new CustomEntryComponent(entry, renderer, this.outputPad);
		component.setExpanded(this.toolOutputExpanded);
		if (!component.hasContent()) {
			return;
		}

		if (this.streamingComponent) {
			const streamingIndex = this.chatContainer.children.indexOf(this.streamingComponent);
			if (streamingIndex >= 0) {
				this.chatContainer.children.splice(streamingIndex, 0, component);
				return;
			}
		}

		this.chatContainer.addChild(component);
	}

	private addMessageToChat(message: AgentMessage, options?: { populateHistory?: boolean }): void {
		switch (message.role) {
			case "bashExecution": {
				const component = new BashExecutionComponent(
					message.command,
					this.ui,
					message.excludeFromContext,
					this.outputPad,
				);
				if (message.output) {
					component.appendOutput(message.output);
				}
				component.setComplete(
					message.exitCode,
					message.cancelled,
					message.truncated ? ({ truncated: true } as TruncationResult) : undefined,
					message.fullOutputPath,
				);
				this.chatContainer.addChild(component);
				break;
			}
			case "custom": {
				if (message.display) {
					const renderer = this.session.extensionRunner.getMessageRenderer(message.customType);
					const component = new CustomMessageComponent(
						message,
						renderer,
						this.getMarkdownThemeWithSettings(),
						this.outputPad,
					);
					component.setExpanded(this.toolOutputExpanded);
					this.chatContainer.addChild(component);
				}
				break;
			}
			case "compactionSummary": {
				this.chatContainer.addChild(new Spacer(1));
				const component = new CompactionSummaryMessageComponent(
					message,
					this.getMarkdownThemeWithSettings(),
					this.outputPad,
				);
				component.setExpanded(this.toolOutputExpanded);
				this.chatContainer.addChild(component);
				break;
			}
			case "branchSummary": {
				this.chatContainer.addChild(new Spacer(1));
				const component = new BranchSummaryMessageComponent(
					message,
					this.getMarkdownThemeWithSettings(),
					this.outputPad,
				);
				component.setExpanded(this.toolOutputExpanded);
				this.chatContainer.addChild(component);
				break;
			}
			case "system":
				break;
			case "user": {
				const textContent = this.getUserMessageText(message);
				if (textContent) {
					if (this.chatContainer.children.length > 0) {
						this.chatContainer.addChild(new Spacer(1));
					}
					const skillBlock = parseSkillBlock(textContent);
					if (skillBlock) {
						// Render skill block (collapsible)
						const component = new SkillInvocationMessageComponent(
							skillBlock,
							this.getMarkdownThemeWithSettings(),
							this.outputPad,
						);
						component.setExpanded(this.toolOutputExpanded);
						this.chatContainer.addChild(component);
						// Render user message separately if present
						if (skillBlock.userMessage) {
							this.chatContainer.addChild(new Spacer(1));
							const userComponent = new UserMessageComponent(
								skillBlock.userMessage,
								this.getMarkdownThemeWithSettings(),
								this.outputPad,
								this.getMarkdownTransformers(),
							);
							userComponent.timestamp = message.timestamp;
							this.chatContainer.addChild(userComponent);
						}
					} else {
						const userComponent = new UserMessageComponent(
							textContent,
							this.getMarkdownThemeWithSettings(),
							this.outputPad,
							this.getMarkdownTransformers(),
						);
						userComponent.timestamp = message.timestamp;
						this.chatContainer.addChild(userComponent);
					}
					if (options?.populateHistory) {
						this.editor.addToHistory?.(textContent);
					}
				}
				break;
			}
			case "assistant": {
				const assistantComponent = new AssistantMessageComponent(
					message,
					this.hideThinkingBlock,
					this.getAssistantMarkdownTheme(),
					this.hiddenThinkingLabel,
					this.outputPad,
					this.getMarkdownTransformers(),
				);
				this.chatContainer.addChild(assistantComponent);
				break;
			}
			case "toolResult": {
				// Tool results are rendered inline with tool calls, handled separately
				break;
			}
			default: {
				const _exhaustive: never = message;
			}
		}
	}

	private renderSessionItems(
		items: readonly RenderSessionItem[],
		options: { updateFooter?: boolean; populateHistory?: boolean } = {},
	): void {
		this.pendingTools.clear();
		const renderedPendingTools = new Map<string, ToolExecutionComponent>();
		// Cache misses are not persisted, unlike successful cache-warming usage.
		// Re-derive them and inject them after the assistant messages that paid for them.
		const cacheMisses = this.settingsManager.getShowCacheMissNotices()
			? collectCacheMisses(this.sessionManager.getEntries(), this.session.modelRuntime)
			: new Map<AssistantMessage, CacheMiss>();

		if (options.updateFooter) {
			this.footer.invalidate();
			this.updateEditorBorderColor();
		}

		for (const item of items) {
			if (isCustomSessionEntry(item)) {
				this.addCustomEntryToChat(item);
				continue;
			}
			if (isUsageSessionEntry(item)) {
				this.addCacheWarmingUsage(item);
				continue;
			}
			if (isCompactionCostNotice(item)) {
				this.addCompactionCostNotice(item);
				continue;
			}

			const message = item;
			// Assistant messages need special handling for tool calls
			if (message.role === "assistant") {
				this.addMessageToChat(message);
				// Render tool call components
				for (const content of message.content) {
					if (content.type === "toolCall") {
						const component = new ToolExecutionComponent(
							content.name,
							content.id,
							content.arguments,
							{
								showImages: this.settingsManager.getShowImages(),
								imageWidthCells: this.settingsManager.getImageWidthCells(),
								outputPad: this.outputPad,
							},
							this.getRegisteredToolDefinition(content.name),
							this.ui,
							this.sessionManager.getCwd(),
						);
						component.setExpanded(this.toolOutputExpanded);
						this.addToolComponentToChat(component);

						if (message.stopReason === "aborted" || message.stopReason === "error") {
							let errorMessage: string;
							if (message.stopReason === "aborted") {
								const retryAttempt = this.session.retryAttempt;
								errorMessage =
									retryAttempt > 0
										? `Aborted after ${retryAttempt} retry attempt${retryAttempt > 1 ? "s" : ""}`
										: "Operation aborted";
							} else {
								errorMessage = message.errorMessage || "Error";
							}
							component.updateResult({ content: [{ type: "text", text: errorMessage }], isError: true });
						} else {
							renderedPendingTools.set(content.id, component);
						}
					}
				}
				if (message.stopReason !== "aborted" && message.stopReason !== "error") {
					const miss = cacheMisses.get(message);
					if (miss) this.addCacheMissNotice(miss);
				}
			} else if (message.role === "toolResult") {
				// Match tool results to pending tool components
				const component = renderedPendingTools.get(message.toolCallId);
				if (component) {
					component.updateResult(message);
					renderedPendingTools.delete(message.toolCallId);
				}
			} else {
				// All other messages use standard rendering
				this.addMessageToChat(message, options);
			}
		}

		for (const [toolCallId, component] of renderedPendingTools) {
			this.pendingTools.set(toolCallId, component);
		}
		this.ui.requestRender();
	}

	/**
	 * Render session entries to chat. Used for initial load and rebuild after compaction.
	 * @param entries Compaction-aware session entries to render
	 * @param options.updateFooter Update footer state
	 * @param options.populateHistory Add user messages to editor history
	 */
	private renderSessionEntries(
		entries: SessionEntry[],
		options: { updateFooter?: boolean; populateHistory?: boolean } = {},
	): void {
		// Selection coordinates point into the transcript being replaced (#9311).
		if (this.renderer instanceof TuiAltScreen) this.renderer.resetTextSelection();
		const items = entries.flatMap((entry): RenderSessionItem[] => {
			if (entry.type === "custom" || (entry.type === "usage" && entry.kind === "cache_warm")) {
				return [entry];
			}
			const messages = sessionEntryToContextMessages(entry);
			if ((entry.type === "compaction" || entry.type === "branch_summary") && entry.usage && messages.length > 0) {
				return [...messages, { type: "compaction_cost", kind: entry.type, usage: entry.usage }];
			}
			return messages;
		});
		this.renderSessionItems(items, options);
	}

	private addCacheWarmingUsage(entry: UsageEntry): void {
		if (!this.settingsManager.getShowCacheMissNotices()) return;
		this.chatContainer.addChild(new Spacer(1));
		const usage = `Cache refresh: ${entry.usage.input + entry.usage.cacheRead} prompt tokens`;
		this.chatContainer.addChild(new ThemedText(() => theme.fg("dim", usage), 1, 0));
	}

	/**
	 * Render billing usage for a compaction or branch summary. The notice is derived
	 * from persisted summary usage and is not stored as a separate session entry.
	 */
	private addCompactionCostNotice(notice: CompactionCostNotice): void {
		if (!this.settingsManager.getShowCacheMissNotices()) return;

		const { usage } = notice;
		const tokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
		const cost = usage.cost.total >= 0.01 ? ` (~$${usage.cost.total.toFixed(2)})` : "";
		const label = notice.kind === "compaction" ? "Compaction" : "Branch summary";
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(
			new ThemedText(() => theme.fg("warning", `${label}: ${formatTokens(tokens)} tokens billed${cost}`), 1, 0),
		);
	}

	private static countDroppedThinkingBlocks(message: AssistantMessage): number {
		let count = 0;
		for (const diagnostic of message.diagnostics ?? []) {
			if (diagnostic.type !== "anthropic_input_transformations") continue;
			const transformations = diagnostic.details?.transformations;
			if (!Array.isArray(transformations)) continue;
			count += transformations.filter(
				(transformation) =>
					typeof transformation === "object" &&
					transformation !== null &&
					(transformation as Record<string, unknown>).type === "thinking_dropped",
			).length;
		}
		return count;
	}

	private maybeShowThinkingDropNotice(message: AssistantMessage): void {
		if (!this.settingsManager.getShowCacheMissNotices()) return;

		const droppedCount = InteractiveMode.countDroppedThinkingBlocks(message);
		if (droppedCount === 0) return;

		let previousDroppedCount = 0;
		// message_end reaches the UI before the current message is persisted,
		// so the branch's last assistant message is the previous response.
		const branch = this.sessionManager.getBranch();
		for (let i = branch.length - 1; i >= 0; i--) {
			const entry = branch[i];
			if (entry.type === "message" && entry.message.role === "assistant") {
				previousDroppedCount = InteractiveMode.countDroppedThinkingBlocks(entry.message);
				break;
			}
		}
		if (droppedCount <= previousDroppedCount) return;

		const noun = droppedCount === 1 ? "thinking block" : "thinking blocks";
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(
			new ThemedText(
				() => theme.fg("warning", `Anthropic dropped ${droppedCount} ${noun} (details in session)`),
				1,
				0,
			),
		);
	}

	/**
	 * Show a transcript notice when a completed assistant message paid for a
	 * significant cache miss. Only states observable facts: the miss itself,
	 * a model switch, or an idle gap past the cache TTL.
	 */
	private maybeShowCacheMissNotice(message: AssistantMessage): void {
		if (!this.settingsManager.getShowCacheMissNotices()) return;

		// Entries don't contain `message` yet: message_end fires before persistence.
		const miss = detectCacheMiss(this.sessionManager.getEntries(), message, this.session.modelRuntime);
		if (miss) this.addCacheMissNotice(miss);
	}

	private addCacheMissNotice(miss: CacheMiss): void {
		if (miss.missedTokens < 20_000 && miss.missedCost < 0.1) return;

		const cost = miss.missedCost >= 0.01 ? ` (~$${miss.missedCost.toFixed(2)})` : "";
		const reBilled = `${formatTokens(miss.missedTokens)} tokens re-billed${cost}`;
		let label = "Cache miss";
		if (miss.modelChanged) {
			label = "Cache miss after model switch";
		} else if (miss.idleMs >= (this.session.model ? sessionIdleTtlMs(this.session.model) : CACHE_TTL_MS)) {
			label = `Cache miss after ${Math.round(miss.idleMs / 60_000)}m idle`;
		}
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new ThemedText(() => theme.fg("warning", `${label}: ${reBilled}`), 1, 0));
	}

	/** Show the session's current todo list above the editor (hidden when empty or all done). */
	private refreshTodoPanel(): void {
		const before = this.todoPanel.visible;
		this.todoPanel.setItems(this.session.todoItems);
		if (before || this.todoPanel.visible) this.renderWidgets();
	}

	renderInitialMessages(): void {
		this.refreshTodoPanel();
		const entries = this.sessionManager.buildContextEntries();
		this.renderSessionEntries(entries, {
			updateFooter: true,
			populateHistory: true,
		});
		this.renderProjectTrustWarningIfNeeded();

		// Show compaction info if session was compacted
		const allEntries = this.sessionManager.getEntries();
		const compactionCount = allEntries.filter((e) => e.type === "compaction").length;
		if (compactionCount > 0) {
			const times = compactionCount === 1 ? "1 time" : `${compactionCount} times`;
			this.showStatus(`Session compacted ${times}`);
		}
	}

	private renderProjectTrustWarningIfNeeded(): void {
		if (this.settingsManager.isProjectTrusted() || !hasTrustRequiringProjectResources(this.sessionManager.getCwd())) {
			return;
		}

		if (this.chatContainer.children.length > 0) {
			this.chatContainer.addChild(new Spacer(1));
		}
		this.chatContainer.addChild(
			new ThemedText(
				() =>
					theme.fg(
						"warning",
						`This project is not trusted. Project ${CONFIG_DIR_NAME} resources and packages are ignored. Use /trust to save a trust decision, then restart ${APP_NAME}.`,
					),
				1,
				0,
			),
		);
	}

	async getUserInput(): Promise<string> {
		const queuedInput = this.pendingUserInputs.shift();
		if (queuedInput !== undefined) {
			return queuedInput;
		}

		return new Promise((resolve) => {
			this.onInputCallback = (text: string) => {
				this.onInputCallback = undefined;
				resolve(text);
			};
		});
	}

	/** The model and thinking level that answered the turn, and in auto mode why the router picked them. */
	private currentRoutePick(): TurnRoutePick | undefined {
		if (this.session.isAutoRouting) {
			const decision = this.session.lastRouteDecision;
			const model = decision?.model.id ?? this.session.model?.id;
			if (!model) return undefined;
			return {
				model,
				thinking: decision?.thinkingLevel ?? this.session.thinkingLevel,
				mode: `auto:${this.session.routerMode}`,
				reason: decision ? shortRouteReason(decision) : undefined,
				escalation: decision?.escalationSteps,
			};
		}
		const model = this.session.model;
		if (!model) return undefined;
		return { model: model.id, thinking: model.reasoning ? this.session.thinkingLevel : undefined };
	}

	/**
	 * Write the turn summary line (time, files, tools, cost, router pick) after an agent turn. The file counts
	 * come from the turn's checkpoint once it is summarized, else from the turn's edit diffs.
	 */
	private addTurnSummary(): void {
		const startedAt = this.turnStartedAt;
		this.turnStartedAt = undefined;
		const display = this.settingsManager.getDisplaySettings();
		if (startedAt === undefined) return;
		const stats = collectTurnStats(this.sessionManager.getBranch() as unknown as TurnEntryLike[]);
		const endedAt = Date.now();
		let data: TurnSummaryData = {
			status: stats.status,
			durationMs: endedAt - startedAt,
			tools: stats.tools,
			toolErrors: stats.toolErrors,
			cost: stats.cost,
			files: stats.editFiles.count > 0 ? stats.editFiles : undefined,
			route: this.currentRoutePick(),
			endedAt,
		};
		// The footer keeps the last turn whatever the mode: a footer layout with the turn item shows it.
		this.footer.setLastTurn(data);
		const component =
			display.turnSummary === "reply" && shouldShowTurnSummary(data)
				? new TurnSummaryComponent(
						data,
						this.outputPad,
						() => this.ui.requestRender(),
						() => this.settingsManager.getDisplaySettings().turnSummaryFields,
					)
				: undefined;
		if (component) this.chatContainer.addChild(component);
		const store = this.session.checkpoints;
		const entryId = stats.userEntryId;
		if (!store || !entryId) return;
		void (async () => {
			await store.idle();
			const checkpoint = store.forEntry(entryId);
			if (!checkpoint) return;
			const files = filesFromChangeSummary(await store.summarize(checkpoint.id));
			if (!files) return;
			data = { ...data, files };
			component?.setData({ ...component.getData(), files });
			this.footer.setLastTurn(data);
			this.ui.requestRender();
		})().catch(() => {});
	}

	/** `display.turnSummary` and its fields, pushed to the footer. */
	private applyFooterTurnSummary(): void {
		const display = this.settingsManager.getDisplaySettings();
		this.footer.setTurnSummary(display.turnSummary, display.turnSummaryFields);
	}

	/** Push the `display.*` settings to the tool renderers, which read them at render time. */
	private applyTranscriptDisplaySettings(): void {
		const display = this.settingsManager.getDisplaySettings();
		setTranscriptDisplay({
			editDiffs: display.editDiffs,
			diffLayout: display.diff,
			diffSyntax: display.diffSyntax,
			groupReads: display.groupReads,
			turnSummary: display.turnSummary === "reply",
			timestamps: display.timestamps,
		});
	}

	/**
	 * Add a tool card to the transcript. Consecutive read-only calls (read, grep, find, ls) fold into one
	 * ToolGroupComponent line; assistant messages with no visible text between them do not break the run.
	 */
	private addToolComponentToChat(component: ToolExecutionComponent): void {
		if (!this.settingsManager.getDisplaySettings().groupReads || !isGroupableTool(component.getToolName())) {
			this.chatContainer.addChild(component);
			return;
		}
		const children = this.chatContainer.children;
		for (let i = children.length - 1; i >= 0; i--) {
			const child = children[i];
			if (child instanceof ToolGroupComponent) {
				child.addTool(component);
				return;
			}
			if (child instanceof ToolExecutionComponent) {
				if (!isGroupableTool(child.getToolName())) break;
				const group = new ToolGroupComponent(this.sessionManager.getCwd(), this.outputPad, () =>
					this.ui.requestRender(),
				);
				group.setGroupExpanded(this.toolOutputExpanded);
				group.addTool(child);
				group.addTool(component);
				children[i] = group;
				return;
			}
			if (child instanceof AssistantMessageComponent && child.hasNoVisibleText()) continue;
			break;
		}
		this.chatContainer.addChild(component);
	}

	private rebuildChatFromMessages(): void {
		this.refreshTodoPanel();
		this.chatContainer.clear();
		this.renderSessionEntries(this.sessionManager.buildContextEntries());
	}

	// =========================================================================
	// Key handlers
	// =========================================================================

	private handleCtrlC(): void {
		const now = Date.now();
		if (now - this.lastSigintTime < 500) {
			void this.shutdown();
		} else {
			this.clearEditor();
			this.lastSigintTime = now;
		}
	}

	private handleCtrlD(): void {
		// Only called when editor is empty (enforced by CustomEditor)
		void this.shutdown();
	}

	/**
	 * Gracefully shutdown the agent.
	 * Stops the TUI before emitting shutdown events so extension UI cleanup cannot
	 * repaint the final frame while the process is exiting.
	 */
	private isShuttingDown = false;

	private async shutdown(options?: { fromSignal?: boolean }): Promise<void> {
		if (this.isShuttingDown) return;
		this.isShuttingDown = true;
		// Keep signal handlers registered until terminal cleanup has completed.
		// `signal-exit` checks the listener list during the same SIGTERM/SIGHUP
		// dispatch and re-sends the signal if only its own listeners remain.

		if (options?.fromSignal) {
			// Signal-triggered shutdown (SIGTERM/SIGHUP). Emit extension cleanup
			// (session_shutdown) BEFORE touching the terminal. Extension teardown
			// such as removing sockets does not write to the tty, so it must not be
			// skipped if a later terminal-restore write fails on a dead or stalled
			// terminal. If the terminal is gone, the restore writes below emit EIO,
			// which the stdout/stderr error handler turns into emergencyTerminalExit;
			// the render loop is already idle, so this cannot hot-spin (see #4144).
			await this.runtimeHost.dispose();
			this.themeController.disableAutoSync();
			await this.ui.terminal.drainInput(1000);
			this.stop();
			process.exit(0);
		}

		// Interactive quit (Ctrl+D, Ctrl+C, /quit, extension shutdown()). Stop the
		// TUI before emitting shutdown events so extension UI cleanup cannot repaint
		// the final frame while the process is exiting.
		// Drain any in-flight Kitty key release events before stopping.
		// This prevents escape sequences from leaking to the parent shell over slow SSH.
		this.themeController.disableAutoSync();
		await this.ui.terminal.drainInput(1000);

		this.stop();
		await this.runtimeHost.dispose();

		const resumeCommand = formatResumeCommand(this.sessionManager);
		if (resumeCommand) {
			process.stdout.write(`${chalk.dim("To resume this session:")} ${resumeCommand}\n`);
		}
		try {
			await this.options.onExit?.();
		} catch (error) {
			process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		}

		process.exit(0);
	}

	private emergencyTerminalExit(): never {
		this.isShuttingDown = true;
		this.unregisterSignalHandlers();
		killTrackedDetachedChildren();
		// The terminal is gone. Do not run normal shutdown because TUI and
		// extension cleanup can write restore sequences and re-trigger EIO.
		process.exit(129);
	}

	/**
	 * Last-resort handler for uncaught exceptions. The TUI puts stdin into raw
	 * mode and hides the cursor; without this handler, an uncaught throw from
	 * anywhere (e.g. an extension's async `ChildProcess.on("exit")` callback)
	 * tears down the process while leaving the terminal in raw mode with no
	 * cursor, requiring `stty sane && reset` to recover.
	 *
	 * Unlike emergencyTerminalExit, the terminal is still alive here, so we
	 * call ui.stop() to restore cooked mode, the cursor, and disable bracketed
	 * paste / Kitty / modifyOtherKeys sequences.
	 */
	private uncaughtCrash(error: Error): never {
		// A dead terminal is not a RunKiln crash. Do not try to restore it or record it.
		if (isDeadTerminalError(error)) {
			this.emergencyTerminalExit();
		}
		if (this.isShuttingDown) {
			process.exit(1);
		}
		this.isShuttingDown = true;
		try {
			this.unregisterSignalHandlers();
		} catch {}
		try {
			killTrackedDetachedChildren();
		} catch {}
		try {
			this.ui.stop();
		} catch {}
		console.error(`${APP_NAME} exiting due to uncaughtException:`);
		console.error(error);
		const extensionHint = this.getCrashExtensionHint(error);
		if (extensionHint) console.error(`\n${extensionHint}`);
		if (this.recordCrash("uncaught_exception", error)) {
			console.error(`\n${this.crashReportInstructions()}`);
		}
		process.exit(1);
	}

	/**
	 * Check if shutdown was requested and perform shutdown if so.
	 */
	private async checkShutdownRequested(): Promise<void> {
		if (!this.shutdownRequested) return;
		await this.shutdown();
	}

	private registerSignalHandlers(): void {
		this.unregisterSignalHandlers();

		const signals: NodeJS.Signals[] = ["SIGTERM"];
		if (process.platform !== "win32") {
			signals.push("SIGHUP");
		}

		for (const signal of signals) {
			const handler = () => {
				// SIGHUP no longer hard-exits: graceful shutdown emits session_shutdown
				// first, then attempts terminal restore. A genuinely dead terminal
				// surfaces as an EIO on the restore writes, which the stdout/stderr
				// error handler converts into emergencyTerminalExit (see #4144, #5080).
				killTrackedDetachedChildren();
				void this.shutdown({ fromSignal: true });
			};
			process.prependListener(signal, handler);
			this.signalCleanupHandlers.push(() => process.off(signal, handler));
		}

		const terminalErrorHandler = (error: Error) => {
			if (isDeadTerminalError(error)) {
				this.emergencyTerminalExit();
			}
			throw error;
		};
		// stdin needs the handler too: once the terminal is gone, reads and setRawMode
		// fail with EIO (orphaned background process group) or ENOTTY (revoked tty).
		// Node emits these as stream errors, which are uncaught without a listener.
		for (const stream of [process.stdin, process.stdout, process.stderr]) {
			stream.on("error", terminalErrorHandler);
			this.signalCleanupHandlers.push(() => stream.off("error", terminalErrorHandler));
		}

		// Restore the terminal before the process dies on any uncaught throw.
		// Without this, an unhandled exception from extension code (or anywhere
		// in RunKiln) leaves the terminal in raw mode with no cursor.
		const uncaughtExceptionHandler = (error: Error) => this.uncaughtCrash(error);
		process.prependListener("uncaughtException", uncaughtExceptionHandler);
		this.signalCleanupHandlers.push(() => process.off("uncaughtException", uncaughtExceptionHandler));
	}

	private unregisterSignalHandlers(): void {
		for (const cleanup of this.signalCleanupHandlers) {
			cleanup();
		}
		this.signalCleanupHandlers = [];
	}

	private handleCtrlZ(): void {
		if (process.platform === "win32") {
			this.showStatus("Suspend to background is not supported on Windows");
			return;
		}

		// Keep the event loop alive while suspended. Without this, stopping the TUI
		// can leave Node with no ref'ed handles, causing the process to exit on fg
		// before the SIGCONT handler gets a chance to restore the terminal.
		const suspendKeepAlive = setInterval(() => {}, 2 ** 30);

		// Ignore SIGINT while suspended so Ctrl+C in the terminal does not
		// kill the backgrounded process. The handler is removed on resume.
		const ignoreSigint = () => {};
		process.on("SIGINT", ignoreSigint);

		// Set up handler to restore TUI when resumed
		process.once("SIGCONT", () => {
			clearInterval(suspendKeepAlive);
			process.removeListener("SIGINT", ignoreSigint);
			this.ui.start();
			this.ui.requestRender(true);
		});

		try {
			// Stop the TUI (restore terminal to normal mode)
			this.ui.stop();

			// Send SIGTSTP to process group (pid=0 means all processes in group)
			process.kill(0, "SIGTSTP");
		} catch (error) {
			clearInterval(suspendKeepAlive);
			process.removeListener("SIGINT", ignoreSigint);
			throw error;
		}
	}

	private async handleFollowUp(): Promise<void> {
		const text = (this.editor.getExpandedText?.() ?? this.editor.getText()).trim();
		if (!text) return;

		// Queue input during compaction (extension commands execute immediately)
		if (this.session.isCompacting) {
			if (this.isExtensionCommand(text)) {
				this.rememberPrompt(text);
				this.editor.setText("");
				await this.session.prompt(text);
			} else {
				this.queueCompactionMessage(text, "followUp");
			}
			return;
		}

		// Alt+Enter queues a follow-up message (waits until agent finishes)
		// This handles extension commands (execute immediately), prompt template expansion, and queueing
		if (this.session.isStreaming) {
			const images = await this.bindPromptImages(text);
			this.takePromptImages(text);
			this.rememberPrompt(text);
			this.editor.setText("");
			await this.session.prompt(text, { streamingBehavior: "followUp", images });
			this.updatePendingMessagesDisplay();
			this.ui.requestRender();
		}
		// If not streaming, Alt+Enter acts like regular Enter (trigger onSubmit)
		else if (this.editor.onSubmit) {
			this.editor.setText("");
			this.editor.onSubmit(text);
		}
	}

	private handleDequeue(): void {
		const restored = this.restoreQueuedMessagesToEditor();
		if (restored === 0) {
			this.showStatus("No queued messages to restore");
		} else {
			this.showStatus(`Restored ${restored} queued message${restored > 1 ? "s" : ""} to editor`);
		}
	}

	private updateEditorBorderColor(): void {
		if (this.isBashMode) {
			this.editor.borderColor = theme.getBashModeBorderColor();
		} else {
			const level = this.session.thinkingLevel || "off";
			this.editor.borderColor = theme.getThinkingBorderColor(level);
		}
		this.activeStatusIndicator?.invalidate();
		this.ui.requestRender();
	}

	// =========================================================================
	// Permissions
	// =========================================================================

	private permissionPromptQueue: Promise<unknown> = Promise.resolve();
	private permissionPromptComponent: PermissionPromptComponent | undefined;

	/**
	 * Show the approval prompt for one tool call in the editor slot. Prompts are shown one at a time: a second call
	 * that needs approval waits until the first is answered.
	 */
	private showPermissionPrompt(prompt: PermissionPrompt, signal?: AbortSignal): Promise<ApprovalAnswer | undefined> {
		const run = () =>
			new Promise<ApprovalAnswer | undefined>((resolve) => {
				if (signal?.aborted) {
					resolve(undefined);
					return;
				}
				let settled = false;
				const finish = (answer: ApprovalAnswer | undefined) => {
					if (settled) return;
					settled = true;
					signal?.removeEventListener("abort", onAbort);
					component.dispose();
					if (this.permissionPromptComponent === component) {
						this.permissionPromptComponent = undefined;
						this.editorContainer.clear();
						this.editorContainer.addChild(this.editor);
						this.programStatus.setBlocked("extension-dialog", undefined);
						this.ui.setFocus(this.editor);
					}
					this.ui.requestRender();
					resolve(answer);
				};
				const onAbort = () => finish(undefined);
				signal?.addEventListener("abort", onAbort, { once: true });
				const component = new PermissionPromptComponent(prompt, finish, {
					tui: this.ui,
					// timeoutAction "pause": the prompt stays open, so make sure the user hears about it.
					onTimeout: () => this.notifier.waiting("approval", `Still waiting: ${prompt.title}`, { force: true }),
				});
				this.permissionPromptComponent = component;
				this.disposeActiveSelector();
				this.editorContainer.clear();
				this.editorContainer.addChild(component);
				this.ui.setFocus(component);
				this.programStatus.setBlocked("extension-dialog", { kind: "permission", message: prompt.title });
				this.notifier.waiting("approval", prompt.title);
				this.ui.requestRender();
			});
		const next = this.permissionPromptQueue.then(run, run);
		this.permissionPromptQueue = next.catch(() => undefined);
		return next;
	}

	private permissionAutoBackend(): string | undefined {
		const judge = isPermissionJudgeAvailable() ? createPermissionJudge() : undefined;
		if (!judge) return undefined;
		const model = (judge as { model?: string }).model;
		return model ? `${judge.label} ${model}` : judge.label;
	}

	/** Mouse options for the fullscreen renderer (settings `mouse`, `terminal.pointerShape`, `terminal.fullRepaint`). */
	private clickTuiOptions() {
		return {
			mouse: this.settingsManager.getMouseMode(),
			pointerShapes: resolvePointerShapes(this.settingsManager.getPointerShapeSetting()),
			fullRepaint: this.settingsManager.getFullRepaint(),
			// Right click pastes only when it is not the card menu's button.
			openUrl: (url: string) => this.clickActions.openUrl(url),
			openTextAt: (token: string, modifiers: { ctrl: boolean; alt: boolean; shift: boolean }) =>
				this.clickActions.openTextAt(token, modifiers),
			firstSelectionHint: nativeSelectionHint(),
			onFocusChange: (focused: boolean) => setTerminalFocused(focused),
		};
	}

	private createClickActions(): ClickActions {
		return new ClickActions({
			ui: this.ui,
			settings: this.settingsManager,
			cwd: () => this.sessionManager.getCwd(),
			notify: (message) => this.confirmCopy(message, true),
			copy: (text) => this.copyTextToClipboard(text),
			runInTerminal: async (command, args) => {
				this.ui.stop();
				try {
					await runForeground(command, args);
				} finally {
					this.ui.start();
					this.ui.requestRender(true);
				}
			},
			rerunBash: (command) => {
				if (this.session.isBashRunning) {
					this.showWarning("A shell command is already running.");
					return;
				}
				void this.handleBashCommand(command);
			},
			revertFile: (card, file) => this.revertCardFile(card, file),
			rewindFrom: (card) => this.rewindFromCard(card),
		});
	}

	/** The rewind point (user turn) a tool card belongs to. */
	private async rewindPointForCard(card: ToolExecutionComponent): Promise<RewindPoint | undefined> {
		const id = card.getToolCallId();
		let userEntry: string | undefined;
		let found: string | undefined;
		for (const entry of this.sessionManager.getBranch()) {
			if (entry.type !== "message") continue;
			if (entry.message.role === "user") userEntry = entry.id;
			const content = (entry.message as { content?: unknown }).content;
			if (
				entry.message.role === "assistant" &&
				Array.isArray(content) &&
				content.some(
					(part) =>
						(part as { type?: string; id?: string }).type === "toolCall" && (part as { id?: string }).id === id,
				)
			) {
				found = userEntry;
				break;
			}
		}
		if (!found) return undefined;
		const points = await this.session.getRewindPoints();
		return points.find((point) => point.entryId === found);
	}

	/** A card's "rewind from here": the /rewind flow at the card's turn. */
	private async rewindFromCard(card: ToolExecutionComponent): Promise<void> {
		const blocked = this.checkpointBlocker();
		if (blocked) {
			this.showStatus(blocked);
			return;
		}
		const point = await this.rewindPointForCard(card);
		if (!point) {
			this.showStatus("This card is not on the current branch");
			return;
		}
		await this.rewindTo(point);
	}

	/** A card's "revert file": that one file back to before the card's turn, after a confirm. */
	private async revertCardFile(card: ToolExecutionComponent, file: string): Promise<void> {
		const blocked = this.checkpointBlocker();
		if (blocked) {
			this.showStatus(blocked);
			return;
		}
		if (!this.session.checkpoints) {
			this.showStatus("Checkpoints are off for this session (in-memory session or RUNKILN_CHECKPOINTS=0)");
			return;
		}
		try {
			const point = await this.rewindPointForCard(card);
			const plan = point ? await this.session.planFileRestore(point.entryId) : undefined;
			const cwd = this.sessionManager.getCwd();
			const target = path.resolve(cwd, file);
			const items = plan?.items.filter((item) => path.resolve(cwd, item.path) === target) ?? [];
			if (!point || !plan || items.length === 0) {
				this.showStatus(`Nothing to revert: ${path.relative(cwd, target) || file} already matches how it was`);
				return;
			}
			const single: RestorePlan = {
				...plan,
				items,
				skipped: plan.skipped.filter((item) => path.resolve(cwd, item.path) === target),
				changedOutside: plan.changedOutside.filter((item) => path.resolve(cwd, item) === target),
				partial: true,
			};
			if (!(await this.confirmFileRestore(single, point))) {
				this.showStatus("Revert cancelled; no files changed");
				return;
			}
			const result = await this.session.applyFileRestore(single);
			void this.refreshChangesTray();
			const notice = `Reverted to before ${this.quoteTurn(point)}: ${formatRestoreNotice(result)}`;
			if (result.failed.length > 0) this.showWarning(notice);
			else this.showStatus(notice);
		} catch (error) {
			this.showError(error instanceof Error ? error.message : String(error));
		}
	}

	/** A click on a footer item. */
	private handleFooterAction(action: FooterAction, event: TuiMouseEvent): void {
		switch (action) {
			case "router":
				this.handleRouterCommand("");
				return;
			case "model":
				this.showModelSelector();
				return;
			case "thinking":
				this.showThinkingSelector();
				return;
			case "branch":
				void this.handleDiffCommand("git");
				return;
			case "todo":
				this.handleTodoCommand();
				return;
			case "jobs":
				this.handleJobsCommand("");
				return;
			case "usage":
			case "tests":
				this.openUsageScreen("");
				return;
			case "context":
				showContextMenu(this.ui, {
					title: "Context",
					items: [
						{ id: "compact", label: "Compact now", key: "c" },
						{ id: "usage", label: "Tokens and cost", key: "u" },
					],
					x: event.screenX,
					y: event.screenY,
					onPick: (item) => {
						if (item.id === "compact") void this.handleCompactCommand();
						else this.openUsageScreen("");
					},
				});
				return;
			case "permissions": {
				const gate = this.session.permissions;
				const autoAvailable = gate.isAutoAvailable();
				showContextMenu(this.ui, {
					title: "Permissions (this session)",
					items: PERMISSION_MODES.filter((info) => info.id !== "auto" || autoAvailable).map((info, index) => ({
						id: info.id,
						label: info.id === gate.mode ? `${info.label} (now)` : info.label,
						key: String(index + 1),
						...(info.id === "allow-all" ? { danger: true } : {}),
					})),
					x: event.screenX,
					y: event.screenY,
					onPick: (item) => void this.pickPermissionMode(item.id as PermissionMode),
				});
				return;
			}
		}
	}

	/** /settings rows for the mouse and clicks. */
	private applyClickSetting(id: string, value: string): void {
		switch (id) {
			case "mouse":
				if (value === "on" || value === "wheel" || value === "off") this.settingsManager.setMouseMode(value);
				this.showStatus("Mouse setting saved; it applies the next time RunKiln starts.");
				return;
			case "mouse-right-click":
				if (value === "auto" || value === "menu" || value === "paste")
					this.settingsManager.setMouseRightClick(value);
				return;
			case "card-actions":
				this.settingsManager.setCardActions(isOn(value));
				return;
			case "editor-open":
				this.settingsManager.setEditorOpen(value);
				return;
			case "pointer-shape":
				if (value === "auto" || value === "on" || value === "off")
					this.settingsManager.setPointerShapeSetting(value);
				this.showStatus("Pointer shape saved; it applies the next time RunKiln starts.");
				return;
			case "full-repaint":
				this.settingsManager.setFullRepaint(isOn(value));
				if (this.renderer instanceof TuiAltScreen)
					this.renderer.setFullRepaint(this.settingsManager.getFullRepaint());
				return;
		}
	}

	/** Set the session's permission mode from the footer menu; allow-all asks first. */
	private async pickPermissionMode(mode: PermissionMode): Promise<void> {
		if (mode === this.session.permissions.mode) return;
		if (mode === "allow-all") {
			const yes = "Allow all for this session";
			const choice = await this.showExtensionSelector(
				"Nothing will ask before running. Allow all for this session?",
				[yes, "Cancel"],
			);
			if (choice !== yes) return;
		}
		const error = this.session.setPermissionMode(mode);
		if (error) this.showWarning(error);
		else this.announcePermissionMode(mode, " This session only.");
	}

	private announcePermissionMode(mode: PermissionMode, suffix = ""): void {
		const info = permissionModeInfo(mode);
		this.footer.invalidate();
		this.showStatus(`Permissions: ${info.label}. ${info.description}${suffix}`);
	}

	private cyclePermissionMode(): void {
		const gate = this.session.permissions;
		const next = nextPermissionMode(gate.mode, {
			autoAvailable: gate.isAutoAvailable(),
			includeAllowAll: gate.allowAllInCycle,
		});
		const error = this.session.setPermissionMode(next);
		if (error) {
			this.showWarning(error);
			return;
		}
		this.announcePermissionMode(next);
	}

	private handlePermissionsCommand(arg: string): void {
		if (arg === "") {
			this.showPermissionsSelector();
			return;
		}
		if (arg === "rules") {
			this.showPermissionRulesView();
			return;
		}
		const ruleCommand = /^(allow|ask|deny)\s+(.+)$/i.exec(arg);
		if (ruleCommand) {
			const action = ruleCommand[1].toLowerCase() as RuleAction;
			let text = ruleCommand[2].trim();
			const project = /(^|\s)--project$/.test(text);
			if (project) text = text.replace(/(^|\s)--project$/, "").trim();
			const scope = project ? "project" : "global";
			const error = this.session.addSavedPermissionRules(scope, action, [text]);
			if (error) {
				this.showWarning(`${error} Examples: Bash(npm test:*), Edit(src/**), Read(.env), mcp__github__*.`);
				return;
			}
			this.showStatus(
				`Saved ${action} rule ${text} (${project ? "this project" : "global"}): ${describeSavedRule(text)}. /permissions rules lists and removes rules.`,
			);
			return;
		}
		if (arg === "clear") {
			const count = this.session.permissions.clearRules();
			this.showStatus(
				count === 0
					? "No session rules to clear."
					: `Cleared ${count} “always allow” rule${count === 1 ? "" : "s"}.`,
			);
			return;
		}
		const mode = parsePermissionMode(arg);
		if (!mode) {
			this.showWarning(
				`Unknown permission mode "${arg}". Use ask, read-write, plan, auto or allow-all, rules, or allow|ask|deny <rule> (or /permissions to pick).`,
			);
			return;
		}
		const error = this.session.setPermissionMode(mode, { persist: true });
		if (error) {
			this.showWarning(error);
			return;
		}
		this.announcePermissionMode(mode, mode === "plan" ? " This session only." : " Saved as the default.");
	}

	/** `/permissions rules`: session, project, global and project-file rules, with removal. */
	private showPermissionRulesView(): void {
		const gate = this.session.permissions;
		const cwd = this.sessionManager.getCwd();
		const saved = this.session.getSavedPermissionRules();
		const entries: RuleViewEntry[] = [
			...gate.rules.map((rule, index) => ({
				scope: "session" as const,
				action: "allow" as const,
				text: describeRule(rule, cwd),
				removable: true,
				sessionIndex: index,
			})),
			...saved.rules.map((rule) => ({
				scope: rule.scope,
				action: rule.action,
				text: rule.text,
				description: describeSavedRule(rule.text),
				removable: rule.scope !== "project-file",
			})),
			...saved.ignored.map((rule) => ({
				scope: rule.scope,
				action: rule.action,
				text: rule.text,
				ignored: rule.reason,
				removable: rule.scope !== "project-file",
			})),
		];
		this.showSelector((done) => {
			const view = new PermissionRulesViewComponent({
				entries,
				onRemove: (entry) => {
					if (entry.scope === "session")
						return entry.sessionIndex !== undefined && gate.removeRule(entry.sessionIndex);
					if (entry.scope === "project-file") return false;
					return this.session.removeSavedPermissionRule(entry.scope, entry.action, entry.text);
				},
				onClose: () => {
					done();
					this.ui.requestRender();
				},
			});
			return { component: view, focus: view };
		});
	}

	private planApprovalOpen = false;

	/**
	 * After a run in plan mode settles with a plan in its last message, ask what to do with it (plan-approval.ts).
	 * A run that ends with a question (no `## Plan` heading) just returns to the editor.
	 */
	/** The body of the turn-end notification: the start of the last reply. */
	private turnEndNotice(): string {
		const text = lastAssistantText(this.session.messages as never)?.trim();
		const first = text
			?.split("\n")
			.find((line) => line.trim())
			?.replace(/^[#>*\-\s]+/, "");
		return first || "Turn finished.";
	}

	private maybeShowPlanApproval(): void {
		if (!this.session.isPlanMode || this.planApprovalOpen || this.session.isStreaming) return;
		if (this.session.pendingMessageCount > 0) return;
		const text = lastAssistantText(this.session.messages as never);
		const plan = text ? extractPlan(text) : undefined;
		if (!plan) return;
		this.planApprovalOpen = true;
		this.notifier.waiting("plan", "A plan is waiting for your approval.");
		const returnMode = this.session.permissions.modeBeforePlan;
		const restoreEditor = () => {
			this.planApprovalOpen = false;
			this.editorContainer.clear();
			this.editorContainer.addChild(this.editor);
			this.programStatus.setBlocked("extension-dialog", undefined);
			this.ui.setFocus(this.editor);
			this.ui.requestRender();
		};
		const component = new PlanApprovalComponent({
			plan,
			returnMode,
			tui: this.ui,
			onEditPlan: (current) => this.editPlanInExternalEditor(current),
			onAnswer: (answer) => {
				restoreEditor();
				if (!answer) {
					this.showStatus("Plan mode stays on. Type what to change, or press the permission key to leave.");
					return;
				}
				if (answer.choice === "approve") {
					void this.session.approvePlan(answer.plan).then(
						(result) => {
							if ("error" in result) this.showWarning(result.error);
							this.footer.invalidate();
						},
						(error: unknown) => this.showError(error instanceof Error ? error.message : String(error)),
					);
					this.footer.invalidate();
					this.showStatus(
						`Plan approved${answer.plan ? " (your edited version)" : ""}. Permissions: ${permissionModeInfo(this.session.permissionMode).label}.`,
					);
					return;
				}
				if (answer.choice === "discard") {
					const mode = this.session.discardPlan();
					this.footer.invalidate();
					this.showStatus(`Plan discarded. Permissions: ${permissionModeInfo(mode).label}. Nothing ran.`);
					return;
				}
				const feedback = answer.plan ? planEditedFeedback(answer.plan, answer.feedback) : answer.feedback?.trim();
				if (feedback) {
					void this.session.prompt(feedback).catch((error: unknown) => {
						this.showError(error instanceof Error ? error.message : String(error));
					});
				} else {
					this.showStatus("Plan mode stays on. Type what to change in the plan.");
				}
			},
		});
		this.disposeActiveSelector();
		this.editorContainer.clear();
		this.editorContainer.addChild(component);
		this.ui.setFocus(component);
		this.programStatus.setBlocked("extension-dialog", { kind: "permission", message: "Ready to run this plan?" });
		this.ui.requestRender();
	}

	private showPermissionsSelector(): void {
		const gate = this.session.permissions;
		const cwd = this.sessionManager.getCwd();
		const autoAvailable = gate.isAutoAvailable();
		this.showSelector((done) => {
			const selector = new PermissionsSelectorComponent({
				current: gate.mode,
				saved: parsePermissionMode(this.settingsManager.getPermissionMode()),
				autoAvailable,
				autoHint: "Needs a Jev or OpenRouter key: add one in /setup keys.",
				autoBackend: autoAvailable ? this.permissionAutoBackend() : undefined,
				rules: gate.rules.map((rule) => describeRule(rule, cwd)),
				onSelect: (mode) => {
					done();
					const error = this.session.setPermissionMode(mode, { persist: true });
					if (error) this.showWarning(error);
					else
						this.announcePermissionMode(mode, mode === "plan" ? " This session only." : " Saved as the default.");
				},
				onClearRules: () => {
					gate.clearRules();
				},
				onOpenRules: () => {
					done();
					this.showPermissionRulesView();
				},
				onCancel: () => {
					done();
					this.ui.requestRender();
				},
			});
			return { component: selector, focus: selector };
		});
	}

	private showMarkdownPanel(title: string, markdown: string): void {
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new DynamicBorder((text) => theme.fg("borderAccent", text)));
		this.chatContainer.addChild(new ThemedText(() => theme.bold(theme.fg("accent", title)), 1, 0));
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Markdown(markdown.trim(), 1, 1, this.getMarkdownThemeWithSettings()));
		this.chatContainer.addChild(new DynamicBorder((text) => theme.fg("borderAccent", text)));
		this.ui.requestRender();
	}

	private handleHelpCommand(): void {
		const builtin = new Set(BUILTIN_SLASH_COMMANDS.map((command) => command.name));
		const extra = [
			...this.session.promptTemplates.map((cmd) => ({
				name: cmd.name,
				description: cmd.description,
				argumentHint: cmd.argumentHint,
			})),
			...this.session.extensionRunner
				.getRegisteredCommands()
				.filter((cmd) => !builtin.has(cmd.name))
				.map((cmd) => ({ name: cmd.invocationName, description: cmd.description })),
			...[...this.skillCommands.keys()].map((name) => ({ name, description: "Run this skill" })),
		];
		this.showMarkdownPanel(
			"Help",
			buildHelpMarkdown({
				extra,
				keys: {
					permissions: this.getAppKeyDisplay("app.permissions.cycle"),
					thinking: this.getAppKeyDisplay("app.thinking.cycle"),
					model: this.getAppKeyDisplay("app.model.cycleForward"),
					routerMode: this.getAppKeyDisplay("app.router.cycleMode"),
					hotkeysHint: `**Keyboard shortcuts**\n${this.hotkeysMarkdown()}`,
				},
			}),
		);
	}

	private handleStatusCommand(): void {
		const stats = this.session.getSessionStats();
		const state = this.session.state;
		const context = this.session.getContextUsage();
		const cwd = this.sessionManager.getCwd();
		const router = this.session.getRouterStatus();
		this.showMarkdownPanel(
			"Status",
			buildStatusMarkdown({
				version: this.version,
				cwd,
				gitBranch: this.footerDataProvider.getGitBranch(),
				sessionFile: stats.sessionFile,
				sessionId: stats.sessionId,
				sessionName: this.sessionManager.getSessionName(),
				model: state.model ? `${state.model.provider}/${state.model.id}` : "none",
				routing: this.session.isAutoRouting
					? `auto:${this.session.routerMode}${router.backend ? ` - classifier ${router.backend}${router.classifierModel ? ` ${router.classifierModel}` : ""}` : ` - no classifier (${router.problem ?? "not configured"})`}`
					: "manual",
				thinking: this.session.isThinkingAuto ? "auto" : (state.thinkingLevel ?? "off"),
				permissionMode: this.session.permissionMode,
				sessionRules: this.session.permissions.rules.map((rule) => describeRule(rule, cwd)),
				autoBackend: this.permissionAutoBackend(),
				runInfraKey: this.session.modelRuntime.hasConfiguredAuth("runinfra"),
				catalog: router.catalogInfo,
				unbenched: router.derivedModels,
				contextPercent: context?.percent,
				contextWindow: context?.contextWindow ?? state.model?.contextWindow,
				messages: stats.totalMessages,
				cost: stats.cost,
				...this.verifyStatusRows(),
			}),
		);
	}

	/**
	 * `/usage [tab|range]` (also `/cost`, `/stats`): the usage overlay. An argument picks the tab (overview, models,
	 * turns, context, history) or a History range (today, week, month, all). Without a TTY it prints the plain report.
	 */
	private openUsageScreen(arg: string): void {
		const { tab, range } = parseUsageArgument(arg);
		if (!process.stdout.isTTY) {
			this.showMarkdownPanel("Usage", `\`\`\`\n${this.usageText(range)}\`\`\``);
			return;
		}
		const session = this.session;
		const ledgerPath = session.usageLedgerPath;
		void this.showExtensionCustom<void>(
			(tui, _theme, _keybindings, done) =>
				new UsageScreen({
					data: {
						report: () => session.getUsageReport(),
						context: () => session.getContextBreakdown(),
						history: (selected) =>
							ledgerPath ? summarizeLedger(readLedger(ledgerPath), { since: rangeStart(selected) }) : undefined,
						budgets: () => session.getBudgetStatuses(),
						...(ledgerPath ? { ledgerPath } : {}),
						title: this.sessionManager.getSessionName() ?? this.sessionManager.getSessionId().slice(0, 8),
					},
					...(tab ? { initialTab: tab } : {}),
					...(range ? { initialRange: range } : {}),
					height: () => tui.terminal.rows,
					requestRender: () => tui.requestRender(),
					onClose: () => done(undefined),
				}),
			{
				overlay: true,
				overlayOptions: () => ({ width: "100%", maxHeight: "100%", anchor: "top-left", margin: 0 }),
			},
		);
	}

	/** /commit [turn|session|all]: draft a message on the chore model, let the user edit or confirm it, commit. */
	private async handleCommitCommand(arg: string): Promise<void> {
		if (this.session.isStreaming) {
			this.showError("Wait for the current response to finish, then /commit.");
			return;
		}
		const scope = arg ? COMMIT_SCOPES.find((value) => value === arg) : undefined;
		if (arg && !scope) {
			this.showError("Usage: /commit [turn|session|all] (default: the session's changes)");
			return;
		}
		this.showStatus("Writing a commit message…");
		const draft = await this.session.draftCommit(scope);
		if ("error" in draft) {
			this.showError(draft.error);
			return;
		}
		const message = await this.showExtensionEditor(commitPromptTitle(draft), draft.message, {
			description: commitPromptDescription(draft),
		});
		if (message === undefined) {
			this.showStatus("Commit cancelled. Nothing was staged or committed.");
			return;
		}
		const result = this.session.commitFiles(draft, message);
		if ("error" in result) this.showError(result.error);
		else
			this.showStatus(
				`Committed ${result.sha} ${result.subject} (${draft.paths.length} file${draft.paths.length === 1 ? "" : "s"})`,
			);
	}

	private async handleReviewCommand(arg: string): Promise<void> {
		if (this.session.isStreaming) {
			this.showError("Wait for the current response to finish, then /review.");
			return;
		}
		this.flushPendingBashComponents();
		try {
			const result = await this.session.review(arg || undefined);
			if (result.error) this.showError(result.error);
		} catch (error) {
			this.showError(error instanceof Error ? error.message : String(error));
		}
	}

	private handleTodoCommand(): void {
		const items = this.session.todoItems;
		this.todoPanel.setItems(items);
		if (items.length === 0) {
			this.showStatus("No todo list in this session yet. The agent starts one for multi-step work.");
			return;
		}
		if (!this.todoPanel.visible) {
			this.showMarkdownPanel(
				`Todo (all ${items.length} done)`,
				items.map((item) => `- [x] ${item.text.replace(/[\\`*_[\]]/g, "\\$&")}`).join("\n"),
			);
			return;
		}
		this.todoPanel.setExpanded(!this.todoPanel.isExpanded);
		this.renderWidgets();
	}

	private handleHooksCommand(arg: string): void {
		const hooks = this.session.hooks;
		if (arg === "trust") {
			if (hooks.projectHooksTrusted) this.showStatus("No project hooks are waiting for approval.");
			else {
				hooks.trustProjectHooks(true);
				this.showStatus("Project hooks approved; they run from now on (a changed command asks again).");
			}
		} else if (arg === "untrust") {
			hooks.reload();
			this.session.revokeProjectHooks();
			this.showStatus("Project hooks are no longer approved.");
		} else if (arg === "reload") {
			hooks.reload();
			this.showStatus("Hooks re-read. Hooks added to a file with none before need /reload to be bridged.");
		} else if (arg) {
			this.showError("Usage: /hooks [trust|untrust|reload]");
			return;
		}
		this.showMarkdownPanel("Hooks", buildHooksMarkdown(hooks));
	}

	private async handleMcpCommand(arg: string): Promise<void> {
		const mcp = this.session.mcp;
		const [action, name] = arg.split(/\s+/, 2);
		if (action === "trust") {
			const pending = mcp.untrustedServers().map((state) => state.config.name);
			if (pending.length === 0) this.showStatus("No project MCP servers are waiting for approval.");
			else {
				mcp.trustServers(pending, true);
				this.showStatus(`Approved ${pending.join(", ")}; starting.`);
				await mcp.start();
			}
		} else if (action === "reconnect") {
			const names = !name || name === "all" ? mcp.servers().map((s) => s.config.name) : [name];
			if (name && name !== "all" && !mcp.server(name)) {
				this.showError(`No MCP server named ${name}.`);
				return;
			}
			this.showStatus(`Reconnecting ${names.join(", ")}…`);
			await Promise.all(names.map((n) => mcp.reconnect(n)));
		} else if (action && action !== "tools") {
			this.showError("Usage: /mcp [reconnect <server|all>|tools <server>|trust]");
			return;
		}
		this.showMarkdownPanel("MCP servers", buildMcpMarkdown(mcp, action === "tools" && name ? { toolsOf: name } : {}));
	}

	private handleJobsCommand(arg: string): void {
		const jobs = this.session.jobs;
		const [action, id] = arg.split(/\s+/, 2);
		if (action === "kill") {
			if (!id) {
				this.showError("Usage: /jobs kill <id|all>");
				return;
			}
			if (id === "all") this.showStatus(`Killed ${jobs.killAll()} job(s).`);
			else if (jobs.kill(id)) this.showStatus(`Killed ${jobs.resolveId(id)}.`);
			else {
				this.showError(`No job ${id}.`);
				return;
			}
		} else if (action) {
			const job = jobs.get(action);
			if (!job) {
				this.showError(`No job ${action}. Usage: /jobs [<id>|kill <id|all>]`);
				return;
			}
			this.showMarkdownPanel(
				`Job ${job.id}`,
				["```", job.lastLine ? jobs.tail(job.id) : "(no output yet)", "```"].join("\n"),
			);
			return;
		}
		this.showMarkdownPanel("Background jobs", buildJobsMarkdown(jobs));
	}

	private async handleMapCommand(arg: string): Promise<void> {
		const cwd = this.sessionManager.getCwd();
		const request = parseMapArgs(arg, (target) => fs.existsSync(path.resolve(cwd, target)));
		request.tokens ??= this.settingsManager.getRepoMapSettings().tokens;
		request.conversation = conversationText(this.sessionManager.getBranch() as never);
		const map = getRepoMap(cwd, repoMapCacheDir());
		try {
			const result = await map.render(request);
			const tokens = Math.max(64, Math.min(8192, request.tokens));
			this.chatContainer.addChild(
				buildRepoMapPanel(
					result,
					() => renderRepoMap(map.rank(request).ranked, tokens, themedRepoMapStyle()).styled,
				),
			);
		} catch (error) {
			this.showError(`Repo map failed: ${error instanceof Error ? error.message : String(error)}`);
		}
		this.ui.requestRender();
	}

	/** Budgets already announced (80%, 100%) or approved past 100%, per budget, so each is said once. */
	private readonly budgetSeen = new Map<BudgetStatus["kind"], BudgetLevel>();
	private readonly budgetApproved = new Set<string>();

	/** After a run: a warning when a budget crossed 80% or 100%. */
	private announceBudget(): void {
		try {
			const crossed = newlyCrossed(this.session.getBudgetStatuses(), this.budgetSeen);
			if (!crossed) return;
			const text = describeBudget(crossed, usd, usdLimit);
			this.showWarning(
				crossed.level === "over"
					? `Budget reached: ${text}. The next prompt asks first (/usage for the breakdown).`
					: `Budget at ${Math.round(crossed.fraction * 100)}%: ${text}.`,
			);
		} catch {
			// Budgets are advisory.
		}
	}

	/** True to send the prompt. A budget at 100% asks once (per budget and limit; the daily one again each day). */
	private async confirmBudget(): Promise<boolean> {
		let statuses: BudgetStatus[];
		try {
			statuses = this.session.getBudgetStatuses().filter((status) => status.level === "over");
		} catch {
			return true;
		}
		const today = new Date().toDateString();
		const pending = statuses.filter(
			(status) => !this.budgetApproved.has(`${status.kind}:${status.limit}:${status.kind === "daily" ? today : ""}`),
		);
		const status = tightestBudget(pending);
		if (!status) return true;
		const title = `Budget reached: ${describeBudget(status, usd, usdLimit)}`;
		const choice = await this.showExtensionSelector(
			`${title}\nSend this prompt anyway? Raise or remove budget.${status.kind} in settings to stop asking.`,
			["Send anyway", "Not now"],
			undefined,
			{ kind: "question", message: title },
		);
		if (choice !== "Send anyway") {
			this.showStatus("Not sent. /usage shows where the money went.");
			return false;
		}
		for (const over of pending)
			this.budgetApproved.add(`${over.kind}:${over.limit}:${over.kind === "daily" ? today : ""}`);
		this.budgetSeen.set(status.kind, "over");
		return true;
	}

	/** The plain-text report (no TTY): every tab, history for `range` (default: today). */
	private usageText(range: UsageRange | undefined): string {
		const ledgerPath = this.session.usageLedgerPath;
		const selected = range ?? "today";
		return usageText({
			report: this.session.getUsageReport(),
			context: this.session.getContextBreakdown(),
			budgets: this.session.getBudgetStatuses(),
			...(ledgerPath
				? {
						history: {
							range: selected,
							summary: summarizeLedger(readLedger(ledgerPath), { since: rangeStart(selected) }),
							ledgerPath,
						},
					}
				: {}),
		});
	}

	/** /status rows for the post-edit checks, the verify loop and edit misses. */
	private verifyStatusRows(): { checks: string; verify: string; editMisses?: string } {
		const checks = this.settingsManager.getChecksSettings();
		const slow = this.session.postEditSkipped;
		const verify = this.settingsManager.getVerifySettings();
		const project = this.settingsManager.getVerifyProject(this.sessionManager.getCwd());
		const marker = this.session.verify.marker;
		const command = verify.command ?? project?.command;
		return {
			checks: checks.enabled
				? `on${checks.autoDetect ? " (auto-detect)" : ""}${checks.commands ? ` - ${Object.keys(checks.commands).join(", ")}` : ""}${slow.length > 0 ? ` - skipped as slow: ${slow.join(", ")}` : ""}`
				: "off",
			verify: `${verify.mode}${command ? ` - ${command}` : ""}${project?.decision === "never" ? " - never in this project" : ""}${marker ? ` - last: ${marker}` : ""}`,
			editMisses: formatEditMisses(getEditStats()),
		};
	}

	/** /test: run the project's tests now; `/test off|ask|auto` sets verify.mode; `/test <command>` saves a command. */
	private async handleTestCommand(arg: string): Promise<void> {
		const verify = this.session.verify;
		if (arg === "off" || arg === "ask" || arg === "auto") {
			this.settingsManager.setVerifyMode(arg);
			const what =
				arg === "off"
					? "Tests no longer run after file-changing turns (/test still runs them)."
					: arg === "ask"
						? "RunKiln offers to run the tests after the first file-changing turn."
						: "Tests run after every turn that changes files.";
			this.showStatus(`verify.mode: ${arg}. ${what}`);
			return;
		}
		if (!this.session.isIdle) {
			this.showStatus("The agent is working; run /test when the turn ends.");
			return;
		}
		if (arg)
			this.settingsManager.setVerifyProject(this.sessionManager.getCwd(), { command: arg, decision: "always" });
		const command = arg || (await verify.resolveCommand(true));
		if (!command) {
			this.showStatus("No test command. Set one with /test <command> (saved for this project) or verify.command.");
			return;
		}
		this.showStatus(`Running ${command}…`);
		const result = await verify.run(command);
		this.showMarkdownPanel("Tests", buildTestMarkdown(command, result));
	}

	/** The review view key and the keys it can move to: the default, free alt and ctrl+alt keys, or none. */
	private reviewKeyChoices(): { current: string; choices: string[] } {
		const current = this.keybindings.getKeys("app.changes.review")[0] ?? "none";
		const free = REVIEW_KEY_CANDIDATES.filter(
			(key) => key === current || this.keybindings.actionsUsingKey(key, "app.changes.review").length === 0,
		);
		return { current, choices: [...new Set([...free, current, "none"])] };
	}

	/**
	 * `/diff`: what `display.diffOpens` says, the review view of this session's changes by default (the git panel when
	 * there are none). `/diff git` and `/diff review` pick one.
	 */
	private async handleDiffCommand(arg = ""): Promise<void> {
		const target = resolveDiffTarget(arg, this.settingsManager.getDisplaySettings().diffOpens);
		if (target === "review") {
			const changes = await this.session.getSessionChanges().catch(() => undefined);
			if (changes && changes.files.length > 0) {
				await this.openChangesReview();
				return;
			}
		}
		this.showMarkdownPanel("Uncommitted changes", buildDiffMarkdown(this.sessionManager.getCwd()));
	}

	/** Read this session's changes into the tray (hidden when none, or when display.changesTray is off). */
	private async refreshChangesTray(): Promise<void> {
		const enabled = this.settingsManager.getDisplaySettings().changesTray;
		this.changesTray.setEnabled(enabled);
		const changes = enabled ? await this.session.getSessionChanges().catch(() => undefined) : undefined;
		this.changesTray.setChanges(changes);
		this.renderWidgets();
	}

	/** The review view: per-file diffs of this session's changes, with keep and revert per hunk or file. */
	private async openChangesReview(path?: string): Promise<void> {
		if (!this.session.checkpoints) {
			this.showStatus("Checkpoints are off for this session (in-memory session or RUNKILN_CHECKPOINTS=0)");
			return;
		}
		const session = this.session;
		const source: ChangesReviewSource = {
			list: () => session.getSessionChanges(),
			versions: (file) => session.getSessionFileVersions(file),
			keep: (file, content) => session.keepSessionChange(file, content),
			revert: (file, content) => session.revertSessionChange(file, content),
		};
		const files = await loadReviewFiles(source);
		if (files.length === 0) {
			this.showStatus("No changes from this session to review");
			void this.refreshChangesTray();
			return;
		}
		await this.showExtensionCustom<void>(
			(tui, _theme, _keybindings, done) =>
				new ChangesReviewScreen({
					source,
					files,
					...(path ? { initialPath: path } : {}),
					height: () => tui.terminal.rows,
					requestRender: () => tui.requestRender(),
					onChanged: () => void this.refreshChangesTray(),
					onClose: () => done(undefined),
				}),
			{
				overlay: true,
				overlayOptions: () => ({ width: "100%", maxHeight: "100%", anchor: "top-left", margin: 0 }),
			},
		);
		void this.refreshChangesTray();
	}

	private handleDoctorCommand(): void {
		const agentDir = getAgentDir();
		const settingsErrors = this.settingsManager
			.getLoadErrors()
			.map((entry) => `${entry.scope} settings: ${entry.message}`);
		this.showMarkdownPanel(
			"Doctor",
			formatDoctorMarkdown(
				runDoctorChecks({
					cwd: this.sessionManager.getCwd(),
					agentDir,
					nodeVersion: process.version,
					runInfraKey: this.session.modelRuntime.hasConfiguredAuth("runinfra"),
					autoBackend: this.permissionAutoBackend(),
					permissionMode: this.session.permissionMode,
					settingsErrors,
					env: process.env,
				}),
			),
		);
	}

	private handleInitCommand(): void {
		const prompt = buildInitPrompt(this.sessionManager.getCwd());
		this.editor.addToHistory?.("/init");
		if (this.session.isStreaming) {
			void this.session.prompt(prompt, { streamingBehavior: "followUp" });
			this.showStatus("Queued /init: the agent writes AGENTS.md after the current turn.");
			return;
		}
		this.flushPendingBashComponents();
		if (this.onInputCallback) this.onInputCallback(prompt);
		else this.pendingUserInputs.push(prompt);
	}

	private cycleThinkingLevel(): void {
		const newLevel = this.session.cycleThinkingLevel();
		if (newLevel === undefined) {
			this.showStatus("Current model does not support thinking");
		} else {
			this.footer.invalidate();
			this.updateEditorBorderColor();
			this.showStatus(
				newLevel === "auto"
					? "Thinking level: auto (router picks per turn)"
					: `Thinking level: ${newLevel}${this.session.isAutoRouting ? " (pinned)" : ""}`,
			);
		}
	}

	/** app.router.cycleMode: auto:low → auto:medium → auto:high (turns auto routing on from a manual model). */
	private cycleRouterMode(): void {
		try {
			const wasAuto = this.session.isAutoRouting;
			const mode = this.session.cycleRouterMode();
			this.footer.invalidate();
			this.updateEditorBorderColor();
			const description = this.session.getRouterStatus().modeDescription;
			this.showStatus(
				`${wasAuto ? "Routing mode" : "Auto routing on"}: auto:${mode}${description ? ` (${description})` : ""}`,
			);
		} catch (error) {
			this.showError(error instanceof Error ? error.message : String(error));
		}
	}

	private async cycleModel(direction: "forward" | "backward"): Promise<void> {
		try {
			const result = await this.session.cycleModel(direction);
			if (result === undefined) {
				const msg = this.session.scopedModels.length > 0 ? "Only one model in scope" : "Only one model available";
				this.showStatus(msg);
			} else {
				this.footer.invalidate();
				this.updateEditorBorderColor();
				const thinkingStr =
					result.model.reasoning && result.thinkingLevel !== "off" ? ` (thinking: ${result.thinkingLevel})` : "";
				this.showStatus(
					this.session.isAutoRouting
						? `Switched to auto:${this.session.routerMode}: the router picks model and thinking per turn${this.describeRouterReadiness()}`
						: `Switched to ${result.model.name || result.model.id}${thinkingStr}`,
				);
				void this.maybeWarnAboutAnthropicSubscriptionAuth(result.model);
			}
		} catch (error) {
			this.showError(error instanceof Error ? error.message : String(error));
		}
	}

	private toggleToolSelectMode(): void {
		if (this.toolCardSelection) {
			this.exitToolSelectMode();
			return;
		}
		const cards = this.chatContainer.children.filter(
			(child): child is ToolExecutionComponent | ToolGroupComponent =>
				child instanceof ToolExecutionComponent || child instanceof ToolGroupComponent,
		);
		if (cards.length === 0) {
			this.showStatus("No tool cards to select");
			return;
		}
		const marker = `${theme.fg("accent", "▸")} ${theme.fg("dim", "↑↓ move - enter open/close - esc done")}`;
		const selection = new CardSelection<SelectableCard>(cards, marker);
		const unsubscribe = this.ui.addInputListener((data) => {
			const key = classifyCardSelectKey(data);
			if (key === "other") {
				this.exitToolSelectMode();
				return undefined;
			}
			if (key === "up") selection.move(-1);
			else if (key === "down") selection.move(1);
			else if (key === "toggle") selection.toggle();
			else this.exitToolSelectMode();
			if (this.toolCardSelection) this.revealTranscriptComponent(selection.selected);
			this.ui.requestRender();
			return { consume: true };
		});
		this.toolCardSelection = { selection, unsubscribe };
		this.revealTranscriptComponent(selection.selected);
		this.ui.requestRender();
	}

	private exitToolSelectMode(): void {
		const current = this.toolCardSelection;
		if (!current) return;
		this.toolCardSelection = undefined;
		current.unsubscribe();
		current.selection.dispose();
		this.ui.requestRender();
	}

	/** Fullscreen: scroll the transcript so a chat component's first rows are visible. */
	private revealTranscriptComponent(component: unknown): void {
		const scrollView = this.transcriptScrollView;
		if (!scrollView || !(this.renderer instanceof TuiAltScreen) || !component) return;
		const width = scrollView.getContentWidth(this.ui.terminal.columns);
		let offset = 0;
		for (const child of this.documentContainer.children) {
			if (child === this.chatContainer) break;
			offset += child.render(width).length;
		}
		for (const child of this.chatContainer.children) {
			if (child === component) break;
			offset += child.render(width).length;
		}
		const viewport = scrollView.viewportHeight;
		if (viewport <= 0) return;
		const top = scrollView.scrollTop;
		if (offset < top || offset + 2 > top + viewport) {
			scrollView.scrollTo(Math.max(0, offset - 1), { disableFollow: true });
		}
	}

	private toggleToolOutputExpansion(): void {
		this.setToolsExpanded(!this.toolOutputExpanded);
	}

	private setToolsExpanded(expanded: boolean): void {
		if (expanded === this.toolOutputExpanded) return;

		this.toolOutputExpanded = expanded;
		this.todoPanel.setExpanded(expanded);
		if (this.todoPanel.visible) this.renderWidgets();
		const activeHeader = this.customHeader ?? this.builtInHeader;
		if (isExpandable(activeHeader)) {
			activeHeader.setExpanded(expanded);
		}
		for (const container of [this.loadedResourcesContainer, this.chatContainer]) {
			for (const child of container.children) {
				if (isExpandable(child)) {
					child.setExpanded(expanded);
				}
			}
		}
		this.showStatus(`Tool output: ${expanded ? "expanded" : "collapsed"}`);
	}

	/** Update rendered assistant messages without rebuilding live tool components. */
	private updateThinkingBlockVisibility(): void {
		for (const child of this.chatContainer.children) {
			if (child instanceof AssistantMessageComponent) {
				child.setHideThinkingBlock(this.hideThinkingBlock);
			}
		}
		this.ui.requestRender();
	}

	private toggleThinkingBlockVisibility(): void {
		this.hideThinkingBlock = !this.hideThinkingBlock;
		this.settingsManager.setHideThinkingBlock(this.hideThinkingBlock);
		this.updateThinkingBlockVisibility();
		this.showStatus(`Thinking blocks: ${this.hideThinkingBlock ? "hidden" : "visible"}`);
	}

	/** Open a plan in the external editor (plan approval's edit key); undefined when the editor failed. */
	private async editPlanInExternalEditor(plan: string): Promise<string | undefined> {
		this.ui.stop();
		try {
			const result = await editInExternalEditor({
				command: this.settingsManager.getExternalEditorCommand(),
				content: plan,
			});
			return result.status === "complete" ? result.content : undefined;
		} finally {
			this.ui.start();
			this.ui.requestRender(true);
		}
	}

	private async handleOpenExternalEditor(): Promise<void> {
		const editorCmd = this.settingsManager.getExternalEditorCommand();
		const content = this.editor.getExpandedText?.() ?? this.editor.getText();
		this.ui.stop();
		try {
			const result = await editInExternalEditor({
				command: editorCmd,
				content,
			});
			if (result.status === "complete") {
				this.editor.setText(result.content);
			}
		} finally {
			this.ui.start();
			this.ui.requestRender(true);
		}
	}

	// =========================================================================
	// Prompt history, stash, chips, key hints and the shortcut sheet
	// =========================================================================

	/** Add a sent prompt to Up/Down and the persistent history, then bring back a stashed draft. */
	private rememberPrompt(text: string): void {
		this.editor.addToHistory?.(text);
		this.promptHistory.append(text, this.sessionManager.getCwd(), this.sessionManager.getSessionId());
		if (this.promptStash) {
			// After the send path has cleared the editor.
			setTimeout(() => {
				if (this.promptStash && this.editor === this.defaultEditor && this.defaultEditor.getText() === "") {
					this.restoreStash();
				}
			}, 0);
		}
	}

	/** Stash key: park the draft and clear the editor; again (or with an empty editor) brings it back. */
	private toggleStash(): void {
		if (this.editor !== this.defaultEditor) return;
		const editor = this.defaultEditor;
		const hasDraft = editor.getText().trim().length > 0;
		const key = keyText("app.editor.stash");
		if (!hasDraft) {
			if (this.promptStash) this.restoreStash();
			else this.showStatus(`Nothing to stash. Type a draft, then ${key} parks it until your next send.`);
			return;
		}
		const previous = this.promptStash;
		const draft = editor.getDraft();
		this.promptStash = { draft, images: this.imageAttachments.take(draft.imageChipIds) };
		editor.setText("");
		editor.clearImageMarkers();
		if (previous) {
			this.restoreStash(previous);
			this.showStatus(`Swapped drafts: the other one is stashed (${key} swaps back).`);
		} else {
			this.showStatus(`Draft stashed. It comes back after your next send, or press ${key}.`);
		}
		this.ui.requestRender();
	}

	private restoreStash(stash = this.promptStash): void {
		if (!stash) return;
		if (stash === this.promptStash) this.promptStash = undefined;
		// Image ids may have been reused since; give the images new ids and rewrite their chips.
		const ids = new Map<number, number>();
		for (const image of stash.images) {
			const { id: oldId, ...prepared } = image;
			ids.set(oldId, this.imageAttachments.add(prepared).id);
		}
		const text = stash.draft.text.replace(IMAGE_MARKER_REGEX, (marker, id: string) => {
			const next = ids.get(Number(id));
			return next === undefined ? marker : marker.replace(`[image ${id} `, `[image ${next} `);
		});
		this.defaultEditor.setDraft({ ...stash.draft, text, imageChipIds: [...ids.values()] });
		if (stash !== this.promptStash) this.showStatus("Stashed draft restored.");
		this.ui.requestRender();
	}

	/** $EDITOR for a paste chip: the externalEditor setting, VISUAL or EDITOR; none means expand inline. */
	private pasteChipEditorCommand(): string | undefined {
		const configured = this.settingsManager.getExternalEditorCommand();
		const explicit = process.env.VISUAL || process.env.EDITOR;
		const fromSettings = configured !== "nano" && configured !== "notepad" ? configured : undefined;
		return fromSettings ?? explicit ?? undefined;
	}

	/** Enter on a chip: a paste opens in $EDITOR (or expands inline), an image shows its details. */
	private openEditorChip(chip: EditorChip): boolean {
		if (chip.kind === "image") {
			const image = this.imageAttachments.get(chip.id);
			if (!image) return false;
			const note = image.note ? `, ${image.note}` : "";
			this.showStatus(
				`${chip.marker}: ${image.image.mimeType}, ${image.label} as sent${note}. Delete the chip to drop it; Enter after it sends.`,
			);
			return true;
		}
		const command = this.pasteChipEditorCommand();
		if (!command) return false;
		void (async () => {
			this.ui.stop();
			try {
				const result = await editInExternalEditor({ command, content: chip.content });
				if (result.status === "complete") this.defaultEditor.setPasteContent(chip.id, result.content);
			} finally {
				this.ui.start();
				this.ui.requestRender(true);
			}
		})();
		return true;
	}

	private openHistorySearch(): void {
		if (this.historySearchOverlay || this.editor !== this.defaultEditor) return;
		const cwd = this.sessionManager.getCwd();
		const sessionId = this.sessionManager.getSessionId();
		const close = () => {
			this.historySearchOverlay?.hide();
			this.historySearchOverlay = undefined;
			this.ui.setFocus(this.editor);
			this.ui.requestRender();
		};
		const rows = this.ui.terminal.rows;
		const component = new HistorySearch({
			scopes: [
				{ id: "session", label: "session" },
				{ id: "project", label: "project" },
				{ id: "all", label: "all" },
			],
			initialScope: "project",
			load: (scope) => {
				const now = Date.now();
				return this.promptHistory.query(scope as PromptHistoryScope, { cwd, sessionId }, 2000).map((entry) => ({
					text: entry.text,
					detail:
						scope === "all" && entry.cwd !== path.resolve(cwd)
							? `${formatAge(entry.ts, now).padStart(3)} ${path.basename(entry.cwd)}`
							: formatAge(entry.ts, now).padStart(3),
				}));
			},
			onAccept: (text, mode) => {
				close();
				if (mode === "replace") this.defaultEditor.setText(text);
				else this.defaultEditor.insertTextAtCursor(text);
			},
			onCancel: close,
			theme: {
				border: (text) => theme.fg("border", text),
				title: (text) => theme.bold(theme.fg("accent", text)),
				scopeActive: (text) => theme.bold(theme.fg("accent", text)),
				scopeInactive: (text) => theme.fg("dim", text),
				match: (text) => theme.bold(theme.fg("warning", text)),
				detail: (text) => theme.fg("dim", text),
				hint: (text) => theme.fg("dim", text),
				selectList: getSelectListTheme(),
			},
			maxVisible: Math.max(3, Math.min(10, rows - 12)),
		});
		this.historySearchOverlay = this.ui.showOverlay(component, {
			anchor: "bottom-center",
			width: "100%",
			margin: { left: 0, right: 0, bottom: 0, top: 1 },
		});
		this.ui.requestRender();
	}

	private openShortcutSheet(): void {
		if (this.shortcutSheetOverlay) return;
		const terminal = this.ui.terminal as Terminal & { modifyOtherKeysActive?: boolean };
		const close = () => {
			this.shortcutSheetOverlay?.hide();
			this.shortcutSheetOverlay = undefined;
			this.ui.setFocus(this.editor);
			this.ui.requestRender();
		};
		const component = new ShortcutSheet({
			rows: buildShortcutRows(),
			warning: optionAsMetaWarning({
				platform: process.platform,
				env: process.env,
				enhancedKeys: terminal.kittyProtocolActive || terminal.modifyOtherKeysActive === true,
			}),
			onClose: close,
			maxVisible: Math.max(3, terminal.rows - 10),
		});
		this.shortcutSheetOverlay = this.ui.showOverlay(component, {
			anchor: "center",
			width: Math.min(100, Math.max(40, terminal.columns - 4)),
			margin: 1,
		});
		this.ui.requestRender();
	}

	/** What the key-hint line shows now; undefined hides it (a selector owns the input area). */
	private keyHintState(): KeyHintState | undefined {
		if (this.shortcutSheetOverlay) return undefined;
		if (this.historySearchOverlay) return { mode: "history-search" };
		if (this.permissionPromptComponent) return { mode: "approval", approvalKind: "permission" };
		if (this.planApprovalOpen) return { mode: "approval", approvalKind: "plan" };
		if (this.editor !== this.defaultEditor || !this.editorContainer.children.includes(this.defaultEditor)) {
			return undefined;
		}
		const stashed = this.promptStash !== undefined;
		if (this.ui instanceof TuiAltScreen && this.ui.hasActiveSelection()) return { mode: "selection", stashed };
		const editor = this.defaultEditor;
		if (editor.isShowingAutocomplete()) return { mode: "autocomplete", stashed };
		const chip = editor.getSelectedChip();
		if (chip) {
			return {
				mode: "chip",
				chipKind: chip.kind,
				pasteOpensEditor: chip.kind === "paste" && this.pasteChipEditorCommand() !== undefined,
				stashed,
			};
		}
		if (this.session.isStreaming) {
			const queued = this.getAllQueuedMessages();
			return { mode: "streaming", queued: queued.steering.length + queued.followUp.length > 0, stashed };
		}
		const text = editor.getText();
		if (this.imageAttachments.size > 0 && /\[image \d+ - /.test(text)) return { mode: "image", stashed };
		if (text.trim()) return { mode: "draft", stashed };
		return { mode: "idle", stashed };
	}

	// =========================================================================
	// UI helpers
	// =========================================================================

	clearEditor(): void {
		this.editor.setText("");
		this.ui.requestRender();
	}

	showError(errorMessage: string): void {
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new ThemedText(() => theme.fg("error", `Error: ${errorMessage}`), this.outputPad, 0));
		this.ui.requestRender();
	}

	showWarning(warningMessage: string): void {
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new ThemedText(() => theme.fg("warning", `Warning: ${warningMessage}`), 1, 0));
		this.ui.requestRender();
	}

	/**
	 * Get all queued messages (read-only).
	 * Combines session queue and compaction queue.
	 */
	private getAllQueuedMessages(): { steering: string[]; followUp: string[] } {
		return {
			steering: [
				...this.session.getSteeringMessages(),
				...this.compactionQueuedMessages.filter((msg) => msg.mode === "steer").map((msg) => msg.text),
			],
			followUp: [
				...this.session.getFollowUpMessages(),
				...this.compactionQueuedMessages.filter((msg) => msg.mode === "followUp").map((msg) => msg.text),
			],
		};
	}

	/**
	 * Clear all queued messages and return their contents.
	 * Clears both session queue and compaction queue.
	 */
	private clearAllQueues(): { steering: string[]; followUp: string[] } {
		const { steering, followUp } = this.session.clearQueue();
		const compactionSteering = this.compactionQueuedMessages
			.filter((msg) => msg.mode === "steer")
			.map((msg) => msg.text);
		const compactionFollowUp = this.compactionQueuedMessages
			.filter((msg) => msg.mode === "followUp")
			.map((msg) => msg.text);
		this.compactionQueuedMessages = [];
		return {
			steering: [...steering, ...compactionSteering],
			followUp: [...followUp, ...compactionFollowUp],
		};
	}

	private updatePendingMessagesDisplay(): void {
		this.pendingMessagesContainer.clear();
		const { steering: steeringMessages, followUp: followUpMessages } = this.getAllQueuedMessages();
		if (steeringMessages.length > 0 || followUpMessages.length > 0) {
			this.pendingMessagesContainer.addChild(new Spacer(1));
			for (const message of steeringMessages) {
				const text = theme.fg("dim", `Steering: ${message}`);
				this.pendingMessagesContainer.addChild(new TruncatedText(text, 1, 0));
			}
			for (const message of followUpMessages) {
				const text = theme.fg("dim", `Follow-up: ${message}`);
				this.pendingMessagesContainer.addChild(new TruncatedText(text, 1, 0));
			}
			const dequeueHint = this.getAppKeyDisplay("app.message.dequeue");
			const hintText = theme.fg("dim", `↳ ${dequeueHint} or click to edit all queued messages`);
			this.pendingMessagesContainer.addChild(
				new MouseRegion(new TruncatedText(hintText, 1, 0), (event) => {
					if (event.type === "move") return { handled: true, pointer: "pointer" };
					if (event.type !== "click" || event.button !== "left") return undefined;
					this.handleDequeue();
					return { handled: true };
				}),
			);
		}
	}

	private restoreQueuedMessagesToEditor(options?: { abort?: boolean; currentText?: string }): number {
		const { steering, followUp } = this.clearAllQueues();
		const allQueued = [...steering, ...followUp];
		if (allQueued.length === 0) {
			this.updatePendingMessagesDisplay();
			if (options?.abort) {
				void this.session.abort();
			}
			return 0;
		}
		const queuedText = allQueued.join("\n\n");
		const currentText = options?.currentText ?? this.editor.getText();
		const combinedText = [queuedText, currentText].filter((t) => t.trim()).join("\n\n");
		this.editor.setText(combinedText);
		this.updatePendingMessagesDisplay();
		if (options?.abort) {
			void this.session.abort();
		}
		return allQueued.length;
	}

	private queueCompactionMessage(text: string, mode: "steer" | "followUp"): void {
		this.compactionQueuedMessages.push({ text, mode });
		this.rememberPrompt(text);
		this.editor.setText("");
		this.updatePendingMessagesDisplay();
		this.showStatus("Queued message for after compaction");
	}

	private isExtensionCommand(text: string): boolean {
		if (!text.startsWith("/")) return false;

		const extensionRunner = this.session.extensionRunner;

		const spaceIndex = text.indexOf(" ");
		const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
		return !!extensionRunner.getCommand(commandName);
	}

	private async flushCompactionQueue(options?: { willRetry?: boolean }): Promise<void> {
		if (this.compactionQueuedMessages.length === 0) {
			return;
		}

		const queuedMessages = [...this.compactionQueuedMessages];
		this.compactionQueuedMessages = [];
		this.updatePendingMessagesDisplay();

		const restoreQueue = (error: unknown) => {
			this.session.clearQueue();
			this.compactionQueuedMessages = queuedMessages;
			this.updatePendingMessagesDisplay();
			this.showError(
				`Failed to send queued message${queuedMessages.length > 1 ? "s" : ""}: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		};

		try {
			if (options?.willRetry) {
				// When retry is pending, queue messages for the retry turn
				for (const message of queuedMessages) {
					if (this.isExtensionCommand(message.text)) {
						await this.session.prompt(message.text);
					} else if (message.mode === "followUp") {
						await this.session.followUp(message.text);
					} else {
						await this.session.steer(message.text);
					}
				}
				this.updatePendingMessagesDisplay();
				return;
			}

			// Find first non-extension-command message to use as prompt
			const firstPromptIndex = queuedMessages.findIndex((message) => !this.isExtensionCommand(message.text));
			if (firstPromptIndex === -1) {
				// All extension commands - execute them all
				for (const message of queuedMessages) {
					await this.session.prompt(message.text);
				}
				return;
			}

			// Execute any extension commands before the first prompt
			const preCommands = queuedMessages.slice(0, firstPromptIndex);
			const firstPrompt = queuedMessages[firstPromptIndex];
			const rest = queuedMessages.slice(firstPromptIndex + 1);

			for (const message of preCommands) {
				await this.session.prompt(message.text);
			}

			// Start a prompt when idle, or queue it into a run still finishing compaction.
			const promptPromise = this.session
				.prompt(firstPrompt.text, { streamingBehavior: firstPrompt.mode })
				.catch((error) => {
					restoreQueue(error);
				});

			// Queue remaining messages
			for (const message of rest) {
				if (this.isExtensionCommand(message.text)) {
					await this.session.prompt(message.text);
				} else if (message.mode === "followUp") {
					await this.session.followUp(message.text);
				} else {
					await this.session.steer(message.text);
				}
			}
			this.updatePendingMessagesDisplay();
			void promptPromise;
		} catch (error) {
			restoreQueue(error);
		}
	}

	/** Move pending bash components from pending area to chat */
	private flushPendingBashComponents(): void {
		for (const component of this.pendingBashComponents) {
			this.pendingMessagesContainer.removeChild(component);
			this.chatContainer.addChild(component);
		}
		this.pendingBashComponents = [];
	}

	// =========================================================================
	// Selectors
	// =========================================================================

	private disposeActiveSelector(): void {
		const dispose = this.activeSelectorDispose;
		this.activeSelectorToken = undefined;
		this.activeSelectorDispose = undefined;
		dispose?.();
	}

	/**
	 * Shows a selector component in place of the editor.
	 * @param create Factory that receives a `done` callback and returns the component and focus target
	 */
	private showSelector(
		create: (done: () => void) => { component: Component; focus: Component; dispose?: () => void },
	): void {
		const token = {};
		let dispose: (() => void) | undefined;
		const done = () => {
			dispose?.();
			if (this.activeSelectorToken !== token) return;
			this.activeSelectorToken = undefined;
			this.activeSelectorDispose = undefined;
			this.editorContainer.clear();
			this.editorContainer.addChild(this.editor);
			this.ui.setFocus(this.editor);
		};
		const created = create(done);
		dispose = created.dispose;
		this.disposeActiveSelector();
		this.activeSelectorToken = token;
		this.activeSelectorDispose = dispose;
		this.editorContainer.clear();
		this.editorContainer.addChild(created.component);
		this.ui.setFocus(created.focus);
		this.ui.requestRender();
	}

	/** `/statusline`: toggle and reorder footer items with a live preview; saves `footer.items`. */
	private showStatusLinePicker(onClosed?: () => void): void {
		this.showSelector((done) => {
			const preview = new FooterComponent(this.session, this.footerDataProvider);
			preview.setAutoCompactEnabled(this.session.autoCompactionEnabled);
			preview.setShow(this.settingsManager.getFooterShow());
			const picker = new StatusLinePickerComponent({
				items: this.settingsManager.getFooterItems(),
				preview: (items, width) => {
					preview.setItems(items);
					return preview.render(width);
				},
				onSave: (items) => {
					this.settingsManager.setFooterItems(items);
					this.footer.setItems(items);
					done();
					this.showStatus(items ? `Footer items saved: ${items.join(", ")}` : "Footer back to the default layout");
					this.ui.requestRender();
					onClosed?.();
				},
				onCancel: () => {
					done();
					this.ui.requestRender();
					onClosed?.();
				},
			});
			return { component: picker, focus: picker };
		});
	}

	private showSettingsSelector(): void {
		this.showSelector((done) => {
			let selector: SettingsSelectorComponent | undefined;
			const defaultProvider = this.settingsManager.getDefaultProvider();
			const defaultModelId = this.settingsManager.getDefaultModel();
			const defaultModel = defaultProvider && defaultModelId ? `${defaultProvider}/${defaultModelId}` : "not set";
			selector = new SettingsSelectorComponent(
				{
					autoCompact: this.session.autoCompactionEnabled,
					defaultModel,
					currentModel: this.session.model,
					availableDefaultModels: this.session.modelRuntime.getAvailableSnapshot(),
					showImages: this.settingsManager.getShowImages(),
					imageWidthCells: this.settingsManager.getImageWidthCells(),
					autoResizeImages: this.settingsManager.getImageAutoResize(),
					blockImages: this.settingsManager.getBlockImages(),
					enableSkillCommands: this.settingsManager.getEnableSkillCommands(),
					steeringMode: this.session.steeringMode,
					followUpMode: this.session.followUpMode,
					transport: this.settingsManager.getTransport(),
					httpIdleTimeoutMs: this.settingsManager.getHttpIdleTimeoutMs(),
					thinkingLevel: this.settingsManager.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL,
					availableThinkingLevels: [...THINKING_LEVEL_OPTIONS],
					modelThinkingLevels: this.settingsManager.getAllModelThinkingLevels(),
					currentTheme: this.themeController.getThemeSelection() || SYSTEM_THEME_NAME,
					terminalTheme: this.themeController.getTerminalTheme(),
					availableThemes: getAvailableThemes(),
					hideThinkingBlock: this.hideThinkingBlock,
					mermaidRenderingMode: this.settingsManager.getMermaidRenderingMode(),
					display: this.settingsManager.getDisplaySettings(),
					maxProseWidth: this.settingsManager.getMaxProseWidth(),
					footerLayout: this.settingsManager.getFooterItems() ? "custom" : "default",
					footerShow: this.settingsManager.getFooterShow(),
					reviewKey: this.reviewKeyChoices(),
					collapseChangelog: this.settingsManager.getCollapseChangelog(),
					doubleEscapeAction: this.settingsManager.getDoubleEscapeAction(),
					treeFilterMode: this.settingsManager.getTreeFilterMode(),
					showHardwareCursor: this.settingsManager.getShowHardwareCursor(),
					showCacheMissNotices: this.settingsManager.getShowCacheMissNotices(),
					modelFailover: this.settingsManager.getFailoverSettings().enabled,
					defaultProjectTrust: this.settingsManager.getDefaultProjectTrust(),
					editorPaddingX: this.settingsManager.getEditorPaddingX(),
					outputPad: this.settingsManager.getOutputPad(),
					autocompleteMaxVisible: this.settingsManager.getAutocompleteMaxVisible(),
					quietStartup: this.settingsManager.getQuietStartup(),
					clearOnShrink: this.settingsManager.getClearOnShrink(),
					showKeyHints: this.settingsManager.getUiHints(),
					showTerminalProgress: this.settingsManager.getShowTerminalProgress(),
					dynamicTitle: this.settingsManager.getDynamicTitle(),
					reducedMotion: this.settingsManager.getReducedMotion(),
					tuiMode: this.ui.mode,
					fullscreenExitOutput: this.settingsManager.getFullscreenExitOutput(),
					fullscreenScrollbar: this.settingsManager.getFullscreenScrollbar(),
					fullscreenCopyOnSelect: this.settingsManager.getFullscreenCopyOnSelect(),
					fullscreenWheelScrollLines: this.settingsManager.getFullscreenWheelScrollLines(),
					warnings: this.settingsManager.getWarnings(),
					click: {
						mouse: this.settingsManager.getMouseMode(),
						rightClick: this.settingsManager.getRawMouseRightClick(),
						cardActions: this.settingsManager.getCardActions(),
						editorOpen: this.settingsManager.getEditorOpen(),
						pointerShape: this.settingsManager.getPointerShapeSetting(),
						fullRepaint: this.settingsManager.getFullRepaint(),
					},
				},
				{
					onAutoCompactChange: (enabled) => {
						this.session.setAutoCompactionEnabled(enabled);
						this.footer.setAutoCompactEnabled(enabled);
					},
					onShowImagesChange: (enabled) => {
						this.settingsManager.setShowImages(enabled);
						for (const child of this.chatContainer.children) {
							if (child instanceof ToolExecutionComponent) {
								child.setShowImages(enabled);
							}
						}
					},
					onImageWidthCellsChange: (width) => {
						this.settingsManager.setImageWidthCells(width);
						for (const child of this.chatContainer.children) {
							if (child instanceof ToolExecutionComponent || child instanceof ToolGroupComponent) {
								child.setImageWidthCells(width);
							}
						}
					},
					onAutoResizeImagesChange: (enabled) => {
						this.settingsManager.setImageAutoResize(enabled);
					},
					onBlockImagesChange: (blocked) => {
						this.settingsManager.setBlockImages(blocked);
					},
					onEnableSkillCommandsChange: (enabled) => {
						this.settingsManager.setEnableSkillCommands(enabled);
						this.setupAutocompleteProvider();
					},
					onSteeringModeChange: (mode) => {
						this.session.setSteeringMode(mode);
					},
					onFollowUpModeChange: (mode) => {
						this.session.setFollowUpMode(mode);
					},
					onTransportChange: (transport) => {
						this.settingsManager.setTransport(transport);
						this.session.agent.transport = transport;
					},
					onHttpIdleTimeoutMsChange: (timeoutMs) => {
						this.settingsManager.setHttpIdleTimeoutMs(timeoutMs);
						void configureHttpDispatcher(timeoutMs);
						this.showStatus(`HTTP idle timeout: ${formatHttpIdleTimeoutMs(timeoutMs)}`);
					},
					onModelThinkingLevelChange: (provider, modelId, level) => {
						this.settingsManager.setModelThinkingLevel(provider, modelId, level);
						// If the override is for the current model, apply it to the session too
						const current = this.session.model;
						if (current && current.provider === provider && current.id === modelId) {
							this.session.setThinkingLevel(level);
							this.footer.invalidate();
							this.updateEditorBorderColor();
						}
					},
					onModelThinkingLevelRemove: (provider, modelId) => {
						this.settingsManager.removeModelThinkingLevel(provider, modelId);
						// If the override was for the current model, revert to global default
						const current = this.session.model;
						if (current && current.provider === provider && current.id === modelId) {
							const globalDefault = this.settingsManager.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL;
							this.session.setThinkingLevel(globalDefault);
							this.footer.invalidate();
							this.updateEditorBorderColor();
						}
					},
					onThemeChange: (themeSetting) => {
						this.settingsManager.setTheme(themeSetting);
						this.themeController.setThemeSetting(themeSetting);
					},
					onThemePreview: (themeName) => this.themeController.preview(themeName),
					onHideThinkingBlockChange: (hidden) => {
						this.hideThinkingBlock = hidden;
						this.settingsManager.setHideThinkingBlock(hidden);
						this.updateThinkingBlockVisibility();
					},
					onMermaidRenderingModeChange: (mode) => {
						this.settingsManager.setMermaidRenderingMode(mode);
						this.chatContainer.invalidate();
						this.ui.requestRender();
					},
					onDisplaySettingChange: (key, value) => {
						this.settingsManager.setDisplaySetting(key, value);
						this.applyTranscriptDisplaySettings();
						this.applyFooterTurnSummary();
						if (key === "changesTray" || key === "changesTrayPosition") void this.refreshChangesTray();
						else if (key === "toolOutput") this.setToolsExpanded(value === "expanded");
						else if (key === "groupReads" || key === "turnSummary") this.rebuildChatFromMessages();
						else if (key !== "diffOpens") this.chatContainer.invalidate();
						this.ui.requestRender();
					},
					onMaxProseWidthChange: (width) => {
						this.settingsManager.setMaxProseWidth(width);
						this.rebuildChatFromMessages();
					},
					onFooterShowChange: (show) => {
						this.settingsManager.setFooterShow(show);
						this.footer.setShow(show);
						this.ui.requestRender();
					},
					onFooterPreset: (preset) => {
						const show = footerShowForPreset(preset);
						this.settingsManager.setFooterShow(show);
						this.footer.setShow(show);
						this.settingsManager.setUiHints(preset !== "none");
						if (preset === "default" && this.settingsManager.getFooterItems()) {
							this.settingsManager.setFooterItems(undefined);
							this.footer.setItems(undefined);
						}
						this.ui.requestRender();
					},
					onOpenFooterLayout: () => {
						done();
						this.showStatusLinePicker(() => this.showSettingsSelector());
					},
					onReviewKeyChange: (key) => {
						this.keybindings.setUserBinding(
							"app.changes.review",
							key === "none" ? [] : key === REVIEW_KEY_DEFAULT ? undefined : (key as KeyId),
						);
						this.renderWidgets();
						this.showStatus(key === "none" ? "Review key removed (/diff still opens it)" : `Review key: ${key}`);
					},
					onShowCacheMissNoticesChange: (shown) => {
						this.settingsManager.setShowCacheMissNotices(shown);
						this.rebuildChatFromMessages();
					},
					onModelFailoverChange: (enabled) => {
						this.settingsManager.setFailoverEnabled(enabled);
					},
					onCollapseChangelogChange: (collapsed) => {
						this.settingsManager.setCollapseChangelog(collapsed);
					},
					onQuietStartupChange: (quiet) => {
						this.settingsManager.setQuietStartup(quiet);
					},
					onDefaultProjectTrustChange: (defaultProjectTrust) => {
						this.settingsManager.setDefaultProjectTrust(defaultProjectTrust);
					},
					onDoubleEscapeActionChange: (action) => {
						this.settingsManager.setDoubleEscapeAction(action);
					},
					onTreeFilterModeChange: (mode) => {
						this.settingsManager.setTreeFilterMode(mode);
					},
					onShowHardwareCursorChange: (enabled) => {
						this.settingsManager.setShowHardwareCursor(enabled);
						this.ui.setShowHardwareCursor(enabled);
					},
					onEditorPaddingXChange: (padding) => {
						this.settingsManager.setEditorPaddingX(padding);
						this.defaultEditor.setPaddingX(padding);
						if (this.editor !== this.defaultEditor && this.editor.setPaddingX !== undefined) {
							this.editor.setPaddingX(padding);
						}
					},
					onOutputPadChange: (padding) => {
						this.settingsManager.setOutputPad(padding);
						this.outputPad = padding;
						for (const container of [this.chatContainer, this.pendingMessagesContainer]) {
							for (const child of container.children) {
								if ("setOutputPad" in child && typeof child.setOutputPad === "function") {
									child.setOutputPad(padding);
								}
							}
						}
						this.ui.requestRender();
					},
					onAutocompleteMaxVisibleChange: (maxVisible) => {
						this.settingsManager.setAutocompleteMaxVisible(maxVisible);
						this.defaultEditor.setAutocompleteMaxVisible(maxVisible);
						if (this.editor !== this.defaultEditor && this.editor.setAutocompleteMaxVisible !== undefined) {
							this.editor.setAutocompleteMaxVisible(maxVisible);
						}
					},
					onShowKeyHintsChange: (enabled) => {
						this.settingsManager.setUiHints(enabled);
						this.ui.requestRender();
					},
					onClearOnShrinkChange: (enabled) => {
						this.settingsManager.setClearOnShrink(enabled);
						this.ui.setClearOnShrink(enabled);
						if (!enabled && !this.activeStatusIndicator) {
							this.statusContainer.clear();
						}
					},
					onDynamicTitleChange: (enabled) => {
						this.settingsManager.setDynamicTitle(enabled);
						this.updateTerminalTitle();
					},
					onReducedMotionChange: (enabled) => {
						this.settingsManager.setReducedMotion(enabled);
						setReducedMotion(enabled);
					},
					onShowTerminalProgressChange: (enabled) => {
						this.settingsManager.setShowTerminalProgress(enabled);
					},
					onTuiModeChange: (mode) => {
						if (!this.switchTuiMode(mode)) {
							selector?.getSettingsList().updateValue("tui-mode", this.ui.mode);
							this.showStatus("Close active overlays before changing TUI mode");
							return;
						}
						this.settingsManager.setTuiMode(mode);
						if (!this.activeStatusIndicator) this.statusContainer.clear();
						this.showStatus(`TUI mode: ${mode}`);
					},
					onFullscreenExitOutputChange: (output) => {
						this.settingsManager.setFullscreenExitOutput(output);
					},
					onFullscreenScrollbarChange: (mode) => {
						this.settingsManager.setFullscreenScrollbar(mode);
						this.applyFullscreenScrollbarSetting();
					},
					onFullscreenCopyOnSelectChange: (enabled) => {
						this.settingsManager.setFullscreenCopyOnSelect(enabled);
						if (this.renderer instanceof TuiAltScreen) this.renderer.setCopyOnSelect(enabled);
					},
					onClickSettingChange: (id, value) => this.applyClickSetting(id, value),
					onFullscreenWheelScrollLinesChange: (lines) => {
						this.settingsManager.setFullscreenWheelScrollLines(lines);
						if (this.renderer instanceof TuiAltScreen) this.renderer.setWheelScrollLines(lines);
					},
					onWarningsChange: (warnings) => {
						this.settingsManager.setWarnings(warnings);
					},
					onCancel: () => {
						done();
						this.ui.requestRender();
					},
				},
			);
			return { component: selector, focus: selector.getSettingsList() };
		});
	}

	private handleThinkingCommand(searchTerm?: string): void {
		const availableLevels = this.session.getAvailableThinkingLevels();
		if (!searchTerm) {
			this.showThinkingSelector();
			return;
		}

		const normalized = searchTerm.trim().toLowerCase();
		if (normalized === "auto") {
			this.selectThinkingLevel("auto", false);
			return;
		}
		// Auto mode pins any level; it is clamped per routed model.
		const choices: ThinkingLevel[] = this.session.isAutoRouting
			? ["off", "minimal", "low", "medium", "high", "xhigh", "max"]
			: availableLevels;
		const level = choices.find((candidate) => candidate.toLowerCase() === normalized);
		if (!level) {
			this.showError(
				`Unknown thinking level "${searchTerm}". Available levels: ${[...(this.session.isAutoRouting ? ["auto"] : []), ...choices].join(", ")}.`,
			);
			return;
		}

		this.selectThinkingLevel(level, false);
	}

	private selectThinkingLevel(level: ThinkingChoice, persist: boolean): void {
		if (level === "auto") {
			if (!this.session.isAutoRouting) {
				this.showError('Thinking "auto" works with the auto model (/model auto)');
				return;
			}
			this.session.setThinkingAuto();
			this.footer.invalidate();
			this.updateEditorBorderColor();
			this.showStatus("Thinking level: auto (router picks per turn)");
			return;
		}
		try {
			this.session.setThinkingLevel(level, { persist });
			this.footer.invalidate();
			this.updateEditorBorderColor();
			const pinned = this.session.isAutoRouting ? " (pinned; /thinking auto to let the router pick)" : "";
			this.showStatus(persist ? `Default thinking level: ${level}${pinned}` : `Thinking level: ${level}${pinned}`);
		} catch (error) {
			this.showError(error instanceof Error ? error.message : String(error));
		}
	}

	private showThinkingSelector(): void {
		this.showSelector((done) => {
			const selectLevel = (level: ThinkingChoice, persist: boolean) => {
				this.selectThinkingLevel(level, persist);
				done();
			};
			const auto = this.session.isAutoRouting;
			const selector = new ThinkingSelectorComponent(
				this.session.isThinkingAuto ? "auto" : (this.session.thinkingLevel ?? DEFAULT_THINKING_LEVEL),
				auto
					? ["auto", ...(["off", "minimal", "low", "medium", "high", "xhigh", "max"] as ThinkingLevel[])]
					: this.session.getAvailableThinkingLevels(),
				(level) => selectLevel(level, false),
				() => {
					done();
					this.ui.requestRender();
				},
				(level) => selectLevel(level, true),
				this.settingsManager.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL,
			);
			return { component: selector, focus: selector };
		});
	}

	/** " (classifier: …)" or a warning suffix when no classifier is configured. */
	private describeRouterReadiness(): string {
		const status = this.session.getRouterStatus();
		if (status.backend)
			return ` - classifier: ${status.backend}${status.classifierModel ? ` ${status.classifierModel}` : ""}`;
		return ` - no classifier (${status.problem ?? "not configured"}): using the default model`;
	}

	private handleRouterCommand(arg: string): void {
		if (isRouterMode(arg)) {
			try {
				if (!this.session.isAutoRouting) this.session.setAutoRouting(true, { mode: arg });
				else this.session.setRouterMode(arg);
				this.footer.invalidate();
				this.updateEditorBorderColor();
				this.showStatus(`Auto routing: ${arg} (${this.session.getRouterStatus().modeDescription ?? ""})`);
			} catch (error) {
				this.showError(error instanceof Error ? error.message : String(error));
			}
			return;
		}
		if (arg === "on" || arg === "off") {
			try {
				this.session.setAutoRouting(arg === "on");
				this.footer.invalidate();
				this.updateEditorBorderColor();
				this.showStatus(
					arg === "on"
						? `Auto routing on (auto:${this.session.routerMode})${this.describeRouterReadiness()}`
						: `Auto routing off: staying on ${this.session.model?.id ?? "the current model"}`,
				);
			} catch (error) {
				this.showError(error instanceof Error ? error.message : String(error));
			}
			return;
		}
		if (arg) {
			this.showError("Usage: /router [on|off|low|medium|high]");
			return;
		}
		this.chatContainer.addChild(new Spacer(1));
		const report = this.session.formatRouterReport({ modeCycleKey: keyText("app.router.cycleMode") });
		this.chatContainer.addChild(new Text(theme.fg("muted", report), 1, 0));
		this.ui.requestRender();
	}

	private async handleModelCommand(searchTerm?: string): Promise<void> {
		if (!searchTerm) {
			this.showModelSelector();
			return;
		}
		if (isAutoModelId(searchTerm)) {
			try {
				this.session.setAutoRouting(true, { mode: parseAutoMode(searchTerm) });
				this.footer.invalidate();
				this.updateEditorBorderColor();
				this.showStatus(
					`Model: auto:${this.session.routerMode} (router picks model and thinking per turn)${this.describeRouterReadiness()}`,
				);
			} catch (error) {
				this.showError(error instanceof Error ? error.message : String(error));
			}
			return;
		}

		const model = await this.findExactModelMatch(searchTerm);
		if (model) {
			try {
				await this.session.setModel(model, { persist: false });
				this.footer.invalidate();
				this.updateEditorBorderColor();
				this.showStatus(
					this.session.isAutoRouting
						? `Model: auto:${this.session.routerMode} (router picks model and thinking per turn)${this.describeRouterReadiness()}`
						: `Model: ${model.id}`,
				);
				void this.maybeWarnAboutAnthropicSubscriptionAuth(model);
			} catch (error) {
				this.showError(error instanceof Error ? error.message : String(error));
			}
			return;
		}

		this.showModelSelector(searchTerm);
	}

	private async findExactModelMatch(searchTerm: string): Promise<Model<any> | undefined> {
		const cachedModels =
			this.session.scopedModels.length > 0
				? this.session.scopedModels.map((scoped) => scoped.model)
				: [...this.session.modelRuntime.getAvailableSnapshot()];
		const cachedMatch = findExactModelReferenceMatch(searchTerm, cachedModels);
		if (cachedMatch || this.session.scopedModels.length > 0) return cachedMatch;

		return undefined;
	}

	/** Update the footer's available provider count from the current snapshot without refreshing catalogs. */
	private updateAvailableProviderCount(): void {
		const models =
			this.session.scopedModels.length > 0
				? this.session.scopedModels.map((scoped) => scoped.model)
				: this.session.modelRuntime.getAvailableSnapshot();
		const uniqueProviders = new Set(models.map((model) => model.provider));
		this.footerDataProvider.setAvailableProviderCount(uniqueProviders.size);
	}

	private async maybeWarnAboutAnthropicSubscriptionAuth(
		model: Model<any> | undefined = this.session.model,
	): Promise<void> {
		if (this.settingsManager.getWarnings().anthropicExtraUsage === false) {
			return;
		}
		if (this.anthropicSubscriptionWarningShown) {
			return;
		}
		if (!model || model.provider !== "anthropic") {
			return;
		}

		try {
			if ((await this.session.modelRuntime.checkAuth("anthropic"))?.type === "oauth") {
				this.anthropicSubscriptionWarningShown = true;
				this.showWarning(ANTHROPIC_SUBSCRIPTION_AUTH_WARNING);
				return;
			}
			const apiKey = (await this.session.modelRuntime.getAuth(model.provider))?.auth.apiKey;
			if (!isAnthropicSubscriptionAuthKey(apiKey)) {
				return;
			}
			this.anthropicSubscriptionWarningShown = true;
			this.showWarning(ANTHROPIC_SUBSCRIPTION_AUTH_WARNING);
		} catch {
			// Ignore auth lookup failures for warning-only checks.
		}
	}

	private maybeSaveImplicitProjectTrustAfterReload(): boolean {
		const cwd = this.sessionManager.getCwd();
		if (this.autoTrustOnReloadCwd !== cwd) {
			return false;
		}
		if (!this.settingsManager.isProjectTrusted() || !hasTrustRequiringProjectResources(cwd)) {
			return false;
		}

		const trustStore = new ProjectTrustStore(this.runtimeHost.services.agentDir);
		try {
			if (trustStore.get(cwd) !== null) {
				this.autoTrustOnReloadCwd = undefined;
				return false;
			}
			trustStore.set(cwd, true);
			this.autoTrustOnReloadCwd = undefined;
			return true;
		} catch (error) {
			this.showWarning(
				`Could not save project trust after reload: ${error instanceof Error ? error.message : String(error)}`,
			);
			return false;
		}
	}

	private showTrustSelector(): void {
		const cwd = this.sessionManager.getCwd();
		const trustStore = new ProjectTrustStore(this.runtimeHost.services.agentDir);
		const savedDecision = trustStore.getEntry(cwd);
		this.showSelector((done) => {
			const selector = new TrustSelectorComponent({
				cwd,
				savedDecision,
				projectTrusted: this.settingsManager.isProjectTrusted(),
				onSelect: (selection) => {
					trustStore.setMany(selection.updates);
					done();
					this.showStatus(
						`Saved trust decision: ${selection.trusted ? "trusted" : "untrusted"}. Restart ${APP_NAME} for this to take effect.`,
					);
				},
				onCancel: () => {
					done();
					this.ui.requestRender();
				},
			});
			return { component: selector, focus: selector };
		});
	}

	private showModelSelector(initialSearchInput?: string): void {
		this.showSelector((done) => {
			const selectModel = async (model: Model<any>, persist: boolean) => {
				try {
					await this.session.setModel(model, { persist });
					this.updateAvailableProviderCount();
					this.footer.invalidate();
					this.updateEditorBorderColor();
					done();
					if (this.session.isAutoRouting) {
						this.showStatus(
							`${persist ? "Default model" : "Model"}: auto:${this.session.routerMode} (router picks model and thinking per turn)${this.describeRouterReadiness()}`,
						);
					} else {
						this.showStatus(persist ? `Default model: ${model.provider}/${model.id}` : `Model: ${model.id}`);
					}
					void this.maybeWarnAboutAnthropicSubscriptionAuth(model);
				} catch (error) {
					done();
					this.showError(error instanceof Error ? error.message : String(error));
				}
			};
			const defaultProvider = this.settingsManager.getDefaultProvider();
			const defaultModel = this.settingsManager.getDefaultModel();
			const selector = new ModelSelectorComponent(
				this.ui,
				this.session.selectedModel,
				this.session.modelRuntime,
				this.session.scopedModels,
				(model) => selectModel(model, false),
				() => {
					done();
					this.ui.requestRender();
				},
				initialSearchInput,
				(model) => selectModel(model, true),
				defaultProvider && defaultModel ? { provider: defaultProvider, id: defaultModel } : undefined,
			);
			return { component: selector, focus: selector, dispose: () => selector.dispose() };
		});
	}

	private showModelsSelector(onClosed?: () => void): void {
		const availableModels = [...this.session.modelRuntime.getAvailableSnapshot()];
		const availableModelIds = new Set(availableModels.map((model) => `${model.provider}/${model.id}`));
		const configuredPatterns = this.settingsManager.getEnabledModels();
		const sessionScopedModels = this.session.scopedModels;
		const configuredEnabledIds = (models: readonly Model<any>[]): string[] | null => {
			if (!configuredPatterns?.length) return null;
			const resolved = resolveModelScopeFromModels(configuredPatterns, models);
			const ids = resolved.scopedModels.map((scoped) => `${scoped.model.provider}/${scoped.model.id}`);
			for (const diagnostic of resolved.diagnostics) {
				if (diagnostic.code === "no-match" && !ids.includes(diagnostic.pattern)) ids.push(diagnostic.pattern);
			}
			return ids;
		};

		let currentEnabledIds =
			sessionScopedModels.length > 0
				? sessionScopedModels.map((scoped) => `${scoped.model.provider}/${scoped.model.id}`)
				: configuredEnabledIds(availableModels);
		let selectionChanged = false;

		const updateSessionModels = (enabledIds: string[] | null): void => {
			currentEnabledIds = enabledIds === null ? null : [...enabledIds];
			const hasEnabledAvailableModel = enabledIds?.some((id) => availableModelIds.has(id)) ?? false;
			const allAvailableModelsEnabled =
				enabledIds !== null && [...availableModelIds].every((id) => enabledIds.includes(id));
			if (enabledIds && hasEnabledAvailableModel && !allAvailableModelsEnabled) {
				const newScopedModels = resolveModelScopeFromModels(enabledIds, availableModels).scopedModels;
				this.session.setScopedModels(
					newScopedModels.map((scoped) => ({
						model: scoped.model,
						thinkingLevel: scoped.thinkingLevel,
					})),
				);
			} else {
				this.session.setScopedModels([]);
			}
			this.updateAvailableProviderCount();
			this.ui.requestRender();
		};

		this.showSelector((done) => {
			const selector = new ScopedModelsSelectorComponent(
				{
					allModels: availableModels,
					enabledModelIds: currentEnabledIds,
				},
				{
					onChange: (enabledIds) => {
						selectionChanged = true;
						updateSessionModels(enabledIds);
					},
					onPersist: (enabledIds) => {
						const allEnabled =
							enabledIds !== null &&
							enabledIds.length === availableModels.length &&
							enabledIds.every((id) => availableModelIds.has(id));
						const newPatterns = enabledIds === null || allEnabled ? undefined : enabledIds;
						this.settingsManager.setEnabledModels(newPatterns ? [...newPatterns] : undefined);
						this.showStatus("Model selection saved to settings");
					},
					onCancel: () => {
						done();
						this.ui.requestRender();
						onClosed?.();
					},
				},
			);
			return { component: selector, focus: selector };
		});
	}

	private showUserMessageSelector(): void {
		const userMessages = this.session.getUserMessagesForForking();
		const canCopy = !!this.sessionManager.getLeafId();

		if (userMessages.length === 0 && !canCopy) {
			this.showStatus("No messages to fork from");
			return;
		}

		const initialSelectedId = userMessages[userMessages.length - 1]?.entryId ?? FORK_HERE_ID;
		const items = userMessages.map((m) => ({ id: m.entryId, text: m.text }));
		// The last entry copies the whole session as it is now (what /clone did).
		if (canCopy) items.push({ id: FORK_HERE_ID, text: "Here, now: a copy of this whole session" });

		this.showSelector((done) => {
			const selector = new UserMessageSelectorComponent(
				items,
				async (entryId) => {
					done();
					if (entryId === FORK_HERE_ID) {
						await this.handleCloneCommand();
						return;
					}
					try {
						const result = await this.runtimeHost.fork(entryId);
						if (result.cancelled) {
							this.ui.requestRender();
							return;
						}

						this.editor.setText(result.selectedText ?? "");
						this.showStatus("Forked to new session");
					} catch (error: unknown) {
						this.showError(error instanceof Error ? error.message : String(error));
					}
				},
				() => {
					done();
					this.ui.requestRender();
				},
				initialSelectedId,
			);
			return { component: selector, focus: selector.getMessageList() };
		});
	}

	/** Why /undo and /rewind cannot run now, or undefined when they can. */
	private checkpointBlocker(): string | undefined {
		if (this.session.isStreaming) return "Wait for the response to finish (Esc stops it) before going back.";
		if (this.session.isCompacting) return "Wait for the compaction to finish before going back.";
		return undefined;
	}

	private quoteTurn(point: RewindPoint): string {
		const text = point.text.replace(/\s+/g, " ").trim();
		return `turn ${point.turn} “${text.length > 50 ? `${text.slice(0, 49)}…` : text}”`;
	}

	/** Ask before overwriting files. True when the user confirmed. */
	private async confirmFileRestore(plan: RestorePlan, point: RewindPoint): Promise<boolean> {
		const count = plan.items.length;
		const title = `Restore ${count} file${count === 1 ? "" : "s"} to before ${this.quoteTurn(point)}?`;
		const choice = await this.showExtensionSelector(
			`${title}\n${formatRestorePlan(plan).join("\n")}`,
			[`Restore ${count === 1 ? "the file" : `${count} files`}`, "Cancel"],
			undefined,
			{ kind: "permission", message: title },
		);
		return choice !== undefined && choice !== "Cancel";
	}

	/** /undo: put the files back as they were before the last turn that changed them. The conversation stays. */
	private async handleUndoCommand(): Promise<void> {
		const blocked = this.checkpointBlocker();
		if (blocked) {
			this.showStatus(blocked);
			return;
		}
		if (!this.session.checkpoints) {
			this.showStatus("Checkpoints are off for this session (in-memory session or RUNKILN_CHECKPOINTS=0)");
			return;
		}
		try {
			const points = await this.session.getRewindPoints();
			const last = [...points]
				.reverse()
				.find((point) => point.checkpointId && !point.restored && (point.summary?.files.length ?? 0) > 0);
			if (!last) {
				this.showStatus("Nothing to undo: no turn on this branch changed files (or they were undone already)");
				return;
			}
			const plan = await this.session.planFileRestore(last.entryId);
			if (!plan || plan.items.length === 0) {
				this.showStatus(`Nothing to undo: the files already match how they were before ${this.quoteTurn(last)}`);
				return;
			}
			if (!(await this.confirmFileRestore(plan, last))) {
				this.showStatus("Undo cancelled; no files changed");
				return;
			}
			const result = await this.session.applyFileRestore(plan);
			void this.refreshChangesTray();
			const notice = `Undo ${this.quoteTurn(last)}: ${formatRestoreNotice(result)}. The conversation is unchanged (/rewind can rewind it too).`;
			if (result.failed.length > 0) this.showWarning(notice);
			else this.showStatus(notice);
		} catch (error) {
			this.showError(error instanceof Error ? error.message : String(error));
		}
	}

	/** /rewind: pick an earlier turn, then restore the files, the conversation, or both. */
	private async showRewindSelector(): Promise<void> {
		const blocked = this.checkpointBlocker();
		if (blocked) {
			this.showStatus(blocked);
			return;
		}
		let points: RewindPoint[];
		try {
			points = await this.session.getRewindPoints();
		} catch (error) {
			this.showError(error instanceof Error ? error.message : String(error));
			return;
		}
		if (points.length === 0) {
			this.showStatus("Nothing to rewind yet");
			return;
		}
		this.showSelector((done) => {
			const selector = new RewindSelectorComponent(
				points,
				(point) => {
					done();
					void this.rewindTo(point);
				},
				() => {
					done();
					this.ui.requestRender();
				},
			);
			return { component: selector, focus: selector.getList() };
		});
	}

	private async rewindTo(point: RewindPoint): Promise<void> {
		const BOTH = "Restore files and conversation";
		const CONVERSATION = "Restore conversation only";
		const FILES = "Restore files only";
		try {
			const plan =
				point.checkpointId || this.session.checkpoints
					? await this.session.planFileRestore(point.entryId)
					: undefined;
			const hasFiles = !!plan && plan.items.length > 0;
			const fileLine = hasFiles
				? `${plan.items.length} file${plan.items.length === 1 ? "" : "s"} changed since then.`
				: "No file changes to restore from this turn on.";
			const choice = await this.showExtensionSelector(
				`Rewind to before ${this.quoteTurn(point)}\n${fileLine} The conversation drops this turn and the ones after it; they stay in /tree.`,
				hasFiles ? [BOTH, CONVERSATION, FILES, "Cancel"] : [CONVERSATION, "Cancel"],
			);
			if (choice === undefined || choice === "Cancel") {
				this.showStatus("Rewind cancelled; nothing changed");
				return;
			}
			const notices: string[] = [];
			if ((choice === BOTH || choice === FILES) && plan) {
				if (!(await this.confirmFileRestore(plan, point))) {
					this.showStatus("Rewind cancelled; nothing changed");
					return;
				}
				const result = await this.session.applyFileRestore(plan);
				void this.refreshChangesTray();
				notices.push(formatRestoreNotice(result));
				if (result.failed.length > 0) {
					this.showWarning(`${notices[0]}. The conversation was not rewound.`);
					return;
				}
			}
			if (choice === BOTH || choice === CONVERSATION) {
				const rewound = await this.session.rewindConversation(point.entryId);
				if (rewound.cancelled) {
					notices.push("an extension kept the conversation as it was");
				} else {
					this.chatContainer.clear();
					this.renderInitialMessages();
					if (rewound.editorText && !this.editor.getText().trim()) this.editor.setText(rewound.editorText);
					notices.push("conversation rewound, your message is back in the editor");
				}
			}
			const notice = `Rewound to before ${this.quoteTurn(point)}: ${notices.join("; ")}`;
			this.showStatus(notice);
		} catch (error) {
			this.showError(error instanceof Error ? error.message : String(error));
		}
	}

	private async handleCloneCommand(): Promise<void> {
		const leafId = this.sessionManager.getLeafId();
		if (!leafId) {
			this.showStatus("Nothing to clone yet");
			return;
		}

		try {
			const result = await this.runtimeHost.fork(leafId, { position: "at" });
			if (result.cancelled) {
				this.ui.requestRender();
				return;
			}

			this.editor.setText("");
			this.showStatus("Cloned to new session");
		} catch (error: unknown) {
			this.showError(error instanceof Error ? error.message : String(error));
		}
	}

	private showTreeSelector(initialSelectedId?: string): void {
		const tree = this.sessionManager.getTree();
		const realLeafId = this.sessionManager.getLeafId();
		const initialFilterMode = this.settingsManager.getTreeFilterMode();

		if (tree.length === 0) {
			this.showStatus("No entries in session");
			return;
		}

		this.showSelector((done) => {
			const selector = new TreeSelectorComponent(
				tree,
				realLeafId,
				this.ui.terminal.rows,
				async (entryId) => {
					// Selecting the current leaf is a no-op (already there)
					if (entryId === this.sessionManager.getLeafId()) {
						done();
						this.showStatus("Already at this point");
						return;
					}

					// Ask about summarization
					done(); // Close selector first

					// Loop until user makes a complete choice or cancels to tree
					let wantsSummary = false;
					let customInstructions: string | undefined;

					// Check if we should skip the prompt (user preference to always default to no summary)
					if (!this.settingsManager.getBranchSummarySkipPrompt()) {
						while (true) {
							const summaryChoice = await this.showExtensionSelector("Summarize branch?", [
								"No summary",
								"Summarize",
								"Summarize with custom prompt",
							]);

							if (summaryChoice === undefined) {
								// User pressed escape - re-show tree selector with same selection
								this.showTreeSelector(entryId);
								return;
							}

							wantsSummary = summaryChoice !== "No summary";

							if (summaryChoice === "Summarize with custom prompt") {
								customInstructions = await this.showExtensionEditor("Custom summarization instructions");
								if (customInstructions === undefined) {
									// User cancelled - loop back to summary selector
									continue;
								}
							}

							// User made a complete choice
							break;
						}
					}

					// The user committed to navigating: stop the active response first.
					if (this.session.isStreaming) {
						this.restoreQueuedMessagesToEditor();
						await this.session.abort();
					}

					// Recheck after the dialogs and streaming abort, before replacing another operation's UI.
					if (this.session.isCompacting) {
						this.showError(
							"Wait for the current compaction or tree navigation to finish before navigating the session tree.",
						);
						return;
					}

					// Set up escape handler and status indicator if summarizing
					let showingSummaryIndicator = false;
					const originalOnEscape = this.defaultEditor.onEscape;

					if (wantsSummary) {
						this.defaultEditor.onEscape = () => {
							this.session.abortBranchSummary();
						};
						this.chatContainer.addChild(new Spacer(1));
						this.showStatusIndicator(new BranchSummaryStatusIndicator(this.ui));
						showingSummaryIndicator = true;
						this.ui.requestRender();
					}

					try {
						const result = await this.session.navigateTree(entryId, {
							summarize: wantsSummary,
							customInstructions,
						});

						if (result.aborted) {
							// Summarization aborted - re-show tree selector with same selection
							this.showStatus("Branch summarization cancelled");
							this.showTreeSelector(entryId);
							return;
						}
						if (result.cancelled) {
							this.showStatus("Navigation cancelled");
							return;
						}

						// Update UI
						this.chatContainer.clear();
						this.renderInitialMessages();
						if (result.editorText && !this.editor.getText().trim()) {
							this.editor.setText(result.editorText);
						}
						this.showStatus("Navigated to selected point");
						void this.flushCompactionQueue({ willRetry: false });
					} catch (error) {
						this.showError(error instanceof Error ? error.message : String(error));
					} finally {
						if (showingSummaryIndicator) {
							this.clearStatusIndicator("branchSummary");
						}
						this.defaultEditor.onEscape = originalOnEscape;
					}
				},
				() => {
					done();
					this.ui.requestRender();
				},
				(entryId, label) => {
					this.sessionManager.appendLabelChange(entryId, label);
					this.ui.requestRender();
				},
				initialSelectedId,
				initialFilterMode,
			);
			selector.onCopy = async (text) => {
				if (!text) {
					this.showError("Selected entry has no text to copy");
					return;
				}
				try {
					await copyToClipboard(text);
					this.showStatus("Copied selected message to clipboard");
				} catch (error) {
					this.showError(error instanceof Error ? error.message : String(error));
				}
			};
			return { component: selector, focus: selector };
		});
	}

	private showSessionSelector(): void {
		this.showSelector((done) => {
			const selector = new SessionSelectorComponent(
				(onProgress, signal) =>
					SessionManager.list(
						this.sessionManager.getCwd(),
						this.sessionManager.getSessionDir(),
						onProgress,
						signal,
					),
				(onProgress, signal) =>
					this.sessionManager.usesDefaultSessionDir()
						? SessionManager.listAll(onProgress, signal)
						: SessionManager.listAll(this.sessionManager.getSessionDir(), onProgress, signal),
				async (sessionPath) => {
					done();
					await this.handleResumeSession(sessionPath);
				},
				() => {
					done();
					this.ui.requestRender();
				},
				() => {
					void this.shutdown();
				},
				() => this.ui.requestRender(),
				{
					renameSession: async (sessionFilePath: string, nextName: string | undefined) => {
						const next = (nextName ?? "").trim();
						if (!next) return;
						const mgr = SessionManager.open(sessionFilePath);
						mgr.appendSessionInfo(next);
					},
					showRenameHint: true,
					keybindings: this.keybindings,
				},

				this.sessionManager.getSessionFile(),
			);
			return { component: selector, focus: selector };
		});
	}

	private async handleResumeSession(
		sessionPath: string,
		options?: Parameters<ExtensionCommandContext["switchSession"]>[1],
	): Promise<{ cancelled: boolean }> {
		this.clearStatusIndicator();
		try {
			const result = await this.runtimeHost.switchSession(sessionPath, {
				withSession: options?.withSession,
				projectTrustContextFactory: (cwd) => this.createProjectTrustContext(cwd),
			});
			if (result.cancelled) {
				return result;
			}
			this.showStatus("Resumed session");
			return result;
		} catch (error: unknown) {
			if (error instanceof MissingSessionCwdError) {
				const selectedCwd = await this.promptForMissingSessionCwd(error);
				if (!selectedCwd) {
					this.showStatus("Resume cancelled");
					return { cancelled: true };
				}
				const result = await this.runtimeHost.switchSession(sessionPath, {
					cwdOverride: selectedCwd,
					withSession: options?.withSession,
					projectTrustContextFactory: (cwd) => this.createProjectTrustContext(cwd),
				});
				if (result.cancelled) {
					return result;
				}
				this.showStatus("Resumed session in current cwd");
				return result;
			}
			return this.handleFatalRuntimeError("Failed to resume session", error);
		}
	}

	// =========================================================================
	// Command handlers
	// =========================================================================

	private async handleReloadCommand(): Promise<void> {
		if (this.session.isStreaming) {
			this.showWarning("Wait for the current response to finish before reloading.");
			return;
		}
		if (this.session.isCompacting) {
			this.showWarning("Wait for compaction to finish before reloading.");
			return;
		}

		this.resetExtensionUI();

		const reloadBox = new Container();
		const borderColor = (s: string) => theme.fg("border", s);
		reloadBox.addChild(new DynamicBorder(borderColor));
		reloadBox.addChild(new Spacer(1));
		reloadBox.addChild(
			new ThemedText(
				() => theme.fg("muted", "Reloading keybindings, extensions, skills, prompts, themes, and context files..."),
				1,
				0,
			),
		);
		reloadBox.addChild(new Spacer(1));
		reloadBox.addChild(new DynamicBorder(borderColor));

		const previousEditor = this.editor;
		this.editorContainer.clear();
		this.editorContainer.addChild(reloadBox);
		this.ui.setFocus(reloadBox);
		this.ui.requestRender(true);
		await new Promise((resolve) => process.nextTick(resolve));

		const dismissReloadBox = (editor: Component) => {
			this.editorContainer.clear();
			this.editorContainer.addChild(editor);
			this.ui.setFocus(editor);
			this.ui.requestRender();
		};

		let chatRestoredBeforeSessionStart = false;
		let reloadBoxDismissed = false;
		const restoreChatBeforeSessionStart = () => {
			if (chatRestoredBeforeSessionStart) {
				return;
			}
			this.hideThinkingBlock = this.settingsManager.getHideThinkingBlock();
			this.outputPad = this.settingsManager.getOutputPad();
			this.rebuildChatFromMessages();
			chatRestoredBeforeSessionStart = true;
		};

		try {
			await this.session.reload({ beforeSessionStart: restoreChatBeforeSessionStart });
			restoreChatBeforeSessionStart();
			this.keybindings.reload();
			const activeHeader = this.customHeader ?? this.builtInHeader;
			if (isExpandable(activeHeader)) {
				activeHeader.setExpanded(this.toolOutputExpanded);
			}
			setRegisteredThemes(this.session.resourceLoader.getThemes().themes);
			this.applyRuntimeSettings();
			this.themeController.applyFromSettings();
			this.setupAutocompleteProvider();
			const runner = this.session.extensionRunner;
			this.setupExtensionShortcuts(runner);
			this.showLoadedResources({
				force: false,
				showDiagnosticsWhenQuiet: true,
			});
			const savedImplicitProjectTrust = this.maybeSaveImplicitProjectTrustAfterReload();
			const modelsJsonError = this.session.modelRuntime.getError();
			if (modelsJsonError) {
				this.showError(`models.json error: ${modelsJsonError}`);
			}
			this.showStatus(
				savedImplicitProjectTrust
					? "Reloaded keybindings, extensions, skills, prompts, themes, and context files; saved project trust"
					: "Reloaded keybindings, extensions, skills, prompts, themes, and context files",
			);
			dismissReloadBox(this.editor as Component);
			reloadBoxDismissed = true;
		} catch (error) {
			if (!reloadBoxDismissed) {
				dismissReloadBox(previousEditor as Component);
			}
			this.showError(`Reload failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private async handleExportCommand(text: string): Promise<void> {
		const outputPath = this.getPathCommandArgument(text, "/export");

		try {
			if (outputPath?.endsWith(".jsonl")) {
				const filePath = this.session.exportToJsonl(outputPath);
				this.showStatus(`Session exported to: ${filePath}`);
			} else {
				const filePath = await this.session.exportToHtml(outputPath, {
					themeName: theme.name,
				});
				this.showStatus(`Session exported to: ${filePath}`);
			}
		} catch (error: unknown) {
			this.showError(`Failed to export session: ${error instanceof Error ? error.message : "Unknown error"}`);
		}
	}

	private getPathCommandArgument(text: string, command: "/export" | "/import"): string | undefined {
		if (text === command) {
			return undefined;
		}
		if (!text.startsWith(`${command} `)) {
			return undefined;
		}

		const argsString = text.slice(command.length + 1).trimStart();
		if (!argsString) {
			return undefined;
		}

		const firstChar = argsString[0];
		if (firstChar === '"' || firstChar === "'") {
			const closingQuoteIndex = argsString.indexOf(firstChar, 1);
			if (closingQuoteIndex < 0) {
				return undefined;
			}
			return argsString.slice(1, closingQuoteIndex);
		}

		const firstWhitespaceIndex = argsString.search(/\s/);
		if (firstWhitespaceIndex < 0) {
			return argsString;
		}
		return argsString.slice(0, firstWhitespaceIndex);
	}

	private async handleImportCommand(text: string): Promise<void> {
		const inputPath = this.getPathCommandArgument(text, "/import");
		if (!inputPath) {
			this.showError("Usage: /import <path.jsonl>");
			return;
		}

		const confirmed = await this.showExtensionConfirm("Import session", `Replace current session with ${inputPath}?`);
		if (!confirmed) {
			this.showStatus("Import cancelled");
			return;
		}

		try {
			this.clearStatusIndicator();
			const result = await this.runtimeHost.importFromJsonl(inputPath);
			if (result.cancelled) {
				this.showStatus("Import cancelled");
				return;
			}
			this.showStatus(`Session imported from: ${inputPath}`);
		} catch (error: unknown) {
			if (error instanceof MissingSessionCwdError) {
				const selectedCwd = await this.promptForMissingSessionCwd(error);
				if (!selectedCwd) {
					this.showStatus("Import cancelled");
					return;
				}
				const result = await this.runtimeHost.importFromJsonl(inputPath, selectedCwd);
				if (result.cancelled) {
					this.showStatus("Import cancelled");
					return;
				}
				this.showStatus(`Session imported from: ${inputPath}`);
				return;
			}
			if (error instanceof SessionImportFileNotFoundError) {
				this.showError(`Failed to import session: ${error.message}`);
				return;
			}
			await this.handleFatalRuntimeError("Failed to import session", error);
		}
	}

	/**
	 * Copy text with OSC 52 (reaches the terminal's clipboard, also over SSH) and the native clipboard path.
	 * Fails only when neither route is available.
	 */
	private async copyTextToClipboard(text: string): Promise<void> {
		const sequence = osc52Sequence(text);
		let sent = false;
		if (sequence) {
			try {
				this.ui.terminal.write(sequence);
				sent = true;
			} catch {
				sent = false;
			}
		}
		try {
			await copyToClipboard(text);
		} catch (error) {
			if (!sent) throw error;
		}
	}

	private confirmCopy(message: string, flash: boolean): void {
		if (flash && this.ui instanceof TuiAltScreen) this.ui.flash(message);
		else this.showStatus(message);
	}

	/** A click on a code block's "copy" label. */
	private copyCodeBlock(code: string): void {
		void this.copyTextToClipboard(code).then(
			() => this.confirmCopy(`Copied ${lineCountLabel(code)}`, true),
			(error: unknown) => this.showError(error instanceof Error ? error.message : String(error)),
		);
	}

	/** `/copy`, `/copy md`, `/copy code [n]`. */
	private async handleCopySubcommand(text: string): Promise<void> {
		const command = parseCopyCommand(text);
		if (command.kind === "error") {
			this.showWarning(command.message);
			return;
		}
		if (command.kind === "message") {
			await this.handleCopyCommand();
			return;
		}
		const message = this.session.getLastAssistantText();
		if (!message) {
			this.showError("No agent messages to copy yet.");
			return;
		}
		let copied = message;
		let label = `Copied last agent message as Markdown (${lineCountLabel(message)})`;
		if (command.kind === "code") {
			const blocks = extractCodeBlocks(message);
			const selected = selectCodeBlock(blocks, command.index);
			if ("error" in selected) {
				this.showWarning(selected.error);
				return;
			}
			copied = selected.block.code;
			label = `Copied code block ${selected.position} of ${blocks.length} (${lineCountLabel(copied)})`;
		}
		try {
			await this.copyTextToClipboard(copied);
			this.confirmCopy(label, false);
		} catch (error) {
			this.showError(error instanceof Error ? error.message : String(error));
		}
	}

	private async handleCopyCommand(
		options: { flashConfirmation?: boolean; preferSelection?: boolean } = {},
	): Promise<void> {
		if (
			options.preferSelection &&
			this.ui instanceof TuiAltScreen &&
			!this.ui.getCopyOnSelect() &&
			this.ui.hasActiveSelection()
		) {
			await this.ui.copyActiveSelectionToClipboard();
			return;
		}

		const text = this.session.getLastAssistantText();
		if (!text) {
			this.showError("No agent messages to copy yet.");
			return;
		}

		try {
			await copyToClipboard(text);
			if (options.flashConfirmation && this.ui instanceof TuiAltScreen) {
				this.ui.flash("Copied!");
			} else {
				this.showStatus("Copied last agent message to clipboard");
			}
		} catch (error) {
			this.showError(error instanceof Error ? error.message : String(error));
		}
	}

	private handleNameCommand(text: string): void {
		const name = text.replace(/^\/name\s*/, "").trim();
		if (!name) {
			const currentName = this.sessionManager.getSessionName();
			if (currentName) {
				this.chatContainer.addChild(new Spacer(1));
				this.chatContainer.addChild(new ThemedText(() => theme.fg("dim", `Session name: ${currentName}`), 1, 0));
			} else {
				this.showWarning("Usage: /name <name>");
			}
			this.ui.requestRender();
			return;
		}

		this.session.setSessionName(name);
		const sessionName = this.sessionManager.getSessionName();
		if (sessionName !== name) {
			this.showWarning(`Session name was normalized from ${JSON.stringify(name)} to ${JSON.stringify(sessionName)}`);
		}
		this.chatContainer.addChild(new Spacer(1));
		const displayName = sessionName ?? name;
		this.chatContainer.addChild(new ThemedText(() => theme.fg("dim", `Session name set: ${displayName}`), 1, 0));
		this.ui.requestRender();
	}

	private handleChangelogCommand(): void {
		const changelogPath = getChangelogPath();
		const allEntries = parseChangelog(changelogPath);

		const changelogMarkdown =
			allEntries.length > 0
				? allEntries
						.reverse()
						.map((e) => normalizeChangelogLinks(e.content, e))
						.join("\n\n")
				: "No changelog entries found.";

		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new DynamicBorder());
		this.chatContainer.addChild(new ThemedText(() => theme.bold(theme.fg("accent", "What's New")), 1, 0));
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Markdown(changelogMarkdown, 1, 1, this.getMarkdownThemeWithSettings()));
		this.chatContainer.addChild(new DynamicBorder());
		this.ui.requestRender();
	}

	/**
	 * Get capitalized display string for an app keybinding action.
	 */
	private getAppKeyDisplay(action: AppKeybinding): string {
		return keyDisplayText(action);
	}

	/**
	 * Get capitalized display string for an editor keybinding action.
	 */
	private getEditorKeyDisplay(action: Keybinding): string {
		return keyDisplayText(action);
	}

	/** Every keyboard shortcut as markdown, the second half of /help (what /hotkeys used to show). */
	private hotkeysMarkdown(): string {
		// Navigation keybindings
		const cursorUp = this.getEditorKeyDisplay("tui.editor.cursorUp");
		const cursorDown = this.getEditorKeyDisplay("tui.editor.cursorDown");
		const cursorLeft = this.getEditorKeyDisplay("tui.editor.cursorLeft");
		const cursorRight = this.getEditorKeyDisplay("tui.editor.cursorRight");
		const cursorWordLeft = this.getEditorKeyDisplay("tui.editor.cursorWordLeft");
		const cursorWordRight = this.getEditorKeyDisplay("tui.editor.cursorWordRight");
		const cursorLineStart = this.getEditorKeyDisplay("tui.editor.cursorLineStart");
		const cursorLineEnd = this.getEditorKeyDisplay("tui.editor.cursorLineEnd");
		const jumpForward = this.getEditorKeyDisplay("tui.editor.jumpForward");
		const jumpBackward = this.getEditorKeyDisplay("tui.editor.jumpBackward");
		const pageUp = this.getEditorKeyDisplay("tui.editor.pageUp");
		const pageDown = this.getEditorKeyDisplay("tui.editor.pageDown");

		// Editing keybindings
		const submit = this.getEditorKeyDisplay("tui.input.submit");
		const newLine = this.getEditorKeyDisplay("tui.input.newLine");
		const deleteWordBackward = this.getEditorKeyDisplay("tui.editor.deleteWordBackward");
		const deleteWordForward = this.getEditorKeyDisplay("tui.editor.deleteWordForward");
		const deleteToLineStart = this.getEditorKeyDisplay("tui.editor.deleteToLineStart");
		const deleteToLineEnd = this.getEditorKeyDisplay("tui.editor.deleteToLineEnd");
		const yank = this.getEditorKeyDisplay("tui.editor.yank");
		const yankPop = this.getEditorKeyDisplay("tui.editor.yankPop");
		const undo = this.getEditorKeyDisplay("tui.editor.undo");
		const tab = this.getEditorKeyDisplay("tui.input.tab");

		// App keybindings
		const interrupt = this.getAppKeyDisplay("app.interrupt");
		const clear = this.getAppKeyDisplay("app.clear");
		const exit = this.getAppKeyDisplay("app.exit");
		const suspend = this.getAppKeyDisplay("app.suspend");
		const cycleThinkingLevel = this.getAppKeyDisplay("app.thinking.cycle");
		const cyclePermissions = this.getAppKeyDisplay("app.permissions.cycle");
		const cycleModelForward = this.getAppKeyDisplay("app.model.cycleForward");
		const cycleRouterMode = this.getAppKeyDisplay("app.router.cycleMode");
		const selectModel = this.getAppKeyDisplay("app.model.select");
		const expandTools = this.getAppKeyDisplay("app.tools.expand");
		const toggleThinking = this.getAppKeyDisplay("app.thinking.toggle");
		const externalEditor = this.getAppKeyDisplay("app.editor.external");
		const cycleModelBackward = this.getAppKeyDisplay("app.model.cycleBackward");
		const copyMessage = this.getAppKeyDisplay("app.message.copy");
		const followUp = this.getAppKeyDisplay("app.message.followUp");
		const dequeue = this.getAppKeyDisplay("app.message.dequeue");
		const pasteImage = this.getAppKeyDisplay("app.clipboard.pasteImage");

		let hotkeys = `
**Navigation**
| Key | Action |
|-----|--------|
| \`${cursorUp}\` / \`${cursorDown}\` / \`${cursorLeft}\` / \`${cursorRight}\` | Move cursor / browse history |
| \`${cursorWordLeft}\` / \`${cursorWordRight}\` | Move by word |
| \`${cursorLineStart}\` | Start of line |
| \`${cursorLineEnd}\` | End of line |
| \`${jumpForward}\` | Jump forward to character |
| \`${jumpBackward}\` | Jump backward to character |
| \`${pageUp}\` / \`${pageDown}\` | Scroll by page |

**Editing**
| Key | Action |
|-----|--------|
| \`${submit}\` | Send message |
| \`${newLine}\` | New line${process.platform === "win32" ? " (Ctrl+Enter on Windows Terminal)" : ""} |
| \`${deleteWordBackward}\` | Delete word backwards |
| \`${deleteWordForward}\` | Delete word forwards |
| \`${deleteToLineStart}\` | Delete to start of line |
| \`${deleteToLineEnd}\` | Delete to end of line |
| \`${yank}\` | Paste the most-recently-deleted text |
| \`${yankPop}\` | Cycle through the deleted text after pasting |
| \`${undo}\` | Undo |

**Other**
| Key | Action |
|-----|--------|
| \`${tab}\` | Path completion / accept autocomplete |
| \`${interrupt}\` | Cancel autocomplete / abort streaming |
| \`${clear}\` | Clear editor (first) / exit (second) |
| \`${exit}\` | Exit (when editor is empty) |
| \`${suspend}\` | Suspend to background |
| \`${cycleThinkingLevel}\` | Cycle thinking level |
| \`${cyclePermissions}\` | Cycle permission mode (ask, read & write, plan, auto) |
| \`${cycleModelForward}\` / \`${cycleModelBackward}\` | Cycle models |
| \`${cycleRouterMode}\` | Cycle auto routing mode (auto:low → medium → high) |
| \`${selectModel}\` | Open model selector |
| \`${expandTools}\` | Toggle tool output expansion |
| \`${toggleThinking}\` | Toggle thinking block visibility |
| \`${externalEditor}\` | Edit message in external editor |
| \`${copyMessage}\` | Copy selection or last assistant message |
| \`${followUp}\` | Queue follow-up message |
| \`${dequeue}\` | Restore queued messages |
| \`${pasteImage}\` | Attach a clipboard image (a chip you can delete), or paste files or text |
| \`/\` | Slash commands (\`/help\` lists them) |
| \`@\` | Mention a file |
| \`!\` | Run bash command |
| \`!!\` | Run bash command (excluded from context) |
`;

		// Add extension-registered shortcuts
		const extensionRunner = this.session.extensionRunner;
		const shortcuts = extensionRunner.getShortcuts(this.keybindings.getEffectiveConfig());
		if (shortcuts.size > 0) {
			hotkeys += `
**Extensions**
| Key | Action |
|-----|--------|
`;
			for (const [key, shortcut] of shortcuts) {
				const description = shortcut.description ?? shortcut.extensionPath;
				const keyDisplay = formatKeyText(key, { capitalize: true });
				hotkeys += `| \`${keyDisplay}\` | ${description} |\n`;
			}
		}

		return hotkeys.trim();
	}

	private async handleClearCommand(): Promise<void> {
		this.clearStatusIndicator();
		try {
			const result = await this.runtimeHost.newSession();
			if (result.cancelled) {
				return;
			}
			this.chatContainer.addChild(new Spacer(1));
			this.chatContainer.addChild(new ThemedText(() => theme.fg("accent", "✓ New session started"), 1, 1));
			this.ui.requestRender();
		} catch (error: unknown) {
			await this.handleFatalRuntimeError("Failed to create session", error);
		}
	}

	private handleDebugCommand(): void {
		const width = this.ui.terminal.columns;
		const height = this.ui.terminal.rows;
		const allLines = this.ui.render(width);

		const debugLogPath = getDebugLogPath();
		const debugData = [
			`Debug output at ${new Date().toISOString()}`,
			`Terminal: ${width}x${height}`,
			`Total lines: ${allLines.length}`,
			"",
			"=== All rendered lines with visible widths ===",
			...allLines.map((line, idx) => {
				const vw = visibleWidth(line);
				const escaped = JSON.stringify(line);
				return `[${idx}] (w=${vw}) ${escaped}`;
			}),
			"",
			"=== Agent messages (JSONL) ===",
			...this.session.messages.map((msg) => JSON.stringify(msg)),
			"",
		].join("\n");

		fs.mkdirSync(path.dirname(debugLogPath), { recursive: true });
		fs.writeFileSync(debugLogPath, debugData);

		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(
			new ThemedText(() => `${theme.fg("accent", "✓ Debug log written")}\n${theme.fg("muted", debugLogPath)}`, 1, 1),
		);
		this.ui.requestRender();
	}

	private handleArminSaysHi(): void {
		if (playArmin3d(this.renderer)) return;
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new ArminComponent(this.ui));
		this.ui.requestRender();
	}

	private async handleBashCommand(command: string, excludeFromContext = false): Promise<void> {
		const extensionRunner = this.session.extensionRunner;

		// Emit user_bash event to let extensions intercept
		let eventResult: UserBashEventResult | undefined;
		try {
			eventResult = await extensionRunner.emitUserBash({
				type: "user_bash",
				command,
				excludeFromContext,
				cwd: this.sessionManager.getCwd(),
			});
		} catch {
			// The extension runner already reported the error. Do not fall back to local execution.
			return;
		}

		// If extension returned a full result, use it directly
		if (eventResult?.result) {
			const result = eventResult.result;

			// Create UI component for display
			this.bashComponent = new BashExecutionComponent(command, this.ui, excludeFromContext, this.outputPad);
			if (this.session.isStreaming) {
				this.pendingMessagesContainer.addChild(this.bashComponent);
				this.pendingBashComponents.push(this.bashComponent);
			} else {
				this.chatContainer.addChild(this.bashComponent);
			}

			// Show output and complete
			if (result.output) {
				this.bashComponent.appendOutput(result.output);
			}
			this.bashComponent.setComplete(
				result.exitCode,
				result.cancelled,
				result.truncated ? ({ truncated: true, content: result.output } as TruncationResult) : undefined,
				result.fullOutputPath,
			);

			// Record the result in session
			this.session.recordBashResult(command, result, { excludeFromContext });
			this.bashComponent = undefined;
			this.ui.requestRender();
			return;
		}

		// Normal execution path (possibly with custom operations)
		const isDeferred = this.session.isStreaming;
		this.bashComponent = new BashExecutionComponent(command, this.ui, excludeFromContext, this.outputPad);

		if (isDeferred) {
			// Show in pending area when agent is streaming
			this.pendingMessagesContainer.addChild(this.bashComponent);
			this.pendingBashComponents.push(this.bashComponent);
		} else {
			// Show in chat immediately when agent is idle
			this.chatContainer.addChild(this.bashComponent);
		}
		this.ui.requestRender();

		try {
			const result = await this.session.executeBash(
				command,
				(chunk) => {
					if (this.bashComponent) {
						this.bashComponent.appendOutput(chunk);
						this.ui.requestRender();
					}
				},
				{ excludeFromContext, operations: eventResult?.operations },
			);

			if (this.bashComponent) {
				this.bashComponent.setComplete(
					result.exitCode,
					result.cancelled,
					result.truncated ? ({ truncated: true, content: result.output } as TruncationResult) : undefined,
					result.fullOutputPath,
				);
			}
		} catch (error) {
			if (this.bashComponent) {
				this.bashComponent.setComplete(undefined, false);
			}
			this.showError(`Bash command failed: ${error instanceof Error ? error.message : "Unknown error"}`);
		}

		this.bashComponent = undefined;
		this.ui.requestRender();
	}

	private async handleCompactCommand(customInstructions?: string): Promise<void> {
		this.clearStatusIndicator();

		try {
			await this.session.compact(customInstructions);
		} catch {
			// Ignore, will be emitted as an event
		}
	}

	stop(fullscreenExitOutput = this.settingsManager.getFullscreenExitOutput()): void {
		this.disposeActiveSelector();
		if (this.settingsManager.getShowTerminalProgress()) {
			this.ui.terminal.setProgress(false);
		}
		this.clearStatusIndicator();
		this.themeController.disableAutoSync();
		this.clearExtensionTerminalInputListeners();
		this.footer.dispose();
		this.footerDataProvider.dispose();
		if (this.unsubscribe) {
			this.unsubscribe();
		}
		if (this.isInitialized) {
			this.stopInteractiveTui(fullscreenExitOutput);
			this.isInitialized = false;
		}
		this.terminalTitle.restore();
		this.unregisterSignalHandlers();
	}
}
