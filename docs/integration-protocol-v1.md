<!-- markdownlint-disable MD013 -->

# Pi Worklist Integration Protocol v1

## Status and scope

This document defines the version 1 contract between pi-worklist and automation consumers such as pi-orchestrator.
The exported TypeScript contract in `src/integration-contract.ts` is the normative machine-readable definition.
The wire contract and shared application result boundary are implemented, but the pi-worklist protocol provider and pi-orchestrator client are not yet implemented.

`WorklistApplicationService.execute` returns a deterministic discriminated envelope for every tool, command, dashboard, CLI, or future protocol operation.
Success envelopes contain `ok: true`, the requested scope and action, the operation result, and canonical change metadata.
Failure envelopes contain `ok: false`, the requested scope and action, a typed error with explicit retryability and bounded resolution details, and unchanged metadata.
Adapters whose host signals failures with exceptions use `unwrapWorklistApplicationResult`, which throws `WorklistApplicationError` without discarding the stable error code or actionable details.

The protocol lets a consumer negotiate capabilities, read the active or explicitly selected Project Goal, list bounded Session Task projections, reconcile managed Session Task projections, update projected execution state, and create an explicitly approved Project Goal batch.
The protocol does not grant an automation consumer unrestricted access to worklist storage or Pi session snapshots.

## Transport

The transport is Pi's process-local shared `pi.events` bus.
The stable event names are:

| Direction | Event |
| --- | --- |
| Consumer to provider | `pi-worklist:request` |
| Provider to consumers | `pi-worklist:result` |
| Provider notifications | `pi-worklist:change` |

Event names are deliberately not versioned.
Every event envelope carries `protocol` and `protocolVersion` so incompatible participants can negotiate or return a typed error over stable discovery channels.

A consumer must register its result listener before emitting a request because Pi event delivery may be synchronous.
A consumer must correlate responses by `requestId` and must ignore unrelated results on the shared result channel.
A consumer should broadcast capability negotiation without `targetProviderInstanceId`.
After selecting a provider, a consumer should set `targetProviderInstanceId` on later requests.
A provider must ignore a targeted request for a different provider instance.

## Version and capability negotiation

Protocol v1 uses `protocol: "pi-worklist"` and `protocolVersion: 1`.
A consumer starts with `capabilities.negotiate` and sends all versions it can understand in `payload.supportedProtocolVersions`.
Negotiation does not require prior capability agreement.
A successful response selects one protocol version and reports the provider identity, capability versions, and advertised limits.

The v1 capabilities are:

| Capability | Operations |
| --- | --- |
| `project-goals.read` | `project-goals.get` |
| `project-goals.create-approved-batch` | `project-goals.create-approved-batch` |
| `session-tasks.list` | `session-tasks.list` |
| `session-tasks.reconcile` | `session-tasks.reconcile` |
| `session-tasks.update-execution` | `session-tasks.update-execution` |
| `changes.subscribe` | `pi-worklist:change` notifications |

Capabilities have independent versions so later providers can evolve an operation without claiming support for unrelated functionality.
Limits can advertise default and maximum list sizes, maximum batch sizes, maximum byte lengths for projected text, and default and maximum timeouts.
A consumer must obey the limits reported by the selected provider.
A consumer must not infer support for an operation that was not negotiated.

## Request envelope

Every request contains these fields:

- `protocol` identifies pi-worklist.
- `protocolVersion` proposes the wire version used by the request.
- `requestId` is a consumer-generated unique correlation identifier.
- `operation` is one of the exported operation constants.
- `actor` identifies the initiating extension, user, tool, command, dashboard, CLI, or system and can include its version.
- `correlation` optionally carries repository, Pi session, roadmap, phase, repository run, run, step, attempt, and general correlation IDs.
- `targetProviderInstanceId` optionally routes a post-negotiation request to one provider instance.
- `deadlineAt` optionally records the absolute time after which the consumer will ignore a result.
- `payload` is the operation-specific body.

Actor and correlation fields provide provenance only.
They are not approval evidence and must not be treated as authorization.
A request ID correlates one logical request and is not an idempotency key.
Mutation payloads carry a separate `idempotencyKey` so retries can safely refer to the same intended mutation.

## Result envelope

Every result echoes `protocol`, `protocolVersion`, `requestId`, `operation`, `actor`, and `correlation`.
Provider-generated results identify the responding provider instance.
Consumer-synthesized fallback results omit the provider identity.

A successful result has `ok: true` and an operation-specific `result`.
A failed result has `ok: false` and a typed `error`.
A result never has both `result` and `error`.

Every result has `meta` with:

- `changed` to report whether canonical state changed.
- `semanticNoOp` to report a valid mutation whose requested semantic state already existed.
- `changedFields` as sorted, unique JSON Pointer paths.
- `changedEntities` when Project Goal or Session Task identities changed.
- `revisions` when project or session revisions are available.

Read and negotiation results use `changed: false` and `semanticNoOp: false`.
A successful mutation that writes nothing because state already matches uses `changed: false` and `semanticNoOp: true`.
Failures use both fields as false.
Providers must use deterministic ordering for capabilities, entities, mappings, and changed fields.
Providers must not add response timestamps, generated request IDs, or other nondeterministic data to result envelopes.

## Operations

### `project-goals.get`

The selector is either `{ type: "active" }` or `{ type: "id", id }`.
An active lookup can return `goal: null` when no active Project Goal exists.
An explicit ID that does not exist returns `NOT_FOUND`.
An explicit done or archived goal returns `VALIDATION_FAILED` with `resolution: "reopen-project-goal"` and cannot be used for orchestration until the user explicitly reopens it through a confirmed pi-worklist lifecycle action.
The result is a bounded detail projection with the stable goal ID and `updatedAt`, any truncated text named in `projection.truncatedFields`, and the containing Project Worklist revision in result metadata.
The consumer snapshots the selected goal ID and `updatedAt` before planning or approval.

### `session-tasks.list`

The request can filter by Project Goal and Session Task status.
The provider reads only the current Pi session branch managed by its existing session service.
The consumer can request a limit and continue with an opaque cursor.
The result always includes `page.limit`, `page.returned`, and `page.truncated`.
The provider must not return more than its advertised maximum, and it clamps larger requested limits to that maximum.
A cursor that is malformed, or whose anchor left the filtered view, returns `VALIDATION_FAILED` with `resolution: "restart-list-from-beginning"`.
List items stay compact: projected titles are truncated to the advertised byte limit and truncated items carry `projection.truncatedFields`.
Managed projections appear on list items so a consumer can locate its own workflow steps, and full Session Task text beyond the advertised bounds is never returned.

### `session-tasks.reconcile`

This operation atomically reconciles the desired pi-orchestrator-managed projection set for one Project Goal.
The request carries the owner, versioned producer identity, stable external workflow-step identities, projected titles and worklist statuses, plan and approved-plan revisions, lightweight execution projections, bounded references, an idempotency key, the selected goal's expected `updatedAt`, and an optional expected session revision.
Before changing Session Tasks, the provider verifies that `goalId` still exists, is open or active, and has the expected `updatedAt` captured by `project-goals.get`.
A missing goal returns `NOT_FOUND`, a done or archived goal returns `VALIDATION_FAILED` with `resolution: "reopen-project-goal"`, and a changed `updatedAt` returns `CONFLICT` with `resolution: "refresh-and-retry"`.
None of these failures append a Session Task snapshot.
A stored managed projection adds creation and update timestamps while preserving the producer and external identity.
The response maps every external identity to its stable Session Task ID and reports whether it was created, updated, unchanged, removed, or preserved because of a user override.
The operation must not append snapshots directly outside the shared worklist mutation service.

Managed Session Task metadata uses projection schema version 1 inside Session Task snapshot version 3.
The external identity must identify a `workflow-step`, and its `id` is the stable orchestration step ID.
The execution `runId` is the orchestration run ID.
Managed projections retain producer identity, plan and approved-plan revisions, creation and update timestamps, lightweight read-only execution state, and bounded summary, run, result, or session-contribution references.
Every valid managed projection also has a non-empty Session Task `goalId`.
References are limited to 2,048 UTF-8 bytes and execution summaries are limited to 4,096 UTF-8 bytes.
Normalization omits unknown fields rather than copying attempts, retries, dependencies, workers, logs, artifacts, evidence, or recovery state into pi-worklist.
Ordinary Session Task list and mutation results omit managed metadata.
Snapshots version 1 and 2 remain readable, preserve their existing Session Task IDs and branch revision behavior, and are written as version 3 only after the next real mutation.

### `session-tasks.update-execution`

This operation atomically updates lightweight projected execution state for pi-orchestrator-managed Session Tasks.
The update identifies tasks by stable external identities rather than queue position or title.
An external identity without a managed projection on the current session branch returns `NOT_FOUND`; the consumer must reconcile before updating execution state.
The user-facing todo, doing, and done lifecycle is never changed by an execution update; only `session-tasks.reconcile` projects it.
Execution updates reject closed or missing goal associations exactly like reconciliation.
Session mutation idempotency keys share one namespace, so reusing a reconciliation key for an execution update returns an idempotency-key conflict.
Execution summaries and run references must stay within advertised bounds.
The provider must not copy worker logs, dependency graphs, retry histories, artifacts, or recovery state into pi-worklist.

### `project-goals.create-approved-batch`

This is the only protocol operation that creates Project Goals.
The request must include explicit approval evidence, a digest of the exact approved content, stable external phase identities, an idempotency key, and an optional expected project revision.
The provider validates approval and creates the complete batch atomically or creates nothing.

Protocol v1 deliberately has no operation to rewrite, complete, archive, delete, reopen, or activate a Project Goal.
Those lifecycle actions stay under pi-worklist control and retain their existing explicit confirmation rules.
Archiving a goal makes its existing managed projections closed associations, while confirmed deletion can leave temporarily orphaned projections.
Pi-worklist preserves those projections for inspection and does not append a Session Task snapshot, silently reassign them, recreate a deleted goal, or infer approval.
New managed reconciliation and execution mutations reject closed or missing associations.
Explicitly reopening the same archived or done goal preserves its stable ID and makes its projections eligible again, while a deleted goal remains missing.

## Revisions, conflicts, and no-ops

Project and session revisions are opaque strings.
Consumers compare them for equality and must not parse or increment them.
The Project revision represents the canonical `.pi/worklist.json` file, while the Session revision represents the latest worklist snapshot on the active Pi session branch.
Legacy Session Task snapshots derive their revision from the Pi custom entry ID, and a branch without a snapshot uses the baseline token `0`.
The first mutation on two branches that share a snapshot produces distinct successor tokens, so a resumed consumer cannot silently overwrite a newer mutation on either branch.
Mutation operations can carry the relevant expected revision.
The expected-revision check occurs before no-op detection, so a stale request conflicts even when its requested state happens to match current state.
A mismatch returns `CONFLICT` with expected and actual revisions plus `resolution: "refresh-and-retry"`.

Identical updates, already-satisfied moves or activations, and repeated status transitions are semantic no-ops.
A semantic no-op does not rewrite `.pi/worklist.json`, change Project Goal timestamps, append a Session Task snapshot, increment a Project revision, replace a Session token, or emit a change event.

A repeated mutation with the same idempotency key and identical semantic input returns the original mapping or an equivalent semantic no-op result.
Reusing an idempotency key for different semantic input returns `CONFLICT` with `type: "idempotency-key"`.
Session replay records are branch-aware and bounded to the most recent 32 external mutations, so a key committed on one branch re-executes on a branch that never contained it, and consumers must not rely on replaying keys older than that window.

## User overrides on managed projections

The user always keeps full control over editing, moving, deleting, and changing the status of a managed Session Task.
A manual edit, status change, or deletion of a managed task stamps the projection with `userOverride` metadata, or a bounded deletion tombstone, and emits a `session-tasks.user-overridden` change event.
Reconciliation and execution updates never silently restore projected data over a user override; they report `preserved-user-override` for the affected external identity and leave the user's version untouched.
A deleted managed projection is not recreated while its tombstone exists; the tombstone clears once the producer stops projecting that step, after which the step may be projected again as a new task.
When the producer stops projecting an overridden step, the task detaches into an ordinary user task and its managed metadata is removed.
Consumers that receive `preserved-user-override` must pause or replan from current worklist state instead of retrying the same projection.
Successful managed tasks never automatically complete their associated Project Goal.
A user override that cannot be overwritten safely returns `USER_OVERRIDE` or a conflict with `resolution: "request-user-decision"`.

## Errors and fallback

Every error includes a stable code, a human-readable message, and an explicit `retryable` boolean.
Errors can include `retryAfterMs`, structured conflict information, and bounded operation-specific details.

The v1 error codes are:

- `UNAVAILABLE`
- `INCOMPATIBLE_VERSION`
- `UNSUPPORTED_CAPABILITY`
- `INVALID_REQUEST`
- `VALIDATION_FAILED`
- `NOT_FOUND`
- `APPROVAL_REQUIRED`
- `CONFLICT`
- `USER_OVERRIDE`
- `TIMEOUT`
- `SHUTTING_DOWN`
- `PERSISTENCE_FAILED`
- `INTERNAL`

A provider that understands the base envelope but shares no protocol version returns `INCOMPATIBLE_VERSION` and reports its supported versions in bounded error details.
A provider that lacks a requested capability returns `UNSUPPORTED_CAPABILITY`.
A provider entering shutdown returns `SHUTTING_DOWN` and does not start new mutations.

No provider can answer when pi-worklist is absent.
The consumer therefore waits no longer than its configured timeout, bounded by `MAX_WORKLIST_REQUEST_TIMEOUT_MS`, and synthesizes a deterministic `UNAVAILABLE` or `TIMEOUT` error result locally.
The default timeout is `DEFAULT_WORKLIST_REQUEST_TIMEOUT_MS`.
An absent or incompatible pi-worklist must disable only worklist integration and must not prevent pi-orchestrator from operating on inline objectives or its own stored plans.
An absent pi-orchestrator must not affect any standalone pi-worklist feature.

## Change events

The provider emits `pi-worklist:change` only after a committed mutation.
The event identifies the provider, mutation type, actor, correlation metadata, source request when present, changed fields, changed entity IDs, and resulting revisions.
Change events are notifications rather than a durable event log.
Consumers recover missed events by reading current bounded projections and comparing revisions.
Events must not contain worker logs, artifacts, secrets, or unbounded descriptions.

## Ownership and approval boundary

Pi-worklist owns Project Goals, manual Session Task lifecycle, queue order, standalone interfaces, and lightweight managed projections.
Pi-orchestrator owns roadmaps, phases, workflow steps, dependencies, readiness, repository runs, attempts, workers, artifacts, retries, recovery, Git integration, validation, and evidence.

Pi-worklist must not calculate workflow readiness or duplicate orchestrator recovery state.
Pi-orchestrator must not instantiate another pi-worklist `SessionStore`, edit `.pi/worklist.json`, append worklist snapshots, or invoke the model-facing worklist tool for machine integration.
All protocol mutations must eventually route through the same application mutation service used by the tool, command, dashboard, and CLI.

Actor metadata, run correlation, roadmap references, and managed ownership do not authorize Project Goal lifecycle changes.
Explicit approval is required for approved batch creation.
Existing explicit confirmation remains required for destructive Project Goal lifecycle actions.
Project Goal completion is never inferred from a successful orchestration run.
