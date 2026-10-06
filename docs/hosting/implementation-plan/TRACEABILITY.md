# Hosting requirement and verification traceability

Every launch requirement below is traced to a task and invariant. [Verification](./00-VERIFICATION.md) defines test boundaries and evidence; phase files define concrete cases. This is a coverage plan, **not a passing-test report**.

## Product requirement coverage

| Requirement from hosting plan | Implementing tasks | Verification | Gate |
| --- | --- | --- | --- |
| Private workspace; deploy/share rather than infrastructure administration | CH2-01/02, CH6-01/02, CH8-04 | V01, V03, V17; first-deploy/share journey | G2/G3 |
| One confirmation after account/integration prerequisites | CH3-04, CH4-01/02, CH5-01, CH6-01/02 | V07, V17; missing-input preflight and deploy timings | G2 |
| Separate platform roles, app roles and scoped agent identities | CH2-01…05 | V01–V03; role matrix across HTTP/browser/CLI/MCP | G1/G2 |
| Revocation across caches, streams, delayed work | CH2-03, CH5-05, CH6-03, CH7-01/02 | V03; maximum 30-second timed checks with lost invalidation | G1/G2 |
| Hostile code cannot mint platform identities | CH2-04, CH4-04 | V02, V08; algorithm/audience negatives and real IAM | G1 |
| Isolated build with safe source and no production secrets | CH4-01…04, CH3-01/03/04 | V04, V08, V14; hostile archives/install/config and cloud probes | G1 |
| Isolated execution and noisy-neighbor containment | CH1-03, CH3-01/03, CH8-02 | V05; raw Node/network/resource probes and provider review | G0/G1/G3 |
| App/environment database security boundary | CH3-02 | V06; actual login-role SQL/connection probes | G1 |
| Approved outbound integrations and workspace environment baseline | CH3-03/04, CH5-04, CH6-04 | V05, V09, V14; restrictive-policy intersection and bypass attempts | G1/G2 |
| Immutable artifact, SBOM/provenance, digest-bound deployment | CH4-03/04, CH5-02 | V04, V08; admission mutation/quarantine/signing tests | G1 |
| Recoverable deployment controller and atomic route generation | CH5-01…03 | V07; crash points, duplicate requests, stale fences, concurrent promotion | G1 |
| Safe rollback without pretending to undo data/effects | CH5-04, CH7-01/03 | V07, V10, V11; compatible/incompatible version fixtures | G1/G2 |
| Private Git previews, no production credentials, cleanup | CH4-02, CH6-04 | V09; hostile fork/reordered webhook/expiry tests | G2 |
| Persistent gateway routing, distributed limits and session policy | CH5-05 | V03, V13; two-replica failure/quota/reconnect tests | G1 |
| Browser apps, accessibility, immutable views, fallback | CH6-03; required P14 | V12, V17; real browser/XSS/cache/action/fallback tests | G2 |
| Existing workflow crash/cancel/claim-role gates | CH7-01; P11 | V06, V10; hosted and framework crash matrices | G2 |
| Old workflow versions retained during deployment | CH5-03/04, CH7-01, CH8-01 | V07, V10, V15; version-pinned work/GC/cost tests | G2/G3 |
| Authorized cross-app actions/events rather than shared DB trust | CH2-03/04, CH3-03, CH7-02 | V01–V03, V10; producer/receiver/audience/queue revocation tests | G2 |
| Real backup/PITR/per-app restore, fenced cutover and replay controls | CH7-03 | V11; timed real-provider restore with neighbor receipts | G2 |
| Export/portability/deletion/account and ownership recovery | CH2-02, CH7-04, CH8-01/03 | V16; import round trip, identity/lifecycle/grace tests | G2/G3 |
| Logs/traces/durable audit and safe support access | CH1-04, CH7-05 | V14, V18; sink outage, injection/redaction and access-expiry tests | G2 |
| Key/secret rotation, isolation and incident response | CH2-04, CH3-04, CH7-05, CH8-03 | V02, V14, V18; actual timed operator drills | G2/G3 |
| Workspace pricing, authoritative usage, budgets and billing | CH8-01 | V15, V16; ledger/property/provider/webhook/race tests | G3 |
| Measured availability/latency/recovery rather than unproved promises | CH7-03/05, CH8-02/03 | V11, V13, V18; defined measurement protocols and approved claim matrix | G3 |
| Customer privacy/legal/support/abuse and billing terms | CH1-02, CH8-01/03/04 | V16, V18; counsel/owner review, support and signup-pause drills | Before customer data / G3 |
| Sustainable unit economics and retained customer value | CH1-03, CH8-01/04 | V15, V18; cost reconciliation and design-partner cohort evidence | G3 |
| Local and self-hosted compatibility | CH1-04, CH2-04, CH6-02, CH7-04, CH8-02, CH9-01 | V16, V17; packed consumers, local no-login, export/import | G1/G3 |
| Cloud Run first, request-based min-zero runtime | CH1-03, CH3-01, CH9-06 | ADR 0006; V05, V19, V21; actual provider configuration/instance evidence | G0/G1/G2 |
| Every hosted app stateless across replacement/concurrency | CH9-01/06, CH6-02 | V19; wiped scratch, no boot effects, no detached work, incompatible fixture rejection | G1/G2 |
| Events/schedules/retries wake from zero without user traffic | CH9-02/03 | V20; real Tasks/Scheduler, independent due-work sweep, source/intent/queue/ACK crash matrix | G1/G2 |
| Discovery/idle MCP do not pin app instances | CH9-04 | V13, V19, V21; idle client with zero app requests/instances | G1/G2 |
| Gateway itself can reach zero and safely recover | CH9-07, CH9-06 | V22; actual zero, external cold HTTP/CLI/MCP, quota/audit/revocation persistence and independent scheduled work | G1/G2/G3 |
| MCP session/idle-stream behavior permits gateway sleep where supported | CH9-07 | V13, V17, V22; stateless/reinitialize/resume client matrix, no blind mutation replay, idle reconnect-loop and active-work controls | G1/G2 |
| Sleeping old release and stale restore/delete tasks | CH9-05, CH7-01/03 | V10, V11, V20; revision pinning, epoch fencing, disabled restored effects | G2 |
| Queue/scanner/gateway costs and cold DB capacity | CH9-06, CH3-02, CH8-01/02 | V15, V21; actual instance-time, sweep lag, fair backlog and connection budgets | G2/G3 |

## Required proof scenarios from product plan §12

| Scenario | Primary cases |
| --- | --- |
| 1. New account → deploy → invite → scoped call → audit | CH6-01.a/d, CH6-02.a, CH2-05.b, CH7-05.a |
| 2. W1 cannot enumerate/invoke/restore/export W2 | CH1-04.e, CH2-03.e, CH7-03.b, CH7-04.b |
| 3. Malicious app cannot access neighbor data/secrets/network | CH3-01.b/e, CH3-02.a, CH3-03.a/b, CH3-04.a/b |
| 4. Host cannot forge identities/events/grants | CH2-04.a/b/e, CH7-02.a/d |
| 5. Revocation across caches/sessions/queues | CH2-03.c/d, CH2-05.c, CH5-05.d, CH6-03.e, CH7-02.d |
| 6. Install scripts/archive attacks contained | CH4-01.a, CH4-03.a/b/d |
| 7. Bad/concurrent deploy preserves healthy release | CH5-01.b/c/d/e, CH5-02.c, CH5-03.a/b/c |
| 8. Process/DB failure preserves durable work | CH5-05.a/e, CH7-01.a/b, CH8-02.c |
| 9. Restore isolation and external replay decision | CH7-03.a/b/d/e |
| 10. Preview/fork isolation | CH4-02.d, CH6-04.a/b/c/d |
| 11. XSS/private-cache isolation | CH6-03.b/c/d/e |
| 12. Resource flood/agent loop limits | CH3-01.c, CH5-05.b, CH7-05.d, CH8-01.c/d |
| 13. Rotation/recovery/export/ownership procedures | CH2-02.b, CH2-04.c, CH3-04.c, CH7-04.a/d, CH8-03.a/c |
| 14. Correct work after sleeping/waking | MANDATORY: CH9-01.a/c/e, CH9-02.a/b/e/f, CH9-03.a/b/e/f, CH9-04.a/b/c, CH9-05.a/c/e, CH9-06.a/b/d/f |
| 15. Gateway zero, cold sessions, security state and background independence | MANDATORY: CH9-07.a/b/c/d/e/f/g/h |

## Workstream correspondence

| Product plan workstream | Detailed tasks |
| --- | --- |
| HC-01 Threat model/provider | CH1-02/03 |
| HC-02 Resource/control-plane state | CH1-01/04 |
| HC-03 Hosted auth/grants | CH2-01/02/03/05 |
| HC-04 Identity/registration | CH2-04 |
| HC-05 Builds/artifacts | CH4-01…04 |
| HC-06 DB/restore | CH3-02, CH7-03/04 |
| HC-07 Deployment/runtime | CH3-01/03/04, CH5-01…04 |
| HC-08 Console/CLI/Git | CH4-02, CH6-01/02/04 |
| HC-09 Durable gateway/sessions | CH5-05, CH9-04/07 |
| HC-10 Events/workflows | CH7-01/02 |
| HC-11 Hosted browser | CH6-03 |
| HC-12 Metering/telemetry/billing | CH7-05, CH8-01 |
| HC-13 Assurance/terms/launch | CH8-02/03/04 |
| HC-14 Stateless runtime and durable scale-to-zero | CH9-01…07; CH3-01/02, CH5-02, CH7-01/03 integrations |

## Coverage rules for future edits

- Every new externally visible feature adds/updates a row, task, invariant case and release gate.
- Every negative security case has an allowed-path control and validates absence of forbidden state/effect, not just an error message.
- Each critical boundary has real-environment evidence; local unit tests cannot satisfy a cloud-only invariant.
- Case IDs are stable. Renaming/deleting a case requires updating this file and migrating evidence mappings.
- A deliberate scope cut is documented in DECISIONS and public claims, not represented as a skipped passing test.
- Code implementing CH1-01 must machine-check task/case references and require full V01–V22 coverage. Until then, validate links/references during documentation review; this file alone is not an executable checker.
