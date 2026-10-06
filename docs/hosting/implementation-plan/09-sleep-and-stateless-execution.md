# 09 — Mandatory Cloud Run sleep and stateless execution

**This is a launch-critical parallel track, not post-launch work.** The number preserves existing task IDs; implement early slices alongside phases 2–5. [ADR 0006](../../adr/0006-cloud-run-stateless-hosting.md) supersedes always-on-first hosting. [ADR 0007](../../adr/0007-gateway-scale-to-zero.md) additionally requires gateway scale-to-zero capability. Read the [architecture](../CLOUD-RUN-ARCHITECTURE.md) and [V19–V22 verification](./00-VERIFICATION.md) first.

## CH9-01 — Stateless hosted runtime and bounded worker invocation

**Verification first:** a fresh process with empty scratch space handles each successive request correctly; no app registration/heartbeat/outbox/workflow polling is required while idle; no required work continues after the response. Existing self-hosted mode still works. Invariants: V06, V10, V17, V19. Boundaries: L2/L3; Cloud Run confirmation CH9-06.

**Dependencies:** CH1-04, CH2-04, CH3-02. **Areas:** host/events/workflows APIs, runtime contracts, scaffolder/skill/docs.

**Implementation steps:**
1. Introduce explicit hosted request-driven execution mode. Separate kernel boot/readiness from `start()` behavior that launches heartbeat and interval workers. Keep local/self-hosted polling mode explicit and compatible.
2. Extend `tickEvents()` / `tickWorkflows()` into bounded claim/execute/checkpoint APIs accepting deadline, work selector/release, maximum items and cancellation. Do not expose a generally callable privileged tick route.
3. Define persistent idempotency and lease/fence contracts; close/release work within budget or let a crashed lease expire safely. App business initialization must not perform migrations or irreversible effects on cold boot.
4. Implement invocation admission and cooperative drain with provider grace handling, but prove abrupt termination recovery without SIGTERM. Request completion means required state is committed; no detached business promises.
5. Update scaffolded apps, reference apps, agent skill and guidance: durable storage, no local persistent production state, no session affinity, no app-owned scheduling loops. Add a runtime compatibility manifest/preflight and migration guidance for old apps.

**Acceptance cases:** `.a` replace process/wipe scratch between CRUD/actions and compare durable checksums; `.b` cold start 20 concurrent replicas and prove boot does not duplicate business effects/migrations; `.c` request ends and CPU stops immediately, committed work is still recoverable; `.d` worker respects batch/deadline with leases and no claim after drain; `.e` hosted mode creates no recurring app heartbeat/poll timers while self-hosted regression passes; `.f` deliberately filesystem/in-memory-dependent fixture fails conformance with useful diagnostics.

**Evidence:** built host contract tests, concurrent real-DB tests, timer/boot assertions, scaffold/skill checks and compatibility report. Static lint alone does not certify arbitrary app code stateless.

## CH9-02 — Durable due-work metadata and lossless wake intents

**Verification first:** kill the app immediately after a committed event/schedule and before any hint/enqueue; trusted reconciliation still discovers and schedules it. Duplicate scans create one logical wake intent; no app-supplied metadata can schedule another tenant's work. Invariants: V01, V06, V10, V20. Boundaries: L2/L3.

**Dependencies:** CH1-04, CH3-02, CH9-01. **Areas:** storage migrations/adapters, platform scheduler repositories, narrow scanner credentials.

**Implementation steps:**
1. Add transactional due-work metadata/indexes/views for events, delivery retries and workflow schedules, including app-bound work ID, definition/release, due time, attempt generation, state and lease expiry. Update metadata with work mutations in the same app DB transaction.
2. Provision trusted scanner roles with only required metadata reads, no app entity/secrets access. Never run app queries/plugins in the dispatcher; use fixed validated SQL and bind resource identity from provisioning, not row claims.
3. Define durable platform WakeIntent/delivery-attempt state and uniqueness scope. Persist intent before provider enqueue; retain work/release/environment epoch and reason, not sensitive action payloads.
4. Implement bounded indexed sweep across provisioned apps with persisted cursors, fair scheduling, connection budget and oldest-unscanned/due-lag metrics. Best-effort hints only accelerate the independent completeness sweep.
5. Coalesce ready work, recover expired leases/missing tasks, respect paused/deleted environments and budget/backoff/dead-letter policy. Future due times beyond provider limits remain in source state.

**Acceptance cases:** `.a` crash before transaction commit yields no work; crash just after commit with no hint still yields intent; `.b` two reconcilers and duplicated hints yield one logical intent/eligible work set; `.c` scanner cannot read entity canaries or modify app data; `.d` hostile row/ID/size/due-time flood cannot wake W2 or starve a normal app; `.e` expired lease/lost transport task becomes eligible again without false successful completion; `.f` paginated scan restart has no permanent gap and meets declared coverage lag under connection limits.

**Evidence:** real SQL/role/concurrency/failure tests, source-to-intent conservation counts and approved scheduling-view schema. PostgreSQL → platform DB → queue is explicitly not one atomic transaction.

## CH9-03 — Cloud Tasks delivery and external scheduler

**Verification first:** with all app instances at zero, Cloud Scheduler/reconciler plus Cloud Tasks causes pending/due work to execute; task creation timeout, duplicate delivery, ACK loss and dispatcher replacement cannot lose work or expand authorization. Invariants: V02, V03, V10, V20. Boundaries: L2/L4.

**Dependencies:** CH9-01/02, CH2-03/04, CH3-03, CH5-02. **Areas:** Cloud Tasks/Scheduler IaC/adapters, trusted dispatcher and private app invocation.

**Implementation steps:**
1. Provision authenticated Scheduler→reconciler and Tasks→dispatcher paths with dedicated minimal service accounts, exact audience and no customer queue/invocation management permissions. Validate resource ownership separately from GCP OIDC.
2. Implement durable queue publisher with deterministic delivery identity, ambiguous-create recovery and retry/backoff. Store provider attempt IDs without relying on finite task-name deduplication as business idempotency.
3. Dispatcher validates current intent/epoch/release, authority, pause/budget state and provenance of initiating identity; then invokes a provisioner-owned private release endpoint with app-specific identity. Tenant payloads cannot choose endpoints or mint principals.
4. Execute bounded app batch within documented handler/Cloud Tasks/Cloud Run deadlines; acknowledge a delivery only after known durable outcome or recorded retry/failure decision. Remaining work stays discoverable.
5. Invoke reconciler at initial one-minute cadence with resumable bounded batches. No post-response publisher thread or immortal platform polling loop required. Repair queue expiration/retry exhaustion and missed hints from source DB state.
6. Configure fairness and global/per-app concurrency limits; alert on backlog and persistent failures, not automatic unlimited retries. Register provider schedule/deadline quotas in configuration validation.

**Acceptance cases:** `.a` real request-free event and delayed workflow wake app from zero; `.b` crash after intent/before create, after create/before receipt, after effect/before ACK and replace dispatcher; no lost committed work and idempotent test effect ledger; `.c` spoofed OIDC, wrong task/app/epoch/audience and arbitrary endpoint reject; `.d` task scheduled beyond allowed horizon remains durable and dispatches when eligible; `.e` queue/DB outage leaves recoverable backlog, then catches up without a wake storm; `.f` revoked actor/subscription/pause denies new execution even for previously enqueued tasks.

**Evidence:** real Tasks/Scheduler delivery logs correlated to durable records and external receipts, IAM negatives, crash matrix and queue-cost/lag report. A forged Cloud Tasks header must never be treated as authentication.

## CH9-04 — Durable sleeping catalog and gateway-owned sessions

**Verification first:** discovering tools or holding an idle MCP session does not wake app instances; invoking an allowed action wakes the correct release; zero replicas is not unhealthy. Gateway reconnect/replacement preserves identity and does not replay mutations. Invariants: V03, V12, V13, V19, V21. Boundaries: L3/L4.

**Dependencies:** CH2-03/05, CH5-05, CH9-01. **Areas:** gateway registry, MCP/HTTP/SSE adapters, progress persistence and console app status.

**Implementation steps:**
1. Publish deployment-owned immutable manifests/routes independent of app heartbeats. Define deployed/idle/executing/failed/paused/deleted states and fail status from provider/operation evidence, not lack of active instances.
2. Route through authenticated stable or version-pinned Cloud Run endpoints without pre-call heartbeat requirement; unauthorized discovery/calls fail before app wake.
3. Terminate MCP client sessions at gateway, using shared durable or reconstructable session state. No open idle connection per app and no periodic app ping to retain a catalog.
4. Add durable operation status/progress cursors with bounded retention and authorization; long jobs return operation IDs. Serve reconnectable progress from trusted platform interfaces without requiring app process affinity.
5. Bound/close downstream action streams on completion/timeout; allow client-gateway streams only under policy and cost limits. Reconnect resumes observation, not execution. Handle proxy/provider timeout deliberately.

**Acceptance cases:** `.a` all apps at zero, repeated global/scoped discovery gives correct authorized catalog and no new app executions; `.b` idle MCP session for 30 minutes plus health checks does not wake/pin apps; `.c` one allowed call cold-wakes only target app, denied call wakes none; `.d` kill gateway/app and resume operation progress under same identity without duplicate mutation; `.e` revoked observer loses new output within V03 deadline; `.f` sleeping app remains visible while failed/paused state prevents inappropriate admission.

**Evidence:** instance metrics, invocation logs, official MCP/browser/CLI tests, durable progress/session access matrix and cold-call traces. Gateway streaming cost remains part of platform cost.

## CH9-05 — Versioned wake, restore epochs and deployment compatibility

**Verification first:** a v1 workflow that sleeps through v2 deployment wakes the correct eligible v1 release; stale tasks after restore/delete/cancel cannot execute against replacement state. Old releases have no mandatory idle instances. Invariants: V07, V10, V11, V20, V21. Boundaries: L2/L3/L4.

**Dependencies:** CH9-03/04, CH5-04, CH7-01/02/03. **Areas:** release routes/retention, workflow scheduler, restore/delete fences and task cleanup.

**Implementation steps:**
1. Persist runnable release/definition references and environment execution epochs. Pin wake to compatible release instead of current active HTTP route; validate immutable endpoint ownership.
2. Prove Cloud Run revision/route retention and authentication under min-zero; preserve referenced releases or safely recreate from admitted artifacts/config. Respect provider revision/tag/service quotas and cap retained versions explicitly.
3. Invalidate/fence task dispatch during restore/delete and release cancellation. Old DB credentials/connections and old epoch must not mutate new authoritative binding; queue deletion alone is not sufficient fencing.
4. Keep restored work paused pending replay review; intentionally reissue eligible work with new epoch and stable external idempotency semantics.
5. Garbage collect only unreferenced artifacts/routes/wake intents; do not keep a runtime warm solely because a dormant workflow references it. Expose storage/version cost and blocked secret versions.

**Acceptance cases:** `.a` sleep v1, deploy v2, new calls use v2 and old workflow wake uses v1; `.b` invalid/revoked old release secret surfaces a durable blocked state rather than falling through to v2; `.c` task in flight at restore/delete with lost cancellation notification is rejected by epoch/fence; `.d` restored external effects remain disabled until approved; `.e` GC race preserves runnable version reference and both versions return to zero when idle; `.f` exhausting retained-version quota rejects/pauses safely, never silently deletes active work.

**Evidence:** real revision/wake traces, external receipts, restore race matrix, retention quota test and inventory proving no min-one retained runtimes.

## CH9-06 — Stateless/sleep conformance, cost and launch evidence

**Verification first:** the exact candidate meets V19–V22 with real app/gateway zero-instance intervals, spontaneous due-work wake, process replacement and measured costs. No keepalive/hidden always-on correctness dependency is accepted. Invariants: V01–V22, especially V19–V22. Boundaries: L3/L4/L5.

**Dependencies:** CH9-01…05, CH9-07, CH6-02/03/04, CH7-05; final billing reconciliation joins CH8-01/02. **Areas:** cloud acceptance/fixtures, deployment preflight, runtime documentation and evidence.

**Implementation steps:**
1. Implement `cloud:test:sleep` suite selecting cold CRUD, event, delayed workflow, retry, versioned release, MCP idle, preview, restored-app and gateway-zero/session-recovery scenarios. Include known-bad local-state/daemon fixtures.
2. Run ≥100 controlled cold replacement/wake cycles for supported reference apps and failure injection at each commit/queue/ack boundary; measure logical work conservation and forbidden effect absence.
3. Observe natural min-zero behavior without external app probes; separate provider idle-retention time from actual billed execution. Validate cold-call/wake-lag targets and shared DB connection/admission envelope.
4. Model 10/100/1,000 apps using measured per-invocation/startup/queue/scanner/DB/network/gateway cost; do not treat free tier as a per-app allowance or claim sleeping database/network is free.
5. Make stateless/sleep compatibility a hosted deploy/release gate; update scaffolder/agent guidance and reject incompatible daemon/persistent-disk requirements with migration help. Test arbitrary app behaviors only to the extent promised; disclose limits of static analysis.
6. Attach exact artifacts/IaC/evidence to G2/G3 review. Any proposal for always-on app capacity or task-budget exception must preserve sleep correctness and be a new explicit product decision.

**Acceptance cases:** `.a` cold/wake protocol completes with no lost committed work or unauthenticated execution; `.b` no runtime-owned recurring wake or MCP pinning in idle observation; `.c` bad fixtures fail preflight/conformance while references pass; `.d` effective service/revision min instances are zero and billed active durations agree with workloads within declared metering tolerance; `.e` backlog/fairness/DB limits hold at supported app-count load, not only one app; `.f` candidate evidence checker rejects missing V19/V20/V21/V22 or mock-only scale-to-zero proof.

**Evidence:** provider instance/billing traces, conformance/fault reports, cost worksheet, workload limits and review. This is a mandatory launch gate, not a cost optimization that can be skipped.

## CH9-07 — Gateway zero capacity and cold session recovery

**Verification first:** the gateway reaches zero with no active requests/connections, then serves an authenticated HTTP/CLI/MCP request correctly from a fresh instance. Quotas, committed audit intent, authorization and logical operation state survive. Reconnect never implicitly repeats a mutation. Invariants: V02, V03, V13, V14, V17, V22. Boundaries: L2/L3/L4.

**Dependencies:** CH5-05, CH9-03/04; completes before CH9-06. **Areas:** gateway/MCP adapters, durable collaborators, Cloud Run gateway IaC, client compatibility fixtures and monitoring configuration.

**Implementation steps:**
1. Add a supported request-based, min-zero gateway profile. Inspect effective service/revision settings and remove mandatory warm-instance assumptions. Optional operator-selected warm capacity changes latency/cost, not correctness or qualification requirements.
2. Finish externalization of registry/catalog, grants/revisions, shared quota counters, committed audit intent and necessary session/progress metadata. Startup loads request-scoped state lazily; no migrations, all-app scan, registration wait or business polling loop. Cold cache/store failure fails closed.
3. Decide and record the MCP lifecycle against the pinned SDK and supported clients: prefer stateless HTTP where compatible; otherwise persist reconstructable logical state or use protocol-correct expiry/reinitialization. Do not serialize SDK transports/sockets or depend on sticky routing. Authentication and app scope are checked on every request/resume.
4. Define bounded idle-stream, cursor retention and reconnection behavior. Use normal responses when streaming is unnecessary. Distinguish active work/observation from idle keepalives; do not cancel useful work solely to force zero. Test clients that immediately reconnect and disclose their active-capacity behavior rather than promising they let the gateway sleep.
5. Make operation IDs/idempotency durable through disconnects and fresh sessions. Reconnect resumes status/progress; automatic mutation retry requires a verified durable idempotency contract. Unknown outcomes are surfaced safely.
6. Keep Scheduler/Tasks/reconciliation/audit delivery outside gateway-owned loops. Monitoring uses provider metrics or isolated test windows instead of public-endpoint pings that keep this profile warm; scheduled app work must continue while gateway remains zero.
7. Measure gateway-only and gateway+app cold requests from the external client, including login/token validation, shared-state connections and MCP reinitialization. Bound startup connection storms; validate optional warm profile with the same security/session semantics.

**Acceptance cases:**
- `.a` observe actual zero gateway instances with effective minimum zero; next HTTP/packed CLI/MCP call succeeds using a new process, with no app registration prerequisite.
- `.b` cold catalog read returns only authorized tools and wakes no apps; both-cold action wakes only the intended app and meets the declared end-to-end reference budget.
- `.c` prefill quota counters and committed audit intent, terminate gateway before sink delivery, then cold-start: quota is not reset and separate delivery recovers the audit record. Revoke a grant while gateway is asleep; first cold request is denied.
- `.d` replace the instance between MCP initialization/list/call/status requests: supported client reinitializes or resumes per declared contract, cannot swap actor/app scope, and observes one logical mutation in the effect ledger after an ambiguous response.
- `.e` designated sleep-compatible client closes/quiesces idle streams without a platform-induced reconnect loop; gateway eventually reaches zero. Separate active-operation/stream fixture completes or follows documented timeout/resume semantics without being killed solely for scale-down.
- `.f` no client traffic: due event/workflow executes via separate dispatcher while gateway stays at zero; health/maintenance/audit schedules do not wake it accidentally.
- `.g` authoritative policy/registry/quota store unavailable during cold start yields safe unavailable/denied response without unauthorized dispatch or quota bypass; recovery works without manual instance seeding.
- `.h` inspect min-zero and optional warm profiles, run concurrent fresh instances, and prove the same identity, session, quota and idempotency guarantees without affinity.

**Evidence:** real Cloud Run zero-instance/first-request traces, client-by-client session/idle-connection matrix, durable state/effect receipts, cold latency distributions, store-outage tests and monitoring/IaC review. Configuration-only or restart-only evidence cannot satisfy V22. Gateway capability is mandatory before launch; zero during active traffic and universal seamless MCP reconnection are not promised.
