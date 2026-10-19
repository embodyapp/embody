# M11 isolated build and artifact admission: independent review of candidate `410c418`

**Candidate:** `410c418` (draft PR [#50](https://github.com/embodyapp/embody/pull/50), branch `feat/mvp-m11-build-admission`, stacked on #49 at `037aa4c`). Its code is identical to `5bf4178` and `20b82dd`, the live-run commit; `20b82dd..410c418` changes only docs and evidence. **Diff:** `037aa4c..410c418` (44 files, +7,139/−39). **Scope:** M11 steps 1–5 and acceptance cases M11.a–c in [IMPLEMENTATION](../../IMPLEMENTATION.md#m11--isolated-build-and-immutable-artifact-admission), checked against [VERIFICATION](../../VERIFICATION.md), the [STATUS](../../STATUS.md) tracker rules and the MD09 row.

**Reviewer:** a separate read-only session, not the author. Local runs used Node 24.21.0 and pnpm 11.25.0 on a clean checkout of the exact candidate. The disposable M03 fixture used Compose project `embody-m11-review-410c418` on port 55611 and was removed afterwards with `down --volumes`. No `embody-local-*` service was touched. No cloud resources were created and no money was spent. No product code was changed; this file is the only tracked change. The repro script (`m11-review-410c418-stuck-building.mjs`) and its output are in the session notes folder. The script runs against the candidate's built `dist` with the memory store and `MemoryBuildProvider`.

## Verdict: **REJECTED**

The isolation design is sound and the evidence holds up:
- Customer code runs only in a no-network nested container, and source enters it only through a platform Dockerfile.
- Admission binds the provider record, the trusted step outputs, the provider-reported digest, the manifest and the SBOM.
- Tags are never trusted.
- Every local suite reproduces with zero skips.

Two blockers remain, both in step 5 (bounded retention and cleanup of failed and orphaned artifacts). They are the same class of retention-liveness defect that sent M10 back:

1. **B1:** a customer can make `settle` throw forever. The artifact then stays `building` permanently.
2. **B2:** expired `building` records are never reclaimed, and they can starve `purgeArtifacts`.

## Reproduction (exact candidate, clean tree, Node 24.21.0)

| Command | Result |
|---|---|
| `pnpm test:verification` | passed **93**, 0 skipped |
| `pnpm test:m11` (Docker) | passed **10/10 cases, 14 builds in 274 s**. Every `embody-m11-*`/`embody-sandbox-*` container and recipe-labelled image was removed. |
| `pnpm test:postgres` | passed **16**, 0 skipped |
| `pnpm test:gateway-store` | passed **54**, 0 skipped |
| `pnpm test:mvp` | passed **538**, 0 skipped: postgres 16, gateway-store 54, cloud-contracts 106, auth 6, host 109, MCP 18, gateway 213, CLI 16. Matches [TESTING](../../TESTING.md) and [M11-local](../M11-local.md). |

The evidence JSON for all of these records commit `410c418`, `dirty: false`. **Exact-candidate CI:** at review time, `quality` 22/24, `e2e-artifacts` 22/24 and `postgres-matrix (22)` were green; `postgres-matrix (24)` and the `postgres` aggregate were still running. The tracker requires that run to finish green regardless of this verdict.

## Blockers

### B1. An oversized manifest makes `settle` throw forever; the artifact stays `building`

**Where the bytes come from.** Customer code owns `/out` inside the sandbox, so it controls `manifest.json`. The assemble step keeps up to `maxManifestBytes + 1` bytes of it ([build-admission.ts](../../../../packages/gateway/src/build-admission.ts) `assembleScript`, `head -c 262145`). It records the digest of those bytes as trusted step output, and Cloud Build uploads the object.

**Why `settle` throws.** `decideAdmission` reads the object with `readOutput(path, maxBytes)`. Both providers then throw `BuildProviderError("Build output too large")` instead of returning a decision:
- `CloudBuildProvider.read` fetches range `0-maxBytes`, receives `maxBytes + 1` bytes and throws.
- `MemoryBuildProvider.readOutput` throws for the same input.

Neither `decideAdmission` nor `settle` catches this. The build-deadline branch only covers non-terminal builds. So every `settle` throws forever, and the record never becomes `rejected`.

**Repro** (memory store and provider, honest provenance and trusted step outputs, a 262,145-byte manifest):

```text
+0h settle throws: BuildProviderError Build output too large | state building
+2h settle throws: BuildProviderError Build output too large | state building
+9600h settle throws: BuildProviderError Build output too large | state building
purge at +400d: { deleted: 0, failed: 0, skipped: 1 }
orphan cleanup at +400d: { deleted: 1, kept: 0 }
record still present: building
```

Promotion stays closed: nothing is admitted. But the failed build never settles:
- M12 would retry the stage forever, and the user never gets the documented `MANIFEST_INVALID`.
- The record is never purged (B2).
- Its image is deleted after 80 minutes as an "orphan" while the record still exists (finding 1).

No unit, local or live case covers an oversized manifest.

**Fix:**
- Treat any output above the limit as a terminal rejection (`MANIFEST_INVALID` or `OUTPUT_LIMIT`). For example, have the assemble step refuse a manifest over the limit and report the rejection through its step output, and have `readOutput` return a distinguishable "too large" result instead of throwing.
- Give terminal builds their own deadline: a terminal build that still cannot be decided after `BUILD_DEADLINE_MS` is rejected rather than retried forever.
- Add the case to the unit suite and to `test:m11`.

### B2. Expired `building` records are never reclaimed, and they can starve `purgeArtifacts`

**Never reclaimed.** `purgeArtifacts` skips every record with `state === "building" && !finishedAt`. Only `reject` and `admit` set `finishedAt`, so every `building` record is skipped. Purge has no way to settle or cancel one; it relies on M12 calling `settle`. B1 shows `settle` cannot always finish, and an abandoned deployment never calls it at all. [BUILDS](../../BUILDS.md#retention-and-cleanup) says "until settled" with no backstop.

**Starvation.** `expiredArtifacts` returns the oldest `limit` rows by `retain_until`, in both stores:

```sql
ORDER BY retain_until LIMIT $2
```

A building record expires at `createdAt` + 90 days (`deploymentRetentionDays`); rejected records expire after 14 days and admitted ones after 30. Stuck building records therefore move to the head of the expired set and stay there.

Once `limit` (default 100) such records exist anywhere on the platform, every sweep returns only those rows and skips them all. Every later expired admitted or rejected artifact then keeps its image, outputs and logs indefinitely. B1 lets customers create these records, and ordinary abandoned deployments create them too.

The same head-of-line problem applies to tombstones whose provider delete keeps failing (for example a version that Artifact Registry refuses to delete). They are retried first on every sweep. The live retention case used `limit: 1000` with 14 records, so it could not show this.

**Fix:**
- Keep `building` records out of the expired-set query, or reclaim them there: cancel the build and reject with `BUILD_TIMEOUT` once past `BUILD_DEADLINE_MS`.
- Make the sweep advance past rows it skips, for example with a cursor, by excluding skipped states in SQL, or with a separate bounded retry set for failing tombstones.
- Add a conformance case where more than `limit` unreclaimable rows precede a purgeable one.

## Non-blocking findings

Each finding is numbered so a fix can cite it.

1. **Orphan cleanup deletes the image of a finished but unsettled build.** `cleanupOrphanedImages` keeps only digests that a record already references. A `building` record has no digest until it settles. If a successful build is not settled within `ORPHAN_AGE_MS` (80 min; an M12 outage is enough), its image is deleted (repro: `deleted: 1`). A later `settle` then admits a digest whose image no longer exists. This fails closed at deploy, but the artifact is wrongly marked `admitted`. **Fix:** keep images tagged with the `artifactId` of any existing record (tags are safe to use to *keep* an image), or have `settle` check that the image exists.

2. **The provenance digest covers only the fields the platform sets.** `toProviderBuild` drops step `allowFailure`, `allowExitCodes`, `waitFor`, `volumes`, `dir`, `secretEnv` and `script`. At build level it drops `availableSecrets`, `options.pool`, `options.env`, `options.volumes`, `options.secretEnv`, `options.machineType` and `automapSubstitutions`. A record carrying any of these still matches `configDigest`.

   Customers cannot exploit this: only the controller can create builds, and `find(tag)` uses an unguessable artifact tag. But [BUILDS](../../BUILDS.md#admission-trusted-code-outside-the-build) claims the record matches the plan "exactly". **Fix:** reject provider records that carry any security-relevant field the plan did not set, or soften the claim in the docs.

3. **Concurrent `start` calls can submit two builds.** If two callers reach `ensureSubmitted` before either records a `buildId`, both see `find(tag) === null` and both submit. The CAS loser's build pushes under the same mutable tag and is later removed as an orphan. The unit and live idempotency cases are sequential only. **Fix:** M12 must serialize each stage attempt (lease), or `ensureSubmitted` should CAS a `submitting` marker before it submits. Record this in BUILDS as an M12 obligation.

4. **"Zero skips" is not enforced by the suite's structure.** In `infra/mvp/m11/suite.mjs` and `qualify.mjs`, most cases are recorded only when their job exists or an earlier case succeeded (`if (job("probe"))`, `if (deps.retag && …)`, `if (job("durable")?.record.state === "admitted")`). The runners hard-code `skipped: 0`, and there is no list of expected cases. A missing job would silently drop its case and the run would still pass.

   The evidence itself is complete: run `eb3f4c` recorded all 14 cases, and `test:m11` recorded all 10. **Fix:** assert the exact expected case set, and count a missing case as failed.

5. **Sandbox bounds that were not exercised, and one doc/code mismatch.**
   - The 420 s sandbox timeout makes the sandbox step exit 1 with no step output, so it surfaces as `BUILD_FAILED`. The troubleshooting table says `BUILD_TIMEOUT`.
   - The timeout was never executed; local evidence already says it is unit-tested only.
   - Sandbox writes have no disk quota. They are bounded only by the wall clock and the per-build VM's disk, which affects only the customer's own build.

6. **Source read URL lifetime.**
   - If Cloud Build queues the build for more than 10 minutes, the prepare fetch gets a 400 and maps it to `SOURCE_INVALID`, which is not retryable. A platform delay then becomes a permanent customer error. Map a 400/403 from an expired signature to `DEPENDENCY_UNAVAILABLE`.
   - The read URL is not capped at the source's `retainUntil`, which was the M10 F2 lesson. The window is at most 10 minutes and the URL goes only to the trusted step, so the risk is small.

7. **Log read and redaction edge cases.**
   - `BuildAdmission.log` reads at most 2 MiB and throws when the provider log is larger, instead of truncating. Cloud Build prefixes each log line with its step, so a 1 MiB sandbox output made of very short lines probably expands past 2 MiB, and those logs become unreadable for M15.
   - `redactBuildLog` truncates before it redacts. A known canary that straddles the 1 MiB cut therefore leaks its prefix. The pattern-based rules (`X-Goog-Signature=`, PEM with `|$`) still match partial values.
   - **Fix:** truncate instead of throwing. Redact known values before truncating, or over a margin as long as the longest canary.

8. **The artifact store does not freeze admitted fields.** `sameArtifactIdentity` freezes the identity, `buildId` and `imageDigest`. It does not freeze the state transition (`building → admitted|rejected` only) or the admitted `imageReference`, `manifest`, `manifestDigest`, `sbomDigest` and `provenance`. A buggy M13 pin write could change any of them. **Fix:** enforce these in both stores.

9. **Documentation gaps.**
   - BUILDS says a container escape could "rewrite logs in the logs bucket". With `storage.objectUser` there, it could also **read** every tenant's build logs (confidentiality). State this, or scope log access per build.
   - The retention "backstop" names an *outputs*-bucket lifecycle rule for `logs/`, but logs live in the logs bucket.
   - `cleanupOrphanedImages` lists the whole builds repository on every call (O(all images) per app). M16 should list by package instead.

10. **Hardening (not shown to be exploitable).** The prepare step runs pnpm with network access and the builder's token, in the customer's `package.json` directory. The input policy blocks `.npmrc`, `pnpm-workspace.yaml` and pnpmfiles, because the M10 extraction allowlist rejects them, and pins `packageManager`. It does not reject `engines`/`devEngines`, and recent pnpm releases can download a runtime or package manager when `devEngines` asks for one. Consider rejecting `devEngines` and passing `--config.manage-package-manager-versions=false` to the prepare-step pnpm calls.

11. **Handoffs for M13 and M21.** `manifest.appId` and `appVersion` are customer claims, not the platform app identity, so M13 must not use them as identity. The artifact keeps only `catalogDigest`, so M13 needs the catalog from somewhere else. It can re-read the retained `manifest.json` and check it against `manifestDigest`, or compare the running host's catalog against the digest. Record which one in BUILDS.

## What was checked and holds

**Step 1 (pinned recipe):**
- `assertRecipeConfig` refuses unpinned images and a builder that is not a service account.
- The plan is generated entirely by the platform, with no customer Dockerfile.
- Every literal `$` is escaped with split/join, and `substitutionOption: MUST_MATCH` is set.
- The lockfile policy requires exactly one importer, an exact match with `package.json`, registry-only `name@version` keys and sha512-only resolutions.
- `@embody/*` must be the bundled build, with the same version and integrity.
- Aliases and protocols are blocked by the spec regex and the importer version regex, and YAML aliases and custom tags are disabled.
- The prepare step runs `pnpm fetch` with `ignore-scripts`, `ignore-pnpmfile` and the registry forced on the command line.
- The M10 allowlist, which extraction re-applies, keeps dotfiles, `pnpm-workspace.yaml` and pnpmfiles out of the source, so no customer config reaches the networked step.

**Step 2 (customer code only in the sandbox):**
- The nested container has `--network none`, so it cannot reach the metadata server and has no builder token.
- It runs as uid 1000 with `--cap-drop ALL`, `no-new-privileges`, memory equal to memory-swap, pids, cpus and nofile limits, and an empty env-file.
- It has no Docker socket, `/workspace`, step environment or `$BUILDER_OUTPUT`. The input comes from a platform Dockerfile with COPY only and no network.
- The container is killed before `docker cp`, so nothing it starts can run after the copy.
- Output size is bounded twice (`head -c`, then `stat`), and the tar comes from a real filesystem, so it cannot write through a symlink.
- The assemble Dockerfile has no `RUN` instruction, and `--chown node` means no file in the image is setuid root.
- Live probe `M11.a.sandbox-probe`: the metadata server by IP and by name, the npm registry, the storage and Cloud Run APIs and another app's live signed URL were all blocked. The probe saw no platform env vars and could not write to the recipe. The process limit held.

**Steps 3–4 (admission):**
- Order: provenance (`configDigest` over the executed form; the source URL is excluded, while `EMBODY_SOURCE_DIGEST` is included and re-checked against the prepare step output), then status, then the trusted prepare and assemble step outputs.
- The image must be exactly one, with the planned name and a provider-reported `sha256`; the build's own claims are never used.
- The manifest and SBOM must hash to their trusted digests.
- `BuildOutputSchema` and `appManifestSchema` are strict.
- The profile is re-derived from the catalog. The preflight can only make admission stricter, and durable flags must match exactly.
- The admitted reference is `repo@digest`. The tag case (`M11.b.retag`) shows that repointing a tag changes neither the record nor a fresh decision.
- Admission signs nothing and runs nothing with elevated credentials.
- The durable manifest (profile, sorted publishes, subscriptions, workflow target/version/steps, `catalogDigest`, with a refinement that keeps request-only artifacts empty) is enough for M19–M21 event and version binding. `ReleaseManifest.artifact` embeds it.

**Step 5 (records, logs, cleanup), apart from B1 and B2:**
- CAS writes have an immutable identity, a unique (workspace, app, deployment, attempt) key in both stores, and invisible purging tombstones.
- `start` is idempotent sequentially, and a crash between submit and record is recovered through the unguessable provider tag.
- Rejection deletes the image, also found by tag, and the outputs.
- Log output is bounded and redacted.
- The live retention case removed all 14 records with their images and outputs.

**Acceptance cases:**
- **M11.a:** the live IAM inspection matched the exact builder bindings. The admitted image ran as a no-role identity and every privileged call returned `403`. Container escape is a documented residual; finding 9 adds log confidentiality to it.
- **M11.b:** all rejection codes were produced both locally and live. Substitution was replayed against real provider records. That is the only practical method, because the builder's create-only outputs cannot be overwritten. No rejected artifact left an image.
- **M11.c:** both scaffolds were admitted and run on Cloud Run under Node 24 as uid 1000, and each compiled the admitted catalog digest. Three canary formats appeared in the raw log and were absent from the redacted one.

**MD09 row:** consistent with the code and the live evidence, including the mutable-tag rationale and the egress policy the owner confirmed.

## Required for acceptance

1. Fix B1 and B2, with regressions:
   - an oversized manifest is rejected and the record settles;
   - more than `limit` unreclaimable expired rows do not block a purgeable one;
   - an expired `building` record is reclaimed.
2. Re-run `pnpm test:mvp` and `pnpm test:m11`. A new live run is **not** required if the fix stays inside `settle`, `purgeArtifacts`, the stores and the assemble script's limit handling. The live evidence on `20b82dd` still covers the isolation claims. The live retention case should be re-run when the live suite next runs.
3. Green exact-candidate CI on Node 22 and 24, then a focused re-review of the fix.

Findings 1 and 4 are cheap to fix alongside B1 and B2 and are recommended. The others can be tracked for M12, M13, M15 and M16.
