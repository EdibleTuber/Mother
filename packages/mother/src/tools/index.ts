import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { Executor } from "../sandbox.js";
import { attachTool, createAttachTool } from "./attach.js";
import { createBashTool } from "./bash.js";
import { createClaudeTool } from "./claude.js";
import { createEditTool } from "./edit.js";
import { initCommandGuard, initPathGuard, parseAllowedCommandsEnv } from "./guard.js";
import { createReadTool } from "./read.js";
import { createWriteTool } from "./write.js";

export { setUploadFunction } from "./attach.js";

export function createMomTools(
	executor: Executor,
	hostWorkspaceDir?: string,
	guardWorkspaceDir?: string,
): AgentTool<any>[] {
	// Initialize guards when workspace dir is provided (host mode)
	if (guardWorkspaceDir) {
		const extraPaths = process.env.MOTHER_ALLOWED_PATHS?.split(":").filter(Boolean);
		initPathGuard(guardWorkspaceDir, extraPaths);

		const envCommands = process.env.MOTHER_ALLOWED_COMMANDS;
		if (envCommands) {
			const { add, remove } = parseAllowedCommandsEnv(envCommands);
			initCommandGuard(add, remove);
		} else {
			initCommandGuard();
		}
	}

	const tools: AgentTool<any>[] = [
		createReadTool(executor, guardWorkspaceDir),
		createBashTool(executor),
		createEditTool(executor, guardWorkspaceDir),
		createWriteTool(executor, guardWorkspaceDir),
		guardWorkspaceDir ? createAttachTool(guardWorkspaceDir) : attachTool,
	];
	if (hostWorkspaceDir) {
		tools.push(createClaudeTool(hostWorkspaceDir));
	}
	return tools;
}
