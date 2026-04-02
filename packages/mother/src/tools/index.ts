import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { MotherSettingsManager } from "../context.js";
import type { Executor } from "../sandbox.js";
import { attachTool, createAttachTool } from "./attach.js";
import { createBashTool } from "./bash.js";
import { createEditTool } from "./edit.js";
import { initCommandGuard, initPathGuard, parseAllowedCommandsEnv } from "./guard.js";
import { createReadTool } from "./read.js";
import { createRecallTool } from "./recall.js";
import { createSearchTool } from "./search.js";
import { createWriteTool } from "./write.js";

export { setUploadFunction } from "./attach.js";

export function createMomTools(
	executor: Executor,
	guardWorkspaceDir?: string,
	settings?: MotherSettingsManager,
): AgentTool<any>[] {
	// Initialize guards when workspace dir is provided (host mode)
	if (guardWorkspaceDir) {
		const extraPaths = process.env.MOTHER_ALLOWED_PATHS?.split(":").filter(Boolean);
		const readOnlyPaths = process.env.MOTHER_READONLY_PATHS?.split(":").filter(Boolean);
		initPathGuard(guardWorkspaceDir, extraPaths, readOnlyPaths);

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
		createBashTool(executor, settings),
		createEditTool(executor, guardWorkspaceDir),
		createWriteTool(executor, guardWorkspaceDir),
		createSearchTool(settings),
		createRecallTool(settings),
		guardWorkspaceDir ? createAttachTool(guardWorkspaceDir) : attachTool,
	];
	return tools;
}
