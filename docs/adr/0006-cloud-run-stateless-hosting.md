# ADR 0006: Cloud Run first; stateless, sleep-capable hosted apps

- Status: Accepted for provider direction and mandatory runtime contract, by explicit user instruction in the hosting planning conversation.
- Implementation status: Not implemented or verified. Detailed service configuration, security controls, region, budgets and operational targets still require the plan's evidence gates.
- Supersedes: the AWS/Fargate-first evaluation and always-on-first/scale-to-zero-later proposals in hosting decisions HD04 and HD13. Does not supersede framework workflow semantics in ADR 0003 or GenUI gates in ADR 0005.

**Extension:** [ADR 0007](./0007-gateway-scale-to-zero.md) additionally requires verified gateway scale-to-zero capability. Permission to choose warm shared capacity does not remove that requirement.

## Context

Embody's business is hosting many small private apps. Requiring a continuously running worker for every app imposes idle compute cost and ties application correctness to process lifetime. The current host starts heartbeat/outbox/event/workflow polling loops; the gateway equates missed heartbeats with an unhealthy app. These are implementation assumptions, not product requirements.

The user decided: **apps created must be able to sleep and be stateless; Cloud Run is the first provider.**

## Accepted decisions

1. **Google Cloud Run is the first hosting provider.** Do not build an AWS provider in parallel or treat vendor selection as still open. Security/cost qualification remains required; a failed qualification blocks launch and requires review rather than silently weakening controls or changing provider.
2. **All hosted app runtimes are stateless and sleep-capable.** Correctness cannot depend on an instance's memory, writable filesystem, timers, sticky session or work continuing after an HTTP response. Business data and durable work remain stateful in external stores.
3. **Scale-to-zero is a launch requirement.** Idle apps must need no keepalive traffic or always-on replica. Minimum instances are zero for production app services and retained releases in the launch baseline. Request-driven compute is the baseline; shared trusted platform services may have measured baseline capacity.
4. **Durable work must wake sleeping apps.** Requests, events, scheduled workflow steps, retries and retained-version work all need tested wake paths. Persisting a workflow is not sufficient without external scheduling/reconciliation.
5. **App catalog/availability is independent of a live instance.** A deployed sleeping app remains discoverable and callable. Heartbeat absence cannot remove its tools or prevent its next cold request.
6. **Durable execution remains at least once.** External idempotency, transactional state, leases/fences, version pinning and authorization re-evaluation remain required. Sleep does not provide exactly-once side effects.
7. **Portability remains.** Preserve local/self-hosted operation and existing supported public contracts. A hosted request-driven execution mode is explicit; older apps needing indefinite background loops fail hosted readiness with migration guidance rather than being silently kept running.

## Implementation baseline to verify

- Cloud Run second-generation services execute isolated app instances; Cloud SQL PostgreSQL stores app state; Cloud Tasks delivers durable wake requests; Cloud Scheduler triggers bounded reconciliation; a trusted dispatcher performs scheduling without executing customer code.
- App/environment credentials remain separate. A shared dispatcher uses narrow metadata-only database access and cannot impersonate arbitrary principals from app-supplied records.
- Request-based execution performs bounded work inside an authenticated invocation, checkpoints before returning, and never assumes post-response CPU.
- Workflow versions retain artifacts/configuration and zero-minimum routable releases, not continuously running workers.
- MCP sessions and idle SSE connections terminate in a trusted gateway or reconnectable authorized progress layer, not an idle connection to every app instance.
- Builds run in isolated jobs with no production/signing credentials; exact build packaging/network controls need a real-provider test.

These are engineering selections, not independently approved service-level promises. See the [Cloud Run architecture](../hosting/CLOUD-RUN-ARCHITECTURE.md) and [mandatory sleep implementation track](../hosting/implementation-plan/09-sleep-and-stateless-execution.md).

## Consequences

- Sleep/wake/stateless tests move onto the critical path before customer beta and paid launch. The prior always-on schedule estimate must be re-estimated after the first provider/runtime spike.
- The framework needs bounded request-driven worker APIs, an external scheduling seam, and a deployability contract/tooling update.
- Cloud Tasks delivery is not the source of truth. PostgreSQL work records plus reconciliation must recover commit/enqueue gaps, task expiry and lost acknowledgments.
- A platform-level baseline cost remains: database, gateway, dispatcher/reconciler, networking, queues, logs and backups. Scale-to-zero app compute is not a zero-dollar workspace guarantee.
- Frequent schedules and active streams/work keep compute billable. Sleeping means no runtime needed while idle, not forcibly stopping useful work.
- Persistent local disks, in-memory durable sessions, daemon-style plugins, and uncheckpointed jobs longer than the supported invocation budget are not supported hosted patterns.
- No finite static checker proves arbitrary JavaScript stateless. Enforce runtime limits, inspect declared capabilities and use adversarial cold-start/replacement tests; document residual app-logic risk.

## Required verification

V19: replace every process and wipe scratch storage between operations without losing committed state or authorization.

V20: with every app at zero instances and no user traffic, deliver an event and run a delayed workflow on its pinned release; survive all commit/queue/ack crash points without lost durable work.

V21: an idle reference app actually reaches zero without keepalive traffic; catalog discovery and an idle MCP client do not wake it; wake latency, scheduler lag, connection pressure and billed instance time are measured.

Existing V01–V18 isolation, security, recovery and product requirements still apply. Approval of this ADR is not evidence that any of them pass.
