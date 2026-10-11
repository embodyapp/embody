# M05 local development evidence — 2026-10-11

## Remote alignment and scope

Fetched/pruned `origin`, confirmed the clean worktree had no local-only commits, then
fast-forwarded `worktree-session-dc56` to remote main
`596af34b577a5cfb372ca20cfe2a102ab05dc82d` (#36, completed M04).
No other branch/worktree was reset, rebased or overwritten.

This is **local dirty-worktree development evidence**, not an exact committed candidate,
independent review, remote merge, provider qualification or M05 completion. The SHA in
JSON identifies the base; `dirty: true` explicitly identifies uncommitted implementation.
Implementation is committed on `feat/mvp-m05-identity` in [draft PR#37](https://github.com/embodyapp/embody/pull/37).
M05 is BLOCKED on approved cloud fixture/access/budget and real provider acceptance.
See [independent local acceptance](./M05-independent-review.md). The JSON in `M05-local`
is historical dirty development evidence, not current candidate or provider proof.

## Changes

- Gateway-only ES256 private key loading, strict public JWKS validation, matching active
  key/ID and public `/.well-known/jwks.json`; hosted workspace gateway rejects HMAC.
- 300-second app-audience principal tokens. Hosted verifier pins ES256/issuer/exact
  audience/workspace, requires bounded `iat`/`exp` and rejects forged delegation.
- 60-second maximum remote key cache, 5-second fetch timeout, no expired-cache fallback;
  immediate unknown-ID refresh supports rotation overlap. Removed-key and unavailable
  JWKS negatives execute against a real disposable HTTP JWKS server.
- Hosted app environment uses public verification only, rejects shared/private signing
  material, platform database config and unbound legacy shared-secret event ingress,
  and cannot override hosted authentication. Hosted MCP forces delegated agent attribution
  even when the legacy token-mode opt-out is supplied; downstream claims are verified in
  the hosted MCP integration test before asserting that caller keys were not forwarded.
- Provider identity adapter separate from caller/API/principal identity; invocation origin
  comes from authorized catalog. All downstream execution surfaces forbid redirects.
  The hosted executable now wires `cloudRunInvocationToken` and requires the provisioned
  `GATEWAY_SERVICE_ACCOUNT_EMAIL`. Metadata identity/audience/refresh failure tests execute
  locally; default HTTPS `*.run.app` origins only. Five-second metadata `iat` leeway keeps
  expiry strict; principal verification retains zero tolerance.
- Mandatory MVP runner includes auth/host suites. Existing M04 real store and MCP
  cross-workspace/revocation cases continue executing under asymmetric signing.
- Real gateway-to-host JWT round-trip uses the gateway public JWKS across HTTP/SSE/MCP;
  provider and principal headers stay separate on all three paths, and unauthorized
  workspace requests cannot acquire provider tokens. Actual exported SQL role inspection
  and CONNECT-stage classifier now run against real PostgreSQL within mandatory store coverage. Missing-kid, unsigned and array-
  audience negatives added; unknown-ID JWKS refresh has a one-second cooldown.
- Targeted runtime-metadata IAM/SQL and private-invocation probes plus six local fail-closed
  runner tests; [live procedure](../M05-PROVIDER-PROOF.md). No provider evidence claimed.
- CI now runs mandatory PostgreSQL/MVP on both Node 22 and 24, with stable aggregate checks.
- [Identity diagram, required role matrix and rotation/revocation runbook](../IDENTITY.md).

## Local commands/results

Used supported **Node v24.21.0**, pnpm 11.25.0 and disposable PostgreSQL 16.15.
Initial checks also ran on default Node 26, but are not accepted evidence; the results
below were rerun on Node 24. Used only public fixture credentials from
`test/postgres/fixture.env.example`; separate Compose project
`embody-m05-verification`, removed after tests. Existing local reference services were
not changed by the PostgreSQL fixture.

| Gate | Result |
|---|---|
| `pnpm verify` | PASS: lint/boundaries/skills/license, all-package typecheck/build/test, API report and format |
| Workspace Vitest in verify | 281 passed, 11 explicitly optional DB skips; not a mandatory DB claim |
| Verification runner negatives | 23 passed, 0 failed |
| `pnpm test:mvp` | **156 passed, 0 failed, 0 skipped** |
| MVP breakdown | app PostgreSQL 12 + real platform store 22 + contracts 38 + auth 6 + host 14 + gateway 64 |
| `pnpm test:baseline` | PASS: one clean packed-consumer journey and one Docker distributed journey; zero failures/skips |

Baseline executes CLI, MCP, HTTP, events, restart, TTL and isolation in the reference
profile; it does not claim live hosted IAM or scale-to-zero. Local baseline was run before
completion-pass metadata adapter/probe/round-trip additions; final candidate CI must rerun it.
Mandatory MVP and verify were rerun after those additions. Reports remain local dirty-worktree
results; exact-candidate CI must rerun both baselines.

Sanitized reports retained in [M05-local/](./M05-local/): `mvp.json`,
`gateway-store.json`, `postgres.json`, `baseline.json`. These include local timestamps,
base SHA/dirty flag, lockfile/schema hashes and actual image identities.

## Acceptance disposition and remaining gates

- **M05.a:** local crypto and host HTTP/SSE adversaries pass. Existing gateway HTTP/MCP
  delegation attribution and workspace negatives pass. Hosted OIDC provider integration
  and full cold-client contract are not claimed.
- **M05.b:** an independently generated attacker key cannot sign accepted tokens; runtime
  uses public keys only. Real PostgreSQL role/DDL/cross-DB negatives pass. **Provider
  runtime metadata secret/deploy/signing-key denial remains unproven.**
- **M05.c:** overlap succeeds and removed keys stop working after configured cache expiry;
  failed refresh denies requests. Runbook specifies 300-second token lifetime and
  60-second cache/removal bounds. Live multi-revision convergence is unproven.
- **M05.d:** unauthenticated execute paths fail before kernel execution; cross-workspace
  catalog/action/MCP cases pass. **Private provider ingress remains unproven.** Logs,
  source and secret APIs have not landed and are not claimed complete/authorized.

[Independent local review](./M05-independent-review.md) accepted runtime code and, after
false-green/parser hardening and actual PostgreSQL regression, qualification tooling.
Review did **not** accept M05 DONE without live proof. Initial clean candidate CI passed
all eight checks on Node22/24; the final probe-hardening candidate must rerun exact CI.

Before DONE: committed-candidate independent security/scope review, Node 22/24 CI and
packed/E2E evidence; approved cloud project/budget and distinct provider identities;
private ingress/live rotation and actual metadata/IAM negatives. The provider adapter is
implemented but not live-qualified (final provider qualification retained in M09/M17). No cloud resources or budget
were authorized or created in this session.
