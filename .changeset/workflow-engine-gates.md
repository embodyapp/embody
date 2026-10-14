---
"@embody/core": minor
"@embody/storage": minor
"@embody/host": minor
"@embody/cli": patch
---

Workflows now run under a least-privilege PostgreSQL runtime role: workers claim through a narrowly granted `SECURITY DEFINER` function (grant `EXECUTE` on `STORAGE_RUNTIME_FUNCTIONS`) and process each step in its tenant's own transaction, fenced by its claim. Fix a join that could stay blocked when two branches finished together, a claimed step that could start after cancellation, early `cancelled` status while steps were still running, and compensation that could run before a later step settled. Running steps receive a cancellation signal and are awaited before their outcome is recorded; failed compensations retry as compensation. Add `assertHostedWorkflowLimits`, active workflow version listing, and CLI `<workflow> <operation> [id]` resolution so workflows in one app never shadow each other.
