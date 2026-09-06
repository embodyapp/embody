import type { TestHarness } from "@embody/testing";
import type { KanbanCard } from "./plugin.js";

/** Development/test-only deterministic seed; production startup never calls this helper. */
export async function seedCards(
  harness: TestHarness,
  cards: readonly Partial<KanbanCard>[] = [],
): Promise<readonly unknown[]> {
  return Promise.all(
    cards.map((card, index) =>
      harness.call("kanban.card.create", {
        data: { title: `Seed card ${index + 1}`, ...card },
      }),
    ),
  );
}
