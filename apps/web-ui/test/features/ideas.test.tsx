import { render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import userEvent from "@testing-library/user-event";
import type { Idea } from "@ytw/shared/api/ideas";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryRouter, RouterProvider } from "react-router";
import { Component as IdeasPage } from "../../src/features/ideas/IdeasPage.tsx";
import { Component as IdeaDetailPage } from "../../src/features/ideas/IdeaDetailPage.tsx";
import { StageMoveDialog } from "../../src/features/ideas/StageMoveDialog.tsx";
import { setCsrfToken } from "../../src/lib/csrf.ts";
import { SessionContext } from "../../src/lib/session.ts";
import { createTestQueryClient, renderWithSession, sessionWith } from "../helpers/render.tsx";

const IDEA_ID = "0199c2a4-7b1e-7c3a-9d2f-3b8a1c4e5f60";
const ARCHIVED_ID = "0199c2a4-7b1e-7c3a-9d2f-3b8a1c4e5f61";
const NOW = "2026-10-01T10:00:00.000Z";

function idea(overrides: Partial<Idea> = {}): Idea {
  return {
    id: IDEA_ID,
    title: "Audience research video",
    pitch: "Find overlooked questions.",
    status: "shortlisted",
    status_changed_at: NOW,
    age_in_stage_seconds: 120,
    days_in_stage: 0,
    score: 78,
    source: "Community poll",
    tags: ["research"],
    version: 2,
    archived_at: null,
    created_at: NOW,
    updated_at: NOW,
    created_by: "alice",
    updated_by: "alice",
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function recordFetch(handler: (url: URL, init?: RequestInit) => Response | Promise<Response>) {
  const requests: Array<{ url: URL; method: string; body?: unknown }> = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const method = (init?.method ?? "GET").toUpperCase();
    let body: unknown;
    if (typeof init?.body === "string") body = JSON.parse(init.body) as unknown;
    requests.push({ url, method, body });
    return handler(url, init);
  });
  return requests;
}

describe("Ideas UI", () => {
  afterEach(() => setCsrfToken(undefined));

  it("requires a note to move an idea backward and submits that note with the move", async () => {
    setCsrfToken("test-csrf");
    const requests = recordFetch((url, init) => {
      expect(url.pathname).toBe(`/api/ideas/${IDEA_ID}/stage`);
      expect(new Headers(init?.headers).get("X-CSRF-Token")).toBe("test-csrf");
      return jsonResponse({ idea: idea({ status: "inbox", version: 3 }) });
    });
    const onMoved = vi.fn<(moved: Idea) => void>();
    const user = userEvent.setup();
    renderWithSession(
      <StageMoveDialog
        idea={idea()}
        target="inbox"
        onClose={vi.fn<() => void>()}
        onMoved={onMoved}
      />,
    );

    const move = screen.getByRole("button", { name: "Move idea" });
    expect(
      screen.getByRole("textbox", { name: "Why is this idea moving backward?" }),
    ).toBeRequired();
    expect(move).toBeDisabled();
    await user.type(
      screen.getByRole("textbox", { name: "Why is this idea moving backward?" }),
      "Revisit after validating the audience data.",
    );
    expect(move).toBeEnabled();
    await user.click(move);

    await waitFor(() =>
      expect(onMoved).toHaveBeenCalledWith(expect.objectContaining({ status: "inbox" })),
    );
    expect(requests[0]).toMatchObject({
      method: "POST",
      body: {
        expected_version: 2,
        new_status: "inbox",
        note: "Revisit after validating the audience data.",
      },
    });
  });

  it("shows the optimistic conflict dialog with the latest idea after a stale stage move", async () => {
    setCsrfToken("test-csrf");
    const latest = idea({ title: "Updated title from another writer", version: 3 });
    recordFetch(() =>
      jsonResponse({ error: "The idea changed; reload the current version.", latest }, 409),
    );
    const user = userEvent.setup();
    renderWithSession(
      <StageMoveDialog
        idea={idea()}
        target="scripting"
        onClose={vi.fn<() => void>()}
        onMoved={vi.fn<(moved: Idea) => void>()}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Move idea" }));

    expect(
      await screen.findByRole("heading", { name: "This idea changed while you were editing" }),
    ).toBeInTheDocument();
    expect(screen.getByText("The idea changed; reload the current version.")).toBeInTheDocument();
    expect(screen.getByText("Updated title from another writer · Shortlisted")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Discard mine and reload" })).toBeInTheDocument();
  });

  it("applies filters and sort changes to the API query and disables moves on archived rows", async () => {
    const activeIdea = idea({ status: "inbox" });
    const archivedIdea = idea({
      id: ARCHIVED_ID,
      title: "Archived concept",
      archived_at: NOW,
      status: "inbox",
    });
    const requests = recordFetch((url) => {
      if (url.pathname === "/api/ideas") {
        const includeArchived = url.searchParams.get("include_archived") === "true";
        return jsonResponse({
          ideas: includeArchived ? [activeIdea, archivedIdea] : [activeIdea],
          page: { limit: 100, offset: 0, total: includeArchived ? 2 : 1 },
        });
      }
      return jsonResponse({ error: "Not found" }, 404);
    });
    const user = userEvent.setup();
    renderWithSession(<IdeasPage />, { session: sessionWith({ ideas: "write" }) });

    expect(await screen.findAllByText("Audience research video")).not.toHaveLength(0);
    await user.type(screen.getByRole("textbox", { name: "Filter by tag" }), "audience");
    await waitFor(() => {
      expect(
        requests.some(
          ({ url }) => url.pathname === "/api/ideas" && url.searchParams.get("tag") === "audience",
        ),
      ).toBe(true);
    });

    await user.click(screen.getByRole("button", { name: "Table" }));
    await user.click(screen.getByRole("button", { name: /Title/ }));
    await waitFor(() => {
      expect(
        requests.some(
          ({ url }) =>
            url.pathname === "/api/ideas" &&
            url.searchParams.get("sort_by") === "title" &&
            url.searchParams.get("sort_order") === "asc",
        ),
      ).toBe(true);
    });

    await user.click(screen.getByRole("checkbox", { name: "Include archived" }));
    expect(await screen.findByText("Archived concept")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Move Archived concept to stage" })).toBeDisabled();
    expect(
      requests.some(
        ({ url }) =>
          url.pathname === "/api/ideas" && url.searchParams.get("include_archived") === "true",
      ),
    ).toBe(true);
  });

  it("links to script and packaging routes when an idea has no saved documents yet", async () => {
    recordFetch((url) => {
      if (url.pathname === `/api/ideas/${IDEA_ID}`) {
        return jsonResponse({ idea: idea({ status: "inbox" }), videos: [] });
      }
      if (url.pathname === "/api/notes") return jsonResponse({ notes: [] });
      return jsonResponse({ error: "Not found" }, 404);
    });
    const router = createMemoryRouter([{ path: "/ideas/:ideaId", element: <IdeaDetailPage /> }], {
      initialEntries: [`/ideas/${IDEA_ID}`],
    });
    const session = sessionWith({ ideas: "read", scripts: "read", videos: "read", notes: "read" });
    render(
      <QueryClientProvider client={createTestQueryClient()}>
        <SessionContext value={session}>
          <RouterProvider router={router} />
        </SessionContext>
      </QueryClientProvider>,
    );

    const startScript = await screen.findByRole("link", { name: "Start script" });
    const startPackaging = screen.getByRole("link", { name: "Start packaging" });
    expect(startScript).toHaveAttribute("href", `/scripts/${IDEA_ID}/script`);
    expect(startPackaging).toHaveAttribute("href", `/scripts/${IDEA_ID}/packaging`);
  });
});
