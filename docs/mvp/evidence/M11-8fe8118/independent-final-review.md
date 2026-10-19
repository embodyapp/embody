# M11 isolated build and artifact admission: independent re-review of the B3 fix, candidate `8fe8118`

**Candidate:** `8fe8118` (draft PR [#50](https://github.com/embodyapp/embody/pull/50), branch `feat/mvp-m11-build-admission`). **Diff:** `bd10e10..8fe8118`:
- the fix, `12a4497` (`build-admission.ts`, +4/−2, and one new shared conformance case);
- the [`bd10e10` review](../M11-bd10e10/independent-final-review.md), cherry-picked as `a47e52a`;
- a docs-only commit, `8fe8118`.

**Scope:** B3 and notes N1–N3 of that review, plus any new defect the diff introduces. Everything else was accepted on `bd10e10` and is unchanged.

**Reviewer:** the same read-only session that wrote both earlier reviews, not the author. Runs used Node 24.21.0 on a clean checkout of the exact candidate. The disposable M03 fixture used Compose project `embody-m11-review-8fe8118` on port 55614 and was removed with `down --volumes`. No `embody-local-*` service was touched. No cloud calls were made and no money was spent. No product code was changed; this file is the only tracked change.

## Verdict: **ACCEPTED**

B3 is fixed, and no new defect was found. Together with the `bd10e10` review, every blocker raised against M11 (B1, B2, B3) is resolved. Under the tracker rules, M11 can be marked DONE once exact-candidate CI on `8fe8118` is green on Node 22 and 24. When this review was written, those checks were queued with no conclusions.

## B3: fixed

**The change.** `artifactTransitionAllowed` now compares `manifest` and `provenance` with the gateway's `canonical()`, which:
- sorts object keys recursively and keeps array order;
- drops `undefined` members, matching what a `JSON.stringify` write into jsonb keeps.

The jsonb key reordering therefore no longer matters, while a real change to any value is still refused. `finishedAt` is now frozen too (N3).

The `building → settled` path is unchanged. That includes the purge reclaim, which sets `finishedAt` on a `building` record. The purge fence copies `finishedAt` unchanged, so it still passes.

**Repro, re-run on real PostgreSQL 16** (`m11-final-bd10e10-pg-freeze.mjs`, unchanged). It goes through build, admit with manifest and provenance, then pin:

```text
pin of returned record: ok rel_aaaaaaaa
pin of re-read record: ok rel_aaaaaaaa
```

On `bd10e10` the first line was `BadRequestError Artifact identity and decision are immutable`.

**Regression.** The new shared case runs on both stores:
- it writes a durable manifest and provenance in non-canonical key order;
- it pins the record the store **returned**, then unpins a re-read record;
- it checks that a forged `publishes` or a changed `finishedAt` is still refused.

It does what B3 asked for. My repro fails on `bd10e10` and passes here, which independently confirms the author's report that the case fails on PostgreSQL with the old comparison.

## N1–N3

- **N1:** BUILDS now states the bound correctly: up to 10 × `limit` rows that are skipped or failing per sweep, the sweep restarting at the head, and M16 alerting on a non-zero `failed` count (or persisting the cursor between sweeps).
- **N2:** BUILDS now tells M12 to settle promptly and to treat a `DEPENDENCY_UNAVAILABLE` rejection from an overdue settle as a new attempt.
- **N3:** `finishedAt` is frozen. Arbitrary changes while a record is `building` remain allowed, identity apart. That is harmless and was not required.

## Reproduction (exact candidate, clean tree, Node 24.21.0)

| Command | Result |
|---|---|
| `pnpm test:postgres` | passed **16**, 0 skipped |
| `pnpm test:gateway-store` | passed **56**, 0 skipped (adds the B3 case on PostgreSQL) |
| `pnpm test:mvp` (includes `test:verification`) | passed **551**, 0 skipped: postgres 16, gateway-store 56, cloud-contracts 106, auth 6, host 109, MCP 18, gateway 224, CLI 16 |

All results match the fix record, and the evidence JSON records commit `8fe8118` with `dirty: false`.

`test:m11` and the live suite were not re-run, because the diff touches neither the recipe nor the providers nor the sandbox. The `bd10e10` results (10/10 cases, 15 builds) and live run `eb3f4c` still apply.

## Remaining obligations

None of these block M11; they are already recorded in BUILDS:
- **M12:** a lease per stage attempt, and the retry semantics from N2.
- **M13:** deploy only `imageReference`, pin artifacts it releases, and take the catalog from the retained `manifest.json` verified against `manifestDigest`.
- **M15:** serve `BuildAdmission.log`.
- **M16:** schedule the sweeps, alert on `failed`, and list orphaned images by package.
- **Hardening options:** provenance field coverage, per-build log scoping, and a private pool.
- **Next live run:** re-run the live retention case.
