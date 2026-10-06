# Hosting implementation status

**State: planning only. Cloud Run first and mandatory stateless/sleep-capable apps are accepted by user instruction (ADR 0006); no implementation or verification is claimed.** Gateway scale-to-zero capability is additionally accepted in ADR 0007. There are now 42 work items; CH9 is launch-critical, not a later optimization. Existing framework completion states live in their own [tracker](../../implementation-plan/STATUS.md); do not copy DONE labels without checking the hosting requirements.

## State and evidence rules

- `NOT_STARTED`: unclaimed; runnable only when listed dependencies/decision gates are satisfied.
- `IN_PROGRESS`: one accountable owner has claimed it and is executing testable slices.
- `BLOCKED`: cannot progress; record exact decision, dependency, environment or failing verification.
- `IN_REVIEW`: implementation and required evidence ready; independent review pending.
- `DONE`: all acceptance cases and required boundary tests passed and reviewer recorded.

State transitions require a dated activity entry. Evidence field contains a run ID/report link and exact command summary, not just “tests pass.” Every evidence record follows [00-VERIFICATION.md](./00-VERIFICATION.md). A later relevant change requires a gate rerun even if task history remains DONE.

Dependencies name completed tasks unless an entry explicitly permits parallel slices. External framework gates/decisions are additional requirements, not optional notes.

## Work items

| ID | Work item | State | Owner | Dependencies / completion gates | Evidence |
| --- | --- | --- | --- | --- | --- |
| CH1-01 | Verification runners, fixtures, evidence and protected CI | NOT_STARTED | — | None | — |
| CH1-02 | Threat model, scope/decision review, framework dependency mapping | NOT_STARTED | — | Can start immediately; CH1-01 evidence format before DONE; GenUI scope decision | — |
| CH1-03 | Selected Cloud Run security/cost/scale-to-zero qualification | NOT_STARTED | — | CH1-01; reviewed CH1-02 trust boundaries; region/test budget | — |
| CH1-04 | Service boundaries, resource contracts and durable platform state | NOT_STARTED | — | CH1-01/02; provider wiring after CH1-03 | — |
| CH2-01 | Hosted login, private workspace and secure sessions | NOT_STARTED | — | CH1-02/04; login provider decision | — |
| CH2-02 | Invitations, grants, ownership transfer and audit | NOT_STARTED | — | CH2-01 | — |
| CH2-03 | Unified policy and bounded revocation | NOT_STARTED | — | CH2-02 | — |
| CH2-04 | Asymmetric downstream identity and owned registration | NOT_STARTED | — | CH1-03/04, CH2-03; signer decision | — |
| CH2-05 | CLI/device and scoped MCP/agent authentication | NOT_STARTED | — | CH2-01…04 | — |
| CH3-01 | Isolated runtime provider and enforced resource caps | NOT_STARTED | — | CH1-03/04 | — |
| CH3-02 | App database provisioning, restricted roles and migrations | NOT_STARTED | — | CH1-03/04 | — |
| CH3-03 | Enforced ingress/egress and workspace network policy | NOT_STARTED | — | CH3-01/02, CH2-03 policy contracts | — |
| CH3-04 | Scoped secrets, bindings and rotation | NOT_STARTED | — | CH2-02/03, CH3-01/03 | — |
| CH4-01 | Safe source upload and CLI archive | NOT_STARTED | — | CH1-04, CH2-03 | — |
| CH4-02 | Git integration, immutable source and webhook trust | NOT_STARTED | — | CH2-03, CH4-01 | — |
| CH4-03 | Isolated build and untrusted manifest extraction | NOT_STARTED | — | CH3-01/03, CH4-01; CH4-02 for Git | — |
| CH4-04 | Signed artifact admission, SBOM and retention | NOT_STARTED | — | CH4-03, CH2-04 | — |
| CH5-01 | Idempotent deployment API and fenced reconciler | NOT_STARTED | — | CH1-04, CH2-03, CH3-01…04, CH4-04 | — |
| CH5-02 | Secure candidate startup, migrations and readiness | NOT_STARTED | — | CH5-01, CH2-04, CH9-01 stateless mode | — |
| CH5-03 | Atomic route promotion and draining | NOT_STARTED | — | CH5-02; HA recheck with CH5-05 | — |
| CH5-04 | Capability/compatibility diffs and safe rollback | NOT_STARTED | — | CH5-03 | — |
| CH5-05 | Durable gateway, shared quotas and MCP failover | NOT_STARTED | — | CH2-03…05, CH5-03; HD15 decision | — |
| CH6-01 | Console deploy/share/access journey | NOT_STARTED | — | CH2-01…03, CH5-01…05 | — |
| CH6-02 | Packed production CLI, templates and agent journey | NOT_STARTED | — | CH2-05, CH4-01, CH5-04/05; export slice CH7-04 | — |
| CH6-03 | Secure hosted browser app experience | NOT_STARTED | — | CH6-01, CH5-05; CH1-02 GenUI decision and required P14 gates | — |
| CH6-04 | Private preview lifecycle and reviewed promotion | NOT_STARTED | — | CH4-02, CH5-04, CH6-01, CH3-04 | — |
| CH7-01 | Hosted workflow crash/version/authorization correctness | NOT_STARTED | — | CH2-03, CH3-02, CH5-03/04, CH9-01…03; P11-02/03 verified | — |
| CH7-02 | Authorized cross-app events and retry controls | NOT_STARTED | — | CH2-04, CH3-03, CH5-05, CH7-01; event transport decision | — |
| CH7-03 | Measured PITR and isolated fenced restore | NOT_STARTED | — | CH3-02/04, CH5-03/04; CH7-01/02 replay tests | — |
| CH7-04 | Export/import, account recovery and deletion lifecycle | NOT_STARTED | — | CH2-02/03, CH3-02/04, CH5-01; later billing integration CH8-01 | — |
| CH7-05 | Durable audit, diagnostics, alerts and operator controls | NOT_STARTED | — | CH1-04, CH5-05; CH7-01…04 integrations before DONE | — |
| CH8-01 | Metering, billing, budgets and lifecycle integration | NOT_STARTED | — | CH5-01/05, CH7-04/05, CH9-06 initial cost proof; price/limit approvals | — |
| CH8-02 | Candidate performance/resilience and independent security review | NOT_STARTED | — | CH1…CH7 and CH9 complete, CH8-01 path ready | — |
| CH8-03 | Legal/privacy, support staffing and operating approvals | NOT_STARTED | — | Starts after CH1-02; staged approval for customer data after CH7; final CH8-01/02; P13 | — |
| CH8-04 | Design partners, go/no-go and controlled paid rollout | NOT_STARTED | — | Pilot after G2/pre-data approval; paid after CH8-01…03, CH9 and G3 evidence | — |
| CH9-01 | Stateless request-driven host and bounded worker APIs | NOT_STARTED | — | CH1-04, CH2-04, CH3-02; precedes CH5-02 | — |
| CH9-02 | Transactional due metadata, narrow scanner and wake intents | NOT_STARTED | — | CH1-04, CH3-02, CH9-01 | — |
| CH9-03 | Cloud Tasks/Scheduler and authenticated bounded dispatch | NOT_STARTED | — | CH9-01/02, CH2-03/04, CH3-03, CH5-02 | — |
| CH9-04 | Sleeping catalog and gateway-owned MCP/progress sessions | NOT_STARTED | — | CH2-03/05, CH5-05, CH9-01 | — |
| CH9-05 | Dormant release wake, restore epochs and stale-task fences | NOT_STARTED | — | CH9-03/04, CH5-04, CH7-01…03 | — |
| CH9-06 | Real sleep/stateless conformance and measured cost | NOT_STARTED | — | CH9-01…05, CH9-07, CH6-02…04, CH7-05; billing correlation follows in CH8 | — |
| CH9-07 | Gateway min-zero, cold session recovery and independent background work | NOT_STARTED | — | CH5-05, CH9-03/04; completes before CH9-06 | — |

## Decision and external dependency closure

| Dependency | State | Owner | Required evidence |
| --- | --- | --- | --- |
| HD01–HD22 implementation baseline review | OPEN | — | CH1-02 reviews detailed selections/consequences; accepted direction below is not reopened |
| Cloud Run first (HD04) | ACCEPTED-USER | User | Explicit instruction; ADR 0006; implementation qualification remains CH1-03 |
| Stateless/sleep mandatory (HD13/HD20) | ACCEPTED-USER | User | Explicit instruction; ADR 0006; no passing V19–V21 evidence yet |
| Gateway zero capability (HD22) | ACCEPTED-USER | User | Explicit instruction; ADR 0007; CH9-07/V22 not implemented or verified |
| Region/network/IAM/budget configuration | OPEN | — | CH1-03 real GCP security/cost report and approval |
| Durable wake/scanner/queue limits (HD21) | BASELINE_TO_VERIFY | — | CH9-02/03 transaction-gap, role, lag/connection and provider-limit proof |
| Login provider/recovery/MFA (HD06) | OPEN | — | CH2-01 selected configuration, threat review and tests |
| Hosted signing algorithm/service (HD05) | OPEN | — | CH2-04 library/provider support, custody and rotation proof |
| Limiter/session consistency (HD15) | OPEN | — | CH5-05 failover/quota/session decision and tests |
| Hosted event transport (HD10) | OPEN | — | CH7-02 identity/fan-out/retry ownership proof |
| GenUI gate scope (HD12) | OPEN | — | Existing P14-07 evidence or approved superseding ADR |
| Workflow baseline P11 | EXTERNAL_GATE | — | Current framework crash/cancellation/role/version evidence linked by CH7-01 |
| Framework P12 hardening/release | EXTERNAL_GATE | — | Packaging, fuzz/soak/restore/security evidence; CH8-02 checks applicability |
| Framework P13 / customer legal | EXTERNAL_GATE | — | Applicable rightsholder/license/customer-term approval in CH8-03 |
| Retention/recovery/support promises | OPEN | — | CH7-03 measurements and CH8-03 approval |
| Pricing/quotas/trial/grace | OPEN | — | CH8-01 cost/billing tests and commercial approval |

## Gate ledger

| Gate | State | Evidence / approvers |
| --- | --- | --- |
| G0 architecture/provider ready | NOT_EVALUATED | — |
| G1 secure sleeping synthetic-data vertical slice | NOT_EVALUATED | CH2–CH5 + CH9-01…04 + CH9-07 |
| Pre-customer-data terms/privacy approval | NOT_EVALUATED | — |
| G2 customer private beta | NOT_EVALUATED | Includes all CH9 and V19–V22; no always-on correctness workaround |
| G3 paid launch | NOT_EVALUATED | All 42 task criteria and V01–V22 candidate evidence |
| G4 optional follow-ons | OUT_OF_SCOPE | New decisions/tasks required |

## Activity log

- Initial planning: defined verification, decisions, 35 tasks and gates. No implementation, cloud provisioning, product test execution or task completion claimed.
- User-directed revision: accepted Cloud Run first and mandatory stateless/sleep-capable apps in ADR 0006; superseded AWS/Fargate-first and deferred sleep. Added CH9-01…06, V19–V21 and updated launch dependencies (41 total tasks). No runtime or cloud tests executed by this documentation revision.
- User-directed extension: accepted gateway scale-to-zero capability in ADR 0007/HD22; added CH9-07 and V22, cold-session/idle-connection tests, optional warm-capacity distinction and updated dependencies (42 tasks). Documentation only; no gateway/cloud tests executed.
- Append future entries as: `YYYY-MM-DD owner — task, state change, exact commands/run ID, result, review or blocker`.
