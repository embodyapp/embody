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

Optional `maxTokenAgeSeconds` (integer 1–300) requires a valid issued-at claim and rejects older credentials even when their expiration is still in the future. Presented application hosts use a 60-second maximum age for their default production verifier. Supplying a custom verifier transfers freshness enforcement to that verifier; audience, signed purpose and scope checks still belong to the resource endpoint.

`localDevVerifier` is deliberately restricted to development environments. Never expose a host using it to an untrusted network.

See the [authentication guide](https://github.com/embodyapp/embody/blob/main/docs/guides/06-authentication-and-principals.md).

Licensed under the [Elastic License 2.0](./LICENSE).
