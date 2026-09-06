# Authentication, Identity & Principals

> Learn how Embody models identity with `Principal`, supports multi-tenancy, and secures requests in development and production.

---

## 👤 The `Principal` Identity Contract

Every incoming request into an Embody host—whether from the CLI, an HTTP call, or an AI agent over MCP—is resolved into an authenticated **Principal**:

```typescript
interface Principal {
  /** Organization or tenant identifier */
  readonly orgId: string;

  /** Unique identifier of the actor */
  readonly actorId: string;

  /** Actor classification */
  readonly actorType: "agent" | "human" | "system";

  /** High-level business roles */
  readonly roles: readonly string[];

  /** Granular permission scopes */
  readonly scopes: readonly string[];

  /** Optional custom metadata claims */
  readonly metadata?: Readonly<Record<string, unknown>>;
}
```

### Why `actorType` is Critical
Most web frameworks only know *who* a user is (e.g. `user_123`). Embody explicitly differentiates:
- **`agent`**: Autonomous LLM instances (Claude, Cursor, Cline, LangChain).
- **`human`**: Human operators in terminal shells or web dashboards.
- **`system`**: Schedulers, background daemons, and system webhooks.

This allows your business logic and pre-commit hooks to attenuate agent permissions without degrading human operational control.

---

## 🔐 Pluggable Verifiers

Authentication is managed via an `AppAuthVerifier`. Embody includes two first-party verifiers:

### 1. `localDevVerifier` (Local Development Only)
In development, generating signed JWTs for every terminal command or MCP tool test creates unnecessary friction. The `localDevVerifier` automatically injects a default development principal:

```typescript
import { localDevVerifier } from "@embody/auth";

const verifier = localDevVerifier({
  enabled: true,
  environment: "development",
  principal: {
    orgId: "dev-org",
    actorId: "dev-user",
    actorType: "human",
    roles: ["admin"],
    scopes: ["*"],
  },
});
```

> [!CAUTION]
> **Production Safety Lock**: If `NODE_ENV=production` is set, Embody strictly refuses to start with `localDevVerifier`.

### 2. `gatewayJwtVerifier` (Production)
In production, requests passing through the Embody Gateway carry cryptographically signed JWTs:

```typescript
import { gatewayJwtVerifier } from "@embody/auth";

const verifier = gatewayJwtVerifier({
  issuer: "https://auth.company.com",
  audience: "embody-gateway",
  algorithms: ["RS256", "ES256"],
  jwksUrl: "https://auth.company.com/.well-known/jwks.json",
});
```

The verifier extracts `orgId`, `actorId`, `actorType`, `roles`, and `scopes` directly from the validated JWT claims.

---

## 🏢 Multi-Tenant Isolation via `orgId`

Multi-tenancy is not an afterthought in Embody—it is baked into the storage layer:
- Every entity created receives the current `orgId` from `context.principal.orgId`.
- Every entity query (`get`, `list`, `update`, `delete`) automatically injects an `orgId` filter.
- In PostgreSQL, Row-Level Security (RLS) guarantees that even raw SQL queries cannot leak cross-tenant data.

---

## 🔑 Supplying Credentials to the CLI

When invoking the CLI against an authenticated host or gateway:

```bash
# Via environment variable
export EMBODY_TOKEN="eyJhbGciOi..."
embody ops task list

# Or via explicit flag
embody ops task list --token "eyJhbGciOi..."

# Or using configuration profiles
embody --profile production ops task list
```

Configuration profiles are stored securely in `~/.config/embody/config.json` with `0600` file permissions.

Next: **[Gateway & Control Plane →](./07-gateway-and-control-plane.md)**
