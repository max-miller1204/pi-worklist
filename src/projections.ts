import type {
	ProjectGoalDetailProjection,
	SessionTaskSummaryProjection,
	WorklistOperationPayloads,
	WorklistProjectionPage,
} from "./integration-contract.ts";
import { WORKLIST_PROVIDER_LIMITS } from "./integration-contract.ts";
import type { ProjectGoal, SessionTaskStatus, StoredSessionTask } from "./types.ts";

/**
 * Pi-free bounded read projections.
 *
 * List projections stay compact so an automation consumer cannot pull unbounded
 * text through the protocol; full detail is an explicit per-entity read that still
 * enforces byte limits and reports what it truncated.
 */

const SESSION_TASK_STATUSES: readonly SessionTaskStatus[] = ["todo", "doing", "done"];

export interface TruncatedText {
	value: string;
	truncated: boolean;
}

/** Truncates on code-point boundaries so the result stays valid UTF-8 within maxBytes. */
export function truncateUtf8(value: string, maxBytes: number): TruncatedText {
	if (Buffer.byteLength(value, "utf8") <= maxBytes) return { value, truncated: false };
	let bytes = 0;
	let result = "";
	for (const char of value) {
		const size = Buffer.byteLength(char, "utf8");
		if (bytes + size > maxBytes) break;
		bytes += size;
		result += char;
	}
	return { value: result, truncated: true };
}

export class ListCursorError extends Error {
	readonly name = "ListCursorError";
	readonly cursor: string;

	constructor(cursor: string, reason: "malformed" | "stale") {
		super(
			reason === "malformed"
				? "List cursor is malformed. Restart the list from the beginning."
				: "List cursor no longer matches the current tasks. Restart the list from the beginning.",
		);
		this.cursor = cursor;
	}
}

interface ListCursorPayload {
	afterTaskId: string;
}

export function encodeListCursor(afterTaskId: string): string {
	const payload: ListCursorPayload = { afterTaskId };
	return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeListCursor(cursor: string): ListCursorPayload {
	let parsed: unknown;
	try {
		parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
	} catch {
		throw new ListCursorError(cursor, "malformed");
	}
	if (
		typeof parsed !== "object" ||
		parsed === null ||
		typeof (parsed as ListCursorPayload).afterTaskId !== "string" ||
		!(parsed as ListCursorPayload).afterTaskId
	) {
		throw new ListCursorError(cursor, "malformed");
	}
	return parsed as ListCursorPayload;
}

export function toSessionTaskSummaryProjection(task: StoredSessionTask): SessionTaskSummaryProjection {
	const title = truncateUtf8(task.title, WORKLIST_PROVIDER_LIMITS.maxTitleBytes);
	return {
		id: task.id,
		title: title.value,
		status: task.status,
		...(task.goalId !== undefined ? { goalId: task.goalId } : {}),
		...(task.managed !== undefined ? { managed: task.managed } : {}),
		...(title.truncated ? { projection: { truncatedFields: ["title"] } } : {}),
	};
}

export interface SessionTaskListProjection {
	tasks: SessionTaskSummaryProjection[];
	page: WorklistProjectionPage;
}

export function planSessionTaskListProjection(
	storedTasks: StoredSessionTask[],
	payload: Pick<WorklistOperationPayloads["session-tasks.list"], "goalId" | "statuses" | "limit" | "cursor">,
): SessionTaskListProjection {
	const statuses =
		payload.statuses === undefined
			? undefined
			: new Set(payload.statuses.filter((status) => SESSION_TASK_STATUSES.includes(status)));
	const filtered = storedTasks.filter((task) => {
		if (payload.goalId !== undefined && task.goalId !== payload.goalId) return false;
		if (statuses !== undefined && !statuses.has(task.status)) return false;
		return true;
	});

	const requestedLimit = payload.limit ?? WORKLIST_PROVIDER_LIMITS.defaultListLimit;
	const limit = Math.min(requestedLimit, WORKLIST_PROVIDER_LIMITS.maxListLimit);

	let start = 0;
	if (payload.cursor !== undefined) {
		const { afterTaskId } = decodeListCursor(payload.cursor);
		const anchorIndex = filtered.findIndex((task) => task.id === afterTaskId);
		if (anchorIndex === -1) throw new ListCursorError(payload.cursor, "stale");
		start = anchorIndex + 1;
	}

	const slice = filtered.slice(start, start + limit);
	const truncated = start + slice.length < filtered.length;
	const lastReturned = slice.at(-1);
	return {
		tasks: slice.map(toSessionTaskSummaryProjection),
		page: {
			limit,
			returned: slice.length,
			truncated,
			...(truncated && lastReturned !== undefined ? { nextCursor: encodeListCursor(lastReturned.id) } : {}),
		},
	};
}

export function toProjectGoalDetailProjection(goal: ProjectGoal): ProjectGoalDetailProjection {
	const title = truncateUtf8(goal.title, WORKLIST_PROVIDER_LIMITS.maxTitleBytes);
	const description =
		goal.description === undefined
			? undefined
			: truncateUtf8(goal.description, WORKLIST_PROVIDER_LIMITS.maxDescriptionBytes);
	const truncatedFields = [
		...(description?.truncated ? ["description"] : []),
		...(title.truncated ? ["title"] : []),
	];
	return {
		id: goal.id,
		title: title.value,
		status: goal.status,
		createdAt: goal.createdAt,
		updatedAt: goal.updatedAt,
		...(description !== undefined ? { description: description.value } : {}),
		projection: { truncatedFields },
	};
}
