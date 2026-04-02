# Mother Learning System Design

**Date:** 2026-04-01
**Status:** Approved
**Scope:** packages/mother in pi-mono

## Overview

Add a continuous learning system to Mother, inspired by PAI's memory architecture but adapted for Mother's always-on Discord bot model and local inference constraints. Four integrated modules give Mother the ability to detect feedback, extract learnings, crystallize wisdom, and build per-user relationship profiles.

## Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Feedback detection | LLM sentiment inference per user message | Qwen 3.5 35B-A3B is cheap to run (MoE, ~3B active params); catches soft signals regex would miss |
| Learning trigger | Only on detected feedback | Keeps learning store high-signal; not every interaction has a lesson |
| Wisdom crystallization | Auto-detection + explicit promotion with pending/active gates | Auto finds patterns; user confirmation keeps wisdom clean |
| Relationship scope | Per-user across all channels | Household bot; user prefs should be global. Project context stays in channel MEMORY.md |
| Storage/retrieval split | Wisdom injected into prompt; learnings + relationships in inference server collections | Protects token budget; wisdom is small/high-value, rest is searched on-demand |
| Architecture | Integrated modules (functions called from agent.ts) | Follows Mother's existing patterns; event bus is future evolution when signal processing grows |
| Storage format | Markdown + YAML frontmatter (learnings, wisdom, relationships); JSONL (ratings) | Frontmatter enables inference server collection indexing with tag filtering |

## Storage Layout

```
{workspace}/
├── learnings/
│   └── {channelId}/
│       └── YYYY-MM-DD_HHmmss_{slug}.md
├── wisdom/
│   ├── active.md          # Injected into every prompt
│   ├── pending.md         # Candidates awaiting promotion
│   └── archive.md         # Demoted/superseded entries
├── relationships/
│   └── {userId}.md        # Per-user W/B/O profile
├── ratings/
│   └── {channelId}.jsonl  # Append-only rating log
├── MEMORY.md              # (existing, unchanged)
├── MOTHER.md              # (existing, unchanged)
└── settings.json          # (existing, extended)
```

## Module 1: Rating Capture (`src/ratings.ts`)

### Trigger

After every user message arrives, before the agent processes it.

### Flow

1. Read the user's message and the last assistant response (from run state or log.jsonl)
2. If this is the first message in a channel (no prior response), or the message is an image/attachment with no text, skip
3. Send a one-shot sentiment prompt to the inference server (same Ollama endpoint Mother uses)
4. Parse the JSON response
5. Append to `ratings/{channelId}.jsonl`
6. If `is_feedback` is true, trigger learning extraction (Module 2)

### Sentiment Prompt

```
Given this conversation exchange, assess if the user is giving feedback on the assistant's previous response.

Assistant said: "{last_response_summary}"
User said: "{user_message}"

Respond in JSON only:
{"is_feedback": bool, "rating": 1-10 or null, "sentiment": "positive"|"negative"|"neutral", "confidence": 0.0-1.0, "context": "brief explanation", "promotion_intent": bool}
```

### Rating Record Schema

```typescript
interface RatingRecord {
  ts: number;              // Unix timestamp
  userId: string;          // Discord user ID
  channelId: string;
  rating: number | null;   // 1-10 or null if not ratable
  sentiment: "positive" | "negative" | "neutral";
  confidence: number;      // 0.0-1.0
  context: string;         // Brief explanation from model
  promotionIntent: boolean; // User wants to promote insight to wisdom
}
```

### Integration Point

In `agent.ts` `run()` function, after user message is received but before `session.prompt()`. The sentiment call is async and non-blocking -- fire it off, store when it completes. Does not delay the agent's response.

### Error Handling

- Malformed JSON from model: log failure, don't store a rating
- Inference server unreachable: log warning, skip silently
- Rate limit: `maxLearningsPerDay` setting caps extraction volume

## Module 2: Learning Extraction (`src/learning.ts`)

### Trigger

Only when rating capture returns `is_feedback: true`.

### Flow

1. Gather recent conversation turns (last 3-5 exchanges from context.jsonl)
2. Send extraction prompt to inference server with the rating context
3. Write learning file to `learnings/{channelId}/`
4. After writing, trigger wisdom similarity check (Module 3)

### Extraction Prompt

```
A user rated the assistant's work {rating}/10 ({sentiment}).
Context: {rating_context}

Recent conversation:
{recent_turns}

Extract a concise learning from this interaction. Respond in JSON:
{"topic": "2-5 word topic", "insight": "what to do differently or keep doing", "category": "approach"|"communication"|"tool_use"|"knowledge", "tags": ["relevant", "tags"]}
```

### Learning File Format

```markdown
---
topic: file path resolution
category: approach
rating: 3
sentiment: negative
tags: [file-paths, workspace]
userId: "123"
channelId: "456"
timestamp: 2026-04-01T14:30:00Z
---

When resolving file paths in the workspace, always verify the file exists before referencing it. User was frustrated when given a path that didn't exist.
```

### Integration Point

Chained after rating capture. Non-blocking -- does not delay the agent's response.

### Collection Indexing

The inference server indexes `learnings/` as a collection. Frontmatter provides tags for filtered search. Mother searches past learnings via her existing `search` tool.

Collections config addition:
```json
{ "id": "learnings", "source_dir": "{workspace}/learnings", "doc_type": "markdown" }
```

## Module 3: Wisdom Crystallization (`src/wisdom.ts`)

### Two Promotion Paths

**Automatic candidate detection:**
1. After a learning is stored, call the inference server embeddings endpoint
2. Search the `learnings` collection for similar entries (cosine similarity >= 0.8)
3. If 3+ learnings cluster around the same topic, create a pending wisdom entry

**Explicit promotion:**
1. User says "remember that", "that's important", or similar
2. Detected via the sentiment prompt (add `promotion_intent: bool` to the rating schema)
3. Most recent learning or current insight promoted directly to pending at 85% confidence (immediately active since >= 80% threshold)

### Confidence Scoring

| Trigger | Starting Confidence |
|---|---|
| Auto-detected, 3 occurrences | 60% |
| Auto-detected, 5 occurrences | 75% |
| Each additional supporting learning | +5-10% |
| User confirmation of pending entry | Set to 90% |
| Explicit user promotion | 85% (immediately active) |

Pending entries promote to active when confidence >= 80%.

### Decay

If a wisdom entry is not reinforced by new learnings for 90 days, drop confidence by 10%. Falls below 50% → moved to `wisdom/archive.md`.

### Storage Format

`wisdom/active.md`:
```markdown
## File Path Verification [confidence: 92%]
Always verify files exist before referencing paths to the user. Learned from repeated negative feedback across multiple channels.
- Sources: 4 learnings (2026-03-15, 2026-03-20, 2026-03-28, 2026-04-01)
- Last updated: 2026-04-01

## Concise Responses Preferred [confidence: 85%]
Keep responses short and direct. User prefers actionable output over explanations.
- Sources: user-promoted (2026-03-25)
- Last updated: 2026-03-25
```

`wisdom/pending.md` follows the same format but with lower confidence scores.

### Prompt Injection

Full content of `wisdom/active.md` injected into `buildSystemPrompt()` alongside existing MEMORY.md sections. Capped at 500 chars (configurable via `wisdom.maxActiveChars`).

### Integration Points

- Similarity check: after learning is written, call embeddings endpoint against `learnings` collection
- Explicit promotion: detected in rating capture via `promotion_intent` field
- Prompt injection: `buildSystemPrompt()` reads `wisdom/active.md`
- Decay: checked on workspace bootstrap or periodically

## Module 4: Relationship Notes (`src/relationships.ts`)

### Trigger

After every completed run, if the conversation had 2+ user messages. Not feedback-gated -- relationship signals appear in normal conversation.

### Flow

1. After `await queueChain` completes in `agent.ts`
2. If the conversation had fewer than 2 user messages this run, skip
3. Send recent turns to inference server for extraction
4. Parse response, deduplicate against existing profile
5. Append or update `relationships/{userId}.md`

### Extraction Prompt

```
Analyze this conversation for information about the user that would be useful to remember across future conversations. Ignore project-specific or task-specific details.

User: {userName} ({userId})
Conversation:
{recent_turns}

Respond in JSON:
{"notes": [{"type": "W"|"B"|"O", "content": "the note", "confidence": 0.0-1.0}]}

Types:
- W (World): Objective facts about the user's situation, role, environment
- B (Biographical): What the user did or accomplished this session
- O (Opinion): User preferences, beliefs, or communication style
```

### Storage Format

`relationships/{userId}.md`:
```markdown
# User: edible (123456789)

## World
- Runs a Pi 5 homelab with inference server [confidence: 0.95] (2026-04-01)
- Uses Obsidian for knowledge management [confidence: 0.90] (2026-03-28)

## Biographical
- Set up collection-based retrieval on inference server (2026-04-01)
- Ported PAI learning features to Mother (2026-04-01)

## Opinions
- Prefers concise responses over verbose explanations [confidence: 0.85] (2026-03-25)
- Likes to understand systems before adopting them wholesale [confidence: 0.80] (2026-04-01)
```

### Deduplication

Before appending, check existing entries. If a new note is substantially similar to an existing one (same type, similar content -- use embedding similarity >= 0.85), update the timestamp and confidence rather than duplicating.

### Collection Indexing

```json
{ "id": "relationships", "source_dir": "{workspace}/relationships", "doc_type": "markdown" }
```

Not injected into every prompt. Searched on-demand when context about a user would help.

### Integration Point

Post-run in `agent.ts`, after `await queueChain`, before state cleanup. Non-blocking.

## Configuration

Extensions to workspace `settings.json`:

```json
{
  "learning": {
    "enabled": true,
    "sentimentModel": null,
    "ratingsPerChannel": true,
    "extractionMinTurns": 1,
    "maxLearningsPerDay": 20
  },
  "wisdom": {
    "enabled": true,
    "maxActiveChars": 500,
    "promotionThreshold": 0.80,
    "explicitPromotionConfidence": 0.85,
    "clusterSimilarityThreshold": 0.80,
    "clusterMinOccurrences": 3,
    "decayDays": 90,
    "decayAmount": 0.10
  },
  "relationships": {
    "enabled": true,
    "minTurnsForExtraction": 2,
    "deduplicationThreshold": 0.85
  }
}
```

`sentimentModel: null` means use the same model Mother already runs. Can be overridden to point at a different model.

Each feature has an `enabled` flag for incremental rollout or disabling if misbehaving.

## Workspace Bootstrap

`bootstrapWorkspace()` in `agent.ts` extended to create:
- `learnings/`
- `wisdom/` (with empty `active.md`, `pending.md`, `archive.md`)
- `relationships/`
- `ratings/`

## System Prompt Changes

`buildSystemPrompt()` extended with:

1. **Wisdom section** (always injected):
   ```
   ## Learned Wisdom
   {contents of wisdom/active.md, capped at maxActiveChars}
   ```

2. **Learning system awareness** (static text):
   ```
   ## Feedback & Learning
   You have a learning system that captures feedback from users. When a user explicitly
   asks you to "remember that" or says something is important, it will be promoted to
   your wisdom. You can search past learnings and relationship notes via the search tool
   using the "learnings" and "relationships" collections.
   ```

## Inference Server Collections

Two new entries in `/etc/llama/collections.json`:

```json
{ "id": "learnings", "source_dir": "{workspace}/learnings", "doc_type": "markdown" },
{ "id": "relationships", "source_dir": "{workspace}/relationships", "doc_type": "markdown" }
```

Wisdom is not indexed -- it's small, always injected, single file.

## Future Direction

**Event bus migration:** If signal processing grows beyond these 4 features (e.g., tool usage analytics, session summaries, proactive suggestions), refactor the inline module calls into a lightweight event emitter. The modules stay the same -- they subscribe to events instead of being called directly from agent.ts. The current design keeps each feature in its own module, making this a clean refactor when the time comes.
