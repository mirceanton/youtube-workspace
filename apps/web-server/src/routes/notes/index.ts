import { addNote, listNotes, type NoteRecord, type Queryable } from "@ytw/db";
import type { NoteEntityType } from "@ytw/shared/constants";
import { createNoteRequestSchema, listNotesQuerySchema, NOTES_PATH } from "@ytw/shared/api/notes";
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from "fastify";

type AccessLevel = "read" | "write";
type NotesCore = FastifyInstance & {
  requireLevel(resource: "notes", level: AccessLevel): preHandlerHookHandler;
  db: {
    pool: Queryable;
    withActor<T>(
      request: FastifyRequest,
      fn: (client: Parameters<typeof addNote>[0]) => Promise<T>,
    ): Promise<T>;
  };
};

const ENTITY_ID_SQL: Record<NoteEntityType, string> = {
  idea: "SELECT 1 FROM public.ideas WHERE id = $1::uuid",
  script: "SELECT 1 FROM public.scripts WHERE id = $1::uuid",
  video: "SELECT 1 FROM public.videos WHERE id = $1::uuid",
  experiment: "SELECT 1 FROM public.experiments WHERE id = $1::uuid",
};

function toApiNote(note: NoteRecord) {
  return {
    id: note.id,
    entity_type: note.entityType,
    entity_id: note.entityId,
    author: note.author,
    actor_type: note.actorType,
    body_md: note.bodyMd,
    created_at: note.createdAt.toISOString(),
    updated_at: note.updatedAt.toISOString(),
  };
}

async function entityExists(db: Queryable, type: NoteEntityType, id: string): Promise<boolean> {
  const { rows } = await db.query(ENTITY_ID_SQL[type], [id]);
  return rows.length > 0;
}

function invalid(reply: FastifyReply, message: string) {
  return reply.code(400).send({ error: message });
}

/** Web API for listing and adding append-only notes on workspace entities. */
export default async function notesRoutes(server: FastifyInstance): Promise<void> {
  const app = server as NotesCore;

  app.get(NOTES_PATH, { preHandler: app.requireLevel("notes", "read") }, async (request, reply) => {
    const parsed = listNotesQuerySchema.safeParse(request.query);
    if (!parsed.success) return invalid(reply, parsed.error.issues[0]?.message ?? "Invalid query");
    const { entity_type: entityType, entity_id: entityId } = parsed.data;
    if (!(await entityExists(app.db.pool, entityType, entityId))) {
      return reply.code(404).send({ error: "Entity not found" });
    }
    const notes = await listNotes(app.db.pool, { entityType, entityId });
    return reply.send({ notes: notes.map(toApiNote) });
  });

  app.post(
    NOTES_PATH,
    { preHandler: app.requireLevel("notes", "write") },
    async (request, reply) => {
      const parsed = createNoteRequestSchema.safeParse(request.body);
      if (!parsed.success) return invalid(reply, parsed.error.issues[0]?.message ?? "Invalid body");
      const { entity_type: entityType, entity_id: entityId, body_md: bodyMd } = parsed.data;
      if (!(await entityExists(app.db.pool, entityType, entityId))) {
        return reply.code(404).send({ error: "Entity not found" });
      }
      const note = await app.db.withActor(request, (tx) =>
        addNote(tx, { entityType, entityId, bodyMd }),
      );
      // The database wrapper derives the audit actor from the session request; the body never
      // accepts author/actor fields from the client.
      return reply.code(201).send({ note: toApiNote(note) });
    },
  );
}
