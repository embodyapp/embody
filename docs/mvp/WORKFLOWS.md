# Durable workflows for hosted apps (M19)

Workflows follow [ADR 0003](../adr/0003-durable-workflows.md): versioned step graphs whose
inputs, outputs, attempts and schedules live in PostgreSQL. M19 closes the framework engine
gates (P11-02, P11-03) so workflows run correctly under the least-privilege runtime role.
Queue-woken hosted execution is M20; until then the reference-mode worker drives steps and the
request-only profile still rejects workflows.

## Contract

- **At least once.** A step can run again after a crash, a lost lease or a timeout. Make every
  external effect idempotent, for example with `${context.workflowId}:${step}` as the provider's
  idempotency key. The engine never claims an effect happened exactly once.
- **One owner at a time.** A worker claims a step, then locks it and checks that it still owns
  that claim (worker ID and attempt) before running it. A worker whose lease expired cannot
  process or record the step after another worker took it over.
- **Dependencies.** A step becomes runnable once all of its dependencies have completed. Claims
  re-check blocked steps, so two branches finishing at the same moment still release their join.
- **Retries.** A failing step retries per its `retry` policy, waiting `2^(attempt-1) × backoffMs`
  measured on the worker clock. `NonRetryableWorkflowError` and revoked permissions fail at once.
- **Start, status, cancel, retry** are generated actions (`<plugin>.<workflow>.start` and so on),
  authorized and tenant-scoped like any other action.

## Cancellation and compensation

- Cancelling stops all steps that have not started; **no step starts after a cancellation
  commits**, including a step already claimed but not yet running.
- A running step is signalled through `context.signal` (checked about once a second). The worker
  waits for the handler to settle before recording anything, so a late write can never escape the
  step's transaction. Cancellation is cooperative: it does not kill code.
- A step that finishes despite cancellation has done its effect, so it is compensated.
- Completed compensatable steps are compensated **in reverse order**: a compensation waits until
  every later step has settled. A step left running by a dead worker is settled after its lease:
  compensated if compensatable (its effect may have happened), otherwise cancelled.
- While steps are still settling, the instance keeps its status with `cancelRequested: true`. It
  then becomes `compensating`, and finally `compensated` (if anything was undone) or `cancelled`.
- A failed compensation leaves the instance `failed`. **Retry** retries the compensation (the
  cancellation stays requested); it never resumes forward steps.

## Runtime-role claims

The runtime role has no `BYPASSRLS`, and row-level security shows each transaction only its own
tenant's rows. A worker serves every tenant of its app, so it claims through one narrowly granted
function instead:

- `embody_claim_workflow_steps(now, expired, limit, worker)` is `SECURITY DEFINER`, owned by the
  migration role, with `EXECUTE` revoked from `PUBLIC`. It only claims due steps and returns
  `(step_id, step_org_id, step_attempt)`: no input, output or principal.
- The worker then processes each claim in that tenant's own transaction, under RLS.
- `embody_active_workflow_versions()` returns `(definition, version, instances)` for instances
  that are running or retryable (`failed` counts: it can be retried). Deployment (M13) uses it to
  refuse a release that would drop a version still in use.

Grant `EXECUTE` on every entry of `STORAGE_RUNTIME_FUNCTIONS` (exported by `@embody/storage`)
to the runtime role after migrating; `scripts/prepare-postgres.mjs` shows how.

## Hosted limits

`assertHostedWorkflowLimits` (exported by `@embody/core`) rejects definitions the hosted profile
cannot run, with a message saying what to change:

| Limit | Value | Why |
|---|---|---|
| Step `timeoutMs` | ≤ 30 000 ms | A step runs within one bounded request (the action deadline). Steps without `timeoutMs` are capped by the worker's `stepDeadlineMs`. |
| Step `delayMs` | ≤ 30 days | One queue task can wait at most 30 days. |
| Retry backoff before the last attempt | ≤ 30 days | Same queue limit. |

The hosted durable profile (M20) will call this check at preflight and set `stepDeadlineMs`.

## CLI and MCP

```sh
embody orders fulfil start --json <<< '{"input":{"orderId":"42"},"idempotencyKey":"order-42"}'
embody orders fulfil status <id>
embody orders fulfil cancel <id>
embody orders fulfil retry <id>
```

The CLI resolves `<workflow> <operation>` before single-word actions, so two workflows in one app
never shadow each other's `start`. Over MCP the same actions appear as tools ending in
`_<workflow>_start`, `_status`, `_cancel` and `_retry`.

## Verification

`pnpm test:m19` (see [TESTING](./TESTING.md)) runs on the disposable PostgreSQL fixture with zero
skips: runtime-role claims and grants, a crash matrix that kills real worker processes after the
claim, before and after the effect, after recording completion and during compensation, lease
fencing, concurrent joins, cancellation at each stage, compensation order and retry, worker-clock
backoff, exact active versions, limit validation, and the packed CLI plus official MCP client
journey through a real gateway.
