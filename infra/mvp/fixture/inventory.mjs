import { execFileSync } from "node:child_process";
export function immutableLeaf(image) {
  const manifest = JSON.parse(
    execFileSync("docker", ["buildx", "imagetools", "inspect", image, "--raw"], {
      encoding: "utf8",
    }),
  );
  const digest =
    manifest.manifests?.find(
      (entry) => entry.platform?.os === "linux" && entry.platform?.architecture === "amd64",
    )?.digest ?? image.split("@")[1];
  if (!/^sha256:[a-f0-9]{64}$/.test(digest)) throw new Error("Immutable amd64 image required");
  return `${image.split("@")[0]}@${digest}`;
}
export async function servingInventory(api, data) {
  const base = `https://run.googleapis.com/v2/projects/${data.project}/locations/${data.region}`;
  const names = [`${data.prefix}-gateway`, ...data.apps.map((app) => app.service)];
  const inventory = [];
  for (const [index, name] of names.entries()) {
    const service = await api(`${base}/services/${name}`);
    if (
      service.terminalCondition?.state !== "CONDITION_SUCCEEDED" ||
      (index > 0 && service.ingress !== "INGRESS_TRAFFIC_INTERNAL_ONLY")
    )
      throw new Error("Serving fixture not ready/private");
    const traffic = service.trafficStatuses ?? [];
    if (!traffic.length || traffic.reduce((sum, target) => sum + (target.percent ?? 0), 0) !== 100)
      throw new Error("Serving traffic inventory incomplete");
    const revisions = [];
    for (const target of traffic.filter((target) => target.percent > 0 || target.tag)) {
      const name = target.revision.includes("/")
        ? target.revision
        : `${service.name}/revisions/${target.revision}`;
      const revision = await api(`https://run.googleapis.com/v2/${name}`);
      const image = revision.containers?.[0]?.image;
      if (typeof image !== "string" || ![data.image, data.leafImage].includes(image))
        throw new Error("Serving fixture image differs from candidate");
      revisions.push({
        name,
        image,
        percent: target.percent ?? 0,
        ...(target.uri ? { uri: target.uri } : {}),
      });
    }
    inventory.push({ name: service.name, uri: service.uri, ingress: service.ingress, revisions });
  }
  return inventory;
}
