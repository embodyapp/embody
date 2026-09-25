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

The gateway is available in two operating models: the paid managed Embody Gateway, or an operator-owned deployment built with this package. Applications use the same registration and execution contracts with either model.

The environment-driven process in [`apps/gateway`](https://github.com/embodyapp/embody/tree/main/apps/gateway) is a distributed-test reference with example-specific identities and credentials, not a generic production binary. Production operators must provide TLS, rotated secrets, explicit endpoint allowlists, durable audit export, appropriate rate limits, and registration recovery.

See the [gateway guide](https://github.com/embodyapp/embody/blob/main/docs/guides/07-gateway-and-control-plane.md) and [self-hosting guide](https://github.com/embodyapp/embody/blob/main/docs/production/07-self-hosting-the-gateway.md).

Licensed under the [Elastic License 2.0](./LICENSE).
