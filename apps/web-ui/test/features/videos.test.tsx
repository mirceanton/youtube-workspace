import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  MetricSnapshot,
  Video,
  VideoDetailResponse,
  VideoPerformance,
} from "@ytw/shared/api/videos";
import { createMemoryRouter, RouterProvider } from "react-router";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Component as VideoDetailPage } from "../../src/features/videos/VideoDetailPage.tsx";
import { VideoEditorDialog } from "../../src/features/videos/VideoEditorDialog.tsx";
import { Component as VideosPage } from "../../src/features/videos/VideosPage.tsx";
import {
  metricsToChartSeries,
  retentionToChartSeries,
} from "../../src/features/videos/chart-data.ts";
import { videoWatchUrl } from "../../src/features/videos/api.ts";
import { sortVideos } from "../../src/features/videos/sorting.ts";
import { setCsrfToken } from "../../src/lib/csrf.ts";
import { SessionContext } from "../../src/lib/session.ts";
import { createTestQueryClient, sessionWith } from "../helpers/render.tsx";

const VIDEO_ID = "0199c2a4-7b1e-7c3a-9d2f-000000000001";
const IDEA_ID = "0199c2a4-7b1e-7c3a-9d2f-000000000002";
const NOW = "2026-10-04T10:00:00.000Z";

function video(overrides: Partial<Video> = {}): Video {
  return {
    id: VIDEO_ID,
    idea_id: IDEA_ID,
    youtube_id: "dQw4w9WgXcQ",
    title: "A measured video",
    published_at: NOW,
    thumbnail_url: null,
    version: 2,
    archived_at: null,
    created_at: NOW,
    updated_at: NOW,
    created_by: "alice",
    updated_by: "alice",
    ...overrides,
  };
}

function performance(overrides: Partial<VideoPerformance> = {}): VideoPerformance {
  return {
    id: VIDEO_ID,
    idea_id: IDEA_ID,
    youtube_id: "dQw4w9WgXcQ",
    title: "A measured video",
    published_at: NOW,
    thumbnail_url: null,
    latest: {
      id: "0199c2a4-7b1e-7c3a-9d2f-000000000011",
      captured_at: NOW,
      views: "1200",
      impressions: "5000",
      ctr: "4.5",
      avg_view_duration_s: "132",
      avg_view_pct: "42",
      watch_time_min: "2640",
      subs_gained: 4,
    },
    median: {
      sample_size: 3,
      views: "1000",
      impressions: "4000",
      ctr: "4.0",
      avg_view_duration_s: "120",
      avg_view_pct: "40",
      watch_time_min: "2000",
      subs_gained: "2",
    },
    vs_median: {
      views: "200",
      impressions: "1000",
      ctr: "0.5",
      avg_view_duration_s: "12",
      avg_view_pct: "2",
      watch_time_min: "640",
      subs_gained: "2",
    },
    ...overrides,
  };
}

function snapshot(overrides: Partial<MetricSnapshot> = {}): MetricSnapshot {
  return {
    id: "0199c2a4-7b1e-7c3a-9d2f-000000000021",
    video_id: VIDEO_ID,
    captured_at: NOW,
    views: "1200",
    impressions: null,
    ctr: null,
    avg_view_duration_s: null,
    avg_view_pct: null,
    watch_time_min: null,
    subs_gained: null,
    retention: null,
    created_at: NOW,
    created_by: "alice",
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function renderWithRouter(
  element: ReactNode,
  path: string,
  session = sessionWith({ videos: "read", ideas: "read" }),
) {
  const router = createMemoryRouter([{ path, element }], {
    initialEntries: [path.replace(":videoId", VIDEO_ID)],
  });
  return render(
    <QueryClientProvider client={createTestQueryClient()}>
      <SessionContext value={session}>
        <RouterProvider router={router} />
      </SessionContext>
    </QueryClientProvider>,
  );
}

afterEach(() => setCsrfToken(undefined));

describe("Videos feature UI", () => {
  it("turns sparse metric snapshots into chart gaps and handles empty and large history", () => {
    expect(metricsToChartSeries([])).toEqual([
      { label: "Views", points: [] },
      { label: "CTR", points: [] },
      { label: "Average view duration (seconds)", points: [] },
    ]);
    const sparse = metricsToChartSeries([
      snapshot({ captured_at: "2026-10-01T10:00:00.000Z", views: "12", ctr: null }),
      snapshot({
        captured_at: "2026-10-02T10:00:00.000Z",
        views: null,
        ctr: "4.3",
        avg_view_duration_s: "98",
      }),
    ]);
    expect(sparse[0]?.points.map((point) => point.y)).toEqual([12, null]);
    expect(sparse[1]?.points.map((point) => point.y)).toEqual([null, 4.3]);
    expect(sparse[2]?.points.map((point) => point.y)).toEqual([null, 98]);

    const large = Array.from({ length: 1500 }, (_, index) =>
      snapshot({
        captured_at: new Date(Date.UTC(2026, 0, 1 + index)).toISOString(),
        views: String(index),
      }),
    );
    expect(metricsToChartSeries(large)[0]?.points).toHaveLength(1500);
    expect(retentionToChartSeries(null)[0]?.points).toEqual([]);
    expect(
      retentionToChartSeries([
        { t: 0, pct: 100 },
        { t: 45, pct: 67 },
      ])[0]?.points,
    ).toEqual([
      { x: 0, y: 100 },
      { x: 45, y: 67 },
    ]);
  });

  it("sorts latest metrics accurately, including large integer counts and missing values", () => {
    const high = performance({
      id: "0199c2a4-7b1e-7c3a-9d2f-000000000031",
      title: "Higher reach",
      latest: { ...performance().latest!, views: "90071992547409930" },
    });
    const low = performance({
      id: "0199c2a4-7b1e-7c3a-9d2f-000000000032",
      title: "Lower reach",
      latest: { ...performance().latest!, views: "9" },
    });
    const missing = performance({
      id: "0199c2a4-7b1e-7c3a-9d2f-000000000033",
      title: "No metrics",
      latest: null,
    });
    expect(sortVideos([low, high, missing], "views", "desc").map((item) => item.title)).toEqual([
      "Higher reach",
      "Lower reach",
      "No metrics",
    ]);
    expect(sortVideos([low, high], "title", "asc").map((item) => item.title)).toEqual([
      "Higher reach",
      "Lower reach",
    ]);
    const highImpressions = performance({
      id: "0199c2a4-7b1e-7c3a-9d2f-000000000034",
      title: "Higher impressions",
      latest: { ...performance().latest!, impressions: "90071992547409930" },
    });
    const lowImpressions = performance({
      id: "0199c2a4-7b1e-7c3a-9d2f-000000000035",
      title: "Lower impressions",
      latest: { ...performance().latest!, impressions: "9" },
    });
    expect(
      sortVideos([lowImpressions, highImpressions], "impressions", "desc").map(
        (item) => item.title,
      ),
    ).toEqual(["Higher impressions", "Lower impressions"]);
  });

  it("shows mobile cards and a sortable desktop table with latest metrics and median deltas", async () => {
    vi.stubGlobal("fetch", async () => jsonResponse({ videos: [performance()] }));
    const { container } = renderWithRouter(
      <VideosPage />,
      "/videos",
      sessionWith({ videos: "read" }),
    );
    const videoLinks = await screen.findAllByRole("link", { name: "A measured video" });
    expect(videoLinks[0]).toHaveAttribute("href", `/videos/${VIDEO_ID}`);
    expect(screen.getByRole("combobox", { name: "Sort videos" })).toBeInTheDocument();
    expect(screen.getAllByText("vs median +200").length).toBeGreaterThan(0);
    expect(screen.getAllByText("5,000").length).toBeGreaterThan(0);
    expect(screen.getAllByText("42%").length).toBeGreaterThan(0);
    expect(screen.getAllByText("2,640 min").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Subscribers gained").length).toBeGreaterThan(0);
    expect(screen.getAllByText("vs median +640 min").length).toBeGreaterThan(0);
    expect(screen.getAllByText("vs median +2").length).toBeGreaterThan(0);
    expect(container.querySelector(".md\\:hidden")).not.toBeNull();
    expect(container.querySelector(".hidden.md\\:block")).not.toBeNull();
    expect(screen.getByRole("columnheader", { name: /Views/ })).toHaveAttribute(
      "aria-sort",
      "none",
    );
  });

  it("registers a video and carries the current CSRF token on its mutation", async () => {
    setCsrfToken("video-csrf");
    let submitted: Record<string, unknown> | undefined;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname !== "/api/videos" || init?.method !== "POST")
        return jsonResponse({ error: "Unexpected request" }, 500);
      expect(new Headers(init.headers).get("X-CSRF-Token")).toBe("video-csrf");
      submitted = JSON.parse(String(init.body)) as Record<string, unknown>;
      return jsonResponse(
        { video: video({ title: "New registration", idea_id: null, version: 1 }) },
        201,
      );
    });
    const user = userEvent.setup();
    const onSaved = vi.fn<(saved: Video) => void>();
    renderWithRouter(
      <VideoEditorDialog open onClose={vi.fn<() => void>()} onSaved={onSaved} />,
      "/videos",
      sessionWith({ videos: "write" }),
    );
    await user.type(screen.getByRole("textbox", { name: "YouTube video ID" }), "dQw4w9WgXcQ");
    await user.type(screen.getByRole("textbox", { name: "Title" }), "New registration");
    await user.click(screen.getByRole("button", { name: "Register video" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(submitted).toMatchObject({
      youtube_id: "dQw4w9WgXcQ",
      title: "New registration",
      idea_id: null,
    });
  });

  it("shows a stale edit conflict and lets the editor reload the latest version", async () => {
    const latest = video({ title: "Updated elsewhere", version: 3 });
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PATCH")
        return jsonResponse({ error: "Version 2 is stale; version 3 exists.", latest }, 409);
      return jsonResponse({ error: "Unexpected request" }, 500);
    });
    const user = userEvent.setup();
    renderWithRouter(
      <VideoEditorDialog open video={video()} onClose={vi.fn<() => void>()} />,
      "/videos",
      sessionWith({ videos: "write" }),
    );
    const title = screen.getByRole("textbox", { name: "Title" });
    await user.clear(title);
    await user.type(title, "My unsaved edit");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    const conflict = await screen.findByRole("dialog", {
      name: "This video changed while you were editing",
    });
    expect(conflict).toHaveTextContent("Version 2 is stale; version 3 exists.");
    await user.click(within(conflict).getByRole("button", { name: "Discard mine and reload" }));
    expect(screen.getByRole("textbox", { name: "Title" })).toHaveValue("Updated elsewhere");
  });

  it("keeps YouTube links canonical and safe and links the readable originating idea", async () => {
    const detail: VideoDetailResponse = {
      video: video(),
      metrics: [],
      performance: null,
      idea: { id: IDEA_ID, title: "Originating idea" },
    };
    vi.stubGlobal("fetch", async () => jsonResponse(detail));
    renderWithRouter(
      <VideoDetailPage />,
      "/videos/:videoId",
      sessionWith({ videos: "read", ideas: "read" }),
    );
    const youtube = await screen.findByRole("link", { name: "Watch on YouTube" });
    expect(youtube).toHaveAttribute("href", "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    expect(youtube).toHaveAttribute("target", "_blank");
    expect(youtube).toHaveAttribute("rel", "noopener noreferrer");
    expect(screen.getByRole("link", { name: "Originating idea" })).toHaveAttribute(
      "href",
      `/ideas/${IDEA_ID}`,
    );
    expect(videoWatchUrl("javascript:xx")).toBeNull();
    expect(screen.getAllByText("No data yet").length).toBeGreaterThan(0);
  });
});
