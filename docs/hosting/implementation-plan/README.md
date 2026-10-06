# Embody Cloud — executable implementation plan

## Start with verification

**Read [00-VERIFICATION.md](./00-VERIFICATION.md) first.** Verification means reproducible evidence that an observable requirement holds at the actual trust boundary, including denial, crash and recovery cases. A feature is not DONE merely because code exists or a happy-path demo works.

This directory turns the [hosting service plan](../PLAN.md) into **42 dependency-tracked work items**, each with verification first, implementation steps, acceptance cases and required evidence. It does not implement the hosting service or claim any tests have passed.

**Accepted direction:** [ADR 0006](../../adr/0006-cloud-run-stateless-hosting.md) selects Cloud Run first and requires all hosted apps to be stateless/sleep-capable. Read the [Cloud Run architecture](../CLOUD-RUN-ARCHITECTURE.md) for service mapping and request/event/schedule wake paths. Sleep is launch-critical, not a deferred optimization. [ADR 0007](../../adr/0007-gateway-scale-to-zero.md) adds gateway scale-to-zero capability: CH9-07 must prove correct cold HTTP/CLI/MCP behavior, not merely app sleep.

Read next:

1. [DECISIONS.md](./DECISIONS.md): selected engineering baseline, alternatives/consequences, open choices and approval gates.
2. [STATUS.md](./STATUS.md): task dependencies, ownership and completion evidence.
3. [TRACEABILITY.md](./TRACEABILITY.md): product requirements → tasks → invariant tests → gates.
4. The relevant phase document and the existing [framework implementation status](../../implementation-plan/STATUS.md).

## Plan structure

| Phase | Detailed plan | Work items | Deliverable |
| --- | --- | --- | --- |
| 1 | [Foundation](./01-foundation.md) | CH1-01…04 | Executable evidence harness, threat model, provider proof, contracts/platform state |
| 2 | [Identity/access](./02-identity-and-access.md) | CH2-01…05 | Login, sharing, policy/revocation, asymmetric tokens, agent/CLI auth |
| 3 | [Runtime/data](./03-runtime-and-data.md) | CH3-01…04 | VM-isolated execution, restricted DBs, enforced networking and secrets |
| 4 | [Source/build/artifacts](./04-source-build-and-artifacts.md) | CH4-01…04 | Safe upload/Git, isolated build, provenance and signed admission |
| 5 | [Deployment/gateway](./05-deployment-and-gateway.md) | CH5-01…05 | Fenced controller, readiness, promotion, rollback and gateway HA |
| 6 | [Product experience](./06-product-experience.md) | CH6-01…04 | Console, production CLI, browser apps and previews |
| 7 | [Durability/recovery/operations](./07-durability-recovery-and-operations.md) | CH7-01…05 | Versioned work/events, restore/export and audited operations |
| 8 | [Billing/assurance/launch](./08-billing-assurance-and-launch.md) | CH8-01…04 | Metering, budgets, independent assurance, support/legal and controlled launch |
| 9, parallel and launch-critical | [Sleep/stateless execution](./09-sleep-and-stateless-execution.md) | CH9-01…07 | Request-driven host, durable wake, idle catalog/MCP, gateway-zero/session recovery, version/restore fences and cost proof |

These phase numbers organize work; **task dependencies, not numeric order, determine scheduling**. CH9 was added without renumbering existing task IDs: CH9-01 begins after identity/storage foundations and precedes hosted startup CH5-02; CH9-02…04 follow during deployment work; CH9-07 follows CH9-03/04 and completes before CH9-06; CH9-05/06 finish before customer beta. Restoration/export/terms work also begins before full console completion. CH6-02's export command completes after CH7-04.

## Delivery sequence and gates

```text
Verification harness + threat model
             |
      Cloud Run qualification + contracts/state
             |
      +------+-----------------------+
      |                              |
 Identity/policy               Runtime/DB/network
      |                              |
      +-------- Source/build/signing-+
                       |
        Stateless host + durable deployment/gateway
                       |
          Durable wake / queue / scheduler / idle MCP
                       |
           +-----------+----------------+
           |                            |
      Console/CLI/views         Workflows/restore/export/ops
           +----------------------------+
                       |
              Customer private beta
                       |
           Billing/assurance/support/legal
                       |
               Controlled paid launch
```

- **G0 — Architecture ready:** CH1 evidence complete; Cloud Run qualified for the initial architecture, with region/configuration/budget decisions and harness ready.
- **G1 — Secure sleeping vertical slice:** CH2–CH5, CH9-01…04 and CH9-07 complete. Stateless app execution, durable wake, idle catalog/MCP and actual gateway-zero/cold-session recovery work on Cloud Run; synthetic data only until recovery/terms are ready.
- **G2 — Customer private beta:** CH6–CH7 and all CH9 complete, V19–V22 and required framework gates pass, and CH8-03's pre-customer-data legal/privacy/support approval recorded. Invitation-only, explicit support limits.
- **G3 — Paid launch:** all tasks other than gate-owner CH8-04 complete, including CH9; CH8-04 readiness cases and V01–V22 suites pass for exact candidate with commercial/operational sign-off. CH8-04 completes with sign-off before public rollout.
- **G4 — Optional follow-ons:** groups/SSO/SCIM, integration broker, more regions or attachments. Sleep/statelessness are already mandatory.

Gate details and evidence freshness are defined in [verification §7](./00-VERIFICATION.md#7-definition-of-done-and-release-gates). Product plan H0–H5 stages are broad delivery milestones; CH task IDs are implementation units and HC-01…14 are workstreams, not alternate completion trackers.

## Working protocol

1. Select an unblocked item in STATUS. Read its decisions, interfaces and required invariants. Obtain access only to authorized test infrastructure.
2. Claim the item with one accountable owner; record branch/session and dependencies. Split large items into testable PR slices without dropping parent acceptance cases.
3. Add the failing boundary test before behavior. Run it and confirm failure is for the intended reason. For research/legal/review tasks use the specified review checklist instead.
4. Implement the minimum vertical slice, run it green, then refactor. Use real PostgreSQL for SQL guarantees and real cloud tests for infrastructure boundaries.
5. Run task cases and affected existing framework/package regressions. Public interfaces/protocols change atomically with consumers, fixtures and documentation.
6. Record evidence commands, source/artifact/infra revisions, real environment, results and cleanup; never check secrets or raw customer data into git.
7. Move to IN_REVIEW with evidence links. An independent reviewer checks acceptance cases and decision compliance before DONE. A failing or unavailable required test means BLOCKED/IN_PROGRESS, not a waived green checkbox.
8. Re-run candidate-wide suites at gates. Historical unit results do not prove a later infrastructure revision safe.

**Completion rule:** all listed criteria are conjunctive. A task that has code but lacks real-provider proof is not DONE. Stubs are allowed only behind clearly marked test seams, never as silently permissive production defaults.

## Planned code layout

```text
apps/cloud-api/                 trusted control-plane HTTP API
apps/cloud-worker/              bounded Cloud Tasks/Scheduler-driven deploy/recovery/wake handlers
apps/cloud-console/             management browser UI
packages/cloud-contracts/       versioned cloud resources/APIs/policies
packages/cloud-provider/        GCP Cloud Run/Tasks/Scheduler/SQL/storage adapters
infra/                         reviewed cloud/IAM/network/database configuration
scripts/                       suite runners, evidence and cleanup checks
test/cloud/                    shared fixtures, boundary suites, fault scenarios
```

Extend existing `auth`, `gateway`, `host`, `storage`, `cli`, `testing`, scaffolder and required `genui` packages through public interfaces. The exact number of small internal packages may change, but core cannot depend on provider SDKs, cloud accounts or billing. Do not duplicate the framework execution engine in the SaaS control plane.

## Scope and existing decisions

- Existing workflow ADR 0003 and security/release/legal blockers remain binding. This plan creates evidence dependencies; it does not mark those tasks finished.
- Existing GenUI P14-07 gate remains binding unless explicitly superseded by an approved ADR. Optional-client scope reduction must not happen implicitly.
- Cloud Run first and mandatory app sleep/statelessness are ACCEPTED-USER decisions in ADR 0006; gateway scale-to-zero capability is accepted in ADR 0007. Optional warm gateway capacity cannot substitute for min-zero correctness verification. BASELINE implementation details still require verification; OPEN region/security/configuration/legal choices block dependent completion.
- Pricing, recovery targets and availability are internal hypotheses/targets until measured and approved. Never publish them merely because they appear here.
- Infrastructure limits and verification govern readiness. The previous 16–24-week estimate preceded mandatory sleep; re-estimate after CH1-03 and initial CH9-01/02 evidence rather than absorbing the new critical path invisibly.

## First actions

Start **CH1-01** and **CH1-02** in parallel. Run **CH1-03** as a budgeted Cloud Run qualification, not vendor selection, and **CH1-04** contracts/state work. After app-bound identity/storage, implement **CH9-01** and deploy Kanban with min-zero/no app polling, then **CH9-02/03** to wake Email/delayed work from zero with crash-gap recovery. Do not polish a mock console or substitute always-on replicas for this first proof.
