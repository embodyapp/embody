/* global document */
import { startGenUiApp } from "@embody/genui/app-runtime";
import { kanbanProvider } from "./native-provider.ts";
void startGenUiApp({
  container: document.querySelector("main"),
  status: document.querySelector("#connection"),
  readTarget: "kanban.board",
  readTargets: kanbanProvider.readTargets,
  tools: {
    "kanban.board": "kanban_board",
    "kanban.card.get": "kanban_card_get",
    "kanban.card.update": "kanban_card_update",
  },
  present: kanbanProvider.present,
  bindings: kanbanProvider.bindings,
});
