# React Hooks & the HTTP Tool Bridge

A UI is the **fourth transport over the one executor**. A plugin registers a tool once; an
AI agent calls it over MCP, a script calls it over the CLI, and a React component calls it
with `useToolQuery` / `useToolMutation`. All four get the same tenant scoping (RLS), the
same authorization, and the same vetoable hook chain.

The practical consequence: a rule another plugin registered — including a company's own,
you wrote — refuses a write from your UI **without your UI containing any code for
it**. You do not re-implement business rules in the browser, and you cannot accidentally
bypass them.

Two pieces:

| Piece | Package | What it is |
| :--- | :--- | :--- |
| The bridge | `@embody/host` | `/api/*` routes that call `makeExecutor`. Mounted by `startHost` by default. |
| The hooks | `@embody/react` | `EmbodyProvider` + hooks over that bridge. Zero runtime dependencies; React is a peer. |

---

## 1. Quickstart

Install and wrap your app:

```bash
pnpm add @embody/react
```

```tsx
import { EmbodyProvider } from '@embody/react';

<EmbodyProvider>          {/* baseUrl defaults to "/api" */}
  <App />
</EmbodyProvider>
```

Read and write:

```tsx
import { useToolQuery, useToolMutation, useCan } from '@embody/react';

function Deals() {
  const { data, status, error, isFetching, refetch } = useToolQuery('crm_query_deals', { limit: 50 });
  const canWrite = useCan('write', 'crm:deal');

  const close = useToolMutation('crm_update_deal', {
    invalidates: ['crm_query_deals'],
    optimistic: (input, tx) =>
      tx.patch('crm_query_deals', (rows = []) =>
        rows.map((r) => (r.id === input.id ? { ...r, stage: input.stage } : r))),
  });

  if (status === 'loading') return <Skeleton />;

  return rows.map((deal) => (
    <button
      disabled={!canWrite}
      onClick={async () => {
        const res = await close.mutate({ id: deal.id, stage: 'closed_won' });
        // A domain rule refusing is an ordinary outcome, not an exception.
        if (!res.ok) toast.error(res.error.message);
      }}
    >
      Close
    </button>
  ));
}
```

A working example is `demo/demo-ui/src/live/` — the "Live data" page in the B2B CRM.
See §7 to run it.

---

## 2. The bridge

Mounted on the host's Hono app by `startHost` unless you pass `api: false`.

| Route | Auth | Body | 200 response |
| :--- | :--- | :--- | :--- |
| `POST /api/session` | dev-gated | `{orgId, userId, roles?}` | `{principal, permissions, source}` + `Set-Cookie` |
| `DELETE /api/session` | — | — | `204` |
| `GET /api/me` | required | — | `{principal, permissions, source}` |
| `GET /api/tools` | required | — | `{tools: ToolDescriptor[]}` |
| `POST /api/tools/:name` | required | `{input?}` | `{result}` |

**Everything is POST, including reads.** The executor draws no read/write distinction, and
a query string cannot carry a tool's nested input losslessly. So nothing here is
HTTP-cacheable — every response carries `Cache-Control: no-store`, and caching is the
client's job (§4).

**Envelopes both ways** (`{input}` / `{result}` / `{error}`) so a tool result that happens
to be shaped like `{result: …}` stays unambiguous, and fields like `requestId` can be added
later without a breaking change.

**CSRF** is covered by requiring `content-type: application/json` (a cross-site HTML form
cannot set it) plus the session cookie's `SameSite=Lax`.

`GET /api/tools` publishes real JSON Schema per tool, converted from the plugin's Zod
schema — enough to render a form or pre-validate, not just a list of parameter names:

```json
{ "tools": [{
  "name": "crm_query_deals",
  "description": "List deals in the current org, optionally filtered by stage.",
  "inputSchema": { "type": "object", "properties": {
    "stage": { "type": "string" },
    "limit": { "type": "integer", "exclusiveMinimum": 0, "maximum": 100 } } } }]}
```

There is deliberately **no per-tool "may I call this?" flag**: the permission a tool needs
lives inside its handler (`req.assert("write", "crm:deal")`) and is not declaratively
knowable, so any such flag would be a guess. Use `useCan` for affordance instead.

---

## 3. Errors: the taxonomy

Every failure arrives as an `EmbodyError` with a `kind`. Branch on the kind, not the status.

| kind | HTTP | Means | What a UI should do |
| :--- | :--- | :--- | :--- |
| `unauthenticated` | 401 | No session, no dev identity | Show the login screen |
| `denied` | 403 | RBAC refused | Disable the control; explain the role |
| `veto` | 409 | **A domain rule refused** | Show `message` verbatim; do not retry unchanged |
| `not_found` | 404 | No such row in this org | "Not found" — see the RLS note below |
| `unknown_tool` | 404 | This deployment doesn't enable that app | Hide the feature |
| `invalid_input` | 400 | Failed the tool's Zod schema | Field errors from `details` (Zod issues) |
| `unavailable` | 501 | Route exists, switched off in this config | Explain the configuration |
| `internal` | 500 | A bug | Generic message; the real one is in the server log |
| `network` | 0 | Never reached the server | "Offline" / retry |

**Which messages are safe to show a user?** `veto`, `denied`, `not_found` and
`unknown_tool` are written for humans by the plugin author and cross the wire verbatim —
surfacing a rule's own reason *is* the feature. `internal` is redacted to `"Internal
error"` server-side; the original is logged and never sent.

A veto also carries `details: { hook, plugin }`, so a UI can say *which* plugin refused
without parsing the sentence:

```json
{ "error": {
  "kind": "veto",
  "message": "Acme policy: healthcare deals require a completed HIPAA review before they can move to 'closed_won'.",
  "details": { "hook": "crm.deal.beforeUpdate", "plugin": "custom-acme-crm" },
  "tool": "crm_update_deal" } }
```

> **404, not 403, for another org's row.** RLS hides the row, and the taxonomy keeps it
> hidden: answering 403 would confirm the id exists. "Hidden" and "missing" are
> indistinguishable on purpose.

### How a veto gets typed

`HookRegistry.run` wraps **every** throw from a hook handler in `HookVetoError`, carrying
the original on `cause`. That happens in the kernel, not in plugins — a design that
required customers to `throw new HookVetoError(...)` in their own plugin code to get a
correct HTTP status would silently produce 500s in every real deployment.

`toHttpError` then unwraps: if the cause is an `AuthorizationError`, `EntityNotFoundError`
or `ZodError`, it maps to *that* (a rule calling `req.assert` is enforcing permissions, not
vetoing); if the cause looks like a driver error, it is a 500. Only a plain domain throw
becomes a 409.

---

## 4. The hooks

```ts
useToolQuery(name, input?, { enabled? })
  -> { data, error, status, isFetching, refetch }

useToolMutation(name, { invalidates?, optimistic?, onSuccess?, onError? })
  -> { mutate, status, error, data, reset }

useTool(name)        // imperative escape hatch: (input?) => Promise<Output>
useTools()           // this deployment's tool catalogue
useIdentity()        // { identity, principal, status, isAuthenticated, login, logout, refresh }
usePrincipal()       // just the principal, or null
useCan(action, res)  // UI affordance only — the server still decides
useEmbody()          // { client, cache } for imperative work
```

Named `useToolQuery`/`useToolMutation`, not `useQuery`/`useMutation`, so they read
unambiguously next to react-query.

**`mutate` never rejects.** It resolves with `{ ok: true, data } | { ok: false, error }`.
A rejected promise in an `onClick` is the most common source of unhandled rejections, and a
veto is an ordinary outcome of a correct request — not an exception.

### The cache

A small `useSyncExternalStore` store, not react-query: the framework should not push a
state library onto every consumer, and what a tool bridge needs is narrow.

- **Keys** are `(tool, canonical input)`. Key order doesn't matter, `undefined` is dropped,
  and non-JSON values (`Date`, `Map`, functions) **throw** rather than silently collide.
- **Dedupe:** one request per key in flight. This is what makes StrictMode's
  mount/unmount/remount, and two components rendering the same list, issue a single fetch.
- **Mounting reuses cached data.** Only an explicit `refetch()` or an `invalidate` goes back
  to the server. One rule: **data changes when you invalidate it.** No `staleTime`, no
  refetch-on-focus, no polling.
- **Revalidation keeps data visible:** `status` stays `success` and `isFetching` carries the
  spinner, so a list doesn't flash a skeleton on every write.
- **Optimistic patches** are recorded and reverted in reverse order if the call fails.
  Known limit: two overlapping mutations on one key roll back to each other's optimistic
  value; the follow-up `invalidate` refetch is the real reconciliation.
- Nothing is aborted on unmount — that would cancel the request StrictMode's remount needs.
  Correctness comes from key-addressed writes plus a per-entry generation counter.

A client `AbortSignal` cancels the *response*, not the server's work. The write still lands.

### Typed tools, no codegen

`ToolMap` is empty by default (everything is `unknown`, and it works). Augment it to get
autocomplete and checked inputs — ideally from the plugin's own schema module, so the types
cannot drift from the server:

```ts
import type { CrmQueryDealsInput, DealRow } from '@embody/crm/schemas';

declare module '@embody/react' {
  interface ToolMap {
    crm_query_deals: { input: CrmQueryDealsInput; output: DealRow[] };
  }
}
```

`@embody/crm/schemas` is a leaf module importing **only zod** — the plugin entry point
pulls in `node:url`, the kernel and postgres, none of which belongs in a browser bundle.
Every catalog app should follow that pattern.

---

## 5. Identity

**Dev-grade by design.** `POST /api/session` has no password concept: it verifies that the
membership exists and mints an opaque session cookie
(`HttpOnly; SameSite=Lax; Path=/`, `Secure` on https). Authentication belongs to an
identity provider, and this is the seam one plugs into.

Resolution order:

1. **session cookie** — always honoured; a session was explicitly minted;
2. `x-embody-org` / `x-embody-user` / `x-embody-roles` headers — **only** when `EMBODY_DEV_IDENTITY=1`;
3. `EMBODY_ORG` / `EMBODY_USER` / `EMBODY_ROLES` env — same gate, so what `embody seed`
   prints works with no login step at all.

> ⚠️ **`EMBODY_DEV_IDENTITY=1` is full impersonation.** Anyone who can reach the port
> becomes anyone. It is off by default, and enabling it logs a warning at boot. Never set
> it in production.
>
> `InMemorySessionStore` also drops every session when the process restarts. Swap
> `SessionStore` for a durable one when that matters.

Signing in as `viewer` is how you see RBAC reach the UI: `useCan` disables the controls,
and forcing the call anyway returns 403 `denied`.

### A real identity provider

Everything above sits behind one interface, and the bridge doesn't change:

```ts
startHost({ config, identity: myOidcProvider });
// resolve(c) -> validate a bearer token / JWT -> { principal, source }
// omit login() and POST /api/session answers 501 `unavailable`
```

---

## 6. Testing

- Bridge unit tests need no database: build a fake `Runtime` whose `booted.mcp.tools` are
  real Zod schemas with handlers that throw the interesting errors, and drive it with
  `app.fetch(new Request(...))` — no socket, no port. See `packages/host/src/api.test.ts`.
- The properties that need Postgres — RLS, RBAC and real vetoes over HTTP — are in
  `examples/custom-crm/src/api.integration.test.ts`.
- Hook tests use `@testing-library/react` with a `// @vitest-environment happy-dom`
  docblock pragma (this repo has no vitest config files). Most behaviour is covered
  without React in `ui/react/src/cache.test.ts`.

---

## 7. Running the live example

```bash
pnpm db:up
pnpm --filter acme-deployment migrate
pnpm --filter acme-deployment seed          # prints orgId / userId
```

Then, in two terminals:

```bash
EMBODY_DEV_IDENTITY=1 PORT=3100 pnpm --filter acme-deployment dev
```

```bash
pnpm --filter @embody/demo-ui dev           # http://localhost:5173
```

Open **http://localhost:5173/b2b/live**, sign in with the ids `seed` printed, and click
"Create 3 demo deals". Then move **Brightpath Health** to *closed won* and watch four
things happen in order:

1. **409 veto** from `examples/b2b-saas` — over $50k without a security review. The
   optimistic row snaps back.
2. Click **Security review** → succeeds. The jsonb merge preserves `industry_vertical`,
   which the caller never re-sent.
3. Retry → **409 veto** from `examples/custom-crm` — a *customer's* rule, reaching the browser
   through a page that contains no code for it.
4. Click **HIPAA review** → retry → closed won.

Sign out and back in as `viewer` to see the read-only state.

The demo UI's Vite dev server proxies `/api` to the host, which is what makes the client
same-origin: no CORS, and the session cookie travels on ordinary fetches.

---

## See also

- [AI & MCP Integration](./mcp-and-ai.md) — the sibling transport, same executor
- [Security & Multi-Tenancy](./security-and-multitenancy.md) — RLS, RBAC, the dev-identity warning
- [Middleware & Hooks](./middleware-and-hooks.md) — writing the rules that become 409s
- [Writing Plugins](./writing-plugins.md) — registering a tool once, getting four transports
