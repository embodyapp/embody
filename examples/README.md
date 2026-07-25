# examples/ — 📖 never published

Reference code to copy.

- `custom-crm` — a complete app: its config, its own plugin, its own schema. This is the
  shape `npm create embody-app` generates, and the two are pinned together by a test.
- `b2b-saas`, `ecom-fulfillment` — two plugins written the way a community plugin is
  written, down to the `embody-plugin-*` name and the peer dependencies.

Your own app does not belong here. Create one anywhere you like:

```bash
npm create embody-app my-crm
```

See [../PLUGINS.md](../PLUGINS.md).
