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
| Kanban reference behavior | 10 | Domain and distributed tests | `examples/kanban/test/plugin.test.ts` — `Kanban reference plugin` |
| Email/reference cross-app event | 6, 10 | Relay/restart/idempotency tests | TBD |
| Audit and rate limiting | 7, 12 | Outcome/redaction/isolation tests | TBD |
| App-owned GenUI view/action bindings | 14 | Manifest fixtures, compile-time props compatibility, boot rejection, enriched-registration parity | `docs/implementation-plan/14-generative-ui.md` — P14-01/P14-03 |
| Standard web, Markdown, and text renderers | 14 | Shared fixture corpus, semantic DOM/golden fallback, accessibility/keyboard and XSS/CSP tests | `docs/implementation-plan/14-generative-ui.md` — P14-02 |
| MCP Apps resources and tool presentation | 14 | Official MCP client plus reference-host capability/resource/result contract suite | `docs/implementation-plan/14-generative-ui.md` — P14-04 |
| Same-principal allowlisted UI interactions | 5, 7, 14 | App-originated tool-call auth/scope/hook/audit/isolation/cancellation E2E | `docs/implementation-plan/14-generative-ui.md` — P14-04 |
| Standalone browser fallback | 9, 14 | Loopback short-lived capability, headers/CSP/replay/lifecycle and packed-browser E2E | `docs/implementation-plan/14-generative-ui.md` — P14-05 |
| Native Pi GenUI adapter | 14 | Built-extension install, width/theme/keyboard/mode/lifecycle tests and cross-renderer journey | `docs/implementation-plan/14-generative-ui.md` — P14-06 |
| GenUI fallback and cross-harness parity | 8, 10, 14 | Kanban plain MCP/MCP Apps/browser/Pi/CLI semantic and final-state E2E | `docs/implementation-plan/14-generative-ui.md` — P14-07 |
| Source-available/commercial licensing and viability | 13 | Ownership review, dual-license scenario tests, package/container inspection, SBOM, attribution, entitlement tests, and purchase-path rehearsal | `docs/implementation-plan/13-commercial-licensing.md` — licensing decision and commercial launch gates |

## Review rule

A row can be marked complete only with a stable source link and at least one named automated test (or an explicit documentation/review artifact for non-executable requirements). Any approved deviation must link its ADR.