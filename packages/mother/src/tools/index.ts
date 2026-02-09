import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { Executor } from "../sandbox.js";
import { attachTool } from "./attach.js";
import { createBashTool } from "./bash.js";
import { createClaudeTool } from "./claude.js";
import { createEditTool } from "./edit.js";
import { createReadTool } from "./read.js";
import { createWriteTool } from "./write.js";

export { setUploadFunction } from "./attach.js";

export function createMomTools(executor: Executor, hostWorkspaceDir?: string): AgentTool<any>[] {
	const tools: AgentTool<any>[] = [
		createReadTool(executor),
		createBashTool(executor),
		createEditTool(executor),
		createWriteTool(executor),
		attachTool,
	];
	if (hostWorkspaceDir) {
		tools.push(createClaudeTool(hostWorkspaceDir));
	}
	return tools;
}
