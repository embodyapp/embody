import { expect, it } from "vitest";
import { parseGenUiDocument, renderGenUiText, parseGenUiEvent } from "../src/index.js";

const changeEvent = {
  intent: "change",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["value"],
    properties: {
      value: { type: "string", maxLength: 100 },
    },
  },
};
const document = {
  version: 1,
  root: {
    version: 1,
    type: "stack",
    children: [
      {
        version: 1,
        type: "field",
        id: "pr-url",
        label: "PR URL",
        value: "private draft",
        sensitive: true,
        event: changeEvent,
      },
      {
        version: 1,
        type: "select",
        id: "status",
        label: "Status",
        value: "done",
        options: [
          { value: "todo", label: "Todo" },
          { value: "done", label: "Done" },
        ],
        event: changeEvent,
      },
    ],
  },
};

it("describes ordinary action effects and requires an explicit callable-target allowlist", () => {
  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["id", "data"],
    properties: {
      id: { type: "string", maxLength: 63 },
      data: {
        type: "object",
        additionalProperties: false,
        required: ["status"],
        properties: { status: { type: "string", maxLength: 16, enum: ["done"] } },
      },
    },
  };
  const form = {
    version: 1,
    root: {
      version: 1,
      type: "form",
      id: "complete-form",
      label: "Complete task",
      effect: "Mark the task done",
      children: [],
      event: { intent: "submit", target: "kanban.card.update", schema },
    },
  };
  expect(renderGenUiText(form)).toBe(
    "Complete task\n\nSubmit: Mark the task done (target: kanban.card.update)\n",
  );
  const payload = { id: "task-1", data: { status: "done" } };
  expect(() => parseGenUiEvent(form, "complete-form", payload)).toThrow(/allowlisted/);
  expect(
    parseGenUiEvent(form, "complete-form", payload, { callableTargets: ["kanban.card.update"] }),
  ).toEqual(payload);
  const actions = {
    version: 1,
    root: {
      version: 1,
      type: "actions",
      actions: [
        {
          id: "refresh",
          label: "Refresh",
          effect: "Read authoritative data",
          event: {
            intent: "invoke",
            target: "kanban.board",
            schema: { type: "object", additionalProperties: false, properties: {}, required: [] },
          },
        },
      ],
    },
  };
  expect(renderGenUiText(actions)).toBe(
    "1. Refresh — Read authoritative data (target: kanban.board)\n",
  );
});

it("blocks child events inside a pending form as well as its submit event", () => {
  const form = {
    version: 1,
    root: {
      version: 1,
      type: "form",
      id: "form",
      label: "Edit task",
      effect: "Update task",
      pending: true,
      children: [document.root.children[0]],
      event: {
        intent: "submit",
        target: "kanban.card.update",
        schema: { type: "object", additionalProperties: false, properties: {}, required: [] },
      },
    },
  };
  expect(() => parseGenUiEvent(form, "pr-url", { value: "new draft" })).toThrow(/unavailable/);
  expect(() =>
    parseGenUiEvent(form, "form", {}, { callableTargets: ["kanban.card.update"] }),
  ).toThrow(/unavailable/);
  expect(renderGenUiText(form)).toContain("PR URL: [redacted] (disabled)");
});

it.each([
  { intent: "change", schema: { type: "string", maxLength: 100 } },
  {
    intent: "change",
    schema: {
      type: "object",
      additionalProperties: false,
      properties: { value: { type: "string", maxLength: 100, pattern: "(a+)+" } },
      required: ["value"],
    },
  },
  { intent: "change", schema: { $ref: "https://example.com/schema" } },
])("rejects invalid or unbounded change event declarations", (event) => {
  expect(() =>
    parseGenUiDocument({ version: 1, root: { ...document.root.children[0], event } }),
  ).toThrow(/schema/);
});

it("rejects duplicate interactive IDs across a document", () => {
  const field = document.root.children[0];
  expect(() =>
    parseGenUiDocument({
      version: 1,
      root: { version: 1, type: "stack", children: [field, field] },
    }),
  ).toThrow(/duplicate node IDs/);
});

it("does not disclose option labels from a select marked sensitive", () => {
  const select = {
    ...document.root.children[1],
    sensitive: true,
    value: "secret",
    options: [{ value: "secret", label: "private account" }],
  };
  expect(renderGenUiText({ version: 1, root: select })).toBe("Status: [redacted]\n");
});

it("renders labeled controls with redacted values and validates local change payloads", () => {
  const parsed = parseGenUiDocument(document);
  expect(renderGenUiText(parsed)).toBe("PR URL: [redacted]\n\nStatus: done\n1. Todo\n2. Done\n");
  expect(parseGenUiEvent(parsed, "status", { value: "todo" })).toEqual({ value: "todo" });
  expect(() => parseGenUiEvent(parsed, "status", { value: "undeclared" })).toThrow(/event/);
  expect(() => parseGenUiEvent(parsed, "pr-url", { value: "x", extra: "private" })).toThrow(
    /event/,
  );
});
