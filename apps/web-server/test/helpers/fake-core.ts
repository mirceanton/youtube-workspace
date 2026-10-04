import type { ActorTx, Queryable } from "@ytw/db";
import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from "fastify";
import Fastify from "fastify";

type AccessLevel = "read" | "write";
type NoteEntity = "idea" | "script" | "video" | "experiment";
type StoredNote = {
  id: string;
  entityType: NoteEntity;
  entityId: string;
  author: string;
  actorType: "human";
  bodyMd: string;
  createdAt: Date;
  updatedAt: Date;
};

export interface FakeCoreState {
  level: "none" | "read" | "write" | "unknown";
  username: string;
  entities: Set<string>;
  notes: StoredNote[];
  calls: string[];
}

/** Implements only the documented T40 core surface needed by feature route unit tests. */
export function buildFakeCore(state: FakeCoreState): FastifyInstance {
  const app = Fastify({ logger: false });
  app.addHook("onRequest", async (request) => {
    Object.assign(request, {
      auth: {
        userId: "user-1",
        username: state.username,
        isAdmin: false,
        levels: { notes: state.level },
      },
    });
  });

  const pool = {
    async query(query: string | { text: string; values: unknown[] }, values: unknown[] = []) {
      const text = typeof query === "string" ? query : query.text;
      const params = typeof query === "string" ? values : query.values;
      state.calls.push(text);
      if (text.includes("FROM public.ideas")) {
        return { rows: state.entities.has(`idea:${String(params[0])}`) ? [{ "?column?": 1 }] : [] };
      }
      if (text.includes("FROM public.scripts")) {
        return {
          rows: state.entities.has(`script:${String(params[0])}`) ? [{ "?column?": 1 }] : [],
        };
      }
      if (text.includes("FROM public.videos")) {
        return {
          rows: state.entities.has(`video:${String(params[0])}`) ? [{ "?column?": 1 }] : [],
        };
      }
      if (text.includes("FROM public.experiments")) {
        return {
          rows: state.entities.has(`experiment:${String(params[0])}`) ? [{ "?column?": 1 }] : [],
        };
      }
      if (text.includes("FROM public.notes")) {
        return {
          rows: state.notes
            .filter((note) => note.entityType === params[0] && note.entityId === params[1])
            .map(toDbNote),
        };
      }
      return { rows: [] };
    },
  } as unknown as Queryable;

  const core = app as unknown as FastifyInstance & {
    requireLevel(resource: "notes", level: AccessLevel): preHandlerHookHandler;
    db: {
      pool: Queryable;
      withActor<T>(request: FastifyRequest, fn: (tx: ActorTx) => Promise<T>): Promise<T>;
    };
  };
  core.requireLevel = (_resource, needed) => async (_request, reply) => {
    const permitted =
      needed === "read"
        ? state.level === "read" || state.level === "write"
        : state.level === "write";
    if (!permitted) return reply.code(403).send({ error: "Forbidden" });
  };
  core.db = {
    pool,
    async withActor(request, fn) {
      const auth = (request as FastifyRequest & { auth: { username: string } }).auth;
      const tx = {
        actor: { name: auth.username, type: "human" as const, tokenId: null },
        async query(query: string | { text: string; values: unknown[] }, values: unknown[] = []) {
          const text = typeof query === "string" ? query : query.text;
          const params = typeof query === "string" ? values : query.values;
          state.calls.push(text);
          if (!text.includes("FROM public.add_note")) return { rows: [] };
          const note: StoredNote = {
            id: `note-${state.notes.length + 1}`,
            entityType: String(params[3]) as NoteEntity,
            entityId: String(params[4]),
            author: String(params[0]),
            actorType: "human",
            bodyMd: String(params[5]),
            createdAt: new Date("2026-10-04T12:00:00.000Z"),
            updatedAt: new Date("2026-10-04T12:00:00.000Z"),
          };
          state.notes.push(note);
          return { rows: [toDbNote(note)] };
        },
      } as unknown as ActorTx;
      return fn(tx);
    },
  };
  return app;
}

function toDbNote(note: StoredNote) {
  return {
    id: note.id,
    entityType: note.entityType,
    entityId: note.entityId,
    author: note.author,
    actorType: note.actorType,
    bodyMd: note.bodyMd,
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
  };
}
