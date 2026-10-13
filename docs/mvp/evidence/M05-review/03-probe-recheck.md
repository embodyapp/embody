I found two problems in the probe code that should be fixed before the probes are accepted as tooling: one false green and one likely false red. The rest are hardening items, gaps in test coverage, or fail-closed restrictions that should be documented. I only read the five files, plus host `/health` and `cloudRunInvocationToken` to confirm two assumptions. I made no edits, ran no tests and touched no cloud resources.

## Fix before accepting as tooling

1. **False green: the runtime can still write to or regrant the other secrets.** For the platform, other-app and signing secrets, the probe only checks that reading them returns 403 (`probe-m05-runtime.mjs:161-170`). It never asks whether the runtime can add a new version or change those secrets' access policies. The project-wide query doesn't ask either, because it only lists `secretmanager.versions.access`. A runtime that could add a version to the signing secret, add one to the platform DB secret, or grant itself read access would still pass. That is a full signer or platform takeover path.
   - **Fix:** add a per-secret `:testIamPermissions` query on each of the three foreign secrets for `versions.access`, `versions.add`, `secrets.setIamPolicy` and `secrets.update`, and require an empty result.
   - Widen the own-secret positive control to ask about the same permissions, and still require exactly `["secretmanager.versions.access"]` back.
   - Add `versions.add` and `secrets.setIamPolicy` to the project-level list.

2. **Likely false red: the SQL role check may reject even a correct role.** The `ARRAY(SELECT granted.rolname …)` expression returns PostgreSQL's `name[]` type. As far as I recall, node-pg's type parsers don't handle `name[]`, so `memberships` would come back as the string `"{}"`. `assertRuntimeSqlRole` requires an array, so the check would always throw. This fails closed, but it means the probe could never pass.
   - **Fix:** cast with `granted.rolname::text`.
   - I couldn't confirm this without running it, so check it against real PostgreSQL. Nothing tests the inspection SQL or the connect-error classifier inside `main()` (`:364-400`) today. The tests inject an error that is already tagged as a connect denial.

## Should fix (cheap hardening)

3. **The other-app address isn't proven to be the real other service.** Nothing confirms that `otherAppOrigin` is actually `otherService` in this project. The validation only checks the hostname prefix `${service}-` plus `.run.app`. That also matches sibling services like `embody-test-m05-own-x…` and services in any other project. A private service the runtime can't call returns 403 either way, so a wrong address passes. Two fixes:
   - Have the invocation probe also make a gateway call to `otherAppOrigin` and check the other app's ID as a positive control.
   - Put a config digest in both reports so the runtime report and invocation report can be matched to the same config. Today the runtime report doesn't even record `appOrigin`.
4. **`iam.serviceAccounts.implicitDelegation` is missing** from the per-identity queries (`:249-257`). Add it.

## Legitimate fail-closed restrictions (document, don't fix)

Document these as operator requirements:

- Cloud SQL users created through the Cloud SQL Admin API are automatically members of `cloudsqlsuperuser`, so they will fail the membership check. Create the runtime role with SQL instead.
- PostgreSQL grants CONNECT to PUBLIC by default. Revoke it on the platform and other-app databases.
- Unix-socket DSNs (`postgresql://u:p@/db?host=/cloudsql/…`) fail `new URL`. Use a TCP DSN (private IP or a proxy sidecar).

These also fail closed, correctly:

- 400 from invalid permissions in an IAM query, and 404 for resources that don't exist.
- 404 from ingress blocking when the job isn't on the app's network.
- Google changing the `IAM_PERMISSION_DENIED` error format.
- Non-English PostgreSQL server messages.
- The example config's uppercase `REPLACE_…` origins (URL normalisation lowercases them, so they don't match) and the all-zero SHA.

## Fine as is

- **The 403 really comes from Cloud Run's access gate.** The host's `/health` (`packages/host/src/index.ts:201`) needs no authentication and returns 200 if a request gets through. So a 403 can't be the app itself refusing.
- **The invocation probe's identity is bound to the gateway.** `cloud-run.ts:56` checks that the metadata ID token's email equals the gateway service account.
- **Disabled APIs and empty IAM answers are handled.** The own-secret checks rule out a disabled Secret Manager API behind the 403s, and confirm that `testIamPermissions` really works for this caller. Accepting `{}` is correct given that control.
- **SQL and stale-report fixes hold.** Only connection-stage `42501` FATAL errors count as a denial, query-time errors don't, and both CLIs delete old success reports before validating anything.
- **Nothing sensitive leaks.** No tokens, DSNs or error text appear in the output.

**Minor:**
- Secret 403s aren't checked for the `IAM_PERMISSION_DENIED` reason, so a VPC Service Controls block or a missing secret also passes. This is acceptable because the docs require an independent inventory.
- A few cases have no tests:
  - a `{}` response is accepted;
  - `{permissions: [], extra}` is rejected;
  - the own app's health returning 200 fails;
  - an ID token with the wrong audience or email fails.

## Verdict

Once items 1 and 2 are fixed (and 3 and 4 ideally too), the probes plus the documented external procedure are acceptable as **tooling only**. They are not live proof. The docs correctly say that `candidateSha` is not provenance, and that image/build correlation, inventory and IAM checks, external ingress tests, live rotation and cleanup are each required separately. No cloud credentials, project or budget exist, so M05 must stay not DONE.
