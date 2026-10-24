# M14: deploy and control a hosted app from the CLI

Implementation: [`@embody/cli`](../../packages/cli/src/manage.ts) (`deploy`, `deployments`, `apps status`, `mcp setup`), [workspace URL resolution](../../packages/cli/src/target.ts) and the shared [source upload](../../packages/cli/src/source.ts); the app list route in [`deployment-routes.ts`](../../packages/gateway/src/deployment-routes.ts); the `embody.hosted` declaration written by [`create-embody-app`](../../packages/create-embody-app/src/index.ts). Task definition: [IMPLEMENTATION M14](./IMPLEMENTATION.md#m14--packed-cli-deploy-and-control-journey).

The CLI is a thin client of the central gateway. Every platform call goes to the gateway's management API (`<root>/v1/workspaces/<ws>/…`) or its workspace routes (`<root>/w/<ws>/…`); the only other request is the source `PUT` to the short-lived upload URL the gateway issues. The CLI never imports or runs project code, never talks to a cloud provider and holds no deployment state: the deployment ID is the whole handle.

## Quickstart

**Before you start (operator, once per user):** the workspace operator creates the workspace, reserves each app by name (which provisions its runtime identity, database secret and, for durable apps, its wake queue: [RELEASES](./RELEASES.md#app-provisioning-at-reservation-not-the-worker)) and issues credentials: a **deployer** key (source upload, deploy, status, cancel) and an **app-caller** key (discover and call actions, MCP) with scopes for the app's namespace and its plugins, for example `kanban:*` (gateway catalog) and `app:*` (the scaffold's plugin, checked by the app itself). After that, everything below is yours; no operator step is needed for deploys or updates.

1. Store the keys in protected profiles (`~/.config/embody/config.json`, mode `0600`; the CLI refuses a token-bearing file that others can read):

   ```json
   {
     "defaultProfile": "deploy",
     "profiles": {
       "deploy": { "baseUrl": "https://gateway.example/w/ws_abcd1234", "token": "<deployer key>" },
       "app": { "baseUrl": "https://gateway.example", "workspace": "ws_abcd1234", "token": "<caller key>" }
     }
   }
   ```

2. Create and lock a hosted app (`--request-only` or `--durable`). The scaffold's `package.json` declares the hosted profile under `embody.hosted`; the build needs a current `pnpm-lock.yaml`:

   ```sh
   npm create embody-app@latest kanban -- --request-only
   cd kanban && pnpm install && pnpm test
   ```

   The app name must equal the reserved name (it is the CLI/MCP namespace; a different `appId` fails the readiness check).

3. Deploy. The ID is printed as soon as the gateway accepts the submission; the CLI then follows it:

   ```console
   $ embody deploy --app kanban
   Packaged 7 files (3104 bytes, 2 excluded) as sha256:5f1c….
   Uploaded source src_k2j….
   Submitted deployment dep_q8n… for kanban (app_kanban0001).
     Status: embody deployments status dep_q8n… --app kanban --wait
     Cancel: embody deployments cancel dep_q8n… --app kanban
     state: accepted
     state: validating
     state: building
     state: provisioning
     state: checking
     state: promoting
     state: active
   Deployment dep_q8n… is active: release rel_7xw… of kanban (app_kanban0001).
     Discover: embody apps list
     Call:     embody kanban <entity|action> …
     MCP:      embody mcp setup --app kanban
   ```

4. Use it (caller profile):

   ```sh
   embody --profile app apps list
   embody --profile app kanban card create --title "First card"
   embody --profile app kanban card list --output json
   ```

   A durable app's workflows use the generated actions: `embody --profile app <app> followUp start --json < start.json` (with `{"input": {...}, "idempotencyKey": "…"}`) and `embody --profile app <app> followUp status <instance-id>`; `cancel` and `retry` work the same way ([WORKFLOWS](./WORKFLOWS.md)).

5. Connect an agent: `embody --profile app mcp setup --app kanban --write ~/.embody-mcp.json`, then `claude --strict-mcp-config --mcp-config ~/.embody-mcp.json` (see [MCP setup](#mcp-setup)).

## Command reference

Global options (accepted anywhere on the command line): `--profile <name>` (`EMBODY_PROFILE`), `--base-url <url>` (`EMBODY_GATEWAY_URL`), `--token <token>` (`EMBODY_TOKEN`; prefer profiles: arguments are visible in process listings), `--output json|table`, `--request-timeout <seconds>` (`EMBODY_REQUEST_TIMEOUT`, default 90). A profile may carry `workspace`; `EMBODY_WORKSPACE` sets it too.

| Command | Permission | What it does |
|---|---|---|
| `embody deploy [dir] --app <name\|app_id> [--workspace <ws>] [--no-wait] [--wait-timeout <s>] [--retry]` | `deployment:submit` (deployer) | Reads `embody.hosted` from `package.json`, packs `dir` (default `.`) with the [M10 rules](./SOURCES.md), resolves the app, uploads, submits at the app's current generation and waits (default 30 minutes) unless `--no-wait` |
| `embody deployments status <dep_id> --app <name\|app_id> [--wait] [--wait-timeout <s>]` | `deployment:read` | Reads (or follows) a deployment by ID from any machine |
| `embody deployments cancel <dep_id> --app <name\|app_id>` | `deployment:cancel` | Server-side cancellation under the deployment's cancellation fence |
| `embody apps status [name\|app_id]` | `app:read` | Apps this key may read, including reserved ones: name, ID, lifecycle status, generation, active release |
| `embody apps list` / `apps inspect <name>` | `app:call` | Unchanged: the callable catalog (namespaces) and an app's manifest |
| `embody <app> <entity> create\|get\|list\|update\|delete …`, `embody <app> <action> …`, workflow `start\|status\|cancel\|retry` | `app:call` + scopes | Unchanged; see the [CLI reference](../developer-tools/01-cli-reference.md) |
| `embody mcp setup [--app <name>] [--write <file>] [--name <server>]` | none (no request) | Prints the workspace (or app) MCP URL and the Claude Code configuration; `--write` stores it with the credential in a new `0600` file |
| `embody source pack\|upload …` | `deployment:submit` (upload) | M10 commands, unchanged except that workspace URLs now work |

**The hosted declaration.** `embody deploy` submits the profile and capabilities declared in `package.json`; it cannot infer them without running project code. The isolated build compares them with the built app and refuses a mismatch (`UNSUPPORTED_PROFILE`).

```json
{ "embody": { "hosted": { "profile": "request-only-v1" } } }
{ "embody": { "hosted": { "profile": "durable-v1", "workflows": true, "events": false, "subscriptions": true } } }
```

`events` means the app declares `publishes` in `defineApp` (events for other apps); `subscriptions` means it handles events; `workflows` means it defines workflows. The generated durable starter has workflows and a handler but publishes nothing for other apps. Schedules, app-to-app RPC, local state and GenUI cannot be declared.

**Resuming instead of resubmitting.** The submission's idempotency key is derived from the source digest and the app generation it was read at. Running the same `embody deploy` again (after a lost connection, a crash, or `--no-wait`) returns the same deployment (`Resuming existing deployment …`), even after it ended. To try the same source again after a transient failure, pass `--retry` (a new key, so a new deployment). New source or a newer generation is always a new deployment.

**Waiting, disconnects, Ctrl-C.** While waiting, the CLI polls `GET …/deployments/<id>` (every 2 s, backing off to 15 s while the gateway is unreachable or cold) and prints each state change on stderr. A dropped connection or a gateway restart does not affect the deployment: it is a durable job driven by the deployment worker ([DEPLOYMENTS](./DEPLOYMENTS.md)). Ctrl-C stops the local wait only and says so; nothing is cancelled. A Ctrl-C before the gateway answered the submission leaves its acceptance unknown; rerunning the same command resolves it without a second deployment.

**Cancellation.** `deployments cancel` reads the deployment's `cancellationFence` and posts it back; the gateway cancels in one transaction only if the fence still matches and the deployment has not ended ([CONTRACTS](./CONTRACTS.md#durability-retries-and-fencing)). If promotion won the race the CLI reports the deployment as active and exits 6. Repeating a cancel prints the cancelled status without advancing the fence. Cancelling never undoes migrations that already ran; the previous release keeps serving.

### Workspace URLs (M14.c)

| Profile / flags | Catalog, execute, MCP | Management API |
|---|---|---|
| `baseUrl: https://gw.example/w/ws_abcd1234` | `https://gw.example/w/ws_abcd1234/…` | `https://gw.example/v1/workspaces/ws_abcd1234/…` |
| `baseUrl: https://gw.example`, `workspace: ws_abcd1234` (or `--workspace`, `EMBODY_WORKSPACE`) | same | same |
| `baseUrl: https://edge.example/embody/w/ws_abcd1234` (reverse proxy path) | `https://edge.example/embody/w/ws_abcd1234/…` | `https://edge.example/embody/v1/workspaces/ws_abcd1234/…` |

A workspace in the URL and a different `--workspace` is a usage error. URLs with user info, a query or a fragment are refused (put tokens in profiles). A root URL without any workspace keeps the reference-gateway behavior for `apps`/action commands; management commands then fail with a usage error.

## Output and exit codes

Human output goes to stdout (results) and stderr (progress, hints, errors). With `--output json`, stdout carries exactly one JSON document and stderr stays human. Scripts branch on exit codes, never on messages.

| Code | Name (`EXIT.*`) | Meaning and what to do |
|---:|---|---|
| 0 | — | Success (`deploy`/`--wait`: the deployment is `active`; plain `status`: the read succeeded, whatever the state) |
| 1 | `internal` | Unexpected local error |
| 2 | `usage` | Bad command or flags, missing workspace, missing or invalid `embody.hosted`, or source that cannot be packaged (malformed source: the message names the file or rule) |
| 3 | `auth` | Key missing, expired, revoked or for another workspace: ask the operator for a new key |
| 4 | `forbidden` | Key lacks the permission (for example a caller key used to deploy), or the app is disabled |
| 5 | `notFound` | App or deployment not found or not visible to this key |
| 6 | `remote` | The gateway or app rejected the request (invalid, idempotency or generation conflict, cancel after the end, action error) |
| 7 | `unavailable` | Gateway unreachable, timed out (cold start), rate limited or a dependency outage. Retry reads; for writes the outcome is unknown, so check before retrying (the CLI never replays a write) |
| 8 | `deploymentFailed` | The deployment ended `failed`; stderr has the public error code, its fixed message and a fix-it hint |
| 9 | `deploymentCancelled` | The deployment ended `cancelled` |
| 10 | `waitTimeout` | `--wait-timeout` elapsed; the deployment is still running on the server |
| 130 | `interrupted` | Ctrl-C: local waiting stopped; nothing was cancelled |

Deployment failure hints map the [M02 public codes](./CONTRACTS.md): `BUILD_FAILED` (install/build with the recipe locally: `pnpm install --frozen-lockfile && pnpm build`), `INVALID_INPUT` (lockfile, files or an expired upload), `UNSUPPORTED_PROFILE` (declaration mismatch), `LIMIT_EXCEEDED`, `CHECK_FAILED` (the app did not start or report ready, the name differs, or a migration was refused), `STALE_GENERATION` (another deploy won: deploy again), `DEPENDENCY_UNAVAILABLE` (`--retry`). Build logs are not exposed yet (`embody logs` is M15).

### JSON examples

`embody deploy --no-wait --output json` and `deployments status --output json` print the `DeploymentStatus` contract verbatim (strict, version 1):

```json
{
  "version": 1,
  "workspaceId": "ws_abcd1234",
  "appId": "app_kanban0001",
  "deploymentId": "dep_q8nz4k2m0aa1",
  "sourceDigest": "sha256:5f1c…",
  "state": "building",
  "stageAttempt": 1,
  "expectedGeneration": 2,
  "cancellationFence": 0,
  "lifecycleFence": 0
}
```

A finished deployment adds `"state": "active", "releaseId": "rel_7xw…"`; a failed one adds `"error": {"code": "BUILD_FAILED", "message": "Build failed; inspect authorized deployment logs."}` and exits 8. `embody deploy --output json` (waiting) prints the final status the same way, also when interrupted (exit 130) or timed out (exit 10), so a script always has the ID.

`embody apps status --output json` prints the `AppList` contract; with an app argument, one `AppStatus`:

```json
{
  "version": 1,
  "workspaceId": "ws_abcd1234",
  "apps": [
    {
      "version": 1,
      "workspaceId": "ws_abcd1234",
      "appId": "app_kanban0001",
      "name": "kanban",
      "generation": 3,
      "lifecycleFence": 0,
      "status": "enabled",
      "activeReleaseId": "rel_7xw…"
    }
  ]
}
```

`embody mcp setup --app kanban --output json`:

```json
{
  "url": "https://gateway.example/w/ws_abcd1234/mcp/kanban",
  "client": "claude-code@2.1.296",
  "config": {
    "mcpServers": {
      "embody": {
        "type": "http",
        "url": "https://gateway.example/w/ws_abcd1234/mcp/kanban",
        "headers": { "Authorization": "Bearer <workspace credential>" }
      }
    }
  }
}
```

## MCP setup

The supported client is **Claude Code 2.1.296 over direct HTTP** (MD07, [MCP](./MCP.md)). `embody mcp setup` prints the workspace MCP URL (`/w/<ws>/mcp`, or `/mcp/<app>` with `--app`) and a configuration with a placeholder; it makes no request and never prints the key. `--write <file>` creates a new file with mode `0600` containing the profile's key (it refuses to overwrite) and prints the launch command: `claude --strict-mcp-config --mcp-config <file>`. Use an **app-caller** key: deploy and admin permissions are separate and MCP never gains them. Delete the file when done. Other clients and the stdio bridge are not qualified.

## Secrets and telemetry (M14.c)

- Tokens come from profiles or the environment and go only in the `Authorization` header to the gateway. They never appear in URLs, stdout, stderr, cache keys in clear (the catalog cache is keyed by a SHA-256), error messages or the source archive. Storage receives only the signed upload headers.
- Packaging excludes `.env*`, dotfiles, credentials, local databases, `.git`, `node_modules` and build output, and refuses private-key material ([SOURCES](./SOURCES.md)); the deploy output lists only counts.
- Error messages are fixed texts; the CLI never prints raw provider or host output. It sends no telemetry of its own; the gateway's audit lines carry IDs, outcome and timing only.

## Verification

- `pnpm --filter @embody/cli test` (part of `pnpm verify` and `test:mvp`): the commands against the real gateway routes, controller and build admission on a memory store: ID at once, resume by rerun, reconnect by ID, Ctrl-C (exit 130, nothing cancelled, the deployment finishes), fenced and repeated cancel, cancel after activation, build failure, malformed source and missing declaration (no request sent), missing scope, revoked key, unknown app, missing workspace, cold timeouts for management and write calls, all URL forms including a reverse-proxy path, `mcp setup` and its private file, and no token or source secret in any output. The gateway suite covers the app list route (only readable apps, names, foreign workspace refused).
- `pnpm test:m14` (local integration topology, zero skips): the **packed** CLI and scaffolder installed from tarballs in a clean consumer drive the journey below as separate processes with protected profiles. Requires the platform PostgreSQL fixture, `EMBODY_PROVISIONER_URL`, Docker, npm 11 and access to registry.npmjs.org.

| Case | Pass |
|---|---|
| `M14.a.deploy-returns-id` | `deploy --no-wait` returns a `dep_` ID and the resume hint |
| `M14.a.reconnect-by-id` | rerunning the same deploy resumes that ID; a new process follows it to `active` |
| `M14.a.discover` | the caller key lists and inspects the app; `apps status` shows both apps (one reserved) |
| `M14.a.crud` | create, get, update, create, delete, list through the CLI |
| `M14.a.durable-workflow` | the durable scaffold deploys; `followUp start` and `followUp status` through the CLI; the delayed step's wake task was created |
| `M14.a.interrupt-keeps-running` | SIGINT after the ID: exit 130, "NOT cancelled"; the same deployment reaches `active`; data survives the update |
| `M14.a.cancel-fenced` | cancel right after submission: `cancelled`; a repeat keeps the fence; waiting exits 9; the previous release still serves |
| `M14.a.mcp-setup` | `mcp setup --write` makes a `0600` file; the official MCP SDK client lists and calls the app's tools with it |
| `M14.b.malformed-source` | missing `embody.config.ts`: exit 2, names the rule |
| `M14.b.build-failure` | failing build script: exit 8, `BUILD_FAILED`, fix-it hint; the previous release still serves |
| `M14.b.missing-scope` | caller key deploying: exit 4, says a deployer key is needed |
| `M14.b.stale-key` | revoked key: exit 3 for deploy and discovery |
| `M14.b.cold-timeout` | the serving container frozen: a call with `--request-timeout 3` exits 7 with the cold-start note; it answers again after |
| `M14.c.workspace-prefixes` | `/w/<ws>` URL, root plus profile workspace, root plus `--workspace`, and a reverse proxy under `/edge` (status and CRUD) |
| `M14.c.no-secrets` | no key and no source secret in any CLI output, gateway audit line, worker log, candidate log, build log or uploaded archive |

The local topology ([`infra/mvp/m14`](../../infra/mvp/m14/)) is the real hosted gateway, M12 controller, M11 build admission and M13 release stages on the platform PostgreSQL fixture, with builds through the exact platform plan on local Docker ([M11 emulator](./BUILDS.md)) and candidates as Docker containers on per-app databases made by the provisioner role. Provider stand-ins make it local evidence only: no Cloud Run IAM or ingress, Cloud Tasks recorded but not delivered, JWKS over HTTP through a test-only preload in the candidate process (the admitted image is unchanged). The live journey (phase 2) runs the same cases against the real integration topology.

## Not yet proven / later tasks

- **Live journey** on Cloud Run, Cloud Build, Cloud Tasks and Cloud SQL: waits for an owner-approved budget (STATUS).
- **M15:** `embody logs`, `secrets set`, `apps disable|delete`, `rollback` commands (the rollback route exists since M13; its CLI command lands with M15's lifecycle controls). Build logs for failed deployments.
- App reservation and key issuance stay operator steps for the invite-only MVP (no signup or OAuth, README).
