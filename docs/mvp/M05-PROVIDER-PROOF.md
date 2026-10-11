# M05 provider proof procedure

This is an **executable but not yet live-run** targeted qualification procedure. Local
mocked probe tests establish fail-closed behavior, not Google Cloud IAM effectiveness.
The broader `pnpm test:mvp:cloud` gate remains deliberately blocked until M09–M17 exist.
M05 cannot be marked DONE merely because these scripts or a role matrix exist.

## Owner inputs required before provisioning

- Dedicated disposable Google Cloud project; no production/customer resources or data.
- Explicit positive USD spending ceiling and authorization to provision the fixture.
- Operator access to provision service accounts, test secrets/services and test databases.
- Selected region, fixture resource prefix beginning `embody-test-`, cleanup owner/deadline.
- Gateway/platform/app/migration/build/deployer identities matching [the role matrix](./IDENTITY.md).

No such project/access/budget was configured in this development environment. Do not
substitute an existing unrelated project, operator ADC or service-account impersonation
for app runtime metadata evidence. Budget attestations are not hard spending caps.

## Disposable fixture requirements

Provision two app services, a gateway service, distinct runtime and gateway service accounts,
separate own/platform/other-app databases on the same PostgreSQL server, and four distinct
Secret Manager secrets: own runtime DB DSN, platform DB DSN, other app secret, gateway signer.
Use only invented test data. Make all target resources exist and record their resource IDs,
service identity bindings, IAM policies and database grants before running negatives.

The own DSN must authenticate the app runtime's non-superuser/non-BYPASSRLS role and connect
only to its own DB. SQL denial must be actual `42501` CONNECT denial on the existing platform
and other-app DBs, not a bad password, nonexistent database, timeout or missing network.
Cross-server database topology needs an additional qualified probe before it is supported;
this fixture explicitly tests the approved same-server/different-database pattern.

The gateway identity alone has provider invocation rights on the app services. No public
`allUsers`/`allAuthenticatedUsers` invoker binding; no broad inherited roles for runtimes.
The gateway identity can access only the platform runtime credential and signer, not app
credentials. App/migration/builder/deployer identities must not access platform/signing secrets.
Set hosted profile flags and bind each app's issuer, audience, workspace and HTTPS gateway
JWKS. The gateway uses `GATEWAY_SERVICE_ACCOUNT_EMAIL` and the matching workload identity.
Use default HTTPS `*.run.app` service origins; custom domains are not admitted.

## Runtime metadata/IAM/SQL proof

Copy `infra/mvp/m05-runtime-probe.example.json` and replace every placeholder with the
**actual** dedicated project, fixture resources and exact committed candidate SHA. Also
set the actual `appOrigin`, `appAudience` and `workspaceId` matching the deployed app.
The candidate SHA is an operator-supplied attestation, not proof by itself: retain the
image digest and deployed revision/job identity to corroborate which code actually ran.

Run the candidate's `scripts/probe-m05-runtime.mjs` in a disposable Cloud Run job under the
**same app runtime service account/network configuration as the admitted app**, without
operator ADC or a signing credential. The gateway package's production `pg` dependency
must be installed and reachable by the script. Supply the config file and attestations:

```sh
# Inside the authorized disposable runtime fixture, not a developer workstation:
export EMBODY_MVP_CLOUD_PROJECT='<approved dedicated project>'
export EMBODY_MVP_CLOUD_RESOURCE_PREFIX='<approved embody-test- prefix>'
export EMBODY_MVP_CLOUD_BUDGET_USD='<approved positive ceiling>'
export EMBODY_MVP_CLOUD_BUDGET_APPROVED=true
export EMBODY_M05_RUNTIME_PROBE_CONFIG='/fixture/m05-config.json'
pnpm test:mvp:runtime-isolation
```

The probe requires the real metadata email to equal the app runtime identity, obtains
its metadata access token, verifies access to the own DB secret as a positive control,
and tests denial of platform/other-app/signing secrets. It queries effective project and
service-specific deployment/build/IAM permissions, attempts (and requires denial of)
gateway impersonation, verifies own SQL role/connection, and requires actual CONNECT denial
on platform/other DBs using that known-good runtime credential. Queries are read-only;
no deployment, build or SQL mutation is performed. A wrongly granted impersonation permission
would mint a short-lived token and fail the test; it is never printed or retained.

`403` is required for actual secret/impersonation denials. `404`, `500`, a timeout or an
unexpected grant cannot pass. Target resource existence/IAM inventory must be independently
corroborated by the operator; a denial response alone does not prove the fixture was provisioned.

## Private invocation proof

Run `scripts/probe-m05-invocation.mjs` inside the trusted **gateway** workload fixture,
with the same config/approval flags, installed built gateway package, and gateway-only
signing environment (`GATEWAY_JWT_ISSUER`, `GATEWAY_JWT_KID`, `GATEWAY_JWT_PRIVATE_KEY`,
`GATEWAY_JWT_PUBLIC_JWKS`). The app's provisioned workspace/audience/issuer/JWKS must match
that config/signing identity. Run:

```sh
pnpm test:mvp:private-invocation
```

This uses only read-only `/health` calls: unauthenticated invocation must return provider
`403`, and adding a minted valid Embody principal JWT without provider identity must still
return provider `403`. The same target must return a matching ready/live app identity
when called with the gateway's metadata-based Google ID token. Host `/health` itself does
not require an Embody principal, so the unauthenticated denial tests the provider gate,
not merely the host's `/execute` JWT requirement. A public host returning `401`/`200`, a
nonexistent/unreachable target or an unready/wrong app cannot pass. The network/internal
-ingress path and external denial must additionally be recorded against the actual
configured ingress policy; a gateway-origin probe alone is not an external reachability test.

## Live rotation and evidence acceptance

Follow [the rotation runbook](./IDENTITY.md) against all serving gateway revisions:
publish overlap, wait the cache bound, switch signer, verify old/new host acceptance,
stop old signers, retain overlap through old-token expiry, remove old public keys everywhere,
and confirm removed-key rejection after cache expiry. Retain actual revision inventories,
public key IDs (never private keys/tokens), timestamps and sanitized HTTP outcomes.

Probe success reports are written under `.artifacts/verification/`. Each CLI removes its
previous success file before starting and exits nonzero on failure, so stale green reports
cannot satisfy a failed run. Provider/driver error text, tokens, secret bodies, request JWTs
and DSNs are never emitted. These reports must be accompanied by actual deployed revision/
image digests, metadata subject, independently checked target inventory/IAM and DB grants,
external ingress negatives, live rotation results and cleanup/cost inventory.

Only after independent review and clean candidate Node 22/24 CI/baselines **and** these
live acceptance cases pass may the integrator mark M05 DONE. M09/M17 still own final
provider/database/cost/zero-instance/full-release qualification; passing targeted M05
identity probes does not complete those milestones.
