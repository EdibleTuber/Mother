/**
 * Vector DB document retrieval tool for Mother.
 *
 * Fetches full document content from the inference server's collection
 * endpoint by collection and document ID. Used after searching to load
 * a specific document into context.
 */
import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { TextContent } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import type { MotherSettingsManager } from "../context.js";
import { getBaseUrl } from "./search.js";

interface Document {
	id: string;
	name: string;
	collection: string;
	summary: string;
	content: string;
	metadata: Record<string, unknown>;
}

const recallSchema = Type.Object({
	label: Type.Optional(Type.String({ description: "Brief description of what you're retrieving (shown to user)" })),
	collection: Type.String({ description: "Collection the document belongs to (e.g. 'skills', 'notes')" }),
	id: Type.String({ description: "Document ID from search results (e.g. 'Security/Recon')" }),
});

export function createRecallTool(settings?: MotherSettingsManager): AgentTool<typeof recallSchema> {
	return {
		name: "recall",
		label: "recall",
		description:
			"Retrieve full document content from the knowledge base by collection and document ID. Use after searching to load a specific document into context.",
		parameters: recallSchema,
		execute: async (
			_toolCallId: string,
			{ collection, id }: { label?: string; collection: string; id: string },
			signal?: AbortSignal,
		): Promise<{ content: TextContent[]; details: undefined }> => {
			if (!settings) {
				throw new Error("Settings not available — cannot determine inference server URL");
			}

			const baseUrl = getBaseUrl(settings);
			const url = `${baseUrl}/collections/${encodeURIComponent(collection)}/docs/${id}`;

			const response = await fetch(url, { signal });

			if (response.status === 404) {
				throw new Error(`Document not found: ${id} in collection "${collection}"`);
			}

			if (!response.ok) {
				const text = await response.text().catch(() => "");
				throw new Error(`Recall failed (HTTP ${response.status}): ${text}`);
			}

			const doc = (await response.json()) as Document;

			let output = `# ${doc.name}\nCollection: ${doc.collection}\n`;

			const meta = doc.metadata;
			if (meta && Object.keys(meta).length > 0) {
				if (meta.tags && Array.isArray(meta.tags)) {
					output += `Tags: ${(meta.tags as string[]).join(", ")}\n`;
				}
				if (meta.category) {
					output += `Category: ${meta.category}\n`;
				}
			}

			output += `\n${doc.content}`;

			return {
				content: [{ type: "text", text: output }],
				details: undefined,
			};
		},
	};
}
