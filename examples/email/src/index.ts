import { createAppHost } from "@embody/host";
import app from "../embody.config.js";
import { createEmailPlugin, JsonFileMailer } from "./plugin.js";

export async function startEmail(env: NodeJS.ProcessEnv = process.env) {
  const recordFile = env["MAILER_RECORD_FILE"];
  const definition = recordFile
    ? {
        ...app,
        plugins: [
          createEmailPlugin(
            new JsonFileMailer(recordFile, env["MAILER_CRASH_AFTER_FIRST_WRITE"] === "true"),
          ),
        ],
      }
    : app;
  const runtime = await createAppHost(definition, { env });
  await runtime.start();
  return runtime;
}

if (import.meta.url === new URL(process.argv[1]!, "file:").href) {
  const runtime = await startEmail();
  console.log(`Email listening at ${runtime.url}`);
  const close = () => void runtime.stop();
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}
