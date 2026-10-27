# M14 packed CLI deploy and control journey: independent review of candidate `8d4bb07`

**Candidate:** code commit `8d4bb07` on `feat/mvp-m14-cli-journey` (draft PR [#56](https://github.com/embodyapp/embody/pull/56), stacked on #54). **Diff:** `101a719..8d4bb07` (41 files, +4,523/−177). The branch tip `cfe0ea8` adds only `docs/mvp/{CLI,STATUS,TESTING,VERIFICATION}.md` and `docs/mvp/evidence/M14-live-8d4bb07/` on top of `8d4bb07` (`git diff --stat 8d4bb07 cfe0ea8`: 6 files, docs only), so the code is identical. **Scope:** M14 steps 1–4 and acceptance M14.a–c in [IMPLEMENTATION](../../IMPLEMENTATION.md#m14--packed-cli-deploy-and-control-journey), checked against [CLI](../../CLI.md), [SOURCES](../../SOURCES.md), [DEPLOYMENTS](../../DEPLOYMENTS.md), [RELEASES](../../RELEASES.md), the [README](../../README.md) product promise and the [STATUS](../../STATUS.md) tracker rules.

**Reviewer:** a separate session, not the author.
- Local runs used Node 24.21.0, npm 11.19.0 and pnpm 11.25.0 (`pnpm install --frozen-lockfile`, `pnpm build`) on a clean checkout of `cfe0ea8` (code-identical to the candidate).
- The disposable fixture was Compose project `embody-m14-review` on loopback port 55781, from `docker-compose.postgres-test.yml` and `test/postgres/init.sql`, with `fixture.env.example` rewritten for that port and container (every line exported, including `EMBODY_PROVISIONER_URL`). It was removed afterwards with `down --volumes --remove-orphans`. `embody-local-*`, `embody-m12-verification` and `embody-m14-verification` were not touched.
- No cloud resources were created, nothing was spent, and `test:mvp:cloud` was not run. The live evidence was judged from the committed sanitized JSON, the README and the suite code.
- No product code, tests or docs were changed; only this file was added. Probes ran against the built `packages/cli/dist/bin.js` from scratch directories outside the repository.

## Verdict: **REJECTED**

The journey is well built and almost all of it holds up:
- every platform call goes through the gateway (`Api.call` → `<root>/v1/workspaces/<ws>/…`, the catalog/execute calls → `<root>/w/<ws>/…`); the only other request is the signed source `PUT`, which carries only the signed headers (`source.ts`), with `redirect: "error"` everywhere;
- the deployment ID is printed as soon as the gateway answers; status, `--wait` and cancel work from any process by ID;
- Ctrl-C never cancels: during the wait it returns exit 130 with "NOT cancelled"; during the submission it says acceptance is unknown; nothing calls the cancel route except `deployments cancel`;
- cancel posts the read `cancellationFence`; the gateway (`deployment.ts` `cancelDeployment`, around :848–:875) cancels in one transaction, a repeat returns the record without advancing the fence, and a 409 is re-read so that "already cancelled" and "promotion won" are reported correctly;
- the deployment idempotency key is scoped per `(workspace, app, key)` (`embody_platform_deployments` `UNIQUE(workspace_id, app_id, idempotency_key)`), and the source upload key is derived from the digest, so a rerun rebinds the same `uploadId` and the replay fingerprint matches;
- `GET /v1/workspaces/:ws/apps` lists only apps the credential holds `app:read` on, from the request's catalog snapshot; names come from the same `^[a-z][a-z0-9-]{0,62}$` rule the store enforces on write;
- the `mcp setup` file is created with `wx` and `0600`, the key is never printed, and the printed config uses a placeholder;
- the live signer and gateway bucket grants match the SOURCES identity table (signer `roles/storage.objectCreator` on the run bucket only; gateway `roles/storage.objectUser` on it and `serviceAccountTokenCreator` on the signer), are bucket/SA-scoped (no project IAM) and are removed with the bucket and the signer SA; M13's `deployGateway` gains only an optional `env` defaulting to `{}`, so the M13 suite is unchanged.

Every local gate reproduces with zero skips. Two M14.c blockers remain; both are small fixes.

1. **B1:** a token passed as `--token=<key>` (or any secret passed as `--<flag>=<value>`) is echoed verbatim to stderr by the new management commands.
2. **B2:** the CLI accepts a plain `http://` gateway on any host, although its own error text says http is allowed only on loopback. It then sends the bearer key in cleartext and `mcp setup --write` stores it in a config that also sends it in cleartext.

## Reproduction (exact code, clean tree, Node 24.21.0)

| Command | Result |
|---|---|
| `pnpm --filter @embody/cli test` | **29** passed (5 files), 0 skipped |
| `pnpm test:verification` | **114** passed, 0 failed, 0 skipped |
| `pnpm test:m14` (private fixture above, Docker, npm 11, registry.npmjs.org) | **16/16** journey cases, 5 builds in 336 s; 4 candidate containers removed. `.artifacts/verification/m14-local.json`: `commit: cfe0ea88…`, `dirty: false`, `status: passed`, `counts {passed: 16, failed: 0, skipped: 0}` |

All counts match the author's claims (CLI 29, verification 114, local journey 16/16). A first attempt under the machine's default Node 26 failed 20 verification subprocess gates on the engine check; that was the environment, not the candidate, and the rerun on Node 24 is the result above.

**Exact-candidate CI:** STATUS records run [40129558784](https://github.com/embodyapp/embody/actions/runs/40129558784) on `8d4bb07` with all 9 checks green, including `test:m14` on Node 22 and 24. I did not re-run CI.

**Live evidence (judged, not re-run):** `mvp-cloud-m14-run1.json` records `commit 8d4bb071…`, `dirty: false`, `status: passed`, 18/18 cases (setUp, the 16 journey cases, cleanup), `wakeTasks: 1`, `deadlineSeconds: 0.05` for the cold case and `checkedBytes: 585197` for the secret scan. It contains no tokens. The suite's teardown and inventory cover the M13 resources plus the upload signer SA, and the cleanup case requires an empty inventory and byte-identical project IAM before and after (`qualify.mjs`:278–295).

## Blockers

### B1. `--flag=value` arguments, including `--token=<key>`, are echoed to stderr

**What the code does:**
- The global options are recognized only in the two-word form: `args.indexOf("--token")`, `indexOf("--base-url")` and so on (`packages/cli/src/index.ts`, `runCli`, around :217–:235). `--token=<key>` is not recognized and is passed on to the subcommand.
- The new management parser rejects it with the raw argument: `throw new Failure(EXIT.usage, \`Unknown option: --${name}\`)`, where `name` is everything after `--` (`packages/cli/src/manage.ts`:137). `runManageCommand` writes the message to stderr (`manage.ts`:348–350).

**Reproduced** against the built binary (with `EMBODY_TOKEN` set so the parser is reached; `SECRET123` stands in for a real key):

```text
$ embody deploy . --app kanban --token=SECRET123 --base-url http://127.0.0.1:9/w/ws_abcdefgh12
Unknown option: --token=SECRET123          (exit 2)
$ embody deployments status dep_abcdefgh12 --app kanban --token=SECRET123 …
Unknown option: --token=SECRET123          (exit 2)
```

`--app=<x>`, `--workspace=<x>` and any other `=` form behave the same way. The older action path has the same pattern (`flags()`, `index.ts`:123, `Unknown option: --${key}`), so `embody kanban card list --token=…` leaks too, but it is now one of many leaking paths rather than the only one.

**Why it breaks M14.c:** "credentials/source secrets never appear in stdout/stderr" is the acceptance case, and CLI.md says tokens "never appear in … stderr … error messages". `--token=$KEY` is the usual GNU form and the natural one in CI scripts, where stderr goes to build logs that are retained and shared. The usage error does not even tell the user to rotate the key. The journey's `M14.c.no-secrets` scan cannot see this, because the journey never passes a token on the command line.

**Fix direction:** accept `--name=value` for the global options (or reject it explicitly), and never echo an option's value: print only the option name up to `=`, in both `manage.ts` and `index.ts` `flags()`. Add a regression that runs `--token=<canary>` through `deploy`, `deployments`, `apps status`, `mcp setup` and an action and asserts the canary is absent from both streams.

### B2. Plain `http://` to a non-loopback gateway is accepted; the bearer key goes out in cleartext

**What the code does:** `resolveTarget` (`packages/cli/src/target.ts`:26–27) refuses only non-http(s) schemes, with the message "The gateway URL must use https (or http on loopback)". No loopback check exists. Every management call, the catalog/execute calls and `mcp setup` accept `http://gateway.example/…`.

**Reproduced:**

```text
$ EMBODY_TOKEN=… embody apps status --base-url http://gateway.invalid/w/ws_abcdefgh12
Gateway unreachable; check the gateway URL and retry.        (exit 7: the request was attempted)
$ EMBODY_TOKEN=… embody mcp setup --write m.json --base-url http://gateway.invalid/w/ws_abcdefgh12
Wrote a private MCP config (mode 0600, contains the credential) …   (exit 0)
m.json: "url": "http://gateway.invalid/w/ws_abcdefgh12/mcp", "Authorization": "Bearer <key>"
```

**Why it breaks M14.c:** CLI.md promises that tokens "go only in the `Authorization` header to the gateway". The code's own message states the rule that should enforce this. A mistyped `http://` profile sends a workspace deployer or caller key in cleartext on every command. `mcp setup --write` then makes that a standing configuration for an agent. The source path already applies the rule to upload targets (`uploadTarget` refuses non-HTTPS remote URLs), so the gateway URL is the gap. `M14.c.workspace-prefixes` exercises only https (live) and loopback http (local), so nothing tests the refusal.

**Fix direction:** in `resolveTarget`, allow `http:` only for `localhost`, `127.0.0.0/8` and `[::1]` (the CLI's default `http://localhost:3000` keeps working), and add unit cases for a remote http URL (exit 2, no request sent) and for `mcp setup --write`.

## Non-blocking notes

- **N1. Resume semantics are narrower than CLI.md says.**
  - The key is `deploy_<digest>_g<generation>` (`manage.ts`:575), and promotion sets `generation + 1` (`deployment.ts`:838). So rerunning `embody deploy` after the deployment went **active** (for example after a dropped connection during `--wait`) submits a new deployment and a second identical build and release. It does not "return the same deployment … even after it ended" (CLI.md "Resuming instead of resubmitting"). That sentence holds only for deployments that ended `failed` or `cancelled`.
  - For those two outcomes, the rerun replays the terminal result forever (exit 8 or 9). The `CHECK_FAILED` and `CANCELLED` hints do not mention `--retry`, although a transient readiness failure or a cancelled attempt is exactly when a user reruns.
  - `--retry` uses a random nonce (`manage.ts`:570), so a lost reply to a `--retry` submission cannot be resumed. CLI.md's "rerunning the same command resolves it without a second deployment" is false for `--retry`.
  - Fix the doc wording and the two hints; optionally print "already active as release …" when the source digest matches the active release.
- **N2. Strict status parsing turns a contract drift into a silent 30-minute wait.** `parseStatus` maps any schema mismatch to `EXIT.unavailable` (`manage.ts`:323–326). Inside `wait()` that is treated as transient (`:469–475`). A gateway that adds a field to the strict `DeploymentStatus` makes an older CLI print "status temporarily unavailable" until `--wait-timeout`, then exit 10 "still running". On submission, the same failure exits 7 after the gateway accepted the deployment, without printing the ID. Treat a malformed 200 as non-retryable (exit 1 or 6), and print `deploymentId` from the raw reply when present.
- **N3. Rollback is implemented, tested and evidenced, but the docs say it is not.** `embody rollback <app> <rel_id>` is in `USAGE` (`manage.ts`:362) and the unit suite (`deploy.test.ts`:471). It is `M14.a.rollback` in both journeys and in the local and live evidence (16 journey cases). But CLI.md's command table omits it, its Verification table lists 15 cases without it, and "Not yet proven" says the rollback command "lands with M15". Reconcile CLI.md and `docs/developer-tools/01-cli-reference.md`.
- **N4. The live cold-timeout case proves only a client timer.** At 0.05 s, the action command's first request, the catalog fetch, times out before any app or candidate is reached (`index.ts` catalog fetch with `catalogTimeout`). `t.pause` and `t.resume` are no-ops live (`qualify.mjs`:231–232). The live case therefore repeats the unit test and never exercises the execute path or a sleeping Cloud Run app. The local case, with the container frozen and the catalog answered, is the real M14.b evidence. The README states this limit honestly. A live variant that freezes the app (for example a test-only readiness delay longer than the deadline) would make the live case meaningful.
- **N5. The wake-task check is weak.** `expect(tasks === null || tasks.length > 0)` (`journey.mjs`:164): a provider that returns `null` passes vacuously, and any task in the app's queue counts, not specifically the delayed step's wake for this instance. A durable app also enqueues lease and retention tasks. Match the task to the instance or step (name or schedule time later than the start), and drop the `null` escape now that both providers return arrays.
- **N6. The secret scan matches exact substrings only.** `haystack.includes(secret)` (`journey.mjs`:358–360) would miss a truncated, URL-encoded or base64 occurrence of a key. Also scan for the key's secret part and its encodings, or for the `Bearer ` prefix in logs.
- **N7. Untested branches in the new commands:**
  - the cancel 409 race path (`manage.ts`:725–739: "already cancelled" after a conflict versus "lost the race … active");
  - Ctrl-C during the submission POST (unknown acceptance, exit 130 and the rerun hint, `:586–598`);
  - an interrupted upload.

  Each is a few lines with the existing `topology()` helper and a fetch wrapper.
- **N8. Creating a new app still needs the operator.** The README promise (line 25) is that after the operator provisions the workspace and its credentials, "the user deploys and updates supported apps without operator intervention". M14 meets this only for apps the operator reserved first. RELEASES:59 says reservation is "an operator today, M15's app API later", but IMPLEMENTATION M15 has no app-create step. This is not a blocker for M14.a, which says "after account provisioning", and the M13 design was accepted. But the owner should record whether per-app reservation counts as account provisioning, or schedule a user-facing app-create step, before G5.
- **N9. Minor CLI nits:**
  - `--request-timeout` given without a value silently uses 90 s (`index.ts` splice);
  - the `seconds()` message says "between 0 and 86400" but rejects 0;
  - `deploy` accepts an unused `--wait` flag;
  - the wait loop can overshoot `--wait-timeout` by up to one request timeout (90 s by default).

## What would make this ACCEPTED

Fix B1 and B2 with the regressions described, and correct the N1/N3 doc statements. Neither blocker touches the server or the live topology, so no new live run is needed: the unit suite, `test:verification`, `test:m14` and exact-candidate CI on the fix commit are enough. A focused re-review can check the fix diff, the regressions (with a mutation that reverts each fix) and the gates.
