/**
 * Vector DB search tool for Mother.
 *
 * Queries the inference server's collection search endpoint for semantically
 * similar documents. Returns ranked summaries with document IDs that can be
 * loaded via the recall tool.
 */
import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { TextContent } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import type { MotherSettingsManager } from "../context.js";

/**
 * Derive the inference server base URL (without /v1) from the Ollama URL setting.
 * The Ollama URL is typically "http://host:port/v1" but collection endpoints
 * live at the root: /collections/...
 */
export function getBaseUrl(settings: MotherSettingsManager): string {
	const ollamaUrl = settings.getOllamaUrl();
	return ollamaUrl.replace(/\/v1\/?$/, "");
}

interface SearchResult {
	id: string;
	name: string;
	collection: string;
	summary: string;
	tags: string[];
	score: number;
	children?: { id: string; name: string; summary: string }[];
}

const searchSchema = Type.Object({
	label: Type.Optional(Type.String({ description: "Brief description of what you're searching for (shown to user)" })),
	collection: Type.String({ description: "Collection ID to search (e.g. 'skills', 'notes')" }),
	query: Type.String({ description: "Natural language search query" }),
	limit: Type.Optional(Type.Number({ description: "Max results to return (default 5)" })),
	tags: Type.Optional(Type.Array(Type.String(), { description: "Filter results by tags" })),
});

export function createSearchTool(settings?: MotherSettingsManager): AgentTool<typeof searchSchema> {
	return {
		name: "search",
		label: "search",
		description:
			"Search the knowledge base for relevant documents by natural language query. Returns ranked summaries with document IDs that can be loaded with the recall tool.",
		parameters: searchSchema,
		execute: async (
			_toolCallId: string,
			{
				collection,
				query,
				limit,
				tags,
			}: { label?: string; collection: string; query: string; limit?: number; tags?: string[] },
			signal?: AbortSignal,
		): Promise<{ content: TextContent[]; details: undefined }> => {
			if (!settings) {
				throw new Error("Settings not available — cannot determine inference server URL");
			}

			const baseUrl = getBaseUrl(settings);
			const url = `${baseUrl}/collections/${encodeURIComponent(collection)}/search`;

			const body: Record<string, unknown> = { query, limit: limit ?? 5 };
			if (tags && tags.length > 0) {
				body.tags = tags;
			}

			const response = await fetch(url, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
				signal,
			});

			if (!response.ok) {
				const text = await response.text().catch(() => "");
				throw new Error(`Search failed (HTTP ${response.status}): ${text}`);
			}

			const data = (await response.json()) as { results: SearchResult[] };
			const results = data.results;

			if (results.length === 0) {
				return {
					content: [{ type: "text", text: `No results found in "${collection}" for: ${query}` }],
					details: undefined,
				};
			}

			let output = `Found ${results.length} result${results.length === 1 ? "" : "s"} in "${collection}":\n`;

			for (let i = 0; i < results.length; i++) {
				const r = results[i];
				output += `\n${i + 1}. ${r.id} (score: ${r.score.toFixed(2)})`;
				output += `\n   ${r.summary}`;
				if (r.tags.length > 0) {
					output += `\n   Tags: ${r.tags.join(", ")}`;
				}
				if (r.children && r.children.length > 0) {
					for (const child of r.children) {
						output += `\n   - ${child.id}: ${child.summary}`;
					}
				}
			}

			return {
				content: [{ type: "text", text: output }],
				details: undefined,
			};
		},
	};
}
