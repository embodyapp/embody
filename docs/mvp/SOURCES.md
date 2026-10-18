# M10: authenticated source admission

Implementation: archive format and policy in [`@embody/cloud-contracts` `source.ts`](../../packages/cloud-contracts/src/source.ts); admission API, persistence and storage port in [`@embody/gateway`](../../packages/gateway/src/source-admission.ts) ([storage adapters](../../packages/gateway/src/source-storage.ts)); `embody source` in [`@embody/cli`](../../packages/cli/src/source.ts).

M10 admits and stores source only. It never builds, deploys, imports or evaluates customer files: until MD09/M11 provide the isolated builder, uploaded source is inert data. A verified upload is the precondition for a later deployment submission (M12), not a submission.

## Flow

1. `embody source upload [dir] --workspace <ws_…> --app <app_…>` packs the directory into a deterministic `embody-source-v1` archive and checks it with the same reader the gateway uses.
2. `POST /v1/workspaces/:workspace/apps/:app/sources` with the archive digest and size. The gateway authenticates the workspace credential, requires an exact `deployment:submit` grant on that app (app-caller grants never deploy), checks the app is not disabled/deleted, admits the request through the M07 durable quota/audit path, then atomically persists the source record under the per-workspace lock (idempotency, pending and byte quotas). Only then does it issue upload access.
3. The CLI `PUT`s the archive to the returned URL with exactly the returned headers. The Embody token is never sent to storage.
4. `POST …/sources/:uploadId/complete`. The gateway reads the stored object (bounded to the declared size and pinned to the object generation), recomputes SHA-256, compares size and digest with the persisted record, then inspects the archive as data. The result is persisted as `verified` or `rejected`.
5. `GET …/sources/:uploadId` (requires `deployment:read`) returns status. There is no download or list endpoint.

Upload access is a bearer capability, so it is bounded: one server-derived object key (`sources/<ws>/<app>/<src>.tar.gz`), exact size (`x-goog-content-length-range: N,N`), create-only (`x-goog-if-generation-match: 0`), content type `application/gzip`, and a 10-minute expiry. It grants no read, list or delete. The CLI never prints it.

## Retries and interrupted uploads

The archive is deterministic (sorted paths, zero timestamps/owners, normalized modes, fixed gzip header), and the CLI derives the idempotency key from its digest. Re-running the same command therefore reuses the same upload ID and object key:

- Interrupted or expired transfer: nothing is stored (single-request PUT); `complete` returns `UPLOAD_INCOMPLETE`; the next create call renews access for the same upload ID.
- Already stored (client crashed before `complete`): the repeated PUT gets `412` and the CLI proceeds to `complete`.
- Digest or size mismatch (bytes corrupted in transit or swapped): the object is deleted, the record is `rejected`; a create call with the same key re-arms the same upload ID with `attempt + 1`, at most 3 attempts.
- Archive-content rejections (unsafe paths, bombs, forbidden files) are deterministic for that digest and stay terminal.

None of these steps submits a deployment or starts a build; `verifySubmissionSource` (for M12) accepts only a `verified`, unexpired record of the same workspace/app whose stored digest and size equal the submission's.

## Packaging rules (`embody-source-v1`)

Exclusions are applied first and win over inclusions. The gateway re-applies the same policy to every archive entry, so a hand-built archive cannot smuggle excluded files.

**Included (explicit allowlist):**

| Location | Files |
|---|---|
| Project root | `package.json` (required), `embody.config.ts`/`.mts`/`.js`/`.mjs` (required), `pnpm-lock.yaml`, `package-lock.json`, `npm-shrinkwrap.json`, `tsconfig.json`, `tsconfig.*.json`, `README.md`, `LICENSE`/`NOTICE` (optionally `.md`/`.txt`) |
| `src/`, `migrations/`, `public/` (any depth) | `.ts .mts .cts .tsx .js .mjs .cjs .jsx .json .sql .md .txt .css .html .svg .png .jpg .jpeg .gif .webp .ico .woff .woff2 .yaml .yml` |

Everything else is reported as `unsupported` and left out.

**Always excluded (with the reason the CLI reports):**

| Reason | Matches |
|---|---|
| `env-file` | `.env`, `.env.*` at any depth |
| `vcs` | `.git`, `.hg`, `.svn` |
| `dotfile` | any other path segment starting with `.` (e.g. `.npmrc`, `.aws/`, `.ssh/`, `.DS_Store`) |
| `dependencies` | `node_modules`, `bower_components`, `jspm_packages` at any depth |
| `build-output` | top-level `dist`, `build`, `out`, `coverage`, `tmp`, `temp`, `target`, `lib-cov` |
| `local-database` | `*.db`, `*.db3`, `*.sqlite`, `*.sqlite3`, `*.s3db`, `*.sl3`, `*.mdb`, `*.accdb`, `*.ldb` and their `-wal`/`-shm`/`-journal` files |
| `credential` | keys/certificates/keystores (`*.pem *.key *.p8 *.p12 *.pfx *.jks *.keystore *.kdbx *.crt *.cer *.der *.asc *.gpg *.pgp *.ovpn *.ppk`), `id_rsa*`/`id_ed25519*`…, `*.tfstate`, `*.tfvars`, `htpasswd`/`netrc`/`pgpass`, and data files (`json yaml yml txt toml ini xml csv conf cfg properties env` or no extension) whose name contains `credential(s)`, `secret(s)`, `service-account`, `client-secret`, `private-key`, `token(s)`, `password(s)` or `api-key` |
| `symlink`, `special-file` | symbolic links are never followed or packed; sockets/FIFOs/devices are skipped |

Packaging fails (nothing is uploaded) when an included file contains PEM private-key material, when a path is unsafe or case-collides, when `package.json` or `embody.config.*` is missing, or when a limit is exceeded. Messages name the file, never its content. `embody source pack [dir] [--out file] [--output json]` shows exactly what would be included and excluded without contacting the gateway.

## Archive limits (enforced before anything is accepted)

| Limit | Value | Source |
|---|---|---|
| Compressed archive | 10 MiB | `HOSTED_PROFILE.maxSourceBytes` |
| Expanded file bytes | 50 MiB | `HOSTED_PROFILE.maxExpandedSourceBytes` |
| Files / all entries | 2,000 / 4,000 | `HOSTED_PROFILE.maxSourceFiles` |
| Path | ≤ 240 UTF-8 bytes, ≤ 32 segments, relative, NFC, no `..`/`.`/empty segments, no `\`, `:`, control characters or trailing dot/space | `SOURCE_ADMISSION` |
| Compression ratio | expanded tar stream ≤ 100 × compressed size (1 MiB floor), checked while streaming | `SOURCE_ADMISSION` |
| Entry types | regular files and directories only; symlinks, hard links, devices, FIFOs, PAX/GNU extension headers, link targets and setuid/setgid/sticky modes rejected | reader |
| Uniqueness | duplicate, case-insensitively colliding and file-versus-directory paths rejected | reader |
| Integrity | POSIX ustar magic, header checksums, zero padding, complete end-of-archive and no trailing data | reader |

The gateway streams the archive through gunzip and never holds the expanded tree. `extractSourceArchive` (for the M11 builder) re-validates the whole archive first, extracts only into a directory it creates, uses exclusive no-follow file creation and re-checks every file digest.

## Quotas

| Quota | Value |
|---|---|
| Request rate / concurrency | M07 workspace admission (60/min, 20 in flight), shared with dispatch and recorded in durable audit as `source.create` / `source.complete` |
| Pending uploads with live access | 3 per app |
| Retained source bytes | 100 MiB per workspace (unexpired or pinned records) |
| Upload attempts after digest/size mismatch | 3 per upload ID |
| Request body | 16 KiB (`HOSTED_PROFILE.maxSubmissionBytes`) |

## Upload errors

Management errors use fixed public messages (`sourceError`); they never echo archive content, paths, provider text, tokens or upload URLs. Authentication failures (`401`) use the gateway's standard envelope.

| HTTP | Code | Meaning / action |
|---|---|---|
| 400 | `INVALID_INPUT` | Malformed request, body/route workspace or app mismatch, unknown fields (413 for bodies over 16 KiB, 415 for non-JSON) |
| 403 | `FORBIDDEN` | Credential lacks `deployment:submit` (or `deployment:read`) on the app, or the app is disabled |
| 404 | `NOT_FOUND` | Unknown app/upload, no grant for that app, or another workspace's/app's upload |
| 409 | `IDEMPOTENCY_CONFLICT` | Key already bound to another digest/size; use a new key |
| 409 | `UPLOAD_INCOMPLETE` | Object not stored yet; upload (re-request access with the same key if expired), then complete |
| 429 | `LIMIT_EXCEEDED` | Rate, pending-upload, byte or attempt quota; honor `retry-after` |
| 503 | `DEPENDENCY_UNAVAILABLE` | Store or storage unavailable or past its deadline; retry with the same key |
| 400 | `SIZE_MISMATCH`, `DIGEST_MISMATCH` | Stored bytes differ from the declaration; object deleted, retry re-arms (≤ 3 attempts) |
| 400 | `ARCHIVE_INVALID` | Not gzip/ustar, corrupt, truncated, unsupported files or missing `package.json`/`embody.config.*` |
| 400 | `ARCHIVE_LIMIT` | File count, size, path or compression-ratio limit |
| 400 | `UNSAFE_ENTRY` | Traversal, absolute/ambiguous path, link, special file, unsafe mode or path collision |
| 400 | `FORBIDDEN_FILE` | Excluded or secret-bearing file (env, VCS, dependencies, build output, local DB, credentials, private keys) |

CLI exit codes: `0` verified, `2` usage/packaging, `3` authentication, `4` permission, `5` not found, `6` rejected source, `7` storage/quota unavailable after bounded retries.

## Source retention

Each record stores `createdAt`, `accessExpiresAt`, `retainUntil`, actor, digest, size, tree digest and the optional `pinnedBy`. `purgeExpiredSources` deletes the object first and then the record (CAS), so no record points at a missing object and no object is orphaned by a failed sweep; M16 schedules the sweep.

**Decided (MD15, owner approved 2026-10-18):** unpromoted source (pending, rejected or verified but never referenced by a deployment) is deleted **7 days** after the upload was first requested. That is the frozen M02 contract value (`HOSTED_PROFILE.sourceRetentionDays`), long enough to deploy or retry, and keeps the least customer source at rest. Source referenced by a deployment or release is pinned (`pinnedBy`, set by M12/M13) and kept as long as that deployment (90 days) or release (active: indefinitely; inactive: 30 days) is retained, so rollbacks and audits can trace an image to its exact source. Storage cost is negligible against MD06 (at most 100 MiB per workspace of standard storage, under $0.01/month per workspace). Changing it is a one-constant contract change. Customer-data retention beyond source (MD10) stays open.

A bucket lifecycle rule on the `sources/` prefix (age > retention + 1 day) is a recommended backstop only while nothing is pinned; M12/M13 must move or exempt pinned objects before relying on it.

## Storage adapters

- `MemorySourceObjectStore`: local fake for tests and development. HMAC-signed PUT URLs with GCS-like semantics (key, exact length, content type, create-only, expiry); everything else is refused. Not durable.
- `GcsSourceObjectStore`: private Google Cloud Storage bucket. Upload access is a V4 signed URL signed through IAM `signBlob` by a dedicated signer service account (no private keys are stored); signed headers bind the exact length, create-only precondition and content type; expiry is capped at 15 minutes. Metadata, bounded generation-pinned reads and deletes use the JSON API with the gateway's workload token from the metadata server. Every provider call has a 10-second deadline and maps failures to opaque errors.

Bucket requirements: uniform bucket-level access, public access prevention enforced, no public or `allUsers` bindings, versioning off (create-only writes plus explicit deletes), same region as the gateway (`us-central1`). A signed PUT acts with the signer's permissions, so the dedicated signer service account holds only `roles/storage.objectCreator` on the bucket; the gateway identity holds object get/delete on the bucket (for example `roles/storage.objectUser`) and `iam.serviceAccounts.signBlob` on the signer (`roles/iam.serviceAccountTokenCreator`); users never get bucket IAM. Live GCS evidence is phase 2 of M10 and requires an owner-approved budget.
