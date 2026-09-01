# Phase 5 — Remote host, execution, and authentication

**Specs:** 01 §3.3, 02 §3, 04. **Status:** P5-01 to P5-03.

## Objective

Expose one secure action execution pipeline in a remote app host. HTTP, later MCP, CLI, and test harness must all invoke this same pipeline.

## P5-01: execution engine

Create `kernel.execute(target, input, executionOptions)` where options provide verified principal, request/trace IDs, cancellation signal, and progress sink.

Pipeline:

1. Require and validate `Principal`; derive `orgId` only from it.
2. Resolve action and validate input before opening a transaction where possible.
3. Authorize `ctx.can(target, resource)` and required action scope. Define wildcard matching (`kanban:*`, exact target) with segment-aware rules; deny by default.
4. Construct request-scoped `KernelContext` and invoke handler once.
5. Validate optional output schema; map known failures to structured errors.
6. Emit audit metadata (never raw secrets; payload recording follows redaction policy), duration, outcome, actor/app/target/request IDs.

Support cancellation propagation. Place request-scoped state in explicit context, not mutable globals/unsafe async-local assumptions.

## P5-02: host and verifier plugins

Implement `@embody/host` with:

- `POST /execute` accepting `{protocolVersion,target,input}` and `X-Gateway-Auth: Bearer ...`;
- `/execute/stream` in phase 6;
- `/health` with liveness/readiness distinction and version/app ID;
- internal authenticated `/events/deliver` in phase 6;
- body, header, timeout, and concurrency limits; request IDs; graceful shutdown.

Verifier chain fails closed. Built-ins:

- `gatewayJwtVerifier`: verify allowed algorithm (never trust token header alone), issuer, audience/app ID, expiry/not-before, key ID/rotation, and required Principal claims using `jose`.
- `localDevVerifier`: only enabled by explicit development config, binds loopback by default, and emits a visible warning. Production boot rejects it.

Do not allow ordinary caller `Authorization` tokens directly at a remote app unless a separately configured verifier owns them.

## P5-03: gateway registration client

- After readiness, POST versioned manifest/endpoint/health metadata with registration credentials.
- Heartbeat every 30 seconds using injectable clock/scheduler; retry transient registration failures with bounded jittered backoff.
- Re-register after gateway restart/not-found response and when manifest hash changes.
- Stop heartbeat before host shutdown. Never log registration secret.
- Validate advertised endpoint against local deployment config; do not infer a private internal address from request headers.

## Tests and success criteria

### Execution tests

- Exact and wildcard scopes allow intended actions; similarly prefixed scopes (`kanbanx:*`) do not. Missing scope, malformed principal, and `can=false` return forbidden.
- Principal org overrides any org-like field in input; cross-org attempts remain isolated.
- Input errors do not run handlers; output contract errors become safe internal/contract errors.
- Cancellation reaches a cooperative handler and audit outcome is `cancelled`.
- Progress/audit/request IDs are isolated across 100 concurrent executions.
- Unknown target is safe not-found and reveals no manifest beyond caller authorization.

### HTTP/JWT tests

- Fastify injection verifies success and stable mappings for 400/401/403/404/409/422/429/500/503.
- Missing/malformed/expired/future/wrong issuer/wrong audience/wrong algorithm/unknown key/tampered JWTs all fail 401 without handler invocation.
- Current and next rotation keys overlap successfully; retired key fails after configured window.
- Oversized body, too many requests, timeout, disconnect, and malformed JSON are bounded and audited safely.
- Health readiness is false during boot/failure/stopping and true only when executable.
- Production config with local verifier fails boot; development default principal is explicit and loopback-only.

### Registration tests

- Registration payload matches phase-0 fixture and includes deterministic manifest hash.
- Fake clock observes heartbeat at 30 seconds, unhealthy-network retries per policy, re-registration on 404, and no tick after stop.
- Secret is present only in outbound auth header and absent from logs/errors/snapshots.

Phase 5 passes when a built host can execute a generated action via signed gateway JWT, all auth-negative tests fail closed, and graceful stop leaves no sockets/timers.