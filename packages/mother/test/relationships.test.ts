import { describe, expect, it } from "vitest";

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
