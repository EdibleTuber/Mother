#!/usr/bin/env node

import type { Message } from "discord.js";
import { join, resolve } from "path";
import { createInterface } from "readline";
import { type AgentRunner, getOrCreateRunner } from "./agent.js";
import { MotherSettingsManager } from "./context.js";
import { type DiscordBot, DiscordBot as DiscordBotClass, type DiscordEvent, type MotherHandler } from "./discord.js";
import { createEventsWatcher } from "./events.js";
import * as log from "./log.js";
import { parseSandboxArg, type SandboxConfig, validateSandbox } from "./sandbox.js";
import { ChannelStore } from "./store.js";

// ============================================================================
// Config
// ============================================================================

const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const DISCORD_GUILD_ID = process.env.DISCORD_GUILD_ID;
const MOTHER_ALLOWED_USERS = process.env.MOTHER_ALLOWED_USERS;

interface ParsedArgs {
	workingDir?: string;
	sandbox: SandboxConfig;
	cliMode: boolean;
}

function parseArgs(): ParsedArgs {
	const args = process.argv.slice(2);
	let sandbox: SandboxConfig = { type: "host" };
	let workingDir: string | undefined;
	let cliMode = false;

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg.startsWith("--sandbox=")) {
			sandbox = parseSandboxArg(arg.slice("--sandbox=".length));
		} else if (arg === "--sandbox") {
			sandbox = parseSandboxArg(args[++i] || "");
		} else if (arg === "--cli") {
			cliMode = true;
		} else if (!arg.startsWith("-")) {
			workingDir = arg;
		}
	}

	return {
		workingDir: workingDir ? resolve(workingDir) : undefined,
		sandbox,
		cliMode,
	};
}

const parsedArgs = parseArgs();

// Normal bot mode - require working dir
if (!parsedArgs.workingDir) {
	console.error("Usage: mother [--sandbox=host|docker:<name>] [--cli] <working-directory>");
	console.error("");
	console.error("Options:");
	console.error("  --sandbox=host|docker:<name>  Execution environment (default: host)");
	console.error("  --cli                         Run in CLI mode (no Discord connection)");
	process.exit(1);
}

const { workingDir, sandbox, cliMode } = parsedArgs;

const settings = new MotherSettingsManager(workingDir);

// In CLI mode, skip Discord token validation
if (!cliMode) {
	if (!DISCORD_BOT_TOKEN) {
		console.error("Missing env: DISCORD_BOT_TOKEN");
		console.error("Use --cli flag to run without Discord connection");
		process.exit(1);
	}

	if (!DISCORD_GUILD_ID) {
		console.error("Missing env: DISCORD_GUILD_ID");
		console.error("Use --cli flag to run without Discord connection");
		process.exit(1);
	}
}

await validateSandbox(sandbox);

// ============================================================================
// CLI Mode
// ============================================================================

if (cliMode) {
	log.logStartup(workingDir, sandbox.type === "host" ? "host" : `docker:${sandbox.container}`);
	console.log("Running in CLI mode (no Discord connection)");
	console.log("Type your messages and press Enter. Type 'exit' or Ctrl+C to quit.\n");

	const channelId = "cli";
	const channelDir = join(workingDir, channelId);
	const store = new ChannelStore({ workingDir });
	const runner = getOrCreateRunner(sandbox, channelId, channelDir, settings);

	// Create CLI context adapter
	function createCliContext(text: string) {
		let responseText = "";
		const threadMessages: string[] = [];

		return {
			message: {
				text,
				rawText: text,
				user: "cli-user",
				userName: "user",
				channel: channelId,
				ts: Date.now().toString(),
				attachments: [],
			},
			channelName: "cli",
			store,
			channels: [{ id: channelId, name: "cli" }],
			users: [{ id: "cli-user", userName: "user", displayName: "CLI User" }],

			respond: async (text: string, _shouldLog = true) => {
				responseText = responseText ? `${responseText}\n${text}` : text;
				console.log(text);
			},

			replaceMessage: async (text: string) => {
				responseText = text;
				// In CLI, we already printed incremental updates, so just show final
			},

			respondInThread: async (text: string) => {
				threadMessages.push(text);
				console.log(`  [thread] ${text.split("\n")[0].substring(0, 80)}...`);
			},

			setTyping: async (_isTyping: boolean) => {
				// No-op in CLI
			},

			uploadFile: async (filePath: string, title?: string) => {
				console.log(`[file] ${title || filePath}`);
			},

			setWorking: async (_working: boolean) => {
				// No-op in CLI
			},

			deleteMessage: async () => {
				// No-op in CLI
			},
		};
	}

	const rl = createInterface({
		input: process.stdin,
		output: process.stdout,
		prompt: "mother> ",
	});

	rl.prompt();

	rl.on("line", async (line) => {
		const text = line.trim();
		if (!text) {
			rl.prompt();
			return;
		}

		if (text.toLowerCase() === "exit" || text.toLowerCase() === "quit") {
			console.log("Goodbye!");
			process.exit(0);
		}

		try {
			const ctx = createCliContext(text);
			await runner.run(ctx as any, store);
		} catch (err) {
			console.error("Error:", err instanceof Error ? err.message : String(err));
		}

		console.log("");
		rl.prompt();
	});

	rl.on("close", () => {
		console.log("\nGoodbye!");
		process.exit(0);
	});

	// Keep the process running
	await new Promise(() => {});
}

// ============================================================================
// State (per channel)
// ============================================================================

interface ChannelState {
	running: boolean;
	runner: AgentRunner;
	store: ChannelStore;
	stopRequested: boolean;
	stopMessage?: Message;
}

const channelStates = new Map<string, ChannelState>();

function getState(channelId: string): ChannelState {
	let state = channelStates.get(channelId);
	if (!state) {
		const channelDir = join(workingDir, channelId);
		state = {
			running: false,
			runner: getOrCreateRunner(sandbox, channelId, channelDir, settings),
			store: new ChannelStore({ workingDir }),
			stopRequested: false,
		};
		channelStates.set(channelId, state);
	}
	return state;
}

// ============================================================================
// Create DiscordContext adapter
// ============================================================================

function createDiscordContext(event: DiscordEvent, bot: DiscordBot, state: ChannelState, isEvent?: boolean) {
	let message: Message | null = null;
	let accumulatedText = "";
	const statusLines: string[] = [];
	let isWorking = true;
	const workingIndicator = " ...";
	let updatePromise = Promise.resolve();

	const DISCORD_CHAR_LIMIT = 2000;

	const buildDisplay = () => {
		// Reserve space for the main text, working indicator, and a newline separator
		const overhead = workingIndicator.length + 1;
		const budget = DISCORD_CHAR_LIMIT - accumulatedText.length - overhead;

		let statusBlock = "";
		if (statusLines.length > 0 && budget > 0) {
			// Walk backwards from the newest status line, fitting as many as possible
			const kept: string[] = [];
			let used = 0;
			for (let i = statusLines.length - 1; i >= 0; i--) {
				const cost = statusLines[i].length + (kept.length > 0 ? 1 : 0); // +1 for newline
				if (used + cost > budget) break;
				kept.push(statusLines[i]);
				used += cost;
			}
			const dropped = statusLines.length - kept.length;
			kept.reverse();
			if (dropped > 0) {
				kept.unshift(`*(${dropped} earlier)*`);
			}
			statusBlock = kept.join("\n");
		}

		const combined =
			statusBlock && accumulatedText ? `${statusBlock}\n${accumulatedText}` : statusBlock || accumulatedText;
		return isWorking ? combined + workingIndicator : combined;
	};

	const user = bot.getUser(event.user);

	// Extract event filename for status message
	const eventFilename = isEvent ? event.text.match(/^\[EVENT:([^:]+):/)?.[1] : undefined;

	// When triggered from a thread, responses go to the thread
	const responseChannelId = event.threadId || event.channel;

	return {
		message: {
			text: event.text,
			rawText: event.text,
			user: event.user,
			userName: user?.userName,
			channel: event.channel,
			ts: event.ts,
			attachments: (event.attachments || []).map((a) => ({ local: a.local })),
		},
		channelName: bot.getChannel(event.channel)?.name,
		store: state.store,
		channels: bot.getAllChannels().map((c) => ({ id: c.id, name: c.name })),
		users: bot.getAllUsers().map((u) => ({ id: u.id, userName: u.userName, displayName: u.displayName })),

		respond: async (text: string, shouldLog = true) => {
			updatePromise = updatePromise.then(async () => {
				accumulatedText = accumulatedText ? `${accumulatedText}\n${text}` : text;
				const displayText = buildDisplay();

				if (message) {
					await bot.updateMessage(message, displayText);
				} else {
					message = await bot.postMessage(responseChannelId, displayText);
				}

				if (shouldLog && message) {
					bot.logBotResponse(event.channel, text, message.id);
				}
			});
			await updatePromise;
		},

		appendStatus: async (text: string) => {
			updatePromise = updatePromise.then(async () => {
				statusLines.push(text);
				const displayText = buildDisplay();
				if (message) {
					await bot.updateMessage(message, displayText);
				} else {
					message = await bot.postMessage(responseChannelId, displayText);
				}
			});
			await updatePromise;
		},

		replaceMessage: async (text: string) => {
			updatePromise = updatePromise.then(async () => {
				accumulatedText = text;
				const displayText = buildDisplay();
				if (message) {
					await bot.updateMessage(message, displayText);
				} else {
					message = await bot.postMessage(responseChannelId, displayText);
				}
			});
			await updatePromise;
		},

		respondInThread: async (_text: string) => {
			// No-op: thread posting removed. Tool details go to console logs only.
		},

		setTyping: async (isTyping: boolean) => {
			if (isTyping && !message) {
				updatePromise = updatePromise.then(async () => {
					if (!message) {
						accumulatedText = eventFilename ? `*Starting event: ${eventFilename}*` : "*Thinking*";
						message = await bot.postMessage(responseChannelId, buildDisplay());
					}
				});
				await updatePromise;
			}
		},

		uploadFile: async (filePath: string, title?: string) => {
			await bot.uploadFile(responseChannelId, filePath, title);
		},

		setWorking: async (working: boolean) => {
			updatePromise = updatePromise.then(async () => {
				isWorking = working;
				if (message) {
					await bot.updateMessage(message, buildDisplay());
				}
			});
			await updatePromise;
		},

		deleteMessage: async () => {
			updatePromise = updatePromise.then(async () => {
				if (message) {
					await bot.deleteDiscordMessage(message);
					message = null;
				}
			});
			await updatePromise;
		},
	};
}

// ============================================================================
// Handler
// ============================================================================

const handler: MotherHandler = {
	isRunning(channelId: string): boolean {
		const state = channelStates.get(channelId);
		return state?.running ?? false;
	},

	async handleStop(channelId: string, bot: DiscordBot): Promise<void> {
		const state = channelStates.get(channelId);
		if (state?.running) {
			state.stopRequested = true;
			state.runner.abort();
			const msg = await bot.postMessage(channelId, "*Stopping...*");
			state.stopMessage = msg;
		} else {
			await bot.postMessage(channelId, "*Nothing running*");
		}
	},

	async handleEvent(event: DiscordEvent, bot: DiscordBot, isEvent?: boolean): Promise<void> {
		const state = getState(event.channel);

		// Start run
		state.running = true;
		state.stopRequested = false;

		log.logInfo(`[${event.channel}] Starting run: ${event.text.substring(0, 50)}`);

		try {
			// Create context adapter
			const ctx = createDiscordContext(event, bot, state, isEvent);

			// Run the agent
			await ctx.setTyping(true);
			await ctx.setWorking(true);
			const result = await state.runner.run(ctx as any, state.store);
			await ctx.setWorking(false);

			if (result.stopReason === "aborted" && state.stopRequested) {
				if (state.stopMessage) {
					await bot.updateMessage(state.stopMessage, "*Stopped*");
					state.stopMessage = undefined;
				} else {
					await bot.postMessage(event.channel, "*Stopped*");
				}
			}
		} catch (err) {
			log.logWarning(`[${event.channel}] Run error`, err instanceof Error ? err.message : String(err));
		} finally {
			state.running = false;
		}
	},
};

// ============================================================================
// Start
// ============================================================================

log.logStartup(workingDir, sandbox.type === "host" ? "host" : `docker:${sandbox.container}`);

// Shared store for attachment downloads
const sharedStore = new ChannelStore({ workingDir });

const allowedUsers = MOTHER_ALLOWED_USERS
	? MOTHER_ALLOWED_USERS.split(",")
			.map((s) => s.trim())
			.filter(Boolean)
	: undefined;

const bot = new DiscordBotClass(handler, {
	botToken: DISCORD_BOT_TOKEN!,
	guildId: DISCORD_GUILD_ID!,
	workingDir,
	store: sharedStore,
	allowedUsers,
	settings,
});

// Start events watcher
const eventsWatcher = createEventsWatcher(workingDir, bot, settings);
eventsWatcher.start();

// Handle shutdown
const shutdown = () => {
	log.logInfo("Shutting down...");
	eventsWatcher.stop();
	bot.destroy();
	process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await bot.start(DISCORD_BOT_TOKEN!);
