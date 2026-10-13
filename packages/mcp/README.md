# @embody/mcp

Model Context Protocol catalog generation and Streamable HTTP server adapter for Embody gateways.

```sh
npm install @embody/mcp
```

Requires Node.js 22 or 24 and uses ESM.

The package exports:

- `createMcpCatalog`: converts authorized Embody action manifests into collision-checked MCP tools.
- `McpHttpHandler`: official-SDK Streamable HTTP handling; stateful by default with identity/app-scope pinning, or request-local with `sessionMode: "stateless"` for hosted gateways.
- `mcpTargetName`, `mcpResult`, and `mcpError`: stable protocol mapping helpers.

Most application authors do not instantiate this package directly. `@embody/gateway` mounts global `/mcp` and app-scoped `/mcp/:appId` endpoints using it. Desktop clients that require stdio can use:

```sh
npx -y @embody/cli mcp --url https://gateway.example.com/mcp --token "$EMBODY_TOKEN"
```

Hosted workspace gateways use stateless POST requests, authenticate every request, reject session IDs, and return 405 for GET/DELETE rather than keeping an idle stream open. Object results include structured content alongside JSON text. Closing the active HTTP transport cancels request-owned work; separate cancellation notifications cannot reliably cross replicas. See the [hosted MCP contract](https://github.com/embodyapp/embody/blob/main/docs/mvp/MCP.md) for headers, capability/idle limitations and the pending real-client support matrix.

See the [MCP integration guide](https://github.com/embodyapp/embody/blob/main/docs/agent-integrations/01-model-context-protocol.md).

Licensed under the [Elastic License 2.0](./LICENSE).
