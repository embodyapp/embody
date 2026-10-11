# M04 independent automated review — 2026-10-11

Reviewer: separate Codex CLI process in a read-only sandbox. Reviewed implementation against M04.a–d, M02 opaque identity/permission contracts, new workspace documentation, all new store/route source, shared and real PostgreSQL conformance, CLI/bootstrap/fixture/runner/CI changes. Automated review, **not human approval**. The reviewer did not execute service-backed tests or inspect credentials/environment/auth state or perform remote writes.

Initial decision: **ACCEPT for M04**, no blocking correctness/security findings. Two nonblocking coverage suggestions: forced ALS interleaving, and independent opaque app authorization inside a workspace even with broad namespace scopes. Both implemented: the conformance test uses a snapshot barrier and associates each dispatch response endpoint with its workspace; another uses wildcard scopes plus an exact single-app grant and denies discovery/dispatch of the other opaque app identity.

Also added actual compiled hosted-bootstrap and warm closed-pool failure tests. Discovery of unavailable records is a trusted factory option, not a caller registration flag; legacy TTL-bypass payload regression added. Re-reviewed the final implementation.

## Final reviewer decision (verbatim)

> **Automated code review: ACCEPT for final M04 code.** No blocking correctness or security defect found in the working-tree implementation versus `main`, reviewed against `WORKSPACES.md` and `IMPLEMENTATION.md`.
>
> - Both prior coverage suggestions are addressed.
> - ALS wraps Fastify’s request continuation; SDK MCP callbacks and async stream iteration retain that request context. Session pinning prevents credential/workspace/revision substitution.
> - Unavailable-record discovery is a trusted gateway option, forced by the hosted factory. Legacy registration payloads cannot bypass TTL filtering.
> - Real PostgreSQL tests exercise compiled hosted startup and warm closed-pool failure; hosted sanitization overrides requested development rendering.
> - Mandatory runners reject missing configuration, empty reports, failures and skips.
>
> **Final clean-CI acceptance remains pending:** the latest discovery-option rerun and exact committed candidate’s Node 22/24 CI, packed baseline and mandatory zero-skip gates. Reported local counts were not independently executed.
>
> Review remained read-only, with no credential/environment/auth inspection or remote/service actions.

Integrator then reran the final local Node24 `pnpm verify` and mandatory MVP suites successfully (261 optional-layer Vitest passes/11 DB skips + runner17; MVP130 with zero required skips). Exact committed candidate CI and final acceptance are recorded separately in dated M04 evidence. Local reviewer outputs: `/tmp/m04-independent-review.md`, `/tmp/m04-independent-final-review.md`, corresponding `*-agent.log` files. M05/M06/M07/M12 qualification was not claimed or treated as a completed requirement.
