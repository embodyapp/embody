# Distributed Phase 10 test

The release-blocking journey lives in `test/fixtures/distributed-e2e/journey.mjs` so it
can own its MCP SDK dependencies as a workspace package. Run it after a build with:

```sh
pnpm test:e2e
```

It generates ephemeral API keys, per-app registration credentials, JWT/event signing
secrets, project names, ports, and a Compose env file. It starts PostgreSQL 16, the
gateway, Kanban, and Email from compiled JavaScript, waits on health/poll conditions,
and always runs `docker compose down --volumes --remove-orphans`.

The journey exercises CLI, MCP, and HTTP against one tenant; guardrail rollback and
absence of a phantom event; forced Kanban termination before commit; publisher restart
after durable fan-out while Email is offline; a forced Email process exit after the mail
side effect but before acknowledgement; idempotent retry;
ordered CLI/MCP batch progress; registry TTL disappearance and recovery; API-key tenant
and scope isolation; and rejection of a correctly signed token with the wrong app
audience.

For interactive local use, run `pnpm gateway:dev` from the repository root instead.
It generates and reuses gitignored local test credentials, builds the Compose stack,
waits for both apps to register, and prints a CLI example. `pnpm gateway:dev:logs`
shows container logs; `pnpm gateway:dev:down` stops the stack and removes disposable
data. See [the local Gateway instructions](../../apps/gateway/README.md).

`docker-compose.e2e.yml` can still be run manually by copying `e2e.env.example` to an
ignored env file and filling every blank with generated test-only values. Its published
ports are loopback-only. Never reuse these credentials outside an isolated test stack.
