import { GenUiDocumentError, parseGenUiDocument, type GenUiDocument } from "@embody/genui/document";
import { KanbanBoardCardSchema, KanbanBoardSchema, CardStatusSchema } from "./schemas.js";

const statusLabels = {
  todo: "Todo",
  in_progress: "In progress",
  in_review: "In review",
  done: "Done",
} as const;

/** App-owned document builder. It never changes the action output or embeds data in static HTML. */
export function createKanbanBoardDocument(props: unknown): GenUiDocument {
  const result = KanbanBoardSchema.safeParse(props);
  if (!result.success) throw new GenUiDocumentError("Kanban board props are invalid");
  const board = result.data;
  const children: unknown[] = [
    {
      version: 1,
      type: "columns",
      children: CardStatusSchema.options.map((status) => {
        const cards = board.cards.filter((card) => card.data.status === status);
        return {
          version: 1,
          type: "section",
          title: statusLabels[status],
          children: [
            cards.length === 0
              ? { version: 1, type: "emptyState", text: "No tasks on this page" }
              : {
                  version: 1,
                  type: "list",
                  items: cards.map((card) => ({
                    version: 1,
                    type: "stack",
                    children: [
                      { version: 1, type: "text", text: card.data.title },
                      { version: 1, type: "keyValue", label: "ID", value: card.id },
                      { version: 1, type: "badge", text: card.data.priority },
                      {
                        version: 1,
                        type: "actions",
                        actions: [
                          {
                            id: `open-${card.id}`,
                            label: "Open task",
                            effect: "Read task details",
                            event: {
                              intent: "invoke",
                              target: "kanban.card.get",
                              schema: {
                                type: "object",
                                additionalProperties: false,
                                required: ["id"],
                                properties: {
                                  id: { type: "string", maxLength: 36, enum: [card.id] },
                                },
                              },
                            },
                          },
                        ],
                      },
                    ],
                  })),
                },
          ],
        };
      }),
    },
  ];
  if (board.nextOffset !== null)
    children.push({
      version: 1,
      type: "callout",
      tone: "info",
      text: `More tasks are available. Call kanban.board with offset ${board.nextOffset}. This is one page, not the entire board.`,
    });
  return parseGenUiDocument({
    version: 1,
    root: { version: 1, type: "section", title: board.title, children },
  });
}

/** Local details/form composition; the ordinary action still enforces URL validation and the PR hook. */
export function createKanbanTaskDocument(props: unknown): GenUiDocument {
  const result = KanbanBoardCardSchema.safeParse(props);
  if (!result.success) throw new GenUiDocumentError("Kanban task props are invalid");
  const card = result.data;
  const change = {
    intent: "change",
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["value"],
      properties: { value: { type: "string", maxLength: 8_192 } },
    },
  };
  return parseGenUiDocument({
    version: 1,
    root: {
      version: 1,
      type: "section",
      title: card.data.title,
      children: [
        { version: 1, type: "keyValue", label: "ID", value: card.id },
        { version: 1, type: "keyValue", label: "Status", value: statusLabels[card.data.status] },
        {
          version: 1,
          type: "form",
          id: "complete-task",
          label: "Update task",
          effect: "Change the task through the initiating principal's ordinary action",
          children: [
            {
              version: 1,
              type: "select",
              id: "task-status",
              label: "Status",
              value: card.data.status,
              options: CardStatusSchema.options.map((value) => ({
                value,
                label: statusLabels[value],
              })),
              event: change,
            },
            {
              version: 1,
              type: "field",
              id: "task-pr",
              label: "PR URL",
              value: card.data.prUrl ?? "",
              sensitive: true,
              event: change,
            },
          ],
          event: {
            intent: "submit",
            target: "kanban.card.update",
            schema: {
              type: "object",
              additionalProperties: false,
              required: ["id", "data"],
              properties: {
                id: { type: "string", maxLength: 36, enum: [card.id] },
                data: {
                  type: "object",
                  additionalProperties: false,
                  required: ["status"],
                  properties: {
                    status: { type: "string", maxLength: 16, enum: CardStatusSchema.options },
                    prUrl: { type: "string", maxLength: 8_192 },
                  },
                },
              },
            },
          },
        },
      ],
    },
  });
}
