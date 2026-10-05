import { defineApp } from "@embody/host";
import { readFileSync } from "node:fs";
import { defineGenUi, defineView, withGenUi } from "@embody/genui";
import { kanbanPlugin, KanbanBoardSchema } from "./src/plugin.ts";

export default withGenUi(
  defineApp({
    appId: "kanban",
    version: "1.0.0",
    plugins: [kanbanPlugin],
    port: 8081,
    sqlitePath: ".embody/kanban.sqlite",
  }),
  defineGenUi({
    views: {
      board: defineView({
        kind: "standard",
        version: "1.0.0",
        props: KanbanBoardSchema,
        callableTargets: ["kanban.board", "kanban.card.get", "kanban.card.update"],
        fallback: "text",
        resource: {
          text: readFileSync(
            new URL(import.meta.resolve("@embody/example-kanban/apps-resource.html")),
            "utf8",
          ),
        },
      }),
    },
    actions: { "kanban.board": "board" },
  }),
);
