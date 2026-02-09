# Mother: Design Document

## 1. Current State

### 1.1 What Mother Is

Mother is a Discord bot that delegates messages to an LLM-powered coding agent. She runs on a Raspberry Pi 5, listens to Discord, and uses Ollama (on a remote inference server) for LLM reasoning. She can execute shell commands, read/write/edit files, upload attachments, schedule events, and maintain persistent memory across conversations.

Mother was ported from `packages/mom` (a Slack bot) to Discord.

### 1.2 Architecture

```
Discord ──> Pi 5 (Mother) ──> Ollama (192.168.1.41)
                │
                ├── Per-channel agent sessions
                ├── Event scheduler (cron, one-shot, immediate)
                ├── Persistent memory (MEMORY.md)
                └── Tool execution (bash, read, write, edit, attach)
```

### 1.3 Runtime Environment

| Component | Location | Specs |
|-----------|----------|-------|
| Mother (bot process) | Pi 5 | ARM64, 4-8GB RAM, Ubuntu |
| Ollama (inference) | Inference server | x86, 32GB RAM, Tesla P40 (24GB VRAM), Ubuntu headless |
| Discord API | Cloud | External service |

### 1.4 Source Files

| File | Purpose |
|------|---------|
| `main.ts` | Entry point, CLI mode, Discord mode routing, per-channel state |
| `agent.ts` | Model resolution, AgentRunner/AgentSession creation, tool event handling, system prompt |
| `discord.ts` | Discord.js client, message handling, per-channel queue, attachment downloads |
| `store.ts` | Channel directories, log.jsonl writing, attachment management |
| `context.ts` | Session context sync (log.jsonl <-> context.jsonl), settings manager |
| `events.ts` | File-based event scheduler (immediate, one-shot, periodic/cron) |
| `sandbox.ts` | Execution abstraction (host shell vs docker container) |
| `log.ts` | Structured console logging with colors and timestamps |
| `tools/bash.ts` | Shell command execution with truncation |
| `tools/read.ts` | File reading with image support (base64) |
| `tools/write.ts` | File creation/overwrite |
| `tools/edit.ts` | Surgical text replacement with diff output |
| `tools/attach.ts` | File upload to Discord |
| `tools/truncate.ts` | Output truncation utilities |

### 1.5 Capabilities

**Tools:**
- `bash` - Execute shell commands (output truncated to 2000 lines / 50KB)
- `read` - Read files (text + images as base64)
- `write` - Create/overwrite files
- `edit` - Find-and-replace text in files
- `attach` - Upload files to Discord

**Memory:**
- `<workspace>/MEMORY.md` - Global workspace memory (max 1500 chars, injected every turn)
- `<workspace>/<channel>/MEMORY.md` - Channel-specific memory (max 1000 chars, injected every turn)
- `<workspace>/SYSTEM.md` - Environment modification log (read on demand, NOT injected)

**Workspace Files:**
- `<workspace>/MOTHER.md` - Workspace guide: users, projects, quick reference (injected, max 3000 chars). Scaffolded with template on first bootstrap.
- `<workspace>/REFERENCE.md` - Auto-generated reference docs: events, skills creation, log queries, system config. NOT injected. Read on demand. Regenerated each run.
- `<workspace>/<channel>/daily/` - Append-only daily logs (`YYYY-MM-DD.md`). NOT injected. Grep-searchable temporal memory.

**Skills (custom CLI tools):**
- Workspace-level: `<workspace>/skills/<name>/SKILL.md`
- Channel-level: `<workspace>/<channel>/skills/<name>/SKILL.md`
- Auto-discovered and listed in system prompt
- Channel skills override workspace skills on name collision

**Events:**
- `immediate` - Triggers on file creation (webhooks, external signals)
- `one-shot` - Triggers at specific ISO 8601 time (reminders)
- `periodic` - Cron-scheduled with IANA timezone (recurring tasks)
- Stored as JSON files in `<workspace>/events/`
- Max 5 queued events; immediate/one-shot auto-delete after firing
- `[SILENT]` response marker suppresses Discord output

**Session Management:**
- Dual log system: `context.jsonl` (API messages) + `log.jsonl` (human-readable)
- Message sync: pulls missed messages from log.jsonl into context on each run
- Auto-compaction when context window fills
- Per-channel runner caching (one AgentSession per channel, persistent)

**Discord Integration:**
- Responds to @mentions and DMs
- Per-channel sequential queue (max 5 pending)
- `stop` command aborts running task
- Tool results posted to message threads
- Long responses split at 1900 chars (Discord limit)
- Attachment download from Discord CDN
- User/channel ID mapping in system prompt

**Sandbox:**
- `--sandbox=host` - Direct execution on host machine
- `--sandbox=docker:<name>` - Execute inside named Docker container
- Path translation between host and container (`/workspace`)

### 1.6 Configuration

**Environment Variables:**
| Variable | Default | Required |
|----------|---------|----------|
| `DISCORD_BOT_TOKEN` | - | Yes (Discord mode) |
| `DISCORD_GUILD_ID` | - | Yes (Discord mode) |
| `MOTHER_MODEL_PROVIDER` | `ollama` | No |
| `MOTHER_MODEL_ID` | `qwen3:30b-a3b` | No |
| `MOTHER_OLLAMA_URL` | `http://192.168.1.41:11434/v1` | No |
| `MOTHER_MODELS_JSON` | `~/.pi/mother/models.json` | No |

### 1.7 Known Limitations

- **Single-threaded per channel** - One task at a time per channel, queued
- **No sub-task delegation** - Mother does everything herself, no parallel work
- **Host sandbox is unrestricted** - No isolation; a bad command can damage the host
- **Model quality** - Local model (qwen3:30b-a3b) acts as dispatcher, delegating complex work to Claude Code
- **No internet tools** - No web search, no HTTP requests (only via bash + curl)
- **Discord rate limits** - Message edits throttled, long tool chains can be slow to display
- **No vector search** - Memory search uses grep over flat files. Vector search (e.g., `nomic-embed-text` on the remote Ollama server) is viable since the Pi doesn't run the LLM locally, but not needed at current scale. Revisit if daily logs grow beyond what grep can efficiently search.

### 1.8 System Prompt Token Budget

For a 7B model, every token in the system prompt competes with conversation quality. Reference material is moved to REFERENCE.md (read on demand) to minimize injected tokens.

| Component | Max Chars | ~Tokens | Injected? |
|-----------|-----------|---------|-----------|
| Static rules (identity, discord, env, layout) | ~2200 | ~550 | Yes |
| MOTHER.md | 3000 | ~750 | Yes |
| Global memory | 1500 | ~375 | Yes |
| Channel memory | 1000 | ~250 | Yes |
| File tree | ~500-1000 | ~150-250 | Yes (capped) |
| Discord IDs | ~500-1500 | ~250-375 | Yes (dynamic) |
| REFERENCE.md | ~3400 | ~850 | No (on-demand) |
| **Total injected** | | **~2325-2550** | |

---

## 2. Future: Chick Architecture

### 2.1 Vision

Mother becomes an **orchestrator** that spawns disposable **chick** containers on the inference server for actual work. Mother handles Discord interaction, task routing, and state. Chicks handle execution.

```
Discord ──> Pi 5 (Mother)
              │
              │  SSH / Docker API
              ▼
        Inference Server (192.168.1.41)
        ├── Ollama (LLM inference)
        ├── chick-1 (container) ── task A
        ├── chick-2 (container) ── task B
        └── chick-3 (container) ── task C
```

### 2.2 What Is a Chick?

A chick is a **disposable Docker container** running a headless agent loop:
- Receives a goal from Mother
- Has its own LLM context and tool set
- Works autonomously (bash, read, write, edit)
- Reports results back to Mother
- Gets destroyed when done (or on timeout)

### 2.3 Why Chicks?

| Problem | Solution |
|---------|----------|
| Mother is single-threaded per channel | Chicks work in parallel |
| Host sandbox is dangerous | Chicks are isolated and disposable |
| Complex tasks block the channel | Chick works in background, Mother stays responsive |
| One model for everything | Mother uses cheap/fast model, chicks use Claude for hard tasks |

### 2.4 Resource Budget

**Inference Server (192.168.1.41):**
- 32GB RAM, Tesla P40 (24GB VRAM), Ubuntu headless
- Ollama: ~4-8GB VRAM (model dependent), ~2GB system RAM
- Remaining: ~22GB system RAM for containers
- Each chick: ~500MB-2GB depending on task
- Comfortable capacity: **5-10 concurrent chicks**

**Pi 5 (Mother):**
- Stays lightweight: Discord client + orchestration logic
- ~150-200MB RAM usage
- No LLM inference, no heavy execution

### 2.5 Model Tiering

| Role | Model | Cost | Use Case |
|------|-------|------|----------|
| Mother (routing, chat) | GLM-4.7-Flash (local) | Free | Simple chat, task parsing, status updates |
| Chick (complex reasoning) | Claude API | Per-token | Coding, analysis, multi-step planning |
| Chick (simple execution) | qwen3:14b (local) | Free | File ops, scripting, grep/search |

Mother can decide which model a chick gets based on task complexity.

### 2.6 Chick Lifecycle

```
1. User asks Mother to do something complex
2. Mother creates a chick:
   - Docker container on inference server
   - Mounted workspace volume
   - Goal description + relevant context
   - Model assignment (local or Claude)
3. Chick works autonomously:
   - Runs agent loop with tools
   - Writes results to workspace
4. Chick reports completion:
   - Exit code + summary
   - Output files in workspace
5. Mother reads results and responds to user
6. Container destroyed
```

### 2.7 Open Design Questions

- **Communication protocol**: How does Mother send goals and receive results? SSH + Docker API? HTTP callback? Shared filesystem?
- **Context sharing**: Does Mother pass conversation history to chicks, or just a goal string?
- **Chick visibility**: Should users see chick activity in Discord threads? Real-time streaming?
- **Error handling**: What if a chick hangs or crashes? Timeout + cleanup?
- **State persistence**: Are chick workspaces ephemeral or preserved for inspection?
- **Chick images**: One base image for all, or specialized images per task type?
- **Concurrency limits**: Hard cap on active chicks? Per-user limits?
- **Cost control**: How to prevent runaway Claude API usage?
