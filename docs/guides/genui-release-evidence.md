# GenUI — scoped completion and release evidence

**Technical review: 2026-10-04, `pi`, under the owner's delegated implementation/scope decisions.** P14 increments A and B are complete for the subset below. This is a technical feature gate, **not public publication approval**: Phase 11–13 operational, ownership, commercial and legal gates remain independent. No package was published and no vendor certification was performed.

## Approved scope and compatibility

| Surface | Verified versions/environment | Verified behavior | Limits |
|---|---|---|---|
| MCP Apps reference host | Stable `2026-01-26` protocol; ext-apps **1.7.5**; MCP SDK **1.30.0**; Chrome **154.0.8037.97**, Playwright **1.58.2** | Official App/AppBridge initialization in an opaque iframe; registered resource and direct props; allowlisted action; veto/correction/refresh; minimal ordered outcomes reaching the next Pi provider request | Reference-host support only. Claude, ChatGPT, Codex and other vendor products are **not certified**. Host supplies authentication, sandboxing and verified outcome publication or explicit agent reconciliation. |
| Native Pi | Public SDK/TUI and actual CLI **1.0.0**, Node **22.23.3 / 24.21.0** | Authenticated discovery/dispatch, native Kanban keyboard journey without browser, focus/width/redaction/recovery, next-provider-request context, installed extension, deterministic non-TUI degradation, disposal | Real CLI OS-PTY checks in fullscreen/dark and regular/light, resized 80→30 columns. Not physical-terminal, screen-reader or IME certification; no arbitrary Pi-version claim. |
| Standalone browser — increment B | Chrome **154.0.8037.97**, same packaged classic renderer | One-time fragment handoff; allowed mutation and veto; refresh/review; unsaved-draft navigation warning; expiry/revocation/purpose/isolation/CSRF/Host/Origin tests | **Development loopback only**, maximum 100 sessions, bounded expiry/requests. No production browser authentication/session mechanism. Manual authoring requires an explicit agent read after mutations unless a verified host outcome publisher is supplied. |
| Plain clients | HTTP, CLI, official non-Apps MCP; Markdown/plain text | Equivalent ordinary domain results/final state and useful noninteractive output | No UI capability required; no changed action result envelope. |
| Database/runtime | Node **22.23.3 / 24.21.0**, SQLite fixtures and PostgreSQL **16.14** | Same real agent-principal Kanban journey through all surfaces; PostgreSQL storage, RLS and kernel adapter regression | PostgreSQL run with a **non-owner, NOSUPERUSER, NOBYPASSRLS** runtime role. Docker Compose/image certification was not rerun: Docker is unavailable here. |

All 14 standard nodes ship. Native layout is a semantic summary, not browser layout parity. Custom HTML runtime, broader components, durable browser workspaces, rich inspector/scaffolder automation and optimistic domain concurrency remain deliberately deferred. Refresh/review does not prevent lost updates because Kanban has no expected-revision write contract.

## Interaction contract approval

[The reference journey](genui-reference-journey.md) is the accepted contract. The initiating agent retains its org/actor/scopes; a human driving the controls does not become a human principal. The existing agent-only PR hook is unchanged, including separate human-principal behavior.

Consequential outcomes are bounded/redacted and ordered; local editing/navigation does not enter extra conversation context. Cancellation/disposal/generation invalidation suppress late props and mark an ambiguous mutation uncertain, not rolled back. Another mutation requires authoritative reconciliation. Confirmed mutations remain confirmed when a subsequent refresh fails, but submission is blocked until recovery. Failed reads visibly invalidate the snapshot. Dirty draft replacement requires explicit review/discard; Pi Escape requires a second explicit Escape to discard, and browser navigation uses `beforeunload` where the browser permits it. Forced host dismissal/process exit cannot be vetoed and never promises draft persistence or rollback.

## Reproduction and results

Use pnpm **11.25.0**, one of the supported Node versions, and managed Playwright Chromium or `CHROME_PATH`. Build artifacts—not dev aliases—are used for browser and consumer checks.

```sh
# Required database gate: isolated PostgreSQL 16+ test database, pre-migrated by
# a maintenance role; URL belongs to a non-owner/NOSUPERUSER/NOBYPASSRLS role.
# Do not put credentials into source control, transcripts or command arguments.
export EMBODY_POSTGRES_URL='<runtime test URL>'
export EMBODY_POSTGRES_SKIP_SCHEMA=true
pnpm test:genui-release

# Individual gates
pnpm test:genui-postgres
pnpm test:genui-journey
pnpm --filter @embody/genui test:browser
pnpm test:genui-consumer --browser
pnpm test:genui-terminal
pnpm test:genui-performance
pnpm security:audit:production
pnpm run sbom
```

`test:genui-postgres` **fails if its database URL is absent**; skipped database tests are not release evidence. The complete aggregate also runs full tests/builds, typecheck, lint/boundaries/skill validation, neutral core API report, license consistency and tarball inspection. Database fixtures use a unique journey org so gates can repeat safely on the same test database.

| Gate | Reviewed result, 2026-10-04 |
|---|---|
| Node 24 aggregate, with PostgreSQL configured | **Passed** `pnpm test:genui-release`; full workspace **286 passed, zero skipped**; core API report, full typecheck and lint passed |
| Node 22 workspace | **278 passed**, eight explicitly environment-gated database skips; separately executed PostgreSQL gate passed all eight PostgreSQL cases (nine storage/kernel cases including one SQLite case), plus authenticated three-surface journey |
| Built browser suite | **10 passed** on Node 22 and 24: every standard node, keyboard/axe serious-critical checks, hostile content/CSP, official opaque iframe, lifecycle and recovery |
| Cross-surface domain proof | **Passed** SQLite and PostgreSQL: native Pi, temporary browser and official Apps, with HTTP/CLI/plain MCP final-state and actual next-provider-request outcomes |
| Packed browser/Pi consumer | **Passed** external install, public exports, packaged asset rendering, installed Pi manifest/load/disposal, on Node 22 and 24 |
| Real CLI terminal smoke | **Passed** both modes/themes on Node 22 and 24; veto/correction, secret masking, resize and orderly shutdown |
| Host/bridge failures | **Passed** resource substitution/size/outage/redirect/network/deadline/body cancellation; current authorization/generation checks; progress/cancellation; late success after cancel/dispose; bounded gateway shutdown |
| Fuzz/soak | **Passed** retained and seeded 1,000-iteration bounded parser corpus; 300 web/native lifecycle measurements; 10,000 single-view replacements; detached controls inert; browser 100-session bound and memory measurement |
| Artifacts/attribution | **Passed technical checks** all 11 publishable package tarballs; renderer pins/inventories/full license texts included; no fixture/secret sources in GenUI source maps; production CycloneDX SBOM generated. Not legal approval. |
| Production dependency audit | **Zero known vulnerabilities**, `pnpm audit --prod --audit-level low` |
| Screenshots | Reviewed wide/light and narrow/dark/reduced-motion all-node board/details/state captures: readable grouped tasks and labels, wrapped IDs, no horizontal clipping; semantic DOM/keyboard/axe remain the primary gate |

PostgreSQL evidence was obtained using an isolated temporary PostgreSQL 16.14 instance from `embedded-postgres@16.14.0-beta.17` outside the repository. A maintenance role migrated each fresh database and granted runtime DML/schema access; tests ran as the non-owner role. The server was stopped and its data removed afterward. This tooling is not a shipped dependency or a replacement for baseline container/crash-recovery evidence.

Machine-readable evidence and screenshot artifacts are under [`artifacts/genui/`](../../artifacts/genui/). Terminal evidence labels its PTY boundary explicitly. Re-run measurements on the target environment rather than treating one machine's timing as a service-level promise.

## Approved performance budgets

`scripts/measure-genui.mjs` enforces these budgets; exceeding one exits nonzero. Measurements use a 20-task real Kanban document, 30 render samples, ten authenticated resource samples, 100 concurrent browser leases and 300 web/native lifecycles. Heap deltas are post-GC retained heap, not process RSS. These are reference-machine regression ceilings, **not WAN/production latency guarantees**.

| Metric | Budget | Node 24 recorded baseline |
|---|---|---|
| ESM / classic / Kanban HTML assets | Each ≤768 KiB | 554,021 / 554,434 / 525,910 bytes |
| Cold authenticated discovery | ≤2,000 ms | 36.4 ms |
| Authenticated resource discovery/read p95 | ≤1,000 ms | 19.5 ms |
| First web render / update p95 | ≤250 / 100 ms | 4.4 / 4.8 ms |
| Markdown / native render p95 | Each ≤100 ms | 1.9 / 17.1 ms |
| 300 native lifecycles / retained heap | ≤5,000 ms / 16 MiB | 1,415 ms / 184,896 bytes |
| 300 web lifecycles / retained heap | ≤10,000 ms / 32 MiB | 917 ms / 104,096 bytes |
| 100 browser leases retained heap | ≤64 MiB | 1,989,936 bytes |

The companion Node 22 measurements pass the same ceilings. Baselines identify OS/architecture/browser/version and timestamps; asset/license inventories must be regenerated after dependency changes.

## Security and distribution decisions

- Fastify was raised to **^5.12.5**, and vulnerable transitive URI/network/glob/IP/HTML dependencies refreshed within compatible ranges. MCP Apps/MCP SDK and host-provided Pi pins were not changed.
- The **full development audit still reports** unpatched `braces@3.0.3` stack exhaustion, `GHSA-vfj7-8cjw-p6xm`. Accepted narrowly for trusted checked-in build/release glob patterns, outside the runtime/renderer input paths. Do not run release tooling on attacker-supplied patterns or untrusted repositories. No audit suppression was added; revisit when an upstream fix exists. The production audit has no findings.
- Bundle metadata reports declared licenses, but ext-apps' actual license text describes an MIT/Apache-2.0 transition and documentation terms. Full upstream license text is preserved; a metadata-only “all MIT” conclusion is **not** approved. Repository ownership, third-party legal review and publication remain Phase-13 gates.
- There are no advertised vendor products beyond the explicit reference-host scope, so no missing vendor smoke is silently treated as a pass. A new vendor/version, production browser deployment or custom runtime requires its own applicable release gate.
