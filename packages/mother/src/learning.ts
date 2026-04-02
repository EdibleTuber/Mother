/**
 * Learning extraction module for Mother's self-improvement system.
 *
 * When a user gives feedback (via the rating/sentiment system), this module
 * calls the local Ollama model to extract a structured learning from the
 * conversation, then writes it as a markdown file with YAML frontmatter
 * to the workspace learnings directory.
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { MotherSettingsManager } from "./context.js";
import * as log from "./log.js";
import type { SentimentResult } from "./ratings.js";

// ============================================================================
// Types
// ============================================================================

export interface LearningResult {
	topic: string;
	insight: string;
	category: "approach" | "communication" | "tool_use" | "knowledge";
	tags: string[];
}

export interface LearningContext {
	topic: string;
	insight: string;
	category: "approach" | "communication" | "tool_use" | "knowledge";
	tags: string[];
	rating: number;
	sentiment: "positive" | "negative" | "neutral";
	userId: string;
	channelId: string;
}

// ============================================================================
// Prompt building
// ============================================================================

export function buildExtractionPrompt(
	rating: number,
	sentiment: "positive" | "negative" | "neutral",
	ratingContext: string,
	recentTurns: string,
): string {
	return `You are analyzing a conversation to extract a specific, actionable learning for an AI assistant.

The user gave a rating of ${rating}/10 with ${sentiment} sentiment.
Their feedback context: "${ratingContext}"

Recent conversation:
${recentTurns}

Extract ONE key learning from this feedback. Focus on what the assistant did wrong (if negative) or right (if positive) that should be remembered.

Respond in JSON only:
{"topic": "short topic name", "insight": "specific actionable insight", "category": "approach"|"communication"|"tool_use"|"knowledge", "tags": ["tag1", "tag2"]}

- topic: 2-5 word label for what this learning is about
- insight: 1-2 sentence actionable description of the learning
- category: one of approach, communication, tool_use, knowledge
- tags: 1-4 relevant keywords`;
}

// ============================================================================
// Parsing
// ============================================================================

export function parseLearningResponse(text: string): LearningResult | null {
	try {
		const cleaned = text
			.replace(/^```(?:json)?\n?/m, "")
			.replace(/\n?```$/m, "")
			.trim();
		const parsed = JSON.parse(cleaned);

		// Require all three core fields
		if (
			typeof parsed.topic !== "string" ||
			typeof parsed.insight !== "string" ||
			typeof parsed.category !== "string"
		) {
			return null;
		}

		const validCategories = new Set(["approach", "communication", "tool_use", "knowledge"]);
		if (!validCategories.has(parsed.category)) {
			return null;
		}

		return {
			topic: parsed.topic,
			insight: parsed.insight,
			category: parsed.category as LearningResult["category"],
			tags: Array.isArray(parsed.tags) ? parsed.tags.filter((t: unknown) => typeof t === "string") : [],
		};
	} catch {
		return null;
	}
}

// ============================================================================
// File writing
// ============================================================================

/**
 * Converts a topic string to a kebab-cased slug for use in filenames.
 */
function toSlug(topic: string): string {
	return topic
		.toLowerCase()
		.replace(/[^a-z0-9\s-]/g, "")
		.trim()
		.replace(/\s+/g, "-")
		.replace(/-+/g, "-");
}

/**
 * Formats a Date as YYYY-MM-DD_HHmmss for filenames.
 */
function formatDateForFilename(date: Date): string {
	const pad = (n: number, len = 2) => String(n).padStart(len, "0");
	const YYYY = date.getFullYear();
	const MM = pad(date.getMonth() + 1);
	const DD = pad(date.getDate());
	const HH = pad(date.getHours());
	const mm = pad(date.getMinutes());
	const ss = pad(date.getSeconds());
	return `${YYYY}-${MM}-${DD}_${HH}${mm}${ss}`;
}

/**
 * Writes a learning as a markdown file with YAML frontmatter.
 * Returns the absolute path to the written file.
 */
export async function writeLearningFile(learningsDir: string, ctx: LearningContext): Promise<string> {
	const now = new Date();
	const datePart = formatDateForFilename(now);
	const slug = toSlug(ctx.topic);
	const filename = `${datePart}_${slug}.md`;
	const filePath = join(learningsDir, filename);

	const tagsYaml = `[${ctx.tags.join(", ")}]`;
	const isoDate = now.toISOString().split("T")[0];

	const content = `---
topic: ${ctx.topic}
category: ${ctx.category}
rating: ${ctx.rating}
sentiment: ${ctx.sentiment}
tags: ${tagsYaml}
userId: ${ctx.userId}
channelId: ${ctx.channelId}
date: ${isoDate}
---

${ctx.insight}
`;

	await writeFile(filePath, content, "utf-8");
	return filePath;
}

// ============================================================================
// Main extraction entry point
// ============================================================================

/**
 * Calls the Ollama model to extract a learning from recent conversation turns,
 * writes the learning file, and returns its path (or null on failure).
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
	if (!sentimentResult.is_feedback || sentimentResult.rating === null) {
		return null;
	}

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
			log.logWarning("Learning extraction failed", "Empty response from model");
			return null;
		}

		const learning = parseLearningResponse(content);
		if (!learning) {
			log.logWarning("Learning extraction failed", "Could not parse model response");
			return null;
		}

		const learningsDir = join(workspacePath, "learnings", channelId);

		const ctx: LearningContext = {
			...learning,
			rating: sentimentResult.rating,
			sentiment: sentimentResult.sentiment,
			userId,
			channelId,
		};

		const filePath = await writeLearningFile(learningsDir, ctx);
		log.logInfo(`Learning written: ${filePath}`);
		return filePath;
	} catch (err) {
		if (signal?.aborted) return null;
		const msg = err instanceof Error ? err.message : String(err);
		log.logWarning("Learning extraction error", msg);
		return null;
	}
}
