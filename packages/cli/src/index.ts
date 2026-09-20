import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { stdin as input, stdout, stderr } from "node:process";

export {
  loadDevConfig,
  startDevServer,
  watchDevServer,
  type DevServer,
  type EmbodyDevConfig,
} from "./dev.js";
export { startMcpBridge, type McpBridge, type McpBridgeOptions } from "./mcp-bridge.js";

export const EXIT = {
  usage: 2,
  auth: 3,
  forbidden: 4,
  notFound: 5,
  remote: 6,
  unavailable: 7,
  internal: 1,
} as const;
export interface CliIo {
  readonly stdin: NodeJS.ReadableStream;
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
}
export interface CliOptions {
  readonly fetch?: typeof fetch;
  readonly env?: NodeJS.ProcessEnv;
  readonly io?: CliIo;
  readonly signal?: AbortSignal;
}
interface Schema {
  readonly type?: string;
  readonly enum?: readonly unknown[];
  readonly items?: Schema;
  readonly properties?: Readonly<Record<string, Schema>>;
  readonly required?: readonly string[];
  readonly default?: unknown;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly [key: string]: unknown;
}
type CatalogApp = {
  readonly appId: string;
  readonly manifest: {
    readonly entities: Readonly<Record<string, { readonly schema: Schema }>>;
    readonly actions: Readonly<Record<string, { readonly inputSchema: Schema }>>;
  };
};
interface CliConfig {
  readonly defaultProfile?: string;
  readonly profiles?: Readonly<
    Record<string, { readonly baseUrl?: string; readonly token?: string }>
  >;
}
interface CatalogCache {
  readonly etag?: string;
  readonly fetchedAt: number;
  readonly catalog: CatalogApp[];
}
async function config(path: string): Promise<CliConfig> {
  try {
    const info = await stat(path);
    const value = JSON.parse(await readFile(path, "utf8")) as CliConfig;
    const hasToken = Object.values(value.profiles ?? {}).some((profile) => profile.token);
    if (hasToken && (info.mode & 0o077) !== 0)
      throw new Error("Credential config must have mode 0600");
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}
async function readCache(path: string): Promise<CatalogCache | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as CatalogCache;
  } catch {
    return undefined;
  }
}

function fail(io: CliIo, message: string, code: number): number {
  io.stderr.write(`${message}\n`);
  return code;
}
function scalar(value: string, schema?: Schema): unknown {
  if (schema?.type === "object") throw new Error("Complex input requires --json");
  if (schema?.type === "boolean") {
    if (value === "true") return true;
    if (value === "false") return false;
    throw new Error("must be true or false");
  }
  if (schema?.type === "number" || schema?.type === "integer") {
    const n = Number(value);
    if (!Number.isFinite(n) || (schema.type === "integer" && !Number.isInteger(n)))
      throw new Error("must be a number");
    return n;
  }
  if (schema?.type === "array") return value.split(",").map((item) => scalar(item, schema.items));
  if (schema?.enum && Array.isArray(schema.enum) && !schema.enum.includes(value))
    throw new Error("must be an allowed value");
  return value;
}
function flags(args: string[], schema: Schema): Record<string, unknown> {
  const properties = (schema.properties ?? {}) as Record<string, Schema>;
  const result: Record<string, unknown> = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg?.startsWith("--")) throw new Error(`Unexpected argument: ${arg}`);
    const key = arg.slice(2);
    const property = properties[key];
    if (!property) throw new Error(`Unknown option: --${key}`);
    const next = args[i + 1];
    if (property.type === "boolean" && (next === undefined || next.startsWith("--")))
      result[key] = true;
    else {
      if (next === undefined || next.startsWith("--"))
        throw new Error(`Missing value for --${key}`);
      const value = scalar(next, property);
      if (property.type === "array")
        result[key] = [...((result[key] as unknown[] | undefined) ?? []), ...(value as unknown[])];
      else result[key] = value;
      i += 1;
    }
  }
  for (const [key, property] of Object.entries(properties))
    if (result[key] === undefined && property.default !== undefined) result[key] = property.default;
  for (const key of schema.required ?? [])
    if (result[key] === undefined) throw new Error(`Missing required option: --${key}`);
  validate(result, schema);
  return result;
}
function validate(value: unknown, schema: Schema, path = "input"): void {
  if (schema.enum && !schema.enum.includes(value))
    throw new Error(`${path} must be an allowed value`);
  if (schema.type === "object") {
    if (value === null || typeof value !== "object" || Array.isArray(value))
      throw new Error(`${path} must be an object`);
    const record = value as Record<string, unknown>;
    for (const key of schema.required ?? [])
      if (record[key] === undefined) throw new Error(`${path}.${key} is required`);
    for (const [key, child] of Object.entries(schema.properties ?? {}))
      if (record[key] !== undefined) validate(record[key], child, `${path}.${key}`);
  } else if (schema.type === "array") {
    if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
    if (schema.items)
      value.forEach((item, index) => validate(item, schema.items!, `${path}[${index}]`));
  } else if (schema.type === "string" && typeof value !== "string")
    throw new Error(`${path} must be a string`);
  else if ((schema.type === "number" || schema.type === "integer") && typeof value !== "number")
    throw new Error(`${path} must be a number`);
  else if (schema.type === "integer" && !Number.isInteger(value))
    throw new Error(`${path} must be an integer`);
  else if (schema.type === "boolean" && typeof value !== "boolean")
    throw new Error(`${path} must be a boolean`);
  if (typeof value === "number" && schema.minimum !== undefined && value < schema.minimum)
    throw new Error(`${path} is below minimum`);
  if (typeof value === "number" && schema.maximum !== undefined && value > schema.maximum)
    throw new Error(`${path} is above maximum`);
}
function usage(io: CliIo, code: number = EXIT.usage): number {
  return fail(
    io,
    "Usage: embody dev [configPath] | embody mcp --url <endpoint> [--token <token>] | embody apps list|inspect <app> | embody <app> <entity> <create|get|list|update|delete> [id] [--flags] | embody <app> <action> [--flags]",
    code,
  );
}
function actionFor(app: CatalogApp, words: string[]): string | undefined {
  if (words.length >= 2 && ["create", "get", "list", "update", "delete"].includes(words[1] ?? ""))
    return Object.keys(app.manifest.actions).find((target) =>
      target.endsWith(`.${words[0]}.${words[1]}`),
    );
  return Object.keys(app.manifest.actions).find((target) => target.endsWith(`.${words[0]}`));
}
export async function runCli(argv: readonly string[], options: CliOptions = {}): Promise<number> {
  const io = options.io ?? { stdin: input, stdout, stderr };
  const env = options.env ?? process.env;
  const fetcher = options.fetch ?? fetch;
  const args = [...argv];
  if (args.length === 0 || (args.length === 1 && args[0] === "--help")) return usage(io, 0);
  const profileIndex = args.indexOf("--profile");
  const requestedProfile =
    profileIndex >= 0 ? args.splice(profileIndex, 2)[1] : env["EMBODY_PROFILE"];
  let settings: CliConfig;
  const configPath = env["EMBODY_CONFIG"] ?? join(homedir(), ".config", "embody", "config.json");
  try {
    settings = await config(configPath);
  } catch (error) {
    return fail(io, error instanceof Error ? error.message : "Invalid config", EXIT.auth);
  }
  const profile = requestedProfile ?? settings.defaultProfile ?? "default";
  const profileSettings = settings.profiles?.[profile];
  const baseUrlIndex = args.indexOf("--base-url");
  const baseUrl =
    baseUrlIndex >= 0
      ? args.splice(baseUrlIndex, 2)[1]
      : (env["EMBODY_GATEWAY_URL"] ?? profileSettings?.baseUrl ?? "http://localhost:3000");
  const tokenIndex = args.indexOf("--token");
  const token =
    tokenIndex >= 0
      ? args.splice(tokenIndex, 2)[1]
      : (env["EMBODY_TOKEN"] ?? profileSettings?.token);
  const json = args.includes("--json");
  if (json) args.splice(args.indexOf("--json"), 1);
  const outputIndex = args.indexOf("--output");
  const output = outputIndex >= 0 ? args.splice(outputIndex, 2)[1] : "table";
  if (output !== "json" && output !== "table")
    return fail(io, "--output must be json or table", EXIT.usage);
  if (!token)
    return fail(io, "Authentication token is required (EMBODY_TOKEN or --token)", EXIT.auth);
  let catalog: CatalogApp[];
  const cacheRoot = env["EMBODY_CACHE_DIR"] ?? join(homedir(), ".cache", "embody");
  const cachePath = join(
    cacheRoot,
    `${createHash("sha256").update(`${profile}:${baseUrl}:${token}`).digest("hex")}.json`,
  );
  const cached = await readCache(cachePath);
  try {
    const response = await fetcher(new URL("/api/catalog", baseUrl), {
      headers: {
        authorization: `Bearer ${token}`,
        ...(cached?.etag ? { "if-none-match": cached.etag } : {}),
      },
    });
    if (response.status === 304 && cached) catalog = cached.catalog;
    else {
      if (!response.ok)
        return fail(
          io,
          "Gateway unavailable",
          response.status === 401 ? EXIT.auth : EXIT.unavailable,
        );
      catalog = (await response.json()) as CatalogApp[];
      const etag = response.headers.get("etag") ?? undefined;
      await mkdir(dirname(cachePath), { recursive: true, mode: 0o700 });
      await writeFile(
        cachePath,
        JSON.stringify({ ...(etag ? { etag } : {}), fetchedAt: Date.now(), catalog }),
        { mode: 0o600 },
      );
    }
  } catch {
    return fail(io, "Gateway unavailable", EXIT.unavailable);
  }
  if (args[0] === "apps") {
    if (args[1] === "--help") return usage(io, 0);
    if (args[1] === "list") {
      io.stdout.write(
        output === "json"
          ? `${JSON.stringify(catalog.map((a) => a.appId))}\n`
          : `${catalog.map((a) => a.appId).join("\n")}\n`,
      );
      return 0;
    }
    if (args[1] === "inspect" && args[2]) {
      const app = catalog.find((a) => a.appId === args[2]);
      if (!app) return fail(io, "App not found", EXIT.notFound);
      io.stdout.write(`${JSON.stringify(app.manifest, null, 2)}\n`);
      return 0;
    }
    return usage(io);
  }
  const app = catalog.find((candidate) => candidate.appId === args[0]);
  if (!app || !args[1]) return usage(io);
  const target = actionFor(app, args.slice(1, 3));
  if (!target) return fail(io, "Action not found", EXIT.notFound);
  const action = app.manifest.actions[target];
  if (!action) return fail(io, "Action not found", EXIT.notFound);
  if (args.includes("--help")) {
    io.stdout.write(`${target}\n${JSON.stringify(action.inputSchema, null, 2)}\n`);
    return 0;
  }
  const operation = args[2];
  const positional = ["get", "update", "delete"].includes(operation ?? "")
    ? args.splice(3, 1)[0]
    : undefined;
  const rest = args.slice(
    operation && ["create", "get", "list", "update", "delete"].includes(operation) ? 3 : 2,
  );
  let body: unknown;
  try {
    if (json) {
      if ((io.stdin as { isTTY?: boolean }).isTTY)
        return fail(io, "--json requires stdin", EXIT.usage);
      let text = "";
      for await (const chunk of io.stdin) text += String(chunk);
      if (!text.trim()) return fail(io, "--json input is empty", EXIT.usage);
      if (rest.length) return fail(io, "Cannot mix --json and flags", EXIT.usage);
      body = JSON.parse(text);
      validate(body, action.inputSchema);
    } else {
      const top = (action.inputSchema.properties ?? {}) as Record<string, Schema>;
      const dataSchema = top["data"];
      if (operation === "list") {
        const entityTarget = target.replace(/\.list$/, "");
        const entitySchema = app.manifest.entities[entityTarget]?.schema;
        const combined: Schema = {
          type: "object",
          properties: {
            ...(entitySchema?.properties ?? {}),
            limit: top["limit"] ?? {},
            offset: top["offset"] ?? {},
          },
        };
        const values = flags(rest, combined);
        const limit = values["limit"];
        const offset = values["offset"];
        delete values["limit"];
        delete values["offset"];
        body = {
          ...(Object.keys(values).length ? { filter: values } : {}),
          ...(limit === undefined ? {} : { limit }),
          ...(offset === undefined ? {} : { offset }),
        };
      } else {
        if (["get", "update", "delete"].includes(operation ?? "") && !positional)
          throw new Error(`${operation} requires an ID`);
        const positionalRequired = action.inputSchema.required?.filter((key) => key !== "id");
        const flagSchema =
          !dataSchema && positional
            ? {
                ...action.inputSchema,
                ...(positionalRequired ? { required: positionalRequired } : {}),
              }
            : (dataSchema ?? action.inputSchema);
        const values = flags(rest, flagSchema);
        if (dataSchema) body = { data: values, ...(positional ? { id: positional } : {}) };
        else {
          if (positional) values["id"] = positional;
          body = values;
        }
      }
      validate(body, action.inputSchema);
    }
  } catch (error) {
    return fail(io, error instanceof Error ? error.message : "Invalid input", EXIT.usage);
  }
  try {
    const response = await fetcher(
      new URL(
        `/api/execute/stream/${encodeURIComponent(app.appId)}/${encodeURIComponent(target)}`,
        baseUrl,
      ),
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        ...(options.signal ? { signal: options.signal } : {}),
      },
    );
    if (!response.ok || !response.body)
      return fail(
        io,
        "Remote execution failed",
        response.status === 403
          ? EXIT.forbidden
          : response.status === 404
            ? EXIT.notFound
            : response.status === 401
              ? EXIT.auth
              : response.status >= 500
                ? EXIT.unavailable
                : EXIT.remote,
      );
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    let result: unknown;
    let remoteError = false;
    const handle = (frame: string): void => {
      const event = /^event: (.+)$/m.exec(frame)?.[1];
      const data = /^data: (.+)$/m.exec(frame)?.[1];
      if (!event || !data) return;
      const value: unknown = JSON.parse(data);
      if (event === "progress") {
        const progress = value as { percent?: unknown; message?: unknown };
        const line = `${typeof progress.percent === "number" ? `${progress.percent}% ` : ""}${typeof progress.message === "string" ? progress.message : ""}`;
        io.stderr.write((io.stderr as { isTTY?: boolean }).isTTY ? `\r${line}` : `${line}\n`);
      }
      if (event === "result") result = value;
      if (event === "error") remoteError = true;
    };
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      pending += decoder.decode(next.value, { stream: true });
      let boundary: number;
      while ((boundary = pending.indexOf("\n\n")) >= 0) {
        handle(pending.slice(0, boundary));
        pending = pending.slice(boundary + 2);
      }
    }
    if ((io.stderr as { isTTY?: boolean }).isTTY) io.stderr.write("\n");
    if (remoteError) return fail(io, "Remote execution failed", EXIT.remote);
    io.stdout.write(`${JSON.stringify(result, null, output === "json" ? 0 : 2)}\n`);
    return 0;
  } catch {
    if (options.signal?.aborted) return 130;
    return fail(io, "Gateway unavailable", EXIT.unavailable);
  }
}
