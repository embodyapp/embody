# M10 live authenticated-storage evidence (2026-10-18)

```text
Task / acceptance cases: M10.a, M10.b (storage side), M10.c — live GCS phase
Owner / reviewer: claude / independent review pending
Date: 2026-10-18 (run 582c24 finished 12:35 UTC)
Commit: f7b1423 (clean tree; sanitized report run-582c24.json records commit and dirty=false)
Runtime: Node 24.21.0, pnpm 11.25.0; gateway in-process with @embody/gateway GcsSourceObjectStore
Environment: real GCP, project embody-cloud, us-central1, resource prefix embody-test-m10
Credentials: operator gcloud login (EMBODY_MVP_CLOUD_CREDENTIALS=gcloud), no key files
Budget: owner-approved $2 (2026-10-18); suite refuses budgets above $2
```

## Command

```sh
export EMBODY_MVP_CLOUD_PROJECT=embody-cloud EMBODY_MVP_CLOUD_RESOURCE_PREFIX=embody-test-m10
export EMBODY_MVP_CLOUD_BUDGET_USD=2 EMBODY_MVP_CLOUD_BUDGET_APPROVED=true
export EMBODY_MVP_CLOUD_CREDENTIALS=gcloud EMBODY_MVP_CLOUD_SUITES=m10
pnpm build && caffeinate -i pnpm test:mvp:cloud
```

The suite ([qualify.mjs](../../../../infra/mvp/m10/qualify.mjs), [gcp.mjs](../../../../infra/mvp/m10/gcp.mjs)) creates one private bucket `embody-test-m10-src-<run>` (US-CENTRAL1, uniform access, public access prevention enforced, soft delete off, versioning off, 8-day `sources/` lifecycle backstop) and one signer service account `embody-test-m10-sig-<run>` holding only `roles/storage.objectCreator` on that bucket. The operator gets `roles/iam.serviceAccountTokenCreator` on the signer only (resource-level, removed with the account). Project IAM is compared before and after. A names-only run record is kept in the private state bucket under `mvp/m10/runs/<run>.json`.

## Result: run `582c24` passed 11/11, zero skips ([report](./run-582c24.json))

| Case | Provider observations |
|---|---|
| propagation | Fresh signer IAM became effective after 62 s (5 attempts); later cases ran only after that |
| bucketPrivacy | UBLA on, PAP enforced, no `allUsers`/`allAuthenticatedUsers`, signer create-only, region US-CENTRAL1, versioning off; anonymous object read `403`, anonymous list `401`, GET with the signed PUT URL `400` |
| admitVerify | Gateway issued a `storage.googleapis.com` V4 URL (≤ 10 min); real PUT `200`; `complete` → `verified`; stored bytes re-read pinned to generation match the declared SHA-256 and size |
| accessBounds | One byte longer `400`, one shorter `400`, tampered signature `403`, same signature on another object key `403`, signed `x-goog-if-generation-match` header dropped `400`, widened length range `403`; valid PUT `200` (so none of the rejected requests stored anything); overwrite with same-length different bytes `412`; the other key stayed absent |
| expiredAccess | Access with a 5 s expiry used after 10 s: `400`, nothing stored |
| digestMismatch | Same-length corrupted bytes stored through valid access → `DIGEST_MISMATCH`, object deleted; retry re-armed the same upload ID (attempt 2) and verified |
| adversarialArchive | Symlink-escape archive stored, then rejected `UNSAFE_ENTRY` and deleted |
| interruptedUpload | PUT aborted mid-body: nothing stored, `complete` → `409 UPLOAD_INCOMPLETE`; re-run reused the same upload ID and verified; no deployment/build endpoint exists or was called |
| crossWorkspace | Workspace B deployer: A's upload via B's path `404`, status `404`, B's credential on A's route `401`; B's signed URL redirected to A's object key `403` |
| retentionPurge | With the clock past `retainUntil`, `purgeExpiredSources` deleted 6 real objects and records, 0 failures |
| cleanup | Bucket and signer removed; owned-name inventory empty (bounded re-check for IAM list lag); project IAM unchanged |

Spend: 23 class A and 33 class B operations, a few KiB stored for minutes; estimate **$0.0002** per run, about **$0.0004** for both runs, against the $2 approval (GCS Standard us-central1 list prices, 2026-10: class A $0.005/1k, class B $0.0004/1k, storage $0.020/GiB-month; IAM calls free). No invoice line is expected above $0.01.

## Earlier run `c524f3` (failed, kept for the record)

Run `c524f3` on `e603d34` ([report](./run-c524f3-failed.json)) passed 9 of 11. Both failures were in the suite's expectations, not in the admission path:

- GCS answers `400`, not `403`, when a signed header is missing from the request. The request was still rejected, and the following valid PUT returned `200`, proving nothing was stored. The check now accepts any 4xx.
- The signer was deleted (GET `404`) but the service-account list still showed it seconds later. The inventory now re-checks for up to 3 minutes. A manual check afterwards found no `embody-test-m10` buckets or service accounts.

The fix is commit `f7b1423`; the passing run above is a fresh full run on it, not a patched result.

## Cleanup and retained evidence

Final independent inventory at 12:35 UTC: zero `embody-test-m10*` buckets and service accounts in `embody-cloud`; both run records in the state bucket read `status: removed`. Retained: the two names-only run records (`mvp/m10/runs/c524f3.json`, `582c24.json`) and these sanitized reports. No tokens, signed URLs, payloads or connection strings are stored.

## Known gaps

- The gateway ran in-process on the operator machine with the operator identity for metadata/read/delete and signBlob; a Cloud Run gateway using its workload identity (`metadataAccessToken`) and the bucket IAM for that identity are exercised when the hosted gateway deploys sources (M12/M14).
- Source records lived in the memory store during this run; PostgreSQL persistence is covered by the mandatory `test:gateway-store` cases.
- Reviewer decision: pending.
