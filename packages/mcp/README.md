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

Licensed under the [Elastic License 2.0](./LICENSE).
