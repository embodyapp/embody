# deploy/ — 🚀 YOURS.

Your deployables live here. A deployment is the embody host plus an `embody.config.ts`
listing which plugins run — there is no server code to fork.

```bash
embody new deployment <yours> --apps crm,b2b-saas
pnpm --filter <yours>-deployment migrate
pnpm --filter <yours>-deployment dev
```

Upstream never writes to this directory, so the file that enables your customizations
can never conflict on upgrade. That is what makes "customize without forking" true
rather than aspirational.

See [../OWNERSHIP.md](../OWNERSHIP.md); `acme/` is a worked example.
