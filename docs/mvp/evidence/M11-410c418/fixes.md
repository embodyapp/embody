# M11 fixes for the independent review of `410c418`

Review: [independent-review.md](./independent-review.md) (REJECTED: B1, B2). Fix commits on `feat/mvp-m11-build-admission`: `5f812ce`, `1c84dbc`, `2f37b5e`.

## Blockers

| Item | Fix | Regression |
|---|---|---|
| **B1** oversized manifest makes `settle` throw forever | Assemble refuses a manifest over 256 KiB and reports `{"rejected":"MANIFEST_INVALID"}` through its step output. `readOutput` throws a distinguishable `BuildOutputTooLargeError`, which `decideAdmission` maps to `MANIFEST_INVALID` (or, for the SBOM, `MANIFEST_MISMATCH`) instead of propagating. `settle` rejects a terminal build it still cannot decide after `BUILD_DEADLINE_MS` as `DEPENDENCY_UNAVAILABLE` rather than retrying it forever. | Unit: "B1: an oversized manifest settles as MANIFEST_INVALID", "B1: assembly and sandbox step rejections map to their codes", "B1: a finished build that cannot be decided is rejected after its deadline". `test:m11`: new adversary `oversized-manifest` (customer config declares 20,000 event names), expected and observed `MANIFEST_INVALID`. |
| **B2** expired `building` records never reclaimed; failing rows starve the sweep | `purgeArtifacts` reclaims an expired `building` record past its deadline: it cancels the build, rejects the record `BUILD_TIMEOUT` and deletes its outputs, and a later sweep purges it. The sweep pages through `expiredArtifacts(now, limit, after)` with a (retainUntil, workspace, artifact) cursor (byte-order collation in PostgreSQL), so skipped and failing rows no longer stay at the head. Each sweep acts on up to `limit` records and examines at most 10 × `limit` rows. | Unit: "B2: an expired building record is reclaimed, then purged", "B2: failing rows ahead of a purgeable one cannot starve the sweep" (5 failing rows ahead, `limit: 2`, the purgeable one is deleted). Store conformance (memory and **PostgreSQL**): "pages expired artifacts by cursor in a stable order", including a tie on `retainUntil`. |

## Non-blocking findings

| # | Disposition |
|---|---|
| 1 | Fixed. `cleanupOrphanedImages` keeps images whose tag is a recorded artifact ID (`artifactKeys` replaces `artifactDigests`). Regression: "finding 1: orphan cleanup keeps an unsettled build's tagged image" (then the build is still admitted). |
| 2 | Documented. BUILDS now states which fields the provenance digest covers; rejecting records that carry unplanned security fields is an M12 hardening item. |
| 3 | Documented as an M12 obligation (a lease per stage attempt) in BUILDS. |
| 4 | Fixed. The shared suite and the live suite fail on any expected case that was not recorded. A partial `EMBODY_M11_KINDS` run now fails by design. |
| 5 | Fixed. The sandbox step reports `BUILD_TIMEOUT` for a real timeout (exit 124, or 137 once the wall clock reached 420 s). An OOM kill stays `BUILD_FAILED`; the memory-hog adversary covers this, after a first attempt misclassified it. The timeout itself is still unit-tested only. The disk-quota note stands as a residual. |
| 6 | Fixed. A 400/403/5xx from the source fetch is `DEPENDENCY_UNAVAILABLE` (retryable); only 404 is `SOURCE_INVALID`. Read access is capped at an unpinned source's `retainUntil` and refused with less than a minute left. Regression: "finding 6". |
| 7 | Fixed. Logs are truncated, never refused, in all three providers. Known values are redacted before truncation. Regression: "finding 7". |
| 8 | Fixed. `artifactTransitionAllowed` freezes a settled decision (state, error, digests, image reference, manifest, provenance) in both stores. Regressions: unit "finding 8", plus memory and PostgreSQL conformance. |
| 9 | Documented. Log confidentiality under a container escape, the logs-bucket backstop, and repository-wide orphan listing (M16) are now in BUILDS. |
| 10 | Fixed. `devEngines` is rejected, and the prepare step passes `--config.manage-package-manager-versions=false`. |
| 11 | Documented as M13 obligations: `appId`/`appVersion` are claims, and the catalog comes from re-reading `manifest.json` against `manifestDigest`. |

## Also fixed while verifying

`test:m11` removed every container named `embody-m11-*`, which included the author's own disposable PostgreSQL fixture when run before the database gates. It now removes only `embody-m11-step-*` and `embody-sandbox-art_*`. No shared (`embody-local-*`) service was ever matched.

## Live run

Not repeated, as the review allows. The fixes stay inside `settle`, `purgeArtifacts`, the stores, the providers' read paths, the assemble and sandbox limit handling, the prepare step's error mapping and the input policy. The isolation claims rest on run `eb3f4c` ([live evidence](../M11-live-20b82dd/README.md)). The live retention case should be re-run the next time the live suite runs.

## Local results (clean candidate, Node 24.21.0)

All on clean `2f37b5e`, with a disposable M03 fixture (Compose project `embody-m11-verification`, port 55511, removed afterwards):

| Command | Result |
|---|---|
| `pnpm verify` | passed; optional DB-layer skips only |
| `pnpm test:verification` | passed 93, 0 skipped |
| `pnpm test:postgres` | passed 16, 0 skipped |
| `pnpm test:gateway-store` | passed **55**, 0 skipped (adds the PostgreSQL cursor conformance case) |
| `pnpm test:mvp` | passed **549**, 0 skipped: postgres 16, gateway-store 55, cloud-contracts 106, auth 6, host 109, MCP 18, gateway **223**, CLI 16 |
| `pnpm test:m11` | passed **10/10 cases, 15 builds** (adds `oversized-manifest` → `MANIFEST_INVALID`) |
