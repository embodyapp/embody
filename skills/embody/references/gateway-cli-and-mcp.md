# Gateway, CLI, and MCP

Read this before exposing an application outside local development.

## Deployment model

The Embody Gateway is the production control plane for registration, authentication, authorization, discovery, execution, CLI access, and MCP. It can be managed or self-hosted.

- **Managed Embody Gateway:** a paid hosted control plane operated by Embody. Use the URL and credentials supplied during provisioning.
- **Self-hosted gateway:** build and operate a compatible gateway with `@embody/gateway`. The repository's `apps/gateway` is a reference process and must be adapted to the operator's identity, registry, audit, and secret systems.

Business plugins should not depend on which compatible gateway is selected. Moving between them should require configuration and credential changes, not business-logic changes.

## Local development

The host's `/__inspector` routes are loopback-only development surfaces. They execute through the normal kernel but do not model production authentication. Never expose them publicly or use them as proof of an authorization policy.

## Application host registration

Production hosts use:

```text
GATEWAY_URL
PUBLIC_URL
GATEWAY_REGISTRATION_SECRET
GATEWAY_JWT_ISSUER
GATEWAY_JWT_SECRET
```

`GATEWAY_URL` selects either the managed or self-hosted control plane. `PUBLIC_URL` must be an address the gateway can reach. Registration credentials authenticate registration and heartbeats. JWT settings let the host verify requests signed by its gateway.

Use TLS, a secret manager, rotation procedures, and explicit network policy. Never commit these values.

## Client configuration

CLI and agent clients use different credentials:

```text
EMBODY_GATEWAY_URL
EMBODY_TOKEN
```

Inspect before mutating:

```bash
npx -y @embody/cli apps list
npx -y @embody/cli apps inspect ops
```

Prefer JSON for automation and check deterministic CLI exit codes. Entity commands follow `embody <appId> <entity> <operation>`; custom actions follow `embody <appId> <action>`.

## MCP

The gateway exposes:

- `/mcp`: tools from every app visible to the principal
- `/mcp/<appId>`: one app's tools, preferred for focused agents

A stdio client can bridge to either endpoint:

```json
{
  "mcpServers": {
    "embody": {
      "command": "npx",
      "args": [
        "-y",
        "@embody/cli",
        "mcp",
        "--url",
        "https://gateway.example.com/mcp/ops"
      ],
      "env": {
        "EMBODY_TOKEN": "provided-by-the-client-secret-store"
      }
    }
  }
}
```

Do not put real tokens in committed client configuration. The gateway converts canonical dotted targets to stable MCP tool names and enforces principal scopes before dispatch.

## Self-hosting responsibilities

A self-hosted implementation uses `createGateway()` with explicit collaborators, commonly including `GatewayRegistry`, `AuthChain`, and one or more authentication providers. Operators are responsible for:

- authenticating users and agents
- mapping identities to `Principal` values and least-privilege scopes
- storing registration credentials securely
- signing short-lived downstream host tokens
- restricting permitted application origins to prevent SSRF
- TLS and trusted reverse-proxy configuration
- durable audit storage and monitoring
- rate limits and abuse controls
- health checks, backups, upgrades, and secret rotation

`GatewayRegistry` is copy-on-write in-process state. Its `initial` option can seed entries, but production operators must design appropriate registration persistence or deterministic re-registration after restart. The reference `apps/gateway` process contains example-specific identities and application credentials; do not deploy those defaults unchanged.

For private container or cluster endpoints, opt into private targets only within an intentional network boundary. Prefer explicit `allowedOrigins` rather than unrestricted private endpoints.

## Managed gateway boundaries

Do not invent signup, billing, tenant, or provisioning commands. Use the managed service's issued URL and credentials. The managed service should implement the same host registration, catalog, execution, and MCP contracts so applications remain portable.

## Production checklist

- gateway choice is explicit
- host and client credentials are not confused
- app registration and heartbeat succeed
- `/api/catalog` includes the expected app
- CLI inspection succeeds with least privilege
- global and app-scoped MCP catalogs expose only authorized tools
- gateway can reach the host but the host is not unnecessarily public
- registration, signing, and client secrets are distinct and rotated
- audit, rate limiting, TLS, and health monitoring are enabled
