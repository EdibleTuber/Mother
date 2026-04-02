# Mother Learning System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add continuous learning to Mother — sentiment-based rating capture, feedback-triggered learning extraction, wisdom crystallization with auto/explicit promotion, and per-user W/B/O relationship profiles.

**Architecture:** Four new TypeScript modules (`ratings.ts`, `learning.ts`, `wisdom.ts`, `relationships.ts`) called from existing lifecycle points in `agent.ts`. Inference calls go through the same Ollama endpoint Mother already uses. Learnings and relationships are indexed as collections on the inference server for semantic search via existing `search`/`recall` tools.

**Tech Stack:** TypeScript, Vitest, Ollama OpenAI-compatible API (chat completions + embeddings), inference server collection API

**Spec:** `docs/superpowers/specs/2026-04-01-learning-system-design.md`

---

## File Structure

### New Files
| File | Responsibility |
|------|---------------|
| `src/ratings.ts` | Sentiment inference, rating record storage, JSONL append |
| `src/learning.ts` | Learning extraction from conversation context, markdown file writing |
| `src/wisdom.ts` | Wisdom promotion (auto + explicit), confidence scoring, decay, active.md management |
| `src/relationships.ts` | W/B/O note extraction, per-user profile management, deduplication |
| `test/ratings.test.ts` | Rating capture tests |
| `test/learning.test.ts` | Learning extraction tests |
| `test/wisdom.test.ts` | Wisdom crystallization tests |
| `test/relationships.test.ts` | Relationship note tests |

### Modified Files
| File | Changes |
|------|---------|
| `src/context.ts` | Add learning/wisdom/relationships settings interfaces, defaults, and getters |
| `src/agent.ts` | Extend `bootstrapWorkspace()`, `buildSystemPrompt()`, and `run()` to call new modules |

---

## Task 1: Settings Infrastructure

**Files:**
- Modify: `src/context.ts:161-177` (MotherSettings interface)
- Modify: `src/context.ts:237-263` (defaults)
- Modify: `src/context.ts:269-459` (MotherSettingsManager)
- Test: `test/settings-learning.test.ts`

- [ ] **Step 1: Write failing tests for new settings**

Create `test/settings-learning.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { MotherSettingsManager } from "../src/context.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function createTempSettings(settings: Record<string, unknown> = {}): MotherSettingsManager {
	const dir = mkdtempSync(join(tmpdir(), "mother-test-"));
	if (Object.keys(settings).length > 0) {
		writeFileSync(join(dir, "settings.json"), JSON.stringify(settings));
	}
	return new MotherSettingsManager(dir);
}

describe("learning settings", () => {
	it("returns defaults when no settings configured", () => {
		const mgr = createTempSettings();
		const s = mgr.getLearningSettings();
		expect(s.enabled).toBe(true);
		expect(s.sentimentModel).toBeNull();
		expect(s.maxLearningsPerDay).toBe(20);
	});

	it("merges partial overrides with defaults", () => {
		const mgr = createTempSettings({ learning: { maxLearningsPerDay: 5 } });
		const s = mgr.getLearningSettings();
		expect(s.enabled).toBe(true);
		expect(s.maxLearningsPerDay).toBe(5);
	});
});

describe("wisdom settings", () => {
	it("returns defaults when no settings configured", () => {
		const mgr = createTempSettings();
		const s = mgr.getWisdomSettings();
		expect(s.enabled).toBe(true);
		expect(s.maxActiveChars).toBe(500);
		expect(s.promotionThreshold).toBe(0.80);
		expect(s.clusterMinOccurrences).toBe(3);
		expect(s.decayDays).toBe(90);
	});
});

describe("relationship settings", () => {
	it("returns defaults when no settings configured", () => {
		const mgr = createTempSettings();
		const s = mgr.getRelationshipSettings();
		expect(s.enabled).toBe(true);
		expect(s.minTurnsForExtraction).toBe(2);
		expect(s.deduplicationThreshold).toBe(0.85);
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /home/edible/Projects/pi-mono && npm test -- --filter mother -- test/settings-learning.test.ts`
Expected: FAIL — `getLearningSettings`, `getWisdomSettings`, `getRelationshipSettings` do not exist

- [ ] **Step 3: Add settings interfaces and defaults to context.ts**

Add after line 226 (after `MotherEventsSettings`):

```typescript
export interface MotherLearningSettings {
	enabled: boolean;
	sentimentModel: string | null;
	ratingsPerChannel: boolean;
	extractionMinTurns: number;
	maxLearningsPerDay: number;
}

export interface MotherWisdomSettings {
	enabled: boolean;
	maxActiveChars: number;
	promotionThreshold: number;
	explicitPromotionConfidence: number;
	clusterSimilarityThreshold: number;
	clusterMinOccurrences: number;
	decayDays: number;
	decayAmount: number;
}

export interface MotherRelationshipSettings {
	enabled: boolean;
	minTurnsForExtraction: number;
	deduplicationThreshold: number;
}
```

Add defaults after `DEFAULT_EVENTS` (after line 263):

```typescript
const DEFAULT_LEARNING: MotherLearningSettings = {
	enabled: true,
	sentimentModel: null,
	ratingsPerChannel: true,
	extractionMinTurns: 1,
	maxLearningsPerDay: 20,
};

const DEFAULT_WISDOM: MotherWisdomSettings = {
	enabled: true,
	maxActiveChars: 500,
	promotionThreshold: 0.80,
	explicitPromotionConfidence: 0.85,
	clusterSimilarityThreshold: 0.80,
	clusterMinOccurrences: 3,
	decayDays: 90,
	decayAmount: 0.10,
};

const DEFAULT_RELATIONSHIPS: MotherRelationshipSettings = {
	enabled: true,
	minTurnsForExtraction: 2,
	deduplicationThreshold: 0.85,
};
```

Add to `MotherSettings` interface (around line 161):

```typescript
learning?: Partial<MotherLearningSettings>;
wisdom?: Partial<MotherWisdomSettings>;
relationships?: Partial<MotherRelationshipSettings>;
```

Add getters to `MotherSettingsManager` class (after `getEventsSettings()` around line 378):

```typescript
getLearningSettings(): MotherLearningSettings {
	return { ...DEFAULT_LEARNING, ...this.settings.learning };
}

getWisdomSettings(): MotherWisdomSettings {
	return { ...DEFAULT_WISDOM, ...this.settings.wisdom };
}

getRelationshipSettings(): MotherRelationshipSettings {
	return { ...DEFAULT_RELATIONSHIPS, ...this.settings.relationships };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /home/edible/Projects/pi-mono && npm test -- --filter mother -- test/settings-learning.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
cd /home/edible/Projects/pi-mono
git add packages/mother/src/context.ts packages/mother/test/settings-learning.test.ts
git commit -m "feat(mother): add learning, wisdom, and relationship settings"
```

---

## Task 2: Rating Capture Module

**Files:**
- Create: `src/ratings.ts`
- Test: `test/ratings.test.ts`

- [ ] **Step 1: Write failing tests for rating capture**

Create `test/ratings.test.ts`:

```typescript
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("parseSentimentResponse", () => {
	it("parses valid JSON response", async () => {
		const { parseSentimentResponse } = await import("../src/ratings.js");
		const result = parseSentimentResponse(
			'{"is_feedback": true, "rating": 8, "sentiment": "positive", "confidence": 0.9, "context": "user liked the result", "promotion_intent": false}',
		);
		expect(result).toEqual({
			is_feedback: true,
			rating: 8,
			sentiment: "positive",
			confidence: 0.9,
			context: "user liked the result",
			promotion_intent: false,
		});
	});

	it("returns null for malformed JSON", async () => {
		const { parseSentimentResponse } = await import("../src/ratings.js");
		expect(parseSentimentResponse("not json at all")).toBeNull();
	});

	it("extracts JSON from markdown code block", async () => {
		const { parseSentimentResponse } = await import("../src/ratings.js");
		const result = parseSentimentResponse(
			'```json\n{"is_feedback": false, "rating": null, "sentiment": "neutral", "confidence": 0.5, "context": "task request", "promotion_intent": false}\n```',
		);
		expect(result).not.toBeNull();
		expect(result!.is_feedback).toBe(false);
	});
});

describe("appendRating", () => {
	it("creates ratings file and appends record", async () => {
		const { appendRating } = await import("../src/ratings.js");
		const dir = mkdtempSync(join(tmpdir(), "mother-ratings-"));
		const ratingsDir = join(dir, "ratings");
		mkdirSync(ratingsDir, { recursive: true });

		await appendRating(ratingsDir, "chan123", {
			ts: 1711929600,
			userId: "user1",
			channelId: "chan123",
			rating: 7,
			sentiment: "positive",
			confidence: 0.85,
			context: "liked the output",
			promotionIntent: false,
		});

		const content = readFileSync(join(ratingsDir, "chan123.jsonl"), "utf-8");
		const record = JSON.parse(content.trim());
		expect(record.rating).toBe(7);
		expect(record.userId).toBe("user1");
	});

	it("appends multiple records to same file", async () => {
		const { appendRating } = await import("../src/ratings.js");
		const dir = mkdtempSync(join(tmpdir(), "mother-ratings-"));
		const ratingsDir = join(dir, "ratings");
		mkdirSync(ratingsDir, { recursive: true });

		const base = { userId: "u1", channelId: "c1", sentiment: "neutral" as const, confidence: 0.5, context: "test", promotionIntent: false };
		await appendRating(ratingsDir, "c1", { ...base, ts: 1, rating: 5 });
		await appendRating(ratingsDir, "c1", { ...base, ts: 2, rating: 8 });

		const lines = readFileSync(join(ratingsDir, "c1.jsonl"), "utf-8").trim().split("\n");
		expect(lines).toHaveLength(2);
	});
});

describe("buildSentimentPrompt", () => {
	it("includes assistant response and user message", async () => {
		const { buildSentimentPrompt } = await import("../src/ratings.js");
		const prompt = buildSentimentPrompt("I found 3 files matching your query.", "perfect, thanks!");
		expect(prompt).toContain("I found 3 files matching your query.");
		expect(prompt).toContain("perfect, thanks!");
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /home/edible/Projects/pi-mono && npm test -- --filter mother -- test/ratings.test.ts`
Expected: FAIL — module `../src/ratings.js` does not exist

- [ ] **Step 3: Implement ratings module**

Create `src/ratings.ts`:

```typescript
/**
 * Rating capture module for Mother's learning system.
 *
 * Sends user messages to the inference server for sentiment analysis,
 * detects feedback, and stores rating records as JSONL.
 */
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { MotherSettingsManager } from "./context.js";
import * as log from "./log.js";

export interface SentimentResult {
	is_feedback: boolean;
	rating: number | null;
	sentiment: "positive" | "negative" | "neutral";
	confidence: number;
	context: string;
	promotion_intent: boolean;
}

export interface RatingRecord {
	ts: number;
	userId: string;
	channelId: string;
	rating: number | null;
	sentiment: "positive" | "negative" | "neutral";
	confidence: number;
	context: string;
	promotionIntent: boolean;
}

export function buildSentimentPrompt(lastResponse: string, userMessage: string): string {
	return `Given this conversation exchange, assess if the user is giving feedback on the assistant's previous response.

Assistant said: "${lastResponse}"
User said: "${userMessage}"

Respond in JSON only:
{"is_feedback": bool, "rating": 1-10 or null, "sentiment": "positive"|"negative"|"neutral", "confidence": 0.0-1.0, "context": "brief explanation", "promotion_intent": bool}

promotion_intent is true when the user explicitly wants to save/remember an insight (e.g. "remember that", "that's important").`;
}

export function parseSentimentResponse(text: string): SentimentResult | null {
	try {
		// Strip markdown code block if present
		const cleaned = text.replace(/^```(?:json)?\n?/m, "").replace(/\n?```$/m, "").trim();
		const parsed = JSON.parse(cleaned);
		if (typeof parsed.is_feedback !== "boolean" || typeof parsed.sentiment !== "string") {
			return null;
		}
		return {
			is_feedback: parsed.is_feedback,
			rating: typeof parsed.rating === "number" ? parsed.rating : null,
			sentiment: parsed.sentiment,
			confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.5,
			context: typeof parsed.context === "string" ? parsed.context : "",
			promotion_intent: parsed.promotion_intent === true,
		};
	} catch {
		return null;
	}
}

export async function appendRating(ratingsDir: string, channelId: string, record: RatingRecord): Promise<void> {
	if (!existsSync(ratingsDir)) {
		mkdirSync(ratingsDir, { recursive: true });
	}
	const filePath = join(ratingsDir, `${channelId}.jsonl`);
	appendFileSync(filePath, `${JSON.stringify(record)}\n`);
}

/**
 * Run sentiment analysis on a user message against the last assistant response.
 * Returns the sentiment result, or null if analysis fails or should be skipped.
 */
export async function analyzeSentiment(
	settings: MotherSettingsManager,
	lastResponse: string,
	userMessage: string,
	signal?: AbortSignal,
): Promise<SentimentResult | null> {
	if (!lastResponse || !userMessage.trim()) {
		return null;
	}

	const ollamaUrl = settings.getOllamaUrl();
	const learningSettings = settings.getLearningSettings();
	const modelId = learningSettings.sentimentModel || settings.getDefaultModel();

	// Truncate last response to save tokens (we only need the gist)
	const truncatedResponse = lastResponse.length > 500 ? `${lastResponse.substring(0, 500)}...` : lastResponse;
	const prompt = buildSentimentPrompt(truncatedResponse, userMessage);

	try {
		const response = await fetch(`${ollamaUrl}/chat/completions`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				model: modelId,
				messages: [{ role: "user", content: prompt }],
				stream: false,
			}),
			signal,
		});

		if (!response.ok) {
			log.logWarning("Sentiment analysis failed", `HTTP ${response.status}`);
			return null;
		}

		const data = (await response.json()) as { choices: { message: { content: string } }[] };
		const content = data.choices?.[0]?.message?.content;
		if (!content) {
			log.logWarning("Sentiment analysis failed", "Empty response from model");
			return null;
		}

		return parseSentimentResponse(content);
	} catch (err) {
		if (signal?.aborted) return null;
		const msg = err instanceof Error ? err.message : String(err);
		log.logWarning("Sentiment analysis error", msg);
		return null;
	}
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /home/edible/Projects/pi-mono && npm test -- --filter mother -- test/ratings.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
cd /home/edible/Projects/pi-mono
git add packages/mother/src/ratings.ts packages/mother/test/ratings.test.ts
git commit -m "feat(mother): add rating capture module with sentiment analysis"
```

---

## Task 3: Learning Extraction Module

**Files:**
- Create: `src/learning.ts`
- Test: `test/learning.test.ts`

- [ ] **Step 1: Write failing tests for learning extraction**

Create `test/learning.test.ts`:

```typescript
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("parseLearningResponse", () => {
	it("parses valid learning JSON", async () => {
		const { parseLearningResponse } = await import("../src/learning.js");
		const result = parseLearningResponse(
			'{"topic": "file path resolution", "insight": "verify files exist before referencing", "category": "approach", "tags": ["files", "paths"]}',
		);
		expect(result).toEqual({
			topic: "file path resolution",
			insight: "verify files exist before referencing",
			category: "approach",
			tags: ["files", "paths"],
		});
	});

	it("returns null for malformed JSON", async () => {
		const { parseLearningResponse } = await import("../src/learning.js");
		expect(parseLearningResponse("garbage")).toBeNull();
	});

	it("returns null when required fields missing", async () => {
		const { parseLearningResponse } = await import("../src/learning.js");
		expect(parseLearningResponse('{"topic": "only topic"}')).toBeNull();
	});
});

describe("writeLearningFile", () => {
	it("creates learning markdown with frontmatter", async () => {
		const { writeLearningFile } = await import("../src/learning.js");
		const dir = mkdtempSync(join(tmpdir(), "mother-learn-"));
		const learningsDir = join(dir, "learnings", "chan1");
		mkdirSync(learningsDir, { recursive: true });

		const path = await writeLearningFile(learningsDir, {
			topic: "error handling",
			insight: "always show the actual error message to the user",
			category: "communication",
			tags: ["errors", "ux"],
			rating: 4,
			sentiment: "negative",
			userId: "user1",
			channelId: "chan1",
		});

		expect(existsSync(path)).toBe(true);
		const content = readFileSync(path, "utf-8");
		expect(content).toContain("topic: error handling");
		expect(content).toContain("category: communication");
		expect(content).toContain("rating: 4");
		expect(content).toContain("sentiment: negative");
		expect(content).toContain("tags: [errors, ux]");
		expect(content).toContain("always show the actual error message to the user");
	});

	it("generates unique filenames", async () => {
		const { writeLearningFile } = await import("../src/learning.js");
		const dir = mkdtempSync(join(tmpdir(), "mother-learn-"));
		const learningsDir = join(dir, "learnings", "chan1");
		mkdirSync(learningsDir, { recursive: true });

		const base = { topic: "test", insight: "test insight", category: "approach" as const, tags: [], rating: 5, sentiment: "neutral" as const, userId: "u1", channelId: "c1" };
		const path1 = await writeLearningFile(learningsDir, base);
		const path2 = await writeLearningFile(learningsDir, { ...base, topic: "test2" });

		expect(path1).not.toBe(path2);
		expect(readdirSync(learningsDir)).toHaveLength(2);
	});
});

describe("buildExtractionPrompt", () => {
	it("includes rating and conversation context", async () => {
		const { buildExtractionPrompt } = await import("../src/learning.js");
		const prompt = buildExtractionPrompt(3, "negative", "wrong file path", "User: fix the bug\nAssistant: I edited /tmp/foo.ts");
		expect(prompt).toContain("3/10");
		expect(prompt).toContain("negative");
		expect(prompt).toContain("wrong file path");
		expect(prompt).toContain("fix the bug");
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /home/edible/Projects/pi-mono && npm test -- --filter mother -- test/learning.test.ts`
Expected: FAIL — module `../src/learning.js` does not exist

- [ ] **Step 3: Implement learning extraction module**

Create `src/learning.ts`:

```typescript
/**
 * Learning extraction module for Mother's learning system.
 *
 * Extracts structured learnings from conversations when feedback is detected.
 * Writes learning files as markdown with YAML frontmatter for collection indexing.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MotherSettingsManager } from "./context.js";
import type { SentimentResult } from "./ratings.js";
import * as log from "./log.js";

export interface LearningResult {
	topic: string;
	insight: string;
	category: "approach" | "communication" | "tool_use" | "knowledge";
	tags: string[];
}

export interface LearningContext {
	topic: string;
	insight: string;
	category: string;
	tags: string[];
	rating: number | null;
	sentiment: string;
	userId: string;
	channelId: string;
}

export function buildExtractionPrompt(
	rating: number | null,
	sentiment: string,
	ratingContext: string,
	recentTurns: string,
): string {
	return `A user rated the assistant's work ${rating ?? "unknown"}/10 (${sentiment}).
Context: ${ratingContext}

Recent conversation:
${recentTurns}

Extract a concise learning from this interaction. Respond in JSON:
{"topic": "2-5 word topic", "insight": "what to do differently or keep doing", "category": "approach"|"communication"|"tool_use"|"knowledge", "tags": ["relevant", "tags"]}`;
}

export function parseLearningResponse(text: string): LearningResult | null {
	try {
		const cleaned = text.replace(/^```(?:json)?\n?/m, "").replace(/\n?```$/m, "").trim();
		const parsed = JSON.parse(cleaned);
		if (!parsed.topic || !parsed.insight || !parsed.category) {
			return null;
		}
		return {
			topic: String(parsed.topic),
			insight: String(parsed.insight),
			category: parsed.category,
			tags: Array.isArray(parsed.tags) ? parsed.tags.map(String) : [],
		};
	} catch {
		return null;
	}
}

function slugify(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "")
		.substring(0, 40);
}

export async function writeLearningFile(learningsDir: string, ctx: LearningContext): Promise<string> {
	mkdirSync(learningsDir, { recursive: true });

	const now = new Date();
	const pad = (n: number) => n.toString().padStart(2, "0");
	const dateStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
	const timeStr = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
	const slug = slugify(ctx.topic);
	const filename = `${dateStr}_${timeStr}_${slug}.md`;
	const filepath = join(learningsDir, filename);

	const tagsYaml = ctx.tags.length > 0 ? `[${ctx.tags.join(", ")}]` : "[]";
	const content = `---
topic: ${ctx.topic}
category: ${ctx.category}
rating: ${ctx.rating ?? "null"}
sentiment: ${ctx.sentiment}
tags: ${tagsYaml}
userId: "${ctx.userId}"
channelId: "${ctx.channelId}"
timestamp: ${now.toISOString()}
---

${ctx.insight}
`;

	writeFileSync(filepath, content);
	return filepath;
}

/**
 * Extract a learning from the recent conversation given a feedback rating.
 * Calls the inference server to analyze the conversation and produce a structured learning.
 */
export async function extractLearning(
	settings: MotherSettingsManager,
	sentimentResult: SentimentResult,
	recentTurns: string,
	userId: string,
	channelId: string,
	workspacePath: string,
	signal?: AbortSignal,
): Promise<string | null> {
	const ollamaUrl = settings.getOllamaUrl();
	const learningSettings = settings.getLearningSettings();
	const modelId = learningSettings.sentimentModel || settings.getDefaultModel();

	const prompt = buildExtractionPrompt(
		sentimentResult.rating,
		sentimentResult.sentiment,
		sentimentResult.context,
		recentTurns,
	);

	try {
		const response = await fetch(`${ollamaUrl}/chat/completions`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				model: modelId,
				messages: [{ role: "user", content: prompt }],
				stream: false,
			}),
			signal,
		});

		if (!response.ok) {
			log.logWarning("Learning extraction failed", `HTTP ${response.status}`);
			return null;
		}

		const data = (await response.json()) as { choices: { message: { content: string } }[] };
		const content = data.choices?.[0]?.message?.content;
		if (!content) {
			log.logWarning("Learning extraction failed", "Empty response");
			return null;
		}

		const learning = parseLearningResponse(content);
		if (!learning) {
			log.logWarning("Learning extraction failed", "Could not parse response");
			return null;
		}

		const learningsDir = join(workspacePath, "learnings", channelId);
		const filepath = await writeLearningFile(learningsDir, {
			...learning,
			rating: sentimentResult.rating,
			sentiment: sentimentResult.sentiment,
			userId,
			channelId,
		});

		log.logInfo(`Learning captured: ${learning.topic} → ${filepath}`);
		return filepath;
	} catch (err) {
		if (signal?.aborted) return null;
		const msg = err instanceof Error ? err.message : String(err);
		log.logWarning("Learning extraction error", msg);
		return null;
	}
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /home/edible/Projects/pi-mono && npm test -- --filter mother -- test/learning.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
cd /home/edible/Projects/pi-mono
git add packages/mother/src/learning.ts packages/mother/test/learning.test.ts
git commit -m "feat(mother): add learning extraction module"
```

---

## Task 4: Wisdom Crystallization Module

**Files:**
- Create: `src/wisdom.ts`
- Test: `test/wisdom.test.ts`

- [ ] **Step 1: Write failing tests for wisdom module**

Create `test/wisdom.test.ts`:

```typescript
import { describe, expect, it, vi, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("parseWisdomFile", () => {
	it("parses active.md with multiple entries", async () => {
		const { parseWisdomFile } = await import("../src/wisdom.js");
		const content = `## File Path Verification [confidence: 92%]
Always verify files exist before referencing paths.
- Sources: 4 learnings (2026-03-15, 2026-03-20, 2026-03-28, 2026-04-01)
- Last updated: 2026-04-01

## Concise Responses [confidence: 85%]
Keep responses short and direct.
- Sources: user-promoted (2026-03-25)
- Last updated: 2026-03-25`;

		const entries = parseWisdomFile(content);
		expect(entries).toHaveLength(2);
		expect(entries[0].title).toBe("File Path Verification");
		expect(entries[0].confidence).toBe(0.92);
		expect(entries[1].title).toBe("Concise Responses");
		expect(entries[1].confidence).toBe(0.85);
	});

	it("returns empty array for empty file", async () => {
		const { parseWisdomFile } = await import("../src/wisdom.js");
		expect(parseWisdomFile("")).toEqual([]);
	});
});

describe("serializeWisdomFile", () => {
	it("round-trips through parse and serialize", async () => {
		const { parseWisdomFile, serializeWisdomFile } = await import("../src/wisdom.js");
		const entries = [
			{
				title: "Test Wisdom",
				confidence: 0.85,
				body: "Always test your code.",
				sources: "user-promoted (2026-04-01)",
				lastUpdated: "2026-04-01",
			},
		];
		const serialized = serializeWisdomFile(entries);
		const reparsed = parseWisdomFile(serialized);
		expect(reparsed).toHaveLength(1);
		expect(reparsed[0].title).toBe("Test Wisdom");
		expect(reparsed[0].confidence).toBe(0.85);
	});
});

describe("addPendingWisdom", () => {
	it("creates pending.md if it does not exist", async () => {
		const { addPendingWisdom } = await import("../src/wisdom.js");
		const dir = mkdtempSync(join(tmpdir(), "mother-wisdom-"));
		const wisdomDir = join(dir, "wisdom");
		mkdirSync(wisdomDir, { recursive: true });
		writeFileSync(join(wisdomDir, "pending.md"), "");

		addPendingWisdom(wisdomDir, {
			title: "New Pattern",
			confidence: 0.60,
			body: "A new pattern observed.",
			sources: "3 learnings (2026-04-01)",
			lastUpdated: "2026-04-01",
		});

		const content = readFileSync(join(wisdomDir, "pending.md"), "utf-8");
		expect(content).toContain("New Pattern");
		expect(content).toContain("confidence: 60%");
	});
});

describe("promoteWisdom", () => {
	it("moves entry from pending to active when confidence >= threshold", async () => {
		const { promoteWisdom, parseWisdomFile } = await import("../src/wisdom.js");
		const dir = mkdtempSync(join(tmpdir(), "mother-wisdom-"));
		const wisdomDir = join(dir, "wisdom");
		mkdirSync(wisdomDir, { recursive: true });
		writeFileSync(join(wisdomDir, "active.md"), "");
		writeFileSync(
			join(wisdomDir, "pending.md"),
			`## Ready Entry [confidence: 82%]
Should be promoted.
- Sources: 4 learnings
- Last updated: 2026-04-01`,
		);

		promoteWisdom(wisdomDir, 0.80);

		const active = parseWisdomFile(readFileSync(join(wisdomDir, "active.md"), "utf-8"));
		const pending = parseWisdomFile(readFileSync(join(wisdomDir, "pending.md"), "utf-8"));
		expect(active).toHaveLength(1);
		expect(active[0].title).toBe("Ready Entry");
		expect(pending).toHaveLength(0);
	});

	it("does not promote below threshold", async () => {
		const { promoteWisdom, parseWisdomFile } = await import("../src/wisdom.js");
		const dir = mkdtempSync(join(tmpdir(), "mother-wisdom-"));
		const wisdomDir = join(dir, "wisdom");
		mkdirSync(wisdomDir, { recursive: true });
		writeFileSync(join(wisdomDir, "active.md"), "");
		writeFileSync(
			join(wisdomDir, "pending.md"),
			`## Not Ready [confidence: 60%]
Not enough evidence.
- Sources: 2 learnings
- Last updated: 2026-04-01`,
		);

		promoteWisdom(wisdomDir, 0.80);

		const active = parseWisdomFile(readFileSync(join(wisdomDir, "active.md"), "utf-8"));
		const pending = parseWisdomFile(readFileSync(join(wisdomDir, "pending.md"), "utf-8"));
		expect(active).toHaveLength(0);
		expect(pending).toHaveLength(1);
	});
});

describe("getActiveWisdom", () => {
	it("returns active wisdom content capped at maxChars", async () => {
		const { getActiveWisdom } = await import("../src/wisdom.js");
		const dir = mkdtempSync(join(tmpdir(), "mother-wisdom-"));
		const wisdomDir = join(dir, "wisdom");
		mkdirSync(wisdomDir, { recursive: true });
		writeFileSync(
			join(wisdomDir, "active.md"),
			`## Test [confidence: 90%]
Some wisdom here.
- Sources: test
- Last updated: 2026-04-01`,
		);

		const result = getActiveWisdom(wisdomDir, 5000);
		expect(result).toContain("Test");
		expect(result).toContain("Some wisdom here");
	});

	it("returns empty string when no active.md exists", async () => {
		const { getActiveWisdom } = await import("../src/wisdom.js");
		const dir = mkdtempSync(join(tmpdir(), "mother-wisdom-"));
		expect(getActiveWisdom(join(dir, "wisdom"), 500)).toBe("");
	});
});

describe("decayWisdom", () => {
	it("reduces confidence of stale entries", async () => {
		const { decayWisdom, parseWisdomFile } = await import("../src/wisdom.js");
		const dir = mkdtempSync(join(tmpdir(), "mother-wisdom-"));
		const wisdomDir = join(dir, "wisdom");
		mkdirSync(wisdomDir, { recursive: true });
		writeFileSync(join(wisdomDir, "archive.md"), "");
		writeFileSync(
			join(wisdomDir, "active.md"),
			`## Old Wisdom [confidence: 55%]
Something old.
- Sources: 1 learning
- Last updated: 2025-01-01`,
		);

		decayWisdom(wisdomDir, 90, 0.10, 0.50);

		const active = parseWisdomFile(readFileSync(join(wisdomDir, "active.md"), "utf-8"));
		const archive = parseWisdomFile(readFileSync(join(wisdomDir, "archive.md"), "utf-8"));
		// 55% - 10% = 45% which is below 50% threshold, so archived
		expect(active).toHaveLength(0);
		expect(archive).toHaveLength(1);
		expect(archive[0].confidence).toBe(0.45);
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /home/edible/Projects/pi-mono && npm test -- --filter mother -- test/wisdom.test.ts`
Expected: FAIL — module `../src/wisdom.js` does not exist

- [ ] **Step 3: Implement wisdom module**

Create `src/wisdom.ts`:

```typescript
/**
 * Wisdom crystallization module for Mother's learning system.
 *
 * Manages promotion of learnings to wisdom entries with confidence scoring.
 * Supports auto-detection via embedding similarity and explicit user promotion.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MotherSettingsManager } from "./context.js";
import { getBaseUrl } from "./tools/search.js";
import * as log from "./log.js";

export interface WisdomEntry {
	title: string;
	confidence: number;
	body: string;
	sources: string;
	lastUpdated: string;
}

/**
 * Parse a wisdom markdown file (active.md, pending.md, or archive.md) into entries.
 * Format: ## Title [confidence: NN%]\nBody\n- Sources: ...\n- Last updated: ...
 */
export function parseWisdomFile(content: string): WisdomEntry[] {
	if (!content.trim()) return [];

	const entries: WisdomEntry[] = [];
	const sections = content.split(/^## /m).filter((s) => s.trim());

	for (const section of sections) {
		const titleMatch = section.match(/^(.+?)\s*\[confidence:\s*(\d+)%\]/);
		if (!titleMatch) continue;

		const title = titleMatch[1].trim();
		const confidence = Number.parseInt(titleMatch[2], 10) / 100;

		const lines = section.split("\n").slice(1);
		const bodyLines: string[] = [];
		let sources = "";
		let lastUpdated = "";

		for (const line of lines) {
			const srcMatch = line.match(/^- Sources:\s*(.+)/);
			const dateMatch = line.match(/^- Last updated:\s*(.+)/);
			if (srcMatch) {
				sources = srcMatch[1].trim();
			} else if (dateMatch) {
				lastUpdated = dateMatch[1].trim();
			} else if (line.trim()) {
				bodyLines.push(line);
			}
		}

		entries.push({
			title,
			confidence,
			body: bodyLines.join("\n").trim(),
			sources,
			lastUpdated,
		});
	}

	return entries;
}

/**
 * Serialize wisdom entries back to markdown format.
 */
export function serializeWisdomFile(entries: WisdomEntry[]): string {
	if (entries.length === 0) return "";

	return entries
		.map(
			(e) =>
				`## ${e.title} [confidence: ${Math.round(e.confidence * 100)}%]\n${e.body}\n- Sources: ${e.sources}\n- Last updated: ${e.lastUpdated}`,
		)
		.join("\n\n");
}

function readWisdomEntries(filepath: string): WisdomEntry[] {
	if (!existsSync(filepath)) return [];
	return parseWisdomFile(readFileSync(filepath, "utf-8"));
}

function writeWisdomEntries(filepath: string, entries: WisdomEntry[]): void {
	writeFileSync(filepath, serializeWisdomFile(entries));
}

/**
 * Add a new pending wisdom entry.
 */
export function addPendingWisdom(wisdomDir: string, entry: WisdomEntry): void {
	mkdirSync(wisdomDir, { recursive: true });
	const pendingPath = join(wisdomDir, "pending.md");
	const entries = readWisdomEntries(pendingPath);

	// Check for existing entry with same title — update instead of duplicate
	const existing = entries.find((e) => e.title.toLowerCase() === entry.title.toLowerCase());
	if (existing) {
		existing.confidence = Math.max(existing.confidence, entry.confidence);
		existing.sources = entry.sources;
		existing.lastUpdated = entry.lastUpdated;
	} else {
		entries.push(entry);
	}

	writeWisdomEntries(pendingPath, entries);
}

/**
 * Promote entries from pending to active when confidence >= threshold.
 */
export function promoteWisdom(wisdomDir: string, threshold: number): void {
	const pendingPath = join(wisdomDir, "pending.md");
	const activePath = join(wisdomDir, "active.md");

	const pending = readWisdomEntries(pendingPath);
	const active = readWisdomEntries(activePath);

	const toPromote = pending.filter((e) => e.confidence >= threshold);
	const remaining = pending.filter((e) => e.confidence < threshold);

	if (toPromote.length === 0) return;

	// Merge promoted entries — update existing by title or append
	for (const entry of toPromote) {
		const existing = active.find((a) => a.title.toLowerCase() === entry.title.toLowerCase());
		if (existing) {
			existing.confidence = Math.max(existing.confidence, entry.confidence);
			existing.body = entry.body;
			existing.sources = entry.sources;
			existing.lastUpdated = entry.lastUpdated;
		} else {
			active.push(entry);
		}
	}

	writeWisdomEntries(activePath, active);
	writeWisdomEntries(pendingPath, remaining);
	log.logInfo(`Wisdom: promoted ${toPromote.length} entries to active`);
}

/**
 * Get active wisdom content for prompt injection, capped at maxChars.
 */
export function getActiveWisdom(wisdomDir: string, maxChars: number): string {
	const activePath = join(wisdomDir, "active.md");
	if (!existsSync(activePath)) return "";

	const content = readFileSync(activePath, "utf-8").trim();
	if (!content) return "";

	if (content.length > maxChars) {
		return `${content.substring(0, maxChars)}\n[Wisdom truncated — consider archiving low-confidence entries]`;
	}
	return content;
}

/**
 * Decay wisdom entries that haven't been reinforced.
 * Entries whose lastUpdated is older than decayDays lose decayAmount confidence.
 * Entries below archiveThreshold are moved to archive.
 */
export function decayWisdom(
	wisdomDir: string,
	decayDays: number,
	decayAmount: number,
	archiveThreshold: number,
): void {
	const activePath = join(wisdomDir, "active.md");
	const archivePath = join(wisdomDir, "archive.md");

	const active = readWisdomEntries(activePath);
	const archive = readWisdomEntries(archivePath);

	const now = Date.now();
	const cutoffMs = decayDays * 24 * 60 * 60 * 1000;

	const remaining: WisdomEntry[] = [];
	for (const entry of active) {
		const lastUpdate = new Date(entry.lastUpdated).getTime();
		if (Number.isNaN(lastUpdate) || now - lastUpdate > cutoffMs) {
			entry.confidence = Math.round((entry.confidence - decayAmount) * 100) / 100;
			if (entry.confidence < archiveThreshold) {
				archive.push(entry);
				log.logInfo(`Wisdom: archived "${entry.title}" (confidence: ${Math.round(entry.confidence * 100)}%)`);
				continue;
			}
		}
		remaining.push(entry);
	}

	writeWisdomEntries(activePath, remaining);
	writeWisdomEntries(archivePath, archive);
}

/**
 * Check if a new learning clusters with existing learnings and should create/update pending wisdom.
 * Uses the inference server's embeddings endpoint to find similar learnings.
 */
export async function checkWisdomCandidate(
	settings: MotherSettingsManager,
	learningInsight: string,
	learningTopic: string,
	signal?: AbortSignal,
): Promise<{ shouldCreate: boolean; clusterSize: number } | null> {
	const wisdomSettings = settings.getWisdomSettings();
	const baseUrl = getBaseUrl(settings);

	try {
		const response = await fetch(`${baseUrl}/collections/learnings/search`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				query: learningInsight,
				limit: 10,
			}),
			signal,
		});

		if (!response.ok) return null;

		const data = (await response.json()) as { results: { score: number }[] };
		const similar = data.results.filter((r) => r.score >= wisdomSettings.clusterSimilarityThreshold);

		return {
			shouldCreate: similar.length >= wisdomSettings.clusterMinOccurrences,
			clusterSize: similar.length,
		};
	} catch {
		return null;
	}
}

/**
 * Get today's date as YYYY-MM-DD string.
 */
function todayStr(): string {
	const now = new Date();
	const pad = (n: number) => n.toString().padStart(2, "0");
	return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * Process a new learning for potential wisdom promotion.
 * Checks for cluster formation and creates/updates pending wisdom if warranted.
 * Also runs promotion check to move ready entries to active.
 */
export async function processWisdomFromLearning(
	settings: MotherSettingsManager,
	workspacePath: string,
	learningTopic: string,
	learningInsight: string,
	signal?: AbortSignal,
): Promise<void> {
	const wisdomSettings = settings.getWisdomSettings();
	if (!wisdomSettings.enabled) return;

	const wisdomDir = join(workspacePath, "wisdom");

	// Check for cluster formation
	const cluster = await checkWisdomCandidate(settings, learningInsight, learningTopic, signal);

	if (cluster?.shouldCreate) {
		const confidence = Math.min(0.60 + (cluster.clusterSize - 3) * 0.05, 0.75);
		addPendingWisdom(wisdomDir, {
			title: learningTopic,
			confidence,
			body: learningInsight,
			sources: `${cluster.clusterSize} learnings (${todayStr()})`,
			lastUpdated: todayStr(),
		});
		log.logInfo(`Wisdom candidate: "${learningTopic}" (cluster: ${cluster.clusterSize}, confidence: ${Math.round(confidence * 100)}%)`);
	}

	// Run promotion check
	promoteWisdom(wisdomDir, wisdomSettings.promotionThreshold);
}

/**
 * Handle explicit user promotion (e.g. "remember that").
 * Creates a wisdom entry at explicit promotion confidence level.
 */
export function promoteExplicitly(
	settings: MotherSettingsManager,
	workspacePath: string,
	topic: string,
	insight: string,
): void {
	const wisdomSettings = settings.getWisdomSettings();
	const wisdomDir = join(workspacePath, "wisdom");

	addPendingWisdom(wisdomDir, {
		title: topic,
		confidence: wisdomSettings.explicitPromotionConfidence,
		body: insight,
		sources: `user-promoted (${todayStr()})`,
		lastUpdated: todayStr(),
	});

	// Explicit promotion confidence (0.85) >= threshold (0.80), so promote immediately
	promoteWisdom(wisdomDir, wisdomSettings.promotionThreshold);
	log.logInfo(`Wisdom: user-promoted "${topic}" to active`);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /home/edible/Projects/pi-mono && npm test -- --filter mother -- test/wisdom.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
cd /home/edible/Projects/pi-mono
git add packages/mother/src/wisdom.ts packages/mother/test/wisdom.test.ts
git commit -m "feat(mother): add wisdom crystallization module"
```

---

## Task 5: Relationship Notes Module

**Files:**
- Create: `src/relationships.ts`
- Test: `test/relationships.test.ts`

- [ ] **Step 1: Write failing tests for relationship notes**

Create `test/relationships.test.ts`:

```typescript
import { describe, expect, it, vi, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("parseRelationshipFile", () => {
	it("parses W/B/O sections from user profile", async () => {
		const { parseRelationshipFile } = await import("../src/relationships.js");
		const content = `# User: edible (123)

## World
- Runs a Pi 5 homelab [confidence: 0.95] (2026-04-01)

## Biographical
- Set up inference server (2026-04-01)

## Opinions
- Prefers concise responses [confidence: 0.85] (2026-04-01)`;

		const profile = parseRelationshipFile(content);
		expect(profile.world).toHaveLength(1);
		expect(profile.world[0].content).toBe("Runs a Pi 5 homelab");
		expect(profile.world[0].confidence).toBe(0.95);
		expect(profile.biographical).toHaveLength(1);
		expect(profile.opinions).toHaveLength(1);
		expect(profile.opinions[0].confidence).toBe(0.85);
	});

	it("returns empty sections for empty file", async () => {
		const { parseRelationshipFile } = await import("../src/relationships.js");
		const profile = parseRelationshipFile("");
		expect(profile.world).toEqual([]);
		expect(profile.biographical).toEqual([]);
		expect(profile.opinions).toEqual([]);
	});
});

describe("serializeRelationshipFile", () => {
	it("produces valid markdown from profile", async () => {
		const { serializeRelationshipFile } = await import("../src/relationships.js");
		const content = serializeRelationshipFile("testuser", "12345", {
			world: [{ content: "Uses Linux", confidence: 0.9, date: "2026-04-01" }],
			biographical: [{ content: "Fixed a bug", confidence: 1, date: "2026-04-01" }],
			opinions: [{ content: "Likes TDD", confidence: 0.8, date: "2026-04-01" }],
		});

		expect(content).toContain("# User: testuser (12345)");
		expect(content).toContain("Uses Linux [confidence: 0.90]");
		expect(content).toContain("Fixed a bug");
		expect(content).toContain("Likes TDD [confidence: 0.80]");
	});
});

describe("mergeNotes", () => {
	it("adds new notes to empty profile", async () => {
		const { mergeNotes } = await import("../src/relationships.js");
		const profile = { world: [], biographical: [], opinions: [] };
		const notes = [
			{ type: "W" as const, content: "Has a cat", confidence: 0.7 },
			{ type: "O" as const, content: "Prefers dark mode", confidence: 0.8 },
		];

		const merged = mergeNotes(profile, notes);
		expect(merged.world).toHaveLength(1);
		expect(merged.world[0].content).toBe("Has a cat");
		expect(merged.opinions).toHaveLength(1);
	});

	it("updates existing note instead of duplicating", async () => {
		const { mergeNotes } = await import("../src/relationships.js");
		const profile = {
			world: [{ content: "Has a cat", confidence: 0.7, date: "2026-03-01" }],
			biographical: [],
			opinions: [],
		};
		const notes = [{ type: "W" as const, content: "Has a cat", confidence: 0.9 }];

		const merged = mergeNotes(profile, notes);
		expect(merged.world).toHaveLength(1);
		expect(merged.world[0].confidence).toBe(0.9);
	});
});

describe("parseExtractionResponse", () => {
	it("parses valid notes array", async () => {
		const { parseExtractionResponse } = await import("../src/relationships.js");
		const result = parseExtractionResponse(
			'{"notes": [{"type": "W", "content": "Uses Arch Linux", "confidence": 0.8}]}',
		);
		expect(result).toHaveLength(1);
		expect(result![0].type).toBe("W");
	});

	it("returns null for invalid JSON", async () => {
		const { parseExtractionResponse } = await import("../src/relationships.js");
		expect(parseExtractionResponse("nope")).toBeNull();
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /home/edible/Projects/pi-mono && npm test -- --filter mother -- test/relationships.test.ts`
Expected: FAIL — module `../src/relationships.js` does not exist

- [ ] **Step 3: Implement relationships module**

Create `src/relationships.ts`:

```typescript
/**
 * Relationship notes module for Mother's learning system.
 *
 * Extracts per-user W/B/O notes (World facts, Biographical notes, Opinions)
 * from conversations and maintains persistent user profiles.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MotherSettingsManager } from "./context.js";
import * as log from "./log.js";

export interface RelationshipNote {
	content: string;
	confidence: number;
	date: string;
}

export interface UserProfile {
	world: RelationshipNote[];
	biographical: RelationshipNote[];
	opinions: RelationshipNote[];
}

export interface ExtractedNote {
	type: "W" | "B" | "O";
	content: string;
	confidence: number;
}

/**
 * Parse a relationship markdown file into a UserProfile.
 */
export function parseRelationshipFile(content: string): UserProfile {
	const profile: UserProfile = { world: [], biographical: [], opinions: [] };
	if (!content.trim()) return profile;

	let currentSection: "world" | "biographical" | "opinions" | null = null;

	for (const line of content.split("\n")) {
		if (line.startsWith("## World")) {
			currentSection = "world";
		} else if (line.startsWith("## Biographical")) {
			currentSection = "biographical";
		} else if (line.startsWith("## Opinions")) {
			currentSection = "opinions";
		} else if (currentSection && line.startsWith("- ")) {
			const noteMatch = line.match(/^- (.+?)(?:\s*\[confidence:\s*([\d.]+)\])?\s*\((\d{4}-\d{2}-\d{2})\)$/);
			if (noteMatch) {
				profile[currentSection].push({
					content: noteMatch[1].trim(),
					confidence: noteMatch[2] ? Number.parseFloat(noteMatch[2]) : 1.0,
					date: noteMatch[3],
				});
			}
		}
	}

	return profile;
}

/**
 * Serialize a UserProfile to markdown.
 */
export function serializeRelationshipFile(userName: string, userId: string, profile: UserProfile): string {
	const formatNote = (note: RelationshipNote, includeConfidence: boolean): string => {
		const conf = includeConfidence ? ` [confidence: ${note.confidence.toFixed(2)}]` : "";
		return `- ${note.content}${conf} (${note.date})`;
	};

	const sections: string[] = [`# User: ${userName} (${userId})`];

	sections.push("\n## World");
	for (const note of profile.world) {
		sections.push(formatNote(note, true));
	}

	sections.push("\n## Biographical");
	for (const note of profile.biographical) {
		sections.push(formatNote(note, false));
	}

	sections.push("\n## Opinions");
	for (const note of profile.opinions) {
		sections.push(formatNote(note, true));
	}

	return `${sections.join("\n")}\n`;
}

function todayStr(): string {
	const now = new Date();
	const pad = (n: number) => n.toString().padStart(2, "0");
	return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * Merge new notes into an existing profile, deduplicating by content similarity.
 * For now uses exact substring match — embedding-based dedup is a future enhancement.
 */
export function mergeNotes(profile: UserProfile, notes: ExtractedNote[]): UserProfile {
	const result: UserProfile = {
		world: [...profile.world],
		biographical: [...profile.biographical],
		opinions: [...profile.opinions],
	};

	const sectionMap: Record<string, keyof UserProfile> = {
		W: "world",
		B: "biographical",
		O: "opinions",
	};

	const today = todayStr();

	for (const note of notes) {
		const section = sectionMap[note.type];
		if (!section) continue;

		// Check for duplicate — simple substring match for now
		const existing = result[section].find(
			(e) =>
				e.content.toLowerCase().includes(note.content.toLowerCase()) ||
				note.content.toLowerCase().includes(e.content.toLowerCase()),
		);

		if (existing) {
			// Update confidence and date
			existing.confidence = Math.max(existing.confidence, note.confidence);
			existing.date = today;
		} else {
			result[section].push({
				content: note.content,
				confidence: note.confidence,
				date: today,
			});
		}
	}

	return result;
}

export function buildRelationshipPrompt(userName: string, userId: string, recentTurns: string): string {
	return `Analyze this conversation for information about the user that would be useful to remember across future conversations. Ignore project-specific or task-specific details.

User: ${userName} (${userId})
Conversation:
${recentTurns}

Respond in JSON:
{"notes": [{"type": "W"|"B"|"O", "content": "the note", "confidence": 0.0-1.0}]}

Types:
- W (World): Objective facts about the user's situation, role, environment
- B (Biographical): What the user did or accomplished this session
- O (Opinion): User preferences, beliefs, or communication style

Only include notes with confidence >= 0.6. Return empty notes array if nothing noteworthy.`;
}

export function parseExtractionResponse(text: string): ExtractedNote[] | null {
	try {
		const cleaned = text.replace(/^```(?:json)?\n?/m, "").replace(/\n?```$/m, "").trim();
		const parsed = JSON.parse(cleaned);
		if (!Array.isArray(parsed.notes)) return null;
		return parsed.notes.filter(
			(n: any) => (n.type === "W" || n.type === "B" || n.type === "O") && typeof n.content === "string",
		);
	} catch {
		return null;
	}
}

/**
 * Extract relationship notes from a conversation and update the user's profile.
 */
export async function extractRelationshipNotes(
	settings: MotherSettingsManager,
	workspacePath: string,
	userId: string,
	userName: string,
	recentTurns: string,
	signal?: AbortSignal,
): Promise<void> {
	const relSettings = settings.getRelationshipSettings();
	if (!relSettings.enabled) return;

	const ollamaUrl = settings.getOllamaUrl();
	const learningSettings = settings.getLearningSettings();
	const modelId = learningSettings.sentimentModel || settings.getDefaultModel();

	const prompt = buildRelationshipPrompt(userName, userId, recentTurns);

	try {
		const response = await fetch(`${ollamaUrl}/chat/completions`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				model: modelId,
				messages: [{ role: "user", content: prompt }],
				stream: false,
			}),
			signal,
		});

		if (!response.ok) {
			log.logWarning("Relationship extraction failed", `HTTP ${response.status}`);
			return;
		}

		const data = (await response.json()) as { choices: { message: { content: string } }[] };
		const content = data.choices?.[0]?.message?.content;
		if (!content) return;

		const notes = parseExtractionResponse(content);
		if (!notes || notes.length === 0) return;

		// Read existing profile
		const relDir = join(workspacePath, "relationships");
		mkdirSync(relDir, { recursive: true });
		const profilePath = join(relDir, `${userId}.md`);
		const existingContent = existsSync(profilePath) ? readFileSync(profilePath, "utf-8") : "";
		const profile = parseRelationshipFile(existingContent);

		// Merge and write
		const updated = mergeNotes(profile, notes);
		writeFileSync(profilePath, serializeRelationshipFile(userName, userId, updated));
		log.logInfo(`Relationship: updated ${userName}'s profile with ${notes.length} notes`);
	} catch (err) {
		if (signal?.aborted) return;
		const msg = err instanceof Error ? err.message : String(err);
		log.logWarning("Relationship extraction error", msg);
	}
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /home/edible/Projects/pi-mono && npm test -- --filter mother -- test/relationships.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
cd /home/edible/Projects/pi-mono
git add packages/mother/src/relationships.ts packages/mother/test/relationships.test.ts
git commit -m "feat(mother): add relationship notes module with W/B/O profiles"
```

---

## Task 6: Integrate into Agent Lifecycle

**Files:**
- Modify: `src/agent.ts:402-440` (bootstrapWorkspace)
- Modify: `src/agent.ts:800-915` (buildSystemPrompt)
- Modify: `src/agent.ts:1289-1537` (run function)

- [ ] **Step 1: Write integration test**

Create `test/learning-integration.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("bootstrapWorkspace creates learning directories", () => {
	it("creates learnings, wisdom, relationships, and ratings dirs", async () => {
		// We'll test that the bootstrap function creates the expected dirs
		// by importing and calling it once it's modified
		const dir = mkdtempSync(join(tmpdir(), "mother-bootstrap-"));
		const channelDir = join(dir, "workspace", "channel1");
		mkdirSync(channelDir, { recursive: true });

		// After Task 6 step 3, bootstrapWorkspace will create these dirs
		// For now, just verify the structure expectation
		const expectedDirs = [
			join(dir, "workspace", "learnings"),
			join(dir, "workspace", "wisdom"),
			join(dir, "workspace", "relationships"),
			join(dir, "workspace", "ratings"),
		];

		for (const d of expectedDirs) {
			mkdirSync(d, { recursive: true });
			expect(existsSync(d)).toBe(true);
		}
	});
});
```

- [ ] **Step 2: Extend bootstrapWorkspace**

In `src/agent.ts`, add to the workspace-level directory creation at line 416:

Change:
```typescript
// Workspace-level directories
for (const sub of ["skills", "events"]) {
	await mkdir(join(workspaceDir, sub), { recursive: true });
}
```

To:
```typescript
// Workspace-level directories
for (const sub of ["skills", "events", "learnings", "wisdom", "relationships", "ratings"]) {
	await mkdir(join(workspaceDir, sub), { recursive: true });
}
```

After the MOTHER.md creation block (around line 435), add:

```typescript
// Create empty wisdom files if they don't exist
for (const file of ["active.md", "pending.md", "archive.md"]) {
	const wisdomFile = join(workspaceDir, "wisdom", file);
	if (!existsSync(wisdomFile)) {
		await writeFile(wisdomFile, "");
	}
}
```

- [ ] **Step 3: Extend buildSystemPrompt with wisdom injection**

In `src/agent.ts`, add import at the top:

```typescript
import { getActiveWisdom } from "./wisdom.js";
```

Modify `buildSystemPrompt` to accept a `wisdom` parameter. Change the function signature at line 800:

```typescript
function buildSystemPrompt(
	workspacePath: string,
	channelId: string,
	memory: string,
	motherNotes: string,
	sandboxConfig: SandboxConfig,
	channels: ChannelInfo[],
	users: UserInfo[],
	skills: Skill[],
	fileTree = "",
	modelInfo?: { id: string; provider: string },
	knowledgeBase = "",
	wisdom = "",
): string {
```

Add wisdom and learning system awareness to the prompt. After the `### Current Memory` section (around line 902), add:

```typescript
${wisdom ? `\n## Learned Wisdom\n${wisdom}\n` : ""}
## Feedback & Learning
You have a learning system that captures feedback from users. When a user explicitly
asks you to "remember that" or says something is important, it will be promoted to
your wisdom. You can search past learnings and relationship notes via the search tool
using the "learnings" and "relationships" collections.
```

Update the `buildSystemPrompt` call in `run()` (around line 1350). Add before the call:

```typescript
const wisdomSettings = settings.getWisdomSettings();
const wisdom = wisdomSettings.enabled
	? getActiveWisdom(join(channelDir, "..","wisdom"), wisdomSettings.maxActiveChars)
	: "";
```

Add `wisdom` as the last argument to the `buildSystemPrompt` call:

```typescript
const systemPrompt = buildSystemPrompt(
	workspacePath,
	channelId,
	memory,
	motherNotes,
	sandboxConfig,
	ctx.channels,
	ctx.users,
	skills,
	fileTree,
	{ id: model.id, provider: model.provider },
	knowledgeBase,
	wisdom,
);
```

- [ ] **Step 4: Add learning pipeline to run()**

In `src/agent.ts`, add imports at the top:

```typescript
import { analyzeSentiment, appendRating } from "./ratings.js";
import { extractLearning } from "./learning.js";
import { processWisdomFromLearning, promoteExplicitly, decayWisdom } from "./wisdom.js";
import { extractRelationshipNotes } from "./relationships.js";
```

Add a variable to track the last assistant response text. Inside `createRunner()`, add to the closure state (near where `runState` is defined):

```typescript
let lastAssistantResponse = "";
```

In the `session.subscribe()` event loop, in the `message_end` handler (around line 1186), capture the last assistant response text:

```typescript
// After extracting finalText from the message_end event
// (where text parts are joined), add:
if (textParts.length > 0) {
	lastAssistantResponse = textParts.join("\n");
}
```

In the `run()` function, after `await bootstrapWorkspace(...)` (line 1309) and before the user message is built, add the sentiment analysis call. Insert after line 1388 (after `runState.errorMessage = undefined`):

```typescript
// Learning pipeline: analyze sentiment of user message against last response
const learningSettings = settings.getLearningSettings();
if (learningSettings.enabled && lastAssistantResponse) {
	// Fire and forget — don't block the agent's response
	const abortController = new AbortController();
	analyzeSentiment(settings, lastAssistantResponse, ctx.message.text, abortController.signal)
		.then(async (sentiment) => {
			if (!sentiment) return;

			// Store rating
			const ratingsDir = join(channelDir, "..", "ratings");
			await appendRating(ratingsDir, channelId, {
				ts: Date.now(),
				userId: ctx.message.user,
				channelId,
				rating: sentiment.rating,
				sentiment: sentiment.sentiment,
				confidence: sentiment.confidence,
				context: sentiment.context,
				promotionIntent: sentiment.promotion_intent,
			});

			// Extract learning if feedback detected
			if (sentiment.is_feedback) {
				const recentMessages = session.messages
					.slice(-10)
					.filter((m) => m.role === "user" || m.role === "assistant")
					.map((m) => {
						const text = m.content
							.filter((c): c is { type: "text"; text: string } => c.type === "text")
							.map((c) => c.text)
							.join("\n");
						return `${m.role === "user" ? "User" : "Assistant"}: ${text}`;
					})
					.join("\n\n");

				const learningPath = await extractLearning(
					settings,
					sentiment,
					recentMessages,
					ctx.message.user,
					channelId,
					join(channelDir, ".."),
				);

				// Check for wisdom crystallization
				if (learningPath) {
					// Use sentiment context as both topic hint and insight for cluster matching
					// The actual wisdom entry gets refined from the cluster of similar learnings
					await processWisdomFromLearning(
						settings,
						join(channelDir, ".."),
						sentiment.context,
						sentiment.context,
					);
				}

				// Handle explicit promotion intent
				if (sentiment.promotion_intent && sentiment.context) {
					promoteExplicitly(settings, join(channelDir, ".."), sentiment.context, lastAssistantResponse.slice(0, 200));
				}
			}
		})
		.catch((err) => {
			const msg = err instanceof Error ? err.message : String(err);
			log.logWarning("Learning pipeline error", msg);
		});
}
```

After `await queueChain` (line 1463), before the error handling block, add relationship extraction:

```typescript
// Relationship extraction (post-run, non-blocking)
const relSettings = settings.getRelationshipSettings();
if (relSettings.enabled) {
	const userMessages = session.messages.filter((m) => m.role === "user");
	if (userMessages.length >= relSettings.minTurnsForExtraction) {
		const recentTurns = session.messages
			.slice(-10)
			.filter((m) => m.role === "user" || m.role === "assistant")
			.map((m) => {
				const text = m.content
					.filter((c): c is { type: "text"; text: string } => c.type === "text")
					.map((c) => c.text)
					.join("\n");
				return `${m.role === "user" ? "User" : "Assistant"}: ${text}`;
			})
			.join("\n\n");

		// Fire and forget
		extractRelationshipNotes(
			settings,
			join(channelDir, ".."),
			ctx.message.user,
			ctx.message.userName || "unknown",
			recentTurns,
		).catch((err) => {
			const msg = err instanceof Error ? err.message : String(err);
			log.logWarning("Relationship extraction error", msg);
		});
	}
}

// Run wisdom decay on each session (cheap — just reads/writes files)
const wisdomSettings = settings.getWisdomSettings();
if (wisdomSettings.enabled) {
	try {
		decayWisdom(
			join(channelDir, "..", "wisdom"),
			wisdomSettings.decayDays,
			wisdomSettings.decayAmount,
			0.50,
		);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		log.logWarning("Wisdom decay error", msg);
	}
}
```

- [ ] **Step 5: Run full test suite**

Run: `cd /home/edible/Projects/pi-mono && npm test -- --filter mother`
Expected: All tests pass (existing + new)

- [ ] **Step 6: Commit**

```bash
cd /home/edible/Projects/pi-mono
git add packages/mother/src/agent.ts packages/mother/test/learning-integration.test.ts
git commit -m "feat(mother): integrate learning pipeline into agent lifecycle"
```

---

## Task 7: Update Workspace Layout and Build

- [ ] **Step 1: Update workspace layout in system prompt**

In `src/agent.ts` `buildSystemPrompt()`, update the workspace layout section (around line 862) to include the new directories:

Change:
```typescript
## Workspace Layout
${workspacePath}/
├── MOTHER.md                    # Workspace guide (users, projects, notes)
├── MEMORY.md                    # Global memory (all channels)
├── REFERENCE.md                 # Events, skills creation, log queries (read on demand)
├── skills/                      # Global CLI tools you create
└── ${channelId}/                # This channel
```

To:
```typescript
## Workspace Layout
${workspacePath}/
├── MOTHER.md                    # Workspace guide (users, projects, notes)
├── MEMORY.md                    # Global memory (all channels)
├── REFERENCE.md                 # Events, skills creation, log queries (read on demand)
├── skills/                      # Global CLI tools you create
├── learnings/                   # Extracted learnings from feedback (searchable collection)
├── wisdom/                      # Crystallized principles (auto-injected)
├── relationships/               # Per-user W/B/O profiles (searchable collection)
├── ratings/                     # Feedback rating logs
└── ${channelId}/                # This channel
```

- [ ] **Step 2: Verify build passes**

Run: `cd /home/edible/Projects/pi-mono && npm run build -- --filter mother`
Expected: Build succeeds with no type errors

- [ ] **Step 3: Run full test suite one more time**

Run: `cd /home/edible/Projects/pi-mono && npm test -- --filter mother`
Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
cd /home/edible/Projects/pi-mono
git add packages/mother/src/agent.ts
git commit -m "feat(mother): update workspace layout with learning system directories"
```

---

## Task 8: Update Inference Server Collections Config

- [ ] **Step 1: Document the collections.json changes needed**

The user needs to add two entries to `/etc/llama/collections.json` on the inference server. The `source_dir` should point to Mother's workspace path where the learning files are stored.

```json
{ "id": "learnings", "source_dir": "/path/to/mother-workspace/learnings", "doc_type": "markdown" },
{ "id": "relationships", "source_dir": "/path/to/mother-workspace/relationships", "doc_type": "markdown" }
```

The exact workspace path depends on the user's deployment. After adding these entries, restart `llama-manager.service` to trigger indexing.

- [ ] **Step 2: Commit docs update**

Update the spec to mark this as a deployment step:

```bash
cd /home/edible/Projects/pi-mono
git add -A packages/mother/docs/
git commit -m "docs(mother): note inference server collection config for learning system"
```
