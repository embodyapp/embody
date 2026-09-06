# Project Structure & Configuration

> Learn how an Embody project is organized and how to configure environment variables.

---

## 📁 Standard Application Layout

When you scaffold an application using `create-embody-app`, your project structure looks like this:

```text
my-agent-ops/
├── .embody/                     # Local runtime data (SQLite database & logs)
│   └── app.sqlite               # Embedded SQLite database for local dev
├── src/                         # Application source code
│   ├── index.ts                 # Main export file
│   ├── plugins/                 # Modular application plugins
│   │   ├── tasks/               # Tasks domain plugin
│   │   │   ├── schemas.ts       # Zod entity & action schemas
│   │   │   ├── actions.ts       # Action handlers & business logic
│   │   │   ├── hooks.ts         # Pre-commit safety guardrails
│   │   │   └── index.ts         # definePlugin export
│   │   └── billing/             # Additional domain plugins...
│   └── services/                # Singleton services (e.g. Mailer, Stripe)
├── test/                        # Vitest test suite
│   └── app.test.ts              # End-to-end actor tests with @embody/testing
├── .env.example                 # Template for environment variables
├── .env                         # Local environment configuration
├── embody.config.ts             # App definition and host entry point
├── package.json                 # Node dependencies and scripts
├── tsconfig.json                # TypeScript configuration
└── vitest.config.ts             # Test runner configuration
```

---

## ⚙️ The Application Entry Point: `embody.config.ts`

The heart of every Embody application is `embody.config.ts`. The Embody CLI and host look for this file by default when starting the server (`embody dev`) or executing actions.

Here is a clean, modular example:

```typescript
// embody.config.ts
import { defineApp } from "@embody/host";
import { tasksPlugin } from "./src/plugins/tasks/index.js";
import { billingPlugin } from "./src/plugins/billing/index.js";

export default defineApp({
  // Unique application identifier used in routing and CLI commands
  appId: "ops",

  // Semantic version of the application manifest
  version: "1.0.0",

  // Ordered list of plugins registering entities, actions, and hooks
  plugins: [
    tasksPlugin,
    billingPlugin,
  ],
});
```

---

## 🔐 Environment Variables Configuration

Embody uses a strict, fail-closed configuration parser (`parseAppEnvironment`). In development, it defaults to zero-config SQLite. In production, it enforces secure PostgreSQL database connections and JWT authentication.

### Available Variables

| Variable | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `NODE_ENV` | `"development"` \| `"production"` | `"development"` | Application runtime environment. |
| `PORT` | `number` | `8080` | Port for the Fastify HTTP and MCP server. |
| `DATABASE_FILE` | `string` | `".embody/app.sqlite"` | Filepath for local SQLite storage (development only). |
| `DATABASE_URL` | `string` (Postgres URL) | *None* | Connection string for PostgreSQL (required in production). |
| `GATEWAY_URL` | `string` (URL) | *None* | URL of the central Embody Gateway for multi-app registration. |
| `PUBLIC_URL` | `string` (URL) | *None* | Public hostname where this app is reachable by the Gateway. |
| `GATEWAY_REGISTRATION_SECRET` | `string` (>= 16 chars) | *None* | Secret key used to register this app with the Gateway. |
| `GATEWAY_JWT_ISSUER` | `string` | *None* | Expected issuer claim in incoming Bearer tokens. |
| `GATEWAY_JWT_SECRET` | `string` (>= 32 chars) | *None* | Symmetric secret key used to verify Gateway JWT tokens. |

### Development `.env` Example

```ini
# .env (Development)
NODE_ENV=development
PORT=8080
DATABASE_FILE=.embody/app.sqlite
```

In development mode:
- SQLite runs locally with Write-Ahead Logging (WAL) enabled.
- The `localDevVerifier` is active, allowing CLI and web inspector requests without complex token generation.
- The dev inspector is available at `http://127.0.0.1:8080/__inspector`.

### Production `.env` Example

```ini
# .env (Production)
NODE_ENV=production
PORT=8080
DATABASE_URL=postgresql://embody_user:secure_password@postgres.internal:5432/embody_production?sslmode=require
GATEWAY_URL=https://gateway.internal
PUBLIC_URL=https://ops.internal
GATEWAY_REGISTRATION_SECRET=super_secret_registration_key_48291
GATEWAY_JWT_ISSUER=embody-gateway
GATEWAY_JWT_SECRET=super_secret_jwt_key_with_at_least_32_characters
```

> [!WARNING]
> **Production Fail-Closed Guarantee**: If `NODE_ENV=production` is set, Embody will deliberately refuse to boot if `DATABASE_URL` is omitted, or if local development authentication verifiers are used.

---

## 📦 Monorepo vs Standalone Layout

Embody works equally well as:
1. **A Standalone Repository**: A single project folder created via `create-embody-app`.
2. **A Package in a Monorepo**: An application located under `apps/<appId>` inside a pnpm/Turborepo workspace (like the Embody monorepo itself).

When working in a monorepo, add the app package to `pnpm-workspace.yaml`:

```yaml
packages:
  - "apps/*"
  - "packages/*"
```

---

## 🎯 Next Steps

Now that you understand the layout:
- Learn how to structure and register plugins: **[Defining Plugins →](../guides/01-defining-plugins.md)**
- Learn how to define schemas and entities: **[Entities & Storage →](../guides/02-entities-and-storage.md)**
