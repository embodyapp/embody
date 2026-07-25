// @vitest-environment happy-dom
/**
 * The hooks, rendered.
 *
 * Deliberately small: `cache.test.ts` already covers the state machine, and this file
 * covers only what cannot be seen without React — the StrictMode double-mount (which
 * must still issue ONE request) and an optimistic row that survives until a veto sends
 * it back. Those two fail silently in every other kind of test.
 *
 * Run: `pnpm --filter @embody/react exec vitest run`
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { StrictMode } from "react";
import type { ReactNode } from "react";
import { render, screen, waitFor, act, cleanup } from "@testing-library/react";
import { EmbodyProvider } from "./context.ts";
import { useToolQuery, useToolMutation } from "./use-tool.ts";
import { useCan, useIdentity } from "./use-identity.ts";
import { EmbodyError } from "./types.ts";
import type { EmbodyClient } from "./client.ts";
import type { Identity } from "./types.ts";

// No vitest config in this repo, so testing-library's automatic cleanup (which needs
// `globals: true`) is wired by hand — otherwise every render leaks into the next test.
afterEach(cleanup);

const VIEWER: Identity = {
  principal: { orgId: "o", userId: "u", roles: ["viewer"] },
  permissions: [{ action: "read", resource: "*" }],
  source: "session",
};

const OWNER: Identity = {
  principal: { orgId: "o", userId: "u", roles: ["owner"] },
  permissions: [{ action: "*", resource: "*" }],
  source: "session",
};

/** A client with no network: every method is a spy the test controls. */
function fakeClient(overrides: Partial<EmbodyClient> = {}): EmbodyClient {
  return {
    baseUrl: "/api",
    call: vi.fn(async () => undefined as never),
    tools: vi.fn(async () => []),
    me: vi.fn(async () => null),
    login: vi.fn(async () => OWNER),
    logout: vi.fn(async () => undefined),
    ...overrides,
  } as EmbodyClient;
}

const wrap = (client: EmbodyClient, ui: ReactNode, strict = false) => {
  const tree = <EmbodyProvider client={client}>{ui}</EmbodyProvider>;
  return render(strict ? <StrictMode>{tree}</StrictMode> : tree);
};

function Deals() {
  const { data, status, error } = useToolQuery<"crm_query_deals">("crm_query_deals", {
    limit: 50,
  } as never);
  if (status === "loading") return <p>loading</p>;
  if (error) return <p>error: {error.kind}</p>;
  return <ul>{(data as { id: string }[] | undefined)?.map((d) => <li key={d.id}>{d.id}</li>)}</ul>;
}

describe("useToolQuery", () => {
  it("goes loading -> success and renders the result", async () => {
    const client = fakeClient({ call: vi.fn(async () => [{ id: "deal-1" }] as never) });
    wrap(client, <Deals />);

    expect(screen.getByText("loading")).toBeTruthy();
    await waitFor(() => expect(screen.getByText("deal-1")).toBeTruthy());
  });

  it("issues exactly one request under StrictMode's double mount", async () => {
    // React 18/19 dev mounts, unmounts and remounts every effect. Aborting on unmount
    // would cancel the request the remount needs; deduping is what makes it correct.
    const call = vi.fn(async () => [{ id: "deal-1" }] as never);
    wrap(fakeClient({ call }), <Deals />, true);

    await waitFor(() => expect(screen.getByText("deal-1")).toBeTruthy());
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("shares one request between two components reading the same query", async () => {
    const call = vi.fn(async () => [{ id: "deal-1" }] as never);
    wrap(
      fakeClient({ call }),
      <>
        <Deals />
        <Deals />
      </>,
    );
    await waitFor(() => expect(screen.getAllByText("deal-1")).toHaveLength(2));
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("does not refetch for a component that mounts after the data arrived", async () => {
    // useCan/useIdentity and a second list are extra subscribers, not extra requests.
    const call = vi.fn(async () => [{ id: "deal-1" }] as never);
    const client = fakeClient({ call });
    const { rerender } = wrap(client, <Deals />);
    await waitFor(() => expect(screen.getByText("deal-1")).toBeTruthy());

    rerender(
      <EmbodyProvider client={client}>
        <Deals />
        <Deals />
      </EmbodyProvider>,
    );
    await waitFor(() => expect(screen.getAllByText("deal-1")).toHaveLength(2));
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("surfaces a failure as a typed error", async () => {
    const client = fakeClient({
      call: vi.fn(async () => {
        throw new EmbodyError({ kind: "denied", message: "no", status: 403 });
      }),
    });
    wrap(client, <Deals />);
    await waitFor(() => expect(screen.getByText("error: denied")).toBeTruthy());
  });
});

function Pipeline() {
  const { data } = useToolQuery<"crm_query_deals">("crm_query_deals", { limit: 50 } as never);
  const close = useToolMutation<"crm_update_deal">("crm_update_deal", {
    invalidates: ["crm_query_deals"],
    optimistic: (input, tx) => {
      tx.patch<{ id: string; stage: string }[]>("crm_query_deals", (rows) =>
        (rows ?? []).map((row) =>
          row.id === (input as { id: string }).id ? { ...row, stage: "closed_won" } : row,
        ),
      );
    },
  });

  return (
    <div>
      <p data-testid="stage">{(data as { stage: string }[] | undefined)?.[0]?.stage ?? "-"}</p>
      {close.error ? <p data-testid="veto">{close.error.message}</p> : null}
      <button
        onClick={() => {
          void close.mutate({ id: "deal-1", stage: "closed_won" } as never);
        }}
      >
        close
      </button>
    </div>
  );
}

describe("useToolMutation", () => {
  it("shows the optimistic value, then rolls back when a rule vetoes", async () => {
    const veto = new EmbodyError({
      kind: "veto",
      message: "Enterprise deals over $50,000 require an approved Security Review.",
      status: 409,
    });
    let block!: () => void;
    const gate = new Promise<void>((resolve) => {
      block = resolve;
    });

    const client = fakeClient({
      call: vi.fn(async (name: string) => {
        if (name === "crm_query_deals") return [{ id: "deal-1", stage: "lead" }] as never;
        await gate;
        throw veto;
      }) as EmbodyClient["call"],
    });

    wrap(client, <Pipeline />);
    await waitFor(() => expect(screen.getByTestId("stage").textContent).toBe("lead"));

    await act(async () => {
      screen.getByText("close").click();
    });
    // The row moves immediately — that is the point of the optimistic patch.
    expect(screen.getByTestId("stage").textContent).toBe("closed_won");

    await act(async () => {
      block();
      await Promise.resolve();
    });

    // ...and snaps back, with the rule's own words available to show the user.
    await waitFor(() => expect(screen.getByTestId("stage").textContent).toBe("lead"));
    expect(screen.getByTestId("veto").textContent).toMatch(/Security Review/);
  });

  it("revalidates the invalidated query after a successful write", async () => {
    let stage = "lead";
    const call = vi.fn(async (name: string) => {
      if (name === "crm_query_deals") return [{ id: "deal-1", stage }] as never;
      stage = "closed_won";
      return { id: "deal-1", stage } as never;
    }) as EmbodyClient["call"];

    wrap(fakeClient({ call }), <Pipeline />);
    await waitFor(() => expect(screen.getByTestId("stage").textContent).toBe("lead"));

    await act(async () => {
      screen.getByText("close").click();
    });

    await waitFor(() => expect(screen.getByTestId("stage").textContent).toBe("closed_won"));
    // The list was re-read from the server rather than left on the optimistic guess.
    expect(call).toHaveBeenCalledWith("crm_query_deals", { limit: 50 }, expect.anything());
  });
});

function Guard() {
  const { status } = useIdentity();
  const canWrite = useCan("write", "crm:deal");
  return (
    <p data-testid="guard">
      {status}:{canWrite ? "write" : "read-only"}
    </p>
  );
}

describe("useCan", () => {
  it("is read-only until identity arrives, then reflects the grants", async () => {
    const client = fakeClient({ me: vi.fn(async () => OWNER) });
    wrap(client, <Guard />);
    // Better a control that enables a moment late than one that flickers off.
    expect(screen.getByTestId("guard").textContent).toBe("loading:read-only");
    await waitFor(() =>
      expect(screen.getByTestId("guard").textContent).toBe("success:write"),
    );
  });

  it("keeps a viewer read-only", async () => {
    wrap(fakeClient({ me: vi.fn(async () => VIEWER) }), <Guard />);
    await waitFor(() =>
      expect(screen.getByTestId("guard").textContent).toBe("success:read-only"),
    );
  });

  it("treats an anonymous caller as read-only, not as an error", async () => {
    wrap(fakeClient({ me: vi.fn(async () => null) }), <Guard />);
    await waitFor(() =>
      expect(screen.getByTestId("guard").textContent).toBe("success:read-only"),
    );
  });
});
