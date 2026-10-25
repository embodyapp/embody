import { createGenUiGatewayConnection } from "@embody/genui/client";
import { createGenUiBrowserHost } from "@embody/genui/browser";
import { createGenUiController } from "@embody/genui/controller";
import { resolveGenUiPayload } from "@embody/genui/payload";
import { kanbanProvider } from "../dist/src/native-provider.js";
const gatewayUrl = process.env.EMBODY_GATEWAY_URL;
const token = process.env.EMBODY_GATEWAY_TOKEN;
if (!gatewayUrl || !token) throw new Error("Configure EMBODY_GATEWAY_URL and EMBODY_GATEWAY_TOKEN");
const connection = await createGenUiGatewayConnection({
  gatewayUrl,
  appId: "kanban",
  authorization: `Bearer ${token}`,
});
let host;
try {
  const discovered = await connection.discover("kanban.board");
  const controller = createGenUiController({
    document: kanbanProvider.present(
      "kanban.board",
      await discovered.dispatch("kanban.board", {}, new globalThis.AbortController().signal),
    ),
    callableTargets: discovered.view.callableTargets,
    readTargets: kanbanProvider.readTargets,
    refresh: { target: "kanban.board", input: {} },
    dispatch: discovered.dispatch,
    present: kanbanProvider.present,
    resolveAction: (id, values) =>
      resolveGenUiPayload(kanbanProvider.bindings(controller.document)[id], values),
  });
  host = await createGenUiBrowserHost({ mode: "development" });
  const lease = host.open({
    appId: "kanban",
    viewId: "board",
    generation: discovered.generation,
    controller,
    bindings: kanbanProvider.bindings,
    publishOutcome: (outcome) => {
      console.warn(
        `Embody UI: ${outcome.target} ${outcome.status}. Ask the agent to read kanban.board before relying on current state.`,
      );
      return Promise.reject(
        new Error("No automatic agent context in this standalone authoring process"),
      );
    },
  });
  console.log(
    `Temporary loopback presentation (keep private, expires in 60 seconds): ${lease.url}`,
  );
  const close = async () => {
    lease.revoke();
    await host?.close();
    await connection.close();
  };
  process.once("SIGINT", () => {
    void close();
  });
  process.once("SIGTERM", () => {
    void close();
  });
} catch (error) {
  await host?.close();
  await connection.close();
  throw error;
}
