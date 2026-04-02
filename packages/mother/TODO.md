# Mother — Future Work

## Deferred from Learning System (2026-04-02)

- **Event bus architecture** — Refactor the 4 learning modules (ratings, learning, wisdom, relationships) from inline function calls in agent.ts to an event emitter pattern. Do this when signal processing grows beyond these 4 features (e.g., tool usage analytics, session summaries, proactive suggestions). The modules stay the same, they just subscribe to events.

- **Embedding-based deduplication for relationship notes** — Currently uses substring match for dedup in mergeNotes(). Replace with embedding similarity (cosine >= 0.85 via inference server) for more robust matching.

- **Rename vendored packages** — After extraction from pi-mono, optionally rename `@mariozechner/*` imports to `@mother/*` or similar to make the separation from upstream explicit. Low priority — cosmetic, requires rewriting all import paths.

## Deferred from Extraction (2026-04-02)

- **Prune vendored packages** — After extracting pi-agent-core, pi-ai, and pi-coding-agent into the Mother repo, trim unused code. Mother uses a fraction of pi-ai (only Ollama/OpenAI-compatible provider, not Anthropic/Google/Mistral/Bedrock providers) and pi-coding-agent (only AgentSession, SessionManager, skills, not hooks/CLI/extensions). Pruning reduces maintenance surface.

## Infrastructure

- **Fix pre-commit hook TS errors** — The monorepo pre-commit runs type checks across all packages. pi-ai and pi-coding-agent tests have stale model ID literals that fail type checking. Fix or remove after extraction.

- **Inference server collections deployment** — Add `learnings` and `relationships` collection entries to `/etc/llama/collections.json` on the inference server and restart `llama-manager.service`.
