import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Component } from "./ActivityPage.tsx";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const event = (actor: string, actorType: "human" | "agent", id: string) => ({
  id,
  created_at: "2026-10-04T12:00:00.000Z",
  actor,
  actor_type: actorType,
  token_id: null,
  action: "insert",
  entity_type: "ideas",
  entity_id: "018f0f9f-cc8a-7b2a-9a0d-111111111111",
  payload: {},
});

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchInterval: false } },
  });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <Component />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("Activity page", () => {
  it("shows people and agents together and exposes filter controls", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          events: [
            event("alex", "human", "018f0f9f-cc8a-7b2a-9a0d-111111111111"),
            event("outline-agent", "agent", "018f0f9f-cc8a-7b2a-9a0d-222222222222"),
          ],
          next_cursor: null,
        }),
      ),
    );
    renderPage();

    expect(await screen.findByText("alex")).toBeInTheDocument();
    expect(screen.getByText("outline-agent")).toBeInTheDocument();
    expect(screen.getAllByText("Human")).toHaveLength(2);
    expect(screen.getAllByText("Agent")).toHaveLength(2);
    expect(screen.getByLabelText("Actor type")).toBeInTheDocument();
    expect(screen.getByLabelText("Entity type")).toBeInTheDocument();
    expect(screen.getByLabelText("From date")).toBeInTheDocument();
  });

  it("sends actor, entity and date filters to the activity endpoint", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ events: [], next_cursor: null }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    renderPage();

    await user.type(screen.getByLabelText("Actor"), "analysis-agent");
    await user.selectOptions(screen.getByLabelText("Actor type"), "agent");
    await user.selectOptions(screen.getByLabelText("Entity type"), "script");
    await user.type(screen.getByLabelText("Entity ID"), "018f0f9f-cc8a-7b2a-9a0d-111111111111");
    fireEvent.change(screen.getByLabelText("From date"), { target: { value: "2026-10-03" } });
    fireEvent.change(screen.getByLabelText("To date"), { target: { value: "2026-10-04" } });

    await waitFor(() => {
      const requestHasEveryFilter = fetchMock.mock.calls.some(([input]) => {
        const params = new URL(String(input), "http://example.test").searchParams;
        return (
          params.get("actor") === "analysis-agent" &&
          params.get("actor_type") === "agent" &&
          params.get("entity_type") === "script" &&
          params.get("entity_id") === "018f0f9f-cc8a-7b2a-9a0d-111111111111" &&
          params.has("from") &&
          params.has("to")
        );
      });
      expect(requestHasEveryFilter).toBe(true);
    });
  });

  it("shows empty, loading and retryable error states", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ events: [], next_cursor: null })),
    );
    renderPage();
    expect(await screen.findByText("No activity matches these filters")).toBeInTheDocument();

    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() => new Promise<Response>(() => undefined)),
    );
    const pending = renderPage();
    expect(screen.getByText("Loading activity")).toBeInTheDocument();
    pending.unmount();

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ error: "Service unavailable" }, 503)),
    );
    renderPage();
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Service unavailable"));
  });
});
