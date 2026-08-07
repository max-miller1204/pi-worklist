import { findGoalByStoredId } from "./goal-selection.ts";
import type { ProjectGoal } from "./types.ts";

/**
 * The Project Goal dependency graph: what an edge means and what it implies.
 *
 * Only the forward direction is stored, as `dependsOn` on the goal that waits.
 * Everything else here is derived from that one array, so a reverse edge, a
 * blocked reading, and a cycle report can never disagree with the file.
 *
 * These functions are pure and Pi-free, so the CLI, the terminal board, the
 * model tool, and the mutation service all read the same graph the same way.
 */

/**
 * Whether a dependency has been met.
 *
 * Done and archived both count: an archived goal is one someone decided not to
 * do, which settles the question the edge was waiting on just as finishing it
 * would. Anything still open or active has not landed yet.
 */
export function isDependencySatisfied(goal: ProjectGoal): boolean {
	return goal.status === "done" || goal.status === "archived";
}

/** One stored edge, resolved against the goals it was read alongside. */
export interface GoalDependency {
	/** The ID exactly as stored on the depending goal. */
	id: string;
	/** The goal it names, absent when the edge resolves to nothing. */
	goal?: ProjectGoal;
	satisfied: boolean;
}

/**
 * A goal's dependencies in stored order, each resolved to the goal it names.
 *
 * An edge that resolves to nothing is reported unsatisfied rather than ignored.
 * Deleting a goal strips the edges naming it inside the same mutation, so a
 * dangling edge means the file was edited by hand, and reading it as satisfied
 * would quietly release a goal that nothing ever finished.
 */
export function resolveDependencies(
	goals: readonly ProjectGoal[],
	goal: ProjectGoal,
	retiredIds: readonly string[] = [],
): GoalDependency[] {
	return (goal.dependsOn ?? []).map((id) => {
		const target = findGoalByStoredId(goals, id, retiredIds);
		return {
			id,
			...(target ? { goal: target } : {}),
			satisfied: target !== undefined && isDependencySatisfied(target),
		};
	});
}

/** The dependencies still standing between a goal and the work starting. */
export function unsatisfiedDependencies(
	goals: readonly ProjectGoal[],
	goal: ProjectGoal,
	retiredIds: readonly string[] = [],
): GoalDependency[] {
	return resolveDependencies(goals, goal, retiredIds).filter((entry) => !entry.satisfied);
}

/**
 * Whether a goal is waiting on work that has not landed.
 *
 * Blocked is a derived display state rather than a status: it is recomputed from
 * the graph on every read, so nothing can be left marked blocked after the goal
 * that held it up was finished. A settled goal is never blocked, because a done
 * or archived goal is not waiting to start.
 */
export function isGoalBlocked(
	goals: readonly ProjectGoal[],
	goal: ProjectGoal,
	retiredIds: readonly string[] = [],
): boolean {
	if (isDependencySatisfied(goal)) return false;
	return unsatisfiedDependencies(goals, goal, retiredIds).length > 0;
}

/**
 * The goals this one blocks, in canonical file order.
 *
 * Derived by scanning forward edges rather than stored, so adding an edge writes
 * one field on one goal and both directions stay true by construction.
 */
export function dependentGoals(
	goals: readonly ProjectGoal[],
	goal: ProjectGoal,
	retiredIds: readonly string[] = [],
): ProjectGoal[] {
	return goals.filter((candidate) =>
		(candidate.dependsOn ?? []).some((id) => findGoalByStoredId(goals, id, retiredIds)?.id === goal.id),
	);
}

/**
 * A dependency cycle reachable from one goal, as the goals on it in order.
 *
 * The walk starts at the goal a mutation changed, because every other goal's
 * edges were already acyclic before it ran, so a cycle can only exist if the new
 * edges closed one. A goal that depends on itself is the degenerate case and
 * comes back as a single-entry path.
 *
 * The result names each goal on the cycle once, starting with the first one the
 * walk re-entered, so `["a", "b"]` reads as `a -> b -> a`.
 */
export function findDependencyCycle(
	goals: readonly ProjectGoal[],
	startId: string,
	retiredIds: readonly string[] = [],
): string[] | undefined {
	return findDependencyCycleFromRoots(goals, [startId], retiredIds);
}

/**
 * The first dependency cycle reachable from any of the goals a mutation changed.
 *
 * A batch mutation adds many goals at once and every one of them can close a
 * loop, so all of them are roots. One walk covers them all: a goal the walk has
 * already left behind reaches no cycle in this graph, and that stays true
 * whichever root arrived at it, so the roots share a single settled set instead
 * of re-walking the graph once per root under the write lock.
 */
export function findDependencyCycleFromRoots(
	goals: readonly ProjectGoal[],
	startIds: readonly string[],
	retiredIds: readonly string[] = [],
): string[] | undefined {
	const path: string[] = [];
	const onPath = new Set<string>();
	const settled = new Set<string>();

	const walk = (goal: ProjectGoal): string[] | undefined => {
		path.push(goal.id);
		onPath.add(goal.id);
		for (const id of goal.dependsOn ?? []) {
			const next = findGoalByStoredId(goals, id, retiredIds);
			if (!next || settled.has(next.id)) continue;
			if (onPath.has(next.id)) return path.slice(path.indexOf(next.id));
			const cycle = walk(next);
			if (cycle) return cycle;
		}
		path.pop();
		onPath.delete(goal.id);
		settled.add(goal.id);
		return undefined;
	};

	for (const startId of startIds) {
		const start = findGoalByStoredId(goals, startId, retiredIds);
		if (!start || settled.has(start.id)) continue;
		const cycle = walk(start);
		if (cycle) return cycle;
	}
	return undefined;
}

/** Render a cycle as the chain it is, so an error names the whole loop. */
export function formatDependencyCycle(cycle: readonly string[]): string {
	return [...cycle, cycle[0]].join(" -> ");
}
