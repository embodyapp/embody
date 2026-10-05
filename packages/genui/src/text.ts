import stringWidth from "string-width";
import {
  GenUiDocumentError,
  parseGenUiDocument,
  type GenUiNode,
  type GenUiDocumentLimits,
} from "./document.js";

export interface GenUiTextOptions {
  readonly width?: number;
  readonly limits?: Partial<GenUiDocumentLimits>;
}

function safeText(value: string, markdown: boolean): string {
  const escape = "\u001b";
  const plain = value
    .replace(new RegExp(`${escape}\\[[0-?]*[ -/]*[@-~]`, "g"), "")
    .replace(new RegExp(`${escape}\\][^\\u0007${escape}]*(?:\\u0007|${escape}\\\\)`, "g"), "")
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, "    ")
    .replace(/[\u202a-\u202e\u2066-\u2069]/gu, "");
  const clean = Array.from(plain)
    .filter((character) => {
      const code = character.codePointAt(0)!;
      return code === 10 || (code >= 32 && code !== 127 && (code < 128 || code > 159));
    })
    .join("");
  if (!markdown) return clean;
  return clean
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/[\\`*_[\]{}()#+.!|~]/g, "\\$&")
    .replace(/(^|\n)( *)(-)/g, "$1$2\\$3");
}

function renderNode(node: GenUiNode, markdown: boolean, inheritedDisabled = false): string {
  const disabled =
    inheritedDisabled ||
    ("disabled" in node && !!node.disabled) ||
    ("pending" in node && !!node.pending);
  switch (node.type) {
    case "text":
      return node.sensitive ? "[redacted]" : safeText(node.text, markdown);
    case "stack":
    case "columns":
      return node.children.map((child) => renderNode(child, markdown, disabled)).join("\n\n");
    case "callout":
      return `${node.tone[0]!.toUpperCase()}${node.tone.slice(1)}: ${safeText(node.text, markdown)}`;
    case "badge":
      return `[${safeText(node.text, markdown)}]`;
    case "emptyState":
      return safeText(node.text, markdown);
    case "errorState":
      return `Error: ${safeText(node.text, markdown)}`;
    case "form": {
      const children = node.children
        .map((child) => renderNode(child, markdown, disabled))
        .join("\n\n");
      return `${safeText(node.label, markdown)}\n\n${children ? `${children}\n\n` : ""}Submit: ${safeText(node.effect, markdown)} (target: ${safeText(node.event.target, markdown)})${node.pending ? " (pending)" : disabled ? " (disabled)" : ""}`;
    }
    case "actions":
      return node.actions
        .map(
          (action, index) =>
            `${index + 1}. ${safeText(action.label, markdown)} — ${safeText(action.effect, markdown)} (target: ${safeText(action.event.target, markdown)})${action.pending || node.pending ? " (pending)" : action.disabled || disabled ? " (disabled)" : ""}`,
        )
        .join("\n");
    case "field":
      return `${safeText(node.label, markdown)}: ${node.sensitive ? "[redacted]" : safeText(node.value, markdown)}${disabled ? " (disabled)" : ""}`;
    case "select":
      return `${safeText(node.label, markdown)}: ${node.sensitive ? "[redacted]" : safeText(node.value, markdown)}${disabled ? " (disabled)" : ""}${node.sensitive ? "" : `\n${node.options.map((option, index) => `${index + 1}. ${safeText(option.label, markdown)}`).join("\n")}`}`;
    case "keyValue":
      return `${safeText(node.label, markdown)}: ${node.sensitive ? "[redacted]" : safeText(node.value, markdown)}`;
    case "section":
      return `${markdown ? "## " : ""}${safeText(node.title, markdown)}\n\n${node.children.map((child) => renderNode(child, markdown, disabled)).join("\n\n")}`;
    case "list":
      return node.items
        .map((item) => `- ${renderNode(item, markdown, disabled).replace(/\n/g, "\n  ")}`)
        .join("\n");
  }
}

/** Pure fallback rendering; does not print or change the action's JSON result. */
export function renderGenUiMarkdown(
  value: unknown,
  options: Pick<GenUiTextOptions, "limits"> = {},
): string {
  return `${renderNode(parseGenUiDocument(value, options.limits).root, true)}\n`;
}

export function renderGenUiText(value: unknown, options: GenUiTextOptions = {}): string {
  const width = options.width ?? 80;
  if (!Number.isSafeInteger(width) || width < 2 || width > 1_000)
    throw new GenUiDocumentError("GenUI text width must be between 2 and 1000 columns");
  const text = renderNode(parseGenUiDocument(value, options.limits).root, false);
  const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
  const lines: string[] = [];
  for (const line of text.split("\n")) {
    let current = "";
    let columns = 0;
    for (const { segment } of segmenter.segment(line)) {
      const size = stringWidth(segment);
      if (columns + size > width) {
        lines.push(current);
        current = "";
        columns = 0;
      }
      current += segment;
      columns += size;
    }
    lines.push(current);
  }
  return `${lines.join("\n")}\n`;
}
