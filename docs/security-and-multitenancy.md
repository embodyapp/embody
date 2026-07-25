# Security & Multi-Tenancy Deep Dive

Embody is designed from the ground up to support **multi-tenancy** securely (Decision D1 & D4). Multiple companies ("tenants") can safely share the same application instance without any risk of data leakage.

---

## 🔒 1. Database Multi-Tenancy via Row-Level Security (RLS)

In traditional web applications, developers must remember to add `WHERE org_id = current_user_org` to every SQL query. If a developer forgets this clause on even one query, private customer data leaks to another organization!

Embody solves this by enforcing isolation **at the database level** using PostgreSQL **Row-Level Security (RLS)**:

### How RLS Works
1. Every business database table includes an **`org_id`** column.
2. Every table enables RLS policies in SQL:
   ```sql
   ALTER TABLE crm.deals ENABLE ROW LEVEL SECURITY;

   CREATE POLICY tenant_isolation ON crm.deals
     USING (org_id = current_setting('app.current_org')::uuid);
   ```
3. When a web request or AI tool starts, the database connection sets the session variable:
   ```sql
   SET LOCAL app.current_org = 'tenant-uuid-123';
   ```
4. Even if a developer writes `SELECT * FROM crm.deals`, Postgres automatically filters the results to rows matching `'tenant-uuid-123'`.

---

## 🛡️ 2. Centralized Authorization (`ctx.can`)

All identity management (users, organizations, memberships, roles) is owned centrally by `@embody/core`.

### Checking Permissions
Before executing an action, route handlers and MCP tools verify caller rights using `req.assert(action, resource)`:

```typescript
// Asserts that the caller has 'write' permission on resource 'crm:deal'
req.assert("write", "crm:deal");
```

If the caller lacks permission, an HTTP `403 Forbidden` response is returned immediately.

---

## 🪪 3. Who the caller is (HTTP identity)

RLS and `ctx.can` both start from a **`Principal`** (`orgId`, `userId`, `roles`). Over MCP
and the CLI that comes from flags or env. Over HTTP it comes from the identity provider the
host is configured with — a seam, not a fixed policy.

The shipped default (`createDevIdentity`) resolves in this order:

1. **Session cookie** — `embody_session`, an opaque token minted by `POST /api/session`.
   Always honoured, because a session was explicitly created.
2. **`x-embody-org` / `x-embody-user` / `x-embody-roles` headers** — only when
   `EMBODY_DEV_IDENTITY=1`.
3. **`EMBODY_ORG` / `EMBODY_USER` / `EMBODY_ROLES` env** — same gate.

> [!WARNING]
> **`EMBODY_DEV_IDENTITY=1` is full impersonation.** Steps 2 and 3 trust their input
> completely: anyone who can reach the port becomes anyone, in any org, with any role. The
> gate is off by default and logs a warning at boot when enabled. **Never set it in
> production.**

Other properties worth knowing:

- **There is no password concept.** `POST /api/session` verifies that the membership row
  exists and mints a cookie; authentication belongs to an identity provider. Supply your
  own via `startHost({ identity })` — `resolve()` can validate a JWT or bearer token, and
  omitting `login()` makes the dev login route answer `501`. The bridge itself is unchanged.
- **Sessions are in-memory by default.** `InMemorySessionStore` drops everything on
  restart. Swap the `SessionStore` implementation when that matters.
- **Cookie attributes:** `HttpOnly` (so JS cannot read the token — a client reads
  `GET /api/me` instead), `SameSite=Lax`, `Path=/`, and `Secure` on https.
- **CSRF** rests on `SameSite=Lax` plus a required `content-type: application/json` on
  tool calls — a cross-site HTML form cannot set that header.
- **Another org's row answers `404`, never `403`.** RLS hides it, and the error taxonomy
  keeps it hidden: a `403` would confirm the id exists. "Hidden" and "missing" are
  indistinguishable on purpose.
- **Internal errors are redacted.** Only `veto`, `denied`, `not_found` and `unknown_tool`
  messages cross the wire verbatim (they are written for humans by the plugin author);
  anything else becomes `"Internal error"`, with the original in the server log.

Full detail in [React Hooks & the HTTP Bridge](./react-hooks.md).

---

## 📦 4. Kernel Capability Sandboxing

Untrusted or third-party plugins cannot access unauthorized system areas because `@embody/kernel` enforces **Capability Sandboxing** at boot time (Decision D7).

When a plugin loads, it must declare its `CapabilityManifest`:

```typescript
capabilities: {
  entities: ["crm.deal"],
  services: { consume: ["core.registry"] },
  events: { publish: ["crm.deal.created"] },
}
```

### Enforced Rules
- **Services**: A plugin cannot call `ctx.services.get("billing.service")` unless `consume: ["billing.service"]` is listed in its manifest.
- **Hooks**: A plugin cannot register hooks on `billing.invoice.beforeCreate` unless that hook is explicitly declared in its manifest.
- **Events**: A plugin cannot publish events outside its declared publish manifest.

If a plugin attempts to violate its manifest, the kernel rejects the plugin during the startup sequence before the web server begins accepting traffic!
