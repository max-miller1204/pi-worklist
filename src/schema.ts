import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type TUnsafe } from "typebox";

const ScopeSchema: TUnsafe<"session" | "project"> = StringEnum(["session", "project"] as const, {
	description: "Whether to operate on session tasks or project goals.",
});

const ActionSchema: TUnsafe<
	"list" | "add" | "update" | "set_status" | "delete" | "complete" | "reopen" | "archive" | "set_active"
> = StringEnum(
	["list", "add", "update", "set_status", "delete", "complete", "reopen", "archive", "set_active"] as const,
	{
		description:
			"Action to perform. 'complete', 'reopen', 'archive', and 'delete' on project goals require confirm=true.",
	},
);

export const SessionTaskStatusSchema: TUnsafe<"todo" | "doing" | "done"> = StringEnum([
	"todo",
	"doing",
	"done",
] as const);

export const ProjectGoalStatusSchema: TUnsafe<"open" | "active" | "done" | "archived"> = StringEnum([
	"open",
	"active",
	"done",
	"archived",
] as const);

const StatusSchema: TUnsafe<"todo" | "doing" | "done" | "open" | "active" | "archived"> = StringEnum(
	["todo", "doing", "done", "open", "active", "archived"] as const,
	{
		description:
			"Target status for set_status. Project set_status only accepts active; lifecycle actions use complete, reopen, and archive.",
	},
);

export const WorklistParamsSchema = Type.Object({
	scope: ScopeSchema,
	action: ActionSchema,
	id: Type.Optional(
		Type.String({
			description: "Task or goal ID (for update, set_status, delete, complete, reopen, archive, set_active).",
		}),
	),
	title: Type.Optional(Type.String({ description: "Title for add/update." })),
	description: Type.Optional(Type.String({ description: "Description for project goal add/update." })),
	status: Type.Optional(StatusSchema),
	goalId: Type.Optional(
		Type.String({
			description: "Associate a session task with a project goal ID.",
		}),
	),
	confirm: Type.Optional(
		Type.Boolean({
			description:
				"Required boolean for destructive project-goal actions: complete, reopen, archive, delete. Set to true ONLY when the user explicitly requested the action.",
		}),
	),
});
