/**
 * Where the CLI sends requests. Hosted gateways serve the catalog, execution and MCP under a
 * workspace prefix (`<root>/w/<workspace>`) and the management API (sources, deployments, app
 * status) at `<root>/v1/workspaces/<workspace>/…`. A profile may name either form; a
 * reverse-proxy path before `/w/` is kept in both (M14.c).
 */
export interface GatewayTarget {
  /** Gateway origin plus any reverse-proxy path, without the workspace prefix. */
  readonly root: string;
  /** Base for catalog/execute/MCP: `<root>/w/<workspace>`, or the given URL for reference gateways. */
  readonly workspaceBase: string;
  readonly workspaceId?: string;
}

export class TargetError extends Error {}

const WORKSPACE = /^ws_[a-z0-9]{8,64}$/;

export function resolveTarget(baseUrl: string, workspace?: string): GatewayTarget {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new TargetError("A valid gateway URL is required (EMBODY_GATEWAY_URL or --base-url)");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:")
    throw new TargetError("The gateway URL must use https (or http on loopback)");
  if (url.username || url.password || url.search || url.hash)
    throw new TargetError(
      "The gateway URL must not contain credentials, a query or a fragment; use a profile token",
    );
  if (workspace !== undefined && !WORKSPACE.test(workspace))
    throw new TargetError("--workspace must be a workspace ID (ws_…)");
  const path = url.pathname.replace(/\/+$/, "");
  const prefixed = /^(.*)\/w\/([^/]+)$/.exec(path);
  if (prefixed) {
    const [, rootPath, fromUrl] = prefixed as unknown as [string, string, string];
    if (!WORKSPACE.test(fromUrl))
      throw new TargetError("The gateway URL names an invalid workspace ID after /w/");
    if (workspace !== undefined && workspace !== fromUrl)
      throw new TargetError("--workspace does not match the workspace in the gateway URL");
    return {
      root: `${url.origin}${rootPath}`,
      workspaceBase: `${url.origin}${path}`,
      workspaceId: fromUrl,
    };
  }
  const root = `${url.origin}${path}`;
  return workspace === undefined
    ? { root, workspaceBase: root }
    : { root, workspaceBase: `${root}/w/${workspace}`, workspaceId: workspace };
}

/** `base` + `/` + `path`, never keeping a query or fragment. */
export function joinUrl(base: string, path: string): URL {
  const url = new URL(base);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
  url.search = "";
  url.hash = "";
  return url;
}
