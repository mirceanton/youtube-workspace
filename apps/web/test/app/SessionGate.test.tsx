import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { SessionGate } from "../../src/app/SessionGate.tsx";

const OWNER = {
  user: { id: "u", username: "owner", displayName: "Owner", email: "o@x.test", isAdmin: true },
  levels: {
    ideas: "write",
    scripts: "write",
    experiments: "write",
    videos: "write",
    notes: "write",
    activity: "read",
  },
};
const NO_ACCESS = {
  ...OWNER,
  user: { ...OWNER.user, isAdmin: false },
  levels: {
    ideas: "none",
    scripts: "none",
    experiments: "none",
    videos: "none",
    notes: "none",
    activity: "none",
  },
};

function renderGate(me: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async () => Response.json(me, { headers: { "X-CSRF-Token": "t" } })),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <SessionGate>
          <p>the app</p>
        </SessionGate>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("SessionGate", () => {
  it("renders the app for a user with access", async () => {
    renderGate(OWNER);
    expect(await screen.findByText("the app")).toBeInTheDocument();
  });

  it("shows 'access not granted' when the user has no access to anything", async () => {
    renderGate(NO_ACCESS);
    expect(await screen.findByText("Access not granted yet")).toBeInTheDocument();
    expect(screen.queryByText("the app")).toBeNull();
  });

  it("fails closed when /api/me is in a shape this build cannot read", async () => {
    renderGate({ user: {}, levels: {} });
    expect(await screen.findByText(/new version/i)).toBeInTheDocument();
    expect(screen.queryByText("the app")).toBeNull();
  });
});
