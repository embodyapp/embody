# GenUI reference journey — accepted interaction contract

Status: **accepted technical contract, 2026-10-04**, under the owner's delegated P14 decisions. Verified surfaces and limits are in [the release evidence](genui-release-evidence.md); this is not publication or vendor certification. See [Phase 14](../implementation-plan/14-generative-ui.md), [ADR 0005](../adr/0005-generative-ui-presentation.md), and the [glossary](genui-glossary.md).

## Approved public acceptance-test seams

1. **Presentation session:** a transport-independent public controller consumes validated snapshots and declared local events, issues ordinary action requests through an injected dispatcher, and exposes observable presentation state. It does not authenticate callers, execute business logic, or introduce a wire envelope.
2. **Kanban actions:** public test-harness calls exercise the actual kernel, validation, transactions, and PR hook. No mocked hook or private-store assertions.
3. **Rendering:** public standard-document validation and Markdown/plain-text rendering; browser DOM and native Pi keyboard behavior are tested at their respective supported host boundaries.
4. **Transport:** authenticated gateway HTTP and official MCP client calls exercise resource authorization, generation pinning, target allowlists, cancellation, and tenant isolation.
5. **Distribution:** packed external consumers and Pi package loading, not source aliases, exercise shipped artifacts.

The owner approved these public seams before test implementation. Each implementation proceeds as one failing acceptance test, minimal implementation, then the next behavior.

Executable evidence includes the session/controller lifecycle, selection/review, bounds and generation fixtures; real-kernel veto/correction/external-edit/removal journeys; authenticated native keyboard, temporary browser and official Apps journeys through gateway/app host on SQLite and PostgreSQL; Pi public-SDK and actual next-provider-request ordering/redaction; installed packed consumers; and real Pi CLI pseudo-terminal checks. See [the dated evidence matrix](genui-release-evidence.md) for commands, reviewed results and limitations.

## Identity and reference actions

The veto fixture starts with a verified **agent** principal with Kanban read/update scopes. Human input drives the view, but action dispatch retains the initiating verified principal; the UI clearly labels this as acting through the agent session. An action payload cannot supply or override org, actor, roles, or scopes.

Use `kanban.card.update` with `{ id, data: { status: "done" } }` to exercise the existing agent-only PR veto. Correct the draft by adding a valid `prUrl`, then issue the same ordinary update. A separate human-principal fixture proves completion without a PR is allowed. Do not alter the hook or switch principals to obtain a demo veto.

The presented board uses `kanban.board`, an ordinary custom read action with an explicit output schema shared by the standard view. It returns ordinary board data, including record IDs and current card data. Generated CRUD contracts remain unchanged. Refresh invokes that allowlisted read action; mutation results are not assumed compatible with board props.

## Lifecycle and state ownership

- One action result owns one view. Initial presentation is an inline grouped task summary. Expanding it opens task selection and details; it is not a persistent workspace.
- Selection, filter, expansion, and draft are local. Card status and PR URL become domain state only after ordinary execution and authoritative refresh.
- Opening a task first refreshes authoritative data. A refresh failure leaves the previous snapshot visibly stale and disables submission.
- Validation failure or hook veto preserves the draft and selection, displays a safe error, and permits correction. No field values are copied into context messages.
- Refresh preserves an unsaved draft for a surviving selected task but marks it for review if authoritative task data changed. The user must confirm the reviewed draft before submission. If the selected task disappeared, clear selection and draft with a visible explanation.
- A successful mutation clears its draft only after successful authoritative refresh. If refresh fails, show “change confirmed; refresh failed”, retain local draft for reference, and disable resubmission until reconciliation.
- User-controlled closing discards drafts after explicit confirmation, disposes subscriptions, and requests cancellation. Native Escape asks for a second Escape to discard; browser navigation warns through `beforeunload` when permitted. Forced host dismissal, session switch, lease expiry and process exit cannot promise confirmation or draft persistence; they invalidate owned work without claiming rollback. Reopening or rerunning creates a fresh session and authoritative read; do not restore drafts from transcript details.
- A manifest-generation change invalidates the old session. Show a reload affordance, cancel pending work, and discard old snapshots/drafts after confirmation. Never mix old resource bytes with new bindings.

## Request ordering and recovery

Each read/mutation has a session-local monotonically increasing request ID and a generation token. Only a matching active request may update the view. Results for disposed sessions, earlier reads, or another generation are ignored. Requests and snapshots have bounded sizes; no append-only unbounded event history is retained.

At most one mutation may be pending per view. Submission and refresh controls are disabled while it is pending. Duplicate submit issues no second action. A client-side validation failure issues no request. Normal server validation and hooks remain authoritative.

Cancellation, disconnect, or a lost mutation response means **unknown commit status**, not rollback. Show an uncertain outcome, retain the draft, and require an authoritative read before another mutation. Do not automatically retry. A read establishes current state, but does not prove the causal outcome of the lost request when another actor could have edited the same card; label that distinction explicitly. Late mutation responses cannot overwrite a subsequent reconciled snapshot.

Current Kanban update input has no expected-revision comparison. Refresh-before-edit is a mitigation, **not lost-update protection**. Concurrent edits can still overwrite each other. Do not invent client-only conflict guarantees; adding optimistic domain concurrency requires a separately reviewed domain change.

## Human and agent visibility

Local filtering, navigation, field editing, and expansion do not send conversation messages. Never publish drafts, PR URLs, descriptions, credentials, or raw error causes as extra context.

Consequential interactions produce a bounded, redacted summary: canonical target, outcome (`confirmed`, `rejected`, or `uncertain`), and whether authoritative reconciliation succeeded. Errors use safe structured codes. Render that outcome visibly even if presentation subsequently fails.

### MCP Apps

Use only the pinned official Apps bridge. Verify a supported context-update mechanism in the reference host before claiming automatic agent visibility. If unavailable, show “Ask the agent to refresh the board before relying on this change” and require an explicit ordinary read tool call for agent reconciliation. The view's local refresh is not automatically a conversation update. Vendor/product name is never a capability check.

### Pi native

Accepted connection: configured authenticated gateway catalog/execute endpoints, not an assumed built-in MCP renderer. Credentials remain extension-side and are never included in documents or transcript state. Use registered tools for model-issued reads and the same dispatcher for UI requests.

Pi 1.0.0's public `pi.sendMessage()` records bounded model-visible custom messages with `display: true`, without automatic continuation. Verified fixtures cover idle delivery, active-branch and actual next-provider-request ordering, busy denial, malformed/undeclared outcomes, and tree/session/reload/shutdown disposal. Only declared target/status/safe code/reconciliation are copied, never drafts or props. The native extension coordinates one idle editor and blocks agent input/tool dispatch while it is active; publication failure requires explicit reconciliation. Authentication, native keyboard controls, installed extension loading and the real CLI PTY boundary are verified. A nested tool call alone remains insufficient: `ctx.executeTool()` does not create transcript tool-result entries.

Only `tui` may open native components. `print` and `json` produce deterministic fallback without prompts; `rpc` may use supported notifications/dialogs but must not call terminal-only components. Native keyboard interaction must complete the journey without browser handoff.

## Acceptance scenarios

| Scenario | Expected domain effect | Expected presentation |
|---|---|---|
| Initial board / open task | Read only | Grouped task summary, refreshed detail |
| Agent completes without PR | Hook veto, transaction rollback | Safe veto; draft and selection retained |
| Agent corrects PR and completes | One ordinary update | Pending, confirmed, authoritative board refresh |
| Human completes without PR | Update allowed | No fabricated agent veto |
| Duplicate submit | One mutation maximum | Disabled pending controls |
| Invalid PR | Validation rejection | Error and editable draft |
| Read results arrive out of order | None | Latest accepted request only |
| Cancel/disconnect during mutation | May have committed | Uncertain; no retry; read required |
| Refresh fails after success | Commit retained | Confirmed change; stale snapshot; submit disabled |
| Task removed / generation changes | None | Safe invalidation, no stale submission |
| Close/reopen | No assumed rollback | Dispose; new read; no persisted secret draft |
| Consequential outcome | Existing ordinary audit path | Redacted human-visible and agent reconciliation policy |
| Local navigation / sensitive draft | None | No added conversation context |

Run identical journey fixtures against web and native adapters. Also test ordinary HTTP, CLI, and non-Apps MCP domain behavior. State-machine fixtures alone do not establish host compatibility or release approval.

## Scoped approval and future gates

The interaction decisions and applicable increment A/B technical evidence are accepted in [the release matrix](genui-release-evidence.md). Scope is standard reference-host MCP Apps, Pi 1.0.0 and development-loopback browser sessions; no named vendor, physical-terminal/screen-reader certification, production browser session or custom-runtime claim is made. Additional hosts/deployments need fresh applicable evidence. Baseline legal/publication and operational gates remain independent.
