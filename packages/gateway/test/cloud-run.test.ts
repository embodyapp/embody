import { generateKeyPair, SignJWT } from "jose";
import { expect, it, vi } from "vitest";
import { cloudRunInvocationToken } from "../src/index.js";

const email = "gateway@fixture-project.iam.gserviceaccount.com";
const origin = "https://admitted-app.a.run.app";
const now = 1_800_000_000_000;
const pair = await generateKeyPair("RS256");
const mint = (overrides: Record<string, unknown> = {}) =>
  new SignJWT({
    iss: "https://accounts.google.com",
    aud: origin,
    email,
    email_verified: true,
    iat: now / 1000,
    exp: now / 1000 + 3600,
    ...overrides,
  })
    .setProtectedHeader({ alg: "RS256" })
    .sign(pair.privateKey);
const response = (token: string) =>
  new Response(token, { headers: { "Metadata-Flavor": "Google" } });

it("uses only gateway metadata identity with exact origin and bounded cache/refresh", async () => {
  let clock = now;
  const token = await mint();
  const fetcher = vi.fn<typeof fetch>(() => Promise.resolve(response(token)));
  const invoke = cloudRunInvocationToken({
    serviceAccountEmail: email,
    fetch: fetcher,
    now: () => clock,
  });
  expect(await invoke(origin)).toBe(token);
  expect(await invoke(origin)).toBe(token);
  expect(fetcher).toHaveBeenCalledTimes(1);
  const [url, init] = fetcher.mock.calls[0]!;
  expect(url instanceof URL ? url.href : typeof url === "string" ? url : url.url).toBe(
    `http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity?audience=${encodeURIComponent(origin)}&format=full`,
  );
  expect(new Headers(init!.headers).get("Metadata-Flavor")).toBe("Google");
  expect(init!.redirect).toBe("error");
  clock += 3_540_000;
  fetcher.mockRejectedValue(new Error("metadata unavailable"));
  await expect(invoke(origin)).rejects.toThrow("metadata unavailable");
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it("rejects wrong identity/audience/lifetime, missing metadata flavor, unsafe origins and redirects", async () => {
  for (const override of [
    { email: "runtime@fixture-project.iam.gserviceaccount.com" },
    { aud: "https://other-app.a.run.app" },
    { iss: "attacker" },
    { exp: now / 1000 },
    { iat: now / 1000 + 60 },
    { exp: now / 1000 + 7200 },
    { email_verified: false },
  ]) {
    const token = await mint(override);
    await expect(
      cloudRunInvocationToken({
        serviceAccountEmail: email,
        now: () => now,
        fetch: () => Promise.resolve(response(token)),
      })(origin),
    ).rejects.toThrow();
  }
  for (const reply of [
    new Response(await mint()),
    new Response("redirect", { status: 302 }),
    new Response("forbidden", { status: 403 }),
  ])
    await expect(
      cloudRunInvocationToken({
        serviceAccountEmail: email,
        now: () => now,
        fetch: () => Promise.resolve(reply),
      })(origin),
    ).rejects.toThrow("unavailable");
  const skewToken = await mint({ iat: now / 1000 + 3 });
  await expect(
    cloudRunInvocationToken({
      serviceAccountEmail: email,
      now: () => now,
      fetch: () => Promise.resolve(response(skewToken)),
    })(origin),
  ).resolves.toBe(skewToken);
  const fetcher = vi.fn<typeof fetch>();
  const invoke = cloudRunInvocationToken({ serviceAccountEmail: email, fetch: fetcher });
  for (const unsafe of [
    "http://app.example",
    "https://custom-domain.example",
    "https://app.example/path",
    "https://user:pass@app.example",
    "https://app.example/?query=1",
  ])
    await expect(invoke(unsafe)).rejects.toThrow("HTTPS origin");
  expect(fetcher).not.toHaveBeenCalled();
  expect(() => cloudRunInvocationToken({ serviceAccountEmail: "user@example.com" })).toThrow();
});
