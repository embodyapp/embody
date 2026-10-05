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

## Experimental GenUI resource broker

Negotiated MCP Apps clients can discover and read static `ui://` resources for currently authorized presented actions through `/mcp` or `/mcp/:appId`. Resource reads use the registered application's exact manifest generation and integrity. The broker preserves the initiating organization, actor ID and actor type, but issues a separate ≤60-second application-audience credential containing only the reserved resource scope, no roles, and the exact signed URI/generation purpose. Client credentials and unrelated principal metadata are not forwarded as resource grants. Resource credentials cannot execute domain actions.

The broker forbids redirects, limits response bodies to 8 MiB, validates the transport URI/MIME and static resource JSON/integrity, and rechecks registration health/generation/authorization before delivery. `resourceTimeoutMs` defaults to 10,000 and accepts integers from 1 to 30,000. Provider failures return value-free MCP errors and do not alter ordinary action output. General gateway token options also accept `ttlSeconds` from 1 to 300; ordinary tokens retain the 300-second default.

MCP session identity is an unambiguous organization/actor-ID/actor-type tuple. Switching an agent session to a human credential—even for the same actor ID—requires a new session.

This is authenticated resource/direct-props infrastructure, not a completed interactive MCP Apps host. App/AppBridge per-view call authorization, refresh/outcome visibility, browser/native rendering and vendor evidence remain pending.

Licensed under the [Elastic License 2.0](./LICENSE).
