import {
	createWorklistErrorResult,
	DEFAULT_WORKLIST_REQUEST_TIMEOUT_MS,
	isWorklistResult,
	MAX_WORKLIST_REQUEST_TIMEOUT_MS,
	WORKLIST_ERROR_CODES,
	WORKLIST_OPERATIONS,
	WORKLIST_PROTOCOL_ID,
	WORKLIST_REQUEST_EVENT,
	WORKLIST_RESULT_EVENT,
	type WorklistRequest,
	type WorklistResultEnvelope,
} from "./integration-contract.ts";
import type { WorklistProtocolEventBus } from "./protocol-provider.ts";

/**
 * Consumer-side request helper for the pi-worklist protocol.
 *
 * No provider can answer when pi-worklist is absent, so every request resolves
 * within a bounded timeout with a deterministic, locally synthesized error:
 * `UNAVAILABLE` for unanswered negotiation broadcasts (no provider discovered)
 * and `TIMEOUT` for unanswered post-negotiation operations. Synthesized results
 * carry no provider identity, distinguishing them from provider responses.
 */

export interface WorklistConsumerRequestOptions {
	/** Clamped to [1, MAX_WORKLIST_REQUEST_TIMEOUT_MS]. Defaults to DEFAULT_WORKLIST_REQUEST_TIMEOUT_MS. */
	timeoutMs?: number;
}

export function resolveWorklistRequestTimeout(timeoutMs?: number): number {
	if (timeoutMs === undefined || !Number.isFinite(timeoutMs)) return DEFAULT_WORKLIST_REQUEST_TIMEOUT_MS;
	return Math.min(Math.max(Math.floor(timeoutMs), 1), MAX_WORKLIST_REQUEST_TIMEOUT_MS);
}

export function requestWorklistOperation(
	events: WorklistProtocolEventBus,
	request: WorklistRequest,
	options: WorklistConsumerRequestOptions = {},
): Promise<WorklistResultEnvelope> {
	const timeoutMs = resolveWorklistRequestTimeout(options.timeoutMs);
	return new Promise((resolve) => {
		let settled = false;
		const settle = (result: WorklistResultEnvelope) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			unsubscribe();
			resolve(result);
		};

		// The listener must be registered before emitting because delivery may be synchronous.
		const unsubscribe = events.on(WORKLIST_RESULT_EVENT, (value) => {
			if (!isWorklistResult(value)) return;
			if (value.protocol !== WORKLIST_PROTOCOL_ID || value.requestId !== request.requestId) return;
			settle(value);
		});
		const timer = setTimeout(() => {
			const negotiating = request.operation === WORKLIST_OPERATIONS.CAPABILITIES_NEGOTIATE;
			settle(
				createWorklistErrorResult(request, {
					code: negotiating ? WORKLIST_ERROR_CODES.UNAVAILABLE : WORKLIST_ERROR_CODES.TIMEOUT,
					message: negotiating
						? "No pi-worklist provider answered the negotiation within the timeout."
						: `The pi-worklist provider did not answer ${request.operation} within ${timeoutMs}ms.`,
					retryable: true,
					retryAfterMs: timeoutMs,
					details: { timeoutMs },
				}),
			);
		}, timeoutMs);
		events.emit(WORKLIST_REQUEST_EVENT, request);
	});
}
