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

Development defaults to loopback SQLite. Reference production requires PostgreSQL, gateway JWT verification, explicit public/gateway URLs, registration credentials, TLS, and graceful shutdown with `await runtime.stop()`. Hosted apps explicitly set `EMBODY_HOST_PROFILE=hosted`, `EMBODY_WORKSPACE_ID`, `GATEWAY_JWT_ISSUER` and HTTPS `GATEWAY_JWKS_URL`; they verify ES256 app/workspace-bound tokens using public keys only and do not require reference registration credentials. Shared/private signing secrets, platform database URLs and verifier overrides are rejected. See the [hosted identity contract](https://github.com/embodyapp/embody/blob/main/docs/mvp/IDENTITY.md); sleep-safe workers/scaffolding and live private ingress/IAM remain separate qualification gates.

The application host exposes health and execution endpoints. Organization-wide CLI and MCP discovery are exposed by a registered `@embody/gateway` deployment.

See the [deployment guide](https://github.com/embodyapp/embody/blob/main/docs/production/01-deployment.md).

Licensed under the [Elastic License 2.0](./LICENSE).
