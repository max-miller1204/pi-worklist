import type {
	WorklistApplicationResult,
	WorklistApplicationService,
	WorklistOperation as WorklistServiceOperation,
} from "./application-service.ts";
import {
	CURRENT_WORKLIST_PROTOCOL_VERSION,
	createWorklistErrorResult,
	isWorklistRequest,
	SUPPORTED_WORKLIST_PROTOCOL_VERSIONS,
	WORKLIST_CAPABILITIES,
	WORKLIST_ERROR_CODES,
	WORKLIST_OPERATIONS,
	WORKLIST_PROTOCOL_ID,
	WORKLIST_PROVIDER_LIMITS,
	WORKLIST_REQUEST_EVENT,
	WORKLIST_RESULT_EVENT,
	type WorklistActor,
	type WorklistCapability,
	type WorklistOperationPayloads,
	type WorklistProtocolError,
	type WorklistProviderIdentity,
	type WorklistRequestEnvelope,
	type WorklistResultEnvelope,
} from "./integration-contract.ts";

/**
 * The pi-worklist side of the versioned inter-extension protocol.
 *
 * Every mutation routes through the same WorklistApplicationService as the tool,
 * command, dashboard, and CLI, so protocol consumers get identical validation,
 * persistence, and change events. The module is transport-thin on purpose.
 */

export interface WorklistProtocolEventBus {
	emit(channel: string, data: unknown): void;
	on(channel: string, handler: (data: unknown) => void): () => void;
}

export interface WorklistProtocolProviderOptions {
	events: WorklistProtocolEventBus;
	applicationService: WorklistApplicationService;
	provider: WorklistProviderIdentity;
}

export interface WorklistProtocolProviderHandle {
	/**
	 * Enters shutdown: requests still arriving in the current tick receive a
	 * SHUTTING_DOWN error and no new operations start; the request listener then
	 * detaches so a replacement provider instance can own the channel.
	 */
	shutdown(): void;
}

/** Capabilities this provider implementation actually serves, in deterministic order. */
export function advertisedWorklistCapabilities(): WorklistCapability[] {
	const limits = WORKLIST_PROVIDER_LIMITS;
	return [
		{ id: WORKLIST_CAPABILITIES.CHANGES_SUBSCRIBE, version: 1 },
		{
			id: WORKLIST_CAPABILITIES.PROJECT_GOALS_CREATE_APPROVED_BATCH,
			version: 1,
			limits: {
				maxBatchItems: limits.maxBatchItems,
				maxTitleBytes: limits.maxTitleBytes,
				maxDescriptionBytes: limits.maxDescriptionBytes,
				maxReferenceBytes: limits.maxReferenceBytes,
			},
		},
		{
			id: WORKLIST_CAPABILITIES.PROJECT_GOALS_READ,
			version: 1,
			limits: { maxTitleBytes: limits.maxTitleBytes, maxDescriptionBytes: limits.maxDescriptionBytes },
		},
		{
			id: WORKLIST_CAPABILITIES.SESSION_TASKS_LIST,
			version: 1,
			limits: {
				defaultLimit: limits.defaultListLimit,
				maxLimit: limits.maxListLimit,
				maxTitleBytes: limits.maxTitleBytes,
			},
		},
		{
			id: WORKLIST_CAPABILITIES.SESSION_TASKS_RECONCILE,
			version: 1,
			limits: {
				maxBatchItems: limits.maxListLimit,
				maxTitleBytes: limits.maxTitleBytes,
				maxSummaryBytes: limits.maxSummaryBytes,
				maxReferenceBytes: limits.maxReferenceBytes,
			},
		},
		{
			id: WORKLIST_CAPABILITIES.SESSION_TASKS_UPDATE_EXECUTION,
			version: 1,
			limits: {
				maxBatchItems: limits.maxListLimit,
				maxSummaryBytes: limits.maxSummaryBytes,
				maxReferenceBytes: limits.maxReferenceBytes,
			},
		},
	];
}

function boundedErrorMessage(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return message.length > 512 ? `${message.slice(0, 512)}…` : message;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

const KNOWN_OPERATIONS = new Set<string>(Object.values(WORKLIST_OPERATIONS));
const FALLBACK_ACTOR: WorklistActor = { type: "system", id: "unknown-consumer" };

function serviceOperationFor(request: WorklistRequestEnvelope): WorklistServiceOperation | undefined {
	switch (request.operation) {
		case WORKLIST_OPERATIONS.PROJECT_GOALS_GET:
			return {
				scope: "project",
				action: "get_projection",
				goalSelector: request.payload.selector as WorklistOperationPayloads["project-goals.get"]["selector"],
			};
		case WORKLIST_OPERATIONS.PROJECT_GOALS_CREATE_APPROVED_BATCH:
			return {
				scope: "project",
				action: "create_approved_batch",
				approvedBatch:
					request.payload as unknown as WorklistOperationPayloads["project-goals.create-approved-batch"],
			};
		case WORKLIST_OPERATIONS.SESSION_TASKS_LIST:
			return {
				scope: "session",
				action: "list_projection",
				listProjection: request.payload as WorklistOperationPayloads["session-tasks.list"],
			};
		case WORKLIST_OPERATIONS.SESSION_TASKS_RECONCILE:
			return {
				scope: "session",
				action: "reconcile",
				reconciliation: request.payload as unknown as WorklistOperationPayloads["session-tasks.reconcile"],
			};
		case WORKLIST_OPERATIONS.SESSION_TASKS_UPDATE_EXECUTION:
			return {
				scope: "session",
				action: "update_execution",
				executionUpdate:
					request.payload as unknown as WorklistOperationPayloads["session-tasks.update-execution"],
			};
		default:
			return undefined;
	}
}

function protocolResultFor(
	request: WorklistRequestEnvelope,
	provider: WorklistProviderIdentity,
	envelope: WorklistApplicationResult,
): WorklistResultEnvelope {
	const base = {
		protocol: WORKLIST_PROTOCOL_ID,
		protocolVersion: request.protocolVersion,
		requestId: request.requestId,
		operation: request.operation,
		actor: request.actor,
		...(request.correlation !== undefined ? { correlation: request.correlation } : {}),
		provider,
	};
	if (!envelope.ok) return { ...base, ok: false, error: envelope.error, meta: envelope.meta };

	let result: Record<string, unknown>;
	if (request.operation === WORKLIST_OPERATIONS.PROJECT_GOALS_GET) {
		result = { goal: envelope.result.goalProjection ?? null };
	} else if (request.operation === WORKLIST_OPERATIONS.PROJECT_GOALS_CREATE_APPROVED_BATCH) {
		result = { goals: envelope.result.approvedBatch ?? [] };
	} else if (request.operation === WORKLIST_OPERATIONS.SESSION_TASKS_LIST) {
		result = {
			tasks: envelope.result.taskProjections?.tasks ?? [],
			page: envelope.result.taskProjections?.page ?? { limit: 0, returned: 0, truncated: false },
		};
	} else {
		result = { tasks: envelope.result.reconciliation?.tasks ?? [] };
	}
	return { ...base, ok: true, result, meta: envelope.meta };
}

export function registerWorklistProtocolProvider(
	options: WorklistProtocolProviderOptions,
): WorklistProtocolProviderHandle {
	const { applicationService, events, provider } = options;
	let shutdownRequested = false;

	function emitResult(result: WorklistResultEnvelope): void {
		events.emit(WORKLIST_RESULT_EVENT, result);
	}

	function emitError(request: WorklistRequestEnvelope, error: WorklistProtocolError): void {
		emitResult({ ...createWorklistErrorResult(request, error), provider });
	}

	function negotiate(request: WorklistRequestEnvelope): void {
		const supportedByConsumer = (
			request.payload as Partial<WorklistOperationPayloads["capabilities.negotiate"]>
		).supportedProtocolVersions;
		if (
			!Array.isArray(supportedByConsumer) ||
			supportedByConsumer.length === 0 ||
			!supportedByConsumer.every((version) => Number.isSafeInteger(version))
		) {
			emitError(request, {
				code: WORKLIST_ERROR_CODES.INVALID_REQUEST,
				message: "capabilities.negotiate requires payload.supportedProtocolVersions.",
				retryable: false,
				details: { resolution: "provide-supported-protocol-versions" },
			});
			return;
		}
		const selectable = SUPPORTED_WORKLIST_PROTOCOL_VERSIONS.filter((version) =>
			supportedByConsumer.includes(version),
		);
		if (selectable.length === 0) {
			emitError(request, {
				code: WORKLIST_ERROR_CODES.INCOMPATIBLE_VERSION,
				message: "No protocol version is supported by both participants.",
				retryable: false,
				details: { supportedProtocolVersions: [...SUPPORTED_WORKLIST_PROTOCOL_VERSIONS] },
			});
			return;
		}
		const selectedProtocolVersion = Math.max(...selectable);
		emitResult({
			protocol: WORKLIST_PROTOCOL_ID,
			protocolVersion: selectedProtocolVersion,
			requestId: request.requestId,
			operation: request.operation,
			actor: request.actor,
			...(request.correlation !== undefined ? { correlation: request.correlation } : {}),
			provider,
			ok: true,
			result: {
				provider,
				supportedProtocolVersions: [...SUPPORTED_WORKLIST_PROTOCOL_VERSIONS],
				selectedProtocolVersion,
				capabilities: advertisedWorklistCapabilities(),
			},
			meta: { changed: false, semanticNoOp: false, changedFields: [] },
		});
	}

	async function handleRequest(request: WorklistRequestEnvelope): Promise<void> {
		if (request.operation === WORKLIST_OPERATIONS.CAPABILITIES_NEGOTIATE) {
			negotiate(request);
			return;
		}
		if (!(SUPPORTED_WORKLIST_PROTOCOL_VERSIONS as readonly number[]).includes(request.protocolVersion)) {
			emitError(request, {
				code: WORKLIST_ERROR_CODES.INCOMPATIBLE_VERSION,
				message: `Protocol version ${request.protocolVersion} is not supported.`,
				retryable: false,
				details: { supportedProtocolVersions: [...SUPPORTED_WORKLIST_PROTOCOL_VERSIONS] },
			});
			return;
		}
		const operation = serviceOperationFor(request);
		if (operation === undefined) {
			emitError(request, {
				code: WORKLIST_ERROR_CODES.UNSUPPORTED_CAPABILITY,
				message: `Operation ${request.operation} is not supported by this provider.`,
				retryable: false,
				details: { capabilities: advertisedWorklistCapabilities().map((capability) => capability.id) },
			});
			return;
		}
		const envelope = await applicationService.execute(operation, {
			source: "protocol",
			actor: request.actor,
			correlation: request.correlation,
			sourceRequestId: request.requestId,
		});
		emitResult(protocolResultFor(request, provider, envelope));
	}

	function handleUnparsableRequest(value: unknown): void {
		if (!isRecord(value) || value.protocol !== WORKLIST_PROTOCOL_ID) return;
		if (
			value.targetProviderInstanceId !== undefined &&
			value.targetProviderInstanceId !== provider.instanceId
		) {
			return;
		}
		const { requestId, operation } = value;
		if (typeof requestId !== "string" || requestId.length === 0) return;
		if (typeof operation !== "string" || !KNOWN_OPERATIONS.has(operation)) return;
		const syntheticRequest = {
			protocol: WORKLIST_PROTOCOL_ID,
			protocolVersion: Number.isSafeInteger(value.protocolVersion)
				? (value.protocolVersion as number)
				: CURRENT_WORKLIST_PROTOCOL_VERSION,
			requestId,
			operation,
			actor: FALLBACK_ACTOR,
			payload: {},
		} as WorklistRequestEnvelope;
		emitError(syntheticRequest, {
			code: WORKLIST_ERROR_CODES.INVALID_REQUEST,
			message: "The request envelope is malformed.",
			retryable: false,
			details: { resolution: "send-a-valid-request-envelope" },
		});
	}

	const unsubscribe = events.on(WORKLIST_REQUEST_EVENT, (value) => {
		if (!isWorklistRequest(value)) {
			handleUnparsableRequest(value);
			return;
		}
		const request = value;
		if (
			request.targetProviderInstanceId !== undefined &&
			request.targetProviderInstanceId !== provider.instanceId
		) {
			return;
		}
		if (shutdownRequested) {
			emitError(request, {
				code: WORKLIST_ERROR_CODES.SHUTTING_DOWN,
				message: "The pi-worklist provider is shutting down and no longer starts new operations.",
				retryable: true,
			});
			return;
		}
		handleRequest(request).catch((error) => {
			emitError(request, {
				code: WORKLIST_ERROR_CODES.INTERNAL,
				message: boundedErrorMessage(error),
				retryable: false,
			});
		});
	});

	return {
		shutdown(): void {
			if (shutdownRequested) return;
			shutdownRequested = true;
			queueMicrotask(unsubscribe);
		},
	};
}
