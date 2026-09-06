import { defineApp } from "@embody/host";
import { kanbanPlugin } from "./src/plugin.ts";

export default defineApp({
  appId: "kanban",
  version: "1.0.0",
  plugins: [kanbanPlugin],
  port: 8081,
  sqlitePath: ".embody/kanban.sqlite",
});
