# ADR 0005: Generative UI presentation and renderer boundaries

- Status: Accepted
- Date: 2026-09-19

## Context

Embody actions currently return structured values that MCP, CLI, and HTTP clients present as JSON or text. Human users interacting through an agent harness need application-quality cards, tables, forms, boards, progress views, and approval experiences without giving the model permission to generate executable HTML.

The same action must remain useful when a harness has no embedded web surface. Claude and other MCP Apps hosts can render sandboxed HTML resources, while terminal harnesses require text, a native adapter, or a separately opened browser.

## Decision

Add a GenUI presentation layer with these boundaries:

1. The Embody application, not the model, owns each view and binds it to action output.
2. Action output remains validated domain data and is passed directly to the view as props. Presentation metadata references a versioned view; it does not replace authorization, hooks, transactions, or the action output schema. In protocol v1, the action output and view props use the same registered Zod schema object; there is no projector or special response envelope.
3. A trusted, static view implementation is separated from dynamic action-result data. Model-generated HTML, JavaScript, CSS, and CSP declarations are not accepted.
4. `@embody/genui` includes the transport-neutral document/view contracts, a standard web renderer and runtime, a deterministic Markdown/plain-text renderer, and standalone-browser support.
5. MCP hosts own their iframe, sandbox, and host bridge. `@embody/genui` supplies the resource that runs inside that sandbox; `@embody/mcp` adapts manifests, resources, results, and calls to the stable MCP Apps extension.
6. Harness-specific native renderers are adapters. The first is `@embody/genui-pi`; it depends on Pi, while `@embody/genui` does not.
7. Every presented action has a useful non-HTML fallback. A client without GenUI support receives the normal action result plus deterministic text/Markdown, never a failed action merely because it cannot render a view.
8. UI-triggered mutations call ordinary allowlisted Embody actions under the initiating principal. They pass through the same validation, authorization, hooks, audit, and cancellation paths as model-triggered calls.
9. Standard declarative GenUI components are the default portability path. Trusted custom HTML view bundles are an explicit escape hatch and must still declare a fallback; native terminal parity for arbitrary custom HTML is not promised.

## Package and dependency consequences

- `@embody/core` may gain only transport-neutral, optional manifest types for presentation references and view metadata. It must not import renderer, browser, MCP Apps, or Pi code.
- `@embody/genui` depends inward on `@embody/core` and owns validation/rendering/runtime behavior.
- `@embody/mcp`, `@embody/host`, and the developer inspector integrate the GenUI provider through public interfaces; no package imports another package's `src` tree.
- `@embody/genui-pi` is optional and may depend on Pi extension/TUI APIs. Installing or running an Embody app does not install Pi.
- Existing protocol-version-1 manifests remain valid because presentation fields are optional. An incompatible result-envelope or resource change requires an explicit protocol-version decision rather than silent wire drift.

## Security consequences

- Static resources are immutable per app manifest generation and are served with a restrictive CSP. Network, frame, base URI, and device permissions default to none.
- Action data is delivered separately from executable resources. Tenant data, tokens, and secrets must never be embedded in cacheable HTML.
- Standard renderer text/Markdown is escaped or sanitized; URL schemes and declared origins are allowlisted.
- View action calls are same-app and explicit-target allowlisted. Cross-server or undeclared calls fail closed.
- Browser fallback uses loopback binding and short-lived, single-purpose bearer capability URLs; production never emits an unauthenticated public presentation URL.

## MCP Apps compatibility pin

The initial implementation targets the stable MCP Apps `2026-01-26` specification and pins `@modelcontextprotocol/ext-apps` `1.7.5` when the bridge is introduced. Its peer range accepts `@modelcontextprotocol/sdk ^1.29.0`, so it is compatible with the repository's existing `@modelcontextprotocol/sdk 1.30.0`. Phase 14 must not migrate to the split MCP 2.x packages merely to add GenUI. A later 2.x migration is an atomic protocol change that reruns all Phase-8 and Phase-14 contract tests. The 1.x and 2.x ext-apps wire protocol is documented as interoperable, but package compatibility is still verified from packed artifacts.

References:

- [Stable MCP Apps specification](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx)
- [MCP Apps SDK and migration documentation](https://github.com/modelcontextprotocol/ext-apps)

## Deferred decisions

- Output projectors, special `{ data, presentation }` response envelopes, and UI-private data hidden from the model are not part of the first increment; initially the UI renders the same validated result available to the calling client.
- Durable, reconnectable human-input sessions and an action that blocks while awaiting a user are deferred. Interactive views issue normal actions and receive normal results.
- Arbitrary remote view URLs, runtime-downloaded scripts, and model-authored component definitions are deferred.
- Additional native adapters are added only after their host APIs and maintenance ownership are explicit.
