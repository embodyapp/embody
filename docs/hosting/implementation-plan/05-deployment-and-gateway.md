# 05 — Durable deployment, promotion and hosted gateway

## CH5-01 — Deployment admission and persisted reconciliation

**Verification first:** duplicate/reordered requests and controller crashes create one logical deployment; stale/cancelled workers cannot advance or promote it. Permission or policy changes after admission are rechecked before sensitive steps. Invariants: V03, V07, V08. Boundaries: L2/L3.

**Dependencies:** CH1-04, CH2-03, CH3-01–04, CH4-04. **Areas:** cloud API/worker, job repositories and provider orchestration.

**Implementation steps:**
1. Define versioned states and allowed transitions: accepted, validating, building, provisioning, starting, checking, promoting, active, draining, retired; failed/cancelled terminal paths before promotion. Persist reason/progress with stable user-safe codes.
2. Accept idempotent deployment request after checking source ownership, limits, config revision and capabilities; commit intent/job/audit together.
3. Implement leased reconciler steps with fencing token, durable results and bounded retry/backoff. Cloud Tasks invokes bounded controller steps; Cloud Scheduler-backed reconciliation resumes missing/stuck work, so the trusted controller also needs no post-response loop. Provider operations use deterministic ownership keys and discover/adopt on ambiguous responses.
4. Fence cancellation and revalidate authorization/config approval before provisioning and promotion. Concurrent deployment ordering is explicit, not queue-arrival accident.
5. Add source/build/provision/runtime retention and orphan reconciliation; terminal error does not delete previous healthy release or customer data.

**Acceptance cases:** `.a` same key+input returns same deployment, changed input conflicts; `.b` kill worker before/after each persisted step/provider response and restart safely; `.c` two workers race, old fence cannot write; `.d` cancel/revoke while worker paused prevents later promotion; `.e` provider timeout after successful create adopts one resource instead of duplicating.

**Evidence:** enumerated crash-point matrix, real DB concurrent tests and cloud resource counts after retries/cleanup. A queued API response alone is not successful deployment.

## CH5-02 — Secure candidate startup and readiness

**Verification first:** candidate receives only its approved bindings and cannot serve normal user traffic before all checks pass. Healthy HTTP alone is insufficient if manifest, token audience, DB schema or release identity mismatch. Invariants: V02, V06–V08, V14. Boundaries: L3/L4.

**Dependencies:** CH5-01, CH2-04, CH9-01. **Areas:** host lifecycle, trusted migration/startup jobs, provider adapter and registry.

**Implementation steps:**
1. Run approved framework migrations under isolated trusted migration identity; deny app startup access to that credential. Apply backward-compatible expansion before route changes.
2. Deploy immutable admitted image as a Cloud Run second-generation revision with selected config/secret versions, app-only DB, identity, enforced network policy, request-based billing and min instances zero. Hosted runtime mode must pass CH9-01; migrations remain outside cold boot.
3. Publish provisioner-owned release route/catalog to durable registry; compare a bounded authenticated startup probe's runtime manifest with the admitted manifest. No recurring app registration/heartbeat requirement or external health probe loop keeps it warm.
4. Check authenticated read-only readiness fixture including DB/schema and action catalog, without running arbitrary side-effecting custom actions as “health.”
5. Set deadlines and sanitized diagnostics; keep candidate unroutable and roll back provisional non-data resources if checks fail.

**Acceptance cases:** `.a` correct candidate passes authenticated fixture; `.b` wrong manifest/audience/DB binding/protocol fails readiness; `.c` migration interruption or incompatible schema prevents promotion without losing active service; `.d` unhealthy boot cannot register another endpoint; `.e` malicious health response cannot choose active release or trigger custom effects.

**Evidence:** candidate lifecycle test reports and real cloud inspection of deployed bindings. Any unavoidable startup migrations must be reconciled with CH3-02's non-owner runtime design.

## CH5-03 — Atomic promotion, draining and release-aware routing

**Verification first:** concurrent promotions produce one committed active generation; every request uses a coherent release/catalog/view generation. Failed or cancelled candidate never displaces the healthy route. Invariants: V03, V07, V08, V13. Boundaries: L2/L3/L4.

**Dependencies:** CH5-02; durable routing primitives CH1-04, full HA proof CH5-05. **Areas:** route store, gateway routing/caches, host drain protocol.

**Implementation steps:**
1. Recheck artifact admission, grant/capability policy, deployer authority and expected active generation in a promotion transaction.
2. Publish new routing generation through durable state/invalidation. Gateways use bounded caches and reject inconsistent/missing release metadata.
3. Route new work to new release; drain in-flight requests/streams with documented deadline. Define retry/idempotency behavior rather than transparently replaying non-idempotent mutations.
4. Distinguish HTTP drain from durable-work/release retention: finish/checkpoint bounded active invocations; retain old artifacts and authenticated routes needed by CH7-01/CH9-05, not continuously running workers. Old idle revisions remain min-zero and wake only for their eligible work.
5. Persist promotion audit and maintain reversible previous-route reference. Test termination mid-drain and gateway restart during change.

**Acceptance cases:** `.a` two valid promotions with same expected generation have exactly one winner; `.b` kill controller before/after route commit and gateways converge without split authority; `.c` denied capability/revoked deployer at final check leaves old route unchanged; `.d` stale view/tool requests fail or remain correctly pinned rather than calling unintended targets; `.e` drain rejects new admissions while bounded active requests finish/cancel.

**Evidence:** generation/trace logs, durable route queries, effect receipt ledger and cloud rolling promotion test. Temporary old-generation serving within the documented propagation window is measured, not called instantaneous global atomicity.

## CH5-04 — Compatibility checks and safe rollback

**Verification first:** compatible rollback changes code routing without losing data; incompatible schemas/workflow definitions or revoked secret references block unsafe rollback with an actionable reason. Invariants: V07, V10, V11. Boundaries: L2/L3/L4 smoke.

**Dependencies:** CH5-03. **Areas:** manifest/config diff engine, deployment API, rollback validation.

**Implementation steps:**
1. Define compatibility contract covering action/schema changes, persisted entity validation, active workflow versions, framework storage versions, secrets and egress permissions.
2. Generate capability/compatibility diff from old/new release. New sensitive grants need explicit approval; do not automatically add broad wildcard grants.
3. Implement rollback as a new authorized promotion referencing an existing admitted release and compatible current state; no destructive down migration.
4. Fence stale runtime/schema writers where necessary and report when restoration/manual migration is required. Expose that route rollback does not undo external effects.
5. Retain artifacts/config metadata for declared rollback window; GC checks active workflows and restoration references.

**Acceptance cases:** `.a` v1→v2-compatible→v1 retains rows and expected behavior; `.b` v3-incompatible blocks unsafe reverse promotion before route mutation; `.c` missing/revoked secret or purged digest yields stable blocked reason; `.d` old workflow definition still available or rollback explicitly blocked; `.e` new action/egress request cannot acquire permission via rollback path.

**Evidence:** versioned compatibility fixtures, durable data checksums, rollout/rollback timings and explicit unsupported-change list. General arbitrary-code semantic compatibility cannot be proved automatically; risky changes need owner review.

## CH5-05 — Durable gateway replicas, quotas and MCP sessions

**Verification first:** replacing either of two gateways preserves routing/authorization and does not double per-workspace limits; reconnection cannot change principal or silently repeat mutation. Invariants: V01, V03, V13, V14. Boundaries: L3/L4.

**Dependencies:** CH2-03–05, CH5-03. **Areas:** `packages/gateway`, durable registry adapter, quota/session service and edge configuration.

**Implementation steps:**
1. Close HD15 limiter/session decision with measured concurrency and failover tests. Replace process-local registry/audit/limiter collaborators for hosted mode.
2. Persist deployment-owned endpoint/catalog and release generation independently of live replicas; CH9-04 adds sleeping status and full no-heartbeat proof. Endpoint ownership is authoritative platform state, not a tenant registration string or runtime heartbeat TTL.
3. Implement atomic shared quotas by workspace/app/actor and safe failure behavior; account for agents opening many streaming connections.
4. Terminate MCP sessions in trusted gateway, not app runtimes; choose durable/reconstructable session and reconnect semantics. Bind identity/authorization revision and validate every call/resource; affinity cannot be required for correctness. CH9-04 proves idle sessions/catalog discovery do not wake or pin app instances. Do not promise transparent failover if clients must reconnect.
5. Configure edge TLS, trusted proxy headers, streaming idle/body/connection limits and request IDs; reject direct runtime ingress and spoofed identity headers.
6. Keep console outage separate from routing, but fail authorization closed when trusted state freshness expires.

**Acceptance cases:** `.a` kill gateway during HTTP/SSE/MCP; supported client reconnects without scope change or duplicate effect; `.b` distribute concurrent requests across replicas and exact quota is enforced; `.c` spoof forwarding headers and stale registration cannot bypass ownership; `.d` drop invalidation/store connectivity and meet V03 fail-closed bound; `.e` restart all gateways reconstructs valid routing/catalog from durable deployment state even when all app instances are zero; no process-local registration memory is required.

**Evidence:** cloud HA/restart report, session protocol fixtures, distributed limit counts and documented outage behavior. G1 includes these proofs, not simply two processes running. CH9-07 additionally requires actual gateway zero-capacity/cold-request proof, independent scheduled work and tested MCP idle/reinitialization behavior. Passing replica failover alone does not satisfy gateway scale-to-zero.
