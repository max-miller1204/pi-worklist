import { type ChildProcessWithoutNullStreams, execFileSync, spawn } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const children: ChildProcessWithoutNullStreams[] = [];
afterEach(() => {
	for (const child of children.splice(0)) child.kill("SIGTERM");
});

function rpc(child: ChildProcessWithoutNullStreams, request: object): Promise<Record<string, unknown>> {
	return new Promise((resolveResponse, reject) => {
		let buffer = "";
		const cleanup = () => {
			clearTimeout(timer);
			child.stdout.off("data", onData);
		};
		const onData = (chunk: Buffer) => {
			buffer += chunk.toString("utf8");
			for (;;) {
				const newline = buffer.indexOf("\n");
				if (newline < 0) break;
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				if (!line.trim()) continue;
				const value = JSON.parse(line) as Record<string, unknown>;
				if (value.type === "extension_error") {
					cleanup();
					reject(new Error(JSON.stringify(value)));
					return;
				}
				if (value.type === "response" && value.id === "protocol-e2e") {
					cleanup();
					resolveResponse(value);
					return;
				}
			}
		};
		const timer = setTimeout(() => {
			cleanup();
			reject(new Error("RPC response timed out"));
		}, 30_000);
		child.stdout.on("data", onData);
		child.stdin.write(`${JSON.stringify({ id: "protocol-e2e", ...request })}\n`);
	});
}

describe("real Pi protocol round trip", () => {
	it("negotiates, reconciles, replays, lists, and updates execution against the real provider", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-worklist-protocol-e2e-"));
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
				"-e",
				resolve("test/fixtures/real-provider-consumer.ts"),
			],
			{ cwd, stdio: ["pipe", "pipe", "pipe"] },
		);
		children.push(child);
		let stderr = "";
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf8");
		});

		expect(
			(await rpc(child, { type: "prompt", message: "/tasks project add Protocol E2E goal" })).success,
			stderr,
		).toBe(true);
		const worklist = JSON.parse(await readFile(join(cwd, ".pi", "worklist.json"), "utf8")) as {
			goals: Array<{ id: string; title: string }>;
		};
		const goalId = worklist.goals.find((goal) => goal.title === "Protocol E2E goal")?.id;
		expect(goalId).toBeTruthy();

		expect(
			(await rpc(child, { type: "prompt", message: `/probe-real-worklist ${goalId}` })).success,
			stderr,
		).toBe(true);
		const entries = (await rpc(child, { type: "get_entries" })).data as {
			entries: Array<{ customType?: string; data?: Record<string, unknown> }>;
		};
		const probe = entries.entries.find((entry) => entry.customType === "real-worklist-e2e")?.data as {
			negotiate: Record<string, unknown>;
			detail: Record<string, unknown>;
			reconcile: Record<string, unknown>;
			replay: Record<string, unknown>;
			list: Record<string, unknown>;
			updateExecution: Record<string, unknown>;
			changes: Array<Record<string, unknown>>;
		};
		expect(probe, stderr).toBeTruthy();

		expect(probe.negotiate).toMatchObject({
			ok: true,
			result: {
				provider: { id: "pi-worklist", instanceId: expect.any(String) },
				selectedProtocolVersion: 1,
				capabilities: expect.arrayContaining([
					expect.objectContaining({ id: "session-tasks.reconcile", version: 1 }),
				]),
			},
		});
		expect(probe.detail).toMatchObject({
			ok: true,
			result: { goal: { id: goalId, title: "Protocol E2E goal", status: "open" } },
		});
		expect(probe.reconcile).toMatchObject({
			ok: true,
			result: { tasks: [{ external: { id: "step-e2e" }, action: "created" }] },
			meta: { changed: true, revisions: { session: expect.any(String) } },
		});
		expect(probe.replay).toMatchObject({
			ok: true,
			result: { tasks: [{ external: { id: "step-e2e" }, action: "created" }] },
			meta: { changed: false, semanticNoOp: true },
		});
		expect(probe.list).toMatchObject({
			ok: true,
			result: {
				tasks: [
					{
						title: "Real E2E projected step",
						status: "doing",
						goalId,
						managed: { external: { id: "step-e2e" }, execution: { state: "running" } },
					},
				],
				page: { returned: 1, truncated: false },
			},
		});
		expect(probe.updateExecution).toMatchObject({
			ok: true,
			result: { tasks: [{ external: { id: "step-e2e" }, action: "updated" }] },
			meta: { changed: true },
		});

		const mutations = probe.changes.map((change) => change.mutation);
		expect(mutations).toContain("session-tasks.reconciled");
		expect(mutations).toContain("session-tasks.execution-updated");
		const reconcileChange = probe.changes.find((change) => change.mutation === "session-tasks.reconciled");
		expect(reconcileChange).toMatchObject({
			protocol: "pi-worklist",
			protocolVersion: 1,
			actor: { type: "extension", id: "pi-orchestrator" },
			correlation: { runId: "run-real-e2e" },
			provider: { id: "pi-worklist" },
			changedEntities: { sessionTaskIds: [expect.any(String)] },
		});
	}, 60_000);
});
