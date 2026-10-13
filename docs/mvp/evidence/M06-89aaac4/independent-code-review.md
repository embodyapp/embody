# M06 re-review of 89aaac4: provisional code acceptance

I found no code, security or lifecycle blocker. I made no file changes, read no credentials and ran no network commands. I also did not run any tests myself. Everything below comes from reading the code. The pass counts are the ones you gave me.

This is not a final DONE. The candidate evidence listed under "Evidence still owed" is missing.

## Checks on the code

**`packages/mcp/src/index.ts`**
- **The `closing` fence is sound.** `handle()` registers the server in `activeStateless` with no `await` between the `closing` check and the registration. A request therefore either gets the 503 or is in the map when `dispose()` snapshots it. `dispose()` takes the snapshot after awaiting the stateful sessions, but `closing` is already set by then, so nothing can register late.
- **Shutdown during `server.connect` is covered.** The post-connect re-check includes `this.closing`, and it destroys the response and closes the server.
- **Close is idempotent.** `closeServer` is cached per request, and `close()` caches `dispose()`. The disconnect path and the dispose path therefore share one `server.close()`.
- **`structuredContent` is compatible.** No `outputSchema` is declared, so SDK clients do not require or validate it. Arrays, primitives and null stay text-only, which the unit test pins.
- **Resources and prompts are not advertised.** Only the tools capability is registered, so those methods return -32601, and the negatives assert it.

**Gateway**
- **`preClose` is available.** Fastify 5.12.5 supports it, and the `onClose` call stays as a no-op because `close()` is cached.
- **Cancellation is audited exactly once.** `remoteEvents` rethrows on abort and `prepared.finish` runs only in `finally`. An early `return()` from the SDK also reaches that `finally`.
- **Cancelled outcomes carry no `errorCode`.** The test asserts this.

**Tests**
- **Routing proof is sound.** Replica routing is checked per method, and the JWKS authority is the second gateway that is not replaced.
- **No route was missed.** The scope test shows hidden or guessed apps return an empty catalog, a foreign workspace returns 401, and no host is called.

**Client script**
- **Qualification is strict.** It pins the version string exactly and asserts one initialize, at most one GET (405), zero idle requests, zero active responses and zero sockets after 120 seconds.
- **Retries are not masked.** `executions` is asserted to equal 1, 2 and then 3, so a missed or duplicate tool call fails.
- **The token stays out of public evidence.** It sits in a 0600 config file, and the evidence records only `authenticated: boolean`.

## Non-blocking observations

None of these block acceptance. I'd record the first two as documented limitations or M07 inputs, and the other three are optional hardening.

1. **Shutdown does not wait for the audit write.** `close()` resolves when the servers close, not when each `remoteEvents` `finally` has run. The test uses `expect.poll` for this reason. With the in-memory audit log that is fine. With the durable audit planned in M07, the cancelled-call record could be lost if the process exits right after `close()`. Add a drain of in-flight handlers before durable audit lands. MCP.md should not promise that shutdown cancellations are durably recorded.
2. **Stateful path race, pre-existing.** A stateful session created while `close()` runs is added to `sessions` after `dispose()` has cleared it, so it leaks. Hosted mode is stateless, so this doesn't affect M06. Guarding `sessions.set` with `closing` would fix it.
3. **Possible test flake.** The alternation assertion on `tools/call` routes uses a `next++ % 2` counter shared with the SDK's bodiless GET (the 405 probe). The GET normally fires right after `initialized`, before any call, so this is low risk. If CI shows a flake, count only POSTs or assert on the set of routes.
4. **Duplicate payload.** `structuredContent` plus the JSON text doubles the size of large object results. This is acceptable now, but worth noting for M07 quotas.
5. **`undefined` result.** `JSON.stringify(undefined)` gives an invalid text block. This is pre-existing, and a host returning `undefined` is the only trigger.

## Evidence still owed (not defects)

- The final 120-second clean-candidate `pnpm test:mvp:client` run, with its sanitized `mvp-client.json` bound to SHA 89aaac4.
- Exact-candidate CI, with Node 22 and 24, mandatory DB/MVP at zero skips, and the packed/E2E baseline. Your initial 177 passed was measured before the five MCP negatives were added. MCP 18 and gateway 67 give a re-expanded total that needs a fresh mandatory run.
- The `TESTING.md` totals (182 MCP+MVP; gateway-store 25, host 16) need confirming against that run. By my sum, 12+25+38+6+16+18+67 = 182, which is internally consistent.
- Evidence file refresh. `M06-2026-10-13.md` still says "uncommitted working candidate", cites the 30-second smoke, and has M06.c and M06.d as OPEN. Update it to the final SHA, the 120-second result and CI links.
- STATUS.md. It currently says IN_PROGRESS with a count of 5/18, which is correct. Move M06 to DONE only after the evidence is in and an independent acceptance is recorded.

## Case mapping

| Case | Code and test coverage | Status |
|---|---|---|
| M06.a: stateless across replicas and replacement | `McpHttpHandler` stateless mode; mcp.test (replacement true and false); store-conformance "M06: one official client…" | Code accepted; CI pending |
| M06.b: cancellation, disconnect and shutdown | `closing` fence, `preClose` hook, the shutdown tests in both suites, and the exactly-once cancelled audit | Code accepted; CI pending |
| M06.c: named real client and idle | `scripts/test-mvp-client.mjs`, Claude Code 2.1.296, 120-second idle; 30-second smoke passed | Waiting on the final 120-second run |
| M06.d: authorization, scope and no host wake | The grants-empty and revoke steps in store-conformance, the scope test, and the no-fetch assertions | Code accepted; needs a mandatory PostgreSQL run on the exact candidate |

**Provisional verdict:** code accepted with no blockers, and DONE withheld until the evidence items above are attached.
