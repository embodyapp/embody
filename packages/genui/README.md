# `@embody/genui`

App-owned presentation contracts for Embody action results.

> Experimental candidate: bounded standard documents, text/web rendering, shared controllers/declarative payloads, official Apps runtime, authenticated gateway client and temporary loopback-browser handoff. The separate `@embody/genui-pi` package provides installed native controls. See [the host workflow/evidence guide](../../docs/guides/genui-hosts.md). The scoped P14 technical gates pass; [the release matrix](../../docs/guides/genui-release-evidence.md) records versions, budgets and limits. Baseline publication approval, vendor certification and production browser sessions are not claimed.

## Contract

A presented action returns ordinary validated domain data. Its registered view receives that same value as props. Protocol v1 deliberately has no output projector or special response envelope, so HTTP, CLI, and non-UI MCP behavior remain unchanged.

The action output and view props must use the same Zod schema object:

```ts
import { definePlugin, z } from "@embody/core";
import { defineGenUi, defineView, withGenUi } from "@embody/genui";

const BoardResult = z.object({
  title: z.string(),
  cards: z.array(z.object({ id: z.string(), title: z.string() })),
});

const cards = definePlugin({
  id: "cards",
  version: "1.0.0",
  actions: {
    board: {
      input: z.object({}),
      output: BoardResult,
      handler: async () => ({ title: "Sprint", cards: [] }),
    },
  },
});

const presentation = defineGenUi({
  views: {
    board: defineView({
      kind: "standard",
      version: "1.0.0",
      props: BoardResult,
      resource: { text: "<!doctype html><main id=\"app\"></main>" },
      fallback: "markdown",
    }),
  },
  actions: { "cards.board": "board" },
});

export default withGenUi(
  { appId: "kanban", version: "1.0.0", plugins: [cards] },
  presentation,
);
```

`compileGenUiManifest()` produces optional, protocol-version-1 view metadata and action bindings without mutating the base kernel manifest or action output.

## Experimental standard documents and text fallback

```ts
import { parseGenUiDocument } from "@embody/genui/document";
import { renderGenUiMarkdown, renderGenUiText } from "@embody/genui/text";

const document = parseGenUiDocument({
  version: 1,
  root: {
    version: 1,
    type: "section",
    title: "Current sprint",
    children: [{
      version: 1,
      type: "list",
      items: [
        { version: 1, type: "text", text: "Add login" },
        { version: 1, type: "text", text: "Write integration tests" },
      ],
    }],
  },
});

const markdown = renderGenUiMarkdown(document);
const text = renderGenUiText(document, { width: 80 });
```

Documents and nodes use version `1`. The parsed result is detached and deeply frozen. Unknown versions, types, properties, duplicate interactive IDs, callbacks, cyclic data, and accessor-backed objects fail closed with a `GenUiDocumentError` (`GENUI_INVALID_DOCUMENT`); messages do not include supplied values. Shared acyclic author definitions may be reused. `serializeGenUiDocument()` produces canonical, sorted-key JSON for fixtures; **it contains dynamic data and must not be put in static resources or extra model context**.

| Nodes | Text behavior |
|---|---|
| `stack`, `columns`, `section` | Ordered vertical sections; columns degrade to groups |
| `text`, `callout`, `keyValue`, `list`, `badge` | Escaped content, labeled values and list items |
| `emptyState`, `errorState` | Useful empty/error messages |
| `field`, `select` | Labeled values and numbered options |
| `form`, `actions` | Labeled submit/numbered actions, effect descriptions and canonical targets |

Text/Markdown values marked `sensitive` are redacted. Sensitive selects also hide option labels. Terminal escapes, control characters and directional override/isolate characters are stripped. Markdown input is treated as text, not trusted Markdown/HTML. Plain text wraps by terminal columns without splitting Unicode graphemes, defaults to width 80, accepts widths 2–1000, and contains no ANSI. These pure functions return strings; they do not print, alter action JSON, dispatch actions, or automatically integrate with CLI/MCP/Pi output.

### Events and limits

Interactive controls require a stable `id`, accessible `label`, and an event declaration. Fields/selects declare `intent: "change"` with an object schema containing a required string `value`. Forms declare `intent: "submit"`; actions declare `intent: "invoke"`; both require a canonical `target`, a human-readable effect, and a schema for ordinary action input. No callbacks are embedded in nodes.

`parseGenUiEvent(document, nodeId, payload, { callableTargets })` validates payloads and rejects unavailable, disabled or pending controls. A pending/disabled form disables descendants. Action events fail closed unless the target appears in the supplied **trusted manifest allowlist**; local change events need no action target. The function returns the validated payload, not a special action envelope. Authentication, same-app/session identity, scope checks, generation pinning and actual dispatch still belong to adapters and ordinary Embody execution. Never derive authority from a model-authored document or caller-supplied allowlist.

The supported event JSON Schema subset includes bounded strings (optional enums), booleans, bounded integers and nested strict objects (`additionalProperties: false`, explicit `required`). Arrays, references, patterns, remote schemas and other keywords are rejected. String maxima are at most 8192 characters; objects have at most 100 properties. Server/domain validation, including URL checks and hooks, remains authoritative.

| Limit | Default | Hard maximum |
|---|---:|---:|
| Serialized document bytes | 256 KiB | 1 MiB |
| JSON nesting depth (containers include arrays) | 32 | 64 |
| Document nodes, including action choices | 2000 | 10000 |
| Text length (UTF-16 code units) | 8192 | 32768 |
| Select options / action choices / enum values | 100 | 500 |
| Event payload bytes | 16 KiB | 64 KiB |

Pass partial limit overrides to `parseGenUiDocument()`, or `{ limits }` to render/event functions. Non-integer, non-positive, or above-hard-max configurations are rejected. An additional fixed 100,000-value JSON bound protects structural traversal. Iterative JSON checks precede bounded recursive schema parsing. The document/text/session subpaths do not import core or Node crypto; this is a module boundary, not a browser-host compatibility claim.

Run `pnpm test:genui-consumer` from the workspace root to build, pack and exercise the root and subpath exports in an external consumer with runtime dependencies installed.

## Experimental presentation sessions

`createGenUiSession()` manages local drafts and request ordering independently of a renderer. Supply a validated initial snapshot, its Zod schema, an ordinary read target, explicitly declared mutation input schemas, and an authenticated dispatcher `(target, input, signal) => Promise<unknown>`.

- `edit(draft)` replaces the local draft; it does not change domain state.
- `submit(target)` validates the draft, prevents duplicate submission, and refreshes through the read target after confirmed success.
- A hook veto or validation failure preserves the draft and reports a redacted code.
- A lost response or cancelled mutation is uncertain, not assumed rolled back. Submission stays blocked until `refresh()` succeeds; refresh does not prove which request caused the observed state.
- A refresh failure cannot reverse a confirmed mutation. The snapshot remains marked stale.
- `cancel()` invalidates pending results and aborts the dispatcher signal. `dispose()` also clears the draft and permanently closes the session; it is the unconditional cleanup path for shutdown.
- Supply an app-owned `items(snapshot)` mapping to use task selection. `openItem(id)` refreshes first; changing selection with a draft requires `{ discardDraft: true }`.
- If the selected item's data changes on refresh, the draft is preserved but `reviewRequired` blocks submission until `confirmReview()`. Reopening the item cannot bypass review. This is not domain lost-update protection.
- If the selected item disappears, selection and draft are cleared and `notice` becomes `selection-removed`.
- `invalidateGeneration(newGeneration)` makes an old session unusable, cancels requests, and preserves drafts for discard confirmation. `close({ discardDraft: true })` confirms discard; create a new session for the new generation.
- Reads are correlated so late results cannot replace a newer snapshot. The exposed state is a detached copy.

Drafts are JSON trees limited to 64 KiB; snapshots are limited to 1 MiB before and after Zod validation. Both have depth 32 and 10,000-value limits; cyclic/shared object references and non-JSON values are rejected. Oversized refreshed snapshots leave the previous snapshot stale. A successful recovery read clears the original confirmed mutation draft, but not a new draft explicitly edited since that mutation. Do not persist drafts or publish them as conversation context. `state.outcome` contains only the target, status, and a safe error code; adapters still need to verify their human/agent visibility mechanism.

The `/controller` seam composes result-attached document navigation/refresh with authenticated ordinary dispatch; `/payload` provides bounded declarative payload composition. Host integrations and real Kanban/next-provider-request fixtures are documented in [the host guide](../../docs/guides/genui-hosts.md). The dispatcher owns identity, authorization, ordinary execution, response validation and transport cleanup; controllers are not authorization boundaries. Pure text rendering has no automatic dispatch/context delivery.

`parseGenUiResourceJson` decodes bounded transport JSON containing static HTML, the MCP Apps MIME type and strict CSP/permission/border metadata. It rejects unknown fields and malformed resources with value-free errors. Parsing does not authorize executable content: consumers must compare resource integrity with a trusted, generation-pinned manifest before using it.

## Experimental web renderer and official Apps host

`@embody/genui/web` exports `mountGenUiWeb(container, document, options)`. The renderer supports the 14 standard nodes with semantic DOM, native labeled controls, sensitive display redaction, keyboard-only operation, responsive columns, visible focus, system light/dark colors and reduced-motion/high-contrast defaults. It never interprets supplied text as markup, CSS or URLs and uses CSP-compatible, non-JIT validators.

`options.callableTargets` is trusted authority, not document data. `resolveAction(nodeId, values)` is app-owned payload composition; its output still passes the declared event schema before `onEvent` receives it. Only the authenticated adapter may execute it. Pending submissions disable controls and prevent duplicates; rejection preserves input. Exceptions are uncertain, not proof of rollback. `view.update(document)` refuses dirty replacement with `review-required`; explicit `{ discardDraft: true }` accepts authoritative replacement. `dispose()` removes listeners and aborts owned requests. Forms emit declared events without requiring iframe `allow-forms` permission.

`@embody/genui/apps` exports `createGenUiAppBridge`, using official ext-apps 1.7.5 `AppBridge` without broad automatic forwarding. Each instance belongs to one initialized view/generation, permits only declared app-visible mapped tools, rejects foreign apps/stale generations, and keeps authenticated dispatch credentials in the host. Mutation outcomes are minimal and ordered; the caller must implement `publishOutcome` using a verified next-agent-request context mechanism. Read-only entries should specify `effect: "read"`. Safe definitive error codes distinguish veto from uncertain transport failure; publication failure never undoes a confirmed domain result.

Built assets are exported as `@embody/genui/renderer` (ES module) and `@embody/genui/renderer-global.js` (classic script exposing `EmbodyGenUi`, useful in opaque iframes without module CORS). Both include the same web renderer and official Apps APIs, contain no domain props, and are bundled with source maps/license comments. App-owned props-to-document builders remain trusted compiled code; this does not add a server-side action projector or model-authored HTML.

Run `pnpm --filter @embody/genui exec playwright install chromium`, then `pnpm --filter @embody/genui test:browser`. `CHROME_PATH` may select an installed Chrome executable. The tests use built assets, a no-eval/no-network CSP, an opaque iframe, keyboard interactions and axe serious/critical checks. `node scripts/test-genui-packed-consumer.mjs --browser` additionally verifies the installed tarball asset outside the workspace (run with pnpm on PATH).

The authenticated Kanban native/standalone/official Apps journey and plain MCP/CLI final-state comparison are executable fixtures. Apps mutations reach minimal actual next-provider-request Pi context. `/app-runtime`, `/client` and `/browser` are documented in the host guide; the scoped technical gates are recorded in [the release evidence](../../docs/guides/genui-release-evidence.md), without vendor certification or publication approval. Built bundle component inventories and license text accompany assets in `dist/THIRD-PARTY-LICENSES.{json,txt}`; redistribute these with served assets. ext-apps 1.7.5's extensionless inherited declaration imports require a small documented public-lifecycle type adapter for NodeNext; no SDK internals are patched.

## Security boundary

`resource.text` is a trusted immutable application build artifact. Never pass model-authored or action-input HTML, JavaScript, CSS, resource URLs, or CSP declarations to `defineView`. Resource integrity covers the HTML bytes and security/rendering metadata; tenant action data is delivered separately and is never included in the resource hash.
