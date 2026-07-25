# catalog/ — 📦 UPSTREAM. Do not edit.

First-party apps a deployment can enable: `crm`, `b2b-saas`, `ecom-fulfillment`.
Enable one by adding its plugin to your deployment's `embody.config.ts`.

To change how one of these behaves, **do not edit it**. Register a hook from your own
plugin under `custom/` — domain hooks run inside the transaction around every entity
write, so your rule genuinely gates the write:

```bash
embody new custom <name> --for deploy/<yours>
```

Editing anything here conflicts on upgrade. See [../OWNERSHIP.md](../OWNERSHIP.md).
