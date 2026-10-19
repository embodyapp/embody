## Disposition (read-only)

I only read the six named files. I didn't run anything, edit anything, or contact the cloud. The mandatory 156/zero-skip result is the integrator's rerun, not one I reproduced.

### Blocking finding 1: foreign secret add/setIamPolicy/update denials — **Resolved**
- **Own-secret control:** `scripts/probe-m05-runtime.mjs:210-230` asks for access, add, setIamPolicy and update. It passes only if the result is exactly `["secretmanager.versions.access"]`. This confirms the permission-check API works, and that the runtime can read its own secret but not change it.
- **Foreign secrets:** all three (platform DB, other app, signer) run the same four-permission query on the secret itself through `noPermissions` (`:231-242`). That check accepts only `{}` or an empty `permissions` list; any other response shape or any granted permission fails.
- **Project level:** the project query also denies `versions.add`, `secrets.setIamPolicy` and `secrets.update` (`:255-258`).
- **Tests:** an unwanted `versions.add` on the signer or `setIamPolicy` on the platform secret is rejected (`m05-runtime.test.mjs:179-186`). The 15 permission queries (1+3+1+3+1+6) and the 16 checks both add up.

### Blocking finding 2: PostgreSQL `name[]` cast — **Resolved**
- The memberships query now uses `granted.rolname::text` (`:414`), so `pg` returns a real JS array instead of the string `"{}"`. `createRuntimeSqlProbe` is exported (`:385`).
- The required gateway test case (`postgres-store.test.ts:171-216`, inside the existing `describe`, not a new skippable case) runs the real exported probe in a child process against actual PostgreSQL:
  - The runtime role passes `inspect`. This only works if the array comes back as an empty array, so it directly exercises the fix.
  - Connecting to the platform DB fails at the connect stage with `42501`.
  - The migrator fails with `/elevated or mismatched/`, which proves the inspection query actually ran rather than failing at connect.
- The import paths resolve correctly from `cwd=packages/gateway`.

### Hardening recommendation 1: other-app gateway positive control + matching config SHA-256 — **Present**
- `probe-m05-invocation.mjs:57-72` requires the other app to answer 200 with the right audience and live/ready status. Both reports include `fixtureConfigSha256` and both `appOrigins` (`runtime:379-380`, `invocation:81-82`).
- The docs require the two digests to match (`M05-PROVIDER-PROOF.md:60-61`), and a test asserts the digest (`test:316-317`).

### Hardening recommendation 2: `implicitDelegation` — **Present**
It's in the permission list checked for all six service accounts (`runtime:288-302`) and is listed in the docs at `:92`.

### Docs guardrails — **Present**
- The docs require independent inventory/IAM checks, immutable source and image provenance, external ingress denials, live rotation, and cleanup/cost records (`:58-65`, `:105-106`, `:131-134`, `:136-149`).
- They state that no project, credentials or budget were configured (`:16`) and that M05 can't be marked DONE from the scripts alone (`:6`, `:151-154`).

### Local tooling acceptance
**Accepted.** I found nothing left blocking in the four items you asked about, and I didn't widen the scope.

### M05 DONE — separate and **not met**
No live provider run has happened yet. Marking M05 DONE still needs:
- an approved disposable project and budget
- both probe reports from the deployed fixtures, with matching digests
- image/revision provenance
- the operator's inventory/IAM and DB-grant checks
- external ingress denials
- live rotation evidence
- clean Node 22/24 CI
- an independent review
