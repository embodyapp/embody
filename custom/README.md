# custom/ — 🛠️ YOURS.

Your plugins live here. Upstream never writes to this directory, so nothing you put
here can conflict when you upgrade.

```bash
embody new custom <name> --for deploy/<yours>
```

That creates the package **and** wires it into your deployment (dependency, import, and
plugins array) in one step.

A plugin here has the same powers as a first-party app: its own Postgres schema with
RLS, vetoable domain hooks that gate real writes, DI services, MCP tools, CLI commands,
and event subscriptions — all declared in a capability manifest the kernel enforces.

Name packages **unscoped and private** (`acme-crm`). `@embody/*` is the vendor's npm
scope. See [../OWNERSHIP.md](../OWNERSHIP.md); `acme-crm/` is a worked example.
