import { expect, it } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createGenUiController } from "@embody/genui/controller";
import { createPiGenUiComponent } from "../src/native.js";
const event = {
  intent: "change",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: { value: { type: "string", maxLength: 80 } },
    required: ["value"],
  },
};
const document = {
  version: 1,
  root: {
    version: 1,
    type: "form",
    id: "save",
    label: "Update task 👩‍💻",
    effect: "Change status",
    children: [
      { version: 1, type: "field", id: "pr", label: "PR", sensitive: true, value: "", event },
    ],
    event: {
      intent: "submit",
      target: "cards.update",
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["pr"],
        properties: { pr: { type: "string", maxLength: 80 } },
      },
    },
  },
};
it("edits a secret using Pi input, submits a canonical action, preserves vetoed draft and keeps narrow lines bounded", async () => {
  const inputs: unknown[] = [];
  const outcomes: unknown[] = [];
  let veto = true;
  const controller = createGenUiController({
    document,
    callableTargets: ["cards.update", "cards.get"],
    readTargets: ["cards.get"],
    refresh: { target: "cards.get", input: {} },
    resolveAction: (_id, values) => ({ pr: values["pr"] }),
    present: () => document,
    dispatch: (target, input) => {
      if (target === "cards.update") {
        inputs.push(input);
        if (veto)
          return Promise.reject(Object.assign(new Error("secret cause"), { code: "HOOK_VETO" }));
      }
      return Promise.resolve({});
    },
  });
  const component = createPiGenUiComponent({
    controller,
    requestRender: () => {},
    onClose: () => {},
    publishOutcome: (outcome) => {
      outcomes.push(outcome);
      return Promise.resolve();
    },
  });
  component.handleInput("https://private.example/pr/1");
  component.handleInput("\t");
  component.handleInput("\r");
  await component.settled();
  expect(component.render(30).join("\n")).toContain("rejected");
  expect(component.render(80).join("\n")).not.toContain("private.example");
  expect(inputs).toEqual([{ pr: "https://private.example/pr/1" }]);
  veto = false;
  component.handleInput("\r");
  await component.settled();
  expect(inputs).toHaveLength(2);
  expect(JSON.stringify(outcomes)).not.toContain("private.example");
  for (const width of [1, 2, 12, 40, 120]) {
    component.invalidate();
    expect(component.render(width).every((line) => visibleWidth(line) <= width)).toBe(true);
  }
  component.dispose();
  component.handleInput("\r");
  await component.settled();
  expect(inputs).toHaveLength(2);
});

it("visibly blocks mutation retry after an uncertain outcome until read and draft review", async () => {
  const controller = createGenUiController({
    document,
    callableTargets: ["cards.update", "cards.get"],
    readTargets: ["cards.get"],
    refresh: { target: "cards.get", input: {} },
    resolveAction: () => ({ pr: "draft" }),
    present: () => document,
    dispatch: (target) =>
      target === "cards.update" ? Promise.reject(new Error("Disconnected")) : Promise.resolve({}),
  });
  const component = createPiGenUiComponent({
    controller,
    requestRender: () => {},
    onClose: () => {},
    publishOutcome: () => Promise.resolve(),
  });
  try {
    component.handleInput("draft");
    component.handleInput("\t");
    component.handleInput("\r");
    await component.settled();
    expect(component.render(100).join("\n")).toContain("Update task 👩‍💻 [disabled]");
    component.handleInput("\u0012"); // Ctrl+R: authoritative reconciliation, preserving dirty draft.
    await component.settled();
    expect(component.render(100).join("\n")).toContain("Review current state");
    component.handleInput("\u0004"); // Ctrl+D: explicit discard/accept.
    expect(component.render(100).join("\n")).not.toContain("[disabled]");
  } finally {
    component.dispose();
  }
});

it("requires explicit draft-discard confirmation before closing a dirty native view", () => {
  let closed = false;
  const controller = createGenUiController({
    document,
    callableTargets: ["cards.update", "cards.get"],
    readTargets: ["cards.get"],
    refresh: { target: "cards.get", input: {} },
    resolveAction: () => ({}),
    present: () => document,
    dispatch: () => Promise.resolve({}),
  });
  const component = createPiGenUiComponent({
    controller,
    requestRender: () => {},
    onClose: () => {
      closed = true;
    },
    publishOutcome: () => Promise.resolve(),
  });
  try {
    component.handleInput("private draft");
    component.handleInput("\u001b");
    expect(closed).toBe(false);
    expect(component.render(100).join("\n")).toContain("Esc again");
    expect(component.render(100).join("\n")).not.toContain("private draft");
    component.handleInput("\u001b");
    expect(closed).toBe(true);
    expect(component.render(100)).toEqual([]);
  } finally {
    component.dispose();
  }
});
