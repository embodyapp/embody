# Read-only acceptance review of M05 at `b429a0a`

**Verdict:** I found no concrete security or false-green blocker. The technical M05 gates are acceptable, **provided cleanup is verified**. There are six qualifications below, and two of them should be written into the acceptance record. M05 is not DONE.

I ran nothing. Everything here comes from the 11 public evidence JSON files, `infra/mvp/fixture/*`, `packages/mcp`, `packages/gateway`, `packages/auth`, `apps/gateway`, and `Dockerfile.m05`. I didn't read anything under `/tmp/embody-m05-private`.

## Gate-by-gate

| Gate | Finding |
|---|---|
| CI | Exactly 9 jobs, all `success`, and `headSha` is the full `b429a0a5…`. Static count of the tests: 8 `it` blocks in `mcp.test.ts`, one of which is `it.each` over stateless/stateful, so 9 tests run. That fits "9 MCP". I can't confirm "64 Gateway" without running it, because the shared conformance suite runs more than once. |
| Runtime A/B | 16 checks each. Identities are `-r-9e72…` and `-r-49e66…`, and their origin and config digests are swapped as expected (`job.mjs:18-38`). Inventory matches finalInventory. |
| Initial | 19 checks. Before the 9 negatives run, the probe calls the adversary template unmodified and requires a 200 (`gateway-probe.mjs:127`). So the 401s can't come from a broken template. |
| Publish → overlap | The overlap run reached both revisions from one root client: `callCount` 8, revisions `00037-rvs`/`00038-fgx`, exactly matching `EMBODY_GATEWAY_REVISIONS`. The revision header comes from the platform's `K_REVISION` and is only added when `EMBODY_M05_REVISION_PROBE=true` (`apps/gateway/src/index.ts:100`). It is set in the `onRequest` hook, before `hijack`, so MCP/SSE responses carry it. Old and new keys are both accepted. |
| Source: stateless MCP | Requests other than POST get 405 with `allow: POST`. Session IDs are rejected. The disconnect-cleanup listener is attached before `server.connect`, and the socket is re-checked after it (`packages/mcp/src/index.ts:156-271`). Stateful stays the default, and identity/endpoint pinning is unchanged (`:166-176`). The gateway alone selects `"stateless"` (`packages/gateway/src/index.ts:660`). |
| Removed | 3 origins, all on revisions `00039`/`00040`. A freshly minted old-key token gets 401 and the current key gets 200. `deploy.mjs:259-263` reads JWKS back on both tagged revisions and requires exactly `["m05-key-2"]`. |
| External | `/health` and an authenticated `/execute` both return 404 on both app origins. The job is checked to have no VPC (`job.mjs:253`). |
| Watch | Timings check out: 38.338 − 35.829 = **2509 ms**, measured from the last observed old-key publication, which is a conservative start point. The code confirms the same `instanceNonce` and revision per app before and after (`gateway-probe.mjs:407-413`). Apps run with `maxInstanceCount: 1`, and app JWKS caching is capped at 60 s (`packages/auth/src/index.ts:67`). |
| Provider | Six FATAL `42501` denials match the requested set. No SQL role has super, createrole, createdb, replication or bypassrls. `cloudsql.client` is limited to this instance by an IAM condition. Credentials: 21 revoked, 0 not revoked. Apps are internal-only and only the gateway service account can invoke them. The notes keep operator diagnostics separate from the workload job gates. |
| Old signer | Destroyed at 11:49:49, after external (11:38:53) and removed (11:40:01). |

## The watch reconciliation

I accept it, and the code supports the operator's explanation independently. In `job.mjs`, the execution/report binding check (`:289-308`: `succeededCount===1`, sourceSha, candidateSha, config digest, phase, exact origins, required checks) runs **before** the final `servingInventory` (`:309`). That inventory call throws `"Serving fixture not ready/private"` whenever the gateway's `terminalCondition` isn't `SUCCEEDED`, for example while it is reconciling. So if the original CLI failed with that message, the binding check had already passed. Also, `watch-removal` is the one phase where inventory equality is not required (`:310`). The reconciled `finalInventory` is clearly a later read after convergence, not the state at the moment of the watch, and the file says so.

There is one gap. Unlike every other gateway evidence file, `watch-reconciled.json` has no `serviceAccount` field. The job's identity is only implied: it could read the signer secret, and the runtime probes show runtime service accounts are denied that secret. I'd add the job's attached identity to the record.

## Residual qualifications (not blockers)

1. **The serving image and the job image differ in the evidence.** Every serving revision shows `dc38bd…`, while the jobs show `09b29…`. This is the expected index/amd64 split from `immutableLeaf`, but the only link between the two digests is the operator-written `leafImage` field. No raw index manifest is in the evidence. Provenance is also operator-attested and not reproducible: the base images are pinned by tag, not digest, and the source label comes from a build argument. I can't evaluate the "build 23 vs final 24" point from the repo.
2. **Publish-phase key publication was never read back.** `deploy.mjs` checks JWKS only in the overlap and removed phases, and `publishAt`/`switchedAt` are kept in private state. The ≥60 s and ≥300 s waits are enforced in code and fit the timestamps, but there is no public observation from the publish phase. This affects availability, not security.
3. **The watch's old-key denial is a single check.** The probe stops at the first all-401 and doesn't test whether it stays denied. The later removed-phase check covers only the primary (kanban) app. Risk is small: tokens live at most 5 minutes, and the old signer was destroyed afterwards.
4. **Removal is timed from the root URL only.** `lastOldPublicationAt` is taken from the root JWKS. Cloud Run frontends could still route to the old revision for a short time after the switch. The 60 s cache cap still bounds the outcome.
5. **SQL residuals:**
   * The instance has a public IP but no authorized networks, with `ENCRYPTED_ONLY`.
   * `template0` and `cloudsqladmin` show `can_connect=true` in the catalog. That's normal: `datallowconn` and Cloud SQL's own access rules block them. But no denial was demonstrated for them.
6. **The gateway is still running warm.** It has `minInstanceCount: 1` and `allUsers` invoker. Both are hardcoded for any non-initial phase in `deploy.mjs:151`, so this must be undone in teardown.

## Before M05 can be called DONE

1. Run cleanup and verify the resource inventory is empty: SQL, VPC/NAT, services, jobs, images, secret versions, and the IAM condition binding.
2. Do the conservative cost and usage accounting, and confirm the backend state is preserved.
3. Add the watch job's attached identity to the record.
4. Record qualifications 1 and 2 explicitly.

I couldn't write the plan file because no file-write tool was available in this session, so this review is the deliverable.
