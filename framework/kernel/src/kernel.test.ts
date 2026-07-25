import { describe, it, expect } from "vitest";
import { EmbodyKernel } from "./kernel.ts";
import { topoSort, PluginError } from "./plugin-manager.ts";
import { HookVetoError } from "./hooks.ts";
import { createSilentLogger } from "./logger.ts";
import type { EmbodyPlugin, KernelContext } from "./types.ts";
import type { DomainEvent } from "./events.ts";

const silent = () => ({ logger: createSilentLogger() });

/** Minimal helper to build a plugin with sane defaults. */
function plugin(p: Partial<EmbodyPlugin> & { id: string; schema: string }): EmbodyPlugin {
  return { capabilities: {}, ...p };
}

describe("topoSort", () => {
  it("orders dependencies before dependents", () => {
    const core = plugin({ id: "core", schema: "core" });
    const crm = plugin({ id: "crm", schema: "crm", dependsOn: ["core"] });
    const billing = plugin({ id: "billing", schema: "billing", dependsOn: ["crm"] });
    const order = topoSort([billing, crm, core]).map((p) => p.id);
    expect(order.indexOf("core")).toBeLessThan(order.indexOf("crm"));
    expect(order.indexOf("crm")).toBeLessThan(order.indexOf("billing"));
  });

  it("throws on unknown dependency", () => {
    const crm = plugin({ id: "crm", schema: "crm", dependsOn: ["nope"] });
    expect(() => topoSort([crm])).toThrow(PluginError);
  });

  it("throws on a dependency cycle", () => {
    const a = plugin({ id: "a", schema: "a", dependsOn: ["b"] });
    const b = plugin({ id: "b", schema: "b", dependsOn: ["a"] });
    expect(() => topoSort([a, b])).toThrow(/cycle/i);
  });
});

describe("service registry (DI)", () => {
  it("lets one plugin consume another's service, dependencies-first", async () => {
    let greeting = "";
    const core = plugin({
      id: "core",
      schema: "core",
      capabilities: { services: { provide: ["core.greeter"] } },
      provides: () => [
        { name: "core.greeter", version: "1.0.0", impl: { hello: () => "hi from core" } },
      ],
    });
    const crm = plugin({
      id: "crm",
      schema: "crm",
      dependsOn: ["core"],
      capabilities: { services: { consume: ["core.greeter"] } },
      init: (ctx: KernelContext) => {
        const greeter = ctx.services.get<{ hello: () => string }>("core.greeter");
        greeting = greeter.hello();
      },
    });
    await new EmbodyKernel(silent()).register(core).register(crm).boot();
    expect(greeting).toBe("hi from core");
  });

  it("blocks consuming an undeclared service (capability enforcement)", async () => {
    const core = plugin({
      id: "core",
      schema: "core",
      capabilities: { services: { provide: ["core.greeter"] } },
      provides: () => [
        { name: "core.greeter", version: "1.0.0", impl: { hello: () => "hi" } },
      ],
    });
    const bad = plugin({
      id: "bad",
      schema: "bad",
      dependsOn: ["core"],
      capabilities: {}, // did NOT declare consume
      init: (ctx: KernelContext) => {
        ctx.services.get("core.greeter");
      },
    });
    await expect(
      new EmbodyKernel(silent()).register(core).register(bad).boot(),
    ).rejects.toThrow(/undeclared service/);
  });
});

describe("hooks", () => {
  it("runs handlers in order, mutating the payload", async () => {
    const p = plugin({
      id: "crm",
      schema: "crm",
      capabilities: { hooks: ["crm.deal.beforeCreate"] },
      registerHooks: (hooks) => {
        hooks.register<{ amount: number }>("crm.deal.beforeCreate", (d) => ({
          amount: d.amount + 10,
        }));
        hooks.register<{ amount: number }>("crm.deal.beforeCreate", (d) => ({
          amount: d.amount * 2,
        }));
      },
    });
    const booted = await new EmbodyKernel(silent()).register(p).boot();
    const ctx = {} as KernelContext;
    const result = await booted.hooks.run(
      "crm.deal.beforeCreate",
      { amount: 5 },
      ctx,
    );
    expect(result).toEqual({ amount: 30 }); // (5 + 10) * 2
  });

  it("propagates a veto (thrown error) from a hook, typed as HookVetoError", async () => {
    const cause = new Error("deletion not allowed");
    const p = plugin({
      id: "compliance",
      schema: "compliance",
      capabilities: { hooks: ["crm.deal.beforeDelete"] },
      registerHooks: (hooks) => {
        hooks.register("crm.deal.beforeDelete", () => {
          throw cause;
        });
      },
    });
    const booted = await new EmbodyKernel(silent()).register(p).boot();
    const err = await booted.hooks
      .run("crm.deal.beforeDelete", {}, {} as KernelContext)
      .then(
        () => null,
        (e: unknown) => e,
      );
    // A plain throw is wrapped, so transports can tell a domain rule from a bug —
    // without the plugin (which may be customer-owned) knowing the class exists.
    expect(err).toBeInstanceOf(HookVetoError);
    expect((err as HookVetoError).hook).toBe("crm.deal.beforeDelete");
    expect((err as HookVetoError).pluginId).toBe("compliance");
    expect((err as HookVetoError).cause).toBe(cause);
    expect(String(err)).toMatch(/not allowed/);
  });

  it("passes a HookVetoError thrown by a handler through untouched", async () => {
    const veto = new HookVetoError("crm.deal.beforeDelete", "compliance", "locked");
    const p = plugin({
      id: "compliance",
      schema: "compliance",
      capabilities: { hooks: ["crm.deal.beforeDelete"] },
      registerHooks: (hooks) => {
        hooks.register("crm.deal.beforeDelete", () => {
          throw veto;
        });
      },
    });
    const booted = await new EmbodyKernel(silent()).register(p).boot();
    await expect(
      booted.hooks.run("crm.deal.beforeDelete", {}, {} as KernelContext),
    ).rejects.toBe(veto);
  });

  it("blocks registering an undeclared hook (capability enforcement)", async () => {
    const p = plugin({
      id: "sneaky",
      schema: "sneaky",
      capabilities: {}, // no hooks declared
      registerHooks: (hooks) => {
        hooks.register("crm.deal.beforeCreate", () => {});
      },
    });
    await expect(
      new EmbodyKernel(silent()).register(p).boot(),
    ).rejects.toThrow(/undeclared hook/);
  });
});

describe("events", () => {
  it("delivers published events to matching subscribers", async () => {
    const received: string[] = [];
    const listener = plugin({
      id: "audit",
      schema: "audit",
      capabilities: { events: { subscribe: ["crm.*"] } },
      subscribe: (bus) => {
        bus.subscribe<{ id: string }>("crm.*", (e: DomainEvent<{ id: string }>) => {
          received.push(`${e.name}:${e.payload.id}`);
        });
      },
    });
    const booted = await new EmbodyKernel(silent()).register(listener).boot();
    await booted.events.publish({
      name: "crm.deal.created",
      orgId: "org1",
      payload: { id: "d1" },
    });
    await booted.events.publish({
      name: "other.thing.happened",
      orgId: "org1",
      payload: { id: "x" },
    });
    expect(received).toEqual(["crm.deal.created:d1"]);
  });
});

describe("full lifecycle", () => {
  it("boots a no-op plugin and reports it ready", async () => {
    const noop = plugin({ id: "noop", schema: "noop" });
    const booted = await new EmbodyKernel(silent()).register(noop).boot();
    expect(booted.plugins.map((p) => p.id)).toEqual(["noop"]);
    expect(booted.app).toBeDefined();
  });
});
