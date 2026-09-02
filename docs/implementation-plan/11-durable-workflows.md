# Phase 11 — Durable workflows

**Spec:** 02 (`workflows` SPI and “multi-step durable workflows”). **Status:** P11-01 to P11-03. **Gate:** D-02.

## Objective

Implement the durable workflow state machine approved by [ADR 0003](../adr/0003-durable-workflows.md) rather than a misleading in-memory sequence. Workflows are the final MVP feature phase before hardening and release.

## Required contract to approve first (P11-01)

Define `WorkflowDefinition` with:

- versioned Zod input/output schemas and named, stable step definitions;
- step handler receiving immutable workflow input, prior step outputs, attempt, and normal tenant/principal context;
- retry policy, timeout, and optional compensation handler per step;
- workflow statuses (`pending`, `running`, `waiting`, `completed`, `failed`, `cancelled`, `compensating`, `compensated`) and step statuses;
- explicit APIs/actions for start, get status, cancel, and retry; stable instance/idempotency key behavior;
- deterministic version policy for in-flight instances when plugin code changes.

Do not promise transparent replay of arbitrary TypeScript. Persist outputs/errors between steps, execute each step at-least-once via the existing outbox worker, and require idempotent step side effects. Recommended MVP runs a DAG that is validated acyclic at boot; a linear list is acceptable if approved explicitly. Delays/waits use `scheduled_at`, not process timers.

## Persistence and engine (P11-02)

- Add internal schema migrations for workflow instance and step rows with org ID, definition/version, encrypted-or-redacted input/output according to policy, status, attempt, schedule, lease, timestamps, and optimistic version.
- Starting a workflow transactionally creates instance/steps and an outbox wake-up event. An idempotency key returns the same instance for the same org/definition/input hash and conflicts for mismatched input.
- Worker claims runnable steps using the phase-6 lease/concurrency model. Commit each step result and unlock dependent steps atomically.
- Retry retryable errors with configured backoff; fail terminal errors. Compensation runs completed compensatable steps in reverse dependency order and records failures without pretending rollback of external effects.
- Cancellation stops new claims, signals cooperative active steps, and enters compensation according to approved policy.
- Every transition emits workflow events and progress that use existing relay/SSE/MCP mechanisms.
- Enforce tenant authorization on start/status/cancel/retry and keep the initiating Principal snapshot/actor IDs needed for audit. Define whether permissions are re-evaluated at each step.

## Surfaces and tooling (P11-03)

- Manifest advertises workflow start/status/cancel schemas without colliding with custom actions.
- Gateway, MCP, and CLI invoke workflow control actions through the standard execution path.
- Harness exposes deterministic workflow ticks and clock advancement. Inspector displays state/attempt timeline and safe step errors.
- Scaffolder includes a commented or tested example only after API stability.

## Tests and success criteria

### Contract/graph tests

- Definition rejects duplicate/invalid step names, missing dependencies, cycles, invalid retry/timeout values, schema/version errors, and action-name collisions.
- Type tests infer workflow input, step dependencies/outputs, and final output while rejecting access to unavailable step output.
- Manifest/control actions are deterministic and valid JSON Schema.

### Persistence/state-machine tests

- Start persists instance plus wake-up atomically; forced failure leaves neither. Duplicate idempotent start returns one instance; mismatched duplicate conflicts.
- Linear and diamond workflows run each eligible step, wait for dependencies, and complete once with expected output.
- Process termination after side effect but before completion causes allowed re-execution; idempotency-key fixture yields one logical external effect.
- Fake-clock retries occur exactly per policy and exhaust to failed; non-retryable error fails immediately.
- Two PostgreSQL workers never simultaneously own one step, recover expired leases, and can process independent branches concurrently.
- Cancellation before start, while waiting, and during cooperative execution reaches defined final states; no downstream step starts afterward.
- Compensation executes eligible completed steps in reverse order; compensation failure is retained/audited and does not label instance compensated.
- Every transition and step result commits atomically; restart from each state resumes without skipped or falsely completed work.

### Security/surface tests

- Cross-org status/cancel/retry is not found/forbidden per policy, including known UUID attempts and raw PostgreSQL RLS checks.
- Permission snapshot/re-evaluation follows D-02 and is tested for revoked actor permissions.
- Oversized/sensitive step outputs obey storage/redaction limits; logs, audit, inspector, and errors contain no protected values.
- CLI and official MCP client start a workflow, observe ordered progress/status, cancel it, and receive stable terminal output/errors.
- Harness tests all transitions without sleeps; inspector browser test renders malicious step text inert.

### Upgrade tests

- An instance pinned to workflow v1 finishes correctly after v2 is deployed because the deployment retains v1 until matching instances drain.
- Storage migrates from pre-workflow schema and previous workflow schema fixture without losing entity/outbox data.

Phase 11 passes only when crash-point and concurrent PostgreSQL tests demonstrate durable, resumable behavior. Phase 12 and the MVP release remain blocked until this phase passes.