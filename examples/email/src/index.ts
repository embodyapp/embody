import { createAppHost } from "@embody/host";
import app from "../embody.config.js";

export async function startEmail(env: NodeJS.ProcessEnv = process.env) {
  const runtime = await createAppHost(app, { env });
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
