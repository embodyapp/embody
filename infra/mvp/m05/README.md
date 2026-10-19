# M05 foundation and app provisioning

This is an early M09 IaC spike, **not** M09/M12/M13 completion or live M05 acceptance.
User-authorized project: `embody-cloud`; region `us-central1`; target $0, one-off ceiling
$10 USD. Billing alerts/this numeric attestation are not hard caps. No production data.

## Ownership split

- Terraform: API enablement, empty image repository, empty deploy queue, platform gateway/
  builder/deployer/platform-migrator identities, empty gateway signer/platform DB secret
  containers and resource-specific IAM. Optional shared PostgreSQL instance is **disabled**
  by default; review hourly/storage/IP pricing before enabling. No database credentials,
  app databases, secret versions, images, app services or app identities are Terraform-owned.
- `../provider/cloud-run.mjs`: deterministic workspace/app resource naming, app runtime/
  migrator identities, app secret containers and private Cloud Run candidates. Both fixture
  CLI and future controller call the same primitives. Digests only; no caller-provided URL,
  identity, resource name or arbitrary environment. Existing ownership and IAM are checked
  before updating services. JWKS origin, issuer and gateway identity must match the exact
  gateway service returned by the trusted project Run API, not a hostname-prefix guess.
  This checks latest template config, not traffic-converged serving revisions; rotation
  qualification must independently inventory serving revisions/issuer convergence.
  Workspace ownership labels are bounded hashes, supporting long workspace IDs.
  Default origin is externally addressable but **IAM-private**;
  this is NOT network-internal ingress qualification. External/network containment remains
  a live acceptance step.
- SQL provisioning/migrations, build/admission, bounded Cloud SQL connector configuration,
  job authorization/leases/fencing, cancellation, readiness, atomic route/manifest promotion,
  rollback and orphan cleanup remain controller work. The adapter deploy operation updates
  service configuration; it is NOT a safe production release/promotion API.
- Deployer has **no provisioning grants yet**. The operator fixture is not proof that the
  eventual restricted deployer can run the full workflow. No Terraform/controller overlap
  on app resources. Never import adapter-owned apps into this foundation state.

## Remote state bootstrap

State bucket is bootstrapped BEFORE Terraform and is not destroyed with the foundation.
Run using operator `gcloud auth login`; no ADC file or downloadable SA key is needed.

```sh
export EMBODY_MVP_CLOUD_PROJECT=embody-cloud
export EMBODY_MVP_CLOUD_RESOURCE_PREFIX=embody-test-m05
export EMBODY_MVP_CLOUD_BUDGET_USD=10
export EMBODY_MVP_CLOUD_BUDGET_APPROVED=true
node scripts/bootstrap-m05-state.mjs
```

Bucket: `gs://embody-cloud-tfstate-930896908754`, backend prefix `mvp/m05/foundation`.
Regional STANDARD, uniform bucket access, enforced public-access prevention, versioning,
30-day noncurrent cleanup retaining at least five newer versions. Soft delete disabled
for this disposable state bucket to avoid duplicate retention costs. Google-managed
at-rest encryption. Treat state as privileged even without intentional secret payloads.
Only operator/project administrators currently have access; app/builder/deployer accounts
receive no state-bucket grants. IAM inheritance must also be reviewed before production.

Bootstrap rejects foreign/unmarked/unsafe existing buckets. The bootstrap bucket itself
is deliberately NOT Terraform-owned to avoid deleting the active backend. Preserve it
for future applies. Final deletion, if requested, is a separate operator step only AFTER
resource teardown and state export; versioned state objects must also be removed.

## Terraform

Pinned Terraform 1.16.5 and signed Google provider 8.6.0; commit `.terraform.lock.hcl`.
The temporary local installation is `/tmp/embody-terraform/terraform`; install the same
version normally for ongoing use. CI validates formatting/schema WITHOUT backend/cloud
credentials. `.terraform`, operator vars, state and plans are ignored by Git.

```sh
# Short-lived token in environment only; never backend/provider config arguments or files.
export GOOGLE_OAUTH_ACCESS_TOKEN="$(gcloud auth print-access-token)"
terraform -chdir=infra/mvp/m05 init \
  -backend-config='bucket=embody-cloud-tfstate-930896908754' \
  -backend-config='prefix=mvp/m05/foundation'
terraform -chdir=infra/mvp/m05 validate
terraform -chdir=infra/mvp/m05 plan \
  -var='project=embody-cloud' -var='approved_budget_usd=10' -out=/tmp/m05.tfplan
# Inspect the saved plan, then apply THAT exact plan, not a new auto-approved plan.
terraform -chdir=infra/mvp/m05 apply /tmp/m05.tfplan
unset GOOGLE_OAUTH_ACCESS_TOKEN
```

GCS supplies state locking; never use `-lock=false`. Re-authenticate for expired tokens.
Do not use local fallback state, commit state, or put keys/passwords into Terraform inputs:
`sensitive = true` merely hides output and DOES NOT prevent plaintext state storage.
Generate/inject signer and database credentials outside Terraform directly into Secret
Manager. Only public config and secret references belong in service templates.

API enablement is retained on teardown (`disable_on_destroy=false`), because disabling
shared APIs can break unrelated resources. API activation can create Google service agents
and automatic default-account IAM grants not shown as Terraform resources. Inspect
project IAM after apply; the live spike revoked automatically added Editor on the default
Compute account. Do not assign that default account to builds/runtimes. Deleting/recreating
a Cloud Tasks queue can reserve its name for seven days; choose a new reviewed fixture prefix
for fast destroy/reapply cycles. The create-only plan must not change existing
resources/global project IAM. Namespace/source/image/policy provenance are still required
for provider acceptance.

## App primitives

Config file contains PUBLIC IDs/metadata only:

```json
{
  "project": "embody-cloud",
  "region": "us-central1",
  "prefix": "embody-test-m05",
  "workspaceId": "ws_m05fixture01",
  "appId": "kanban"
}
```

```sh
node scripts/provision-m05-app.mjs prepare /path/to/app-config.json
```

Prepare creates no secret versions or service. Inject bounded app-runtime/migration DSNs
separately. To deploy, add immutable `image` from the foundation repository, stable public
`issuer`, gateway `jwksUrl` and an enabled numeric DB `secretVersion` to the config. Use
`node scripts/provision-m05-app.mjs deploy ...`. No arbitrary env/command overrides. The operator CLI is pinned to approved us-central1 and
suppresses all error details; inspect deterministic resource metadata/policies for recovery.
An existing foreign/public service/policy causes refusal. Repeated prepare reconciles
owned resources, but concurrent creation can return conflict and needs caller retry.
New-account IAM propagation is retried only for specific account-not-found 400s, at most
five attempts. Tombstoned `deleted:` IAM members fail closed; an operator must inventory
and remove/recreate only owned resources/policies before retry, not grant project-wide actAs.
Operation polling is bounded to 60 attempts and accepts only the approved project ID or
its number resolved from Resource Manager, in the approved region. Partial creation
requires reconciliation by name. Service writes also use bounded account-propagation retry. No source build, SQL preparation/connector, gateway service, probe jobs or complete
hosted fixture is magically created by these primitives.

## Cleanup

Adapter-owned app services/secrets/identities must be inventoried by fixture labels/names
and removed separately before foundation destroy. Use `node scripts/provision-m05-app.mjs
remove /path/to/app-config.json`: it verifies ALL ownership before any deletion and removes deterministic service,
secret containers/versions and identities (repeatable for absent resources). SQL databases/
roles and any external grants remain separate cleanup steps. Future controller must authorize
and fence deletion just like provisioning. Do not delete by broad project listing.
Terraform destroy owns only this foundation state; an enabled SQL instance deletion is
DESTRUCTIVE (disposable fixture only). Generate/review a destroy plan with the same vars
and refreshed short-lived token. Leave the backend bucket intact. Empty repository/queue,
no secret versions and no compute/database workloads aim to avoid fixed baseline costs;
free allowances are billing-account-wide and actual billed usage may lag.

To preserve the reusable foundation, disable only the optional fixture with
`enable_postgres=false` and `enable_network=false`, review/apply a new plan, then require a
fresh no-change plan. Remove gateway/jobs, all fixture images, signer/platform secret
versions and instance-scoped SQL IAM grants separately; app `remove` does not own those.
Do not infer cleanup from a delete request: verify provider lists, secret-version states,
IAM, image versions and private fixture-file absence while retaining private versioned GCS state.

Direct VPC can block subnet/network deletion **1–2 hours after all Cloud Run resources
have been deleted**. These free serverless internal address reservations are managed by
Google and cannot be manually deleted ([provider documentation](https://cloud.google.com/run/docs/configuring/vpc-direct-vpc#delete-subnet)).
Delete paid SQL/NAT/workloads first; bounded retry/reconciliation with refreshed tokens and
new plans can finish network teardown after release. Do not retain paid fixtures for this
wait, disable state locking, reuse a stale partially applied plan, or declare complete
cleanup before the final lists and no-change plan agree.

Live IAM/SQL/ingress/rotation tests required by `docs/mvp/M05-PROVIDER-PROOF.md` passed on
frozen b429a0a; see `docs/mvp/evidence/M05-live-b429/README.md` for sanitized reports,
independent review, provenance/cost qualifications and final cleanup status.
