import { EventEmitter } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { WorklistApplicationService } from "../src/application-service.ts";
import {
	CURRENT_WORKLIST_PROTOCOL_VERSION,
	isWorklistResult,
	type ManagedSessionTaskInput,
	WORKLIST_PROTOCOL_ID,
	WORKLIST_REQUEST_EVENT,
	WORKLIST_RESULT_EVENT,
	type WorklistResultEnvelope,
} from "../src/integration-contract.ts";
import {
	advertisedWorklistCapabilities,
	registerWorklistProtocolProvider,
	type WorklistProtocolEventBus,
} from "../src/protocol-provider.ts";
import { SessionStore } from "../src/session-store.ts";

function createEventBus(): WorklistProtocolEventBus & { results: WorklistResultEnvelope[] } {
	const emitter = new EventEmitter();
	const results: WorklistResultEnvelope[] = [];
	emitter.on(WORKLIST_RESULT_EVENT, (value: unknown) => {
		if (isWorklistResult(value)) results.push(value);
	});
	return {
		results,
		emit: (channel, data) => {
			emitter.emit(channel, data);
		},
		on: (channel, handler) => {
			emitter.on(channel, handler);
			return () => emitter.off(channel, handler);
		},
	};
}

async function createProvider() {
	const projectPath = join(
		await mkdtemp(join(tmpdir(), "pi-worklist-protocol-provider-")),
		".pi",
		"worklist.json",
	);
	const pi = { appendEntry: () => undefined } as unknown as ExtensionAPI;
	const sessionStore = new SessionStore(pi);
	const applicationService = new WorklistApplicationService({ projectPath, sessionStore });
	const events = createEventBus();
	const provider = { id: "pi-worklist" as const, version: "0.4.0", instanceId: "provider-under-test" };
	const handle = registerWorklistProtocolProvider({ events, applicationService, provider });
	return { applicationService, events, handle, provider };
}

function waitForResult(
	events: { results: WorklistResultEnvelope[] },
	requestId: string,
): Promise<WorklistResultEnvelope> {
	return new Promise((resolve, reject) => {
		const startedAt = Date.now();
		const poll = () => {
			const result = events.results.find((candidate) => candidate.requestId === requestId);
			if (result) return resolve(result);
			if (Date.now() - startedAt > 2_000) return reject(new Error(`No result for ${requestId}`));
			setTimeout(poll, 5);
		};
		poll();
	});
}

function baseRequest(operation: string, payload: Record<string, unknown>, requestId: string) {
	return {
		protocol: WORKLIST_PROTOCOL_ID,
		protocolVersion: CURRENT_WORKLIST_PROTOCOL_VERSION,
		requestId,
		operation,
		actor: { type: "extension", id: "pi-orchestrator", version: "0.9.0" },
		correlation: { runId: "run-15" },
		payload,
	};
}

function managedInput(externalId: string, title: string): ManagedSessionTaskInput {
	return {
		external: { system: "pi-orchestrator", kind: "workflow-step", id: externalId },
		title,
		status: "todo",
		producer: { id: "pi-orchestrator", version: "0.9.0" },
		planRevision: 1,
		approvedPlanRevision: 1,
		execution: {
			state: "planned",
			updatedAt: "2026-07-25T12:00:00.000Z",
			runId: "run-15",
		},
	};
}

describe("worklist protocol provider", () => {
	it("negotiates capabilities and reports provider identity and limits", async () => {
		const { events, provider } = await createProvider();
		events.emit(
			WORKLIST_REQUEST_EVENT,
			baseRequest("capabilities.negotiate", { supportedProtocolVersions: [99, 1] }, "negotiate-1"),
		);
		const result = await waitForResult(events, "negotiate-1");
		expect(result).toMatchObject({
			ok: true,
			protocolVersion: 1,
			operation: "capabilities.negotiate",
			actor: { type: "extension", id: "pi-orchestrator" },
			correlation: { runId: "run-15" },
			provider,
			result: {
				provider,
				supportedProtocolVersions: [1],
				selectedProtocolVersion: 1,
				capabilities: advertisedWorklistCapabilities(),
			},
			meta: { changed: false, semanticNoOp: false, changedFields: [] },
		});
		const capabilityIds = advertisedWorklistCapabilities().map((capability) => capability.id);
		expect(capabilityIds).toEqual([...capabilityIds].sort());
		expect(capabilityIds).not.toContain("project-goals.create-approved-batch");
	});

	it("serves reads and mutations through the shared application service", async () => {
		const { applicationService, events } = await createProvider();
		const added = await applicationService.execute(
			{ scope: "project", action: "add", title: "Protocol goal" },
			{ source: "command" },
		);
		if (!added.ok || !added.result.goal) throw new Error("Expected goal");
		const goal = added.result.goal;
		await applicationService.execute(
			{ scope: "project", action: "set_active", id: goal.id },
			{ source: "command" },
		);

		events.emit(
			WORKLIST_REQUEST_EVENT,
			baseRequest("project-goals.get", { selector: { type: "active" } }, "get-1"),
		);
		const detail = await waitForResult(events, "get-1");
		expect(detail).toMatchObject({
			ok: true,
			result: { goal: { id: goal.id, status: "active", projection: { truncatedFields: [] } } },
			meta: { changed: false, revisions: { project: "2" } },
		});
		if (!detail.ok) throw new Error("Expected goal detail");
		const goalUpdatedAt = (detail.result as { goal: { updatedAt: string } }).goal.updatedAt;

		events.emit(
			WORKLIST_REQUEST_EVENT,
			baseRequest(
				"session-tasks.reconcile",
				{
					idempotencyKey: "run-15:plan-1",
					goalId: goal.id,
					expectedGoalUpdatedAt: goalUpdatedAt,
					owner: "pi-orchestrator",
					tasks: [managedInput("step-a", "Projected step")],
				},
				"reconcile-1",
			),
		);
		const reconciled = await waitForResult(events, "reconcile-1");
		expect(reconciled).toMatchObject({
			ok: true,
			result: { tasks: [{ external: { id: "step-a" }, action: "created" }] },
			meta: { changed: true, changedFields: ["/tasks"] },
		});

		events.emit(WORKLIST_REQUEST_EVENT, baseRequest("session-tasks.list", { goalId: goal.id }, "list-1"));
		const listed = await waitForResult(events, "list-1");
		expect(listed).toMatchObject({
			ok: true,
			result: {
				tasks: [{ title: "Projected step", managed: { external: { id: "step-a" } } }],
				page: { returned: 1, truncated: false },
			},
		});

		events.emit(
			WORKLIST_REQUEST_EVENT,
			baseRequest(
				"session-tasks.update-execution",
				{
					idempotencyKey: "run-15:execution-1",
					owner: "pi-orchestrator",
					updates: [
						{
							external: { system: "pi-orchestrator", kind: "workflow-step", id: "step-a" },
							execution: {
								state: "running",
								updatedAt: "2026-07-25T12:05:00.000Z",
								runId: "run-15",
							},
						},
					],
				},
				"execution-1",
			),
		);
		const updated = await waitForResult(events, "execution-1");
		expect(updated).toMatchObject({
			ok: true,
			result: { tasks: [{ external: { id: "step-a" }, action: "updated" }] },
			meta: { changed: true },
		});
	});

	it("returns typed errors for unsupported versions, capabilities, and invalid envelopes", async () => {
		const { events } = await createProvider();

		events.emit(WORKLIST_REQUEST_EVENT, {
			...baseRequest("session-tasks.list", {}, "version-1"),
			protocolVersion: 99,
		});
		expect(await waitForResult(events, "version-1")).toMatchObject({
			ok: false,
			error: {
				code: "INCOMPATIBLE_VERSION",
				retryable: false,
				details: { supportedProtocolVersions: [1] },
			},
		});

		events.emit(
			WORKLIST_REQUEST_EVENT,
			baseRequest("project-goals.create-approved-batch", {}, "unsupported-1"),
		);
		expect(await waitForResult(events, "unsupported-1")).toMatchObject({
			ok: false,
			error: { code: "UNSUPPORTED_CAPABILITY", retryable: false },
		});

		events.emit(WORKLIST_REQUEST_EVENT, {
			protocol: WORKLIST_PROTOCOL_ID,
			protocolVersion: 1,
			requestId: "malformed-1",
			operation: "session-tasks.list",
			actor: { type: "mystery", id: "" },
			payload: {},
		});
		expect(await waitForResult(events, "malformed-1")).toMatchObject({
			ok: false,
			error: { code: "INVALID_REQUEST", retryable: false },
		});

		events.emit(
			WORKLIST_REQUEST_EVENT,
			baseRequest("capabilities.negotiate", { supportedProtocolVersions: [99] }, "negotiate-mismatch"),
		);
		expect(await waitForResult(events, "negotiate-mismatch")).toMatchObject({
			ok: false,
			error: { code: "INCOMPATIBLE_VERSION", details: { supportedProtocolVersions: [1] } },
		});
	});

	it("ignores requests targeted at other provider instances and unrelated events", async () => {
		const { events } = await createProvider();
		events.emit(WORKLIST_REQUEST_EVENT, {
			...baseRequest("session-tasks.list", {}, "targeted-elsewhere"),
			targetProviderInstanceId: "some-other-instance",
		});
		events.emit(WORKLIST_REQUEST_EVENT, { unrelated: true });
		events.emit(WORKLIST_REQUEST_EVENT, "not even an object");

		events.emit(WORKLIST_REQUEST_EVENT, {
			...baseRequest("session-tasks.list", {}, "targeted-here"),
			targetProviderInstanceId: "provider-under-test",
		});
		await waitForResult(events, "targeted-here");
		expect(events.results.map((result) => result.requestId)).toEqual(["targeted-here"]);
	});

	it("stops accepting requests after shutdown", async () => {
		const { events, handle } = await createProvider();
		handle.shutdown();
		events.emit(WORKLIST_REQUEST_EVENT, baseRequest("session-tasks.list", {}, "after-shutdown"));
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(events.results).toHaveLength(0);
	});
});
