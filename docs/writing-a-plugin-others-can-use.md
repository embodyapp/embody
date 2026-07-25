# Writing a plugin others can use

A plugin that only runs in your app and one that a stranger installs from npm are the
same object. The difference is entirely in the packaging, and this walks through it.

If you only want to bend your own app, [Customization &
Upgrades](customization-and-upgrades.md) is the shorter path. Come back when you want to
publish.

---

## 1. Start from a plugin that works

Inside your app:

```bash
npx embody new plugin compliance
```

Build the rule until it does what you want, then move `plugins/compliance/` into its own
repository. Nothing in the code changes — the kernel does not care where a plugin came
from.

## 2. Package it

```jsonc
{
  "name": "embody-plugin-compliance",
  "version": "1.0.0",
  "type": "module",
  "keywords": ["embody-plugin"],
  "exports": { ".": "./dist/index.js" },
  "types": "./dist/index.d.ts",
  "files": ["dist", "src", "migrations"],

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

Four things here are load-bearing.

**`embody-plugin-*` and the keyword.** This is the discovery convention, and
`embody doctor` uses the keyword to recognise your package as a plugin.

**`peerDependencies`, not `dependencies`.** This is the one that will bite you if you
skip it. Your plugin registers hooks against the SDK instance it resolved; if an app
ends up with two copies of `@embody/plugin-sdk`, you register against a registry the
kernel never boots. Your plugin then installs cleanly, logs nothing, and **its rules
never run**. Nothing throws. A user will report that your plugin "does nothing" and
neither of you will have a stack trace to look at.

`zod` needs identical treatment: your schemas cross into the host, which parses them and
converts them to JSON Schema, and `instanceof` checks fail across copies.

**`migrations` in `files`.** Your plugin computes its migration directory from
`import.meta.url`, so it resolves fine inside `node_modules` — but only if you actually
ship the directory.

**Flat `dist/`.** If your build nests output (`dist/src/plugin.js`), the `../migrations`
lookup climbs one level too few and breaks.

## 3. Name your schema after your plugin

A plugin owns one Postgres schema outright and migrates it independently. Two plugins
claiming the same schema will overwrite each other's tables — a failure that surfaces as
data loss, not an error. `embody doctor` rejects a collision, but only once both are
installed, so pick a name nobody else would: `compliance`, not `audit` or `shared`.

## 4. Declare what you touch

```ts
capabilities: {
  entities: ["compliance.review"],
  hooks: ["crm.deal.beforeUpdate"],
  services: { consume: ["core.registry"] },
  events: { publish: ["compliance.reviewed"] },
}
```

The kernel rejects anything undeclared at runtime, so this is enforcement rather than
documentation. It matters more for a published plugin than a private one: it is how
somebody decides whether to trust yours. A reader can see statically that you touch one
hook and one schema and publish one event, without reading your source.

## 5. Depend on other plugins as peers

If yours extends another — `dependsOn: ["crm"]`, or registering a `crm.*` hook — that is
a runtime requirement even when you import nothing from it:

```jsonc
"peerDependencies": { "@embody/crm": "^1.0.0" }
```

`examples/b2b-saas` in this repository is exactly that shape: it never imports
`@embody/crm`, and cannot work without it.

## 6. Test against a real runtime

```ts
import { bootRuntime, defineConfig, makeExecutor, databaseReachable } from "@embody/testing";
import { crmPlugin } from "@embody/crm";
import { compliancePlugin } from "./src/plugin.ts";

const suite = (await databaseReachable()) ? describe : describe.skip;

suite("compliance blocks an unreviewed close", () => {
  it("rolls the write back", async () => {
    const runtime = await bootRuntime({
      config: defineConfig({ plugins: [crmPlugin, compliancePlugin] }),
    });
    // Drive a real tool through the executor an agent, the CLI and REST all share.
  });
});
```

Booting a real kernel is worth the seconds it costs. A veto proven against a fake never
proves the write actually rolled back, and the rollback is the whole feature.

Guard on `databaseReachable()` so a contributor without Postgres running still gets a
clean test run rather than a wall of failures.

## 7. Before you publish

```bash
npm pack
tar -tzf embody-plugin-compliance-1.0.0.tgz
```

Check `migrations/` is in there and that `dist/` is flat. Then install the tarball into a
scratch app and boot it — a plugin that resolves in your monorepo and not in a real
`node_modules` is a common enough outcome to be worth ten minutes.

```bash
npm create embody-app trial
cd trial && npm i ../embody-plugin-compliance-1.0.0.tgz
# add it to embody.config.ts
npx embody doctor && npm run migrate
```

If `doctor` reports two SDK copies, your `peerDependencies` are wrong. That is the check
existing for this exact moment.
