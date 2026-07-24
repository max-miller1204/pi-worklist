import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	CURRENT_WORKLIST_PROTOCOL_VERSION,
	WORKLIST_CAPABILITIES,
	WORKLIST_PROTOCOL_ID,
	WORKLIST_REQUEST_EVENT,
	WORKLIST_RESULT_EVENT,
	type WorklistRequest,
	type WorklistResult,
} from "pi-worklist/integration-contract";

const REQUEST_ID = "contract-e2e-request";

export default function integrationContractConsumer(pi: ExtensionAPI): void {
	pi.events.on(WORKLIST_RESULT_EVENT, (value: unknown) => {
		const result = value as WorklistResult;
		if (result.protocol !== WORKLIST_PROTOCOL_ID || result.requestId !== REQUEST_ID) return;
		pi.appendEntry("integration-contract-result", result);
	});

	pi.registerCommand("probe-worklist-contract", {
		description: "Exercise the pi-worklist integration contract",
		handler: async () => {
			const request: WorklistRequest = {
				protocol: WORKLIST_PROTOCOL_ID,
				protocolVersion: CURRENT_WORKLIST_PROTOCOL_VERSION,
				requestId: REQUEST_ID,
				operation: "capabilities.negotiate",
				actor: { type: "extension", id: "pi-orchestrator" },
				correlation: { runId: "run-contract-e2e" },
				deadlineAt: "2030-01-01T00:00:00.000Z",
				payload: {
					supportedProtocolVersions: [CURRENT_WORKLIST_PROTOCOL_VERSION],
					requestedCapabilities: [WORKLIST_CAPABILITIES.PROJECT_GOALS_READ],
				},
			};
			pi.events.emit(WORKLIST_REQUEST_EVENT, request);
		},
	});
}
