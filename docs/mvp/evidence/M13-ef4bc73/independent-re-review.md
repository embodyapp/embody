# M13 independent re-review: `ef4bc73` (tip `290a056`)

**Candidate:** product code `ef4bc73`. The reviewed tip is `290a056` on `feat/mvp-m13-provision-promote`, draft PR #54.
- `ef4bc73..290a056` changes only docs and the live-harness check in `infra/mvp/m13/qualify.mjs` (+12/−2), confirmed with `git diff --stat ef4bc73..290a056 -- packages scripts test infra`.
- **Fix diff:** `a561eaf..ef4bc73`, 26 files, +1658/−235.
- **Exact-candidate CI:** run 39792875459 on `5ac6fb9`: `success`, all 9 jobs green. `5ac6fb9..290a056` changes only `docs/mvp/STATUS.md`.

**Scope:** a focused re-review of blockers B1–B3, notes 1 and 3–9, the post-live-run design (app provisioning at reservation, resource-level grants, project-wide Cloud Run service management) and the live evidence of run `ed009e`. Code unchanged since `a561eaf` keeps the earlier review's "What was checked and holds".

**Reviewer statement:** a separate session; I wrote none of the M13 code, its fixes or the earlier review.
- Read-only in my own worktree, plus a scratch copy at `/tmp/m13rereview3/scratch` made with `git archive 290a056`.
- One disposable fixture, Compose project `embody-m13-rereview2` on port 55781, created fresh and torn down with `down --volumes --remove-orphans`.
- Read-only cloud access: Cloud Logging and audit logs in `embody-cloud`. The resources of run 8 (`embody-test-m13`) and any others were not touched.
- No repository changes; nothing spent.

## Verdict: **REJECTED**

Not dependent on the confirming live run 8.

- **B1, B2 and B3 as originally stated are fixed**, each with a mutation-proven regression; all local gates reproduce with zero skips.
- **The live B1 proof is stronger than the evidence README says**: Cloud Run request logs show the wake going through the worker's wake route to release B's candidate 13 minutes after A's candidate was deleted.
- **One new blocker (B4).** The worker's residual project-wide Cloud Run authority is described in RELEASES as "availability only … not read data or act as an app or the gateway". That is false: with `run.services.delete`/`create`, `run.services.setIamPolicy` and `actAs` on app runtimes, a compromised worker can take over the gateway's deterministic `run.app` URL, including the JWKS every app trusts, and forge any principal to any app. That is a least-privilege escalation beyond the identity table, mischaracterised in the contract: the same class as the original B3.

The minimal fix is docs plus an owner decision; no code change and no live re-run are required.

## Reproduction

Clean tree at `290a056`, Node 24.21.0, pnpm 11.25.0, `pnpm install --frozen-lockfile`.

| Command | Result |
|---|---|
| `pnpm verify` (no DB variables) | exit 0. Optional DB files skipped by design: gateway 294/4 skipped, storage 14/15, host 68/45 |
| `pnpm test:verification` | **109** passed, 0 failed, 0 skipped |
| `pnpm test:mvp` (fresh fixture) | **641** passed, 0 failed, 0 skipped |
| `pnpm test:m12` (fresh fixture) | **128** passed, 0 failed, 0 skipped |
| `pnpm test:m13` (fresh fixture) | **98** passed, 0 failed, 0 skipped (6 files) |

All counts match the author's claims. Every evidence JSON (`postgres` 16, `gateway-store` 68, `mvp` 641, `m12` 128, `m13` 98) records commit `290a0565a94d…`, `dirty: false`, `status: passed`, `failed = skipped = 0`.

### Mutation proof (scratch copy; `release.test.ts` + `cloud-release.test.ts`, 38 tests unmutated, all pass)

| Mutation | Result |
|---|---|
| M1: drain URL back to the candidate's own URL (`release-stages.ts:562`) | **2 fail** |
| M2: sweep stops at the first failure (`:791`) | **1 fail** |
| M3: paging removed (`cloud-release.ts:280`) | **1 fail** |
| M4: wake-route auth hook disabled (`wake-forwarder.ts:56`) | **1 fail** |
| M6: drain `Retry-After` not passed through (`:98`) | **1 fail** |
| M8: `customAudiences` dropped (`release-stages.ts:596`) | **1 fail** |
| M9: forwarder mints for the candidate URL instead of the wake audience (`wake-forwarder.ts:86`) | **1 fail** |
| M5: verifier uses a fixed app's invoker instead of the path's app (`:64`) | **survives** (N1) |
| M7: sweep wall-clock budget ignored (`release-stages.ts:774`) | **survives** (N2) |
| M10: deleted app forwarded instead of answered `gone` (`wake-forwarder.ts:74`) | **survives** (N2) |

## Blocker assessment

### B1: stable per-app wake route. **Fixed.**

- Authentication runs in an `onRequest` hook (`wake-forwarder.ts:55–70`) before body parsing; the verifier is bound to the audience `wakeUrl(base, ws, app)` and the invoker `invokerFor(ws, app)` from the path. Path components are regex-checked, bodies capped at 4 KiB, the verifier cache at 1,000 entries.
- Cross-tenant: the production `invokerFor` (`infra/mvp/m13/worker.mjs:120–121`) derives the invoker from `appResourceNames`; a task aimed at A's route with A's audience but signed by invoker B is refused. Correct, but not pinned by the regression (N1).
- Forwarding resolves the active release, mints as the same invoker for the same audience, candidates list the wake URL as a custom audience; drain 5xx → 503, numeric `Retry-After` passed through, forward failure → 503 `Retry-After: 5`, no release → 503 `Retry-After: 60`, deleted or unknown app → 200 `gone`. Bounded at 55 s inside the worker's 60 s timeout.
- **Live proof (independently checked):** audit log for `embody-test-m13-c-ed009e`: `CreateService ted009e-c7418…` (A) 13:31:55; `CreateService ted009e-c1615…` (B) 13:35:15; `DeleteService ted009e-c7418…` 13:48:02.686 (operation entries 13:48:03–04); no request logs for A after 13:47. Cloud Run request logs: `embody-test-m13-worker-ed009e` received `POST /_embody/wake/ws_m13ed009e02/app_m13ed009e02` at **14:01:37.80 → 200**; B's candidate received `/_embody/drain` at **14:01:38.15 → 200**. The step scheduled by A was delivered through the stable route to B, 13 minutes after A was deleted. Later wakes at 14:02:39–55 got 503/404 after the operator deleted B at 14:02:04 during teardown, as expected.

### B2: sweep starvation. **Fixed** (bounded, not strictly unstarvable; N3)

`list` follows `nextPageToken` up to 10×200 (`cloud-release.ts:262–283`); the sweep catches each failure and continues, stopping at 10 removals or 20 s. Remaining: the walk starts at the list head in a stable order with a shared budget, so slow failures at the head or very large keep volumes could still starve the tail (N3).

### B3: worker grants. **Fixed as stated, but replaced by a design whose residual is mischaracterised (B4)**

The secret `setIamPolicy` escalation is gone. The worker holds the project-wide `base` role (`gcp.mjs:33–42`), a prefix-conditioned `secrets` role (Secret Manager honours it), per-account grants from provisioning, and no queue or IAM-admin role. The live IAM case passed.

## NEW blockers

### B4. Project-wide Cloud Run service management is not availability-only: a compromised worker can take over the gateway (and its JWKS) and act as any app

**What the docs say:** RELEASES "Residual risks" (`:181`) and the identity table (`:114`) call it service management only, availability-only. The grants (`gcp.mjs:33–42`), the per-runtime `actAs` from `provisionAppIdentity`, and the JWKS at the gateway's deterministic `run.app` URL (`gcp.mjs:385`) say otherwise:

1. **Gateway takeover without `update`:** delete the gateway service, create one with the same name running any image as an app runtime (for which the worker holds `actAs`); Cloud Run URLs are deterministic per name, project and region, so the new service serves the gateway URL and its own `/.well-known/jwks.json`. Every hosted app then accepts attacker-signed tokens for any principal, and client credentials sent to the gateway are captured.
2. **"No update" is not a bound:** `run.services.setIamPolicy` on any service lets the worker grant itself `roles/run.admin` on that service, so `run.services.update` on platform services; and exposing any service with `allUsers` is an integrity change, not availability.
3. **"Not read data or act as an app":** `actAs` on each runtime plus `create` runs arbitrary code as any app (its `DATABASE_URL` secret), and the worker holds the provisioner credential. Within the intended deploy authority, but the sentence denying it is false.

**Fix (either):** (a) technical: candidates in a separate project, or a live-verified tag-based deny/allow; (b) minimum for this milestone: correct RELEASES, the `gcp.mjs` header and role comments and the `qualify.mjs` evaluator comment to state the true capability; record the owner's explicit acceptance in STATUS; schedule the hardening before G5 in IMPLEMENTATION (M16/M18).

## Notes 1, 3–9 and live-run findings

| Item | Status |
|---|---|
| Note 1 | Fixed: instance-conditioned binding at policy v3; 1,500-principal bound recorded. The evaluator does not check the condition (N8) |
| Note 2 | Moot: no IAM admin |
| Note 3 | Serialized by a session advisory lock; window recorded. SCRAM verifier neither adopted nor recorded (N9) |
| Note 4 | Fixed (`RECIPE_SCHEMA_VERSIONS`) |
| Note 5 | Fixed |
| Note 6 | 20 s budget; not test-pinned (N2) |
| Note 7 | `STEP_BUDGET` 25 s; idempotent, not stuck |
| Note 8 | Recorded |
| Note 9 | Fixed or moot |
| Diagnostic tags, socket `DATABASE_URL`, 429 backoff | Fixed and bounded |
| Scope namespaces | Recorded as an M14/M15 follow-up |
| Live harness fix (`ef4bc73..290a056`) | Waits up to 120 s for asynchronous deletes in M13.a and M13.e; reasonable |

## Live evidence assessment

Run `ed009e` on clean `ef4bc73`: 8 of 9 cases pass, cleanup and IAM-unchanged pass. The `replacedCandidateRemoved` failure is a check race, not an M13 defect; the audit and request logs confirm M13.e's substance. Acceptance need not wait for run 8 on B1 grounds. The evidence README should cite the request-log lines, and align "9 cases, 8 passed" with the JSON `counts` (passed 9, failed 1, including the gate entry). The live IAM case pins binding names, not what they allow, so it does not exercise B4.

## Non-blocking notes

- **N1.** The B1 test's `invokerFor` is constant, so a verifier bound to another app's invoker survives (M5). Add a case where invoker B with A's audience on A's path is refused.
- **N2.** The sweep budget (M7) and the deleted-app `gone` answer (M10) are not pinned.
- **N3.** Rotate the sweep's start offset or deprioritise recently failed names, add a per-candidate deadline; record until then.
- **N4.** Every durable wake holds a worker request for the drain's duration; wakes share worker capacity with deployment control (live: 2 instances × 4). Record and size it, or split the forwarder into its own service.
- **N5.** Reclaimer gaps: the per-app invoker member on the worker service's `run.invoker` policy and the worker's per-account grants are not named for M15; the policy member ceiling bounds durable apps; an authoritative IAM re-apply on the worker service would remove every wake binding.
- **N6.** An app provisioned non-durable that later deploys `durable-v1` is not checked for its queue/invoker; fail `APP_NOT_PROVISIONED` by checking the invoker account.
- **N7.** Non-5xx drain statuses pass through; harmless (Cloud Tasks retries any non-2xx), but mapping all non-2xx to 503 is cleaner.
- **N8.** Stale comments in the `gcp.mjs` header, `ONLY_SQL_CLIENT`, and the `evaluateReleaseBindings` doc; the evaluator checks role names, not permission contents or the Cloud SQL condition.
- **N9.** Note 3's SCRAM-verifier suggestion is neither adopted nor recorded.

## Required for acceptance

1. **B4:** either remove the worker's ability to delete, re-create or re-policy non-candidate services (with live proof), or correct RELEASES, the `gcp.mjs` and `qualify.mjs` comments to state the true capability, record the owner's explicit acceptance in STATUS, and schedule the hardening before G5 in IMPLEMENTATION.
2. **Evidence:** the M13 live README cites the request-log proof of B1 (or a passing run 8); case-count wording aligned with the JSON.
3. **Should accompany the fix:** N1 and N5. The remaining notes may be tracked.
4. With option 1(b), no code change and no new live run are needed; re-verification is a docs diff check, plus CI on the final commit if any code or tests change.
