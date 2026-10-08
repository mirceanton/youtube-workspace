import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Component } from "./SearchPage.tsx";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

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

describe("Search page", () => {
  it("renders matches as text and safe highlights without interpreting markup", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          results: [
            {
              entity_type: "idea",
              id: "018f0f9f-cc8a-7b2a-9a0d-111111111111",
              idea_id: "018f0f9f-cc8a-7b2a-9a0d-111111111111",
              kind: null,
              version: null,
              title: "Nebula idea",
              rank: 0.7,
              snippet: "Safe text ⟦<script>⟧",
            },
          ],
        }),
      ),
    );
    const user = userEvent.setup();
    renderPage();
    await user.type(screen.getByLabelText("Search the workspace"), "nebula");
    await user.click(screen.getByRole("button", { name: "Search" }));

    expect(await screen.findByText("Nebula idea")).toBeInTheDocument();
    expect(screen.getByText("<script>", { selector: "mark" })).toBeInTheDocument();
    expect(document.querySelector("script")).not.toBeInTheDocument();
  });

  it("shows empty, loading and retryable error states", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ results: [] })));
    const user = userEvent.setup();
    renderPage();
    expect(screen.getByText("Search ideas and scripts")).toBeInTheDocument();
    await user.type(screen.getByLabelText("Search the workspace"), "nothing");
    await user.click(screen.getByRole("button", { name: "Search" }));
    expect(await screen.findByText("No matches found")).toBeInTheDocument();
    cleanup();

    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() => new Promise<Response>(() => undefined)),
    );
    const pending = renderPage();
    const pendingUser = userEvent.setup();
    await pendingUser.type(screen.getByLabelText("Search the workspace"), "waiting");
    await pendingUser.click(screen.getByRole("button", { name: "Search" }));
    expect(screen.getByText("Searching")).toBeInTheDocument();
    pending.unmount();

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ error: "Search unavailable" }, 503)),
    );
    const errorUser = userEvent.setup();
    renderPage();
    await errorUser.type(screen.getByLabelText("Search the workspace"), "broken");
    await errorUser.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Search unavailable"));
  });
});
