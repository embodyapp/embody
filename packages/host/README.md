# @embody/host

HTTP host runtime, application assembly, SSE execution, registration, and durable event/workflow workers for Embody applications.

```sh
npm install @embody/core @embody/host
```

Requires Node.js 22 or 24 and uses ESM.

## Define and run an application

```ts
import { definePlugin, z } from "@embody/core";
import { createAppHost, defineApp } from "@embody/host";

const config = defineApp({
  appId: "operations",
  version: "1.0.0",
  plugins: [
    definePlugin({
      id: "system",
      version: "1.0.0",
      actions: {
        ping: { input: z.object({}), handler: () => ({ ok: true }) },
      },
    }),
  ],
});

const runtime = await createAppHost(config);
await runtime.start();
console.log(runtime.url);
```

Development defaults to loopback SQLite. Production requires PostgreSQL, gateway JWT verification, explicit public/gateway URLs, registration credentials, TLS, and graceful shutdown with `await runtime.stop()`.

The application host exposes health and execution endpoints. Organization-wide CLI and MCP discovery are exposed by a registered `@embody/gateway` deployment.

See the [deployment guide](https://github.com/embodyapp/embody/blob/main/docs/production/01-deployment.md).

## Experimental GenUI resources

`AppDefinition.genui` compiles trusted application-authored views at boot. The runtime exposes the enriched `manifest` and its SHA-256 `generation`; registration publishes that same manifest. Ordinary action outputs are unchanged: view props use the validated domain output, without a projector or presentation envelope.

Presented applications expose `POST /genui/resources/read` with the strict body:

```json
{ "protocolVersion": 1, "uri": "ui://kanban/board@1.0.0", "generation": "<manifest SHA-256>" }
```

The endpoint requires a verified credential for the exact application audience, the reserved `@embody/genui:resource:read` scope, and signed principal metadata `genuiResource: { uri, generation }` matching the request. This scope grants no domain-action authority. Default production verification limits credential age to 60 seconds; custom verifiers must enforce equivalent freshness. The gateway's negotiated MCP resource broker issues these narrowed grants; ordinary gateway action credentials cannot be used as resource grants. The application receives them in `X-Gateway-Auth`, not as client-facing bearer credentials.

Static HTML and strict CSP/permission metadata are detached at boot, not loaded from request paths or model input. Reads revalidate captured integrity and generation, reject unknown resources, and support authenticated `If-None-Match` responses with private immutable caching. Resource failures do not change committed actions or ordinary execution availability. Aggregate boot resources are limited to 16 MiB.

This is resource-serving infrastructure, not a browser renderer, native Pi adapter, or completed MCP Apps host. Minimal preview/diagnostics remain pending.

Licensed under the [Elastic License 2.0](./LICENSE).
