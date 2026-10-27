# M14 fixes for the independent review of `8d4bb07`

The [independent review](./independent-review.md) (separate session) REJECTED `8d4bb07` on two M14.c blockers. Both are CLI-only: the gateway, the release stages and the live topology are unchanged, so, as the review states, no new live run is needed; the unit suite, `test:verification`, `test:m14` and exact-candidate CI on the fix commit are the gates.

## Blockers

- **B1 (option values echoed to stderr).** Fixed.
  - Global options accept `--name value` and `--name=value`. A missing value is a usage error that names only the option. Covered options: `--profile`, `--base-url`, `--token`, `--output`, `--request-timeout`.
  - The management parser (`manage.ts` `parse`) accepts `--name=value` for its value options. For an unknown option it prints only the name up to `=`.
  - The action parser (`index.ts` `flags`) refuses `=` forms without echoing them, and reports a stray positional argument by position, not by its text.
  - Regression `B1: --name=value never echoes the value…` (`packages/cli/test/deploy.test.ts`) runs a canary through `deploy`, `deployments status`, `apps status`, `mcp setup`, an action flag and an action positional. Every run asserts the canary is absent from stdout and stderr. It also checks that `--token=<wrong>` is an auth failure and `--token=<valid> --output=json` works. Reverting either parser fix makes the regression fail.
- **B2 (plain http to a remote gateway).** Fixed.
  - `resolveTarget` accepts `http:` only for loopback hosts: `localhost`, `*.localhost`, `127.0.0.0/8` and `[::1]`. Everything else must use `https`. Every command resolves its target before sending anything.
  - Regression `B2: plain http to a non-loopback gateway is refused…` covers `apps status`, `apps list`, `deploy`, `mcp setup --write` and an action against `http://gateway.invalid`. Each exits 2 with the https message. No request is sent and no config file is written. Loopback forms still resolve. Making `loopback()` accept every host makes the regression fail.
  - `action-resolution.test.ts` used `http://gateway.test` with a fake fetch; it now uses `https://gateway.test`.

## Notes

- **N1 (resume semantics):**
  - CLI.md now says what the key actually does. A rerun resumes the same deployment while it is in progress, or after it ended `failed` or `cancelled`. After it went `active`, a rerun submits a new deployment of the same source; use `deployments status --wait` to follow an existing one. A lost reply to a `--retry` submission cannot be resumed.
  - The `CHECK_FAILED` and `CANCELLED` hints, and the cancelled-wait message, now mention `--retry`.
- **N2 (contract drift):** fixed. A reply that does not match the strict v1 `DeploymentStatus` is not retried. It exits 6 with "contract mismatch" and keeps the deployment ID when the reply has one. Regression `N2: …` injects an unknown field into status replies and asserts exit 6 with zero further polls.
- **N3 (rollback docs):** CLI.md's command table and Verification table now include `embody rollback` and `M14.a.rollback` (16 journey cases). The "lands with M15" statement is removed. The CLI reference already listed the command.
- **N5 (weak wake-task check):** fixed in `infra/mvp/m14/journey.mjs`. The case now needs an array (no `null` escape) and at least one task due 55–65 minutes after the start: the scaffold's one-hour delayed step, not a lease or retention task. Re-verified locally (`test:m14`) on the fix commit.
- **N7 (untested branches):** new regression `N7: …` covers three paths:
  - cancellation losing to promotion between the CLI's read and its post (exit 6, "lost the race … active");
  - a concurrent cancel: the gateway answers the stale-fence repeat idempotently (200, `cancelled`, fence advanced once), as CONTRACTS specifies, so the CLI's 409 branch is defensive;
  - Ctrl-C during the submission POST (exit 130, "may or may not have been accepted", "Run the same command again"; the rerun then submits or resumes).
- **N9 (CLI nits):** fixed.
  - `--request-timeout` without a value is now a usage error.
  - The timeout messages read "more than 0 and at most …".
  - `deploy` no longer accepts the unused `--wait` flag.
  - The wait-loop overshoot, at most one request timeout, is unchanged and documented here.

## Residuals (not changed; recorded)

- **N4.** The live cold-timeout case proves the CLI's deadline, exit code and message against the real gateway, not a sleeping Cloud Run app. At 0.05 s the catalog request times out first. The local case, with the serving container frozen and the catalog answered, is the M14.b evidence for the execute path. Measured cold starts are M17. The live evidence README already states this limit.
- **N6.** The secret scan matches exact substrings. CLI-side, no path transforms a key: tokens appear only in the `Authorization` header, cache keys are SHA-256 hashes, and messages never echo values (B1). A broadened scan (encodings, a `Bearer ` prefix in logs) is left for M17's log review.
- **N8.** Creating a new app still needs the operator, who reserves it. M14.a's "after account provisioning" is met with apps reserved at provisioning, and the M13 design for reservation was accepted. Whether per-app reservation counts as account provisioning, or a user-facing app-create step is scheduled before G5, is an **owner decision**, recorded in STATUS.
