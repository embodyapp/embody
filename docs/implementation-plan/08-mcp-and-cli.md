# Phase 8 — MCP and CLI surfaces

**Spec:** 05, progress mappings from 06. **Status:** P8-01 to P8-03.

## Objective

Expose the gateway catalog and execution pipeline through standards-compliant MCP and one dynamic hierarchical CLI without duplicating business behavior.

## P8-01: MCP

Use the official supported MCP TypeScript SDK and pin/test the protocol version. Implement:

- Global `GET/POST /mcp`: healthy authorized tools named `<app>__<mapped_target>`.
- Scoped `GET/POST /mcp/:appId`: only that app, app prefix omitted.
- JSON-RPC initialize, tools/list, tools/call, cancellation, and supported SSE/streamable HTTP session behavior.
- Deterministic target mapping (e.g. `card.create` → `card_create`; camel case normalization approved in phase 0) with collision rejection at registration.
- Tool descriptions/input JSON Schema directly from manifests. Filter catalog by caller scopes so unauthorized tool metadata is not exposed.
- Convert execution results/errors to MCP content/isError conventions without leaking internal errors.

Do not hand-roll JSON-RPC framing beyond thin validated adapters.

## P8-02: CLI

Build `embody` binary with gateway URL/profile/auth config and commands:

- `embody apps list`, `embody apps inspect <app>`;
- entity CRUD hierarchy exactly as specs, including positional update/get/delete IDs;
- custom actions at `embody <app> <action>`;
- schema-derived flags, `--json` stdin mode, `--output json|table`, `--help`, profile/base URL options, and noninteractive behavior.

Rules:

- Fetch live manifest, cache only with TTL/ETag, and never execute stale targets without gateway confirmation.
- Convert flags by JSON Schema types; repeated array options and booleans must be unambiguous. Complex nested input uses JSON rather than lossy guessed flags.
- Reject mixing incompatible stdin/flags. Never prompt when stdin is non-TTY.
- Machine output writes only data to stdout; progress/diagnostics go to stderr. Stable exit codes distinguish usage/auth/forbidden/not-found/remote/unavailable/internal.
- Store credentials using env/config/keychain policy; redact from debug logs and child-process arguments where possible.

## P8-03: progress forwarding

- Gateway proxies remote SSE with backpressure/cancellation and maps remote progress to MCP `notifications/progress` when client supplied progress token.
- CLI renders TTY progress on stderr and newline-safe plain progress when non-TTY; `--output json` result stays valid JSON.
- Preserve order, request IDs, terminal result/error, and cancellation across remote app → gateway → client.

## Tests and success criteria

### MCP contract tests

- Official MCP client initializes and lists/calls tools against global and scoped endpoints.
- Global names include app prefix; scoped names omit it; camel/acronym/collision fixtures map deterministically.
- Only healthy and caller-authorized tools appear. Health/scope changes affect the next catalog response/session according to documented caching.
- Every emitted input schema validates against JSON Schema meta-schema and matches Zod acceptance for a corpus of valid/invalid inputs.
- Invalid JSON-RPC, unknown method/tool, wrong session, cancellation, and handler error return compliant responses.
- Two app tools execute correct canonical downstream targets with caller identity retained.

### CLI tests

- Golden help tests cover apps discovery, entity CRUD, custom action, JSON, and output options.
- Spawn built binary against test gateway: create/list/update/delete and custom action produce expected request payloads and exits.
- String/number/boolean/enum/array/default/optional flags coerce correctly; invalid/missing flags fail locally without dispatch.
- Piped valid JSON executes; malformed JSON, empty stdin, mixed flags, and non-TTY prompt need produce deterministic usage errors.
- JSON stdout parses with no progress/log contamination; secrets never appear in debug/error snapshots.
- Unhealthy app, auth denial, rate limit, remote validation, and network failure map to documented exit codes.

### Progress tests

- One action's three updates arrive in order as MCP notifications and CLI stderr followed by one result.
- Two concurrent requests with distinct progress tokens never cross updates.
- Ctrl-C/MCP cancellation closes upstream/downstream and action observes abort; no terminal success follows cancellation.
- Slow MCP/CLI consumer triggers bounded backpressure behavior without unbounded memory.

Phase 8 passes when official MCP client and spawned built CLI execute the same reference action through gateway with equivalent input/result/error behavior and progress integrity.