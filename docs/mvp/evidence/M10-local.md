# M10 local evidence (2026-10-18), phase 1

Branch `feat/mvp-m10-source-admission`, stacked on #47 (`19b52e8`). Phase 1 is local and spends nothing in the cloud. Live authenticated-storage (GCS) evidence is phase 2 and waits for owner budget approval; acceptance also requires an independent review and exact-candidate CI on Node 22 and 24.

Environment: macOS, Node 24.21.0, pnpm 11.25.0, disposable M03 fixture (`postgres:16-alpine`, Compose project `embody-m10-verify`, port 55510). Shared `embody-local-*` services were not touched.

| Command (clean commit `6dcbb7c`) | Result |
|---|---|
| `pnpm verify` | passed (lint, license, typecheck, tests, build, API report, format); optional DB layer skips only (storage 15, host 45, gateway 4) |
| `pnpm test:verification` | passed: 82, zero skips |
| `pnpm test:mvp` | passed: **476, zero skipped**: postgres 16, gateway-store 49, cloud-contracts 95, auth 6, host 109, MCP 18, gateway 167, CLI 16 |

Two quick mutation checks confirmed the HTTP suite bites: disabling the digest comparison or the grant check each made the admission tests fail.

## Acceptance mapping

| Case | Evidence |
|---|---|
| M10.a | `cloud-contracts/test/source.test.ts`: traversal (`../`, nested `..`, absolute, backslash, colon, control/non-NFC), symlink/hard-link/device/FIFO entries, symlink-escape followed by a write through it (destination never created), duplicate/case-colliding/file-as-directory paths, a 40 MiB zero bomb (ratio), a declared 60 MiB entry, 2,001 files, oversize archive, corrupt/truncated/trailing/GNU/PAX archives, setuid mode, forbidden and unsupported files and PEM key content. `gateway/test/source-admission.test.ts`: the same classes over HTTP end in `rejected` with the object deleted and `verifySubmissionSource` refusing them; expired access (`400`), foreign key path, widened length range and read attempts (`403`), oversized body (`400`), second write (`412`); digest and size mismatches rejected. Hostile `embody.config.ts`/`src` code and `preinstall`/`postinstall` scripts are admitted as data and a marker file proves nothing ran. |
| M10.b | `packSource` and `embody source pack` on a fixture holding `.env`, `.env.local`, `src/.env.test`, `.npmrc`, `credentials.json`, `src/service-account.json`, `id_rsa`, `src/server.key`, `local.db`, `src/dev.sqlite(-wal)`, `.git/config`, `node_modules`, `dist`, `build`, `coverage` and symlinks: none are packaged, the decompressed archive does not contain the canary, exclusion reports carry paths only. Errors for private keys name the file, not the content. Gateway and CLI outputs, error bodies and audit records never contain the token, the canary or the signed URL; storage never receives the Embody token. |
| M10.c | Interrupted PUT (stream reset) stores nothing; `complete` answers `UPLOAD_INCOMPLETE`; `verifySubmissionSource` refuses the source; re-running reuses the same upload ID and object key and verifies; the CLI test retries a reset transfer and a corrupted one (attempt 2) under one identity and calls only `/sources` endpoints (no deployment or build). Another workspace (`401` on the route, `404` through its own path and in `verifySubmissionSource`), another app's deployer (`404`) and an app-caller (`403`) cannot read or complete the upload. Concurrent completions settle to one verified record. |
| Steps 2/4 | Grants and durable M07 quota/audit before any `admitSource` or upload-access call (spies assert zero calls on `403`/`404`/`401`/`429`); per-app pending and per-workspace byte quotas; idempotent replays and concurrency on memory and real PostgreSQL (shared conformance), CAS, immutable identity, bounded retry attempts, retention listing, pinning and purge. |

## Residuals and open items

- Live GCS: signed-URL acceptance, `x-goog-content-length-range`/`x-goog-if-generation-match` enforcement, bucket privacy and IAM are verified only against the local fake and unit tests with a local RSA signer. Phase 2 must prove them on the provider.
- Retention default (7 days unpromoted, pinned while referenced) is a proposal pending owner confirmation (MD10).
- No source is built or deployed (MD09/M11). M12 must call `verifySubmissionSource` inside submission and pin sources; M16 must schedule `purgeExpiredSources`.
- The gateway reads up to 10 MiB per completion in memory; the 20-in-flight workspace admission bounds the concurrency.
