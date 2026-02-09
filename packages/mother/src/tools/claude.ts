import { execFile } from "node:child_process";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { truncateTail } from "./truncate.js";

const claudeSchema = Type.Object({
	label: Type.Optional(Type.String({ description: "Brief description of what you're delegating (shown to user)" })),
	prompt: Type.String({ description: "The task description for Claude Code" }),
	sessionId: Type.Optional(
		Type.String({
			description:
				"Session ID from a previous claude call. Pass this to continue an existing session — Claude Code will have full context of prior work.",
		}),
	),
	maxTurns: Type.Optional(Type.Number({ description: "Maximum agentic turns (default: 20)" })),
	timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (default: 600)" })),
});

export function createClaudeTool(hostWorkspaceDir: string): AgentTool<typeof claudeSchema> {
	return {
		name: "claude",
		label: "claude",
		description:
			"Delegate a task to Claude Code, a powerful coding agent. Use this for ALL coding, debugging, multi-file operations, research, and any task requiring multi-step reasoning. Provide a clear, detailed prompt describing what to do. This is your primary tool for getting real work done. Returns a session_id you can pass back to continue the same session for follow-up work.",
		parameters: claudeSchema,
		execute: async (
			_toolCallId: string,
			{
				prompt,
				sessionId,
				maxTurns,
				timeout,
			}: { label?: string; prompt: string; sessionId?: string; maxTurns?: number; timeout?: number },
			signal?: AbortSignal,
		) => {
			const turns = maxTurns ?? 20;
			const timeoutSec = timeout ?? 600;

			const args = [
				"-p",
				prompt,
				"--output-format",
				"json",
				"--dangerously-skip-permissions",
				"--max-turns",
				String(turns),
				"--model",
				"claude-sonnet-4-5-20250929",
			];

			if (sessionId) {
				args.push("--resume", sessionId);
			}

			const result = await new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve) => {
				let stdout = "";
				let stderr = "";
				let killed = false;

				const proc = execFile(
					"claude",
					args,
					{ maxBuffer: 10 * 1024 * 1024, timeout: timeoutSec * 1000, cwd: hostWorkspaceDir },
					(error, out, err) => {
						stdout = out || "";
						stderr = err || "";
						if (killed) {
							resolve({ stdout, stderr, code: null });
						} else if (error) {
							const errCode = (error as any).code;
							resolve({
								stdout,
								stderr,
								code: errCode === "ETIMEDOUT" ? null : typeof errCode === "number" ? errCode : 1,
							});
						} else {
							resolve({ stdout, stderr, code: 0 });
						}
					},
				);

				if (signal) {
					if (signal.aborted) {
						proc.kill();
						killed = true;
					} else {
						signal.addEventListener(
							"abort",
							() => {
								proc.kill();
								killed = true;
							},
							{ once: true },
						);
					}
				}
			});

			// Handle timeout
			if (result.code === null) {
				throw new Error(`Claude Code timed out after ${timeoutSec}s. Try a simpler prompt or increase timeout.`);
			}

			// Try to parse JSON output
			const raw = result.stdout.trim();
			if (!raw) {
				if (result.stderr.includes("command not found") || result.stderr.includes("ENOENT")) {
					throw new Error("claude CLI not found. Install it: npm install -g @anthropic-ai/claude-code");
				}
				throw new Error(result.stderr || `Claude Code exited with code ${result.code} and no output`);
			}

			let resultText: string;
			let returnedSessionId: string | undefined;
			try {
				const json = JSON.parse(raw);
				resultText = json.result ?? JSON.stringify(json, null, 2);
				returnedSessionId = json.session_id;
			} catch {
				// Not JSON — return raw output (might be an error message)
				resultText = raw;
			}

			// Check for rate limit errors in the output
			if (result.code !== 0 && resultText.toLowerCase().includes("rate limit")) {
				throw new Error(`Claude Code rate limited: ${resultText}`);
			}

			if (result.code !== 0) {
				throw new Error(`Claude Code failed (exit ${result.code}): ${resultText}`);
			}

			// Truncate large outputs
			const truncation = truncateTail(resultText);
			let text = truncation.content || "(no output)";

			// Append session ID so the model can use it for follow-ups
			if (returnedSessionId) {
				text += `\n\n[session_id: ${returnedSessionId}]`;
			}

			return { content: [{ type: "text", text }], details: undefined };
		},
	};
}
