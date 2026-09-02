import { describe, expect, it, vi } from "vitest";
import { ForbiddenError, Kernel, UnavailableError, z, type KernelContext } from "../src/index.js";

const principal = (scopes: readonly string[] = ["kanban:*"]) => ({
  orgId: "trusted-org",
  actorId: "actor",
  actorType: "human" as const,
  roles: [],
  scopes,
});

function kernel(
  handler: (input: { value: string }, context: KernelContext) => unknown = vi.fn(() => ({
    ok: true,
  })),
) {
  const instance = new Kernel({
    storage: {
      ensureSchema: () => Promise.resolve(),
      close: () => Promise.resolve(),
      transaction: async <T>(_orgId: string, callback: (tx: never) => Promise<T>) =>
        callback({} as never),
    },
    plugins: [
      {
        id: "kanban",
        version: "1.0.0",
        actions: {
          "card.create": {
            input: z.object({ value: z.string() }),
            output: z.object({ ok: z.boolean() }),
            handler,
          },
        },
      },
    ],
  });
  return { instance, handler };
}

describe("kernel execution", () => {
  it("authorizes segment-aware exact and wildcard scopes", async () => {
    const { instance, handler } = kernel();
    await instance.boot();
    await expect(
      instance.execute("kanban.card.create", { value: "x" }, { principal: principal() }),
    ).resolves.toEqual({ ok: true });
    await expect(
      instance.execute(
        "kanban.card.create",
        { value: "x" },
        { principal: principal(["kanbanx:*"]) },
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      instance.execute(
        "kanban.card.create",
        { value: "x" },
        { principal: principal(["kanban.card.create"]) },
      ),
    ).resolves.toEqual({ ok: true });
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("validates input before handler invocation and exposes request-scoped controls", async () => {
    const handler = vi.fn((_input: { value: string }, ctx: KernelContext) => {
      ctx.progress({ message: ctx.orgId });
      return { ok: true };
    });
    const { instance } = kernel(handler);
    await instance.boot();
    await expect(
      instance.execute("kanban.card.create", {}, { principal: principal() }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    const progress = vi.fn();
    await instance.execute(
      "kanban.card.create",
      { value: "x", orgId: "attacker" },
      { principal: principal(), requestId: "request-1", progress },
    );
    expect(handler).toHaveBeenCalledOnce();
    expect(progress).toHaveBeenCalledWith({ message: "trusted-org" });
  });

  it("propagates cancellation and records a cancelled audit outcome", async () => {
    const { instance } = kernel();
    await instance.boot();
    const controller = new AbortController();
    controller.abort();
    const audit = vi.fn();
    await expect(
      instance.execute(
        "kanban.card.create",
        { value: "x" },
        { principal: principal(), signal: controller.signal, audit },
      ),
    ).rejects.toBeInstanceOf(UnavailableError);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ outcome: "cancelled" }));
  });
});
