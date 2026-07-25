import { EventEmitter } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { WorklistApplicationService } from "../src/application-service.ts";
import {
	CURRENT_WORKLIST_PROTOCOL_VERSION,
	DEFAULT_WORKLIST_REQUEST_TIMEOUT_MS,
	MAX_WORKLIST_REQUEST_TIMEOUT_MS,
	WORKLIST_PROTOCOL_ID,
	type WorklistRequest,
} from "../src/integration-contract.ts";
import { requestWorklistOperation, resolveWorklistRequestTimeout } from "../src/protocol-consumer.ts";
import { registerWorklistProtocolProvider, type WorklistProtocolEventBus } from "../src/protocol-provider.ts";
import { SessionStore } from "../src/session-store.ts";

function createEventBus(): WorklistProtocolEventBus {
	const emitter = new EventEmitter();
	return {
		emit: (channel, data) => {
			emitter.emit(channel, data);
		},
		on: (channel, handler) => {
			emitter.on(channel, handler);
			return () => emitter.off(channel, handler);
		},
	};
}

function negotiateRequest(requestId: string): WorklistRequest<"capabilities.negotiate"> {
	return {
		protocol: WORKLIST_PROTOCOL_ID,
		protocolVersion: CURRENT_WORKLIST_PROTOCOL_VERSION,
		requestId,
		operation: "capabilities.negotiate",
		actor: { type: "extension", id: "pi-orchestrator" },
		payload: { supportedProtocolVersions: [CURRENT_WORKLIST_PROTOCOL_VERSION] },
	};
}

async function createProviderFixture() {
	const projectPath = join(
		await mkdtemp(join(tmpdir(), "pi-worklist-protocol-fallback-")),
		".pi",
		"worklist.json",
	);
	const pi = { appendEntry: () => undefined } as unknown as ExtensionAPI;
	const sessionStore = new SessionStore(pi);
	const applicationService = new WorklistApplicationService({ projectPath, sessionStore });
	const events = createEventBus();
	const provider = { id: "pi-worklist" as const, version: "0.4.0", instanceId: "fallback-provider" };
	registerWorklistProtocolProvider({ events, applicationService, provider });
	return { applicationService, events };
}

describe("consumer fallback behavior", () => {
	it("synthesizes a deterministic UNAVAILABLE result when no provider exists", async () => {
		const events = createEventBus();
		const request = negotiateRequest("absent-negotiation");
		const result = await requestWorklistOperation(events, request, { timeoutMs: 25 });
		expect(result).toEqual({
			protocol: WORKLIST_PROTOCOL_ID,
			protocolVersion: CURRENT_WORKLIST_PROTOCOL_VERSION,
			requestId: "absent-negotiation",
			operation: "capabilities.negotiate",
			actor: { type: "extension", id: "pi-orchestrator" },
			correlation: undefined,
			ok: false,
			error: {
				code: "UNAVAILABLE",
				message: "No pi-worklist provider answered the negotiation within the timeout.",
				retryable: true,
				retryAfterMs: 25,
				details: { timeoutMs: 25 },
			},
			meta: { changed: false, semanticNoOp: false, changedFields: [] },
		});
		expect(result.provider).toBeUndefined();
	});

	it("synthesizes TIMEOUT for unanswered post-negotiation operations and ignores late results", async () => {
		const events = createEventBus();
		// A provider that hears requests but never answers.
		events.on("pi-worklist:request", () => undefined);
		const result = await requestWorklistOperation(
			events,
			{
				protocol: WORKLIST_PROTOCOL_ID,
				protocolVersion: CURRENT_WORKLIST_PROTOCOL_VERSION,
				requestId: "silent-list",
				operation: "session-tasks.list",
				actor: { type: "extension", id: "pi-orchestrator" },
				targetProviderInstanceId: "someone",
				payload: {},
			},
			{ timeoutMs: 25 },
		);
		expect(result).toMatchObject({
			ok: false,
			error: { code: "TIMEOUT", retryable: true, details: { timeoutMs: 25 } },
		});
	});

	it("clamps configured timeouts to the protocol bounds", () => {
		expect(resolveWorklistRequestTimeout(undefined)).toBe(DEFAULT_WORKLIST_REQUEST_TIMEOUT_MS);
		expect(resolveWorklistRequestTimeout(0)).toBe(1);
		expect(resolveWorklistRequestTimeout(-100)).toBe(1);
		expect(resolveWorklistRequestTimeout(5_000)).toBe(5_000);
		expect(resolveWorklistRequestTimeout(MAX_WORKLIST_REQUEST_TIMEOUT_MS + 1)).toBe(
			MAX_WORKLIST_REQUEST_TIMEOUT_MS,
		);
		expect(resolveWorklistRequestTimeout(Number.POSITIVE_INFINITY)).toBe(DEFAULT_WORKLIST_REQUEST_TIMEOUT_MS);
	});

	it("resolves real provider responses and correlates by request ID on the shared channel", async () => {
		const { events } = await createProviderFixture();
		// Unrelated traffic on the shared result channel must be ignored.
		events.emit("pi-worklist:result", { noise: true });

		const result = await requestWorklistOperation(events, negotiateRequest("live-negotiation"), {
			timeoutMs: 1_000,
		});
		expect(result).toMatchObject({
			ok: true,
			provider: { id: "pi-worklist", instanceId: "fallback-provider" },
			result: { selectedProtocolVersion: CURRENT_WORKLIST_PROTOCOL_VERSION },
		});
	});

	it("surfaces goal and idempotency conflicts as typed protocol results", async () => {
		const { applicationService, events } = await createProviderFixture();
		const added = await applicationService.execute(
			{ scope: "project", action: "add", title: "Conflict goal" },
			{ source: "command" },
		);
		if (!added.ok || !added.result.goal) throw new Error("Expected goal");
		const goal = added.result.goal;
		await applicationService.execute(
			{ scope: "project", action: "update", id: goal.id, title: "Edited conflict goal" },
			{ source: "dashboard" },
		);

		const reconcilePayload = {
			idempotencyKey: "run-16:plan-1",
			goalId: goal.id,
			// Captured before the user's edit: must conflict, not overwrite.
			expectedGoalUpdatedAt: goal.updatedAt,
			owner: "pi-orchestrator" as const,
			tasks: [],
		};
		const staleGoal = await requestWorklistOperation(
			events,
			{
				protocol: WORKLIST_PROTOCOL_ID,
				protocolVersion: CURRENT_WORKLIST_PROTOCOL_VERSION,
				requestId: "conflict-goal",
				operation: "session-tasks.reconcile",
				actor: { type: "extension", id: "pi-orchestrator" },
				payload: reconcilePayload,
			},
			{ timeoutMs: 1_000 },
		);
		expect(staleGoal).toMatchObject({
			ok: false,
			provider: { id: "pi-worklist" },
			error: {
				code: "CONFLICT",
				retryable: true,
				conflict: {
					type: "revision",
					expectedRevision: goal.updatedAt,
					conflictingIds: [goal.id],
					resolution: "refresh-and-retry",
				},
			},
		});

		const current = (await applicationService.getProjectGoals()).find(
			(candidate) => candidate.id === goal.id,
		);
		if (!current) throw new Error("Expected current goal");
		const committed = await requestWorklistOperation(
			events,
			{
				protocol: WORKLIST_PROTOCOL_ID,
				protocolVersion: CURRENT_WORKLIST_PROTOCOL_VERSION,
				requestId: "conflict-commit",
				operation: "session-tasks.reconcile",
				actor: { type: "extension", id: "pi-orchestrator" },
				payload: { ...reconcilePayload, expectedGoalUpdatedAt: current.updatedAt },
			},
			{ timeoutMs: 1_000 },
		);
		expect(committed).toMatchObject({ ok: true });

		const keyReuse = await requestWorklistOperation(
			events,
			{
				protocol: WORKLIST_PROTOCOL_ID,
				protocolVersion: CURRENT_WORKLIST_PROTOCOL_VERSION,
				requestId: "conflict-key",
				operation: "session-tasks.reconcile",
				actor: { type: "extension", id: "pi-orchestrator" },
				payload: {
					...reconcilePayload,
					expectedGoalUpdatedAt: current.updatedAt,
					goalId: goal.id,
					tasks: [
						{
							external: { system: "pi-orchestrator", kind: "workflow-step", id: "step-x" },
							title: "Different input",
							status: "todo",
							producer: { id: "pi-orchestrator", version: "0.9.0" },
							planRevision: 1,
							approvedPlanRevision: 1,
							execution: {
								state: "planned",
								updatedAt: "2026-07-25T12:00:00.000Z",
								runId: "run-16",
							},
						},
					],
				},
			},
			{ timeoutMs: 1_000 },
		);
		expect(keyReuse).toMatchObject({
			ok: false,
			error: {
				code: "CONFLICT",
				retryable: false,
				conflict: { type: "idempotency-key", resolution: "use-new-idempotency-key" },
			},
		});
	});
});
