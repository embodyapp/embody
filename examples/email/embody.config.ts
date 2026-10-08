import { defineApp } from "@embody/host";
import { emailPlugin } from "./src/plugin.ts";

export default defineApp({
  appId: "email",
  version: "1.0.0",
  title: "Email",
  description: "Send email batches and follow their delivery progress.",
  instructions:
    "Batches over 500 recipients require the marketing_lead role; otherwise split them into batches of 500 or fewer.",
  plugins: [emailPlugin],
  port: 8082,
  sqlitePath: ".embody/email.sqlite",
});
