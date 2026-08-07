import { describe, expect, it } from "vitest";
import {
	dependentGoals,
	findDependencyCycle,
	findDependencyCycleFromRoots,
	formatDependencyCycle,
	isGoalBlocked,
	resolveDependencies,
	unsatisfiedDependencies,
} from "../src/dependencies.ts";
import type { ProjectGoal } from "../src/types.ts";

function goal(overrides: Partial<ProjectGoal> & Pick<ProjectGoal, "id">): ProjectGoal {
	return {
		title: overrides.id,
		status: "open",
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		...overrides,
	};
}

describe("project goal dependency graph", () => {
	it("satisfies an edge once its target is done or archived", () => {
		const goals = [
			goal({ id: "done", status: "done" }),
			goal({ id: "archived", status: "archived" }),
			goal({ id: "open" }),
			goal({ id: "active", status: "active" }),
			goal({ id: "waiting", dependsOn: ["done", "archived", "open", "active"] }),
		];
		const waiting = goals[4];

		expect(resolveDependencies(goals, waiting).map((entry) => entry.satisfied)).toEqual([
			true,
			true,
			false,
			false,
		]);
		expect(unsatisfiedDependencies(goals, waiting).map((entry) => entry.id)).toEqual(["open", "active"]);
		expect(isGoalBlocked(goals, waiting)).toBe(true);
	});

	it("reads an edge naming no goal as unsatisfied rather than met", () => {
		// Deleting a goal strips the edges naming it, so a dangling edge means the
		// file was hand-edited. Treating it as satisfied would release a dependent
		// on work nothing ever finished.
		const goals = [goal({ id: "waiting", dependsOn: ["vanished"] })];
		expect(resolveDependencies(goals, goals[0])).toEqual([{ id: "vanished", satisfied: false }]);
		expect(isGoalBlocked(goals, goals[0])).toBe(true);
	});

	it("never calls a settled goal blocked", () => {
		const blockers = [goal({ id: "blocker" })];
		for (const status of ["done", "archived"] as const) {
			const settled = goal({ id: "settled", status, dependsOn: ["blocker"] });
			expect(isGoalBlocked([...blockers, settled], settled), status).toBe(false);
		}
		const live = goal({ id: "live", status: "active", dependsOn: ["blocker"] });
		expect(isGoalBlocked([...blockers, live], live)).toBe(true);
	});

	it("derives the reverse direction from the stored one, in file order", () => {
		const goals = [
			goal({ id: "late", dependsOn: ["foundation"] }),
			goal({ id: "foundation" }),
			goal({ id: "early", dependsOn: ["foundation"] }),
		];
		expect(dependentGoals(goals, goals[1]).map((entry) => entry.id)).toEqual(["late", "early"]);
		expect(dependentGoals(goals, goals[0])).toEqual([]);
	});

	it("resolves an edge written against a former ID", () => {
		const goals = [
			goal({ id: "renamed", previousIds: ["goal-mse1rzxb-8213cc2a"], status: "done" }),
			goal({ id: "waiting", dependsOn: ["goal-mse1rzxb-8213cc2a"] }),
		];
		expect(resolveDependencies(goals, goals[1])[0]).toMatchObject({ satisfied: true });
		expect(dependentGoals(goals, goals[0]).map((entry) => entry.id)).toEqual(["waiting"]);
	});

	it("finds a cycle reachable from one goal and names each goal on it once", () => {
		const goals = [
			goal({ id: "a", dependsOn: ["b"] }),
			goal({ id: "b", dependsOn: ["c"] }),
			goal({ id: "c", dependsOn: ["a"] }),
		];
		expect(findDependencyCycle(goals, "a")).toEqual(["a", "b", "c"]);
		expect(findDependencyCycle(goals, "b")).toEqual(["b", "c", "a"]);
		expect(formatDependencyCycle(["a", "b", "c"])).toBe("a -> b -> c -> a");
	});

	it("treats a goal depending on itself as the degenerate cycle", () => {
		const goals = [goal({ id: "solo", dependsOn: ["solo"] })];
		expect(findDependencyCycle(goals, "solo")).toEqual(["solo"]);
		expect(formatDependencyCycle(["solo"])).toBe("solo -> solo");
	});

	it("reports no cycle for a graph that merely re-converges", () => {
		// A diamond visits `base` twice without ever re-entering the active path, so
		// a walk that mistook a repeat visit for a loop would refuse a valid graph.
		const goals = [
			goal({ id: "base" }),
			goal({ id: "left", dependsOn: ["base"] }),
			goal({ id: "right", dependsOn: ["base"] }),
			goal({ id: "top", dependsOn: ["left", "right"] }),
		];
		expect(findDependencyCycle(goals, "top")).toBeUndefined();
	});

	it("reports nothing for a goal that does not exist", () => {
		expect(findDependencyCycle([goal({ id: "only" })], "missing")).toBeUndefined();
	});

	it("searches every changed goal, including one whose cycle an earlier root cannot reach", () => {
		// The roots share `base`, which the first walk clears, so a search that
		// carried that verdict too far would miss the loop the last root closes.
		const goals = [
			goal({ id: "base" }),
			goal({ id: "left", dependsOn: ["base"] }),
			goal({ id: "right", dependsOn: ["base"] }),
			goal({ id: "trailer", dependsOn: ["base", "loop"] }),
			goal({ id: "loop", dependsOn: ["trailer"] }),
		];
		expect(findDependencyCycleFromRoots(goals, ["left", "right"])).toBeUndefined();
		expect(findDependencyCycleFromRoots(goals, ["left", "right", "trailer"])).toEqual(["trailer", "loop"]);
		expect(findDependencyCycleFromRoots(goals, [])).toBeUndefined();
		expect(findDependencyCycleFromRoots(goals, ["missing"])).toBeUndefined();
	});
});
