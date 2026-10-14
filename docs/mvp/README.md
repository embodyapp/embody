# Minimal hosted MVP: deploy once, control through one gateway

**Status:** approved product scope from the owner conversation; implementation and cloud qualification remain unverified. Recorded 2026-10-08.

## Start here

- [Implementation tasks](./IMPLEMENTATION.md): ordered work, dependencies, acceptance cases, documentation requirements.
- [Completion tracker](./STATUS.md): claim work and record completion evidence here.
- [Verification contract](./VERIFICATION.md): test layers, release journey, evidence format and launch gate.
- [Durable workspaces and credentials](./WORKSPACES.md): hosted provisioning, identity/name bindings, route migration and cache/failure semantics.
- [Hosted identity and rotation](./IDENTITY.md): asymmetric app/workspace binding, provider identity separation, required role matrix and revocation bounds; [M05 live IAM/SQL/rotation evidence](./evidence/M05-live-b429/README.md) technical gates and cleanup independently accepted; final committed-evidence CI/task disposition in [STATUS](./STATUS.md).
- [Hosted MCP client contract](./MCP.md): stateless methods, headers, capability/cancellation limits and named-client qualification.
- [Hosted dispatch safety](./DISPATCH.md): connection policy, deadlines, no-replay semantics, durable workspace quotas/audit and retention operations (accepted M07; provider qualification remains separate).
- [Verification commands and prerequisites](./TESTING.md): mandatory DB/runtime-role fixture, MVP/cloud failure gates, clean packed/E2E runs and sanitized evidence.
- [M02 API/CLI and workload contracts](./CONTRACTS.md): implemented schemas and policy; deployment endpoints/commands still await their implementation tasks.

This is the delivery plan for a **narrow, invite-only hosted MVP**, not a declaration that the broader framework or managed-hosting plans are complete. All commands, endpoints and new directories described below are proposals until their implementation task passes.

## Product promise

> A user deploys a supported Embody app using the CLI, then discovers and controls it through one centralized workspace gateway using CLI or MCP. Apps can publish and subscribe to events and run durable workflows. Both apps and the gateway can reach zero instances when idle and wake automatically on requests **or when queued event/workflow work is due**, without losing data, registrations, pending work or authorization state.

An operator initially provisions each workspace and its scoped credentials. After that, the user deploys and updates supported apps **without operator intervention**. A script that only the operator can run is a prototype, not completion of this MVP.

### Supported workload

- Node/TypeScript apps based on the supported Embody scaffold and runtime versions.
- Request-driven CRUD and bounded custom actions with external PostgreSQL persistence.
- **Events, subscriptions and durable workflows** (scope change 2026-10-14, MD03/MD11–MD14, owner-approved): transactional publish, at-least-once delivery to subscribing apps in the same workspace through the gateway relay, and versioned workflows with persisted delays, retries, cancellation and compensation. Work is woken by an external queue when it is due; nothing polls (M19–M21).
- One launch region, one production environment per app, and a documented app/resource quota.
- CLI and at least one explicitly tested token-capable MCP client.
- Separate deployments for each `(workspace, app)`; multiple workspaces can share the gateway.
- User source is treated as untrusted at build/runtime boundaries even during an invite-only beta.

### Explicitly excluded

- GenUI, production browser UI/sessions and a web management console.
- Public signup, invitations, teams UI, OAuth and universal MCP-client support.
- Customer Dockerfiles, arbitrary runtimes, plugins requiring daemons or persistent local disks.
- Cron/scheduled jobs, general app-to-app RPC, cross-workspace events, and workflow steps longer than the action deadline or delayed more than 30 days (MD13/MD14).
- GitHub App integration, previews, automated billing and multi-region operation.

Unsupported features must fail deployment preflight with actionable diagnostics. The Kanban → Email review-notification journey (event publish, cross-app subscription, idempotent external effect) is the reference durable journey for M17. Static inspection cannot prove arbitrary JavaScript is stateless: the supported contract, runtime controls and tested scaffold must all be explicit.

**Two hosted profiles.** The *request-only* profile (M08, accepted) keeps zero retained notifications and rejects events/workflows. The *durable* profile (M20) adds them back without background processes: every outbox record or workflow step is paired with an external queue task created **before** the transaction commits (deterministic name, scheduled for the due time). The task wakes the app through a platform-only drain endpoint that processes one bounded batch. If the queue is unavailable, the write fails closed. Retained event/inbox/delivery records follow ADR 0004 (30 days) and are cleaned up by scheduled queue tasks, not polling. Never imply delivery in the request-only profile.

## Relationship to existing plans

The broader [framework tracker](../implementation-plan/STATUS.md), [ADR 0003](../adr/0003-durable-workflows.md) and Phase 11 still govern releases that advertise durable workflows. This narrower hosted profile intentionally does not offer those features; it does not mark those gates DONE or change their framework semantics. GenUI remains a separately gated feature under Phase 14. Applicable security, packaging, ownership and customer-data obligations from Phases 12–13 still apply.

**Scope change 2026-10-14:** the hosted MVP now includes ADR 0003 workflows and ADR 0004 events, using the gateway relay transport (previously optional P7-04) because hosted apps cannot reach each other directly. Framework workflow gates (P11-02/P11-03) become MVP prerequisites through M19.

The review snapshot used local `main` at `a7643d3`, with fetched `origin/main` at `c07d6ff`. Phase 15 and hosting documents exist on remote/unmerged branches and may not be present in this checkout. M01 reconciles their task IDs and latest state before implementation. Prefer reusing their implementation over building parallel stores, auth or dispatch systems.

Relevant work identified in the review:

- PR #29: shared dispatch, error handling, audit and limits (P15-01).
- PR #30: action metadata (P15-02); annotations alone do not prove safe write replay.
- PR #31: delegated agent attribution (P15-06), stacked on #29.
- PR #32: workspace/sleep design, not implementation.
- `docs/genui-incremental-plan`: substantial unmerged GenUI work; preserve it, but it is not a prerequisite for this non-UI MVP.
- `docs/cloud-run-hosting-plan`: broad hosting plan, not implemented infrastructure.

## Architecture

```text
CLI / supported MCP client
          |
          v
Gateway (Cloud Run, min instances 0)
  - workspace authentication / authorization
  - durable app catalog and action routing
  - deployment admission and management API
          |                         |
          v                         v
App services  <---- wake ----  Durable deployment jobs
(Cloud Run, min 0)      |            |
          |       Wake queue (Cloud Tasks): due events,
          |       workflow steps, relay deliveries
          |                         v
App-bound PostgreSQL          Trusted deployment worker
                              /                  \
                       Isolated builder      Provider APIs
                       (no prod secrets)     / migration runner
                              |
                       Immutable image registry
```

The gateway is the centralized public interface, **not the untrusted build executor**. Customer code/configuration must never execute in the gateway or privileged deployment worker. The worker uses external durable jobs and bounded invocations, not detached promises after an HTTP response. An external reconciler repairs incomplete deployments without requiring the gateway to stay alive.

### Durable state and identities

- Platform database: workspaces, hashed credentials, registrations/manifests, deployments, active release pointers, quota/audit intent and deployment jobs. No app runtime may access it.
- App database: restricted per-app credentials, separate migration authority; tenant RLS is defense in depth, not a substitute for database privileges.
- Private object storage: bounded uploaded source archives, expiring retention and scoped access.
- Artifact Registry: immutable images by digest, with ownership and retention metadata.
- Secret Manager: gateway signing keys and app-bound secrets. Apps receive only verification material, never gateway signing authority.
- Each workload has minimal cloud permissions. Ingress requires platform invocation identity plus appropriate Embody authorization; credentials cannot be reused across apps/workspaces.

Cloud Run is selected. Managed PostgreSQL is required. **Neon versus Cloud SQL remains a qualification decision**: test role isolation, pooling, cold latency, region, connection limits, recovery and total cost before choosing. No second runtime provider abstraction is needed.

## Scale-to-zero contract (mandatory)

1. Gateway and every supported app use minimum instances `0`, request-based billing and bounded scaling/concurrency.
2. Both must actually reach zero in real-cloud tests; configuration alone is insufficient evidence.
3. Platform ingress wakes the gateway; gateway dispatch to the stable app endpoint wakes the target app.
4. Catalog discovery reads durable state and makes no app calls. Sleeping apps remain listed.
5. No mandatory app heartbeat, background polling or process-owned session state. Registration belongs to deployment, not individual instances.
6. No scheduled public health checks or idle MCP keepalive policy that defeats scale-down. Provider metrics and controlled synthetic checks are used instead.
7. Useful active requests/streams may keep instances running. Scale-to-zero means after quiescence, not forced cancellation of active work or guaranteed immediate shutdown.
8. MCP must work across gateway instance replacement without sticky routing; publish the exact supported client/version and idle behavior.
9. All correctness-critical state lives outside processes and ephemeral filesystems.
10. Cold store failure fails closed; no empty/permissive fallback registry, quota or authorization policy.
11. Cold timeouts are bounded and measured across client → gateway → database → app. Never blindly replay mutations after an ambiguous failure.
12. Deployment processing and maintenance can wake their own worker; they must not periodically ping the gateway or unrelated apps.
13. Events, workflow steps, retries, delays and retention cleanup run only when a queue task for that specific work is due. An idle app with no due work receives no wake; a delayed step sleeps until its scheduled time. No periodic sweep (MD12).

Scale-to-zero does not mean zero monthly cost. Database compute/storage, backups, images, source storage, network, builds and logs must be included in cost evidence. Budget alerts are not spending caps.

## Minimum user-facing surface

Existing execution/discovery commands should remain compatible. Proposed new commands, finalized and documented by M02/M14:

- `embody deploy`: validate, upload, submit and wait for deployment, with noninteractive/JSON output and a resumable deployment ID.
- `embody deployments status <id>`: inspect progress/failure without resubmitting.
- `embody apps list`: list authorized apps and release/status metadata.
- `embody logs <app>`: bounded, authorized logs with request/deployment IDs.
- `embody rollback <app> <release>`: request a compatible previous release.
- `embody apps disable <app>` / `embody apps delete <app>`: stop admission; deletion requires explicit confirmation and retention policy.
- `embody secrets set <app> <name>`: protected interactive/stdin input, never secret values in command arguments or normal output.

Use existing protected CLI profiles for credentials. Do not invent an OAuth login flow for this release. MCP exposes app tools; deploy/admin permissions are separate and are not automatically granted to an agent that can call app actions.

## Delivery order

1. **Foundation:** M01–M03 (integration, contracts, real verification).
2. **Secure gateway:** M04–M07 (durable state, auth, stateless MCP, dispatch safety).
3. **Hosted runtime:** M08–M09 (request-only profile and qualified cloud/database/queue baseline), M19–M20 (workflow engine gates and queue-woken durable runtime).
4. **Deploy path:** M10–M13 (source admission, isolated build, durable controller, promotion), then M21 (gateway event relay and subscriptions).
5. **Operate:** M14–M16 (CLI, management, recovery/terms).
6. **Prove and release:** M17–M18 (real cold journey and candidate sign-off).

Work may overlap according to task dependencies. One owner per task; one integrator owns shared gateway/host contracts. The estimated schedule is subordinate to acceptance evidence, not a commitment to ship on a date.
