import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Note } from "@ytw/shared/api/notes";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NotesPanel } from "../../src/kit/NotesPanel.tsx";
import { createQueryClient } from "../../src/lib/query-client.ts";
import { expectNoA11yViolations } from "../helpers/a11y.ts";
import {
  createTestQueryClient,
  personaSession,
  renderWithSession,
  sessionWith,
  setOnline,
  stubApi,
} from "../helpers/render.tsx";

const IDEA_ID = "0199c2a4-7b1e-7c3a-9d2f-3b8a1c4e5f60";
const OTHER_ID = "0199c2a4-7b1e-7c3a-9d2f-3b8a1c4e5f99";

function note(partial: Partial<Note> & Pick<Note, "id" | "body_md">): Note {
  return {
    entity_type: "idea",
    entity_id: IDEA_ID,
    author: "owner",
    actor_type: "human",
    created_at: "2026-10-01T10:00:00.000Z",
    updated_at: "2026-10-01T10:00:00.000Z",
    ...partial,
  };
}

const SEED: Note[] = [
  note({
    id: "n2",
    author: "research-agent",
    actor_type: "agent",
    body_md: "Titles with **numbers** do better. [Source](https://example.com/r)",
    created_at: "2026-10-01T10:05:00.000Z",
  }),
  note({
    id: "n1",
    author: "owner",
    body_md: "Good idea, shortlist it.",
    created_at: "2026-10-01T10:00:00.000Z",
  }),
  note({ id: "n3", entity_id: OTHER_ID, body_md: "A note on another idea" }),
];

afterEach(() => {
  setOnline(true);
  vi.useRealTimers();
});

describe("NotesPanel: reading", () => {
  it("lists the entity's notes oldest first, with author, actor type, time and rendered markdown", async () => {
    const api = stubApi("owner", { notes: structuredClone(SEED) });
    renderWithSession(<NotesPanel entityType="idea" entityId={IDEA_ID} />);

    const items = await screen.findAllByRole("listitem");
    expect(items).toHaveLength(2);
    // The markdown renderer is a lazy chunk: wait for the rendered bold text.
    await screen.findByText("numbers");
    expect(within(items[0] as HTMLElement).getByText("owner")).toBeInTheDocument();
    expect(within(items[1] as HTMLElement).getByText("research-agent")).toBeInTheDocument();
    expect(within(items[1] as HTMLElement).getByText("Agent")).toBeInTheDocument();
    expect(within(items[0] as HTMLElement).queryByText("Agent")).toBeNull();
    expect(within(items[1] as HTMLElement).getByText("numbers").tagName).toBe("STRONG");
    expect(within(items[1] as HTMLElement).getByRole("link", { name: /Source/ })).toHaveAttribute(
      "href",
      "https://example.com/r",
    );
    expect(screen.queryByText("A note on another idea")).toBeNull();
    expect(screen.getByRole("heading", { name: /Notes/ })).toBeInTheDocument();

    const request = api.requests.find((r) => r.method === "GET" && r.path.startsWith("/api/notes"));
    expect(request?.path).toBe(`/api/notes?entity_type=idea&entity_id=${IDEA_ID}`);
  });

  it("shows a loading state first", async () => {
    stubApi("owner");
    renderWithSession(<NotesPanel entityType="idea" entityId={IDEA_ID} />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading notes");
    await screen.findByText("No notes yet");
  });

  it("shows an empty state when there are no notes", async () => {
    stubApi("owner");
    renderWithSession(<NotesPanel entityType="idea" entityId={IDEA_ID} />);
    expect(await screen.findByText("No notes yet")).toBeInTheDocument();
  });

  it("shows an error state with a retry that recovers", async () => {
    const api = stubApi("owner", { notes: structuredClone(SEED) });
    let failing = true;
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) =>
      failing
        ? Promise.resolve(
            new Response(JSON.stringify({ error: "The database is down" }), { status: 500 }),
          )
        : api.fetch(input, init),
    );
    const user = userEvent.setup();
    renderWithSession(<NotesPanel entityType="idea" entityId={IDEA_ID} />);

    expect(await screen.findByRole("alert")).toHaveTextContent("The database is down");
    failing = false;
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Good idea, shortlist it.")).toBeInTheDocument();
  });

  it("rejects a successful response containing notes for another entity", async () => {
    vi.stubGlobal("fetch", () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            notes: [note({ id: "wrong-entity", entity_id: OTHER_ID, body_md: "private note" })],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    renderWithSession(<NotesPanel entityType="idea" entityId={IDEA_ID} />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The server's response to /api/notes was not in the expected format.",
    );
    expect(screen.queryByText("private note")).toBeNull();
  });

  it("does not ask the server at all without Read on notes", () => {
    const api = stubApi("owner");
    renderWithSession(<NotesPanel entityType="idea" entityId={IDEA_ID} />, {
      session: sessionWith({ ideas: "write", notes: "none" }),
    });
    expect(screen.getByText("You do not have access to notes.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add note" })).toBeNull();
    expect(api.requests).toEqual([]);
  });

  it("uses the title and heading level it is given", async () => {
    stubApi("owner");
    renderWithSession(
      <NotesPanel entityType="script" entityId={IDEA_ID} title="Comments" headingLevel={3} />,
    );
    expect(screen.getByRole("heading", { level: 3, name: /Comments/ })).toBeInTheDocument();
    await screen.findByText("No notes yet");
  });
});

describe("NotesPanel: writing", () => {
  it("adds a note: sends the CSRF token, shows the note, clears the form and announces it", async () => {
    const api = stubApi("collaborator", { notes: structuredClone(SEED) });
    const user = userEvent.setup();
    renderWithSession(<NotesPanel entityType="idea" entityId={IDEA_ID} />, {
      session: personaSession("collaborator"),
    });
    await screen.findByText("Good idea, shortlist it.");

    await user.type(screen.getByLabelText("Add to notes"), "Let's film this **Friday**");
    await user.click(screen.getByRole("button", { name: "Add note" }));

    expect(await screen.findByText("Friday")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Note added.");
    expect(screen.getByLabelText("Add to notes")).toHaveValue("");
    expect(screen.getByLabelText("Add to notes")).toHaveFocus();

    const post = api.requests.find((r) => r.method === "POST");
    expect(post?.path).toBe("/api/notes");
    expect(post?.body).toEqual({
      entity_type: "idea",
      entity_id: IDEA_ID,
      body_md: "Let's film this **Friday**",
    });
    expect(post?.csrf).toBe(api.csrfToken());
    expect(api.notes.at(-1)).toMatchObject({ author: "collaborator", actor_type: "human" });
    // The author comes from the session on the server, never from the client.
    expect(JSON.stringify(post?.body)).not.toContain("author");
  });

  it("fetches the CSRF token itself when no session query has run yet", async () => {
    const api = stubApi("owner");
    const user = userEvent.setup();
    renderWithSession(<NotesPanel entityType="idea" entityId={IDEA_ID} />);
    await screen.findByText("No notes yet");
    await user.type(screen.getByLabelText("Add to notes"), "hello");
    await user.click(screen.getByRole("button", { name: "Add note" }));
    await screen.findByText("hello");
    expect(api.requests.some((r) => r.path === "/api/me")).toBe(true);
  });

  it("submits with Ctrl+Enter", async () => {
    const api = stubApi("owner");
    const user = userEvent.setup();
    renderWithSession(<NotesPanel entityType="idea" entityId={IDEA_ID} />);
    await screen.findByText("No notes yet");
    await user.type(
      screen.getByLabelText("Add to notes"),
      "via keyboard{Control>}{Enter}{/Control}",
    );
    await screen.findByText("via keyboard");
    expect(api.requests.filter((r) => r.method === "POST")).toHaveLength(1);
  });

  it("refuses an empty note on the client and sends nothing", async () => {
    const api = stubApi("owner");
    const user = userEvent.setup();
    renderWithSession(<NotesPanel entityType="idea" entityId={IDEA_ID} />);
    await screen.findByText("No notes yet");
    await user.type(screen.getByLabelText("Add to notes"), "   ");
    await user.click(screen.getByRole("button", { name: "Add note" }));
    expect(await screen.findByText("A note cannot be empty")).toBeInTheDocument();
    expect(screen.getByLabelText("Add to notes")).toBeInvalid();
    expect(api.requests.filter((r) => r.method === "POST")).toEqual([]);
  });

  it("refuses an oversized note on the client and sends nothing", async () => {
    const api = stubApi("owner");
    const user = userEvent.setup();
    renderWithSession(<NotesPanel entityType="idea" entityId={IDEA_ID} />);
    await screen.findByText("No notes yet");
    await user.click(screen.getByLabelText("Add to notes"));
    await user.paste("x".repeat(65_537));
    await user.click(screen.getByRole("button", { name: "Add note" }));
    expect(await screen.findByText(/at most 65536 bytes/)).toBeInTheDocument();
    expect(api.requests.filter((r) => r.method === "POST")).toEqual([]);
  });

  it("keeps the text and shows the server's reason when saving fails", async () => {
    const api = stubApi("owner");
    api.missingEntities.add(IDEA_ID);
    const user = userEvent.setup();
    renderWithSession(<NotesPanel entityType="idea" entityId={IDEA_ID} />);
    await screen.findByText("No notes yet");
    await user.type(screen.getByLabelText("Add to notes"), "orphan note");
    await user.click(screen.getByRole("button", { name: "Add note" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The note was not saved");
    expect(alert).toHaveTextContent(`No idea with id ${IDEA_ID}`);
    expect(screen.getByLabelText("Add to notes")).toHaveValue("orphan note");
  });

  it("shows the server's refusal when the level was lowered after the page loaded", async () => {
    const api = stubApi("owner");
    const user = userEvent.setup();
    renderWithSession(<NotesPanel entityType="idea" entityId={IDEA_ID} />, {
      session: personaSession("owner"),
    });
    await screen.findByText("No notes yet");
    api.setPersona("reader");
    await user.type(screen.getByLabelText("Add to notes"), "too late");
    await user.click(screen.getByRole("button", { name: "Add note" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("You need write access to notes");
  });

  it("disables the form for a user with Read only, with the reason, and never posts", async () => {
    const api = stubApi("reader", { notes: structuredClone(SEED) });
    renderWithSession(<NotesPanel entityType="idea" entityId={IDEA_ID} />, {
      session: personaSession("reader"),
    });
    await screen.findByText("Good idea, shortlist it.");
    expect(screen.getByLabelText("Add to notes")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Add note" })).toBeDisabled();
    expect(screen.getByText(/read-only access to notes/i)).toBeInTheDocument();
    expect(api.requests.filter((r) => r.method === "POST")).toEqual([]);
  });

  it("disables the form while offline", async () => {
    stubApi("owner");
    renderWithSession(<NotesPanel entityType="idea" entityId={IDEA_ID} />);
    await screen.findByText("No notes yet");
    act(() => setOnline(false));
    expect(screen.getByRole("button", { name: "Add note" })).toBeDisabled();
    expect(screen.getByText(/You are offline/)).toBeInTheDocument();
  });
});

describe("NotesPanel: live updates", () => {
  it("picks up a note an agent added, within the 15 s polling interval", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const api = stubApi("owner", { notes: structuredClone(SEED) });
    renderWithSession(<NotesPanel entityType="idea" entityId={IDEA_ID} />, {
      client: createQueryClient(),
    });
    await screen.findByText("Good idea, shortlist it.");
    expect(screen.queryByText("Added by an agent meanwhile")).toBeNull();

    api.notes.push(
      note({
        id: "n9",
        author: "writer-agent",
        actor_type: "agent",
        body_md: "Added by an agent meanwhile",
        created_at: "2026-10-01T11:00:00.000Z",
      }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_100);
    });
    expect(await screen.findByText("Added by an agent meanwhile")).toBeInTheDocument();
  });

  it("does not keep the typed draft hostage to a refetch", async () => {
    const api = stubApi("owner", { notes: structuredClone(SEED) });
    const user = userEvent.setup();
    const { client } = renderWithSession(<NotesPanel entityType="idea" entityId={IDEA_ID} />);
    await screen.findByText("Good idea, shortlist it.");
    await user.type(screen.getByLabelText("Add to notes"), "unsent draft");
    api.notes.push(
      note({ id: "n8", body_md: "arrived meanwhile", created_at: "2026-10-01T12:00:00.000Z" }),
    );
    await act(() => client.invalidateQueries());
    await screen.findByText("arrived meanwhile");
    expect(screen.getByLabelText("Add to notes")).toHaveValue("unsent draft");
  });
});

describe("NotesPanel: accessibility", () => {
  it("has no violations with notes, in the error-free states", async () => {
    stubApi("owner", { notes: structuredClone(SEED) });
    const { container } = renderWithSession(<NotesPanel entityType="idea" entityId={IDEA_ID} />, {
      client: createTestQueryClient(),
    });
    await screen.findByText("Good idea, shortlist it.");
    await waitFor(() => expect(container.querySelector("[data-markdown-loading]")).toBeNull());
    await expectNoA11yViolations(container);
  });
});
