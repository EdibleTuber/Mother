/**
 * Wisdom Crystallization Module for Mother.
 *
 * Manages distilled wisdom derived from clustered learnings. Wisdom lives in
 * three markdown files per workspace:
 *   wisdom/pending.md  — candidates under evaluation
 *   wisdom/active.md   — promoted wisdom injected into context
 *   wisdom/archive.md  — decayed/retired entries
 *
 * Each entry in the markdown files follows this format:
 *   ## Title [confidence: NN%]
 *   Body text.
 *   - Sources: description
 *   - Last updated: YYYY-MM-DD
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MotherSettingsManager } from "./context.js";
import * as log from "./log.js";
import { getBaseUrl } from "./tools/search.js";

// ============================================================================
// Types
// ============================================================================

export interface WisdomEntry {
	title: string;
	confidence: number; // 0-1
	body: string;
	sources: string;
	lastUpdated: string; // YYYY-MM-DD
}

// ============================================================================
// Parse / Serialize
// ============================================================================

/**
 * Parse a wisdom markdown file into an array of WisdomEntry objects.
 */
export function parseWisdomFile(content: string): WisdomEntry[] {
	if (!content.trim()) return [];

	const entries: WisdomEntry[] = [];

	// Split on lines starting with "## " — each signals a new entry
	const blocks = content.split(/\n(?=## )/);

	for (const block of blocks) {
		const trimmed = block.trim();
		if (!trimmed) continue;

		// Header line: ## Title [confidence: NN%]
		const headerMatch = trimmed.match(/^## (.+?) \[confidence: (\d+)%\]/);
		if (!headerMatch) continue;

		const title = headerMatch[1].trim();
		const confidence = parseInt(headerMatch[2], 10) / 100;

		// Rest of the block after the header line
		const rest = trimmed.substring(trimmed.indexOf("\n") + 1);

		// Sources line
		const sourcesMatch = rest.match(/^- Sources: (.+)$/m);
		const sources = sourcesMatch ? sourcesMatch[1].trim() : "";

		// Last updated line
		const lastUpdatedMatch = rest.match(/^- Last updated: (.+)$/m);
		const lastUpdated = lastUpdatedMatch ? lastUpdatedMatch[1].trim() : "";

		// Body: lines that aren't the sources/lastUpdated metadata lines
		const bodyLines: string[] = [];
		for (const line of rest.split("\n")) {
			if (line.startsWith("- Sources:") || line.startsWith("- Last updated:")) continue;
			bodyLines.push(line);
		}
		const body = bodyLines.join("\n").trim();

		entries.push({ title, confidence, body, sources, lastUpdated });
	}

	return entries;
}

/**
 * Serialize an array of WisdomEntry objects to markdown string.
 */
export function serializeWisdomFile(entries: WisdomEntry[]): string {
	if (entries.length === 0) return "";

	return entries
		.map((entry) => {
			const pct = Math.round(entry.confidence * 100);
			return [
				`## ${entry.title} [confidence: ${pct}%]`,
				entry.body,
				`- Sources: ${entry.sources}`,
				`- Last updated: ${entry.lastUpdated}`,
			].join("\n");
		})
		.join("\n\n");
}

// ============================================================================
// File operations
// ============================================================================

function readWisdomFile(wisdomDir: string, filename: string): WisdomEntry[] {
	const filePath = join(wisdomDir, filename);
	if (!existsSync(filePath)) return [];
	const content = readFileSync(filePath, "utf-8");
	return parseWisdomFile(content);
}

function writeWisdomFile(wisdomDir: string, filename: string, entries: WisdomEntry[]): void {
	const filePath = join(wisdomDir, filename);
	writeFileSync(filePath, serializeWisdomFile(entries), "utf-8");
}

/**
 * Add or update an entry in pending.md. If an entry with the same title
 * already exists, it is replaced (dedup by title).
 */
export function addPendingWisdom(wisdomDir: string, entry: WisdomEntry): void {
	const existing = readWisdomFile(wisdomDir, "pending.md");
	const idx = existing.findIndex((e) => e.title.toLowerCase() === entry.title.toLowerCase());
	if (idx !== -1) {
		existing[idx] = entry;
	} else {
		existing.push(entry);
	}
	writeWisdomFile(wisdomDir, "pending.md", existing);
}

/**
 * Promote entries from pending.md to active.md when confidence >= threshold.
 * Entries already in active.md with the same title are replaced.
 */
export function promoteWisdom(wisdomDir: string, threshold: number): void {
	const pending = readWisdomFile(wisdomDir, "pending.md");
	const active = readWisdomFile(wisdomDir, "active.md");

	const toPromote = pending.filter((e) => e.confidence >= threshold);
	const remaining = pending.filter((e) => e.confidence < threshold);

	for (const entry of toPromote) {
		const idx = active.findIndex((e) => e.title.toLowerCase() === entry.title.toLowerCase());
		if (idx !== -1) {
			active[idx] = entry;
		} else {
			active.push(entry);
		}
	}

	writeWisdomFile(wisdomDir, "pending.md", remaining);
	writeWisdomFile(wisdomDir, "active.md", active);
}

/**
 * Read active.md and return its content truncated to maxChars.
 * Returns empty string if active.md doesn't exist.
 */
export function getActiveWisdom(wisdomDir: string, maxChars: number): string {
	const filePath = join(wisdomDir, "active.md");
	if (!existsSync(filePath)) return "";
	const content = readFileSync(filePath, "utf-8");
	if (content.length <= maxChars) return content;
	return content.substring(0, maxChars);
}

/**
 * Decay stale entries in active.md:
 * - Entries whose lastUpdated is older than decayDays get confidence reduced by decayAmount.
 * - Entries whose new confidence falls below archiveThreshold are moved to archive.md.
 */
export function decayWisdom(wisdomDir: string, decayDays: number, decayAmount: number, archiveThreshold: number): void {
	const active = readWisdomFile(wisdomDir, "active.md");
	const archive = readWisdomFile(wisdomDir, "archive.md");

	const now = Date.now();
	const decayMs = decayDays * 24 * 60 * 60 * 1000;

	const stillActive: WisdomEntry[] = [];

	for (const entry of active) {
		const updatedMs = new Date(entry.lastUpdated).getTime();
		const ageMs = now - updatedMs;

		if (ageMs >= decayMs) {
			// Apply decay, round to 2 decimal places to avoid floating-point noise
			const newConfidence = Math.round((entry.confidence - decayAmount) * 100) / 100;
			const decayed = { ...entry, confidence: newConfidence };

			if (newConfidence < archiveThreshold) {
				// Move to archive
				const idx = archive.findIndex((e) => e.title.toLowerCase() === entry.title.toLowerCase());
				if (idx !== -1) {
					archive[idx] = decayed;
				} else {
					archive.push(decayed);
				}
			} else {
				stillActive.push(decayed);
			}
		} else {
			stillActive.push(entry);
		}
	}

	writeWisdomFile(wisdomDir, "active.md", stillActive);
	writeWisdomFile(wisdomDir, "archive.md", archive);
}

// ============================================================================
// Cluster detection (async, uses inference server)
// ============================================================================

/**
 * Search the learnings collection for entries similar to the given insight/topic.
 * Returns whether a wisdom candidate should be created and how large the cluster is.
 */
export async function checkWisdomCandidate(
	settings: MotherSettingsManager,
	learningInsight: string,
	learningTopic: string,
	signal?: AbortSignal,
): Promise<{ shouldCreate: boolean; clusterSize: number }> {
	const wisdomSettings = settings.getWisdomSettings();
	const baseUrl = getBaseUrl(settings);

	const query = `${learningTopic}: ${learningInsight}`;

	try {
		const url = `${baseUrl}/collections/learnings/search`;
		const response = await fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				query,
				limit: 20,
				threshold: wisdomSettings.clusterSimilarityThreshold,
			}),
			signal,
		});

		if (!response.ok) {
			log.logWarning(`wisdom: cluster search failed (${response.status})`);
			return { shouldCreate: false, clusterSize: 0 };
		}

		const data = (await response.json()) as { results?: unknown[] };
		const clusterSize = Array.isArray(data.results) ? data.results.length : 0;
		const shouldCreate = clusterSize >= wisdomSettings.clusterMinOccurrences;

		return { shouldCreate, clusterSize };
	} catch (err) {
		if ((err as Error).name !== "AbortError") {
			log.logWarning(`wisdom: cluster search error`, String(err));
		}
		return { shouldCreate: false, clusterSize: 0 };
	}
}

// ============================================================================
// Orchestration
// ============================================================================

/**
 * Check if a new learning creates a cluster large enough to warrant wisdom,
 * then add to pending and attempt promotion.
 */
export async function processWisdomFromLearning(
	settings: MotherSettingsManager,
	workspacePath: string,
	learningTopic: string,
	learningInsight: string,
	signal?: AbortSignal,
): Promise<void> {
	const wisdomSettings = settings.getWisdomSettings();
	if (!wisdomSettings.enabled) return;

	const wisdomDir = join(workspacePath, "wisdom");

	const { shouldCreate, clusterSize } = await checkWisdomCandidate(settings, learningInsight, learningTopic, signal);

	if (!shouldCreate) return;

	const today = new Date().toISOString().slice(0, 10);
	const confidence = Math.min(
		0.79, // below default promotion threshold — must accumulate more signal
		wisdomSettings.clusterMinOccurrences > 0 ? clusterSize / (wisdomSettings.clusterMinOccurrences * 2) : 0.5,
	);

	const entry: WisdomEntry = {
		title: learningTopic,
		confidence: Math.round(confidence * 100) / 100,
		body: learningInsight,
		sources: `${clusterSize} learnings (${today})`,
		lastUpdated: today,
	};

	addPendingWisdom(wisdomDir, entry);
	promoteWisdom(wisdomDir, wisdomSettings.promotionThreshold);

	log.logInfo(`wisdom: processed cluster of ${clusterSize} for topic "${learningTopic}"`);
}

/**
 * Explicitly promote a learning to wisdom at the explicitPromotionConfidence,
 * bypassing cluster detection. Immediately promotes to active.md.
 */
export async function promoteExplicitly(
	settings: MotherSettingsManager,
	workspacePath: string,
	topic: string,
	insight: string,
): Promise<void> {
	const wisdomSettings = settings.getWisdomSettings();
	const wisdomDir = join(workspacePath, "wisdom");
	const today = new Date().toISOString().slice(0, 10);

	const entry: WisdomEntry = {
		title: topic,
		confidence: wisdomSettings.explicitPromotionConfidence,
		body: insight,
		sources: `user-promoted (${today})`,
		lastUpdated: today,
	};

	addPendingWisdom(wisdomDir, entry);
	promoteWisdom(wisdomDir, wisdomSettings.promotionThreshold);

	log.logInfo(`wisdom: explicitly promoted "${topic}"`);
}
