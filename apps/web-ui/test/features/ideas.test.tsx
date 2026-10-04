import { render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import userEvent from "@testing-library/user-event";
import type { Idea } from "@ytw/shared/api/ideas";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryRouter, RouterProvider } from "react-router";
import { Component as IdeasPage } from "../../src/features/ideas/IdeasPage.tsx";
import { Component as IdeaDetailPage } from "../../src/features/ideas/IdeaDetailPage.tsx";
import { IdeaEditorDialog } from "../../src/features/ideas/IdeaEditorDialog.tsx";
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

  it("clears the canceled note and conflict before reusing the stage dialog for another idea", async () => {
    setCsrfToken("test-csrf");
    const requests = recordFetch((url) => {
      if (url.pathname === `/api/ideas/${IDEA_ID}/stage`) {
        return jsonResponse(
          {
            error: "The first idea changed while its move was being prepared.",
            latest: idea({ title: "First idea latest version", version: 3 }),
          },
          409,
        );
      }
      return jsonResponse({
        idea: idea({ id: ARCHIVED_ID, title: "Second idea", status: "shortlisted", version: 3 }),
      });
    });
    const onMoved = vi.fn<(moved: Idea) => void>();
    function Harness() {
      const [selection, setSelection] = useState<{
        idea: Idea;
        target: "inbox" | "shortlisted";
      } | null>({ idea: idea(), target: "inbox" });
      return (
        <>
          <button
            type="button"
            onClick={() =>
              setSelection({
                idea: idea({ id: ARCHIVED_ID, title: "Second idea", status: "inbox" }),
                target: "shortlisted",
              })
            }
          >
            Open second idea
          </button>
          <StageMoveDialog
            idea={selection?.idea ?? null}
            target={selection?.target ?? null}
            onClose={() => setSelection(null)}
            onMoved={onMoved}
          />
        </>
      );
    }
    const user = userEvent.setup();
    renderWithSession(<Harness />);

    await user.type(
      screen.getByRole("textbox", { name: "Why is this idea moving backward?" }),
      "Do not carry this note forward.",
    );
    await user.click(screen.getByRole("button", { name: "Move idea" }));
    expect(
      await screen.findByRole("heading", { name: "This idea changed while you were editing" }),
    ).toBeInTheDocument();
    expect(screen.getByText("First idea latest version · Shortlisted")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(
      screen.queryByRole("heading", { name: "This idea changed while you were editing" }),
    ).toBeNull();
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    await user.click(screen.getByRole("button", { name: "Open second idea" }));
    expect(screen.queryByRole("textbox", { name: "Why is this idea moving backward?" })).toBeNull();
    expect(
      screen.queryByRole("heading", { name: "This idea changed while you were editing" }),
    ).toBeNull();
    await user.click(screen.getByRole("button", { name: "Move idea" }));

    await waitFor(() =>
      expect(onMoved).toHaveBeenCalledWith(expect.objectContaining({ id: ARCHIVED_ID })),
    );
    expect(requests[1]).toMatchObject({
      method: "POST",
      body: { expected_version: 2, new_status: "shortlisted" },
    });
    expect(requests[1]?.body).not.toHaveProperty("note");
  });

  it("keeps the local title and rebases untouched remote pitch and source after merging", async () => {
    setCsrfToken("test-csrf");
    const original = idea({
      title: "Version two",
      pitch: "Version two pitch",
      source: "Version two source",
      score: 42,
      tags: ["version-two"],
    });
    const current = idea({
      score: 42,
      tags: ["version-two"],
      title: "Version two",
      pitch: "Version three pitch",
      source: "Version three source",
      version: 3,
    });
    const requests = recordFetch((url, init) => {
      if (url.pathname !== `/api/ideas/${IDEA_ID}` || init?.method !== "PATCH") {
        return jsonResponse({ error: "Unexpected request" }, 500);
      }
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      const attempt = requests.filter((request) => request.method === "PATCH").length;
      if (attempt === 1) {
        return jsonResponse({ error: "This idea changed to version 3.", latest: current }, 409);
      }
      return jsonResponse({
        idea: idea({
          ...current,
          title: body.title as string,
          pitch: body.pitch as string,
          source: body.source as string,
          score: body.score as number,
          tags: body.tags as string[],
          version: 4,
        }),
      });
    });
    const onSaved = vi.fn<(saved: Idea) => void>();
    const user = userEvent.setup();
    renderWithSession(
      <IdeaEditorDialog open idea={original} onClose={vi.fn<() => void>()} onSaved={onSaved} />,
    );

    await user.clear(screen.getByRole("textbox", { name: "Title" }));
    await user.type(screen.getByRole("textbox", { name: "Title" }), "My retained title");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(await screen.findByText("This idea changed to version 3.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Merge my changes" }));
    expect(screen.getByRole("textbox", { name: "Title" })).toHaveValue("My retained title");
    expect(screen.getByRole("textbox", { name: "Pitch" })).toHaveValue("Version three pitch");
    expect(screen.getByRole("textbox", { name: "Source" })).toHaveValue("Version three source");
    expect(screen.getByRole("spinbutton", { name: "Score" })).toHaveValue(42);
    expect(screen.getByRole("textbox", { name: "Tags" })).toHaveValue("version-two");

    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() =>
      expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ version: 4 })),
    );
    const patchBodies = requests
      .filter((request) => request.method === "PATCH")
      .map((request) => request.body as Record<string, unknown>);
    expect(patchBodies[0]).toMatchObject({ expected_version: 2 });
    expect(patchBodies[1]).toMatchObject({
      expected_version: 3,
      title: "My retained title",
      pitch: "Version three pitch",
      source: "Version three source",
      score: 42,
      tags: ["version-two"],
    });
  });

  it("shows overlapping pitch and source on both sides and keeps both local values when rebasing", async () => {
    setCsrfToken("test-csrf");
    const original = idea({
      title: "Version two",
      pitch: "Version two pitch",
      source: "Version two source",
      score: 42,
      tags: ["version-two"],
    });
    const current = idea({
      title: "Version three title",
      pitch: "Version three pitch",
      source: "Version three source",
      score: 65,
      tags: ["version-three"],
      version: 3,
    });
    const requests = recordFetch((url, init) => {
      if (url.pathname !== `/api/ideas/${IDEA_ID}` || init?.method !== "PATCH") {
        return jsonResponse({ error: "Unexpected request" }, 500);
      }
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      const attempt = requests.filter((request) => request.method === "PATCH").length;
      if (attempt === 1) {
        return jsonResponse({ error: "This idea changed to version 3.", latest: current }, 409);
      }
      return jsonResponse({
        idea: idea({
          ...current,
          title: body.title as string,
          pitch: body.pitch as string,
          source: body.source as string,
          score: body.score as number,
          tags: body.tags as string[],
          version: 4,
        }),
      });
    });
    const onSaved = vi.fn<(saved: Idea) => void>();
    const user = userEvent.setup();
    renderWithSession(
      <IdeaEditorDialog open idea={original} onClose={vi.fn<() => void>()} onSaved={onSaved} />,
    );

    await user.clear(screen.getByRole("textbox", { name: "Pitch" }));
    await user.type(screen.getByRole("textbox", { name: "Pitch" }), "My retained pitch");
    await user.clear(screen.getByRole("textbox", { name: "Source" }));
    await user.type(screen.getByRole("textbox", { name: "Source" }), "My retained source");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(await screen.findByText("This idea changed to version 3.")).toBeInTheDocument();
    expect(screen.getAllByText("My retained pitch")).toHaveLength(2);
    expect(screen.getByText("Version three pitch")).toBeInTheDocument();
    expect(screen.getByText("My retained source")).toBeInTheDocument();
    expect(screen.getByText("Version three source")).toBeInTheDocument();
    expect(screen.getAllByText("Both changed")).toHaveLength(4);

    await user.click(screen.getByRole("button", { name: "Merge my changes" }));
    expect(screen.getByRole("textbox", { name: "Title" })).toHaveValue("Version three title");
    expect(screen.getByRole("textbox", { name: "Pitch" })).toHaveValue("My retained pitch");
    expect(screen.getByRole("textbox", { name: "Source" })).toHaveValue("My retained source");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() =>
      expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ version: 4 })),
    );
    const patchBodies = requests
      .filter((request) => request.method === "PATCH")
      .map((request) => request.body as Record<string, unknown>);
    expect(patchBodies[1]).toMatchObject({
      expected_version: 3,
      title: "Version three title",
      pitch: "My retained pitch",
      source: "My retained source",
      score: 65,
      tags: ["version-three"],
    });
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

  it("queries the selected mobile stage before paging and keeps both stage controls in sync", async () => {
    const inboxPage = Array.from({ length: 100 }, (_, index) =>
      idea({
        id: `0199c2a4-7b1e-7c3a-9d2f-${String(index + 1).padStart(12, "0")}`,
        title: `Inbox idea ${index + 1}`,
        status: "inbox",
      }),
    );
    const olderEditing = idea({
      id: ARCHIVED_ID,
      title: "Older editing idea",
      status: "editing",
    });
    const requests = recordFetch((url) => {
      if (url.pathname !== "/api/ideas") return jsonResponse({ error: "Not found" }, 404);
      if (url.searchParams.get("stage") === "editing") {
        return jsonResponse({
          ideas: [olderEditing],
          page: { limit: 100, offset: 0, total: 1 },
        });
      }
      const offset = Number(url.searchParams.get("offset") ?? 0);
      return jsonResponse({
        ideas: offset === 100 ? inboxPage.slice(50, 100) : inboxPage,
        page: { limit: 100, offset, total: 150 },
      });
    });
    const user = userEvent.setup();
    renderWithSession(<IdeasPage />, { session: sessionWith({ ideas: "write" }) });

    expect(await screen.findAllByText("Inbox idea 100")).not.toHaveLength(0);
    expect(screen.queryByText("Older editing idea")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => {
      expect(
        requests.some(
          ({ url }) => url.pathname === "/api/ideas" && url.searchParams.get("offset") === "100",
        ),
      ).toBe(true);
    });
    await user.selectOptions(screen.getByRole("combobox", { name: "Show one stage" }), "editing");

    expect(await screen.findAllByText("Older editing idea")).not.toHaveLength(0);
    expect(screen.getByRole("combobox", { name: "Filter by stage" })).toHaveValue("editing");
    expect(
      requests.some(
        ({ url }) =>
          url.pathname === "/api/ideas" &&
          url.searchParams.get("stage") === "editing" &&
          url.searchParams.get("offset") === "0",
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
