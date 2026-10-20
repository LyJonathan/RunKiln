<p align="center"><img src="https://raw.githubusercontent.com/LyJonathan/RunKiln/main/assets/rk.svg" alt="RunKiln" width="128"></p>

# @runkiln/coding-agent

The `runkiln` CLI: a lean coding agent for [RunInfra](https://runinfra.ai), with model routing built in.

## Install

Needs Node 22.19 or newer.

```bash
npm install -g @runkiln/coding-agent
```

## API key

Set `RUNINFRA_API_KEY`, or create `~/.runkiln/agent/runinfra.json`:

```json
{ "apiKey": "your-key", "baseUrl": "https://api.runinfra.ai/v1" }
```

## Use

Start RunKiln in the directory where you want it to work:

```bash
runkiln            # interactive
runkiln -p "..."   # print mode: one answer, then exit
runkiln --help     # all options and environment variables
```

On an interactive launch with no key, RunKiln opens the full-screen setup wizard. `runkiln setup` and `/setup wizard` run it again; `/setup` opens the setup hub (see [Change settings later](#change-settings-later)).

With the `auto` model, Alt+R cycles the routing mode `auto:low → auto:medium → auto:high` (it turns auto on from a manual model). Alt+M cycles the permission mode (`app.permissions.cycle`). Rebind the routing key as `app.router.cycleMode` in `~/.runkiln/agent/keybindings.json`.

### Images

Attach an image to the next prompt in any of these ways:

- **Ctrl+V** (Alt+V on Windows, where the terminal keeps Ctrl+V) reads an image from the system clipboard: `wl-paste` on Wayland (package `wl-clipboard`), `xclip` on X11, the Windows clipboard through PowerShell on WSL, the bundled helper on macOS and Windows (with `pngpaste` or AppleScript as a fallback on macOS, PowerShell on Windows). With no image on the clipboard, or no way to read it (a missing helper, or SSH with no display), RunKiln says so and what to install.
- **Drag an image file** into the terminal, or paste its path: terminals send a drop as a pasted path (quoted, `\`-escaped, `file://` and, on WSL, `C:\…` paths all work).
- **`@path`** to an image file in the prompt.

Each image shows in the editor as a chip like `[image 1 - 240 KB]`; delete the chip to drop the image. PNG, JPEG, GIF and WebP are sent as they are; BMP is converted to PNG; anything over 2 MB is resized (bundled, no extra tool needed) so the request stays under RunInfra's 3.5 MiB limit. Files over 30 MB are refused. Images go with the prompt as image content. With `auto`, an image turn is routed only to a model whose live `/models` entry lists `image` input (today GLM 5.3 Flash, Ornith 1.5 35B and Qwen3.8 27B). A manual model without image input gets a warning naming the models that take images, instead of silently seeing "(image omitted)".

### Usage and cost

`/usage` (old names `/cost` and `/stats` still work) opens the usage overlay: Overview, Models, Turns, Context and History tabs, with the costs RunInfra billed (`usage.cost`), cache hit rate, time to first token, and router classifier and permission judge spend. The footer shows `$0.0123 - 87% cached`. `runkiln usage [today|week|month|all] [--since 7d] [--json] [--rebuild]` totals spend across saved sessions from the ledger `~/.runkiln/agent/usage.jsonl` (`RUNKILN_USAGE_LEDGER=0` turns it off). Optional budgets: `"budget": { "session": 0.5, "daily": 2 }` in `settings.json` (USD; a warning at 80%, a confirmation before the next prompt at 100%, never a hard stop).

## Configuration

- Global config lives in `~/.runkiln/agent/` (`settings.json`, `runinfra.json`, sessions, skills, prompts, themes). Override it with `RUNKILN_CODING_AGENT_DIR`.
- Project config lives in `.runkiln/` inside the project and is only loaded after you trust the folder with `/trust`.
- Skills are also discovered from `.agents/skills`.

## Setup

Setup runs when you start an interactive session and neither `RUNINFRA_API_KEY` nor `apiKey` in `~/.runkiln/agent/runinfra.json` is set. `runkiln setup` and `/setup wizard` run it again any time. Print mode and RPC do not; they keep the missing-key error.

Setup is full screen: it switches to the terminal's alternate screen, keeps a centered column with a step indicator on top and the key hints on the bottom row, re-lays out when the window is resized (a compact indicator below 80 columns, a "make the terminal larger" notice below 44x14). The layout has fixed slots: blank lines never collapse, the status line is always reserved, and on a short window the body scrolls with "N more" markers instead of squeezing. Options, chips, fields and key hints are clickable, and gives the terminal back exactly as it was on finish, on quit, on Ctrl+C, or if the process is signalled. On `TERM=dumb`, or with `RUNKILN_SETUP_INLINE=1`, the same steps render inline instead. Without a terminal (`stdin` or `stdout` not a TTY) there is no setup screen: use `runkiln key set --stdin` or `RUNINFRA_API_KEY`.

Keys: arrows (or Tab / Shift+Tab) move, Enter confirms, Esc goes back one step, `q` (outside text fields) or Ctrl+C asks "Quit setup? Nothing has been saved." (`y` quits, a second Ctrl+C quits at once). **Nothing is written until Finish** on the review screen.

Each screen has one short line at most; only the focused choice shows a hint. Defaults are preselected, so Enter, Enter, Enter finishes. Steps that need no decision are left out, and the order follows what each choice depends on:

0. **Welcome.** The RK banner and Enter to start.
1. **Key.** If `RUNINFRA_API_KEY` is set, setup says "Using `RUNINFRA_API_KEY` from your environment.", checks it, and does not ask for one. Otherwise paste or type the key into a masked field (it shows `•` and a character count, never the key). A paste is checked as soon as it lands; Enter checks a typed key. Get a workspace key at [runinfra.ai/settings/api-keys](https://runinfra.ai/settings/api-keys). Setup checks the key with `GET {baseUrl}/models` and sends it only in the `Authorization` header, with a spinner while it waits. Success shows `✓ Key works - N models` and the key step stays on screen: Enter continues, and after 1.2 s without a key press it moves on by itself. Failure says what went wrong (`invalid key: …` for a wrong, revoked or expired key, a deactivated key, out of credits, rate limited with the `Retry-After` wait, a RunInfra 5xx, or no connection), never the response body or headers, and clears the field. On a rerun, Enter on the empty field keeps the saved key (checked live); a new key replaces it only when you finish, and the review says "replaces the saved key".

   A new key is written to `~/.runkiln/agent/runinfra.json` (the directory is created if needed). On macOS and Linux the file mode is `0600`. On Windows, setup tries to limit the file to the current user with `icacls`. The key is still written if that fails, and setup shows "Key saved, but RunKiln couldn't lock the file. Make `runinfra.json` readable only by you." The key is never written into the project directory, and an environment key is not copied into the file.

2. **Model.** **Auto** with its routing mode (`low`, `medium`, `high`; ←→ changes it; auto picks the thinking level per task), or **Manual**: one model from the `/models` response, in `models.yaml` order, without paused or unavailable models, with prices when the response has them, and its **thinking** level right below (`model default` removes `defaultThinkingLevel`, or `off` … `max`). Auto is preselected when a classifier key already works (saved, or `TYPESAFE_API_KEY` / `OPENROUTER_API_KEY`), otherwise Manual with the catalog default. Saved as `models.code` (`auto:<mode>` or the model id) and, for auto, `router.mode`.
3. **Classifier (only when needed).** Shown when you pick Auto, or Auto permissions, and no classifier key works yet. Pick **Jev (TypeSafe)**, **OpenRouter** (then a decision model from the live list at openrouter.ai, default `typesafe/jev-1.14`; only decision models, which answer with probabilities rather than text, are offered), or **Skip** (sets `router.classifier` to `off`; with Auto picked, the manual model is used). The key is checked live, sent only in the `Authorization` header: Jev with `GET https://api.typesafe.ai/v1/models`, OpenRouter with `GET https://openrouter.ai/api/v1/key` (which also shows the key's usage and remaining limit). Failures say what went wrong and never include the key or the response body. A typed key is written to `~/.runkiln/agent/router-keys.json` (`0600`; `icacls` on Windows, as above) and `router.classifier` (plus `router.openrouter.model`) is merged into `settings.json`. An environment key is never copied into the file. The review can always open this step, also to replace a working classifier ("Keep …" leaves it as it is).
4. **Permissions.** **Auto** (suggested when a Jev or OpenRouter key exists, the same rule as `/permissions`; without one, Enter on it opens the classifier step and comes back with Auto chosen), **Allow all**, **Read & write**, or **Ask everything**. Saved as `permissions.mode` (`auto`, `allow-all`, `read-write`, `ask`) in `settings.json`, the setting `/permissions` writes; it applies to the session setup runs in, and `--permissions` / `RUNKILN_PERMISSIONS` still override it at startup.
5. **Theme.** `system`, `dark` or `light`, previewed live as you move; quitting restores the previous one. Saved as `theme`.
6. **Review.** One line per choice. Pick a line and press Enter to reopen that step (Enter or Esc there comes straight back), or **Finish** (Enter on the button, or `f`).
7. **Done** (full screen). `✓ You're set` with the shortcuts to remember: Alt+R (routing mode), Alt+M (permission mode), `/help`. Enter starts.

Everything is merged into `~/.runkiln/agent/settings.json` (`0600`); other settings are left as they are. When setup finishes you are in the chat, without restarting. The closing lines are "You're set. Type a task or `/` to see commands.", `key saved` when a key was written, one `router: …` line, the model and the permission mode; they never include any part of a key. The agent session starts after that save, so the first turn uses what you picked.

### Change settings later

`/setup` opens the setup hub: one screen with six sections, as tabs (Tab / Shift+Tab, 1-6, or a click). `/setup <section>` and `runkiln setup <section>` open it on one section. A change is saved when you confirm it (Enter on a row, or a key that passes its live check); Esc closes the hub and drops anything highlighted but not confirmed. The layout is the wizard's.

| Section | What it does |
|---|---|
| `keys` | RunInfra, Jev and OpenRouter keys: where each comes from (environment or saved file), Set, Test, Remove. A key is saved only once it checks out. After a RunInfra check it shows the model count and the account's available credits (`GET {baseUrl}/credits`). `RUNINFRA_API_KEY`, `TYPESAFE_API_KEY` and `OPENROUTER_API_KEY` win over the saved keys, and the screen says so. |
| `model` | Default for new sessions: Auto with its mode, or a manual model and its thinking level. "Enabled models" opens the models screen (below) and "Ctrl+P cycle" the scoped models picker. |
| `routing` | Default auto mode (`low`, `medium`, `high`), the classifier (auto, Jev, OpenRouter, off) and the OpenRouter decision model. The session rebuilds its router when the hub closes. |
| `permissions` | Default permission mode (`permissions.mode`), the setting `/permissions` writes. |
| `look` | Theme, previewed as you move; Enter saves. |
| `footer` | Opens the footer items picker with a live preview (`footer.items`). |

Old names still work as hidden aliases and say the new name once per session: `/key`, `/login` and `/runinfra` open `/setup keys` (`/logout` opens it on removing the RunInfra key); `/models`, `/scoped-models` and `/statusline` still open their screens directly, which `/setup model` and `/setup footer` also reach.

From the shell:

```bash
runkiln setup                     # the full-screen setup wizard
runkiln setup keys                # the hub on one section (keys, model, routing, permissions, look, footer)
runkiln key                       # which keys are set and where they come from
runkiln key set                   # enter a RunInfra key in the hub, check it, save it
echo "$KEY" | runkiln key set --stdin                 # check and save without a TTY
runkiln key set jev               # a Jev key; also sets router.classifier
echo "$KEY" | runkiln key set openrouter --stdin --router-model openai/gpt-4.1-nano
runkiln key remove openrouter     # remove a saved key
runkiln key test                  # check every active key live
```

`runkiln login` and `runkiln logout` (with their old `--router` flag) still work and say the new name. None of these commands print a key.

### Models

The models screen (`/setup model`, then Enabled models) lists the RunInfra catalog with price (USD per 1M tokens in/out), context, vision, and the thinking levels each model supports. Space turns a model on or off, Enter makes it the default model (the code role), `t` / `T` cycles the default thinking level (used for manually picked models when you have not pinned one with `/thinking` and auto routing is off; it is clamped to the levels the model supports), `r` refetches. Changes save right away to `~/.runkiln/agent/settings.json`:

```json
{ "disabledModels": ["nemotron-3-5-lightning-30b"], "models": { "code": "glm-5-3-flash" }, "defaultThinkingLevel": "low" }
```

Disabled models are hidden from the model selector, Ctrl+P cycling, `/model`, and `--list-models`, and the `auto` router never picks them. The `auto:low`, `auto:medium` and `auto:high` entries always stay in the selector. The default model cannot be disabled, and at least one model stays on.

The catalog comes from `GET {baseUrl}/models` and is cached in `~/.runkiln/agent/cache/runinfra-models.json`. Offline (or with `--offline`), the models screen uses that cache, then the bundled `models.yaml`.

When a chat request fails with 401, 402, 403, or 429, RunKiln shows what to do (for example "Replace it in /setup keys") instead of a bug-report prompt.

See the [repository README](https://github.com/LyJonathan/RunKiln#readme) for models, approvals and development.

## Hooks, MCP servers and background jobs

### Hooks

Shell hooks use [Claude Code's format](https://code.claude.com/docs/en/hooks), under `hooks` in `~/.runkiln/agent/settings.json` or the project's `.runkiln/settings.json` / `.runkiln/settings.local.json` (with `"claudeHooks": true` in global settings, also `.claude/settings.json` and `.claude/settings.local.json`):

```json
{ "hooks": {
    "PreToolUse": [{ "matcher": "Bash", "hooks": [{ "type": "command", "command": "./scripts/guard.sh", "timeout": 10 }] }],
    "PostToolUse": [{ "matcher": "edit|write", "hooks": [{ "type": "command", "command": "npx biome format --write ." }] }],
    "Stop": [{ "hooks": [{ "type": "command", "command": "npm test --silent" }] }] } }
```

- Events: `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `Stop`, `Notification` (`permission_prompt`, `idle_prompt`), `SessionStart` (`startup`, `resume`, `clear`, `fork`), `PreCompact` (`manual`, `auto`).
- Matchers follow Claude Code: empty or `*` matches all, `Edit|Write` is an exact list, anything else is a regex. Tool matchers see RunKiln's name (`bash`, `edit`, `write`, `read`, `find`…) and Claude Code's (`Bash`, `Edit`, `Write`, `Read`, `Glob`…); MCP tools are `mcp__<server>__<tool>`. `if` takes a permission rule (`Bash(git *)`).
- The hook gets the event as JSON on stdin (`session_id`, `transcript_path`, `cwd`, `permission_mode`, `hook_event_name`, plus `tool_name` / `tool_input` / `tool_response`, `prompt`, `source`…; tool inputs also carry `file_path` next to `path`). `RUNKILN_PROJECT_DIR` and `CLAUDE_PROJECT_DIR` are set.
- Exit 2 blocks: the tool call does not run (stderr is the tool's error for the model), the prompt is not sent, `Stop` keeps the agent going with stderr as feedback (at most 5 times per run; `stop_hook_active` is set), `PreCompact` cancels compaction; `PostToolUse` adds stderr to the tool result. Other exit codes are non-blocking errors unless `onFailure: "block"`. JSON on stdout is read like Claude Code: `decision`/`reason`, `hookSpecificOutput.permissionDecision` (`deny`, `ask`), `updatedInput`, `additionalContext`, `systemMessage`, `continue: false`. Default timeout 600 s (30 s for `UserPromptSubmit`).
- `additionalContext` (and plain stdout of `UserPromptSubmit` / `SessionStart`) reaches the model as a hidden message, never the system prompt, so the cached prefix does not change.
- `PreToolUse` runs after the permission gate: it can deny or ask about a call, but it cannot approve one the gate would ask about.
- Project hooks are commands from the repository: they run only after a one-time confirmation of exactly those commands (asked at startup, or `/hooks trust`); a changed command asks again. `disableAllHooks: true` turns all hooks off. `/hooks` lists them.

### MCP servers

`.mcp.json` in the project (or `.runkiln/mcp.json`) and `mcpServers` in global settings, in Claude Code's format, with `${VAR}` and `${VAR:-default}` expanded in `command`, `args`, `env`, `url` and `headers`:

```json
{ "mcpServers": {
    "docs": { "command": "npx", "args": ["-y", "docs-mcp"], "env": { "TOKEN": "${DOCS_TOKEN}" } },
    "api": { "type": "http", "url": "${API_URL:-https://api.example.com}/mcp", "headers": { "Authorization": "Bearer ${API_KEY}" } } } }
```

Transports: stdio, streamable HTTP (`http`, `streamable-http`; falls back to SSE when the server refuses), and SSE. Servers start in the background. Their tools are **not** added to the tool list: the model sees one `mcp` tool (`search`, then `call`), so the prompt stays small and its cached prefix stays the same while servers connect. `"mcp": { "pinned": ["docs"] }` (or `"alwaysLoad": true` on a server) declares a server's tools directly instead; `"disabled"` keeps a server off. Each call passes the permission gate under its own name, so rules like `mcp__docs__*` apply and plan mode blocks it. Project servers start only after you approve them. `/mcp` shows servers, status and tools; `/mcp reconnect <server|all>`, `/mcp tools <server>`, `/mcp trust`.

### Background jobs

`bash` takes `background: true` for dev servers and watchers: it returns a job id at once, and `bash_output` reads new output (`filter` regex, `wait` seconds) or stops the job (`kill: true`). A command that looks long-running (`npm run dev`, `vite`, `--watch`…) and is still running after 20 s moves to the background on its own instead of holding the turn (`backgroundJobs.autoBackgroundSeconds`, 0 turns it off). Each job keeps its last 256 KB of output. Running jobs show in the footer and in `/jobs` (`/jobs <id>` shows recent output, `/jobs kill <id|all>`). Jobs stop when the session ends or RunKiln exits. Background commands go through the same permissions as any bash call (plan mode blocks them).

## License

MIT. See [LICENSE](LICENSE).
