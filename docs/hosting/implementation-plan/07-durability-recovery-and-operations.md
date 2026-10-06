# 07 — Durable work, recovery, export and operations

These tasks may run in parallel with the console once their dependencies pass. **Do not accept production customer data before tested recovery and reviewed customer terms.**

## CH7-01 — Hosted workflow correctness and release retention

**Verification first:** committed work survives process loss; two workers cannot simultaneously own a valid step lease; stale worker cannot commit after fencing; old-version work resumes on the correct release; revocation/cancellation blocks new steps. External effect receipts remain idempotent under deliberate retries. Invariants: V03, V06, V10. Boundaries: L2/L3/L4 crash smoke.

**Dependencies:** CH2-03, CH3-02, CH5-03/04, CH9-01…03 and existing P11-02/P11-03 release-gate closure. **Areas:** workflow/storage/host packages, cloud release scheduler.

**Implementation steps:**
1. Complete existing crash/cancellation/claim-role design tests with app-specific database permissions. Do not introduce a tenant-visible cross-workspace claim credential.
2. Persist workflow definition/release references, due metadata and restrict bounded worker claims to versions it can execute. New instances use active release; existing ones retain supported definitions. CH9-02/03 schedules their wake externally even with zero app instances; no workflow polling daemon is required.
3. Add lease renewal/fencing and crash points before claim, after claim, before/after effect, before/after completion; preserve at-least-once semantics and external idempotency keys.
4. Reauthorize initiator before step dispatch; bound cancellation, compensation/retry attempts, redaction and dead-letter visibility. Treat custom in-process enforcement as app trust, not a malicious-code security boundary.
5. Retain old artifacts/configuration and authenticated release routes until work finishes or explicit migration/cancel policy applies. Idle old versions have zero minimum instances. Cap retention/resource use and validate provider revision quotas; notify owners about blocked versions without silently dropping work. CH9-05 proves wake across deployment/restore.

**Acceptance cases:** `.a` kill at every crash point and compare committed state/effect ledger; `.b` two workers plus expired/reacquired lease cannot both commit success; `.c` v1 workflow spans v2 deployment and uses v1 semantics while new work uses v2; `.d` actor revoked during delay cannot perform next normal-path step; `.e` compensation failure is visible, not falsely successful; `.f` retained version cannot be garbage collected or billed invisibly.

**Evidence:** existing framework P11 evidence links plus hosted crash/version/security matrix. A recording provider with idempotency demonstrates application behavior, not exactly-once guarantees for all vendors.

## CH7-02 — Authorized cross-app events and safe retry controls

**Verification first:** app can publish only as itself and deliver only to explicitly subscribed authorized destinations; forged/replayed/wrong-audience events cannot create unauthorized effects. Offline receivers recover durably without duplicate logical effects. Invariants: V01–V03, V10. Boundaries: L2/L3/L4 connectivity.

**Dependencies:** CH2-04, CH3-03, CH5-05, CH7-01 for workflow-triggered events. **Areas:** event transport adapter, trusted directory/policy service, outbox/inbox UI/API.

**Implementation steps:**
1. Close hosted event transport decision preserving ADR 0004 semantics. Define whether publisher or trusted relay owns fan-out/retries before acknowledgment.
2. Bind producer identity and destination to immutable resource IDs; credentials grant only that app's producer identity, never a shared workspace signing authority.
3. Authorize subscriptions/cross-app calls explicitly and support revocation. Durable destination snapshots do not override a later revoked grant at dispatch. Receiver may have zero instances: delivery uses an owned wake-capable endpoint; offline retries live durably and wake via CH9-02/03, not an in-app interval.
4. Test outbox-to-inbox atomicity boundaries, envelope size/version/expiry, deduplication, independent destination retry and no-subscriber audit.
5. Provide scoped backlog/dead-letter/status/retry/cancel controls with side-effect warnings and rate limits. Operator retry is authorized and audited, not a raw queue edit.

**Acceptance cases:** `.a` hostile app cannot impersonate another producer or register arbitrary private endpoint; `.b` receiver offline/restart resumes delivery; `.c` receiver crash after external receipt/before ack produces idempotent logical result; `.d` revoked subscription stops new dispatch including queued snapshots; `.e` W2 cannot view/retry W1 failures; `.f` duplicate retry submissions don't expand effects or bypass limits.

**Evidence:** full send/receive/fan-out fault matrix, cross-app scope negatives, cloud network tests and actual operator retry journey.

## CH7-03 — Backup, per-app PITR and fenced restore

**Verification first:** recover selected app to a measured point within the test objective without changing another app's data; restored runtime cannot send external effects by default; old runtime cannot continue writing after cutover. Invariants: V06, V10, V11, V14. Boundaries: L4/L5 mandatory.

**Dependencies:** CH3-02/04, CH5-03/04; CH7-01/02 for durable-work replay scenarios. **Areas:** backup IaC, recovery worker, restore API, restricted operations tools.

**Implementation steps:**
1. Enable encrypted PITR/retention with protected backup identities, alerts and inventory. Confirm whether per-app restore requires whole-cluster restore/extraction and reserve temporary capacity.
2. Implement authorized async restore job: select recovery point, restore into isolated recovery infrastructure, extract selected app, validate schema/receipts/checksums and create new binding.
3. Disable egress/secrets/worker execution in restored copies until replay policy approved. Compare outbox/workflow receipts with external sink before resuming.
4. Cut over with app write fence, old session termination/credential revoke where needed, environment execution-epoch increment, route/binding generation update and validation; preserve unrelated apps and a rollback binding until safe cleanup. Old Cloud Tasks/wake intents must fail epoch checks even if queue cancellation is lost; CH9-05 verifies this race.
5. Measure recovery objectives at declared app/cluster sizes; document regional-loss limitation, costs and owner actions. Schedule monthly automatic and quarterly operator drills.

**Acceptance cases:** `.a` restore seeded 1 GiB app with committed minute receipts and measure actual RPO/RTO; `.b` W2/neighbor checksums stay unchanged; `.c` restore interruption/retry/cancel is safe and leaves no public recovery endpoint; `.d` old DB connection attempts after cutover cannot mutate authoritative data; `.e` restored email/workflow does not replay until deliberate approval; `.f` backup failure and expired recovery point raise actionable alerts.

**Evidence:** provider backup/PITR reports, timed runbook execution, receipt comparisons, effective permissions and cleanup inventory. A successful `pg_dump` is not PITR/restore proof.

## CH7-04 — Data export, workspace recovery and deletion lifecycle

**Verification first:** authorized export/import round trip preserves app data/schema metadata, denied users cannot obtain the artifact, and cancellation/nonpayment never triggers undocumented data deletion. Account recovery cannot bypass ownership authentication. Invariants: V01, V14, V16. Boundaries: L2/L3/L5 policy review.

**Dependencies:** CH2-02/03, CH3-02/04, CH5-01; billing-state integration later CH8-01. **Areas:** lifecycle/export worker, API/console, CLI adapter and customer policy.

**Implementation steps:**
1. Define versioned paginated export format, consistent snapshot behavior, schema/manifest/stable ID metadata and excluded secrets/system internals. Check snapshot consistency under concurrent writes.
2. Generate encrypted restricted artifacts with expiring downloads, ownership checks, revocation and retention cleanup; artifact URLs/tokens do not enter logs.
3. Prove import into a compatible self-hosted fixture with export-created metadata. Unsupported external effects/integration settings are documented, not silently omitted as fully portable state.
4. Implement recovery/ownership transfer with recent auth, verified acceptance, notification and audited support escalation. Support access is temporary and cannot silently expose secrets.
5. Implement deletion as explicit recent-auth intent, grace/tombstone, dependency-aware purge and eventual backup expiry. Cancel/restore access within promised grace; retain mandatory billing/audit records only under documented policy.

**Acceptance cases:** `.a` concurrent export/import matches declared snapshot checksum/count/version; `.b` wrong workspace, expired/revoked link and removed member cannot download; `.c` duplicate purge job deletes only intended generation and never another workspace; `.d` ownership recovery social/role bypass attempts fail; `.e` pending cancellation retains export during grace; `.f` later CH8 billing tests prove unpaid status respects this policy.

**Evidence:** round-trip dataset reports, download authorization tests, lifecycle state-machine tests and reviewed retention/recovery policy. Final billing end-to-end closure is required by CH8-01, not a circular dependency here.

## CH7-05 — Durable observability, alerts and operator controls

**Verification first:** an action/deploy/event can be traced by request ID without secrets; killing services does not lose committed platform audit intent; simulated incidents page the intended responder with actionable context. Tenant code cannot erase trusted audit history. Invariants: V13, V14, V18. Boundaries: L2/L3/L4/L5.

**Dependencies:** CH1-04, CH5-05; CH7-01–04 integration before DONE. **Areas:** telemetry pipeline, audit exporter, console operations views, internal support tools.

**Implementation steps:**
1. Emit structured logs/metrics/traces and transactional audit outbox for privileged platform changes, denials, deployments and grants. Bound user log volume; separate untrusted app logs from trusted platform audit facts.
2. Export audit to restricted append-oriented storage with retention and reconciliation. Decide/document behavior during sink outage; buffer durably and reject sensitive operations if no durable intent can be recorded.
3. Build dashboards and alerts for gateway errors, stale authorization, app failure vs healthy idle state, due-work sweep/wake lag, queue retries, cold-start latency, retained dormant versions, connection storms, database/backup capacity, secret/signing failures, telemetry/billing lag and budget abuse. Read platform/provider metrics without periodic external health requests that pin app compute.
4. Provide scoped user diagnostics and protected operator isolate-app/revoke-key/drain/restart/restore controls with MFA, reason and time-limited access.
5. Write runbooks, status-page workflow and incident templates; exercise alert delivery, acknowledgment, escalation and cleanup with actual on-call identities.

**Acceptance cases:** `.a` synthetic incident correlates edge→gateway→action→event safely; `.b` audit sink down/process crash replays intent once logically without losing committed change history; `.c` app log injection cannot forge platform audit fields; `.d` log flood stays within limit and doesn't hide operator alert; `.e` cross-workspace log access denies; `.f` support grant expires and break-glass use is externally auditable.

**Evidence:** alert receipts, dashboards/runbooks, outage recovery tests and actual operator drill. Existing product hooks cannot prove complete audit of malicious runtime activity; describe audited platform boundaries accurately.
