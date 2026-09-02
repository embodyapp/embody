# ADR 0003: Durable workflows in the MVP

- Status: Accepted
- Date: 2026-09-02

## Decision

Durable workflows are part of the MVP and are implemented in Phase 11, after the action, outbox, gateway, tooling, and distributed reference-app foundations. Phase 12 release hardening depends on the workflow phase passing.

The initial workflow contract uses these semantics:

- Workflows are versioned, acyclic directed graphs of stable, named steps; independent branches may run concurrently.
- Workflow instances are pinned to the definition version with which they started. Deployments must retain that definition while matching instances can still run.
- Inputs, step outputs, attempts, errors, schedules, and state transitions are persisted. Delays use persisted schedules rather than process timers.
- Steps execute at least once and must make external side effects idempotent. Configurable retry, backoff, and timeout policies apply per step.
- Starting with the same organization, definition, and idempotency key returns the existing instance for equivalent input and conflicts for different input.
- Cancellation prevents new step claims, cooperatively signals active steps, and then compensates completed compensatable steps.
- Compensation executes in reverse dependency order. Compensation failures remain visible and audited; they do not produce a falsely successful or compensated state.
- Authorization is re-evaluated before each step using the initiating actor identity. The workflow retains the principal information required for authorization and audit, subject to data minimization and redaction rules.
- Start, status, cancel, and retry are explicit operations exposed through the normal execution, gateway, CLI, and MCP surfaces.

The engine does not promise transparent replay of arbitrary TypeScript. Workflow and step execution is built on the durable storage and worker primitives delivered by earlier phases.

## Consequences

Durable workflows remain on the MVP release critical path. MVP cannot ship until Phase 11 passes crash recovery, concurrency, retry, cancellation, compensation, tenant-isolation, and upgrade tests.

Plugins continue to fail boot with `UNSUPPORTED_WORKFLOW` until Phase 11 implements the approved contract. This temporary failure must not be represented as permanent workflow deferral.

Retaining old workflow definitions increases deployment and operational complexity. Re-evaluating authorization means a long-running workflow can stop after its initiating actor loses permission; that failure must be surfaced and audited clearly.
