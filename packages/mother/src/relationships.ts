/**
 * Relationship notes module for Mother.
 *
 * Tracks per-user World (W), Biographical (B), and Opinion (O) notes, stored
 * as markdown files in the workspace relationships directory. After each agent
 * run, Mother can call extractRelationshipNotes to update the profile for the
 * active user.
 *
 * File format (relationships/<userId>.md):
 *   # User: <userName> (<userId>)
 *
 *   ## World
 *   - <content> [confidence: N.NN] (YYYY-MM-DD)
 *
 *   ## Biographical
 *   - <content> (YYYY-MM-DD)
 *
 *   ## Opinions
 *   - <content> [confidence: N.NN] (YYYY-MM-DD)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MotherSettingsManager } from "./context.js";
import * as log from "./log.js";

// ============================================================================
// Types
// ============================================================================

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

// ============================================================================
// Parsing
// ============================================================================

/**
 * Parse a note line of the form:
 *   - Content text [confidence: 0.95] (2026-04-01)
 * or (biographical, no confidence):
 *   - Content text (2026-04-01)
 */
function parseNoteLine(line: string, hasConfidence: boolean): RelationshipNote | null {
	// Strip leading "- "
	const stripped = line.replace(/^-\s+/, "").trim();
	if (!stripped) return null;

	// Extract date at end: (YYYY-MM-DD)
	const dateMatch = stripped.match(/\((\d{4}-\d{2}-\d{2})\)\s*$/);
	const date = dateMatch ? dateMatch[1] : new Date().toISOString().slice(0, 10);

	// Remove the date from the text
	let rest = dateMatch ? stripped.slice(0, dateMatch.index).trim() : stripped;

	// Extract confidence if expected
	let confidence = 1.0;
	if (hasConfidence) {
		const confMatch = rest.match(/\[confidence:\s*([\d.]+)\]\s*$/);
		if (confMatch) {
			confidence = parseFloat(confMatch[1]);
			rest = rest.slice(0, confMatch.index).trim();
		}
	}

	const content = rest;
	if (!content) return null;

	return { content, confidence, date };
}

/**
 * Parse a relationship markdown file into a UserProfile.
 * Handles ## World, ## Biographical, ## Opinions sections.
 */
export function parseRelationshipFile(content: string): UserProfile {
	const profile: UserProfile = { world: [], biographical: [], opinions: [] };

	if (!content.trim()) return profile;

	type Section = "world" | "biographical" | "opinions" | null;
	let currentSection: Section = null;

	for (const rawLine of content.split("\n")) {
		const line = rawLine.trimEnd();

		if (line.startsWith("## World")) {
			currentSection = "world";
			continue;
		}
		if (line.startsWith("## Biographical")) {
			currentSection = "biographical";
			continue;
		}
		if (line.startsWith("## Opinions")) {
			currentSection = "opinions";
			continue;
		}
		if (line.startsWith("#")) {
			// Other headings (e.g., "# User: ...") reset section
			currentSection = null;
			continue;
		}

		if (!currentSection || !line.startsWith("-")) continue;

		const isBiographical = currentSection === "biographical";
		const note = parseNoteLine(line, !isBiographical);
		if (note) {
			profile[currentSection].push(note);
		}
	}

	return profile;
}

// ============================================================================
// Serialization
// ============================================================================

/**
 * Format a confidence number as a two-decimal string: e.g. 0.9 -> "0.90"
 */
function fmtConf(confidence: number): string {
	return confidence.toFixed(2);
}

/**
 * Serialize a UserProfile back to markdown.
 */
export function serializeRelationshipFile(userName: string, userId: string, profile: UserProfile): string {
	const lines: string[] = [];

	lines.push(`# User: ${userName} (${userId})`);
	lines.push("");

	lines.push("## World");
	for (const note of profile.world) {
		lines.push(`- ${note.content} [confidence: ${fmtConf(note.confidence)}] (${note.date})`);
	}
	lines.push("");

	lines.push("## Biographical");
	for (const note of profile.biographical) {
		lines.push(`- ${note.content} (${note.date})`);
	}
	lines.push("");

	lines.push("## Opinions");
	for (const note of profile.opinions) {
		lines.push(`- ${note.content} [confidence: ${fmtConf(note.confidence)}] (${note.date})`);
	}
	lines.push("");

	return lines.join("\n");
}

// ============================================================================
// Merging
// ============================================================================

/**
 * Returns true if two content strings are considered duplicates.
 * Uses substring containment as a simple deduplication heuristic.
 */
function isDuplicate(existing: string, incoming: string): boolean {
	const a = existing.toLowerCase();
	const b = incoming.toLowerCase();
	return a === b || a.includes(b) || b.includes(a);
}

/**
 * Merge newly extracted notes into an existing profile.
 * Deduplicates by substring match, updating confidence and date when matched.
 */
export function mergeNotes(profile: UserProfile, notes: ExtractedNote[]): UserProfile {
	const today = new Date().toISOString().slice(0, 10);

	// Deep clone to avoid mutation
	const merged: UserProfile = {
		world: profile.world.map((n) => ({ ...n })),
		biographical: profile.biographical.map((n) => ({ ...n })),
		opinions: profile.opinions.map((n) => ({ ...n })),
	};

	const sectionMap: Record<"W" | "B" | "O", RelationshipNote[]> = {
		W: merged.world,
		B: merged.biographical,
		O: merged.opinions,
	};

	for (const note of notes) {
		const section = sectionMap[note.type];
		const existing = section.find((n) => isDuplicate(n.content, note.content));

		if (existing) {
			existing.confidence = note.confidence;
			existing.date = today;
		} else {
			section.push({ content: note.content, confidence: note.confidence, date: today });
		}
	}

	return merged;
}

// ============================================================================
// Prompt building
// ============================================================================

/**
 * Build the extraction prompt for relationship notes.
 */
export function buildRelationshipPrompt(userName: string, userId: string, recentTurns: string): string {
	return `You are analyzing a conversation to extract factual notes about the user "${userName}" (ID: ${userId}).

Extract notes that fall into one of three categories:
- W (World): Facts about the user's environment, setup, skills, or situation
- B (Biographical): Personal events or history the user mentions
- O (Opinion): The user's preferences, opinions, or attitudes

Recent conversation:
${recentTurns}

Respond in JSON only with a "notes" array. Each note has:
- type: "W", "B", or "O"
- content: a concise factual statement (under 15 words)
- confidence: 0.0–1.0 how confident you are this is accurate

Example: {"notes": [{"type": "W", "content": "Runs a Pi 5 homelab", "confidence": 0.95}]}

If there is nothing notable to extract, respond with: {"notes": []}`;
}

// ============================================================================
// Response parsing
// ============================================================================

/**
 * Parse the model's JSON extraction response.
 * Handles optional markdown code fences.
 * Returns null on parse failure.
 */
export function parseExtractionResponse(text: string): ExtractedNote[] | null {
	try {
		const cleaned = text
			.replace(/^```(?:json)?\n?/m, "")
			.replace(/\n?```$/m, "")
			.trim();

		const parsed = JSON.parse(cleaned);

		if (!Array.isArray(parsed.notes)) return null;

		const validTypes = new Set(["W", "B", "O"]);
		const notes: ExtractedNote[] = [];

		for (const item of parsed.notes) {
			if (
				typeof item.type === "string" &&
				validTypes.has(item.type) &&
				typeof item.content === "string" &&
				typeof item.confidence === "number"
			) {
				notes.push({
					type: item.type as "W" | "B" | "O",
					content: item.content,
					confidence: item.confidence,
				});
			}
		}

		return notes;
	} catch {
		return null;
	}
}

// ============================================================================
// Main extraction entry point
// ============================================================================

/**
 * Calls the Ollama model to extract relationship notes from recent conversation,
 * reads the existing profile for this user, merges new notes, and writes the
 * updated profile to disk.
 *
 * Returns the path to the profile file, or null on failure.
 */
export async function extractRelationshipNotes(
	settings: MotherSettingsManager,
	workspacePath: string,
	userId: string,
	userName: string,
	recentTurns: string,
	signal?: AbortSignal,
): Promise<string | null> {
	const relationshipSettings = settings.getRelationshipSettings();
	if (!relationshipSettings.enabled) return null;

	const ollamaUrl = settings.getOllamaUrl();
	const modelId = settings.getDefaultModel();

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
			return null;
		}

		const data = (await response.json()) as { choices: { message: { content: string } }[] };
		const responseContent = data.choices?.[0]?.message?.content;
		if (!responseContent) {
			log.logWarning("Relationship extraction failed", "Empty response from model");
			return null;
		}

		const extractedNotes = parseExtractionResponse(responseContent);
		if (!extractedNotes) {
			log.logWarning("Relationship extraction failed", "Could not parse model response");
			return null;
		}

		if (extractedNotes.length === 0) {
			return null;
		}

		// Read existing profile
		const relationshipsDir = join(workspacePath, "relationships");
		mkdirSync(relationshipsDir, { recursive: true });

		const profilePath = join(relationshipsDir, `${userId}.md`);
		let profile: UserProfile = { world: [], biographical: [], opinions: [] };

		if (existsSync(profilePath)) {
			const existing = readFileSync(profilePath, "utf-8");
			profile = parseRelationshipFile(existing);
		}

		// Merge and write
		const merged = mergeNotes(profile, extractedNotes);
		const serialized = serializeRelationshipFile(userName, userId, merged);
		writeFileSync(profilePath, serialized, "utf-8");

		log.logInfo(`Relationship profile updated: ${profilePath}`);
		return profilePath;
	} catch (err) {
		if (err instanceof Error && err.name === "AbortError") throw err;
		log.logWarning("Relationship extraction failed", String(err));
		return null;
	}
}
