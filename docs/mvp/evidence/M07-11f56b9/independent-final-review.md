# M07 independent final evidence/acceptance review

## Decision: **ACCEPT**

**Accept the frozen M07 implementation and its retained acceptance evidence. All M07.a–d are satisfied within M07’s controlled-fixture scope.** No mandatory code fix or acceptance rerun was identified.

**M07 may be marked DONE once the final evidence/status bookkeeping is recorded and its exact-revision CI passes.** At the reviewed snapshot, those bookkeeping conditions remain open; this is not an unconditional declaration that the tracker is already complete.

## Reviewed revisions and provenance

| Role | SHA |
|---|---|
| Evidence snapshot / reviewed HEAD | `645ff0e48887e1ccc48cbf179c78538f45e991b3` |
| Frozen code candidate | `11f56b99061be30366ccb42b7fd5dc0a15aa9c95` |
| Accepted M06 base | `06c4222d5673ab826d2095b11cd64a8a50b9e1cf` |
| GitHub PR test merge | `590434445716e0f4f48b989066267f4dfbb5203d` |

Independent Git inspection confirms:

- Candidate and PR test merge have the **identical complete Git tree**:  
  `d15c27a6abdd0b85891d3a6ba77cf61311e11eed`.
- `11f56b9..645ff0e` changes **only** `docs/mvp/STATUS.md` and files under `docs/mvp/evidence/`. No implementation, tests, workflow, lockfile or infrastructure changes.
- The reviewed worktree was clean at both status checkpoints.
- PR [#39](https://github.com/embodyapp/embody/pull/39) remains **OPEN**, stacked on `feat/mvp-m06-stateless-mcp`; its current head is `645ff0e`. The test merge SHA is **not evidence of a merge into main**.

## Evidence reconciliation

Reviewed the implementation/verification/testing criteria, `docs/mvp/DISPATCH.md`, `docs/mvp/STATUS.md`, both independent code reviews, the dated M07 evidence report, and all **16 retained gate JSON reports** under `docs/mvp/evidence/M07-11f56b9/`.

### Exact-candidate CI

Read-only GitHub inspection confirms [run **38455216022**](https://github.com/embodyapp/embody/actions/runs/38455216022):

- `headSha` is the frozen candidate.
- Run status is completed; conclusion is success.
- **All nine actual jobs succeeded**: Terraform, quality22/24, PostgreSQL matrix22/24, PostgreSQL aggregate, baseline matrix22/24, and baseline aggregate.
- The archived job names, statuses, conclusions, URLs and start/completion timestamps in  
  `docs/mvp/evidence/M07-11f56b9/ci-run.json` **match live GitHub data exactly**.

This establishes exact-tree candidate CI, not merely a green unrelated branch.

### Runtime and counts

All retained reports consistently bind local runs to `11f56b9`, CI runs to the identical-tree merge `5904344`, and declare `dirty: false`.

| Gate | Local Node22/24 | Candidate CI Node22/24 |
|---|---|---|
| Mandatory MVP | **270 passed / 0 failed / 0 skipped**, each | Same |
| Mandatory gateway-store | **43 passed / 0 failed / 0 skipped**, each | Same |
| Mandatory app PostgreSQL | **12 passed / 0 failed / 0 skipped**, each | Same |
| Packed/distributed baseline | **1 packed + 1 distributed journey**, no failures/skips, each | Same |
| Workspace regression | **359 passed / 11 optional DB skips**, each | Same |
| Separate runner negatives | **36 passed**, no failures/skips | Same |

The mandatory total reconciles exactly:

**12 app DB + 43 gateway-store + 38 contracts + 6 auth + 16 host + 18 MCP + 137 gateway = 270.**

I independently corroborated workspace and runner counts using local log summaries and candidate CI quality-job logs. The **11 optional workspace DB skips are not used as mandatory database evidence**. Runner36 is separate from both the 270 and 359 totals. Earlier 210/214/315 development counts are correctly labeled historical diagnostics, not final-candidate passes.

### Hashes and image identities

All 16 reports carry identical source hashes, independently recomputed from the reviewed files:

| File | SHA-256 |
|---|---|
| `pnpm-lock.yaml` | `9f862aa8602908a4934b9dcc20ded53d768ca5ef747c7e535cbba6726cb76990` |
| `packages/storage/src/index.ts` | `5b9f98f62202e5aa3c154a6d6e5487cd6198da4703e6638b4a1413c951b0b5e6` |
| `packages/gateway/src/store.ts` | `283dacac66f21a1cde30350a349cbe6dc47cee29003454a1ed45ba7d9f17e0e5` |
| `test/postgres/init.sql` | `5ee505a6ae07b9b1bfbb9a98493fa0495081732cf2ca423a42311e69f5dea580` |

The four baseline reports retain distinct E2E app image IDs:

| Execution | `embody-e2e-apps` image ID |
|---|---|
| Local22 | `sha256:baf66f8fb1e803630ab5c80310b7786e8f7488eeb70a409d352194d23b3ccc72` |
| Local24 | `sha256:f45a5413924000a24117b8f949d28f73247dafca80f73926dae28b7250829be7` |
| CI22 | `sha256:872dfd8cc1fcab29a3d396a185c5a0ae2be17f960b3e30af10bafb1b240b9f92` |
| CI24 | `sha256:fca90654ba6fe51bad941e25965b831bdd37ea63efd21da31b2c1d8adf9da9f4` |

Different build IDs are recorded honestly; byte-identical cross-environment images are not claimed. CI app images have empty registry-digest lists but retain immutable local image IDs.

PostgreSQL identities also reconcile:

- Local fixtures and baseline registry digest: `sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea`.
- CI baseline Linux image ID: `sha256:81bd698b4594e751a3269e4dcd3e03a4a0ec0daf7b72e7aa1abd43cce9887542`, retaining the above registry digest.
- CI mandatory DB uses `postgres:16`, not the baseline’s Alpine image: image ID `sha256:275447c94b11b151decd1f29877965301d5a77032037c46de93d990f739f00a9`, registry digest `sha256:ca0bd484cb98bf4b24eb1010e73fb3fcbd6714d240fbc1a10eea5b7dbecb641d`.
- Mandatory reports identify PostgreSQL **16.15** and actual container IDs.

Packed journeys are bound through the clean commit, lockfile/source hashes and successful baseline runner. These reports do **not** retain standalone package-tarball SHA-256 values; I do not claim otherwise.

## Acceptance cases

| Case | Disposition | Reconciled evidence |
|---|---|---|
| **M07.a** | **ACCEPT** | Complete controlled cold gateway/store/HTTP-host success; bounded token/header/body/auth/ingress deadlines; authorization/scope negatives prevent host calls. |
| **M07.b** | **ACCEPT** | Real HTTP host commits a PostgreSQL effect and drops its response; matching request ID, exactly one ledger effect and durable unknown outcome. Shared conformance separately covers `idempotent: true` without replay. No automatic read retry exists. |
| **M07.c** | **ACCEPT** | Prohibited/mixed DNS answers, connection-pinned lookup, redirects, metadata/address negatives, cumulative response limits, UTF-8 frame/chunk-boundary regressions, stalled bodies and deadline-bound SSE backpressure. |
| **M07.d** | **ACCEPT** | Real-store concurrent/replacement quotas; process-loss unknown intent; immutable completion; lease/window expiry; lost COMMIT ACK; SQL timeout/rollback/pool reuse; admission/completion outages and shutdown/late-admission drain. |

The initial rejection is historical, not an unresolved final disposition. The frozen-candidate review in `docs/mvp/evidence/M07-11f56b9/independent-code-review.md` accepts the B1–B3 fixes and executable coverage; candidate CI now satisfies that review’s formerly pending execution gate.

## Cleanup and residual ownership

`docker ps` showed only the four documented shared services: local email, kanban, PostgreSQL and gateway. No owned M07/baseline fixture was running. The detached Node22 worktree was absent from Git’s worktree inventory.

This corroborates the recorded cleanup, but does not independently inventory stopped containers, networks or volumes. Project-scoped teardown is recorded in `docs/mvp/evidence/M07-2026-10-13.md`; reusable images were intentionally retained, not globally pruned.

Residuals remain correctly assigned:

- **M08:** cooperative customer-code cancellation and request-only runtime behavior; gateway leases do not forcibly stop customer execution.
- **M09/M17:** actual provider TLS/egress, cold latency and natural zero-instance qualification.
- **M15/M16:** external audit retention/export scheduling, monitoring and customer-data approval.
- **M16/M18 / accountable humans:** operating, privacy/terms, budget and release approvals.

`docs/mvp/DISPATCH.md` appropriately requires maintenance migrations before rollout, describes manual 30-day retention pending approval, and does not claim a provisioned scheduler, outcome-query API or app-level idempotency mechanism.

## Mandatory bookkeeping before DONE

1. **Record this final acceptance durably**, with reviewed SHAs and limitations, under `docs/mvp/evidence/M07-11f56b9/`—for example, `independent-final-review.md`—and link it from `docs/mvp/evidence/M07-2026-10-13.md`.
2. **Complete exact-revision bookkeeping CI.** At my last observation, [run **38456349615**](https://github.com/embodyapp/embody/actions/runs/38456349615), bound to `645ff0e`, was still in progress: quality22/24, PostgreSQL22/24 and aggregate, and Terraform had succeeded; both baseline legs remained running. **Do not count it as passed yet.**
3. Require green CI on the final committed evidence/bookkeeping revision, including any subsequent review/status additions. Record its exact SHA and run URL in `docs/mvp/evidence/M07-2026-10-13.md` and `docs/mvp/STATUS.md`.
4. Then reconcile `docs/mvp/STATUS.md`: M07 row, activity entry, opening summary and completion count to **7/18 DONE**. Update the dated evidence report’s pending disposition consistently. Preserve the production/cloud/human-approval exclusions.

Any implementation change would create a new candidate requiring affected review and verification; documentation-only bookkeeping does not invalidate the accepted frozen implementation.

## Review limitations

This was read-only. I did not modify files, commit, push, invoke agents, run tests, alter Docker resources, access cloud services or read secret material. Acceptance rests on retained execution evidence, independently checked Git/GitHub provenance, selected executable assertions, source hashes and current read-only inventory.

**Final disposition: ACCEPT M07 task/evidence; authorize DONE only after the stated evidence/bookkeeping CI conditions pass. No production, M08/M17 completion, cloud-zero or human qualification is conferred.**
