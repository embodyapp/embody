# 03 — Isolated runtime, storage and configuration

**Entry:** Cloud Run is selected by ADR 0006; its security/configuration spike and real-cloud harness must pass. Tests in this phase run customer-controlled JS/SQL under the exact credentials/network policies to be deployed.

## CH3-01 — Runtime provider and resource containment

**Verification first:** app/environment runtimes have distinct provider isolation boundaries; one hostile workload cannot read/modify another's canaries or platform resources. Capped exhaustion does not take down the healthy neighbor. Invariants: V05, V13. Boundaries: L2 adapter contracts + L4.

**Dependencies:** CH1-03/04. **Areas:** `packages/cloud-provider`, runtime IaC and provider conformance suite.

**Implementation steps:**
1. Define narrow ensure/observe/retire/destroy service/revision operations with deterministic ownership/generation and wake-capable release routing. A deployed service may have zero instances; sleeping is not deletion. Classify retryable/terminal/ambiguous provider outcomes.
2. Implement Cloud Run second-generation app/environment services with request-based billing, zero minimum instances, bounded max instances/concurrency and non-root images. No host mounts/socket/privileged mode; ingress requires trusted infrastructure identity. Validate actual scratch/root-filesystem controls; do not invent unsupported flags.
3. Enforce CPU/memory/log/concurrency/duration limits and tested process/filesystem-abuse containment. Missing mandatory isolation blocks launch; reviewed equivalent controls and limitations must be explicit.
4. Separate trusted provisioning/image-pull authority from tenant service identity. Metadata tokens may exist but must grant no unintended GCP, signing, queue or neighbor access.
5. Implement provider readiness, termination/drain, diagnostics, idle/executing/failed state and inventory. No periodic external app probes to keep instances alive. Full stateless/wake behavior is verified by CH9-01…06.

**Acceptance cases:** `.a` adapter retry after ambiguous create discovers one owned runtime; `.b` hostile raw process/filesystem/cloud-API probes fail with positive controls; `.c` CPU/memory/process/log/disk pressure is contained and observed; `.d` terminated runtime stops serving and cleanup twice is safe; `.e` no runtime can obtain authorized control-plane/admin access or assume a provisioning identity.

**Evidence:** real cloud conformance, runtime configuration inspection, capacity/noisy-neighbor report and provider limitations/runbook.

## CH3-02 — App-bound database provisioning and schema ownership

**Verification first:** actual runtime credential can use its app DB, but cannot connect to any other app/preview/platform DB, change protected ownership/RLS, assume a migration role or gain access by changing tenant session variables. Invariants: V01, V06. Boundaries: L2 real PostgreSQL + L4 managed deployment.

**Dependencies:** CH1-03/04. **Areas:** storage provisioning worker, `packages/storage`, database IaC.

**Implementation steps:**
1. Provision Cloud SQL PostgreSQL database/login role per immutable app/environment and separate non-login schema owner/migration identity. Revoke unwanted PUBLIC/CONNECT/default privileges and restrict future-object defaults.
2. Install trusted framework schema through migration job; do not expose migration credentials to app host boot or customer scripts. Resolve how current schema-ensure behavior operates with restricted runtime permissions.
3. Issue app-only connection binding; implement pooling with transaction-local org state reset and bounded connections/query/transaction timeouts. Bound pool × concurrent Cloud Run instances × retained releases, reserve scanner capacity, and test reconnect storms on cold scale-out; max-instance configuration alone is not a proven hard DB admission fence.
4. Add storage monitoring/admission and emergency containment. State clearly whether storage ceilings are soft monitored limits; no unsupported hard per-DB quota claim.
5. Implement recoverable provisioning state and cleanup; connection credential rotation can terminate old sessions if required. Keep backup/delete privileges out of runtime role.

**Acceptance cases:** `.a` exhaustive role/CONNECT/DDL/SET ROLE/BYPASSRLS probes using real runtime credential; `.b` cross-org transaction context does not leak across pooled connections; `.c` provisioning interrupted after database/role/schema creation resumes without duplicate ownership; `.d` excessive connections/long query does not consume unlimited shared capacity; `.e` supported framework boot/CRUD/outbox/workflow operations succeed as non-owner.

**Evidence:** raw SQL denial/positive reports, effective privilege inventory, managed-cluster tests and migration compatibility fixtures. Restore is CH7-03, not implied by provisioning.

## CH3-03 — Enforced egress, private ingress and policy templates

**Verification first:** from arbitrary app code, approved HTTPS sink and its own database work; all unauthorized destinations fail through raw sockets, IPv6, alternate DNS, redirects/rebinding and proxy bypass. Invariants: V05, V09. Boundary: L4 mandatory.

**Dependencies:** CH3-01/02, workspace policy contracts from CH2-03. **Areas:** network IaC, trusted egress/proxy service if needed, policy compiler.

**Implementation steps:**
1. Implement Cloud Run authenticated/private ingress and Direct VPC egress with all applicable outbound paths forced through approved firewall/proxy controls. Include DNS, metadata and IPv6 explicitly; provider-managed exceptions must have no useful unintended authority. Validate Cloud Tasks/Scheduler→trusted service paths without opening app ingress broadly.
2. Restrict database destinations by binding and app ingress to trusted gateway/authorized event transport only. A VPC/subnet being private does not make all peers trusted.
3. Resolve/validate destination policies, redirects and certificate/host matching; restrict link-local/private targets except provisioner-owned bindings. Provider-managed metadata identity must grant no unintended authority; document any network-level exception and prove its IAM boundary.
4. Add workspace baseline templates and app-narrowing requests with capability diff/approval. Policy updates are versioned and converge within a measured bound.
5. Add logs/metrics without sensitive URL query strings; fail closed on policy service/proxy outage and rate-limit DNS/network abuse.

**Acceptance cases:** `.a` full V05 network corpus under real runtime and separate build network; `.b` user-configured endpoint cannot reach internal gateway/admin APIs; `.c` stricter workspace rule overrides broader app request; `.d` partial rollout never temporarily grants a wider policy; `.e` egress-control failure blocks new outbound connections and is visible to operator/user.

**Evidence:** packet/flow-policy reports, provider route/security inspection, positive/negative endpoint receipts and approved policy-change tests. Domain rules are not represented as complete protection from exfiltration to an approved service.

## CH3-04 — Secret bindings, rotation and integration credentials

**Verification first:** app can receive only explicitly bound environment secrets; another app, preview, builder or browser cannot retrieve them. Rotation denies old credentials according to the integration's documented semantics and does not leak values. Invariants: V09, V14. Boundaries: L2/L3/L4.

**Dependencies:** CH2-02/03, CH3-01/03. **Areas:** secret API/store adapter, workload injection and audit.

**Implementation steps:**
1. Store values in managed encrypted secret storage; control plane persists opaque references and versions. Authorize secret administration separately from app execution; never return stored plaintext through ordinary read/list API.
2. Bind Secret Manager values by app/environment and immutable release/configuration reference; only approved bindings reach runtime. Customer service identity must not get broad lookup permissions. Cold starts and dormant old releases resolve pinned versions consistently; revoked versions fail explicitly rather than silently using latest.
3. Validate missing requirements before deploy confirmation; builds receive no production secrets. Add explicit restricted private-registry build credential scope only if supported/tested.
4. Implement rotate/revoke, rollout notification, affected-release analysis and stale-session/connection handling. Label rollback failures caused by revoked versions.
5. Redact known values and token patterns in platform logs, cap user logs and document that arbitrary app output cannot be perfectly scrubbed.

**Acceptance cases:** `.a` malicious manifest/ID substitution cannot bind another secret; `.b` preview/build/artifact/browser inspection finds no production canary; `.c` rotation during deployment yields a consistent selected binding and audit revision; `.d` secret-store outage fails startup safely without logging values; `.e` KMS/IAM denial tests prevent unauthorized decrypt/read and app cannot edit audit history.

**Evidence:** secret canary scan reports, provider permissions, rotation drill and documented distinction between direct runtime credentials and a future trusted connector broker.
