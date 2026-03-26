/**
 * Context management for mother.
 *
 * Mother uses two files per channel:
 * - context.jsonl: Structured API messages for LLM context (same format as coding-agent sessions)
 * - log.jsonl: Human-readable channel history for grep (no tool results)
 *
 * This module provides:
 * - syncLogToSessionManager: Syncs messages from log.jsonl to SessionManager
 * - MotherSettingsManager: Simple settings for mother (compaction, retry, model preferences)
 */

import type { UserMessage } from "@mariozechner/pi-ai";
import type { SessionManager, SessionMessageEntry } from "@mariozechner/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";

// ============================================================================
// Sync log.jsonl to SessionManager
// ============================================================================

interface LogMessage {
	date?: string;
	ts?: string;
	user?: string;
	userName?: string;
	text?: string;
	isBot?: boolean;
}

/**
 * Sync user messages from log.jsonl to SessionManager.
 *
 * This ensures that messages logged while mother wasn't running (channel chatter,
 * messages while busy) are added to the LLM context.
 *
 * @param sessionManager - The SessionManager to sync to
 * @param channelDir - Path to channel directory containing log.jsonl
 * @param excludeTs - Timestamp of current message (will be added via prompt(), not sync)
 * @returns Number of messages synced
 */
export function syncLogToSessionManager(
	sessionManager: SessionManager,
	channelDir: string,
	excludeTs?: string,
): number {
	const logFile = join(channelDir, "log.jsonl");

	if (!existsSync(logFile)) return 0;

	// Build set of existing message content from session
	const existingMessages = new Set<string>();
	for (const entry of sessionManager.getEntries()) {
		if (entry.type === "message") {
			const msgEntry = entry as SessionMessageEntry;
			const msg = msgEntry.message as { role: string; content?: unknown };
			if (msg.role === "user" && msg.content !== undefined) {
				const content = msg.content;
				if (typeof content === "string") {
					// Strip timestamp prefix for comparison (live messages have it, synced don't)
					// Format: [YYYY-MM-DD HH:MM:SS+HH:MM] [username]: text
					let normalized = content.replace(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}\] /, "");
					// Strip attachments section
					const attachmentsIdx = normalized.indexOf("\n\n<discord_attachments>\n");
					if (attachmentsIdx !== -1) {
						normalized = normalized.substring(0, attachmentsIdx);
					}
					existingMessages.add(normalized);
				} else if (Array.isArray(content)) {
					for (const part of content) {
						if (
							typeof part === "object" &&
							part !== null &&
							"type" in part &&
							part.type === "text" &&
							"text" in part
						) {
							let normalized = (part as { type: "text"; text: string }).text;
							normalized = normalized.replace(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}\] /, "");
							const attachmentsIdx = normalized.indexOf("\n\n<discord_attachments>\n");
							if (attachmentsIdx !== -1) {
								normalized = normalized.substring(0, attachmentsIdx);
							}
							existingMessages.add(normalized);
						}
					}
				}
			}
		}
	}

	// Read log.jsonl and find user messages not in context
	const logContent = readFileSync(logFile, "utf-8");
	const logLines = logContent.trim().split("\n").filter(Boolean);

	const newMessages: Array<{ timestamp: number; message: UserMessage }> = [];

	for (const line of logLines) {
		try {
			const logMsg: LogMessage = JSON.parse(line);

			const ts = logMsg.ts;
			const date = logMsg.date;
			if (!ts || !date) continue;

			// Skip the current message being processed (will be added via prompt())
			if (excludeTs && ts === excludeTs) continue;

			// Skip bot messages - added through agent flow
			if (logMsg.isBot) continue;

			// Build the message text as it would appear in context
			const messageText = `[${logMsg.userName || logMsg.user || "unknown"}]: ${logMsg.text || ""}`;

			// Skip if this exact message text is already in context
			if (existingMessages.has(messageText)) continue;

			const msgTime = new Date(date).getTime() || Date.now();
			const userMessage: UserMessage = {
				role: "user",
				content: [{ type: "text", text: messageText }],
				timestamp: msgTime,
			};

			newMessages.push({ timestamp: msgTime, message: userMessage });
			existingMessages.add(messageText); // Track to avoid duplicates within this sync
		} catch {
			// Skip malformed lines
		}
	}

	if (newMessages.length === 0) return 0;

	// Sort by timestamp and add to session
	newMessages.sort((a, b) => a.timestamp - b.timestamp);

	for (const { message } of newMessages) {
		sessionManager.appendMessage(message);
	}

	return newMessages.length;
}

// ============================================================================
// MotherSettingsManager - Simple settings for mother
// ============================================================================

export interface MotherCompactionSettings {
	enabled: boolean;
	reserveTokens: number;
	keepRecentTokens: number;
}

export interface MotherRetrySettings {
	enabled: boolean;
	maxRetries: number;
	baseDelayMs: number;
}

export interface MotherSettings {
	defaultProvider?: string;
	defaultModel?: string;
	defaultThinkingLevel?: "off" | "minimal" | "low" | "medium" | "high";
	compaction?: Partial<MotherCompactionSettings>;
	retry?: Partial<MotherRetrySettings>;
	ollamaUrl?: string;
	modelsJsonPath?: string;
	contextWindow?: number;
	maxTokens?: number;
	memory?: Partial<MotherMemorySettings>;
	context?: Partial<MotherContextSettings>;
	discord?: Partial<MotherDiscordSettings>;
	tools?: Partial<MotherToolsSettings>;
	events?: Partial<MotherEventsSettings>;
}

const DEFAULT_COMPACTION: MotherCompactionSettings = {
	enabled: true,
	reserveTokens: 16384,
	keepRecentTokens: 20000,
};

const DEFAULT_RETRY: MotherRetrySettings = {
	enabled: true,
	maxRetries: 3,
	baseDelayMs: 2000,
};

export interface MotherModelSettings {
	provider: string;
	modelId: string;
	ollamaUrl: string;
	modelsJsonPath: string;
	contextWindow: number;
	maxTokens: number;
}

export interface MotherMemorySettings {
	globalMaxChars: number;
	channelMaxChars: number;
	motherMaxChars: number;
}

export interface MotherContextSettings {
	maxTurns: number;
	fileTreeMaxDepth: number;
	fileTreeMaxEntries: number;
}

export interface MotherDiscordSettings {
	editRateLimit: number;
	maxQueuedEvents: number;
	threadName: string;
}

export interface MotherToolsSettings {
	bashMaxLines: number;
	bashMaxBytes: number;
}

export interface MotherEventsSettings {
	debounceMs: number;
	maxRetries: number;
	retryBaseMs: number;
}

const DEFAULT_MODEL: MotherModelSettings = {
	provider: "ollama",
	modelId: "Qwen3.5-35B-A3B-Uncensored-HauhauCS-Aggressive-Q4_K_M",
	ollamaUrl: "http://192.168.1.14:11434/v1",
	modelsJsonPath: "~/.pi/mother/models.json",
	contextWindow: 128000,
	maxTokens: 32768,
};

const DEFAULT_MEMORY: MotherMemorySettings = {
	globalMaxChars: 1500,
	channelMaxChars: 1000,
	motherMaxChars: 3000,
};

const DEFAULT_CONTEXT: MotherContextSettings = {
	maxTurns: 10,
	fileTreeMaxDepth: 4,
	fileTreeMaxEntries: 150,
};

const DEFAULT_DISCORD: MotherDiscordSettings = {
	editRateLimit: 1000,
	maxQueuedEvents: 5,
	threadName: "Details",
};

const DEFAULT_TOOLS: MotherToolsSettings = {
	bashMaxLines: 2000,
	bashMaxBytes: 50 * 1024,
};

const DEFAULT_EVENTS: MotherEventsSettings = {
	debounceMs: 100,
	maxRetries: 3,
	retryBaseMs: 100,
};

/**
 * Settings manager for mother.
 * Stores settings in the workspace root directory.
 */
export class MotherSettingsManager {
	private settingsPath: string;
	private settings: MotherSettings;

	constructor(workspaceDir: string) {
		this.settingsPath = join(workspaceDir, "settings.json");
		this.settings = this.load();
	}

	private load(): MotherSettings {
		if (!existsSync(this.settingsPath)) {
			return {};
		}

		try {
			const content = readFileSync(this.settingsPath, "utf-8");
			return JSON.parse(content);
		} catch {
			return {};
		}
	}

	private save(): void {
		try {
			const dir = dirname(this.settingsPath);
			if (!existsSync(dir)) {
				mkdirSync(dir, { recursive: true });
			}
			writeFileSync(this.settingsPath, JSON.stringify(this.settings, null, 2), "utf-8");
		} catch (error) {
			console.error(`Warning: Could not save settings file: ${error}`);
		}
	}

	getCompactionSettings(): MotherCompactionSettings {
		return {
			...DEFAULT_COMPACTION,
			...this.settings.compaction,
		};
	}

	getCompactionEnabled(): boolean {
		return this.settings.compaction?.enabled ?? DEFAULT_COMPACTION.enabled;
	}

	setCompactionEnabled(enabled: boolean): void {
		this.settings.compaction = { ...this.settings.compaction, enabled };
		this.save();
	}

	getRetrySettings(): MotherRetrySettings {
		return {
			...DEFAULT_RETRY,
			...this.settings.retry,
		};
	}

	getRetryEnabled(): boolean {
		return this.settings.retry?.enabled ?? DEFAULT_RETRY.enabled;
	}

	setRetryEnabled(enabled: boolean): void {
		this.settings.retry = { ...this.settings.retry, enabled };
		this.save();
	}

	getDefaultModel(): string {
		return this.settings.defaultModel || process.env.MOTHER_MODEL_ID || DEFAULT_MODEL.modelId;
	}

	getDefaultProvider(): string {
		return this.settings.defaultProvider || process.env.MOTHER_MODEL_PROVIDER || DEFAULT_MODEL.provider;
	}

	getOllamaUrl(): string {
		return this.settings.ollamaUrl || process.env.MOTHER_OLLAMA_URL || DEFAULT_MODEL.ollamaUrl;
	}

	getModelsJsonPath(): string {
		const raw = this.settings.modelsJsonPath || process.env.MOTHER_MODELS_JSON || DEFAULT_MODEL.modelsJsonPath;
		return raw.startsWith("~") ? raw.replace("~", homedir()) : raw;
	}

	getContextWindow(): number {
		return this.settings.contextWindow ?? DEFAULT_MODEL.contextWindow;
	}

	getMaxTokens(): number {
		return this.settings.maxTokens ?? DEFAULT_MODEL.maxTokens;
	}

	getMemorySettings(): MotherMemorySettings {
		return { ...DEFAULT_MEMORY, ...this.settings.memory };
	}

	getContextSettings(): MotherContextSettings {
		return { ...DEFAULT_CONTEXT, ...this.settings.context };
	}

	getDiscordSettings(): MotherDiscordSettings {
		return { ...DEFAULT_DISCORD, ...this.settings.discord };
	}

	getToolsSettings(): MotherToolsSettings {
		return { ...DEFAULT_TOOLS, ...this.settings.tools };
	}

	getEventsSettings(): MotherEventsSettings {
		return { ...DEFAULT_EVENTS, ...this.settings.events };
	}

	setDefaultModelAndProvider(provider: string, modelId: string): void {
		this.settings.defaultProvider = provider;
		this.settings.defaultModel = modelId;
		this.save();
	}

	getDefaultThinkingLevel(): string {
		return this.settings.defaultThinkingLevel || "off";
	}

	setDefaultThinkingLevel(level: string): void {
		this.settings.defaultThinkingLevel = level as MotherSettings["defaultThinkingLevel"];
		this.save();
	}

	// Compatibility methods for AgentSession
	getSteeringMode(): "all" | "one-at-a-time" {
		return "one-at-a-time";
	}

	setSteeringMode(_mode: "all" | "one-at-a-time"): void {
		// No-op
	}

	getFollowUpMode(): "all" | "one-at-a-time" {
		return "one-at-a-time";
	}

	setFollowUpMode(_mode: "all" | "one-at-a-time"): void {
		// No-op
	}

	getHookPaths(): string[] {
		return [];
	}

	getHookTimeout(): number {
		return 30000;
	}

	getImageAutoResize(): boolean {
		return false;
	}

	setImageAutoResize(_enabled: boolean): void {
		// No-op
	}

	getShellCommandPrefix(): string | undefined {
		return undefined;
	}

	setShellCommandPrefix(_prefix: string | undefined): void {
		// No-op
	}

	getBranchSummarySettings(): { enabled: boolean } {
		return { enabled: false };
	}

	setBranchSummaryEnabled(_enabled: boolean): void {
		// No-op
	}

	getTheme(): string | undefined {
		return undefined;
	}

	setTheme(_theme: string | undefined): void {
		// No-op
	}

	reload(): void {
		this.settings = this.load();
	}
}
