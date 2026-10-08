import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MessageSquare } from "lucide-react";
import { useId, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import type { NoteEntityType } from "@ytw/shared/constants";
import type { Note } from "@ytw/shared/api/notes";
import { api } from "@/lib/api.ts";
import { cx } from "@/lib/cx.ts";
import { NOTE_BODY_MAX_BYTES, NOTES_PATH } from "@/lib/contract.ts";
import { describeError } from "@/lib/errors.ts";
import { formatDateTime, formatRelativeTime } from "@/lib/format.ts";
import { useLevel } from "@/lib/session.ts";
import { Alert } from "./Alert.tsx";
import { Badge } from "./Badge.tsx";
import { Button } from "./Button.tsx";
import { TextAreaField } from "./Field.tsx";
import { MarkdownView } from "./MarkdownView.tsx";
import { EmptyState, ErrorState, LoadingState } from "./states.tsx";
import { notesQueryKey } from "./notes-keys.ts";
import { WriteGuard } from "./WriteGuard.tsx";

const NOTE_ENTITY_TYPES = ["idea", "script", "video", "experiment"] as const;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseNote(value: unknown): Note {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    value.id.length === 0 ||
    !NOTE_ENTITY_TYPES.includes(value.entity_type as (typeof NOTE_ENTITY_TYPES)[number]) ||
    typeof value.entity_id !== "string" ||
    !UUID_PATTERN.test(value.entity_id) ||
    typeof value.author !== "string" ||
    value.author.length === 0 ||
    (value.actor_type !== "human" && value.actor_type !== "agent") ||
    typeof value.body_md !== "string" ||
    typeof value.created_at !== "string" ||
    Number.isNaN(Date.parse(value.created_at)) ||
    typeof value.updated_at !== "string" ||
    Number.isNaN(Date.parse(value.updated_at))
  ) {
    throw new TypeError("The server returned an invalid note");
  }
  return value as unknown as Note;
}

function parseNotesResponse(
  value: unknown,
  entityType: NoteEntityType,
  entityId: string,
): { notes: Note[] } {
  if (!isRecord(value) || !Array.isArray(value.notes)) {
    throw new TypeError("The server returned an invalid notes list");
  }
  const notes = value.notes.map(parseNote);
  if (notes.some((note) => note.entity_type !== entityType || note.entity_id !== entityId)) {
    throw new TypeError("The server returned notes for a different entity");
  }
  return { notes };
}

function parseNoteResponse(
  value: unknown,
  entityType: NoteEntityType,
  entityId: string,
): { note: Note } {
  if (!isRecord(value) || !("note" in value)) {
    throw new TypeError("The server returned an invalid note response");
  }
  const note = parseNote(value.note);
  if (note.entity_type !== entityType || note.entity_id !== entityId) {
    throw new TypeError("The server returned a note for a different entity");
  }
  return { note };
}

export interface NotesPanelProps {
  /** What the notes are attached to. */
  entityType: NoteEntityType;
  /** The entity's id (uuid). */
  entityId: string;
  /** Heading text (default "Notes"). Use "Comments" on screens where that reads better. */
  title?: string;
  /** Heading level of the title (default 2). */
  headingLevel?: 2 | 3 | 4;
  className?: string;
}

function sortOldestFirst(notes: readonly Note[]): Note[] {
  return notes.toSorted((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
}

/**
 * Comments on an idea, script, video or experiment: the list (author, human/agent, time, sanitised
 * markdown body) and an add form. Talks to `/api/notes` (packages/shared/src/api/notes.ts) and
 * refreshes with the app's 12 s polling, so a note an agent adds shows up without a reload.
 *
 * Needs Read on notes to show anything; the form is disabled (with the reason) without Write on
 * notes or while offline.
 */
export function NotesPanel({
  entityType,
  entityId,
  title = "Notes",
  headingLevel = 2,
  className,
}: NotesPanelProps) {
  const readLevel = useLevel("notes");
  const queryClient = useQueryClient();
  const key = notesQueryKey(entityType, entityId);
  const headingId = useId();
  const Heading = `h${headingLevel}` as const;

  const query = useQuery({
    queryKey: key,
    enabled: readLevel !== "none",
    queryFn: ({ signal }) =>
      api.get(NOTES_PATH, {
        query: { entity_type: entityType, entity_id: entityId },
        parse: { parse: (value: unknown) => parseNotesResponse(value, entityType, entityId) },
        signal,
      }),
  });

  const [draft, setDraft] = useState("");
  const [validation, setValidation] = useState<string | null>(null);
  const [added, setAdded] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const add = useMutation({
    mutationFn: (body_md: string) =>
      api.post(
        NOTES_PATH,
        { entity_type: entityType, entity_id: entityId, body_md },
        { parse: { parse: (value: unknown) => parseNoteResponse(value, entityType, entityId) } },
      ),
    onSuccess: ({ note }) => {
      queryClient.setQueryData(key, (old: { notes: Note[] } | undefined) => ({
        notes: [...(old?.notes ?? []).filter((n) => n.id !== note.id), note],
      }));
      void queryClient.invalidateQueries({ queryKey: key });
      setDraft("");
      setAdded(true);
      textareaRef.current?.focus();
    },
  });

  function submit(event?: FormEvent) {
    event?.preventDefault();
    setAdded(false);
    if (draft.trim().length === 0) {
      setValidation("A note cannot be empty");
      return;
    }
    if (new TextEncoder().encode(draft).length > NOTE_BODY_MAX_BYTES) {
      setValidation(`A note can be at most ${NOTE_BODY_MAX_BYTES} bytes`);
      return;
    }
    setValidation(null);
    add.mutate(draft);
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) submit();
  }

  const notes = query.data ? sortOldestFirst(query.data.notes) : [];

  return (
    <section aria-labelledby={headingId} className={cx("flex min-w-0 flex-col gap-4", className)}>
      <Heading id={headingId} className="flex items-center gap-2 text-lg font-semibold">
        <MessageSquare aria-hidden="true" className="size-5 text-ink-muted" />
        {title}
        {notes.length > 0 ? (
          <span className="text-sm font-normal text-ink-muted">({notes.length})</span>
        ) : null}
      </Heading>

      {readLevel === "none" ? (
        <Alert tone="info">You do not have access to notes.</Alert>
      ) : query.isPending ? (
        <LoadingState compact lines={3} label={`Loading ${title.toLowerCase()}`} />
      ) : query.isError && !query.data ? (
        <ErrorState
          compact
          error={query.error}
          onRetry={() => void query.refetch()}
          retrying={query.isFetching}
        />
      ) : notes.length === 0 ? (
        <EmptyState
          compact
          title="No notes yet"
          description="Notes added by you or by agents show up here."
        />
      ) : (
        <ol className="flex flex-col gap-3">
          {notes.map((note) => (
            <li key={note.id} className="rounded-lg border border-line bg-surface p-3">
              <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                <strong className="font-semibold">{note.author}</strong>
                {note.actor_type === "agent" ? <Badge tone="info">Agent</Badge> : null}
                <time
                  dateTime={note.created_at}
                  title={formatDateTime(note.created_at)}
                  className="text-ink-muted"
                >
                  {formatRelativeTime(note.created_at)}
                </time>
              </div>
              <MarkdownView markdown={note.body_md} headingStart={4} className="text-base" />
            </li>
          ))}
        </ol>
      )}

      {readLevel !== "none" ? (
        <WriteGuard resource="notes">
          <form onSubmit={submit} className="flex flex-col gap-2" noValidate>
            <TextAreaField
              ref={textareaRef}
              label={`Add to ${title.toLowerCase()}`}
              hint="Markdown is supported. Press Ctrl+Enter to send."
              value={draft}
              onChange={(event) => {
                setDraft(event.target.value);
                setAdded(false);
                if (validation) setValidation(null);
              }}
              onKeyDown={onKeyDown}
              error={validation}
              rows={3}
            />
            {add.isError ? (
              <Alert tone="danger" title="The note was not saved">
                {describeError(add.error)}
              </Alert>
            ) : null}
            {added ? <Alert tone="ok">Note added.</Alert> : null}
            <div>
              <Button type="submit" variant="primary" busy={add.isPending}>
                Add note
              </Button>
            </div>
          </form>
        </WriteGuard>
      ) : null}
    </section>
  );
}
