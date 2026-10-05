# Phase 14 — Generative UI presentation

**Design:** [ADR 0005](../adr/0005-generative-ui-presentation.md). **Status:** P14-00 to P14-07 complete for scoped increments A–B (2026-10-04). **Depends on:** P5-01, P8-01, P9-02, P10-03.

**Completion record:** [reviewed evidence and support matrix](../guides/genui-release-evidence.md). Verified scope is standard MCP Apps reference-host behavior, Pi 1.0.0 and development-loopback browser handoff. Baseline publication/legal gates remain open; no vendor certification, production browser sessions or custom-runtime support is implied. The requirements below remain the contract for future changes.

## Objective

Allow a human using an agent harness to receive an application-quality UI for an Embody action response while preserving the action as the single source of business behavior. The app owns a trusted view, the action returns validated data, and the client renders the best supported representation: MCP App, standalone browser, native Pi TUI, Markdown, or plain JSON.

This phase is a post-baseline, incremental roadmap, not one MVP-sized delivery. It may be implemented in parallel with legal/commercial work. Each advertised capability must pass the applicable P14-07 security, packaging, compatibility, and documentation gates; version one requires both the MCP Apps vertical slice and the native Pi subset to pass their gates. Standalone-browser support is not required. Baseline legal/publication gates still apply.

## Delivery strategy: prove the journey first

Begin with the Kanban journey, not a comprehensive component catalog:

1. A human asks an agent for the current sprint and receives an inline board summary.
2. The human opens a task and attempts a consequential change.
3. The UI displays an existing policy veto, preserves the draft, and allows correction.
4. The human supplies a PR and completes the task through an ordinary action.
5. The view refreshes from authoritative app data, and the agent can learn the consequential outcome through the supported host mechanism.

The existing Kanban PR guardrail is actor-specific. P14-00 must specify the initiating principal and an applicable veto scenario; do not assume a human click triggers an agent-only hook or change actor identity merely to make the demo pass.

Delivery order:

| Increment | Required work | Support claim |
|---|---|---|
| A: version one — MCP Apps + native Pi | P14-00, P14-01, minimal P14-02/P14-03, P14-04, P14-06, applicable P14-07 evidence for both surfaces | Standard Kanban experience on a verified MCP Apps host and in Pi TUI; useful plain-client/noninteractive fallback |
| B: browser handoff | P14-05 plus browser-specific P14-07 evidence | Secure temporary browser views in explicitly supported deployment modes |
| Later expansion | Additional components, custom HTML runtime, richer inspector/scaffolder support | Only capabilities with their own reviewed evidence |

Move reference-app fixtures and E2E proof into every increment rather than waiting until the roadmap ends. A reference-host conformance test is not a vendor support claim. Publish a dated support matrix naming host/product/version, supported interactions, limitations, and verified fallback behavior. No support for Claude, ChatGPT, Codex, or Pi is inferred from its name.

## P14-00: reference journey and interaction semantics

This new planning gate precedes renderer work without reopening the implemented P14-01 contracts. Write a reviewed interaction specification and executable fixtures for the journey above before expanding the component vocabulary.

### Required decisions

- **Presentation lifecycle:** choose when a result merits a view, inline versus expanded presentation, how task details open, and what closing/reopening or rerunning a tool does. The first slice is a result-attached view, not a persistent workspace or durable human-input session.
- **State ownership:** domain state belongs to the app. Filters, selection, expansion, and unsaved drafts are view-local state, never proof that a domain mutation succeeded. Define draft preservation/reset on refresh, failure, closure, and resource-generation change.
- **Action outcomes:** specify pending/disabled states, prevention of duplicate submissions, inline validation and hook errors, cancellation, and recovery from an ambiguous outcome. Do not blindly retry a mutation when cancellation/disconnect leaves commit status unknown; refetch authoritative state or use an existing domain idempotency mechanism.
- **Refresh and replacement:** choose whether a successful mutation replaces props directly or invokes an allowlisted read action. Specify result correlation, late/out-of-order result handling, selected-task continuity, and whether the original view updates or a new result is appended. Do not add a special action envelope or output projector to solve renderer state.
- **Stale data and conflicts:** define snapshot freshness and refresh affordances. Use existing domain revision/conflict checks where available; otherwise document the limitation and refresh-before-edit policy. Do not imply lost-update protection that the domain does not provide. Live subscriptions and optimistic updates are not required for the first slice.
- **Conversation visibility:** local navigation/filtering need not produce chat messages. A consequential mutation must have a declared, redacted outcome visible to the human and available to the agent through a verified host mechanism. Define whether this is a tool result, supported context update, or explicit follow-up read; audit logging alone is not conversation visibility. If the host cannot provide automatic visibility, show a clear limitation and require an explicit reconciliation path before the agent relies on the changed state.
- **Identity and policy:** identify the principal/actor for each interaction, permitted actions, and expected veto. UI interactions must not impersonate another actor to obtain or evade a policy outcome.

### Tests and success criteria

- Reviewed fixtures specify initial render, open task, pending mutation, veto, correction, successful mutation, authoritative refresh, and human/agent-visible outcome in both MCP Apps and Pi TUI. Validate Pi tool access and agent visibility early, not after web interaction semantics are finalized.
- State-transition tests cover duplicate submit, validation error, cancellation with unknown commit status, stale props, conflicting edit where supported, out-of-order results, disconnect, and reopen.
- Local-only events and consequential events have explicit visibility/redaction assertions; no secret draft fields are copied into conversation context.
- Record unresolved host limitations and the verified reconciliation path. The journey fails its acceptance gate if the agent can silently rely on stale state after a consequential UI change.

P14-00 passes when renderer and transport implementers can implement the same journey without inventing lifecycle, identity, refresh, or conversation behavior. See the [GenUI glossary](../guides/genui-glossary.md).

## Product invariants

1. **Data first:** an action succeeds independently of whether its caller can render UI.
2. **App-owned presentation:** application code registers views and action bindings. A model cannot submit executable HTML, JavaScript, CSS, resource URLs, or CSP.
3. **Static code, dynamic data:** cacheable view resources contain no tenant/action data. Validated action results are delivered separately as view props.
4. **One business path:** a click or form submission calls an ordinary Embody action through existing authentication, authorization, validation, hooks, transactions, cancellation, and audit.
5. **Progressive enhancement:** HTML is never the only representation. Unsupported and noninteractive clients retain stable JSON and deterministic Markdown/text.
6. **Explicit capabilities:** clients and views negotiate MCP Apps/display/tool-call capabilities; no behavior is inferred from a vendor name.
7. **Semantic portability:** renderers preserve relevant information, policy outcomes, and useful actions, not identical appearance or interaction mechanics. Unsupported rich nodes have documented text/browser degradation.
8. **State and conversation coherence:** local UI state is distinct from authoritative domain state; consequential changes have a defined human/agent visibility and reconciliation policy.
9. **Bounded content:** documents, props, resources, trees, tables, text, patches, and event rates have configured limits and fail with safe structured errors.

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

Because exact Zod-schema equivalence is not generally decidable, protocol v1 uses one enforceable rule: the action output and view props must reference the same registered Zod schema object. The validated action output is delivered directly as props. This is an enforceable first-increment constraint, not a permanent claim that presentation and domain schemas must always coincide. Collect concrete reuse/projection pain points before proposing a versioned alternative. Output projectors and special response envelopes are deferred; do not use unvalidated casts or compare generated JSON text heuristically.

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

Implement a discriminated, versioned, immutable document tree after P14-00. The first slice includes only nodes required by the reviewed Kanban journey:

- layout: `stack`, `columns`, `section`;
- content/data: `text`, `callout`, `keyValue`, `list`, `badge`;
- state: `emptyState`, `errorState` (pending/disabled behavior is part of controls);
- input: `field`, `select`, `form`, `actions`.

Compose the board from columns and task lists; do not introduce a specialized board language before proving the journey. If a listed node is unnecessary, defer it with an explicit fixture/scope update.

Later candidates, driven by concrete workflows, are `divider`, `markdown`, `code`, `diff`, `image` with safe data/resource references, `table`, `progress`, and `checkbox`. They are not first-release requirements. Schema-driven default views and safe agent-composed documents require separate proposals and are not implied by this component vocabulary.

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

### Trusted custom views — deferred runtime

P14-01's custom-view contracts and security boundaries remain valid, but custom HTML rendering, its asset pipeline, and custom-view support claims are not required for increment A. Unimplemented custom paths must fail safely or use a verified fallback, never silently claim runtime support. Add the following proof when a concrete use case justifies this escape hatch.

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

P14-02's first increment passes when the journey's validated standard document renders semantically equivalent information as accessible web UI, Markdown, and plain text, and hostile content remains inert. Tests referring to every node mean every shipped node; custom-runtime tests gate that later capability, not increment A.

## P14-03: app host, manifest, resources, and execution integration

- Compile app presentation bindings after kernel boot and expose one authoritative enriched runtime manifest to registration, inspector, tests, and local development.
- Keep `Kernel.execute()` and HTTP action output semantics unchanged. Presentation metadata is selected from the target's manifest, and the already validated action output is delivered directly as view props. Presentation/resource failure cannot undo a committed action: the action remains successful, UI rendering is omitted, and a safe presentation error is audited.
- Register immutable resources by canonical URI and manifest generation. Serve standard renderer/custom bundles through a provider interface, not arbitrary filesystem paths.
- Add an authenticated internal app resource route only if the gateway cannot serve a resource locally. It must use short-lived audience-bound gateway credentials, body/time limits, immutable ETag, exact MIME type, and no path-derived file access.
- Ensure HTML/resource bytes never enter app registration manifests, logs, audit payloads, CLI output, or model context.
- For increment A, provide minimal development-only fixture preview and resource/binding diagnostics needed to debug the journey. Rich view catalogs, interactive inspector tooling, and accessibility warnings are later DX work. Production retains the existing inspector prohibition.
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

P14-03's first increment passes when the real Kanban app registers and serves its standard view without changing ordinary HTTP/CLI execution results or weakening tenant isolation. Custom-resource serving receives the same tests before that capability ships.

## P14-04: MCP Apps catalog, resources, results, and interactions

Extend `@embody/mcp` and gateway integration using the stable official extension:

- negotiate `io.modelcontextprotocol/ui`; clients that omit it retain existing tools behavior;
- expose `resources/read` for authorized `ui://` resources and only advertise/list resources according to the stable spec;
- add `_meta.ui.resourceUri` and explicit `visibility` to bound tools without changing unbound tool fixtures;
- deliver validated action output/props through the standard tool result fields expected by the Apps bridge while retaining concise, valid fallback `content` for non-Apps clients;
- pin resource lookup, app identity, principal identity, scoped/global endpoint, and manifest generation to the MCP session;
- proxy view `tools/call` only to same-app `callableTargets`, only when visibility includes `app`, and under the session's current verified principal and normal gateway dispatch limits;
- forward cancellation, progress, structured safe errors, and request correlation without exposing gateway credentials to the iframe;
- implement P14-00's refresh/replacement and conversation visibility policy using verified host mechanisms; test consequential UI actions separately from local-only events and document any explicit reconciliation requirement;
- deny cross-server tools, stale/removed targets, confused-deputy app IDs, and calls not associated with the initialized view.

Do not detect support from `clientInfo.name`. Use negotiated capabilities and produce a normal text tool result when the extension is absent or partially supported.

### P14-04 tests and success criteria

- Official MCP client plus an Apps reference/basic host initializes, lists a bound tool, reads its resource, calls it, delivers props, and renders the expected semantic DOM.
- A client with no Apps capability receives the pre-GenUI-compatible tool result and never receives a required `ui://` fetch.
- Global and app-scoped endpoints map view URIs deterministically without cross-app collision or resource disclosure.
- Resource reads and app-originated tool calls fail for wrong identity/session/app/generation, missing capability, absent `app` visibility, undeclared target, cross-app target, unhealthy app, revoked scope, and expired session.
- A UI action invokes the canonical downstream target once with the same org/actor, records the normal audit event, observes a hook veto, and presents its safe error.
- Two concurrent sessions/tenants never cross results, props, resource authorization, progress, or events.
- Cancellation from a closing view aborts downstream execution where supported and does not update a disposed view. If commit status is unknown, mark the outcome uncertain and use P14-00's reconciliation path; do not claim cancellation guarantees rollback.
- Malformed JSON-RPC/postMessage-shaped values, oversized props/results, slow resource provider, and disconnect produce bounded cleanup and compliant errors.
- Existing Phase-8 MCP fixture and official-client tests pass unchanged for unbound tools.

P14-04 passes when the same reference action has equivalent domain result/error behavior through an Apps-capable and a plain official MCP client, with the former additionally rendering and safely invoking one action.

## P14-05: standalone browser and developer experience

Provide a browser fallback for harnesses without embedded Apps support, reusing the exact web renderer artifact and normalized view contract.

- Development mode may host a loopback-only presentation session with an unguessable, short-lived, single-purpose capability token.
- The URL fragment should carry bearer material where practical so it is not sent in referrers/access logs. Responses set `Cache-Control: no-store`, restrictive CSP, `Referrer-Policy: no-referrer`, frame policy, and no permissive CORS.
- A session is bound to app/view/result/principal purpose, expires deterministically, can be revoked, and cannot be upgraded into a general API credential.
- Production browser fallback is disabled until an authenticated deployment policy is explicitly configured; never silently expose a loopback development principal on a non-loopback listener.
- Start with a documented manual author/build/browser workflow. Scaffold/build automation and rich inspector support are follow-ups, not prerequisites for secure browser handoff. A generated app without GenUI remains unchanged.
- Before DX automation ships, prove its web and Markdown previews use the same fixture and expose resource metadata/CSP, callable targets, validation failures, and accessibility warnings. Custom-view asset pipelines remain deferred until custom runtime support is justified.

### P14-05 tests and success criteria

- Browser E2E opens a generated one-time URL, renders the expected result, invokes one allowed action, and rejects reuse after expiry/revocation according to documented policy.
- Missing, guessed, leaked-query, wrong-view, wrong-purpose, expired, and replayed tokens fail without revealing whether a resource/result exists.
- Server binds loopback by default and production/non-loopback negative tests fail closed without approved auth configuration.
- Headers, CSP, no-store, referrer behavior, origin checks, WebSocket/SSE cleanup if used, and shutdown cleanup have automated assertions.
- The browser and MCP Apps paths use the same renderer build digest and pass the same semantic view fixture suite.
- A documented manual browser workflow works from packed artifacts without monorepo source paths. When scaffolder automation is added, its packed-artifact test creates, builds, tests, and previews a GenUI-enabled app.

P14-05 passes when a non-MCP-Apps client can direct a human to a secure, temporary view without granting a general Embody credential.

## P14-06: `@embody/genui-pi` native adapter

Build an optional-to-install Pi package as a required version-one deliverable. Its native subset must complete the Kanban journey without a browser: show the board as a task list or grouped list, open task details, edit the required fields, submit an action, display pending/veto/error states, and refresh authoritative data. Text-only output is not sufficient for the TUI acceptance gate.

P14-06 depends on P14-00/01/02/03, not completion of P14-04 or P14-05. Develop it alongside MCP integration using shared journey fixtures. Specify and test how the extension discovers bindings, obtains validated props, and dispatches authorized actions through public Embody interfaces; do not assume Pi includes an MCP client or an MCP Apps renderer. Settle the supported connection/authentication path in P14-00 before implementation. No separate UI execution path or Pi dependency is introduced into server packages.

Before implementation, read Pi's current extension, package, SDK/TUI, and mode documentation and verify any proposed host mechanism. Use documented APIs rather than patching internals.

- Load only as an installed Pi extension; never patch Pi internals.
- Publish a node/capability support matrix. Render the useful native subset with terminal-width-safe components, host theme colors, keyboard navigation, expansion, and cancellation; degrade other nodes to a documented list/summary or browser handoff. Preserve semantic information and useful actions, not browser layout parity. Reuse Pi's existing selection/input/settings components where applicable.
- Persist only safe presentation references/state needed for session restore; do not copy secrets or full sensitive props into extra session entries.
- For a custom HTML view or unsupported standard node, show the deterministic text fallback and optionally open the P14-05 browser session after explicit user action.
- Guard behavior by Pi mode: full native UI in `tui`, supported notifications/dialogs in `rpc`, and pure text/JSON with no prompt in `print`/`json`.
- UI actions use the same normalized GenUI event/action contract. Version one must prove consequential action outcomes are available to the Pi agent as well as visible to the human; choose and test a supported context/tool-result mechanism in P14-00, including ordering and redaction. Audit-only visibility does not pass.
- Clean up overlays, listeners, browser sessions, and pending requests on cancellation, session switch, reload, and shutdown.

### P14-06 tests and success criteria

- Component tests assert every rendered line is within supplied visible width at narrow/wide widths and after theme invalidation.
- Keyboard tests cover focus order, selection, form editing/submission, expand/collapse, cancellation, and disabled controls without sleeps.
- TUI test renders the standard reference view, submits one event, receives an updated result, and displays a hook veto safely.
- `print`, `json`, and `rpc` tests never call TUI-only APIs or block waiting for input; output remains parseable and equivalent to core fallback.
- Custom HTML and unknown-node fixtures degrade to fallback/browser prompt rather than attempting to interpret HTML in the terminal.
- Session reload/switch/shutdown tests leave no active timer, overlay, request, or browser capability session and do not restore stale revision state.
- Package installation test loads the built extension through Pi's documented package mechanism with dependencies present in production installation.

P14-06 passes when the reference journey's information and useful actions are accessible through the documented Pi native/degradation paths, with the same identity and policy outcome as MCP Apps. Non-TUI modes remain deterministic and noninteractive. Unsupported layouts need not be reimplemented natively, and browser handoff is optional unless advertised.

## P14-07: per-increment reference proof, hardening, docs, and release gates

This is a recurring gate. Version one requires completion of both the MCP Apps slice and Pi native subset, but not browser or custom HTML work. Execute it for increment A and again for every additional advertised capability. Keep the original work item open until all planned increments are complete; record each passed increment separately in `STATUS.md`.

Build and test the Kanban journey from P14-00 throughout implementation. Increment A proves equivalent final domain state via HTTP, CLI, plain MCP, MCP Apps, and Pi TUI, plus the human/agent visibility contract on both interactive surfaces. Pi print/JSON/RPC mode behavior and production package installation are also version-one gates. Browser joins this proof in increment B. Add a custom view only when it proves a justified use case.

Documentation must cover the shipped subset's view authoring, components, build output, props, action allowlists, interaction lifecycle, freshness/conflict limitations, conversation visibility, accessibility, CSP, testing, compatibility, and troubleshooting. Document browser fallback, Pi installation, and custom bundles only as supported when their gates pass; otherwise mark them planned. Clearly distinguish supported hosts from protocol conformance; vendor smoke tests are dated evidence, not permanent capability assumptions.

### P14-07 security and non-functional tests

- Fuzz document/result/resource/bridge parsers for a fixed CI budget with no crash, hang, stack exhaustion, or unbounded allocation; retain discovered seeds.
- Soak repeated mount/update/unmount with bounded DOM nodes, listeners, timers, and memory. Add session creation/expiry bounds when browser sessions ship; test equivalent disposal bounds for native adapters.
- Record renderer asset size, cold resource-read latency, first render, update render, and Markdown render baselines for increment A. Approve budgets before release claims. Add 100 concurrent presentation-session memory baselines when browser sessions ship; include native Pi lifecycle/render measurements in increment A.
- Verify dependency licenses/SBOM, package boundaries, API report, tarball contents, source maps, notices, and no fixture secrets or unpublished custom source in artifacts.
- Run Node/version compatibility and the existing full workspace suite. Browser tests run from packed artifacts and built assets, not dev-source aliases.
- Manual smoke against each advertised vendor host verifies render, theme, resize, one allowed interaction, one veto, fallback, and disconnect. Record product/version/date; failure removes the support claim rather than weakening automated conformance.

### Increment release and roadmap completion criteria

An increment is releasable only when:

- the Kanban action remains correct through HTTP, CLI, plain MCP, and every UI surface advertised by that increment;
- shipped renderers preserve relevant semantic content, and interactions reach the canonical action under the intended principal with the same policy outcome;
- lifecycle, stale/conflict handling, mutation recovery, and human/agent visibility satisfy the reviewed P14-00 contract;
- a client with no UI support loses no domain capability and receives useful deterministic output;
- malicious content and undeclared actions remain inert/denied across all shipped paths;
- resources and any shipped sessions are bounded, authenticated, generation-safe, and cleaned up under cancellation/restart;
- applicable public API/protocol fixtures, package artifacts, user documentation, compatibility matrix, performance evidence, and `STATUS.md` command results are reviewed;
- no README or marketing material claims support for an unverified host, component, deployment mode, or interaction.

Phase 14's planned roadmap is complete when increments A–B pass their respective gates. Later component/custom-runtime expansion is not a prerequisite for that milestone. Passing increment A permits narrowly scoped MCP Apps and native Pi claims for the verified subset; it does not imply browser support. Do not mark version one releasable while either required interactive surface is missing its evidence.
