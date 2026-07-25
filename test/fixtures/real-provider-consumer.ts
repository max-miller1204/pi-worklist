import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	CURRENT_WORKLIST_PROTOCOL_VERSION,
	isWorklistResult,
	WORKLIST_CHANGE_EVENT,
	WORKLIST_PROTOCOL_ID,
	WORKLIST_REQUEST_EVENT,
	WORKLIST_RESULT_EVENT,
	type WorklistChangeEvent,
	type WorklistOperation,
	type WorklistResultEnvelope,
} from "pi-worklist/integration-contract";

/**
 * Exercises the real pi-worklist protocol provider end to end inside a live Pi
 * process: negotiate, read the selected goal, reconcile, replay, list, and
 * update execution state, then persist every observed envelope for assertions.
 */
export default function realProviderConsumer(pi: ExtensionAPI): void {
	const pending = new Map<string, (result: WorklistResultEnvelope) => void>();
	const changes: WorklistChangeEvent[] = [];
	let requestCounter = 0;

	pi.events.on(WORKLIST_RESULT_EVENT, (value: unknown) => {
		if (!isWorklistResult(value)) return;
		const resolve = pending.get(value.requestId);
		if (!resolve) return;
		pending.delete(value.requestId);
		resolve(value);
	});
	pi.events.on(WORKLIST_CHANGE_EVENT, (value: unknown) => {
		changes.push(value as WorklistChangeEvent);
	});

	function request(
		operation: WorklistOperation,
		payload: Record<string, unknown>,
		targetProviderInstanceId?: string,
	): Promise<WorklistResultEnvelope> {
		requestCounter += 1;
		const requestId = `real-e2e-${requestCounter}-${operation}`;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				pending.delete(requestId);
				reject(new Error(`Timed out waiting for ${operation}`));
			}, 10_000);
			pending.set(requestId, (result) => {
				clearTimeout(timer);
				resolve(result);
			});
			pi.events.emit(WORKLIST_REQUEST_EVENT, {
				protocol: WORKLIST_PROTOCOL_ID,
				protocolVersion: CURRENT_WORKLIST_PROTOCOL_VERSION,
				requestId,
				operation,
				actor: { type: "extension", id: "pi-orchestrator", version: "e2e" },
				correlation: { runId: "run-real-e2e" },
				...(targetProviderInstanceId !== undefined ? { targetProviderInstanceId } : {}),
				payload,
			});
		});
	}

	pi.registerCommand("probe-real-worklist", {
		description: "Drive the real pi-worklist protocol provider end to end",
		handler: async (args) => {
			const goalId = args.trim();
			const negotiate = await request("capabilities.negotiate", {
				supportedProtocolVersions: [CURRENT_WORKLIST_PROTOCOL_VERSION, 99],
			});
			const providerInstanceId = negotiate.ok
				? (negotiate.result as { provider: { instanceId: string } }).provider.instanceId
				: "negotiation-failed";

			const detail = await request(
				"project-goals.get",
				{ selector: { type: "id", id: goalId } },
				providerInstanceId,
			);
			const goalUpdatedAt = detail.ok
				? (detail.result as { goal: { updatedAt: string } }).goal.updatedAt
				: "detail-failed";

			const reconcilePayload = {
				idempotencyKey: "run-real-e2e:plan-1",
				goalId,
				expectedGoalUpdatedAt: goalUpdatedAt,
				owner: "pi-orchestrator",
				tasks: [
					{
						external: { system: "pi-orchestrator", kind: "workflow-step", id: "step-e2e" },
						title: "Real E2E projected step",
						status: "doing",
						producer: { id: "pi-orchestrator", version: "e2e" },
						planRevision: 1,
						approvedPlanRevision: 1,
						execution: {
							state: "running",
							updatedAt: "2026-07-25T12:00:00.000Z",
							runId: "run-real-e2e",
						},
					},
				],
			};
			const reconcile = await request("session-tasks.reconcile", reconcilePayload, providerInstanceId);
			const replay = await request("session-tasks.reconcile", reconcilePayload, providerInstanceId);
			const list = await request("session-tasks.list", { goalId }, providerInstanceId);
			const updateExecution = await request(
				"session-tasks.update-execution",
				{
					idempotencyKey: "run-real-e2e:execution-1",
					owner: "pi-orchestrator",
					updates: [
						{
							external: { system: "pi-orchestrator", kind: "workflow-step", id: "step-e2e" },
							execution: {
								state: "succeeded",
								updatedAt: "2026-07-25T12:05:00.000Z",
								runId: "run-real-e2e",
								summary: "Validated end to end",
							},
						},
					],
				},
				providerInstanceId,
			);

			pi.appendEntry("real-worklist-e2e", {
				negotiate,
				detail,
				reconcile,
				replay,
				list,
				updateExecution,
				changes,
			});
		},
	});
}
