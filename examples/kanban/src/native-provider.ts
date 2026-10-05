import type { PiGenUiProvider } from "@embody/genui-pi";
import type { GenUiDocument, GenUiNode } from "@embody/genui/document";
import type { GenUiPayloadBinding } from "@embody/genui/payload";
import { createKanbanBoardDocument, createKanbanTaskDocument } from "./presentation.js";
export function kanbanPayloadBindings(
  document: GenUiDocument,
): Readonly<Record<string, GenUiPayloadBinding>> {
  const bindings: Record<string, GenUiPayloadBinding> = {};
  function walk(node: GenUiNode) {
    if (node.type === "actions")
      for (const action of node.actions) {
        const schema = action.event.schema;
        if (schema.type === "object") {
          const fields: Record<string, GenUiPayloadBinding> = {};
          for (const key of schema.required) {
            const child = schema.properties[key];
            if (child?.type !== "string" || child.enum?.length !== 1)
              throw new Error("Unsupported Kanban binding");
            fields[key] = { kind: "literal", value: child.enum[0]! };
          }
          bindings[action.id] = { kind: "object", fields };
        }
      }
    if (
      node.type === "form" &&
      node.id === "complete-task" &&
      node.event.schema.type === "object"
    ) {
      const id = node.event.schema.properties["id"];
      if (id?.type !== "string" || id.enum?.length !== 1)
        throw new Error("Unsupported Kanban binding");
      bindings[node.id] = {
        kind: "object",
        fields: {
          id: { kind: "literal", value: id.enum[0]! },
          data: {
            kind: "object",
            fields: {
              status: { kind: "field", id: "task-status" },
              prUrl: { kind: "field", id: "task-pr", omitEmpty: true },
            },
          },
        },
      };
    }
    if ("children" in node) for (const child of node.children) walk(child);
    if (node.type === "list") for (const item of node.items) walk(item);
  }
  walk(document.root);
  return bindings;
}
export const kanbanProvider: PiGenUiProvider = {
  appId: "kanban",
  target: "kanban.board",
  viewId: "board",
  readTargets: ["kanban.board", "kanban.card.get"],
  present: (target, props) =>
    target === "kanban.board"
      ? createKanbanBoardDocument(props)
      : target === "kanban.card.get"
        ? createKanbanTaskDocument(props)
        : (() => {
            throw new Error("Unsupported Kanban presentation target");
          })(),
  bindings: kanbanPayloadBindings,
};
export const providers = [kanbanProvider];
