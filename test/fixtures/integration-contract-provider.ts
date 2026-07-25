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

export default function integrationContractProvider(pi: ExtensionAPI): void {
	pi.events.on(WORKLIST_REQUEST_EVENT, (value: unknown) => {
		const request = value as WorklistRequest;
		if (request.protocol !== WORKLIST_PROTOCOL_ID || request.operation !== "capabilities.negotiate") return;

		const result: WorklistResult = {
			protocol: WORKLIST_PROTOCOL_ID,
			protocolVersion: CURRENT_WORKLIST_PROTOCOL_VERSION,
			requestId: request.requestId,
			operation: request.operation,
			actor: request.actor,
			correlation: request.correlation,
			ok: true,
			result: {
				provider: { id: "pi-worklist", version: "test", instanceId: "contract-provider" },
				supportedProtocolVersions: [CURRENT_WORKLIST_PROTOCOL_VERSION],
				selectedProtocolVersion: CURRENT_WORKLIST_PROTOCOL_VERSION,
				capabilities: [
					{
						id: WORKLIST_CAPABILITIES.PROJECT_GOALS_READ,
						version: 1,
						limits: { defaultLimit: 20, maxLimit: 100 },
					},
				],
			},
			meta: {
				changed: false,
				semanticNoOp: false,
				changedFields: [],
			},
		};
		pi.events.emit(WORKLIST_RESULT_EVENT, result);
	});
}
