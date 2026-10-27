# MVP verification and completion contract

## Rules

- A plan, code branch, green unrelated job or configured `minInstances: 0` is not completion evidence.
- Run mandatory tests on the exact integrated candidate. Record commit, image digests, dependency lockfile, schema and IaC revision.
- Database tests use real PostgreSQL and least-privilege runtime roles; mocks cannot establish isolation, migrations or locking behavior.
- Cloud tests use a dedicated approved project/resource prefix, explicit budget and cleanup inventory. Never run destructive drills against customer data.
- Missing required DB/cloud credentials must fail the selected gate, not silently skip it. Local unit suites may explicitly skip optional environments, but cannot satisfy release gates.
- Tests use injected clocks/barriers for determinism. Real cloud scale-down uses bounded observation of provider metrics, not an arbitrary sleep followed by an assumption.
- Evidence must not include tokens, connection strings, source secrets or customer payloads.
- M03 implements the local/CI runners documented in [TESTING.md](./TESTING.md). Later tasks extend their explicit suite list. The cloud entry point runs only implemented suites (M09–M12 so far) and fails closed for the rest; its evidence is not a release gate until M10–M17 and M19–M21 cloud suites exist.

## Test layers and commands

| Layer | Runner | Evidence |
|---|---|---|
| Workspace regression | Existing `pnpm verify` | Supported Node versions; lint/typecheck/build/API/format/license checks and tests |
| Real database | `pnpm test:postgres` | Explicit runtime/migration/other-app URLs and actual Docker container ID; maintenance migrations, non-owner runtime SQL negatives, storage and kernel cases, zero required skips; `pnpm test:gateway-store` additionally migrates a distinct platform DB and runs durable store/two-gateway/cold-start/MCP/SQL boundary cases |
| Packed/distributed regression | `pnpm test:baseline` (wraps existing consumer/E2E journeys) | Clean installed CLI/scaffold, real HTTP/MCP/database, Node 22/24 CI matrix and image-hash evidence |
| MVP contracts/integration | `pnpm test:mvp` | Current contracts/gateway + mandatory DB/isolation/failure-path suites; later tasks add source/build adversaries, controller recovery and effect ledgers |
| Deployment controller (local) | `pnpm test:m12` | Real platform PostgreSQL: crash matrix with SIGKILLed processes (commit/enqueue, resource/receipt, ACK), duplicate/concurrent/cancellation races, malicious tasks and ingress, zero skips ([deployments](./DEPLOYMENTS.md)). Fake queue and build provider; the real queue, worker and builds are the live suite's |
| Isolated build (local) | `pnpm test:m11` | Exact build plan on local Docker: clean scaffolds admitted and runnable, adversarial builds rejected or contained, zero skips. Recipe/admission evidence only, not provider IAM ([builds](./BUILDS.md)) |
| CLI journey (local) | `pnpm test:m14` | Packed CLI and scaffolder in a clean consumer against the local integration topology (real gateway, controller, build plan on Docker, release stages, per-app PostgreSQL, Docker candidates): M14.a–c journey cases, zero skips ([CLI](./CLI.md)). Provider stand-ins; the live journey is the M14 cloud suite |
| Real provider qualification | `pnpm test:mvp:cloud`: M09 ([runbook](./M09-QUALIFICATION.md)), M10 ([source storage](./SOURCES.md)), M11 ([builds](./BUILDS.md)), M12 ([deployments](./DEPLOYMENTS.md)), M13 ([releases](./RELEASES.md)) and M14 ([CLI journey](./CLI.md)) suites implemented, later suites fail closed | Fails on missing project/budget/credentials, on budgets above $25, on unimplemented suites and on any failed case; M10–M17 must add build/deploy/restore/zero-instance checks before it can stand for a release |
| Real client smoke | Versioned fixture and documented manual steps | Named MCP product/version, setup, cold call, quiescence and known limitations |
| Release audit | Proposed evidence checker plus human review | Every task/case has matching candidate evidence; customer/operating approvals are manual |

The integrated gate must include tests for both positive behavior and authentication, authorization, malformed input, dependency outage and concurrency negatives. Keep task-level commands available so a developer can reproduce one failed case.

## Release journey

All of the following must pass before M17/M18 are DONE:

| ID | Scenario | Required assertion | Task owners |
|---|---|---|---|
| V01 | Provision workspace A and B, scoped user/agent credentials | One workspace cannot enumerate/control the other; callers cannot deploy | M04/M05 |
| V02 | User deploys packed scaffold with CLI | No operator action after provisioning; ID/status visible, image and manifest bound to source | M10–M14 |
| V03 | CLI and MCP list apps/tools, execute CRUD | Same authorization, useful errors, agent guardrail and persistent data | M01/M06/M14 |
| V04 | All requests/connections quiesce | Actual zero instance intervals for gateway and apps, backed by provider metrics | M08/M09/M17 |
| V05 | Cold discovery via CLI and real MCP | Gateway wakes; no app invocation or app wake; catalog intact | M04/M06/M17 |
| V06 | Cold action with gateway/app at zero | Only target app wakes; bounded useful response; data survives | M07/M08/M17 |
| V07 | Replace gateway between initialize/list/call and app between CRUD calls | No session affinity or process-state dependency; identities unchanged | M04–M08 |
| V08 | Commit mutation, lose response | No blind replay; explicit unknown outcome; effect ledger has one effect | M07 |
| V09 | Database/policy/quota store outage | Fail closed; no permissive catalog or execution; recover without reseeding | M04/M07 |
| V10 | Malicious upload/build/runtime | No extraction escape, credential theft, lateral DB/cloud access or unbounded resource use | M09–M11 |
| V11 | Crash deployment at commit/enqueue/create/ACK boundaries | External recovery completes or reports failure; no lost job/duplicate promotion | M12 |
| V12 | Failed update, concurrent update, cancel and rollback | Previous app remains usable; one winning generation; incompatible rollback rejected | M13 |
| V13 | Revoke key, rotate signing/app secret, disable/delete during deploy | Revocation within bound; no stale job resurrection; no secret output | M05/M15 |
| V14 | Restore/export one app | Data checksums restored, old binding fenced, other workspace unchanged | M16 |
| V15 | Unsupported cron/local-state fixtures; events/workflows under request-only profile | Rejected with actionable errors; request-only outbox treatment bounded and documented | M08/M20 |
| V16 | Restart/replica switching after quota use or pending audit | Counters not reset; committed audit intent survives, interrupted outcome remains unknown | M07 |
| V17 | Idle observation while deployment worker/maintenance runs | No recurring gateway/app wake solely for maintenance; deployment survives gateway zero | M12/M16/M17 |
| V18 | Cost/latency/operating review | Measured budget and supported-client limits, recovery and customer-data approvals | M09/M16–M18 |
| V19 | Publish an event with gateway and apps at zero | Only the gateway and subscribing apps wake; each subscriber handles it once; unrelated apps stay asleep | M20/M21/M17 |
| V20 | Workflow with a delayed step, everything idle | No wake before the due time; step runs once when due; status/cancel/retry via CLI and MCP | M19/M20/M17 |
| V21 | Crash mid-step, mid-delivery and between enqueue/commit | No lost work, no duplicate effect in the ledger; failures dead-letter visibly | M19–M21 |
| V22 | Queue outage, cross-workspace subscription, forged drain/delivery | Writes fail closed; foreign and forged calls rejected; no app woken by denied work | M20/M21 |

## Scale-to-zero measurement protocol

1. Record effective service and revision configuration, including minimum/maximum instances, request billing, concurrency, startup and request limits.
2. Stop test-client activity and close connections normally. Do not delete services or force termination to fake scale-to-zero.
3. Observe provider metrics for zero-instance intervals with timestamps and account for metrics delay/idle retention. Do not poll the application itself to check if it is asleep.
4. Capture app invocation counts before cold catalog calls; after discovery, verify no invocation/wake on any app. Then call one app and verify unrelated apps remain asleep.
5. Run gateway-only cold and gateway-plus-app cold scenarios. Label database warm/cold status; include auth and connection establishment in external latency.
6. Collect at least 20 evidenced cold trials, p50/p95, failures and deadline behavior. If target budget fails, change supported limits/design or explicitly revise approved budget; do not omit failed trials.
7. Record idle behavior for the supported real MCP client. Active requests may keep instances running. A client that continually reconnects is not evidence for idle zero compatibility.
8. Correlate active durations and actual/estimated provider charges. Include database, build, storage, backup, egress and logging costs; do not multiply account-wide free allowances per app.

## Evidence record template

Store sanitized reports at `docs/mvp/evidence/<task>-<date>.md` or link to durable CI/artifact locations. Create reports when work is executed, not placeholder success reports.

```text
Task / acceptance cases:
Owner / reviewer:
Date / CI run URL:
Commit / lockfile / image digest / schema / IaC revisions:
Runtime / PostgreSQL / SDK / client versions:
Environment (local, integration, real cloud; region and resource prefix):
Commands (redacted; required environment variable names only):
Results (passed/failed/skipped counts, including negative cases):
Artifacts (logs, metrics, checksums, effect ledger):
Observed limits (cold latency, recovery time, cost):
Documentation changed:
Known gaps / residual risks / expiry and owner of exceptions:
Cleanup and retained evidence:
Reviewer decision:
```

No secrets in command lines or evidence. If an acceptance case is not executed, the task is not DONE. An approved scope amendment must update the task, this matrix and status explicitly; an exception note alone must not erase a required security or scale-to-zero gate.

## Release decision

M18 requires:

- All M01–M17 and M19–M21 accepted, with evidence for every applicable case on the final candidate.
- Workspace regression, real Postgres, packed consumer, distributed E2E and MVP suites passing; zero required skips.
- Real-cloud V04–V06, V17, V19 and V20 evidence, not configuration-only claims.
- Verified access isolation, mutation ambiguity handling, deploy recovery, rollback, revocation and restore.
- Approved budget, workload limits, supported client/version, support responsibility, terms/privacy and data retention.
- An explicit owner decision to release the invite-only candidate. No automatic claim of general availability or completion of broader P11–P15/hosting plans.
