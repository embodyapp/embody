# Specification traceability

Use this matrix during review to prevent a green implementation from omitting a specified capability. Update links to actual tests as they are created.

| Spec requirement | Primary phase | Planned proof | Implementation/test link |
|---|---:|---|---|
| Three-tier topology and central gateway | 7, 10 | Distributed E2E topology | TBD |
| Push registration and 30s heartbeat/90s TTL | 5, 7 | Fake-clock registration/health tests | TBD |
| Gateway execution dispatch/token exchange | 5, 7 | Authenticated dispatch E2E | TBD |
| Plugin contract and dependency graph | 1, 3 | Type tests, graph property/fault tests | TBD |
| Seven-phase deterministic boot | 3 | Phase recorder and fault injection | TBD |
| Services and `KernelContext` | 1, 3, 5 | Type/service/request-isolation tests | TBD |
| Synchronous vetoable hooks | 3, 4 | Ordered veto/rollback tests | TBD |
| Workflow SPI | 0, 11 | Explicit deferral or durable workflow state-machine suite | TBD |
| PostgreSQL JSONB/SQLite entity storage | 2, 4 | Shared adapter conformance | TBD |
| Zero-DDL entity field evolution | 4 | Schema evolution integration test | TBD |
| Five generated CRUD actions | 4 | Registry/manifests/CRUD suite | TBD |
| Filtering/sorting/pagination | 2, 4 | Cross-adapter behavior/injection suite | TBD |
| Gateway auth provider plugins | 7 | API key/OIDC contract tests | TBD |
| App verifier plugins and Principal | 5 | JWT claim/negative suite | TBD |
| PostgreSQL RLS | 2, 11 | Raw SQL tenant escape tests | TBD |
| Unified CLI hierarchy/discovery | 8 | Spawned built CLI suite | TBD |
| Global and app-scoped MCP | 8 | Official MCP client contract suite | TBD |
| Zod-to-JSON-Schema translation | 1, 8 | Golden + acceptance parity corpus | TBD |
| MCP progress notifications | 8 | Concurrent token/order/cancel tests | TBD |
| Transactional outbox | 2, 4, 6 | Atomic commit/rollback tests | TBD |
| Concurrent `SKIP LOCKED` worker | 2, 6 | Real PostgreSQL contention test | TBD |
| Retry/backoff/dead-letter | 6 | Fake-clock worker suite | TBD |
| SSE progress | 6, 8 | Wire/backpressure/cancel tests | TBD |
| `create-embody-app` | 9 | External packed-project smoke | TBD |
| `embody dev` and inspector | 9 | Process + browser security tests | TBD |
| `@embody/testing` under-10ms goal | 9, 11 | Functional suite + benchmark | TBD |
| Kanban reference behavior | 10 | Domain and distributed tests | TBD |
| Email/reference cross-app event | 6, 10 | Relay/restart/idempotency tests | TBD |
| Audit and rate limiting | 7, 12 | Outcome/redaction/isolation tests | TBD |

## Review rule

A row can be marked complete only with a stable source link and at least one named automated test (or an explicit documentation/review artifact for non-executable requirements). Any approved deviation must link its ADR.