# `@embody/genui-pi`

Experimental installed Pi extension and native standard-document controls for Embody GenUI. See [the host guide](../../docs/guides/genui-hosts.md) for authoring, authenticated connection, browser comparison, lifecycle and limitations. The [scoped P14 technical gates](../../docs/guides/genui-release-evidence.md) pass for Pi 1.0.0; baseline publication remains gated. This package is not a blanket vendor or arbitrary Pi-version support claim.

## Install and connect

Build the package before local installation. Pi's documented package manifest loads `dist/extension.js`; published installation uses `pi install npm:@embody/genui-pi`. For a local package use `pi install ./packages/genui-pi`.

Configure `EMBODY_GATEWAY_URL`, `EMBODY_GATEWAY_TOKEN` and `EMBODY_GENUI_ADAPTER` (an **absolute local compiled app provider module**, e.g. Kanban's `dist/src/native-provider.js`). Never accept provider imports from props/resource HTML/model output. Run `/embody-view kanban kanban.board`. API credentials stay in the host; the native renderer never executes HTML. Discovery checks the authenticated manifest, official MCP resource URI/MIME/integrity and generation. Dispatch uses the public ordinary gateway action endpoint and pinned binding under the initiating principal.

`createPiGenUiExtension({ providers, connect })` is the programmatic factory seam. A provider contains app/target/view IDs, read targets, a props-validating document builder and declarative payload bindings. Install trusted app code explicitly; standard app browser code is not executable native code.

## Native controls and modes

`createPiGenUiComponent` implements Pi's component/focus/input lifecycle using Pi's own `Input` and key parsing. Tab/Shift+Tab changes focus, arrows change selects, Enter activates actions/forms, Ctrl+R refreshes, Ctrl+D discards a draft after authoritative reconciliation when review is required, and Escape closes (a second Escape confirms discarding an unsaved draft). Labels/content are terminal-safe and width-aware; private inputs are masked and never persisted. Layout/content nodes become summaries/lists rather than browser layout parity.

The native adapter is idle-only and blocks agent input/tools while an editor is active, including when notification fails. Rejection preserves the draft; correction follows the ordinary action path. Commit/refresh are distinct. Unknown outcome blocks mutation retries until an authoritative read. Session/tree/fork/reload/shutdown close the editor and owned requests. Reopen from current authoritative state, not a saved draft.

Print, JSON and RPC modes produce deterministic redacted text with no TUI-only API calls or input wait. Custom/unknown presentation is not interpreted as terminal HTML; use the ordinary domain action and its text/JSON fallback. Production browser handoff and native/browser appearance parity are not advertised.

## Minimal outcome reporter

`createPiOutcomeReporter(pi, ctx, { callableTargets, readTarget })` emits bounded human-visible `embody.genui.outcome` messages with `triggerTurn: false`. Only target/status/allowlisted safe code/reconciliation enter the next provider request; drafts, props, task IDs, PR URLs, credentials and raw causes do not. Even a confirmed refreshed outcome tells the agent to read the ordinary action before relying on domain state.

`report()` returns `recorded`, `invalid`, `busy` or `disposed`; it does not queue busy outcomes or trigger a turn. This helper alone does not coordinate agent concurrency; the extension owns that guard. Disposal unsubscribes and is idempotent. The host must deduplicate publication and explicitly reconcile if delivery is unavailable.

## Evidence and compatibility

Development pins the official Pi SDK/TUI **1.0.0**; the `*` peer ranges follow Pi's package convention and are not compatibility evidence for other versions. Both packages are host-provided peers, never bundled into a server or renderer artifact.

Public SDK tests cover modes, active-editor/provider ordering, actual next-provider-request visibility/redaction, reporter busy/lifecycle behavior, native keyboard edit/veto/correction, width and disposal. The authenticated Kanban fixture discovers real gateway/host bindings and mutates under the initiating agent, retaining the PR guardrail. The packed smoke discovers/loads this package through its installed Pi manifest outside the workspace. Apps reference-host mutations also reach a real Pi reporter and the next offline provider request. Actual Pi CLI pseudo-terminal checks additionally verify fullscreen/dark and regular/light keyboard veto/correction, secret masking, resize and shutdown on Node 22/24. These are **not physical-terminal/IME/screen-reader certification, vendor certification or publication approval**.

```sh
pnpm --filter @embody/genui-pi test
pnpm --filter @embody/example-kanban test
pnpm test:genui-consumer
```

The full technical release matrix, performance budgets and independent baseline publication gates are in [the release evidence](../../docs/guides/genui-release-evidence.md) and `docs/implementation-plan/STATUS.md`. `pnpm test:genui-release` requires actual PostgreSQL execution; it does not count skips as evidence.
