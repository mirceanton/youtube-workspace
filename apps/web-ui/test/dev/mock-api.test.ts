import {
  createNoteResponseSchema,
  listNotesResponseSchema,
  type Note,
} from "@ytw/shared/api/notes";
import { meResponseSchema } from "@ytw/shared/api/session";
import { describe, expect, it, vi } from "vitest";
import {
  PERSONAS,
  createMockApi,
  errorResponse,
  isPersonaName,
  requireMockLevel,
} from "../../src/dev/mock-api.ts";
import { seedNotes } from "../../src/dev/demo-data.ts";

// The mock is the SPA's stand-in for the web server until T40/T41b land, and the fake backend of
// every component test, so it must itself honour the contract in packages/shared/src/api.

const ENTITY = "0199c2a4-7b1e-7c3a-9d2f-3b8a1c4e5f60";

async function post(api: ReturnType<typeof createMockApi>, body: unknown, csrf = api.csrfToken()) {
  return api.fetch("/api/notes", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
    body: JSON.stringify(body),
  });
}

describe("mock API: /api/me", () => {
  it.each(Object.keys(PERSONAS).filter((name) => name !== "anonymous"))(
    "answers the contract for persona %s, with the CSRF header",
    async (name) => {
      const api = createMockApi({ persona: name as keyof typeof PERSONAS });
      const response = await api.fetch("/api/me");
      expect(response.status).toBe(200);
      expect(response.headers.get("X-CSRF-Token")).toBe(api.csrfToken());
      expect(meResponseSchema.safeParse(await response.json()).success).toBe(true);
    },
  );

  it("answers 401 for an anonymous visitor", async () => {
    const response = await createMockApi({ persona: "anonymous" }).fetch("/api/me");
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Not signed in" });
  });

  it("follows the PRD 7 example table for the collaborator and the reader", () => {
    expect(PERSONAS.collaborator?.levels).toEqual({
      ideas: "write",
      scripts: "write",
      experiments: "write",
      videos: "read",
      notes: "write",
      activity: "read",
    });
    expect(PERSONAS.reader?.levels.activity).toBe("none");
    expect(PERSONAS.owner?.user.isAdmin).toBe(true);
  });

  it("knows its persona names", () => {
    expect(isPersonaName("owner")).toBe(true);
    expect(isPersonaName("root")).toBe(false);
    expect(isPersonaName(null)).toBe(false);
  });
});

describe("mock API: /api/notes", () => {
  it("lists the notes of one entity and validates the query", async () => {
    const api = createMockApi({ notes: seedNotes() });
    const ok = await api.fetch(`/api/notes?entity_type=idea&entity_id=${ENTITY}`);
    const body = listNotesResponseSchema.parse(await ok.json());
    expect(body.notes).toHaveLength(2);
    expect((await api.fetch("/api/notes?entity_type=idea")).status).toBe(400);
    expect((await api.fetch(`/api/notes?entity_type=user&entity_id=${ENTITY}`)).status).toBe(400);
  });

  it("creates a note authored by the session user, as a human", async () => {
    const api = createMockApi({ persona: "collaborator" });
    const response = await post(api, {
      entity_type: "script",
      entity_id: ENTITY,
      body_md: "hello",
    });
    expect(response.status).toBe(201);
    const { note } = createNoteResponseSchema.parse(await response.json());
    expect(note).toMatchObject({
      author: "collaborator",
      actor_type: "human",
      entity_type: "script",
    });
    expect(api.notes).toHaveLength(1);
  });

  it("rejects bad input, unknown entities and over-long notes", async () => {
    const api = createMockApi();
    expect(
      (await post(api, { entity_type: "idea", entity_id: ENTITY, body_md: "  " })).status,
    ).toBe(400);
    expect((await post(api, { entity_type: "idea", entity_id: "nope", body_md: "x" })).status).toBe(
      400,
    );
    api.missingEntities.add(ENTITY);
    const missing = await post(api, { entity_type: "idea", entity_id: ENTITY, body_md: "x" });
    expect(missing.status).toBe(404);
    expect((await missing.json()).error).toContain(ENTITY);
  });

  it("enforces levels: Read to list, Write to create, 403 with a readable message", async () => {
    const reader = createMockApi({ persona: "reader" });
    expect((await reader.fetch(`/api/notes?entity_type=idea&entity_id=${ENTITY}`)).status).toBe(
      200,
    );
    const denied = await post(reader, { entity_type: "idea", entity_id: ENTITY, body_md: "x" });
    expect(denied.status).toBe(403);
    expect((await denied.json()).error).toBe("You need write access to notes");

    const none = createMockApi({ persona: "newcomer" });
    expect((await none.fetch(`/api/notes?entity_type=idea&entity_id=${ENTITY}`)).status).toBe(403);
  });

  it("answers 401 to mutations without a session", async () => {
    const api = createMockApi({ persona: "anonymous" });
    expect((await post(api, { entity_type: "idea", entity_id: ENTITY, body_md: "x" })).status).toBe(
      401,
    );
  });

  it("refuses mutations without the right CSRF token, and accepts a rotated one", async () => {
    const api = createMockApi();
    const body = { entity_type: "idea", entity_id: ENTITY, body_md: "x" };
    const missing = await api.fetch("/api/notes", { method: "POST", body: JSON.stringify(body) });
    expect(missing.status).toBe(403);
    expect((await post(api, body, "wrong")).status).toBe(403);
    const old = api.csrfToken();
    const rotated = api.rotateCsrfToken();
    expect(rotated).not.toBe(old);
    expect((await post(api, body, old)).status).toBe(403);
    expect((await post(api, body, rotated)).status).toBe(201);
  });

  it("records every request for assertions", async () => {
    const api = createMockApi();
    await api.fetch("/api/me");
    await post(api, { entity_type: "idea", entity_id: ENTITY, body_md: "x" });
    expect(api.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      "GET /api/me",
      "POST /api/notes",
    ]);
    expect(api.requests[1]?.csrf).toBe(api.csrfToken());
  });
});

describe("mock API: routing and extension", () => {
  it("answers 404 with a message for routes nobody mocked, so gaps are obvious", async () => {
    const response = await createMockApi().fetch("/api/ideas");
    expect(response.status).toBe(404);
    expect((await response.json()).error).toBe("The mock API has no GET /api/ideas");
  });

  it("lets features register routes with params, query and a body", async () => {
    const api = createMockApi();
    api.router.get("/api/ideas/:id", (request) => ({
      json: { id: request.params.id, stage: request.query.get("stage") },
    }));
    api.router.patch("/api/ideas/:id", (request) => {
      const denied = requireMockLevel(request, "ideas", "write");
      return denied ?? { status: 200, json: { patched: request.body } };
    });
    const got = await api.fetch("/api/ideas/abc%20d?stage=inbox");
    expect(await got.json()).toEqual({ id: "abc d", stage: "inbox" });
    const patched = await api.fetch("/api/ideas/1", {
      method: "PATCH",
      headers: { "X-CSRF-Token": api.csrfToken() },
      body: JSON.stringify({ title: "x" }),
    });
    expect(await patched.json()).toEqual({ patched: { title: "x" } });
    api.setPersona("reader");
    const denied = await api.fetch("/api/ideas/1", {
      method: "PATCH",
      headers: { "X-CSRF-Token": api.csrfToken() },
      body: "{}",
    });
    expect(denied.status).toBe(403);
  });

  it("passes non-/api URLs to the real fetch", async () => {
    const passthrough = vi.fn<typeof fetch>(async () => new Response("asset"));
    const api = createMockApi({ passthrough });
    expect(await (await api.fetch("/assets/app.js")).text()).toBe("asset");
    expect(passthrough).toHaveBeenCalledTimes(1);
  });

  it("builds error responses in the shared error shape", async () => {
    const response = errorResponse(409, "stale", { latest: { version: 2 } });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "stale", latest: { version: 2 } });
  });

  it("starts from the notes it is given and keeps them", async () => {
    const seed: Note[] = seedNotes();
    const api = createMockApi({ notes: seed });
    expect(api.notes).toBe(seed);
  });
});
