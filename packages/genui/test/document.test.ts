import { expect, it } from "vitest";
import { parseGenUiDocument, renderGenUiMarkdown, renderGenUiText } from "../src/index.js";

const board = {
  version: 1,
  root: {
    version: 1,
    type: "section",
    title: "Current sprint",
    children: [
      {
        version: 1,
        type: "list",
        items: [
          { version: 1, type: "text", text: "Add login — task-1" },
          { version: 1, type: "text", text: "Write integration tests — task-2" },
        ],
      },
    ],
  },
};

it("rejects excessive nesting with a safe structured error before recursive schema parsing", () => {
  let root: unknown = { version: 1, type: "text", text: "private text" };
  for (let index = 0; index < 3_000; index++)
    root = { version: 1, type: "section", title: "Nested", children: [root] };
  try {
    parseGenUiDocument({ version: 1, root });
    expect.fail("An excessive document must fail closed");
  } catch (error) {
    expect(error).toMatchObject({
      code: "GENUI_INVALID_DOCUMENT",
      message: "GenUI document exceeds depth limit",
    });
  }
});

it("returns a detached deeply immutable document", () => {
  const input = { version: 1, root: { version: 1, type: "text", text: "Original" } };
  const document = parseGenUiDocument(input);
  input.root.text = "Changed";
  expect(renderGenUiText(document)).toBe("Original\n");
  expect(Object.isFrozen(document)).toBe(true);
  expect(Object.isFrozen(document.root)).toBe(true);
});

it.each([
  { version: 2, root: board.root },
  { version: 1, root: { version: 2, type: "text", text: "secret" } },
  { version: 1, root: { version: 1, type: "html", text: "secret" } },
  { version: 1, root: { version: 1, type: "text", text: "secret", onclick: "secret script" } },
])("rejects unsupported or executable nodes without leaking their values", (input) => {
  expect(() => parseGenUiDocument(input)).toThrow("GenUI document schema is invalid");
});

it("keeps hostile Markdown and HTML inert and strips terminal escape sequences", () => {
  const document = {
    version: 1,
    root: {
      version: 1,
      type: "text",
      text: "<script>alert(1)</script> [go](javascript:evil)\u001b[31mred\u001b[0m",
    },
  };
  expect(renderGenUiMarkdown(document)).toBe(
    "&lt;script&gt;alert\\(1\\)&lt;/script&gt; \\[go\\]\\(javascript:evil\\)red\n",
  );
  expect(renderGenUiText(document)).toBe("<script>alert(1)</script> [go](javascript:evil)red\n");
});

it("preserves board groups, task metadata and safe state messages in text fallback", () => {
  const document = {
    version: 1,
    root: {
      version: 1,
      type: "stack",
      children: [
        { version: 1, type: "callout", tone: "warning", text: "Acting through the agent session" },
        {
          version: 1,
          type: "columns",
          children: [
            {
              version: 1,
              type: "section",
              title: "Todo",
              children: [
                { version: 1, type: "badge", text: "High priority" },
                { version: 1, type: "keyValue", label: "Title", value: "Add login" },
                {
                  version: 1,
                  type: "keyValue",
                  label: "PR",
                  value: "private URL",
                  sensitive: true,
                },
              ],
            },
            {
              version: 1,
              type: "section",
              title: "Done",
              children: [{ version: 1, type: "emptyState", text: "No completed tasks" }],
            },
          ],
        },
        { version: 1, type: "errorState", text: "Agents need a linked PR before completion" },
        { version: 1, type: "text", text: "private draft", sensitive: true },
      ],
    },
  };
  expect(renderGenUiText(document)).toBe(
    "Warning: Acting through the agent session\n\nTodo\n\n[High priority]\n\nTitle: Add login\n\nPR: [redacted]\n\nDone\n\nNo completed tasks\n\nError: Agents need a linked PR before completion\n\n[redacted]\n",
  );
  expect(renderGenUiMarkdown(document)).not.toMatch(/private URL|private draft/);
});

it("wraps plain text by terminal columns without splitting Unicode graphemes", () => {
  const document = {
    version: 1,
    root: { version: 1, type: "text", text: "123456界界🙂\ne\u0301e\u0301e\u0301" },
  };
  expect(renderGenUiText(document, { width: 8 })).toBe("123456界\n界🙂\ne\u0301e\u0301e\u0301\n");
  expect(() => renderGenUiText(document, { width: 1 })).toThrow(/width/);
});

it("renders a validated board summary deterministically as Markdown and plain text", () => {
  const document = parseGenUiDocument(board);
  expect(renderGenUiMarkdown(document)).toBe(
    "## Current sprint\n\n- Add login — task-1\n- Write integration tests — task-2\n",
  );
  expect(renderGenUiText(document)).toBe(
    "Current sprint\n\n- Add login — task-1\n- Write integration tests — task-2\n",
  );
});
