import { describe, expect, it } from "vitest";
import { definePlugin, z } from "@embody/core";
import { defineGenUi, defineView, withGenUi } from "../src/index.js";

const result = z.object({ value: z.string() });
const plugin = definePlugin({
  id: "demo",
  version: "1.0.0",
  actions: {
    show: {
      input: z.object({}),
      output: result,
      handler: () => ({ value: "ok" }),
    },
  },
});
const app = { appId: "demo", version: "1.0.0", plugins: [plugin] as const };
const resource = { text: "<!doctype html><title>Demo</title>" };

function compileTimeRejectionFixtures(): void {
  const compatible = defineView({
    kind: "standard",
    version: "1.0.0",
    props: result,
    resource,
    fallback: "markdown",
  });
  const incompatible = defineView({
    kind: "standard",
    version: "1.0.0",
    props: z.object({ count: z.number() }),
    resource,
    fallback: "markdown",
  });

  // @ts-expect-error unknown action target
  withGenUi(app, defineGenUi({ views: { compatible }, actions: { "demo.missing": "compatible" } }));
  // @ts-expect-error unknown view name
  withGenUi(app, defineGenUi({ views: { compatible }, actions: { "demo.show": "missing" } }));
  const incompatibleDefinition = defineGenUi({
    views: { incompatible },
    actions: { "demo.show": "incompatible" },
  });
  // @ts-expect-error action output and view props differ
  withGenUi(app, incompatibleDefinition);
}
void compileTimeRejectionFixtures;

describe("GenUI public types", () => {
  it("preserves compatible action, view, and props literals", () => {
    const view = defineView({
      kind: "standard",
      version: "1.0.0",
      props: result,
      resource,
      fallback: "markdown",
    });
    const configured = withGenUi(
      app,
      defineGenUi({ views: { result: view }, actions: { "demo.show": "result" } }),
    );

    expect(configured.genui.views.result.props).toBe(result);
    expect(configured.genui.actions["demo.show"]).toBe("result");
  });

  it("maintains compile-time rejection fixtures", () => {
    expect(compileTimeRejectionFixtures).toBeTypeOf("function");
  });
});
