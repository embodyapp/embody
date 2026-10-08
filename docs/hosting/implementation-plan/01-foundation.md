# 01 — Verification harness, architecture and platform foundation

**Entry:** read [verification](./00-VERIFICATION.md), [decisions](./DECISIONS.md), the [hosting product plan](../PLAN.md), and current framework release status. These tasks may start immediately; later phases depend on their evidence.

## CH1-01 — Establish the executable verification harness

**Verification first:** a known failing fixture must produce nonzero exit and a failed evidence record; an unknown/empty task selection must also fail. The same selector must run a positive fixture successfully. Invariants: V16–V18. Boundaries: L0–L3 harness self-tests.

**Dependencies:** none. **Areas:** `scripts/`, `test/cloud/`, package scripts and CI.

**Implementation steps:**
1. Define typed task/test/evidence manifests with task ID, invariant, required layer, command, environment needs and report artifacts.
2. Add the command interface from verification §4, incremental suite registration and common result schema. Unimplemented required suites return NOT_IMPLEMENTED/nonzero, never success.
3. Add fixtures for W1/W2 identities, canary data, release variants, a recording integration sink and injected clocks/IDs. Keep privileged provisioning outside tenant fixtures.
4. Add supported PostgreSQL provisioning, isolated run IDs, cleanup ledgers, fault barriers and built-package launch helpers. Add browser runner and official MCP test client without replacing existing framework tests.
5. Add CI tiers, protected provider credentials, spend authorization and evidence validation. Store raw reports outside git; verify secret scrubbing.

**Acceptance cases:**
- `.a` failing/passing/empty selectors report exact counts and exit codes; skipped required case rejects gate evaluation.
- `.b` two parallel runs cannot share DBs/resources; cleanup twice is safe; interrupted cleanup leaves a discoverable inventory.
- `.c` a fake secret in a failure report is redacted; credentials are unavailable in fork workflow context.
- `.d` malformed/missing/stale evidence and evidence from the wrong artifact cannot satisfy a gate.

**Completion evidence:** runner self-tests, one real PostgreSQL fixture run, built CLI/browser smoke, CI policy review and example sanitized evidence record. This task validates the harness, not the future hosting service.

## CH1-02 — Review threat model, requirements and framework dependencies

**Verification first:** every external endpoint/data path has an owner, caller identity, auth rule, replay policy, limits and failure behavior; every V01–V22 invariant maps to at least one task. No unresolved release dependency is labeled complete. Boundaries: L0/L5 review.

**Dependencies:** none; evidence format from CH1-01 before DONE. **Areas:** hosting docs, framework ADRs/release checklist, `test/cloud/fixtures/`.

**Implementation steps:**
1. Inventory source upload, Git/login/billing callbacks, invite links, console/API, runtime ingress, MCP/SSE, views, events, secrets, migrations, exports and support tooling.
2. Draw trust boundaries and attacker paths for malicious builders/apps/users/staff; assign each mitigation a test and accountable owner.
3. Review HD01–HD22, accepted ADR 0007 (Cloud Run, statelessness and mandatory app sleep) and ADR 0008 (gateway zero-capacity support). Confirm private-app scope, deployment-as-data-access implications, pricing assumptions and what “production-ready” excludes.
4. Snapshot existing P11/P12/P13/P14 blockers with evidence links. Decide how required framework tests enter cloud gates without rewriting historical completion claims.
5. Resolve the GenUI release scope through the existing gate or a reviewed superseding ADR; explicitly record optional-adapter dependency if retained.
6. Finalize acceptance fixtures and initial supported workload limits; interview design partners using deploy/share/recovery scenarios.

**Acceptance cases:**
- `.a` traceability review finds no launch promise without a test/task or explicit deferral.
- `.b` adversarial review walks stolen token, hostile npm script, forged registration, arbitrary SQL, XSS and malicious workflow through a complete mitigation path.
- `.c` product/security owners sign scope; unresolved legal, region or provider-configuration decisions remain visibly OPEN with dependent tasks blocked.

**Completion evidence:** reviewed threat model, endpoint matrix, decision sign-offs and framework dependency register. Research notes are de-identified. No code implementation is implied.

## CH1-03 — Qualify the selected Cloud Run architecture

**Verification first:** on real disposable infrastructure, two hostile isolated tasks cannot access each other's canaries or platform credentials; approved database/HTTPS traffic succeeds while unauthorized network paths fail. Resource exhaustion remains bounded. Invariants: V04–V06, V13, V18. Boundary: L4 mandatory.

**Dependencies:** CH1-01; reviewed initial trust boundaries from CH1-02. **Areas:** `infra/spikes/`, `packages/cloud-provider/` prototype, provider evidence.

**Implementation steps:**
1. Use explicitly second-generation Cloud Run services, request-based billing and min instances zero. Establish separate build/app/platform identities, authenticated ingress and the intended Direct VPC/egress layout.
2. Prototype Cloud SQL app roles, IAM/Secret Manager/KMS, restricted Cloud Run build jobs/OCI packaging, Cloud Tasks→dispatcher→app and Scheduler→reconciler paths. Cloud Run metadata-issued tokens must have no unintended authority.
3. Exercise raw TCP/UDP where supported, IPv4/IPv6, alternate DNS, rebinding/redirects, cloud APIs, termination and zero-instance cold request. Document actual provider capabilities/limits; do not assume Fargate hardening flags exist.
4. Measure cold start, idle/active MCP/SSE behavior, scale-to-zero, wake/queue cost, shared DB/network cost and retained dormant revisions. Model 10/100/1,000 apps including connection/sweep/restore capacity, without provisioning them all unnecessarily.
5. Document GCP shared responsibility, quotas, revision retention, patching and escape response. Failed mandatory controls block launch for review; Cloud Run is selected, not one of two parallel implementations.
6. Record region, project/trust-domain layout, supported concurrency/timeout limits, identity-provider decision or bounded shortlist, budget and outstanding sleep/security validation.

**Acceptance cases:**
- `.a` adversarial canary matrix passes with actual app/build credentials; generic network outage does not count as isolation.
- `.b` busy-loop/process/log/disk pressure is capped and healthy neighbor remains within declared test budget.
- `.c` stream/reconnect works through the selected edge; an idle app reaches zero and next authorized request cold-wakes it; app identity cannot use platform/neighbor credentials. Killing an instance is not assumed to revoke previously issued identity tokens—test IAM and revocation separately.
- `.d` complete inventory is destroyed; independent inventory query finds no billable orphan outside explicitly retained evidence storage.

**Completion evidence:** sanitized GCP infrastructure plan, cloud test reports, cost worksheet, provider assurance references and HD04 configuration qualification. If enforcement is infeasible, record BLOCKED and escalate the design under ADR 0007; do not silently switch provider or weaken V05.

## CH1-04 — Scaffold contracts, services and durable platform state

**Verification first:** resources with the same slug in W1/W2 remain distinct; cross-workspace lookups return a safe not-found/denied result; transaction failure leaves no partially created resource/job/audit intent. Invariants: V01, V07, V14, V17. Boundaries: L0/L2.

**Dependencies:** CH1-01, CH1-02; provider-specific wiring follows CH1-03. **Areas:** `packages/cloud-contracts`, `apps/cloud-api`, `apps/cloud-worker`, `infra/`, root package boundaries.

**Implementation steps:**
1. Add inward-only package/service boundaries, health/readiness, configuration validation and API version/error envelopes. Do not import provider SDKs into core.
2. Define immutable workspace/app/environment IDs, release/deployment/configuration resources, principals/grants, secret references, jobs and audit intents. Slugs are mutable display/routing aliases, not authorization keys.
3. Implement Cloud SQL PostgreSQL migrations with unique/foreign-key constraints, tenant-scoped repositories and connection roles. Platform DB is inaccessible to customer runtimes.
4. Implement transactional idempotency records, persisted job leases/fences, environment execution epochs, due-work/wake contracts and audit outbox primitives. Separate trusted cross-workspace scheduling from end-user authorization; define bounded Cloud Tasks-driven control-plane execution instead of post-response loops.
5. Define API operations for app/environment creation, deploy submission/status/cancel, grants, secret bindings, rollback, restore/export and lifecycle; add request/response fixtures before full handlers.
6. Add baseline IaC modules for trusted services/state, protected CI identity, environment separation, backup configuration and mandatory resource ownership tags.

**Acceptance cases:**
- `.a` malformed/unsupported contracts reject at both producer and consumer; secrets never appear in serialized configuration.
- `.b` duplicate idempotency key with same input returns same resource; different input conflicts; concurrent inserts preserve uniqueness.
- `.c` crash before commit creates neither job nor resource; after commit a new worker can resume the job; stale fence cannot overwrite a new owner.
- `.d` existing framework/local scaffolder/self-hosted tests run without cloud credentials; static dependency checks reject provider imports into core.
- `.e` W1/W2 use identical display slugs; W1 cannot get/list/update/delete W2 resources by guessed immutable ID, nested child ID or alias. W2 can still read its unchanged canary, and allowed W1 operations succeed.

**Completion evidence:** real migration/upgrades/transaction tests, API contract fixtures, IaC policy tests, package build/typecheck and compatibility results. G0 requires all CH1 tasks, not just scaffolding.
