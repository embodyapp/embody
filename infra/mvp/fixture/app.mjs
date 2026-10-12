// Invented-data application exercising real hosted auth, kernel and Postgres storage.
import { definePlugin, z } from "../../../packages/core/dist/index.js";
import { defineApp } from "../../../packages/host/dist/index.js";
export function fixtureApp(appId) {
  if (!["kanban", "email"].includes(appId)) throw new Error("Unknown fixture app");
  const plugin = definePlugin({ id: appId, version: "1.0.0", entities: {} }, (define) => ({
    actions: {
      ping: define.action({
        input: z.object({}),
        effect: "read",
        handler: (_input, context) => ({
          ok: true,
          appId,
          orgId: context.principal.orgId,
          actorType: context.principal.actorType,
          ...(context.principal.delegation ? { delegation: context.principal.delegation } : {}),
        }),
      }),
    },
  }));
  return defineApp({ appId, version: "1.0.0", plugins: [plugin] });
}
