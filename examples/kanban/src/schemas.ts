import { z } from "zod";
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
export const KanbanBoardCardSchema = z.object({ id: z.uuid(), data: KanbanCardSchema });
export const KanbanBoardSchema = z.object({
  title: z.string(),
  cards: z.array(KanbanBoardCardSchema).max(20),
  nextOffset: z.number().int().min(0).nullable(),
});
export type KanbanBoard = z.output<typeof KanbanBoardSchema>;
export type CardStatus = z.output<typeof CardStatusSchema>;
export type CardPriority = z.output<typeof CardPrioritySchema>;
export type KanbanCard = z.output<typeof KanbanCardSchema>;
