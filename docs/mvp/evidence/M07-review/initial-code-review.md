# M07 independent read-only review

## Decision: **REJECT — not ready to declare DONE**

The implementation has a sound foundation: authoritative admission precedes dispatch, quota and audit intent commit together, no automatic replay exists, and DNS answers are pinned to the connection. However, ambiguity handling is inconsistent across transports, completion-store failures can destroy useful results and request IDs, and the SSE frame limit depends incorrectly on network chunk boundaries.

**Missing final CI is not a code blocker.** Clean exact-candidate Node 22/24 CI is nevertheless required for completion after the issues below are resolved.

## Review scope and limitations

Reviewed the diff against `06c4222d5673ab826d2095b11cd64a8a50b9e1cf`, including untracked `safe-fetch.ts`, its tests, `DISPATCH.md`, and the M07 evidence entry. Read the M07 requirements, MVP README/verification contract, gateway/store/tests, and relevant MCP/host cancellation paths.

The worktree changed during review. The latest observed source blobs were:

| File | Git blob prefix |
|---|---|
| `packages/gateway/src/dispatch.ts` | `fafc37b68e36` |
| `packages/gateway/src/index.ts` | `324b22cfe637` |
| `packages/gateway/src/store.ts` | `465dc367a5c4` |
| `packages/gateway/src/safe-fetch.ts` | `0ddf690a319d` |

Line references below correspond to that snapshot. Any subsequent changes require re-review.

No files were modified, no agents invoked, and no DB/cloud operations or secret reads performed. Small in-memory diagnostics used the available Node 26 runtime; they are **not supported-runtime acceptance evidence**.

## Code blockers

### B1 — HTTP error-body paths do not consistently report unknown outcomes

**Files:** `packages/gateway/src/index.ts:869–874, 992–1003`; compare MCP normalization around `:658–670`.

Both HTTP execution paths swallow failures while reading non-success response bodies:

```ts
await response.json().catch(() => undefined)
```

A truncated, oversized, stalled, or malformed error response consequently becomes a generic `INTERNAL_ERROR` envelope. These branches return it directly, bypassing the hosted “outcome unknown; do not replay” normalization.

Likewise, a parsed host `UNAVAILABLE`/`INTERNAL_ERROR` envelope is returned unchanged on these HTTP paths, although durable completion normalizes that outcome to `unknown`. MCP and terminal HTTP SSE events handle this differently.

**Impact:** an ambiguous mutation can produce an ordinary-looking failure to HTTP clients while its authoritative audit says unknown. This violates the documented cross-surface no-replay semantics.

**Required fix/tests:**
- Centralize hosted unknown-outcome normalization across JSON, pre-stream errors, terminal SSE errors, and MCP.
- Preserve known public failures such as `HOOK_VETO` and `VALIDATION_ERROR`.
- Parameterize tests across all three surfaces for:
  - commit followed by malformed/truncated non-2xx body;
  - non-2xx headers followed by a stalled or oversized body;
  - host `INTERNAL_ERROR` and `UNAVAILABLE`;
  - exactly one effect, no retry, explicit unknown warning, matching request ID and durable outcome.

### B2 — Durable completion failure can replace a known result or erase its request ID

**Files:** `packages/gateway/src/dispatch.ts:340–365`; `packages/gateway/src/index.ts:624–643, 743, 957, 1020`; `packages/mcp/src/index.ts:233–261`.

`finish()` awaits the completion store and lets its rejection escape. Each transport awaits `finish()` in `finally`.

Consequences include:
- JSON: a valid downstream result can be replaced by a generic gateway error.
- MCP: a terminal result already collected by the adapter can be replaced by its generic catch fallback, **without the dispatch request ID**.
- HTTP SSE: completion can throw after terminal output has already been sent and the response ended, entering the ordinary error-handler path too late.

Leaving the committed intent unknown during a completion outage is appropriate. Losing outcome information or the correlation ID is not.

**Required fix/tests:**
- Define completion-failure behavior explicitly: retain a known result where appropriate, or return a structured unknown response with the dispatch ID.
- Do not attempt a second ordinary HTTP response after SSE termination.
- Inject completion-store rejection and delay after host success and known failure on every surface.
- Assert durable intent remains recoverable, no effect repeats, IDs remain available, and shutdown remains bounded.

### B3 — SSE frame size enforcement is dependent on chunk boundaries

**File:** `packages/gateway/src/dispatch.ts:142–159`.

The decoder checks the size of the entire pending string **before extracting complete frames**. That string can contain several valid frames, or one valid frame plus part of the next.

Thus identical SSE bytes can succeed when delivered in smaller chunks and fail when coalesced. The new UTF-8 byte check improves accounting but retains this transport bug.

**Required fix/tests:**
- Enforce the limit on each complete frame and on the remaining incomplete frame—not the aggregate chunk.
- Test identical bytes split into many chunks versus one coalesced chunk.
- Cover two individually valid frames whose combined size exceeds 64 KiB, a near-limit frame followed by another frame, and multibyte characters split across chunks.
- Keep genuine oversized-frame rejection and reader cancellation.

## Missing acceptance coverage

These are substantive coverage gaps, separate from the missing final CI run.

### M07.d — Lease and admission failure boundaries

**Files:** `packages/gateway/test/store-conformance.ts:98–251`; `packages/gateway/test/postgres-store.test.ts:20–59`; `packages/gateway/src/store.ts:386–432`.

Current tests establish concurrent admission, quota exhaustion, persisted intent, and first-completion-wins behavior. They do not establish:

- lease expiry frees admission without converting unknown to success;
- quota-window rollover across replicas;
- completion-store outage;
- admission commits after the caller’s deadline/cancellation;
- lost COMMIT acknowledgement;
- SQL lock/query timeout followed by rollback and healthy pool reuse.

Use deterministic barriers and disposable real PostgreSQL for SQL boundaries. After each failure, assert quota/audit consistency and zero downstream invocation where delivery was never authorized. **Do not add blind transaction retries around an ambiguous COMMIT.**

### M07.a/c — Newly added cancellation and shutdown paths need regression evidence

The latest code now supplies request signals to preflight, tracks pending admission earlier, and handles late admission completion. Those changes address weaknesses present in the first snapshot, but the inspected tests still primarily cover cancellation/shutdown **after dispatch begins**.

Add:
- client disconnect and shutdown during admission and token acquisition;
- late admission completion after the response has ended;
- HTTP SSE backpressure with neither `drain` nor `close`, ending through deadline;
- request deadline while workspace credential/catalog lookup is pending;
- assertions that no late token/admission continuation invokes the host.

The cold-success test currently exercises `boundedFetch` with an injected delay, not a complete hosted gateway/store/host journey. Add a controlled end-to-end cold fixture within the documented budget.

## Security and optional follow-ups

- **Address normalization:** `safe-fetch.ts:8–32` now rejects additional IPv6 special-use ranges, but comparison of `second === "db8"` is textual. For example, the helper treats `2001:0db8::1` differently from `2001:db8::1`. URL literals normally canonicalize before this check, so this is **not a demonstrated production SSRF bypass**. Use numeric/canonical address classification and test equivalent compressed, expanded, mixed-case, and zero-padded forms. Also document treatment of IPv4 documentation/deprecated transition ranges.
- **Production transport tests:** `safe-connection.test.ts:8–55` verifies a mocked lookup callback, not actual TLS hostname verification or socket cancellation. Add a controlled HTTPS fixture covering wrong certificate hostname, mixed public/private DNS answers, redirects, and bodyless statuses.
- **Issues changed during review:** the original unguarded `Response` construction could throw from the HTTPS response callback on 204/205. The latest callback catches exceptions and handles bodyless responses; I am **not retaining that as a current blocker**. Add regression tests.
- **Host cancellation boundary:** `packages/host/src/index.ts:223–237` only observes request `aborted` for JSON execution. Closing a connection after its request body was received does not necessarily abort kernel execution. Track this explicitly into M08; gateway lease counts must not be advertised as a hard cap on still-running customer code.
- **Audit interpretation:** durable completion normalizes some records to unknown, while the optional sink receives the original failure/cancelled record. Label local transport outcome versus authoritative action outcome, or normalize consistently.
- **Timer/resource cleanup:** successful calls leave timeout/listener machinery until expiration; the shutdown race leaves its losing timer scheduled. Explicit cleanup is preferable, especially for rejected-call volume.
- **Retention/export:** manual maintenance and deferred scheduling are honestly documented. They are follow-ups, not grounds to require cloud operations for M07.

## Completion gates

`docs/mvp/evidence/M07-2026-10-13.md` correctly labels its runs as dirty-worktree diagnostics and M07 as unaccepted. Changes made during this review are not covered by that earlier evidence.

Before DONE, require:

1. Resolution and regression coverage for B1–B3.
2. Acceptance evidence for the failure boundaries above.
3. A frozen candidate and updated independent review.
4. Clean Node 22/24 quality, mandatory DB/MVP, and packed/distributed E2E CI, with zero required skips.

Real provider scale-to-zero and measured cloud cold latency remain M09/M17 gates, not prerequisites for manufacturing cloud evidence in this review.

**Final disposition: REJECT the current M07 DONE claim; keep M07 IN_REVIEW.**
