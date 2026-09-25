# `@embody/genui`

App-owned presentation contracts for Embody action results.

> Current status: Phase P14-01 contracts. Web, text, browser, MCP Apps, and harness renderers are planned but are not implemented by this package version.

## Contract

A presented action returns ordinary validated domain data. Its registered view receives that same value as props. Protocol v1 deliberately has no output projector or special response envelope, so HTTP, CLI, and non-UI MCP behavior remain unchanged.

The action output and view props must use the same Zod schema object:

```ts
import { definePlugin, z } from "@embody/core";
import { defineGenUi, defineView, withGenUi } from "@embody/genui";

const BoardResult = z.object({
  title: z.string(),
  cards: z.array(z.object({ id: z.string(), title: z.string() })),
});

const cards = definePlugin({
  id: "cards",
  version: "1.0.0",
  actions: {
    board: {
      input: z.object({}),
      output: BoardResult,
      handler: async () => ({ title: "Sprint", cards: [] }),
    },
  },
});

const presentation = defineGenUi({
  views: {
    board: defineView({
      kind: "standard",
      version: "1.0.0",
      props: BoardResult,
      resource: { text: "<!doctype html><main id=\"app\"></main>" },
      fallback: "markdown",
    }),
  },
  actions: { "cards.board": "board" },
});

export default withGenUi(
  { appId: "kanban", version: "1.0.0", plugins: [cards] },
  presentation,
);
```

`compileGenUiManifest()` produces optional, protocol-version-1 view metadata and action bindings without mutating the base kernel manifest or action output.

## Security boundary

`resource.text` is a trusted immutable application build artifact. Never pass model-authored or action-input HTML, JavaScript, CSS, resource URLs, or CSP declarations to `defineView`. Resource integrity covers the HTML bytes and security/rendering metadata; tenant action data is delivered separately and is never included in the resource hash.
