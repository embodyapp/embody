# 08 — Billing, independent assurance and launch

## CH8-01 — Authoritative metering, billing and spending controls

**Verification first:** duplicate/out-of-order usage and payment webhooks cannot overbill or grant another workspace capacity; app-generated fake usage cannot affect authoritative accounting. Budget exhaustion stops new expensive admission according to policy while preserving data/export. Invariants: V01, V15, V16. Boundaries: L2/L3/L4 reconciliation + billing sandbox.

**Dependencies:** CH5-01/05, CH7-04/05, CH9-06 initial measured-cost/conformance evidence; cost/pricing approvals HD17. **Areas:** metering ledger, billing adapter/API/console, resource admission.

**Implementation steps:**
1. Define meter units/rounding/windows for Cloud Run billed execution/CPU/memory, startup, builds, Cloud Tasks/Scheduler, scanner/gateway, storage/backups, transfer and telemetry. Distinguish active app compute from shared baseline and dormant artifact costs; do not charge a sleeping release as an always-on worker. Include previews and retained releases. Use integer fixed-point accounting.
2. Collect authoritative provider/platform lifecycle samples into idempotent append-only ledger with tenant ownership and correction entries; reconcile totals to provider records and distinguish measured vs estimated usage.
3. Implement workspace plans/entitlements, checkout and authenticated webhook handler with durable deduplication and out-of-order state reconciliation. Billing provider identity never overrides resource ownership.
4. Add budget reservation/admission for builds/runtimes plus warning thresholds, owner-approved overages and conservative behavior if metering is stale. Define unavoidable overshoot from existing allocations rather than claiming instant zero spend.
5. Implement dunning/cancel/refund/grace/export lifecycle consistent with CH7-04. Essential isolation/backups remain enabled in paid tiers; no security downgrade on plan change.
6. Add price/usage/estimate UI and per-cohort cost model; get actual pricing/included-limit approval before enabling charges.

**Acceptance cases:** `.a` property tests and fixture ledger reconcile duplicates/reordering/late correction exactly; `.b` webhook spoof/replay/wrong-account and missing provider metadata fail safely; `.c` parallel deploy requests cannot oversubscribe reserved quota; `.d` stale meter blocks new spend under documented policy and leaves export working; `.e` trial expiry/nonpayment/cancellation never silently purges data; `.f` real test-provider bill reconciles within an explicitly approved tolerance with discrepancies explained.

**Evidence:** ledger/billing sandbox reports, cloud cost reconciliation, race tests, approved pricing/limits and UX review. No live customer charges in automated tests.

## CH8-02 — Performance, resilience and independent security assurance

**Verification first:** exact release candidate passes V01–V22 at required layers, measured targets use the published protocols, and independent review finds no unresolved critical/high exploitable tenant-boundary defect. Invariants: all, especially V04–V06/V11/V18. Boundaries: L3–L5.

**Dependencies:** CH1–CH7 and CH9 complete; CH8-01 billing path ready. **Areas:** complete acceptance suite, infrastructure, external review and capacity report.

**Implementation steps:**
1. Run full test corpus from clean built artifacts and approved IaC revision; verify no required test skipped/mocked at the wrong layer.
2. Execute defined deploy/rollback/revocation/gateway/noisy-neighbor plus stateless replacement/cold-wake/idle-MCP/backlog benchmarks and ≥24-hour mixed active/idle soak. Include confirmed-zero app and gateway periods, request-free due-work pickup while gateway is zero, and both-cold MCP/session recovery under CH9-07. Include errors/timeouts in results; measure 30-day external availability through private beta for an SLO claim.
3. Inject gateway/controller/runtime termination, DB failover, policy invalidation loss, signer/secret-store outage, audit/usage lag and provider partial provisioning failures.
4. Commission independent source/configuration/penetration review covering accounts/invites, archive/builds, identity, runtime/network/SQL, views, exports/support and billing. Restrict testing to authorized environments.
5. Fix/retest findings, run dependency/image/SBOM/license scans, verify signed artifacts and supported package/install regressions. Record residual risks with owners/expiry; security boundary failures block exposure.

**Acceptance cases:** `.a` full evidence checker rejects wrong artifact/old configuration or skipped suite; `.b` quantitative objectives pass or are revised through reviewed decision before launch; `.c` all required fault scenarios recover with correct durable state and no forbidden receipts; `.d` reviewer reruns exploit regressions; `.e` cleanup restores inventory and projected cost remains within approved plan.

**Evidence:** candidate evidence manifest, external review disposition, performance/soak/fault reports and artifact hashes. A clean scanner alone is not an independent security review.

## CH8-03 — Customer terms, support and operating approvals

**Verification first:** each published promise has measured evidence and an accountable operator; a responder other than the author can follow the runbooks to revoke a key, isolate an app and restore data. Legal/commercial approvals exist before their corresponding exposure/charge. Invariants: V11, V14–V18. Boundary: L5 with real drill evidence.

**Dependencies:** CH1-02; policy/terms work starts early. Customer-data approval uses CH7 recovery/support baseline; final sign-off uses CH8-01/02. **Areas:** commercial docs, customer policies, support tooling/runbooks.

**Implementation steps:**
1. Obtain counsel/rightsholder review for operating entity, ToS, privacy/subprocessors, DPA process, acceptable use, retention/deletion/export, billing/refunds and license/trademark claims. Existing P13 blockers remain tracked.
2. Approve region/residency claims, recovery assumptions, support hours, escalation staffing, incident notifications and any SLA/service credits. Do not advertise certification or monthly uptime absent evidence.
3. Staff and rehearse on-call and break-glass procedures; support access requires MFA, customer/workspace scope, expiry and audit. Review account recovery abuse paths.
4. Test data-subject/export/deletion request handling and privacy-safe telemetry; do not use customer source/data for model training without explicit consent.
5. Record staged approvals: before real customer data, before private beta and before paid launch. Unresolved prices/support promises stay unapproved publicly.

**Acceptance cases:** `.a` independent responder completes key rotation/isolation/restore using only runbooks and records timings; `.b` alert routes to actual primary/backup and incident update is published to test status channel; `.c` customer cancellation/privacy request simulation matches policy and system behavior; `.d` counsel/owner sign-off references exact customer terms; `.e` public docs/website audit finds no unsupported guarantees.

**Evidence:** protected signed reviews, drill reports, staffing/escalation roster and approved public claim matrix. Tests cannot substitute for counsel or an actual staffed support rotation.

## CH8-04 — Design-partner validation and controlled launch

**Verification first:** representative customers complete deploy/share/use/revoke/rollback/recovery journeys without infrastructure intervention; usage/retention/cost evidence supports releasing the exact candidate. Emergency disable/rollback procedures are exercised before broad signup. Invariants: V17, V18 plus all G3 requirements.

**Dependencies:** staged G2 approval for pilot; final CH8-01–03 before gate evaluation. This task executes G3 rather than depending on its own prior completion; public rollout follows the signed gate. **Areas:** onboarding/templates/docs, feature rollout, evidence index and product analytics.

**Implementation steps:**
1. Start invite-only with 5–10 design-partner workspaces after G2 and customer-data terms approval. Use quotas, recording integrations until authorized and explicit beta support expectations.
2. Observe first deploy, first collaborator and scoped agent setup; classify failures as product/framework/provider/user input, preserve denominators and fix repeated friction.
3. Measure ≥80% supported deploy completion without staff help and directional ≥50% four-week activated-workspace retention; capture ≥3 credible willingness-to-pay validations. Small-cohort limitations remain explicit.
4. Reconcile actual workspace cost including support and idle/retained capacity. Adjust approved limits/pricing rather than weakening isolation to make the forecast work.
5. Publish reviewed docs/status/support entry points; ramp signup quotas gradually. Define abort criteria: any tenant-boundary failure, loss of recoverability, severe uncontained cost or sustained error-budget burn.
6. Run G3 evidence checker/review against final candidate, record go/no-go owners and rehearse feature/signup pause, bad-release rollback and customer notification.

**Acceptance cases:** `.a` timed customer journeys recorded without exposing private data; `.b` all release invariants/current artifacts have passing required evidence; `.c` test launch pause prevents new workloads without deleting/locking out existing exports; `.d` abort exercise reaches named decision-maker and rollback/isolation path; `.e` template/documentation install path works from published or packed candidate artifacts.

**Evidence:** cohort summary, cost report, final gate sign-off and rehearsed rollout plan. Mark this task DONE with G3 sign-off; append subsequent controlled rollout results to its activity log. Product metrics guide go/no-go; they never waive failed security/recovery tests.

## Deferred follow-on work (not silently launch-critical)

Scale-to-zero/statelessness are **not deferred**: CH9-01…07 must pass before customer beta/paid launch, including gateway zero-capacity capability even if an optional warm production profile is selected. Each remaining follow-on below needs its own decision, task breakdown and verification before implementation:

- **Groups / SSO / SCIM:** group membership intersections, removal revocation, domain ownership verification, IdP outage policy, provisioning replay and owner lockout recovery.
- **Trusted integration broker:** credential custody outside app runtime, approval bound to exact input/action/release, spend counters, single-use receipt semantics and malicious-app bypass tests.
- **Additional regions / BYOC:** region-bound identity/routing, replicated policy, backup residency, disaster recovery split-brain and tested operational ownership.
- **Attachments/object storage:** app-bound object capabilities, content-type/download isolation, quota/malware/expiry/backup/export policy.

Deferred capabilities are not advertised as delivered. A decision to include one at launch must add explicit task dependencies and update verification/traceability/gates.
