# M11 live Cloud Build qualification (2026-10-19)

Task / acceptance cases: M11.a, M11.b, M11.c and steps 1–5 ([IMPLEMENTATION](../../IMPLEMENTATION.md#m11--isolated-build-and-immutable-artifact-admission), [contract](../../BUILDS.md)).
Owner / reviewer: claude / independent review pending.
Commit: `20b82dd` (clean tree), branch `feat/mvp-m11-build-admission`, [#50](https://github.com/embodyapp/embody/pull/50).
Environment: project `embody-cloud`, `us-central1`, Cloud Build regional default pool (`e2-standard-2`), resource prefix `embody-test-m11`, operator gcloud login (no key file), Node 24.21.0 on the operator machine, Docker Desktop with `buildx` for the `linux/amd64` recipe image.
Command (names only): `EMBODY_MVP_CLOUD_SUITES=m11 EMBODY_MVP_CLOUD_PROJECT EMBODY_MVP_CLOUD_RESOURCE_PREFIX EMBODY_MVP_CLOUD_BUDGET_USD=5 EMBODY_MVP_CLOUD_BUDGET_APPROVED=true EMBODY_MVP_CLOUD_CREDENTIALS=gcloud caffeinate -i pnpm test:mvp:cloud`.
Result: **run `eb3f4c` passed 14/14 cases, zero skips**; sanitized report [`mvp-cloud-m11.json`](./mvp-cloud-m11.json) (`releaseGate: false`).

## Cases

| Case | Live result |
|---|---|
| `M11.a.builder-iam` | The builder holds exactly: `artifactregistry.writer` on the builds repository, `artifactregistry.reader` on the recipe repository, `storage.objectCreator` + `legacyBucketReader` on the outputs bucket, `storage.objectUser` + `legacyBucketReader` on the logs bucket. No project role, no source-bucket access, and no binding on itself or the runtime identity (no impersonation). |
| `propagation` | Read-signer `signBlob` usable after 46 s (4 attempts). |
| `M11.a.sandbox-probe` | Root `postinstall` running in the Cloud Build sandbox, as uid 1000: metadata server by IP and by name, registry.npmjs.org, storage.googleapis.com, the Cloud Run API and a **live 15-minute signed URL for another app's source** were all `blocked`. It saw no Docker socket, `/workspace` or `/builder/outputs`, no platform environment variables, and could not write `/embody`. 487 of 700 attempted processes started (512-process limit). |
| `M11.a.resource-bounds` | A 16 GiB heap allocation was killed by the 4 GiB limit (`BUILD_FAILED`); 576 MiB of output was refused (`OUTPUT_LIMIT`). |
| `M11.b.inputs-and-failures` | `BUILD_FAILED` (failing build script), `LOCKFILE_REJECTED` (stale, tarball-resolved, missing lockfile), `UNSUPPORTED_RUNTIME` (foreign `@embody/core` integrity, `pnpm@9`), `UNSUPPORTED_PROFILE` (durable app submitted as request-only), `CAPABILITY_MISMATCH` (durable with `workflows: false`). |
| `M11.b.substitution` | Replayed against a real successful build: honest → admitted; manifest edited after the build → `MANIFEST_MISMATCH`; image under another name and a second image → `IMAGE_INVALID`; record from another service account and another source digest → `PROVENANCE_INVALID`. |
| `M11.b.retag` | The admitted durable artifact's tag was repointed at another app's image in the registry. The artifact still references its own `@sha256` digest, and a fresh admission of the same build binds the same digest: tags are never trusted. |
| `M11.b.never-promotable` | No rejected artifact has an image reference, manifest or public digest, and no image of a rejected build is left in the registry (including the two policy-rejected builds whose images had been pushed). |
| `M11.c.scaffold-request-only` / `-durable` | Both clean scaffolds were admitted by `…/builds/<ws>/<app>@sha256:…` with SBOM and provenance. The durable manifest records profile `durable-v1`, `publishes: ["app.submitted"]`, `subscriptions: ["app.submitted"]` and workflow `app.followUp` `0.1.0`. Each admitted image ran as a **Cloud Run job** under a no-role runtime identity: it ran on Node 24 as uid 1000 and compiled the admitted catalog digest. Every privileged call from it was `403`: source-bucket list, outputs-bucket write, Cloud Build create, Cloud Run deploy, Secret Manager list and impersonating the builder. |
| `M11.c.log-redaction` | The canary build printed a private key, a `ya29.` token and a signed-URL signature. All three are in the raw provider log and absent from `BuildAdmission.log`. |
| `M11.idempotent-start` | Repeating `start` for an attempt returned the same artifact and submitted no second build (14 submissions for 14 attempts). |
| `M11.step5.retention` | `purgeArtifacts` after retention removed all 14 records with their images and outputs; no image left. |
| `cleanup` | Cloud Run job, three buckets, two repositories and three service accounts removed; owned-name inventory empty; project IAM unchanged. Cloud Build was already enabled, so there was no enablement delta. |

## Provider behaviour learned (fixed on this branch)

The first live runs failed closed and each exposed one provider fact, now encoded in code, tests and [BUILDS](../../BUILDS.md):

1. Artifact Registry `getIamPolicy` is a GET.
2. A throwaway Docker config must keep the operator's CLI plugins and endpoint.
3. Fresh `signBlob` grants take 30–50 s to propagate.
4. Cloud Build refuses a user-specified logs or artifacts bucket the builder cannot get (`FAILED_PRECONDITION`, "bucket does not exist"), and rewrites the log object during the build. Hence the separate logs bucket with object read/write, and bucket get on the create-only outputs bucket.
5. Cloud Build reports steps **after substitution**, so the provenance digest compares the executed form.
6. `docker cp -a` on the Cloud Build daemon resolves the container user in the **host** passwd file. Source therefore enters the sandbox through a per-build input image (platform Dockerfile, `COPY --chown`, no RUN, no network).
7. Image deletes are long-running operations that can fail, and immutable-tag repositories refuse to delete tagged versions. Hence mutable tags (nothing deploys by tag; see `M11.b.retag`) and deletes that wait for the operation and treat NOT_FOUND as already deleted.
8. Idempotent provider calls retry, and the suite always records cleanup. One interrupted run (`9567d0`, a network error after its builds) was reconciled with the provider's own teardown by run ID: everything was removed and the inventory was empty.

## Spend

| | |
|---|---|
| Owner-approved one-off budget | $5 (2026-10-18), raised to **$8 total** (2026-10-19) |
| This run | 16 build-minutes; suite estimate **$0.35** (builds at list price plus a $0.25 fixed allowance) |
| All 16 live runs | about 229 build-minutes ≈ **$1.37** at the $0.006/min list price, plus well under $0.05 for repositories, buckets, Cloud Run job seconds and egress. Conservative suite tally ≈ $5.38, within $8 |
| Invoice | Not yet checked. The 2,500 free build-minutes per billing account per month likely cover the builds; record the invoice when available |

## Not covered here

- The runtime-identity negatives cover the no-role probe identity, not a provisioned app runtime with database and queue grants. That is M13/M17.
- No deployment controller (M12) or promotion (M13) drives these calls yet.
- A private pool with no public egress remains the upgrade path for the build VM itself.

Reviewer decision: pending independent review.
