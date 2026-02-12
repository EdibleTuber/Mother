import { beforeEach, describe, expect, it } from "vitest";
import {
	guardCommand,
	guardPath,
	initCommandGuard,
	initPathGuard,
	parseAllowedCommandsEnv,
} from "../src/tools/guard.js";

describe("guardPath", () => {
	beforeEach(() => {
		initPathGuard("/home/mother/workspace");
	});

	it("allows files inside workspace", () => {
		const result = guardPath("/home/mother/workspace/file.txt", "/home/mother/workspace");
		expect(result.allowed).toBe(true);
		expect(result.resolvedPath).toBe("/home/mother/workspace/file.txt");
	});

	it("allows nested workspace paths", () => {
		const result = guardPath("/home/mother/workspace/channel/scratch/deep/file.ts", "/home/mother/workspace");
		expect(result.allowed).toBe(true);
	});

	it("allows relative paths resolved against workspace", () => {
		const result = guardPath("MEMORY.md", "/home/mother/workspace");
		expect(result.allowed).toBe(true);
		expect(result.resolvedPath).toBe("/home/mother/workspace/MEMORY.md");
	});

	it("allows /tmp", () => {
		const result = guardPath("/tmp/output.log", "/home/mother/workspace");
		expect(result.allowed).toBe(true);
	});

	it("blocks /etc/passwd", () => {
		const result = guardPath("/etc/passwd", "/home/mother/workspace");
		expect(result.allowed).toBe(false);
		expect(result.reason).toContain("outside allowed directories");
	});

	it("blocks .. traversal escaping workspace", () => {
		const result = guardPath("/home/mother/workspace/../../etc/passwd", "/home/mother/workspace");
		expect(result.allowed).toBe(false);
	});

	it("blocks prefix confusion (workspace-evil)", () => {
		const result = guardPath("/home/mother/workspace-evil/file.txt", "/home/mother/workspace");
		expect(result.allowed).toBe(false);
	});

	it("allows workspace dir itself", () => {
		const result = guardPath("/home/mother/workspace", "/home/mother/workspace");
		expect(result.allowed).toBe(true);
	});

	it("allows extra paths from initPathGuard", () => {
		initPathGuard("/home/mother/workspace", ["/opt/data"]);
		const result = guardPath("/opt/data/file.csv", "/home/mother/workspace");
		expect(result.allowed).toBe(true);
	});

	it("skips guard when not initialized (no prefixes)", () => {
		// Re-init with empty state
		initPathGuard("/home/mother/workspace");
		// This is the normal case — guard is active
		const result = guardPath("/etc/shadow", "/home/mother/workspace");
		expect(result.allowed).toBe(false);
	});
});

describe("guardCommand", () => {
	beforeEach(() => {
		initCommandGuard();
	});

	// --- Allowed commands ---

	it("allows ls -la", () => {
		expect(guardCommand("ls -la").allowed).toBe(true);
	});

	it("allows npm install", () => {
		expect(guardCommand("npm install").allowed).toBe(true);
	});

	it("allows git status", () => {
		expect(guardCommand("git status").allowed).toBe(true);
	});

	it("allows cat file", () => {
		expect(guardCommand("cat somefile.txt").allowed).toBe(true);
	});

	it("allows rm -rf ./dir (relative path)", () => {
		expect(guardCommand("rm -rf ./dir").allowed).toBe(true);
	});

	it("allows command with full path", () => {
		expect(guardCommand("/usr/bin/cat file.txt").allowed).toBe(true);
	});

	// --- Blocked commands ---

	it("blocks sudo", () => {
		const result = guardCommand("sudo apt install curl");
		expect(result.allowed).toBe(false);
		expect(result.reason).toContain("sudo");
	});

	it("blocks shutdown", () => {
		const result = guardCommand("shutdown -h now");
		expect(result.allowed).toBe(false);
		expect(result.reason).toContain("shutdown");
	});

	it("blocks bash -c", () => {
		const result = guardCommand('bash -c "echo hello"');
		expect(result.allowed).toBe(false);
		expect(result.reason).toContain("bash");
	});

	it("blocks dd", () => {
		const result = guardCommand("dd if=/dev/zero of=/dev/sda");
		expect(result.allowed).toBe(false);
		expect(result.reason).toContain("dd");
	});

	it("blocks systemctl", () => {
		const result = guardCommand("systemctl restart nginx");
		expect(result.allowed).toBe(false);
		expect(result.reason).toContain("systemctl");
	});

	// --- Critical patterns ---

	it("blocks rm -rf /", () => {
		const result = guardCommand("rm -rf /");
		expect(result.allowed).toBe(false);
		expect(result.reason).toContain("rm -rf");
	});

	it("blocks rm -rf /*", () => {
		const result = guardCommand("rm -rf /*");
		expect(result.allowed).toBe(false);
		expect(result.reason).toContain("rm -rf");
	});

	it("blocks rm -f -r /", () => {
		const result = guardCommand("rm -f -r /");
		expect(result.allowed).toBe(false);
	});

	it("blocks fork bomb", () => {
		const result = guardCommand(":(){ :|:& };:");
		expect(result.allowed).toBe(false);
		expect(result.reason).toContain("fork bomb");
	});

	// --- Pipelines ---

	it("allows cat file | grep foo | wc -l", () => {
		expect(guardCommand("cat file | grep foo | wc -l").allowed).toBe(true);
	});

	it("blocks cat file | sudo tee /etc/passwd", () => {
		const result = guardCommand("cat file | sudo tee /etc/passwd");
		expect(result.allowed).toBe(false);
		expect(result.reason).toContain("sudo");
	});

	// --- Shell operators ---

	it("allows mkdir -p dir && cd dir", () => {
		expect(guardCommand("mkdir -p dir && cd dir").allowed).toBe(true);
	});

	it("blocks echo hi && sudo rm -rf /", () => {
		const result = guardCommand("echo hi && sudo rm -rf /");
		expect(result.allowed).toBe(false);
	});

	it("allows commands with semicolons", () => {
		expect(guardCommand("ls; pwd; date").allowed).toBe(true);
	});

	it("blocks dangerous command after semicolons", () => {
		const result = guardCommand("ls; bash -c 'evil'");
		expect(result.allowed).toBe(false);
	});

	// --- Shell builtins ---

	it("allows echo (shell builtin)", () => {
		expect(guardCommand("echo hello world").allowed).toBe(true);
	});

	it("allows cd (shell builtin)", () => {
		expect(guardCommand("cd /tmp").allowed).toBe(true);
	});

	it("allows printf (shell builtin)", () => {
		expect(guardCommand("printf '%s' hello").allowed).toBe(true);
	});

	it("blocks eval (not in safe builtins)", () => {
		const result = guardCommand("eval 'rm -rf /'");
		expect(result.allowed).toBe(false);
		expect(result.reason).toContain("eval");
	});

	it("blocks exec (not in safe builtins)", () => {
		const result = guardCommand("exec bash");
		expect(result.allowed).toBe(false);
		expect(result.reason).toContain("exec");
	});

	// --- No false positives ---

	it("does not false positive on 'su' inside other words", () => {
		// 'result' contains 'su' but that shouldn't trigger a block
		expect(guardCommand("echo result").allowed).toBe(true);
	});

	// --- Env var prefix ---

	it("allows commands with env var prefix", () => {
		expect(guardCommand("NODE_ENV=production npm start").allowed).toBe(true);
	});

	// --- Configuration ---

	it("allows added commands via initCommandGuard", () => {
		initCommandGuard(["rustup"], []);
		expect(guardCommand("rustup update").allowed).toBe(true);
	});

	it("blocks removed commands via initCommandGuard", () => {
		initCommandGuard([], ["ssh"]);
		const result = guardCommand("ssh user@host");
		expect(result.allowed).toBe(false);
		expect(result.reason).toContain("ssh");
	});

	it("allows or-chained commands", () => {
		expect(guardCommand("test -f file || touch file").allowed).toBe(true);
	});
});

describe("parseAllowedCommandsEnv", () => {
	it("parses +add and -remove", () => {
		const result = parseAllowedCommandsEnv("+rustup,-ssh,-scp");
		expect(result.add).toEqual(["rustup"]);
		expect(result.remove).toEqual(["ssh", "scp"]);
	});

	it("treats no prefix as add", () => {
		const result = parseAllowedCommandsEnv("rustup,terraform");
		expect(result.add).toEqual(["rustup", "terraform"]);
		expect(result.remove).toEqual([]);
	});

	it("handles whitespace", () => {
		const result = parseAllowedCommandsEnv(" +rustup , -ssh ");
		expect(result.add).toEqual(["rustup"]);
		expect(result.remove).toEqual(["ssh"]);
	});

	it("handles empty string", () => {
		const result = parseAllowedCommandsEnv("");
		expect(result.add).toEqual([]);
		expect(result.remove).toEqual([]);
	});
});
