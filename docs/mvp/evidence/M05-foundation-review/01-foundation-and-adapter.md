I found nothing that should block the foundation apply. The provider primitive (`cloud-run.mjs`) has one real security gap and a couple of robustness bugs, and those should be fixed before anyone relies on it. I only read files: nothing was run, edited, or sent to the cloud. I had no tool to write the plan file or exit plan mode, so the full review is here.

## Foundation apply (`main.tf` + bootstrap): no blockers

The 20-resource plan matches what you described. No SQL, workloads, image or secret versions get created. The empty secrets mean the state file holds nothing sensitive, and `disable_on_destroy = false` is set. Things to know before or after applying:

1. **Turning on the 9 APIs does more than the plan shows.** Enabling Cloud Build, Cloud Run, Secret Manager and Cloud Tasks makes Google create its own service accounts and IAM grants. Depending on project age and org policy, Cloud Build can fall back to the Compute Engine default account, which may have `roles/editor`. After applying, check the project IAM policy for default accounts with Editor. If org policy allows, enforce `iam.automaticIamGrantsForDefaultServiceAccounts`. "Create-only" is true for Terraform's resources, not for the project's IAM.
2. **The first apply may fail and need a re-run.** Newly enabled APIs can take a few minutes to start working, so you may get `SERVICE_DISABLED` / 403 errors even with `depends_on` in place. Re-running is safe. Also check that `serviceusage.googleapis.com` is already enabled, since Terraform uses it to enable everything else and it isn't in the list.
3. **The $10 budget isn't enforced anywhere.** `approved_budget_usd` is only checked by a validation rule. The plan creates no billing budget or alert, so set one up separately if you want a warning at $10.
4. **The queue name can't be reused right after deletion.** If the queue is destroyed and recreated, Cloud Tasks blocks the old name for about 7 days. That only matters for teardown and re-run loops.
5. **Bootstrap script (`scripts/bootstrap-m05-state.mjs`):**
   - It fails closed on name squatting (403, or a different project number), never prints the token, and handles races by erroring (409), so re-running is safe.
   - When it adopts an existing bucket, it doesn't check the bucket's IAM policy. Public access is blocked, but anyone holding a project-level storage role can still read the state. That's low risk while the state has no secrets.
   - `softDeletePolicy: 0` means a deleted bucket can't be recovered. Versioning only protects objects. That's an acceptable trade-off for this fixture.

## Later adapter use (`infra/mvp/provider/cloud-run.mjs`): fix before relying on it

1. **The JWKS origin check accepts other projects' services (security).** `cloud-run.mjs:161-170` only checks that the host starts with `${prefix}-gateway-` and ends in `.run.app`. Anyone can create a service called `embody-test-m05-gateway` in their own project, and its URL passes this check. A deployed app would then trust tokens signed by that attacker. Fix: compare against the exact gateway URL, read from the Run API (`services/<prefix>-gateway`.uri) or built from the project number.
2. **No new-account retry in `prepare()`.** Right after `prepare()` creates the runtime/migrator accounts, it immediately calls `secrets:setIamPolicy` with the new account as a member. IAM often rejects this for a few seconds ("service account does not exist"). The call fails, and a re-run then succeeds. Add a bounded retry on that specific 400.
3. **Deleted accounts leave the adapter permanently stuck.** If an app account (or the gateway account) is deleted and recreated, the old bindings show up as `deleted:serviceAccount:…?uid=…`. The strict policy checks (lines 122-132 and 191-201) then refuse every attempt. Failing closed is correct, but there's no documented way to recover.
4. **Workspace IDs can be too long for labels.** The regex allows `ws_` plus up to 64 characters (67 total), but GCP label values max out at 63. Today's generated IDs (`ws_` plus 32 hex) fit, but the contract (`docs/mvp/CONTRACTS.md:8`) allows longer ones. Either tighten the regex to `{8,60}` or put a hash in the label.
5. **The deployer needs permissions this design doesn't yet scope.** To deploy with the new runtime accounts, whatever identity calls the adapter needs `iam.serviceAccounts.actAs` on them. The obvious shortcut, project-level `roles/iam.serviceAccountUser`, would also let it act as gateway, builder, platform-mig and the default compute account, which is a privilege-escalation path. When the restricted deployer is built, grant `actAs` per account inside `prepare()`, or use IAM conditions on the `${prefix}-r-` / `-m-` name prefixes. You've already said this isn't claimed yet; I'm flagging the design trap.
6. **Nothing cleans up adapter-created resources.** Accounts, secrets and services the adapter creates are outside Terraform, so `terraform destroy` won't remove them. Destroying the gateway account would also leave `deleted:` members behind (see item 3). Before acceptance you need a cleanup step that finds everything labelled `managed_by=embody-m05-app-adapter`.
7. **Minor:**
   - `issuer` isn't validated beyond being a non-empty string, and it isn't tied to the gateway.
   - The pre-deploy check (lines 187-202) and the setIamPolicy etag cover concurrent writers, but there's no lock across the whole get-then-patch sequence. That's acceptable if the future controller serializes work per app.

## Gaps in `test/verification/m05-infra.test.mjs`

- **The update (PATCH) path is never tested.** The mock throws on PATCH ("Unexpected mock mutation"), so redeploying an existing service, including the `updateMask`/etag request shape, has no coverage.
- **No tests for:**
  - a JWKS host from another project
  - long-running operation polling (`done: false`) and its scope check
  - a 400 from setIamPolicy on a brand-new account
  - `deleted:` policy members
  - the label-length limit
- **Bootstrap:** nothing tests a 403 on the initial GET (bucket name squatted in another project), or a 409 on create.

**Bottom line:** the foundation apply is fine to go ahead, as long as you check the default-account IAM grants afterwards (item 1). Fix adapter items 1–2 and add the PATCH-path test before the adapter is used against the real project.
