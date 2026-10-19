# Hosted durable runtime (M20)

The *durable* profile runs ADR 0004 events and ADR 0003 workflows on a hosted app that may
scale to zero. Nothing runs in the background: no worker, interval or periodic sweep. Every
write that creates work also creates a queue task, and the task wakes the app when the work is
due. The [request-only profile](./RUNTIME.md) is unchanged and stays supported.

```text
action transaction ──► outbox row / runnable step
        │                     │
        └─ before COMMIT ─► queue task (deterministic name, due time, txid)
                                   │  at the due time
                                   ▼
        Cloud Tasks ──OIDC (platform invoker, app audience)──► POST /_embody/drain
                                   │
                          one bounded batch ──► follow-up task if work remains
```

## Configuration

Wake-up tasks and the drain's authentication use the platform's shared queue adapter and task
ingress (`cloudTasksQueue`, `authenticateTask` in `@embody/host`), the same path as the M12
deployment controller ([DEPLOYMENTS](./DEPLOYMENTS.md#task-ingress-and-the-shared-queue-step-6)).

`EMBODY_HOST_PROFILE=hosted` plus `EMBODY_HOSTED_PROFILE=durable`, with every hosted setting
from [IDENTITY](./IDENTITY.md) and:

| Variable | Meaning |
|---|---|
| `EMBODY_WAKE_QUEUE` | Cloud Tasks queue, `projects/<p>/locations/<l>/queues/<q>`. |
| `EMBODY_DRAIN_URL` | This app's drain URL (HTTPS), ending `/_embody/drain`. |
| `EMBODY_DRAIN_AUDIENCE` | OIDC audience of wake tasks (HTTPS); the drain accepts no other. |
| `EMBODY_DRAIN_INVOKER_EMAIL` | The platform invoker service account; the drain accepts no other. |

Drain settings outside the durable profile are rejected. `createAppHost` accepts a `wakeQueue`
override for tests and local development; it never overrides authentication or storage.
Scaffold with `create-embody-app my-app --durable`.

## Preflight

`assertDurablePlugins` (from `@embody/core`) runs at build/preflight, host construction and
kernel boot. It allows workflows, event handlers and subscriptions, and rejects schedules,
background handlers, always-on capabilities and `init`/service factory callbacks. Workflows
must fit the [hosted limits](./WORKFLOWS.md#hosted-limits): steps within 30 seconds, delays and
retry backoff within 30 days, and at most 50 steps per workflow.

## Wake before commit (MD12)

Storage is wrapped by `wakingStorage`. Before a transaction commits it computes the tasks the
transaction needs and enqueues them:

- **Event**: every outbox event written or rescheduled for retry, due at its scheduled time.
- **Step**: every forward step this transaction made runnable (started, unblocked by a completed
  dependency, rescheduled for retry or delay). More than four in one transaction collapse into
  one **sweep** per tenant and due time; sweeps claim globally and chain while work remains.
- **Compensation**: any change to an instance's compensations gets one sweep. Compensations
  run one at a time in reverse order and the claim picks the one that may run, so cancelling
  50 steps costs one task per compensation, not one per pair.
- **Lease**: every claim (events and steps alike, including items that are not the drain's own
  task) enqueues a wake at the claim's lease expiry before the claim commits. If the drain
  dies, that wake reclaims the item. It carries no transaction ID.
- **Cleanup**: when an outbox event completes, one retention cleanup per tenant and day.

Each task name hashes the app, tenant, work item, due time and the PostgreSQL transaction ID,
so a retried enqueue in the same transaction is a duplicate the queue rejects, and two
transactions never share a name. **An enqueue failure throws and the transaction rolls back**:
the caller gets `UNAVAILABLE` and nothing is written. One action may create at most 100 tasks
(`RATE_LIMITED` beyond that). A task due beyond the queue's 30-day horizon is scheduled at the
horizon and reschedules itself when it arrives.

If a workflow step's own transaction cannot commit (for example its handler published more
events than one transaction may wake, or the queue failed), its writes roll back and the worker
records the failure in a new transaction: a deterministic scheduling failure is terminal,
anything else follows the step's retry policy. A step therefore never reruns forever.

The queue may deliver a task before its transaction is visible, or after it rolled back. The
drain asks PostgreSQL for the transaction's outcome (`txid_status`):

| Outcome | Drain answer |
|---|---|
| in progress | `503` with `Retry-After`; the queue retries |
| rolled back | `200`, nothing to do: the work never existed |
| committed, or too old to tell | process |

## The drain endpoint

`POST /_embody/drain` accepts only `Authorization: Bearer <provider OIDC token>` whose issuer
is Google, audience is `EMBODY_DRAIN_AUDIENCE` exactly, `email` is the platform invoker and
`email_verified` is true. Gateway principal tokens (`X-Gateway-Auth`) are never accepted here,
and a drain token never authorizes an action. A request for another app is rejected (`403`).
Platform-to-app ingress must still be private (Cloud Run IAM); see [IDENTITY](./IDENTITY.md).

One drain claims at most 4 events of the task's tenant and 2 workflow steps, runs them within
the 30-second step deadline, then looks at the task's own item:

- **leased** by another drain: enqueue a follow-up at the lease expiry (60 seconds, longer than
  the step deadline) in case that drain died;
- **lease expired**: enqueue a follow-up sweep;
- **not yet due** at the task's own due time: the task came early (clock skew or the 30-day
  horizon), so enqueue a follow-up at the due time and answer `200`; if the item was
  rescheduled later, a newer task exists and this one is done;
- **due but unclaimed**, a full batch, or any other claimable work still due for the tenant:
  enqueue a follow-up sweep.

Only a task whose transaction is still open is answered `503`, so no work depends on the queue's
retry ceiling for early tasks.

Follow-up names derive from the current task's name, so a retried drain never schedules one
twice. Every drain writes one structured `embody.drain` log line (task, kind, tenant, outcome,
counts, duration) without payloads.

**Recovery without a sweep (MD12).** After an authenticated action or stream, the host asks
whether this tenant has claimable work overdue by more than a minute (or a claim older than its
lease) and, if so, enqueues one sweep. Each instance checks a tenant at most once a minute; the
check is bounded to two seconds and never fails the request. A compensation waiting for a later
step is not overdue. An idle app with no requests therefore stays at zero; overdue work
with no inbound request waits for the queue's own retries.

## Delivery semantics

- **At least once.** Event handlers and steps can run again after a crash or lost lease. The
  inbox records each handler's completion in the same transaction as its writes; make external
  effects idempotent (for example keyed by `event.id` or `${workflowId}:${step}`).
- **No lost work.** Work exists only if its transaction committed, and then its task exists.
  A crash before commit leaves neither; a crash after leaves both.
- **Retries.** Events retry five times with exponential backoff (1 s base), then dead-letter
  visibly. Workflow retries follow each step's policy; each retry is a task at its retry time.
- **Generated events.** CRUD and workflow lifecycle events are written only when this app
  handles them, so writes nobody listens to never wake the app. Events published by actions
  are always written. Cross-app subscriptions arrive with the gateway relay (M21).

## Retention (ADR 0004)

Completed outbox, delivery and inbox records are kept 30 days and then deleted by cleanup
tasks; dead letters are kept until resolved. Cloud Tasks cannot schedule beyond 30 days, so a
cleanup deletes what has expired (1,000 records per batch) and schedules the next one at the
expiry of the oldest record that remains. Migration 6 adds `embody_outbox.completed_at`;
records completed before it are kept 30 days from the migration. The inbox has no tenant
column, so cleanup of inbox records is app-wide: any tenant's cleanup deletes completed inbox
rows of every tenant of the app. A completed handler's inbox row is gone after 30 days, so a
dead letter replayed later than that would rerun handlers that had already completed.

## Migrating from reference or request-only

Apply migration 6 with the maintenance identity before starting the new version. It updates
every completed outbox row and builds three indexes without `CONCURRENTLY`, so on a large
outbox it blocks writes while it runs: schedule it in a quiet window. From
request-only, switch the profile and supply the drain settings; there is no legacy work to
settle. From reference mode, stop the reference workers and settle pending outbox, delivery and
workflow work first: the durable drain only processes work that has wake tasks. Overdue
reference work is picked up by recovery once requests arrive, but do not rely on it for a
large backlog.

## Verification

`pnpm test:m20` requires the M03 PostgreSQL fixture and container. It builds, pre-migrates and
runs, with zero skips: preflight, environment, 20 cold boots with fake timers and no tasks,
drain authentication negatives, the Cloud Tasks request shape, the real PostgreSQL runtime-role
suite (wake before commit, outage rollback, early and rolled-back tasks, delayed steps, retry
backoff, compensation, quota, retention, MD12 recovery and 20 hosted `createAppHost` boots), the
crash matrix with killed child processes, the request-only regression suites and the packed
durable scaffold. Suites that claim workflow steps hold one PostgreSQL advisory lock so they
never overlap.

Crash matrix (`m20-crash-child.mjs` is killed with `SIGKILL` at each point):

| Killed | Result |
|---|---|
| before enqueue | nothing committed, no task |
| after enqueue, before commit | task drains as `rolled-back`; no outbox row, no effect |
| after commit, before any drain | the task delivers the work once |
| mid-batch, before the effect | lease follow-up; redelivered once after the lease |
| after the effect, before commit | rerun after the lease: one effect, two attempts |
| after commit, before acknowledgement | redelivery is a no-op |
| mid-step after its effect | step reruns after its lease; one effect; workflow completes |
| holding another task's step (B1) | the claim's lease wake reclaims it; workflow completes |
| mid-compensation (B2) | the claim's lease wake reclaims it; instance compensated |

Fan-out regressions: a 40-leaf fan-out completes through chained sweeps; cancelling it after
40 completions creates one task and compensates every leaf once; a step that can never commit
fails once instead of looping.

## Not yet proven

- **Real queue (M09): now qualified live** ([evidence](./evidence/M09-live-3ef5f28/README.md)): duplicate names 409 before and after execution, the 30-day horizon, 503 retries with backoff, `email`/`email_verified` in OIDC tokens, per-app queue/invoker isolation, the runtime's enqueue/actAs grants and the real adapter. The items below in this bullet remain as written for the record. M09 must qualify the
  de-duplication window, 30-day schedule limit, retry ceilings for `503` (uncommitted) answers,
  whether OIDC tokens carry `email` and `email_verified` for the invoker, audience and IAM. The app
  runtime needs `cloudtasks.tasks.create` on its own queue and `actAs` on the invoker identity;
  qualify a per-app invoker or queue so one app cannot wake another's drain (it could not make
  another app process foreign work, but could cost it wake-ups).
- **Quotas and audit with M07.** Drains do not pass through the gateway, so they appear in app
  logs, not the M07 durable audit or quota ledger. Per-app queue rate limits are queue
  configuration (M09/M12).
- **Cost.** Every claim adds a lease wake, so each item costs at least two tasks.
- **Event handler deadline.** Steps have a 30-second deadline; event handlers are bounded only
  by the PostgreSQL statement and idle-transaction timeouts. Keep handlers short.
- **Deployment admission.** `@embody/cloud-contracts` still describes `request-only-v1`; durable
  admission belongs to M11/M13, and scale-to-zero proof to M17.
