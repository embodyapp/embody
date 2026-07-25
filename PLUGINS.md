# Plugins: the contract

embody is a headless business operating system. You compose an app from plugins instead
of editing a runtime, and a plugin you write can be published for someone else to
install. This document is the contract that makes the second half true.

## What ships, and to whom

| Directory   | Published as   | What it is                                                    |
| ----------- | -------------- | ------------------------------------------------------------- |
| `packages/` | `@embody/*`    | The runtime and the SPI. One version line.                     |
| `plugins/`  | `@embody/*`    | First-party plugins, built on the public SPI like any other.   |
| `ui/`       | `@embody/*`    | Browser packages, on their own version line.                   |
| `demo/`     | never          | Showcase apps, to look at rather than copy.                    |
| `examples/` | never          | Reference code to copy.                                        |

The rule reads off the path: **`@embody/*` means published.** Anything not published is
private and unscoped.

`plugins/crm` depends on `@embody/plugin-sdk` by version range rather than by workspace
link on purpose. It is the dogfood test — if the first-party CRM cannot be built through
the public SPI, nobody else's plugin can be either.

## The one rule

> **A plugin depends on `@embody/plugin-sdk`, and on nothing else from embody.**

`@embody/plugin-sdk` re-exports the whole plugin-authoring surface: the plugin type, the
kernel context, the request context, all four extension surfaces, and the core service
interfaces you consume through DI. `@embody/kernel`, `@embody/core`, and `@embody/db`
are implementation detail behind it and can change without a major bump.

```jsonc
{
  "name": "embody-plugin-compliance",
  "keywords": ["embody-plugin"],
  "peerDependencies": {
    "@embody/plugin-sdk": "^1.0.0",
    "zod": "^3.24.1"
  },
  "devDependencies": {
    "@embody/plugin-sdk": "^1.0.0",
    "@embody/testing": "^1.0.0",
    "zod": "^3.24.1"
  }
}
```

### Peer, never dependency

This is the part that bites, and it is worth understanding rather than copying.

A plugin registers its hooks against the SDK instance it resolved. If an app ends up
with two copies of `@embody/plugin-sdk`, your plugin registers against a registry the
kernel never boots. It then installs cleanly, logs nothing, and **its rules silently
never run**. Nothing throws, so nothing in a stack trace points at it.

Declaring the SDK as a `peerDependency` is what lets the installer collapse everyone
onto one copy. `zod` needs the same treatment: your schemas cross into the host, which
parses them and converts them to JSON Schema, and `instanceof` checks fail across
copies.

`embody doctor` exists mostly to catch this. Run it in any app:

```bash
npx embody doctor
```

### Depending on another plugin

If your plugin extends one — declaring `dependsOn: ["crm"]` or registering a `crm.*`
hook — that is a runtime requirement even when you import nothing from it. Declare it as
a peer dependency too:

```jsonc
"peerDependencies": { "@embody/crm": "^1.0.0" }
```

`examples/b2b-saas` is exactly this case: it never imports `@embody/crm`, and still
cannot function without it.

## Conventions

**Naming.** Community plugins are `embody-plugin-<name>`, with `"keywords":
["embody-plugin"]` so they are discoverable and so `embody doctor` can recognise them.
`@embody/*` is the vendor scope; do not publish into it.

**Schemas.** A plugin owns one Postgres schema outright and migrates it independently.
Two plugins claiming the same schema will overwrite each other's tables, so name yours
after your plugin. `embody doctor` fails on a collision.

**Capabilities.** Declare everything you touch in the capability manifest — hooks,
entities, services consumed or provided, events published. The kernel rejects anything
undeclared. This is also what lets someone install your plugin and see statically what
it can reach, which matters more for a stranger's plugin than for your own.

## Upgrading

There is no merge. embody arrives from npm:

```bash
npm update @embody/crm
```

Two consequences worth knowing:

1. **Migrations apply at boot.** A new version's SQL runs the next time your app starts,
   inside an advisory lock. Use `embody-host ./embody.config.ts --mode migrate-only` as
   an explicit deploy step if you would rather that not happen implicitly.
2. **Migrations only roll forward.** Installing an older version leaves the newer schema
   in place; the package downgrades, the database does not.

## Testing a plugin

`@embody/testing` boots a real kernel so a veto you prove in a test is the veto that
fires in production. It is a devDependency and never ships in an app's runtime graph.

```ts
import { bootRuntime, defineConfig, makeExecutor, databaseReachable } from "@embody/testing";
```

It lives apart from the SDK for a structural reason: `@embody/host` already depends on
`@embody/plugin-sdk`, so the SDK cannot re-export the host without a cycle.
