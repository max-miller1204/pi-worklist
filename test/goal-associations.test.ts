import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorklistApplicationService } from "../src/application-service.ts";
import {
	inspectManagedGoalAssociation,
	ProjectGoalAssociationChangedError,
	ProjectGoalOrchestrationBlockedError,
	resolveProjectGoalForOrchestration,
	validateManagedGoalAssociation,
} from "../src/goal-associations.ts";
import { SessionStore } from "../src/session-store.ts";

async function createHarness() {
	const root = await mkdtemp(join(tmpdir(), "pi-worklist-goal-associations-"));
	const projectPath = join(root, ".pi", "worklist.json");
	const entries: unknown[] = [];
	const pi = {
		appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
	} as unknown as ExtensionAPI;
	const sessionStore = new SessionStore(pi);
	const service = new WorklistApplicationService({ projectPath, sessionStore });
	return { entries, projectPath, service, sessionStore };
}

async function addGoal(service: WorklistApplicationService, title = "Orchestrated goal") {
	const result = await service.execute({ scope: "project", action: "add", title }, { source: "command" });
	expect(result.ok).toBe(true);
	if (!result.ok || !result.result.goal) throw new Error("Expected Project Goal creation to succeed");
	return result.result.goal;
}

afterEach(() => {
	vi.useRealTimers();
});

function managedTask(goalId: string) {
	return {
		id: "managed-task",
		title: "Projected work",
		status: "doing" as const,
		goalId,
		managed: {
			version: 1 as const,
			owner: "pi-orchestrator" as const,
			producer: { id: "pi-orchestrator" as const, version: "0.8.0" },
			external: {
				system: "pi-orchestrator" as const,
				kind: "workflow-step" as const,
				id: "step-1",
			},
			planRevision: 2,
			approvedPlanRevision: 1,
			createdAt: "2026-07-24T20:00:00.000Z",
			updatedAt: "2026-07-24T20:05:00.000Z",
			execution: {
				state: "running" as const,
				updatedAt: "2026-07-24T20:05:00.000Z",
				runId: "run-1",
			},
		},
	};
}

describe("orchestrator Project Goal associations", () => {
	it("returns the selected stable goal identity and exact project snapshot revision", async () => {
		const { projectPath, service } = await createHarness();
		const goal = await addGoal(service);

		const selected = await resolveProjectGoalForOrchestration(projectPath, {
			type: "id",
			id: goal.id,
		});
		expect(selected).toEqual({ goal, revision: "1" });

		await service.execute(
			{ scope: "project", action: "set_active", id: goal.id, expectedRevision: "1" },
			{ source: "dashboard" },
		);
		const active = await resolveProjectGoalForOrchestration(projectPath, { type: "active" });
		expect(active.goal?.id).toBe(goal.id);
		expect(active.goal?.updatedAt).not.toBe(goal.updatedAt);
		expect(active.revision).toBe("2");
	});

	it("rejects done and archived goals until an explicitly confirmed reopen", async () => {
		const { projectPath, service } = await createHarness();
		const goal = await addGoal(service);

		await service.execute(
			{ scope: "project", action: "complete", id: goal.id, confirm: true },
			{ source: "command" },
		);
		await expect(validateManagedGoalAssociation(projectPath, goal.id)).rejects.toMatchObject({
			name: ProjectGoalOrchestrationBlockedError.name,
			goalId: goal.id,
			status: "done",
		});

		const unconfirmed = await service.execute(
			{ scope: "project", action: "reopen", id: goal.id },
			{ source: "protocol" },
		);
		expect(unconfirmed).toMatchObject({ ok: false, error: { code: "APPROVAL_REQUIRED" } });
		await expect(validateManagedGoalAssociation(projectPath, goal.id)).rejects.toBeInstanceOf(
			ProjectGoalOrchestrationBlockedError,
		);

		await service.execute(
			{ scope: "project", action: "archive", id: goal.id, confirm: true },
			{ source: "dashboard" },
		);
		await expect(validateManagedGoalAssociation(projectPath, goal.id)).rejects.toMatchObject({
			status: "archived",
		});

		const reopened = await service.execute(
			{ scope: "project", action: "reopen", id: goal.id, confirm: true },
			{ source: "dashboard" },
		);
		expect(reopened).toMatchObject({ ok: true, result: { goal: { id: goal.id, status: "open" } } });
		await expect(validateManagedGoalAssociation(projectPath, goal.id)).resolves.toMatchObject({
			goal: { id: goal.id, status: "open" },
		});
	});

	it("detects edits to the exact selected goal even when the wall clock does not advance", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-07-24T20:00:00.000Z"));
		const { projectPath, service } = await createHarness();
		const goal = await addGoal(service);
		const selected = await validateManagedGoalAssociation(projectPath, goal.id);

		await service.execute(
			{ scope: "project", action: "update", id: goal.id, title: "Edited after planning" },
			{ source: "tool" },
		);

		await expect(
			validateManagedGoalAssociation(projectPath, goal.id, {
				expectedGoalUpdatedAt: selected.goal.updatedAt,
			}),
		).rejects.toMatchObject({
			name: ProjectGoalAssociationChangedError.name,
			goalId: goal.id,
			expectedGoalUpdatedAt: "2026-07-24T20:00:00.000Z",
			actualGoalUpdatedAt: "2026-07-24T20:00:00.001Z",
		});
	});

	it("detaches malformed managed metadata that has no Project Goal association", async () => {
		const { entries, sessionStore } = await createHarness();
		const { goalId: _goalId, ...taskWithoutGoal } = managedTask("missing-association");
		sessionStore.reconstruct({
			sessionManager: {
				getBranch: () => [
					{
						type: "custom",
						id: "snapshot-malformed-managed",
						customType: "worklist-session-snapshot",
						data: { version: 3, revision: "session-1", tasks: [taskWithoutGoal] },
					},
				],
			},
		} as never);

		await sessionStore.setTaskStatus(taskWithoutGoal.id, "done");
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({
			data: {
				tasks: [{ id: taskWithoutGoal.id, title: taskWithoutGoal.title, status: "done" }],
			},
		});
		expect(entries[0]).not.toMatchObject({ data: { tasks: [{ managed: expect.anything() }] } });
	});

	it("preserves closed and temporarily orphaned projections without treating them as eligible", async () => {
		const { entries, projectPath, service, sessionStore } = await createHarness();
		const goal = await addGoal(service);
		const task = managedTask(goal.id);
		sessionStore.reconstruct({
			sessionManager: {
				getBranch: () => [
					{
						type: "custom",
						id: "snapshot-managed",
						customType: "worklist-session-snapshot",
						data: { version: 3, revision: "session-1", tasks: [task] },
					},
				],
			},
		} as never);

		await service.execute(
			{ scope: "project", action: "archive", id: goal.id, confirm: true },
			{ source: "dashboard" },
		);
		expect(await inspectManagedGoalAssociation(projectPath, goal.id)).toMatchObject({
			state: "closed",
			goal: { id: goal.id, status: "archived" },
		});
		expect(sessionStore.getTasks()).toEqual([
			{ id: task.id, title: task.title, status: task.status, goalId: goal.id },
		]);
		expect(entries).toHaveLength(0);

		await service.execute(
			{ scope: "project", action: "delete", id: goal.id, confirm: true },
			{ source: "dashboard" },
		);
		expect(await inspectManagedGoalAssociation(projectPath, goal.id)).toEqual({
			goalId: goal.id,
			state: "missing",
			revision: "3",
		});
		expect(sessionStore.getTasks()).toEqual([
			{ id: task.id, title: task.title, status: task.status, goalId: goal.id },
		]);
		expect(entries).toHaveLength(0);
	});
});
