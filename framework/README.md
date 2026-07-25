# framework/ — ⚙️ UPSTREAM. Do not edit.

The embody runtime: `kernel`, `core`, `db`, `auth`, `host`, `cli`, `mcp-server`,
`plugin-sdk`. Upgrades replace this directory wholesale, so any edit you make here
becomes a merge conflict the next time you run `git merge upstream/main`.

To change how embody behaves, write a plugin instead:

```bash
embody new custom <name> --for deploy/<yours>
```

See [../OWNERSHIP.md](../OWNERSHIP.md).
