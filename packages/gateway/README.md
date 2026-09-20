# @embody/gateway

Registry, authentication, authorization, dispatch, health, audit, limits, MCP endpoints, and optional durable relay for the Embody control plane.

```sh
npm install @embody/gateway
```

Requires Node.js 22 or 24 and uses ESM.

`createGateway(options)` creates a Fastify application. Its required collaborators are explicit: registry, authentication providers, signing credentials, audit sink, and network policy. Registered application hosts then become available through:

- `/api/catalog` for CLI discovery.
- `/api/execute` and `/api/execute/stream` for dispatch.
- `/mcp` and `/mcp/:appId` for Model Context Protocol clients.
- Registration and heartbeat routes for application hosts.

For a deployable environment-driven entrypoint, use the reference implementation in [`apps/gateway`](https://github.com/nimrod4278/embody/tree/main/apps/gateway). Production deployments must use TLS, rotated secrets, explicit endpoint allowlists, durable audit storage, and appropriate rate limits.

See the [gateway guide](https://github.com/nimrod4278/embody/blob/main/docs/guides/07-gateway-and-control-plane.md).

Licensed under the [Elastic License 2.0](./LICENSE).
