# Kanban reference app

A deployable consumer of public Embody packages. It defines `kanban.card`, its five generated CRUD actions, a schema-validated `kanban.board` read, `kanban.bulkMove`, an agent-only completion guardrail, and `kanban.card.ready_for_review`.

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

The app registers its compiled manifest and sends heartbeats when gateway settings are present. Cross-app delivery is enabled with `EMBODY_EVENT_SECRET` and a validated `EMBODY_EVENT_DESTINATIONS` JSON map; the distributed test routes `kanban.card.ready_for_review` to Email. Use distinct, rotated registration credentials, TLS endpoints, and signing keys supplied by secret management. Never commit these values.

After gateway registration, discovery/execution are available through the framework surfaces:

```sh
embody kanban card list --limit 20
embody kanban bulkMove --cardIds <uuid> --newStatus in_review
# Connect an MCP client to the gateway's /mcp or /mcp/kanban endpoint.
```

`bulkMove` rejects empty and duplicate IDs and runs in one transaction: every card is first read in the caller's tenant, then all changes and hooks commit together or none do. An agent can move a card to `done` only when an existing `prUrl` or that same patch contains a valid URL. Humans are not vetoed by this plugin; gateway authorization remains authoritative.

## Experimental GenUI reference fixtures

`kanban.board` returns ordinary domain data: `{ title, cards: [{ id, data }], nextOffset }`. It reads at most 21 records and returns a 20-card page, with an explicit continuation offset when more data exists. Call it with `{ offset: nextOffset }` for the next page. Offset paging is not a durable snapshot; concurrent edits/inserts/deletes may change page membership. The app has no sprint entity, so this is labeled **Kanban board**, not an invented current-sprint filter.

`src/presentation.ts` contains app-owned `createKanbanBoardDocument()` and `createKanbanTaskDocument()` builders for the bounded standard model. The board uses grouped sections/lists; task details use a declared status/PR form targeting the ordinary update action. Text/Markdown fallbacks redact PR values, describe action effects, and escape hostile text. The registered action's output schema is the exported `KanbanBoardSchema`; the registered view reuses that exact schema object. The [P14 release matrix](../../docs/guides/genui-release-evidence.md) records the verified reference-host/native/loopback-browser subset and independent publication limits.

These builders are tested through the real kernel but are **not yet bound to a served resource or interactive Pi/MCP Apps runtime**. Calling the board action through HTTP/CLI/MCP still returns ordinary data; no UI is opened automatically. The text fallback is opt-in application/test code, not a changed transport envelope. A view click must retain the authenticated initiating principal: a human operating an agent-principal session observes the agent PR veto; a true human principal does not.

```ts
import { renderGenUiText } from "@embody/genui/text";
import { createKanbanBoardDocument } from "./presentation.js";

// result is the validated output of the ordinary kanban.board action.
const text = renderGenUiText(createKanbanBoardDocument(result), { width: 80 });
```

`test/presentation.test.ts` exercises ordinary board reads, bounded pagination, hostile-text fallback, form payload validation, the agent PR veto and correction. `test/genui-journey.test.ts` separately covers shared lifecycle behavior with real actions. `test/pi-visibility.test.ts` adds a headless public Pi 1.0.0 SDK fixture: the actual initiating agent principal observes the veto, corrects the draft, refreshes, and publishes two redacted outcomes to model context. It does not exercise authenticated gateway transport or native keyboard interaction. No browser, native Pi, or vendor-host support is claimed by these fixtures.

`src/seed.ts` is intentionally a test/development helper and is never called by production startup.
