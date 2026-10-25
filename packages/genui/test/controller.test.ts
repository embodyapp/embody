import { describe, expect, it } from "vitest";
import { createGenUiController } from "../src/controller.js";
const change = {
  intent: "change",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["value"],
    properties: { value: { type: "string", maxLength: 50 } },
  },
};
const document = {
  version: 1,
  root: {
    version: 1,
    type: "form",
    id: "save",
    label: "Save",
    effect: "Update",
    children: [
      { version: 1, type: "field", id: "name", label: "Name", value: "Original", event: change },
    ],
    event: {
      intent: "submit",
      target: "cards.update",
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["name"],
        properties: { name: { type: "string", maxLength: 50 } },
      },
    },
  },
};
describe("authenticated presentation controller", () => {
  it.each(["before", "during"])(
    "does not confirm or refresh a mutation cancelled %s dispatch",
    async (when) => {
      const abort = new AbortController();
      const calls: string[] = [];
      const controller = createGenUiController({
        document,
        callableTargets: ["cards.update", "cards.get"],
        readTargets: ["cards.get"],
        refresh: { target: "cards.get", input: {} },
        resolveAction: (_id, values) => ({ name: values["name"] }),
        present: () => document,
        dispatch: (target) => {
          calls.push(target);
          abort.abort();
          return Promise.resolve({});
        },
      });
      if (when === "before") abort.abort();
      try {
        expect(await controller.invoke("save", { name: "Changed" }, abort.signal)).toMatchObject({
          status: "uncertain",
          reconciled: false,
        });
        expect(calls).toEqual(when === "before" ? [] : ["cards.update"]);
        await expect(controller.invoke("save", { name: "Changed" })).rejects.toThrow(
          /read current state/i,
        );
      } finally {
        controller.dispose();
      }
    },
  );
  it("blocks a mutation after a failed refresh until a successful authoritative read", async () => {
    let offline = true;
    const controller = createGenUiController({
      document,
      callableTargets: ["cards.update", "cards.get"],
      readTargets: ["cards.get"],
      refresh: { target: "cards.get", input: {} },
      resolveAction: () => ({ name: "Changed" }),
      present: () => document,
      dispatch: (target) =>
        target === "cards.get" && offline
          ? Promise.reject(new Error("Offline"))
          : Promise.resolve({}),
    });
    try {
      await expect(controller.refresh()).rejects.toThrow();
      await expect(controller.invoke("save", { name: "Changed" })).rejects.toThrow(
        /read current state/i,
      );
      offline = false;
      await controller.refresh();
      expect((await controller.invoke("save", { name: "Changed" })).status).toBe("confirmed");
    } finally {
      controller.dispose();
    }
  });
  it("requires an authoritative read before retrying an uncertain mutation", async () => {
    let calls = 0;
    const controller = createGenUiController({
      document,
      callableTargets: ["cards.update", "cards.get"],
      readTargets: ["cards.get"],
      refresh: { target: "cards.get", input: {} },
      resolveAction: (_id, values) => ({ name: values["name"] }),
      present: () => document,
      dispatch: (target) => {
        calls++;
        return target === "cards.update"
          ? Promise.reject(new Error("Disconnected"))
          : Promise.resolve({});
      },
    });
    expect((await controller.invoke("save", { name: "Changed" })).status).toBe("uncertain");
    await expect(controller.invoke("save", { name: "Changed" })).rejects.toThrow(
      /read current state/i,
    );
    expect(calls).toBe(1);
    await controller.refresh();
    expect((await controller.invoke("save", { name: "Changed" })).status).toBe("uncertain");
    expect(calls).toBe(3);
    controller.dispose();
  });
  it("validates submissions, preserves vetoes and confirms a commit despite failed refresh", async () => {
    const calls: string[] = [];
    let veto = true;
    const controller = createGenUiController({
      document,
      callableTargets: ["cards.update", "cards.get"],
      readTargets: ["cards.get"],
      refresh: { target: "cards.get", input: {} },
      resolveAction: (_id, values) => ({ name: values["name"] }),
      present: () => document,
      dispatch: (target) => {
        calls.push(target);
        if (target === "cards.get") return Promise.reject(new Error("private transport cause"));
        if (veto)
          return Promise.reject(
            Object.assign(new Error("private policy cause"), { code: "HOOK_VETO" }),
          );
        return Promise.resolve({});
      },
    });
    expect((await controller.invoke("save", { name: "Changed" })).status).toBe("rejected");
    veto = false;
    const committed = await controller.invoke("save", { name: "Changed" });
    expect(committed).toMatchObject({
      status: "confirmed",
      reconciled: false,
      target: "cards.update",
    });
    expect(JSON.stringify(committed)).not.toContain("private");
    expect(calls).toEqual(["cards.update", "cards.update", "cards.get"]);
    await expect(controller.invoke("foreign", {})).rejects.toThrow();
    expect(calls).toHaveLength(3);
    await expect(controller.submit("save", { foreign: "not a declared name" })).rejects.toThrow();
    expect(calls).toHaveLength(3);
    controller.dispose();
    await expect(controller.invoke("save", {})).rejects.toThrow(/unavailable/);
  });
});
