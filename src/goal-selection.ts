import type { GoalIdMigration, ProjectGoal, ProjectWorklist } from "./types.ts";

/**
 * How a Project Goal is named, found, and referred to.
 *
 * An ID is derived from the goal's title when the goal is created and frozen
 * from then on, so it reads as words in a shell, a PR description, or an
 * evidence file while a later rename leaves every existing reference valid.
 *
 * Everything that turns a caller's text into one goal lives here, and every
 * interface resolves through these functions, so the CLI, the model tool, the
 * dashboard, and the terminal board cannot disagree about which goal was meant.
 */

/** Longest slug derived from a title, before any collision suffix. */
export const GOAL_ID_MAX_LENGTH = 40;

/**
 * Shortest whole-word cut worth preferring over a hard cut at the cap.
 *
 * Without a floor, a title whose first word is longer than the cap would be
 * truncated back to whatever short word preceded it.
 */
const MIN_WORD_BOUNDARY_LENGTH = Math.floor(GOAL_ID_MAX_LENGTH / 2);

/** The slug for a title with no characters a slug can keep, such as "???". */
const FALLBACK_GOAL_SLUG = "goal";

/** IDs minted by the pre-slug generator: `goal-<base36 time>-<8 hex>`. */
const LEGACY_GOAL_ID_PATTERN = /^goal-[0-9a-z]+-[0-9a-f]{8}$/;

/** Candidates named when a prefix is ambiguous, so an error stays readable. */
export const MAX_REPORTED_GOAL_CANDIDATES = 10;

/**
 * Function words that read as a dangling fragment at the end of a truncated slug.
 *
 * Only the tail of a slug the cap already cut is trimmed, never a slug short
 * enough to survive whole: a title really called "What to do" should keep its
 * own words, while `...batch import of a JSON plan document` should not leave
 * `of-a` hanging off the end.
 */
const TRAILING_SLUG_STOPWORDS = new Set([
	"a",
	"an",
	"and",
	"as",
	"at",
	"but",
	"by",
	"for",
	"from",
	"in",
	"into",
	"is",
	"of",
	"on",
	"or",
	"that",
	"the",
	"to",
	"with",
]);

/** Drops dangling function words, always keeping at least one segment. */
function dropTrailingStopwords(slug: string): string {
	const segments = slug.split("-");
	while (segments.length > 1 && TRAILING_SLUG_STOPWORDS.has(segments[segments.length - 1])) {
		segments.pop();
	}
	return segments.join("-");
}

/**
 * The slug a title yields, before collision handling.
 *
 * Accented and non-Latin characters decompose to ASCII where they can and are
 * dropped where they cannot, so the result is always shell-safe and typeable.
 *
 * A slug the cap had to cut also loses any function words left dangling at the
 * end, because the cut lands wherever the character budget runs out rather than
 * where the phrase does.
 */
export function slugifyGoalTitle(title: string): string {
	const ascii = title.normalize("NFKD").replace(/\p{Diacritic}/gu, "");
	const slug = ascii
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	if (slug === "") return FALLBACK_GOAL_SLUG;
	if (slug.length <= GOAL_ID_MAX_LENGTH) return slug;
	const capped = slug.slice(0, GOAL_ID_MAX_LENGTH);
	const boundary = capped.lastIndexOf("-");
	const truncated = boundary >= MIN_WORD_BOUNDARY_LENGTH ? capped.slice(0, boundary) : capped;
	return dropTrailingStopwords(truncated.replace(/-+$/, ""));
}

/** Every live or retired ID reserved across the whole worklist. */
export function takenGoalIds(worklist: ProjectWorklist): Set<string> {
	const taken = new Set(worklist.retiredIds ?? []);
	for (const goal of worklist.goals) {
		taken.add(goal.id);
		for (const previous of goal.previousIds ?? []) taken.add(previous);
	}
	return taken;
}

/**
 * A unique ID for a new goal with `title`.
 *
 * `taken` must include former and retired IDs as well as current ones, so a
 * freshly minted ID can never shadow a live or stale historical reference.
 * Legacy-generator-shaped candidates are reserved for migration provenance,
 * keeping newly minted slugs disjoint from IDs migration may rewrite.
 */
export function generateGoalId(title: string, taken: ReadonlySet<string>): string {
	const base = slugifyGoalTitle(title);
	if (!taken.has(base) && !isLegacyGeneratedGoalId(base)) return base;
	// One more candidate than there are taken IDs, so a free suffix must exist.
	const limit = taken.size + 2;
	for (let suffix = 2; suffix <= limit; suffix++) {
		const candidate = `${base}-${suffix}`;
		if (!taken.has(candidate) && !isLegacyGeneratedGoalId(candidate)) return candidate;
	}
	throw new Error(`Cannot derive a unique goal ID from ${JSON.stringify(title)}`);
}

export type GoalSelectorResolution =
	| { kind: "found"; goal: ProjectGoal }
	| { kind: "ambiguous"; candidates: ProjectGoal[] }
	| { kind: "not-found" };

/** A selector that named no goal, or named more than one. */
export type UnresolvedGoalSelector = Exclude<GoalSelectorResolution, { kind: "found" }>;

/**
 * The one goal a caller's selector names.
 *
 * Resolution is ordered most specific first: a current ID, then an ID the goal
 * answered to before a migration renamed it, then a unique prefix of a current
 * ID. An exact match therefore always wins over a prefix, so no goal can be
 * made unreachable by another goal's longer ID.
 *
 * Former IDs are matched only in full. Prefix-matching them would let a name
 * nothing carries any more compete with a name something does.
 */
export function resolveGoalSelector(
	goals: readonly ProjectGoal[],
	selector: string,
	retiredIds: readonly string[] = [],
): GoalSelectorResolution {
	const needle = selector.trim();
	if (needle === "") return { kind: "not-found" };
	if (retiredIds.includes(needle)) return { kind: "not-found" };
	const stages = [
		() => goals.filter((goal) => goal.id === needle),
		() => goals.filter((goal) => goal.previousIds?.includes(needle)),
		() => goals.filter((goal) => goal.id.toLowerCase().startsWith(needle.toLowerCase())),
	];
	for (const stage of stages) {
		const matches = stage();
		if (matches.length === 1) return { kind: "found", goal: matches[0] };
		if (matches.length > 1) return { kind: "ambiguous", candidates: matches };
	}
	return { kind: "not-found" };
}

/**
 * The goal an ID refers to, without prefix matching.
 *
 * Stored references such as `SessionTask.goalId` name one goal exactly, so they
 * resolve through current and former IDs but never through a prefix, which
 * could otherwise start matching a different goal as the worklist grows.
 */
export function findGoalByStoredId(
	goals: readonly ProjectGoal[],
	id: string,
	retiredIds: readonly string[] = [],
): ProjectGoal | undefined {
	if (retiredIds.includes(id)) return undefined;
	return goals.find((goal) => goal.id === id || goal.previousIds?.includes(id));
}

/** Case-insensitive search across a goal's title and description. */
export function matchesGoalQuery(goal: ProjectGoal, query: string): boolean {
	if (query === "") return true;
	const needle = query.toLowerCase();
	if (goal.title.toLowerCase().includes(needle)) return true;
	return (goal.description ?? "").toLowerCase().includes(needle);
}

/** Whether an ID belongs to the namespace the pre-slug generator exclusively minted. */
export function isLegacyGeneratedGoalId(id: string): boolean {
	return LEGACY_GOAL_ID_PATTERN.test(id);
}

/**
 * The ID rewrites a migration would apply, in worklist order.
 *
 * Only randomly generated IDs are rewritten. New slug minting reserves the
 * legacy generator's shape, so shape is stable provenance even after a title
 * changes and migration never needs to re-derive a frozen ID from that title.
 *
 * Old IDs stay reserved because the migration records them as former IDs, and
 * retired IDs participate in collision handling without becoming resolvable.
 */
export function planGoalIdMigration(worklist: ProjectWorklist): GoalIdMigration[] {
	const taken = takenGoalIds(worklist);
	const migrations: GoalIdMigration[] = [];
	for (const goal of worklist.goals) {
		if (!isLegacyGeneratedGoalId(goal.id)) continue;
		const to = generateGoalId(goal.title, taken);
		taken.add(to);
		migrations.push({ from: goal.id, to, title: goal.title });
	}
	return migrations;
}
