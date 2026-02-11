import { Agent, type AgentEvent, type AgentMessage } from "@mariozechner/pi-agent-core";
import { getModel, type ImageContent, type UserMessage } from "@mariozechner/pi-ai";
import {
	AgentSession,
	AuthStorage,
	convertToLlm,
	createExtensionRuntime,
	formatSkillsForPrompt,
	loadSkillsFromDir,
	ModelRegistry,
	type ResourceLoader,
	SessionManager,
	type Skill,
} from "@mariozechner/pi-coding-agent";
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { mkdir, writeFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
import { MotherSettingsManager, syncLogToSessionManager } from "./context.js";
import type { ChannelInfo, DiscordContext, UserInfo } from "./discord.js";
import * as log from "./log.js";
import { createExecutor, type SandboxConfig } from "./sandbox.js";
import type { ChannelStore } from "./store.js";
import { createMomTools, setUploadFunction } from "./tools/index.js";

// ============================================================================
// Model configuration
// ============================================================================

const MOTHER_MODEL_PROVIDER = process.env.MOTHER_MODEL_PROVIDER || "anthropic";
const MOTHER_MODEL_ID = process.env.MOTHER_MODEL_ID || "claude-haiku-4-5";
const MOTHER_OLLAMA_URL = process.env.MOTHER_OLLAMA_URL || "http://192.168.1.41:11434/v1";
const MOTHER_MODELS_JSON = process.env.MOTHER_MODELS_JSON || join(homedir(), ".pi", "mother", "models.json");

function resolveModel(): any {
	// Check for custom models.json first
	const modelsPaths = [MOTHER_MODELS_JSON, join(homedir(), ".pi", "agent", "models.json")];

	for (const modelsPath of modelsPaths) {
		if (existsSync(modelsPath)) {
			try {
				const modelsConfig = JSON.parse(readFileSync(modelsPath, "utf-8"));
				if (Array.isArray(modelsConfig)) {
					const match = modelsConfig.find(
						(m: any) => m.provider === MOTHER_MODEL_PROVIDER && m.id === MOTHER_MODEL_ID,
					);
					if (match) {
						log.logInfo(`Loaded model config from ${modelsPath}: ${MOTHER_MODEL_PROVIDER}/${MOTHER_MODEL_ID}`);
						return match;
					}
				}
			} catch (err) {
				log.logWarning(`Failed to parse models config: ${modelsPath}`, String(err));
			}
		}
	}

	// Try built-in model registry (returns undefined if not found, doesn't throw)
	try {
		const builtIn = getModel(MOTHER_MODEL_PROVIDER as any, MOTHER_MODEL_ID as any);
		if (builtIn) {
			return builtIn;
		}
	} catch {
		// Not found in registry — use fallback
	}

	// Fallback: construct model for ollama provider
	log.logInfo(`Using ollama model: ${MOTHER_MODEL_ID} at ${MOTHER_OLLAMA_URL}`);
	return {
		id: MOTHER_MODEL_ID,
		name: MOTHER_MODEL_ID,
		api: "openai-completions",
		provider: MOTHER_MODEL_PROVIDER,
		baseUrl: MOTHER_OLLAMA_URL,
		reasoning: false,
		input: ["text"] as ("text" | "image")[],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 32768,
		// Mother-specific: thinking output filtering
		thinkingInText: false, // qwen3 uses proper thinking blocks, not text-prefixed thinking
		intermediateToThread: true, // Route intermediate messages (stopReason="toolUse") to thread only
		showThinkingInThread: false, // Post thinking blocks to thread (always logged regardless)
	};
}

// NOTE: Model is resolved lazily in createRunner() to ensure env vars are available

/**
 * Check if ollama server is reachable.
 * Returns error message if unreachable, undefined if ok.
 */
async function checkOllamaHealth(): Promise<string | undefined> {
	if (MOTHER_MODEL_PROVIDER !== "ollama") {
		return undefined;
	}

	try {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 5000);

		// Ollama v1 API has a /models endpoint we can ping
		const baseUrl = MOTHER_OLLAMA_URL.replace(/\/v1\/?$/, "");
		const response = await fetch(`${baseUrl}/api/tags`, {
			signal: controller.signal,
		});
		clearTimeout(timeout);

		if (!response.ok) {
			return `Ollama returned HTTP ${response.status}`;
		}
		return undefined;
	} catch (err) {
		if (err instanceof Error && err.name === "AbortError") {
			return `Ollama server at ${MOTHER_OLLAMA_URL} timed out`;
		}
		return `Cannot reach ollama at ${MOTHER_OLLAMA_URL}: ${err instanceof Error ? err.message : String(err)}`;
	}
}

// ============================================================================
// Types
// ============================================================================

export interface PendingMessage {
	userName: string;
	text: string;
	attachments: { local: string }[];
	timestamp: number;
}

export interface AgentRunner {
	run(
		ctx: DiscordContext,
		store: ChannelStore,
		pendingMessages?: PendingMessage[],
	): Promise<{ stopReason: string; errorMessage?: string }>;
	abort(): void;
}

const IMAGE_MIME_TYPES: Record<string, string> = {
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	png: "image/png",
	gif: "image/gif",
	webp: "image/webp",
};

function getImageMimeType(filename: string): string | undefined {
	return IMAGE_MIME_TYPES[filename.toLowerCase().split(".").pop() || ""];
}

function getMemory(channelDir: string): string {
	const parts: string[] = [];
	const MAX_GLOBAL_CHARS = 1500;
	const MAX_CHANNEL_CHARS = 1000;

	// Read workspace-level memory (shared across all channels)
	const workspaceMemoryPath = join(channelDir, "..", "MEMORY.md");
	if (existsSync(workspaceMemoryPath)) {
		try {
			let content = readFileSync(workspaceMemoryPath, "utf-8").trim();
			if (content) {
				if (content.length > MAX_GLOBAL_CHARS) {
					content =
						content.substring(0, MAX_GLOBAL_CHARS) +
						"\n[Global memory truncated — clean up MEMORY.md to remove outdated entries]";
				}
				parts.push(`### Global Workspace Memory\n${content}`);
			}
		} catch (error) {
			log.logWarning("Failed to read workspace memory", `${workspaceMemoryPath}: ${error}`);
		}
	}

	// Read channel-specific memory
	const channelMemoryPath = join(channelDir, "MEMORY.md");
	if (existsSync(channelMemoryPath)) {
		try {
			let content = readFileSync(channelMemoryPath, "utf-8").trim();
			if (content) {
				if (content.length > MAX_CHANNEL_CHARS) {
					content =
						content.substring(0, MAX_CHANNEL_CHARS) +
						"\n[Channel memory truncated — clean up MEMORY.md to remove outdated entries]";
				}
				parts.push(`### Channel-Specific Memory\n${content}`);
			}
		} catch (error) {
			log.logWarning("Failed to read channel memory", `${channelMemoryPath}: ${error}`);
		}
	}

	if (parts.length === 0) {
		return "(no working memory yet)";
	}

	return parts.join("\n\n");
}

function getMotherNotes(channelDir: string): string {
	const motherPath = join(channelDir, "..", "MOTHER.md");
	if (existsSync(motherPath)) {
		try {
			let content = readFileSync(motherPath, "utf-8").trim();
			if (content) {
				const MAX_MOTHER_CHARS = 3000;
				if (content.length > MAX_MOTHER_CHARS) {
					content = `${content.substring(0, MAX_MOTHER_CHARS)}\n[Truncated — keep MOTHER.md concise]`;
				}
				return content;
			}
		} catch (error) {
			log.logWarning("Failed to read MOTHER.md", `${motherPath}: ${error}`);
		}
	}
	return "";
}

function loadMotherSkills(channelDir: string, workspacePath: string): Skill[] {
	const skillMap = new Map<string, Skill>();

	const hostWorkspacePath = join(channelDir, "..");

	const translatePath = (hostPath: string): string => {
		if (hostPath.startsWith(hostWorkspacePath)) {
			return workspacePath + hostPath.slice(hostWorkspacePath.length);
		}
		return hostPath;
	};

	// Load workspace-level skills (global)
	const workspaceSkillsDir = join(hostWorkspacePath, "skills");
	for (const skill of loadSkillsFromDir({ dir: workspaceSkillsDir, source: "workspace" }).skills) {
		skill.filePath = translatePath(skill.filePath);
		skill.baseDir = translatePath(skill.baseDir);
		skillMap.set(skill.name, skill);
	}

	// Load channel-specific skills (override workspace skills on collision)
	const channelSkillsDir = join(channelDir, "skills");
	for (const skill of loadSkillsFromDir({ dir: channelSkillsDir, source: "channel" }).skills) {
		skill.filePath = translatePath(skill.filePath);
		skill.baseDir = translatePath(skill.baseDir);
		skillMap.set(skill.name, skill);
	}

	return Array.from(skillMap.values());
}

function generateReferenceDoc(workspacePath: string, channelId: string, isDocker: boolean): string {
	const channelPath = `${workspacePath}/${channelId}`;
	const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;

	return `# Mother Reference Guide

Auto-generated. Do not edit — changes will be overwritten.

## Skills (Custom CLI Tools)

You can create reusable CLI tools for recurring tasks (email, APIs, data processing, etc.).

### Creating Skills
Store in \`${workspacePath}/skills/<name>/\` (global) or \`${channelPath}/skills/<name>/\` (channel-specific).
Each skill directory needs a \`SKILL.md\` with YAML frontmatter:

\`\`\`markdown
---
name: skill-name
description: Short description of what this skill does
---

# Skill Name

Usage instructions, examples, etc.
Scripts are in: {baseDir}/
\`\`\`

\`name\` and \`description\` are required. Use \`{baseDir}\` as placeholder for the skill's directory path.

## Events

You can schedule events that wake you up at specific times or when external things happen. Events are JSON files in \`${workspacePath}/events/\`.

### Event Types

**Immediate** - Triggers as soon as harness sees the file. Use in scripts/webhooks to signal external events.
\`\`\`json
{"type": "immediate", "channelId": "${channelId}", "text": "New GitHub issue opened"}
\`\`\`

**One-shot** - Triggers once at a specific time. Use for reminders.
\`\`\`json
{"type": "one-shot", "channelId": "${channelId}", "text": "Remind Mario about dentist", "at": "2025-12-15T09:00:00+01:00"}
\`\`\`

**Periodic** - Triggers on a cron schedule. Use for recurring tasks.
\`\`\`json
{"type": "periodic", "channelId": "${channelId}", "text": "Check inbox and summarize", "schedule": "0 9 * * 1-5", "timezone": "${tz}"}
\`\`\`

### Cron Format
\`minute hour day-of-month month day-of-week\`
- \`0 9 * * *\` = daily at 9:00
- \`0 9 * * 1-5\` = weekdays at 9:00
- \`30 14 * * 1\` = Mondays at 14:30
- \`0 0 1 * *\` = first of each month at midnight

### Timezones
All \`at\` timestamps must include offset (e.g., \`+01:00\`). Periodic events use IANA timezone names. The harness runs in ${tz}. When users mention times without timezone, assume ${tz}.

### Creating Events
Use unique filenames to avoid overwriting existing events. Include a timestamp or random suffix:
\`\`\`bash
cat > ${workspacePath}/events/dentist-reminder-$(date +%s).json << 'EOF'
{"type": "one-shot", "channelId": "${channelId}", "text": "Dentist tomorrow", "at": "2025-12-14T09:00:00+01:00"}
EOF
\`\`\`
Or check if file exists first before creating.

### Managing Events
- List: \`ls ${workspacePath}/events/\`
- View: \`cat ${workspacePath}/events/foo.json\`
- Delete/cancel: \`rm ${workspacePath}/events/foo.json\`

### When Events Trigger
You receive a message like:
\`\`\`
[EVENT:dentist-reminder.json:one-shot:2025-12-14T09:00:00+01:00] Dentist tomorrow
\`\`\`
Immediate and one-shot events auto-delete after triggering. Periodic events persist until you delete them.

### Silent Completion
For periodic events where there's nothing to report, respond with just \`[SILENT]\` (no other text). This deletes the status message and posts nothing to Discord. Use this to avoid spamming the channel when periodic checks find nothing actionable.

### Debouncing
When writing programs that create immediate events (email watchers, webhook handlers, etc.), always debounce. If 50 emails arrive in a minute, don't create 50 immediate events. Instead collect events over a window and create ONE immediate event summarizing what happened, or just signal "new activity, check inbox" rather than per-item events. Or simpler: use a periodic event to check for new items every N minutes instead of immediate events.

### Limits
Maximum 5 events can be queued. Don't create excessive immediate or periodic events.

## System Configuration Log (SYSTEM.md)

Maintain ${workspacePath}/SYSTEM.md to log all environment modifications:
- Installed packages (apk add, npm install, pip install)
- Environment variables set
- Config files modified (~/.gitconfig, cron jobs, etc.)
- Skill dependencies installed

Update this file whenever you modify the environment. On fresh container, read it first to restore your setup.

## Log Queries (for older history)

Format: \`{"date":"...","ts":"...","user":"...","userName":"...","text":"...","isBot":false}\`
The log contains user messages and your final responses (not tool calls/results).
${isDocker ? "Install jq: apk add jq" : ""}

\`\`\`bash
# Recent messages
tail -30 log.jsonl | jq -c '{date: .date[0:19], user: (.userName // .user), text}'

# Search for specific topic
grep -i "topic" log.jsonl | jq -c '{date: .date[0:19], user: (.userName // .user), text}'

# Messages from specific user
grep '"userName":"mario"' log.jsonl | tail -20 | jq -c '{date: .date[0:19], text}'
\`\`\`
`;
}

function generateMotherTemplate(): string {
	const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
	return `# Mother Workspace Guide

## Users
- [Add user names, preferences, what they work on]

## Projects
| Name | Path | Description |
|------|------|-------------|
| [project] | [/path/to/project] | [brief description] |

When working on a project, read its PROJECT.md for detailed context.

## Quick Reference
- Timezone: ${tz}

## Operational Notes
- [Environment quirks, lessons learned, common tasks]
`;
}

async function bootstrapWorkspace(
	channelDir: string,
	workspacePath: string,
	channelId: string,
	isDocker: boolean,
): Promise<void> {
	const workspaceDir = join(channelDir, "..");

	// Channel-level directories
	for (const sub of ["attachments", "scratch", "skills", "daily"]) {
		await mkdir(join(channelDir, sub), { recursive: true });
	}

	// Workspace-level directories
	for (const sub of ["skills", "events"]) {
		await mkdir(join(workspaceDir, sub), { recursive: true });
	}

	// Create MEMORY.md and SYSTEM.md if they don't exist (empty)
	for (const path of [
		join(workspaceDir, "MEMORY.md"),
		join(workspaceDir, "SYSTEM.md"),
		join(channelDir, "MEMORY.md"),
	]) {
		if (!existsSync(path)) {
			await writeFile(path, "");
		}
	}

	// Create MOTHER.md with template if it doesn't exist
	const motherPath = join(workspaceDir, "MOTHER.md");
	if (!existsSync(motherPath)) {
		await writeFile(motherPath, generateMotherTemplate());
	}

	// Generate/regenerate REFERENCE.md (always overwrite — it's auto-generated)
	const referencePath = join(workspaceDir, "REFERENCE.md");
	await writeFile(referencePath, generateReferenceDoc(workspacePath, channelId, isDocker));
}

/**
 * Generate a file tree of the workspace for inclusion in the system prompt.
 * Gives the model awareness of existing files without needing tool calls.
 */
function generateWorkspaceTree(hostDir: string, displayPath: string, maxDepth = 4, maxEntries = 150): string {
	const lines: string[] = [`${displayPath}/`];
	let count = 0;

	const SKIP = new Set(["node_modules", "attachments", "log.jsonl", "context.jsonl", "last_prompt.jsonl"]);

	function walk(dir: string, prefix: string, depth: number) {
		if (depth > maxDepth || count >= maxEntries) return;

		let entries: string[];
		try {
			entries = readdirSync(dir).sort();
		} catch {
			return;
		}

		entries = entries.filter((e) => !e.startsWith(".") && !SKIP.has(e));

		for (let i = 0; i < entries.length && count < maxEntries; i++) {
			const entry = entries[i];
			const fullPath = join(dir, entry);
			const isLast = i === entries.length - 1;
			const connector = isLast ? "└── " : "├── ";
			const childPrefix = isLast ? "    " : "│   ";

			try {
				const stat = statSync(fullPath);
				if (stat.isDirectory()) {
					lines.push(`${prefix}${connector}${entry}/`);
					count++;
					walk(fullPath, prefix + childPrefix, depth + 1);
				} else {
					const size = stat.size;
					const sizeStr =
						size < 1024
							? `${size}B`
							: size < 1024 * 1024
								? `${(size / 1024).toFixed(1)}K`
								: `${(size / (1024 * 1024)).toFixed(1)}M`;
					lines.push(`${prefix}${connector}${entry} (${sizeStr})`);
					count++;
				}
			} catch {
				// Skip inaccessible files
			}
		}

		if (count >= maxEntries) {
			lines.push(`${prefix}... (truncated, ${maxEntries} entries shown)`);
		}
	}

	walk(hostDir, "", 1);
	return lines.join("\n");
}

/**
 * Trim context by logical turns (user message + assistant/toolResult responses).
 * Keeps the most recent MAX_TURNS turns and generates a one-line summary of the last dropped user message.
 */
function trimContextByTurns(
	messages: AgentMessage[],
	channelId: string,
): { messages: AgentMessage[]; droppedTurns: number; summary: string } {
	const MAX_TURNS = 10;

	// Split messages into turns: each turn starts with a user message
	const turns: AgentMessage[][] = [];
	let currentTurn: AgentMessage[] = [];

	for (const msg of messages) {
		if ("role" in msg && msg.role === "user" && currentTurn.length > 0) {
			turns.push(currentTurn);
			currentTurn = [];
		}
		currentTurn.push(msg);
	}
	if (currentTurn.length > 0) {
		turns.push(currentTurn);
	}

	if (turns.length <= MAX_TURNS) {
		return { messages, droppedTurns: 0, summary: "" };
	}

	const droppedTurns = turns.length - MAX_TURNS;
	const keptTurns = turns.slice(-MAX_TURNS);

	// Extract summary from the last dropped turn's user message
	const lastDroppedTurn = turns[droppedTurns - 1];
	let summary = "";
	const lastDroppedUser = lastDroppedTurn.find((m) => "role" in m && m.role === "user");
	if (lastDroppedUser && "role" in lastDroppedUser && lastDroppedUser.role === "user") {
		const content = lastDroppedUser.content;
		let text = "";
		if (typeof content === "string") {
			text = content;
		} else if (Array.isArray(content)) {
			text = content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join(" ");
		}
		// Strip timestamp prefix: [YYYY-MM-DD HH:MM:SS+HH:MM] [username]:
		text = text.replace(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}\] \[[^\]]+\]: /, "");
		summary = text.length > 100 ? `${text.substring(0, 100)}...` : text;
	}

	log.logInfo(
		`[${channelId}] Trimming context: ${turns.length} turns -> ${MAX_TURNS} turns (dropped ${droppedTurns})`,
	);

	const kept = keptTurns.flat();

	// Prepend a synthetic context summary if we dropped turns
	if (summary) {
		const syntheticMsg: UserMessage = {
			role: "user",
			content: `[Prior context trimmed. Last topic before trim: ${summary}]`,
			timestamp: (kept[0] as any)?.timestamp ?? Date.now(),
		};
		return { messages: [syntheticMsg, ...kept], droppedTurns, summary };
	}

	return { messages: kept, droppedTurns, summary };
}

function buildSystemPrompt(
	workspacePath: string,
	channelId: string,
	memory: string,
	motherNotes: string,
	sandboxConfig: SandboxConfig,
	channels: ChannelInfo[],
	users: UserInfo[],
	skills: Skill[],
	fileTree = "",
	modelInfo?: { id: string; provider: string },
): string {
	const channelPath = `${workspacePath}/${channelId}`;
	const isDocker = sandboxConfig.type === "docker";

	// Format channel mappings
	const channelMappings =
		channels.length > 0 ? channels.map((c) => `${c.id}\t#${c.name}`).join("\n") : "(no channels loaded)";

	// Format user mappings
	const userMappings =
		users.length > 0 ? users.map((u) => `${u.id}\t@${u.userName}\t${u.displayName}`).join("\n") : "(no users loaded)";

	const envDescription = isDocker
		? `You are running inside a Docker container (Alpine Linux).
- Bash working directory: / (use cd or absolute paths)
- Install tools with: apk add <package>
- Your changes persist across sessions`
		: `You are running directly on the host machine.
- Bash working directory: ${process.cwd()}
- Be careful with system modifications`;

	const modelDesc = modelInfo ? `\nModel: ${modelInfo.id} via ${modelInfo.provider}` : "";

	return `You are mother, a Discord bot assistant. Be concise. No emojis.
You are capable and handle tasks directly. Use your tools to read, write, edit files, and run commands.${modelDesc}

## Context
- For current date/time, use: date
- You have access to previous conversation context including tool results from prior turns.
- For older history beyond your context, search log.jsonl (contains user messages and your final responses, but not tool results).
- Save important info to MEMORY.md when you learn something worth preserving across sessions.

## How to Work
Handle tasks yourself using your tools (bash, read, write, edit). You are a competent agent — read files, reason about code, make edits, run commands, and iterate.

Use the **claude** tool for escalation when:
- The task requires extended multi-file coding sessions (large refactors, new features spanning many files)
- You want Opus-level reasoning for architectural decisions or complex debugging
- You've attempted something and are stuck after a few tries

For routine tasks — coding, debugging, file edits, scripting, research, investigation — handle them yourself.

## Discord Formatting (Markdown)
Bold: **text**, Italic: *text*, Code: \`code\`, Block: \`\`\`code\`\`\`, Links: [text](url)
Do NOT use *single asterisks for bold* or <url|text> link format.

## Discord IDs
Channels: ${channelMappings}

Users: ${userMappings}

When mentioning users, use <@userid> format (e.g., <@123456789>).

## Environment
${envDescription}

## Workspace Layout
${workspacePath}/
├── MOTHER.md                    # Workspace guide (users, projects, notes)
├── MEMORY.md                    # Global memory (all channels)
├── REFERENCE.md                 # Events, skills creation, log queries (read on demand)
├── skills/                      # Global CLI tools you create
└── ${channelId}/                # This channel
    ├── MEMORY.md                # Channel-specific memory
    ├── daily/                   # Daily append-only logs (grep-searchable)
    ├── log.jsonl                # Message history (no tool results)
    ├── attachments/             # User-shared files
    ├── scratch/                 # Your working directory
    └── skills/                  # Channel-specific tools
${fileTree ? `\n### Current Files\n\`\`\`\n${fileTree}\n\`\`\`\n` : ""}
## Reference
For events, skills creation, log queries, and system config: read ${workspacePath}/REFERENCE.md
${skills.length > 0 ? `\n### Available Skills\n${formatSkillsForPrompt(skills)}\n` : ""}
## Project Notes (MOTHER.md)
${
	motherNotes
		? `${motherNotes}\n\nWhen working on a specific project, read its PROJECT.md file for detailed context, conventions, and notes.`
		: `No MOTHER.md found. Create ${workspacePath}/MOTHER.md to store project locations and notes.\nWhen working on a specific project, read its PROJECT.md file for detailed context, conventions, and notes.`
}

## Memory
Write to MEMORY.md files to persist important context across conversations.
- Global (${workspacePath}/MEMORY.md): user preferences, project info, operational lessons
- Channel (${channelPath}/MEMORY.md): channel-specific decisions, ongoing work

**Rules:**
- Keep entries short (1-2 lines each). Memory is injected into every prompt — bloat wastes context.
- Only record things you can't re-derive: user preferences, failed approaches, environment quirks.
- Do NOT duplicate tool descriptions, system prompt content, or documentation.
- Periodically clean up outdated or redundant entries.
- When a tool call fails, record a one-line lesson (e.g., "No sudo — ask user for systemd changes").

## Daily Logs
Append important events, decisions, and task summaries to ${channelPath}/daily/YYYY-MM-DD.md (use today's date).
These are NOT injected into your prompt — use grep to search them when you need past context.

### Current Memory
${memory}

## Safety
- NEVER run destructive commands without asking the user first: rm -rf, dd, mkfs, fdisk, format operations
- NEVER modify system services (systemctl, service) without asking first
- NEVER use sudo or run commands as root without asking first
- NEVER access or read SSH keys, API tokens, .env files, or credentials outside your workspace
- NEVER modify /etc, /root, or system configuration files
- If a command could cause data loss or system instability, describe what you plan to do and wait for confirmation
- Stay within your workspace directory for file operations unless the user explicitly directs you elsewhere

## Tools
- bash: Run shell commands (primary tool). Install packages as needed.
- read: Read files
- write: Create/overwrite files
- edit: Surgical file edits
- attach: Share files to Discord
- claude: Escalate to Claude Code (Sonnet/Opus). Use for large multi-file refactors, complex architectural work, or when you're stuck. Returns a session_id — pass it back via the sessionId parameter to continue the same session for follow-ups.

Each tool requires a "label" parameter (shown to user).
`;
}

function truncate(text: string, maxLen: number): string {
	if (text.length <= maxLen) return text;
	return `${text.substring(0, maxLen - 3)}...`;
}

/**
 * Strip "Thinking\n..." prefix from model text output.
 * Some models (e.g. glm-4) output reasoning as regular text
 * with a "Thinking" header instead of using thinking blocks.
 */
function stripThinkingBlock(text: string): string {
	const match = text.match(/^Thinking\n/i);
	if (!match) return text;
	return text.slice(match[0].length);
}

function extractToolResultText(result: unknown): string {
	if (typeof result === "string") {
		return result;
	}

	if (
		result &&
		typeof result === "object" &&
		"content" in result &&
		Array.isArray((result as { content: unknown }).content)
	) {
		const content = (result as { content: Array<{ type: string; text?: string }> }).content;
		const textParts: string[] = [];
		for (const part of content) {
			if (part.type === "text" && part.text) {
				textParts.push(part.text);
			}
		}
		if (textParts.length > 0) {
			return textParts.join("\n");
		}
	}

	return JSON.stringify(result);
}

function formatToolArgsForDiscord(_toolName: string, args: Record<string, unknown>): string {
	const lines: string[] = [];

	for (const [key, value] of Object.entries(args)) {
		if (key === "label") continue;

		if (key === "path" && typeof value === "string") {
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			if (offset !== undefined && limit !== undefined) {
				lines.push(`${value}:${offset}-${offset + limit}`);
			} else {
				lines.push(value);
			}
			continue;
		}

		if (key === "offset" || key === "limit") continue;

		if (typeof value === "string") {
			lines.push(value);
		} else {
			lines.push(JSON.stringify(value));
		}
	}

	return lines.join("\n");
}

// Cache runners per channel
const channelRunners = new Map<string, AgentRunner>();

export function getOrCreateRunner(sandboxConfig: SandboxConfig, channelId: string, channelDir: string): AgentRunner {
	const existing = channelRunners.get(channelId);
	if (existing) return existing;

	const runner = createRunner(sandboxConfig, channelId, channelDir);
	channelRunners.set(channelId, runner);
	return runner;
}

function createRunner(sandboxConfig: SandboxConfig, channelId: string, channelDir: string): AgentRunner {
	// Resolve model at runner creation time (not module load time)
	const model = resolveModel();
	// Apply Mother defaults for Discord routing (read by event handlers)
	if ((model as any).intermediateToThread === undefined) {
		(model as any).intermediateToThread = true;
	}
	if ((model as any).showThinkingInThread === undefined) {
		(model as any).showThinkingInThread = false;
	}
	if (!model) {
		throw new Error(
			"Failed to resolve model. Check MOTHER_MODEL_PROVIDER and MOTHER_MODEL_ID environment variables.",
		);
	}

	const executor = createExecutor(sandboxConfig);
	const hostWorkspaceDir = channelDir.replace(`/${channelId}`, "");
	const workspacePath = executor.getWorkspacePath(hostWorkspaceDir);

	// Create tools
	const tools = createMomTools(executor, hostWorkspaceDir);
	const memory = getMemory(channelDir);
	const motherNotes = getMotherNotes(channelDir);
	const skills = loadMotherSkills(channelDir, workspacePath);
	const fileTree = generateWorkspaceTree(hostWorkspaceDir, workspacePath);
	const systemPrompt = buildSystemPrompt(
		workspacePath,
		channelId,
		memory,
		motherNotes,
		sandboxConfig,
		[],
		[],
		skills,
		fileTree,
		{ id: model.id, provider: model.provider },
	);

	// Create session manager and settings manager
	const contextFile = join(channelDir, "context.jsonl");
	const sessionManager = SessionManager.open(contextFile, channelDir);
	const settingsManager = new MotherSettingsManager(join(channelDir, ".."));

	// Create AuthStorage and ModelRegistry
	const authStorage = new AuthStorage(join(homedir(), ".pi", "agent", "auth.json"));
	// Set dummy API key for ollama (it doesn't need auth, but ModelRegistry requires one)
	if (model.provider === "ollama") {
		authStorage.setRuntimeApiKey("ollama", "ollama");
	}
	const modelRegistry = new ModelRegistry(authStorage);

	// Create agent
	const agent = new Agent({
		initialState: {
			systemPrompt,
			model,
			thinkingLevel: "medium",
			tools,
		},
		convertToLlm,
		getApiKey: async (provider: string) => authStorage.getApiKey(provider),
	});

	// Explicitly set the model (initialState spread doesn't reliably set it)
	agent.setModel(model);

	// Load existing messages
	const loadedSession = sessionManager.buildSessionContext();
	if (loadedSession.messages.length > 0) {
		agent.replaceMessages(loadedSession.messages);
		log.logInfo(`[${channelId}] Loaded ${loadedSession.messages.length} messages from context.jsonl`);
	}

	const resourceLoader: ResourceLoader = {
		getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () => systemPrompt,
		getAppendSystemPrompt: () => [],
		getPathMetadata: () => new Map(),
		extendResources: () => {},
		reload: async () => {},
	};

	const baseToolsOverride = Object.fromEntries(tools.map((tool) => [tool.name, tool]));

	// Create AgentSession wrapper
	const session = new AgentSession({
		agent,
		sessionManager,
		settingsManager: settingsManager as any,
		cwd: process.cwd(),
		modelRegistry,
		resourceLoader,
		baseToolsOverride,
	});

	// Mutable per-run state
	const runState = {
		ctx: null as DiscordContext | null,
		logCtx: null as { channelId: string; userName?: string; channelName?: string } | null,
		queue: null as {
			enqueue(fn: () => Promise<void>, errorContext: string): void;
			enqueueMessage(text: string, target: "main" | "thread", errorContext: string, doLog?: boolean): void;
		} | null,
		pendingTools: new Map<string, { toolName: string; args: unknown; startTime: number }>(),
		totalUsage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		errorMessage: undefined as string | undefined,
	};

	// Subscribe to events ONCE
	session.subscribe(async (event) => {
		if (!runState.ctx || !runState.logCtx || !runState.queue) return;

		const { ctx, logCtx, queue, pendingTools } = runState;

		if (event.type === "tool_execution_start") {
			const agentEvent = event as AgentEvent & { type: "tool_execution_start" };
			const args = agentEvent.args as { label?: string };
			const label = args.label || agentEvent.toolName;

			pendingTools.set(agentEvent.toolCallId, {
				toolName: agentEvent.toolName,
				args: agentEvent.args,
				startTime: Date.now(),
			});

			log.logToolStart(logCtx, agentEvent.toolName, label, agentEvent.args as Record<string, unknown>);
			queue.enqueue(() => ctx.respond(`*-> ${label}*`, false), "tool label");
		} else if (event.type === "tool_execution_end") {
			const agentEvent = event as AgentEvent & { type: "tool_execution_end" };
			const resultStr = extractToolResultText(agentEvent.result);
			const pending = pendingTools.get(agentEvent.toolCallId);
			pendingTools.delete(agentEvent.toolCallId);

			const durationMs = pending ? Date.now() - pending.startTime : 0;

			if (agentEvent.isError) {
				log.logToolError(logCtx, agentEvent.toolName, durationMs, resultStr);
			} else {
				log.logToolSuccess(logCtx, agentEvent.toolName, durationMs, resultStr);
			}

			// Post args + result to thread
			const label = pending?.args ? (pending.args as { label?: string }).label : undefined;
			const argsFormatted = pending
				? formatToolArgsForDiscord(agentEvent.toolName, pending.args as Record<string, unknown>)
				: "(args not found)";
			const duration = (durationMs / 1000).toFixed(1);
			let threadMessage = `**${agentEvent.isError ? "X" : "OK"} ${agentEvent.toolName}**`;
			if (label) threadMessage += `: ${label}`;
			threadMessage += ` (${duration}s)\n`;
			if (argsFormatted) threadMessage += `\`\`\`\n${argsFormatted}\n\`\`\`\n`;
			threadMessage += `**Result:**\n\`\`\`\n${resultStr}\n\`\`\``;

			queue.enqueueMessage(threadMessage, "thread", "tool result thread", false);

			if (agentEvent.isError) {
				queue.enqueue(() => ctx.respond(`*Error: ${truncate(resultStr, 200)}*`, false), "tool error");
			}
		} else if (event.type === "message_start") {
			const agentEvent = event as AgentEvent & { type: "message_start" };
			if (agentEvent.message.role === "assistant") {
				log.logResponseStart(logCtx);
			}
		} else if (event.type === "message_end") {
			const agentEvent = event as AgentEvent & { type: "message_end" };
			if (agentEvent.message.role === "assistant") {
				const assistantMsg = agentEvent.message as any;

				if (assistantMsg.stopReason) {
					runState.stopReason = assistantMsg.stopReason;
				}
				if (assistantMsg.errorMessage) {
					runState.errorMessage = assistantMsg.errorMessage;
				}

				if (assistantMsg.usage) {
					runState.totalUsage.input += assistantMsg.usage.input;
					runState.totalUsage.output += assistantMsg.usage.output;
					runState.totalUsage.cacheRead += assistantMsg.usage.cacheRead;
					runState.totalUsage.cacheWrite += assistantMsg.usage.cacheWrite;
					runState.totalUsage.cost.input += assistantMsg.usage.cost.input;
					runState.totalUsage.cost.output += assistantMsg.usage.cost.output;
					runState.totalUsage.cost.cacheRead += assistantMsg.usage.cost.cacheRead;
					runState.totalUsage.cost.cacheWrite += assistantMsg.usage.cost.cacheWrite;
					runState.totalUsage.cost.total += assistantMsg.usage.cost.total;
				}

				const content = agentEvent.message.content;
				const thinkingParts: string[] = [];
				const textParts: string[] = [];
				for (const part of content) {
					if (part.type === "thinking") {
						thinkingParts.push((part as any).thinking);
					} else if (part.type === "text") {
						textParts.push((part as any).text);
					}
				}

				const rawText = textParts.join("\n");
				const filterThinking = (model as any).thinkingInText === true;
				const intermediateToThread = (model as any).intermediateToThread === true;
				const isIntermediate = assistantMsg.stopReason === "toolUse";

				// Actual thinking blocks — always logged, optionally posted to thread
				const showThinking = (model as any).showThinkingInThread === true;
				for (const thinking of thinkingParts) {
					log.logThinking(logCtx, thinking);
					if (showThinking) {
						queue.enqueueMessage(`*${thinking}*`, "thread", "thinking thread", false);
					}
				}

				// Fallback: if model put everything in reasoning field, use thinking as response
				let displayText = rawText;
				if (!rawText.trim() && thinkingParts.length > 0) {
					displayText = thinkingParts.join("\n");
				}

				if (displayText.trim()) {
					const text = filterThinking ? stripThinkingBlock(displayText) : displayText;
					log.logResponse(logCtx, displayText);

					if (text.trim()) {
						if (intermediateToThread && isIntermediate) {
							// Intermediate: thread only
							queue.enqueueMessage(text, "thread", "response thread", false);
						} else {
							// Final response (or filtering disabled): main + thread
							queue.enqueueMessage(text, "main", "response main");
							queue.enqueueMessage(text, "thread", "response thread", false);
						}
					}
				}
			}
		} else if (event.type === "auto_compaction_start") {
			log.logInfo(`Auto-compaction started (reason: ${(event as any).reason})`);
			queue.enqueue(() => ctx.respond("*Compacting context...*", false), "compaction start");
		} else if (event.type === "auto_compaction_end") {
			const compEvent = event as any;
			if (compEvent.result) {
				log.logInfo(`Auto-compaction complete: ${compEvent.result.tokensBefore} tokens compacted`);
			} else if (compEvent.aborted) {
				log.logInfo("Auto-compaction aborted");
			}
		} else if (event.type === "auto_retry_start") {
			const retryEvent = event as any;
			log.logWarning(`Retrying (${retryEvent.attempt}/${retryEvent.maxAttempts})`, retryEvent.errorMessage);
			queue.enqueue(
				() => ctx.respond(`*Retrying (${retryEvent.attempt}/${retryEvent.maxAttempts})...*`, false),
				"retry",
			);
		}
	});

	// Discord message limit — split at 1900 to leave room for continuation markers
	const DISCORD_MAX_LENGTH = 1900;
	const splitForDiscord = (text: string): string[] => {
		if (text.length <= DISCORD_MAX_LENGTH) return [text];
		const parts: string[] = [];
		let remaining = text;
		let partNum = 1;
		while (remaining.length > 0) {
			const chunk = remaining.substring(0, DISCORD_MAX_LENGTH - 50);
			remaining = remaining.substring(DISCORD_MAX_LENGTH - 50);
			const suffix = remaining.length > 0 ? `\n*(continued ${partNum}...)*` : "";
			parts.push(chunk + suffix);
			partNum++;
		}
		return parts;
	};

	return {
		async run(
			ctx: DiscordContext,
			_store: ChannelStore,
			_pendingMessages?: PendingMessage[],
		): Promise<{ stopReason: string; errorMessage?: string }> {
			// Check ollama health before proceeding
			const healthError = await checkOllamaHealth();
			if (healthError) {
				log.logWarning("Ollama health check failed", healthError);
				try {
					await ctx.respond(`*Cannot connect to AI server: ${healthError}*`);
				} catch {
					// Ignore
				}
				return { stopReason: "error", errorMessage: healthError };
			}

			// Ensure channel directory exists
			await mkdir(channelDir, { recursive: true });
			const isDocker = sandboxConfig.type === "docker";
			await bootstrapWorkspace(channelDir, workspacePath, channelId, isDocker);

			// Sync messages from log.jsonl
			const syncedCount = syncLogToSessionManager(sessionManager, channelDir, ctx.message.ts);
			if (syncedCount > 0) {
				log.logInfo(`[${channelId}] Synced ${syncedCount} messages from log.jsonl`);
			}

			// Reload messages from context.jsonl
			const reloadedSession = sessionManager.buildSessionContext();
			if (reloadedSession.messages.length > 0) {
				const trimmed = trimContextByTurns(reloadedSession.messages, channelId);
				agent.replaceMessages(trimmed.messages);
				log.logInfo(`[${channelId}] Reloaded ${trimmed.messages.length} messages from context`);
				if (trimmed.droppedTurns > 0) {
					log.logInfo(`[${channelId}] Trimmed ${trimmed.droppedTurns} turns, summary: ${trimmed.summary}`);
				}
			}

			// Update system prompt with fresh memory, channel/user info, and skills
			const memory = getMemory(channelDir);
			const motherNotes = getMotherNotes(channelDir);
			const skills = loadMotherSkills(channelDir, workspacePath);
			const fileTree = generateWorkspaceTree(hostWorkspaceDir, workspacePath);
			const systemPrompt = buildSystemPrompt(
				workspacePath,
				channelId,
				memory,
				motherNotes,
				sandboxConfig,
				ctx.channels,
				ctx.users,
				skills,
				fileTree,
				{ id: model.id, provider: model.provider },
			);
			session.agent.setSystemPrompt(systemPrompt);

			// Set up file upload function
			setUploadFunction(async (filePath: string, title?: string) => {
				const hostPath = translateToHostPath(filePath, channelDir, workspacePath, channelId);
				await ctx.uploadFile(hostPath, title);
			});

			// Reset per-run state
			runState.ctx = ctx;
			runState.logCtx = {
				channelId: ctx.message.channel,
				userName: ctx.message.userName,
				channelName: ctx.channelName,
			};
			runState.pendingTools.clear();
			runState.totalUsage = {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			};
			runState.stopReason = "stop";
			runState.errorMessage = undefined;

			// Create queue for this run
			let queueChain = Promise.resolve();
			runState.queue = {
				enqueue(fn: () => Promise<void>, errorContext: string): void {
					queueChain = queueChain.then(async () => {
						try {
							await fn();
						} catch (err) {
							const errMsg = err instanceof Error ? err.message : String(err);
							log.logWarning(`Discord API error (${errorContext})`, errMsg);
							try {
								await ctx.respondInThread(`*Error: ${errMsg}*`);
							} catch {
								// Ignore
							}
						}
					});
				},
				enqueueMessage(text: string, target: "main" | "thread", errorContext: string, doLog = true): void {
					const parts = splitForDiscord(text);
					for (const part of parts) {
						this.enqueue(
							() => (target === "main" ? ctx.respond(part, doLog) : ctx.respondInThread(part)),
							errorContext,
						);
					}
				},
			};

			// Log context info
			log.logInfo(`Context sizes - system: ${systemPrompt.length} chars, memory: ${memory.length} chars`);
			log.logInfo(`Channels: ${ctx.channels.length}, Users: ${ctx.users.length}`);

			// Build user message with timestamp and username prefix
			const now = new Date();
			const pad = (n: number) => n.toString().padStart(2, "0");
			const offset = -now.getTimezoneOffset();
			const offsetSign = offset >= 0 ? "+" : "-";
			const offsetHours = pad(Math.floor(Math.abs(offset) / 60));
			const offsetMins = pad(Math.abs(offset) % 60);
			const timestamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}${offsetSign}${offsetHours}:${offsetMins}`;
			let userMessage = `[${timestamp}] [${ctx.message.userName || "unknown"}]: ${ctx.message.text}`;

			const imageAttachments: ImageContent[] = [];
			const nonImagePaths: string[] = [];

			for (const a of ctx.message.attachments || []) {
				const fullPath = `${workspacePath}/${a.local}`;
				const mimeType = getImageMimeType(a.local);

				if (mimeType && existsSync(fullPath)) {
					try {
						imageAttachments.push({
							type: "image",
							mimeType,
							data: readFileSync(fullPath).toString("base64"),
						});
					} catch {
						nonImagePaths.push(fullPath);
					}
				} else {
					nonImagePaths.push(fullPath);
				}
			}

			if (nonImagePaths.length > 0) {
				userMessage += `\n\n<discord_attachments>\n${nonImagePaths.join("\n")}\n</discord_attachments>`;
			}

			// Debug: write context to last_prompt.jsonl
			const debugContext = {
				systemPrompt,
				messages: session.messages,
				newUserMessage: userMessage,
				imageAttachmentCount: imageAttachments.length,
			};
			await writeFile(join(channelDir, "last_prompt.jsonl"), JSON.stringify(debugContext, null, 2));

			await session.prompt(userMessage, imageAttachments.length > 0 ? { images: imageAttachments } : undefined);

			// Wait for queued messages
			await queueChain;

			// Handle error case
			if (runState.stopReason === "error" && runState.errorMessage) {
				try {
					await ctx.replaceMessage("*Sorry, something went wrong*");
					await ctx.respondInThread(`*Error: ${runState.errorMessage}*`);
				} catch (err) {
					const errMsg = err instanceof Error ? err.message : String(err);
					log.logWarning("Failed to post error message", errMsg);
				}
			} else {
				// Final message update
				const messages = session.messages;
				const lastAssistant = messages.filter((m) => m.role === "assistant").pop();
				const rawFinalText =
					lastAssistant?.content
						.filter((c): c is { type: "text"; text: string } => c.type === "text")
						.map((c) => c.text)
						.join("\n") || "";
				const finalText = (model as any).thinkingInText ? stripThinkingBlock(rawFinalText) : rawFinalText;

				// Check for [SILENT] marker
				if (finalText.trim() === "[SILENT]" || finalText.trim().startsWith("[SILENT]")) {
					try {
						await ctx.deleteMessage();
						log.logInfo("Silent response - deleted message and thread");
					} catch (err) {
						const errMsg = err instanceof Error ? err.message : String(err);
						log.logWarning("Failed to delete message for silent response", errMsg);
					}
				} else if (finalText.trim()) {
					try {
						const mainText =
							finalText.length > DISCORD_MAX_LENGTH
								? `${finalText.substring(0, DISCORD_MAX_LENGTH - 50)}\n\n*(see thread for full response)*`
								: finalText;
						await ctx.replaceMessage(mainText);
					} catch (err) {
						const errMsg = err instanceof Error ? err.message : String(err);
						log.logWarning("Failed to replace message with final text", errMsg);
					}
				}
			}

			// Log usage summary with context info
			const totalCost = runState.totalUsage.cost.total;
			const isLocalModel = totalCost === 0 && MOTHER_MODEL_PROVIDER === "ollama";

			if (totalCost > 0 || isLocalModel) {
				const messages = session.messages;
				const lastAssistantMessage = messages
					.slice()
					.reverse()
					.find((m) => m.role === "assistant" && (m as any).stopReason !== "aborted") as any;

				const contextTokens = lastAssistantMessage
					? lastAssistantMessage.usage.input +
						lastAssistantMessage.usage.output +
						lastAssistantMessage.usage.cacheRead +
						lastAssistantMessage.usage.cacheWrite
					: 0;
				const contextWindow = model.contextWindow || 128000;

				const summary = log.logUsageSummary(
					runState.logCtx!,
					runState.totalUsage,
					contextTokens,
					contextWindow,
					isLocalModel,
				);
				runState.queue.enqueue(() => ctx.respondInThread(summary), "usage summary");
				await queueChain;
			}

			// Clear run state
			runState.ctx = null;
			runState.logCtx = null;
			runState.queue = null;

			return { stopReason: runState.stopReason, errorMessage: runState.errorMessage };
		},

		abort(): void {
			session.abort();
		},
	};
}

function translateToHostPath(
	containerPath: string,
	channelDir: string,
	workspacePath: string,
	channelId: string,
): string {
	if (workspacePath === "/workspace") {
		const prefix = `/workspace/${channelId}/`;
		if (containerPath.startsWith(prefix)) {
			return join(channelDir, containerPath.slice(prefix.length));
		}
		if (containerPath.startsWith("/workspace/")) {
			return join(channelDir, "..", containerPath.slice("/workspace/".length));
		}
	}
	return containerPath;
}
