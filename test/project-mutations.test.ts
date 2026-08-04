import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	activateProjectGoal,
	addProjectGoal,
	deleteProjectGoal,
	ProjectGoalActivationBlockedError,
	ProjectGoalNotFoundError,
	readProjectGoals,
	transitionProjectGoal,
	updateProjectGoal,
} from "../src/project-mutations.ts";

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
