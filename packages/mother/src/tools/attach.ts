import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { basename, resolve as resolvePath } from "path";
import { guardPath } from "./guard.js";

// This will be set by the agent before running
let uploadFn: ((filePath: string, title?: string) => Promise<void>) | null = null;

export function setUploadFunction(fn: (filePath: string, title?: string) => Promise<void>): void {
	uploadFn = fn;
}

const attachSchema = Type.Object({
	label: Type.Optional(Type.String({ description: "Brief description of what you're sharing (shown to user)" })),
	path: Type.String({ description: "Path to the file to attach" }),
	title: Type.Optional(Type.String({ description: "Title for the file (defaults to filename)" })),
});

function makeAttachExecute(workspaceDir?: string) {
	return async (
		_toolCallId: string,
		{ path, title }: { label?: string; path: string; title?: string },
		signal?: AbortSignal,
	) => {
		if (!uploadFn) {
			throw new Error("Upload function not configured");
		}

		if (signal?.aborted) {
			throw new Error("Operation aborted");
		}

		if (workspaceDir) {
			const check = guardPath(path, workspaceDir);
			if (!check.allowed) throw new Error(check.reason!);
			path = check.resolvedPath!;
		}

		const absolutePath = resolvePath(path);
		const fileName = title || basename(absolutePath);

		await uploadFn(absolutePath, fileName);

		return {
			content: [{ type: "text" as const, text: `Attached file: ${fileName}` }],
			details: undefined,
		};
	};
}

export const attachTool: AgentTool<typeof attachSchema> = {
	name: "attach",
	label: "attach",
	description:
		"Attach a file to your response. Use this to share files, images, or documents with the user in Discord. Only files from /workspace/ can be attached.",
	parameters: attachSchema,
	execute: makeAttachExecute(),
};

export function createAttachTool(workspaceDir: string): AgentTool<typeof attachSchema> {
	return {
		name: "attach",
		label: "attach",
		description:
			"Attach a file to your response. Use this to share files, images, or documents with the user in Discord. Only files from /workspace/ can be attached.",
		parameters: attachSchema,
		execute: makeAttachExecute(workspaceDir),
	};
}
