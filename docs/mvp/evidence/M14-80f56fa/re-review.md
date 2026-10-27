# M14 packed CLI deploy and control journey: focused re-review of fix commit `80f56fa`

**Candidate:** fix commit `80f56fa` on `feat/mvp-m14-cli-journey` (draft PR [#56](https://github.com/embodyapp/embody/pull/56)). The record commit `07b95bd` adds only one line to `docs/mvp/STATUS.md` (`git diff --stat 80f56fa 07b95bd`). **Fix diff:** `cfe0ea8..80f56fa`, 9 files:
- CLI source: `packages/cli/src/{index,manage,target}.ts`;
- tests: `packages/cli/test/{deploy,action-resolution}.test.ts`;
- journey: `infra/mvp/m14/journey.mjs`;
- docs: `docs/mvp/CLI.md`, the copied review and `docs/mvp/evidence/M14-8d4bb07/fixes.md`.

The copied review is byte-identical to my commit `d4fe9d8`. No gateway, contract, release-stage or live-topology code changed.

**Scope:** the blockers and notes of the [independent review of `8d4bb07`](../M14-8d4bb07/independent-review.md) and the author's [fixes](../M14-8d4bb07/fixes.md).

**Reviewer:** the same separate session that wrote the review, not the author.
- Runs used a detached worktree of `07b95bd` outside the repository, with Node 24.21.0, npm 11.19.0 and pnpm 11.25.0 (`pnpm install --frozen-lockfile`, `pnpm build`).
- The disposable fixture was Compose project `embody-m14-rereview` on loopback port 55782, removed afterwards with `down --volumes --remove-orphans`. `embody-local-*` and every other project were not touched.
- No cloud resources were created and nothing was spent. No product code was changed; mutations were applied one at a time and reverted with `git checkout`, and the tree was clean afterwards.

## Verdict: **ACCEPTED**

B1 and B2 are fixed. Each fix has a regression that fails when the fix is reverted. N1, N2, N3, N5, N7 and N9 are addressed, and the N4, N6 and N8 residuals are recorded honestly. Exact-candidate CI on the fix tip is green. N8 remains an open owner decision in STATUS; it does not block M14.

## Reproduction (exact code, clean tree, Node 24.21.0)

| Command | Result |
|---|---|
| `pnpm --filter @embody/cli test` | **33** passed (5 files), 0 skipped (29 before + 4 new regressions) |
| `pnpm test:verification` | **114** passed, 0 failed, 0 skipped |
| `pnpm test:m14` (private fixture above) | **16/16** journey cases, 5 builds in 287 s; 4 candidate containers removed. `.artifacts/verification/m14-local.json`: `commit 07b95bd7…` (code = `80f56fa`), `dirty: false`, `status: passed`, `counts {passed: 16, failed: 0, skipped: 0}`. This includes the stricter N5 wake-task check |

These match the author's claims (CLI 33/33, verification 114/0, `test:m14` 16/16).

**Exact-candidate CI:** run [40545850462](https://github.com/embodyapp/embody/actions/runs/40545850462) on `07b95bd` (code = `80f56fa`) completed `success` on all 9 jobs: `quality` 22/24, `postgres-matrix` 22/24 (which runs `test:m14`), `postgres`, `e2e-artifacts-matrix` 22/24, `e2e-artifacts` and `terraform`.

## Blockers

### B1: option values echoed to stderr. **Fixed.**

What the fix does:
- `takeOption` (`index.ts`) recognizes `--name value` and `--name=value` for `--profile`, `--base-url`, `--token`, `--output` and `--request-timeout`. A missing value is an error that names only the option.
- `manage.ts` `parse` splits at `=` and prints only the name.
- The action parser's `flags()` refuses `=` forms as `Use --<name> <value>`. It reports a stray positional by position, not by its text.

Probed against the built binary, using a canary in every position:
- `--token=`, `--tokn=`, `--no-wait=`, `--workspace=`, `--app=`, `--title=` and `--profile=`, as a positional, as `dep_`/`app`/`rel` arguments, after a trailing `--token`, and in `source upload`;
- **no** output contained the canary.

The only echo left is `mcp setup --name=<x>`, which prints the user-chosen server name in the generated config. That is intended: the value must match `[A-Za-z0-9_-]{1,64}` and is not a credential.

### B2: plain http off loopback. **Fixed.**

`resolveTarget` now accepts `http:` only when `loopback(hostname)` is true: `localhost`, `*.localhost`, `127.0.0.0/8` or `[::1]`. Every command resolves its target before any request, including `apps list`, actions, `source upload` and `mcp setup --write`.

Probes:

| URL | Result |
|---|---|
| `http://<name>.example`, `http://0.0.0.0`, `http://[::ffff:127.0.0.1]` (normalized by WHATWG), `http://localhost.` | refused, exit 2, nothing sent |
| `HTTP://LOCALHOST:9` | allowed (normalized) |
| `http://2130706433` | allowed (normalized to `127.0.0.1`) |
| `https://user:…@host` | still refused |

`mcp setup --write` to a remote http URL writes no file.

## Mutation testing

Each mutation was applied alone to the source; `packages/cli/test/deploy.test.ts` was run, then the file was restored.

| Mutation | Result |
|---|---|
| M1 `manage.ts` `parse` prints the whole `--x=value` argument | **fails** "B1: --name=value never echoes the value" |
| M2 `takeOption` ignores the `=` form | **fails** B1 |
| M3 `flags()` echoes the `=` argument | **fails** B1 |
| M4 `flags()` echoes a stray positional | **fails** B1 |
| M5 `loopback()` returns true for every host | **fails** "B2: plain http to a non-loopback gateway is refused" |
| M6 `parseStatus` back to `EXIT.unavailable` (retried) | **fails** "N2: a reply that breaks the status contract…" |
| M7 the cancel 409 re-read branch removed | **fails** "N7: cancel that loses to promotion…" |
| M8 Ctrl-C during the submission POST reported as unavailable | **fails** N7 |

Every regression in the new block guards what it claims; the other 16 tests stayed green under every mutation.

## Notes from the first review

- **N1 (resume semantics):** fixed in CLI.md and in the `CHECK_FAILED`/`CANCELLED` hints and the cancelled-wait message. The doc now says that a rerun after `active` makes a second release, and that a lost `--retry` reply is not resumable. This matches `manage.ts`:575 and the gateway's generation bump.
- **N2:** fixed. A contract mismatch exits 6, is not retried, and names the deployment ID when the reply has one.
- **N3:** fixed. The command table and the Verification table include `rollback` and `M14.a.rollback`, and the M15 statement is corrected.
- **N4:** recorded residual. The live cold case is a client deadline; the local frozen-container case is the M14.b execute-path evidence. Accepted as recorded.
- **N5:** fixed. The case needs an array and a task due 55–65 min after the start, which matches the scaffold's `delayMs: 60 * 60_000` (`create-embody-app`). The local recorder stores `scheduleTime`, and the live provider returns Cloud Tasks' RFC 3339 `scheduleTime`. See N10.
- **N6:** recorded residual (exact-substring scan); accepted. With B1 fixed, no CLI path transforms or echoes a key.
- **N7:** fixed, with three new cases. The finding that the gateway answers a concurrent stale-fence cancel idempotently (200), so the CLI's 409 branch is defensive, is consistent with `cancelDeployment` returning the cancelled record unchanged.
- **N8:** recorded in STATUS as an **owner decision** (per-app reservation as account provisioning, or a user-facing app-create step before G5). This is correctly left to the owner and does not block M14.
- **N9:** fixed: `--request-timeout` without a value, the message wording, and the unused `deploy --wait` flag. The documented overshoot is accepted.

## New non-blocking notes

- **N10.** The stricter N5 check has run only locally. The live evidence (`e1a52e` on `8d4bb07`) recorded one wake task under the old check. The task list and the field it needs (`scheduleTime`) are the same in the live provider, so no live re-run is needed for acceptance. The next live `m14` run (for example at M17) will exercise the new window; if Cloud Tasks schedules the wake slightly earlier than the step's due time, widen the window rather than drop it.
- **N11.** `loopback()` also accepts `*.localhost`. On macOS and with systemd-resolved, those names resolve to loopback; I confirmed `evil.localhost` → `127.0.0.1`/`::1` here. RFC 6761 says resolvers should do this, but a plain glibc `/etc/hosts` + DNS setup may forward `*.localhost` to DNS. Consider allowing only `localhost` itself, or resolving the name and checking the addresses. This is low risk and not a blocker.
- **N12.** The legacy stdio MCP bridge (`embody mcp --url … [--token …]`, `bin.ts`) does not go through `resolveTarget`, so it can still send a key over plain http to a remote host. It predates M14 and is documented as unqualified (CLI.md "Other clients and the stdio bridge are not qualified"). Apply the same rule when it is next touched.
