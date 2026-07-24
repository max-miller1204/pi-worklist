import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	activateProjectGoal,
	addProjectGoal,
	deleteProjectGoal,
	ProjectGoalActivationBlockedError,
	ProjectGoalNotFoundError,
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
		expect(second.goals.map((goal) => goal.title)).toEqual(["First", "Second"]);
		expect(second.goal.description).toBe("With description");
	});

	it("throws typed errors for missing goals", async () => {
		const path = await tempPath();
		await expect(updateProjectGoal(path, "missing", { title: "x" })).rejects.toThrow(
			ProjectGoalNotFoundError,
		);
		await expect(activateProjectGoal(path, "missing")).rejects.toThrow(ProjectGoalNotFoundError);
		await expect(transitionProjectGoal(path, "missing", "done")).rejects.toThrow(ProjectGoalNotFoundError);
		await expect(deleteProjectGoal(path, "missing")).rejects.toThrow(ProjectGoalNotFoundError);
	});

	it("blocks activating done or archived goals with a typed error", async () => {
		const path = await tempPath();
		const { goal } = await addProjectGoal(path, "Finished");
		await transitionProjectGoal(path, goal.id, "done");
		await expect(activateProjectGoal(path, goal.id)).rejects.toThrow(ProjectGoalActivationBlockedError);
		await transitionProjectGoal(path, goal.id, "archived");
		await expect(activateProjectGoal(path, goal.id)).rejects.toThrow(ProjectGoalActivationBlockedError);
	});
});
