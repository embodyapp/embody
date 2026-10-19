import { randomUUID } from "node:crypto";
import {
  BuildOutputTooLargeError,
  BuildProviderError,
  type BuildConfig,
  type BuildProvider,
  type ImageVersion,
  type ProviderBuild,
  type ProviderBuildStatus,
} from "./build-admission.js";

/** What a simulated build produced. Tests use it to model honest and malicious builds. */
export interface SimulatedBuildResult {
  readonly status: ProviderBuildStatus;
  /** Objects written under the output bucket, by path. */
  readonly outputs?: Readonly<Record<string, Uint8Array>>;
  /** `$BUILDER_OUTPUT/output` per step index. */
  readonly stepOutputs?: readonly string[];
  readonly images?: readonly { readonly name: string; readonly digest: string }[];
  readonly log?: string;
}

/**
 * In-memory build provider for tests and local development. `run` receives the exact config the
 * platform submitted and returns what the "build" produced; the provider echoes the config back
 * the way Cloud Build does. Not isolation evidence.
 */
export class MemoryBuildProvider implements BuildProvider {
  public readonly submitted: BuildConfig[] = [];
  public readonly deletedImages: string[] = [];
  public readonly deletedPrefixes: string[] = [];
  private readonly builds = new Map<
    string,
    { config: BuildConfig; result: SimulatedBuildResult | undefined; tags: readonly string[] }
  >();
  public readonly outputs = new Map<string, Uint8Array>();
  public readonly images = new Map<string, ImageVersion[]>();
  public available = true;
  public constructor(
    private readonly run: (config: BuildConfig) => SimulatedBuildResult | undefined,
    private readonly clock: { now(): Date } = { now: () => new Date() },
  ) {}
  private check(): void {
    if (!this.available) throw new BuildProviderError("Build provider unavailable");
  }
  public submit(config: BuildConfig): Promise<{ buildId: string }> {
    this.check();
    const buildId = randomUUID();
    this.submitted.push(config);
    this.builds.set(buildId, { config, result: undefined, tags: config.tags });
    return Promise.resolve({ buildId });
  }
  /** Runs (or re-runs) the simulated build; until then the build is WORKING. */
  public complete(buildId: string): void {
    const build = this.builds.get(buildId);
    if (!build) throw new Error("unknown build");
    const result = this.run(build.config) ?? { status: "WORKING" as const };
    build.result = result;
    for (const [path, bytes] of Object.entries(result.outputs ?? {})) this.outputs.set(path, bytes);
    for (const image of result.images ?? []) {
      const path = image.name.split("/").slice(3).join("/").split(":")[0]!;
      const list = this.images.get(path) ?? [];
      list.push({
        digest: image.digest,
        createdAt: this.clock.now().toISOString(),
        tags: [image.name.split(":").pop()!],
      });
      this.images.set(path, list);
    }
    if (result.log !== undefined) {
      const logs = build.config.logsBucket.replace(/^gs:\/\/[^/]+\//, "");
      this.outputs.set(`${logs}/log-${buildId}.txt`, Buffer.from(result.log));
    }
  }
  public completeAll(): void {
    for (const id of this.builds.keys()) this.complete(id);
  }
  public find(tag: string): Promise<string | null> {
    this.check();
    for (const [id, build] of this.builds) if (build.tags.includes(tag)) return Promise.resolve(id);
    return Promise.resolve(null);
  }
  public get(buildId: string): Promise<ProviderBuild> {
    this.check();
    const build = this.builds.get(buildId);
    if (!build) return Promise.reject(new BuildProviderError("Build not found"));
    // Echo the config the way Cloud Build does: substitutions applied.
    const { substitutions, ...planned } = build.config;
    const executed = (value: string) =>
      value
        .split("$$")
        .join("\u0000")
        .replaceAll("$_SOURCE_URL", substitutions._SOURCE_URL)
        .split("\u0000")
        .join("$");
    const config = {
      ...planned,
      steps: planned.steps.map((s) => ({
        ...s,
        args: s.args.map(executed),
        env: s.env.map(executed),
      })),
    };
    return Promise.resolve({
      id: buildId,
      status: build.result?.status ?? "WORKING",
      config,
      images: build.result?.images ?? [],
      stepOutputs: build.result?.stepOutputs ?? [],
    });
  }
  public cancel(buildId: string): Promise<void> {
    this.check();
    const build = this.builds.get(buildId);
    if (build) build.result = { status: "CANCELLED" };
    return Promise.resolve();
  }
  public readOutput(path: string, maxBytes: number): Promise<Uint8Array | null> {
    this.check();
    const bytes = this.outputs.get(path);
    if (bytes && bytes.byteLength > maxBytes) return Promise.reject(new BuildOutputTooLargeError());
    return Promise.resolve(bytes ?? null);
  }
  public deleteOutputs(prefix: string): Promise<void> {
    this.check();
    this.deletedPrefixes.push(prefix);
    for (const key of [...this.outputs.keys()])
      if (key.startsWith(prefix)) this.outputs.delete(key);
    return Promise.resolve();
  }
  public readLog(buildId: string, logsBucket: string, maxBytes: number): Promise<string | null> {
    this.check();
    const logs = logsBucket.replace(/^gs:\/\/[^/]+\//, "");
    const bytes = this.outputs.get(`${logs}/log-${buildId}.txt`);
    // Logs are truncated, never refused: an oversized log must stay readable.
    return Promise.resolve(
      bytes ? Buffer.from(bytes.subarray(0, maxBytes)).toString("utf8") : null,
    );
  }
  public deleteLogs(logsBucket: string): Promise<void> {
    return this.deleteOutputs(`${logsBucket.replace(/^gs:\/\/[^/]+\//, "")}/`);
  }
  public deleteImage(path: string, digest: string): Promise<void> {
    this.check();
    this.deletedImages.push(`${path}@${digest}`);
    this.images.set(
      path,
      (this.images.get(path) ?? []).filter((image) => image.digest !== digest),
    );
    return Promise.resolve();
  }
  public listImages(path: string): Promise<readonly ImageVersion[]> {
    this.check();
    return Promise.resolve([...(this.images.get(path) ?? [])]);
  }
}
