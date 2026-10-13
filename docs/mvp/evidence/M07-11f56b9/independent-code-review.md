# M07 independent final code review

## Decision: **ACCEPT — code and executable acceptance coverage**

**Frozen candidate:** `11f56b99061be30366ccb42b7fd5dc0a15aa9c95`  
**Reviewed diff:** `06c4222..11f56b9`

The candidate resolves the original **B1–B3** blockers and supplies substantive executable coverage for the previously missing cancellation, deadline, admission, completion and PostgreSQL fault boundaries. **No required M07 code fixes identified.**

Exact-candidate CI is running. **CI-pending is an outstanding evidence condition, not a code blocker.** This decision accepts the implementation and test coverage; it does not independently certify CI results, declare M07 DONE, or qualify production/cloud behavior.

## Scope and method

Reviewed:

- `docs/mvp/evidence/M07-review/initial-code-review.md`
- M07 requirements in `docs/mvp/IMPLEMENTATION.md`, verification/testing contracts, and `docs/mvp/DISPATCH.md`
- The candidate diff, gateway dispatch/store/network/lifecycle code, MCP result and cancellation handling, and relevant tests
- Mandatory-suite wiring and the candidate’s implementation evidence

HEAD matched the exact candidate and the worktree was clean at review checkpoints. No files were modified; no gates, agents, database/cloud operations, secret reads, commits or pushes were performed. Test execution counts below are **reported evidence**, not results independently rerun during this review.

## Original blockers

| Finding | Final assessment |
|---|---|
| **B1 — inconsistent unknown outcomes on HTTP error-body paths** | **Resolved.** Hosted JSON, pre-stream HTTP errors, terminal SSE errors and MCP normalize ambiguous `INTERNAL_ERROR`/`UNAVAILABLE` outcomes to an explicit unknown/no-replay warning, retaining the dispatch ID. Known public host failures remain failures. |
| **B2 — completion failures replace results or erase IDs** | **Resolved.** Completion rejection and its separate bounded wait no longer escape `finish()` and replace a known host result. Failed completion emits sanitized unknown/correlation metadata. MCP successes now carry the dispatch ID in `_meta`; SSE completion failure does not trigger a second ordinary response. |
| **B3 — aggregate-chunk SSE frame limit** | **Resolved.** The decoder extracts complete frames and checks each frame and the incomplete remainder separately in UTF-8 bytes, rather than rejecting the aggregate chunk. |

**Implementation references:**  
`packages/gateway/src/index.ts:673–691, 723–739, 894–924, 1020–1048`  
`packages/gateway/src/dispatch.ts:141–159, 348–401`  
`packages/mcp/src/index.ts:113–123, 254`

**Regression coverage:** `packages/gateway/test/hosted-dispatch.test.ts:90–192, 257–271` parameterizes ambiguity and completion failures across HTTP/SSE/MCP, checks warnings, IDs and single dispatch, and compares coalesced versus split multibyte SSE input while retaining genuine oversized-frame rejection.

## M07 acceptance assessment

| Case | Assessment and executable evidence |
|---|---|
| **M07.a — cold success, useful bounded failure, unauthorized calls never reach host** | **Satisfied at M07’s controlled-fixture scope.** A complete hosted gateway/store/real HTTP host fixture succeeds with injected cold delay. Tests cover stalled headers/bodies, invocation-token preflight, authoritative authentication, incomplete incoming JSON, and disconnect/shutdown during preflight. Existing workspace/grant/scope negatives retain zero-host-call assertions. |
| **M07.b — commit then lose response, no replay, unknown outcome and one effect** | **Satisfied.** Shared-store conformance explicitly exercises an annotated `idempotent: true` mutation without replay. A real HTTP host commits an effect in PostgreSQL and drops the response; the test checks one ledger row, the matching request ID, client unknown outcome and durable unknown audit. No automatic action retries were introduced. |
| **M07.c — rebinding/redirect/metadata negatives; bounded oversized/stalled streams** | **Satisfied.** Production hosted dispatch defaults to validated, connection-pinned HTTPS. Tests cover prohibited addresses, mixed public/private DNS answers, pinned lookup, redirects, cumulative body limits, stalled responses, bodyless/invalid status callbacks, per-frame UTF-8 limits and SSE backpressure without `drain`. |
| **M07.d — durable quotas/audit across replacement; outage fails closed** | **Satisfied.** Real-store conformance exercises concurrent replicas and replacement quota exhaustion. PostgreSQL tests cover process-loss intent persistence, immutable completion, lease expiry/window rollover, lost COMMIT ACK, lock timeout/rollback/pool reuse, and actual completion-pool outage. Admission failures never authorize a downstream call. |

Principal coverage locations:

- `packages/gateway/test/hosted-dispatch.test.ts`
- `packages/gateway/test/store-conformance.ts:99–438`
- `packages/gateway/test/postgres-store.test.ts:22–343`
- `packages/gateway/test/safe-fetch.test.ts`
- `packages/gateway/test/safe-connection.test.ts`
- Existing gateway/MCP authorization, cancellation and replica tests

These cases are wired into ordinary gateway tests and the separately mandatory PostgreSQL/MVP gates, rather than being documentation-only acceptance claims.

## Focused lifecycle and fault findings

- **Cancellation and whole-request timer:** ingress establishes cancellation and the whole-request timer before workspace authentication/body parsing. HTTP preflight receives that signal; MCP uses request-owned SDK cancellation. A late authentication/admission continuation cannot legitimately proceed to host dispatch after cancellation.
- **Late admission and drain:** admission enters `inFlight` before awaiting the store. If admission completes after cancellation/deadline, its continuation records unknown completion instead of dispatching. Tests cover both deadline and shutdown boundaries.
- **Completion timeout/outage:** the caller’s completion wait is separately bounded; an eventual completion remains tracked for drain. Known results survive rejection or delay. An unavailable completion store leaves the authoritative intent recoverable as unknown.
- **COMMIT ACK and connection events:** the wire proxy drops PostgreSQL’s acknowledgement after commit. Its test verifies one quota increment, one incomplete unknown intent and zero host calls. Checked-out client and idle-pool error handling prevents the exposed connection event from becoming an uncaught process error, without raw driver logging or transaction replay.
- **Unsafe addresses:** numeric parsing fixes the original zero-padded IPv6 documentation-range discrepancy. Every DNS answer must pass validation, and the connection uses a pinned validated address while retaining the original TLS hostname.

## Residuals — not M07 blockers

1. **M08 cooperative execution boundary.** Gateway cancellation/lease expiry does not forcibly stop arbitrary customer code or guarantee app transaction cancellation. The documentation correctly distinguishes admission leases from still-running customer execution.
2. **M09/M17 provider qualification.** Controlled cold delay and mocked HTTPS lookup are not actual zero-instance, cloud latency, provider-egress or live TLS qualification. A controlled wrong-certificate/socket-cancellation fixture would strengthen transport regression coverage, but its absence does not invalidate the reviewed Node HTTPS defaults.
3. **Operator deployment and audit lifecycle.** Migrate the two new tables before rollout using maintenance authority. Runtime remains DML-only. Retention/export scheduling, growth monitoring and failed-completion monitoring require external/operator controls; automatic enforcement is not claimed.
4. **Recovery remains application-assisted.** There is no public outcome-query endpoint or app-level idempotency mechanism. Unknown calls require authorized audit/application-state correlation; a new request ID is not permission to replay.
5. **Additional test hardening.** More barrier/fake-clock coverage for short-delay tests and expanded address-policy fixtures would improve determinism and maintenance. These are follow-ups, not missing M07 acceptance cases.

## Final evidence conditions

Before changing M07 from **IN_REVIEW** to **DONE**:

1. Require clean **exact-candidate Node 22/24 CI** for quality/build/package checks, mandatory PostgreSQL/MVP suites and packed/distributed E2E; **zero required skips**.
2. Retain sanitized artifacts and the run URL explicitly bound to  
   `11f56b99061be30366ccb42b7fd5dc0a15aa9c95`.
3. Reconcile the artifacts with the reported hardened local results: **270 mandatory MVP passes**, including **43 gateway-store passes**, plus **36 runner negatives**. The reported optional workspace result is **359 passes / 11 optional DB skips**, not mandatory DB evidence.
4. Record this review, accepted disposition, residual ownership and fixture cleanup evidence. Any code change requires review of the new candidate.

**Final disposition: ACCEPT the frozen M07 code candidate. Keep task completion evidence-pending until exact-candidate CI and evidence bookkeeping are accepted.**
