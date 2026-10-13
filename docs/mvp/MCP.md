# Hosted MCP contract (M06)

The hosted workspace gateway uses request-local `@modelcontextprotocol/sdk` **1.32.1** servers and Streamable HTTP transports. No sticky routing, process-owned initialization state or MCP session ID is required. The standalone adapter's default remains stateful for compatibility.

## Connection and authorization

Use `https://<gateway>/w/<workspace>/mcp` for the authorized workspace catalog or append `/<appId>` for an app-scoped catalog. Send the workspace credential as `Authorization: Bearer <token>` on **every** request. Catalog and call permissions are evaluated again on every request, including after gateway replacement. Discovery reads the durable catalog, not app health/heartbeat endpoints, and must not invoke app hosts.

Send `Content-Type: application/json`, `Accept: application/json, text/event-stream`, and the negotiated `MCP-Protocol-Version` on subsequent requests. SDK 1.32.1 negotiates protocol `2025-11-25` by default. Do not send `Mcp-Session-Id`; the hosted adapter rejects it with HTTP 400. These protocol headers are not substitutes for authorization.

| Operation | Hosted behavior |
| --- | --- |
| POST `initialize` | Standard SDK negotiation; tools advertised with `listChanged: false`; no session ID returned |
| POST `notifications/initialized` | Accepted without retaining client capability state |
| POST `tools/list` | Current authorized catalog, including app scope |
| POST `tools/call` | Current authorization; request-owned SSE stream for progress and result |
| POST `ping` | SDK protocol response; clients must not schedule idle pings |
| GET / DELETE | HTTP 405 with `Allow: POST`; no idle SSE connection or server session to delete |
| Other protocol operations | Not advertised; SDK rejects unsupported requests |

Each request has a fresh SDK server. Do not depend on capabilities supplied to a prior replica's `initialize`. The hosted profile advertises only tools: no GenUI/resources/prompts/subscriptions or universal UI support. Tool results retain JSON text content; object results also include `structuredContent`. Arrays and primitives remain text-only. Progress is sent in execution order only when the current call supplies `_meta.progressToken`. Sanitized errors preserve validation details, retry hints, error code and request ID.

## Cancellation, shutdown and idle behavior

Close/abort the **active HTTP transport** to cancel reliably. A cancellation notification sent as a separate request may reach another replica and cannot reliably cancel the original request. An SDK call-level AbortSignal alone must not be advertised as cross-replica cancellation; close the transport as well. Execution must cooperate with its AbortSignal; transport cleanup cannot forcibly terminate arbitrary customer code.

Completed or disconnected request servers are disposed. Gateway shutdown closes MCP before Fastify drains connections, aborts request handlers and destroys active HTTP responses. Clients must treat premature EOF as an incomplete call; some SDK clients keep a pending call until their deadline or explicit client close even after an SSE stream ends. No success is inferred from stream closure. The reference adapter only records local cancellation audit. The hosted gateway now adds authoritative admission and a bounded durable in-flight drain (M07); handler close still cannot wait for arbitrary application cleanup or guarantee audit delivery on forced process exit. See [dispatch semantics](./DISPATCH.md). Final M07 acceptance remains pending. There is no resumable stream, affinity fallback or automatic mutation replay promise. After an ambiguous mutation failure, inspect the outcome rather than blindly retrying.

The SDK client may attempt GET to establish a listening stream; the 405 intentionally prevents an idle stream. Clients must tolerate that response without a reconnect loop, close active streams after completion, and avoid idle polling/keepalives. Local resource cleanup is not proof of provider zero-instance behavior; M17 requires metrics.

## Client support matrix

| Client | Status | Setup / qualification |
| --- | --- | --- |
| Official TypeScript SDK 1.32.1 | Automated local transport regression | `StreamableHTTPClientTransport` with bearer header in `requestInit`; replica replacement, progress, result and shutdown tests |
| Embody CLI 0.1.0 (plain HTTP actions) | Local authenticated discovery/action smoke passed | Protected profiles or `EMBODY_TOKEN`; no MCP session needed |
| Claude Code **2.1.296**, direct HTTP | Qualified on frozen candidate `89aaac4`; see [acceptance evidence](./evidence/M06-2026-10-13.md) | Bearer header in private MCP config; initializes/lists/calls across replicas and replacement; live-client 120-second idle window with zero requests, active responses or sockets |
| Other desktop/remote clients | Not qualified | No universal compatibility claim; token/405/idle/cancellation behavior varies |

### Claude Code 2.1.296 setup

Use a private MCP configuration file (mode `0600`) with `mcpServers.embody.type: "http"`, the workspace MCP URL, and an `Authorization` bearer header. Keep the token in the file, not in process arguments or public transcripts. Launch Claude Code with `--strict-mcp-config --mcp-config <private-file>`; allow only the desired app tools. Delete temporary configuration after the smoke. The executable fixture does this automatically with a disposable credential and synthetic local app.

Claude Code 2.1.296 first probes `server/discover` using protocol `2026-07-28`; SDK 1.32.1 rejects that probe with 400. The client then successfully falls back to standard `initialize` and negotiated `2025-11-25`, receives GET 405 once, and does not reconnect in the observed idle interval. The probe is **not** a supported method or a promise to support newer protocol capabilities. Other Claude Code versions and the stdio bridge require their own qualification.

Run `pnpm test:mvp:client` with the installed, authenticated **2.1.296** client. This opt-in gate builds the candidate, uses a local hosted gateway plus authenticated host, alternates replicas, replaces one gateway between two calls, leaves the client running for 120 seconds with stdin open, then closes it normally and executes a plain CLI action. It fails if the named client/version is unavailable, a call is missing or repeated, more than one GET probe occurs, idle requests recur, responses/sockets remain open or client shutdown fails. Model/tool behavior is intentionally observed through the real product, not mocked: a missed or duplicate call is a failed smoke, and the fixture never silently retries it. Claude model use is limited to two synthetic smoke turns with a `$1` client budget; this does not authorize cloud infrastructure spend. Evidence is sanitized `.artifacts/verification/mvp-client.json`; no provider authentication or raw client logs are published.

### Required real-client smoke before acceptance

1. Record exact client/version, Node/runtime, gateway candidate SHA, SDK/lockfile version, workspace and sanitized setup. Keep bearer tokens out of command-line arguments and transcripts.
2. Initialize, list authorized tools and execute a bounded tool call. Record result/error/progress behavior and which gateway replicas handled requests.
3. Replace the gateway between requests; verify continued calls and current authorization. Verify app-scoped and workspace-scoped catalogs without app invocation.
4. Close the client normally; observe connection/request counts for a stated bounded interval. Record any GET retries, reconnects or keepalives; a reconnect loop is a failed gate, not a passing exception.
5. Record plain CLI discovery/action parity and cancellation/shutdown behavior. No cloud resource creation is authorized by this local smoke procedure.

Final acceptance remains tracked in [STATUS](./STATUS.md). Run focused regressions with `pnpm --filter @embody/mcp test`; the mandatory `pnpm test:mvp` runner now includes this package.
