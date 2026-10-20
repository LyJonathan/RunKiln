# Security

## Reporting a vulnerability

Report it privately through GitHub: **Security > Report a vulnerability** on this repository (a private security advisory). Don't open a public issue for a vulnerability. Include the RunKiln version (`runkiln --version`), your OS and shell, the permission mode, and the smallest repro you have. Expect a first answer within a week.

Supported versions: the latest release only.

## Threat model

RunKiln runs an AI agent that reads files, edits them and runs commands as you, with your environment and network. The agent can be steered by text it reads (prompt injection): a README, a web page, an MCP result, a dependency's source. RunKiln assumes:

- **The model may be hostile.** Any tool call can be what an attacker wants. The permission gate decides what runs without you.
- **A repository may be hostile.** Cloning one and starting RunKiln in it must not run its code. Project config (`.runkiln/`, hooks, MCP servers, skills) loads only after you trust the folder, and hooks and MCP servers need a second approval of their exact commands.
- **You are trusted**, and so is your global config in `~/.runkiln/agent`.

Out of scope: a compromised machine or user account, a malicious RunInfra or model provider, and anything you approve or run in `allow-all` mode.

### What protects you

| Layer | What it does |
|---|---|
| Permission gate | Every tool call except the built-in read-only tools goes through it. Deny rules beat everything; a project can only add ask and deny rules. Modes: `ask`, `read-write` (default), `plan`, `auto`, `allow-all`. |
| Global-only settings | `shellPath`, `shellCommandPrefix`, `externalEditor`, `editor` (click-to-open command), `npmCommand`, `sessionDir`, `sessionShareDestination`, `httpProxy`, `defaultProjectTrust`, `shellEnvironment`, the permission mode and `readsOutsideProject` are read from global settings only. A project value is ignored with a warning. Startup reads no project settings before the trust decision. |
| Protected files | Writes to `.git/**`, `.runkiln/**`, `.mcp.json`, `.agents/**`, other agents' folders (`.claude`, `.cursor`, `.gemini`, `.codex`, `.opencode`), CI workflows, git hook config (`.husky`, pre-commit, lefthook), `package.json`, build and test configs (`*.config.*`, `conftest.py`, `Makefile`, `build.rs` and similar), editor and dev container config and shell startup files always ask. |
| Shell analysis | Chains, `$(...)` and PowerShell expressions are split and checked part by part. PowerShell grouping, script blocks, `--%` and `-EncodedCommand` never match a prefix rule and never pass the auto pre-pass. It is a guard rail, not a sandbox. |
| Write then run | After the agent edits a file a test runner or build executes, the next runner command goes to the decision model or asks. `npx`, `bunx` and `pnpx` are never pre-allowed. |
| Secret reads | Reading a credentials file (SSH keys, `.env`, cloud CLI credentials and similar, matched on the real path after links) asks in every mode except `allow-all`. Reads outside the project ask by default (`permissions.readsOutsideProject`). RunKiln's own key files are refused. `grep` and `find` skip `.env*` unless asked for them. |
| Environment | RunKiln's own keys never reach commands, hooks or MCP servers. Variables named like secrets (`*KEY*`, `*SECRET*`, `*TOKEN*`, `*PASSWORD*`, `*PASSWD*`, `*CREDENTIAL*`) are hidden from commands unless `shellEnvironment.include` lists them. Stdio MCP servers get only a minimal environment plus the variables they declare. |
| Trust prompts | Hook and MCP trust prompts show the full command, every argument, cwd, env and headers, with terminal escapes and invisible characters made visible. A project MCP config can't expand secret-looking variables. |
| Private storage | `~/.runkiln/agent` and a custom session folder are 0700, files in them 0600 (existing installs are fixed at startup). On Windows the agent folder gets one inherited ACL for the current user's SID. A deleted session's checkpoints go with it. |
| Redaction | RunKiln's keys, secret-looking environment values and common token formats (`sk-`, `ghp_`, `github_pat_`, `xox?-`, `AKIA`, JWTs, private key blocks, `boat_`, bearer tokens, URL passwords) are redacted from session files, exports and decision-model requests. The running session keeps the originals; a resumed one does not. |
| Untrusted content | MCP results and files read from outside the project reach the model inside `<untrusted source="...">` blocks, and the system prompt says text inside them is data. Unicode tag characters are stripped from read files and MCP output. |
| Downloads | `rg` and `fd` are downloaded at pinned versions and checked against SHA-256 hashes before they are installed. Self-update runs package managers with `--ignore-scripts`. |

### Known gaps

- No OS sandbox yet. An approved command can read and write anything you can and reach any host.
- Hard links inside the project are not detected.
- Redaction only knows the formats and values listed above. A secret in another format can still reach the model provider and the session file.
- Prompt injection is mitigated, not solved. The untrusted markers help the model; they don't stop it.

## Compared to Pi

RunKiln is a fork of [Pi](https://github.com/earendil-works/pi). Pi's security page says Pi does not ask before tool calls, extensions run in-process, and prompt injection and sandboxing are outside its security boundary; it recommends running in a container. RunKiln keeps the container advice for `allow-all` and adds:

| | Pi | RunKiln |
|---|---|---|
| Approval before tool calls | No | Yes, every call except the built-in read-only tools |
| Extensions and packages | In-process extensions, npm and git packages | Removed |
| Project settings that pick programs (`shellPath`, `shellCommandPrefix`, editor, npm) | Project can set them | Global only |
| `sessionDir` read before trust | Yes (documented) | No |
| Agent writing its own config (`.runkiln/**`, `.mcp.json`, skills) | Allowed | Asks |
| Secrets in the shell environment | Inherited | Hidden by default, opt in per name |
| MCP server environment | Full environment | Minimal plus declared variables |
| Session and checkpoint files | Default umask (0644, 0755) | 0600 and 0700 |
| Redaction | None | Session files, exports, decision-model requests |
| `rg`/`fd` downloads | Latest release, unverified | Pinned, SHA-256 checked |
