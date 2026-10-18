# M10 independent review: candidate `19cd93e`

**Candidate:** `19cd93e` (draft PR #48, branch `feat/mvp-m10-source-admission`). The code is identical to `a5514a9`: `a5514a9..19cd93e` touches only `docs/mvp/STATUS.md`. **Diff reviewed:** `6d24a3a..19cd93e` (36 files, +5,662/−57), stacked on #47 (M09) and #43.

**Reviewer:** separate read-only reviewer. I read every changed source, test and infra file and the evidence. Out-of-tree checks ran on a disposable M03 fixture (Compose project `embody-m10-review-19cd93e`, port 55810, removed afterwards; no `embody-local-*` service was touched). No cloud calls were made and no money was spent. The repro scripts are kept outside the repo, in the session notes folder (`m10-review-19cd93e-probe{1..5}.mjs`). The only tracked file this review changes is this one.

## Verdict: **REJECTED**

One blocker: under a retention sweep (and, more narrowly, a stale completion), a source can end up `verified` while its object has been deleted. `verifySubmissionSource` accepts that record, and re-running the CLI cannot repair it. Everything else meets M10.a–c and steps 1–4. The fix is small and local (see B1). After it, I expect to accept, conditional on green exact-candidate CI.

## Reproduction of local suites (exact candidate, clean tree, Node 24.21.0)

| Command | Result |
|---|---|
| `pnpm test:postgres` | passed 16, 0 skipped |
| `pnpm test:gateway-store` | passed 49, 0 skipped (it failed 2 non-M10 app-DB cases when run before `test:postgres` on a fresh fixture, as TESTING.md's order requires) |
| `pnpm test:mvp` | passed **476**, 0 skipped (matches the M10-local evidence count) |
| `pnpm test:verification` | passed 86, 0 skipped (82 in M10-local plus the 4 later `m10-cloud` tests) |
| Package suites: cloud-contracts `source.test.ts`, gateway `source-admission`/`source-storage`, cli `source.test.ts` | 57 / 26 / 3 passed |

`pnpm verify` and Node 22 were not rerun by the reviewer. CI must cover them.

## Blocker

### B1. A `verified` record can point at a deleted object (unconditional object deletes vs. renew in place)

`purgeExpiredSources` (`source-admission.ts:224`) lists expired records, then for each one deletes the object **unconditionally** and only afterwards CAS-deletes the record. `decideSourceAdmission` renews an expired, unswept record **in place**: same upload ID and object key, state `pending`. The completion `reject` path (`source-admission.ts:464`) has the same problem: it deletes the key without pinning the generation it inspected.

**Failing scenario 1 (honest user, no fault injection, reproduced on MemoryGatewayStore and real PostgreSQL):**
1. Source S is verified on day 0.
2. On day 7 the sweep lists S (expired, unpinned). It then works through up to 100 records, one sequential provider DELETE each, so reaching S takes seconds.
3. Before the sweep reaches S, the user re-runs `embody source upload` on the same tree:
   - create renews S in place (`pending`, attempt 1, new `retainUntil` = day 14);
   - the PUT gets `412`, because the old object still exists;
   - `complete` reads the old object and S becomes `verified`.
4. The sweep reaches S and deletes the object. `deleteSource` then fails its revision CAS, so it returns `false` and counts nothing as failed.

Result (probe4/probe5):
- `record verified, retainUntil +7d, object present false`;
- `purge { deleted: 0, failed: 0 }`;
- `verifySubmissionSource` → **ACCEPTED**;
- another CLI re-run gets `create → verified`, with no upload offered.

The idempotency key is derived from the digest, so the user is stuck with a byte-less verified source for that tree until the new `retainUntil` (7 days), unless they change the content. M12/M11 would accept the submission and then fail to fetch the source.

**Failing scenario 2 (stale completion, narrower):**
1. A same-length corrupted upload exists. Completion B reaches its `reject` delete, and that provider DELETE is slow (simulated by delaying the first delete call).
2. Meanwhile completion A rejects (`DIGEST_MISMATCH`), the user re-arms (attempt 2, same object key), uploads the correct bytes, and completion C verifies.
3. B's delete then lands and removes the verified object. B's CAS loses, so it reports `verified`.

The end state and the `verifySubmissionSource` result are the same as in scenario 1 (probe2).

**Why this blocks:**
- It contradicts SOURCES.md ("no record points at a missing object") and the M12 precondition (a verified source whose stored digest and size match).
- In scenario 1 the end state is unrecoverable through the documented retry path, which is M10.c's "resumes/restarts safely" property.
- Scenario 1 requires no fault, only a re-run that coincides with the scheduled sweep.

**Suggested fix (any one closes scenario 1; the first two close both):**
- Make deletes generation-conditional. Add `generation` to `SourceObjectStore.delete`, use GCS `ifGenerationMatch`, and treat `412` as "already replaced, leave it". `reject` already holds `info.generation`.
- In purge, fence the record before touching the object. CAS it to a `purging` state or tombstone (revision bump) first, then delete the object, then delete the record. `admitSource` must then treat a fenced record as a fresh identity (new upload ID/object key) or as `DEPENDENCY_UNAVAILABLE`, never renew it in place.
- Alternatively, renewal of an expired record could always allocate a new upload ID/object key.

Add an interleaving regression test for each path to the shared conformance or HTTP suite. Optionally, have `verifySubmissionSource`'s M12 caller `stat` the object as defence in depth.

## Per-step and per-case verdicts

| Item | Verdict | Notes |
|---|---|---|
| Step 1: packaging and exclusions | ACCEPT | Allowlist plus exclusion-first `classifySourcePath`, applied again by the gateway to every entry, PEM content scan, symlinks/special files never followed or packed, deterministic archive (digest-derived key). The docs match the code. |
| Step 2: authorize and quota before capacity | ACCEPT | Order verified: workspace auth hook → route/credential workspace match → exact app grant + `deployment:submit` + not disabled/deleted → body binding → M07 `admit` → `admitSource` (per-workspace `FOR UPDATE`, pending/byte quotas) → `createUploadAccess`. Spies in the HTTP test assert zero calls on 401/403/404/429. The signed URL binds the key, exact length, create-only and content type; 10-minute expiry, signer capped at 15 minutes. |
| Step 3: verify and safe extraction; no evaluation | ACCEPT | Generation-pinned bounded read, size and SHA-256 compared before inspection. The tar reader enforces checksums, ustar magic, type allow-list, link-name/setuid rejection, NFC/traversal/colon/backslash/control/trailing-dot rules, duplicate, case and file-vs-dir collisions, header-declared size before content, streamed ratio cap, end-of-archive and trailing data. Extraction re-inspects, creates a fresh 0700 root, uses `O_EXCL|O_NOFOLLOW`, a realpath containment check and per-file digest re-check. The gateway never imports customer files; the marker test proves nothing ran. |
| Step 4: identity, retention, retries | **REJECT (B1)** | Identity is immutable (memory check plus PG `WHERE` on key/objectKey/digest/bytes), CAS and bounded attempts are correct, and retries reuse one upload ID. The retention sweep vs. renew-in-place and the stale reject delete break the record↔object invariant. |
| M10.a | ACCEPT | Traversal, symlink/hard link, bombs (40 MiB zero, declared 60 MiB, ratio), 2,001 files, expired/foreign/widened/tampered access (memory fake and live GCS) and digest/size mismatch all end in rejection before anything could execute. My probes agree: PAX `x` and second-member entries after EOA are rejected, and a missing end block is rejected. |
| M10.b | ACCEPT | The fixture secrets and local DBs are absent and the canary is not in the decompressed archive. Errors name files, never content. Fixed public messages; token, canary and `sig=` are absent from outputs and audits; storage receives no `authorization` header (CLI test). |
| M10.c | **REJECT (B1)** | Interrupted PUT stores nothing → `UPLOAD_INCOMPLETE` → same identity verifies; no deployment/build endpoint is called; cross-workspace 401/404, other-app 404, app-caller 403 (local and live). B1 is a restart/retry path that ends in an unrecoverable state. |

## Non-blocking notes

- **N1. Rejections are audited as `success`.** `complete` returns rejected records rather than throwing, so `audited()` records `outcome: "success"` for `DIGEST_MISMATCH`/`UNSAFE_ENTRY`/… even though the HTTP status is 400. probe3 shows that sequence of audits: `source.complete:success` for the 400. Record a failure outcome and error code for rejected completions.
- **N2. `GET …/sources/:id` bypasses M07 admission and audit.** It is a cheap, scoped read, but it is the only source route without a rate limit (probe3: 5 GETs, no `admit` calls). Either admit it or document the exemption.
- **N3. Rejected and never-uploaded records count against the 100 MiB byte quota for 7 days.** A deployer can lock their own workspace's quota with records whose objects were deleted or never written. The pending cap (3 per app) only limits records with live access, so about 10 never-completed 10 MiB declarations, created over about 40 minutes, block the workspace for a week. Each workspace can only harm itself. Consider counting only `verified` records and live `pending` ones, and charging rejected ones nothing.
- **N4. `updateSource` calls in `complete` have no route deadline.** Admit/stat/read/delete are wrapped in `deadline()`, but the CAS write is not. The PG pool's 5 s statement/query timeouts bound it in practice; the memory store has no such bound.
- **N5. Possible GCS `Content-Encoding` differential (unverified, needs a cents-level live probe).** `Content-Encoding` is not a signed header. If GCS accepts an unsigned `Content-Encoding: gzip` on the signed PUT, it later transcodes on read (undici sends `Accept-Encoding: identity` with a `Range`). The gateway would then verify the *decoded* bytes while the stored object differs, which is possible because an attacker can tune the outer gzip length to the declared size. Only the uploader's own app is affected. Suggest requesting `contentEncoding` in `stat` and rejecting any value, or adding it to the live suite.
- **N6. Name-based credential exclusion covers data extensions only.** `src/secrets.ts`, `src/config/credentials.js` and `migrations/seed-passwords.sql` are packed (by design, as documented). The PEM scan catches private keys; other secret literals in code are not detected. It is worth one line in the CLI output or docs.
- **N7. Small reader leniencies (no security impact).** A single zero end block is accepted ("complete end-of-archive" in SOURCES.md implies two). Trailing zero bytes after the gzip member are accepted. Bidi-override and Windows-reserved names (`src/CON.ts`) pass the path policy. A PEM header longer than the 64-char carry can evade the scan across a chunk boundary (heuristic only).
- **N8. Extraction ordering.** `extractSourceArchive`'s `directory` callback runs `mkdir(recursive)` before `inside()`. It is safe today because the tree is fresh and link-free, but check first so M11 does not inherit the pattern.
- **N9. Live-suite scope (already disclosed in the evidence).**
  - The gateway ran in process with the operator identity for metadata/read/delete/signBlob and the memory record store. The Cloud Run workload identity, its bucket IAM (`objectUser` + `signBlob` on the signer only) and the PostgreSQL-backed live path remain M12/M14 work.
  - The $2 budget is an approval ceiling plus a post-run estimate, not a runtime cap. That is acceptable at the observed $0.0002 per run.
- **N10. `packSource` TOCTOU.** `lstat` then `readFile` would follow a symlink swapped in between, and `--out` writes through an existing path or symlink. Both are on the user's own machine, so this is low priority.

## Evidence check

- **M10-local.md:** counts match my rerun (`test:mvp` 476/0). `test:verification` is now 86 because of the later m10-cloud tests.
- **M10-live-f7b1423:** the README and `run-582c24.json` are internally consistent (11/11, cleanup with project IAM unchanged, about $0.0002). The failed run `c524f3` is retained honestly, with an explained expectation fix (`f7b1423`). No tokens, signed URLs or payloads appear in either JSON. The live cases don't exercise B1: the sweep runs with no concurrent renewal.

## Required before re-review

1. Fix B1 on both paths (purge/renew and stale reject), with interleaving regression tests that fail on `19cd93e`.
2. Preferably also N1 (audit outcome) and N3 (quota accounting). The rest can be follow-ups.
3. Green exact-candidate CI on Node 22 and 24 for the new head, with zero skips in `test:mvp`/`test:gateway-store`. The live GCS run need not be repeated unless the storage port's delete semantics change (generation-conditional delete would change them, but the memory fake plus a mocked-GCS unit test is enough unless the owner wants live proof of `412` on a conditional delete).
