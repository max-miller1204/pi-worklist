import type { ProjectGoal, SessionTask } from "./types.ts";

export function compactDescription(description: string): string {
	return description.replace(/\s+/g, " ").trim();
}

export function formatSessionTasks(tasks: SessionTask[]): string {
	if (tasks.length === 0) return "No session tasks.";
	return tasks
		.map((t) => {
			const marker = t.status === "done" ? "[x]" : t.status === "doing" ? "[~]" : "[ ]";
			const goal = t.goalId ? ` (goal:${t.goalId})` : "";
			return `${marker} ${t.id}: ${t.title}${goal}`;
		})
		.join("\n");
}

export function formatProjectGoals(goals: ProjectGoal[]): string {
	if (goals.length === 0) return "No project goals.";
	// Canonical file order, unsorted: the array is the roadmap's own order.
	return goals
		.map(
			(g) =>
				`[${g.status}] ${g.id}: ${g.title}${g.description ? ` - ${compactDescription(g.description)}` : ""}`,
		)
		.join("\n");
}
