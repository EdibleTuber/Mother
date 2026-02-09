# Claude Code Project Notes

Read `AGENTS.md` first — it has the authoritative development rules.

## Project Overview

pi-mono is a TypeScript monorepo for AI agent tooling. Lockstep versioning (currently v0.51.6). All packages share the same version.

## Packages

| Package | What it does |
|---------|-------------|
| **ai** | Unified LLM API — multi-provider (Anthropic, OpenAI, Google, Mistral, Bedrock, Ollama, LM Studio) |
| **agent** | General-purpose agent core — transport abstraction, state management |
| **coding-agent** | The `pi` CLI — coding agent with read/bash/edit/write tools, session management |
| **tui** | Terminal UI library — differential rendering for text-based interfaces |
| **mom** | Slack bot — delegates to coding agent |
| **mother** | Discord bot — delegates to coding agent, runs on Raspberry Pi |
| **pods** | CLI for managing vLLM deployments on GPU pods |
| **web-ui** | Reusable web UI components for AI chat (Lit-based) |

## Build & Check

```bash
npm run check          # Biome lint/format + type check. Run after code changes. Fix ALL errors.
npm run build          # Build all packages (rarely needed, check is faster)
npm run build -w packages/<name>  # Build single package
npm test -- test/specific.test.ts  # Run specific test (from package root, not repo root)
```

**Never run:** `npm run dev`, `npm run build` (full), `npm test` (full) — see AGENTS.md.

## Code Style

- **Biome** is the sole formatter/linter (no Prettier, no ESLint)
- **Tabs** for indentation, indent width 3
- **Line width:** 120
- **No `any`** unless absolutely necessary
- **No inline imports** — always top-level
- **No emojis** in code, commits, or prose

## Tech Stack

- TypeScript 5.9+, Node.js >= 20
- **tsgo** for compilation (not tsc)
- **Vitest** for testing
- **Biome 2.3** for linting/formatting
- **Husky** pre-commit hook runs `npm run check`

## Mother (Discord Bot) — packages/mother

Runs on a Raspberry Pi, uses Ollama (glm-4.7-flash) by default. Key files:

- `src/agent.ts` — Main agent runner, model config, system prompt, event handling
- `src/discord.ts` — Discord client and message handling
- `src/tools/` — Mother-specific tools (bash, read, write, edit, attach)
- `src/sandbox.ts` — Docker/host execution sandbox
- `src/context.ts` — Session/settings management

### Mother Model Config

The fallback Ollama config in `agent.ts` has Mother-specific flags:
- `thinkingInText: true` — Strips "Thinking\n..." prefix from text output (for models that don't use thinking blocks)
- `intermediateToThread: true` — Routes intermediate messages (stopReason="toolUse") to Discord thread only
- `showThinkingInThread: false` — Whether to post thinking blocks to thread (always logged regardless)

These can be overridden per-model in `~/.pi/mother/models.json`.
