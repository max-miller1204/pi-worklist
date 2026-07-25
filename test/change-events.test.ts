import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { WorklistApplicationService } from "../src/application-service.ts";
import { createWorklistChangeEvent, type WorklistChangeDescription } from "../src/change-events.ts";
import type { ManagedSessionTaskInput } from "../src/integration-contract.ts";
import { SessionStore } from "../src/session-store.ts";

async function createServiceWithEvents() {
	const projectPath = join(
		await mkdtemp(join(tmpdir(), "pi-worklist-change-events-")),
		".pi",
		"worklist.json",
	);
	const pi = {
		appendEntry: () => undefined,
	} as unknown as ExtensionAPI;
	const sessionStore = new SessionStore(pi);
	const events: WorklistChangeDescription[] = [];
	const service = new WorklistApplicationService({
		projectPath,
		sessionStore,
		publishChange: (description) => events.push(description),
	});
	return { events, service };
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
			runId: "run-13",
		},
	};
}

describe("structured worklist change events", () => {
	it("emits one versioned event per committed mutation with actor, entities, and revisions", async () => {
		const { events, service } = await createServiceWithEvents();

		const added = await service.execute(
			{ scope: "project", action: "add", title: "Event goal" },
			{ source: "command" },
		);
		if (!added.ok || !added.result.goal) throw new Error("Expected goal");
		const goal = added.result.goal;
		expect(events).toHaveLength(1);
		expect(events[0]).toEqual({
			mutation: "project-goals.changed-manually",
			actor: { type: "command", id: "pi-worklist" },
			changedFields: ["/goals"],
			changedEntities: { projectGoalIds: [goal.id], sessionTaskIds: [] },
			revisions: { project: "1" },
		});

		const taskAdded = await service.execute(
			{ scope: "session", action: "add", title: "Event task" },
			{ source: "tool" },
		);
		if (!taskAdded.ok || !taskAdded.result.task) throw new Error("Expected task");
		expect(events).toHaveLength(2);
		expect(events[1]).toMatchObject({
			mutation: "session-tasks.changed-manually",
			actor: { type: "tool", id: "pi-worklist" },
			changedEntities: { projectGoalIds: [], sessionTaskIds: [taskAdded.result.task.id] },
			revisions: { session: expect.any(String) },
		});
		expect(taskAdded.meta.changedEntities).toEqual({
			projectGoalIds: [],
			sessionTaskIds: [taskAdded.result.task.id],
		});
	});

	it("suppresses events for reads, failures, and semantic no-ops", async () => {
		const { events, service } = await createServiceWithEvents();
		const added = await service.execute(
			{ scope: "project", action: "add", title: "Quiet goal", description: "Stable" },
			{ source: "cli" },
		);
		if (!added.ok || !added.result.goal) throw new Error("Expected goal");
		const id = added.result.goal.id;
		expect(events).toHaveLength(1);

		await service.execute({ scope: "project", action: "list" }, { source: "tool" });
		await service.execute(
			{ scope: "project", action: "get_projection", goalSelector: { type: "id", id } },
			{ source: "protocol" },
		);
		await service.execute({ scope: "session", action: "list" }, { source: "tool" });
		expect(events).toHaveLength(1);

		const noOp = await service.execute(
			{ scope: "project", action: "update", id, title: "Quiet goal", description: "Stable" },
			{ source: "dashboard" },
		);
		expect(noOp).toMatchObject({ ok: true, meta: { semanticNoOp: true } });
		expect(events).toHaveLength(1);

		const failure = await service.execute(
			{ scope: "project", action: "complete", id },
			{ source: "protocol" },
		);
		expect(failure).toMatchObject({ ok: false });
		expect(events).toHaveLength(1);
	});

	it("reports both activated and demoted goals when the active goal changes", async () => {
		const { events, service } = await createServiceWithEvents();
		const first = await service.execute(
			{ scope: "project", action: "add", title: "First goal" },
			{ source: "command" },
		);
		const second = await service.execute(
			{ scope: "project", action: "add", title: "Second goal" },
			{ source: "command" },
		);
		if (!first.ok || !first.result.goal || !second.ok || !second.result.goal) {
			throw new Error("Expected goals");
		}
		await service.execute(
			{ scope: "project", action: "set_active", id: first.result.goal.id },
			{ source: "dashboard" },
		);
		events.length = 0;

		await service.execute(
			{ scope: "project", action: "set_active", id: second.result.goal.id },
			{ source: "dashboard" },
		);
		expect(events).toHaveLength(1);
		expect(events[0]?.changedEntities.projectGoalIds).toEqual(
			[first.result.goal.id, second.result.goal.id].sort(),
		);
	});

	it("labels reconciliation and execution updates with orchestration mutation types", async () => {
		const { events, service } = await createServiceWithEvents();
		const added = await service.execute(
			{ scope: "project", action: "add", title: "Run goal" },
			{ source: "command" },
		);
		if (!added.ok || !added.result.goal) throw new Error("Expected goal");
		const goal = added.result.goal;
		events.length = 0;

		const reconciled = await service.execute(
			{
				scope: "session",
				action: "reconcile",
				reconciliation: {
					idempotencyKey: "run-13:plan-1",
					goalId: goal.id,
					expectedGoalUpdatedAt: goal.updatedAt,
					owner: "pi-orchestrator",
					tasks: [managedInput("step-a", "Projected step")],
				},
			},
			{
				source: "protocol",
				actor: { type: "extension", id: "pi-orchestrator", version: "0.9.0" },
				correlation: { runId: "run-13" },
				sourceRequestId: "request-42",
			},
		);
		if (!reconciled.ok) throw new Error("Expected reconciliation");
		const taskId = reconciled.result.reconciliation?.tasks[0]?.taskId;
		expect(events).toHaveLength(1);
		expect(events[0]).toEqual({
			mutation: "session-tasks.reconciled",
			actor: { type: "extension", id: "pi-orchestrator", version: "0.9.0" },
			correlation: { runId: "run-13" },
			sourceRequestId: "request-42",
			changedFields: ["/tasks"],
			changedEntities: { projectGoalIds: [], sessionTaskIds: [taskId] },
			revisions: reconciled.meta.revisions,
		});

		const updated = await service.execute(
			{
				scope: "session",
				action: "update_execution",
				executionUpdate: {
					idempotencyKey: "run-13:execution-1",
					owner: "pi-orchestrator",
					updates: [
						{
							external: { system: "pi-orchestrator", kind: "workflow-step", id: "step-a" },
							execution: {
								state: "running",
								updatedAt: "2026-07-25T12:05:00.000Z",
								runId: "run-13",
							},
						},
					],
				},
			},
			{ source: "protocol", actor: { type: "extension", id: "pi-orchestrator" } },
		);
		expect(updated).toMatchObject({ ok: true, meta: { changed: true } });
		expect(events).toHaveLength(2);
		expect(events[1]).toMatchObject({
			mutation: "session-tasks.execution-updated",
			changedEntities: { sessionTaskIds: [taskId] },
		});
	});

	it("assembles complete versioned event envelopes without unbounded payloads", () => {
		const provider = { id: "pi-worklist" as const, version: "0.4.0", instanceId: "instance-1" };
		const event = createWorklistChangeEvent(provider, {
			mutation: "session-tasks.reconciled",
			actor: { type: "extension", id: "pi-orchestrator" },
			correlation: { runId: "run-13" },
			sourceRequestId: "request-42",
			changedFields: ["/tasks"],
			changedEntities: { projectGoalIds: [], sessionTaskIds: ["task-1"] },
			revisions: { session: "session-2" },
		});
		expect(event).toMatchObject({
			protocol: "pi-worklist",
			protocolVersion: 1,
			eventId: expect.any(String),
			occurredAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
			mutation: "session-tasks.reconciled",
			provider,
			actor: { type: "extension", id: "pi-orchestrator" },
			correlation: { runId: "run-13" },
			sourceRequestId: "request-42",
			changedFields: ["/tasks"],
			changedEntities: { projectGoalIds: [], sessionTaskIds: ["task-1"] },
			revisions: { session: "session-2" },
		});
		expect(Object.keys(event).sort()).toEqual([
			"actor",
			"changedEntities",
			"changedFields",
			"correlation",
			"eventId",
			"mutation",
			"occurredAt",
			"protocol",
			"protocolVersion",
			"provider",
			"revisions",
			"sourceRequestId",
		]);
	});

	it("never lets a faulty subscriber break a committed mutation", async () => {
		const projectPath = join(
			await mkdtemp(join(tmpdir(), "pi-worklist-change-events-faulty-")),
			".pi",
			"worklist.json",
		);
		const service = new WorklistApplicationService({
			projectPath,
			publishChange: () => {
				throw new Error("subscriber exploded");
			},
		});
		const added = await service.execute(
			{ scope: "project", action: "add", title: "Still committed" },
			{ source: "command" },
		);
		expect(added).toMatchObject({ ok: true, meta: { changed: true } });
	});
});
