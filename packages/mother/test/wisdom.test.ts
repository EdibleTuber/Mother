import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

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
			confidence: 0.6,
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

		promoteWisdom(wisdomDir, 0.8);

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

		promoteWisdom(wisdomDir, 0.8);

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

		decayWisdom(wisdomDir, 90, 0.1, 0.5);

		const active = parseWisdomFile(readFileSync(join(wisdomDir, "active.md"), "utf-8"));
		const archive = parseWisdomFile(readFileSync(join(wisdomDir, "archive.md"), "utf-8"));
		expect(active).toHaveLength(0);
		expect(archive).toHaveLength(1);
		expect(archive[0].confidence).toBe(0.45);
	});
});
