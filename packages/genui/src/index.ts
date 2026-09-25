import { createHash } from "node:crypto";
import {
  compileManifest,
  stableStringify,
  type AppManifest,
  type EmbodyPlugin,
  type ViewFallback,
  type ViewManifest,
} from "@embody/core";
import { z } from "zod";

export const GENUI_PROTOCOL_VERSION = 1 as const;
export const GENUI_MIME_TYPE = "text/html;profile=mcp-app" as const;
export const GENUI_MAX_VIEWS = 500;
export const GENUI_MAX_RESOURCE_BYTES = 1_048_576;
export const GENUI_MAX_CALLABLE_TARGETS = 100;

const appIdPattern = /^[a-z][a-z0-9-]{0,62}$/;
const viewIdPattern = /^[a-z][a-z0-9-]{0,62}$/;
const versionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export interface GenUiResourceCsp {
  readonly connectDomains?: readonly string[];
  readonly resourceDomains?: readonly string[];
  readonly frameDomains?: readonly string[];
  readonly baseUriDomains?: readonly string[];
}

export interface GenUiResourcePermissions {
  readonly camera?: boolean;
  readonly microphone?: boolean;
  readonly geolocation?: boolean;
  readonly clipboardWrite?: boolean;
}

export interface GenUiResourceMetadata {
  readonly csp?: GenUiResourceCsp;
  readonly permissions?: GenUiResourcePermissions;
  readonly prefersBorder?: boolean;
}

/** Trusted immutable HTML built with the application, never supplied by a model or action input. */
export interface GenUiResourceDefinition {
  readonly mimeType?: typeof GENUI_MIME_TYPE;
  readonly text: string;
  readonly metadata?: GenUiResourceMetadata;
}

export interface GenUiViewDefinition<TProps extends z.ZodType = z.ZodType> {
  readonly kind: "standard" | "custom";
  readonly version: string;
  readonly description?: string;
  readonly props: TProps;
  readonly resource: GenUiResourceDefinition;
  readonly callableTargets?: readonly string[];
  readonly fallback: ViewFallback;
}

export type GenUiViewMap = Readonly<Record<string, GenUiViewDefinition>>;
export type GenUiActionBindings = Readonly<Record<string, string>>;

export interface GenUiDefinition<
  TViews extends GenUiViewMap = GenUiViewMap,
  TActions extends GenUiActionBindings = GenUiActionBindings,
> {
  readonly views: TViews;
  readonly actions: TActions;
}

interface GenUiAppLike {
  readonly appId: string;
  readonly plugins: readonly EmbodyPlugin[];
}

export type GenUiApp<
  TApp extends GenUiAppLike = GenUiAppLike,
  TDefinition extends GenUiDefinition = GenUiDefinition,
> = TApp & { readonly genui: TDefinition };

type PluginUnion<TApp> = TApp extends { readonly plugins: readonly (infer TPlugin)[] }
  ? TPlugin
  : never;
type CustomActionTarget<TApp> =
  PluginUnion<TApp> extends infer TPlugin
    ? TPlugin extends {
        readonly id: infer TId extends string;
        readonly actions?: infer TActions extends Readonly<Record<string, unknown>>;
      }
      ? `${TId}.${Extract<keyof TActions, string>}`
      : never
    : never;
type ActionOutputSchema<TApp, TTarget extends string> =
  PluginUnion<TApp> extends infer TPlugin
    ? TPlugin extends {
        readonly id: infer TId extends string;
        readonly actions?: infer TActions extends Readonly<Record<string, unknown>>;
      }
      ? TTarget extends `${TId}.${infer TAction}`
        ? TAction extends keyof TActions
          ? TActions[TAction] extends { readonly output: infer TOutput extends z.ZodType }
            ? TOutput
            : never
          : never
        : never
      : never
    : never;
type ViewPropsSchema<TViews, TView extends PropertyKey> = TView extends keyof TViews
  ? TViews[TView] extends GenUiViewDefinition<infer TProps>
    ? TProps
    : never
  : never;
type CompatibleViewNames<TApp, TViews, TTarget extends string> = {
  [TView in keyof TViews & string]: [z.output<ActionOutputSchema<TApp, TTarget>>] extends [
    z.output<ViewPropsSchema<TViews, TView>>,
  ]
    ? [z.output<ViewPropsSchema<TViews, TView>>] extends [
        z.output<ActionOutputSchema<TApp, TTarget>>,
      ]
      ? TView
      : never
    : never;
}[keyof TViews & string];
type CheckedBindings<TApp, TViews, TBindings extends Readonly<Record<string, string>>> = {
  readonly [TTarget in keyof TBindings]: TTarget extends CustomActionTarget<TApp>
    ? TTarget extends string
      ? TBindings[TTarget] extends CompatibleViewNames<TApp, TViews, TTarget>
        ? TBindings[TTarget]
        : never
      : never
    : never;
};

/** Preserves literal view and binding types. Full app compatibility is checked by `withGenUi`. */
export function defineGenUi<
  const TViews extends GenUiViewMap,
  const TActions extends GenUiActionBindings,
>(definition: GenUiDefinition<TViews, TActions>): GenUiDefinition<TViews, TActions> {
  return definition;
}

/** Preserves a view's props schema so action/view compatibility can be checked statically. */
export function defineView<const TView extends GenUiViewDefinition>(view: TView): TView {
  return view;
}

/**
 * Adds app-owned presentation configuration. In v1, a presented action and its view must share the
 * exact same Zod output/props schema object; no implicit projection or response envelope is used.
 */
export function withGenUi<
  const TApp extends GenUiAppLike,
  const TViews extends GenUiViewMap,
  const TBindings extends GenUiActionBindings,
>(
  app: TApp,
  definition: GenUiDefinition<TViews, TBindings> & {
    readonly actions: TBindings & CheckedBindings<TApp, TViews, TBindings>;
  },
): GenUiApp<TApp, GenUiDefinition<TViews, TBindings>> {
  validateDefinition(app, definition);
  return { ...app, genui: definition };
}

/** Adds optional view/action metadata without changing any existing action output. */
export function compileGenUiManifest(
  app: GenUiApp,
  baseManifest: AppManifest = compileManifest(app.plugins),
): AppManifest {
  validateDefinition(app, app.genui);
  const views = Object.fromEntries(
    Object.entries(app.genui.views)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([id, view]) => [id, viewManifest(app.appId, id, view)]),
  );
  const bindings = app.genui.actions;
  const actions = Object.fromEntries(
    Object.entries(baseManifest.actions).map(([target, action]) => {
      const view = bindings[target];
      return [target, view === undefined ? action : { ...action, presentation: { view } }];
    }),
  );
  return { ...baseManifest, actions, views };
}

/** Computes the generation-stable URI used by MCP Apps resource discovery. */
export function genUiResourceUri(appId: string, viewId: string, version: string): string {
  if (!appIdPattern.test(appId)) throw new Error("GenUI app ID is invalid");
  if (!viewIdPattern.test(viewId)) throw new Error("GenUI view ID is invalid");
  if (!versionPattern.test(version)) throw new Error("GenUI view version must be semantic");
  return `ui://${appId}/${viewId}@${version}`;
}

/** Hashes immutable HTML and its security/rendering metadata; tenant data is never an input. */
export function genUiResourceIntegrity(resource: GenUiResourceDefinition): string {
  validateResource(resource);
  const digest = createHash("sha256")
    .update(resource.text)
    .update("\0")
    .update(stableStringify(resource.metadata ?? {}))
    .digest("hex");
  return `sha256:${digest}`;
}

function viewManifest(appId: string, id: string, view: GenUiViewDefinition): ViewManifest {
  return {
    protocolVersion: GENUI_PROTOCOL_VERSION,
    id,
    kind: view.kind,
    ...(view.description === undefined ? {} : { description: view.description }),
    propsSchema: z.toJSONSchema(view.props, { target: "draft-7", reused: "inline" }),
    resourceUri: genUiResourceUri(appId, id, view.version),
    version: view.version,
    callableTargets: [...(view.callableTargets ?? [])].sort(),
    fallback: view.fallback,
    integrity: genUiResourceIntegrity(view.resource),
  };
}

function validateDefinition(app: GenUiAppLike, definition: GenUiDefinition): void {
  if (!appIdPattern.test(app.appId)) throw new Error("GenUI app ID is invalid");
  const entries = Object.entries(definition.views);
  if (entries.length === 0 || entries.length > GENUI_MAX_VIEWS)
    throw new Error(`GenUI must define between 1 and ${GENUI_MAX_VIEWS} views`);
  const manifest = compileManifest(app.plugins);
  const targets = new Set(Object.keys(manifest.actions));
  for (const [id, view] of entries) {
    if (!viewIdPattern.test(id)) throw new Error(`GenUI view ID is invalid: ${id}`);
    if (view.kind !== "standard" && view.kind !== "custom")
      throw new Error(`GenUI view kind is invalid: ${id}`);
    if (!versionPattern.test(view.version))
      throw new Error(`GenUI view version must be semantic: ${id}`);
    if (view.description !== undefined && view.description.length > 2_000)
      throw new Error(`GenUI view description is too long: ${id}`);
    if (!(view.props instanceof z.ZodType)) throw new Error(`GenUI view props are invalid: ${id}`);
    if (view.fallback !== "markdown" && view.fallback !== "text" && view.fallback !== "json")
      throw new Error(`GenUI view fallback is invalid: ${id}`);
    validateResource(view.resource);
    const callable = view.callableTargets ?? [];
    if (callable.length > GENUI_MAX_CALLABLE_TARGETS)
      throw new Error(`GenUI view has too many callable targets: ${id}`);
    if (new Set(callable).size !== callable.length)
      throw new Error(`GenUI view has duplicate callable targets: ${id}`);
    for (const target of callable)
      if (!targets.has(target)) throw new Error(`GenUI callable target was not found: ${target}`);
  }
  for (const [target, viewId] of Object.entries(definition.actions)) {
    if (!targets.has(target)) throw new Error(`GenUI presented action was not found: ${target}`);
    const view = definition.views[viewId];
    if (view === undefined) throw new Error(`GenUI bound view was not found: ${viewId}`);
    const output = customActionOutput(app.plugins, target);
    if (output === undefined)
      throw new Error(`GenUI presented action must be a custom action with an output: ${target}`);
    if (output !== view.props)
      throw new Error(`GenUI action output and view props must use the same schema: ${target}`);
  }
}

function customActionOutput(
  plugins: readonly EmbodyPlugin[],
  target: string,
): z.ZodType | undefined {
  for (const plugin of plugins) {
    const prefix = `${plugin.id}.`;
    if (!target.startsWith(prefix)) continue;
    const actionName = target.slice(prefix.length);
    return plugin.actions?.[actionName]?.output;
  }
  return undefined;
}

function validateResource(resource: GenUiResourceDefinition): void {
  if (resource === null || typeof resource !== "object")
    throw new Error("GenUI resource is invalid");
  if ((resource.mimeType ?? GENUI_MIME_TYPE) !== GENUI_MIME_TYPE)
    throw new Error("GenUI resource MIME type is invalid");
  const bytes = Buffer.byteLength(resource.text);
  if (bytes === 0 || bytes > GENUI_MAX_RESOURCE_BYTES)
    throw new Error(`GenUI resource must be between 1 and ${GENUI_MAX_RESOURCE_BYTES} bytes`);
  validateOrigins(resource.metadata?.csp?.connectDomains, "connectDomains");
  validateOrigins(resource.metadata?.csp?.resourceDomains, "resourceDomains");
  validateOrigins(resource.metadata?.csp?.frameDomains, "frameDomains");
  validateOrigins(resource.metadata?.csp?.baseUriDomains, "baseUriDomains");
  const permissions = resource.metadata?.permissions;
  if (
    permissions !== undefined &&
    Object.values(permissions).some((permission) => typeof permission !== "boolean")
  )
    throw new Error("GenUI resource permissions must be boolean");
  if (
    resource.metadata?.prefersBorder !== undefined &&
    typeof resource.metadata.prefersBorder !== "boolean"
  )
    throw new Error("GenUI resource border preference must be boolean");
}

function validateOrigins(origins: readonly string[] | undefined, field: string): void {
  if (origins === undefined) return;
  if (origins.length > 100 || new Set(origins).size !== origins.length)
    throw new Error(`GenUI ${field} must contain at most 100 unique origins`);
  for (const value of origins) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error(`GenUI ${field} contains an invalid origin`);
    }
    if (
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== "" ||
      url.origin !== value ||
      (url.pathname !== "/" && url.pathname !== "") ||
      url.search !== "" ||
      url.hash !== ""
    )
      throw new Error(`GenUI ${field} contains an invalid origin`);
  }
}
