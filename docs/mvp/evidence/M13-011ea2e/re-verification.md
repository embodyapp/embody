# M13 re-verification of `011ea2e` (after the `ef4bc73` re-review)

**Candidate:** `011ea2e630b8f13000b7aa391c123953b8a72e6b` on `feat/mvp-m13-provision-promote` (draft PR #54). **Diff checked:** `290a056..011ea2e`, 8 files, +212/−18: `docs/mvp/{IMPLEMENTATION,RELEASES,STATUS}.md`, `docs/mvp/evidence/M13-ef4bc73/independent-re-review.md` (new), `docs/mvp/evidence/M13-live-ef4bc73/README.md`, `infra/mvp/m13/{gcp,qualify}.mjs` (comments only), `packages/gateway/test/release.test.ts` (one new test). **`packages/*/src` is unchanged.**

**Reviewer:** an independent session that wrote none of this code. A narrow check against the re-review's "B4", N1, N5 and "Required for acceptance": only the diff and the files it names were read, and only `packages/gateway/test/release.test.ts` was re-run (29/29 passed, including the N1 test). `pnpm verify` and the database gates were not re-run (exact-candidate CI covers them); no cloud access, no fixtures, no repository changes.

## Checklist

| Item | Result | Where |
|---|---|---|
| Product code under `packages/*/src` unchanged | Met | `git diff 290a056..011ea2e --stat -- 'packages/*/src'` is empty |
| B4 1(b): Residual risks states the true capability | Met | `docs/mvp/RELEASES.md:182` |
| B4 1(b): identity table worker row states the true capability | **Not met** | `docs/mvp/RELEASES.md:114`: the row holds only the residual sentence; the grant list it replaced is gone from the "M13 grants" column, while `:119` still says "the live suite pins these grants exactly" and `qualify.mjs:106` points to this table. The row's "Never: … IAM administration" also contradicts `:182` (2), self-granting `run.admin` through `setIamPolicy` |
| B4 1(b): `gcp.mjs` header and role comment corrected | Met | `infra/mvp/m13/gcp.mjs:1–11`, `:27–35` |
| B4 1(b): `qualify.mjs` evaluator comment corrected (pins binding names, not what they allow) | Met | `infra/mvp/m13/qualify.mjs:105–112` |
| B4 1(b): owner's explicit acceptance recorded in STATUS, dated 2026-10-24 | Met | `docs/mvp/STATUS.md:79` |
| B4 1(b): hardening scheduled before G5 in IMPLEMENTATION | Met | `docs/mvp/IMPLEMENTATION.md:308` |
| N1: cross-app invoker regression pins the property | Met | `packages/gateway/test/release.test.ts:855–913`: `invokerFor` depends on the path's app as in production (`infra/mvp/m13/worker.mjs:120`, `wake-forwarder.ts:64`); B's token with A's audience on A's path gets 401, A's own token 503 (no served release), nothing forwarded |
| N5: reclaimers and policy bounds recorded for M15 | Met | `docs/mvp/RELEASES.md:105`; `docs/mvp/IMPLEMENTATION.md:308` |
| Remaining notes tracked (N2–N4, N6, N7, N9) | Met | `docs/mvp/RELEASES.md:167` |
| Live README cites the 14:01:37 wake-route and 14:01:38 drain request-log lines | Met | `docs/mvp/evidence/M13-live-ef4bc73/README.md:31–32`, `:35` |
| Live README case-count wording matches the JSON `counts` | Met | `docs/mvp/evidence/M13-live-ef4bc73/README.md:5` |

## CI

Run [40089013243](https://github.com/embodyapp/embody/actions/runs/40089013243): head SHA `011ea2e630b8f13000b7aa391c123953b8a72e6b`, **conclusion success**, all 9 jobs passed: quality (22, 24), postgres, postgres-matrix (22, 24), e2e-artifacts, e2e-artifacts-matrix (22, 24), terraform.

## Required to accept (docs only)

In `docs/mvp/RELEASES.md:114`, restore the worker's actual M13 grant list in the "M13 grants" column next to the B4 residual note (project-wide `base`; prefix-conditioned `secrets`, no `versions.access`; resource-level `actAs` on each runtime and token creation on each wake invoker; `cloudsql.client` and the provisioner credential). In the "Never" column, replace "IAM administration" with "no IAM-admin role (but see Residual risks: `setIamPolicy` on services)". Re-verification is then a docs diff check; CI is not needed unless code or tests change.

## Verdict

**Verdict: REJECTED** for M13 code and docs on `011ea2e`, only on the identity-table row above. The code, the N1 test, N5, the B4 Residual-risks text, the STATUS acceptance, the IMPLEMENTATION schedule, the live README and CI all pass. Once the row is corrected, acceptance is expected with no further code review. The confirming live run 8 is separate evidence; this verdict does not depend on it.
