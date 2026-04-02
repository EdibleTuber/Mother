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
		const cleaned = text
			.replace(/^```(?:json)?\n?/m, "")
			.replace(/\n?```$/m, "")
			.trim();
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
