# Directory Structure

This describes **the embody repository** — the one that publishes embody to npm. If you
are building an app you need none of it; skip to
[Your app's layout](#your-apps-layout).

The top level is split by **role in the ecosystem**. Each bucket answers one question:
*does this ship, and to whom?*

```text
embody/
├── packages/   📦  Published as @embody/*. The runtime and the SPI. One version line.
├── plugins/    📦  Published. First-party plugins, built on the PUBLIC SPI.
├── ui/         📦  Published, separate version line. Browser packages.
├── demo/       🖥️  Never published. Showcase apps, to look at.
└── examples/   📖  Never published. Reference code, to copy.
```

The rule reads off the path: **`@embody/*` means published.** Anything not published is
private and unscoped.

---

## `packages/` — the runtime and the SPI

| Package              | Name                 | What it does                                              |
| -------------------- | -------------------- | --------------------------------------------------------- |
| `plugin-sdk/`        | `@embody/plugin-sdk` | **The public contract.** Everything a plugin imports.      |
| `kernel/`            | `@embody/kernel`     | Microkernel: lifecycle, DI, hooks, capability enforcement  |
| `core/`              | `@embody/core`       | Shared entities, parties, the cross-app registry           |
| `db/`                | `@embody/db`         | Drizzle ORM, RLS helpers, the SQL migration runner         |
| `auth/`              | `@embody/auth`       | Principals, RBAC, the `req.assert()` check                 |
| `host/`              | `@embody/host`       | HTTP engine, the `/api` tool bridge, `embody-host`         |
| `cli/`               | `@embody/cli`        | The `embody` binary                                        |
| `mcp-server/`        | `@embody/mcp-server` | Stdio MCP runner for AI agents                             |
| `testing/`           | `@embody/testing`    | Boot a real runtime inside a plugin's tests                |
| `create-embody-app/` | `create-embody-app`  | The project generator                                      |

`kernel`, `core`, and `db` are **implementation detail**. A plugin never imports them —
`plugin-sdk` re-exports everything it needs, so those three can change without a major
bump. See [../PLUGINS.md](../PLUGINS.md).

`testing` is separate from `plugin-sdk` for a structural reason: `host` already depends
on `plugin-sdk`, so the SDK cannot re-export the host without a cycle.

## `plugins/` — first-party plugins

`crm/` (`@embody/crm`) — deals and contact profiles.

Kept out of `packages/` deliberately. It depends on `@embody/plugin-sdk` by **version
range**, not by workspace link, which makes it a continuous test that the public SPI is
sufficient. If the first-party CRM cannot be built through it, no community plugin can.

## `ui/` — browser packages

`react/` (`@embody/react`) — hooks over the host's `/api` bridge.

On its own version line, because the runtime is headless and how you render it is your
business. It imports nothing from any other embody package: the few shapes that must
agree with the server (`Principal`, `Permission`, the error kinds) are re-declared and
pinned by tests, so a browser bundle never pulls in hono or postgres.

## `demo/` — showcase apps

`demo-ui/` — a Vite SPA with two full CRMs, an AI copilot, and one page wired to a live
host. It proxies `/api` to port 3100, which is what makes `@embody/react` same-origin:
no CORS, and the session cookie rides ordinary fetches.

Here to be looked at. To start from something, copy `examples/`.

## `examples/` — reference code

| Directory           | What it shows                                                        |
| ------------------- | -------------------------------------------------------------------- |
| `custom-crm/`       | A complete app: config, its own plugin, its own schema, its own tests |
| `b2b-saas/`         | A plugin written exactly as a community plugin would be              |
| `ecom-fulfillment/` | Another one                                                          |

`custom-crm` is the shape `npm create embody-app` generates, and a test pins the two
together — if they drift, the example is what is wrong.

The two plugin examples are named `embody-plugin-*` and declare peer dependencies, so
they demonstrate the real conventions rather than workspace shortcuts.

---

## Your app's layout

An embody app is an ordinary npm project. Nothing from the tree above is checked into
it:

```text
my-crm/
├── package.json          depends on @embody/host and whichever plugins you enable
├── embody.config.ts      which plugins run — this is the whole of your server
├── src/plugin.ts         your rules, tools, extra fields
├── plugins/<name>/       further plugins, from `embody new plugin`
└── migrations/           your own schema
```

Create one with:

```bash
npm create embody-app my-crm
```

---

## Root files

| File                  | Purpose                                                       |
| --------------------- | ------------------------------------------------------------- |
| `pnpm-workspace.yaml` | Which directories hold workspace packages                     |
| `turbo.json`          | Task graph. `typecheck` deliberately does not depend on build |
| `tsconfig.base.json`  | Shared compiler options, for this repo only                   |
| `docker-compose.yml`  | Local Postgres on 5432                                        |
| `PLUGINS.md`          | The plugin contract                                           |
| `ARCHITECTURE.md`     | The eight design decisions                                    |

Inside the workspace every package's `exports` points at **source**, and only
`publishConfig` swaps it to `dist/` at publish time. That keeps the local loop
build-free while consumers still get compiled output with type declarations.
