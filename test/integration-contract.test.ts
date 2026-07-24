import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	CURRENT_WORKLIST_PROTOCOL_VERSION,
	canonicalChangedFields,
	createWorklistErrorResult,
	isWorklistRequest,
	isWorklistResult,
	MANAGED_SESSION_TASK_PROJECTION_VERSION,
	MAX_MANAGED_REFERENCE_BYTES,
	normalizeManagedSessionTaskProjection,
	SUPPORTED_WORKLIST_PROTOCOL_VERSIONS,
	WORKLIST_CAPABILITIES,
	WORKLIST_CHANGE_EVENT,
	WORKLIST_ERROR_CODES,
	WORKLIST_OPERATIONS,
	WORKLIST_PROTOCOL_ID,
	WORKLIST_REQUEST_EVENT,
	WORKLIST_RESULT_EVENT,
	type WorklistRequest,
} from "pi-worklist/integration-contract";
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
				if (value.type === "response" && value.id === "contract-test") {
					cleanup();
					resolveResponse(value);
					return;
				}
			}
		};
		const timer = setTimeout(() => {
			cleanup();
			reject(new Error("RPC response timed out"));
		}, 20_000);
		child.stdout.on("data", onData);
		child.stdin.write(`${JSON.stringify({ id: "contract-test", ...request })}\n`);
	});
}

describe("pi-worklist integration contract", () => {
	it("keeps negotiation discoverable and excludes unapproved goal lifecycle operations", () => {
		expect(SUPPORTED_WORKLIST_PROTOCOL_VERSIONS).toEqual([CURRENT_WORKLIST_PROTOCOL_VERSION]);
		expect(new Set([WORKLIST_REQUEST_EVENT, WORKLIST_RESULT_EVENT, WORKLIST_CHANGE_EVENT]).size).toBe(3);
		expect(Object.values(WORKLIST_OPERATIONS)).toEqual([
			"capabilities.negotiate",
			"project-goals.get",
			"project-goals.create-approved-batch",
			"session-tasks.list",
			"session-tasks.reconcile",
			"session-tasks.update-execution",
		]);
		expect(Object.values(WORKLIST_OPERATIONS)).not.toContain("project-goals.complete");
		expect(Object.values(WORKLIST_OPERATIONS)).not.toContain("project-goals.archive");
		expect(Object.values(WORKLIST_OPERATIONS)).not.toContain("project-goals.delete");
		expect(Object.values(WORKLIST_CAPABILITIES)).toContain("changes.subscribe");
	});

	it("validates bounded managed workflow-step projections without copying canonical run details", () => {
		const projection = {
			version: MANAGED_SESSION_TASK_PROJECTION_VERSION,
			owner: "pi-orchestrator",
			producer: { id: "pi-orchestrator", version: "0.8.0" },
			external: { system: "pi-orchestrator", kind: "workflow-step", id: "step-3" },
			planRevision: 4,
			approvedPlanRevision: 3,
			createdAt: "2026-07-24T20:00:00.000Z",
			updatedAt: "2026-07-24T20:05:00.000Z",
			execution: {
				state: "running",
				updatedAt: "2026-07-24T20:05:00.000Z",
				runId: "run-7",
				summary: "Current projected state",
				runReference: "pi-orchestrator://runs/run-7",
				attempt: 8,
				artifacts: ["artifact-secret"],
			},
			resultReference: "pi-orchestrator://results/result-9",
			sessionContributionReference: "pi://sessions/session-2#entry-5",
			recovery: { checkpoint: "recovery-secret" },
		};

		const normalized = normalizeManagedSessionTaskProjection(projection);
		expect(normalized).toEqual({
			version: 1,
			owner: "pi-orchestrator",
			producer: { id: "pi-orchestrator", version: "0.8.0" },
			external: { system: "pi-orchestrator", kind: "workflow-step", id: "step-3" },
			planRevision: 4,
			approvedPlanRevision: 3,
			createdAt: "2026-07-24T20:00:00.000Z",
			updatedAt: "2026-07-24T20:05:00.000Z",
			execution: {
				state: "running",
				updatedAt: "2026-07-24T20:05:00.000Z",
				runId: "run-7",
				summary: "Current projected state",
				runReference: "pi-orchestrator://runs/run-7",
			},
			resultReference: "pi-orchestrator://results/result-9",
			sessionContributionReference: "pi://sessions/session-2#entry-5",
		});
		expect(normalized?.execution).not.toHaveProperty("attempt");
		expect(normalized).not.toHaveProperty("recovery");
		expect(
			normalizeManagedSessionTaskProjection({
				...projection,
				resultReference: "x".repeat(MAX_MANAGED_REFERENCE_BYTES + 1),
			}),
		).toBeUndefined();
		expect(
			normalizeManagedSessionTaskProjection({
				...projection,
				external: { ...projection.external, kind: "phase" },
			}),
		).toBeUndefined();
	});

	it("defines deterministic correlated error envelopes and canonical changed fields", () => {
		const request: WorklistRequest<"session-tasks.reconcile"> = {
			protocol: WORKLIST_PROTOCOL_ID,
			protocolVersion: CURRENT_WORKLIST_PROTOCOL_VERSION,
			requestId: "request-conflict",
			operation: "session-tasks.reconcile",
			actor: { type: "extension", id: "pi-orchestrator" },
			correlation: { runId: "run-7", stepId: "step-3" },
			payload: {
				idempotencyKey: "run-7:projection-1",
				goalId: "goal-1",
				owner: "pi-orchestrator",
				tasks: [],
			},
		};
		const result = createWorklistErrorResult(request, {
			code: WORKLIST_ERROR_CODES.CONFLICT,
			message: "Session revision changed",
			retryable: true,
			conflict: {
				type: "revision",
				expectedRevision: "session-4",
				actualRevision: "session-5",
				conflictingIds: ["task-1"],
				resolution: "refresh-and-retry",
			},
		});

		expect(result).toEqual({
			protocol: WORKLIST_PROTOCOL_ID,
			protocolVersion: CURRENT_WORKLIST_PROTOCOL_VERSION,
			requestId: "request-conflict",
			operation: "session-tasks.reconcile",
			actor: request.actor,
			correlation: request.correlation,
			ok: false,
			error: {
				code: "CONFLICT",
				message: "Session revision changed",
				retryable: true,
				conflict: {
					type: "revision",
					expectedRevision: "session-4",
					actualRevision: "session-5",
					conflictingIds: ["task-1"],
					resolution: "refresh-and-retry",
				},
			},
			meta: { changed: false, semanticNoOp: false, changedFields: [] },
		});
		expect(canonicalChangedFields(["/tasks/2/status", "/tasks/0", "/tasks/2/status"])).toEqual([
			"/tasks/0",
			"/tasks/2/status",
		]);
		expect(isWorklistRequest(request)).toBe(true);
		expect(isWorklistResult(result)).toBe(true);
		expect(isWorklistRequest({ ...request, operation: "project-goals.delete" })).toBe(false);
		expect(isWorklistRequest({ ...request, actor: { type: "mystery", id: "unknown" } })).toBe(false);
		expect(isWorklistResult({ ...result, error: { ...result.error, code: "MYSTERY" } })).toBe(false);
		expect(
			isWorklistResult({ ...result, meta: { ...result.meta, changedFields: ["/tasks/2", "/tasks/1"] } }),
		).toBe(false);
	});

	it("requires explicit approval evidence for externally materialized goals", () => {
		const request = {
			protocol: WORKLIST_PROTOCOL_ID,
			protocolVersion: CURRENT_WORKLIST_PROTOCOL_VERSION,
			requestId: "approved-goals-1",
			operation: "project-goals.create-approved-batch",
			actor: { type: "extension", id: "pi-orchestrator" },
			payload: {
				expectedProjectRevision: "project-8",
				idempotencyKey: "roadmap-2:revision-4",
				approval: {
					type: "explicit-user-approval",
					approvalId: "approval-9",
					approvedAt: "2026-07-24T12:00:00.000Z",
					approvedBy: { type: "user", id: "local-user" },
					contentDigest: "sha256:approved-content",
				},
				goals: [
					{
						external: { system: "pi-orchestrator", kind: "phase", id: "phase-1" },
						title: "Approved phase",
					},
				],
			},
		} satisfies WorklistRequest<"project-goals.create-approved-batch">;

		expect(isWorklistRequest(request)).toBe(true);
		expect(request.payload.approval.type).toBe("explicit-user-approval");
	});

	it("round-trips capability negotiation between two real Pi extensions", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-worklist-contract-rpc-"));
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
				resolve("test/fixtures/integration-contract-provider.ts"),
				"-e",
				resolve("test/fixtures/integration-contract-consumer.ts"),
			],
			{ cwd, stdio: ["pipe", "pipe", "pipe"] },
		);
		children.push(child);
		let stderr = "";
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf8");
		});

		expect((await rpc(child, { type: "prompt", message: "/probe-worklist-contract" })).success, stderr).toBe(
			true,
		);
		const entriesResponse = await rpc(child, { type: "get_entries" });
		const data = entriesResponse.data as {
			entries: Array<{ customType?: string; data?: Record<string, unknown> }>;
		};
		const result = data.entries.find((entry) => entry.customType === "integration-contract-result")?.data;

		expect(result).toMatchObject({
			protocol: WORKLIST_PROTOCOL_ID,
			protocolVersion: CURRENT_WORKLIST_PROTOCOL_VERSION,
			requestId: "contract-e2e-request",
			operation: "capabilities.negotiate",
			actor: { type: "extension", id: "pi-orchestrator" },
			correlation: { runId: "run-contract-e2e" },
			ok: true,
			result: {
				supportedProtocolVersions: [CURRENT_WORKLIST_PROTOCOL_VERSION],
				selectedProtocolVersion: CURRENT_WORKLIST_PROTOCOL_VERSION,
				capabilities: [{ id: WORKLIST_CAPABILITIES.PROJECT_GOALS_READ, version: 1 }],
			},
			meta: { changed: false, semanticNoOp: false, changedFields: [] },
		});
	});
});
