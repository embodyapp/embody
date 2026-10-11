# M05 independent local review — 2026-10-11

Separate Claude Code read-only review sessions used only Read/Grep/Glob tools. Reviewers
made no edits, ran no tests and contacted no cloud. Retained verbatim reports:

1. [Runtime review](./M05-review/01-runtime-review.md): no critical auth/gateway/host defect;
   conditional local acceptance; required documentation consistency and candidate reruns.
2. [Probe review](./M05-review/02-probe-review.md): runtime code accepted subject to CI;
   identified false-green gaps in the new qualification tooling.
3. [Probe recheck](./M05-review/03-probe-recheck.md): remaining foreign-secret mutation and
   PostgreSQL `name[]` parser conditions, plus other-app/config correlation hardening.
4. [Resolution/accepted tooling](./M05-review/04-accepted-tooling.md): both blocking
   conditions resolved, recommended hardening present; **local tooling accepted**.

## Fixes and integrator verification

- Metadata provider issuance allows five seconds of clock skew with strict expiry; Embody
  principal verification remains zero-tolerance and requires explicit `kid`.
- Gateway public JWKS → real host HTTP/SSE/MCP round-trip, provider/principal separation,
  forced delegated MCP, unsigned/missing-kid/array-audience and hosted verifier override
  adversaries. Mandatory DB/MVP CI covers both supported Node majors.
- Runtime probes use real metadata identity, own secret/IAM/DB positive controls, deny
  foreign secret access **and mutation/regrant**, test all six identities for access/ID-token
  minting, implicit delegation, signing/actAs/key/policy authority, test project/service/
  artifact permissions, and require actual IAM denial rather than a disabled API.
- Authenticated non-gateway own/other-app invocation negatives, principal JWT/provider
  confusion negatives, and gateway positive controls for both target apps. Both reports
  bind the same canonical fixture config digest and target origins.
- SQL inspection uses `rolname::text` and rejects elevation, replication, memberships,
  CREATE and object ownership. Actual exported inspector/classifier executes against real
  PostgreSQL within the existing mandatory gateway test, proving runtime inspection,
  FATAL CONNECT denial and elevated migrator rejection. Query-stage errors cannot masquerade
  as CONNECT denial. Both CLIs remove stale success files before prerequisite checks.

Integrator reruns: supported Node24 `pnpm verify` (281 Vitest cases/11 optional DB skips,
runner23) and mandatory `pnpm test:mvp` **156 passed/zero skips**, including actual PostgreSQL
SQL parser/classifier coverage. Earlier candidate `07d9684` passed all eight checks in
[CI38150639785](https://github.com/embodyapp/embody/actions/runs/38150639785); downloaded and
inspected Node22/24 mandatory156/zero-skip and clean packed/distributed reports, not just
job summaries. Its synthetic checkout `0fa33fd4` has the exact same Git tree as that
candidate. Probe hardening after that candidate requires a fresh exact-candidate CI run.

## Explicit boundary

**No reviewer accepted M05 DONE or live IAM qualification.** All reviews agree actual
provider evidence is missing. The scripts are accepted as tooling only, with independently
corroborated target inventory/IAM/DB grants, immutable source/build/image provenance,
external ingress, live multi-revision rotation and cleanup/cost evidence still required.

No dedicated cloud project, provisioning credentials or approved positive spending ceiling
is available. M05 remains blocked on those owner inputs and the subsequent real acceptance
runs. M09/M17 still own broader provider/database/cost/full-hosted qualification. This is
independent automated review and integrator verification, not human or release approval.
