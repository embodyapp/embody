import { createHash } from "node:crypto";
import { stableStringify, type AppManifest, type EmbodyPlugin } from "@embody/core";
import {
  compileGenUiManifest,
  GENUI_MIME_TYPE,
  type GenUiDefinition,
  type GenUiResourceMetadata,
} from "@embody/genui";

export interface HostedGenUiResource {
  readonly uri: string;
  readonly mimeType: typeof GENUI_MIME_TYPE;
  readonly text: string;
  readonly metadata?: GenUiResourceMetadata;
}
export interface HostPresentation {
  readonly manifest: AppManifest;
  readonly generation: string;
  readResource(uri: string, generation: string): HostedGenUiResource | undefined;
}

function immutable<T>(value: T): T {
  const result = structuredClone(value);
  const pending: object[] = result !== null && typeof result === "object" ? [result] : [];
  while (pending.length) {
    const item = pending.pop()!;
    for (const child of Object.values(item) as unknown[])
      if (child !== null && typeof child === "object") pending.push(child);
    Object.freeze(item);
  }
  return result;
}

/** Captures trusted app build artifacts at boot, without tenant data or filesystem-derived lookup. */
export function compileHostPresentation(
  app: {
    readonly appId: string;
    readonly plugins: readonly EmbodyPlugin[];
    readonly genui?: GenUiDefinition;
  },
  base: AppManifest,
): HostPresentation {
  const manifest =
    app.genui === undefined
      ? base
      : immutable(compileGenUiManifest({ ...app, genui: app.genui }, base));
  const generation = createHash("sha256").update(stableStringify(manifest)).digest("hex");
  const resources = new Map<string, HostedGenUiResource>();
  let bytes = 0;
  for (const [id, view] of Object.entries(app.genui?.views ?? {})) {
    const uri = manifest.views![id]!.resourceUri;
    bytes +=
      Buffer.byteLength(view.resource.text) +
      Buffer.byteLength(stableStringify(view.resource.metadata ?? {}));
    if (bytes > 16 * 1_048_576) throw new Error("GenUI resources exceed the host byte budget");
    resources.set(
      uri,
      immutable({
        uri,
        mimeType: GENUI_MIME_TYPE,
        text: view.resource.text,
        ...(view.resource.metadata === undefined ? {} : { metadata: view.resource.metadata }),
      }),
    );
  }
  return Object.freeze({
    manifest,
    generation,
    readResource: (uri: string, requested: string) =>
      requested === generation ? resources.get(uri) : undefined,
  });
}
