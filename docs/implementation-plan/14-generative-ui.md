# Phase 14 — Generative UI presentation

**Design:** [ADR 0005](../adr/0005-generative-ui-presentation.md). **Status:** P14-01 to P14-07. **Depends on:** P5-01, P8-01, P9-02, P10-03.

## Objective

Allow a human using an agent harness to receive an application-quality UI for an Embody action response while preserving the action as the single source of business behavior. The app owns a trusted view, the action returns validated data, and the client renders the best supported representation: MCP App, standalone browser, native Pi TUI, Markdown, or plain JSON.

This phase is a post-baseline feature track. It may be implemented in parallel with legal/commercial work, but GenUI must satisfy its own P14-07 security, packaging, compatibility, and documentation gates before any release advertises it as supported.

## Product invariants

1. **Data first:** an action succeeds independently of whether its caller can render UI.
2. **App-owned presentation:** application code registers views and action bindings. A model cannot submit executable HTML, JavaScript, CSS, resource URLs, or CSP.
3. **Static code, dynamic data:** cacheable view resources contain no tenant/action data. Validated action results are delivered separately as view props.
4. **One business path:** a click or form submission calls an ordinary Embody action through existing authentication, authorization, validation, hooks, transactions, cancellation, and audit.
5. **Progressive enhancement:** HTML is never the only representation. Unsupported and noninteractive clients retain stable JSON and deterministic Markdown/text.
6. **Explicit capabilities:** clients and views negotiate MCP Apps/display/tool-call capabilities; no behavior is inferred from a vendor name.
7. **Bounded content:** documents, props, resources, trees, tables, text, patches, and event rates have configured limits and fail with safe structured errors.

## Target experience and data flow

```text
human prompt
    -> agent calls an Embody MCP tool
    -> gateway dispatches the normal action
    -> app validates and returns domain output
    -> tool metadata identifies a registered ui:// view
    -> capable host reads the immutable view resource
    -> host renders it in a sandbox and delivers the tool result as props
    -> human interacts with the view
    -> host proxies an allowlisted tools/call under the same principal
    -> ordinary Embody execution returns the updated result

unsupported host
    -> receives the same successful action result
    -> displays deterministic Markdown/text or JSON
```

## Package shape and dependency rules

```text
packages/
  genui/                   @embody/genui
    core contracts and validators
    standard declarative component model
    web renderer and MCP Apps view runtime
    Markdown/plain-text renderer
    standalone browser/session support
  genui-pi/                @embody/genui-pi
    optional Pi extension
    native standard-component renderer
    browser fallback for custom web views
```

Integration changes belong in `core` only when transport-neutral, in `host` for app resource/runtime serving, in `mcp` for MCP Apps mapping, and in `cli`/the inspector only for fallback and developer behavior. `core` must not depend on either new package. `genui-pi` must not become a dependency of any server package.

## P14-01: protocol, compatibility, and public contracts

Before renderer code, add fixed accepted/rejected fixtures and settle the exact public contracts.

### View and binding contract

Define versioned equivalents of:

```ts
interface GenUiViewManifest {
  readonly protocolVersion: 1;
  readonly id: string;                 // canonical app-local ID
  readonly kind: "standard" | "custom";
  readonly description?: string;
  readonly propsSchema: JsonSchema;
  readonly resourceUri: string;        // ui://<app>/<view>@<version>
  readonly version: string;
  readonly callableTargets: readonly string[];
  readonly fallback: "markdown" | "text" | "json";
  readonly integrity: string;          // digest of immutable resource bytes and metadata
}

interface ActionPresentationManifest {
  readonly view: string;
}
```

The app manifest gains optional `views` and optional `presentation` on an action. Absence means the existing non-UI behavior. View IDs, resource URIs, target references, MIME type, semantic versions, hashes, and all size/count limits are validated at app boot and again at gateway registration.

### Author API

Specify and type-test an app-level API such as:

```ts
const presentation = defineGenUi({
  views: {
    board: defineStandardView({ props: BoardSchema, document: boardDocument }),
    diagram: defineCustomView({ props: DiagramSchema, resource: bundledHtml }),
  },
  actions: {
    "cards.board": "board",
  },
});

export default withGenUi(defineApp({ appId: "kanban", version: "1.0.0", plugins }), presentation);
```

The final spelling may change during P14-01, but these properties may not:

- presentation binds a canonical existing action target to a canonical existing view;
- each presented action has an output schema and that schema is compatible with the view props contract;
- bindings enrich the published runtime manifest without changing the kernel handler result;
- app/test code can inspect the same enriched manifest that registration sends;
- duplicate IDs, missing targets/views, incompatible schemas, and lossy `ui://` mappings fail before the app is ready.

Because exact Zod-schema equivalence is not generally decidable, protocol v1 uses one enforceable rule: the action output and view props must reference the same registered Zod schema object. The validated action output is delivered directly as props. Output projectors and special response envelopes are deferred; do not use unvalidated casts or compare generated JSON text heuristically.

### MCP Apps dependency decision

Run a compatibility spike against the stable MCP Apps specification and the repository's pinned MCP SDK. Record whether `@modelcontextprotocol/ext-apps` can be pinned without migrating the existing server SDK, or make the SDK migration an atomic reviewed change with all Phase-8 MCP tests. Do not maintain a divergent private Apps protocol.

### P14-01 tests and success criteria

- Accepted manifest fixtures round-trip with deterministic property ordering and resource hashes; old manifests without views still parse unchanged.
- Rejected fixtures cover unknown protocol/kind/fallback, malformed or duplicate IDs, non-`ui://` URI, URI collision, missing action/view, action without output, schema/projector mismatch, undeclared callable target, external origin, invalid digest, and every configured limit boundary.
- Compile-time tests infer action output/view props and reject a binding to incompatible props.
- API report proves `@embody/core` exposes only neutral optional manifest contracts and has no GenUI/MCP/Pi runtime dependency.
- An ADR or dependency note pins the stable MCP Apps protocol and SDK versions with an upgrade policy.

P14-01 passes when an implementing agent can build server and renderer independently from fixtures without choosing new wire semantics.

## P14-02: `@embody/genui` document model and renderers

### Standard component model

Implement a discriminated, versioned, immutable document tree. MVP nodes are:

- layout: `stack`, `columns`, `section`, `divider`;
- content: `text`, `markdown`, `code`, `diff`, `callout`, `image` with safe data/resource references;
- data: `keyValue`, `list`, `table`, `badge`;
- state: `progress`, `emptyState`, `errorState`;
- input: `field`, `select`, `checkbox`, `form`, `actions`.

Every interactive node has a stable node ID, accessible label, declared event schema, and semantic intent. Nodes contain data and action target references, never executable callbacks. Unknown node versions/types fail closed rather than rendering as raw HTML.

Define conservative defaults and configurable hard maxima for serialized bytes, depth, node count, text length, table rows/columns, option count, base64 media, and event payload size. Validation must be iterative or depth-guarded so malicious nesting cannot exhaust the JS stack.

### Web renderer

Ship a prebuilt, framework-private renderer artifact that:

- renders every standard node without `innerHTML` for untrusted values;
- sanitizes the supported Markdown subset and code/diff content;
- uses host theme variables with accessible defaults;
- supports keyboard-only operation, visible focus, reduced motion, narrow containers, high contrast, host resize, inline/fullscreen modes where negotiated, and loading/error/disabled states;
- initializes through the official MCP Apps bridge, receives tool input/result and host-context updates, and sends only declared requests;
- exposes no ambient credentials, cookies, storage, direct backend URL, or network access by default;
- produces deterministic DOM for the same normalized document and props.

### Text renderers

Provide pure deterministic Markdown and plain-text renderers. Interactive controls become numbered/labeled choices with target and effect descriptions; secrets and fields marked sensitive are redacted. Width-aware plain text must remain valid without ANSI support. JSON remains available as the existing machine fallback and is not reformatted on stdout unexpectedly.

### Trusted custom views

Support bundled HTML only from application build artifacts registered before boot. Compute an integrity digest, validate MIME type `text/html;profile=mcp-app`, and reject runtime URLs or tenant-specific bytes. Custom views use the same bridge helper, props validation, call allowlist, CSP declaration, and mandatory fallback contract as standard views.

### P14-02 tests and success criteria

- Unit/property tests cover every node, nested compositions, all limits, unknown versions, duplicate node IDs, invalid event schemas, and stable normalization/serialization.
- Golden Markdown/plain-text fixtures cover all nodes at narrow/wide widths and contain no ANSI or unstable object ordering.
- A browser test renders every node in light/dark, narrow/wide, reduced-motion, loading, error, and disabled states; screenshots are reviewed but semantic DOM assertions remain the primary gate.
- Automated accessibility checks report no serious/critical violations; keyboard tests reach and operate every control in logical order, and labels/roles/live regions are asserted.
- An XSS corpus in text, Markdown, code, URLs, labels, table values, host style variables, tool errors, and custom props never creates executable script, event attributes, unsafe URL navigation, or unsanitized HTML.
- CSP tests prove zero network/frame/device permission by default and exact no-wider-than-declared directives when permissions are configured.
- Renderer reconnect, duplicate result, out-of-order revision, malformed bridge message, unavailable tool call, cancellation, and disposal leave a stable recoverable state without leaked listeners/timers.
- Packed `@embody/genui` contains its renderer assets and can render them from an external consumer without source aliases.

P14-02 passes when one validated standard document renders equivalently as accessible web UI, Markdown, and plain text, and hostile content remains inert.

## P14-03: app host, manifest, resources, and execution integration

- Compile app presentation bindings after kernel boot and expose one authoritative enriched runtime manifest to registration, inspector, tests, and local development.
- Keep `Kernel.execute()` and HTTP action output semantics unchanged. Presentation metadata is selected from the target's manifest, and the already validated action output is delivered directly as view props. Presentation/resource failure cannot undo a committed action: the action remains successful, UI rendering is omitted, and a safe presentation error is audited.
- Register immutable resources by canonical URI and manifest generation. Serve standard renderer/custom bundles through a provider interface, not arbitrary filesystem paths.
- Add an authenticated internal app resource route only if the gateway cannot serve a resource locally. It must use short-lived audience-bound gateway credentials, body/time limits, immutable ETag, exact MIME type, and no path-derived file access.
- Ensure HTML/resource bytes never enter app registration manifests, logs, audit payloads, CLI output, or model context.
- Add development-only inspector endpoints for view catalog, validated fixture props, web preview, and fallback preview. Production retains the existing inspector prohibition.
- Support cache invalidation by manifest generation/integrity. In-flight MCP sessions may finish on their pinned generation; a new resource under old bytes must never reuse the same URI plus integrity value.

### P14-03 tests and success criteria

- Boot rejects every invalid binding before readiness; valid binding appears identically in runtime inspection and the signed registration body.
- Existing app with no GenUI configuration has byte-for-byte equivalent action behavior and no resource route/catalog.
- Action output validation still occurs once through the kernel, and only that validated output becomes view props. Presentation/resource failure or oversize cannot undo a committed action or leak its cause.
- Resource read returns exact bytes, MIME, metadata, ETag, and digest. Conditional read works; unknown URI/generation and traversal/encoded-traversal attempts fail safely.
- Authentication, audience, scope, body/time limit, cache, and redaction negative tests cover any remote resource endpoint.
- Concurrent tenants receive the same static resource bytes but only their own action data; cache keys and logs contain no tenant payload.
- Hot reload publishes a new generation, invalidates the old development preview, and does not mix old HTML with new props metadata.
- Inspector browser tests render malicious fixture values inert and are unavailable in production.

P14-03 passes when a real app can register one standard and one custom view without changing ordinary HTTP/CLI execution results or weakening tenant isolation.

## P14-04: MCP Apps catalog, resources, results, and interactions

Extend `@embody/mcp` and gateway integration using the stable official extension:

- negotiate `io.modelcontextprotocol/ui`; clients that omit it retain existing tools behavior;
- expose `resources/read` for authorized `ui://` resources and only advertise/list resources according to the stable spec;
- add `_meta.ui.resourceUri` and explicit `visibility` to bound tools without changing unbound tool fixtures;
- deliver validated action output/props through the standard tool result fields expected by the Apps bridge while retaining concise, valid fallback `content` for non-Apps clients;
- pin resource lookup, app identity, principal identity, scoped/global endpoint, and manifest generation to the MCP session;
- proxy view `tools/call` only to same-app `callableTargets`, only when visibility includes `app`, and under the session's current verified principal and normal gateway dispatch limits;
- forward cancellation, progress, structured safe errors, and request correlation without exposing gateway credentials to the iframe;
- deny cross-server tools, stale/removed targets, confused-deputy app IDs, and calls not associated with the initialized view.

Do not detect support from `clientInfo.name`. Use negotiated capabilities and produce a normal text tool result when the extension is absent or partially supported.

### P14-04 tests and success criteria

- Official MCP client plus an Apps reference/basic host initializes, lists a bound tool, reads its resource, calls it, delivers props, and renders the expected semantic DOM.
- A client with no Apps capability receives the pre-GenUI-compatible tool result and never receives a required `ui://` fetch.
- Global and app-scoped endpoints map view URIs deterministically without cross-app collision or resource disclosure.
- Resource reads and app-originated tool calls fail for wrong identity/session/app/generation, missing capability, absent `app` visibility, undeclared target, cross-app target, unhealthy app, revoked scope, and expired session.
- A UI action invokes the canonical downstream target once with the same org/actor, records the normal audit event, observes a hook veto, and presents its safe error.
- Two concurrent sessions/tenants never cross results, props, resource authorization, progress, or events.
- Cancellation from a closing view aborts downstream execution where supported; no terminal success is delivered afterward.
- Malformed JSON-RPC/postMessage-shaped values, oversized props/results, slow resource provider, and disconnect produce bounded cleanup and compliant errors.
- Existing Phase-8 MCP fixture and official-client tests pass unchanged for unbound tools.

P14-04 passes when the same reference action has equivalent domain result/error behavior through an Apps-capable and a plain official MCP client, with the former additionally rendering and safely invoking one action.

## P14-05: standalone browser and developer experience

Provide a browser fallback for harnesses without embedded Apps support, reusing the exact web renderer artifact and normalized view contract.

- Development mode may host a loopback-only presentation session with an unguessable, short-lived, single-purpose capability token.
- The URL fragment should carry bearer material where practical so it is not sent in referrers/access logs. Responses set `Cache-Control: no-store`, restrictive CSP, `Referrer-Policy: no-referrer`, frame policy, and no permissive CORS.
- A session is bound to app/view/result/principal purpose, expires deterministically, can be revoked, and cannot be upgraded into a general API credential.
- Production browser fallback is disabled until an authenticated deployment policy is explicitly configured; never silently expose a loopback development principal on a non-loopback listener.
- Add scaffold/build support for standard views and an optional custom-view asset pipeline. A generated app without GenUI remains unchanged.
- Inspector shows web and Markdown previews from the same fixture, resource metadata/CSP, callable targets, validation failures, and accessibility warnings.

### P14-05 tests and success criteria

- Browser E2E opens a generated one-time URL, renders the expected result, invokes one allowed action, and rejects reuse after expiry/revocation according to documented policy.
- Missing, guessed, leaked-query, wrong-view, wrong-purpose, expired, and replayed tokens fail without revealing whether a resource/result exists.
- Server binds loopback by default and production/non-loopback negative tests fail closed without approved auth configuration.
- Headers, CSP, no-store, referrer behavior, origin checks, WebSocket/SSE cleanup if used, and shutdown cleanup have automated assertions.
- The browser and MCP Apps paths use the same renderer build digest and pass the same semantic view fixture suite.
- Scaffolder packed-artifact test creates, builds, tests, and previews a GenUI-enabled app without importing monorepo source paths.

P14-05 passes when a non-MCP-Apps client can direct a human to a secure, temporary view without granting a general Embody credential.

## P14-06: `@embody/genui-pi` native adapter

Build an optional Pi package following Pi's extension and TUI APIs.

- Load only as an installed Pi extension; never patch Pi internals.
- Render standard nodes natively with terminal-width-safe components, host theme colors, keyboard navigation, expansion, and cancellation. Reuse Pi's existing selection/input/settings components where applicable.
- Persist only safe presentation references/state needed for session restore; do not copy secrets or full sensitive props into extra session entries.
- For a custom HTML view or unsupported standard node, show the deterministic text fallback and optionally open the P14-05 browser session after explicit user action.
- Guard behavior by Pi mode: full native UI in `tui`, supported notifications/dialogs in `rpc`, and pure text/JSON with no prompt in `print`/`json`.
- UI actions use the same normalized GenUI event/action contract and produce an ordinary result visible to both the human and agent where appropriate.
- Clean up overlays, listeners, browser sessions, and pending requests on cancellation, session switch, reload, and shutdown.

### P14-06 tests and success criteria

- Component tests assert every rendered line is within supplied visible width at narrow/wide widths and after theme invalidation.
- Keyboard tests cover focus order, selection, form editing/submission, expand/collapse, cancellation, and disabled controls without sleeps.
- TUI test renders the standard reference view, submits one event, receives an updated result, and displays a hook veto safely.
- `print`, `json`, and `rpc` tests never call TUI-only APIs or block waiting for input; output remains parseable and equivalent to core fallback.
- Custom HTML and unknown-node fixtures degrade to fallback/browser prompt rather than attempting to interpret HTML in the terminal.
- Session reload/switch/shutdown tests leave no active timer, overlay, request, or browser capability session and do not restore stale revision state.
- Package installation test loads the built extension through Pi's documented package mechanism with dependencies present in production installation.

P14-06 passes when the same standard document and user action used by the MCP Apps E2E work in Pi TUI, while all non-TUI modes remain deterministic and noninteractive.

## P14-07: reference proof, hardening, documentation, and release gate

Extend the Kanban reference application with one standard response view and one custom view only if the custom path adds clear proof. Recommended journey:

1. human asks an agent for the current sprint;
2. agent calls `kanban.cards.board`;
3. agent receives valid structured output and concise fallback;
4. Apps host renders columns/cards;
5. human attempts to complete a card without a PR and sees the existing hook veto;
6. human adds a PR and completes the card through the UI;
7. plain MCP, CLI, browser fallback, and Pi show equivalent final domain state.

Documentation must cover view authoring, standard components, custom bundles, build output, props, action allowlists, accessibility, CSP, browser fallback, Pi installation, testing, compatibility, and troubleshooting. Clearly distinguish supported hosts from protocol conformance; vendor smoke tests are dated evidence, not permanent capability assumptions.

### P14-07 security and non-functional tests

- Fuzz document/result/resource/bridge parsers for a fixed CI budget with no crash, hang, stack exhaustion, or unbounded allocation; retain discovered seeds.
- Soak repeated mount/update/unmount and session creation/expiry with bounded DOM nodes, listeners, timers, sessions, and memory.
- Record renderer asset size, cold resource-read latency, first render, update render, Markdown render, and 100 concurrent presentation-session memory baselines. Approve budgets before release claims.
- Verify dependency licenses/SBOM, package boundaries, API report, tarball contents, source maps, notices, and no fixture secrets or unpublished custom source in artifacts.
- Run Node/version compatibility and the existing full workspace suite. Browser tests run from packed artifacts and built assets, not dev-source aliases.
- Manual smoke against each advertised vendor host verifies render, theme, resize, one allowed interaction, one veto, fallback, and disconnect. Record product/version/date; failure removes the support claim rather than weakening automated conformance.

### Phase success criteria

Phase 14 is complete only when:

- the same Kanban action remains correct through HTTP, CLI, plain MCP, MCP Apps, standalone browser, and Pi;
- Apps/browser/Pi render the same standard semantic content and an interaction reaches the same canonical action with the same principal and policy outcome;
- a client with no UI support loses no domain capability and receives useful deterministic output;
- malicious content and undeclared actions remain inert/denied across web, text, and terminal renderers;
- resources and sessions are bounded, authenticated, generation-safe, and cleaned up under cancellation/restart;
- public API/protocol fixtures, package artifacts, user documentation, compatibility matrix, performance evidence, and `STATUS.md` command results are reviewed;
- no README or marketing material claims GenUI support for a harness that has only an unrecorded manual assumption.
