# Embody Cloud: managed hosting service plan

**Status:** Product/implementation plan with **Cloud Run first and mandatory stateless, sleep-capable hosted apps accepted by user direction** in [ADR 0007](../adr/0007-cloud-run-stateless-hosting.md). Other baseline choices require verification/approval. Not an announcement or an approved SLA/pricing commitment.

**Implementation:** Start with the [verification contract](./implementation-plan/00-VERIFICATION.md), then the [detailed implementation plan](./implementation-plan/README.md), [decision register](./implementation-plan/DECISIONS.md), and [task tracker](./implementation-plan/STATUS.md).

**Updated runtime architecture:** [Cloud Run, external durable state, and wake-on-work](./CLOUD-RUN-ARCHITECTURE.md). Sleep is a launch requirement, not a future optimization; [CH9-01…07](./implementation-plan/09-sleep-and-stateless-execution.md) define its implementation and tests. [ADR 0008](../adr/0008-gateway-scale-to-zero.md) also requires the gateway itself to support zero instances and correct cold-session recovery.

**Business direction:** Embody's primary business is hosting Embody applications. The framework is the creation and portability layer; the paid product is deploying, sharing, securing, and operating those applications without becoming an infrastructure engineer.

## 1. Product thesis

> Build an Embody app with your agent. Click Deploy. Share it with the right people and agents. Embody operates the rest.

The starting point is Pete Koomen's YC request, [A Cloud for Small Software](https://www.ycombinator.com/rfs#a-cloud-for-small-software). It describes purpose-built tools with one or a handful of users, now easy to create with agents but difficult to deploy and share. It specifically identifies company-specific environments, authentication, permissions, and the security of arbitrary code as unsolved problems. Its product benchmark is: **“Small software should be as easy to share with your colleagues as a Google Doc.”**

### Implications for Embody

1. **Sell a working, private application—not a container.** Hosting must include identity, persistent data, TLS, secrets, recovery, and operational visibility.
2. **Make sharing a first-class operation.** “Invite Alice as an operator” should not require writing authentication code or issuing a broad API key.
3. **Treat generated code as untrusted.** Typed actions and policy hooks improve application correctness; they do not isolate malicious or compromised JavaScript.
4. **Offer a workspace environment.** Apps inherit approved identities, policies, integrations, resource budgets, and region settings.
5. **Optimize for many small apps.** A workspace with twenty intermittently used tools should not need twenty infrastructure projects or twenty expensive always-on servers.
6. **Differentiate through Embody semantics.** Automatically understand entities, actions, agent capabilities, events, approvals, and workflow versions rather than presenting generic infrastructure controls.
7. **Preserve an exit.** Users retain their source and can export data and self-host. Convenience and trust—not trapped data—should drive retention.
8. **Stateless execution, durable external state, sleep by default.** Every hosted app must tolerate replacement and zero idle instances; requests, events and scheduled work wake it without an app-owned daemon.

### Positioning

**Embody Cloud is the private, managed home for your team's agent-built operational apps.**

The initial competitive alternative is not only another PaaS: it is a useful tool abandoned on a laptop, a spreadsheet plus a shared API key, or an employee spending days assembling hosting, identity, and a database.

## 2. Initial customer and scope

### Initial customer profile

Small engineering, operations, and AI-native teams, roughly 2–50 people, building internal tools with coding agents. The buyer is a technical founder or team lead; the builder is often an engineer working with an agent; most app users should not need technical knowledge.

Start with three repeatable use cases:

- A task/approval hub shared by people and agents.
- An operations dashboard with custom actions and durable records.
- An integration workflow that ingests events, drafts changes, and requires approval before external effects.

Use the Kanban and Email examples as starting fixtures, not as evidence that their hosting and external integrations are production-certified.

### MVP boundary

| Include at paid launch | Defer |
| --- | --- |
| Embody Node/TypeScript apps using supported versions | Arbitrary language runtimes and customer Dockerfiles |
| Private workspace, invitations, app roles, scoped agent identities | Anonymous public SaaS, public app marketplace |
| Git-backed and CLI source deployment | A new AI coding editor |
| Managed PostgreSQL, encrypted secrets, TLS | GPU workloads and arbitrary persistent local disks |
| Isolated builds and stateless Cloud Run execution with scale-to-zero | Customer infrastructure/BYOC and multi-cloud operation |
| Browser app entry point, CLI, MCP | Full visual app builder |
| Logs, audit, metrics, rollback, backup and restore | Automatic repair of arbitrary application bugs |
| One selected region, multi-zone platform services where supported | Active-active multi-region applications |
| Measured limits, billing, export, incident support | Unlimited free compute and bespoke enterprise contracts |
| Verified outbox/workflow behavior and approved cross-app access | Unrestricted cross-app SQL or network access |

Do not require every GenUI client adapter to launch hosting. Do require a secure browser experience for the promised reference apps and a management console that does not expose the development inspector. Changing existing framework release dependencies requires an explicit decision, not silently skipping them.

## 3. Core user journeys

### 3.1 First deployment

1. A user opens **Deploy to Embody** from a template/repository, or runs the proposed `embody deploy` command from an existing app.
2. They sign in, create/select a workspace, and authorize access only to the selected repository. CLI login uses a browser/device flow; no account token is pasted into source.
3. Embody identifies the app, supported runtime, lockfile, entities, actions, views, workflows, requested secrets, and requested outbound integrations. App configuration is executable code: manifest extraction runs in the isolated builder, never in the control-plane process.
4. A concise confirmation shows **Private to you**, region, resource/billing ceiling, requested capabilities, and any missing integration credentials. Established workspace defaults remove repeated decisions.
5. The user clicks **Deploy**. Embody builds an immutable artifact, provisions app storage and identity, installs approved configuration, runs health/compatibility checks, and switches routing only when ready.
6. The result is an HTTPS app URL, a **Share** button, and **Connect an agent** instructions. MCP/CLI connections reference the same app and authorization model.
7. The app page shows its current version, health, backup status, usage, and recent deployments.

**One click means one confirmation after initial account/integration setup.** Embody must not hide required permissions or pretend it can invent third-party credentials. Missing inputs produce an actionable checklist, not a failed deployment log.

Proposed experience targets for supported small reference apps, to validate rather than advertise immediately:

- Median first deployment under 3 minutes; p95 under 5 minutes, excluding human input.
- Share an existing app in under 30 seconds.
- No customer-authored Dockerfile, cloud account, TLS setup, SQL administration, or IAM configuration.
- Every failure has a stable code, plain-language explanation, and retry/remediation path.

### 3.2 Sharing and access

- Owner selects **Share → person/group → role → optional expiry**.
- Recipient signs in and sees only accessible apps. A URL by itself grants no access.
- Invitations are single-use, expiring, and bound to the invited verified identity. Automatic access for a claimed email domain is off by default.
- Owner can see and revoke all human, agent, and service grants from one screen.
- An agent receives a separate identity and explicit action/app scopes, not the owner's full session.
- Revocation stops new operations, invalidates cached permissions and streaming sessions, and is rechecked before delayed workflow steps.

### 3.3 Updates and rollback

- Git integration can create a private preview; production promotion is manual by default.
- Preview has separate credentials and a separate database, no production secrets/data or external side effects by default, and an expiration policy.
- The deployment screen shows changes to actions, scopes, entity validation, workflow definitions, secrets, and egress. New sensitive permissions require approval.
- Healthy deployment becomes active atomically; old traffic drains. Failed readiness checks leave the previous release serving.
- Rollback selects a previous immutable release. It does **not** silently reverse database changes or external effects. Compatibility checks determine whether rollback is safe.

### 3.4 Operations without infrastructure expertise

The app page answers: Is it working? Who can access it? What changed? Why did this action fail? Is my data recoverable? What is this costing?

Provide deploy history, redacted logs, request/action IDs, failed event/workflow queues, retry controls with side-effect warnings, spend limits, backup/restore, and data export. Notification defaults should surface actionable failures rather than raw infrastructure noise.

## 4. What exists and what must be built

Repository evidence: [framework status](../implementation-plan/STATUS.md), [security model](../production/03-security.md), [gateway operations](../production/07-self-hosting-the-gateway.md), and the auth, gateway, and PostgreSQL source packages. This is an architecture review, not a fresh verification of every tracked test.

| Existing foundation | Hosting gap |
| --- | --- |
| Typed manifests, action dispatch, entity hooks, principal scopes | Workspace policy service, invitations, persistent grants, access management UI |
| Host lifecycle, health, registration, HTTP/SSE | Placement, isolated execution, readiness, rollout, managed lifecycle |
| Gateway, CLI, MCP and OIDC/API-key primitives | Hosted login, agent onboarding, persistent registry, HA, distributed quotas |
| PostgreSQL storage and RLS | Provisioning, app-bound database credentials, backup/restore, connection limits |
| Transactional outbox and workflow implementation | Complete crash/upgrade/authorization proofs and version-aware scheduling |
| Local scaffolding, inspector, testing harness | Deploy CLI, secure source upload, build pipeline and hosted console |
| GenUI contracts under development | Secure hosted rendering and browser end-user experience |
| Security/release procedures and commercial planning | Operational evidence, incident staffing, billing, customer contracts |

### Non-negotiable changes before running unrelated customers

1. **In-process plugins are not a sandbox.** The documented current model trusts app code. Different hosted apps need an infrastructure security boundary.
2. **Replace shared downstream HS256 signing secrets.** Current hosts share a configured signing key with the gateway. Untrusted hosted code must never receive a key that can mint platform identity tokens. Use asymmetric signing: trusted gateway holds private keys; apps receive verification keys only. Pin issuer, audience, algorithm, environment, and lifetime; support rotation.
3. **RLS alone does not contain hostile code holding a database connection.** The current adapter sets `app.current_org` per transaction. An attacker with the same credential can attempt to change session context. Use app/environment-bound database privileges and credentials, not merely a caller-controlled organization setting.
4. **Productionize gateway state.** Registry, audit, limits, and MCP session behavior need explicit persistence, consistency, replication, restart, and routing designs. Multiple replicas alone do not create HA.
5. **Resolve existing release gates.** The status tracker still marks workflow crash/cancellation and claim-role isolation, hardening, packaging, and legal work incomplete. Hosting must not relabel these as finished.

## 5. Architecture

### 5.1 Trust boundaries

```text
People / coding agents / automation
               |
        TLS edge + abuse controls
               |
      +--------+-------------------------------+
      |                                        |
Cloud console/API                      Regional data gateway
      |                               auth / policy / MCP / routing
Control-plane database                          |
Deployment reconciler                  isolated app environments
      |                                |                   |
Isolated build workers             app A runtime        app B runtime
      |                                |                   |
Signed immutable registry          app A database      app B database
      |                                +---- egress policy ----+
Runtime provider adapter                        |
                                     approved external services
```

- **Control plane:** accounts, workspaces, memberships, policies, deployment intent, artifacts, secret references, billing and audit metadata. Customer code never executes here.
- **Data plane:** authenticated routing, app runtimes, app databases, event/workflow execution, controlled outbound connectivity.
- **Build plane:** short-lived untrusted builds with separate identities, network rules, quotas, and no production credentials.
- **Operations plane:** internal tooling with time-limited privileged access, separate staff identity, audited break-glass procedures, and backups inaccessible to apps.

An outage of the console or deploy API should not stop healthy apps. The data plane uses bounded caches of durable routing/policy state, with explicit invalidation and fail-closed behavior once authorization freshness expires. New deployments and administrative mutations can fail independently.

### 5.2 Selected provider and sleep-first architecture

**Use GCP Cloud Run first**, in one launch region. This is accepted in ADR 0007, superseding the AWS/Fargate-first and always-on-first proposals. Region, exact configuration, security qualification and budgets remain to verify. No second provider or custom compute scheduler for MVP.

- **Cloud Run second-generation services:** isolated app/environment instances, request-based billing, minimum instances zero; no correctness reliance on process memory, disk, sticky sessions or post-response work.
- **Cloud SQL PostgreSQL:** externally durable entities, outbox/inbox, schedules/workflows and idempotency; separate app databases/roles and protected platform state.
- **Cloud Tasks + Cloud Scheduler + trusted dispatcher/reconciler:** authenticated bounded wake delivery for events, due steps, retries and platform jobs, even when every app is at zero. PostgreSQL work records remain truth; reconciliation repairs commit/enqueue/ACK gaps.
- **Artifact Registry, Cloud Storage, Secret Manager and Cloud KMS:** immutable images/artifacts, scoped credentials and trusted signing.
- **Cloud Run Jobs:** isolated customer builds with staging-only authority; trusted packaging never executes customer output with privileged credentials.
- **VPC/Direct VPC egress and enforced outbound controls, HTTPS gateway/edge, Logging/Monitoring:** secure access, network containment and operations. Shared platform capacity may remain provisioned; app scale-to-zero does not mean a zero-dollar database/network.

Catalogs and routes are deployment-owned durable state, not dependent on 30-second app heartbeats. MCP sessions terminate at the trusted gateway; idle discovery/streams must not pin app runtimes. The gateway must also support a verified min-zero profile with externally durable/reconstructable state and tested MCP session recovery. Active connections may keep it running; optional warm gateway capacity is a latency/cost choice, never a correctness dependency. Workflows retain dormant release routes/artifacts, not warm workers. See [the detailed architecture](./CLOUD-RUN-ARCHITECTURE.md) for service mapping, deadlines, queue/reconciliation semantics and trust boundaries.

Cloud Run qualification must prove: isolated credentials/data, enforced egress and harmless least-privilege metadata identity; actual zero-instance request/event/schedule wake; no app polling or idle MCP pinning; bounded restart-safe execution and database connections; version-pinned wake and stale-restore-task fencing. Model 10/100/1,000 apps including shared infrastructure and queue/scanner costs. A failed mandatory control blocks launch for design review, not an automatic switch of provider or weaker security.

**All hosted apps must be stateless and sleep-capable at launch.** Persistent local storage, process-owned scheduling and uncheckpointed indefinite workers are unsupported hosted patterns. Static checks plus runtime conformance and enforced limits assess compatibility; no claim that arbitrary JavaScript can be proven stateless automatically.

### 5.3 Resource model

```text
Account
  Workspace (billing, identity, policies, region)
    Membership / Group / AgentIdentity / ServiceIdentity
    App
      Environment (production, preview; staging later)
        Deployment -> artifact digest + manifest + config revision
        DatabaseBinding / SecretBinding / IntegrationBinding
        AppGrant / EgressPolicy / ResourceQuota
        WorkflowVersion / EventSubscription / ExecutionEpoch
    WakeIntent / QueueDelivery / SchedulerCursor
    AuditRecord / UsageRecord / InvoiceReference
```

Every resource has an immutable internal identifier. Display `appId` and URL slugs are not globally authoritative identifiers. Routing and registration keys include workspace, app, environment, and release where appropriate. Map workspace identity to the existing `orgId` contract explicitly; do not assume current single-registry app IDs safely separate hosted workspaces.

Separate immutable **release definition** (artifact, manifest, runtime, configuration references) from mutable **deployment state** (provisioning, healthy, failed, retired). Secret values never enter an artifact or release document.

### 5.4 Deployment controller

Proposed API: create deployment with source digest/ref, app/environment, configuration revision, and idempotency key; receive a deployment ID immediately. CLI and console use the same API.

```text
accepted -> validating -> building -> provisioning -> starting
         -> checking -> promoting -> active -> draining -> retired
                     \-> failed (previous active release preserved)
```

Use persisted state and a queue/reconciler, not a long HTTP request. Every step must tolerate duplicates, retries, controller restarts, and partial cloud failures. Serialize production promotions per app/environment using generation checks. Cancellation fences later promotion. Garbage collection deletes orphan resources only after checking ownership and retention.

Pipeline responsibilities:

1. Authorize deployer, plan limits and requested capability changes.
2. Fetch a pinned commit/source archive; defend extraction against traversal, symlinks, oversized archives, and decompression bombs.
3. Build with pinned runtime/base image and frozen lockfile. npm install scripts and app manifest evaluation are untrusted execution. Initially allow only documented build recipes, not privileged Docker builds.
4. Produce manifest, SBOM, vulnerability report, provenance and digest; sign with a platform service outside the untrusted builder. A valid signature proves pipeline origin, not that source is harmless.
5. Provision app-bound database role, secret bindings, network policy and runtime identity.
6. Run trusted platform schema migrations with a separate migration role. Never hand that role to application startup code. App-specific data migrations run with app-limited permissions.
7. Start candidate, validate manifest/resource ownership, test readiness and authenticated action connectivity without unintended business side effects.
8. Promote route with compare-and-swap generation; pin catalogs/views to release; drain old requests and preserve necessary workflow versions.
9. Emit audit and usage events; report success or a recoverable, sanitized failure.

Retain enough previous artifacts and configuration references for the advertised rollback window; expose when revoked secrets or schema changes prevent safe rollback.

## 6. Identity, sharing and authorization

### 6.1 Separate platform roles from application roles

| Platform role | Intended permissions |
| --- | --- |
| Workspace owner | Billing, ownership transfer, workspace deletion and all administration |
| Workspace admin | Membership, environment policy and app administration; not ownership transfer |
| Developer | Create/deploy apps as granted; cannot expand workspace policy |
| Member | Discover and use explicitly granted apps |
| Billing admin | Billing and usage, no implicit access to app data |

| App role | Intended permissions |
| --- | --- |
| App administrator | Share and configure this app; deployment rights are separately controlled |
| Viewer | Explicitly declared read actions |
| Operator | Explicitly approved operational actions |
| Approver | Approve specific sensitive operations; no automatic deployment rights |
| Custom grant | Named actions/entity operations within policy limits |

Do not infer that arbitrary custom actions are safe/read-only from their names. Add reviewed action metadata and role bindings; default unknown actions to ungranted. If row/field restrictions cannot yet be enforced centrally, say so and require tested app-specific policies rather than presenting a misleading fine-grained UI.

**Effective permission is the intersection of** workspace policy, app grant, actor/credential scope, environment policy, and current app restrictions. A URL scoped to an app is not authorization. Discovery, invocation, streams, views, retries and workflow steps all apply the same decision rules.

### 6.2 Identity implementation

- Buy hosted authentication; own Embody membership and authorization records. Start with a standard login provider, verified invitations, and MFA for privileged operations; add organization SSO/SCIM when demanded.
- Use secure HTTP-only browser sessions with CSRF protection and session rotation. Keep console sessions off app origins.
- Use a separate origin/site boundary for customer-controlled views; avoid parent-domain cookies that leak console credentials. Restrict frames, CSP, cross-origin messaging, and allowed interaction targets.
- Implement remote MCP authorization against the applicable protocol and test supported clients. During beta, narrowly scoped expiring agent credentials can bridge unsupported clients; never label manual bearer setup as universal one-click OAuth.
- Store API-key verification hashes, display new secrets once, track last use, enforce expiry and revocation. Separate agent identities from human membership lifetimes and document their sponsorship/ownership.
- Downstream identity tokens are short-lived, audience-bound, asymmetric, and contain only necessary claims. Hosts have no minting keys. Cross-app calls go through trusted identity/policy enforcement with narrower delegated authority; no reuse of incoming bearer tokens for another audience.
- Revocation target: new calls denied within 30 seconds. Use policy revisions, invalidation, bounded cache lifetimes, and step-boundary checks; test already-open streams. Previously completed external effects cannot be revoked.

### 6.3 Approvals and policy limits

Use the existing principal-aware hooks as an application safety layer, supplemented by platform-enforced access and outbound controls. Where offered, approval records bind actor, app/release, action, exact input digest, expiry, and single-use/idempotency semantics. Material input changes require a new approval. Separate requester and approver where workspace policy requires it.

**Important boundary:** a malicious app can bypass its own hooks or use secrets it legitimately holds. Hard guarantees such as “cannot send email without approval” require the external credential and side effect to live behind a trusted connector broker that enforces approval. Until that exists, describe direct integration policies as protection against agent misuse through normal app APIs, not protection against hostile app code.

## 7. Secure runtime environment

### Threat model

Assume customer source, dependencies, install scripts, generated views, action inputs and external webhook payloads can be malicious. Protect other customers, the hosting control plane, infrastructure credentials and backups. Also reduce blast radius within a workspace: one app is not automatically trusted with all company data.

| Threat | Required controls |
| --- | --- |
| Runtime escape/cross-app access | Provider-supported VM isolation per app execution boundary; no privileged mode, host mounts or runtime sockets; patched base images; distinct workload identities |
| Resource exhaustion/cryptomining | CPU, memory, process, disk, request, build-duration and concurrency caps; signup/billing abuse checks; kill switch |
| Secret theft | Per-app/environment bindings, encryption, redaction, no build-time production secrets, rotation; brokered credentials where stronger protection is needed |
| SSRF/metadata attacks | No platform privileges in app context; metadata-issued app identity has no unintended authority; restrict private/link-local destinations and document provider-managed exceptions; enforce egress and validate redirects/DNS resolution |
| Gateway registration abuse | Provisioner-owned endpoints and workload-bound registration credentials; app cannot choose arbitrary proxy destinations |
| Database lateral access | Per-app/environment database and login role; revoke PUBLIC/default cross-database privileges; non-owner runtime role; no broad DDL/BYPASSRLS |
| Supply-chain compromise | Lockfiles, isolated builds, SBOM/scanning, provenance, signed digest deployment, documented vulnerability response |
| Forged identities/events | Asymmetric identity tokens, per-producer/audience event trust, expiry/replay checks and inbox idempotency; no workspace-wide shared app signing secret |
| View XSS/token theft | Untrusted origin isolation, CSP, safe rendering, validated messages and no console tokens in app JS |
| Sensitive logs | Bounded/redacted structured logs, no bodies by default, restricted access/retention; do not promise perfect redaction of malicious output |
| Staff misuse | MFA, least privilege, time-limited audited support access, no routine customer-secret visibility |

Default runtime: Cloud Run second-generation, non-root image, min instances zero, bounded request/batch execution and ephemeral scratch, authenticated ingress via trusted platform, no persistent local state. Validate actual provider hardening capabilities and reviewed equivalent controls rather than claiming unsupported read-only-root/process-limit flags. Enforce isolation and resource policies below customer JavaScript; app-owned wrappers are not security boundaries.

Default outbound access is denied except managed app storage and explicitly approved integrations. All app network paths must be subject to enforceable rules; bypass through raw sockets or alternate DNS must fail. Domain allowlists alone do not prevent exfiltration through an approved endpoint, so offer scoped credentials and warn owners about requested destinations.

Workspace administrators define templates for egress, secrets/integrations, allowed builders/runtime versions, preview behavior, resource limits and data retention. Apps may request narrower settings, never silently weaken the workspace baseline. Enterprise private connectivity is later work, not a hidden prerequisite for MVP.

## 8. Data, events and durable work

### 8.1 Storage strategy

Use Cloud SQL PostgreSQL for hosted production; keep SQLite for local development. Cold app instances reconstruct state from external stores; local SQLite is never hosted production persistence. Start with **a database and restricted role per app/environment on managed regional clusters**. Cluster-level sharing keeps costs manageable, but database privileges—not just naming conventions—must prevent lateral access. Separate the platform database from all tenant runtime credentials.

This deliberately changes the literal “one shared company database” deployment story: present a connected workspace through authorized APIs/events, not universal SQL credentials. Apps can share data by declaring explicit capabilities and subscriptions. A later trusted app-group storage mode needs its own threat model and explicit common-trust consent.

- Enforce connection, query/statement timeout, storage and transaction-duration limits; use pooling compatible with transaction-local tenant context.
- RLS remains defense in depth for framework paths. App credentials can potentially access all data inside their own app database; do not claim hostile-code isolation between business tenants inside one hosted app.
- Keep migration credentials outside the runtime. Test runtime inability to change ownership, RLS configuration, other databases or roles.
- Validate JSON schema changes against old data. Flexible JSONB storage removes many DDL migrations, not data compatibility problems.
- Provide paginated, authorized data export including entity types, schema/manifest versions, timestamps and stable IDs. Encrypt export artifacts and expire download links.
- Add managed blob/object storage with app-bound access when customer use cases require attachments; do not encourage storing binary files in ephemeral disks.

### 8.2 Backups and restore

Proposed paid-production objectives: **RPO ≤ 15 minutes and RTO ≤ 4 hours**, subject to measured database size and failure scenarios. These are internal design targets until restore drills validate them. Initial regional-disaster objectives must be stated separately; a single-region product must not imply regional HA.

- Enable encrypted continuous/PITR backups with a proposed seven-day recovery window, plus retention tiers only after cost/legal review.
- Distinguish cluster PITR from per-app restore. Shared-cluster PITR may require restoring an entire cluster to an isolated recovery environment, then extracting the selected app database.
- Restore into a new binding first; validate and explicitly cut over. Do not overwrite unrelated apps.
- Fence writes/old runtimes during cutover and preserve a rollback path. Disable external integrations in restored copies until approved.
- Restoring outbox/workflow state may replay effects already completed externally. Preserve external idempotency semantics and require a replay decision; a backup does not “undo email.”
- Run automated sample restores monthly and full operational drills quarterly, measuring data integrity, elapsed time and permissions.
- Publish deletion behavior for primary data, logs and expiring backups; handle legal retention separately.

### 8.3 Events, jobs and workflows

Keep Embody's at-least-once semantics explicit. Do not promise exactly-once external effects.

- Initially use the existing outbox/workflow persistence model with enforced app-specific credentials and bounded workers.
- Finish existing crash recovery, claim-role, cancellation, retry, compensation and authorization tests before including workflows in production support.
- Retain artifacts/configuration and authenticated release routes needed by active workflows. New work uses active release; old work wakes its pinned dormant release. Idle retained versions have zero minimum instances; apply explicit retention/quota/migration/cancellation policy.
- Persist schedules and due-work metadata transactionally in app PostgreSQL. A trusted metadata-only reconciler sweeps even when hints are lost; Cloud Tasks wakes bounded app batches. Repair the source-DB/platform-DB/queue transaction gaps and provider queue expiry without relying on app CPU after response.
- Cold boot does not migrate data or send effects. Workers checkpoint within invocation deadlines; longer operations use durable steps. Restore/delete epochs fence stale wake tasks. Sleep/wake is mandatory before launch.
- Approve cross-app subscriptions by workspace/app identity, not endpoint strings supplied by customer code. Relay or direct transport must enforce identical ownership, audience and replay protections.
- Observe oldest pending event age, workflow lag, dead letters and retained-version cost.

## 9. Reliability, support and operating contract

### Proposed service objectives

| Measure | Initial internal target / definition |
| --- | --- |
| Paid data-plane availability | 99.9% monthly successful platform serving for healthy supported apps; distinguish app-code failures from platform failures |
| Authorization revocation | New calls denied within 30 seconds; delayed steps reauthorize |
| First deploy | p95 < 5 minutes for published small reference fixture |
| Compatible rollback | p95 < 2 minutes for route promotion, excluding data repair |
| Gateway overhead | p95 < 100 ms regional warm-request overhead, excluding app execution |
| Backup recovery | RPO ≤ 15 minutes / RTO ≤ 4 hours for explicitly tested data sizes/scenarios |

Publish only measured promises with exclusions, support hours and service-credit terms approved. Cold startup is part of the supported latency model; sleeping is not unhealthy. Concurrent replicas must share only durable authoritative state and pass lease/session/rollout tests. Track cold latency, due-work/sweep lag, queue retries, zero-instance intervals and database connection pressure.

Required operations:

- Central metrics, structured logs and trace/request IDs spanning edge, gateway, action, event and workflow. Audit records are append-oriented, access-controlled and exported to storage tenant code cannot modify.
- Durable registry and distributed rate limits. Define MCP stateless/reconstructable session, expiry/reinitialization and catalog behavior; affinity cannot be required for correctness. Verify gateway zero→cold HTTP/CLI/MCP, persistent quota/audit/revocation state, no blind mutation replay and no maintenance/health traffic accidentally pinning gateway capacity. Schedule work through separate dispatcher even when gateway is zero.
- Alerts for error budget burn, unhealthy apps, authorization anomalies, worker lag, database saturation, backup failure, capacity and billing-meter lag.
- Documented handling for provider outage, database failure, bad deploy, lost signing key, exposed customer secret, abusive tenant and mistaken deletion.
- Customer-visible status page and incident notifications. Staff production support before selling production promises; use a sustainable on-call rotation rather than a nominal 24/7 guarantee from one person.
- Dependency/base-image patch policy with emergency redeployment for critical exploitable vulnerabilities. Distinguish app-owner dependency remediation from platform patching.
- Repeated resilience tests: worker/gateway/controller termination, database failover, duplicate queue delivery, stale policies, interrupted build/provisioning, streaming disconnects and full restore.

Production-ready means the platform is operated and recoverable. It does not mean Embody can certify arbitrary customer business logic, regulatory suitability or third-party uptime.

## 10. Pricing and unit economics

### Packaging hypothesis—not approved pricing

Charge primarily for a **workspace with included app capacity**, with transparent resource limits. Do not charge for every invited viewer: that penalizes the sharing behavior the product needs. Agent calls still consume metered capacity, so unlimited viewers must not imply unlimited compute.

| Package hypothesis | Positioning | Illustrative test range |
| --- | --- | --- |
| Trial | Time-limited, low quotas, no SLA; explicit data/export grace period | Free with abuse safeguards |
| Builder | Small private production workspace, modest included resources | $20–40/workspace/month |
| Team | More included apps/capacity, groups, audit retention and collaboration | $80–150/workspace/month |
| Business, later | SSO/SCIM, larger isolation/retention options and contracted support | Validated sales-led price |

Do not promise exact app counts until idle compute and database costs are measured. Essential isolation, authentication, TLS and basic recoverability belong in every paid tier, not a security upsell.

Track compute-seconds and memory allocation, database storage/connections, outbound transfer, build minutes, logs/retention, retained workflow versions and backups. Present estimated monthly spend, included usage, threshold alerts and an owner-approved overage setting. No surprise autoscaling bill.

Use idempotent append-only usage records, reconciled against provider totals, with billing webhook replay protection. Infrastructure measures usage; untrusted apps do not self-report the authoritative meter. Define what happens when meters lag.

Budget policy distinguishes admission from durability: prevent new expensive work at limits, but retain data and provide export access. Warn before suspension; document how required workflow draining, backup retention and minimum baseline costs are handled. A spend ceiling cannot instantly reverse already-incurred provider usage.

### Economic validation

For each cohort calculate:

`gross margin = (revenue - compute - storage/backups - network - build - telemetry - identity/payment fees - direct support) / revenue`

Model 1/5/20 apps per workspace; idle vs periodic use; heavy agent loops; long-lived MCP connections; workflow version retention; restore overhead. Aim for a credible path to >70% gross margin at stable scale, not an assumed day-one result.

Price from measured request-driven app compute plus shared gateway/dispatcher, Cloud Tasks/Scheduler, Cloud SQL, network, backup and support costs. Dormant releases incur artifact/state retention, not mandatory always-on compute. If economics fail, adjust included limits/pricing and improve batching/fairness; do not weaken isolation or postpone mandatory sleep. App-owned keepalive loops are unsupported.

## 11. Implementation structure and delivery plan

### Suggested repository boundaries

All names below are proposals, not existing APIs:

- `apps/cloud-console`: workspace/app/deploy/access/billing browser UI.
- `apps/cloud-api`: control-plane API and external identity/billing integration.
- `apps/cloud-worker`: bounded Cloud Tasks/Scheduler-driven deployment, due-work scanning, wake dispatch, recovery and cleanup handlers.
- `packages/cloud-contracts`: versioned resource, policy and deployment API schemas.
- `packages/cloud-provider`: narrow Cloud Run/Jobs, Cloud Tasks/Scheduler, Cloud SQL, Artifact Registry and storage provisioning adapters.
- `infra/`: reviewed infrastructure-as-code, environment configuration and policy tests.
- Extend `packages/cli`: login, deploy, status, logs, share, rollback and export commands.
- Extend `packages/auth` / `packages/gateway`: asymmetric verification/issuance, hosted resource identity, durable collaborators and policy invalidation.
- Extend `packages/host` / `packages/storage`: explicit stateless hosted mode, bounded request-driven workers, transactional due metadata, release/epoch-aware claims, external scheduling seam, app-bound provisioning and migrations.
- Use `packages/genui` for hosted views only after browser security/rendering gates pass.

Keep platform provisioning, billing and provider SDK dependencies outside `@embody/core`. Preserve local development and self-hosting; cloud-specific secrets and account requirements must not leak into local use.

### Resourcing and planning assumptions

The previous **16–24-week estimate with 3–4 engineers** assumed sleep could wait; it is no longer the baseline schedule. Re-estimate after the Cloud Run qualification and first stateless/wake slices (CH1-03, CH9-01/02). Staff platform/runtime, identity/product and storage/recovery work in parallel with design/security/legal support. A single engineer should run a narrower invite-only pilot, not promise this scope or a production SLA on the old calendar.

| Stage | Order | Deliverables | Exit gate |
| --- | --- | --- | --- |
| H0: Validate selected platform | First | Threat model, Cloud Run/Cloud SQL/Tasks spike, test harness, region/budget, stateless contract | G0: provider controls and cold execution feasible; no vendor selection left open |
| H1: Secure sleeping vertical slice | After foundations | Identity, isolated build/app DB, bounded host mode, durable deploy/catalog, external wake queue/reconciler | G1: request/event/schedule wake from zero, commit/enqueue crash proof, idle MCP does not pin app; synthetic data |
| H2: Sharing and daily use | Alongside durable-work integration | Invitations/roles, CLI/browser, Git/previews, stateless templates and migration guidance | Teammate/agent journey survives cold starts, revocation and instance replacement |
| H3: Operated sleep-capable beta | After all required runtime/recovery work | Workflow release gates, dormant-version wake, restore epoch fencing, export, telemetry and cost proof | G2: CH9/V19–V22 plus framework/security/recovery/terms gates pass before real customer data |
| H4: Paid launch readiness | After beta evidence | Billing/budgets, independent review, incident drills, staffed support and approved terms | G3: exact candidate V01–V22, cost/billing reconciliation and commercial sign-off |
| H5: Growth and efficiency | Post-launch | Better wake batching/cold latency, templates, groups/SSO on demand, optimizations | Improve retention/margin without weakening already-delivered sleep/security correctness |

Stages overlap only where task dependencies allow. Sleep is already required in H1/H3, not introduced in H5. Dates are subordinate to exit gates.

### Workstreams and dependencies

| ID | Workstream | Primary owner skill | Depends on | Acceptance evidence |
| --- | --- | --- | --- | --- |
| HC-01 | Threat model, provider and isolation ADR | Platform/security | H0 interviews | Adversarial isolation and cost spike report |
| HC-02 | Resource model and control-plane persistence | Backend | HC-01 | Tenant-scoped API tests; no cross-workspace enumeration |
| HC-03 | Hosted auth, memberships, grants and revocation | Backend/security | HC-02 | Positive/negative role matrix across every surface |
| HC-04 | Asymmetric gateway identity and registration ownership | Runtime/security | HC-01, HC-02 | Compromised host cannot mint accepted tokens or register another destination |
| HC-05 | Isolated build and artifact pipeline | Platform | HC-01 | Malicious install script contained; signed immutable deployment |
| HC-06 | DB provisioning, least privilege and restore | Storage/platform | HC-01, HC-02 | Hostile SQL tests and timed per-app restore drill |
| HC-07 | Deployment reconciler and runtime lifecycle | Platform/backend | HC-04–HC-06 | Controller crash/retry does not duplicate or incorrectly promote resources |
| HC-08 | Console, CLI and Git deployment UX | Product/full-stack | HC-02, HC-03, HC-07 | Timed first-deploy/share journey without infrastructure knowledge |
| HC-09 | Durable gateway, sessions, quotas and zero-capacity support | Runtime/backend | HC-03, HC-04; CH9-07 integration | Rolling restart, actual zero/cold sessions, durable security state and independent background work |
| HC-10 | Events/workflows and version retention | Runtime/storage | Existing P11 gates, HC-06, HC-07 | Crash/upgrade/cancel matrix; no unauthorized replay |
| HC-11 | Hosted browser views and origin isolation | Frontend/security | Required P14 subset, HC-03, HC-08 | XSS/cross-origin/permission tests and usable reference apps |
| HC-12 | Telemetry, metering, billing and budgets | Backend/operations | HC-07, HC-09 | Usage reconciliation, webhook replay and budget-stop tests |
| HC-13 | Launch assurance and customer terms | Operations/legal/security | All required launch work | Signed-off launch checklist and operational evidence |
| HC-14 | Stateless host, durable wake and scale-to-zero | Runtime/platform/storage | Identity/storage primitives; then deployment/workflow/recovery integration per CH9 | V19–V22: cold replacement, lossless wake, idle catalog/MCP, gateway-zero and measured cost |

Critical path: **Cloud Run qualification → app-bound identity/storage → stateless bounded host → deploy/catalog + lossless external wake → sharing/idle MCP → sleeping workflow/version/restore correctness → security/operational launch gate**. Detailed CH task dependencies, not coarse workstream ordering, govern implementation. Billing and console design can proceed in parallel; they cannot compensate for an incomplete runtime boundary.

## 12. Release test matrix and launch gates

### Required end-to-end proofs

1. New account → deploy reference app → invite teammate → scoped agent call → audit entry, without operator intervention.
2. Workspace A cannot enumerate, invoke, subscribe to, restore or export workspace B's resources, including guessed IDs and stale catalog URLs.
3. App A executing arbitrary JS/SQL cannot reach app B's storage, secrets, identity tokens, private endpoint or cloud permissions, even within the same workspace unless granted.
4. A compromised runtime cannot forge gateway identities, event producers or workflow grants accepted outside its boundary.
5. Revocation works across cached grants, active MCP/SSE sessions, queued jobs, delayed workflow steps and deployment permissions.
6. Dependency install scripts and archive extraction attacks cannot reach the control plane or production credentials.
7. Failed build, failed migration, unhealthy candidate and concurrent deploys preserve the last healthy release; idempotent retries leave no orphan active instances.
8. Node/process termination, gateway replacement and database failover preserve durable state; duplicate delivery does not falsely claim exactly-once external behavior.
9. App-level PITR/restore leaves unrelated apps untouched; restored jobs do not send external effects without a deliberate replay decision.
10. Preview environments cannot read production secrets/data or send production webhooks; untrusted Git contributions cannot acquire privileged build credentials.
11. View XSS cannot access console sessions or invoke unauthorized actions; private app content cannot leak through public/CDN caches.
12. Burst traffic, fork/process pressure, log floods and agent loops cannot exhaust shared services or evade billing/resource limits.
13. Key rotation, emergency app isolation, account recovery, ownership transfer, deletion and export are rehearsed.
14. All apps reach zero idle instances; HTTP/events/due workflows wake the correct release without user traffic, heartbeat or app polling. Process replacement, commit/enqueue/ACK failures, stale restore tasks and idle MCP are tested. V19–V21 are mandatory at launch.
15. Gateway reaches actual zero when requests/connections are quiescent, cold-starts correctly, preserves quotas/audit/grants, safely recovers or expires sessions and never replays mutations merely because a connection failed. Scheduled app work continues without gateway capacity. V22 is mandatory, even if an operator chooses warm gateway capacity.

### Paid-launch checklist

- [ ] Product promise and supported workload limits are explicit; no undocumented beta dependencies.
- [ ] Every hosted app uses stateless request-driven execution; real scale-to-zero, lossless wake, idle-MCP and version/restore tests V19–V21 pass. No always-on correctness workaround.
- [ ] Gateway min-zero capability and cold-session tests CH9-07/V22 pass, including idle-client compatibility, durable security state and end-to-end double-cold latency. Active work is not killed just to force zero.
- [ ] Existing required framework release blockers have evidence, not just status labels.
- [ ] Isolation, identity, egress, secrets and database boundaries have independent review.
- [ ] All critical findings closed; other accepted risks have named owners and expiry dates.
- [ ] Backup/restore, disaster assumptions and rollback limitations are documented and measured.
- [ ] Production support, escalation, incident communication and abuse handling have accountable owners.
- [ ] Terms of service, privacy policy, subprocessors, DPA process, deletion/retention and usage policy reviewed by counsel.
- [ ] Billing, refunds, cancellation, data export and entitlement grace behavior are tested.
- [ ] No claims of certifications, compliance, SLA or customer data residency beyond delivered evidence.
- [ ] Customer data/source are not used for model training without explicit consent; telemetry collection is disclosed.
- [ ] Five or more design partners have used real apps and at least three have validated willingness to pay at a sustainable price.

## 13. Go-to-market and success metrics

### Acquisition loop

1. A coding agent scaffolds an Embody app using the framework skill/template.
2. Local success ends with **Deploy to Embody**, not Docker instructions as the primary paid-product path.
3. The user deploys privately, then invites teammates or connects another agent.
4. Workspace members discover trusted templates and create the next app with inherited policy defaults.
5. More useful apps and retained data/workflows increase workspace value without multiplying administrative work.

Keep the framework docs, CLI, templates and website aligned: framework = build; cloud = deploy/share/operate. Do not remove self-hosting documentation or call the existing source-available license open source.

Recruit design partners directly before buying acquisition. Onboard their actual existing scripts/internal tools, observe deployment and access friction, and measure who continues using the app after the initial demo. Publish verified customer workflows and migration guides rather than generic cloud feature lists.

### Metrics

**North star:** weekly active hosted workspaces with at least one successfully used production app. Track the subset shared with another person or agent to measure the sharing thesis; do not exclude useful solo apps.

Supporting metrics:

- Acquisition → local app → deploy started → deployed → first successful use → first share → paid conversion.
- Time to first deployment, time to first collaborator, deployment success without staff intervention.
- Active apps per workspace; four/eight-week workspace retention; weekly meaningful actions, excluding health checks and synthetic agent loops.
- Percentage of apps with a non-owner user/agent; invite acceptance and scoped-agent connection completion.
- Platform-caused error rate, restore success, permission incidents, revocation latency and support tickets per workspace.
- Infrastructure/direct support cost per active workspace and per idle app, gross margin and unexpected bill incidents.

Suggested beta decision thresholds: ≥80% of supported deploy attempts complete without staff intervention; ≥50% of activated design-partner workspaces remain active after four weeks; zero known cross-tenant security defects; measured unit economics support the selected tier. Treat small-cohort percentages as directional, supplemented by interviews.

## 14. Decisions to approve next

1. Confirm private internal/team apps as the launch wedge, rather than public anonymous applications.
2. Approve the app/environment as a runtime and database trust boundary; replace implicit shared-DB trust with explicit connected-app access.
3. Approve asymmetric downstream identity and no tenant-held platform signing keys.
4. Cloud Run first and mandatory stateless/sleep are already accepted. Approve region, networking/IAM configuration, invocation limits and queue/scanner budgets after GCP qualification.
5. Approve minimum browser/GenUI functionality and which client adapters are not hosting launch dependencies.
6. Set funded staffing, support hours and beta timeline; choose capacity limits from observed costs.
7. Approve trial/pricing experiments, backup retention, recovery targets and launch evidence requirements.
8. Confirm counsel-reviewed customer rights, operating entity, terms and privacy obligations before accepting production customer data.

**Recommended immediate action:** qualify Cloud Run and deploy Kanban with isolated DB/identity, min instances zero, no app polling and a durable catalog. Prove cold CRUD after process replacement. Next wake Email/outbox and a delayed workflow with no user traffic, including a crash immediately after DB commit but before queue submission. Then add sharing/revocation, dormant-version rollback and fenced restore. These proofs precede console polish and any production launch.

## References

- [YC: A Cloud for Small Software](https://www.ycombinator.com/rfs#a-cloud-for-small-software) — product motivation; infrastructure choices and proposed economics above are Embody recommendations, not YC prescriptions.
- [Framework implementation status](../implementation-plan/STATUS.md).
- [Current security model](../production/03-security.md).
- [Current self-hosted gateway behavior and limitations](../production/07-self-hosting-the-gateway.md).
- [Durable workflows ADR](../adr/0003-durable-workflows.md).
- [GenUI ownership ADR](../adr/0005-generative-ui-presentation.md).
- [Cloud Run/stateless/sleep ADR](../adr/0007-cloud-run-stateless-hosting.md), [gateway scale-to-zero ADR](../adr/0008-gateway-scale-to-zero.md) and [runtime architecture](./CLOUD-RUN-ARCHITECTURE.md).
- [Commercial decisions](../commercial/DECISIONS.md) — deferred commercial choices remain unapproved until recorded there.
