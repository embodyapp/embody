# Minimal MVP implementation tasks

Read [scope](./README.md), [verification](./VERIFICATION.md) and [status](./STATUS.md) before claiming work. **None of these tasks is complete merely because this plan exists or a related PR is green.** Dependencies mean accepted implementation/evidence, not just a branch. Suggested paths are new unless already present.

Every task must add or update executable tests, user/operator documentation, and a dated evidence entry. All acceptance cases below are required unless an explicit scope change is approved and recorded. Preserve these IDs in PRs and commits.

## M01 — Integrate and reconcile existing work

**Depends on:** none. **Areas:** existing PRs, framework/hosting plans, package lockfile and API reports.

Steps:
1. Inspect current remote main, open PRs and local-only changes without resetting another worktree. Record exact reviewed SHAs.
2. Review #29/#30/#31 (respect the stack), reconcile #32 with the narrower request-only profile, and integrate approved pieces in small changes.
3. Keep GenUI/WIP history safe; do not make non-UI deployment wait on theme or renderer work. Preserve existing behavior if GenUI has since landed.
4. Map this plan to P15/CH tasks where available. Record scope differences, particularly unsupported workflows and app-to-app calls. Avoid duplicate implementations.
5. Triage security fixes separately from optional major toolchain upgrades; regenerate lockfile/API reports on the integrated candidate.

Acceptance:
- **M01.a:** combined candidate passes affected dispatch, principal/delegation, CLI and MCP regression tests on supported Node versions.
- **M01.b:** HTTP and MCP errors, rate limits, guardrails and audit parity remain covered after integration.
- **M01.c:** integration report identifies merged/reused/unmerged work, exact SHAs and remaining gates; no prior branch evidence is presented as a new test run.

Docs: integration report and updated framework task references. Evidence: integration CI run and review.

## M02 — Freeze the supported profile and deployment contracts

**Depends on:** M01. **Areas:** proposed `packages/cloud-contracts`, CLI/host contracts, docs.

Steps:
1. Specify workspace/app/release/deployment IDs, scoped roles (`deployer`, `operator`, `app-caller`) and request-only capability declaration.
2. Define versioned schemas for deployment submission/status, release manifests, secret references and app management. Exclude secrets from release metadata.
3. Define durable deployment states: accepted → validating → building → provisioning → checking → promoting → active; terminal failed/cancelled, with bounded retries.
4. Define idempotency keys, source digest binding, promotion generation/CAS, cancellation fences and safe public errors.
5. Pin the supported scaffold, Node versions, input/build limits, action deadlines, database connections and retention defaults. Config is executable source and evaluated only inside isolation.

Acceptance:
- **M02.a:** schema tests accept valid requests and reject missing workspace binding, unknown versions, oversized inputs and invalid state transitions.
- **M02.b:** same submission key/body returns the same deployment; different body with the same key conflicts (repository contract tests now, real store integration in M12).
- **M02.c:** separate call/deploy/admin permissions have a positive/negative role matrix; caller cannot deploy or read secrets.

Docs: API/CLI contract, supported workload and limits table, decisions with owners. Evidence: contract tests and scope review.

## M03 — Make verification trustworthy

**Depends on:** M01. **Areas:** `.github/workflows/ci.yml`, storage tests, E2E fixture and package scripts.

Steps:
1. Make mandatory database jobs fail when configuration is missing, rather than silently skip. Wire the real PostgreSQL test URL without leaking it.
2. Use a maintenance role for migrations and a separate non-owner, NOSUPERUSER, NOBYPASSRLS runtime role. Include kernel-adapter and gateway-store tests as they land.
3. Reproduce/fix any Compose initialization failure on the exact committed candidate, not an uncommitted local workaround.
4. Establish proposed `test:mvp` and `test:mvp:cloud` commands with explicit prerequisites; absent required credentials fail the selected gate.
5. Add evidence output with commit/image hashes, test counts/skips and sanitized artifacts. Cloud tests require an explicitly approved project/budget.

Acceptance:
- **M03.a:** intentionally omit DB URL: mandatory DB job fails; configure it: actual PostgreSQL cases execute with zero required skips.
- **M03.b:** negative SQL verifies runtime cannot migrate, bypass RLS or access a second app database.
- **M03.c:** clean checkout builds packed CLI/app artifacts and runs baseline distributed E2E on supported Node versions.

Docs: reproducible test commands and local/cloud prerequisites. Evidence: CI including deliberate failure-path tests.

## M04 — Durable workspace catalog and credentials

**Depends on:** M02, M03. **Areas:** `packages/gateway`, `apps/gateway`, platform migrations. Reuse P15-05/P15-08.

Steps:
1. Implement PostgreSQL store plus memory test adapter for workspaces, hashed/expiring/revocable credentials, app manifests and active release pointers.
2. Key all data by workspace/app; revision and promotion generation update atomically. Bind credentials to explicit permissions and app identity where appropriate.
3. Route CLI/MCP under `/w/<workspace>`; fix URL joining so prefixes are preserved.
4. Remove heartbeat-dependent discoverability in the hosted profile. Persist registrations at deploy time; idle/ready/unavailable/disabled are not equivalent to instance count.
5. Use bounded caches with defined revocation freshness (target: new operations denied within 30 seconds). Fail closed on authoritative-store failure.

Acceptance:
- **M04.a:** real-store conformance covers create/read/update/revoke, concurrent CAS, revision changes and restarts.
- **M04.b:** two workspaces both named `kanban` see different catalogs/endpoints; guessed IDs and workspace URL mismatch reveal no unauthorized catalog.
- **M04.c:** no heartbeat and zero app instances do not remove catalog entries; discovery performs zero app requests.
- **M04.d:** two gateway instances share changes within the cache bound; expired/revoked credential denied, including after cold start.

Docs: workspace provisioning, credentials, route migration and cache/failure semantics. Evidence: real Postgres and multi-instance tests.

## M05 — App-bound identity and tenant isolation

**Depends on:** M04. **Areas:** auth, gateway, host, infra identity. Reuse P15-09/P15-12.

Steps:
1. Issue short-lived asymmetric gateway tokens; publish public keys with rotation overlap. Store private signing material only in trusted gateway identity.
2. Pin issuer, algorithm, audience and workspace at every host. Do not reuse gateway API keys downstream.
3. Separate platform/deployer/builder/runtime/migration identities. Define private platform-to-app invocation and provider token handling separately from Embody principal tokens.
4. Authorize all catalog, action, management, logs, source and secret operations. MCP human credentials become delegated agents; app-caller keys do not grant deployment rights.

Acceptance:
- **M05.a:** reject expired, wrong issuer/algorithm/audience/workspace tokens and forged delegation across HTTP/MCP/host paths.
- **M05.b:** app A cannot mint tokens accepted by B; runtime metadata identity cannot access platform DB, other secrets, deploy APIs or signing keys.
- **M05.c:** key rotation succeeds during overlap; removed keys stop working after documented cache/token bounds.
- **M05.d:** direct unauthenticated app calls fail; authenticated cross-workspace discovery/calls/log access fail.

Docs: identity diagram, role matrix, key rotation/revocation runbook. Evidence: cryptographic and IAM negative tests; final provider proof in M09/M17.

## M06 — Stateless MCP and supported client contract

**Depends on:** M04, M05. **Areas:** `packages/mcp`, gateway/CLI. Reuse P15-04 and minimal P15-03 metadata.

Steps:
1. Use per-request official SDK transport without required in-memory sessions or affinity. Authenticate every request and dispose resources after response/abort.
2. Preserve ordered progress, error details, structured output where supported, cancellation and plain-client behavior.
3. Define supported methods/headers, initialization, shutdown and idle-connection behavior against pinned SDK and one real target client.
4. Verify capability handling does not assume previous in-process initialization. If GenUI is present, keep its integrity/authorization behavior or disable the unsupported hosted capability explicitly; no universal UI promise.

Acceptance:
- **M06.a:** official SDK client initializes/lists/calls across alternating gateway instances without a session affinity requirement.
- **M06.b:** replacement between requests preserves authorization and action correctness; abort/shutdown cleans up bounded in-flight work.
- **M06.c:** real named/versioned MCP client completes tool call and becomes quiescent without a reconnect loop. Plain CLI remains usable.
- **M06.d:** catalogs respect workspace/app scope on every request and do not wake app hosts.

Docs: client setup/support matrix, methods, idle and reconnect limitations. Evidence: SDK tests and dated real-client transcript with secrets removed.

## M07 — Safe dispatch, cold starts, quotas and durable audit

**Depends on:** M04, M05, M06. **Areas:** gateway dispatch/limits/audit, platform DB. Reuse P15-01/P15-10/P15-14 portions.

Steps:
1. Route only to deployment-owned endpoints; validate at connection time, prohibit arbitrary redirects and prevent private/metadata SSRF outside explicitly admitted provider destinations.
2. Propagate cancellation and bound complete request time (including cold DB/app), body/frame size and concurrency. Use safe timeout/progress behavior.
3. Do not replay ambiguous writes. Annotation `idempotent: true` alone is insufficient: generated hooks/events may repeat. Report outcome unknown and request ID; only proven not-delivered requests or separately proven idempotent operations may retry.
4. Persist quota/admission counters or equivalent authoritative limits across instances; local limits can supplement but not replace workspace budgets. Fail closed on store failure.
5. Persist action admission/audit intent before dispatch, then completion when known. Interrupted calls retain an unknown outcome, not false success. Export/log delivery can be asynchronous through durable jobs.

Acceptance:
- **M07.a:** controlled cold host succeeds within budget; exhausted budget returns bounded useful error; unauthorized calls never reach host.
- **M07.b:** host commits then drops response: write is not repeated, client sees unknown outcome, effect ledger contains one effect. Reads only retry under defined safe semantics.
- **M07.c:** rebinding/redirect/metadata endpoint attempts fail; oversized streams and stalled bodies terminate.
- **M07.d:** restart/replica switching cannot reset quotas or erase committed audit intent; DB outage never bypasses limits/auth.

Docs: timeout/retry semantics, rate/budget limits, audit retention and redaction. Evidence: failure injection, real-store concurrency and effect ledger.

## M08 — Request-only, sleep-safe host and scaffold

**Depends on:** M02, M03, M05. **Areas:** host/core/storage, scaffolder, reference fixture. Reuse P15-15/CH9-01 only for this narrower profile.

Steps:
1. Add an explicit hosted request-only runtime; preserve existing local/always-on mode.
2. Disable automatic heartbeat/outbox/delivery/workflow intervals, automatic registration and startup migrations in hosted mode. Pre-migrate with separate credentials; boot validates schema compatibility read-only.
3. Reject declared workflows, scheduled/background handlers and always-on capabilities during preflight and host startup. Do not claim static analysis catches arbitrary timers or module state.
4. Define and implement bounded outbox treatment for generated CRUD in this no-delivery profile (see scope). Make retention/cleanup externally driven if needed; no hidden app polling.
5. Enforce action deadlines, cancellation, database pool limits and ephemeral scratch usage; require durable request state before response.
6. Produce a request-only scaffold/reference app. No production SQLite/local-dev verifier and no startup business side effects.

Acceptance:
- **M08.a:** fake-timer tests find no recurring business/heartbeat timers; no migrations or effects on 20 concurrent cold boots.
- **M08.b:** process/scratch replacement between CRUD calls preserves PostgreSQL data; abrupt termination preserves transaction atomicity.
- **M08.c:** workflow/subscription/SQLite/always-on fixtures fail with actionable errors; generated CRUD has tested bounded outbox behavior and no delivery promise.
- **M08.d:** runtime role cannot execute migration DDL; existing self-hosted mode regression passes.

Docs: supported runtime contract, migration from always-on apps, outbox limitations and scaffold guide. Evidence: real DB, boot/timer and packed-scaffold tests.

## M09 — Qualify the cloud/database baseline and cost limits

**Depends on:** M03, M05, M08. **Areas:** proposed `infra/mvp`, qualification scripts and runbook. Early disposable spikes may precede dependencies; DONE requires all.

Steps:
1. Provision one approved region/project using small repeatable IaC; choose Neon or Cloud SQL using measured compatibility, isolation, latency and recovery evidence.
2. Set Cloud Run request billing/minimum zero and bounded max instances/concurrency; use request-only host and minimal service identities.
3. Provision app databases/roles with PUBLIC/default privileges reviewed, statement/connection limits and separate platform credentials. Test selected pooling semantics.
4. Enforce ingress and network/identity containment. If the provider configuration cannot contain user code at the documented boundary, block user deployment rather than calling review a sandbox.
5. Configure secrets, images, source storage, backups and lifecycle limits. Bound builds/logs/storage and set alerts plus an emergency admission stop.
6. Record price assumptions, quotas, domain/egress/fixed-cost line items and approved monthly ceiling. No unsupported free-tier/SLA promise.
7. Qualify the wake queue (Cloud Tasks): OIDC invoker identity bound to platform/app audiences, deterministic task names and their de-duplication window, schedule time up to 30 days, retry/backoff ceilings that outlast the longest transaction, per-workspace queue quotas, outage behavior and cost.

Acceptance:
- **M09.a:** fresh IaC apply creates a usable baseline; teardown removes only owned test resources.
- **M09.b:** app A raw SQL/metadata/network probes cannot access B or the platform; builder has no production credentials.
- **M09.c:** selected PostgreSQL passes storage/RLS/role tests, connection-storm test and a preliminary restore; cold connection latency recorded.
- **M09.d:** inspect actual service/revision min/max settings and confirm a disposable request-only service reaches zero. Baseline cost worksheet reviewed by owner.
- **M09.e:** a task scheduled for later wakes a disposable service at zero only when due; duplicate task names are rejected; a caller without the platform invoker identity cannot invoke; queue cost and quota are in the worksheet.

Docs: provider/database decision, IaC commands, limits and costs. Evidence: real-cloud IAM/SQL/instance traces, sanitized config and dated pricing links.

## M10 — Authenticated source admission

**Depends on:** M02, M04, M05, M09. **Areas:** CLI archive code, gateway management API, private object storage.

Steps:
1. Package supported source with exclusions for `.env`, credentials, local DBs, `.git`, dependencies and build outputs; document explicit inclusion rules.
2. Authorize deployment and quotas before allocating upload/build capacity; issue bounded, short-lived workspace-bound upload access.
3. Verify digest/size after upload; safely extract with limits on files, bytes, paths, symlinks and compression ratio. Never evaluate config in the gateway.
4. Persist source identity and retention metadata; all retries use the same bound deployment identity.

Acceptance:
- **M10.a:** traversal, symlink escape, archive bombs, expired/foreign upload access, digest mismatch and excessive files fail before code execution.
- **M10.b:** fixture secrets/local DBs are absent from produced archive; errors/logs do not echo credential contents.
- **M10.c:** interrupted upload resumes/restarts safely without submitting an unintended build; unauthorized user cannot access another archive.

Docs: packaging exclusions, supported files, upload errors and source retention. Evidence: adversarial archives and authenticated storage integration.

## M11 — Isolated build and immutable artifact admission

**Depends on:** M08, M09, M10. **Areas:** build jobs, image registry, manifest extraction.

Steps:
1. Use one pinned build recipe/runtime, frozen lockfile and bounded build resources; no arbitrary customer Dockerfiles.
2. Run dependency scripts, app config and manifest extraction only inside isolated unprivileged jobs with staging-only permissions and network restrictions.
3. Validate output manifest/profile/schema and digest using trusted code outside the build; bind artifact to workspace/source/deployment. The manifest includes the hosted profile, published event names, subscriptions and versioned workflow definitions (M19–M21). Scans/provenance are not proof the code is harmless.
4. Admit digest-addressed images with provenance/SBOM/vulnerability policy; trusted signing/admission never executes customer output with elevated credentials.
5. Persist logs/status with bounded retention and cleanup of failed/orphaned artifacts.

Acceptance:
- **M11.a:** malicious install script cannot read platform secrets, access another build's source or deploy workloads; resource/network abuse is bounded.
- **M11.b:** unsupported runtime/profile, bad lockfile, substituted digest/manifest and failed build never reach promotion.
- **M11.c:** clean scaffold yields runnable immutable image and artifact metadata; logs redact injected secret canaries.

Docs: build contract, provenance/scan policy, build troubleshooting and retention. Evidence: real isolated-job negatives and successful scaffold build.

## M12 — Durable deployment controller

**Depends on:** M04, M09, M10, M11. **Areas:** proposed deployment worker, platform migrations, external queue/reconciler.

Steps:
1. Persist deployment state and durable job/outbox in one transaction at submission; gateway returns ID without waiting for build execution.
2. Use an authenticated external task delivery/reconciler with bounded handlers, leases, fencing and retries. Repair commit/enqueue/ACK gaps; no gateway-owned timers.
3. Authorize/validate workspace, epoch and current job at each privileged transition; bind provider resource names and endpoints from platform records.
4. Make provisioning/build references idempotent; serialize promotions per app. Cancellation prevents later promotion; orphan cleanup verifies ownership.
5. Set a tested reconciliation interval, retry ceiling, timeout and visible terminal failure policy.
6. Build the queue/task adapter and authenticated task ingress as shared infrastructure; M20 and M21 reuse it for app wakes and event relay rather than adding a second queue path.

Acceptance:
- **M12.a:** kill after commit/before enqueue, after resource creation/before receipt and before task ACK; reconciliation reaches one active logical deployment without lost jobs.
- **M12.b:** duplicate/concurrent tasks and cancellation race cannot promote twice or cross workspace boundaries.
- **M12.c:** deployment continues while gateway has zero instances; worker replacement and queue outage recover within the documented bound.
- **M12.d:** malicious task IDs/headers/URLs and expired provider tokens cannot invoke privileged work.

Docs: state machine, retries, cancellation and stuck-job recovery. Evidence: real database/queue crash matrix and provider inventory.

## M13 — Provision, migrate, promote and roll back

**Depends on:** M05, M08, M09, M12. **Areas:** deploy worker/provider calls, gateway store, migration runner.

Steps:
1. Provision restricted app identity/database/secrets and create candidate from admitted digest with min zero. Runtime has no migration/platform authority.
2. Run bounded migrations separately. Limit MVP updates to compatible schema/data changes; reject unsupported destructive migrations before execution. Route rollback cannot undo data mutations.
3. Validate candidate manifest, readiness and authorized side-effect-free smoke; atomically switch active route/manifest only on success.
4. Keep previous release serving after failed build/check; drain existing calls with clear generation semantics. Retain rollback images/config references.
5. Permit compatible rollback by digest/config with fresh checks; fail safely if schema or secret compatibility prevents it.
6. Bind subscriptions and workflow definitions with the route/manifest switch. Keep every workflow definition version that still has running instances available after promotion or rollback; refuse a release that drops one.

Acceptance:
- **M13.a:** first deploy registers the app; update switches route and manifest together without mixed catalogs across gateway instances.
- **M13.b:** failed readiness/compatible migration attempt leaves old route usable; rejected destructive migration does not modify production data.
- **M13.c:** two concurrent promotions and stale/cancelled worker cannot overwrite the winning generation.
- **M13.d:** rollback restores previous code with data intact where compatible; incompatible rollback gives explicit refusal.
- **M13.e:** an instance started on workflow v1 completes on v1 after v2 is promoted; a release removing v1 while instances run is refused; subscriptions switch with the active generation.

Docs: deploy/rollback semantics, migration restrictions, recovery and retention. Evidence: real Cloud Run candidate/promotion/rollback tests with data checksums.

## M14 — Packed CLI deploy and control journey

**Depends on:** M06, M10, M12, M13. **Areas:** `packages/cli`, protected profiles, packed consumer tests.

Steps:
1. Implement deploy/upload/status and the command grammar from the scope; reuse existing profiles and action discovery/execution.
2. Support useful human output plus stable JSON/error exits; give deployment ID immediately and allow status polling after disconnect.
3. Ctrl-C stops local waiting without falsely claiming server cancellation; explicit cancellation has server-side fence semantics.
4. Return gateway/MCP setup instructions, never secret values. Keep all platform calls through the central gateway API.

Acceptance:
- **M14.a:** external packed CLI consumer creates/deploys scaffold, reconnects by ID, discovers app and executes CRUD without operator intervention after account provisioning. A durable scaffold variant starts a workflow and reads its status through CLI.
- **M14.b:** malformed source, build failure, missing scope, stale key and cold timeout have stable exits and actionable errors.
- **M14.c:** workspace URL prefixes work; credentials/source secrets never appear in stdout/stderr or routine telemetry.

Docs: end-to-end quickstart, command reference, JSON examples and supported MCP setup. Evidence: spawned packaged CLI against the real integration topology.

## M15 — Logs, secrets and app lifecycle management

**Depends on:** M07, M13, M14. **Areas:** gateway management API, CLI, provider adapters.

Steps:
1. Provide authorized bounded logs/status with request/deployment IDs and redaction; never offer raw cross-workspace provider queries.
2. Implement secret set/rotation through protected input, versioned references and authorized rollout; normal APIs do not return values.
3. Disable admission immediately under the revocation bound; fence queued deployments so they cannot silently re-enable a disabled/deleted app.
4. Require explicit delete confirmation; stop traffic, revoke runtime credentials, apply documented data/source/image/backup retention, and retain minimal audit.
5. Provide an operator global/workspace emergency stop that does not delete data or block authorized export/recovery.
6. Provide authorized CLI/MCP operations for workflows (status, cancel, retry) and event deliveries (list dead letters, retry, purge). Disable/delete stops new deliveries and cancels or compensates running workflows; queued tasks for a disabled app are fenced.

Acceptance:
- **M15.a:** foreign workspace and app-caller credentials cannot read logs, mutate secrets or manage app lifecycle.
- **M15.b:** secret rotation reaches new calls without leaking values; old access is revoked within the documented bound.
- **M15.c:** disable/delete versus in-flight deploy/retry cannot resurrect service; data retention and deletion receipts match policy.
- **M15.d:** excessive logs and log query requests are bounded and attributable to the correct workspace.
- **M15.e:** dead-lettered delivery retried by an authorized operator delivers once; foreign workspace cannot see or retry it; disabling an app with a delayed step and pending deliveries prevents both from running.

Docs: management reference, revocation/rotation, deletion and emergency runbook. Evidence: lifecycle race and authorization tests.

## M16 — Recovery, operations and pre-customer-data readiness

**Depends on:** M07, M09, M13, M15. **Areas:** backups/export, runbooks, terms, alerts and artifact policy.

Steps:
1. Configure backups and test app-scoped restore to a new binding. Fence old runtimes/connections during cutover; do not affect unrelated apps.
2. Provide authorized export and operator recovery/deletion procedures; define retention, recovery targets and limitations based on measurements.
3. Exercise bad deploy, DB outage, queue outage, dead-letter growth, compromised key, abusive app and budget-overrun admission stop. Monitor through provider metrics, not recurring gateway/app pings.
4. Close applicable packaging, dependency, license/ownership, beta/privacy and support gates with named accountable approval. No implied SLA or legal certification.

Acceptance:
- **M16.a:** timed restore/export recovers entity checksums; workspace B is unchanged; old app credentials cannot write to the replacement binding.
- **M16.b:** alerts fire for injected outage/quota events without keeping idle gateway/apps awake; operator follows runbook successfully.
- **M16.c:** signed checklist records terms/privacy, ownership, retention, support hours, known risks and approved costs before customer data.

Docs: recovery measurements, incident runbooks, customer limitations and approvals. Evidence: restore artifacts, drill logs and accountable sign-off (manual where appropriate).

## M17 — Real scale-to-zero and centralized-control proof

**Depends on:** M03–M16, M19–M21. **Areas:** `test:mvp:cloud` implementation, cloud metrics and support matrix.

Steps:
1. Run the exact packaged CLI/image/IaC candidate with two workspaces and at least two apps in one workspace.
2. Observe natural zero-instance intervals using provider metrics; no synthetic keepalive or forced deletion presented as autoscaling evidence.
3. Execute the complete release journey in VERIFICATION.md with gateway-only cold and both-cold cases, from CLI and the supported real MCP client.
4. Measure at least 20 cold trials where actual zero state is evidenced; separate DB warm/cold, platform idle retention and billed usage. Record p50/p95 and failures against M09-approved budgets.
5. Inject replacement, store outage, ambiguous mutation and denied cross-workspace calls. Record costs, quotas, test teardown and supported idle behavior.
6. Run the Kanban → Email durable journey: moving a card publishes an event that wakes only the subscriber, which sends one idempotent notification; a workflow with a delayed step resumes at its due time while gateway and apps are at zero.

Acceptance:
- **M17.a:** actual zero gateway/apps; authenticated discovery wakes gateway only; an authorized action wakes only its app.
- **M17.b:** data/catalog/credentials/audit/quotas survive replacement; failed cold store access is unavailable, never permissive.
- **M17.c:** CLI and real MCP journey succeed within approved deadlines without sticky sessions or duplicate writes; denied calls wake no apps.
- **M17.d:** failed deployment/rollback/revocation and all isolation cases pass; no required test is skipped. Cost report includes fixed and variable charges.
- **M17.e:** event and delayed-step wakes observed from actual zero with provider metrics; unrelated apps stay asleep; an instance killed mid-step or mid-delivery recovers with one effect in the ledger.

Docs: dated support matrix, cold-latency/cost report and reproduction steps. Evidence: real provider metrics/logs, run IDs, exact hashes and effect ledgers.

## M18 — Candidate review and controlled release

**Depends on:** M01–M17, M19–M21. **Areas:** release checklist and status.

Steps:
1. Review traceability from every requirement to acceptance cases and candidate evidence; rerun relevant gates after code/infra changes.
2. Ensure every task is DONE with reviewer/evidence and no expired high-risk exceptions. Avoid unsupported GenUI/cron/long-running-step/SLA claims in docs or landing content.
3. Onboard one design partner with provisioned credentials; observe user-operated deployment and CLI/MCP control. Record rollback/stop decision and support contact.
4. Tag candidate artifacts and record a release decision; public/general-availability work remains separate.

Acceptance:
- **M18.a:** evidence checker/reviewer rejects missing task evidence, skipped mandatory tests or mismatched candidate hashes.
- **M18.b:** first partner completes supported journey; owner approves the exact candidate, limits, costs and residual risks.

Docs: final release record and next backlog. Evidence: reviewed checklist and dated owner decision. Manual approval is required; tests alone cannot approve customer terms or launch.

---

# Scope change 2026-10-14: events, subscriptions and durable workflows

Owner decision (MD03 revised, MD11–MD14): the hosted MVP includes ADR 0003 workflows and ADR 0004 events. The framework engines are reused; only their trigger changes from in-process polling to queue tasks that wake the app when work is due. M08's request-only profile stays supported and accepted; the durable profile extends it. Amendments to M09, M11–M17 above are part of this change.

## M19 — Close workflow engine gates for hosted use

**Depends on:** M03, M08. **Areas:** `packages/core` workflows, `packages/storage` workflow persistence, framework P11-02/P11-03.

Steps:
1. Complete the P11-02 crash-point and active-cancellation matrix: claim, step effect, completion, compensation and cancellation each interrupted at every persistence boundary.
2. Replace the cross-tenant `system` claim with a design that works under the M03 runtime role without RLS bypass (per-org claims or a narrowly granted claim function), and test it.
3. Expose the set of workflow definition versions with running instances so deployment (M13) can refuse to drop them.
4. Enforce a step duration limit equal to the action deadline and a maximum delay of 30 days at definition validation.
5. Complete P11-03: the official CLI and MCP workflow journey (start, status, cancel, retry through the gateway's generated actions) against the real PostgreSQL engine, with docs and scaffold guidance. M19 DONE closes framework P11-02 and P11-03.

Acceptance:
- **M19.a:** every crash point yields exactly one completed or compensated logical step; no step runs after cancellation is committed.
- **M19.b:** the runtime role has no `BYPASSRLS`; tenant-scoped operations cannot read or advance another tenant's instances; the only cross-tenant path is the narrowly granted claim function, which returns claim identity only and is not executable by other roles.
- **M19.c:** definitions over the step/delay limits fail validation with actionable errors; running-version listing is exact under concurrency.
- **M19.d:** packed CLI and the supported MCP client start a workflow, read its status, cancel one and retry a failed one through the gateway; unauthorized callers are denied.

Docs: workflow contract for hosted apps, limits and idempotency guidance. Evidence: real PostgreSQL crash matrix with zero skips.

## M20 — Queue-woken durable runtime

**Depends on:** M08, M19 (local); M09 and M12 for the real queue adapter. **Areas:** `packages/host`, `packages/core` outbox, queue port and adapters.

Steps:
1. Add a hosted *durable* profile alongside request-only. It permits events, subscriptions and workflows and still starts no timers or workers.
2. Define a wake-queue port. Within the transaction that records an outbox event or schedules a workflow step, create a task with a deterministic name and the due time before commit. Enqueue failure aborts the transaction (fail closed).
3. Add a platform-only drain endpoint: verifies platform invoker identity and app audience, processes one bounded batch within the action deadline, and enqueues a follow-up task when work remains. A task arriving before its transaction is visible retries; one arriving after rollback is a no-op.
4. Implement delays and retry backoff with task schedule time. Implement ADR 0004 retention (30 days) and its cleanup as scheduled tasks. After any inbound request, the app re-enqueues overdue work it can see (recovery without a periodic sweep, MD12).
5. Enforce per-app queue quotas and payload limits (256 KiB envelopes); integrate quota/audit records with M07.

Acceptance:
- **M20.a:** fake timers: no intervals in durable profile; 20 cold boots start no work; work runs only when a drain task arrives.
- **M20.b:** kill before enqueue, after enqueue before commit, after commit before drain, mid-batch and after effect before acknowledgement: no lost work and one logical effect in the ledger.
- **M20.c:** queue outage makes publish/start fail and roll back; a delayed step never runs early; drain without platform identity or for another app is rejected.
- **M20.d:** request-only profile regression passes unchanged; durable profile scaffold builds and runs in the packed consumer.

Docs: durable profile contract, queue semantics, limits, retention and migration from reference mode. Evidence: real PostgreSQL plus fake queue locally; real queue in M09/M17.

## M21 — Gateway event relay and subscriptions

**Depends on:** M04, M05, M07, M12, M13, M20. **Areas:** `packages/gateway` relay, platform DB, receiver inbox.

Steps:
1. The publisher's drain sends each event to authenticated gateway ingress using its app identity. The gateway verifies producer, workspace and event name against the admitted manifest.
2. Resolve subscribers from the active catalog (subscriptions bound at promotion, same workspace only, explicit allowlist). Snapshot the destination set and persist one delivery per destination in the platform DB before acknowledging.
3. Create one queue task per destination; deliver through the gateway to the receiver's `/events/deliver` with app-bound credentials. Receivers deduplicate `(eventId, handlerId)` in their durable inbox.
4. Apply attempts, backoff and dead letters per destination; one failing destination never blocks or reruns another. No subscriber is a recorded success.
5. Retain delivery records for 30 days with scheduled cleanup; payloads hidden from audit by default.

Acceptance:
- **M21.a:** one event with two subscribers is delivered once to each (inbox dedupe proven with duplicate tasks); a failing subscriber dead-letters without affecting the other.
- **M21.b:** cross-workspace subscription, unlisted event name, forged producer and replayed or expired delivery credentials are rejected.
- **M21.c:** gateway replacement or crash between persistence, enqueue and delivery loses no delivery and creates no duplicate effect.
- **M21.d:** subscription changes affect only new events; disabled subscriber receives nothing new.

Docs: event contract for hosted apps, relay semantics, retention and dead-letter operations. Evidence: real platform DB, multi-gateway relay crash matrix and ledger.

