import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

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

		const base = {
			topic: "test",
			insight: "test insight",
			category: "approach" as const,
			tags: [],
			rating: 5,
			sentiment: "neutral" as const,
			userId: "u1",
			channelId: "c1",
		};
		const path1 = await writeLearningFile(learningsDir, base);
		const path2 = await writeLearningFile(learningsDir, { ...base, topic: "test2" });

		expect(path1).not.toBe(path2);
		expect(readdirSync(learningsDir)).toHaveLength(2);
	});
});

describe("buildExtractionPrompt", () => {
	it("includes rating and conversation context", async () => {
		const { buildExtractionPrompt } = await import("../src/learning.js");
		const prompt = buildExtractionPrompt(
			3,
			"negative",
			"wrong file path",
			"User: fix the bug\nAssistant: I edited /tmp/foo.ts",
		);
		expect(prompt).toContain("3/10");
		expect(prompt).toContain("negative");
		expect(prompt).toContain("wrong file path");
		expect(prompt).toContain("fix the bug");
	});
});
