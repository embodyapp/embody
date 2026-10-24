import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createApp } from "../src/index.js";

const cleanup: string[] = [];
afterEach(async () =>
  Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true }))),
);

it("generates the documented safe starter layout", async () => {
  const root = await mkdtemp(join(tmpdir(), "embody-scaffold-"));
  cleanup.push(root);
  const app = await createApp({
    name: "my-agent",
    destination: join(root, "my-agent"),
    noInstall: true,
  });
  expect(app.files).toContain("embody.config.ts");
  expect(await readFile(join(app.directory, "Dockerfile"), "utf8")).toContain("HEALTHCHECK");
  expect(await readFile(join(app.directory, "embody.config.ts"), "utf8")).toContain("defineApp");
  expect(await readFile(join(app.directory, "src/index.ts"), "utf8")).toContain("createAppHost");
  const packageJson = JSON.parse(
    await readFile(join(app.directory, "package.json"), "utf8"),
  ) as Record<string, unknown>;
  const scaffolderPackage = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  ) as { version: string };
  expect(packageJson).not.toHaveProperty("secret");
  expect(packageJson).toMatchObject({
    private: true,
    license: "UNLICENSED",
    scripts: { prestart: "pnpm build" },
    dependencies: {
      "@embody/cli": `^${scaffolderPackage.version}`,
      "@embody/core": `^${scaffolderPackage.version}`,
      "@embody/host": `^${scaffolderPackage.version}`,
    },
    devDependencies: { "@embody/testing": `^${scaffolderPackage.version}` },
  });
  expect(await readFile(join(app.directory, "README.md"), "utf8")).toContain(
    "belongs to its creator",
  );
  expect(app.files).not.toContain("LICENSE");
});

it("generates a hosted starter that cannot silently run the reference runtime", async () => {
  const root = await mkdtemp(join(tmpdir(), "embody-request-only-"));
  cleanup.push(root);
  const app = await createApp({
    name: "hosted-app",
    destination: join(root, "app"),
    profile: "request-only",
    noInstall: true,
  });
  expect(await readFile(join(app.directory, "src/index.ts"), "utf8")).toContain(
    'process.env.EMBODY_HOST_PROFILE !== "hosted"',
  );
  expect(await readFile(join(app.directory, ".env.example"), "utf8")).toContain(
    "EMBODY_HOST_PROFILE=hosted",
  );
  expect(await readFile(join(app.directory, "README.md"), "utf8")).toContain("zero retention");
  // M14: the static declaration `embody deploy` submits.
  expect(JSON.parse(await readFile(join(app.directory, "package.json"), "utf8"))).toMatchObject({
    embody: { hosted: { profile: "request-only-v1" } },
  });
});

it("generates a durable starter with an event, a delayed step and queue settings", async () => {
  const root = await mkdtemp(join(tmpdir(), "embody-durable-"));
  cleanup.push(root);
  const app = await createApp({
    name: "durable-app",
    destination: join(root, "app"),
    profile: "durable",
    noInstall: true,
  });
  const config = await readFile(join(app.directory, "embody.config.ts"), "utf8");
  expect(config).toContain('ctx.events.publish("app.submitted"');
  expect(config).toContain("delayMs: 60 * 60_000");
  expect(await readFile(join(app.directory, "src/index.ts"), "utf8")).toContain(
    'process.env.EMBODY_HOSTED_PROFILE !== "durable"',
  );
  const env = await readFile(join(app.directory, ".env.example"), "utf8");
  for (const name of [
    "EMBODY_HOSTED_PROFILE=durable",
    "EMBODY_WAKE_QUEUE=",
    "EMBODY_DRAIN_URL=https://",
    "EMBODY_DRAIN_AUDIENCE=https://",
    "EMBODY_DRAIN_INVOKER_EMAIL=",
  ])
    expect(env).toContain(name);
  expect(await readFile(join(app.directory, "README.md"), "utf8")).toContain("at least once");
  // Workflows and a subscription (the `app.submitted` handler); no `publishes` declared.
  expect(JSON.parse(await readFile(join(app.directory, "package.json"), "utf8"))).toMatchObject({
    embody: {
      hosted: { profile: "durable-v1", workflows: true, events: false, subscriptions: true },
    },
  });
});

it("rejects traversal and preserves nonempty destinations", async () => {
  const root = await mkdtemp(join(tmpdir(), "embody-scaffold-"));
  cleanup.push(root);
  await expect(createApp({ name: "../bad", destination: root })).rejects.toThrow(/Project name/);
  const destination = join(root, "existing");
  await mkdir(destination);
  await writeFile(join(destination, "keep"), "keep");
  await expect(createApp({ name: "good", destination })).rejects.toThrow(/Destination/);
  expect(await readFile(join(destination, "keep"), "utf8")).toBe("keep");
});
