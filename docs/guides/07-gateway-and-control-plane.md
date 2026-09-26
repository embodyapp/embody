# Gateway & Control Plane

> Use a managed or self-hosted Embody Gateway to expose production applications to operators and agents.

---

## Role of the gateway

The gateway is the production control plane between clients and independently deployed Embody application hosts:

```text
CLI and MCP clients
        |
        v
Managed or self-hosted Embody Gateway
  - authentication and authorization
  - application registry and health
  - catalog aggregation
  - execution and progress relay
  - audit and rate limiting
        |
        v
One or more Embody application hosts
```

It exposes:

- `/api/catalog` for discovery
- `/api/execute` and `/api/execute/stream` for dispatch
- `/mcp` for an authorized aggregate tool catalog
- `/mcp/:appId` for an app-scoped MCP catalog
- registration and heartbeat routes for application hosts

The local host inspector is a loopback-only development surface. It is not a production MCP endpoint or authentication boundary. For a disposable, multi-app **local Gateway demo** from a repository checkout, run `pnpm gateway:dev` (Node.js 22/24, pnpm, and Docker Compose required). This generates ignored test credentials, starts the reference Gateway, Kanban, Email, and PostgreSQL, and prints a CLI command once the apps register. Stop and remove its data with `pnpm gateway:dev:down`. See [local setup](../../apps/gateway/README.md). You do not need the Gateway to develop just one app with `pnpm dev`.

---

## Choose an operating model

### Managed Embody Gateway

Use the paid hosted service when Embody should operate the control plane. Provisioning supplies the gateway URL, application registration credentials, and client credentials. Application plugins remain independent of the managed service.

### Self-hosted gateway

Use `@embody/gateway` when an organization needs to operate its own control plane. The package exports `createGateway()` and explicit registry, authentication, signing, audit, network-policy, and rate-limit collaborators.

The repository's `apps/gateway` process demonstrates composition for the distributed example environment. It contains example-specific identities and app credentials and is not a generic production configuration. See [Self-hosting the Gateway](../production/07-self-hosting-the-gateway.md).

Both models implement the same registration, catalog, execution, and MCP contracts. Moving an application between compatible gateways should require configuration and credential changes, not business-logic changes.

---

## Registration protocol

A production application host:

1. Boots its kernel and compiles its manifest.
2. Registers its `appId`, version, reachable endpoint, health URL, and manifest.
3. Authenticates registration with its app-specific registration secret.
4. Sends heartbeats while healthy.
5. Accepts execution only with a gateway-signed downstream token.

The host uses:

```text
GATEWAY_URL
PUBLIC_URL
GATEWAY_REGISTRATION_SECRET
GATEWAY_JWT_ISSUER
GATEWAY_JWT_SECRET
```

`GATEWAY_URL` can identify either operating model. `PUBLIC_URL` must be reachable by the gateway. Store all credentials in a secret manager and rotate them using an overlap or coordinated rollout procedure.

---

## Client access

CLI and MCP clients use separate client credentials:

```text
EMBODY_GATEWAY_URL
EMBODY_TOKEN
```

Inspect the authorized catalog before mutation:

```bash
npx -y @embody/cli apps list
npx -y @embody/cli apps inspect ops
```

Use `/mcp/:appId` for focused agents to reduce tool context and accidental cross-domain access. The catalog is also filtered by the principal's scopes; endpoint scoping is not a substitute for authorization.

---

## Network and security requirements

A production gateway must:

- terminate or sit behind TLS
- authenticate every client
- map identities to tenant-aware principals and least-privilege scopes
- use app-specific registration credentials
- sign short-lived downstream host tokens
- restrict application endpoints to approved origins
- prevent server-side request forgery through registration data
- keep durable audit records
- enforce appropriate rate limits
- monitor registration health and execution failures
- support credential rotation and incident response

Private application endpoints may be appropriate within a controlled network. Self-hosted operators must opt into them intentionally and should prefer explicit origin allowlists.

---

## Deployment topologies

| Topology | Purpose | Access surface |
| --- | --- | --- |
| Local development | Build and inspect one app | Loopback `/__inspector` only |
| Managed gateway | Hosted production control plane | Managed URL, CLI, and MCP |
| Self-hosted gateway | Operator-controlled production plane | Operator URL, CLI, and MCP |

Next: **[Model Context Protocol →](../agent-integrations/01-model-context-protocol.md)**
