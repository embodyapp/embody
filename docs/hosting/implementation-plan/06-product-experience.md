# 06 — One-click deployment, sharing and end-user experience

## CH6-01 — Console deployment and access management

**Verification first:** a new owner can deploy a supported reference app and invite a teammate without cloud configuration; viewer/member/billing roles cannot reach privileged operations by manipulating the UI or calling APIs directly. Invariants: V01, V03, V12, V17. Boundaries: L3 browser + L5 usability.

**Dependencies:** CH2-01–03, CH5-01–05. **Areas:** `apps/cloud-console`, cloud API contracts.

**Implementation steps:**
1. Build workspace/app dashboard, creation/import, deployment preflight and single confirmation with private visibility, region, source version, capabilities and estimated limit/cost.
2. Render missing secret/integration requirements as a checklist. Deploy uses async API/status with refresh/reconnect recovery; no second submission on page reload.
3. Add app page with stable URL, release/status (including healthy deployed/idle vs failed/paused), Share and Connect agent entry points, deploy history, logs links and rollback actions. Display cold-start progress and operation IDs honestly; console polling reads platform state and does not ping/wake apps.
4. Add invitations, explicit app grants, expiry/revoke, agent credential lifecycle and owner-transfer UX. Show deployer privilege implications; do not suggest hidden data protection from app code owner.
5. Provide accessible keyboard/navigation/form/error states, safe markdown/text and CSRF protections. UI hiding never substitutes for backend authorization.

**Acceptance cases:** `.a` Playwright account→workspace→deploy→ready journey using built services; `.b` missing credentials produce no doomed deploy; `.c` refresh/network reconnect preserves one deployment ID; `.d` role matrix direct API and browser tests agree; `.e` novice design partner can share in <30 seconds after setup, with measured exceptions recorded.

**Evidence:** browser/accessibility tests and de-identified timed usability session; no claim that rendering a mock dashboard proves deployment usability.

## CH6-02 — Production CLI, templates and agent connection journey

**Verification first:** freshly packed/installed CLI—not source aliases—can log in, deploy source, inspect status/logs, share, roll back and export with predictable exit codes and no secret leakage. Supported MCP client uses the same access grants. Invariants: V03, V17. Boundaries: L3 + supported-client L5 smoke.

**Dependencies:** CH2-05, CH4-01, CH5-04/05; export command completes with CH7-04. **Areas:** CLI, scaffolder, templates, docs.

**Implementation steps:**
1. Add cloud command namespace/flags without shadowing dynamic app commands; define JSON output, stderr progress, stable exit codes, cancellation and timeout semantics.
2. Reuse console APIs/idempotency; preflight archive/runtime requirements and show explicit production capability confirmation. Noninteractive mode requires explicit approvals, not an implicit broad yes.
3. Add login/profile selection, deploy/status/logs/share/rollback/export and agent connection instructions. Safe credential storage has restrictive permissions and documented headless options.
4. Add Deploy-to-Embody templates for Kanban/Email with pinned source, safe recording Email default and the stateless request-driven host contract. Hosted preflight rejects local durable SQLite/files, required daemon loops and unsupported long steps with migration guidance; runtime conformance follows CH9-06.
5. Run clean consumer install/local development/self-hosted compatibility tests and supported real MCP client smoke.

**Acceptance cases:** `.a` spawned CLI in empty temporary HOME completes deploy and gives authenticated URL; `.b` nonzero exits for denial/failed build/incompatible rollback, useful structured JSON; `.c` disconnect/retry does not duplicate deployment; `.d` stdout/stderr/config permission checks prevent credential disclosure; `.e` local `embody dev` works without cloud login and existing CLI dynamic commands still work; `.f` export/download command works after CH7-04.

**Evidence:** packed artifact tests and actual client matrix. Task stays IN_PROGRESS until export integration passes; other command slices may merge earlier.

## CH6-03 — Secure hosted browser app surface

**Verification first:** a teammate can view and mutate permitted reference-app data in a real browser; hostile static view/data cannot access console identity, leak another app's results, invoke undeclared actions or poison caches. Invariants: V03, V12, V17. Boundary: L3 built browser assets.

**Dependencies:** CH6-01, CH5-05, CH1-02 GenUI gate resolution and required P14 deliverables. **Areas:** hosted app shell, GenUI renderer/host integration, edge asset/data rules.

**Implementation steps:**
1. Implement selected browser experience under approved GenUI scope. Preserve fallback text/action data; never reuse public development inspector as production UI.
2. Serve app-controlled executable views from a separate site with no console cookies; pin assets to immutable release/manifest. Authenticate private resources and separate static assets from user data.
3. Deliver validated props through an authorized channel; bridge messages validate origin, source, schema, request ID, app/release and allowed action. No management tokens in iframe/app JavaScript. Long-operation progress uses durable IDs/cursors through the gateway; browser refresh/reconnect does not depend on a surviving app process.
4. Apply CSP, sandbox, frame/device/URL/network restrictions and cache rules; default private responses to non-shared caching. Add same-app normal action dispatch and revocation for existing sessions.
5. Implement accessible Kanban/Email flows with error/progress/approval states supported by actual app actions. No model-generated executable UI.

**Acceptance cases:** `.a` allowed viewer/operator behaviors render correct data and enforce mutation rights; `.b` hostile markup/URLs/postMessage cannot invoke privileged/other-app action or read cookie; `.c` W1/W2 same URL pattern through CDN/cache never shares data; `.d` stale view release cannot call changed action under wrong schema; `.e` revoked browser session stops new data/actions/output within V03 bound; `.f` keyboard/accessibility and plain-text fallback pass.

**Evidence:** renderer/host contract tests from packed assets, XSS/cache corpus and required framework P14 release evidence or superseding ADR. Screenshots alone are insufficient.

## CH6-04 — Preview environments and capability promotion review

**Verification first:** preview remains private and isolated from production, expires without deleting production state, and cannot auto-promote new capabilities or fork-supplied secrets. Invariants: V03, V07, V09. Boundaries: L3/L4.

**Dependencies:** CH4-02, CH5-04, CH6-01, CH3-04. **Areas:** environment provisioning/reconciler, Git callbacks, preview/promotion UI.

**Implementation steps:**
1. Provision preview using same min-zero stateless Cloud Run runtime/DB boundary as production but new identities, secret bindings, grants and URL; default to no external side effects and empty/synthetic data. Sleeping preview is not expired; TTL cleanup fences pending wake tasks and environment epoch independently of replica count.
2. Define TTL, maximum concurrent previews, resource budgets, manual extension and repository-event cleanup policy. No production data cloning in MVP.
3. Show release diff for schemas/actions/workflows/egress/secrets; require current authorized approval for capability expansion and promotion.
4. Treat production promotion as deploying admitted artifact with production bindings, not reusing preview database or credentials. Revalidate approval if artifact/config/policy changes.
5. Garbage collect expired previews only after ownership checks and retention rules; stale cleanup job is fenced against recreation with a new generation.

**Acceptance cases:** `.a` canary scan proves no production secrets/data in preview; `.b` fork PR cannot invoke privileged build/promote path; `.c` private preview URL denies ungranted user; `.d` expired preview resources disappear and production checksums/routes remain unchanged; `.e` changed artifact/input after approval requires new consent; `.f` duplicate/delete-after-recreate webhook does not destroy current environment.

**Evidence:** cloud preview lifecycle/inventory tests, capability diff fixtures and real-browser review flow.
