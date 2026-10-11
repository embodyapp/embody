# M01 independent automated review — 2026-10-11

Reviewer: separate Codex CLI 0.162.1 process, OpenAI `gpt-6.1-sol`, read-only sandbox. The implementation agent did not supply an acceptance conclusion. No human approval is claimed. The user directed the integrator to perform the work necessary for M01/M02 acceptance.

Scope: merged M01 `024df01` against parent `c07d6ff`, followed by review of the M01 acceptance-fix diff on `feat/mvp-m02-contracts`. M02 files excluded. Reviewer inspected code/tests and the integration evidence; did not edit files, inspect credentials or perform remote writes. CI results were supplied context, not rerun by the reviewer.

## Findings and fixes

Initial decision: **NOT ACCEPTED**. Four P2 findings:

1. HTTP JSON/SSE returned raw host error text while MCP normalized it.
2. Unknown/unauthorized MCP tool calls bypassed shared-dispatch audit.
3. Stream cleanup abort incorrectly classified host disconnects as client cancellation.
4. M01's historical report had not recorded final CI/merge/provenance.

Implementation normalizes HTTP and MCP through the shared bounded parser, hides raw INTERNAL_ERROR text, emits a public error for missing terminal frames, cancels host readers, audits rejected MCP tools with indistinguishable public errors, and classifies outcomes before cleanup abort.

Second review found two further P2 paths: malformed successful HTTP JSON could audit as success, and a client close during backpressure could take a normal break without cancellation classification. Both fixed, with deterministic regression coverage.

## Final reviewer decision (verbatim)

> **M01 code acceptance: ACCEPTED.** No remaining correctness or security blockers found in the full M01 followup diff against `024df01`.
>
> All initial and followup code blockers are resolved:
> - HTTP JSON and SSE failures use normalized public errors.
> - Unknown and unauthorized MCP calls are audited without public catalog disclosure.
> - Host failures remain failures despite cleanup abort.
> - Malformed successful JSON throws and is audited as failure.
> - Client cancellation is classified before cleanup abort, including the normal break during backpressure. The deterministic regression asserts injection failure and an audit outcome of `cancelled`, without an error code.
>
> Automated, read-only code review only. The reported **41 passing gateway tests** are supplied evidence; I did not rerun them. CI/provenance remains separate. No edits, credential/environment/auth-file inspection, remote writes, or human approval claims.

Review artifacts retained locally: `/tmp/embody-m01-independent-review.md`, `/tmp/embody-m01-independent-rereview.md`, `/tmp/embody-m01-final-independent-review.md`, and corresponding `*-agent.log` files. Exact candidate/CI acceptance is recorded separately in the integration report and status tracker.
