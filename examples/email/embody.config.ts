import { defineApp } from "@embody/host";
import { emailPlugin } from "./src/plugin.ts";

export default defineApp({
  appId: "email",
  version: "1.0.0",
  plugins: [emailPlugin],
  port: 8082,
  sqlitePath: ".embody/email.sqlite",
});
