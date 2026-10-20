import { ModelThinkingLevelSchema } from "@runkiln/ai/providers/model-schema";
import { type Static, type TSchemaOptions, Type } from "typebox";
import { SETTINGS_DEFAULTS } from "./settings-defaults.ts";

function nonNegativeSafeInteger(options: { default?: number; description?: string } = {}) {
	return Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER, ...options });
}

function timeoutSetting(options?: TSchemaOptions) {
	return Type.Union([Type.Number({ minimum: 0 }), Type.Literal("disabled")], options);
}

const CompactionModelOverrideSchema = Type.Object({
	reserveTokens: Type.Optional(nonNegativeSafeInteger()),
	keepRecentTokens: Type.Optional(nonNegativeSafeInteger()),
});

const CompactionSettingsSchema = Type.Object({
	enabled: Type.Optional(Type.Boolean({ default: SETTINGS_DEFAULTS.compaction.enabled })),
	reserveTokens: Type.Optional(nonNegativeSafeInteger({ default: SETTINGS_DEFAULTS.compaction.reserveTokens })),
	keepRecentTokens: Type.Optional(nonNegativeSafeInteger({ default: SETTINGS_DEFAULTS.compaction.keepRecentTokens })),
	triggerTokens: Type.Optional(
		Type.Union([nonNegativeSafeInteger(), Type.Literal("auto")], {
			default: "auto",
			description:
				'Context size that triggers auto-compaction. "auto" picks the cost-optimal point for the model (at least 192k tokens, never past the window minus reserveTokens); a number pins it.',
		}),
	),
	reuseSessionPrefix: Type.Optional(
		Type.Boolean({
			default: SETTINGS_DEFAULTS.compaction.reuseSessionPrefix,
			description:
				"Generate the compaction summary on the session's own warm prompt prefix (RunInfra cache hit) instead of a standalone request on the side-task model.",
		}),
	),
	idleCompact: Type.Optional(
		Type.Boolean({
			default: SETTINGS_DEFAULTS.compaction.idleCompact,
			description:
				"Compact before the next turn when the session sat idle longer than the model's cache TTL (RunInfra session idle TTL, about 900 s) and the context is at least idleMinTokens: that turn pays the full uncached price anyway.",
		}),
	),
	idleMinTokens: Type.Optional(
		nonNegativeSafeInteger({
			default: SETTINGS_DEFAULTS.compaction.idleMinTokens,
			description: "Smallest context (tokens) that idle compaction compacts.",
		}),
	),
	modelOverrides: Type.Optional(
		Type.Record(Type.String(), CompactionModelOverrideSchema, {
			description: 'Per-model overrides keyed by exact "provider/modelId" strings.',
		}),
	),
});

const BranchSummarySettingsSchema = Type.Object({
	reserveTokens: Type.Optional(
		Type.Number({
			description: "Tokens reserved for the prompt and LLM response.",
			default: SETTINGS_DEFAULTS.branchSummary.reserveTokens,
		}),
	),
	skipPrompt: Type.Optional(
		Type.Boolean({
			description: 'When true, skips the "Summarize branch?" prompt and defaults to no summary.',
			default: SETTINGS_DEFAULTS.branchSummary.skipPrompt,
		}),
	),
});

const ProviderRetrySettingsSchema = Type.Object({
	timeoutMs: Type.Optional(Type.Number({ description: "SDK or provider request timeout in milliseconds." })),
	maxRetries: Type.Optional(Type.Number({ description: "SDK or provider retry attempts." })),
	maxRetryDelayMs: Type.Optional(
		Type.Number({
			description: "Maximum server-requested delay before failing.",
			default: SETTINGS_DEFAULTS.retry.provider.maxRetryDelayMs,
		}),
	),
});

const RetrySettingsSchema = Type.Object({
	enabled: Type.Optional(Type.Boolean({ default: SETTINGS_DEFAULTS.retry.enabled })),
	maxRetries: Type.Optional(Type.Number({ default: SETTINGS_DEFAULTS.retry.maxRetries })),
	baseDelayMs: Type.Optional(
		Type.Number({
			description: "Exponential backoff base delay in milliseconds: 2s, 4s, 8s.",
			default: SETTINGS_DEFAULTS.retry.baseDelayMs,
		}),
	),
	maxAgentDelayMs: Type.Optional(Type.Number({ default: SETTINGS_DEFAULTS.retry.maxAgentDelayMs })),
	provider: Type.Optional(ProviderRetrySettingsSchema),
	maxDelayMs: Type.Optional(
		Type.Number({
			description: "Legacy retry delay setting. Use provider.maxRetryDelayMs instead.",
			deprecated: true,
		}),
	),
});

const FailoverSettingsSchema = Type.Object({
	enabled: Type.Optional(
		Type.Boolean({
			description:
				"Auto mode: when the routed model keeps failing (5xx, 429, overloaded, timeout, connection reset, stall), switch to another RunInfra model at an equivalent thinking level for the rest of the turn. A model picked manually is only retried.",
			default: SETTINGS_DEFAULTS.failover.enabled,
		}),
	),
	retries: Type.Optional(
		Type.Number({
			description:
				"Auto mode: retries on the same model (jittered backoff) before switching. Capped by retry.maxRetries.",
			default: SETTINGS_DEFAULTS.failover.retries,
		}),
	),
	stallTimeoutSec: Type.Optional(
		Type.Number({
			description:
				"Abort a request that has streamed no token (text, thinking or tool call) after this many seconds, and treat it as a retryable error. 0 turns the stall check off.",
			default: SETTINGS_DEFAULTS.failover.stallTimeoutSec,
		}),
	),
	cooldownSec: Type.Optional(
		Type.Number({
			description:
				"Seconds a failed model is avoided by the router and by side tasks. Default: router.yaml failed_model_cooldown_sec (300).",
		}),
	),
});

const RepoMapSettingsSchema = Type.Object({
	enabled: Type.Optional(
		Type.Boolean({
			description:
				"The repo_map tool: a ranked, token-budgeted map of the repository's files and key symbols (tree-sitter, cached on disk by git HEAD and mtimes). /map shows it. The map is never put in the system prompt, so the cached prefix does not change with the repo.",
			default: SETTINGS_DEFAULTS.repoMap.enabled,
		}),
	),
	firstTurnTokens: Type.Optional(
		Type.Number({
			description:
				"Token budget of a static repo map appended once to the first user turn of a session (0: off). It stays in the conversation, so later requests keep the same cached prefix.",
			default: SETTINGS_DEFAULTS.repoMap.firstTurnTokens,
		}),
	),
	tokens: Type.Optional(
		Type.Number({
			description: "Default token budget of the repo_map tool and /map (64-8192).",
			default: SETTINGS_DEFAULTS.repoMap.tokens,
		}),
	),
});

const TodoSettingsSchema = Type.Object({
	enabled: Type.Optional(
		Type.Boolean({
			description:
				"The todo tool: the agent keeps a checklist for multi-step work, shown above the editor and saved in the session.",
			default: SETTINGS_DEFAULTS.todo.enabled,
		}),
	),
	nudge: Type.Optional(
		Type.Boolean({
			description: "When a run ends with unfinished todo items, remind the agent once (hidden message).",
			default: SETTINGS_DEFAULTS.todo.nudge,
		}),
	),
});

const GitSettingsSchema = Type.Object({
	autoCommit: Type.Optional(
		Type.Union([Type.Literal("off"), Type.Literal("turn")], {
			description:
				'"turn": after each turn that changed files, commit those files with a message from the chore model (plus the git.coAuthor trailer when set). "off" (default): RunKiln never commits unless you run /commit.',
			default: SETTINGS_DEFAULTS.git.autoCommit,
		}),
	),
	coAuthor: Type.Optional(
		Type.String({
			description:
				'"Name <email>": add a "Co-authored-by: Name <email>" trailer to commits made by /commit and git.autoCommit. Empty (default): no trailer.',
			default: SETTINGS_DEFAULTS.git.coAuthor,
		}),
	),
});

const FooterSettingsSchema = Type.Object(
	{
		items: Type.Optional(
			Type.Array(Type.String(), {
				description:
					'Footer items in order: model, router, thinking, permissions, cost, cache, context, tests, jobs, todo, branch, cwd, session, time, turn, queue; "break" starts a new line. Unset: the default layout. Edit with /statusline.',
			}),
		),
		show: Type.Optional(
			Type.Record(Type.String(), Type.Boolean(), {
				description:
					"Footer parts on and off: cwd, branch, session, permissions, cost, cache, context, autoCompact, tests, xp, todo, queue, time, provider, router, model, thinking, decision, confidence, turn, statuses. Unset parts keep their default (todo, queue and time off; turn follows display.turnSummary). With footer.items, only false hides an item. Edit in /settings > Footer.",
			}),
		),
	},
	{ description: "Footer (status line) layout." },
);

const UiSettingsSchema = Type.Object(
	{
		hints: Type.Optional(
			Type.Boolean({
				description:
					"Show a dim key-hint line under the editor with the keys that matter right now (hidden on terminals shorter than 20 rows).",
				default: SETTINGS_DEFAULTS.ui.hints,
			}),
		),
		reducedMotion: Type.Optional(
			Type.Boolean({
				description: "No spinners or animations: static indicators instead.",
				default: SETTINGS_DEFAULTS.ui.reducedMotion,
			}),
		),
		maxProseWidth: Type.Optional(
			Type.Number({
				minimum: 0,
				description:
					"Wrap assistant prose at this many columns on wide terminals; code blocks and tables keep the full width. 0: no cap.",
				default: SETTINGS_DEFAULTS.ui.maxProseWidth,
			}),
		),
	},
	{ description: "Accessibility and readability. NO_COLOR in the environment turns colors off." },
);

const TerminalSettingsSchema = Type.Object({
	showImages: Type.Optional(
		Type.Boolean({
			description: "Show images when the terminal supports them.",
			default: SETTINGS_DEFAULTS.terminal.showImages,
		}),
	),
	imageWidthCells: Type.Optional(
		Type.Number({
			description: "Preferred inline image width in terminal cells.",
			default: SETTINGS_DEFAULTS.terminal.imageWidthCells,
		}),
	),
	clearOnShrink: Type.Optional(
		Type.Boolean({
			description: "Clear empty rows when content shrinks.",
			default: SETTINGS_DEFAULTS.terminal.clearOnShrink,
		}),
	),
	showTerminalProgress: Type.Optional(
		Type.Boolean({
			description: "Show OSC 9;4 terminal progress indicators.",
			default: SETTINGS_DEFAULTS.terminal.showTerminalProgress,
		}),
	),
	dynamicTitle: Type.Optional(
		Type.Boolean({
			description:
				'Set the terminal title to "RunKiln - <project> - ● working | ✓ done | ⚠ needs approval" (restored on exit; tmux pane titles too). false: a static title.',
			default: SETTINGS_DEFAULTS.terminal.dynamicTitle,
		}),
	),
	hyperlinks: Type.Optional(Type.Union([Type.Boolean(), Type.Literal("auto")])),
	images: Type.Optional(
		Type.Union([Type.Literal("kitty"), Type.Literal("iterm2"), Type.Literal("auto"), Type.Literal(false)]),
	),
	trueColor: Type.Optional(Type.Union([Type.Boolean(), Type.Literal("auto")])),
	fullRepaint: Type.Optional(
		Type.Boolean({
			description:
				"Fullscreen: rewrite every row on every frame. Fixes stale fragments on some ConPTY hosts (Windows Terminal, older conhost). RUNKILN_FULL_REPAINT=1 turns it on too.",
			default: SETTINGS_DEFAULTS.terminal.fullRepaint,
		}),
	),
	pointerShape: Type.Optional(
		Type.Union([Type.Literal("auto"), Type.Literal("on"), Type.Literal("off")], {
			description:
				'Pointer shape (OSC 22) over clickable things. "auto": on in kitty, Ghostty, foot, WezTerm, iTerm2 and xterm, off under tmux and elsewhere.',
			default: SETTINGS_DEFAULTS.terminal.pointerShape,
		}),
	),
});

const ImageSettingsSchema = Type.Object({
	autoResize: Type.Optional(
		Type.Boolean({
			description: "Resize images to 2000x2000 maximum for better model compatibility.",
			default: SETTINGS_DEFAULTS.images.autoResize,
		}),
	),
	blockImages: Type.Optional(
		Type.Boolean({
			description: "When true, prevents all images from being sent to LLM providers.",
			default: SETTINGS_DEFAULTS.images.blockImages,
		}),
	),
});

function thinkingBudgetsSettings(options?: TSchemaOptions) {
	return Type.Object(
		{
			minimal: Type.Optional(Type.Number()),
			low: Type.Optional(Type.Number()),
			medium: Type.Optional(Type.Number()),
			high: Type.Optional(Type.Number()),
		},
		options,
	);
}

const ThinkingBudgetsSettingsSchema = thinkingBudgetsSettings();

const MarkdownSettingsSchema = Type.Object({
	codeBlockIndent: Type.Optional(Type.String({ default: SETTINGS_DEFAULTS.markdown.codeBlockIndent })),
	mermaid: Type.Optional(
		Type.Union([Type.Literal("off"), Type.Literal("final"), Type.Literal("streaming")], {
			default: SETTINGS_DEFAULTS.markdown.mermaid,
		}),
	),
});

const DisplaySettingsSchema = Type.Object({
	editDiffs: Type.Optional(
		Type.Union([Type.Literal("full"), Type.Literal("collapsed"), Type.Literal("summary")], {
			description:
				'How edit cards show their diff until expanded: "full" diff, "collapsed" (header with +/− counts and the first few lines), or "summary" (header only). Click a card or press the tool expand key to see the rest.',
			default: SETTINGS_DEFAULTS.display.editDiffs,
		}),
	),
	diff: Type.Optional(
		Type.Union([Type.Literal("unified"), Type.Literal("split"), Type.Literal("auto")], {
			description:
				'Diff layout: "unified", "split" (side by side), or "auto" (split when the terminal is ≥ 140 columns).',
			default: SETTINGS_DEFAULTS.display.diff,
		}),
	),
	diffSyntax: Type.Optional(
		Type.Boolean({
			description: "Syntax-highlight code inside diffs.",
			default: SETTINGS_DEFAULTS.display.diffSyntax,
		}),
	),
	groupReads: Type.Optional(
		Type.Boolean({
			description: "Fold consecutive read, grep, find and ls calls into one expandable line.",
			default: SETTINGS_DEFAULTS.display.groupReads,
		}),
	),
	turnSummary: Type.Optional(
		Type.Union([Type.Literal("reply"), Type.Literal("footer"), Type.Literal("off"), Type.Boolean()], {
			description:
				'Per-turn summary (time, files changed, tools, cost, model): "reply" writes one dim line after each reply, "footer" shows the last turn as a footer row instead, "off" hides it. true and false still mean "reply" and "off".',
			default: SETTINGS_DEFAULTS.display.turnSummary,
		}),
	),
	turnSummaryFields: Type.Optional(
		Type.Object(
			{
				time: Type.Optional(Type.Boolean({ description: "How long the turn took.", default: true })),
				files: Type.Optional(
					Type.Boolean({ description: "Files changed, lines added and removed.", default: true }),
				),
				tools: Type.Optional(Type.Boolean({ description: "Tool calls (and failed ones).", default: true })),
				cost: Type.Optional(Type.Boolean({ description: "Cost of the turn.", default: true })),
				model: Type.Optional(
					Type.Boolean({ description: "Model and thinking level the turn ran on.", default: true }),
				),
				clock: Type.Optional(Type.Boolean({ description: "Time of day the turn ended (HH:MM).", default: false })),
			},
			{ description: "Which parts the turn summary shows. The status mark is always shown." },
		),
	),
	toolOutput: Type.Optional(
		Type.Union([Type.Literal("collapsed"), Type.Literal("expanded")], {
			description:
				"Tool output at startup: collapsed cards or expanded output. The tool expand key still toggles it for the session.",
			default: SETTINGS_DEFAULTS.display.toolOutput,
		}),
	),
	changesTray: Type.Optional(
		Type.Boolean({
			description: "Show the files the agent changed this session in a row above the editor.",
			default: SETTINGS_DEFAULTS.display.changesTray,
		}),
	),
	changesTrayPosition: Type.Optional(
		Type.Union([Type.Literal("editor"), Type.Literal("footer")], {
			description:
				'Where the changes tray sits: "editor" (the row above the editor) or "footer" (under the editor, above the footer).',
			default: SETTINGS_DEFAULTS.display.changesTrayPosition,
		}),
	),
	timestamps: Type.Optional(
		Type.Union([Type.Literal("off"), Type.Literal("time"), Type.Literal("datetime")], {
			description:
				'A dim timestamp under each user message and assistant reply: "off", "time" (14:32) or "datetime" (2026-10-17 14:32), in the TZ zone or the OS zone.',
			default: SETTINGS_DEFAULTS.display.timestamps,
		}),
	),
	diffOpens: Type.Optional(
		Type.Union([Type.Literal("review"), Type.Literal("git")], {
			description:
				'What /diff opens: "review" (the review view of this session\'s changes, the git panel when there are none) or "git" (the uncommitted changes panel). /diff git and /diff review open either one.',
			default: SETTINGS_DEFAULTS.display.diffOpens,
		}),
	),
});

const WarningSettingsSchema = Type.Object({
	anthropicExtraUsage: Type.Optional(Type.Boolean({ default: SETTINGS_DEFAULTS.warnings.anthropicExtraUsage })),
});

function codemodeMode(options?: TSchemaOptions) {
	return Type.Union([Type.Literal("on"), Type.Literal("only")], options);
}

const CodemodeModeSchema = codemodeMode();

const CodemodeSettingsSchema = Type.Object({
	mode: Type.Optional(
		codemodeMode({
			description:
				'How codemode presents tools. "on" keeps direct tools declared and annotates tools callable from scripts; codemode lists only tools without direct exposure. "only" lists every script-callable tool in codemode and does not declare active direct tools.',
			default: SETTINGS_DEFAULTS.codemode.mode,
		}),
	),
	inlineBudget: Type.Optional(
		Type.Number({
			minimum: 0,
			description: "Estimated tokens available for inline codemode tool declarations.",
			default: SETTINGS_DEFAULTS.codemode.inlineBudget,
		}),
	),
});

const StringArraySchema = Type.Array(Type.String());
const SkillsInputSchema = Type.Union(
	[
		StringArraySchema,
		Type.Object(
			{
				enableSkillCommands: Type.Optional(Type.Boolean()),
				customDirectories: Type.Optional(StringArraySchema),
			},
			{ deprecated: true },
		),
	],
	{ description: "Local skill file paths or directories." },
);

const RouterBackendSettingsSchema = Type.Object({
	model: Type.Optional(Type.String({ description: "Classifier model: a Jev model name (default jev-latest)." })),
	baseUrl: Type.Optional(Type.String({ description: "API base URL (https; http only for localhost)." })),
});

const RouterOpenRouterSettingsSchema = Type.Object({
	model: Type.Optional(
		Type.String({
			description:
				'OpenRouter decision model for routing and auto permissions (output modality "decisions", called through /api/v1/systemone), such as typesafe/jev-1.14 (default). Chat models are not accepted; a saved one is moved to the default at startup. The list: https://openrouter.ai/models?output_modalities=decisions',
		}),
	),
	baseUrl: Type.Optional(Type.String({ description: "API base URL (https; http only for localhost)." })),
});

const RouterSettingsSchema = Type.Object(
	{
		classifier: Type.Optional(
			Type.Union([Type.Literal("auto"), Type.Literal("jev"), Type.Literal("openrouter"), Type.Literal("off")], {
				description:
					'Classifier for the "auto" model. "auto" uses Jev when a Jev key is available (TYPESAFE_API_KEY or router-keys.json), else OpenRouter when an OpenRouter key is.',
				default: "auto",
			}),
		),
		mode: Type.Optional(
			Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")], {
				description:
					'Routing mode for "auto": low (cost-efficient), medium (balanced, leans toward quality), high (deepest model and thinking).',
				default: "medium",
			}),
		),
		jev: Type.Optional(RouterBackendSettingsSchema),
		openrouter: Type.Optional(RouterOpenRouterSettingsSchema),
		timeoutMs: Type.Optional(
			Type.Number({ minimum: 100, description: "Classifier timeout in milliseconds.", default: 4000 }),
		),
		fallbackModel: Type.Optional(
			Type.String({ description: "Model used when the classifier fails before any routing decision exists." }),
		),
		sessionModel: Type.Optional(
			Type.Boolean({
				description:
					"Route only the session's first request and keep that model and thinking level for the rest of the session (one model per session, like Amp). Failover still switches when the model fails. Default false: every request is routed.",
				default: false,
			}),
		),
		cacheTtlSec: Type.Optional(
			Type.Number({
				minimum: 0,
				description: "Seconds a classifier answer is reused for the same request.",
				default: 600,
			}),
		),
	},
	{
		description:
			'Model router ("auto" model). Global setting only: it decides where prompts are sent. Keys come from TYPESAFE_API_KEY / OPENROUTER_API_KEY, else ~/.runkiln/agent/router-keys.json (/key, runkiln login --router).',
	},
);

export const SettingsSchema = Type.Object(
	{
		$schema: Type.Optional(Type.String({ description: "JSON Schema reference." })),
		lastChangelogVersion: Type.Optional(Type.String()),
		defaultProvider: Type.Optional(Type.String()),
		models: Type.Optional(
			Type.Object(
				{
					code: Type.Optional(Type.String({ description: "Model for coding sessions." })),
					chat: Type.Optional(Type.String({ description: "Model for chat sessions (--chat)." })),
					title: Type.Optional(Type.String({ description: "Model for background session titles." })),
					fallback: Type.Optional(
						Type.Array(Type.String(), {
							description:
								"Models tried in order when a role model is unavailable, and when a request fails before the session has a reply.",
						}),
					),
				},
				{
					description:
						"RunKiln model roles, as model ids from models.yaml. Unset roles use the models.yaml defaults.",
				},
			),
		),
		router: Type.Optional(RouterSettingsSchema),
		hooks: Type.Optional(
			Type.Record(Type.String(), Type.Array(Type.Unknown()), {
				description:
					'Shell hooks in Claude Code\'s format: { "PreToolUse": [{ "matcher": "bash|edit", "hooks": [{ "type": "command", "command": "./check.sh", "timeout": 30 }] }] }. Events: PreToolUse, PostToolUse, UserPromptSubmit, Stop, Notification, SessionStart, PreCompact. Project hooks (.runkiln/settings.json) run only after a one-time confirmation. /hooks lists them.',
			}),
		),
		disableAllHooks: Type.Optional(Type.Boolean({ description: "Global: turn every hook off." })),
		claudeHooks: Type.Optional(
			Type.Boolean({
				description:
					"Global: also read hooks from the project's .claude/settings.json and .claude/settings.local.json.",
			}),
		),
		mcpServers: Type.Optional(
			Type.Record(Type.String(), Type.Unknown(), {
				description:
					'Global MCP servers in Claude Code\'s format (projects use .mcp.json): { "docs": { "command": "npx", "args": ["-y", "docs-mcp"] }, "api": { "type": "http", "url": "${API_URL}/mcp", "headers": { "Authorization": "Bearer ${API_KEY}" } } }. ${VAR} and ${VAR:-default} are expanded. /mcp lists servers and tools.',
			}),
		),
		mcp: Type.Optional(
			Type.Object(
				{
					pinned: Type.Optional(
						Type.Array(Type.String(), {
							description:
								"Servers whose tools are declared to the model directly. Others are reached through the mcp tool (search, then call), which keeps the prompt small and cached.",
						}),
					),
					disabled: Type.Optional(Type.Array(Type.String(), { description: "Servers not to start." })),
					connectTimeoutMs: Type.Optional(Type.Number({ description: "Default 30000." })),
					toolTimeoutMs: Type.Optional(
						Type.Number({ description: "Default 120000; a server's own timeout wins." }),
					),
				},
				{ description: "MCP options." },
			),
		),
		backgroundJobs: Type.Optional(
			Type.Object(
				{
					autoBackgroundSeconds: Type.Optional(
						Type.Number({
							description:
								"Seconds a command that looks long-running (npm run dev, vite, --watch) may hold the turn before it moves to the background. 0 turns it off. Default 20.",
						}),
					),
				},
				{ description: "Background shell jobs (bash background: true, bash_output, /jobs)." },
			),
		),
		permissions: Type.Optional(
			Type.Object(
				{
					mode: Type.Optional(
						Type.Union(
							[
								Type.Literal("ask"),
								Type.Literal("read-write"),
								Type.Literal("plan"),
								Type.Literal("auto"),
								Type.Literal("allow-all"),
							],
							{
								description:
									'Default permission mode: "ask" (every read, write and command asks), "read-write" (reads and in-project edits run, commands ask), "plan" (read-only: research and propose a plan; writes, edits and commands are blocked until you approve it), "auto" (a Jev or OpenRouter decision model judges each call; risky calls always ask), "allow-all" (nothing asks). --permissions and RUNKILN_PERMISSIONS override it.',
								default: "read-write",
							},
						),
					),
					allow: Type.Optional(
						Type.Array(Type.String(), {
							description:
								'Rules that run without asking, e.g. "Bash(npm test:*)", "Edit(src/**)", "Read", "mcp__docs__search". Global settings only; never lifts plan mode or approves a risky call.',
						}),
					),
					ask: Type.Optional(
						Type.Array(Type.String(), {
							description:
								'Rules that always ask (except in allow-all), e.g. "Bash(git push:*)", "Edit(migrations/**)".',
						}),
					),
					deny: Type.Optional(
						Type.Array(Type.String(), {
							description:
								'Rules that never run, in every mode including allow-all, e.g. "Bash(rm -rf:*)", "Read(.env)", "mcp__prod__*".',
						}),
					),
					promptTimeoutSec: Type.Optional(
						Type.Number({
							minimum: 0,
							description:
								"Seconds an approval prompt waits for an answer. 0 (the default) waits indefinitely; then timeoutAction applies.",
							default: 0,
						}),
					),
					readsOutsideProject: Type.Optional(
						Type.Union([Type.Literal("ask"), Type.Literal("allow")], {
							description:
								'Whether read, grep, find and ls of a path outside the project ask ("ask", the default) or run ("allow"). Loaded skills and RunKiln\'s own output files are always readable. Global settings only.',
							default: "ask",
						}),
					),
					timeoutAction: Type.Optional(
						Type.Union([Type.Literal("deny"), Type.Literal("pause")], {
							description:
								'What an approval prompt does when promptTimeoutSec runs out: "deny" (the default) denies the call; "pause" keeps the prompt open, waiting for you, and sends a notification.',
							default: "deny",
						}),
					),
					projects: Type.Optional(
						Type.Record(
							Type.String(),
							Type.Object({
								allow: Type.Optional(Type.Array(Type.String())),
								ask: Type.Optional(Type.Array(Type.String())),
								deny: Type.Optional(Type.Array(Type.String())),
							}),
							{
								description:
									'Rules for one project, keyed by its folder ("always allow in this project" writes here). Global settings only.',
							},
						),
					),
				},
				{
					description:
						"Tool permissions. The mode, allow rules and per-project rules are read from global settings only. A project's .runkiln/settings.json may add ask and deny rules (it can only tighten, never loosen). Change them with /permissions and /permissions rules.",
				},
			),
		),
		defaultModel: Type.Optional(Type.String()),
		defaultThinkingLevel: Type.Optional(ModelThinkingLevelSchema),
		modelThinkingLevels: Type.Optional(
			Type.Record(Type.String(), ModelThinkingLevelSchema, {
				description: 'Per-model default thinking level overrides keyed by "provider/modelId".',
			}),
		),
		transport: Type.Optional(
			Type.Union(
				[Type.Literal("auto"), Type.Literal("sse"), Type.Literal("websocket"), Type.Literal("websocket-cached")],
				{ default: SETTINGS_DEFAULTS.transport },
			),
		),
		sessionShareDestination: Type.Optional(
			Type.Union([Type.Literal("auto"), Type.Literal("gist"), Type.Literal("radius")], {
				description:
					'Destination used by /share. "auto" uses Radius when authenticated and otherwise creates a GitHub gist.',
				default: SETTINGS_DEFAULTS.sessionShareDestination,
			}),
		),
		steeringMode: Type.Optional(
			Type.Union([Type.Literal("all"), Type.Literal("one-at-a-time")], {
				default: SETTINGS_DEFAULTS.steeringMode,
			}),
		),
		followUpMode: Type.Optional(
			Type.Union([Type.Literal("all"), Type.Literal("one-at-a-time")], {
				default: SETTINGS_DEFAULTS.followUpMode,
			}),
		),
		theme: Type.Optional(Type.String()),
		compaction: Type.Optional(CompactionSettingsSchema),
		branchSummary: Type.Optional(BranchSummarySettingsSchema),
		retry: Type.Optional(RetrySettingsSchema),
		failover: Type.Optional(FailoverSettingsSchema),
		todo: Type.Optional(TodoSettingsSchema),
		notifications: Type.Optional(
			Type.Union([Type.Literal("auto"), Type.Literal("bell"), Type.Literal("off")], {
				description:
					'Notify when a turn ends or an approval or plan is waiting while the terminal is unfocused. "auto": a desktop notification (OSC 9 / OSC 777) where the terminal supports it, else the bell; "bell": the bell only; "off": never. Without focus reporting, only turns longer than 30 s notify.',
				default: SETTINGS_DEFAULTS.notifications,
			}),
		),
		git: Type.Optional(GitSettingsSchema),
		repoMap: Type.Optional(RepoMapSettingsSchema),
		budget: Type.Optional(
			Type.Object(
				{
					session: Type.Optional(
						Type.Number({
							exclusiveMinimum: 0,
							description: "USD per session. RunKiln warns at 80% and asks before the next prompt at 100%.",
						}),
					),
					daily: Type.Optional(
						Type.Number({
							exclusiveMinimum: 0,
							description:
								"USD per local day across all sessions (the usage ledger). Warns at 80%, asks at 100%.",
						}),
					),
				},
				{ description: "Optional spend budgets, shown in the footer and in /usage. Asks, never hard-stops." },
			),
		),
		choreModel: Type.Optional(
			Type.String({
				description:
					'Model for side tasks (session titles, compaction and branch summaries): "<model>" or "<model>:<thinking>", e.g. "glm-5-3-flash:low". "session" uses the session model and thinking level. Global setting only. When the model is disabled or unhealthy, glm-5-3-flash:low is used, then the session model.',
				default: SETTINGS_DEFAULTS.choreModel,
			}),
		),
		hideThinkingBlock: Type.Optional(Type.Boolean({ default: SETTINGS_DEFAULTS.hideThinkingBlock })),
		showCacheMissNotices: Type.Optional(
			Type.Boolean({
				description: "Show cache cost and provider recovery notices.",
				default: SETTINGS_DEFAULTS.showCacheMissNotices,
			}),
		),
		externalEditor: Type.Optional(
			Type.String({ description: "Command for Ctrl+G external editor; takes precedence over VISUAL and EDITOR." }),
		),
		shellPath: Type.Optional(
			Type.String({
				description: "Custom shell path, for example for Cygwin on Windows, with support for leading ~ expansion.",
			}),
		),
		quietStartup: Type.Optional(
			Type.Union([Type.Boolean(), Type.Literal("header")], {
				description: 'When true, hide all startup output. When "header", keep only the startup header.',
				default: SETTINGS_DEFAULTS.quietStartup,
			}),
		),
		defaultProjectTrust: Type.Optional(
			Type.Union([Type.Literal("ask"), Type.Literal("always"), Type.Literal("never")], {
				description: "Global setting only.",
				default: SETTINGS_DEFAULTS.defaultProjectTrust,
			}),
		),
		shellEnvironment: Type.Optional(
			Type.Object(
				{
					inherit: Type.Optional(
						Type.Union([Type.Literal("all"), Type.Literal("core")], {
							description:
								'"all" (the default) passes the environment on; "core" passes only PATH, HOME, LANG and similar.',
						}),
					),
					hideSecrets: Type.Optional(
						Type.Boolean({
							default: true,
							description: "Hide variables named like *KEY*, *SECRET*, *TOKEN*, *PASSWORD*, *CREDENTIAL*.",
						}),
					),
					exclude: Type.Optional(
						Type.Array(Type.String(), {
							description: "More names to hide (case-insensitive globs, e.g. AWS_*).",
						}),
					),
					include: Type.Optional(
						Type.Array(Type.String(), {
							description:
								"Names to pass on anyway (case-insensitive globs, e.g. GITHUB_TOKEN). RunKiln's own keys are never passed.",
						}),
					),
				},
				{
					description:
						"Which environment variables shell commands and hooks get. MCP servers get only core variables and their own env. Global settings only.",
				},
			),
		),
		shellCommandPrefix: Type.Optional(
			Type.String({ description: "Prefix prepended to every bash command, for example to enable shell aliases." }),
		),
		npmCommand: Type.Optional(
			Type.Array(Type.String(), {
				description:
					'Command used for npm package lookup and installation, in argv form such as ["mise", "exec", "node@20", "--", "npm"].',
			}),
		),
		collapseChangelog: Type.Optional(
			Type.Boolean({
				description: "Show the condensed changelog after update; use /changelog for the full changelog.",
				default: SETTINGS_DEFAULTS.collapseChangelog,
			}),
		),
		deviceId: Type.Optional(
			Type.String({
				description: "Stable installation UUID, generated when authentication first needs it. Global only.",
			}),
		),
		skills: Type.Optional(SkillsInputSchema),
		prompts: Type.Optional(
			Type.Array(Type.String(), { description: "Local prompt template file paths or directories." }),
		),
		enableSkillCommands: Type.Optional(
			Type.Boolean({
				description: "Register skills as /skill:name commands.",
				default: SETTINGS_DEFAULTS.enableSkillCommands,
			}),
		),
		terminal: Type.Optional(TerminalSettingsSchema),
		footer: Type.Optional(FooterSettingsSchema),
		ui: Type.Optional(UiSettingsSchema),
		images: Type.Optional(ImageSettingsSchema),
		enabledModels: Type.Optional(
			Type.Array(Type.String(), {
				description: "Model patterns for cycling, in the same format as the --models CLI flag.",
			}),
		),
		disabledModels: Type.Optional(
			Type.Array(Type.String(), {
				description:
					"RunInfra model ids hidden from the model selector, cycling, and automatic model routing. Edit with /setup model.",
			}),
		),
		defaultTools: Type.Optional(
			Type.Array(Type.String(), {
				description:
					"Initial tool selection. Plain names replace the inherited selection; +name and -name entries add or remove tools.",
			}),
		),
		doubleEscapeAction: Type.Optional(
			Type.Union([Type.Literal("fork"), Type.Literal("tree"), Type.Literal("rewind"), Type.Literal("none")], {
				description: "Action for double-escape with an empty editor (rewind opens /rewind, as in Claude Code).",
				default: SETTINGS_DEFAULTS.doubleEscapeAction,
			}),
		),
		treeFilterMode: Type.Optional(
			Type.Union(
				[
					Type.Literal("default"),
					Type.Literal("no-tools"),
					Type.Literal("user-only"),
					Type.Literal("labeled-only"),
					Type.Literal("all"),
				],
				{
					description: "Default filter when opening /tree.",
					default: SETTINGS_DEFAULTS.treeFilterMode,
				},
			),
		),
		thinkingBudgets: Type.Optional(
			thinkingBudgetsSettings({
				description: "Custom token budgets for thinking levels.",
			}),
		),
		editorPaddingX: Type.Optional(
			Type.Number({
				description: "Horizontal padding for the input editor.",
				default: SETTINGS_DEFAULTS.editorPaddingX,
			}),
		),
		outputPad: Type.Optional(
			Type.Union([Type.Literal(0), Type.Literal(1)], {
				description: "Horizontal padding for transcript content.",
				default: SETTINGS_DEFAULTS.outputPad,
			}),
		),
		autocompleteMaxVisible: Type.Optional(
			Type.Number({
				description: "Maximum visible items in the autocomplete dropdown.",
				default: SETTINGS_DEFAULTS.autocompleteMaxVisible,
			}),
		),
		showHardwareCursor: Type.Optional(
			Type.Boolean({ description: "Show the terminal cursor while still positioning it for IME." }),
		),
		markdown: Type.Optional(MarkdownSettingsSchema),
		display: Type.Optional(DisplaySettingsSchema),
		warnings: Type.Optional(WarningSettingsSchema),
		codemode: Type.Optional(CodemodeSettingsSchema),
		sessionDir: Type.Optional(
			Type.String({
				description: "Custom session storage directory, in the same format as the --session-dir CLI flag.",
			}),
		),
		httpProxy: Type.Optional(
			Type.String({
				description: "Proxy URL applied as HTTP_PROXY and HTTPS_PROXY for RunKiln-managed HTTP clients.",
			}),
		),
		httpIdleTimeoutMs: Type.Optional(
			timeoutSetting({
				description: 'HTTP header or body idle timeout in milliseconds; 0 or "disabled" disables it.',
			}),
		),
		checks: Type.Optional(
			Type.Union([
				Type.Boolean(),
				Type.Object({
					enabled: Type.Optional(
						Type.Boolean({
							default: SETTINGS_DEFAULTS.checks.enabled,
							description: "Check each file after edit/write and report the diagnostics the edit introduced.",
						}),
					),
					autoDetect: Type.Optional(
						Type.Boolean({
							default: SETTINGS_DEFAULTS.checks.autoDetect,
							description:
								"Use installed checkers: biome or eslint, tsc (while fast), ruff or a Python syntax check, gofmt and go vet, cargo check, node --check, shellcheck.",
						}),
					),
					timeoutMs: Type.Optional(
						Type.Integer({ minimum: 500, maximum: 60000, default: SETTINGS_DEFAULTS.checks.timeoutMs }),
					),
					commands: Type.Optional(
						Type.Record(Type.String(), Type.String(), {
							description:
								'Check commands per glob, e.g. {"*.py": "mypy {file}"}. {file} is the edited file (appended when missing). They pass the permission gate.',
						}),
					),
				}),
			]),
		),
		verify: Type.Optional(
			Type.Object({
				mode: Type.Optional(
					Type.Union([Type.Literal("off"), Type.Literal("ask"), Type.Literal("auto")], {
						default: SETTINGS_DEFAULTS.verify.mode,
						description:
							'Run the tests when a turn that changed files ends and send failures back to the model. "ask" offers it after the first file-changing turn.',
					}),
				),
				command: Type.Optional(Type.String({ description: "Test command (default: detected)." })),
				maxRetries: Type.Optional(
					Type.Integer({ minimum: 0, maximum: 5, default: SETTINGS_DEFAULTS.verify.maxRetries }),
				),
				timeoutMs: Type.Optional(
					Type.Integer({ minimum: 1000, maximum: 1_800_000, default: SETTINGS_DEFAULTS.verify.timeoutMs }),
				),
				projects: Type.Optional(
					Type.Record(
						Type.String(),
						Type.Object({
							command: Type.Optional(Type.String()),
							decision: Type.Union([Type.Literal("always"), Type.Literal("never")]),
						}),
						{ description: "Saved per-project choices (global settings), keyed by project folder." },
					),
				),
			}),
		),
		edit: Type.Optional(
			Type.Object({
				autoRepair: Type.Optional(
					Type.Boolean({
						default: SETTINGS_DEFAULTS.edit.autoRepair,
						description:
							"When an edit's oldText is not found but one spot is at least 90% similar, let the chore model rewrite oldText to match it (verified unique before applying).",
					}),
				),
			}),
		),
		cacheWarming: Type.Optional(
			Type.Union([Type.Literal("off"), Type.Literal("streaming"), Type.Literal("idle")], {
				description:
					'Cache-warming profile. "idle" also warms between agent runs. Global only because each refresh costs money.',
				default: SETTINGS_DEFAULTS.cacheWarming,
			}),
		),
		websocketConnectTimeoutMs: Type.Optional(
			timeoutSetting({
				description: 'WebSocket connect or open handshake timeout in milliseconds; 0 or "disabled" disables it.',
			}),
		),
		tuiMode: Type.Optional(
			Type.Union([Type.Literal("regular"), Type.Literal("fullscreen")], {
				default: SETTINGS_DEFAULTS.tuiMode,
			}),
		),
		fullscreenExitOutput: Type.Optional(
			Type.Union([Type.Literal("transcript"), Type.Literal("resume-hint")], {
				description: "No effect in regular TUI mode.",
				default: SETTINGS_DEFAULTS.fullscreenExitOutput,
			}),
		),
		fullscreenScrollbar: Type.Optional(
			Type.Union([Type.Literal("auto"), Type.Literal("always"), Type.Literal("hidden")], {
				description: "No effect in regular TUI mode.",
				default: SETTINGS_DEFAULTS.fullscreenScrollbar,
			}),
		),
		fullscreenCopyOnSelect: Type.Optional(
			Type.Boolean({
				description: "No effect in regular TUI mode.",
				default: SETTINGS_DEFAULTS.fullscreenCopyOnSelect,
			}),
		),
		fullscreenWheelScrollLines: Type.Optional(
			Type.Union([Type.Number(), Type.Literal("auto")], {
				description: "Lines scrolled per wheel event in fullscreen mode; numeric values are clamped from 1 to 100.",
				default: SETTINGS_DEFAULTS.fullscreenWheelScrollLines,
			}),
		),
		mouse: Type.Optional(
			Type.Union([Type.Literal("on"), Type.Literal("wheel"), Type.Literal("off")], {
				description:
					'Fullscreen mouse capture. "on": clicks, hover, selection and wheel. "wheel": wheel scrolling only. "off": no capture, the terminal keeps its own selection. RUNKILN_MOUSE=on|wheel|off overrides it.',
				default: SETTINGS_DEFAULTS.mouse,
			}),
		),
		mouseRightClick: Type.Optional(
			Type.Union([Type.Literal("auto"), Type.Literal("menu"), Type.Literal("paste")], {
				description:
					'Right click in fullscreen. "menu": card action menu. "paste": paste the clipboard. "auto": paste on Windows (outside VS Code), menu elsewhere.',
				default: SETTINGS_DEFAULTS.mouseRightClick,
			}),
		),
		cardActions: Type.Optional(
			Type.Boolean({
				description: "Show an action strip (open, diff, copy, rerun, menu) on tool cards under the pointer.",
				default: SETTINGS_DEFAULTS.cardActions,
			}),
		),
		editor: Type.Optional(
			Type.Object({
				open: Type.Optional(
					Type.String({
						description:
							'How clicked file paths open: "auto" (the editor RunKiln runs in, else $VISUAL/$EDITOR, else the default app), "system", "vscode", "cursor", "zed", "nvim", "idea", "subl", "editor" ($VISUAL/$EDITOR), or a template with {file}, {line} and {col}, e.g. "code -g {file}:{line}:{col}". Over SSH the path is copied instead.',
						default: SETTINGS_DEFAULTS.editor.open,
					}),
				),
			}),
		),
		queueMode: Type.Optional(
			Type.Union([Type.Literal("all"), Type.Literal("one-at-a-time")], {
				description: "Legacy setting migrated to steeringMode.",
				deprecated: true,
			}),
		),
		websockets: Type.Optional(
			Type.Boolean({ description: "Legacy setting migrated to transport.", deprecated: true }),
		),
	},
	{ additionalProperties: true },
);

type SettingsInput = Static<typeof SettingsSchema>;

export interface RouterSettingsInput extends Static<typeof RouterSettingsSchema> {}
export interface CompactionModelOverride extends Static<typeof CompactionModelOverrideSchema> {}
export interface CompactionSettings extends Static<typeof CompactionSettingsSchema> {}
export interface BranchSummarySettings extends Static<typeof BranchSummarySettingsSchema> {}
export interface ProviderRetrySettings extends Static<typeof ProviderRetrySettingsSchema> {}
export interface FailoverSettings extends Static<typeof FailoverSettingsSchema> {}
export interface RetrySettings extends Omit<Static<typeof RetrySettingsSchema>, "maxDelayMs"> {}
export interface TerminalSettings extends Static<typeof TerminalSettingsSchema> {}
export interface FooterSettings extends Static<typeof FooterSettingsSchema> {}
export interface UiSettings extends Static<typeof UiSettingsSchema> {}
export interface ImageSettings extends Static<typeof ImageSettingsSchema> {}
export interface ThinkingBudgetsSettings extends Static<typeof ThinkingBudgetsSettingsSchema> {}
export type MermaidRenderingMode = NonNullable<Static<typeof MarkdownSettingsSchema>["mermaid"]>;
export interface MarkdownSettings extends Static<typeof MarkdownSettingsSchema> {}
export interface DisplaySettings extends Static<typeof DisplaySettingsSchema> {}
export interface WarningSettings extends Static<typeof WarningSettingsSchema> {}
export type CodemodeMode = Static<typeof CodemodeModeSchema>;
export interface CodemodeSettings extends Static<typeof CodemodeSettingsSchema> {}
export type DefaultProjectTrust = NonNullable<SettingsInput["defaultProjectTrust"]>;
export type QuietStartup = NonNullable<SettingsInput["quietStartup"]>;
export type TransportSetting = NonNullable<SettingsInput["transport"]>;
export type SessionShareDestination = NonNullable<SettingsInput["sessionShareDestination"]>;
export type FullscreenExitOutput = NonNullable<SettingsInput["fullscreenExitOutput"]>;
export type TuiMode = NonNullable<SettingsInput["tuiMode"]>;
export type CacheWarmingMode = NonNullable<SettingsInput["cacheWarming"]>;
export interface Settings extends Omit<SettingsInput, "queueMode" | "retry" | "skills" | "websockets"> {
	retry?: RetrySettings;
	skills?: string[];
}
