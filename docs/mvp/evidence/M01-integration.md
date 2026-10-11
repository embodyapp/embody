# M01 integration report

**State: IN_REVIEW, not DONE.** Owner: pi. Review began 2026-10-08; final local evidence recorded 2026-10-10. Independent review and combined-branch CI are pending. No remote PR was merged, closed or pushed by this work.

## Candidate and preserved work

- Branch: `feat/mvp-m01-integration`.
- Worktree: sibling `../embody-mvp-m01`, sharing the original repository's Git objects/history.
- Base: `origin/main` at `c07d6ffd0a72dadead28af8cc3e9a7a7c8a89ca4` (PR #28).
- Original checkout remains on `main` at `a7643d3f74dfff74087ddbe98f58b9093f21d563`. Its `.gitignore` and uncommitted docs were preserved; only its MVP status/report were updated to show progress.
- Integrated code/test candidate: **`d295465abeb4927a590ea8e38a052db513bf0ebf`**. Later commits in this branch reconcile planning/status/evidence only; any later code change needs applicable reruns.
- Lockfile SHA-256: `6e8425a008199a51333210f865f54a2483e19ba94d9359b82acc0cc84a310feb`.
- Core API report SHA-256: `34d7787b9ac78d0327f9edd58d4a3f80e146d3d82060e602b27299dfedafb47f`.
- No production/cloud image, schema migration or IaC candidate is claimed. Local Compose builds test images only.

## Reviewed and reused commits

Source commits were cherry-picked with `-x` to retain provenance, not squashed or remotely merged.

| Source | Reviewed SHA | Local integration | Outcome |
|---|---|---|---|
| #29 / P15-01 | `a7d692aecf6a14e7ba18ea14e645d004581ca5ef` | `ea4631c` | Shared dispatch/error/audit/limit foundation included |
| #30 / P15-02 | `847b5acde0a62856550572558b9ede1d630d5b0d` | `d7b2a17` | Action/app metadata included; one import conflict resolved without restoring unused `UnavailableError` |
| #31 / P15-06 | `5168d847b775880a862b2730f492bb29f173aae7` | `8358e5e` | Delegated-agent attribution included after #29; API report combined cleanly |
| #32 / ADR acceptance | `df8df1ea2403a71f22ab8b6d82ef836a549279d0` | `75c8050` | Accepted design retained |
| #32 / workspace amendment | `7d7a403d42c3f4ec96d369143338174ac0a2d467` | `558bffa` | Workspace terminology retained |
| #32 / sleep/MVP plan | `8048ddabe039215546cdccd1e35a2d8bf01476f2` | `2ec5257` | Broader roadmap retained; Amendment 2 scopes first hosted release |

All four PRs were open and their individual checks were green at the review snapshot. Those checks are **not** evidence for the combined candidate, and the dedicated Postgres job can skip tests (M03).

### Work deliberately not integrated

- GenUI implementation `ec7ca78f330c14e41ca6562b5558a57e293cdc30` remains on its branch. Local tip `ba249fc10f73af75b7e7344801f9e298c1fd788e` includes WIP theme/layout; remote tip `ef419be52301980b7de3914c208f68e53486dc0e` includes dependency merges. Neither was reset or overwritten. The request-only, non-UI MVP does not require this work.
- Hosting plan `862ce9c51288e7d48546111a46ff156f1f1c80e2` remains documentation on `docs/cloud-run-hosting-plan`. Its ADR numbering is already committed. The mapping below reuses its design without claiming its 42 tasks are implemented.
- Landing and broader workflow feature work remain outside M01. No worktree cleanup or branch deletion was performed.

## Review findings and corrective changes

### 1. Authentication failures were not audited on every execution surface

P15-01 audited invalid credentials on JSON execution, but streaming/MCP authentication failed before the shared dispatch pipeline and emitted no audit record.

- Added one shared surface-authentication helper for JSON, stream and MCP routes.
- Denied requests produce one bounded failure record without inventing an authenticated actor or contacting a host.
- Regression first failed for stream and MCP, then passed after the fix.
- Tests: `packages/gateway/test/dispatch.test.ts`, parameterized authentication-denial cases.

This is parity for those gateway routes, not a claim that every possible MCP protocol rejection is action-audited or that audit is durable; durability remains M07.

### 2. Generated updates incorrectly claimed idempotency

`Store.applyUpdate()` executes lifecycle hooks and publishes `*.updated` even for an identical patch. Generated updates and Kanban bulk moves therefore must not automatically advertise `idempotent: true`.

- Removed automatic update idempotency and the example bulk-move claim.
- Retained optional custom-action metadata; documented that it is not a durable retry guarantee.
- Core metadata regression first failed, then passed.
- Extended real SQLite CRUD coverage to repeat a patch and assert duplicate update hooks/events while manifest idempotency stays absent.
- Fixed an existing flaky assertion in that test: outbox timestamps can tie within a millisecond, with UUID ordering as the tie-breaker. Exact hook order remains asserted; event verification now compares the exact multiset, including duplicate updates, rather than assuming temporal order not guaranteed by the API.

No mutation retry engine was added; M07 owns ambiguous-outcome/idempotency semantics.

### 3. Compose initialization relied on an executable bind mount

Fresh E2E reproduced PostgreSQL startup failure: `/bin/sh: bad interpreter: Permission denied` while executing `init-databases.sh`.

- Replaced the two-database shell initializer with equivalent SQL loaded by the PostgreSQL entrypoint.
- Updated the Compose mount and removed the unused shell script.
- This pulls forward only the previously identified SQL init-file repair from M03; M03's CI/role/test-runner work remains open.
- The subsequent distributed journey passes without an uncommitted local patch.

### 4. Combined wire-path coverage

Added `packages/gateway/test/integration.test.ts`, using a real kernel, listening HTTP app host, signed downstream JWTs and official SDK MCP client:

- App/action metadata survives registration and discovery.
- A human HTTP action stays human; the same credential over MCP becomes a delegated agent and triggers an agent-only veto.
- Verified client identity, not MCP's self-reported label, reaches the host/audit.
- JSON, stream and MCP preserve validation failures and one failure audit per call.
- JSON/stream share actor limits; MCP limits are applied to the delegated actor before execution.

The fixture has no entities and a minimal transaction adapter. It is wire/authorization regression evidence, **not PostgreSQL or hostile-tenant isolation evidence**. Existing distributed E2E provides separate real PostgreSQL coverage.

## Fresh verification

Environment: macOS arm64; downloaded official Node binaries with SHA-256 checked against their distribution checksum files; Node **22.23.3** and **24.21.0**; pnpm **11.25.0**; Vitest **4.1.11**. SDK remains the baseline/integrated lockfile version (1.32.1 for gateway tests); no optional major toolchain upgrade was taken. Docker server **29.8.2**, Compose PostgreSQL **16.15** observed during the initial run.

| Check | Result | Limit / notes |
|---|---|---|
| Frozen install on Node 24 | PASS | `pnpm install --frozen-lockfile` |
| Red tests: surface auth audit | Expected FAIL | Two cases missing audit before fix; 16 other dispatch cases passed |
| Red test: generated update idempotency | Expected FAIL | Existing manifest incorrectly returned `true` |
| Gateway combined suite | PASS | 31 tests across 4 files, including 3 real-host integration tests |
| `pnpm verify`, Node 24 | PASS | **193 passed, 8 PostgreSQL environment-gated skips**; lint, boundaries, skill, license, typecheck, builds, API report, format |
| `pnpm verify`, Node 22 | PASS | **193 passed, same 8 skips**; native SQLite rebuilt for the runtime |
| `pnpm test:e2e`, Node 24 | PASS after SQL fix | Distributed CLI/MCP/HTTP, events, restart, TTL, tenant/scope/audience checks on Docker/PostgreSQL |
| `pnpm test:e2e`, Node 22 | PASS | Same actual Compose journey on the committed code candidate; app image runtime remains the Dockerfile's Node version |
| `pnpm test:consumer`, Node 24 / npm 11.19.0 | PASS | External tarball install, scaffold, typecheck, test and build |
| `pnpm test:consumer`, Node 22 / npm 10.9.9 | FAIL, tooling | npm Arborist `Cannot read properties of null (reading 'edgesOut')` during install |
| `pnpm test:consumer`, Node 22 / npm 11.19.0 | PASS | Matches the existing CI requirement to use npm 11; no global npm upgrade performed |
| `pnpm install --lockfile-only --ignore-scripts` | PASS, unchanged lockfile | Revalidated integrated dependency graph; no dependency-upgrade churn |
| `pnpm audit --prod --audit-level high` | PASS | No known vulnerabilities reported at run time; not a future guarantee or development-tool audit |
| `pnpm api-report` inside both verifies | PASS, unchanged combined API report | No hand-edited API snapshot required |

An early aggregate attempt was interrupted at the harness timeout; it is not counted as a pass. A new integration-test type error was corrected before the successful runs. The first full suite also exposed the timestamp-ordering flake described above; final counts come from reruns after correction.

Raw local execution logs are under `/tmp/embody-m01-review/` and are disposable; this report records reproducible commands and results. Attach CI run URLs/artifacts before final acceptance. No raw credential-bearing logs are committed. E2E teardown removed its containers/volumes; no cloud resources were provisioned.

### Reproduction

On this branch, use a supported Node runtime and pnpm 11.25.0. Rebuild native dependencies when switching Node ABIs. Use npm 11 for packed consumer tests, as CI does.

```sh
pnpm install --frozen-lockfile
pnpm rebuild better-sqlite3  # when changing Node versions
pnpm verify
pnpm test:e2e               # Docker required; disposable Compose resources
pnpm test:consumer          # npm 11 on PATH
pnpm install --lockfile-only --ignore-scripts
pnpm audit --prod --audit-level high
```

**Do not reinterpret eight skips as passing Postgres conformance.** The dedicated CI job needs explicit `EMBODY_POSTGRES_URL`, migration/runtime-role setup and fail-on-missing configuration in M03. Passing Compose E2E does not replace those eight cases.

## Dependency/security triage

| Work | Decision |
|---|---|
| #12 / #17 security updates | Already inherited from `origin/main`; retain patched baseline and existing documented build-only exceptions |
| #18 / #20 Actions and Dependabot policy | Already inherited; no additional upgrade required |
| #21 patch/minor group (`6065d6c`) | Green at snapshot; defer independent maintenance merge until after combined review; not required to make M01 pass |
| #22 Vite 8, #23 ESLint 10, #24 Vitest 5, #26 Changesets 3 | Green individually; intentionally defer unrelated major migrations |
| #25 Node 26 types, #27 TypeScript 6 | Failing at snapshot; do not integrate unsupported toolchain changes into this task |

No Dependabot PRs were closed and no security alerts were dismissed. Reassess fresh audit results before release.

## Mapping: implement once

| Minimal task | Reuse broader work | Scope difference / remaining work |
|---|---|---|
| M01 | P15-01/02/06, #32 | Combined locally with review fixes; final review/CI pending |
| M02 | CH1-04; Phase 15 contracts | Request-only hosted profile; no automatic broader capability support |
| M03 | Existing CI/E2E; CH1-01 | SQL initializer fixed here; explicit non-skipping DB gate/roles and MVP runners still needed |
| M04 | P15-05/08; CH5-05 registry slice | One workspace-scoped durable store; do not build parallel registry systems |
| M05 | P15-09/12; CH2-04 | Asymmetric app/workspace binding, provider IAM and private ingress; not delivered by the current HS256 foundation |
| M06 | P15-04; minimal P15-03 | Stateless MCP and one verified client; compact discovery and OAuth deferred |
| M07 | P15-01/10/14 dispatch portions; CH5-05/CH7-05 | Durable quotas/audit and proven safe retry; no wake sweep for unsupported jobs |
| M08 | P15-15/CH9-01 portions | Request-only host; reject workflows/subscriptions; settle generated outbox semantics explicitly |
| M09 | CH1-03, CH3-01…04 | Real provider/database/isolation qualification and approved costs |
| M10/M11 | CH4-01/03/04 | Isolated user-source build, one recipe; no GitHub App integration |
| M12/M13 | CH5-01…04 | Durable deploy controller, fenced promotion and safe rollback; independent external recovery still required |
| M14/M15 | CH6-02, CH2-05, CH7-04/05 slices | CLI/control API; provisioned keys, no OAuth login or console |
| M16 | CH7-03/04/05, applicable P12/P13/CH8-03 | Restore, export, runbooks and customer-data approvals remain launch gates |
| M17/M18 | P15-11/16, CH9-06/07, applicable CH8 gates | Actual gateway/app zero proof for request-only scope; no claim broader hosted workflows pass |

Deferred explicitly: P15-07 OAuth, P15-13 app-to-app RPC, compact discovery/team UI, hosted background events/workflows (including due-work scheduling/version wake), GenUI, previews and billing automation. Broader plans retain their acceptance criteria for when those capabilities are offered.

## Historical local acceptance assessment (superseded by the update below)

- **M01.a:** locally demonstrated on both supported Node versions; attach combined CI before acceptance.
- **M01.b:** locally demonstrated by dispatch, attribution, rate-limit, veto and new real-host integration regressions.
- **M01.c:** this report records exact integration/preserved-work provenance, scope mapping and fresh evidence.
- **Not yet DONE:** no independent reviewer, no remote CI for the combined branch, eight skipped standalone Postgres cases disclosed and handed to M03.

At that snapshot the next step was independent review and combined CI. Do not begin user hosting or label the gateway stateless/sleep-capable based on this integration alone.

## 2026-10-11 remote reconciliation and acceptance fixes

- Integration [PR #33](https://github.com/embodyapp/embody/pull/33) merged 2026-10-11 at `024df01acf7b7460275c59eefb6321105a32687a`. CI-tested head was `c0d7eccdb680c36289357e1f1851f8906587c007`; head and squash merge have identical tree `bdac854c9c44e537a44dd8bdbea46b8a3e987ea1`.
- Combined [CI run 38127104108](https://github.com/embodyapp/embody/actions/runs/38127104108): quality Node 22/24 and e2e-artifacts passed (packed consumer and actual distributed Docker/PostgreSQL journey). Standalone postgres job was green with **all 7 selected tests skipped**, not conformance evidence. M03 remains open.
- PRs #29/#30/#31/#32 remain OPEN as of this reconciliation; their integrated source SHAs are in the provenance table above. Their contents were reused through #33, not separately merged; any newer work requires its own reconciliation. No branch/worktree deleted and no redundant merge performed. GenUI/WIP histories remain preserved.
- Independent read-only automated review found HTTP/MCP normalization/audit gaps and incorrect stream-failure classification, then two further malformed-JSON/client-close paths. Fixed all with regressions; final [independent reviewer decision: ACCEPTED](./M01-independent-review-2026-10-11.md). This is an automated code review, not a claim of human approval.
- Fresh acceptance-fix candidate on `feat/mvp-m02-contracts`: Node 22.23.3/24.21.0 `pnpm verify` each passed with **241 passed, 8 existing optional Postgres skips** (includes 38 new M02 contract tests); gateway suite **41 passed**. Local Docker E2E passed again: CLI, MCP, HTTP, events, restart, TTL and isolation.
- Exact followup candidate CI/PR and final task acceptance are recorded in the final acceptance addendum after CI completes. Until then M01 remains IN_REVIEW. The skipped standalone DB gate does not block this integration task's documented contract but continues to block M03/release verification.
