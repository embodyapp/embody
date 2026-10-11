# M03 independent automated review — 2026-10-11

Reviewer: separate Codex CLI 0.162.1 / OpenAI `gpt-6.1-sol` process, read-only sandbox. Reviewed current M03 changes against M03.a–c: all new scripts, SQL/Compose fixture, gate tests, storage/kernel tests, CI/package scripts and testing docs. No human approval is claimed. The implementation agent supplied test results as context; the reviewer did not rerun services/suites.

Initial decision: **REQUEST CHANGES**.

- P1: redaction could leak normalized URLs/encoded passwords accepted from a whitespace-padded URL. Reviewer reproduced this using synthetic credentials only.
- P2: mandatory PostgreSQL evidence omitted the actual database service image identity.
- Required completion evidence: clean exact-candidate Node 22/24 packed/distributed baseline and mandatory DB/MVP CI.

Both code findings fixed: redaction now covers raw/trimmed/normalized URLs and encoded/decoded/JSON-escaped password variants plus generic DSNs; tests reproduce the leak. Evidence inspects the actual container's immutable image, records image ID/digests and server version, and propagates DB context/per-suite MVP counts. Role names are derived from configuration. Added `runVitest` validation and a nonzero-command/green-report regression; failed suite counts are retained.

## Final reviewer decision (verbatim)

> **Code accepted for M03.a–c; no remaining code blockers found. candidateCI acceptance remains pending.** This is an independent automated review, not human approval.
>
> Re-read the brief, current helpers/runners, CI, fixture SQL, storage tests, baseline journeys and MVP docs. The prior blockers are resolved:
> - Redaction covers trimmed/normalized URLs, encoded/decoded and JSON-escaped passwords, plus generic PostgreSQL DSNs.
> - DB evidence inspects the actual container `.Image`, records image ID/digests and server version; successful MVP evidence includes per-suite counts.
> - `runVitest` requires both successful process exit and nonempty, zero-skip assertion results, preserving counts on suite failure.
> - SQL negatives cover migration authority, elevated privileges, RLS bypass and second-database access; role names come from configured URLs.
> - TESTING.md supplies the required reproducible commands and prerequisites.
>
> One nonblocking limitation remains: failed MVP evidence preserves the failing suite’s counts but loses completed per-suite detail and DB image/version context.
>
> **Before marking M03 DONE:** retain clean, exact committed-candidate CI evidence for mandatory DB/MVP and the Node 22/24 packed/distributed baseline, with tested SHA and run/artifact links. The reported local 91 zero-skip cases and 12 runner tests are user-supplied results, not independently rerun here.
>
> No edits, env/auth/credential inspection, service execution or remote writes performed.

Local reviewer artifacts: `/tmp/embody-m03-independent-review.md`, `/tmp/embody-m03-independent-rereview.md` and corresponding `*-agent.log` files. Final candidate CI and integrator acceptance belong in the dated M03 evidence report, not this code-review assertion.

## Protected-check compatibility addendum

After all five initial CI jobs passed, the repository's unchanged protection required stable `e2e-artifacts`, not the new matrix check names. Added a stable aggregate job depending on the renamed matrix and accepting only result `success`; no branch-protection/admin bypass.

Separate read-only automated review in `/tmp/embody-m03-ci-compatibility-review.md` concluded **ACCEPT — no blocker for this CI compatibility fix**. It verified GitHub expression/dependency syntax, fail-fast behavior and that failure/skipped/cancelled results cannot pass the stable check. No `continue-on-error`; both Node legs remain mandatory. Static review, not live CI or human approval. The updated candidate requires another full CI run.
