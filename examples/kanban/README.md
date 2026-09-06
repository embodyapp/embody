# Kanban reference app

A deployable consumer of public Embody packages. It defines `kanban.card`, its five generated CRUD actions, `kanban.bulkMove`, an agent-only completion guardrail, and `kanban.card.ready_for_review`.

## Local SQLite

```sh
pnpm --filter @embody/example-kanban test
pnpm --filter @embody/example-kanban dev
curl -X POST http://127.0.0.1:8081/execute \
  -H 'x-gateway-auth: Bearer local' -H 'content-type: application/json' \
  -d '{"protocolVersion":1,"target":"kanban.card.create","input":{"data":{"title":"Ship it"}}}'
```

The local verifier is deliberately development-only and treats requests as a local human developer. Do not expose this listener outside a trusted loopback development environment.

## Gateway / PostgreSQL deployment

Development defaults to SQLite. Production requires `DATABASE_URL` and therefore uses PostgreSQL; set **all** production variables rather than relying on defaults:

```sh
NODE_ENV=production PORT=8081 DATABASE_URL=postgres://kanban:password@postgres:5432/kanban \
GATEWAY_URL=https://gateway.example.net \
PUBLIC_URL=https://kanban.example.net \
GATEWAY_REGISTRATION_SECRET='a-rotated-per-app-secret' \
GATEWAY_JWT_ISSUER=https://gateway.example.net \
GATEWAY_JWT_SECRET='a-32-byte-or-longer-signing-secret' \
pnpm --filter @embody/example-kanban start
```

The app registers its compiled manifest and sends heartbeats when gateway settings are present. Use a distinct, rotated registration secret per application, a TLS gateway URL, and a private signing key supplied by secret management. Never commit these values.

After gateway registration, discovery/execution are available through the framework surfaces:

```sh
embody kanban card list --limit 20
embody kanban bulkMove --cardIds <uuid> --newStatus in_review
# Connect an MCP client to the gateway's /mcp or /mcp/kanban endpoint.
```

`bulkMove` rejects empty and duplicate IDs and runs in one transaction: every card is first read in the caller's tenant, then all changes and hooks commit together or none do. An agent can move a card to `done` only when an existing `prUrl` or that same patch contains a valid URL. Humans are not vetoed by this plugin; gateway authorization remains authoritative.

`src/seed.ts` is intentionally a test/development helper and is never called by production startup.
