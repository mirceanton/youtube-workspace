import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Component } from "./DashboardPage.tsx";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function dashboardFixture() {
  return {
    ideas: {
      total: 1,
      by_stage: {
        inbox: 1,
        shortlisted: 0,
        scripting: 0,
        filming: 0,
        editing: 0,
        published: 0,
        dropped: 0,
      },
    },
    running_experiments: [
      {
        id: "018f0f9f-cc8a-7b2a-9a0d-111111111111",
        video_id: "018f0f9f-cc8a-7b2a-9a0d-222222222222",
        video_title: "Dashboard video",
        type: "title",
        hypothesis: "A shorter title will help.",
        starts_at: "2026-10-03T12:00:00.000Z",
        variants: [
          { label: "A", is_control: true },
          { label: "B", is_control: false },
        ],
      },
    ],
    latest_videos: [
      {
        id: "018f0f9f-cc8a-7b2a-9a0d-333333333333",
        title: "Dashboard video",
        youtube_id: "T47Dashbrd1",
        published_at: "2026-10-03T12:00:00.000Z",
        views: "1200",
        impressions: "9000",
        ctr: "4.2",
        avg_view_duration_s: "154",
      },
    ],
    recent_activity: [
      {
        id: "018f0f9f-cc8a-7b2a-9a0d-444444444444",
        created_at: "2026-10-04T12:00:00.000Z",
        actor: "analysis-agent",
        actor_type: "agent",
        action: "update",
        entity_type: "ideas",
        entity_id: "018f0f9f-cc8a-7b2a-9a0d-111111111111",
        payload: {},
      },
    ],
  };
}

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchInterval: false } },
  });
  return {
    client,
    ...render(
      <MemoryRouter>
        <QueryClientProvider client={client}>
          <Component />
        </QueryClientProvider>
      </MemoryRouter>,
    ),
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("Dashboard page", () => {
  it("renders the pipeline, running tests, headline metrics and human/agent activity", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(dashboardFixture())));
    renderPage();

    expect(await screen.findByText("Idea pipeline")).toBeInTheDocument();
    expect(screen.getByText("1 ideas")).toBeInTheDocument();
    expect(screen.getAllByText("Dashboard video")).toHaveLength(2);
    expect(screen.getByText("1.2K")).toBeInTheDocument();
    expect(screen.getByText("Agent")).toBeInTheDocument();
  });

  it("shows empty states for collections with no data", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          ...dashboardFixture(),
          running_experiments: [],
          latest_videos: [],
          recent_activity: [],
        }),
      ),
    );
    renderPage();

    expect(await screen.findByText("No running experiments")).toBeInTheDocument();
    expect(screen.getByText("No published videos yet")).toBeInTheDocument();
    expect(screen.getByText("No recent activity")).toBeInTheDocument();
  });

  it("shows an unavailable title when videos are not readable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          ...dashboardFixture(),
          running_experiments: [
            { ...dashboardFixture().running_experiments[0], video_title: null },
          ],
          latest_videos: null,
        }),
      ),
    );
    renderPage();

    expect(await screen.findByText("Video title unavailable")).toBeInTheDocument();
    expect(screen.queryByText("Dashboard video")).not.toBeInTheDocument();
  });

  it("shows loading and retryable error states", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() => new Promise<Response>(() => undefined)),
    );
    const pending = renderPage();
    expect(screen.getByText("Loading dashboard")).toBeInTheDocument();
    pending.unmount();
    pending.client.clear();

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ error: "Database unavailable" }, 503)),
    );
    renderPage();
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("Database unavailable"),
    );
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });
});
