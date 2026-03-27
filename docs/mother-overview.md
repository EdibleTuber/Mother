# Mother -- Operator Reference

## What is Mother

Mother is a Discord bot that runs on a Raspberry Pi 5 and delegates to an LLM-powered coding agent. The LLM inference runs on a separate server via Ollama. Mother was ported from `packages/mom` (a Slack bot) in the original `badlogic/pi-mono` repository and forked to `EdibleTuber/Mother`.

The bot manages per-channel agent sessions, executes tools (bash, file I/O, attach), maintains persistent memory, and runs scheduled events -- all orchestrated through Discord as the user interface.

## Architecture

```
Discord --> Pi 5 (Mother) --> Inference Server (192.168.1.14)
                |                    |
                |                    +-- Ollama (LLM inference)
                |                    +-- Tesla P40 (24GB VRAM)
                |
                +-- Per-channel agent sessions
                +-- Event scheduler (cron, one-shot, immediate)
                +-- Persistent memory (MEMORY.md files)
                +-- Tool execution (bash, read, write, edit, attach)
```

Mother runs as a Node.js process on the Pi. Discord messages arrive via the Discord.js client, get routed through an allowlist check and per-channel queue, then land in an agent session that calls the LLM and executes tool calls in a loop until the model produces a final text response.

## Message Flow

1. A Discord message arrives from a user.
2. The allowlist is checked (`MOTHER_ALLOWED_USERS`). Unauthorized users are ignored.
3. The message enters the channel queue. Only one message processes per channel at a time.
4. An agent session is created or resumed for that channel.
5. Missed messages (sent while the bot was offline or busy) are synced into context as log entries.
6. The system prompt is assembled: global memory + channel memory + MOTHER.md + workspace file tree + Discord user IDs + available skills + REFERENCE.md content.
7. The LLM is called via the configured provider (default: Ollama).
8. If the model returns tool calls, they are executed and results fed back. Tool details are logged to console only (not posted to Discord). A transient status message in the channel shows progress during tool use. This loops until the model produces a text response or hits a stop condition.
9. The final response replaces the transient status and is posted to the channel, split at 1900-character boundaries. No threads are auto-created.
10. Thread replies in Mother's threads route to the parent channel's runner (no @mention required).

## Tools

| Tool | What it does | Limits |
|------|-------------|--------|
| bash | Execute shell commands | Output truncated to last 2000 lines / 50KB |
| read | Read files (text and images as base64) | Truncated to first 2000 lines / 50KB |
| write | Create or overwrite files | Auto-creates parent directories |
| edit | Exact find-and-replace in files | Target string must match exactly once |
| attach | Upload files to Discord | Path-restricted in host mode |

Tool execution respects the command whitelist and path scoping configured via environment variables. In Docker sandbox mode, bash commands run inside the specified container.

## Memory and State

| File | Max Chars | Injected into prompt? | Purpose |
|------|-----------|----------------------|---------|
| MEMORY.md (workspace) | 1500 | Yes | Global memory shared across all channels |
| MEMORY.md (channel) | 1000 | Yes | Channel-specific memory |
| MOTHER.md | 3000 | Yes | Workspace guide -- users, projects, conventions |
| SYSTEM.md | -- | No (read on demand) | Environment modification log |
| REFERENCE.md | -- | No (auto-generated) | Events, skills, and log query reference |
| daily/YYYY-MM-DD.md | -- | No (grep-searchable) | Append-only daily logs |

Memory files are read at the start of each agent turn and included in the system prompt up to their character limits. Daily logs are never injected but can be searched via bash/grep.

## Events

Three event types exist:

- **Immediate**: fire as soon as the event file is created.
- **One-shot**: fire at a specific date/time.
- **Periodic**: fire on a cron schedule.

Events are stored as JSON files in `{workspace}/events/`. A maximum of 5 events can be queued per channel. Immediate and one-shot events auto-delete after firing. If an event handler returns a response starting with `[SILENT]`, no output is posted to Discord.

## Skills

Skills are custom CLI-style tools defined as markdown files with YAML frontmatter. They can be defined at two levels:

- **Workspace-level**: `{workspace}/skills/{name}/SKILL.md`
- **Channel-level**: `{channel}/skills/{name}/SKILL.md`

Channel-level skills override workspace-level skills when names collide. All discovered skills are listed in the system prompt with their descriptions, so the model knows they are available.

## Configuration Reference

### settings.json

All fields below live in `{workspace}/settings.json` and are loaded at startup. Missing fields use the listed defaults.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| defaultProvider | string | "ollama" | LLM provider |
| defaultModel | string | "Qwen3.5-35B-A3B-Uncensored-HauhauCS-Aggressive-Q4_K_M" | Model ID |
| ollamaUrl | string | "http://192.168.1.14:11434/v1" | Ollama API URL |
| modelsJsonPath | string | "~/.pi/mother/models.json" | Custom models config |
| contextWindow | number | 128000 | Context window size |
| maxTokens | number | 32768 | Max output tokens |
| defaultThinkingLevel | string | "off" | Thinking level |
| memory.globalMaxChars | number | 1500 | Global memory character limit |
| memory.channelMaxChars | number | 1000 | Channel memory character limit |
| memory.motherMaxChars | number | 3000 | MOTHER.md character limit |
| context.maxTurns | number | 10 | Max conversation turns kept in context |
| context.fileTreeMaxDepth | number | 4 | File tree depth in system prompt |
| context.fileTreeMaxEntries | number | 150 | File tree entry limit in system prompt |
| compaction.enabled | boolean | true | Auto-compact context when it grows large |
| compaction.reserveTokens | number | 16384 | Tokens reserved for model response |
| compaction.keepRecentTokens | number | 20000 | Recent tokens preserved during compaction |
| retry.enabled | boolean | true | Retry on LLM failure |
| retry.maxRetries | number | 3 | Max retry attempts |
| retry.baseDelayMs | number | 2000 | Base retry delay in ms |
| discord.editRateLimit | number | 1000 | Min ms between Discord message edits |
| discord.maxQueuedEvents | number | 5 | Max queued events per channel |
| tools.bashMaxLines | number | 2000 | Bash output line limit |
| tools.bashMaxBytes | number | 51200 | Bash output byte limit |
| events.debounceMs | number | 100 | Event file creation debounce |
| events.maxRetries | number | 3 | Event JSON parse retries |
| events.retryBaseMs | number | 100 | Event retry base delay |

### Environment Variables

These are set in the shell environment, never in settings.json.

**Required:**
- `DISCORD_BOT_TOKEN` -- Discord bot authentication token.
- `DISCORD_GUILD_ID` -- Discord server (guild) ID.

**Optional:**
- `MOTHER_ALLOWED_USERS` -- comma-separated Discord user IDs. If set, only these users can interact with the bot.
- `MOTHER_ALLOWED_PATHS` -- colon-separated additional paths the bot may access.
- `MOTHER_ALLOWED_COMMANDS` -- modify the command whitelist with `+cmd` to add or `-cmd` to remove.

**Model config overrides** (override corresponding settings.json fields):
- `MOTHER_MODEL_PROVIDER`
- `MOTHER_MODEL_ID`
- `MOTHER_OLLAMA_URL`
- `MOTHER_MODELS_JSON`

## Running Mother

```bash
# Discord mode
DISCORD_BOT_TOKEN=xxx DISCORD_GUILD_ID=xxx node dist/main.js /path/to/workspace

# CLI mode (no Discord, interactive terminal)
node dist/main.js --cli /path/to/workspace

# With Docker sandbox (bash commands run inside the container)
node dist/main.js --sandbox=docker:container-name /path/to/workspace
```

A convenience script exists at `packages/mother/dev.sh` for local development.

Build before running:

```bash
npm run build -w packages/mother
```

## Repository

| | |
|---|---|
| Fork | github.com/EdibleTuber/Mother |
| Upstream | github.com/badlogic/pi-mono |
| Package path | packages/mother |
| Original (Slack) | packages/mom |
