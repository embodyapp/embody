import { defineApp } from "@embody/host";
import { kanbanPlugin } from "./src/plugin.ts";

export default defineApp({
  appId: "kanban",
  version: "1.0.0",
  title: "Kanban",
  description: "Track cards through todo, in-progress, review and done columns.",
  instructions:
    "Use the card list action to find cards before updating them. Agents must attach a pull request URL (prUrl) before moving a card to done.",
  plugins: [kanbanPlugin],
  port: 8081,
  sqlitePath: ".embody/kanban.sqlite",
});
