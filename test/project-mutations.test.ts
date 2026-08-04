import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	activateProjectGoal,
	addProjectGoal,
	deleteProjectGoal,
	migrateProjectGoalIds,
	ProjectGoalActivationBlockedError,
	ProjectGoalNotFoundError,
	readProjectGoals,
	transitionProjectGoal,
	updateProjectGoal,
} from "../src/project-mutations.ts";
import { readProjectWorklist } from "../src/project-store.ts";

async function tempPath() {
	const root = await mkdtemp(join(tmpdir(), "pi-worklist-mutations-"));
	return join(root, ".pi", "worklist.json");
}

describe("project mutation service", () => {
	it("returns the post-mutation goal list computed under the lock", async () => {
		const path = await tempPath();
		const first = await addProjectGoal(path, "First");
		const second = await addProjectGoal(path, "Second", "With description");
		expect(first.goals.map((goal) => goal.title)).toEqual(["First"]);
		expect(first.revision).toBe("1");
		expect(second.goals.map((goal) => goal.title)).toEqual(["First", "Second"]);
		expect(second.revision).toBe("2");
		expect(second.goal.description).toBe("With description");
	});

	it("appends a paragraph without replaying the stored description", async () => {
		const path = await tempPath();
		const { goal } = await addProjectGoal(path, "Stage E", "First paragraph.");

		const noted = await updateProjectGoal(path, goal.id, {
			appendDescription: "Stale as of 2026-08-03.",
		});
		expect(noted.goal.description).toBe("First paragraph.\n\nStale as of 2026-08-03.");
		expect(noted.goal.title).toBe("Stage E");

		const twice = await updateProjectGoal(path, goal.id, { appendDescription: "Soft-depends on goal-x." });
		expect(twice.goal.description).toBe(
			"First paragraph.\n\nStale as of 2026-08-03.\n\nSoft-depends on goal-x.",
		);

		const bare = await addProjectGoal(path, "No description yet");
		const first = await updateProjectGoal(path, bare.goal.id, { appendDescription: "The only note." });
		expect(first.goal.description).toBe("The only note.");
	});

	it("throws typed errors for missing goals", async () => {
		const path = await tempPath();
		await expect(updateProjectGoal(path, "missing", { title: "x" })).rejects.toThrow(
			ProjectGoalNotFoundError,
		);
		await expect(activateProjectGoal(path, "missing")).rejects.toThrow(ProjectGoalNotFoundError);
		await expect(transitionProjectGoal(path, "missing", "done")).rejects.toThrow(ProjectGoalNotFoundError);
		await expect(deleteProjectGoal(path, "missing")).rejects.toThrow(ProjectGoalNotFoundError);
		expect((await readProjectGoals(path)).revision).toBe("0");
	});

	it("derives goal IDs from titles and freezes them against later renames", async () => {
		const path = await tempPath();
		const first = await addProjectGoal(path, "Support goal templates");
		const second = await addProjectGoal(path, "Support goal templates!");
		expect(first.goal.id).toBe("support-goal-templates");
		expect(second.goal.id).toBe("support-goal-templates-2");

		const renamed = await updateProjectGoal(path, first.goal.id, { title: "Something else entirely" });
		expect(renamed.goal.id).toBe("support-goal-templates");

		// The freed-looking slug is still taken, because the renamed goal keeps it.
		const third = await addProjectGoal(path, "Support goal templates");
		expect(third.goal.id).toBe("support-goal-templates-3");
	});

	it("mints distinct slug IDs for concurrent adds of the same title", async () => {
		const path = await tempPath();
		const additions = await Promise.all([
			addProjectGoal(path, "Support goal templates"),
			addProjectGoal(path, "Support goal templates"),
		]);

		expect(additions.map(({ goal }) => goal.id).sort()).toEqual([
			"support-goal-templates",
			"support-goal-templates-2",
		]);
		expect((await readProjectGoals(path)).goals.map((goal) => goal.id).sort()).toEqual([
			"support-goal-templates",
			"support-goal-templates-2",
		]);
	});

	it("keeps legacy-shaped title slugs frozen after a rename", async () => {
		const path = await tempPath();
		const added = await addProjectGoal(path, "Goal abc deadbeef");
		expect(added.goal.id).toBe("goal-abc-deadbeef-2");

		const renamed = await updateProjectGoal(path, added.goal.id, { title: "Something unrelated" });
		expect(renamed.goal.id).toBe("goal-abc-deadbeef-2");

		const migrated = await migrateProjectGoalIds(path);
		expect(migrated.changed).toBe(false);
		expect(migrated.migrations).toEqual([]);
		expect(migrated.goals[0].id).toBe("goal-abc-deadbeef-2");
	});

	it("retires every ID of a deleted goal without making it resolvable", async () => {
		const path = await tempPath();
		await mkdir(dirname(path), { recursive: true });
		await writeFile(
			path,
			`${JSON.stringify({
				version: 1,
				revision: 0,
				goals: [
					{
						id: "older-goal",
						title: "Older goal",
						status: "open",
						createdAt: "2026-08-03T00:00:00.000Z",
						updatedAt: "2026-08-03T00:00:00.000Z",
					},
					{
						id: "goal-mse1rzxb-8213cc2a",
						title: "Support goal templates",
						status: "open",
						createdAt: "2026-08-04T00:00:00.000Z",
						updatedAt: "2026-08-04T00:00:00.000Z",
					},
				],
			})}\n`,
			"utf8",
		);

		await deleteProjectGoal(path, "older-goal");
		const migrated = await migrateProjectGoalIds(path);
		await deleteProjectGoal(path, migrated.goals[0].id);
		const afterDelete = await readProjectWorklist(path);
		expect(afterDelete.data.retiredIds).toEqual([
			"older-goal",
			"support-goal-templates",
			"goal-mse1rzxb-8213cc2a",
		]);
		expect(afterDelete.data.goals).toEqual([]);

		const replacement = await addProjectGoal(path, "Support goal templates");
		expect(replacement.goal.id).toBe("support-goal-templates-2");
		expect((await readProjectWorklist(path)).data.retiredIds).toEqual([
			"older-goal",
			"support-goal-templates",
			"goal-mse1rzxb-8213cc2a",
		]);
	});

	it("migrates generated IDs once, records them, and leaves readable IDs alone", async () => {
		const path = await tempPath();
		await mkdir(dirname(path), { recursive: true });
		await writeFile(
			path,
			`${JSON.stringify({
				version: 1,
				revision: 3,
				goals: [
					{
						id: "goal-mse1rzxb-8213cc2a",
						title: "Support goal templates",
						status: "open",
						createdAt: "2026-08-04T02:37:07.871Z",
						updatedAt: "2026-08-04T03:01:42.534Z",
					},
					{
						id: "future-start-goal",
						title: "Already readable",
						status: "archived",
						createdAt: "2026-07-13T00:00:00.000Z",
						updatedAt: "2026-07-13T00:00:00.000Z",
					},
				],
			})}\n`,
			"utf8",
		);

		const migrated = await migrateProjectGoalIds(path);
		expect(migrated.changed).toBe(true);
		expect(migrated.revision).toBe("4");
		expect(migrated.migrations).toEqual([
			{
				from: "goal-mse1rzxb-8213cc2a",
				to: "support-goal-templates",
				title: "Support goal templates",
			},
		]);
		expect(migrated.goals.map((goal) => goal.id)).toEqual(["support-goal-templates", "future-start-goal"]);
		expect(migrated.goals[0].previousIds).toEqual(["goal-mse1rzxb-8213cc2a"]);
		expect(migrated.goals[0].updatedAt > "2026-08-04T03:01:42.534Z").toBe(true);
		// An untouched goal keeps its baseline, so a migration cannot invalidate a
		// caller's read of a goal it did not rename.
		expect(migrated.goals[1].updatedAt).toBe("2026-07-13T00:00:00.000Z");

		const rerun = await migrateProjectGoalIds(path);
		expect(rerun.changed).toBe(false);
		expect(rerun.migrations).toEqual([]);
		expect(rerun.revision).toBe("4");

		// A migrated ID is as taken as any other, so a later goal cannot shadow it.
		const added = await addProjectGoal(path, "Support goal templates");
		expect(added.goal.id).toBe("support-goal-templates-2");
	});

	it("blocks activating done or archived goals with a typed error", async () => {
		const path = await tempPath();
		const { goal } = await addProjectGoal(path, "Finished");
		await transitionProjectGoal(path, goal.id, "done");
		await expect(activateProjectGoal(path, goal.id)).rejects.toThrow(ProjectGoalActivationBlockedError);
		expect((await readProjectGoals(path)).revision).toBe("2");
		await transitionProjectGoal(path, goal.id, "archived");
		await expect(activateProjectGoal(path, goal.id)).rejects.toThrow(ProjectGoalActivationBlockedError);
	});
});
