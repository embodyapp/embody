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
  algorithms: ["RS256"],
});
```

`gatewayJwtVerifier` validates issuer, audience, an explicit algorithm allowlist, and Embody principal claims. Configure exactly one of `key` or `jwksUrl`.

`localDevVerifier` is deliberately restricted to development environments. Never expose a host using it to an untrusted network.

See the [authentication guide](https://github.com/embodyapp/embody/blob/main/docs/guides/06-authentication-and-principals.md).

Licensed under the [Elastic License 2.0](./LICENSE).
