# M02: request-only hosted contract v1

Implementation: [`@embody/cloud-contracts`](../../packages/cloud-contracts/src/index.ts).
All transport objects are strict (unknown keys rejected), carry `version: 1` and explicit workspace/app binding. Unknown versions fail; consumers must not silently downgrade. This freezes the contract, **not** a working hosted API or a qualification claim. M04–M15 implement the consumers and enforcement. Customer configuration is executable source: never import it in the CLI, gateway or privileged worker; evaluate it only in M11's isolated builder. Metadata validation does not prove arbitrary JavaScript safe or stateless.

## Identity and permission boundaries

Opaque IDs use `ws_`, `app_`, `rel_`, `dep_` followed by 8–64 lowercase alphanumeric characters. Servers generate IDs; names are not IDs. IDs are not credentials. Releases are immutable and belong to one workspace/app. Deployments identify attempts to create/promote releases, not mutable active pointers.

Grants bind a role to an exact `(workspaceId, appId)`; there are no wildcard grants in v1. A principal may have multiple grants. The authenticated workspace, route binding and payload binding must agree; a supplied ID alone never authorizes a request. Roles intentionally do not inherit call permission:

| Permission | app-caller | deployer | operator |
|---|---|---|---|
| Call app actions | Yes | No | No |
| Read app catalog/status | Yes | Yes | Yes |
| Submit/read/cancel deployment, rollback | No | Yes | Yes |
| Disable/delete app | No | No | Yes |
| Write secrets | No | No | Yes |
| Read secret values | No | No | No |

Reading deployment logs requires deployment-read permission and redaction. Secret values are never returned; operators write via a separate protected-input operation (M15). Reference objects contain only a scoped opaque secret ID, pinned integer version and environment name. Release metadata carries references, never secret values or provider resource URLs. MCP agents granted app-caller do not gain deployment/admin operations.

## API and CLI mapping

The following paths are reserved for v1; only the M10 source routes are served so far. All management endpoints require workspace authentication, exact app authorization and bounded JSON bodies. Errors use fixed public messages from `publicError`, never raw exceptions/provider output. HTTP 401 is authentication failure; 403 is permission denial; cross-workspace resource lookup returns 404. Invalid version/input is 400, idempotency/CAS conflict 409, body too large 413, quota exhaustion 429, dependency outage 503.

| CLI surface (M14/M15) | Reserved API | Contract/permission |
|---|---|---|
| `embody source upload` (M10, served) | `POST /v1/workspaces/:workspace/apps/:app/sources`, `POST …/sources/:upload/complete`, `GET …/sources/:upload` | SourceUploadRequest / SourceStatus; deployment:submit (status: deployment:read). See [SOURCES](./SOURCES.md) |
| `embody deploy` | `POST /v1/workspaces/:workspace/apps/:app/deployments` | DeploymentSubmission / deployment:submit; 202, or 200 replay |
| `embody deployments status <id>` | `GET /v1/workspaces/:workspace/apps/:app/deployments/:id` | DeploymentStatus / deployment:read |
| `embody apps list` | `GET /v1/workspaces/:workspace/apps` | AppList with authorized AppStatus summaries only / app:read |
| app status (API first) | `GET /v1/workspaces/:workspace/apps/:app` | AppStatus / app:read |
| `embody rollback <app> <release>` | `POST .../apps/:app/rollback` | AppManagement rollback / app:rollback |
| `embody apps disable <app>` | `POST .../apps/:app/disable` | AppManagement disable / app:disable |
| `embody apps delete <app>` | `POST .../apps/:app/delete` | AppManagement delete, confirmAppId / app:delete |
| deployment cancellation (API first) | `POST .../apps/:app/deployments/:id/cancel` | AppManagement cancel / deployment:cancel |
| `embody secrets set <app> <name>` | Separate protected write endpoint, M15 | secret:write; no values in arguments/output |
| `embody logs <app>` | Bounded log endpoint, M15 | app-scoped authorization; redacted results |

Submission contains an owned uploaded-source ID, SHA-256 digest and byte count; expected app generation; request-only capabilities; secret references; and a 16–128 ASCII-character idempotency key. Example (digest abbreviated here only; wire digest must have 64 hex characters):

```json
{
  "version": 1,
  "workspaceId": "ws_aaaaaaaa",
  "appId": "app_aaaaaaaa",
  "idempotencyKey": "submission_key_01",
  "source": { "uploadId": "src_aaaaaaaa", "digest": "sha256:<64 lowercase hex>", "bytes": 1234 },
  "expectedGeneration": 0,
  "capabilities": {
    "profile": "request-only-v1", "crud": true, "boundedActions": true,
    "workflows": false, "schedules": false, "subscriptions": false,
    "appToAppRpc": false, "persistentLocalState": false, "genui": false
  },
  "secretReferences": []
}
```

AppStatus carries current authoritative `generation`, app-wide `lifecycleFence`, lifecycle status (`enabled`, `disabled`, `deleted`) and nullable `activeReleaseId`. Read it before submitting any generation-bound operation and again after a CAS conflict. A successful promotion increments generation; a deployment's `expectedGeneration` remains its historical captured value, not current app state. AppList wraps unique workspace-bound summaries.

Deployment response/status carries deployment ID, workspace/app, source digest, state, stage attempt, expected generation, captured app lifecycle fence and deployment cancellation fence. An active status requires a release ID; a failed status requires a safe error; other statuses carry no error. CLI noninteractive JSON output must preserve the ID so status polling resumes without resubmission. Existing call/discovery commands are unchanged; new commands are not implemented by M02.

## Durability, retries and fencing

- States: `accepted → validating → building → provisioning → checking → promoting → active`. Every nonterminal state can fail or cancel. `active`, `failed`, `cancelled` are immutable terminal states.
- A stage starts at attempt 1. Only validating through promoting may retry the same stage, incrementing by exactly one, at most 3 attempts. Retry delays are 5 and 30 seconds, persisted via scheduled jobs, never process timers. Moving to a different state resets attempt to 1. Only classified transient failures retry; rejection, permission failure, CAS conflict and cancellation do not.
- Repository uniqueness is `(workspace, app, idempotencyKey)`. `submissionFingerprint` hashes a schema-validated canonical JSON representation (object key order irrelevant; array order retained). All accepted fields, including source digest, upload ID, capabilities, secret versions and expected generation, are bound. Same key/body returns the original deployment, including after terminal completion; different body conflicts. Never run a new build on replay. Keep bindings for at least the deployment retention window; expired keys are no longer guaranteed replayable.
- M10 must verify upload ownership, digest and size against stored source, not trust user assertions. Implemented as `verifySubmissionSource` ([SOURCES](./SOURCES.md)); M12 must call it inside submission. M12 must atomically commit deployment, key/fingerprint and durable job/audit intent. The in-memory test fixture establishes the repository contract only, not durability.
- Promotion atomically checks deployment `state=promoting`, app enabled, expected generation, captured app-wide lifecycle fence against the app, and captured per-deployment cancellation fence against that deployment. Winner increments generation and updates the active release pointer in the same transaction. Any late/stale worker fails the CAS. `canPromote` describes the predicate; a pre-check outside the transaction is unsafe.
- Cancellation increments only the target deployment's persisted `cancellationFence` and transitions that deployment terminally in one transaction. Cancelling deployment A does not invalidate pending B for the same app. `canCancel` requires a matching deployment fence and nonterminal state. If activation wins the transaction race, cancellation conflicts; if cancellation wins, promotion fails. Repeated cancel may return existing cancelled status but must not advance the fence again.
- Disable/delete advance the app's `generation` and `lifecycleFence` and stop admission, invalidating all pending jobs. Workers carry both captured fence scopes; they cannot resurrect a disabled/deleted app. Cancellation does not promise to undo already-applied database mutations.
- Rollback submits a new durable operation against the current generation, pins an existing release and requires compatible data/schema checks in M13; route rollback cannot undo destructive migrations.

## Pinned workload and limits

`HOSTED_PROFILE` is the executable source of these defaults. Consumers must enforce it rather than duplicating magic numbers. Raising a limit or adding capabilities requires contract review and renewed qualification. These are design ceilings, not measured latency/cost claims.

| Item | v1 default / bound | Enforcement owner |
|---|---|---|
| Scaffold | `create-embody-app@0.1.0` plus request-only hosted adapter | M08 (existing generic scaffold alone is not certified) |
| Node runtime | 22.x or 24.x only, immutable builder image pinned later | M08/M11 |
| Submission JSON | 16 KiB UTF-8 before parsing | M10 gateway (streaming byte limit too) |
| Source archive / expanded / files | 10 MiB / 50 MiB / 2,000 | M10 |
| Build duration / artifact size | 600 seconds / 500 MiB | M11 |
| Action / whole request deadline | 30 / 60 seconds | M07/M08 (cold path included) |
| DB connections / max app instances | 5 per instance / 3 | M08/M09 (at most 15 app runtime connections) |
| Apps / workspace; secret refs / app | 5; 32 unique names | M04/M10/M15 |
| Stage attempts / retry delays | 3 / 5, 30 seconds | M12 |
| Uploaded source / deployments+key bindings | 7 / 90 days | M16 |
| Inactive releases / logs | 30 / 14 days | M16 |

Active release retention is indefinite until replaced or deleted; do not collect referenced artifacts/secrets. These metadata/log retention defaults do not decide customer-data backup/deletion policy (MD10 remains open). [M08's implemented policy](./RUNTIME.md#outbox-decision-zero-retained-generated-notifications) gives generated CRUD notifications zero retention/no delivery while preserving entity/hook transactions and rejecting custom publishing. MD08/M08 acceptance remains pending; legacy outbox work must be settled before switching profiles. Subscriptions, workflows, schedules, app-to-app RPC, GenUI and local persistence declarations are rejected, not silently ignored. Static declarations supplement rather than replace runtime/isolation controls.

## Decisions and review ownership

| Decision | Owner | State |
|---|---|---|
| Request-only capabilities and independent call/deploy/admin grants | Product scope MD01–MD03; pi integrator + independent automated reviewer | Accepted for contract v1; [review](./evidence/M02-independent-review-2026-10-11.md) |
| Contract v1 IDs, schemas, fingerprint and CAS/cancellation semantics | M02 integrator (pi); M12/M13 reviewers | Independently reviewed and accepted; durable enforcement remains M12/M13 |
| Limits/scaffold/Node and retention defaults above | M02 integrator (pi); M08/M09/M16 owners | Accepted frozen v1 design policy under owner-directed milestone completion; measured qualification/spend/customer-data approvals remain later gates |
| Database/provider region, budget, outbox, MCP client, customer-data policy | Existing MD05–MD10 owners | Open; not resolved by this package |

Run `pnpm --filter @embody/cloud-contracts test`, `typecheck`, and `build`. See the dated M02 evidence report for actual results and unresolved gates.
