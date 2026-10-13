**Decision: ACCEPT M06 technically, with conditions.** The only conditions are the evidence and status bookkeeping and the CI runs on those commits. I found no missing technical gate and no contradiction that blocks acceptance. This review is read-only. I ran no tests, read no credentials and made no network calls, so the CI run itself is not independently confirmed.

## Checks I ran

- **Frozen tree:** `89aaac4` has Git tree `9f12f49a57ad0529469b98256f22151fd9e14e3d`, matching the claim.
- **Docs-only follow-up:** `git diff --name-only 89aaac4 HEAD` lists 12 files, all under `docs/mvp/`. The implementation is frozen.
- **MVP suites:** all four MVP JSON files (local and CI, Node 22 and 24) report 182 passed, 0 failed, 0 skipped. The suites are 38+6+16+18+67+25+12, which sums to 182, and the breakdown is identical in all four. Every file is `dirty:false`, with the same lockfile hash and the same schema and fixture hashes.
- **Baseline files:** all three report one packed-consumer and one distributed journey, zero failed and zero skipped. There is no local Node 24 baseline, and the docs don't claim one.
- **Commit binding:** local artifacts bind to `89aaac4`. CI artifacts bind to merge commit `ba82b2a`, which the tree check ties to the candidate.
- **Real client:** `real-client.json` is clean `89aaac4` on Node 24.21.0, with client 2.1.296, SDK 1.32.1 and model `claude-haiku-5-5`.
  - Request sequence: `server/discover` gets 400, then `initialize`, `initialized` (202), one GET that returns 405, `tools/list`, and two `tools/call`.
  - The calls alternate across replicas 0 and 1. No request carries a session header, and every request is authenticated.
  - Idle: 18:16:10.964Z to 18:18:10.966Z is 120 s, with 0 new requests, 0 active responses and 0 sockets, and the client still running.
  - Host requests rise from 2 to 3 only on the plain CLI `kanban.ping` execute. The CLI catalog GET and the MCP list did not add host requests.

## Case decisions

- **M06.a: PASS.** The SDK client works across alternating replicas with no session or affinity. This is covered on memory and real PostgreSQL stores in the 182-test mandatory run and in the real-client request log.
- **M06.b: PASS.** The tests cover replacement, grant removal, disconnect, shutdown fence and exactly-once cancellation audit. The prior code review found no blocker. Cancellation is cooperative, and cross-replica notification is not claimed.
- **M06.c: PASS** for Claude Code 2.1.296 direct HTTP only. The marker was seen in both turns, there were exactly two tool calls, no reconnect loop, and the plain CLI call worked. The `server/discover` 400 probe followed by `initialize` fallback is honestly documented as a non-feature.
- **M06.d: PASS.** Scope is evaluated on every request, hidden or guessed apps return an empty catalog, foreign workspaces and wrong credentials are denied, and the real-client log shows no host call from discovery.

## Gaps and contradictions

None of these block acceptance. I'd tighten the first one.

1. **No exit code in the transcript.** The "normal exit 0" claim has no field in `real-client.json`, which has no `exitCode` or equivalent. The pass status rests on the script's own check, which the code review confirmed exists. Either note that in the evidence record or add the field in the bookkeeping commit.
2. **Replacement is only a boolean.** The artifact records `gatewayReplacement: true` and replica indices, so the log can't show that the second call hit a new listener. The tests and code review cover this.
3. **Close timestamps between local and CI.** Local runs (18:16–18:18Z) and CI artifact timestamps (18:17–18:18Z) fall within seconds of each other, and the real-client run overlapped the local MVP runs. This is plausible if everything ran in parallel, but compare the run's job start and end times against `gh run view` on CI 38445328639. That also confirms "all nine jobs green", which I could not check offline.
4. **Different Postgres images.** The CI MVP job used digest `ca0bd484…` where baseline and local used `721873…`. Both are PostgreSQL 16.15 and both are recorded, so this is only a note.
5. **Local `pnpm verify` is unbacked.** The 289 pass / 11 skip and runner 36/36 figures have no artifact. CI covers verify, so this only matters if someone wants those local numbers.
6. **Cost figure.** The client-reported $0.00026855 appears to be cumulative across both turns. It is labeled as not a billing figure.

## Scope and residuals

**Accepted scope:**
- Hosted stateless MCP tools-only profile, SDK 1.32.1, protocol 2025-11-25.
- Claude Code 2.1.296 direct HTTP with bearer auth.
- A 120-second local idle window.
- The plain CLI.

**Not claimed:**
- Durable audit on process exit and in-flight drain (M07).
- Quotas and payload-size limits, including the duplicated JSON text plus `structuredContent` (M07).
- The pre-existing standalone stateful initialize/close race, and the `undefined` result edge case.
- Cross-replica cancellation notifications.
- Provider zero-instance and cold-start metrics (M17).
- Other client versions, the stdio bridge, desktop clients, `server/discover` and GenUI.
- The completed-task count is 5 until M06 flips, then 6. The earlier reviewer's suggestion to revert to 4 was correctly rejected.

## Conditions before DONE

1. Commit the final evidence and status changes. Update the "Final reviewer decision: pending" line in `docs/mvp/evidence/M06-2026-10-13.md` and move M06 to DONE with a count of 6/18 in `STATUS.md`. `MCP.md` should lose "in progress" and "final candidate acceptance pending", and its note that a non-durable shutdown cancellation audit isn't promised should stay.
2. Run CI on that evidence commit, wait for it to go green, then link its run ID. Don't write "green" before it has run, as you said.
3. Optionally, apply gaps 1 and 3 above.

If the CI on the bookkeeping commit passes and the docs show no new contradictions, M06 is DONE on this scope.
