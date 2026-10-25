import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { appManifestSchema, type ViewManifest } from "@embody/core";
import { z } from "zod";
import { GENUI_MIME_TYPE, genUiResourceIntegrity, parseGenUiResourceJson } from "./index.js";
export interface GenUiGatewayOptions {
  readonly gatewayUrl: string;
  readonly appId: string;
  readonly authorization: string;
}
export interface GenUiDiscoveredView {
  readonly generation: string;
  readonly view: ViewManifest;
  readonly dispatch: (target: string, input: unknown, signal: AbortSignal) => Promise<unknown>;
}
export interface GenUiGatewayConnection {
  discover(target: string): Promise<GenUiDiscoveredView>;
  close(): Promise<void>;
}
const rowSchema = z.object({
  appId: z.string(),
  generation: z.string().max(256),
  manifest: appManifestSchema,
});
const failure = (code = "FORBIDDEN") =>
  Object.assign(new Error("GenUI action unavailable"), { code });
/** Authenticated public gateway interfaces. No credentials, HTML or remote executable code reach native views. */
export async function createGenUiGatewayConnection(
  options: GenUiGatewayOptions,
): Promise<GenUiGatewayConnection> {
  const url = new URL(options.gatewayUrl);
  if (
    !/^[a-z][a-z0-9-]{0,62}$/.test(options.appId) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname))) ||
    !/^Bearer [^\r\n]{1,8192}$/.test(options.authorization)
  )
    throw failure();
  const authorization = options.authorization;
  const appId = options.appId;
  const lifetime = new AbortController();
  async function json(path: string, init: RequestInit = {}): Promise<unknown> {
    const response = await fetch(new URL(path, url), {
      ...init,
      redirect: "error",
      headers: {
        "Content-Type": "application/json",
        Authorization: authorization,
        ...init.headers,
      },
      signal: AbortSignal.any([
        lifetime.signal,
        AbortSignal.timeout(10_000),
        ...(init.signal ? [init.signal] : []),
      ]),
    });
    const reader = response.body?.getReader();
    if (!reader) throw failure("UNCERTAIN_OUTCOME");
    let bytes = 0;
    const parts: Uint8Array[] = [];
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > 8_388_608) {
          await reader.cancel();
          throw failure("UNCERTAIN_OUTCOME");
        }
        parts.push(part.value);
      }
    } finally {
      reader.releaseLock();
    }
    const buffer = new Uint8Array(bytes);
    let offset = 0;
    for (const part of parts) {
      buffer.set(part, offset);
      offset += part.byteLength;
    }
    const result: unknown = JSON.parse(new TextDecoder().decode(buffer));
    if (!response.ok) {
      const parsed = z.object({ error: z.object({ code: z.string() }) }).safeParse(result);
      const code =
        parsed.success &&
        ["HOOK_VETO", "VALIDATION_ERROR", "FORBIDDEN", "NOT_FOUND"].includes(parsed.data.error.code)
          ? parsed.data.error.code
          : "UNCERTAIN_OUTCOME";
      throw failure(code);
    }
    return result;
  }
  async function catalog() {
    const rows = z
      .array(rowSchema)
      .max(100)
      .parse(await json("/api/catalog"));
    const app = rows.find((row) => row.appId === appId);
    if (!app) throw failure();
    return app;
  }
  const client = new Client(
    { name: "Embody GenUI connection", version: "1.0.0" },
    {
      capabilities: {
        extensions: { "io.modelcontextprotocol/ui": { mimeTypes: [GENUI_MIME_TYPE] } },
      },
    },
  );
  const transport = new StreamableHTTPClientTransport(new URL(`/mcp/${appId}`, url), {
    requestInit: { headers: { Authorization: authorization } },
    fetch: (input, init) =>
      fetch(input, {
        ...init,
        redirect: "error",
        signal: AbortSignal.any([
          lifetime.signal,
          AbortSignal.timeout(10_000),
          ...(init?.signal ? [init.signal] : []),
        ]),
      }),
  });
  try {
    await client.connect(transport as unknown as Transport);
  } catch {
    lifetime.abort();
    await client.close();
    throw failure("UNCERTAIN_OUTCOME");
  }
  return {
    async discover(target) {
      const app = await catalog();
      const action = app.manifest.actions[target];
      const view = action?.presentation
        ? app.manifest.views?.[action.presentation.view]
        : undefined;
      if (!view || !view.resourceUri.startsWith(`ui://${appId}/`)) throw failure();
      const result = await client.readResource(
        { uri: view.resourceUri },
        { signal: lifetime.signal, timeout: 10_000 },
      );
      if (result.contents.length !== 1) throw failure();
      const content = result.contents[0]!;
      if (
        content.uri !== view.resourceUri ||
        !("text" in content) ||
        content.mimeType !== GENUI_MIME_TYPE
      )
        throw failure();
      const metadata: unknown = content._meta?.["ui"];
      const resource = parseGenUiResourceJson(
        JSON.stringify({
          text: content.text,
          mimeType: content.mimeType,
          ...(metadata === undefined ? {} : { metadata }),
        }),
      );
      if (genUiResourceIntegrity(resource) !== view.integrity) throw failure();
      const latest = await catalog();
      if (latest.generation !== app.generation) throw failure();
      const { description, ...definition } = view;
      const normalized: ViewManifest = {
        ...definition,
        ...(description === undefined ? {} : { description }),
      };
      return Object.freeze({
        generation: app.generation,
        view: structuredClone(normalized),
        dispatch: async (requested: string, input: unknown, signal: AbortSignal) => {
          if (lifetime.signal.aborted || !view.callableTargets.includes(requested)) throw failure();
          const current = await catalog();
          const currentView = current.manifest.views?.[view.id];
          if (
            current.generation !== app.generation ||
            !currentView?.callableTargets.includes(requested) ||
            !current.manifest.actions[requested]
          )
            throw failure();
          return json(`/api/execute/${appId}/${encodeURIComponent(requested)}`, {
            method: "POST",
            body: JSON.stringify(input),
            signal,
            headers: {
              "X-Embody-Genui-Generation": app.generation,
              "X-Embody-Genui-View": view.id,
            },
          });
        },
      });
    },
    async close() {
      lifetime.abort();
      await client.close();
    },
  };
}
