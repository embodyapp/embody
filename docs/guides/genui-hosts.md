# GenUI interactive hosts — verified subset

P14's standard reference-host MCP Apps, Pi 1.0.0 native controls and development-loopback browser handoff have passed their scoped technical gates. See [completion evidence and support limits](genui-release-evidence.md). This guide is an implementation workflow, **not baseline publication approval or vendor certification**. Read [the interaction contract](genui-reference-journey.md) and [the roadmap](../implementation-plan/14-generative-ui.md). Custom HTML runtime, general production browser sessions and vendor-name inference are not supported.

## Build and author

An action still returns its registered output unchanged. Its view props use the same schema object. App-owned pure builders turn that output into a bounded `GenUiDocument`; mark private fields sensitive. `examples/kanban/src/schemas.ts` is browser-safe and shared with the ordinary plugin; importing the entire server kernel into browser code is unnecessary. `presentation.ts` builds the documents and `native-provider.ts` declares payload bindings. No projector or special domain-result envelope is added.

`GenUiPayloadBinding` has only `literal`, `field` and `object` nodes. `omitEmpty` omits optional empty fields, allowing the ordinary Kanban PR hook to veto a missing PR instead of mistakenly treating an empty URL as a valid PR. Bindings contain data, not code. `resolveGenUiPayload` only composes input; `parseGenUiEvent` independently validates node, schema, options, disabled ancestors and the trusted target allowlist. Installed author callbacks are trusted code, never resource/model-provided imports.

Build GenUI and the Kanban example before running it. `examples/kanban/scripts/build-presentation.mjs` creates `dist/kanban-app.html` with the official Apps runtime, compiled app builders and an exact script hash CSP. That static artifact contains no action data and is registered through `embody.config.ts`. Its immutable resource and enriched manifest are what runtime registration publishes. Builds fail if the resource exceeds the 1 MiB protocol limit. Existing non-GenUI apps and generated apps are unaffected.

## Common interaction controller

`@embody/genui/controller` exports `createGenUiController`. Each instance belongs to one result-attached view, owns its current document/read reference, and has one authenticated ordinary `dispatch` callback. Read navigation has no extra conversation publication. Mutation outcomes contain only target/status/safe code/reconciliation. A confirmed commit remains confirmed if refresh or rendering fails. An uncertain outcome or failed authoritative read blocks another mutation until recovery; it is never blindly retried. Renderers visibly disable action controls for stale/unreconciled state while retaining editable drafts. Host-owned web integrations call `view.markStale()` after a failed read; a verified authoritative replacement restores the controls.

The web/native adapters preserve a rejected draft. External refresh requires explicit draft discard/review, not an implication of concurrency protection. Kanban does not implement expected-revision writes; refresh and review cannot eliminate the read/write race. User-controlled dirty-view closure requests explicit discard confirmation (second Escape in Pi; browser navigation warning where supported). Closing a view aborts owned work and forgets drafts; forced host/session/process dismissal cannot guarantee a confirmation dialog or rollback. Reopening obtains new authoritative props. Domain persistence remains the ordinary app's responsibility.

## Official Apps runtime and host

`@embody/genui/app-runtime` exports `startGenUiApp`. Trusted compiled app code supplies props builders, read targets and the target-to-tool map. The runtime uses the official `App`, receives the initial tool result, makes declared ordinary calls, refreshes the selected read and handles teardown. Unsolicited duplicate/replacement results do not overwrite a dirty editor; they prompt an explicit refresh. Host light/dark and display-mode enums are accepted; arbitrary host CSS/fonts/URLs are deliberately ignored. Layout uses accessible system colors and native resize-friendly CSS.

`@embody/genui/apps` exports `createGenUiAppBridge` for a trusted host. One bridge is required per initialized view/generation. It selects only mapped same-app app-visible tools from an authenticated catalog. Credentials live in the host callback, never the opaque iframe. Ordinary SDK/client cancellation and safe definitive error metadata distinguish a veto from uncertain transport failure. The host's `publishOutcome` must deliver minimal context in order, without triggering an agent turn. If publication is unavailable, require an explicit authoritative read before agent reliance; a successful domain mutation is not reversed.

Reference tests use `sandbox="allow-scripts"` without `allow-same-origin` or `allow-forms`. Buttons emit validated declared events instead of blocked native form navigation. Real Kanban tests read the registered resource, initialize official App/AppBridge, open a task, observe the agent-only PR veto, supply a PR, mutate through the gateway and refresh the task. Reference conformance does not imply Claude/ChatGPT/Codex support.

## Authenticated native Pi

Install `@embody/genui-pi` as a Pi package (after publication: `pi install npm:@embody/genui-pi`; locally: `pi install ./packages/genui-pi`). Its manifest loads `dist/extension.js`; Pi SDK/TUI are host-provided peers, not bundled. Build local packages first. The packed-consumer smoke loads the installed manifest through Pi 1.0.0's documented resource loader.

Configure the gateway and an explicitly trusted **absolute local compiled provider module**:

```sh
export EMBODY_GATEWAY_URL=http://127.0.0.1:3000
export EMBODY_GATEWAY_TOKEN='<your initiating principal credential>'
export EMBODY_GENUI_ADAPTER=/absolute/path/to/kanban/dist/src/native-provider.js
pi
# /embody-view kanban kanban.board
```

Do not put credentials in prompts, CLI arguments or adapter exports. Production connections require HTTPS; HTTP is allowed only for explicit loopback endpoints. Discovery uses the authenticated catalog and official MCP resource read, checking MIME, canonical URI, generation and integrity. Native rendering does not execute resource HTML. Dispatch uses the public canonical gateway HTTP action route with a pinned view/generation header, preserving the API-key actor and normal validation/hooks/audit. A revoked or replaced binding fails closed.

Native controls reuse Pi's `Input` and key parser. Tab/Shift+Tab focus controls; arrows operate selects; Enter activates actions/forms; Ctrl+R refreshes; Ctrl+D explicitly discards a draft when review is required and an authoritative read has succeeded; Escape closes, with a second Escape required to discard an unsaved draft. Sensitive input is held locally and rendered hidden, not copied into additional session entries. Sections/columns/lists degrade to width-safe summaries; no browser is needed for the Kanban journey. Native screen-reader/IME parity and full browser layout parity are not claimed.

The adapter permits only one idle editor. Agent input/tool dispatch is blocked while it is active, even if host notification fails. The public SDK test verifies no provider request during editing and ordered redacted outcomes in the actual next provider request. Print, JSON and RPC modes produce deterministic redacted text without calling TUI-only APIs or waiting for input. Switch/tree/fork/reload/shutdown invalidate owned state and abort requests; no stale props/draft are restored.

## Temporary browser handoff and fixture preview

`@embody/genui/browser` exports `createGenUiBrowserHost({ mode: "development" })`. It binds `127.0.0.1` (or explicit `::1`) only. Production and non-loopback configurations fail closed. `open` binds a controller and payload builders to a fixed app/view/generation; its fragment contains a 256-bit one-time launch token. The page erases the fragment immediately and exchanges it for a separate in-memory, view-only lease. No upstream API credential enters the page or browser storage.

A lease expires in 60 seconds by default (hard maximum 5 minutes); it can be revoked and has a hard 100-request budget. A host has at most 100 sessions. Exact Host/Origin, non-permissive CORS, no-store/no-referrer/frame/device policies, request bounds and owned cancellation apply. Missing/guessed/query/replayed/revoked/expired capabilities receive the same unavailable response. Reloading an erased URL does not recover the lease: open a fresh result. This is not a general API credential or production login mechanism.

For the manual Kanban workflow, build the app, start/register it and the authenticated gateway, set the two gateway environment variables above, then run:

```sh
node examples/kanban/scripts/browser.mjs
```

Open the printed private one-time loopback URL. This authoring process has **no automatic agent context connection**: the browser says so after mutations, and the process emits only a minimal outcome. Explicitly ask the agent to read `kanban.board` before relying on current state. Ctrl+C revokes the lease and closes the server/client. A host-integrated caller instead supplies a verified `publishOutcome` implementation, such as Pi's reporter.

For development diagnostics, inspect `runtime.manifest.actions[target].presentation`, its bound view's URI/props schema/targets/integrity, and `runtime.generation`; never log `readResource(...).text` or props. Use a purpose-bound authenticated resource read to diagnose MIME/digest failures. The same loopback host can preview an app-owned fixture document with a no-authority dispatch callback; production inspector prohibitions remain unchanged.

## Verification and limitations

Run supported Node 22/24 with pnpm 11.25.0. The browser test requires managed Playwright Chromium or `CHROME_PATH`. The public-seam test inventory includes:

- GenUI unit/controller/payload/parser cases and fixed-budget adversarial seeds;
- all-node Chrome/axe/keyboard/CSP/opaque-iframe tests;
- 300 mount/update/dispose cycles and 10,000 replacements of one view;
- browser one-time exchange, expiry/revocation/CSRF/listener shutdown and 100-session bounds;
- real authenticated Kanban native, standalone and Apps interaction;
- public Pi modes, active-editor/provider ordering, redaction and lifecycle;
- external tarball renderer and installed Pi manifest/load smokes.

Run `pnpm test:genui-release` with an isolated, pre-migrated PostgreSQL test database configured through `EMBODY_POSTGRES_URL` and, for a non-owner role, `EMBODY_POSTGRES_SKIP_SCHEMA=true`. The aggregate requires actual database execution; missing configuration fails rather than counting skips as evidence. The [release matrix](genui-release-evidence.md) records Node 22/24, PostgreSQL 16.14, packed artifacts, real CLI PTY, reviewed screenshots, performance budgets and security results. Baseline legal/publication gates remain independent blockers. New vendor hosts, physical-terminal/IME certification, production browser deployments and custom runtime require their own evidence.
