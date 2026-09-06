import { definePlugin, HookVetoError, z } from "@embody/core";

export const CardStatusSchema = z.enum(["todo", "in_progress", "in_review", "done"]);
export const CardPrioritySchema = z.enum(["low", "medium", "high", "urgent"]);
export const KanbanCardSchema = z.object({
  title: z.string().min(1, "Title is required"),
  description: z.string().optional(),
  status: CardStatusSchema.default("todo"),
  priority: CardPrioritySchema.default("medium"),
  assigneeId: z.string().optional(),
  prUrl: z.string().url().optional(),
});

export type CardStatus = z.output<typeof CardStatusSchema>;
export type CardPriority = z.output<typeof CardPrioritySchema>;
export type KanbanCard = z.output<typeof KanbanCardSchema>;

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
