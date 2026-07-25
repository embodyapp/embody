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

## 📦 3. Kernel Capability Sandboxing

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
