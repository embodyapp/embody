# Recheck of the M05 provider adapter: all three original blockers are resolved

This was a read-only review. I didn't run the tests, touch the cloud or edit anything. The plan file wasn't written because no Write tool is available in this session. I also can't confirm your live-run claims (no service, image, SQL or secret versions created; the IAM grant revoked); I'm taking them as reported.

## Original blockers

**1. JWKS trusting any URL with the right prefix: resolved.** `infra/mvp/provider/cloud-run.mjs:201-212`
- The hostname prefix check now runs only as a cheap first filter.
- Trust then rests on reading the gateway service at its exact name in the configured project and region. That name is built from the provisioner config, so a caller can't point it at another project.
- Three things must match exactly: the gateway's `uri` against the JWKS URL's origin, its `template.serviceAccount` against `gatewayEmail`, and its `GATEWAY_JWT_ISSUER` env value against `issuer`.
- If the gateway is missing, a 404 returns `null` and the check fails closed.
- Tying trust to the gateway's service account is a sound anchor: deploying a service as that account requires permission to act as it.
- The test at `test/verification/m05-infra.test.mjs:254` covers the "evil" hostname that shares the prefix, and checks that only GET requests were made.

**2. Retry while a new service account propagates: resolved.** `cloud-run.mjs:62-64, 73-83`
- Only a 400 whose message matches `service account.*(does not exist|not found)` is retried.
- It makes at most 5 attempts, waiting 1, 2, 4 and 8 seconds between them, and throws on the last one.
- All other errors, including network errors and 403s, are rethrown immediately.
- Retries reuse the same etag. That's correct, because a failed set doesn't change the policy.
- The test arithmetic checks out: `attempts === 4` means two failures and a success on the first secret, then one call on the second.
- Members marked `deleted:` still fail closed (`:154-159`, test at `:291-304`).

**3. PATCH test: resolved.** `test/verification/m05-infra.test.mjs:144-147`
- A second deploy now goes through the PATCH path and asserts `updateMask=` and the image.
- The existing service's ownership and invoker policy are checked before PATCH (`cloud-run.mjs:229-244`).
- The "public" refusal test checks that only GET requests were made.

The other items you listed are also present and look correct:
- **Workspace label hash:** 32 hex characters; the test at `:266` covers a 64-character workspace ID.
- **Scoped operation polling:** confined to the configured project and region.
- **Deleted-member recovery docs:** README lines 119-121.
- **Owned, repeatable cleanup:** exactly 5 DELETEs, idempotent on a second run, refuses a foreign secret.
- **Test count:** 13 tests, matching your claim.

## Remaining issues before real service use

Ordered by impact:

1. **Operation-scope check not exercised live.** `cloud-run.mjs:90-94` requires operation names to start with `projects/${project}/...` using the project ID. No live run has created or deleted a service, so polling has never run against the real API. If Cloud Run returns the project number instead, deploy will throw *after* the service is created or updated. That fails closed but leaves a partly deployed service. Check this in the first live deploy, or accept either the project ID or the known project number.
2. **No propagation retry when creating the service.** `deploy` sends a POST naming the runtime service account that `prepare` may have just created, and only `bindSecret` retries. Deploying immediately after prepare can hit the same "account not found" 400. Separately, the caller needs permission to act as the runtime account, and nothing grants it. That works for an owner-level operator but not for the restricted deployer, which the README already flags.
3. **`remove` can stop halfway.** It deletes the service, then the secrets, then the identities, and checks each one's ownership only just before deleting it. If the service is owned but a secret is foreign, the service is already gone when it refuses. Check ownership of all five resources before deleting any of them.
4. **The CLI hides the reason for every failure.** `scripts/provision-m05-app.mjs:47-51` throws away all errors, including the adapter's own messages. Those messages are already free of provider details, such as "Unexpected app secret policy" or "ownership mismatch". So the operator can't tell a tombstoned-member refusal from an ownership mismatch, which undercuts the recovery docs. Print `error.message` for adapter errors.
5. **Region isn't pinned in the CLI.** Project and prefix must match environment variables, but `config.region` only passes a format check. Add an approved-region variable or hard-code `us-central1`.
6. **The gateway check reads configuration, not what's serving.** `template` is the latest configuration. If traffic is pinned to an older revision, the issuer actually being served could differ. Also, operators must use the gateway's `uri` field, not one of its other URLs, or the exact match fails (it fails closed). Worth a line in the README.
7. **Test gaps that weaken the claims:**
   - No test where the gateway's service account doesn't match.
   - Gateway rejection tests don't assert the error text, so they could pass for an unrelated reason. The `issuer: "attacker"` case also doesn't assert GET-only.
   - Retries: no test that a non-matching 400 or a 403 isn't retried, and none for running out at 5 attempts.
   - No test for the 60-attempt polling deadline.
   - The PATCH test doesn't check that `etag` and `name` are sent, and the mock ignores the etag.
8. **Already documented, still open:**
   - Ingress is `INGRESS_TRAFFIC_ALL`, and network containment hasn't been tested.
   - There's no readiness check after deploy.
   - There's no SQL or connector setup, so an app deployed now will likely fail on `DATABASE_URL`.
   - The deployer has no provisioning grants.
   - Authorisation, leases and fencing are left to a future controller.

**Verdict:** the original three blockers are closed. For this as an operator-only spike, items 1–3 should be dealt with, or explicitly accepted, before the first real `deploy`. Items 4–5 are small CLI fixes. None of this is a full M05 proof or a proof of the restricted deployer, which matches your own framing.
