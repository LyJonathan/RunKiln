import { DEFAULT_MAX_AGENT_RETRY_DELAY_MS } from "@runkiln/ai/utils/retry";

/** Runtime defaults shared by settings accessors and the published JSON Schema. */
export const SETTINGS_DEFAULTS = {
	transport: "auto",
	sessionShareDestination: "auto",
	steeringMode: "one-at-a-time",
	followUpMode: "one-at-a-time",
	compaction: {
		enabled: true,
		reserveTokens: 16384,
		keepRecentTokens: 20000,
		/** "auto": cost-optimal point for the model (see compactionTriggerTokens); a number pins it. */
		triggerTokens: "auto" as number | "auto",
		/** Summarize on the session's warm RunInfra prefix (cached input) when it is still cached. */
		reuseSessionPrefix: true,
		/** Compact before the next turn when the session sat idle past the cache TTL (that turn pays full price). */
		idleCompact: true,
		/** Only for contexts at least this large. */
		idleMinTokens: 40000,
	},
	branchSummary: {
		reserveTokens: 16384,
		skipPrompt: false,
	},
	retry: {
		enabled: true,
		maxRetries: 3,
		baseDelayMs: 2000,
		maxAgentDelayMs: DEFAULT_MAX_AGENT_RETRY_DELAY_MS,
		provider: {
			maxRetryDelayMs: 60000,
		},
	},
	failover: {
		enabled: true,
		retries: 2,
		stallTimeoutSec: 90,
	},
	choreModel: "deepseek-v4-1-flash-1017:off",
	// Workflow: todo tool, notifications, git helpers.
	todo: {
		enabled: true,
		nudge: true,
	},
	notifications: "auto",
	git: {
		autoCommit: "off",
		// "Name <email>" for a Co-authored-by trailer on RunKiln commits; empty: no trailer.
		coAuthor: "",
	},
	repoMap: {
		// The repo_map tool (ranked map of files and key symbols). Never part of the system prompt.
		enabled: false,
		// A static map appended once to the first user turn (0: off).
		firstTurnTokens: 0,
		tokens: 1024,
	},
	hideThinkingBlock: false,
	showCacheMissNotices: false,
	quietStartup: false,
	defaultProjectTrust: "ask",
	collapseChangelog: false,
	enableSkillCommands: true,
	terminal: {
		showImages: true,
		imageWidthCells: 60,
		clearOnShrink: false,
		showTerminalProgress: false,
		// Terminal title "RunKiln - <project> - ● working / ✓ done / ⚠ needs approval".
		dynamicTitle: true,
		fullRepaint: false,
		pointerShape: "auto" as "auto" | "on" | "off",
	},
	ui: {
		// No spinners or animations: static indicators instead.
		reducedMotion: false,
		// Wrap assistant prose at this many columns on wide terminals (code blocks and tables keep the full width). 0: off.
		maxProseWidth: 100,
		// The dim key-hint line under the editor.
		hints: true,
	},
	images: {
		autoResize: true,
		blockImages: false,
	},
	doubleEscapeAction: "tree",
	treeFilterMode: "default",
	editorPaddingX: 0,
	outputPad: 1,
	autocompleteMaxVisible: 5,
	markdown: {
		codeBlockIndent: "  ",
		mermaid: "streaming",
	},
	display: {
		editDiffs: "collapsed" as "full" | "collapsed" | "summary",
		diff: "auto" as "unified" | "split" | "auto",
		diffSyntax: true,
		groupReads: true,
		turnSummary: "reply" as "reply" | "footer" | "off",
		turnSummaryFields: { time: true, files: true, tools: true, cost: true, model: true, clock: false },
		toolOutput: "collapsed" as "collapsed" | "expanded",
		changesTray: true,
		changesTrayPosition: "editor" as "editor" | "footer",
		diffOpens: "review" as "review" | "git",
		timestamps: "off" as "off" | "time" | "datetime",
	},
	warnings: {
		anthropicExtraUsage: true,
	},
	codemode: {
		mode: "on",
		inlineBudget: 3000,
	},
	cacheWarming: "streaming",
	checks: {
		enabled: true,
		autoDetect: true,
		timeoutMs: 4000,
	},
	verify: {
		mode: "ask" as "off" | "ask" | "auto",
		maxRetries: 2,
		timeoutMs: 180000,
	},
	edit: {
		autoRepair: false,
	},
	tuiMode: "fullscreen",
	fullscreenExitOutput: "transcript",
	fullscreenScrollbar: "auto",
	fullscreenCopyOnSelect: true,
	fullscreenWheelScrollLines: "auto",
	mouse: "on" as "on" | "wheel" | "off",
	mouseRightClick: "auto" as "auto" | "menu" | "paste",
	cardActions: true,
	editor: {
		open: "auto",
	},
} as const;
