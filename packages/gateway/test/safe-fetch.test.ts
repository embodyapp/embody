import { describe, expect, it, vi } from "vitest";
import { boundedFetch, publicAddress, publicEndpointFetch } from "../src/safe-fetch.js";

describe("M07 connection and response safety", () => {
  it.each([
    "127.0.0.1",
    "0.0.0.0",
    "10.1.1.1",
    "172.16.1.1",
    "192.168.1.1",
    "169.254.169.254",
    "100.100.100.200",
    "198.18.0.1",
    "224.0.0.1",
    "::1",
    "::ffff:127.0.0.1",
    "fe80::1",
    "fc00::1",
    "2001:db8::1",
    "2001:0DB8:0:0:0:0:0:1",
    "2001::1",
    "2002:7f00:1::1",
    "3fff::1",
  ])("rejects nonpublic %s", (address) => {
    expect(publicAddress(address)).toBe(false);
  });
  it.each(["8.8.8.8", "2606:4700:4700::1111"])("admits public %s", (address) => {
    expect(publicAddress(address)).toBe(true);
  });
  it("rejects metadata and arbitrary protocols before opening a socket", async () => {
    await expect(publicEndpointFetch("https://169.254.169.254/execute")).rejects.toThrow(
      "prohibited address",
    );
    await expect(publicEndpointFetch("http://example.com/execute")).rejects.toThrow("HTTPS");
    await expect(publicEndpointFetch("https://example.com:8443/execute")).rejects.toThrow("443");
  });
  it("does not follow redirects or retry", async () => {
    const transport = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response(null, { status: 302, headers: { location: "http://169.254.169.254" } }),
      ),
    );
    await expect(boundedFetch(transport)("https://one.example")).rejects.toThrow("redirects");
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("bounds cumulative response bytes", async () => {
    let cancelled = false;
    const transport: typeof fetch = () =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              controller.enqueue(new Uint8Array(16));
            },
            cancel() {
              cancelled = true;
            },
          }),
        ),
      );
    const response = await boundedFetch(transport, 1000, 32)("https://one.example");
    await expect(response.text()).rejects.toThrow("exceeds limit");
    expect(cancelled).toBe(true);
  });
  it("bounds stalled headers and bodies including cold start", async () => {
    const stalled: typeof fetch = () => new Promise(() => undefined);
    await expect(boundedFetch(stalled, 20)("https://one.example")).rejects.toThrow("deadline");
    const transport: typeof fetch = () =>
      Promise.resolve(new Response(new ReadableStream<Uint8Array>()));
    const response = await boundedFetch(transport, 20)("https://one.example");
    await expect(response.text()).rejects.toThrow("deadline");
  });
  it("controlled cold response succeeds within budget", async () => {
    const transport: typeof fetch = async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return Response.json({ ok: true });
    };
    expect(await (await boundedFetch(transport, 1000)("https://one.example")).json()).toEqual({
      ok: true,
    });
  });
});
