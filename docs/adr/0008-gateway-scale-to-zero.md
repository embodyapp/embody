# ADR 0008: The hosted gateway must support scale-to-zero

- Status: Accepted requirement, by explicit user instruction to add gateway scale-to-zero to the hosting plan.
- Implementation status: Not implemented or verified. MCP transport/client compatibility and operational settings still need evidence.
- Extends: [ADR 0007](./0007-cloud-run-stateless-hosting.md). Does not require shutting down active work, remove app sleep requirements, or claim databases/network services also scale to zero.

## Decision

The hosted gateway must support a Cloud Run **minimum-instances-zero deployment profile**, reach zero when it has no active requests/connections, and handle the next authenticated request from a cold start without correctness loss. This is a launch requirement, verified by CH9-07/V22.

An operator may select warm gateway capacity for latency or sustained traffic. This is a cost/latency setting, not a correctness dependency; the same release must continue passing min-zero qualification. Unlike idle app compute, a shared gateway may legitimately stay active because many customers are using it.

## Required architecture

1. Routing/catalogs, grants, quota counters, committed audit intent and required logical session/progress state are durable or safely reconstructable outside a gateway process. Local caches are disposable; cold starts cannot reset security controls.
2. Startup initializes only bounded configuration/trusted clients and loads request-scoped state lazily. No global app scan, migrations, heartbeat wait, customer code or essential post-response work.
3. Prefer stateless MCP HTTP where supported by the pinned SDK/client matrix. Where stateful behavior is needed, define durable logical state or protocol-correct session expiry/reinitialization and progress resumption. Do not serialize live SDK server/transport/socket objects or rely on session affinity for correctness.
4. Active requests/streams can keep an instance running. Use tested idle-stream and reconnect policies, but do not interrupt useful work solely to obtain a zero-instance metric. Notification gaps, cursor retention and session expiry are documented per supported client; no universal seamless-reconnect claim.
5. Queue dispatch, scheduled work, reconciliation and audit delivery use separate bounded services/handlers, not gateway-owned background loops. Scheduled reconciliation and monitoring must not continuously ping the public gateway to keep it warm.
6. Durable operation identity/idempotency survives disconnect and replacement. Reconnecting a session or observing progress never implicitly resubmits a mutation. Unknown outcomes require safe status/retry handling, not blind replay.

## Trade-offs and rejected alternatives

- Both gateway and app can cold-start for the same interaction. Measure end-to-end latency including authentication, store access and client reinitialization. Warm-only benchmarks cannot satisfy this requirement.
- An open SSE connection is an active request. It is incompatible with zero serving instances; zero is possible after closure/quiescence, not while preserving a live socket.
- An idle-stream close policy can trigger immediate client reconnection. Test a designated sleep-compatible transport/client mode; clients that maintain streams/periodic traffic remain supported only under explicitly documented active-capacity semantics, not advertised as allowing idle zero.
- Keeping one gateway permanently warm as a correctness workaround is rejected. Optional warm capacity for a measured latency objective remains allowed.
- Merely changing `min-instances` or putting a process-local session map in a cache is insufficient. Persist only the logical protocol state that can actually be reconstructed.

## Verification

V22 requires real Cloud Run instance-count evidence, not just configuration inspection:

- Reach zero with no external probes/keepalives; next HTTP/CLI/MCP request succeeds.
- Show gateway-only cold and gateway+app cold flows separately; catalog requests do not wake unrelated apps.
- Preserve quota counters, committed audit, access restrictions and revocation through termination/cold start.
- Recover/expire MCP sessions correctly, resume permitted progress, and never duplicate a mutation through reconnect.
- Demonstrate idle-stream behavior without a platform-induced reconnect storm; separately show that useful active work is not killed to force sleep.
- Process scheduled app work through the dispatcher while the gateway remains idle/zero.
- Fail closed when authoritative state cannot be read on cold start; there is no permissive empty-cache fallback.

See [CH9-07](../hosting/implementation-plan/09-sleep-and-stateless-execution.md#ch9-07--gateway-zero-capacity-and-cold-session-recovery) and [verification](../hosting/implementation-plan/00-VERIFICATION.md). Approval records intent, not passing tests.
