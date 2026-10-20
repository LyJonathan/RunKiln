<p align="center"><img src="assets/rk.svg" alt="RunKiln" width="160"></p>

# RunKiln

A lean coding agent for [RunInfra](https://runinfra.ai), with model routing built in. It works only with RunInfra.

> **Fork of [Pi](https://github.com/earendil-works/pi)** (formerly `badlogic/pi-mono`) by Mario Zechner, MIT licensed. RunKiln keeps Pi's agent loop, terminal UI and core tools, and changes:
>
> - **Router:** an `auto` model that picks the model and thinking level for each turn, with failover.
> - **RunInfra only:** Pi's other providers are removed; models come from `models.yaml` and RunInfra's live catalog, and costs are what RunInfra billed.
> - **Permissions:** modes, rules, approval prompts, plan mode and an auto-permission judge.
> - **Agent features:** repo map, post-edit checks, a verify loop, `/review`, `/commit`, worktrees.
> - **Usage:** a `/usage` overlay, a spend ledger and budgets; a setup wizard; a smaller system prompt.
>
> See [NOTICE.md](NOTICE.md) for the upstream commit and Pi's license.

## Install

Windows, Linux and macOS. Two ways:

**npm** (needs Node 22.19 or newer):

```bash
npm install -g @runkiln/coding-agent   # puts `runkiln` on your PATH
```

On Windows npm adds `runkiln.cmd` and `runkiln.ps1` shims, so it works from cmd, PowerShell and Git Bash.

**Standalone binary** (no Node needed): download the file for your platform from the [latest release](https://github.com/LyJonathan/RunKiln/releases/latest) and put it on your PATH.

| Platform | File |
|---|---|
| Windows x64 | `runkiln-win-x64.exe` |
| Linux x64 | `runkiln-linux-x64` |
| Linux arm64 | `runkiln-linux-arm64` |
| macOS Apple silicon | `runkiln-darwin-arm64` |
| macOS Intel | `runkiln-darwin-x64` |

```bash
# Linux / macOS
curl -fLo runkiln https://github.com/LyJonathan/RunKiln/releases/latest/download/runkiln-linux-x64
chmod +x runkiln && sudo mv runkiln /usr/local/bin/
```

```powershell
# Windows (PowerShell)
New-Item -ItemType Directory -Force "$env:LOCALAPPDATA\Programs\runkiln" | Out-Null
Invoke-WebRequest https://github.com/LyJonathan/RunKiln/releases/latest/download/runkiln-win-x64.exe -OutFile "$env:LOCALAPPDATA\Programs\runkiln\runkiln.exe"
# then add that folder to your user PATH
```

- Each binary is about 120 MB: Node 22 with RunKiln inside. The first run unpacks RunKiln (about 30 MB) to `%LOCALAPPDATA%\runkiln\bin` on Windows, `~/Library/Caches/runkiln/bin` on macOS or `~/.cache/runkiln/bin` on Linux (`RUNKILN_BINARY_CACHE` overrides it); later runs start from there. Old versions are removed after 14 days unused.
- `SHA256SUMS` in the release lists the checksums.
- The binaries are not code-signed: Windows SmartScreen may ask before the first run, and the macOS ones are only signed ad hoc (downloaded with a browser, clear the quarantine flag with `xattr -d com.apple.quarantine runkiln`).
- To update, download the new release.

**Windows notes.** The `bash` tool uses Git Bash (Git for Windows, machine or per-user install, Scoop, or the Git that owns `git.exe` on PATH), then MSYS2 or Cygwin bash on PATH, then WSL. With no bash at all, the `powershell` tool replaces it in the default tools. `shellPath` in `settings.json` picks a shell yourself. Settings live in `%USERPROFILE%\.runkiln\agent` (`~/.runkiln/agent` elsewhere; `RUNKILN_CODING_AGENT_DIR` overrides it). ripgrep and fd are downloaded for x64 and arm64 when they are not on PATH.

Or from source:

```bash
git clone https://github.com/LyJonathan/RunKiln.git
cd RunKiln
npm install && npm run build
npm link -w @runkiln/coding-agent   # puts `runkiln` on your PATH
```

## API key

Set `RUNINFRA_API_KEY`, or create `~/.runkiln/agent/runinfra.json`:

```json
{ "apiKey": "your-key", "baseUrl": "https://api.runinfra.ai/v1" }
```

- Both fields are optional. `baseUrl` defaults to `https://api.runinfra.ai/v1`.
- If `RUNINFRA_API_KEY` is set, it overrides `apiKey`.
- `baseUrl` must use https. Plain http is allowed only for localhost.
- Run `chmod 600 ~/.runkiln/agent/runinfra.json` so only you can read the file.
- The key is never loaded from the project folder, and it's removed from the environment of shell commands the agent runs.

Or let RunKiln do it: an interactive launch with no key opens the setup wizard, `/setup keys` (or `runkiln key set`) checks a key live and saves it with mode `0600`, and `echo "$KEY" | runkiln key set --stdin` works without a terminal. Details in the [package README](packages/coding-agent/README.md#setup).

## Use

```bash
runkiln            # interactive
runkiln -p "..."   # print mode: one answer, then exit
```

## Models

| Job | Default |
|---|---|
| Code | GLM 5.3 Flash (`glm-5-3-flash`) |
| Chat | DeepSeek V4.1 Flash 1017 (`deepseek-v4-1-flash-1017`) |
| Side tasks: session titles, compaction and branch summaries | DeepSeek V4.1 Flash 1017, thinking off (`choreModel`) |

- To change the defaults, set `models.code`, `models.chat`, `models.title` and `models.fallback` in `~/.runkiln/agent/settings.json`.
- `deepseek-v4-1-flash-1017` replaced `deepseek-v4-1-flash` on 2026-10-17 (same or better pass rate on the benches, cached input $0.01/M instead of $0.03). The old id is an alias in `models.yaml`: settings, `--model` and saved sessions that name it get the new model.
- Side tasks use `choreModel` (global setting, default `"deepseek-v4-1-flash-1017:off"`; `"<model>:<thinking>"`, or `"session"` for the session model). When it is disabled, paused or cooling down after failures, they use `glm-5-3-flash` at `low`, then the session model; a summary whose call fails moves to the next one. `models.title`, when set, still picks the title model.
- A model you pick yourself is only retried (jittered backoff, `retry.*`), never switched, and RunKiln says so; a `models.fallback` list you set yourself is still tried before the session's first successful reply. The `auto` model switches per turn on purpose and fails over (below).
- `models.yaml` can't hold URLs, endpoints, hosts, headers, keys, tokens or secrets, and it can't name any provider other than RunInfra.

### Thinking levels

Models that accept more than one reasoning effort get thinking levels mapped to their own effort names (GLM: low/high/max; DeepSeek: off/low/high/xhigh/max; Qwen: off/low/medium/xhigh). Ornith and Nemotron accept one effort and keep it. With no choice made, each model keeps its `harness_effort` from `models.yaml`. Pick one with `/thinking`, Shift+Tab, or `--thinking <level>`.

## Auto model (router)

`auto` sits next to the real models in `/model`, Ctrl+P cycling, `--model auto` and RPC `set_model`. With it, a router picks the model **and** the thinking level for each turn. Pick any concrete model at any time to override it (`/router off` keeps the current one).

The router needs a classifier key: Jev (TypeSafe) or OpenRouter. Set one up in `runkiln setup` (the classifier step, shown only when needed), in `/setup keys`, or with `runkiln key set jev|openrouter [--stdin]`; it is saved to `~/.runkiln/agent/router-keys.json` (`0600`). `TYPESAFE_API_KEY` / `OPENROUTER_API_KEY` always win over the saved keys.

```bash
TYPESAFE_API_KEY=...   runkiln --model auto          # Jev classifier (TypeSafe), medium mode
OPENROUTER_API_KEY=... runkiln --model auto:low      # decision model on OpenRouter, low mode
runkiln --model auto --router-mode high --router-classifier jev --router-model jev-latest
```

### Modes

`auto` comes in three modes, each shown as its own entry (`auto:low`, `auto:medium`, `auto:high`) in `/model` and Ctrl+P cycling. Plain `auto` means the configured mode (`router.mode`, default `medium`).

| Mode | What it does |
|---|---|
| `low` | Cost-efficient: lower skill bars, the cheapest capable model, thinking one step lighter and hard-capped at `low` (`max_thinking`). Escalation may move to a stronger model, never to a deeper level. |
| `medium` | Balanced (default): cost-aware, leans toward quality, thinking capped at `xhigh` unless no level up to it clears the bar on a model. |
| `high` | Deepest: higher skill bars, the strongest model at its deepest allowed level (up to `max`), no stickiness. Trivial turns (greetings, acks, one-line lookups) take the cheapest model instead, with thinking floored at `low` (`min_thinking`), never `off`. |

Switch with Alt+R (cycles `auto:low → auto:medium → auto:high`, and turns auto on from a manual model), `/router low|medium|high`, `--router-mode <low|medium|high>`, `--model auto:<mode>`, or `router.mode` in settings. Mode overrides live under `modes` in `router.yaml` and only replace the keys they list.

Alt+R is the `app.router.cycleMode` keybinding (Alt+M cycles the permission mode, see [Permissions](#permissions)); rebind it in `~/.runkiln/agent/keybindings.json` like any other (`{ "app.router.cycleMode": "ctrl+alt+o" }`, or `[]` to turn it off). On macOS terminals, Alt combinations need Option to send Meta (Terminal: "Use Option as Meta key"; iTerm2: Option as "Esc+").

Per-mode thinking policy in `router.yaml` (`null` clears a bound):

```yaml
modes:
  low:
    max_thinking: low     # hard cap on the level the router sends (escalation included)
  high:
    min_thinking: low     # hard floor, trivial turns included
    trivial_below: 0.2    # turn difficulty (no momentum) below this = trivial: cheapest feasible model; 0 = off
```

Both bounds apply only to levels the router picks: a level you pin (`/thinking <level>`, Shift+Tab) is sent as is. Triviality is judged on the turn's own classifier difficulty plus this turn's failure boosts, without momentum, so a "thanks" after a hard task stays cheap while a failing tool loop stops being trivial.

### How it works

Router v3 (the default; `selection: quality` in `router.yaml`) picks the **cheapest (model, thinking) pair whose measured pass rate is within the mode's band of the best** for this kind of turn at this difficulty, priced with RunInfra's prompt cache in mind.

- **Obvious turns skip the classifier.** "thanks", "ok", "hi", "lgtm" route as trivial chat; a bare "yes do it", "go ahead", "continue" or "try again" reuses the previous turn's classification (it approves or retries that work). Tool continuations never call the classifier, and an identical recent request (same context) reuses the cached answer.
- **Otherwise one classifier call** (Jev or the OpenRouter decision model) answers: the kind of work (chat/explain, lookup, edit, feature, review → `code`; `algorithm`; `math`; `multi_file` → `agentic`; `terminal` for build/CI/shell/Docker), a difficulty worded like the bench tiers (trivial, easy, medium, hard, frontier), whether it is a follow-up of the previous turn, the expected answer length and ambiguity, and whether it needs tools. The previous turn's kind and difficulty are in the classifier's input. The session starts the call before refreshing the live model list, so the two waits overlap.
- **Follow-ups inherit** the previous turn's kind and (90% of) its difficulty; a new self-contained turn stands on its own (only an ambiguous or low-confidence one keeps some momentum), so a "thanks" after hard work stays cheap.
- **Quality curves** (`quality.models` in `router.yaml`, from `node bench/router/calibrate.mjs`): per pair, the pass rate for each kind at the easy/medium/hard anchors of the 2026-10-15 quality suite (340 trials per pair, shrunk toward the tier rate), plus reasoning tokens per call. The router interpolates at the turn's difficulty; terminal work uses the agentic curves with a public Terminal-Bench lean toward GLM, agentic work a small public lean (DeepSWE/NL2Repo) toward DeepSeek. In practice: easy and medium work → GLM 5.3 Flash low (everything ties there and it is cheapest); hard algorithms and contest math → DeepSeek V4.1 Flash low (88% vs 72% for GLM max on the hard tier); hard terminal work → GLM high/max.
- **Cost** per pair is cache-aware: context at the cached price for the model already in use, the full price for another, plus answer and reasoning tokens at the output price. Pairs within 1% of the cheapest go to the higher pass rate, then the faster first token.
- **Sticky, cache-aware routing** (`quality.cache` in `router.yaml`). RunInfra keeps one prompt cache per (model, thinking) pair on a session for about 900 s, so a switch misses once on the new pair and a thinking change is a switch too. Each pair in the band is priced over the next few turns (the miss now, the warm turns after it, the likely miss on the way back), less the failed turns its pass rate avoids. The warm pair stays unless a clearly better (`clear_gain`) or cheaper pair pays for its miss. A session's first turn takes the cheapest good pair; inside a tool loop only hard failures (a failing test, repeated tool errors) leave the warm pair, in one jump. When the warm pair would win whatever the classifier says, the classifier call is skipped. A mode can override the pricing (`modes.<mode>.cache`): low keeps the warm pair anywhere in its 0.10 band. On the session replay against router v2 (`bench/router/session-replay.mts`, 12 seeds), medium costs 1-2% less at a slightly higher expected pass rate and low about 0.5-0.9% less; live, 13/14 runs passed against 12/14 at about the same cost (`bench/router/README.md`).
- **Frozen prompt.** The tool list and system prompt are fixed for the session, so every request extends the previous one byte for byte (a test checks this across a scripted session).
- **Escalation on failure**: when the previous turn ended badly (a request error, tests still failing at its end, 3+ tool errors, or you say it still fails), the next turn takes a pair at least `step_margin` better than the one that failed; a second failure in a row steps twice; a turn that ends well resets it. Inside a turn, a failing test or 2+ tool errors step up once (4+ twice) from the pair the turn started on. Tool calls you did not approve do not count as failures.
- Modes: `low` caps thinking at low, widens the band (0.10) and sticks to the warm pair inside it; `medium` uses 0.04; `high` takes the best pair (band 0.02, deeper thinking on ties) with thinking at least low, except trivial turns. Levels above a mode's `max_auto` are a reserve, used when escalating or when nothing below comes within the band. A model without curves (new on RunInfra) borrows GLM's, offset by its skill scores and a 0.05 penalty, until it is benched.
- If the classifier fails or no key is set, the router does not guess: it keeps the previous decision, or uses the default model (`router.fallbackModel`, else the role model), and shows a warning. A model whose request fails is skipped for a few minutes.

The skill-score selector from RunRouter is still there (`selection: scores` or `quality: null` in `~/.runkiln/agent/router.yaml`): skill taxonomy classification, required score `req_base + difficulty × req_span`, quality bonus per thinking level, cheapest feasible pair, momentum across turns. The eval in `bench/router/` compares the two.

### Failover

In auto mode, a request that fails with a transient error (5xx, 429, overloaded, timeout, connection reset or dropped stream, or no first token within `failover.stallTimeoutSec`) is retried on the same model `failover.retries` times (default 2) with jittered exponential backoff. If it still fails, the rest of the turn goes to the other RunInfra model at the equivalent thinking level (GLM low/high/max ↔ DeepSeek low/high/max; DeepSeek off → GLM low, xhigh → GLM max), with the conversation and tools unchanged and a notice: `glm-5-3-flash unavailable, switched to deepseek-v4-1-flash for this turn`. The failed model sits out a cooldown (`failover.cooldownSec`, default router.yaml `failed_model_cooldown_sec`, 300 s; `/router` lists it), and the next turn is routed normally. It never switches twice in a turn, never to a disabled (`disabledModels`), paused or gone model (live catalog), to an unbenched model only when no benched one fits, and never to a model without image input when the context has images.

A request that fails mid-stream is restarted, not resumed: the partial answer is dropped and the same request is sent again (to the same model, or the failover model), with every completed tool call and result of the turn kept. An OpenAI-compatible API can't continue a cut-off message reliably, and a half-streamed tool call can't be run.

```json
{ "failover": { "enabled": true, "retries": 2, "stallTimeoutSec": 90, "cooldownSec": 300 } }
```

`failover.enabled: false` (or "Model failover" in `/settings`) keeps auto on the routed model with plain retries. `stallTimeoutSec: 0` turns the first-token check off; after the first token, a stalled stream ends at the HTTP idle timeout (`httpIdleTimeoutMs`).

### Thinking in auto mode

`/thinking auto` (or `--thinking auto`, the default) lets the router pick the level each turn. `/thinking <level>`, Shift+Tab or `--thinking <level>` pins a level while auto picks the model; Shift+Tab cycling passes through `auto` to hand it back.

### Live RunInfra catalog

Which models auto can use comes from RunInfra itself: `GET /models` lists the ids your key can call right now, with availability, prices, context window, image input and reasoning efforts. It is read when auto turns on and before routing (cached 10 minutes, retried after 1 minute on failure, 4 s timeout); if it can't be read, `models.yaml` is used. Paused models stay available for manual picks but are not routed. A model RunInfra adds later is routable without a code change, using the `unknown_model` default scores from `router.yaml` (plus a price prior) until it is benched; `/router` lists such models as derived.

Skill scores, the taxonomy, modes and tuning ship in `router.yaml` at the package root. Put overrides in `~/.runkiln/agent/router.yaml`: tuning/thinking/escalation keys replace ours, skills with the same name replace ours (new names are added), `models.<id>.skills` merge per skill, `modes.<mode>` overrides merge per mode, and `route: false` keeps a model out of auto. Per model, `max_auto_thinking` caps the level auto picks for it in every mode (DeepSeek V4.1 Flash: `high`, since xhigh/max truncate at the 16k output cap and lose on hard tasks; `/thinking` can still pick them), and `auto_off_below` lets it run with thinking off below that difficulty despite the thinking floor (DeepSeek: `0.55`, where thinking measured no gain).

### Configuration

Configure in `~/.runkiln/agent/settings.json` (global only; a project can't change where prompts go):

```json
{
  "models": { "code": "auto" },
  "disabledModels": ["ornith-1-5-35b"],
  "router": {
    "classifier": "jev",
    "mode": "medium",
    "jev": { "model": "jev-latest" },
    "openrouter": { "model": "typesafe/jev-1.14" },
    "timeoutMs": 4000,
    "fallbackModel": "glm-5-3-flash",
    "cacheTtlSec": 600,
    "sessionModel": false
  }
}
```

- **Jev vs OpenRouter.** `router.classifier` is `auto` (default: Jev if it has a key, else OpenRouter if it has one), `jev`, `openrouter` or `off`. Setup, `/setup routing` and `runkiln key set` set it for you. `router.jev.model` / `router.openrouter.model` pick the classifier model. Flags: `--router-classifier <jev|openrouter|auto|off>`, `--router-model <id>` (a Jev model name or an OpenRouter decision model id), `--router-mode <low|medium|high>`.
- **OpenRouter means a decision model.** The OpenRouter classifier and the auto-permission judge call OpenRouter's Decisions / System One API (`POST https://openrouter.ai/api/v1/systemone`) with the same typed questions as Jev and read the answer probabilities; chat models are never used. Setup, `/setup routing` and `runkiln key set openrouter --router-model <id>` offer only the live list from `GET /api/v1/models?output_modalities=decisions` (cached 24 h in `~/.runkiln/agent/cache/openrouter-decision-models.json`). The default, `typesafe/jev-1.14`, won the bench (`bench/router/README.md`). A saved `router.openrouter.model` that is not a decision model (such as the old default `google/gemini-2.5-flash-lite`) is moved to the default at startup with a one-line notice. A task answer whose top probability is under 0.3 is too spread to route on, so the router takes its fallback.
- `--model auto[:mode]` starts this run in auto mode; `"models": { "code": "auto" }` (or `"auto:high"`, etc.) starts new code sessions in auto mode (`chat` works the same).
- `disabledModels`: RunInfra model ids auto must never route to. Every router honors it, including one passed in through the SDK. Anything other than a list of strings is ignored, and non-string entries are skipped. Manual picks are not affected.
- Keys come from the environment first (`TYPESAFE_API_KEY`, `OPENROUTER_API_KEY`), then `~/.runkiln/agent/router-keys.json`, never from a project. Key checks and errors never show the key or a response body. Classifier `baseUrl`s must use https (http only for localhost).

### /router and the footer

- `/router` shows the mode, where the model list came from (live catalog or `models.yaml`, paused and derived models), the classifier, and the last decision: classifier answer (with the task kind, follow-up, length and ambiguity), difficulty adjustments, the chosen and best pass rate and the band (or the required scores), every (model, thinking) candidate with its estimated cost and pass rate (or margin). `/router on|off` turns auto on or off; `/router low|medium|high` switches mode (and turns auto on).
- The footer shows `auto:<mode> → <model> - <thinking> - <kind> d<difficulty>`, e.g. `auto:medium → deepseek-v4-1-flash-1017 - low - algo d0.75` (with the skill-score selector, the skill: `code.bugfix d0.62`). A pinned level shows as `<thinking> (pinned)`, `↑1`/`↑2` marks escalation steps after failures (`↑` with the skill-score selector), `follow-up` a turn that inherited the previous one, `fast` a turn routed without a classifier call, `cached` a reused classifier answer, `trivial` the high-mode trivial-turn policy, and `auto:<mode>!` a classifier failure (with `classifier failed, kept last` or `classifier failed, default` as the reason). Before the first routed message it reads `auto:<mode> → <model> (routes on next message)`. When the stats (cost meter included) and the route don't fit on one line, as at 80 columns, the route gets its own right-aligned line under the stats; the pwd line carries the permission badge (`▸ read & write`, `‖ plan - read-only`, `▸▸ allow all`).

## Permissions

Pick what runs without asking with `/permissions`, cycle in-session with `Alt+M`, or start with `--permissions <mode>` (also `RUNKILN_PERMISSIONS`). `/permissions` saves the choice as the default in the global settings (`permissions.mode`); a project's settings can't change it. Plan mode is never saved as the default.

| Mode | Runs without asking | Asks |
|---|---|---|
| `ask` | nothing | every read, write and command |
| `read-write` (default) | reads, searches, edits inside the project | shell commands, writes outside the project, protected files |
| `plan` | reads and searches only; everything else is blocked | nothing: writes, edits, commands and other tools are blocked until you approve the plan |
| `auto` | the pre-pass and what the decision model allows | what it asks about, plus every risky call |
| `allow-all` | everything except deny rules | nothing |

`Alt+M` cycles `ask → read & write → plan → auto → (allow all)`, the order of Claude Code's Shift+Tab cycle (default, accept edits, plan) with RunKiln's auto after it; allow-all only joins the cycle once you picked it.

### Plan mode

Plan mode is read-only, as in Claude Code: the agent researches with `read`, `grep`, `find` and `ls`, and every write, edit, shell command and other tool is blocked with a reason that tells it to keep planning. It ends its turn with the plan under a `## Plan` heading, and RunKiln shows the plan with three choices: **run it** (back to the mode you were in before plan mode, and the agent implements it), **keep planning** (type what to change; plan mode stays on) or **discard** (back to the previous mode, nothing runs). **Edit** (`e`) opens the plan in your editor (`externalEditor`, else `$VISUAL`, else `$EDITOR`); the prompt then shows your version, and running it sends your edited plan to the agent in full as the plan to implement (keep planning sends it with your note). A turn that ends with a question instead of a plan just returns to the editor. The footer shows `‖ plan - read-only`. Start in it with `--permissions plan`, or switch with `Alt+M` or `/permissions plan`. The plan-mode instructions travel as a hidden message on the run, not in the system prompt, so switching modes keeps the prompt cache.

### Rules

Allow, ask and deny rules use Claude Code's syntax:

```jsonc
// ~/.runkiln/agent/settings.json
{
  "permissions": {
    "allow": ["Bash(npm test:*)", "Bash(git status)", "Read", "Edit(src/**)", "mcp__docs__search"],
    "ask":   ["Bash(git push:*)", "Edit(migrations/**)"],
    "deny":  ["Bash(rm -rf:*)", "Read(.env)", "Read(~/.ssh/**)", "mcp__prod__*"],
    "projects": { "/home/me/app": { "allow": ["Bash(npm run build:*)"] } }
  }
}
```

- `Bash(...)` / `PowerShell(...)` / `Shell(...)`: `npm test` is exactly that command, `npm run test:*` (or `npm run test *`) anything starting with those words, `Bash` alone every command. `Read(...)` covers read, grep, find and ls; `Edit(...)` and `Write(...)` cover write and edit. Path globs: `*` within a folder, `**` across folders, a bare name (`.env`, `*.pem`) at any depth, `./x` or `x/y` from the project folder, `/x` absolute, `~/x` in your home; a folder pattern covers what's inside it. Any other name is a tool name, with `*` wildcards.
- **Deny beats ask, ask beats allow.** Deny rules apply in every mode, plan and allow-all included. Ask rules apply in every mode except allow-all. Allow rules never approve a risky call and never lift plan mode. Shell matching checks every part of a chain and the commands inside `$(...)`; it is a guard rail, not a sandbox.
- Where rules live: global settings (`allow`/`ask`/`deny`), global settings per project (`projects["<folder>"]`, written by "always allow in this project"), and the project's own `.runkiln/settings.json`, which may add `ask` and `deny` rules only. **A project can only tighten**: its allow rules are ignored and shown as ignored.
- `/permissions rules` lists every rule by scope (this session, this project, global, project file) and removes one with `d`, session rules included. `/permissions allow|ask|deny <rule> [--project]` adds one.

### Approval prompt and auto mode

- The prompt offers **allow once**, **always allow** (this session only: a command prefix such as `npm test`, a file, project edits, reads, or a tool), **always allow in this project** (the same rule, saved to your settings for this project folder), **deny**, and **deny with feedback** (your words go back to the model). Every part of a chained command must match a prefix; command substitution never matches. Risky calls never get an "always allow". A call that asks because of an ask rule says which rule.
- **What you approve is shown.** A write or edit shows its diff (the same diff as the tool card: the file on disk against the change, or the whole file for a new one), cut to 8 lines with `+a −r` in the title; the tool-output expand key (`Ctrl+O`) shows all of it. This covers writes outside the project, protected files and every write in `ask` mode. Shell commands are shown whole with syntax colour, MCP calls with their arguments as compact JSON. On a short terminal the prompt cuts the diff and the hints further so the choices stay on screen.
- **Timeout.** By default a prompt waits for your answer as long as it takes. `permissions.promptTimeoutSec` sets a timeout in seconds (shown in the title); when it runs out, `permissions.timeoutAction: "deny"` (the default) denies the call, and `"pause"` keeps the prompt open (`paused` in the title) and sends a notification, even when the terminal has focus (unless `notifications` is `off`).
- **auto** uses the router classifier's key (Jev via `TYPESAFE_API_KEY`, or the OpenRouter model; `/setup keys` or `runkiln key set jev`). Without a key it's greyed out. Order: saved rules, then risk rules, then a local pre-pass that runs obvious routine calls with no model call (read-only git, `ls`/`cat`/`grep` of project files, the project's own test/lint/build scripts from package.json, `tsc --noEmit`, `cargo test`, ordinary edits inside the project), then the decision model. The model sees the call, the project folder, a git summary, your latest request and a few recent turns (your messages and the agent's tool calls, never tool output), and answers allow/ask/deny with a risk level, category, whether you asked for it, and a confidence. A high-risk or unrequested medium-risk allow asks, and so does any answer below 0.7 confidence. Its reason is shown in the prompt (`auto: Jev: installs or removes packages, medium risk (not requested)`). Judging starts as soon as the agent has written the call, answers are cached per normalized command for the session, and an error or a 4 s timeout asks. "Always allow" on a judged call makes similar calls stop asking.
- **Risky calls always ask** in auto: `rm -r/-f`, `git push`, `git reset --hard`, `git clean -f`, `git stash drop`, `git branch -D`, `curl … | sh`, `sudo`, publishing, recursive `chmod`/`chown`, disk tools, secrets (`.env`, SSH keys, credential files, `$…_TOKEN`), and paths outside the project. The model is still consulted on them, but only to make the answer stricter: a deny at 0.9 confidence or more blocks the call.
- Accuracy on the 63-call eval set in `bench/permissions` (live, 2026-10-16): Jev 84.1% → 96.8%, with 0 unsafe allows after. With the OpenRouter decision models (`bench/router/README.md`), the default `typesafe/jev-1.14` scores 63/63 (8/8 denies caught, 0 unsafe) in two runs.
- **Print mode** (`-p`, `--mode json`) follows the mode but can't ask, so a call that would ask is denied with a hint. For unattended runs and benchmarks use `--permissions auto` or `--permissions allow-all` (`--yolo`).
- In every mode, writes whose path Windows reads as another file (trailing dot or space, `:`, device names, 8.3 short names) are refused. Symlinks and junctions are resolved before the project check. Protected files (writes always ask): `.git/**`, `.runkiln/**`, `.mcp.json`, `.agents/**`, other agents' folders, CI workflows, `AGENTS.md`, `CLAUDE.md`, `.envrc`, `package.json`, and files that test runners, builds and editors execute; [SECURITY.md](SECURITY.md) has the list. Hard links aren't detected yet.

## Security

RunKiln assumes the model and the repository may be hostile; [SECURITY.md](SECURITY.md) has the threat model, how to report a vulnerability and a comparison with Pi. In short:

- **Project trust.** Project config loads only in a trusted folder, and hooks and MCP servers also need approval of their exact commands. Settings that pick programs or where transcripts go (`shellPath`, `shellCommandPrefix`, `externalEditor`, `editor`, `npmCommand`, `sessionDir`, `httpProxy`, `shellEnvironment` and others) are read from global settings only.
- **Secrets stay out of commands.** RunKiln's own keys never reach commands, hooks or MCP servers. Variables named like secrets (`*KEY*`, `*SECRET*`, `*TOKEN*`, `*PASSWORD*`, `*CREDENTIAL*`) are hidden from commands by default. Pass one on by name in global settings:

  ```jsonc
  // ~/.runkiln/agent/settings.json
  { "shellEnvironment": { "include": ["GITHUB_TOKEN", "GH_TOKEN"] } }
  ```

  `GITHUB_TOKEN` and `GH_TOKEN` are hidden too, so `gh` and authenticated `git` fall back to their own login. When one is set and hidden, startup shows a one-line notice naming `shellEnvironment.include`. Other keys: `inherit: "core"` passes only the variables a program needs, `exclude` hides more names, `hideSecrets: false` turns the name check off.
- **Secret reads ask.** Credential files ask in every mode except allow-all, reads outside the project ask by default (`permissions.readsOutsideProject: "allow"` turns that off), and RunKiln's key files are refused.
- **Private storage and redaction.** `~/.runkiln/agent` is readable only by you (0700/0600, a user-only ACL on Windows). Keys and common token formats are redacted from session files, `/export` output and decision-model requests; the running session keeps them, a resumed one doesn't.
- **Untrusted content.** MCP results and files outside the project reach the model marked as untrusted data, with invisible Unicode tag characters removed.
- **Not a sandbox.** An approved command runs with your full access. For `allow-all`, use a container or a throwaway checkout.

## Subagents

RunKiln runs one agent per session; the `task` tool, `/delegate`, `/subagents` and the `subagents.*` settings were removed. Old `subagents` settings and `SubagentStop` hooks are ignored, and `/delegate` or `/subagents` prints a one-line notice instead of running. On the multi-part bench (`bench/quality`, 10 repos with 2-3 independent parts each, 2026-10-16), single-agent auto passed 10/10 for $0.009 in total against 9/10 for $0.037 with subagents, and was about twice as fast. Each subagent started from a cold prefix on its own session id, and turning the tool on mid-session changed the tool list, which threw away the main session's prompt cache.

## Workflow

- **Todo list.** For multi-step work the agent keeps a checklist with the `todo` tool. It shows above the editor (the item in progress and the next ones; `/todo` or the tool-output toggle shows all of it) and is saved in the session. When a run ends with unfinished items, the agent gets one hidden reminder. `todo.enabled` / `todo.nudge` (both on by default).
- **/review** `[uncommitted|<commit>|<branch>]`: a read-only code review. RunKiln blocks every write, edit, shell command and non-read tool for that run, in every permission mode, and the answer lists findings by priority (P0–P3) with `file:line`. For CI: `runkiln review [target] [--fail-on P0|P1|P2|P3]` prints the review and exits 2 when a finding at that priority or above is found.
- **/commit** `[turn|session|all]`: commits the files the agent changed this session (or this turn, or every changed file) with a conventional commit message from the chore model, which you edit or confirm first. Commits are path-limited, so files you staged yourself stay staged and out of the commit. `git.autoCommit: "turn"` commits each turn that changed files, without asking (default `"off"`). `git.coAuthor: "Name <email>"` adds a `Co-authored-by` trailer to these commits (default empty: no trailer).
- **--worktree** `[name]`: start the session in a new git worktree and branch under `.runkiln/worktrees/<name>`; on exit, merge it back into the branch it started from, keep it, or remove it.
- **Notifications.** When a turn ends, or an approval or plan is waiting, while the terminal is unfocused: a desktop notification (OSC 9 / OSC 777) where the terminal supports it, else the bell. `notifications: "auto" | "bell" | "off"`. Without focus reporting, only turns longer than 30 s notify.
- **Idle compaction.** After the session sat idle longer than the model's cache TTL (about 900 s on RunInfra), the next turn pays the full uncached price anyway, so RunKiln compacts first when the context is at least `compaction.idleMinTokens` (40,000). `compaction.idleCompact: false` turns it off.

## Repo map

A ranked map of the repository's files and key symbols (functions, classes, types, exports, with their signatures), in the style of Aider's repo map. Definitions and references come from tree-sitter (WASM grammars from `@vscode/tree-sitter-wasm`: TypeScript/TSX, JavaScript, Python, Go, Rust, Java, Ruby, C#, C++, PHP; regexes for C, Kotlin, Swift, Lua, shell and anything tree-sitter can't load). Files are ranked by PageRank over "file A uses a name file B defines" (no self-links, no links across languages, method calls on objects only reach methods), centered on the files and identifiers the conversation mentions, then rendered to a token budget.

- **Not in the system prompt.** The map changes whenever the repo does, so putting it in the prefix would break RunInfra's prefix cache. It is a tool result instead: the `repo_map` tool (`paths`, `query`, `tokens`; read-only, runs without asking) and `/map [tokens] [paths…] [words…]`.
- `repoMap.enabled` (default `false`) adds the `repo_map` tool to the default tools (or pass `--tools +repo_map`). `repoMap.firstTurnTokens` (default `0`) appends a static map once after the first user message; it stays in the conversation, so later requests keep the same prefix. `repoMap.tokens` sets the default budget (1024).
- **Why off by default:** on `bench/quality/repomap.mjs` the map cut turns and navigation calls by about a third but did not raise the pass rate (r1, 22 tasks: glm-low 21/22 without, 19/22 with; auto 20/22 vs 17/22; r2 after ranking fixes, 12 agentic tasks: 11/12 vs 10/12 and 11/12 vs 11/12). Reports in `bench/quality/reports/2026-10-16-repomap-*.md`.
- Built once per process, then refreshed by mtime (only changed files are parsed again). Tags are cached in `~/.runkiln/agent/cache/repo-map/` keyed by git HEAD and every file's mtime and size, so a new session in an unchanged repo parses nothing (about 5 s for the 660 source files of this repo cold, under 0.5 s warm). Git's tracked and untracked-not-ignored files; `node_modules`, `dist`, `build`, `target`, `vendor` and virtualenvs are skipped.

### One model per session

`router.sessionModel: true` routes only a session's first request and keeps that model and thinking level for the rest of the session (like Amp's one model per thread). Failover still switches when the model fails. Default `false`: every request is routed. See `bench/quality/repomap.mjs` and `bench/session/run.mjs --session-model` for the comparison.

## Usage and cost

`/usage` (old names `/cost` and `/stats` still work; also a click on the footer's cost meter) opens a full-screen overlay with five tabs: **Overview** (billed total, cache hit rate and what it saved, time to first token, spend by category: main turns, chores, router classifier and permission judge, plus any budgets), **Models** (requests, prompt and cached tokens, output and $ per model and thinking pair), **Turns** (newest first: cost, cache, requests, duration, the router's pick and why), **Context** (what fills the context window) and **History** (spend across all saved sessions: today, this week, this month or all time, by day, model and category, with a $/day sparkline). Tab / ← → / 1-5 switch tabs, ↑ ↓ PgUp PgDn scroll, `t` `w` `m` `a` pick the History range, `r` refreshes, Esc or `q` closes. `/usage models`, `/usage 3` or `/usage week` open a tab directly.

- **Costs are what RunInfra billed.** When a response carries `usage.cost` (RunInfra and OpenRouter) or `usage.runinfra.cost_microcents`, that is the cost stored for the request; the catalog price is only a fallback, and a decision-model call without a billed cost is marked `est`. Router classifier, auto-permission judge and title/chore calls are counted too.
- **Every router decision is saved** in the session as a `runkiln.route` entry (model, thinking, source, reason), so the Turns tab works on a resumed session.
- **The footer** shows the session's spend and cache hit rate, `$0.0123 - 87% cached`, or `$0.41/$0.50` against the tightest budget when one is set.
- **Print mode**: `runkiln -p "…" "/usage"` prints every tab as plain text after the answer; with `--mode json` it writes one `{ "type": "usage", … }` line.

### Ledger and `runkiln usage`

Saved sessions append one line per billed call to `~/.runkiln/agent/usage.jsonl` (under `RUNKILN_CODING_AGENT_DIR` when set). It feeds the History tab, the daily budget and the CLI:

```sh
runkiln usage                  # the last 7 days: total, $/day, by day, model and category
runkiln usage today|week|month|all
runkiln usage --since 24h      # or 7d, 2w, 30m, 2026-10-01
runkiln usage --json           # totals as JSON, times on your clock (e.g. 2026-10-17T00:30:00.000+02:00) with timeZone and utcOffset
runkiln usage --rebuild        # rewrite the ledger from the saved session files first
```

Session files stay the source of truth; `--rebuild` fills the ledger from sessions saved before it existed. `RUNKILN_USAGE_LEDGER=0` (or `off`, `false`) turns the ledger off; in-memory sessions (`--no-session`) never write to it.

### Budgets

```json
{ "budget": { "session": 0.5, "daily": 2 } }
```

`budget.session` is USD per session, `budget.daily` USD per local calendar day across all sessions (from the ledger). At 80% RunKiln warns once; at 100% it asks before sending the next prompt. A budget never hard-stops a run. Both show in the footer and the Overview tab.

## Settings

`/settings` lists every option in sections (Model, Display, Turn summary, Changes, Footer, Editor, Images, Startup, Terminal); type to search. Changes save to `~/.runkiln/agent/settings.json` (the review key to `keybindings.json`). Display options, defaults first:

| Setting | Values | What it does |
| --- | --- | --- |
| `display.turnSummary` | `reply`, `footer`, `off` | Turn summary after each reply, as the last footer row, or hidden. `true`/`false` still work. |
| `display.turnSummaryFields` | `time`, `files`, `tools`, `cost`, `model` on, `clock` off | Parts of the summary. The status mark always shows. |
| `display.toolOutput` | `collapsed`, `expanded` | Tool cards at startup. The tool expand key still toggles. |
| `display.changesTray` | `true`, `false` | The changes tray. |
| `display.changesTrayPosition` | `editor`, `footer` | Tray above the editor, or under it next to the footer. |
| `display.diffOpens` | `review`, `git` | What `/diff` opens. `/diff review` and `/diff git` pick one. |
| `display.timestamps` | `off`, `time`, `datetime` | Dim time under each message and reply (`14:32`, `2026-10-17 14:32`), in `TZ` or the OS zone. |
| `app.changes.review` | `alt+c`, a free key, none | Review view key (keybindings.json). |
| `ui.maxProseWidth` | `100`, `80`, `120`, `0` (off) | Prose wrap width. |

The footer layout row opens `/setup footer`. Footer rows: a preset (`all`, `none`, `default`) and one on/off row per footer part, below.

## Footer, title and accessibility

### Footer (`/setup footer`)

The footer keeps its current layout until you change it. `/setup footer` (or the old `/statusline`) opens a picker with a live preview: Enter or Space toggles an item, Alt+Up/Alt+Down moves it, `r` goes back to the default layout, Ctrl+S saves, Esc cancels. It writes `footer.items`:

```json
{ "footer": { "items": ["model", "thinking", "cost", "cache", "context", "break", "cwd", "branch", "todo", "tests", "time", "permissions"] } }
```

Items: `model`, `router`, `thinking`, `permissions`, `cost`, `cache`, `context`, `tests`, `jobs`, `todo`, `branch`, `cwd`, `session`, `time`, `turn` (last turn summary); `"break"` starts a new line. Items with nothing to show are hidden. On a narrow terminal the lowest-priority items are dropped first; the permission badge is never dropped, and it is right-aligned when it ends its line. Unset `footer.items` (or press `r` in the picker) for the default layout.

### Footer parts (`/settings` > Footer)

Every part of the footer turns on and off on its own, saved as `footer.show`:

```json
{ "footer": { "show": { "cwd": false, "decision": false, "time": true } } }
```

| Part | Default | Shows |
| --- | --- | --- |
| `cwd`, `branch`, `session` | on | `~/project (main) - name` |
| `permissions` | on | Permission badge at the right end |
| `cost`, `cache` | on | `$0.0123 - 87% cached` |
| `context`, `autoCompact` | on | `4.3%/1.0M (auto)` |
| `tests`, `xp` | on | Verify loop marker, experimental marker |
| `todo`, `queue`, `time` | off | `todo 2/5`, `2 queued`, `14:32` |
| `provider`, `router`, `model`, `thinking` | on | `(provider) auto:medium → model - high` |
| `decision`, `confidence` | on | Router decision and classifier difficulty, `code d0.75` |
| `turn` | follows `display.turnSummary: footer` | Last turn row |
| `statuses` | on | Extension status row |

A row with every part off disappears. Presets: `all` (every part and the key hints on), `none` (no footer, no key hints), `default` (today's footer: clears `footer.show` and `footer.items`, key hints on). With `footer.items` set, a part set to `false` hides its item and the rest of the layout is unchanged.

### Terminal title

`terminal.dynamicTitle` (on by default) sets the title to `RunKiln - <project> - ● working`, `✓ done` or `⚠ needs approval` (OSC 0/2, tmux pane titles too) and restores the previous title on exit. `false` keeps a static title.

### Accessibility and readability

- `NO_COLOR` (any non-empty value) turns theme colours off; bold and italic stay.
- `ui.reducedMotion: true`: no spinners or animations, static indicators instead.
- Themes `dark-colorblind` and `light-colorblind` (blue/orange instead of green/red for diffs and states) and `high-contrast`, next to `dark` and `light`.
- `ui.maxProseWidth` (default 100, `0` for no cap): assistant prose wraps at this width on wide terminals; code blocks and tables keep the full width.
- Full-screen view (`tuiMode: "fullscreen"`): while scrolled up, the last prompt above the view stays pinned at the top (click it to jump there), and the jump button counts new messages below (`2 new ↓`).

### Mouse and clickable UI

In the full-screen view (`tuiMode: "fullscreen"`) most of the UI answers the mouse; the keys still work the same.

- Prompts and pickers: click an approval or plan answer, a model, session, tree, rewind or message row to pick it; hover highlights the row, the wheel moves the selection.
- Tool cards: hover shows an action strip above the card (`open  diff  copy path  ⋯`, or `copy cmd  rerun` on shell cards). Right click or `⋯` opens a menu with the rest: copy output, revert file (puts that one file back as it was before the turn, after asking) and rewind from here. `cardActions: false` hides the strip.
- Footer: the model, branch, context meter, cost, permission badge and the other items are clickable.
- File paths open in your editor. `editor.open`: `"auto"` (the editor RunKiln runs in, else `$VISUAL`/`$EDITOR`, else the default app), `"system"`, `"vscode"`, `"cursor"`, `"zed"`, `"nvim"`, `"idea"`, `"subl"`, `"editor"`, or a template such as `"code -g {file}:{line}:{col}"`. Over SSH the `path:line` is copied instead.
- `mouse`: `"on"` (default: clicks, hover, selection, wheel), `"wheel"` (wheel only) or `"off"` (no capture; the terminal keeps its own selection). `RUNKILN_MOUSE=on|wheel|off` overrides it. With capture on, hold Shift (Option in iTerm2, Fn in Terminal.app) to select with the terminal instead.
- `mouseRightClick`: `"menu"`, `"paste"` or `"auto"` (paste on Windows outside VS Code, menu elsewhere). Shift+right click does the other one.
- `terminal.pointerShape` (`auto|on|off`): a hand pointer (OSC 22) over clickable things; auto turns it on in kitty, Ghostty, foot, WezTerm, iTerm2 and xterm, off under tmux.
- Linux: a copy also fills the PRIMARY selection, so middle click pastes it.
- Windows Terminal: OSC 9;4 tab and taskbar progress is on by default there; copy uses OSC 52, then `clip.exe`, then PowerShell. `terminal.fullRepaint: true` (or `RUNKILN_FULL_REPAINT=1`) rewrites every row each frame if stale fragments show up on a ConPTY host; off by default.

### Replies in your language

The system prompt has one fixed rule: reply in the language the user writes in. Its text never changes, so the cached prompt prefix stays the same.

## Checks and tests

**Post-edit diagnostics.** After each `edit` or `write`, RunKiln checks the file before and after the change and appends only the diagnostics the edit introduced (errors first, about 20 lines) to the tool result, so the model sees a syntax or type error it just made in the same turn. Checkers are auto-detected: biome or eslint, tsc (while it stays fast), ruff or a Python syntax check, gofmt and go vet, cargo check, `node --check`, shellcheck, and a TypeScript syntax fallback (Node's type stripper) when no TS checker is installed. Settings: `checks.enabled` (default on), `checks.autoDetect`, `checks.timeoutMs` (default 4000) and `checks.commands` (per glob, e.g. `{"*.py": "mypy {file}"}`; these pass the permission gate). `checks: false` turns it off.

**Verify loop.** When a turn that changed files ends, RunKiln can run the project's tests (a `package.json` test script, pytest, `cargo test` or `go test`, or `verify.command`) and send a condensed failure back to the model as a hidden follow-up, at most `verify.maxRetries` times (default 2, stops early when the same failure repeats). Each failure counts as a failing test for the router, so the retry escalates the model or thinking; a failure only counts within its own turn. `verify.mode`: `ask` (default, offered after the first file-changing turn in a project, the choice is saved per project), `auto` or `off`. A test command set in a project's `.runkiln/settings.json` is always confirmed before it first runs. `/test` runs the tests now; `/test off|ask|auto` sets the mode and `/test <command>` the command. A command that cannot run at all (missing test file or module, unknown command, nothing collected) is reported to you and never sent to the model. The footer shows the last run (`✓ tests`, `✗ 3 failing ↻1`, `⚠ test command`). In print mode, `--verify` turns the loop on and exits 1 if the tests still fail.

**Edit-miss hints.** When an edit's `oldText` is not found, the error shows the closest matching lines with line numbers and a compact diff of what differs, instead of a bare "could not find". With `edit.autoRepair: true` (off by default), when one spot is at least 90% similar the chore model rewrites `oldText` to match it, and the repair is applied only if it then matches exactly once inside that spot.

## Commands

Type `/` for the command palette (fuzzy search with descriptions), `@` to mention a file, `!cmd` to run a shell command yourself. `/help` lists everything.

37 commands are listed, one per job:

| Area | Commands |
|---|---|
| Help and state | `/help`, `/status`, `/usage`, `/doctor`, `/changelog` |
| Setup | `/setup [keys\|model\|routing\|permissions\|look\|footer\|wizard]`, `/settings`, `/trust` |
| Model and routing | `/model`, `/router`, `/thinking` |
| Permissions | `/permissions` |
| Code | `/diff`, `/test`, `/review`, `/commit`, `/undo`, `/map`, `/init`, `/todo` |
| Agents and tools | `/jobs`, `/hooks`, `/mcp` |
| Session | `/new`, `/resume`, `/fork`, `/rewind`, `/tree`, `/compact`, `/name`, `/copy`, `/export`, `/import`, `/share`, `/reload`, `/quit` |
| Feedback | `/bug` |

Old names are hidden aliases: they still work, are reserved against extensions, and say the new name once per session.

| Old | Now |
|---|---|
| `/key`, `/login`, `/logout`, `/runinfra` | `/setup keys` |
| `/models`, `/scoped-models` | `/setup model` (the old names still open their screens) |
| `/statusline` | `/setup footer` |
| `/cost`, `/stats` | `/usage` |
| `/session` | `/status` |
| `/hotkeys` | `/help` |
| `/clear` | `/new` |
| `/exit` | `/quit` |
| `/clone` | `/fork` |

From the shell, `runkiln setup [section]` and `runkiln key [set|remove|test] [runinfra|jev|openrouter]` replace `runkiln login` / `runkiln logout` (still accepted).

## Benchmark

Run on 2026-10-14 against the unmodified upstream agent RunKiln was forked from. Each number is the median of 9 samples on GLM 5.3 Flash with low reasoning.

| | Upstream | RunKiln |
|---|---|---|
| Time to first token | 542 ms | 643 ms |
| Speed | 302 tok/s | 311 tok/s |
| Cache hit, turns 2–4 | 83.0% | 78.0% |
| Cold start | 374 ms | 237 ms |
| System prompt and tools | 1,449 tokens | 1,038 tokens |

The cache-hit percentage is lower because RunKiln's prompt is smaller. API speed swings hour to hour, so only compare runs from the same session.

## Development

`npm run lint` runs biome (lint, format and import checks); `npm run format` applies its fixes.

```bash
npm run build
npm run check   # type-check
npm run test
```

### CI on boat

While GitHub Actions can't start jobs (billing), `scripts/boat-ci.sh` runs the same steps as `.github/workflows/ci.yml` (`npm ci`, `build`, `check`, `test`) in a throwaway [boat.dev](https://boat.dev) sandbox:

```bash
BOAT_API_KEY=boat_... scripts/boat-ci.sh 42          # a PR number, a branch, or a SHA (default: main)
BOAT_API_KEY=boat_... scripts/boat-ci.sh main --node 22.19   # pin the Node version ci.yml uses
```

It fetches the ref locally, uploads a `git archive` of it (the sandbox gets no GitHub token and none of the account's secrets), runs the steps, prints duration and cost, and always deletes the sandbox. With `gh` signed in it sets a `boat-ci` commit status; for a PR it also comments with the result and, on failure, the log tail. A full run takes about a minute on the `default` size (well under $0.01). Options: `--type small|default`, `--timeout MIN`, `--no-report`, `--comment`, `--log FILE`.

## Releasing

Bump every package to the same version, then push a matching tag (`git tag v0.1.0 && git push origin v0.1.0`). The Release workflow builds, tests and publishes all four `@runkiln/*` packages to npm (it needs the `NPM_TOKEN` secret), then creates the GitHub release.

A second job then builds the standalone binaries on macOS and attaches them and `SHA256SUMS` to that release. To build them yourself:

```bash
npm run build:binaries                                  # all five targets into dist/binaries/
node scripts/build-binaries.mjs --no-build --targets linux-x64,win-x64
```

They are Node [single executable applications](https://nodejs.org/api/single-executable-applications.html) (pinned Node 22.23.3, downloaded from nodejs.org and checked against its `SHA256SUMS`, cached in `~/.cache/runkiln-build`). Every target builds from any host; darwin binaries are re-signed ad hoc with `codesign` on macOS, or `rcodesign` when it is on PATH, and stay unsigned otherwise.

## License

MIT. Forked from [Pi](https://github.com/earendil-works/pi) (pi-mono) by Mario Zechner, MIT; both copyrights are in [LICENSE](LICENSE).
