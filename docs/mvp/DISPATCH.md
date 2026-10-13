# Hosted dispatch safety (M07)

Hosted calls use the authoritative workspace store, not process-local rate limits or
heartbeat health. An idle catalog app is callable; discovery does not wake it.

## Admission and deadlines

- Authorization and advertised-target checks precede admission and host invocation.
- Each workspace has **60 admitted calls per 60-second window** and **20 concurrent
  leases**, shared across credentials, apps and gateway replicas. PostgreSQL's clock
  and a workspace row lock serialize admission. The quota increment and unknown
  audit intent commit in one transaction before downstream token acquisition/dispatch.
- Denied admission returns `RATE_LIMITED` and a retry delay; failed database access
  never enables a local fallback. Completion does not refund the rate budget.
- Leases expire after **60 seconds**, allowing recovery after a dead process; expiry
  never changes an audit outcome into success. Action deadlines cannot exceed 30s.
  These count gateway admission leases, not customer code that continues running
  despite cancellation; cooperative host execution is an M08 runtime boundary.
- The **30-second action deadline** includes admission, invocation-token/signing work,
  cold app connection and the entire response body. Tests may shorten it. Store pool
  acquisition/queries are separately bounded at 5s. A separate **60-second whole
  request timer** begins at ingress before workspace authentication and body parsing;
  it aborts the request and sends a bounded 503 or closes an already-streaming response.
  HTTP parsing/inactive connections are also configured at 60s. Tests may shorten
  these budgets; none is a measured end-to-end cloud SLA.
- Cancellation reaches downstream requests. Shutdown aborts HTTP/stream controllers,
  closes MCP, and drains admitted completions (maximum 35s). A forced termination or
  completion-store outage leaves the committed intent unknown. Completion writes have
  a separate maximum 5-second wait: failure does not replace a known host result or
  erase its request ID. Late admissions after cancellation are never dispatched and
  their unknown completions participate in shutdown drain.
- Incoming JSON: 1 MiB. Downstream cumulative body: 1 MiB. SSE buffered frame: 64 KiB
  in UTF-8 bytes. Oversized or stalled responses are cancelled, not read unboundedly.
  MCP's duplicated JSON text/structured result adds encoding overhead beyond this
  downstream limit; it is not a 1 MiB final wire-envelope guarantee.

## Destinations and retries

Only the trusted control-plane catalog chooses destinations. Hosted production uses
HTTPS port 443, no URL credentials, no redirects, proxies or connection reuse. DNS
is resolved once per connection; every answer must be public and the socket lookup
is pinned to a validated address, while TLS verifies the original catalog hostname.
Private IPv4, shared-address space, link-local/metadata, loopback, mapped IPv4 and
non-global IPv6 are denied. There are no admitted private-provider exceptions today.
The reference/local profile and explicitly injected test transports are not this
production network policy.

**There are no automatic retries, including reads.** `idempotent: true` never permits
write replay. A lost response, malformed/truncated terminal response, deadline or
cancellation after admission is conservatively recorded as **unknown**, with request
ID. Clients must inspect application state/effect ledgers before deciding whether a
new call is safe; issuing a new request ID is not an idempotency mechanism. Known
host error envelopes remain failures; complete valid results alone establish success.

## Durable audit and operations

Maintenance must migrate the two new tables before rolling out this gateway:
`embody_platform_quotas` and `embody_platform_audit`. Runtime requires data-table DML,
not schema ownership or CREATE privilege. `scripts/prepare-platform.mjs` exercises
this split on disposable fixtures; do not use fixture credentials in production.

Audit stores request/workspace/actor/app/target/surface, delegated subject/client,
outcome, error code and duration, plus admission time/lease/completion state. It does
not store action input/output, credentials, JWTs, signing material or raw exception
text. Completion is first-write-wins. An intent is initially `unknown`; process loss
or lease expiry must never synthesize success. Optional JSON-line delivery uses the same conservative outcomes; a failed completion
write logs sanitized unknown/correlation metadata, without driver exception text. It
is not an authoritative audit database and can be lost independently.

Operators inspect a request using bound SQL parameters (authorize workspace first):

```sql
SELECT admitted_at, completed, document
FROM embody_platform_audit
WHERE workspace_id = $1 AND request_id = $2;
```

No public audit/status endpoint is added here. An unknown outcome cannot establish
whether an application committed; correlate the request ID with application data.

Retention baseline: **30 days**, pending M16 customer-data approval. A maintenance
job/operator must export if required and delete rows in bounded batches older than
30 days whose leases have expired. Preserve unknown outcomes in any export. Run
cleanup outside gateway/app processes, without polling app endpoints. Retention is
not an in-process timer and this change does not provision an external scheduler or
export queue. Monitor row growth and failed completions until external lifecycle
controls land; do not claim automatic retention enforcement.

## Verification

`pnpm test:mvp` includes public-address/metadata/redirect negatives, a connection
lookup rebinding fixture, cumulative/stalled body and cold-response tests, effect-ledger
response-loss injection, shared-store quota concurrency/replica replacement, admission
outage, and real PostgreSQL committed-intent/completion/role negatives. Use
[TESTING.md](./TESTING.md) with a distinct disposable container. Exact-candidate
Node22/24 CI, independent review and real cloud zero-instance/cold-latency qualification
are separate evidence gates; local injected cold delay is not provider proof.
