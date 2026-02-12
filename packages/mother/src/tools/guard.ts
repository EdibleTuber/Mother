import { normalize, resolve } from "node:path";

export interface GuardResult {
	allowed: boolean;
	reason?: string;
	resolvedPath?: string;
}

// ---------------------------------------------------------------------------
// Path guard
// ---------------------------------------------------------------------------

let allowedPrefixes: string[] = [];

export function initPathGuard(workspaceDir: string, extraPaths?: string[]): void {
	allowedPrefixes = [normalize(workspaceDir), "/tmp"];
	if (extraPaths) {
		for (const p of extraPaths) {
			const trimmed = p.trim();
			if (trimmed) allowedPrefixes.push(normalize(trimmed));
		}
	}
}

export function guardPath(inputPath: string, workspaceDir: string): GuardResult {
	if (allowedPrefixes.length === 0) {
		return { allowed: true, resolvedPath: inputPath };
	}

	const resolved = normalize(resolve(workspaceDir, inputPath));

	for (const prefix of allowedPrefixes) {
		if (resolved === prefix || resolved.startsWith(`${prefix}/`)) {
			return { allowed: true, resolvedPath: resolved };
		}
	}

	return {
		allowed: false,
		reason: `Path denied: ${inputPath} (resolved: ${resolved}) is outside allowed directories`,
	};
}

// ---------------------------------------------------------------------------
// Command guard
// ---------------------------------------------------------------------------

const DEFAULT_ALLOWED_COMMANDS = new Set([
	// File ops
	"ls",
	"cat",
	"head",
	"tail",
	"wc",
	"file",
	"stat",
	"du",
	"df",
	"cp",
	"mv",
	"rm",
	"mkdir",
	"touch",
	"chmod",
	"chown",
	"ln",
	"readlink",
	"realpath",
	"basename",
	"dirname",
	"mktemp",
	// Search
	"find",
	"grep",
	"egrep",
	"fgrep",
	"rg",
	"fd",
	// Text processing
	"sed",
	"awk",
	"sort",
	"uniq",
	"cut",
	"tr",
	"tee",
	"xargs",
	"diff",
	"comm",
	"paste",
	"column",
	"fold",
	"fmt",
	"nl",
	// Development
	"npm",
	"npx",
	"node",
	"git",
	"python",
	"python3",
	"pip",
	"pip3",
	"make",
	"gcc",
	"g++",
	"cargo",
	"rustc",
	"go",
	"java",
	"javac",
	"tsc",
	"tsgo",
	"biome",
	"vitest",
	"jest",
	"bun",
	"deno",
	// Network
	"curl",
	"wget",
	"ssh",
	"scp",
	"rsync",
	// Archive
	"tar",
	"zip",
	"unzip",
	"gzip",
	"gunzip",
	"bzip2",
	"xz",
	// System info (read-only)
	"date",
	"whoami",
	"uname",
	"hostname",
	"printenv",
	"which",
	"type",
	"whereis",
	"id",
	"groups",
	"uptime",
	// Utilities
	"jq",
	"yq",
	"base64",
	"md5sum",
	"sha256sum",
	"sleep",
	"timeout",
	"seq",
	"yes",
	// Process
	"ps",
	"kill",
	"pgrep",
	"pkill",
	"lsof",
	// Package management
	"apt",
	"apt-get",
	"apk",
	"brew",
	// Other
	"less",
	"more",
	"man",
	"clear",
	"tput",
]);

/** Shell builtins that are implicitly allowed (part of sh itself). Does NOT include eval/exec. */
const SHELL_BUILTINS = new Set([
	"cd",
	"echo",
	"printf",
	"export",
	"pwd",
	"set",
	"unset",
	"read",
	"test",
	"[",
	"true",
	"false",
	"exit",
	"return",
	"shift",
	"wait",
	"trap",
	"source",
	".",
	"local",
	"declare",
	"typeset",
	"alias",
	"unalias",
	"hash",
	"command",
	"builtin",
	"let",
	"getopts",
	"pushd",
	"popd",
	"dirs",
	"umask",
	"ulimit",
	"times",
	"bg",
	"fg",
	"jobs",
	"disown",
	"enable",
	"help",
	"logout",
	"mapfile",
	"readarray",
	"compgen",
	"complete",
	"compopt",
	"coproc",
	"select",
	"shopt",
]);

let allowedCommands = new Set(DEFAULT_ALLOWED_COMMANDS);

export function initCommandGuard(addCommands?: string[], removeCommands?: string[]): void {
	allowedCommands = new Set(DEFAULT_ALLOWED_COMMANDS);
	if (addCommands) {
		for (const cmd of addCommands) {
			allowedCommands.add(cmd);
		}
	}
	if (removeCommands) {
		for (const cmd of removeCommands) {
			allowedCommands.delete(cmd);
		}
	}
}

/** Critical patterns that are blocked even when the base command is allowed. */
const CRITICAL_PATTERNS: { pattern: RegExp; reason: string }[] = [
	{ pattern: /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+)?-[a-zA-Z]*r[a-zA-Z]*\s+\/(\s|$|\*)/, reason: "Blocked: rm -rf /" },
	{ pattern: /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*\s+)?-[a-zA-Z]*f[a-zA-Z]*\s+\/(\s|$|\*)/, reason: "Blocked: rm -rf /" },
	{ pattern: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, reason: "Blocked: fork bomb" },
];

/**
 * Split a command string by shell operators (&&, ||, ;, |) respecting quotes.
 * Returns an array of command segments.
 */
function splitCommandSegments(command: string): string[] {
	const segments: string[] = [];
	let current = "";
	let inSingle = false;
	let inDouble = false;
	let escaped = false;

	for (let i = 0; i < command.length; i++) {
		const ch = command[i];

		if (escaped) {
			current += ch;
			escaped = false;
			continue;
		}

		if (ch === "\\") {
			current += ch;
			escaped = true;
			continue;
		}

		if (ch === "'" && !inDouble) {
			inSingle = !inSingle;
			current += ch;
			continue;
		}

		if (ch === '"' && !inSingle) {
			inDouble = !inDouble;
			current += ch;
			continue;
		}

		if (inSingle || inDouble) {
			current += ch;
			continue;
		}

		// Check for shell operators
		if (ch === ";") {
			segments.push(current);
			current = "";
			continue;
		}

		if (ch === "|") {
			if (command[i + 1] === "|") {
				// ||
				segments.push(current);
				current = "";
				i++; // skip next |
				continue;
			}
			// single |
			segments.push(current);
			current = "";
			continue;
		}

		if (ch === "&" && command[i + 1] === "&") {
			segments.push(current);
			current = "";
			i++; // skip next &
			continue;
		}

		current += ch;
	}

	if (current.trim()) {
		segments.push(current);
	}

	return segments;
}

/**
 * Extract the command name (first word) from a segment, stripping:
 * - Leading whitespace
 * - Environment variable assignments (FOO=bar cmd)
 * - Path prefixes (/usr/bin/cmd -> cmd)
 */
function extractCommandName(segment: string): string {
	let trimmed = segment.trim();

	// Skip leading subshell/group syntax
	while (trimmed.startsWith("(") || trimmed.startsWith("{")) {
		trimmed = trimmed.slice(1).trim();
	}

	// Skip env var assignments: VAR=value VAR2=value ... cmd
	while (/^[A-Za-z_][A-Za-z0-9_]*=\S*\s/.test(trimmed)) {
		trimmed = trimmed.replace(/^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/, "");
	}

	// Get first word
	const firstWord = trimmed.split(/\s/)[0] || "";

	// Strip path prefix: /usr/bin/cat -> cat
	const baseName = firstWord.includes("/") ? firstWord.split("/").pop() || firstWord : firstWord;

	return baseName;
}

export function guardCommand(command: string): GuardResult {
	// Check critical patterns first (against the full command)
	for (const { pattern, reason } of CRITICAL_PATTERNS) {
		if (pattern.test(command)) {
			return { allowed: false, reason };
		}
	}

	// Split by shell operators and check each segment
	const segments = splitCommandSegments(command);

	for (const segment of segments) {
		const cmd = extractCommandName(segment);
		if (!cmd) continue;

		// Shell builtins are implicitly allowed
		if (SHELL_BUILTINS.has(cmd)) continue;

		if (!allowedCommands.has(cmd)) {
			return {
				allowed: false,
				reason: `Command denied: '${cmd}' is not on the allowed commands list`,
			};
		}
	}

	return { allowed: true };
}

/**
 * Parse MOTHER_ALLOWED_COMMANDS env var.
 * Format: "+rustup,-ssh,-scp" — prefixed with + to add, - to remove. No prefix = add.
 */
export function parseAllowedCommandsEnv(envValue: string): { add: string[]; remove: string[] } {
	const add: string[] = [];
	const remove: string[] = [];

	for (const token of envValue.split(",")) {
		const trimmed = token.trim();
		if (!trimmed) continue;

		if (trimmed.startsWith("-")) {
			remove.push(trimmed.slice(1));
		} else if (trimmed.startsWith("+")) {
			add.push(trimmed.slice(1));
		} else {
			add.push(trimmed);
		}
	}

	return { add, remove };
}
