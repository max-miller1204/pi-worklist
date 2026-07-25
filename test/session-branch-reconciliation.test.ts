import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { WorklistApplicationService } from "../src/application-service.ts";
import type { ManagedSessionTaskInput } from "../src/integration-contract.ts";
import { MAX_PROJECTION_RECONCILIATION_RECORDS } from "../src/projection-reconciliation.ts";
import { SessionStore } from "../src/session-store.ts";

interface RecordedEntry {
	type: string;
	id?: string;
	customType: string;
	data: unknown;
}

function createSession(projectPath: string, branch: RecordedEntry[] = []) {
	const entries: RecordedEntry[] = [...branch];
	const pi = {
		appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
	} as unknown as ExtensionAPI;
	const sessionStore = new SessionStore(pi);
	sessionStore.reconstruct({ sessionManager: { getBranch: () => entries } } as never);
	const service = new WorklistApplicationService({ projectPath, sessionStore });
	return { entries, sessionStore, service };
}

function managedInput(externalId: string, title: string): ManagedSessionTaskInput {
	return {
		external: { system: "pi-orchestrator", kind: "workflow-step", id: externalId },
		title,
		status: "todo",
		producer: { id: "pi-orchestrator", version: "0.9.0" },
		planRevision: 1,
		approvedPlanRevision: 1,
		execution: {
			state: "planned",
			updatedAt: "2026-07-25T12:00:00.000Z",
			runId: "run-11",
		},
	};
}

async function createProjectGoal(projectPath: string) {
	const service = new WorklistApplicationService({ projectPath });
	const added = await service.execute(
		{ scope: "project", action: "add", title: "Branch-aware goal" },
		{ source: "command" },
	);
	if (!added.ok || !added.result.goal) throw new Error("Expected goal creation");
	return added.result.goal;
}

async function newProjectPath(prefix: string) {
	return join(await mkdtemp(join(tmpdir(), prefix)), ".pi", "worklist.json");
}

describe("reconciliation across session tree, fork, clone, resume, and replacement", () => {
	it("replays only on branches that contain the committed reconciliation", async () => {
		const projectPath = await newProjectPath("pi-worklist-branch-replay-");
		const goal = await createProjectGoal(projectPath);
		const original = createSession(projectPath);
		await original.service.execute(
			{ scope: "session", action: "add", title: "Shared user task" },
			{ source: "tool" },
		);
		const sharedPrefix = [...original.entries];

		const reconciliation = {
			idempotencyKey: "run-11:plan-1",
			goalId: goal.id,
			expectedGoalUpdatedAt: goal.updatedAt,
			owner: "pi-orchestrator" as const,
			tasks: [managedInput("step-a", "Projected step")],
		};
		const first = await original.service.execute(
			{ scope: "session", action: "reconcile", reconciliation },
			{ source: "protocol" },
		);
		expect(first).toMatchObject({ ok: true, meta: { changed: true } });
		const originalTaskId = first.ok ? first.result.reconciliation?.tasks[0]?.taskId : undefined;
		expect(originalTaskId).toBeTruthy();

		// /tree navigation to the pre-reconciliation node: the same key must re-execute there.
		const earlierBranch = createSession(projectPath, sharedPrefix);
		const reExecuted = await earlierBranch.service.execute(
			{ scope: "session", action: "reconcile", reconciliation },
			{ source: "protocol" },
		);
		expect(reExecuted).toMatchObject({ ok: true, meta: { changed: true, semanticNoOp: false } });
		const reExecutedTaskId = reExecuted.ok ? reExecuted.result.reconciliation?.tasks[0]?.taskId : undefined;
		expect(reExecutedTaskId).toBeTruthy();
		expect(reExecutedTaskId).not.toBe(originalTaskId);

		// Back on the reconciled branch (fork or clone copies it), the key replays the original result.
		const forked = createSession(projectPath, original.entries);
		const replayed = await forked.service.execute(
			{ scope: "session", action: "reconcile", reconciliation },
			{ source: "protocol" },
		);
		expect(replayed).toMatchObject({
			ok: true,
			result: { reconciliation: { tasks: [{ taskId: originalTaskId, action: "created" }] } },
			meta: { changed: false, semanticNoOp: true },
		});
		expect(forked.entries).toHaveLength(original.entries.length);
	});

	it("produces distinct successor tokens for mutations on branches sharing a snapshot", async () => {
		const projectPath = await newProjectPath("pi-worklist-branch-tokens-");
		const legacyEntry: RecordedEntry = {
			type: "custom",
			id: "legacy-shared-snapshot",
			customType: "worklist-session-snapshot",
			data: {
				version: 2,
				tasks: [{ id: "task-1", title: "Shared task", status: "todo" }],
			},
		};
		const branchA = createSession(projectPath, [legacyEntry]);
		const branchB = createSession(projectPath, [legacyEntry]);
		expect(branchA.sessionStore.getRevision()).toBe("legacy-shared-snapshot");
		expect(branchB.sessionStore.getRevision()).toBe("legacy-shared-snapshot");

		const mutatedA = await branchA.service.execute(
			{
				scope: "session",
				action: "set_status",
				id: "task-1",
				status: "doing",
				expectedRevision: "legacy-shared-snapshot",
			},
			{ source: "protocol" },
		);
		const mutatedB = await branchB.service.execute(
			{
				scope: "session",
				action: "set_status",
				id: "task-1",
				status: "done",
				expectedRevision: "legacy-shared-snapshot",
			},
			{ source: "protocol" },
		);
		const revisionA = mutatedA.meta.revisions?.session;
		const revisionB = mutatedB.meta.revisions?.session;
		expect(revisionA).toBeTruthy();
		expect(revisionB).toBeTruthy();
		expect(revisionA).not.toBe("legacy-shared-snapshot");
		expect(revisionB).not.toBe("legacy-shared-snapshot");
		expect(revisionA).not.toBe(revisionB);

		// A consumer resumed from the shared snapshot can no longer overwrite either branch silently.
		const stale = await branchA.service.execute(
			{
				scope: "session",
				action: "set_status",
				id: "task-1",
				status: "todo",
				expectedRevision: "legacy-shared-snapshot",
			},
			{ source: "protocol" },
		);
		expect(stale).toMatchObject({
			ok: false,
			error: {
				code: "CONFLICT",
				conflict: {
					type: "revision",
					expectedRevision: "legacy-shared-snapshot",
					actualRevision: revisionA,
				},
			},
		});
	});

	it("starts session replacement from scratch instead of replaying prior-session state", async () => {
		const projectPath = await newProjectPath("pi-worklist-branch-replacement-");
		const goal = await createProjectGoal(projectPath);
		const first = createSession(projectPath);
		const reconciliation = {
			idempotencyKey: "run-11:plan-1",
			goalId: goal.id,
			expectedGoalUpdatedAt: goal.updatedAt,
			owner: "pi-orchestrator" as const,
			tasks: [managedInput("step-a", "Projected step")],
		};
		const committed = await first.service.execute(
			{ scope: "session", action: "reconcile", reconciliation },
			{ source: "protocol" },
		);
		expect(committed).toMatchObject({ ok: true, meta: { changed: true } });

		const replacement = createSession(projectPath, []);
		expect(replacement.sessionStore.getTasks()).toEqual([]);
		expect(replacement.sessionStore.getRevision()).toBe("0");
		const fresh = await replacement.service.execute(
			{ scope: "session", action: "reconcile", reconciliation },
			{ source: "protocol" },
		);
		expect(fresh).toMatchObject({ ok: true, meta: { changed: true, semanticNoOp: false } });
		expect(replacement.sessionStore.getTasks()).toHaveLength(1);
	});

	it("bounds replay records to the most recent mutations and keeps them replayable", async () => {
		const projectPath = await newProjectPath("pi-worklist-branch-bounded-");
		const goal = await createProjectGoal(projectPath);
		const session = createSession(projectPath);

		const reconciliationFor = (index: number) => ({
			idempotencyKey: `run-11:plan-${index}`,
			goalId: goal.id,
			expectedGoalUpdatedAt: goal.updatedAt,
			owner: "pi-orchestrator" as const,
			tasks: [managedInput("step-a", `Projected title ${index}`)],
		});
		for (let index = 0; index <= MAX_PROJECTION_RECONCILIATION_RECORDS; index++) {
			// Each reconciliation depends on the previous snapshot, so they must run sequentially.
			// pi-lens-ignore: await-in-loop
			const result = await session.service.execute(
				{ scope: "session", action: "reconcile", reconciliation: reconciliationFor(index) },
				{ source: "protocol" },
			);
			expect(result).toMatchObject({ ok: true });
		}

		const lastSnapshot = session.entries.at(-1) as RecordedEntry & {
			data: { projectionReconciliations?: Array<{ idempotencyKey: string }> };
		};
		const records = lastSnapshot.data.projectionReconciliations ?? [];
		expect(records).toHaveLength(MAX_PROJECTION_RECONCILIATION_RECORDS);
		expect(records[0]?.idempotencyKey).toBe("run-11:plan-1");
		expect(records.at(-1)?.idempotencyKey).toBe(`run-11:plan-${MAX_PROJECTION_RECONCILIATION_RECORDS}`);

		// The newest record still replays after reconstruction.
		const resumed = createSession(projectPath, session.entries);
		const replayed = await resumed.service.execute(
			{
				scope: "session",
				action: "reconcile",
				reconciliation: reconciliationFor(MAX_PROJECTION_RECONCILIATION_RECORDS),
			},
			{ source: "protocol" },
		);
		expect(replayed).toMatchObject({ ok: true, meta: { changed: false, semanticNoOp: true } });

		// The evicted key is no longer replayable; it re-executes as a new mutation.
		const evicted = await resumed.service.execute(
			{ scope: "session", action: "reconcile", reconciliation: reconciliationFor(0) },
			{ source: "protocol" },
		);
		expect(evicted).toMatchObject({ ok: true, meta: { changed: true, semanticNoOp: false } });
	});
});
