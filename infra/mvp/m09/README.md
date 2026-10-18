# M09 cloud baseline

Proposed MVP baseline for MD04/MD05/MD06: one project, `us-central1`, one shared small Cloud SQL
for PostgreSQL instance, platform identities, an image repository and an optional budget alert.
**Nothing here has been applied.** Applying it spends money and needs the owner's approval of the
one-off $25 M09 budget (MD06). The runbook, case map and cost worksheet are in
[docs/mvp/M09-QUALIFICATION.md](../../../docs/mvp/M09-QUALIFICATION.md).

## Ownership

| Owner | Resources |
|---|---|
| This Terraform state (`mvp/m09/baseline`) | APIs, `<prefix>-images` repository with cleanup policies, gateway/builder/deployer/platform-migrator identities, empty signer and platform-DB secret containers, optional Cloud SQL instance, optional monthly budget |
| [`provider/cloud-run.mjs`](../provider/cloud-run.mjs) | Per-app runtime/migrator identities, app DB secret containers, app services |
| [`provider/cloud-tasks.mjs`](../provider/cloud-tasks.mjs) | Per-app wake queue and wake invoker identity, and their IAM |
| M09 SQL step ([`sql.mjs`](./sql.mjs)) | Fixture databases and roles inside the instance, created with random passwords and dropped after the run |

Never import adapter-owned resources into this state. The M05 foundation (`embody-test-m05`,
state prefix `mvp/m05/foundation`) is separate and is not touched.

Paid resources are off by default: `enable_postgres=false`. With it on, the instance is
`db-f1-micro`, zonal, 10 GiB HDD, no autoresize, no authorized networks, `ENCRYPTED_ONLY`,
one retained automated backup and no point-in-time recovery. No database user, password or DSN
is in Terraform inputs or state.

## Commands

Credentials: Application Default Credentials for the operator (`gcloud auth application-default
login`), or a credential file the owner provides, named by `GOOGLE_APPLICATION_CREDENTIALS`. The
Terraform provider and the qualification scripts read the same credentials. Never commit or log
them, and never put tokens in Terraform variables.

```sh
export EMBODY_MVP_CLOUD_PROJECT=<approved project>
export EMBODY_MVP_CLOUD_RESOURCE_PREFIX=embody-test-m09
export EMBODY_MVP_CLOUD_BUDGET_USD=25
export EMBODY_MVP_CLOUD_BUDGET_APPROVED=true
# Verifies (or creates) the private versioned state bucket; prints the backend prefix.
node scripts/bootstrap-m05-state.mjs

terraform -chdir=infra/mvp/m09 init \
  -backend-config="bucket=${EMBODY_MVP_CLOUD_PROJECT}-tfstate-<project number>" \
  -backend-config='prefix=mvp/m09/baseline'
terraform -chdir=infra/mvp/m09 plan -out=/tmp/m09.tfplan \
  -var="project=${EMBODY_MVP_CLOUD_PROJECT}" -var='approved_budget_usd=25' \
  -var='enable_postgres=true'
# Review the saved plan: creates only, no change to existing resources or project IAM.
terraform -chdir=infra/mvp/m09 apply /tmp/m09.tfplan
terraform -chdir=infra/mvp/m09 output -json > /tmp/embody-m09-private/baseline.json
```

Add `-var='billing_account=XXXXXX-XXXXXX-XXXXXX'` only if the operator can manage budgets on that
billing account; the budget alerts at 50/80/100% of $50/month and is not a hard cap.

After apply, inspect project IAM: enabling APIs can add Google service agents and default grants
that are not Terraform resources. M05 found and revoked an automatic Editor grant on the default
Compute account; repeat that check.

## Teardown

1. `test:mvp:cloud` removes everything it created (services, job, queues, invokers, app identities
   and secrets, fixture databases and roles) and records the inventory of what is left.
2. `terraform -chdir=infra/mvp/m09 plan -destroy -out=/tmp/m09-destroy.tfplan ...` with the same
   variables; review, then apply that plan. Deleting the SQL instance destroys its data and backups.
3. A fresh `plan` must show no changes, and the owned-name inventory must be empty.

API enablement is retained (`disable_on_destroy=false`). The state bucket is retained. A deleted
queue's name stays reserved for up to seven days, so each run uses fresh run-scoped names.

CI runs `fmt`, `init -backend=false` and `validate` on this directory without credentials.
