# Cloud Run hosting architecture: stateless apps, durable state, external wake-up

**Authority:** [ADR 0007](../adr/0007-cloud-run-stateless-hosting.md) records the user's accepted Cloud Run/stateless/sleep direction. This document specifies the implementation baseline; provisioning and verification have not happened. It replaces the previous always-on-first hosting approach. [ADR 0008](../adr/0008-gateway-scale-to-zero.md) additionally requires a verified gateway min-zero profile; optional warm gateway capacity remains an operational choice.

## 1. Runtime contract

> An Embody app is an isolated, disposable executor. Its data, permissions, schedules and unfinished work outlive every process that executes it.

Every hosted app must tolerate cold start, concurrent replicas, termination during an operation, and zero replicas while idle. Stateless does **not** mean no database; it means no authoritative state in a specific process.

| Allowed | Not a supported hosted dependency |
| --- | --- |
| PostgreSQL entities, transactions, outbox/inbox, workflow state and durable idempotency records | Local SQLite or filesystem as production durable storage |
| Reconstructable in-memory caches with authorization freshness limits | In-memory sessions/locks/counters required for correctness |
| Temporary scratch files whose loss is harmless | Persistent uploads on container disk |
| Bounded authenticated work invocation, persisted retries/delays | `setInterval`/cron/process uptime as the only scheduling mechanism |
| Cache initialization/schema validation during boot | Running migrations or sending business effects on every cold boot |
| A declared long operation split into checkpointed workflow steps | Unbounded detached work after returning an HTTP response |
| Bounded framework connection/timeouts and advisory timers within an invocation | Using timers/heartbeats to prevent idle scale-down |

The scaffolder, skill/docs and deployment preflight must teach this contract. Static checks flag common violations but cannot prove arbitrary code correct. Hosting readiness includes process-replacement and concurrent-replica tests; quota/timeout enforcement contains nonconforming apps.

## 2. GCP service map

| Responsibility | Initial service choice | Scope and boundary |
| --- | --- | --- |
| App execution | Cloud Run services, explicitly second-generation, request-based billing, minimum instances zero | Separate service per app/environment; immutable revisions/owned release routes; configurable bounded max instances/concurrency |
| Gateway/control API/dispatcher | Separate trusted Cloud Run services | No tenant code; independent identities; gateway must support verified min-zero; optional measured warm capacity cannot be required for correctness; never one gateway per app |
| Durable app data | Cloud SQL for PostgreSQL, regional HA for paid production | Separate database/runtime role per app/environment; platform state separated from app access |
| Work delivery | Cloud Tasks HTTP queues | Authenticated requests to trusted dispatcher; platform owns queue creation/targets/identity; app cannot enqueue arbitrary targets |
| Scheduling/reconciliation | Cloud Scheduler → trusted bounded reconciler | Initially one-minute wake cadence; discovers due/lost work without HTTP-pinging app services; resumable paging/shards |
| Image registry | Artifact Registry | Immutable admitted image digest, scoped access, signature/provenance checks |
| Source/build/export artifacts | Cloud Storage | Scoped staging and restricted final artifacts, retention and encrypted exports; managed user attachments remain separately scoped later work |
| Secret values | Secret Manager | Explicit app/environment bindings; no project-wide secret read permissions in tenant code |
| Signing/encryption | Cloud KMS | Trusted signer only; asymmetric verification keys to apps; concrete algorithm validated against provider/library |
| Customer build execution | Cloud Run Jobs in a separate build trust domain | Isolated customer install/build/config execution; staging-only credentials; no production data or platform signing authority |
| Platform CI/image assembly | Protected CI; Cloud Build where suitable | Trusted base-image/platform builds; tenant output is untrusted data, never privileged build instructions |
| Network | VPC, Direct VPC egress, firewall/controlled egress proxy and Cloud NAT where needed | Route applicable outbound traffic through enforcement; own DB and approved destinations only; account for shared fixed costs |
| Public edge | External HTTPS load balancer/serverless routing as needed, managed certificates and Cloud DNS | Trusted gateway is public entry; authenticated app ingress; separate console/customer-view site boundaries; validate header/stream handling |
| Telemetry | Cloud Logging, Monitoring, Trace and restricted audit export | Bounded tenant logs; trusted audit not writable by apps; billing export/reconciliation |

Region, login provider, exact egress design, quotas and prices remain decisions to close. Do not describe Secret Manager, a VPC, or Cloud Run's sandbox as a complete tenant security design by themselves.

**IAM:** each app/environment gets a minimally privileged service identity. Cloud Run exposes service-identity tokens via its environment; the requirement is that those tokens grant no unintended privileges, not a fictional guarantee that no metadata identity exists. No project-default broad service account. Tenant identities have no platform DB, queue management, signing, deployment or neighbor invocation authority. Validate Cloud Run ingress/IAM plus application-layer Embody identity independently; infrastructure OIDC and user/agent authorization are different layers.

## 3. Three execution paths

### Interactive request

```text
Client → trusted gateway (login/grants/catalog)
       → private authenticated app release endpoint
       → Cloud Run cold start if needed
       → bounded action → transaction/result
```

The gateway reads the deployed manifest and route from durable platform state. It does not ask the sleeping app to list tools, register or heartbeat. Authentication failure must not wake an unauthorized app. A route points to an owned release endpoint; never a customer-selected URL.

### Durable background work

```text
App transaction commits entities + work row + due metadata
       ↓ optional best-effort post-commit hint (not correctness-critical)
Trusted reconciler reads narrow due-work index/views
       ↓ persistent WakeIntent in platform DB
Queue publisher creates Cloud Task using deterministic delivery identity
       ↓ authenticated Cloud Task request
Trusted dispatcher validates intent, environment epoch, policy and release
       ↓ authenticated invocation of the selected private app release
App claims bounded work, executes, checkpoints/commits, returns
```

The dispatcher coordinates but never loads customer plugins. Durable app records remain authoritative. The app is allowed to sleep immediately after its original HTTP response; it need not finish publishing a task first.

### Due schedule while all apps sleep

Cloud Scheduler invokes the reconciler. It scans indexed pending work with narrow per-app database roles and creates/coalesces WakeIntents. The initial MVP uses a bounded sweep of provisioned app due-work views, not the unreliable assumption that an app delivered a hint before stopping. Control-plane hints accelerate discovery; an independent sweep closes missing-hint gaps. Scanner credentials expose only provisioner-owned scheduling metadata, not entity payloads or arbitrary SQL execution. Connection budgets and sweep lag are measured at the supported app count.

Schedules beyond Cloud Tasks' scheduling horizon stay in PostgreSQL until eligible. The wake system can use tasks scheduled in the near future for precision, but a missing/expired task is recovered by reconciliation. Apps never need to remain running merely to wait for a date.

## 4. Commit-to-queue correctness

There is no atomic transaction spanning an app's PostgreSQL transaction, platform PostgreSQL and Cloud Tasks. Design explicitly for this:

1. Framework work row and due/index metadata commit together in the app DB. Trusted schema defines narrow scheduling views. App-supplied metadata is untrusted; bind every observation to the connection's provisioned app/environment, validate sizes/types and enforce quotas.
2. Reconciler upserts a platform WakeIntent using a scoped work/version/generation key. Two reconcilers discovering the same work create one logical intent; batching can coalesce multiple ready rows.
3. Persist enqueue intent before calling Cloud Tasks. Deterministic task names plus durable delivery attempts handle ambiguous create responses. Provider name-deduplication windows are not the sole idempotency mechanism.
4. A delivery timeout/ACK loss may invoke the app again. Database claims/fences and external idempotency keys handle duplicates. A Cloud Tasks 2xx acknowledges that delivery, not an assertion that every workflow finished.
5. When a batch finishes or hits its budget, pending work stays visible in the source DB. Reconcile it into another invocation, with bounded exponential backoff, fairness and dead-letter/operator policy. Repair exhausted/expired transport delivery from source state; no infinite hot-loop retries.
6. Initiating identity is not trusted merely because a tenant stored it in a work row. Use verifiable invocation/delegation references and current trusted grants for cross-app/platform capabilities; retain the documented limit that malicious app code can affect its own bound data/secrets.

Restore/delete/redeploy increments an authoritative environment execution epoch as appropriate. Stale tasks, old DB bindings and stale dispatch leases cannot run against restored or deleted state. Restored workflows remain paused until the existing replay review passes.

## 5. Bounded execution and concurrency

Initial proposed limits to validate, not customer promises:

- Interactive action budget: 60 seconds. Longer work returns a durable operation ID and uses checkpointed workflow steps.
- Background invocation budget: 120 seconds, including a drain/checkpoint margin. Individual step timeout must fit the remaining budget; reject or require decomposition of non-checkpointable longer operations.
- Queue delivery/Cloud Run HTTP timeout: configured with margin above the worker budget (initial target: 180 seconds), within current provider limits. No use of Cloud Run's maximum request duration as the normal business-step budget.
- SIGTERM cleanup targets the provider grace window (currently documented as 10 seconds), but correctness must also survive immediate process loss with no cleanup.
- Start with low, measured request concurrency and explicit max instances. Per-instance connection pool × maximum simultaneously active instances/releases must fit database limits. Add trusted admission where provider scaling limits are not hard capacity fences.

Workers claim only runnable work for their app/environment/release with lease/fence checks. A timeout does not prove an external effect failed; use stable idempotency keys or surface an unknown outcome. CPU throttling after a response must not strand necessary in-process work. The platform dispatcher/reconciler itself runs bounded HTTP invocations with persisted cursors; no hidden dependency on a perpetual polling process in request-based Cloud Run.

## 6. Release identity, sleeping state and streams

- Active release and workflow release may differ. Cloud Run revisions/revision routes (for example protected tags) must support immutable version routing, authentication and min-zero behavior; verify provider retention/quotas rather than assuming old revisions live forever.
- Retain artifact, manifest, required secret/config references and a recoverable route for live old-version work. Keep old release instances at zero when idle. Retention costs include artifacts/control metadata and executions, not a mandatory always-on worker.
- Hosted app status distinguishes **deployed/idle**, **executing**, **failed**, **paused**, **deleted**. Zero instances is not a health failure. Cloud Run controls idle retirement; Embody does not promise an exact idle eviction time.
- MCP sessions terminate at the trusted gateway. Discovery reads persisted manifests. An idle MCP connection must not hold a downstream app connection open.
- Long-operation progress is persisted with operation IDs/cursors and served by authorized platform reads/streams. Ephemeral live action progress may flow while the action is running, but idle app streams are bounded/closed. Reconnection must not re-execute mutations.
- Gateway streams still consume platform resources and are metered/limited; moving them is not a claim that streaming is free.

### Gateway scale-to-zero contract

The gateway is also a disposable request handler. With no active requests/connections, a min-zero profile must reach actual zero and cold-start on the next request. Local caches may disappear; registry/catalog, grants, quota counters, committed audit intent and required logical sessions/progress cannot disappear with them. Cold startup performs bounded lazy loading, not migrations, global app scans or heartbeat waits, and fails closed when authoritative state is unavailable.

MCP must use a tested stateless HTTP mode where compatible, or reconstructable logical sessions/protocol-correct expiry and reinitialization. Persisting live SDK transport/server/socket objects is not a solution. Session affinity is optional, never necessary for correctness. After response loss, session recovery observes a durable operation ID; mutations are not blindly resubmitted.

An open SSE/MCP stream is active traffic and may keep the gateway running. Define and test idle-stream closure/reconnect policies without cancelling useful work just to force zero. Some clients immediately reconnect or poll: disclose that active-capacity behavior, and validate a designated sleep-compatible client/transport mode. No claim that a live socket survives zero serving instances or that every client reconnects seamlessly.

Cloud Tasks/Scheduler/reconciliation/audit delivery remain independent of gateway process lifetime. Scheduled app work must continue while gateway is zero. Use provider metrics rather than constant public endpoint probes for idle observation; production synthetic requests themselves count as traffic and their cost/frequency must be explicit.

Test gateway-only cold, app-only cold and both-cold separately from an external client. An operator may keep a gateway warm for latency, but the same release still must pass the zero-capacity tests. See CH9-07/V22; capability is mandatory, zero during continuous traffic is not.

## 7. Security and build implications

Scale-to-zero is not a substitute for isolation. Retain all existing runtime, database, egress, key custody, audit and preview protections. Hardening knobs differ on Cloud Run: where exact writable-root/process-count controls are unavailable, record a reviewed equivalent containment control and limit; do not claim unsupported flags are configured. No unreviewed weakening of tenant boundaries.

Customer install/config code executes in isolated Cloud Run build jobs, not in a privileged shared Cloud Build pipeline. Initial packaging approach: a pinned supported Node build recipe produces a bounded app bundle; a trusted packager validates/extracts it and assembles an OCI artifact with the fixed runtime base without executing tenant output. Prove compatibility, sandbox/network rules, extraction safety and registry permissions in CH1-03/CH4-03. If this cannot be delivered safely, the build design is blocked, not silently given privileged Docker access.

## 8. Verification and delivery

See [verification V19–V22](./implementation-plan/00-VERIFICATION.md) and [CH9-01…07](./implementation-plan/09-sleep-and-stateless-execution.md).

New mandatory proofs:

1. Kill every app instance between create/read/update; committed data and authorized behavior stay correct.
2. Reach real zero instances; invoke from browser/CLI/MCP; record cold readiness and app instance identity.
3. Reach zero, commit pending/due work, then run it with no user traffic or app polling; inject failure between every commit/enqueue/ack boundary.
4. Deploy v2 while v1 workflow sleeps; wake exactly the eligible v1 worker, then scale it back down.
5. Hold an idle MCP session and run catalog discovery without waking app runtimes.
6. Run concurrent requests/wakes and validate claims, DB connection budgets and no unauthorized duplicate effects.
7. Restore/delete while stale tasks exist; no stale execution against the new epoch.
8. Measure app billed instance time, wake/queue/scanner cost and shared baseline at 10/100/1,000 modeled apps; no assertion of zero total cost when apps sleep.
9. Let gateway reach actual zero, cold-start HTTP/CLI/MCP, preserve quotas/audit/grants, safely recover sessions without mutation replay, and execute scheduled app work while gateway remains zero. Test idle closure without reconnect storms and separately preserve useful active work.

**First working slice:** Kanban on Cloud Run, min instances zero, no hosted heartbeat/poll loops, durable catalog, private request wake, and data surviving replacement. **Second slice:** Email/outbox plus one delayed workflow wakes from zero through Cloud Tasks/reconciliation, including the commit/enqueue crash test. These precede full console polish.

## Provider references to revalidate during implementation

- [Execution environments](https://docs.cloud.google.com/run/docs/about-execution-environments)
- [Billing and CPU allocation](https://docs.cloud.google.com/run/docs/configuring/billing-settings)
- [Container lifecycle contract](https://docs.cloud.google.com/run/docs/container-contract)
- [Direct VPC egress](https://docs.cloud.google.com/run/docs/configuring/vpc-direct-vpc)
- [Cloud Tasks HTTP targets](https://docs.cloud.google.com/tasks/docs/creating-http-target-tasks)
- [Cloud Tasks limits](https://docs.cloud.google.com/tasks/docs/quotas)
