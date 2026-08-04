import { describe, expect, it } from "vitest";
import {
	findGoalByStoredId,
	GOAL_ID_MAX_LENGTH,
	generateGoalId,
	isLegacyGeneratedGoalId,
	matchesGoalQuery,
	planGoalIdMigration,
	resolveGoalSelector,
	slugifyGoalTitle,
	takenGoalIds,
} from "../src/goal-selection.ts";
import type { ProjectGoal, ProjectWorklist } from "../src/types.ts";

function goal(id: string, overrides: Partial<ProjectGoal> = {}): ProjectGoal {
	return {
		id,
		title: id,
		status: "open",
		createdAt: "2026-08-04T00:00:00.000Z",
		updatedAt: "2026-08-04T00:00:00.000Z",
		...overrides,
	};
}

function worklist(goals: ProjectGoal[], retiredIds?: string[]): ProjectWorklist {
	return { version: 1, goals, ...(retiredIds ? { retiredIds } : {}) };
}

describe("goal ID derivation", () => {
	it("derives a readable, shell-safe slug from a title", () => {
		expect(slugifyGoalTitle("Support goal templates")).toBe("support-goal-templates");
		expect(slugifyGoalTitle("slug-ids: human-readable goal IDs")).toBe("slug-ids-human-readable-goal-ids");
		expect(slugifyGoalTitle("  Trim/punctuate --- me!  ")).toBe("trim-punctuate-me");
		expect(slugifyGoalTitle("Café déjà vu")).toBe("cafe-deja-vu");
	});

	it("caps the slug without leaving a half word or an empty ID", () => {
		const long = slugifyGoalTitle("Add optimistic concurrency and append primitives to project update");
		expect(long.length).toBeLessThanOrEqual(GOAL_ID_MAX_LENGTH);
		expect(long).toBe("add-optimistic-concurrency-and-append");
		expect(long.endsWith("-")).toBe(false);

		// A single word longer than the cap has no boundary worth cutting back to,
		// so it is cut at the cap rather than truncated to the stub before it.
		const unbroken = slugifyGoalTitle(`a ${"z".repeat(60)}`);
		expect(unbroken.length).toBe(GOAL_ID_MAX_LENGTH);
		expect(unbroken.startsWith("a-zzz")).toBe(true);

		// A title with nothing a slug can keep still yields a usable ID.
		expect(slugifyGoalTitle("???")).toBe("goal");
		expect(slugifyGoalTitle("")).toBe("goal");
	});

	it("drops function words left dangling by the cap", () => {
		// The cut lands where the character budget runs out, not where the phrase
		// does, so without this the tail reads as a fragment.
		expect(slugifyGoalTitle("Add pi-orchestrator compatibility and cross-extension E2E tests")).toBe(
			"add-pi-orchestrator-compatibility",
		);
		expect(slugifyGoalTitle("apply-plan: atomic batch import of a JSON plan document")).toBe(
			"apply-plan-atomic-batch-import",
		);
		expect(slugifyGoalTitle("archive-browsing: archived goals in the Pi dashboard")).toBe(
			"archive-browsing-archived-goals",
		);
		expect(slugifyGoalTitle("Support cross process locking through all interfaces")).toBe(
			"support-cross-process-locking",
		);
		expect(slugifyGoalTitle("Support cross process locking during all interfaces")).toBe(
			"support-cross-process-locking",
		);
		expect(slugifyGoalTitle("Ensure project mutation guarantees are documented")).toBe(
			"ensure-project-mutation-guarantees",
		);
	});

	it("keeps function words a short title actually ends on", () => {
		// Nothing was cut, so every word is the author's own and stays.
		expect(slugifyGoalTitle("What to do")).toBe("what-to-do");
		expect(slugifyGoalTitle("Decide what to ship and")).toBe("decide-what-to-ship-and");
	});

	it("keeps negations and exclusions left at the truncation boundary", () => {
		expect(slugifyGoalTitle("Ensure project mutation locks are not circumvented")).toBe(
			"ensure-project-mutation-locks-are-not",
		);
		expect(slugifyGoalTitle("Ensure mutation locks permit neither invalid state")).toBe(
			"ensure-mutation-locks-permit-neither",
		);
		expect(slugifyGoalTitle("Run atomic project migrations without downtime")).toBe(
			"run-atomic-project-migrations-without",
		);
		expect(slugifyGoalTitle("Process all worklist goals except archived entries")).toBe(
			"process-all-worklist-goals-except",
		);
		expect(slugifyGoalTitle("Block project activation unless reopened manually")).toBe(
			"block-project-activation-unless",
		);
	});

	it("never trims a slug away entirely", () => {
		const allStopwords = slugifyGoalTitle(`of the and to ${"in and of the to ".repeat(6)}`);
		expect(allStopwords.length).toBeGreaterThan(0);
		expect(allStopwords.split("-").length).toBeGreaterThanOrEqual(1);
	});

	it("suffixes colliding slugs and never reuses a former ID", () => {
		const taken = new Set(["support-goal-templates", "support-goal-templates-2"]);
		expect(generateGoalId("Support goal templates", taken)).toBe("support-goal-templates-3");
		expect(generateGoalId("Support goal templates", new Set())).toBe("support-goal-templates");

		const goals = [goal("current", { previousIds: ["goal-mryb1h5b-f5473d74"] })];
		expect(takenGoalIds(worklist(goals, ["deleted-goal"]))).toEqual(
			new Set(["deleted-goal", "current", "goal-mryb1h5b-f5473d74"]),
		);

		const legacyShapedSlug = generateGoalId("Goal abc deadbeef", new Set());
		expect(legacyShapedSlug).toBe("goal-abc-deadbeef-2");
		expect(isLegacyGeneratedGoalId(legacyShapedSlug)).toBe(false);
	});

	it("recognizes only randomly generated IDs as migratable", () => {
		expect(isLegacyGeneratedGoalId("goal-mse1rzxb-8213cc2a")).toBe(true);
		expect(isLegacyGeneratedGoalId("goal-mryb1h5b-f5473d74")).toBe(true);
		expect(isLegacyGeneratedGoalId("future-start-goal")).toBe(false);
		expect(isLegacyGeneratedGoalId("support-goal-templates")).toBe(false);
		expect(isLegacyGeneratedGoalId("goal-templates-2")).toBe(false);
	});
});

describe("goal selector resolution", () => {
	const goals = [
		goal("ship-the-cli"),
		goal("ship-the-cli-2"),
		goal("support-templates", { previousIds: ["goal-ms6gwxrg-56c1bde6"] }),
	];

	it("resolves an exact ID, a former ID, and a unique prefix", () => {
		expect(resolveGoalSelector(goals, "support-templates")).toMatchObject({
			kind: "found",
			goal: { id: "support-templates" },
		});
		expect(resolveGoalSelector(goals, "goal-ms6gwxrg-56c1bde6")).toMatchObject({
			kind: "found",
			goal: { id: "support-templates" },
		});
		expect(resolveGoalSelector(goals, "supp")).toMatchObject({
			kind: "found",
			goal: { id: "support-templates" },
		});
		expect(resolveGoalSelector(goals, "SUPP")).toMatchObject({
			kind: "found",
			goal: { id: "support-templates" },
		});
	});

	it("prefers an exact ID over a longer ID it is a prefix of", () => {
		// Without this precedence, `ship-the-cli` would be permanently unreachable
		// as soon as `ship-the-cli-2` existed.
		expect(resolveGoalSelector(goals, "ship-the-cli")).toMatchObject({
			kind: "found",
			goal: { id: "ship-the-cli" },
		});
	});

	it("refuses an ambiguous prefix with the goals it matched", () => {
		const resolution = resolveGoalSelector(goals, "ship");
		expect(resolution.kind).toBe("ambiguous");
		expect(resolution.kind === "ambiguous" && resolution.candidates.map((entry) => entry.id)).toEqual([
			"ship-the-cli",
			"ship-the-cli-2",
		]);
	});

	it("reports a selector that names nothing, including a blank one", () => {
		expect(resolveGoalSelector(goals, "nothing")).toEqual({ kind: "not-found" });
		expect(resolveGoalSelector(goals, "  ")).toEqual({ kind: "not-found" });
	});

	it("does not reinterpret a retired exact ID as a live goal prefix", () => {
		expect(
			resolveGoalSelector([goal("support-goal-templates-2")], "support-goal-templates", [
				"support-goal-templates",
			]),
		).toEqual({ kind: "not-found" });
		expect(
			findGoalByStoredId(
				[goal("support-goal-templates", { previousIds: ["legacy-support"] })],
				"support-goal-templates",
				["support-goal-templates"],
			),
		).toBeUndefined();
	});

	it("resolves a stored reference by full ID only, never by prefix", () => {
		expect(findGoalByStoredId(goals, "goal-ms6gwxrg-56c1bde6")?.id).toBe("support-templates");
		expect(findGoalByStoredId(goals, "supp")).toBeUndefined();
	});
});

describe("goal text search", () => {
	it("matches titles and descriptions case-insensitively", () => {
		const templates = goal("support-templates", {
			title: "Support goal templates",
			description: "Let teams share reusable outlines",
		});
		expect(matchesGoalQuery(templates, "TEMPLATES")).toBe(true);
		expect(matchesGoalQuery(templates, "reusable")).toBe(true);
		expect(matchesGoalQuery(templates, "")).toBe(true);
		expect(matchesGoalQuery(templates, "dependency graph")).toBe(false);
		expect(matchesGoalQuery(goal("bare", { title: "Bare goal" }), "outlines")).toBe(false);
	});
});

describe("goal ID migration planning", () => {
	it("renames only generated IDs and keeps old names reserved", () => {
		const plan = planGoalIdMigration(
			worklist([
				goal("goal-mse1rzxb-8213cc2a", { title: "Support goal templates" }),
				goal("goal-mryb1h5b-f5473d74", { title: "Support goal templates" }),
				goal("future-start-goal", { title: "Already readable" }),
			]),
		);
		expect(plan).toEqual([
			{
				from: "goal-mse1rzxb-8213cc2a",
				to: "support-goal-templates",
				title: "Support goal templates",
			},
			{
				from: "goal-mryb1h5b-f5473d74",
				to: "support-goal-templates-2",
				title: "Support goal templates",
			},
		]);
	});

	it("never mints an ID that some goal still answers to", () => {
		const plan = planGoalIdMigration(
			worklist(
				[
					goal("support-goal-templates", { title: "Something else entirely" }),
					goal("goal-mse1rzxb-8213cc2a", { title: "Support goal templates" }),
					goal("settled", { title: "Settled", previousIds: ["support-goal-templates-2"] }),
				],
				["support-goal-templates-3"],
			),
		);
		expect(plan.map((migration) => migration.to)).toEqual(["support-goal-templates-4"]);
	});

	it("keeps a renamed slug outside the legacy migration namespace", () => {
		const id = generateGoalId("Goal abc deadbeef", new Set());
		expect(planGoalIdMigration(worklist([goal(id, { title: "Something unrelated" })]))).toEqual([]);
	});

	it("plans nothing for a worklist whose IDs are already readable", () => {
		expect(
			planGoalIdMigration(worklist([goal("support-goal-templates", { title: "Support goal templates" })])),
		).toEqual([]);
	});
});
