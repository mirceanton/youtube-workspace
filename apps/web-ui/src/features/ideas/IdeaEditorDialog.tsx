import { useMutation, useQueryClient } from "@tanstack/react-query";
import type {
  CreateIdeaRequest,
  Idea,
  IdeaMutationResponse,
  UpdateIdeaRequest,
} from "@ytw/shared/api/ideas";
import { useEffect, useId, useState, type FormEvent } from "react";
import {
  Alert,
  Badge,
  Button,
  ConflictDialog,
  Dialog,
  TextAreaField,
  TextField,
  WriteGuard,
  useWriteGuard,
} from "@/kit";
import { api } from "@/lib/api.ts";
import { ConflictError, describeError } from "@/lib/errors.ts";
import { IDEAS_PATH, ideasQueryKey, parseIdea } from "./api.ts";

export interface IdeaEditorDialogProps {
  open: boolean;
  idea?: Idea;
  onClose: () => void;
  onSaved?: (idea: Idea) => void;
}

function initialValues(idea?: Idea) {
  return {
    title: idea?.title ?? "",
    pitch: idea?.pitch ?? "",
    source: idea?.source ?? "",
    score: idea?.score === null || idea?.score === undefined ? "" : String(idea.score),
    tags: idea?.tags.join(", ") ?? "",
  };
}

type EditorValues = ReturnType<typeof initialValues>;
type EditorField = keyof EditorValues;

const EDITOR_FIELDS: ReadonlyArray<{ key: EditorField; label: string }> = [
  { key: "title", label: "Title" },
  { key: "pitch", label: "Pitch" },
  { key: "source", label: "Source" },
  { key: "score", label: "Score" },
  { key: "tags", label: "Tags" },
];

function rebaseValues(
  baseline: EditorValues,
  draft: EditorValues,
  latest: EditorValues,
): EditorValues {
  return Object.fromEntries(
    EDITOR_FIELDS.map(({ key }) => [key, draft[key] === baseline[key] ? latest[key] : draft[key]]),
  ) as EditorValues;
}

function parseLatest(error: unknown): Idea | null {
  if (!(error instanceof ConflictError)) return null;
  return parseIdea(error.latest);
}

function DraftFields({
  values,
  overlappingFields,
  status,
}: {
  values: EditorValues;
  overlappingFields: ReadonlySet<EditorField>;
  status: Idea["status"];
}) {
  return (
    <dl className="flex flex-col gap-2">
      <div className="min-w-0">
        <dt className="font-semibold">Status</dt>
        <dd className="text-ink-muted">{status}</dd>
      </div>
      {EDITOR_FIELDS.map(({ key, label }) => (
        <div key={key} className="min-w-0">
          <dt className="flex flex-wrap items-center gap-2 font-semibold">
            {label}
            {overlappingFields.has(key) ? <Badge tone="warn">Both changed</Badge> : null}
          </dt>
          <dd className="max-h-24 overflow-auto whitespace-pre-wrap break-words text-ink-muted">
            {values[key] || "—"}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** Create or edit an idea; updates always send the version being edited. */
export function IdeaEditorDialog({ open, idea, onClose, onSaved }: IdeaEditorDialogProps) {
  const queryClient = useQueryClient();
  const formId = useId();
  const writeGuard = useWriteGuard("ideas");
  const [values, setValues] = useState(initialValues(idea));
  const [baselineValues, setBaselineValues] = useState(initialValues(idea));
  const [expectedVersion, setExpectedVersion] = useState(idea?.version ?? 1);
  const [conflictOpen, setConflictOpen] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: async (body: CreateIdeaRequest) => {
      if (!idea) {
        return api.post<IdeaMutationResponse>(IDEAS_PATH, body);
      }
      const update: UpdateIdeaRequest = { ...body, expected_version: expectedVersion };
      return api.patch<IdeaMutationResponse>(`${IDEAS_PATH}/${idea.id}`, update);
    },
    onSuccess: async ({ idea: saved }) => {
      await queryClient.invalidateQueries({ queryKey: ideasQueryKey.all });
      onSaved?.(saved);
      onClose();
    },
    onError: (error) => {
      if (error instanceof ConflictError) setConflictOpen(true);
    },
  });

  useEffect(() => {
    if (!open) return;
    const nextValues = initialValues(idea);
    setValues(nextValues);
    setBaselineValues(nextValues);
    setExpectedVersion(idea?.version ?? 1);
    setFormError(null);
    save.reset();
    setConflictOpen(false);
    // Initial values should follow the selected idea and each opening of the editor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, idea?.id]);

  const latest = parseLatest(save.error);
  const latestValues = latest ? initialValues(latest) : undefined;
  const overlappingFields = new Set<EditorField>(
    latestValues
      ? EDITOR_FIELDS.filter(
          ({ key }) =>
            values[key] !== baselineValues[key] && latestValues[key] !== baselineValues[key],
        ).map(({ key }) => key)
      : [],
  );

  function setField(field: keyof ReturnType<typeof initialValues>, value: string) {
    setValues((current) => ({ ...current, [field]: value }));
    setFormError(null);
    save.reset();
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const score = values.score === "" ? null : Number(values.score);
    const input: CreateIdeaRequest = {
      title: values.title.trim(),
      pitch: values.pitch === "" ? null : values.pitch,
      source: values.source.trim() === "" ? null : values.source.trim(),
      score,
      tags: values.tags
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean),
    };
    const issue = validateIdea(input);
    if (issue) {
      setFormError(issue);
      return;
    }
    setFormError(null);
    save.mutate(input);
  }

  function reloadLatest() {
    if (latest) {
      const nextValues = initialValues(latest);
      setValues(nextValues);
      setBaselineValues(nextValues);
      setExpectedVersion(latest.version);
    }
    void queryClient.invalidateQueries({ queryKey: ideasQueryKey.all });
    setConflictOpen(false);
    save.reset();
  }

  function mergeLatest() {
    if (!latest || !latestValues) return;
    // Fields untouched since opening adopt the server's latest value. Local edits remain in
    // the draft so the following PATCH cannot overwrite unrelated remote changes.
    setValues((draft) => rebaseValues(baselineValues, draft, latestValues));
    setBaselineValues(latestValues);
    setExpectedVersion(latest.version);
    setConflictOpen(false);
    save.reset();
  }

  function keepEditing() {
    setConflictOpen(false);
    save.reset();
  }

  return (
    <>
      <Dialog
        open={open}
        onClose={onClose}
        title={idea ? "Edit idea" : "Create idea"}
        description={
          idea
            ? "Saving creates a new item version. Your edits are checked against the version you opened."
            : "Add an idea to the inbox. You can add detail and move it through the pipeline later."
        }
        footer={
          <>
            <Button onClick={onClose}>Cancel</Button>
            <Button
              type="submit"
              form={formId}
              variant="primary"
              busy={save.isPending}
              disabled={!writeGuard.allowed}
            >
              {idea ? "Save changes" : "Create idea"}
            </Button>
          </>
        }
      >
        <WriteGuard resource="ideas">
          <form id={formId} onSubmit={submit} className="flex flex-col gap-4" noValidate>
            <TextField
              label="Title"
              value={values.title}
              onChange={(event) => setField("title", event.target.value)}
              maxLength={500}
              required
            />
            <TextAreaField
              label="Pitch"
              hint="What is the video about, and why might viewers care?"
              value={values.pitch}
              onChange={(event) => setField("pitch", event.target.value)}
              maxLength={20_000}
              rows={4}
            />
            <TextField
              label="Source"
              value={values.source}
              onChange={(event) => setField("source", event.target.value)}
              maxLength={200}
            />
            <TextField
              label="Score"
              hint="Optional priority from 0 to 100."
              type="number"
              min={0}
              max={100}
              step={1}
              value={values.score}
              onChange={(event) => setField("score", event.target.value)}
            />
            <TextField
              label="Tags"
              hint="Separate tags with commas."
              value={values.tags}
              onChange={(event) => setField("tags", event.target.value)}
              maxLength={3_250}
            />
            {formError ? (
              <Alert tone="danger" title="Check the idea details">
                {formError}
              </Alert>
            ) : null}
            {save.isError && !(save.error instanceof ConflictError) ? (
              <Alert tone="danger" title="The idea was not saved">
                {describeError(save.error)}
              </Alert>
            ) : null}
          </form>
        </WriteGuard>
      </Dialog>
      <ConflictDialog
        open={conflictOpen}
        entity="idea"
        error={save.error instanceof ConflictError ? save.error : null}
        changedBy={latest?.updated_by}
        latest={
          latestValues ? (
            <div className="flex flex-col gap-2">
              <p className="text-ink-muted">
                Merge uses the latest value for fields you left unchanged. Fields marked “Both
                changed” keep your draft value.
              </p>
              <DraftFields
                values={latestValues}
                overlappingFields={overlappingFields}
                status={latest?.status ?? "inbox"}
              />
            </div>
          ) : undefined
        }
        yours={
          <DraftFields
            values={values}
            overlappingFields={overlappingFields}
            status={idea?.status ?? "inbox"}
          />
        }
        onReload={reloadLatest}
        onMerge={latest ? mergeLatest : undefined}
        onKeepEditing={keepEditing}
      />
    </>
  );
}

function validateIdea(input: CreateIdeaRequest): string | null {
  if (input.title.length < 1 || input.title.length > 500) {
    return "Title must contain between 1 and 500 characters.";
  }
  if (typeof input.pitch === "string" && input.pitch.length > 20_000) {
    return "Pitch must be at most 20,000 characters.";
  }
  if (typeof input.source === "string" && (input.source.length < 1 || input.source.length > 200)) {
    return "Source must contain between 1 and 200 characters.";
  }
  if (input.tags && input.tags.length > 50) return "Use no more than 50 tags.";
  if (input.tags?.some((tag) => tag.length < 1 || tag.length > 64)) {
    return "Each tag must contain between 1 and 64 characters.";
  }
  if (
    typeof input.score === "number" &&
    (!Number.isInteger(input.score) || input.score < 0 || input.score > 100)
  ) {
    return "Score must be a whole number from 0 to 100.";
  }
  return null;
}
