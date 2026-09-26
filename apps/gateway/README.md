# Gateway application

## Local first run (repository checkout)

You need Node.js 22/24, pnpm (Corepack works), and Docker with Compose. Docker must be running; ports 4400, 8081, and 8082 must be free. No local PostgreSQL, prebuilt packages, or hand-written secrets are needed.

```sh
corepack enable
pnpm gateway:dev
```

The command creates a gitignored `.env.gateway.local` with random, test-only credentials (mode 0600), builds the images, starts the Gateway, Kanban, Email, and PostgreSQL, and waits for both apps to appear in the authorized catalog. It prints the Gateway URL and a working CLI command. Defaults:

- Gateway health: http://127.0.0.1:4400/health
- Authenticated catalog: http://127.0.0.1:4400/api/catalog
- MCP: http://127.0.0.1:4400/mcp (or `/mcp/kanban`)

To inspect from the repository root, run the command printed by `pnpm gateway:dev`, or:

```sh
EMBODY_GATEWAY_URL=http://127.0.0.1:4400 EMBODY_TOKEN="$(node scripts/gateway-dev.mjs token)" npx -y @embody/cli apps list
```

`pnpm gateway:dev` can be rerun without changing credentials. If ports are busy, edit `GATEWAY_PORT`, `KANBAN_PORT`, and `EMAIL_PORT` in `.env.gateway.local` before starting; the CLI URL printed on startup follows `GATEWAY_PORT`. To inspect failures, run `pnpm gateway:dev:logs`. To stop and **delete the disposable database and mail data**, run `pnpm gateway:dev:down`. To rotate local credentials, run down, delete `.env.gateway.local`, then run `pnpm gateway:dev` again. Never commit or reuse that file's credentials.

The Compose ports bind only to loopback. The stack uses intentional test-only settings, including HTTP inside the Docker network and reference identities/scopes. It is not suitable for exposure on an untrusted network or production use. For development of **just one app**, use that app's `pnpm dev` and loopback `/__inspector`; a Gateway is unnecessary.

## Production / custom deployment

This application is the deployable distributed-test reference process, **not** a general-purpose gateway: it hardcodes Kanban and Email credentials and example principals. Its `E2E_SECOND_API_KEY` is only for tenant/scope isolation tests. For a real deployment, compose your own `@embody/gateway` service with your identity, registry, audit, endpoint policy, TLS, and secret-management choices; see [self-hosting the Gateway](../../docs/production/07-self-hosting-the-gateway.md).

To build and run the reference process directly: `pnpm --filter @embody/app-gateway build` and `pnpm --filter @embody/app-gateway start` (supply its environment yourself). Registration is at `/register` and `/api/registry/register` (with heartbeat routes); execution is under `/api/execute`, discovery under `/api/catalog`, and MCP under `/mcp`.
