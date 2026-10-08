# Hosting implementation decision register

Read [verification](./00-VERIFICATION.md) first. This register records the engineering baseline used to make the plan executable, alternatives rejected, consequences and approval gates.

**Status meanings:** `BASELINE` = selected in this implementation proposal, not evidence of deployment or owner approval; `ACCEPTED-EXISTING` = already required by an existing accepted framework ADR/business direction; `ACCEPTED-USER` = explicitly directed by the user and recorded in ADR 0007 or ADR 0008; `OPEN` = must be resolved before the named dependent work can finish; `DEFERRED` = explicitly outside launch. A BASELINE security/product boundary must be reviewed in CH1-02. Approval must name a reviewer/date/evidence; do not invent approvals. Material changes supersede entries rather than erasing history.

## Summary

| ID | Decision | State | Verification / gate |
| --- | --- | --- | --- |
| HD01 | Hosting is the business; private team apps are the initial wedge | BASELINE; hosting direction supplied by user | V17; CH1-02 product review |
| HD02 | Separate control, build, app and operations trust domains | BASELINE | V04–V06; CH1-03 |
| HD03 | App/environment is runtime and database isolation unit | BASELINE | V05, V06; CH3-01/02 |
| HD04 | GCP Cloud Run first; one launch region; no custom compute scheduler | ACCEPTED-USER for provider; region/configuration OPEN | ADR 0007; V05, V11, V13, V21; CH1-03 |
| HD05 | Asymmetric downstream identity; no tenant-held minting keys | BASELINE | V02; CH2-04 |
| HD06 | Own authorization; buy login; least privilege across all surfaces | BASELINE; login provider OPEN | V01–V03; CH2-01/03 |
| HD07 | App-specific PostgreSQL DB/role; RLS is defense in depth | BASELINE | V06, V11; CH3-02 |
| HD08 | Immutable releases and durable fenced deployment reconciler | BASELINE | V07, V08; CH5-01/03 |
| HD09 | Restrictive egress and app-scoped secrets; no implicit shared trust | BASELINE | V05, V14; CH3-03/04 |
| HD10 | At-least-once, version-pinned workflows stay launch-critical | ACCEPTED-EXISTING; hosted adaptation BASELINE | ADR 0003; V10; CH7-01 |
| HD11 | Private previews; explicit production promotion | BASELINE | V09; CH4-02, CH6-04 |
| HD12 | Separate customer-view site; no bypass of GenUI release gate | BASELINE; gate adjustment OPEN if requested | ADR 0005; V12; CH6-03 |
| HD13 | All hosted apps sleep-capable; min-zero at launch | ACCEPTED-USER | ADR 0007; V19–V21; CH9-01…06 |
| HD14 | Restore into new binding; rollback is not data undo | BASELINE | V07, V11; CH5-04, CH7-03 |
| HD15 | Durable PostgreSQL platform state and fenced jobs; shared rate-limit store chosen explicitly | BASELINE; quota/session implementation OPEN | V07, V13; CH1-04, CH5-05 |
| HD16 | Verification gates outweigh dates; real boundary proof mandatory | BASELINE | All V IDs; all gates |
| HD17 | Workspace pricing; basic security in every paid tier | BASELINE; actual prices/limits OPEN | V15; CH8-01 |
| HD18 | Preserve framework portability and current license model | ACCEPTED-EXISTING | V16, V17; CH1-04, CH8-03 |
| HD19 | Strong external-effect enforcement requires a connector broker | BASELINE; broker DEFERRED | V03, V05; product claim review |
| HD20 | Stateless hosted execution; durable state external; no process-affinity correctness | ACCEPTED-USER | ADR 0007; V19; CH9-01/06 |
| HD21 | PostgreSQL due-work truth + Cloud Tasks delivery + external reconciliation | BASELINE implementation of accepted sleep requirement | V20, V21; CH9-02…05 |
| HD22 | Gateway supports actual zero and cold session recovery; warm capacity optional | ACCEPTED-USER | ADR 0008; V22; CH9-07 |
| HD23 | Shared framework work lives in Phase 15; workspace = company account; teams inside workspaces | ACCEPTED-USER | ADR 0006 Amendment 1; Phase 15 |

## HD01 — Product boundary

**Decision:** build the deploy/share/operate service rather than another code editor or generic container host. Launch with supported Embody Node apps for private teams; deny anonymous public application access by default.

**Why / alternative:** broad language/public-SaaS support expands abuse, networking, identity and support scope before validating value. Private apps give sharing a clear authorization model.

**Consequences:** one click follows necessary account/integration setup; a shareable URL is not a bearer grant. Framework development is prioritized where it unblocks the hosted journey. Template onboarding and a secure browser entry point are required, not merely a deployment API.

**Revisit:** customer interviews show public apps dominate paid demand. Expansion requires a new abuse and multi-end-user tenancy design, not a feature flag alone.

## HD02 / HD03 — Trust domains and app isolation

**Decision:** customer code never runs inside a control-plane/API/signing process. Use provider-supported VM-isolated execution per app/environment and separately for builds. Isolate different apps inside one workspace as well as different workspaces. A preview is a different environment/security principal.

**Why / alternative:** JavaScript capabilities, package boundaries and ordinary shared-process plugins cannot constrain raw Node APIs. A default shared-kernel container pool is not accepted as an equivalent boundary without a separately reviewed isolation mechanism.

**Consequences:** baseline compute cost is higher. App code can access its own bound secrets/data; this service does not protect an app's data from its owner-supplied malicious code. Runtime escape assurance combines provider documentation, operational patching and adversarial control tests, not a claim that finite tests prove a hypervisor secure.

**Revisit:** a different runtime offers a documented equivalent boundary and passes the full V04–V06 corpus with review.

## HD04 — Provider and region

**Decision:** use **GCP Cloud Run first**, as explicitly directed by the user and recorded in [ADR 0007](../../adr/0007-cloud-run-stateless-hosting.md). Cloud Run second-generation min-zero services, Cloud SQL PostgreSQL, Cloud Tasks/Scheduler, Artifact Registry, Cloud Storage, Secret Manager and Cloud KMS form the [new baseline](../CLOUD-RUN-ARCHITECTURE.md). The provider is selected; region/configuration/security qualification are not complete.

**Superseded alternative:** AWS/Fargate-first and an always-on-first MVP. Do not build a second provider or re-open selection by default. Custom compute scheduling/Kubernetes remain out of scope; a small trusted durable-work scheduler is required and is not a custom container orchestrator.

**Gate:** CH1-03 must prove private authenticated ingress, enforced egress, minimally privileged metadata identity, stateless cold execution, streaming separation, resource containment and cleanup on real GCP. Failure blocks launch and requires explicit review; it does not authorize silent weakening or a provider switch.

**Owner approval required:** budget and region/data residency. No multi-region recovery claim at launch.

## HD05 — Identity channel

**Decision:** hosted downstream JWTs use an explicitly allowed asymmetric algorithm, short lifetime (initial design ceiling: 60 seconds), issuer/audience/environment binding and `kid` rotation. Gateway/signing service holds private key material; app hosts receive only verification keys. Select the concrete algorithm/key service combination in CH2-04 after provider support review.

**Alternative rejected:** shared HS256 gateway/app secret lets hostile apps mint accepted identities. Merely choosing a random stronger shared secret does not solve this.

**Implemented by:** framework Phase 15 P15-09 (workspace-bound ES256 tokens with JWKS), so it is not built twice.

**Consequences:** add an explicit hosted verifier configuration without silently breaking self-hosted HS256 compatibility. Hosted mode rejects HS256. Key rotation, bounded JWKS caching and unknown-key refresh are tested. JWT expiry alone cannot meet 30-second revocation with a 60-second token: policy/session invalidation and freshness checks are also required.

## HD06 — Authorization ownership

**Decision:** external provider authenticates users; Embody persists membership, app grants, credential scopes and policy revisions. Roles do not automatically grant unknown custom actions. Platform administrative rights and app execution rights are distinct. Map workspace ID to framework `orgId` through a trusted adapter; never accept workspace identity from arbitrary client claims without membership validation.

**Important consequence:** ability to deploy app code or change its secret bindings is effectively privileged access to that app's data and credentials. Do not advertise a developer role as data-blind if it can deploy arbitrary code. Billing-only users have no deploy/access grant. Owners/admins can manage grants, but privileged escalation must be visible/audited; routine data access still uses explicit grants.

**Open choices:** hosted login provider, account recovery rules and provider-specific MFA enforcement. Revocation implementation must deny after bounded stale-state expiry; the data plane may remain up during console outage but must fail closed when authorization freshness cannot be established.

## HD07 — Database boundary

**Decision:** a managed PostgreSQL cluster may contain multiple apps, but each app/environment has a separate database and restricted login role; platform state uses a separately inaccessible database/credentials. Explicitly remove default cross-database CONNECT and PUBLIC privileges where necessary, restrict role assumption and ownership, and verify actual deployed grants.

**Alternative rejected:** one universal runtime credential plus `SET LOCAL app.current_org` is not hostile-code isolation. Schemas/row filters alone are not the selected security boundary.

**Consequences:** shared company knowledge flows through authorized actions/events, not common SQL credentials. App-group shared storage needs new consent/threat model. Cluster resource exhaustion is still shared risk: per-role limits and cluster admission/storage monitoring are required. PostgreSQL does not inherently provide a hard per-database storage quota; do not promise one without enforcement outside app code.

**Untrusted migration constraint:** platform tables use trusted migration jobs; customer code never receives owner privileges. Any custom app migration can affect only its app database under the documented limited model.

## HD08 — Release and deployment state

**Decision:** immutable release = source/artifact digest + manifest + runtime + configuration/secret-version references. Deployment = persisted state machine. Workers are at least once; use idempotency keys, ownership tags, durable step outputs, leases and fencing generations. Promotion uses atomic compare-and-swap on app/environment route generation.

**Alternative rejected:** deploy inside a long API request or “latest” image tag; neither survives retries predictably nor proves what ran.

**Consequences:** retry after an ambiguous provider response discovers/adopts the same owned resource. Revalidate deployer permissions and capability approval at promotion, not only acceptance. Cancellation and stale workers cannot promote after losing their fence. Compatibility violations require explicit operator/user action rather than automatic rollback.

## HD09 — Network and secrets

**Decision:** deny outbound network except app storage and approved destinations; enforce below Node APIs. Runtime and build policies differ. Secrets are bound by app/environment/version, encrypted, omitted from source/manifests/logs and unavailable to ordinary builds. Prefer brokered integration credentials later where protection against malicious app code is required.

**Consequences:** direct IP, IPv6, DNS rebinding, redirects, private/link-local ranges and alternate resolvers are tested. Domain allowlists cannot prevent exfiltration to an approved destination. Runtime-held secrets are readable by that runtime; document this truth. Rotation may intentionally invalidate rollback to an old configuration.

## HD10 — Durable work and cross-app events

**Existing decision:** [ADR 0003](../../adr/0003-durable-workflows.md) requires durable version-pinned workflows, at-least-once steps, idempotent effects and per-step authorization. Existing P11 release blockers remain required.

**Hosted decision:** retain a compatible dormant release/route for active old-version work, not a continuously running worker; external dispatch wakes it on demand. Workers claim only eligible versions within their app database. Cross-app subscriptions require explicit grants and authenticated producer/destination identity. Never share a workspace-wide event signing key among hostile apps.

**Transport choice:** preserve the [ADR 0004](../../adr/0004-cross-app-event-delivery.md) transport seam. CH7-02 must select direct authenticated routing or a trusted durable relay and record retry/fan-out ownership. A transport that lets a tenant impersonate other producers cannot pass. Do not assume an optional relay implementation is already production-ready.

## HD11 — Preview/promotion

**Decision:** source changes may build automatically; production promotion defaults to explicit authorization. Previews get separate storage, grants and secrets, deny effects by default, expire, and cannot receive production credentials merely because a PR originated from the same repository.

**Consequences:** pin Git source to immutable commit; duplicate/reordered webhooks do not deploy an unintended branch. A new action/scope/egress request produces a reviewed capability diff before promotion.

## HD12 — Hosted browser and GenUI scope

**Decision:** customer-controlled views live on a different site boundary from management sessions, with immutable assets, private data channels, CSP, validated messages and normal action authorization. “App-owned trusted static view” in the framework means code trusted by the app author—not code trusted by the hosting platform.

**Existing gate conflict handled explicitly:** [framework implementation README](../../implementation-plan/README.md) requires P14-07 before advertising GenUI. The hosting product plan prefers not to require optional client adapters. **This plan does not silently override that gate.** CH1-02 must either retain it, or approve a superseding ADR splitting hosted web release evidence from optional adapters. Until then, CH6-03/paid GenUI claims are blocked on the existing gate. A non-GenUI browser surface still needs V12 tests and an explicitly approved product scope.

## HD13 / HD14 — Capacity and recovery

**Accepted decision:** every hosted app must be able to sleep; scale-to-zero and statelessness are mandatory at launch. Cloud Run app services/retained releases use minimum instances zero and request-driven bounded execution. HTTP calls, events, workflow delays and retries have external wake paths. No idle heartbeat, per-app daemon or minimum-one instance is allowed as a correctness workaround. Shared trusted services may have measured baseline capacity. This supersedes the prior always-on-first/deferred-sleep proposal.

**Recovery decision:** restore into an isolated new database binding, verify it, fence old writers, then cut over. External effects remain disabled until replay is reviewed. Code rollback requires compatible state and available credentials; no automatic destructive down migrations.

**Open approval:** seven-day PITR retention and RPO/RTO targets require measured provider cost and restore evidence before publication. Recovery of a shared cluster to extract one app must be included in capacity/time modeling.

## HD15 — Platform persistence, queues and sessions

**Decision:** use Cloud SQL PostgreSQL for durable control-plane resources, deployment jobs, idempotency, policy revisions, wake intents and transactional audit outbox. Use **Cloud Tasks as the managed invocation/delivery layer**, with Cloud Scheduler driving bounded reconciliation. PostgreSQL remains work truth; queue ACKs do not replace transactional completion. Provider calls and control-plane steps are bounded, persisted and externally resumed, not detached post-response loops. Trusted platform services—not customer apps—own cross-workspace scheduling.

**Phase 15 alignment:** the persistent registry and catalog are Phase 15 P15-05/P15-08 (PostgreSQL `GatewayStore`); MCP is stateless (P15-04), so there is no gateway session state to persist for MCP.

**Open:** choose shared rate-limit primitives and gateway session persistence in CH5-05. Options include a dedicated managed cache with atomic counters, or a measured database-backed limiter. MCP sessions terminate at trusted gateways, not app instances; catalog/progress data must survive app sleep and gateway replacement. Affinity is at most an optimization, never the sole correctness mechanism. Exact session/reconnect semantics remain to test.

**Reason:** selecting a distributed cache by habit does not establish failover correctness, but process-local counters/registry are inadequate for hosted replicas.

## HD16–HD19 — Assurance, economics and boundaries

- **HD16:** real trust-boundary evidence is mandatory, even if it slows delivery. Critical tenant-isolation or identity defects block all customer exposure. No cloud secrets in fork CI. Dates from the product plan are estimates, not exceptions to gates.
- **HD17:** bill workspaces with included capacity; isolate every paid app consistently. Prices/limits/overages remain unapproved until cost tests and buyer validation. Meter authoritative provider/platform events, not app self-reporting. Budget stops preserve export and do not claim zero overshoot for already-incurred cost.
- **HD18:** preserve local/self-hosted contracts and the current source-available/commercial model. Hosting contracts/privacy/legal entity approval are separate from the framework license. Users retain source/data portability; nonpayment cannot silently erase data or remove promised export access.
- **HD19:** app hooks provide normal-path agent safety, not enforcement against hostile app code. A strong “external send/spend requires approval” guarantee needs a trusted connector broker holding the credential and consuming an approval bound to exact inputs. Broker implementation is deferred; prohibit stronger marketing claims until its independent tests pass.

## HD20 / HD21 — Statelessness and external wake

**HD20 accepted requirement:** runtime memory/scratch is disposable; external PostgreSQL contains business state, outbox/workflows, schedules and idempotency. No local SQLite, durable process timers, in-memory sessions or detached post-response work in hosted production. Cold boot is side-effect-free. Preserve explicit local/self-hosted mode; generated apps and skills teach the hosted contract. Static checking is advisory; replacement/concurrency tests and enforced runtime limits provide evidence, not a proof of arbitrary JavaScript correctness.

**HD21 implementation baseline:** framework transactions persist due-work metadata with work rows; a trusted metadata-only reconciler sweeps it even when hints are lost. Platform WakeIntent/delivery records precede Cloud Tasks enqueue. Authenticated tasks call a trusted dispatcher that checks epoch, grants and pinned release before invoking the app. Duplicate transport delivery is safe through leases/fences and external idempotency; no distributed transaction or exactly-once claim. Long schedules remain in PostgreSQL beyond provider queue horizons. Shared scanner connection/cost limits must be measured.

**Consequences:** add CH9-01…06 and V19–V21 to launch gates. Old-version work retains artifacts/routes with zero idle instances. Restore/delete epochs fence stale tasks. Idle MCP sessions and tool discovery never pin app compute. All shared baseline and queue/reconciliation costs remain in the unit-economics model.

## HD22 — Gateway scale-to-zero capability

**Accepted requirement:** the hosted gateway must support minimum instances zero and recover correct behavior on the next request without live process state. [ADR 0008](../../adr/0008-gateway-scale-to-zero.md) records this extension to ADR 0007. CH9-07/V22 are mandatory before launch, not satisfied by app-only sleep tests.

**Implementation baseline:** external durable/reconstructable routing, authorization, quotas, audit intent and logical session/progress state; bounded lazy cold startup; no gateway-owned background scheduling. Prefer stateless MCP HTTP where supported, otherwise define restart-safe session state or protocol-correct expiry/reinitialization. Live SDK transport/server/socket objects cannot simply be serialized into a shared cache.

**Capacity/connection distinction:** optional warm capacity is a cost/latency policy, never a correctness dependency. Zero requires quiescent requests/connections. Document idle-stream closure, cursor retention and client reconnect behavior; do not force useful active work to stop. Clients with persistent connections or immediate reconnect may keep capacity active and must not be advertised as sleep-compatible without evidence.

**Verification/consequences:** measure gateway-only and both-gateway-and-app cold latency externally; show real zero intervals, independent scheduled app work, preserved quotas/audit, cold revocation and no mutation replay after disconnect. Shared database/network costs remain; no guarantee of zero during continuous customer traffic. The concrete transport/client support matrix remains a CH9-07 design-and-test gate, not presumed universal compatibility.

## HD23 — Alignment with the central MCP gateway (Phase 15)

**Accepted (user, 2026-10-08):** framework [Phase 15](../../implementation-plan/15-central-mcp-gateway.md) and [ADR 0006](../../adr/0006-central-mcp-gateway.md) Amendment 1 cover the gateway as a multi-tenant central MCP server. To avoid planning the same work twice:

- **Terms.** A **workspace** is a customer company's account: the tenant, `orgId` in framework code (as HD06 already maps it). **Teams** are units inside a workspace (for example "Sales EMEA") that own apps; they are not a data boundary. Every app deployment belongs to exactly one workspace and is workspace-wide or team-owned.
- **Implemented once, in Phase 15:** workspace-bound asymmetric gateway tokens (HD05 → P15-09); persistent registry and catalog independent of running instances (HD15, CH9-04 → P15-05, P15-08); stateless MCP (CH9-07 → P15-04); wake-tolerant calls, app status from real calls and a due-time wake sweep (CH9-04 → P15-14); host `sleep` runtime mode with bounded wake work (first slice of CH9-01 → P15-15); app-to-app calls inside a workspace (P15-13).
- **Owned here:** Cloud Run services and min-zero profiles, provisioning, deploy-time registration, the full due-work reconciler with Cloud Tasks and the trusted dispatcher (CH9-02, CH9-03), version-pinned wake and restore fences (CH9-05), launch evidence and cost model (CH9-06, CH9-07 evidence), accounts, invitations, billing, previews and builds.
- **Wake contract.** Phase 15's MVP wakes apps through `POST /embody/wake` driven by a once-a-minute sweep of saved next-due times plus a daily safety wake. HD21's reconciler and Cloud Tasks replace the sweep behind the same endpoint when stronger timing and scale guarantees are needed.
- **App states.** Phase 15 defines `ready`, `idle` and `unavailable` from real calls. CH9-04's hosting states (deployed, executing, failed, paused, deleted) extend them with provider and operation evidence.

## Open-decision closure checklist

Each closure records: selected option; alternatives and rejection reasons; cost/security/compatibility consequences; reviewer/approver; date; test evidence; affected plan/task IDs; reconsideration trigger.

Before G0 close: product boundary review, Cloud Run security/cost qualification, region, infrastructure budget, identity-provider shortlist and GenUI gate resolution plan. Provider selection and mandatory app sleep/statelessness are accepted under ADR 0007; gateway-zero capability is accepted under ADR 0008. Do not leave these requirements marked OPEN. Before the dependent task completes close: concrete signer algorithm/provider, account recovery policy, event transport, limiter/session model, migration compatibility contract. Before customer data/paid launch close: legal/privacy, support staffing, retention/recovery promises, prices and limits. Never mark an OPEN decision accepted merely because a placeholder is implemented.
