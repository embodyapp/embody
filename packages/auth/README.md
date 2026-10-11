# @embody/auth

Authentication and principal verification for Embody application hosts.

```sh
npm install @embody/auth
```

Requires Node.js 22 or 24 and uses ESM.

## Gateway JWT verification

```ts
import { gatewayJwtVerifier } from "@embody/auth";

const verifier = gatewayJwtVerifier({
  issuer: "https://gateway.example.com",
  audience: "kanban",
  jwksUrl: "https://gateway.example.com/.well-known/jwks.json",
  algorithms: ["ES256"],
  workspaceId: "ws_workspace0001",
});
```

`gatewayJwtVerifier` validates issuer, audience, an explicit algorithm allowlist, and Embody principal claims. Configure exactly one of `key` or `jwksUrl`. Hosted apps set `workspaceId`: this requires ES256 remote public keys, exact app/workspace binding and an issued token lifetime of at most 300 seconds. Remote keys are cached for at most 60 seconds by default; expired caches never fall back on failed refresh. See the [hosted identity and rotation runbook](https://github.com/embodyapp/embody/blob/main/docs/mvp/IDENTITY.md).

`localDevVerifier` is deliberately restricted to development environments. Never expose a host using it to an untrusted network.

See the [authentication guide](https://github.com/embodyapp/embody/blob/main/docs/guides/06-authentication-and-principals.md).

Licensed under the [Elastic License 2.0](./LICENSE).
