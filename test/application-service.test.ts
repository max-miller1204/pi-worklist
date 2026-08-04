import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
	unwrapWorklistApplicationResult,
	WorklistApplicationService,
	type WorklistOperationSource,
} from "../src/application-service.ts";
import { WORKLIST_ERROR_CODES } from "../src/result-envelope.ts";
import { SessionStore } from "../src/session-store.ts";

function createSessionStore() {
	const entries: unknown[] = [];
	const pi = {
		appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
	} as unknown as ExtensionAPI;
	return { entries, store: new SessionStore(pi) };
}

describe("worklist application service", () => {
	it("rejects stale Project Goal mutations with the current persisted revision", async () => {
		const projectPath = join(
			await mkdtemp(join(tmpdir(), "pi-worklist-application-revision-")),
			".pi",
			"worklist.json",
		);
		const firstClient = new WorklistApplicationService({ projectPath });
		const secondClient = new WorklistApplicationService({ projectPath });

		const added = await firstClient.execute(
			{ scope: "project", action: "add", title: "Revision guarded", expectedRevision: "0" },
			{ source: "cli" },
		);
		expect(added).toMatchObject({
			ok: true,
			meta: { changed: true, semanticNoOp: false, revisions: { project: "1" } },
		});
		if (!added.ok || !added.result.goal) return;

		const updated = await secondClient.execute(
			{
				scope: "project",
				action: "update",
				id: added.result.goal.id,
				title: "Newer title",
				expectedRevision: "1",
			},
			{ source: "dashboard" },
		);
		expect(updated).toMatchObject({ ok: true, meta: { revisions: { project: "2" } } });
		const beforeConflict = await readFile(projectPath, "utf8");

		const conflict = await firstClient.execute(
			{
				scope: "project",
				action: "update",
				id: added.result.goal.id,
				title: "Stale overwrite",
				expectedRevision: "1",
			},
			{ source: "cli" },
		);
		expect(conflict).toEqual({
			ok: false,
			scope: "project",
			action: "update",
			error: {
				code: WORKLIST_ERROR_CODES.CONFLICT,
				message: "Project worklist revision changed from 1 to 2.",
				retryable: true,
				conflict: {
					type: "revision",
					expectedRevision: "1",
					actualRevision: "2",
					resolution: "refresh-and-retry",
				},
			},
			meta: {
				changed: false,
				semanticNoOp: false,
				changedFields: [],
				revisions: { project: "2" },
			},
		});
		expect(await readFile(projectPath, "utf8")).toBe(beforeConflict);
	});

	it("guards one goal's baseline and appends to it without replaying the stored text", async () => {
		const projectPath = join(
			await mkdtemp(join(tmpdir(), "pi-worklist-application-goal-baseline-")),
			".pi",
			"worklist.json",
		);
		const service = new WorklistApplicationService({ projectPath });
		const added = await service.execute(
			{ scope: "project", action: "add", title: "Stage E", description: "First paragraph." },
			{ source: "cli" },
		);
		if (!added.ok || !added.result.goal) return;
		const baseline = added.result.goal;

		// Another writer moves the goal, leaving the first caller's baseline stale.
		const other = await service.execute(
			{
				scope: "project",
				action: "update",
				id: baseline.id,
				appendDescription: "Recorded by someone else.",
			},
			{ source: "tool" },
		);
		expect(other).toMatchObject({
			ok: true,
			result: { goal: { description: "First paragraph.\n\nRecorded by someone else." } },
			meta: { changed: true, revisions: { project: "2" } },
		});
		if (!other.ok || !other.result.goal) return;
		const current = other.result.goal.updatedAt;
		const beforeConflict = await readFile(projectPath, "utf8");

		const conflict = await service.execute(
			{
				scope: "project",
				action: "update",
				id: baseline.id,
				description: "Stale overwrite",
				expectedUpdatedAt: baseline.updatedAt,
			},
			{ source: "cli" },
		);
		expect(conflict).toEqual({
			ok: false,
			scope: "project",
			action: "update",
			error: {
				code: WORKLIST_ERROR_CODES.CONFLICT,
				message: `Project goal ${baseline.id} changed from ${baseline.updatedAt} to ${current}.`,
				retryable: true,
				conflict: {
					type: "goal-updated-at",
					id: baseline.id,
					expectedUpdatedAt: baseline.updatedAt,
					actualUpdatedAt: current,
					resolution: "refresh-and-retry",
				},
			},
			meta: { changed: false, semanticNoOp: false, changedFields: [] },
		});
		expect(await readFile(projectPath, "utf8")).toBe(beforeConflict);

		// The same change lands once it is rebuilt on a fresh read.
		const retried = await service.execute(
			{
				scope: "project",
				action: "update",
				id: baseline.id,
				appendDescription: "Added after re-reading.",
				expectedUpdatedAt: current,
			},
			{ source: "cli" },
		);
		expect(retried).toMatchObject({
			ok: true,
			result: {
				goal: {
					description: "First paragraph.\n\nRecorded by someone else.\n\nAdded after re-reading.",
				},
			},
			meta: { changed: true, revisions: { project: "3" } },
		});
	});

	it("rejects description and baseline options that would lose or ignore stored text", async () => {
		const projectPath = join(
			await mkdtemp(join(tmpdir(), "pi-worklist-application-goal-options-")),
			".pi",
			"worklist.json",
		);
		const service = new WorklistApplicationService({ projectPath });
		const added = await service.execute(
			{ scope: "project", action: "add", title: "Stage E", description: "First paragraph." },
			{ source: "cli" },
		);
		if (!added.ok || !added.result.goal) return;
		const id = added.result.goal.id;
		const beforeRejections = await readFile(projectPath, "utf8");

		const rejections: Array<[Parameters<typeof service.execute>[0], string]> = [
			[
				{ scope: "project", action: "update", id, description: "Replace", appendDescription: "Add" },
				"mutually exclusive",
			],
			[{ scope: "project", action: "update", id, appendDescription: "   " }, "must not be blank"],
			[
				{ scope: "project", action: "add", title: "New", appendDescription: "Add" },
				"only supported for project update",
			],
			[{ scope: "project", action: "update", id, title: "New", expectedUpdatedAt: "yesterday" }, "ISO 8601"],
			[
				{
					scope: "project",
					action: "add",
					id,
					title: "New",
					expectedUpdatedAt: "2026-05-04T09:12:31.004Z",
				},
				"only supported for target-goal mutations",
			],
			[
				{ scope: "project", action: "list", id, expectedUpdatedAt: "2026-05-04T09:12:31.004Z" },
				"only supported for target-goal mutations",
			],
		];
		for (const [operation, message] of rejections) {
			// Each rejection is asserted against the same untouched fixture file.
			// pi-lens-ignore: await-in-loop
			const rejected = await service.execute(operation, { source: "cli" });
			expect(rejected, JSON.stringify(operation)).toMatchObject({
				ok: false,
				error: { code: WORKLIST_ERROR_CODES.VALIDATION_FAILED },
			});
			expect(rejected.ok ? "" : rejected.error.message).toContain(message);
		}
		expect(await readFile(projectPath, "utf8")).toBe(beforeRejections);

		// Session Tasks have no description, so they have no goal baseline either.
		const sessionService = new WorklistApplicationService({ sessionStore: createSessionStore().store });
		const sessionRejection = await sessionService.execute(
			{ scope: "session", action: "update", id: "task-1", expectedUpdatedAt: "2026-05-04T09:12:31.004Z" },
			{ source: "cli" },
		);
		expect(sessionRejection).toMatchObject({
			ok: false,
			error: {
				code: WORKLIST_ERROR_CODES.VALIDATION_FAILED,
				message: "expectedUpdatedAt is only supported for project goals.",
				details: { fields: ["expectedUpdatedAt"], resolution: "remove-expected-updated-at" },
			},
		});
	});

	it("preserves Project Goal files, revisions, and timestamps for semantic no-ops", async () => {
		const projectPath = join(
			await mkdtemp(join(tmpdir(), "pi-worklist-application-no-op-")),
			".pi",
			"worklist.json",
		);
		const service = new WorklistApplicationService({ projectPath });
		const added = await service.execute(
			{ scope: "project", action: "add", title: "Stable", description: "Unchanged" },
			{ source: "cli" },
		);
		if (!added.ok || !added.result.goal) return;
		const id = added.result.goal.id;
		const createdUpdatedAt = added.result.goal.updatedAt;
		const beforeUpdate = await readFile(projectPath, "utf8");

		const sameUpdate = await service.execute(
			{
				scope: "project",
				action: "update",
				id,
				title: "Stable",
				description: "Unchanged",
				expectedRevision: "1",
			},
			{ source: "cli" },
		);
		expect(sameUpdate).toMatchObject({
			ok: true,
			result: { goal: { id, updatedAt: createdUpdatedAt } },
			meta: {
				changed: false,
				semanticNoOp: true,
				changedFields: [],
				revisions: { project: "1" },
			},
		});
		expect(await readFile(projectPath, "utf8")).toBe(beforeUpdate);

		const activated = await service.execute(
			{ scope: "project", action: "set_active", id, expectedRevision: "1" },
			{ source: "dashboard" },
		);
		expect(activated).toMatchObject({ ok: true, meta: { changed: true, revisions: { project: "2" } } });
		const beforeRepeatedActivation = await readFile(projectPath, "utf8");
		const repeatedActivation = await service.execute(
			{ scope: "project", action: "set_active", id, expectedRevision: "2" },
			{ source: "cli" },
		);
		expect(repeatedActivation).toMatchObject({
			ok: true,
			meta: { changed: false, semanticNoOp: true, revisions: { project: "2" } },
		});
		expect(await readFile(projectPath, "utf8")).toBe(beforeRepeatedActivation);

		const completed = await service.execute(
			{ scope: "project", action: "complete", id, confirm: true, expectedRevision: "2" },
			{ source: "command" },
		);
		expect(completed).toMatchObject({ ok: true, meta: { changed: true, revisions: { project: "3" } } });
		const beforeRepeatedCompletion = await readFile(projectPath, "utf8");
		const repeatedCompletion = await service.execute(
			{ scope: "project", action: "complete", id, confirm: true, expectedRevision: "3" },
			{ source: "cli" },
		);
		expect(repeatedCompletion).toMatchObject({
			ok: true,
			meta: { changed: false, semanticNoOp: true, revisions: { project: "3" } },
		});
		expect(await readFile(projectPath, "utf8")).toBe(beforeRepeatedCompletion);
	});

	it("rejects stale Session Task mutations and avoids snapshots for semantic no-ops", async () => {
		const initialRevision = "snapshot-a";
		const { entries, store } = createSessionStore();
		store.reconstruct({
			sessionManager: {
				getBranch: () => [
					{
						type: "custom",
						id: initialRevision,
						customType: "worklist-session-snapshot",
						data: {
							version: 2,
							tasks: [{ id: "task-1", title: "Original", status: "todo" }],
						},
					},
				],
			},
		} as never);
		const service = new WorklistApplicationService({ sessionStore: store });

		const updated = await service.execute(
			{
				scope: "session",
				action: "update",
				id: "task-1",
				title: "Newer title",
				expectedRevision: initialRevision,
			},
			{ source: "dashboard" },
		);
		expect(updated).toMatchObject({
			ok: true,
			meta: { changed: true, semanticNoOp: false, revisions: { session: expect.any(String) } },
		});
		if (!updated.ok) return;
		const currentRevision = updated.meta.revisions?.session;
		expect(currentRevision).not.toBe(initialRevision);
		expect(entries).toHaveLength(1);

		const conflict = await service.execute(
			{
				scope: "session",
				action: "update",
				id: "task-1",
				title: "Stale overwrite",
				expectedRevision: initialRevision,
			},
			{ source: "cli" },
		);
		expect(conflict).toEqual({
			ok: false,
			scope: "session",
			action: "update",
			error: {
				code: WORKLIST_ERROR_CODES.CONFLICT,
				message: `Session task revision changed from ${initialRevision} to ${currentRevision}.`,
				retryable: true,
				conflict: {
					type: "revision",
					expectedRevision: initialRevision,
					actualRevision: currentRevision,
					resolution: "refresh-and-retry",
				},
			},
			meta: {
				changed: false,
				semanticNoOp: false,
				changedFields: [],
				revisions: { session: currentRevision },
			},
		});
		expect(store.getTasks()[0]?.title).toBe("Newer title");
		expect(entries).toHaveLength(1);

		const noOp = await service.execute(
			{
				scope: "session",
				action: "update",
				id: "task-1",
				title: "Newer title",
				expectedRevision: currentRevision,
			},
			{ source: "cli" },
		);
		expect(noOp).toMatchObject({
			ok: true,
			meta: {
				changed: false,
				semanticNoOp: true,
				revisions: { session: currentRevision },
			},
		});
		expect(entries).toHaveLength(1);
	});

	it("reports queued identical Session Task mutations as one change and one semantic no-op", async () => {
		const { entries, store } = createSessionStore();
		store.setTasks([{ id: "task-1", title: "Original", status: "todo" }]);
		const service = new WorklistApplicationService({ sessionStore: store });

		const [first, second] = await Promise.all([
			service.execute(
				{ scope: "session", action: "update", id: "task-1", title: "Shared result" },
				{ source: "dashboard" },
			),
			service.execute(
				{ scope: "session", action: "update", id: "task-1", title: "Shared result" },
				{ source: "cli" },
			),
		]);

		expect(first).toMatchObject({
			ok: true,
			meta: { changed: true, semanticNoOp: false, revisions: { session: expect.any(String) } },
		});
		expect(second).toMatchObject({
			ok: true,
			meta: { changed: false, semanticNoOp: true, revisions: first.meta.revisions },
		});
		expect(entries).toHaveLength(1);
	});

	it("returns the same deterministic success and error envelopes to every interface", async () => {
		const { store } = createSessionStore();
		store.setTasks([{ id: "task-1", title: "Deterministic", status: "doing" }]);
		const service = new WorklistApplicationService({ sessionStore: store });
		const sources = [
			"tool",
			"command",
			"dashboard",
			"cli",
		] as const satisfies readonly WorklistOperationSource[];

		const successes = await Promise.all(
			sources.map((source) => service.execute({ scope: "session", action: "list" }, { source })),
		);
		expect(successes).toEqual(
			sources.map(() => ({
				ok: true,
				scope: "session",
				action: "list",
				result: {
					scope: "session",
					action: "list",
					tasks: [{ id: "task-1", title: "Deterministic", status: "doing" }],
				},
				meta: {
					changed: false,
					semanticNoOp: false,
					changedFields: [],
					revisions: { session: "0" },
				},
			})),
		);

		const failures = await Promise.all(
			sources.map((source) =>
				service.execute({ scope: "session", action: "move", id: "task-1" }, { source }),
			),
		);
		expect(failures).toEqual(
			sources.map(() => ({
				ok: false,
				scope: "session",
				action: "move",
				error: {
					code: WORKLIST_ERROR_CODES.VALIDATION_FAILED,
					message: "Session move requires exactly one of beforeId or afterId.",
					retryable: false,
					details: {
						fields: ["afterId", "beforeId"],
						resolution: "provide-one-placement-anchor",
					},
				},
				meta: { changed: false, semanticNoOp: false, changedFields: [] },
			})),
		);

		await expect(
			service.execute(
				{ scope: "session", action: "move", id: "task-1", beforeId: "task-1" },
				{ source: "dashboard" },
			),
		).resolves.toMatchObject({
			ok: true,
			meta: { changed: false, semanticNoOp: true, changedFields: [] },
		});
	});

	it("returns actionable not-found and approval errors without rejecting", async () => {
		const projectPath = join(
			await mkdtemp(join(tmpdir(), "pi-worklist-application-errors-")),
			".pi",
			"worklist.json",
		);
		const { store } = createSessionStore();
		const service = new WorklistApplicationService({ sessionStore: store, projectPath });

		await expect(
			service.execute({ scope: "session", action: "delete", id: "missing" }, { source: "tool" }),
		).resolves.toEqual({
			ok: false,
			scope: "session",
			action: "delete",
			error: {
				code: WORKLIST_ERROR_CODES.NOT_FOUND,
				message: "Session task missing was not found.",
				retryable: false,
				details: { entity: "session-task", id: "missing", resolution: "refresh-and-select-existing" },
			},
			meta: { changed: false, semanticNoOp: false, changedFields: [] },
		});

		const added = await service.execute(
			{ scope: "project", action: "add", title: "Protected goal" },
			{ source: "command" },
		);
		expect(added.ok).toBe(true);
		if (!added.ok) return;
		const id = added.result.goal?.id;
		expect(id).toBeTruthy();
		await expect(
			service.execute({ scope: "project", action: "complete", id }, { source: "cli" }),
		).resolves.toEqual({
			ok: false,
			scope: "project",
			action: "complete",
			error: {
				code: WORKLIST_ERROR_CODES.APPROVAL_REQUIRED,
				message: "Project complete requires explicit confirmation.",
				retryable: false,
				details: { confirmation: "confirm=true", resolution: "request-explicit-user-confirmation" },
			},
			meta: { changed: false, semanticNoOp: false, changedFields: [] },
		});
	});

	it("classifies malformed persistence deterministically without exposing raw exceptions", async () => {
		const projectPath = join(
			await mkdtemp(join(tmpdir(), "pi-worklist-application-persistence-")),
			".pi",
			"worklist.json",
		);
		await mkdir(join(projectPath, ".."), { recursive: true });
		await writeFile(projectPath, "not json\n");
		const service = new WorklistApplicationService({ projectPath });

		await expect(service.execute({ scope: "project", action: "list" }, { source: "cli" })).resolves.toEqual({
			ok: false,
			scope: "project",
			action: "list",
			error: {
				code: WORKLIST_ERROR_CODES.PERSISTENCE_FAILED,
				message:
					"Malformed project worklist or unsupported schema. Repair .pi/worklist.json before retrying.",
				retryable: false,
				details: { resolution: "repair-project-file" },
			},
			meta: { changed: false, semanticNoOp: false, changedFields: [] },
		});
	});

	it("applies one operation contract for tool, command, dashboard, and CLI callers", async () => {
		const projectPath = join(
			await mkdtemp(join(tmpdir(), "pi-worklist-application-service-")),
			".pi",
			"worklist.json",
		);
		const { entries, store } = createSessionStore();
		const service = new WorklistApplicationService({ sessionStore: store, projectPath });
		const sources = [
			"tool",
			"command",
			"dashboard",
			"cli",
		] as const satisfies readonly WorklistOperationSource[];

		for (const [index, source] of sources.entries()) {
			await service.execute({ scope: "session", action: "add", title: `${source} task` }, { source });
			const id = service.getSessionTasks().at(-1)?.id;
			expect(id).toBeTruthy();
			await service.execute(
				{ scope: "session", action: "set_status", id, status: index % 2 === 0 ? "doing" : "done" },
				{ source },
			);
		}

		expect(service.getSessionTasks().map(({ title, status }) => ({ title, status }))).toEqual([
			{ title: "tool task", status: "doing" },
			{ title: "command task", status: "done" },
			{ title: "dashboard task", status: "doing" },
			{ title: "cli task", status: "done" },
		]);
		expect(entries).toHaveLength(8);

		const added = await service.execute(
			{ scope: "project", action: "add", title: "Shared goal", description: "One rule set" },
			{ source: "cli" },
		);
		const goalId = unwrapWorklistApplicationResult(added).goal?.id;
		expect(goalId).toBeTruthy();
		await service.execute(
			{ scope: "project", action: "update", id: goalId, title: "Updated through dashboard" },
			{ source: "dashboard" },
		);
		const listed = unwrapWorklistApplicationResult(
			await service.execute({ scope: "project", action: "list" }, { source: "tool" }),
		);
		expect(listed.goals).toEqual([
			expect.objectContaining({
				id: goalId,
				title: "Updated through dashboard",
				description: "One rule set",
			}),
		]);
	});

	it("enforces shared validation and explicit confirmation regardless of caller", async () => {
		const projectPath = join(
			await mkdtemp(join(tmpdir(), "pi-worklist-application-validation-")),
			".pi",
			"worklist.json",
		);
		const { store } = createSessionStore();
		const service = new WorklistApplicationService({ sessionStore: store, projectPath });
		const added = await service.execute(
			{ scope: "project", action: "add", title: "Protected goal" },
			{ source: "command" },
		);
		const id = unwrapWorklistApplicationResult(added).goal?.id;

		for (const source of ["tool", "command", "dashboard", "cli"] as const) {
			await expect(
				service.execute(
					{ scope: "session", action: "add", title: "Invalid", beforeId: "a", afterId: "b" },
					{ source },
				),
			).resolves.toMatchObject({
				ok: false,
				error: { code: WORKLIST_ERROR_CODES.VALIDATION_FAILED, retryable: false },
			});
			await expect(
				service.execute({ scope: "project", action: "complete", id }, { source }),
			).resolves.toMatchObject({
				ok: false,
				error: { code: WORKLIST_ERROR_CODES.APPROVAL_REQUIRED, retryable: false },
			});
		}

		expect((await service.getProjectGoals()).find((goal) => goal.id === id)?.status).toBe("open");
		await expect(
			service.execute({ scope: "project", action: "complete", id, confirm: true }, { source: "dashboard" }),
		).resolves.toMatchObject({ ok: true, result: { goal: { id, status: "done" } } });
	});
});
