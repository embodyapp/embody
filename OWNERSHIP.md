# Ownership: what's ours, what's yours

embody's core promise is that you bend the system to your process **and still take
upstream upgrades**. That promise rests on one thing: your changes live in directories
upstream never writes to. This document says exactly where those are, and how to keep
the boundary honest.

## The five buckets

| Directory    | Owner        | What it is                                                        |
| ------------ | ------------ | ----------------------------------------------------------------- |
| `framework/` | **upstream** | The runtime: kernel, core, db, auth, host, cli, mcp-server, plugin-sdk |
| `catalog/`   | **upstream** | First-party apps you can enable (crm, b2b-saas, ecom-fulfillment) |
| `examples/`  | **upstream** | A reference deployment and the demo UI. Copy them; don't edit them |
| `custom/`    | **you**      | Your plugins — your rules, schemas, tools, commands               |
| `deploy/`    | **you**      | Your deployables — which plugins run, and where                   |

Upgrades replace the top three wholesale. They never touch the bottom two.

## The rule

> **Import upstream code by package name. Own everything under `custom/` and `deploy/`.
> Never take a dependency in the other direction.**

Concretely:

- Upstream packages are `@embody/*`. **That scope is the vendor's, not yours.** Your
  packages are private and unscoped — `acme-crm`, not `@embody/custom-acme-crm`.
- Your deployment imports catalog apps by package name (`@embody/crm`) and your own
  plugins by their package name too (`acme-crm`). The kernel does not distinguish
  them; they ride the same plugin SPI.
- Nothing under `framework/` or `catalog/` may import from `custom/` or `deploy/`.

## Making a change, decided by where it goes

| You want to…                                   | Do this                                            |
| ---------------------------------------------- | -------------------------------------------------- |
| Add a rule, field, tool, schema, or command     | `embody new custom <name> --for deploy/<yours>`    |
| Choose which plugins run                        | Edit `deploy/<yours>/embody.config.ts`             |
| Change how a catalog app behaves                | A hook in your own plugin — **not** an edit to `catalog/` |
| Fix a genuine upstream bug                      | Contribute it upstream; don't carry a local patch  |

The third row is the one that matters. Domain hooks (`crm.deal.beforeUpdate`, etc.) run
inside the tenant transaction around every entity write, so a rule you register in
`custom/` genuinely blocks a real write — for agents, REST, and the CLI alike. That is
why you almost never need to edit a catalog app. See
[docs/customization-and-upgrades.md](docs/customization-and-upgrades.md).

## Upgrading

```bash
git remote add upstream <embody repo url>   # once
git fetch upstream
embody doctor                                # ← check before you merge
git merge upstream/main
```

`embody doctor` reports any file you have changed inside `framework/`, `catalog/` or
`examples/` — committed or not — and exits non-zero. Those files, and only those, are
what a merge can conflict on. If doctor is clean, the merge is clean.

If doctor cannot find an upstream ref it says so and checks nothing, rather than
reporting a false pass.

## Why one repo, and not npm packages

You clone embody once and own your zones inside that clone. There is no separate SDK to
install: `framework/` packages export TypeScript sources directly and are consumed
through the pnpm workspace, so there is no build step between you and the runtime you
are extending. The trade-off is that upgrading is a `git merge` rather than a version
bump — which is exactly what the bucket split and `embody doctor` are here to make safe.
