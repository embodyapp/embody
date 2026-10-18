// Framework registry for the build recipe: serves only the bundled @embody tarballs, on
// loopback, for the trusted fetch step. Every other package comes from the public registry with
// lockfile integrity. A lockfile pinned to any other @embody build fails integrity checks.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** `framework` entries: { name, version, integrity, file } with `file` relative to `dir`. */
export async function startFrameworkRegistry(dir, framework) {
  const byName = new Map(framework.map((p) => [p.name, p]));
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://registry.invalid");
      const path = decodeURIComponent(url.pathname).replace(/^\//, "");
      const tarball = /^(@embody\/[a-z0-9-]+)\/-\/[a-z0-9-]+-(\d+\.\d+\.\d+[0-9A-Za-z.+-]*)\.tgz$/.exec(path);
      if (request.method === "GET" && tarball) {
        const pkg = byName.get(tarball[1]);
        if (!pkg || pkg.version !== tarball[2]) return void response.writeHead(404).end();
        const bytes = await readFile(join(dir, pkg.file));
        response.writeHead(200, { "content-type": "application/octet-stream" }).end(bytes);
        return;
      }
      const pkg = byName.get(path);
      if (request.method === "GET" && pkg) {
        const base = `http://${request.headers.host}`;
        const body = {
          name: pkg.name,
          "dist-tags": { latest: pkg.version },
          versions: {
            [pkg.version]: {
              ...pkg.manifest,
              name: pkg.name,
              version: pkg.version,
              dist: {
                integrity: pkg.integrity,
                tarball: `${base}/${pkg.name}/-/${pkg.name.split("/")[1]}-${pkg.version}.tgz`,
              },
            },
          },
        };
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
        return;
      }
      response.writeHead(404).end();
    })().catch(() => response.writeHead(500).end());
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
