import type { ExtensionContext, ToolExecutionMode } from "@earendil-works/pi-coding-agent";
import {
	unwrapWorklistApplicationResult,
	WorklistApplicationService,
	type WorklistOperation,
	type WorklistOperationSource,
} from "./application-service.ts";
import { formatProjectGoals, formatSessionTasks } from "./format.ts";
import { getWorklistPath, resolveGitRoot } from "./git.ts";
import type { SessionStore } from "./session-store.ts";
import type { WorklistOperationResult, WorklistToolDetails } from "./types.ts";

export interface ToolDeps {
	applicationService?: WorklistApplicationService;
	sessionStore?: SessionStore;
	projectPath?: string | null;
}

export function getProjectPath(cwd: string): string | null {
	const result = resolveGitRoot(cwd);
	if (!result.isGit || !result.root) return null;
	return getWorklistPath(result.root);
}

function getApplicationService(deps: ToolDeps): WorklistApplicationService {
	if (deps.applicationService) return deps.applicationService;
	return new WorklistApplicationService({
		sessionStore: deps.sessionStore,
		projectPath: deps.projectPath,
	});
}

function formatResult(operation: WorklistOperation, result: WorklistOperationResult): string {
	if (operation.scope === "session") {
		switch (operation.action) {
			case "list":
				return formatSessionTasks(result.tasks ?? []);
			case "add":
				return `Added session task ${result.task?.id}: ${result.task?.title}`;
			case "move":
				return `Moved session task ${result.task?.id}`;
			case "update":
				return `Updated session task ${result.task?.id}`;
			case "set_status":
				return `Set session task ${result.task?.id} to ${result.task?.status}`;
			case "delete":
				return `Deleted session task ${operation.id}`;
			default:
				throw new Error(`Unknown session action: ${operation.action}`);
		}
	}
	if (operation.scope === "project") {
		switch (operation.action) {
			case "list":
				return formatProjectGoals(result.goals ?? []);
			case "add":
				return `Added project goal ${result.goal?.id}: ${result.goal?.title}`;
			case "move":
				return `Moved project goal ${result.goal?.id}`;
			case "update":
				return `Updated project goal ${result.goal?.id}`;
			case "set_status":
			case "set_active":
				return `Activated project goal ${result.goal?.id}`;
			case "complete":
			case "reopen":
			case "archive":
				return `Project goal ${result.goal?.id} is now ${result.goal?.status}`;
			case "delete":
				return `Deleted project goal ${operation.id}`;
			default:
				throw new Error(`Unknown project action: ${operation.action}`);
		}
	}
	throw new Error(`Unknown ${operation.scope} action: ${operation.action}`);
}

export async function executeWorklist(
	params: WorklistOperation,
	_ctx: ExtensionContext,
	deps: ToolDeps,
	source: WorklistOperationSource = "tool",
): Promise<{ content: string; details: WorklistToolDetails }> {
	const envelope = await getApplicationService(deps).execute(params, { source });
	const result = unwrapWorklistApplicationResult(envelope);
	return {
		content: formatResult(params, result),
		details: result,
	};
}

export const WORKLIST_EXECUTION_MODE = "sequential" as ToolExecutionMode;
