/**
 * Discord client and message routing for Mother.
 *
 * Manages the discord.js client, per-channel message queues (one task at a time
 * per channel), attachment downloads, and rate-limited message editing. Queues
 * prevent concurrent agent runs on the same channel which would corrupt state.
 */
import {
	AttachmentBuilder,
	ChannelType,
	Client,
	GatewayIntentBits,
	type Guild,
	type Message,
	Partials,
	type TextChannel,
	type ThreadChannel,
} from "discord.js";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "fs";
import { basename, join } from "path";
import type { MotherSettingsManager } from "./context.js";
import * as log from "./log.js";
import type { Attachment, ChannelStore } from "./store.js";

// ============================================================================
// Types
// ============================================================================

export interface DiscordEvent {
	type: "mention" | "dm";
	channel: string;
	ts: string;
	user: string;
	text: string;
	files?: Array<{ name?: string; url?: string }>;
	/** Processed attachments with local paths (populated after logUserMessage) */
	attachments?: Attachment[];
	/** If this message came from a thread, the thread's channel ID (for routing responses back) */
	threadId?: string;
}

export interface DiscordUser {
	id: string;
	userName: string;
	displayName: string;
}

export interface DiscordChannel {
	id: string;
	name: string;
}

// Types used by agent.ts
export interface ChannelInfo {
	id: string;
	name: string;
}

export interface UserInfo {
	id: string;
	userName: string;
	displayName: string;
}

export interface DiscordContext {
	message: {
		text: string;
		rawText: string;
		user: string;
		userName?: string;
		channel: string;
		ts: string;
		attachments: Array<{ local: string }>;
	};
	channelName?: string;
	channels: ChannelInfo[];
	users: UserInfo[];
	respond: (text: string, shouldLog?: boolean) => Promise<void>;
	replaceMessage: (text: string) => Promise<void>;
	respondInThread: (text: string) => Promise<void>;
	setTyping: (isTyping: boolean) => Promise<void>;
	uploadFile: (filePath: string, title?: string) => Promise<void>;
	setWorking: (working: boolean) => Promise<void>;
	deleteMessage: () => Promise<void>;
}

export interface MotherHandler {
	isRunning(channelId: string): boolean;
	handleEvent(event: DiscordEvent, bot: DiscordBot, isEvent?: boolean): Promise<void>;
	handleStop(channelId: string, bot: DiscordBot): Promise<void>;
}

// ============================================================================
// Per-channel queue for sequential processing
// ============================================================================

type QueuedWork = () => Promise<void>;

class ChannelQueue {
	private queue: QueuedWork[] = [];
	private processing = false;

	enqueue(work: QueuedWork): void {
		this.queue.push(work);
		this.processNext();
	}

	size(): number {
		return this.queue.length;
	}

	private async processNext(): Promise<void> {
		if (this.processing || this.queue.length === 0) return;
		this.processing = true;
		const work = this.queue.shift()!;
		try {
			await work();
		} catch (err) {
			log.logWarning("Queue error", err instanceof Error ? err.message : String(err));
		}
		this.processing = false;
		this.processNext();
	}
}

// ============================================================================
// Rate limiter for Discord API calls
// ============================================================================

class RateLimiter {
	private lastEditTime = 0;
	constructor(private readonly minEditInterval: number = 1000) {}

	async waitForEdit(): Promise<void> {
		const now = Date.now();
		const elapsed = now - this.lastEditTime;
		if (elapsed < this.minEditInterval) {
			await new Promise((resolve) => setTimeout(resolve, this.minEditInterval - elapsed));
		}
		this.lastEditTime = Date.now();
	}
}

// ============================================================================
// DiscordBot
// ============================================================================

export class DiscordBot {
	private client: Client;
	private handler: MotherHandler;
	private workingDir: string;
	private store: ChannelStore;
	private botUserId: string | null = null;
	private guildId: string;
	private guild: Guild | null = null;
	private startupTs: number | null = null;

	private users = new Map<string, DiscordUser>();
	private channelMap = new Map<string, DiscordChannel>();
	private queues = new Map<string, ChannelQueue>();
	private rateLimiter: RateLimiter;
	private allowedUsers: Set<string> | null = null;
	private settings: MotherSettingsManager | null;

	constructor(
		handler: MotherHandler,
		config: {
			botToken: string;
			guildId: string;
			workingDir: string;
			store: ChannelStore;
			allowedUsers?: string[];
			settings?: MotherSettingsManager;
		},
	) {
		this.handler = handler;
		this.workingDir = config.workingDir;
		this.store = config.store;
		this.guildId = config.guildId;
		this.allowedUsers = config.allowedUsers ? new Set(config.allowedUsers) : null;
		this.settings = config.settings || null;
		this.rateLimiter = new RateLimiter(config.settings?.getDiscordSettings().editRateLimit);

		this.client = new Client({
			intents: [
				GatewayIntentBits.Guilds,
				GatewayIntentBits.GuildMessages,
				GatewayIntentBits.GuildMembers,
				GatewayIntentBits.MessageContent,
				GatewayIntentBits.DirectMessages,
			],
			partials: [Partials.Channel, Partials.Message],
			// Memory optimization: Discord.js caches all messages and users by default.
			// On a Pi 5 with limited RAM, sweep old messages (>10min) and inactive users
			// periodically to prevent unbounded memory growth during long-running sessions.
			sweepers: {
				messages: { interval: 300, lifetime: 600 },
				users: { interval: 300, filter: () => (user) => user.id !== this.botUserId },
			},
		});
	}

	// ==========================================================================
	// Public API
	// ==========================================================================

	async start(botToken: string): Promise<void> {
		await this.client.login(botToken);

		await new Promise<void>((resolve) => {
			this.client.once("ready", async () => {
				this.botUserId = this.client.user!.id;

				this.guild = this.client.guilds.cache.get(this.guildId) || null;
				if (!this.guild) {
					log.logWarning("Guild not found", this.guildId);
				}

				await Promise.all([this.fetchUsers(), this.fetchChannels()]);
				log.logInfo(`Loaded ${this.channelMap.size} channels, ${this.users.size} users`);

				this.setupEventHandlers();

				// Record startup time
				this.startupTs = Date.now();

				log.logConnected();
				resolve();
			});
		});
	}

	getUser(userId: string): DiscordUser | undefined {
		return this.users.get(userId);
	}

	getChannel(channelId: string): DiscordChannel | undefined {
		return this.channelMap.get(channelId);
	}

	getAllUsers(): DiscordUser[] {
		return Array.from(this.users.values());
	}

	getAllChannels(): DiscordChannel[] {
		return Array.from(this.channelMap.values());
	}

	async postMessage(channelId: string, text: string): Promise<Message> {
		const channel = await this.client.channels.fetch(channelId);
		if (!channel || !("send" in channel)) {
			throw new Error(`Cannot send to channel ${channelId}`);
		}
		return await (channel as TextChannel).send(text);
	}

	async updateMessage(message: Message, text: string): Promise<void> {
		await this.rateLimiter.waitForEdit();
		await message.edit(text);
	}

	async deleteDiscordMessage(message: Message): Promise<void> {
		await message.delete();
	}

	async postInThread(parentMessage: Message, text: string): Promise<Message> {
		let thread = parentMessage.thread;
		if (!thread) {
			const threadName = this.settings?.getDiscordSettings().threadName ?? "Details";
			thread = await parentMessage.startThread({ name: threadName });
		}
		return await thread.send(text);
	}

	async uploadFile(channelId: string, filePath: string, title?: string): Promise<void> {
		const channel = await this.client.channels.fetch(channelId);
		if (!channel || !("send" in channel)) {
			throw new Error(`Cannot send to channel ${channelId}`);
		}
		const fileName = title || basename(filePath);
		const fileContent = readFileSync(filePath);
		const attachment = new AttachmentBuilder(fileContent, { name: fileName });
		await (channel as TextChannel).send({ files: [attachment] });
	}

	/**
	 * Log a message to log.jsonl (SYNC)
	 */
	logToFile(channel: string, entry: object): void {
		const dir = join(this.workingDir, channel);
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		appendFileSync(join(dir, "log.jsonl"), `${JSON.stringify(entry)}\n`);
	}

	/**
	 * Log a bot response to log.jsonl
	 */
	logBotResponse(channel: string, text: string, ts: string): void {
		this.logToFile(channel, {
			date: new Date().toISOString(),
			ts,
			user: "bot",
			text,
			attachments: [],
			isBot: true,
		});
	}

	// ==========================================================================
	// Events Integration
	// ==========================================================================

	enqueueEvent(event: DiscordEvent): boolean {
		const queue = this.getQueue(event.channel);
		const maxQueued = this.settings?.getDiscordSettings().maxQueuedEvents ?? 5;
		if (queue.size() >= maxQueued) {
			log.logWarning(`Event queue full for ${event.channel}, discarding: ${event.text.substring(0, 50)}`);
			return false;
		}
		log.logInfo(`Enqueueing event for ${event.channel}: ${event.text.substring(0, 50)}`);
		queue.enqueue(() => this.handler.handleEvent(event, this, true));
		return true;
	}

	// ==========================================================================
	// Private - Event Handlers
	// ==========================================================================

	private getQueue(channelId: string): ChannelQueue {
		let queue = this.queues.get(channelId);
		if (!queue) {
			queue = new ChannelQueue();
			this.queues.set(channelId, queue);
		}
		return queue;
	}

	private setupEventHandlers(): void {
		this.client.on("messageCreate", async (message) => {
			// Skip bot messages
			if (message.author.bot) return;
			if (message.author.id === this.botUserId) return;

			// Skip users not on the allowlist
			if (this.allowedUsers && !this.allowedUsers.has(message.author.id)) {
				return;
			}

			// --- Thread detection ---
			const isThread =
				message.channel.type === ChannelType.PublicThread || message.channel.type === ChannelType.PrivateThread;

			if (isThread) {
				const thread = message.channel as ThreadChannel;
				const isMotherThread = thread.ownerId === this.botUserId;

				if (isMotherThread) {
					// No @mention required in Mother's own threads
					// Route to parent channel's runner
					const parentId = thread.parentId;
					if (!parentId) return;

					// Fetch the starter message to give Mother context about what this thread is about
					let starterText = "";
					try {
						const starter = await thread.fetchStarterMessage();
						if (starter) {
							const text = starter.content || "";
							starterText = text.length > 200 ? `${text.substring(0, 200)}...` : text;
						}
					} catch {
						// Starter message may have been deleted
					}

					// Build event routed to parent channel
					const discordEvent = this.buildEvent(message, "mention");
					discordEvent.channel = parentId;
					discordEvent.threadId = thread.id;

					// Prefix message with thread context
					if (starterText) {
						discordEvent.text = `[Thread reply on: "${starterText}"]\n${discordEvent.text}`;
					}

					// Log and process
					discordEvent.attachments = this.logUserMessage(discordEvent);

					// Skip messages from before startup
					if (this.startupTs && message.createdTimestamp < this.startupTs) {
						log.logInfo(
							`[${parentId}] Logged old thread message (pre-startup), not triggering: ${discordEvent.text.substring(0, 30)}`,
						);
						return;
					}

					// Check for stop command
					if (discordEvent.text.toLowerCase().trim() === "stop") {
						if (this.handler.isRunning(parentId)) {
							this.handler.handleStop(parentId, this);
						} else {
							this.postMessage(thread.id, "_Nothing running_");
						}
						return;
					}

					// Check if busy
					if (this.handler.isRunning(parentId)) {
						this.postMessage(thread.id, "_Already working. Say stop to cancel._");
					} else {
						this.getQueue(parentId).enqueue(() => this.handler.handleEvent(discordEvent, this));
					}
					return;
				}
				// Non-Mother thread: fall through to normal @mention handling
			}

			// --- Normal channel/DM handling (unchanged) ---
			const isDM = message.channel.type === ChannelType.DM;
			const isMention = message.mentions.has(this.botUserId!);

			// Only respond to DMs or @mentions
			if (!isDM && !isMention) {
				// Still log channel messages
				const discordEvent = this.buildEvent(message, "mention");
				this.logUserMessage(discordEvent);
				return;
			}

			const eventType = isDM ? "dm" : "mention";
			const discordEvent = this.buildEvent(message, eventType);

			// Log the message
			discordEvent.attachments = this.logUserMessage(discordEvent);

			// Skip messages from before startup
			if (this.startupTs && message.createdTimestamp < this.startupTs) {
				log.logInfo(
					`[${message.channel.id}] Logged old message (pre-startup), not triggering: ${discordEvent.text.substring(0, 30)}`,
				);
				return;
			}

			// Check for stop command
			if (discordEvent.text.toLowerCase().trim() === "stop") {
				if (this.handler.isRunning(message.channel.id)) {
					this.handler.handleStop(message.channel.id, this);
				} else {
					this.postMessage(message.channel.id, "_Nothing running_");
				}
				return;
			}

			// Check if busy
			if (this.handler.isRunning(message.channel.id)) {
				const stopHint = isDM ? "`stop`" : "`@mother stop`";
				this.postMessage(message.channel.id, `_Already working. Say ${stopHint} to cancel._`);
			} else {
				this.getQueue(message.channel.id).enqueue(() => this.handler.handleEvent(discordEvent, this));
			}
		});
	}

	private buildEvent(message: Message, type: "mention" | "dm"): DiscordEvent {
		// Strip bot mentions from text
		let text = message.content;
		if (this.botUserId) {
			text = text.replace(new RegExp(`<@!?${this.botUserId}>`, "g"), "").trim();
		}

		// Collect files from attachments
		const files: Array<{ name?: string; url?: string }> = [];
		for (const attachment of message.attachments.values()) {
			files.push({ name: attachment.name, url: attachment.url });
		}

		return {
			type,
			channel: message.channel.id,
			ts: message.id, // Discord snowflake ID
			user: message.author.id,
			text,
			files: files.length > 0 ? files : undefined,
		};
	}

	/**
	 * Log a user message to log.jsonl (SYNC)
	 */
	private logUserMessage(event: DiscordEvent): Attachment[] {
		const user = this.users.get(event.user);
		const attachments = event.files ? this.store.processAttachments(event.channel, event.files, event.ts) : [];
		this.logToFile(event.channel, {
			date: new Date(Number(BigInt(event.ts) >> 22n) + 1420070400000).toISOString(),
			ts: event.ts,
			user: event.user,
			userName: user?.userName,
			displayName: user?.displayName,
			text: event.text,
			attachments,
			isBot: false,
		});
		return attachments;
	}

	// ==========================================================================
	// Private - Fetch Users/Channels
	// ==========================================================================

	destroy(): void {
		this.client.destroy();
	}

	private async fetchUsers(): Promise<void> {
		if (!this.guild) return;
		try {
			const members = await this.guild.members.fetch({ limit: 200 });
			for (const [id, member] of members) {
				if (!member.user.bot) {
					this.users.set(id, {
						id,
						userName: member.user.username,
						displayName: member.displayName || member.user.username,
					});
				}
			}
		} catch (err) {
			log.logWarning("Failed to fetch guild members", String(err));
		}
	}

	private async fetchChannels(): Promise<void> {
		if (!this.guild) return;
		try {
			const channels = await this.guild.channels.fetch();
			for (const [id, channel] of channels) {
				if (channel && (channel.type === ChannelType.GuildText || channel.type === ChannelType.GuildForum)) {
					this.channelMap.set(id, { id, name: channel.name });
				}
			}
		} catch (err) {
			log.logWarning("Failed to fetch guild channels", String(err));
		}
	}
}
