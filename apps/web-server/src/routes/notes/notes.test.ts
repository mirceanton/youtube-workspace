import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import notesRoutes from "./index.js";
import { buildFakeCore, type FakeCoreState } from "../../../test/helpers/fake-core.js";

const ENTITY_ID = "018f0f9f-cc8a-7b2a-9a0d-111111111111";

describe("/api/notes", () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  function setup(level: FakeCoreState["level"] = "write", entityExists = true) {
    const state: FakeCoreState = {
      level,
      username: "channel-owner",
      entities: new Set(entityExists ? [`idea:${ENTITY_ID}`] : []),
      notes: [],
      calls: [],
    };
    app = buildFakeCore(state);
    app.register(notesRoutes);
    return state;
  }

  it("lists an entity's notes for Read and Write access", async () => {
    for (const level of ["read", "write"] as const) {
      const state = setup(level);
      state.notes.push({
        id: "note-1",
        entityType: "idea",
        entityId: ENTITY_ID,
        author: "agent",
        actorType: "human",
        bodyMd: "A **note**",
        createdAt: new Date("2026-10-04T10:00:00.000Z"),
        updatedAt: new Date("2026-10-04T10:00:00.000Z"),
      });

      const response = await app!.inject({
        method: "GET",
        url: `/api/notes?entity_type=idea&entity_id=${ENTITY_ID}`,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        notes: [{ body_md: "A **note**", author: "agent" }],
      });
      expect(state.calls.some((query) => query.includes("FROM public.notes"))).toBe(true);
      await app!.close();
      app = undefined;
    }
  });

  it("denies None and unknown access levels before querying notes", async () => {
    for (const level of ["none", "unknown"] as const) {
      const state = setup(level);
      const response = await app!.inject({
        method: "GET",
        url: `/api/notes?entity_type=idea&entity_id=${ENTITY_ID}`,
      });
      expect(response.statusCode).toBe(403);
      expect(state.calls).toEqual([]);
      await app!.close();
      app = undefined;
    }
  });

  it("validates list query and returns 404 for unknown entities", async () => {
    const state = setup("read");
    expect(
      (await app!.inject({ method: "GET", url: "/api/notes?entity_type=idea" })).statusCode,
    ).toBe(400);
    expect(
      (
        await app!.inject({
          method: "GET",
          url: `/api/notes?entity_type=person&entity_id=${ENTITY_ID}`,
        })
      ).statusCode,
    ).toBe(400);
    state.entities.clear();
    const missing = await app!.inject({
      method: "GET",
      url: `/api/notes?entity_type=idea&entity_id=${ENTITY_ID}`,
    });
    expect(missing.statusCode).toBe(404);
    expect(state.calls.some((query) => query.includes("FROM public.notes"))).toBe(false);
  });

  it("creates a note attributed to the session actor and accepts only the shared body", async () => {
    const state = setup("write");
    const response = await app!.inject({
      method: "POST",
      url: "/api/notes",
      payload: {
        entity_type: "idea",
        entity_id: ENTITY_ID,
        body_md: "Stored as **raw markdown**",
        author: "forged-author",
      },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      note: {
        entity_type: "idea",
        entity_id: ENTITY_ID,
        author: "channel-owner",
        actor_type: "human",
      },
    });
    expect(state.notes[0]?.bodyMd).toBe("Stored as **raw markdown**");
    expect(state.calls.some((query) => query.includes("FROM public.add_note"))).toBe(true);
  });

  it("requires Write, validates note fields, and checks entity existence", async () => {
    const noneState = setup("none");
    const none = await app!.inject({
      method: "POST",
      url: "/api/notes",
      payload: { entity_type: "idea", entity_id: ENTITY_ID, body_md: "hello" },
    });
    expect(none.statusCode).toBe(403);
    expect(noneState.calls).toEqual([]);
    await app!.close();
    app = undefined;

    const state = setup("read");
    const denied = await app!.inject({
      method: "POST",
      url: "/api/notes",
      payload: { entity_type: "idea", entity_id: ENTITY_ID, body_md: "hello" },
    });
    expect(denied.statusCode).toBe(403);
    expect(state.calls).toEqual([]);
    await app!.close();
    app = undefined;

    setup("write");
    expect(
      (
        await app!.inject({
          method: "POST",
          url: "/api/notes",
          payload: { entity_type: "idea", entity_id: ENTITY_ID, body_md: "  " },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app!.inject({
          method: "POST",
          url: "/api/notes",
          payload: { entity_type: "unknown", entity_id: ENTITY_ID, body_md: "hello" },
        })
      ).statusCode,
    ).toBe(400);
    await app!.close();
    app = undefined;

    setup("write", false);
    const missing = await app!.inject({
      method: "POST",
      url: "/api/notes",
      payload: { entity_type: "idea", entity_id: ENTITY_ID, body_md: "hello" },
    });
    expect(missing.statusCode).toBe(404);
  });
});
