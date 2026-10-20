# Changelog

## [Unreleased]

## [0.1.3]

### Fixed

- Sessions with more than 8 images no longer fail with RunInfra's 400 "at most 8 images per request": only the newest 8 images are sent, older ones become a short placeholder.
- Auto mode keeps routing for the work in progress on "go on" or "continue", even after an "ok" or "thanks": approvals, retries and follow-ups inherit the last substantive task (its difficulty, kind and model) instead of the previous trivial turn, and chains of follow-ups no longer lose difficulty.

## [0.1.2]

### Added

- `glm-5-3` (GLM 5.3): $1.30 in, $4.20 out per M tokens, cached input $0.13, 1M context, text only, thinking low/high/max (`high` when nobody picks a level). Manual only: pick it with `/model` or `--model glm-5-3`; auto routing and failover never use it.
- `ornith-1-5-122b` (Ornith 1.5 122B): $0.20 in, $0.80 out per M tokens, cached input $0.02, 262K context and output, text and image input, tools and JSON mode, thinking off by default. Manual only: pick it with `/model` or `--model ornith-1-5-122b`; auto routing and failover never use it.

## [0.1.1]

First RunKiln release, forked from Pi (see NOTICE.md; Pi's own changelog is in docs/pi/).

### Added

- RunInfra as the only provider, with models from `models.yaml` and RunInfra's live catalog, and costs as billed by RunInfra.
- `auto` model router: picks the model and thinking level per turn (modes `auto:low`, `auto:medium`, `auto:high`, Alt+R to cycle), cache-aware and sticky, with failover. Classifier: Jev or an OpenRouter decision model.
- Permission modes `ask`, `read-write`, `auto` and `allow-all`, plan mode, saved allow/ask/deny rules, and approval prompts that show the diff or command.
- Full-screen setup wizard and the `/setup` hub (keys, model, routing, permissions, look, footer); `runkiln key` to manage keys from the shell.
- Turn checkpoints with `/undo` and `/rewind`, a changes tray with per-hunk review, `/review`, `/commit` and `--worktree`.
- Post-edit diagnostics, an optional verify loop that runs the project's tests, and a todo tool.
- `/usage` overlay, a usage ledger (`runkiln usage`) and session/daily budgets.
- Configurable footer, `/settings` in sections, timestamps, mouse and clickable UI, accessibility themes, terminal title and notifications.
- Image input from the clipboard, dragged-in paths and `@file`.
- Standalone binaries for Windows, Linux and macOS.

### Removed

- Pi's other providers, subagents and features RunKiln does not ship.
