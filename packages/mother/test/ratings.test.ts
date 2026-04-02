import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

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

		const base = {
			userId: "u1",
			channelId: "c1",
			sentiment: "neutral" as const,
			confidence: 0.5,
			context: "test",
			promotionIntent: false,
		};
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
