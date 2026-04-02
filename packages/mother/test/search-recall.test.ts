import { afterEach, describe, expect, it, vi } from "vitest";
import { getBaseUrl } from "../src/tools/search.js";

// Mock settings
function mockSettings(url: string) {
	return {
		getOllamaUrl: () => url,
	} as any;
}

describe("getBaseUrl", () => {
	it("strips /v1 suffix", () => {
		expect(getBaseUrl(mockSettings("http://192.168.1.14:11434/v1"))).toBe("http://192.168.1.14:11434");
	});

	it("strips /v1/ suffix with trailing slash", () => {
		expect(getBaseUrl(mockSettings("http://192.168.1.14:11434/v1/"))).toBe("http://192.168.1.14:11434");
	});

	it("returns unchanged URL if no /v1 suffix", () => {
		expect(getBaseUrl(mockSettings("http://localhost:8080"))).toBe("http://localhost:8080");
	});
});

describe("search tool", () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("formats search results as ranked text", async () => {
		const { createSearchTool } = await import("../src/tools/search.js");

		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({
				results: [
					{
						id: "Security/Recon",
						name: "Recon",
						collection: "skills",
						summary: "Network reconnaissance techniques",
						tags: ["security", "recon"],
						score: 0.92,
					},
					{
						id: "Investigation/OSINT",
						name: "OSINT",
						collection: "skills",
						summary: "Open source intelligence",
						tags: ["investigation"],
						score: 0.71,
					},
				],
			}),
		});

		const tool = createSearchTool(mockSettings("http://localhost:11434/v1"));
		const result = await tool.execute("test-id", {
			collection: "skills",
			query: "reconnaissance",
		});

		const text = (result.content[0] as { type: "text"; text: string }).text;
		expect(text).toContain('Found 2 results in "skills"');
		expect(text).toContain("Security/Recon (score: 0.92)");
		expect(text).toContain("Network reconnaissance techniques");
		expect(text).toContain("Tags: security, recon");
		expect(text).toContain("Investigation/OSINT (score: 0.71)");
	});

	it("returns no-results message when empty", async () => {
		const { createSearchTool } = await import("../src/tools/search.js");

		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({ results: [] }),
		});

		const tool = createSearchTool(mockSettings("http://localhost:11434/v1"));
		const result = await tool.execute("test-id", {
			collection: "skills",
			query: "nonexistent",
		});

		expect((result.content[0] as { type: "text"; text: string }).text).toContain("No results found");
	});

	it("throws on HTTP error", async () => {
		const { createSearchTool } = await import("../src/tools/search.js");

		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: false,
			status: 503,
			text: async () => "Service unavailable",
		});

		const tool = createSearchTool(mockSettings("http://localhost:11434/v1"));
		await expect(tool.execute("test-id", { collection: "skills", query: "test" })).rejects.toThrow(
			"Search failed (HTTP 503)",
		);
	});

	it("includes children in output when present", async () => {
		const { createSearchTool } = await import("../src/tools/search.js");

		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({
				results: [
					{
						id: "Security/Recon/SKILL",
						name: "Recon",
						collection: "skills",
						summary: "Reconnaissance",
						tags: [],
						score: 0.9,
						children: [{ id: "Security/Recon/Workflows/Passive", name: "Passive", summary: "Passive recon" }],
					},
				],
			}),
		});

		const tool = createSearchTool(mockSettings("http://localhost:11434/v1"));
		const result = await tool.execute("test-id", { collection: "skills", query: "recon" });

		const text = (result.content[0] as { type: "text"; text: string }).text;
		expect(text).toContain("Security/Recon/Workflows/Passive: Passive recon");
	});
});

describe("recall tool", () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("returns formatted document content", async () => {
		const { createRecallTool } = await import("../src/tools/recall.js");

		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => ({
				id: "Security/Recon",
				name: "Recon",
				collection: "skills",
				summary: "Network reconnaissance",
				content: "# Recon\n\nFull content here...",
				metadata: { tags: ["security", "recon"], category: "Security" },
			}),
		});

		const tool = createRecallTool(mockSettings("http://localhost:11434/v1"));
		const result = await tool.execute("test-id", {
			collection: "skills",
			id: "Security/Recon",
		});

		const text = (result.content[0] as { type: "text"; text: string }).text;
		expect(text).toContain("# Recon");
		expect(text).toContain("Collection: skills");
		expect(text).toContain("Tags: security, recon");
		expect(text).toContain("Category: Security");
		expect(text).toContain("Full content here...");
	});

	it("throws on 404", async () => {
		const { createRecallTool } = await import("../src/tools/recall.js");

		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: false,
			status: 404,
			text: async () => "Not found",
		});

		const tool = createRecallTool(mockSettings("http://localhost:11434/v1"));
		await expect(tool.execute("test-id", { collection: "skills", id: "nonexistent" })).rejects.toThrow(
			"Document not found",
		);
	});
});
