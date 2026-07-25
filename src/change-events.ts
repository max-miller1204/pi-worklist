import { randomUUID } from "node:crypto";
import {
	CURRENT_WORKLIST_PROTOCOL_VERSION,
	WORKLIST_PROTOCOL_ID,
	type WorklistActor,
	type WorklistChangedEntities,
	type WorklistChangeEvent,
	type WorklistCorrelation,
	type WorklistMutationType,
	type WorklistProviderIdentity,
	type WorklistRevisionSet,
} from "./integration-contract.ts";

/**
 * Change events are post-commit notifications, never a durable journal.
 * They must stay compact: identities, revisions, and changed fields only.
 */
export interface WorklistChangeDescription {
	mutation: WorklistMutationType;
	actor: WorklistActor;
	correlation?: WorklistCorrelation;
	sourceRequestId?: string;
	changedFields: string[];
	changedEntities: WorklistChangedEntities;
	revisions: WorklistRevisionSet;
}

export type WorklistChangePublisher = (description: WorklistChangeDescription) => void;

export function createWorklistChangeEvent(
	provider: WorklistProviderIdentity,
	description: WorklistChangeDescription,
): WorklistChangeEvent {
	return {
		protocol: WORKLIST_PROTOCOL_ID,
		protocolVersion: CURRENT_WORKLIST_PROTOCOL_VERSION,
		eventId: randomUUID(),
		occurredAt: new Date().toISOString(),
		mutation: description.mutation,
		provider,
		actor: description.actor,
		...(description.correlation !== undefined ? { correlation: description.correlation } : {}),
		...(description.sourceRequestId !== undefined ? { sourceRequestId: description.sourceRequestId } : {}),
		changedFields: description.changedFields,
		changedEntities: description.changedEntities,
		revisions: description.revisions,
	};
}
