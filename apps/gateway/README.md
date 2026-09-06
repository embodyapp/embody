# Gateway application

This is the deployable Phase 10 control-plane process. It is intentionally configured
entirely by environment variables: registration credentials and the API/signing keys
must be supplied by a secret manager (the compose smoke stack uses an ignored `.env`
file). It registers Kanban and Email independently and exposes catalog, CLI-compatible
HTTP execution, and MCP routes from `@embody/gateway`.

Build and run with `pnpm --filter @embody/app-gateway build` and
`pnpm --filter @embody/app-gateway start`.

Registration is available at `/register` and `/api/registry/register` (with matching
heartbeat routes); execution is under `/api/execute`, discovery under `/api/catalog`,
and MCP under `/mcp`. The process supports a second, Kanban-only test identity when
`E2E_SECOND_API_KEY` is present, solely so the distributed suite can prove tenant and
scope isolation.
