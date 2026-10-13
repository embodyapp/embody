import { Readable } from "node:stream";
import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ resolve: vi.fn(), request: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: mocks.resolve }));
vi.mock("node:https", () => ({ request: mocks.request }));
import { publicEndpointFetch } from "../src/safe-fetch.js";
beforeEach(() => {
  mocks.resolve.mockReset();
  mocks.request.mockReset();
});

it("M07.c pins the validated DNS answer to the actual socket lookup, retaining TLS hostname", async () => {
  mocks.resolve
    .mockResolvedValueOnce([{ address: "8.8.8.8", family: 4 }])
    .mockResolvedValueOnce([{ address: "169.254.169.254", family: 4 }]);
  mocks.request.mockImplementation(
    (
      url: URL,
      options: {
        family: number;
        lookup: (
          host: string,
          options: object,
          callback: (error: unknown, address: string, family: number) => void,
        ) => void;
      },
      respond: (response: Readable) => void,
    ) => {
      expect(url.hostname).toBe("deployment.example");
      expect(options.family).toBe(4);
      const connected = vi.fn();
      options.lookup(url.hostname, {}, connected);
      expect(connected).toHaveBeenCalledWith(null, "8.8.8.8", 4);
      return {
        on: vi.fn(),
        end: () =>
          respond(
            Object.assign(Readable.from([Buffer.from("{}")]), { statusCode: 200, headers: {} }),
          ),
      };
    },
  );
  expect(await (await publicEndpointFetch("https://deployment.example/execute")).json()).toEqual(
    {},
  );
  expect(mocks.resolve).toHaveBeenCalledTimes(1);
  await expect(publicEndpointFetch("https://deployment.example/execute")).rejects.toThrow(
    "prohibited address",
  );
  expect(mocks.request).toHaveBeenCalledTimes(1);
});

it.each([204, 205, 199])(
  "M07.c handles bodyless/invalid HTTPS status %s without uncaught callback errors",
  async (status) => {
    mocks.resolve.mockResolvedValue([{ address: "8.8.8.8", family: 4 }]);
    mocks.request.mockImplementation(
      (_url: URL, _options: object, respond: (response: Readable) => void) => ({
        on: vi.fn(),
        end: () => respond(Object.assign(Readable.from([]), { statusCode: status, headers: {} })),
      }),
    );
    if (status < 200)
      await expect(publicEndpointFetch("https://deployment.example/execute")).rejects.toThrow();
    else expect((await publicEndpointFetch("https://deployment.example/execute")).body).toBeNull();
  },
);

it("M07.c rejects mixed public/private DNS answers before any connection", async () => {
  mocks.resolve.mockResolvedValue([
    { address: "8.8.8.8", family: 4 },
    { address: "169.254.169.254", family: 4 },
  ]);
  await expect(publicEndpointFetch("https://deployment.example/execute")).rejects.toThrow(
    "prohibited address",
  );
  expect(mocks.request).not.toHaveBeenCalled();
});
