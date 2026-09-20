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

See the [deployment guide](https://github.com/nimrod4278/embody/blob/main/docs/production/01-deployment.md).

Licensed under the [Elastic License 2.0](./LICENSE).
