# Phase 10 — Reference applications and distributed proof

**Spec:** 08; validates all prior specs. **Status:** P10-01 to P10-03.

## Objective

Build Kanban and Email as realistic, independently deployable consumers and prove gateway/CLI/MCP/outbox behavior end to end. Examples must not import internals or receive special-case framework logic.

## P10-01: Kanban

Implement the exact card schema, indexes metadata, `bulkMove`, completion guardrail, and `ready_for_review` event from the spec. Add:

- Host configuration through validated environment variables.
- Idempotency/correct transaction policy for `bulkMove` (recommended one transaction: all cards move or none; run every card's hooks).
- README with local SQLite and distributed PostgreSQL/gateway instructions, curl/CLI/MCP examples, and security caveats.
- Seed helper only for development/tests.

Clarify guardrail semantics: an agent may move to done when the existing card already has a valid `prUrl` or the same update patch supplies one. Human behavior follows authorization policy and is not vetoed by this hook.

## P10-02: Email

Implement `sendBatch`, Kanban event subscription, and a `mailer` service abstraction:

- Test/dev mailer records sends; production adapter configuration is explicit and absent by default rather than pretending delivery.
- `sendBatch` validates all recipients, reports progress at every tenth/final recipient, handles zero recipients by schema/policy, and observes cancellation.
- Event handler supplies event ID as mailer's idempotency key so relay retries do not duplicate supported-provider sends.
- Apply the >500-recipient marketing-lead guardrail shown in spec 02 (or document if reference scope intentionally excludes it).

## P10-03: distributed E2E

Provide Docker Compose/Testcontainers topology: PostgreSQL, gateway, Kanban, Email, with unique ports, health checks, per-app registration credentials, signing/verification keys, and no hardcoded production-like secrets. Run tests against built artifacts.

Required journey:

1. Start gateway; apps register and become healthy.
2. Authenticate an agent and discover both manifests through CLI and MCP.
3. Create/list/update a Kanban card via different surfaces; confirm same tenant data.
4. Attempt `done` without PR and observe guardrail veto/no mutation/no completion event.
5. Add PR then move to `in_review`; commit card and outbox atomically.
6. Relay `ready_for_review` through gateway to Email; verify exactly one logical notification with event ID even after forced retry/restart.
7. Call Email `sendBatch`; verify ordered CLI and MCP progress and result.
8. Stop Kanban/miss TTL; verify tools disappear and dispatch fails unavailable. Restart/re-register; verify recovery.
9. Create another org; prove no entity/catalog execution leakage beyond scopes.

## Tests and success criteria

### Kanban tests

- Card schema defaults and all enum/URL/min-length validation match spec.
- Agent done transition without existing or patched PR vetoes and rolls back; with valid PR succeeds; human case follows approved rule.
- Transition into `in_review` emits once; updates already in review do not. Failed transaction emits none.
- `bulkMove` validates all IDs/tenant ownership first and is atomic; one guarded card rolls back all cards. Empty/duplicate ID behavior is explicit.
- App manifest lists five card CRUD tools plus `bulkMove` with correct schemas.

### Email tests

- Valid batch sends each recipient and emits exact progress points (including totals below/not divisible by ten); cancellation stops further sends.
- Invalid email or unauthorized >500 batch sends zero mail.
- Ready-for-review event formats expected subject/body and passes idempotency key; duplicate delivery produces one logical send.
- Mailer outage drives retry/backoff/dead-letter without losing envelope metadata.
- Manifest advertises action and event subscription.

### E2E success

- All nine journey steps run unattended in CI with polling/health conditions, never fixed startup sleeps.
- Force termination at three points: before publisher commit, after gateway fan-out persistence, and after Email side effect before acknowledgement. Assert no pre-commit phantom event, no lost durable event, and at-least-once/idempotency behavior respectively.
- Exercise API key auth and signed app tokens; cross-app audience token misuse fails.
- Capture CLI output and MCP protocol assertions, not only direct HTTP.
- Compose stack shuts down cleanly and tests leave no containers/volumes/processes.

Phase 10 passes when the distributed journey is release-blocking and demonstrates every core guiding principle from `docs/specs/README.md`.