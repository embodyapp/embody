# Minimal hosted MVP status

**Last updated: 2026-10-11. M01–M04 are DONE with independent automated review and exact-candidate CI. M04 executes 130 mandatory DB/store/MVP cases with zero skips and clean packed/E2E baselines on Node 22/24. G1/cloud/provider/secure hosted release verification remains open.**

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
| M01 | Integrate/reconcile existing gateway work | — | DONE | pi | #33 merged; acceptance fixes in [#34](https://github.com/embodyapp/embody/pull/34); [independent review](./evidence/M01-independent-review-2026-10-11.md) accepted; [final evidence](./evidence/M01-integration.md); candidate CI `38131459302` passed |
| M02 | Supported profile and deployment contracts | M01 | DONE | pi | [Contracts](./CONTRACTS.md), [evidence](./evidence/M02-2026-10-11.md); independent code/scope review accepted; [#34](https://github.com/embodyapp/embody/pull/34), candidate CI `38131459302`: Node 22/24 241 pass, 8 existing DB skips; 38 contract tests, zero skips |
| M03 | Trustworthy DB, package and cloud test gates | M01 | DONE | pi | [#35](https://github.com/embodyapp/embody/pull/35), [commands](./TESTING.md), [evidence](./evidence/M03-2026-10-11.md); independent review accepted; CI `38133604952`: mandatory DB/MVP 91 pass/zero skips, 12 runner negatives pass, clean Node 22/24 packed/E2E pass |
| M04 | Durable workspace catalog and credentials | M02, M03 | DONE | pi | [#36](https://github.com/embodyapp/embody/pull/36), [semantics](./WORKSPACES.md), [evidence](./evidence/M04-2026-10-11.md); independent review accepted; CI `38146111665`: mandatory130/zero skips (real store22), runner17, clean Node22/24 packed/E2E; no G1/provider qualification claim |
| M05 | App-bound identity and tenant isolation | M04 | BLOCKED | pi | [Draft#37](https://github.com/embodyapp/embody/pull/37), [identity/runbook](./IDENTITY.md), [accepted local review](./evidence/M05-independent-review.md); local MVP156/zero skips, runner23, initial Node22/24 CI all8 green; final candidate CI rerun pending. Owner must supply dedicated cloud project/access/approved budget for real metadata/IAM/private/external-ingress/rotation proof; no live qualification claimed |
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

**Completed implementation tasks: 4 / 18.** Existing framework code is a foundation, not proof these hosted acceptance cases have passed. Update this count when task states change.

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
| G0: integrated baseline/contracts/tests | M01–M03 | PASSED | M01–M03 accepted; #33/#34/#35 evidence. Later release candidates must rerun exact integrated gates; no cloud/release approval. |
| G1: secure persistent request-only gateway/runtime | M04–M09 | NOT_EVALUATED | — |
| G2: user-operated deploy and management | M10–M15 | NOT_EVALUATED | — |
| G3: recoverable operated candidate | M16 | NOT_EVALUATED | — |
| G4: actual scale-to-zero, isolation and client proof | M17 | NOT_EVALUATED | — |
| G5: invite-only release approved | M18 | NOT_EVALUATED | — |

## Activity log

- 2026-10-08 — Planning: added focused scope, 18 implementation tasks with acceptance cases, verification matrix and completion tracker at the user's request. No code/infra implementation, tests, deployments or runtime completion claimed. Existing `.gitignore` modification left untouched.

- 2026-10-08 — pi — M01 — NOT_STARTED → IN_PROGRESS — `feat/mvp-m01-integration` — refreshed GitHub refs; #29–#32 remain open. Isolated integration worktree preserves original uncommitted files; no remote merge/push authorized by this task execution.

- 2026-10-10 — pi — M01 — IN_PROGRESS → IN_REVIEW — `feat/mvp-m01-integration`, code candidate `d295465` — integrated #29/#30/#31/#32 locally; fixed auth-failure audit parity, unsafe update idempotency metadata and Compose init. Node 22/24 `pnpm verify`: 193 passed, 8 explicit Postgres skips each; Docker E2E passes on both; packed consumer passes with npm 11 on both; production audit clean. [Full evidence and limitations](./evidence/M01-integration.md). Combined CI/independent review pending; no remote push/merge. M03 DB gate remains open.

- 2026-10-11 — pi — M02 — NOT_STARTED → IN_PROGRESS → IN_REVIEW — `feat/mvp-m02-contracts`, isolated `../embody-mvp-m02` on remote main `024df01` after fetch-all/pull — implemented strict v1 schemas, request-only profile, scoped permissions, bounded transitions/retries, fingerprint/repository contract and CAS/cancellation predicates. Node 22/24 `pnpm verify`: 225 passed, 8 existing optional DB skips each; contract suite: 32 passed, zero skips. [Evidence](./evidence/M02-2026-10-11.md). Independent scope/defaults review and CI pending; M01 merged via #33, historical tracker acceptance still requires reconciliation. Original checkout changes preserved.

- 2026-10-11 — pi — M01 — IN_REVIEW → DONE — #33 / [#34](https://github.com/embodyapp/embody/pull/34) — independent automated review accepted after HTTP/MCP normalization/audit and stream-outcome fixes; exact combined candidate `bf74c4d6eee95607ba2c1b9a45065e85b35b50a3` [CI 38131459302](https://github.com/embodyapp/embody/actions/runs/38131459302) passed Node 22/24 quality, packed external consumer and actual Docker/PostgreSQL E2E. Integration/provenance reconciled. Standalone DB skips remain M03, not conformance evidence. Integrator acceptance under owner-directed completion; no human-review claim.

- 2026-10-11 — pi — M02 — IN_REVIEW → DONE — [#34](https://github.com/embodyapp/embody/pull/34), candidate `bf74c4d` — independent code/scope review accepted after app-generation response, separate fence scopes, nested freeze and repository-test fixes; 38 contract tests passed, zero skips. Exact candidate CI Node 22/24: 241 passed, 8 existing optional DB skips each; packed consumer/E2E passed. v1 design defaults accepted by integrator; provider qualification, spending/customer-data approvals and real-store enforcement remain later tasks.

- 2026-10-11 — pi — M03 — NOT_STARTED → IN_PROGRESS — `feat/mvp-m03-verification`, isolated `../embody-m03`, fast-forwarded to remote main `a2b5623` — mandatory PostgreSQL/runtime-role isolation, failure-path tests, MVP/cloud prerequisites, Node 22/24 packed/E2E evidence; no verification success yet claimed.

- 2026-10-11 — pi — M03 — IN_PROGRESS → IN_REVIEW — `feat/mvp-m03-verification` — mandatory PostgreSQL fixture: 12 DB/kernel cases; contracts/gateway plus DB: 91 passed, zero skips; 12 runner failure/redaction regressions pass; Node 24 verify: 241 passed, 11 optional DB skips plus 12 runner cases. Independent automated review accepted after normalized-credential redaction and actual DB image evidence fixes. [Evidence](./evidence/M03-2026-10-11.md); exact committed-candidate CI and clean Node 22/24 packed/E2E still pending.

- 2026-10-11 — pi — M03 — IN_REVIEW → DONE — [#35](https://github.com/embodyapp/embody/pull/35), head `8c7689d27a8b583fa89612a3e869a2b8f0f10469` — [CI 38133604952](https://github.com/embodyapp/embody/actions/runs/38133604952): actual DB/kernel 12 + contracts 38 + gateway 41 = 91 passed, zero required skips; 12 deliberate failure/redaction/budget cases passed; clean packed/distributed baselines passed on Node 22/24. Synthetic checkout `db1d389e` has identical implementation tree; sanitized image/version/count artifacts retained in evidence. Independent automated review and integrator acceptance; no human/provider/release approval claim. Local fixture cleaned. G0 passed, 3/18 tasks DONE.

- 2026-10-11 — pi — M04 — NOT_STARTED → IN_PROGRESS → IN_REVIEW — `feat/mvp-m04-catalog` — distinct platform DB and CAS store, exact app grants/workspace routes, no positive cache; local mandatory MVP130/zero skips + runner17; Node24 verify261 passes/11 optional DB skips. Separate read-only automated reviewer accepted final code after suggested interleaving/app-identity coverage. [Evidence](./evidence/M04-2026-10-11.md); clean exact-candidate Node22/24 CI/packed E2E pending.

- 2026-10-11 — pi — M04 — IN_REVIEW → DONE — [#36](https://github.com/embodyapp/embody/pull/36), candidate `c914edff4e199526872a4e42f7ef920cf4034bf6` — [CI38146111665](https://github.com/embodyapp/embody/actions/runs/38146111665) all six checks pass: appDB12 + real gateway-store22 + contracts38 + gateway58 = 130 pass/zero skips, runner17; clean Node22/24 packed/distributed baselines. Earlier packed dependency failure fixed/reviewed, not waived. Synthetic checkout has identical candidate tree; sanitized artifacts retained. Independent automated review/integrator accepted M04.a–d; local fixture cleaned, 4/18 DONE. G1/host token/provider/stateless MCP/quotas/audit/deployment controller remain open; no human/cloud approval claimed.

- 2026-10-11 — pi — M05 — NOT_STARTED → IN_PROGRESS — `worktree-session-dc56`, fast-forwarded clean worktree to origin/main `596af34` — asymmetric hosted signing/JWKS, workspace-bound host verification, rotation negatives, provider-token separation; Node24 verify278 passes/11 optional skips, mandatory MVP153/zero skips, runner17, packed/distributed baseline pass. [Development evidence](./evidence/M05-development.md); independent review, clean Node22/24 candidate CI, provider adapter/private ingress and live IAM proof remain open. Disposable DB fixture removed; no cloud resources provisioned.

- 2026-10-11 — pi — M05 — IN_PROGRESS → BLOCKED — `feat/mvp-m05-identity`, [draft#37](https://github.com/embodyapp/embody/pull/37) — completed Cloud Run metadata adapter/bootstrap and targeted live-probe tooling; independent automated reviewers accepted runtime/tooling after secret-mutation/impersonation/invocation/SQL-parser false-green fixes; local Node24 verify281/11 optional skips, runner23, mandatory156/zero skips including real probe SQL. Initial candidate `07d9684` [CI38150639785](https://github.com/embodyapp/embody/actions/runs/38150639785) all8 checks green on Node22/24, artifacts inspected; final hardening candidate must rerun. [Review](./evidence/M05-independent-review.md). Only owner-approved dedicated cloud fixture/access/budget and subsequent live acceptance can unblock DONE; no cloud resources/spend authorized or performed.

Append entries as: `date — owner — task — state transition — branch/PR — commands/result/evidence — review or blocker`.
