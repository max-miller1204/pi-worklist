import { afterEach, describe, expect, it } from "vitest";
import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const children: ChildProcessWithoutNullStreams[] = [];
afterEach(() => {
	for (const child of children.splice(0)) child.kill("SIGTERM");
});

function parseJson<T>(value: string): T {
	try {
		return JSON.parse(value) as T;
	} catch (error) {
		throw new Error(`Invalid JSON: ${String(error)}`);
	}
}

function rpc(child: ChildProcessWithoutNullStreams, request: object): Promise<Record<string, unknown>> {
	return new Promise((resolveResponse, reject) => {
		let buffer = "";
		const timer = setTimeout(() => reject(new Error("RPC response timed out")), 20_000);
		child.stdout.on("data", (chunk: Buffer) => {
			buffer += chunk.toString("utf8");
			for (;;) {
				const newline = buffer.indexOf("\n");
				if (newline < 0) break;
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				if (!line.trim()) continue;
				const value = parseJson<Record<string, unknown>>(line);
				if (value.type === "extension_error") {
					clearTimeout(timer);
					reject(new Error(JSON.stringify(value)));
				}
				if (value.type === "response" && value.id === "test") {
					clearTimeout(timer);
					resolveResponse(value);
				}
			}
		});
		child.stdin.write(`${JSON.stringify({ id: "test", ...request })}\n`);
	});
}

describe("real Pi load", () => {
	it("loads the package and registers /tasks", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-worklist-rpc-"));
		execFileSync("git", ["init", "-q"], { cwd });
		const child = spawn(
			"pi",
			[
				"--mode",
				"rpc",
				"--offline",
				"--no-extensions",
				"--no-skills",
				"--no-prompt-templates",
				"--no-themes",
				"--no-context-files",
				"--session-dir",
				join(cwd, "sessions"),
				"-e",
				resolve("."),
			],
			{ cwd, stdio: ["pipe", "pipe", "pipe"] },
		);
		children.push(child);
		let stderr = "";
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf8");
		});
		const response = await rpc(child, { type: "get_commands" });
		expect(response.success, stderr).toBe(true);
		const data = response.data as { commands: Array<{ name: string; path?: string }> };
		expect(data.commands.some((command) => command.name.startsWith("tasks"))).toBe(true);

		expect(
			(
				await rpc(child, {
					type: "prompt",
					message: "/tasks session add RPC task -- Extra context for the task",
				})
			).success,
		).toBe(true);
		const sessionEntries = (await rpc(child, { type: "get_entries" })).data as {
			entries: Array<{
				type: string;
				customType?: string;
				data?: { tasks?: Array<{ title: string; description?: string }> };
			}>;
		};
		const snapshot = sessionEntries.entries.find(
			(entry) => entry.type === "custom" && entry.customType === "worklist-session-snapshot",
		);
		expect(snapshot?.data?.tasks?.[0]).toMatchObject({
			title: "RPC task",
			description: "Extra context for the task",
		});

		expect((await rpc(child, { type: "prompt", message: "/tasks project add RPC goal" })).success).toBe(true);
		const project = parseJson<{ goals: Array<{ title: string }> }>(
			await readFile(join(cwd, ".pi", "worklist.json"), "utf8"),
		);
		expect(project.goals.some((goal) => goal.title === "RPC goal")).toBe(true);

		expect((await rpc(child, { type: "new_session" })).success).toBe(true);
		const freshEntries = (await rpc(child, { type: "get_entries" })).data as {
			entries: Array<{ customType?: string }>;
		};
		expect(freshEntries.entries.some((entry) => entry.customType === "worklist-session-snapshot")).toBe(
			false,
		);
		expect(
			parseJson<{ goals: unknown[] }>(await readFile(join(cwd, ".pi", "worklist.json"), "utf8")).goals,
		).toHaveLength(1);
	});
});
