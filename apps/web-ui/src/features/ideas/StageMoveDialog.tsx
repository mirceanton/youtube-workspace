import { useMutation, useQueryClient } from "@tanstack/react-query";
import { IDEA_STAGE_LABELS, findIdeaStageTransition, type IdeaStage } from "@ytw/shared/constants";
import type { AdvanceIdeaRequest, Idea, IdeaMutationResponse } from "@ytw/shared/api/ideas";
import { useId, useState, type FormEvent } from "react";
import { Alert, Button, ConflictDialog, Dialog, TextAreaField, useWriteGuard } from "@/kit";
import { api } from "@/lib/api.ts";
import { ConflictError, describeError } from "@/lib/errors.ts";
import { IDEAS_PATH, ideasQueryKey, parseIdea } from "./api.ts";

export interface StageMoveDialogProps {
  idea: Idea | null;
  target: IdeaStage | null;
  onClose: () => void;
  onMoved: (idea: Idea) => void;
}

/** A stage move sends the version the user read; the database validates the transition and logs a back-move note atomically. */
export function StageMoveDialog({ idea, target, onClose, onMoved }: StageMoveDialogProps) {
  const queryClient = useQueryClient();
  const formId = useId();
  const writeGuard = useWriteGuard("ideas");
  const [note, setNote] = useState("");
  const [conflictOpen, setConflictOpen] = useState(false);
  const [latestIdea, setLatestIdea] = useState<Idea | null>(null);
  const needsNote =
    idea !== null &&
    target !== null &&
    findIdeaStageTransition(idea.status, target)?.requiresNote === true;

  const move = useMutation({
    mutationFn: async () => {
      if (!idea || !target) throw new Error("Choose an idea and a destination stage");
      const body: AdvanceIdeaRequest = {
        expected_version: idea.version,
        new_status: target,
        ...(note.trim() ? { note: note.trim() } : {}),
      };
      return api.post<IdeaMutationResponse>(`${IDEAS_PATH}/${idea.id}/stage`, body);
    },
    onSuccess: async ({ idea: updated }) => {
      await queryClient.invalidateQueries({ queryKey: ideasQueryKey.all });
      onMoved(updated);
      setNote("");
    },
    onError: (error) => {
      if (error instanceof ConflictError) {
        setLatestIdea(parseIdea(error.latest));
        setConflictOpen(true);
      }
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    move.mutate();
  }

  function closeConflict() {
    setConflictOpen(false);
    move.reset();
  }

  function reloadLatest() {
    if (latestIdea) onMoved(latestIdea);
    void queryClient.invalidateQueries({ queryKey: ideasQueryKey.all });
    closeConflict();
    onClose();
  }

  return (
    <>
      <Dialog
        open={idea !== null && target !== null}
        onClose={onClose}
        title={needsNote ? "Move idea back a stage" : "Move idea to another stage"}
        description={
          idea && target
            ? `${idea.title}: ${IDEA_STAGE_LABELS[idea.status]} → ${IDEA_STAGE_LABELS[target]}`
            : undefined
        }
        footer={
          <>
            <Button onClick={onClose}>Cancel</Button>
            <Button
              type="submit"
              form={formId}
              variant="primary"
              busy={move.isPending}
              disabled={!writeGuard.allowed || (needsNote && note.trim().length === 0)}
            >
              Move idea
            </Button>
          </>
        }
      >
        <form id={formId} onSubmit={submit} className="flex flex-col gap-4" noValidate>
          {idea && target ? (
            <p className="text-sm text-ink-muted">
              Destination:{" "}
              <strong className="font-semibold text-ink">{IDEA_STAGE_LABELS[target]}</strong>
            </p>
          ) : null}
          {needsNote ? (
            <TextAreaField
              label="Why is this idea moving backward?"
              hint="The note is saved with the stage change and appears in the idea's notes."
              value={note}
              onChange={(event) => setNote(event.target.value)}
              maxLength={65_536}
              rows={3}
              required
            />
          ) : null}
          {move.isError && !(move.error instanceof ConflictError) ? (
            <Alert tone="danger" title="The stage was not changed">
              {describeError(move.error)}
            </Alert>
          ) : null}
        </form>
      </Dialog>
      <ConflictDialog
        open={conflictOpen}
        entity="idea"
        error={move.error instanceof ConflictError ? move.error : null}
        changedBy={latestIdea?.updated_by}
        latest={
          latestIdea ? `${latestIdea.title} · ${IDEA_STAGE_LABELS[latestIdea.status]}` : undefined
        }
        yours={idea && target ? `${idea.title} · ${IDEA_STAGE_LABELS[target]}` : undefined}
        onReload={reloadLatest}
        onKeepEditing={closeConflict}
      />
    </>
  );
}
