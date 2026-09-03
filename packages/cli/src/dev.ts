import { watch, type FSWatcher } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Kernel, type EmbodyPlugin, type Principal } from "@embody/core";
import { localDevVerifier } from "@embody/auth";
import { createHost, type EmbodyHost } from "@embody/host";
import { SqliteStorage } from "@embody/storage";

export interface EmbodyDevConfig {
  readonly appId: string;
  readonly version?: string;
  readonly plugins: readonly EmbodyPlugin[];
  readonly port?: number;
  readonly principal?: Principal;
  readonly sqlitePath?: string;
}
export interface DevServer {
  readonly host: EmbodyHost;
  readonly url: string;
  readonly targets: readonly string[];
  close(): Promise<void>;
}
/** Loads a config module through Node's development TypeScript loader (Node 22.6+/24). */
export async function loadDevConfig(path = "embody.config.ts"): Promise<EmbodyDevConfig> {
  const module = (await import(`${pathToFileURL(resolve(path)).href}?t=${Date.now()}`)) as {
    default?: EmbodyDevConfig;
  };
  if (!module.default) throw new Error("embody.config.ts must default-export an EmbodyDevConfig");
  return module.default;
}

/** Starts a loopback-only local host and development inspector. */
export async function startDevServer(config: EmbodyDevConfig): Promise<DevServer> {
  const principal = config.principal ?? {
    orgId: "local",
    actorId: "local-developer",
    actorType: "human" as const,
    roles: ["developer"],
    scopes: config.plugins.map((plugin) => `${plugin.id}:*`),
  };
  const filename = resolve(config.sqlitePath ?? ".embody/dev.sqlite");
  await mkdir(dirname(filename), { recursive: true });
  const storage = new SqliteStorage({ filename });
  const kernel = new Kernel({ plugins: config.plugins, storage });
  await kernel.boot();
  const host = createHost({
    kernel,
    verifier: localDevVerifier({ enabled: true, environment: "development", principal }),
    appId: config.appId,
    version: config.version ?? "0.0.0",
    environment: "development",
  });
  host.app.get("/__inspector", () => ({
    endpoints: ["/__inspector/manifest", "/__inspector/execute", "/__inspector/outbox"],
  }));
  host.app.get("/__inspector/manifest", () => kernel.manifest);
  host.app.get("/__inspector/outbox", async () => {
    const rows = await storage.transaction("system", (tx) => tx.outbox.list());
    return rows.map(({ id, eventName, status, attempts, lastError, scheduledAt }) => ({
      id,
      eventName,
      status,
      attempts,
      scheduledAt,
      ...(lastError === undefined ? {} : { lastError }),
    }));
  });
  host.app.post("/__inspector/execute", async (request) => {
    const body = request.body as { target?: unknown; input?: unknown };
    if (typeof body?.target !== "string") throw new Error("target is required");
    return kernel.execute(body.target, body.input, { principal });
  });
  await host.start();
  const address = await host.app.listen({ port: config.port ?? 8080, host: "127.0.0.1" });
  return { host, url: address, targets: kernel.actionTargets, close: () => host.stop() };
}

/** Restarts the local host after a config edit; a failed reload leaves a visible error and watches on. */
export function watchDevServer(
  path: string | undefined,
  onServer: (server: DevServer) => void,
  onError: (error: unknown) => void,
): { close(): Promise<void> } {
  const configPath = resolve(path ?? "embody.config.ts");
  let server: DevServer | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let reloading = Promise.resolve();
  const reload = (): void => {
    reloading = reloading.then(async () => {
      try {
        const config = await loadDevConfig(configPath);
        await server?.close();
        server = await startDevServer(config);
        onServer(server);
      } catch (error) {
        onError(error);
      }
    });
  };
  const watcher: FSWatcher = watch(configPath, () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(reload, 75);
  });
  reload();
  return {
    async close() {
      watcher.close();
      if (timer !== undefined) clearTimeout(timer);
      await reloading;
      await server?.close();
    },
  };
}
