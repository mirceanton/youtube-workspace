import type { NoteEntityType } from "@ytw/shared/constants";

/** TanStack Query key of one entity's notes; invalidate it to refresh the panel. */
export function notesQueryKey(entityType: NoteEntityType, entityId: string) {
  return ["notes", entityType, entityId] as const;
}
