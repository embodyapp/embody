import {
  BuildProviderError,
  type BuildConfig,
  type BuildProvider,
  type BuildRecipeConfig,
  type ProviderBuild,
  type ProviderBuildStatus,
} from "./build-admission.js";
import { metadataAccessToken } from "./source-storage.js";

export interface CloudBuildProviderOptions {
  readonly recipe: BuildRecipeConfig;
  /** OAuth token of the controller identity (builds.create + actAs on the builder only). */
  readonly accessToken?: () => Promise<string>;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}
const STATUSES: readonly ProviderBuildStatus[] = [
  "QUEUED",
  "PENDING",
  "WORKING",
  "SUCCESS",
  "FAILURE",
  "INTERNAL_ERROR",
  "TIMEOUT",
  "CANCELLED",
  "EXPIRED",
];
const BUILD_ID = /^[a-f0-9-]{8,64}$/;
const str = (value: unknown) => (typeof value === "string" ? value : "");
const strings = (value: unknown) =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];

/**
 * Cloud Build (regional default pool), Cloud Storage outputs and Artifact Registry images.
 * Every call has a deadline, uses no redirects and maps failures to opaque errors.
 */
export class CloudBuildProvider implements BuildProvider {
  private readonly fetcher: typeof fetch;
  private readonly token: () => Promise<string>;
  private readonly timeoutMs: number;
  private readonly recipe: BuildRecipeConfig;
  public constructor(options: CloudBuildProviderOptions) {
    this.recipe = options.recipe;
    this.fetcher = options.fetch ?? fetch;
    this.token = options.accessToken ?? metadataAccessToken(this.fetcher);
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }
  private get builds(): string {
    return `https://cloudbuild.googleapis.com/v1/projects/${this.recipe.project}/locations/${this.recipe.region}/builds`;
  }
  private async call(url: string, init: RequestInit = {}): Promise<Response> {
    const token = await this.token();
    try {
      return await this.fetcher(url, {
        ...init,
        headers: {
          ...(init.headers as Record<string, string>),
          authorization: `Bearer ${token}`,
        },
        redirect: "error",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new BuildProviderError("Build provider request failed");
    }
  }
  private async json(url: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
    const response = await this.call(url, init);
    if (!response.ok) throw new BuildProviderError(`Build provider returned ${response.status}`);
    return (await response.json()) as Record<string, unknown>;
  }
  public async submit(config: BuildConfig): Promise<{ buildId: string }> {
    const operation = await this.json(this.builds, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(config),
    });
    const metadata = operation["metadata"] as { build?: { id?: unknown } } | undefined;
    const id = str(metadata?.build?.id);
    if (!BUILD_ID.test(id)) throw new BuildProviderError("Invalid build operation");
    return { buildId: id };
  }
  public async find(tag: string): Promise<string | null> {
    if (!/^[a-z0-9][a-z0-9.-]{0,127}$/.test(tag)) throw new TypeError("Invalid build tag");
    const body = await this.json(
      `${this.builds}?pageSize=5&filter=${encodeURIComponent(`tags="${tag}"`)}`,
    );
    const builds = Array.isArray(body["builds"]) ? (body["builds"] as { id?: unknown }[]) : [];
    const ids = builds.map((b) => str(b.id)).filter((id) => BUILD_ID.test(id));
    return ids[0] ?? null;
  }
  public async get(buildId: string): Promise<ProviderBuild> {
    if (!BUILD_ID.test(buildId)) throw new TypeError("Invalid build ID");
    const build = await this.json(`${this.builds}/${buildId}`);
    return toProviderBuild(build);
  }
  public async cancel(buildId: string): Promise<void> {
    if (!BUILD_ID.test(buildId)) throw new TypeError("Invalid build ID");
    const response = await this.call(`${this.builds}/${buildId}:cancel`, { method: "POST" });
    // 400: already finished.
    if (!response.ok && response.status !== 400)
      throw new BuildProviderError("Build cancel failed");
  }
  private object(path: string): string {
    if (!/^(builds|logs)\/[A-Za-z0-9_./-]{1,400}$/.test(path) || path.includes(".."))
      throw new TypeError("Invalid output path");
    return `https://storage.googleapis.com/storage/v1/b/${this.recipe.outputBucket}/o/${encodeURIComponent(path)}`;
  }
  public async readOutput(path: string, maxBytes: number): Promise<Uint8Array | null> {
    const response = await this.call(`${this.object(path)}?alt=media`, {
      headers: { range: `bytes=0-${maxBytes}` },
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new BuildProviderError("Build output unavailable");
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw new BuildProviderError("Build output too large");
    return bytes;
  }
  public async deleteOutputs(prefix: string): Promise<void> {
    if (!/^(builds|logs)\/ws_[a-z0-9]+\/app_[a-z0-9]+\/art_[a-z0-9]+\/$/.test(prefix))
      throw new TypeError("Invalid output prefix");
    const list = await this.json(
      `https://storage.googleapis.com/storage/v1/b/${this.recipe.outputBucket}/o?prefix=${encodeURIComponent(prefix)}&fields=items(name)`,
    );
    const items = Array.isArray(list["items"]) ? (list["items"] as { name?: unknown }[]) : [];
    for (const item of items) {
      const name = str(item.name);
      if (!name.startsWith(prefix)) continue;
      const response = await this.call(this.object(name), { method: "DELETE" });
      if (!response.ok && response.status !== 404)
        throw new BuildProviderError("Build output delete failed");
    }
  }
  public async readLog(buildId: string, logsBucket: string, maxBytes: number): Promise<string | null> {
    const prefix = `gs://${this.recipe.outputBucket}/`;
    if (!BUILD_ID.test(buildId) || !logsBucket.startsWith(prefix))
      throw new TypeError("Invalid log location");
    const bytes = await this.readOutput(
      `${logsBucket.slice(prefix.length)}/log-${buildId}.txt`,
      maxBytes,
    );
    return bytes ? Buffer.from(bytes).toString("utf8") : null;
  }
  private packageUrl(path: string): string {
    if (!/^ws_[a-z0-9]{8,64}\/app_[a-z0-9]{8,64}$/.test(path))
      throw new TypeError("Invalid image path");
    const [host, project, repository] = this.recipe.imageRepository.split("/") as [
      string,
      string,
      string,
    ];
    const location = host.replace(/-docker\.pkg\.dev$/, "");
    return `https://artifactregistry.googleapis.com/v1/projects/${project}/locations/${location}/repositories/${repository}/packages/${encodeURIComponent(path)}`;
  }
  public async deleteImage(path: string, digest: string): Promise<void> {
    if (!/^sha256:[a-f0-9]{64}$/.test(digest)) throw new TypeError("Invalid image digest");
    const response = await this.call(
      `${this.packageUrl(path)}/versions/${encodeURIComponent(digest)}?force=true`,
      { method: "DELETE" },
    );
    if (!response.ok && response.status !== 404)
      throw new BuildProviderError("Image delete failed");
  }
  public async listImages(
    path: string,
  ): Promise<readonly { readonly digest: string; readonly createdAt: string }[]> {
    const response = await this.call(`${this.packageUrl(path)}/versions?pageSize=500`);
    if (response.status === 404) return [];
    if (!response.ok) throw new BuildProviderError("Image list failed");
    const body = (await response.json()) as { versions?: { name?: unknown; createTime?: unknown }[] };
    return (body.versions ?? [])
      .map((v) => ({
        digest: decodeURIComponent(str(v.name).split("/versions/")[1] ?? ""),
        createdAt: str(v.createTime),
      }))
      .filter((v) => /^sha256:[a-f0-9]{64}$/.test(v.digest) && Number.isFinite(Date.parse(v.createdAt)));
  }
}

/** Keeps only the fields the platform set; everything else the provider adds is ignored. */
export function toProviderBuild(build: Record<string, unknown>): ProviderBuild {
  const status = str(build["status"]) as ProviderBuildStatus;
  if (!STATUSES.includes(status) || !BUILD_ID.test(str(build["id"])))
    throw new BuildProviderError("Invalid build record");
  const steps = Array.isArray(build["steps"]) ? (build["steps"] as Record<string, unknown>[]) : [];
  const artifacts = (build["artifacts"] as { objects?: Record<string, unknown> } | undefined)
    ?.objects;
  const results = (build["results"] ?? {}) as {
    images?: { name?: unknown; digest?: unknown }[];
    buildStepOutputs?: unknown[];
  };
  const options = (build["options"] ?? {}) as { logging?: unknown };
  return {
    id: str(build["id"]),
    status,
    config: {
      steps: steps.map((s) => ({
        id: str(s["id"]),
        name: str(s["name"]),
        entrypoint: str(s["entrypoint"]),
        args: strings(s["args"]),
        env: strings(s["env"]),
        timeout: str(s["timeout"]),
      })),
      images: strings(build["images"]),
      artifacts: {
        objects: { location: str(artifacts?.["location"]), paths: strings(artifacts?.["paths"]) },
      },
      serviceAccount: str(build["serviceAccount"]),
      logsBucket: str(build["logsBucket"]),
      options: { logging: str(options.logging) as "GCS_ONLY", substitutionOption: "MUST_MATCH" },
      timeout: str(build["timeout"]),
      tags: strings(build["tags"]),
    },
    images: (results.images ?? []).map((i) => ({ name: str(i.name), digest: str(i.digest) })),
    stepOutputs: (results.buildStepOutputs ?? []).map((o) =>
      typeof o === "string" ? Buffer.from(o, "base64").toString("utf8") : "",
    ),
    ...(typeof build["startTime"] === "string" ? { startTime: build["startTime"] } : {}),
    ...(typeof build["finishTime"] === "string" ? { finishTime: build["finishTime"] } : {}),
  };
}
