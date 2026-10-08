# 00 — Verification contract (read first)

## What verification means

**Verification is reproducible evidence that an observable requirement holds across its real trust boundary, including denial and failure cases.** Code existing, a successful demo, a mocked provider call, or a checked box is not verification.

For each work item define, before implementation:

1. **Invariant:** the behavior that must always hold and the assets it protects.
2. **Fixture and preconditions:** identities, data, infrastructure, software versions and initial state.
3. **Stimulus:** the public operation, malicious input, concurrent operation or injected failure.
4. **Oracle:** exact observable result, including state that must *not* change. Use durable queries, authenticated APIs, external effect receipts and infrastructure evidence—not only log text.
5. **Test boundary:** unit, real database, protocol, browser, distributed system or real cloud.
6. **Evidence:** command, source/artifact/configuration digests, environment, test results and reviewer.

Example: “App A cannot access B” is incomplete. A verifiable statement is: “From an isolated runtime using A's actual database credential, connecting to B's database is denied; changing `app.current_org` does not change that; B's canary rows are unchanged; the same runtime successfully reads its own canary, proving the test did not merely lose connectivity.”

This contract precedes the implementation steps in this directory. Task-specific criteria add to it; they do not replace it. [ADR 0007](../../adr/0007-cloud-run-stateless-hosting.md) makes Cloud Run, stateless execution and scale-to-zero mandatory at launch; V19–V21 cannot be deferred. [ADR 0008](../../adr/0008-gateway-scale-to-zero.md) adds mandatory gateway scale-to-zero capability and V22; optional warm capacity cannot replace min-zero verification.

## 1. Required fixture topology

Build a reusable fixture with unique resource names per run:

- Workspace **W1**: owner O1, developer D1, member U1, billing administrator B1, scoped agent A1, revoked agent R1.
- Workspace **W2**: owner O2 and app X, deliberately using the same display app slug as W1's app.
- W1 apps **K** (Kanban), **E** (Email, recording provider), **M** (malicious app), plus a preview of K.
- K releases **v1**, **v2-compatible**, **v3-incompatible**, **unhealthy**, and **workflow-v1/v2**.
- Distinct canary secrets and rows in every app/environment; no real customer data or real email recipients.
- Controlled HTTPS integration sink with a durable receipt ledger and idempotency keys; forbidden private destinations and minimally privileged metadata-identity probes; malicious DNS/redirect endpoint in an owned test network.
- At least two gateway replicas, two controller workers, real PostgreSQL and the selected production network policy in cloud tests.
- OIDC/JWKS, Git and billing local protocol fixtures for deterministic CI; separate provider sandboxes for real integration evidence.
- Cloud Run min-zero services/revision routes, real Cloud Tasks/Scheduler, due-work scanner and gateway-only idle MCP sessions; capture instance identity/count and billing metrics.
- Known-bad fixtures requiring local disk, in-memory sessions, detached promises or polling to make progress; commit/enqueue/ACK failure barriers and stale restore-epoch tasks.
- Min-zero gateway profile with durable quotas/audit/session fixtures; gateway-only cold and gateway+app cold cases; sleep-compatible and persistent-stream MCP clients; separate dispatcher runs while gateway is zero.

The hostile app probes raw sockets, DNS, subprocesses, environment/filesystem, SQL, identity replay, registration, artifact access and resource limits. Run destructive/load/security tests only in explicitly authorized disposable infrastructure. These tests prove specified controls, not the absence of all possible VM/kernel vulnerabilities; provider assurance and independent review remain necessary.

## 2. Verification layers

| Layer | Purpose | Required real boundary | What cannot be claimed |
| --- | --- | --- | --- |
| L0: Static/contracts | Schemas, dependency direction, API versions, IaC policy | Built schemas/artifacts and plan output | Runtime isolation |
| L1: Unit/property | Policy intersections, state machines, accounting arithmetic | Production pure functions; seeded property tests | SQL concurrency, IAM or network behavior |
| L2: Integration | Transactions, leases, migrations, auth adapters | Real supported PostgreSQL, HTTP server, filesystem | Cloud provider semantics |
| L3: Distributed/browser | CLI/MCP/HTTP/browser parity, restart behavior | Built services, real browser and protocol clients | VM isolation or provider PITR |
| L4: Cloud acceptance | Runtime/build containment, IAM, network, secrets, restore | Same IaC modules/runtime class as production in disposable account/project | Every possible escape or regional recovery |
| L5: Operational/human | Incident response, independent review, usability, legal readiness | Timed drills and named accountable reviewers | Automated certification of legal/commercial judgment |

Use mocks only at owned seams for deterministic fault injection. Every security-sensitive provider adapter needs L4 evidence. SQL constraints, RLS and role restrictions need real PostgreSQL, never a mocked query client.

### Test-first execution

For each behavior: add a failing public-boundary test; verify it fails for the intended reason; implement the smallest working slice; run it green; refactor with tests passing. Alternate tests and implementation rather than writing a large implementation first. Record the initial failing command and final passing command. Documentation/review-only tasks use a predefined review checklist rather than an invented red test.

Use fake clocks for owned expiry/retry logic, explicit worker ticks and fault barriers for concurrency, and bounded readiness polling for real systems. Do not use arbitrary sleeps as synchronization. Real elapsed-time measurements are appropriate for cloud startup, revocation and recovery objectives.

## 3. Release-blocking invariant catalog

These IDs are permanent references for tests, task evidence and launch sign-off. Every negative test needs a positive control showing the allowed operation works.

| ID | Invariant and decisive verification | Minimum layer |
| --- | --- | --- |
| V01 | Resource isolation: cross-workspace reads/writes/listing, guessed IDs, exports, registry and same-slug apps cannot disclose or change another resource; checksums unchanged | L2, L3 |
| V02 | Identity integrity: wrong issuer/audience/environment, expired token, unknown key, algorithm substitution and host-minted token rejected; valid issuer succeeds | L2, L3, L4 key custody |
| V03 | Authorization/revocation: all surfaces use grant intersection; no undeclared action access; new calls and new stream output denied within 30 seconds after durable revocation | L2, L3, L4 |
| V04 | Build isolation: hostile install/config/archive cannot obtain production/control-plane credentials, modify another build or publish/promote arbitrary artifacts | L2, L4 |
| V05 | Runtime/egress isolation: hostile app cannot reach other apps or unapproved destinations, and metadata-issued identity has no unintended privileges; raw sockets/DNS/IPv6 cannot bypass approved controls; resource caps contain exhaustion | L4 |
| V06 | Storage privilege: actual runtime credential cannot connect to another app DB, assume migration roles, disable protected RLS or access control-plane data | L2, L4 |
| V07 | Deployment safety: crashes/duplicate tasks/concurrent promotion/cancel/revoke leave at most one active route generation and preserve healthy release on failure | L2, L3, L4 |
| V08 | Artifact trust: source/config/manifest/digest bound; forged, mutated or unapproved artifact rejected; tenant has no signing authority | L2, L4 |
| V09 | Preview separation: production secrets/data/egress/credentials absent; untrusted Git changes cannot acquire them; expiry cleans resources | L3, L4 |
| V10 | Durable work: committed work survives crash; retries are bounded; effects use idempotency; version retention and revocation/cancellation prevent unauthorized new claims | L2, L3, L4 |
| V11 | Recovery: timed app restore preserves unrelated DBs, fences old writers, disables effects and proves declared recovery point | L4, L5 |
| V12 | Browser safety: hostile views cannot access console cookies/tokens or other-app results; cache, CSP and messaging boundaries hold; permitted actions work | L3 |
| V13 | Gateway availability: restart/failover preserves durable routing, quotas and authorization; MCP reconnection does not broaden identity or duplicate mutations silently | L3, L4 |
| V14 | Secrets/audit: credentials scoped and rotated, logs bounded/redacted, audit persists despite process loss; customer code cannot alter trusted audit history | L2, L3, L4 |
| V15 | Metering/budgets: duplicate/out-of-order records do not overbill, per-workspace usage cannot be forged, lag has conservative behavior, limits preserve export/data | L2, L3, L4 reconciliation |
| V16 | Exit/lifecycle: tested export/import round trip, ownership recovery and deletion/grace policy; no accidental permanent deletion on unpaid invoice | L2, L3, L5 |
| V17 | Usability/compatibility: packed CLI and supported MCP/browser clients complete deploy/share/use; local/self-hosted regression suite remains green | L3, L5 |
| V18 | Operating readiness: measured SLOs, usable alerts, timed incident/key/restore drills, staffed escalation and reviewed terms | L4, L5 |
| V19 | Statelessness: fresh process/empty scratch and concurrent replicas preserve committed data, sessions/permissions, idempotency and work; no necessary background execution after response or boot side effects | L2, L3, L4 |
| V20 | Durable wake: with all apps at zero and no user traffic, due work wakes the authorized pinned release; commit/enqueue/ACK crashes, queue expiry and stale restore epochs cause no lost work or forbidden execution | L2, L4 |
| V21 | Sleep/economics: idle app reaches zero without keepalives; catalog/idle MCP do not wake it; cold latency, due-work lag, database connection pressure and actual billed execution are measured | L3, L4 |
| V22 | Gateway zero: no active requests/connections permits actual zero instances; cold HTTP/CLI/MCP serves correct durable routing/auth/quota/audit state; sessions recover or expire safely without replaying mutations; scheduled app work does not require a running gateway | L2, L3, L4 |

**Revocation caveat:** deny newly authorized work/output after the deadline and reauthorize delayed steps; do not claim to undo bytes already delivered or external effects already performed. A malicious app with an already-disclosed external secret is contained through credential rotation/brokering, not merely gateway session revocation.

## 4. Required command interface

The root currently has `pnpm verify`, `pnpm test:postgres`, `pnpm test:e2e`, `pnpm test:consumer`, `pnpm security:audit`, `pnpm sbom`, and `pnpm release:artifacts`. Re-run them for relevant changes; their presence is not proof of a passing result.

**The hosting commands below are planned, not implemented. CH1-01 must introduce them.** Until a suite is implemented, its selector must fail explicitly, not report zero tests as success.

| Planned command | Responsibility |
| --- | --- |
| `pnpm cloud:check` | Plan/task/evidence schema checks, hosting contracts, package boundaries and IaC static policy |
| `pnpm cloud:test:unit` | Deterministic policy/state-machine/unit tests |
| `pnpm cloud:test:integration` | Real PostgreSQL and local protocol adapter tests |
| `pnpm cloud:test:e2e` | Built-service HTTP/CLI/MCP acceptance journeys |
| `pnpm cloud:test:browser` | Built console/views in pinned Playwright browsers; accessibility and hostile-origin tests |
| `pnpm cloud:test:provider` | Real cloud acceptance; requires explicit disposable environment and budget authorization |
| `pnpm cloud:test:resilience` | Fault-injection/recovery suite; supports local or explicit cloud environment |
| `pnpm cloud:test:performance` | Fixed-load startup, gateway, revocation and capacity measurements |
| `pnpm cloud:test:sleep` | Mandatory cold replacement, real scale-to-zero, request/event/schedule wake, queue-gap, idle-MCP and gateway-zero/session-recovery conformance |
| `pnpm cloud:evidence:check` | Validate task/gate evidence, required suites, freshness and review fields |
| `pnpm cloud:env:destroy` | Idempotent resource cleanup scoped to the evidence run's ownership tags |

Each test runner supports `--task CHn-nn`, `--case <case-id>`, `--run-id <id>`, and `--report-dir <path>` with documented defaults. Unknown/empty selectors exit nonzero. Infrastructure suites additionally require environment/account allowlists; they must refuse production and never automatically provision from an untrusted fork PR. Final CLI details can evolve atomically with runner contract tests and these instructions.

## 5. CI and evidence

- **Every PR:** L0–L2 and affected L3 suites; supported Node 22/24 matrix consistent with the runtime ADR. No live credentials in fork jobs.
- **Trusted merge or approved infrastructure PR:** impacted L4 security/provider suite before promotion. A local mock pass cannot substitute for this job.
- **Nightly:** full distributed security/resilience suites; provider suite with budget guard and cleanup.
- **Release candidate:** all launch-blocking suites against the exact artifact digests and infrastructure revision; minimum 24-hour mixed active/idle soak with confirmed-zero and request-free due-work periods, plus monthly/quarterly drills below.
- **Monthly:** automated sampled app restores. **Quarterly:** operator-led full restore/incident/key-rotation drill. Initial launch must perform them once before these schedules begin.

Every run writes structured results and a summary. Retain non-sensitive index files in the repository or approved evidence registry; put raw sanitized reports in restricted durable storage, not customer secrets in git.

Example evidence record (schema to implement in CH1-01):

```yaml
task: CH5-03
status: passed
sourceCommit: <full-sha>
artifactDigests: [<sha256>]
infraRevision: <sha-or-not-applicable>
environment: <disposable-test-id>
runId: <unique-id>
startedAt: <utc>
finishedAt: <utc>
commands: [<exact-command>]
invariants: [V07, V08]
tests: {passed: 12, failed: 0, skippedRequired: 0}
reports: [<restricted-report-uri>]
cleanup: {status: complete, inventoryReport: <uri>}
reviewer: <identity>
limitations: []
```

Task completion needs passing evidence for the current implementation and a reviewer. Gate sign-off needs a current candidate rerun; old task evidence alone is insufficient after relevant changes. For long-running L5 drills use evidence from the preceding 30 days, repeated if relevant design/configuration changed. Security failures cannot be waived by labeling a test flaky. Provider unavailability means **BLOCKED**, not PASS.

## 6. Quantitative measurement protocols

Values below are internal engineering acceptance targets pending commercial approval, not public promises.

| Target | Reproducible protocol |
| --- | --- |
| Deploy p95 < 5 min, median < 3 min | ≥30 fresh supported Kanban deployments; pinned source/base image and declared cache state; time durable API acceptance to authenticated readiness; include failed runs in success rate rather than discarding them |
| Compatible rollback p95 < 2 min | ≥30 alternating compatible releases; time accepted rollback to all routing replicas observing target generation; exclude data restore and report drain separately |
| Revocation ≤30 sec | ≥100 revocations under normal and partitioned invalidation conditions; probe each gateway/surface at ≤1 sec intervals; report maximum, not p95; include streams and delayed work |
| Gateway overhead p95 <100 ms | ≥10,000 warm regional requests at declared fixed concurrency (initial fixture: 20); compare controlled upstream latency; report error rate and CPU, not only latency |
| Recovery RPO ≤15 min / RTO ≤4 hr | Seed monotonically numbered committed receipts every minute; simulate loss; recover an app of the declared supported size (initial fixture: 1 GiB), also record shared-cluster size; measure loss from last durable pre-failure receipt and RTO from incident declaration to authenticated validated cutover |
| 99.9% availability objective | At least 30 days of external synthetic checks with a published denominator, frequency and platform-vs-app error classification; 24-hour soak alone is not evidence of a monthly SLO |
| Capacity/noisy neighbor | Run a capped hostile app while a healthy neighbor serves the fixed baseline; zero cross-boundary access, exhaustion contained, and neighbor remains within its declared error/latency budget |
| Stateless cold execution | ≥100 process-replacement cycles for reference apps; wipe scratch, vary replica, interleave mutations; compare committed data/work/effect receipts and authorization |
| Cold request p95 ≤10 sec | ≥100 cold calls on the declared small reference configuration; report warm-gateway/cold-app, cold-gateway/catalog-only and both-cold separately. Measure from external client request start to first authenticated useful result, including gateway boot, DB/auth and required MCP initialization; include failures in success rate. Confirm natural zero for the dedicated idle-window samples; process replacement alone is not proof of scale-to-zero. Larger workloads need explicit budgets |
| Due-work pickup ≤90 sec in normal reference load | Disable app hints and user traffic; ≥100 due items/events with apps at zero and a one-minute reconciler cadence; measure due/commit to first authorized worker claim, report max and p95; outage backlog recovery is a separate test |
| Real sleep, not min-zero configuration alone | Observe zero instances in ≥30 idle windows without app probes/keepalives and with an idle MCP client; record provider eviction-time distribution and gateway/app invocation counts. No fixed provider scale-down-time SLA is assumed |
| Gateway natural zero and safe resume | ≥30 idle windows using min-zero profile; no synthetic/public probes or maintenance requests during the idle observation. Record gateway instance-count metrics until zero, then one HTTP/CLI/MCP request. Cover closed/quiescent client plus tested idle-stream closure; record persistent clients as active traffic, not false zero failures. No fixed provider eviction-time SLA. Verify quota/audit/grants before/after; separately run background app work while gateway remains zero |
| Lost-wake conservation | Inject crash before/after source commit, intent commit, queue create, external effect and ACK; every committed eligible work item is completed, pending/retrying or explicitly failed/blocked—never absent or silently marked successful |

Adjust a target only through a recorded decision with cost/user-impact analysis—not by silently excluding slow or failed runs. A 30-day SLO measurement may run during private beta; commercial SLA approval remains separate.

## 7. Definition of done and release gates

A task is DONE only when its acceptance cases, required real boundary, affected regressions, docs/runbook updates and evidence review pass. No unexplained skipped required tests; no untracked follow-up that changes a security guarantee. Blocked dependencies are recorded explicitly.

- **G0 — Architecture ready:** CH1-01 through CH1-04; accepted Cloud Run direction qualified for the initial architecture, region/budget decisions and harness usable.
- **G1 — Secure sleeping vertical slice:** CH2–CH5, CH9-01…04 and CH9-07 complete. Stateless app execution, durable wake, idle catalog/MCP and gateway-zero/cold-session recovery work on Cloud Run; synthetic data only until full recovery is ready.
- **G2 — Customer private beta:** CH6, CH7 and all CH9 tasks complete; required framework gates resolved; V19–V22 pass along with recovery/access/support baseline. Real customer data requires appropriate terms and privacy review from CH8-03 even if billing is not live.
- **G3 — Paid launch:** CH1–CH7, CH9 and CH8-01…03 complete; CH8-04 readiness cases pass, V01–V22 candidate suites rerun, independent review and commercial approvals signed. CH8-04 executes this gate and is marked DONE with its sign-off; subsequent rollout is recorded in its activity log. No known critical/high exploitable tenant-boundary defect.
- **G4 — Optional capabilities:** separate tests/decision required for SSO/SCIM, brokered side effects or additional regions. Sleep/statelessness are already mandatory and are not G4 deferrals.

See [TRACEABILITY.md](./TRACEABILITY.md) for requirement coverage and [STATUS.md](./STATUS.md) for execution state. This planning change claims no implementation or test completion.
