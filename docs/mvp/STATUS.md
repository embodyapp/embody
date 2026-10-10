# Minimal hosted MVP status

**Last updated: 2026-10-10. M01 is IN_REVIEW with fresh local evidence; combined CI and independent review remain pending. No cloud verification claimed.**

Scope: [README](./README.md). Tasks and acceptance cases: [IMPLEMENTATION](./IMPLEMENTATION.md). Required evidence: [VERIFICATION](./VERIFICATION.md).

## How to use this tracker

1. Check dependencies and current branch/PR state before claiming work.
2. Set one owner and `IN_PROGRESS`; append a dated activity entry and branch/PR link.
3. Add implementation, executable acceptance tests and the task's documentation.
4. Record exact commands, results and evidence location; set `IN_REVIEW`.
5. Reviewer checks every acceptance case and applicable regression gates. Set `DONE` only with accepted evidence and docs.
6. If a later change invalidates evidence, reopen the task and record the missing rerun. Never reuse an old pass as a fresh result.

States: `NOT_STARTED`, `BLOCKED` (explain why), `IN_PROGRESS`, `IN_REVIEW`, `DONE`. Only `DONE` means completed; every other state means **not completed**. `NOT_STARTED` does not imply dependencies are satisfied. A separate boolean is intentionally avoided so status cannot contradict itself.

## Work tracker

| ID | Task | Depends on | State | Owner | Evidence / PR / blocker |
|---|---|---|---|---|---|
| M01 | Integrate/reconcile existing gateway work | — | IN_REVIEW | pi | [Integration evidence](./evidence/M01-integration.md); candidate `d295465`; Node 22/24 verify, Docker E2E and npm-11 consumer pass; CI/reviewer pending |
| M02 | Supported profile and deployment contracts | M01 | NOT_STARTED | — | Request-only scope recorded; executable contracts pending |
| M03 | Trustworthy DB, package and cloud test gates | M01 | NOT_STARTED | — | Dedicated Postgres CI wiring/skip behavior requires correction |
| M04 | Durable workspace catalog and credentials | M02, M03 | NOT_STARTED | — | Reuse P15-05/P15-08 work if available |
| M05 | App-bound identity and tenant isolation | M04 | NOT_STARTED | — | Asymmetric tokens and actual provider IAM proof pending |
| M06 | Stateless MCP and supported client contract | M04, M05 | NOT_STARTED | — | Must verify per-request capability and idle behavior |
| M07 | Safe dispatch, quotas and durable audit | M04, M05, M06 | NOT_STARTED | — | Existing dispatch PR is only a foundation |
| M08 | Request-only sleep-safe host/scaffold | M02, M03, M05 | NOT_STARTED | — | Outbox retention/unsupported-feature behavior must be implemented |
| M09 | Cloud/database qualification and costs | M03, M05, M08 | NOT_STARTED | — | Provider database, region and budget decisions below |
| M10 | Authenticated safe source admission | M02, M04, M05, M09 | NOT_STARTED | — | — |
| M11 | Isolated build and artifact admission | M08, M09, M10 | NOT_STARTED | — | — |
| M12 | Durable deployment controller/recovery | M04, M09, M10, M11 | NOT_STARTED | — | — |
| M13 | Provision/migrate/promote/rollback | M05, M08, M09, M12 | NOT_STARTED | — | — |
| M14 | Packed CLI deploy/control journey | M06, M10, M12, M13 | NOT_STARTED | — | — |
| M15 | Logs/secrets/lifecycle controls | M07, M13, M14 | NOT_STARTED | — | — |
| M16 | Recovery/operations/customer-data readiness | M07, M09, M13, M15 | NOT_STARTED | — | Includes manual accountable approvals |
| M17 | Real zero-instance and centralized-control proof | M03–M16 | NOT_STARTED | — | Requires actual cloud/client evidence |
| M18 | Candidate review and controlled release | M01–M17 | NOT_STARTED | — | Owner release decision required |

**Completed implementation tasks: 0 / 18.** Existing framework code is a foundation, not proof these hosted acceptance cases have passed. Update this count when task states change.

## Decision ledger

| ID | Decision | State | Owner / due | Result / evidence |
|---|---|---|---|---|
| MD01 | User CLI deploy; centralized CLI/MCP control | ACCEPTED | Owner conversation | README product promise |
| MD02 | Gateway and apps must reach zero instances | ACCEPTED | Owner conversation | Mandatory M17/V04–V06/V17, no warm-instance correctness dependency |
| MD03 | Narrow request-driven profile; background jobs/workflows and GenUI excluded | ACCEPTED-SCOPE | Owner conversation | Does not mark broader framework gates complete |
| MD04 | Cloud Run runtime, one region | BASELINE | M09 owner | Confirm region/project/quota and actual controls before deployment |
| MD05 | Managed PostgreSQL provider and backup tier | OPEN | M09 owner | Qualify Neon versus Cloud SQL; no free-tier production assumption |
| MD06 | Monthly ceiling and resource/cold-latency limits | OPEN | Owner + M09 | Approve before real cloud test spend; alerts are not hard caps |
| MD07 | First supported token-capable MCP client/version | OPEN | M06 owner | Real initialization/call/quiescence proof required |
| MD08 | Request-only generated-CRUD outbox semantics | OPEN | M08 owner | Preserve transaction safety; bound retention; no false delivery promise |
| MD09 | Isolated build provider/recipe and runtime network controls | OPEN | M09/M11 owner | Negative IAM/network/build tests required for user source |
| MD10 | Customer-data retention/restore/support/terms | OPEN | Owner + M16 | Approve before any customer data; manual decisions need evidence |

## Milestone gates

| Gate | Required tasks | State | Evidence |
|---|---|---|---|
| G0: integrated baseline/contracts/tests | M01–M03 | NOT_EVALUATED | — |
| G1: secure persistent request-only gateway/runtime | M04–M09 | NOT_EVALUATED | — |
| G2: user-operated deploy and management | M10–M15 | NOT_EVALUATED | — |
| G3: recoverable operated candidate | M16 | NOT_EVALUATED | — |
| G4: actual scale-to-zero, isolation and client proof | M17 | NOT_EVALUATED | — |
| G5: invite-only release approved | M18 | NOT_EVALUATED | — |

## Activity log

- 2026-10-08 — Planning: added focused scope, 18 implementation tasks with acceptance cases, verification matrix and completion tracker at the user's request. No code/infra implementation, tests, deployments or runtime completion claimed. Existing `.gitignore` modification left untouched.

- 2026-10-08 — pi — M01 — NOT_STARTED → IN_PROGRESS — `feat/mvp-m01-integration` — refreshed GitHub refs; #29–#32 remain open. Isolated integration worktree preserves original uncommitted files; no remote merge/push authorized by this task execution.

- 2026-10-10 — pi — M01 — IN_PROGRESS → IN_REVIEW — `feat/mvp-m01-integration`, code candidate `d295465` — integrated #29/#30/#31/#32 locally; fixed auth-failure audit parity, unsafe update idempotency metadata and Compose init. Node 22/24 `pnpm verify`: 193 passed, 8 explicit Postgres skips each; Docker E2E passes on both; packed consumer passes with npm 11 on both; production audit clean. [Full evidence and limitations](./evidence/M01-integration.md). Combined CI/independent review pending; no remote push/merge. M03 DB gate remains open.

Append entries as: `date — owner — task — state transition — branch/PR — commands/result/evidence — review or blocker`.
