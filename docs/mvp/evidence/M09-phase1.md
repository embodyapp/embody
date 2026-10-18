# M09 phase 1 development record (no cloud)

This is a development record, not acceptance evidence. No cloud API was called, no resource was
created and nothing was spent. Every M09.a–e case remains **unexecuted** until the live run.

```text
Task / acceptance cases: M09 (a–e), phase 1: configuration, suite and mocked tests only
Owner / reviewer: claude / independent review pending (after the live run)
Date: 2026-10-15
Branch: feat/mvp-m09-cloud-qualification, stacked on feat/mvp-m20-durable-runtime (#43, fb9a211)
Runtime: Node 24.21.0, pnpm 11.25.0, npm 11.19.0, Terraform 1.16.5, google provider 8.6.0
Environment: local only
```

## What was built

- [infra/mvp/m09](../../../infra/mvp/m09/README.md): baseline Terraform (paid SQL off by default),
  wake target, queue probe, SQL helpers, cost worksheet, suite and GCP provider.
- [provider/cloud-tasks.mjs](../../../infra/mvp/provider/cloud-tasks.mjs): per-app wake queue and
  invoker, exact IAM, pause/resume, ownership-checked removal.
- `pnpm test:mvp:cloud` runs the M09 suite behind the existing guards plus a $25 ceiling;
  later suites fail closed. `test:postgres` and `test:gateway-store` accept a dedicated Cloud SQL
  instance (`EMBODY_POSTGRES_PROVIDER_INSTANCE`) in place of a fixture container.
- `bootstrap-m05-state.mjs` reuses the private state bucket under `mvp/m09/baseline`.
- [Runbook, case map and cost worksheet](../M09-QUALIFICATION.md).

## Local results

| Command | Result |
|---|---|
| `pnpm test:verification` | 74 passed, 0 failed, 0 skipped (M09 adds 36 mocked cases) |
| `pnpm verify` (Node 24) | exit 0: lint, license, typecheck, workspace tests (optional DB suites skip locally, as before), build, API report, format |
| `terraform -chdir=infra/mvp/m09 fmt -check`, `init -backend=false -lockfile=readonly`, `validate` | pass |
| `pnpm test:postgres` / `pnpm test:gateway-store` on a disposable fixture (Compose project `embody-m09-fixture`, port 55493, removed afterwards) | 16 / 43 passed, zero skips: the container path still works after adding the Cloud SQL provider mode |

Node 22 and exact-candidate CI were not run in phase 1.

Mocked tests cover: guards before any cloud call (budget above $25, unimplemented suites, missing
baseline/image/proxy, long prefixes); teardown on every path including a failed setup; no pass
without every case, a cost measurement and an estimate within budget; provider error text never
reaching results; evaluators for zero intervals (gaps are not zero), delayed wake, 503 retries,
OIDC claims, isolation, builder IAM, scaling, storm, connect denials, latency and restore; the
queue adapter's exact bindings and refusals; the wake target's 503/401 behaviour and token-free
logs; the queue probe's cases, identity negatives and token-free report.

## Not done

Every live case, the restore drill, cold-latency measurements, zero observation, measured cost
and invoice check, independent review and exact-candidate CI. Owner inputs listed in the runbook.
