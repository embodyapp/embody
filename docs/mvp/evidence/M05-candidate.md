# M05 local candidate acceptance — 2026-10-11

## Exact implementation and CI

- Draft PR: [#37](https://github.com/embodyapp/embody/pull/37), `feat/mvp-m05-identity`.
- Final implementation candidate: `fae51690ea45f04a3073d3ef1b1c37732d2c7d52`.
- [CI38154874184](https://github.com/embodyapp/embody/actions/runs/38154874184): all **eight**
  checks passed: quality22/24, mandatory PostgreSQL/MVP22/24, packed/E2E22/24 and the two
  fail-closed stable aggregates.
- Downloaded/inspected reports and logs. CI synthetic merge
  `a8e938bee949b854787e796566950005b9069574` has the **identical Git tree** to the candidate
  (`17ea6f380df4e920528986110549eddbb58618cd`), verified by fetching the PR merge ref.
- [Independent automated local review](./M05-independent-review.md): runtime code and
  probe tooling accepted after documented fixes. No human/provider acceptance claimed.

| Gate (both Node majors) | Result |
|---|---|
| Quality | 281 Vitest cases passed; 11 explicitly optional app DB skips; runner23 passed; lint/typecheck/build/API/format/license passed |
| Mandatory MVP | **156 passed, 0 failed, 0 skipped** |
| MVP breakdown | appDB12 + real gateway-store22 + contracts38 + auth6 + host14 + gateway64 |
| Packed consumer | 1 clean external-consumer journey, zero failure/skip |
| Distributed Docker E2E | 1 real CLI/MCP/HTTP/events/restart/TTL/isolation journey, zero failure/skip |

Native PostgreSQL coverage includes the actual exported runtime SQL inspector/parser and
CONNECT-stage classifier, not just mock-tagged errors. No live Google API call is part of
these CI results. Six qualification-tool failure tests are mocked/unit cases within runner23,
not provider evidence.

Sanitized immutable-image/DB-version/count/hash reports are retained in
[M05-ci-38154874184/](./M05-ci-38154874184/), with clean (`dirty: false`) checkout identity
and matching lockfile hashes. Earlier local dirty reports remain historical diagnostics.
This evidence/status archival commit changes documentation only; PR checks additionally
rerun on that evidence-only head, with no implementation waiver.

## What prevents DONE

No approved dedicated cloud project, provisioning access or positive spending ceiling is
configured. **M05 remains BLOCKED.** Owner inputs must authorize a disposable fixture,
after which actual runtime metadata/IAM/SQL, private/authenticated/external ingress and
multi-revision key rotation must pass [the provider procedure](../M05-PROVIDER-PROOF.md).
Retain corroborated resource/policy/DB grants, exact source/image/revision provenance,
matching probe config digests, cleanup and costs. Tooling availability, review and green
local/CI jobs do not establish those live outcomes.

No cloud resources were created or spending authorized. M09/M17 still own broader provider,
database, cost, zero-instance and full-hosted release qualification. No task dependencies
or acceptance cases were weakened to obtain a DONE label.
