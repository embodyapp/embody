# @embody/mcp

Model Context Protocol catalog generation and Streamable HTTP server adapter for Embody gateways.

```sh
npm install @embody/mcp
```

Requires Node.js 22 or 24 and uses ESM.

The package exports:

- `createMcpCatalog`: converts authorized Embody action manifests into collision-checked MCP tools.
- `McpHttpHandler`: stateful Streamable HTTP handling with session identity and app-scope pinning.
- `mcpTargetName`, `mcpResult`, and `mcpError`: stable protocol mapping helpers.

Most application authors do not instantiate this package directly. `@embody/gateway` mounts global `/mcp` and app-scoped `/mcp/:appId` endpoints using it. Desktop clients that require stdio can use:

```sh
npx -y @embody/cli mcp --url https://gateway.example.com/mcp --token "$EMBODY_TOKEN"
```

See the [MCP integration guide](https://github.com/embodyapp/embody/blob/main/docs/agent-integrations/01-model-context-protocol.md).

## Experimental MCP Apps server foundation

The adapter pins official `@modelcontextprotocol/ext-apps` **1.7.5** and MCP SDK **1.30.0**. It uses the official server capability helper and `text/html;profile=mcp-app` MIME type. Client names do not determine support: absent, partial, or malformed capabilities retain ordinary text results.

A caller may configure `McpHttpOptions.readResource(context, entry, signal)` as a trusted static resource provider. Only then do negotiated clients receive bound-tool `_meta.ui.resourceUri` and explicit `model`/`app` visibility, plus resource list/read support. Successful object outputs are passed directly as `structuredContent`, while their existing JSON text content is retained. Unbound tools and plain clients keep their previous wire results. Arrays and primitives retain JSON text fallback rather than receiving an invented object envelope.

Resources are selected from the caller's currently authorized catalog, pinned to the session's initial manifest generation/URI/integrity, and checked again after the provider completes. The provider must honor cancellation. Invalid bytes, MIME types, unknown/traversal/foreign URIs, revoked bindings and generation changes produce value-free errors; ordinary action data remains available. CSP, permissions and border metadata belong on resource contents, not tool metadata.

The caller must authenticate each request and provide a correctly filtered catalog and stable principal identity. `readResource` is an integration seam, not an authentication broker. The gateway configures it for authenticated registered applications, issuing separate narrowed resource credentials rather than forwarding the client's credential. These official-client conformance tests do **not** establish interactive host, iframe isolation, per-view UI-call authorization, or model-outcome visibility support. The official App/AppBridge reference-host journey and vendor compatibility remain pending.

Licensed under the [Elastic License 2.0](./LICENSE).
