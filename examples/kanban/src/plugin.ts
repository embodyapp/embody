import { definePlugin, HookVetoError, z } from "@embody/core";

import { CardStatusSchema, KanbanCardSchema, KanbanBoardSchema } from "./schemas.js";
export {
  CardStatusSchema,
  CardPrioritySchema,
  KanbanCardSchema,
  KanbanBoardCardSchema,
  KanbanBoardSchema,
  type KanbanBoard,
  type CardStatus,
  type CardPriority,
  type KanbanCard,
} from "./schemas.js";

const bulkMoveInput = z.object({
  cardIds: z
    .array(z.uuid())
    .min(1)
    .refine((cardIds) => new Set(cardIds).size === cardIds.length, {
      message: "cardIds must not contain duplicates",
    }),
  newStatus: CardStatusSchema,
});

export const kanbanPlugin = definePlugin(
  {
    id: "kanban",
    version: "1.0.0",
    entities: {
      card: {
        description: "Tasks and work items managed on the kanban board",
        schema: KanbanCardSchema,
        indexes: ["status", "priority", "assigneeId"],
      },
    },
  },
  (define) => ({
    actions: {
      board: define.action({
        description: "Read a bounded page of the authoritative Kanban board",
        input: z.object({ offset: z.number().int().min(0).max(1_000_000).default(0) }),
        output: KanbanBoardSchema,
        handler: async ({ offset }, context) => {
          const records = await context.entities.card.list({ limit: 21, offset });
          return {
            title: "Kanban board",
            cards: records.slice(0, 20).map(({ id, data }) => ({ id, data })),
            nextOffset: records.length > 20 ? offset + 20 : null,
          };
        },
      }),
      bulkMove: define.action({
        description: "Move multiple cards to a new status atomically",
        input: bulkMoveInput,
        handler: async ({ cardIds, newStatus }, context) => {
          const cards = await context.entities.card.updateMany(
            cardIds.map((id) => ({ id, data: { status: newStatus } })),
          );
          return { count: cards.length, cards };
        },
      }),
    },
    hooks: [
      define.beforeUpdate("card", ({ current, patch }, context) => {
        if (
          context.principal.actorType === "agent" &&
          patch.status === "done" &&
          !current.data.prUrl &&
          !patch.prUrl
        )
          throw new HookVetoError("Agents cannot complete cards without a linked PR URL");
      }),
      define.afterUpdate("card", async ({ current, updated }, context) => {
        if (current.data.status !== "in_review" && updated.data.status === "in_review")
          await context.events.publish("kanban.card.ready_for_review", {
            cardId: updated.id,
            title: updated.data.title,
            ...(updated.data.assigneeId === undefined
              ? {}
              : { assigneeId: updated.data.assigneeId }),
          });
      }),
    ],
  }),
);
