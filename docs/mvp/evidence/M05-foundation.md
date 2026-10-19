# M05/M09 foundation spike — 2026-10-11

User authorized `embody-cloud`, aim $0 and one-off maximum $10 USD, then requested Terraform
with remote GCS state. Local gcloud login verified project active/billing-enabled and the
operator's Owner permission. This supersedes the earlier **missing access/budget** blocker;
no production release or monthly budget approval is implied.

## Applied foundation

- [Terraform](../../../infra/mvp/m05/README.md): Terraform1.16.5, signed/locked Google8.6.0
  provider (Darwin arm64/Linux amd64 checksums). `fmt`, `validate` passed.
- State bucket `gs://embody-cloud-tfstate-930896908754`, prefix `mvp/m05/foundation`,
  live object `default.tfstate`. Actual bucket inspection confirms regional us-central1,
  uniform access, enforced public-access prevention, versioning, noncurrent cleanup.
  Bucket is separately bootstrapped/preserved, not deleted by foundation destroy.
- Reviewed saved plan: **20 create-only** resources, no existing/global IAM overwrite,
  no SQL, secret versions, images or Cloud Run workloads. Independent read-only review
  found no foundation blocker. Applied that exact saved plan: 20 created, 0 changed/deleted.
- Real refreshed `terraform plan -detailed-exitcode` subsequently returned **0/no changes**.
  `state pull` inspected privately: no current OAuth token, secret-version/user/database
  resources. Raw state/plan/token are not retained in Git or this evidence.
- APIs created a default Compute identity with automatic project Editor; explicitly revoked
  **that exact binding**, then verified no Editor on it and no allUsers/allAuthenticatedUsers
  project binding. Google-managed service-agent roles remain; operator Owner is retained.
  API activation IAM side effects must be checked on future fresh applies as well.

Terraform manages empty registry/queue, four platform identities, two empty gateway secret
containers and scoped IAM. No database, service, image or secret payload was created.
The reusable foundation and backend remain available; test app resources were cleaned up.
Free-tier usage is billing-account-wide and delayed; **no assertion of measured $0 spend**
is made. Paid SQL flag remains false; no fixed compute/database baseline is running.

## Shared app primitive

`infra/mvp/provider/cloud-run.mjs` and `scripts/provision-m05-app.mjs` share app-specific
provisioning primitives rather than Terraform ownership. The future controller must call
these only after job authorization/fencing and add build/SQL/connector/readiness/promotion.

Live operator exercise (not runtime metadata proof):

1. Prepare app A (`ws_m05fixture01`/kanban) and B (`ws_m05fixture02`/email).
2. Repeated prepare A reconciled owned names with no duplicate identity/secret container.
3. Remove A/B through ownership-checked adapter; repeated remove A succeeded as absent.
4. Inventory afterwards: only four foundation SAs and two foundation EMPTY secrets remain.

Created/deleted app resources were four identities and four empty secret containers. No
app service, database role or secret version was created. The first prepare invocation
hit the harness's 60-second timeout after partial creation; deterministic re-run reconciled
it. Operator CLI now fetches a single in-memory short-lived token for each bounded call.
This exercise is NOT evidence that a restricted deployer or full deploy workflow works.

Independent review found prefix-only JWKS trust unsafe. Fixed by comparing exact gateway
URI, workload identity and public issuer from the approved project's Run API. Also added
specific bounded new-SA propagation retry, PATCH-path coverage, long workspace label
hashes, scoped operation polling, tombstone refusal/recovery docs and deterministic cleanup.
Thirteen infra unit cases pass; whole runner **36/zero skips** and supported Node24
`pnpm verify` pass (281 Vitest cases/11 explicitly optional app DB skips). Source changes
need clean Node22/24 CI plus new offline Terraform validation; no mocked case is live proof.

## Remaining acceptance

M05 is **IN_PROGRESS**, not DONE. Hosted workloads/actual runtime metadata negatives,
SQL CONNECT denial, authenticated/non-authenticated/private/external ingress and live
multi-revision key rotation still must be qualified with immutable candidate images.
M09 baseline/database/cost/zero-instance and M12/M13 controller remain incomplete.
See [provider procedure](../M05-PROVIDER-PROOF.md). Reviewed foundation IaC and operator
resource creation cannot substitute for those acceptance cases.
