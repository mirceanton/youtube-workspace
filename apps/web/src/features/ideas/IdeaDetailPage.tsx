import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { IDEA_STAGE_LABELS } from "@ytw/shared/constants";
import type { ArchiveIdeaRequest, Idea, IdeaMutationResponse } from "@ytw/shared/api/ideas";
import { Archive, Edit3, ExternalLink, FileText, PlayCircle } from "lucide-react";
import { useState } from "react";
import { Link, useParams } from "react-router";
import {
  Alert,
  Badge,
  Button,
  Card,
  ConflictDialog,
  Dialog,
  EmptyState,
  ErrorState,
  LastChangedBy,
  LoadingState,
  MarkdownView,
  NotesPanel,
  PageHeader,
  WriteGuard,
} from "@/kit";
import { api } from "@/lib/api.ts";
import { ConflictError, describeError } from "@/lib/errors.ts";
import { formatDate, formatNumber } from "@/lib/format.ts";
import { useCan as useResourceAccess } from "@/lib/session.ts";
import { IdeaEditorDialog } from "./IdeaEditorDialog.tsx";
import { fetchIdea, ideasQueryKey, IDEAS_PATH, parseIdea } from "./api.ts";
import { StageMoveDialog } from "./StageMoveDialog.tsx";
import type { IdeaStage } from "@ytw/shared/constants";

function currentFromConflict(error: unknown): Idea | null {
  if (!(error instanceof ConflictError)) return null;
  return parseIdea(error.latest);
}

export function Component() {
  const { ideaId = "" } = useParams();
  const queryClient = useQueryClient();
  const [editOpen, setEditOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [archiveConflictOpen, setArchiveConflictOpen] = useState(false);
  const [moveTarget, setMoveTarget] = useState<IdeaStage | null>(null);
  const canReadScripts = useResourceAccess("scripts", "read");
  const canReadVideos = useResourceAccess("videos", "read");

  const query = useQuery({
    queryKey: ideasQueryKey.detail(ideaId),
    queryFn: ({ signal }) => fetchIdea(ideaId, signal),
    enabled: ideaId.length > 0,
  });

  const archive = useMutation({
    mutationFn: async (idea: Idea) => {
      const body: ArchiveIdeaRequest = { expected_version: idea.version };
      return api.post<IdeaMutationResponse>(`${IDEAS_PATH}/${idea.id}/archive`, body);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ideasQueryKey.all });
      setArchiveOpen(false);
    },
    onError: (error) => {
      if (error instanceof ConflictError) setArchiveConflictOpen(true);
    },
  });

  if (query.isPending) return <LoadingState label="Loading idea" lines={6} />;
  if (query.isError && !query.data) {
    return (
      <ErrorState
        error={query.error}
        onRetry={() => void query.refetch()}
        retrying={query.isFetching}
      />
    );
  }
  const result = query.data;
  if (!result)
    return (
      <EmptyState
        title="Idea not found"
        description="This idea may have been archived or removed."
      />
    );
  const { idea, videos } = result;
  const latest = currentFromConflict(archive.error);
  const archived = idea.archived_at !== null;

  function reloadArchiveConflict() {
    if (latest) queryClient.setQueryData(ideasQueryKey.detail(ideaId), { ...result, idea: latest });
    void queryClient.invalidateQueries({ queryKey: ideasQueryKey.all });
    setArchiveConflictOpen(false);
    setArchiveOpen(false);
    archive.reset();
  }

  function closeArchiveConflict() {
    setArchiveConflictOpen(false);
    archive.reset();
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title={idea.title}
        back={{ to: "/ideas", label: "All ideas" }}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <Badge>{IDEA_STAGE_LABELS[idea.status]}</Badge>
            {idea.score === null ? (
              <Badge>Unscored</Badge>
            ) : (
              <Badge tone={idea.score >= 70 ? "ok" : "neutral"}>Score {idea.score}</Badge>
            )}
            {archived ? <Badge tone="warn">Archived</Badge> : null}
            <span>Version {idea.version}</span>
          </span>
        }
        actions={
          !archived ? (
            <WriteGuard resource="ideas" className="contents">
              <Button onClick={() => setEditOpen(true)}>
                <Edit3 aria-hidden="true" className="size-4" /> Edit
              </Button>
              <Button variant="danger" onClick={() => setArchiveOpen(true)}>
                <Archive aria-hidden="true" className="size-4" /> Archive
              </Button>
            </WriteGuard>
          ) : undefined
        }
      />

      {query.isError && query.data ? (
        <Alert tone="warn" title="Showing the last loaded version">
          {describeError(query.error)}
        </Alert>
      ) : null}

      {!archived ? (
        <div className="flex flex-wrap items-center gap-2">
          <WriteGuard resource="ideas" className="contents">
            <label htmlFor="idea-detail-stage" className="sr-only">
              Move idea to stage
            </label>
            <select
              id="idea-detail-stage"
              value={idea.status}
              onChange={(event) => {
                const next = event.target.value as IdeaStage;
                if (next !== idea.status) setMoveTarget(next);
              }}
              className="min-h-11 rounded-lg border border-line-strong bg-surface px-3 text-base text-ink"
              aria-label="Move idea to stage"
            >
              {Object.entries(IDEA_STAGE_LABELS).map(([stage, label]) => (
                <option key={stage} value={stage}>
                  {label}
                </option>
              ))}
            </select>
          </WriteGuard>
          <p className="text-sm text-ink-muted">
            A backward move requires a note. The server checks all transitions.
          </p>
        </div>
      ) : null}

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.5fr)_minmax(18rem,0.8fr)]">
        <div className="space-y-5">
          <Card>
            <h2 className="mb-3 text-lg font-semibold">Pitch</h2>
            {idea.pitch ? (
              <MarkdownView markdown={idea.pitch} headingStart={3} />
            ) : (
              <p className="text-sm text-ink-muted">No pitch yet.</p>
            )}
            {idea.source ? (
              <p className="mt-4 text-sm text-ink-muted">
                <span className="font-medium text-ink">Source:</span> {idea.source}
              </p>
            ) : null}
            {idea.tags.length > 0 ? (
              <ul aria-label="Tags" className="mt-4 flex flex-wrap gap-2">
                {idea.tags.map((tag) => (
                  <li key={tag}>
                    <Badge>{tag}</Badge>
                  </li>
                ))}
              </ul>
            ) : null}
            <LastChangedBy
              actor={idea.updated_by}
              at={idea.updated_at}
              className="mt-5 border-t border-line pt-3"
            />
          </Card>

          <Card>
            <h2 className="mb-3 flex items-center gap-2 text-lg font-semibold">
              <FileText aria-hidden="true" className="size-5 text-ink-muted" /> Linked scripts
            </h2>
            {!canReadScripts ? (
              <p className="text-sm text-ink-muted">You do not have access to scripts.</p>
            ) : (
              <ul className="divide-y divide-line">
                {[
                  { kind: "script" as const, label: "Script", latest: idea.latest_script },
                  {
                    kind: "packaging" as const,
                    label: "Packaging",
                    latest: idea.latest_packaging,
                  },
                ].map(({ kind, label, latest: document }) => (
                  <li
                    key={kind}
                    className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0"
                  >
                    <div>
                      <p className="font-medium">
                        {document
                          ? `${label} · version ${document.version}`
                          : `${label} · not started`}
                      </p>
                      {document ? (
                        <p className="text-sm text-ink-muted">
                          {document.status} · saved {formatDate(document.saved_at)}
                        </p>
                      ) : null}
                    </div>
                    <Link
                      to={`/scripts/${idea.id}/${kind}`}
                      className="inline-flex min-h-11 items-center gap-1 rounded-lg px-3 font-medium text-link hover:bg-subtle"
                    >
                      {document ? `Open ${label.toLowerCase()}` : `Start ${label.toLowerCase()}`}
                      <ExternalLink aria-hidden="true" className="size-4" />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card>
            <h2 className="mb-3 flex items-center gap-2 text-lg font-semibold">
              <PlayCircle aria-hidden="true" className="size-5 text-ink-muted" /> Linked videos
            </h2>
            {!canReadVideos ? (
              <p className="text-sm text-ink-muted">You do not have access to videos.</p>
            ) : !videos || videos.length === 0 ? (
              <p className="text-sm text-ink-muted">No videos are linked to this idea.</p>
            ) : (
              <ul className="flex flex-col gap-3">
                {videos.map((video) => (
                  <li key={video.id}>
                    <Link
                      to={`/videos/${video.id}`}
                      className="block rounded-lg border border-line p-3 hover:bg-subtle focus-visible:outline-2 focus-visible:outline-focus"
                    >
                      <span className="font-semibold text-link">{video.title}</span>
                      <span className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-sm text-ink-muted">
                        <span>
                          Published:{" "}
                          {video.published_at ? formatDate(video.published_at) : "not set"}
                        </span>
                        {video.views !== null ? (
                          <span>Views: {formatNumber(Number(video.views))}</span>
                        ) : null}
                        {video.ctr !== null ? <span>CTR: {video.ctr}%</span> : null}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        <div className="space-y-5">
          <Card>
            <h2 className="mb-3 text-lg font-semibold">Pipeline details</h2>
            <dl className="grid grid-cols-2 gap-x-3 gap-y-4 text-sm">
              <dt className="text-ink-muted">Stage</dt>
              <dd className="font-medium">{IDEA_STAGE_LABELS[idea.status]}</dd>
              <dt className="text-ink-muted">Time in stage</dt>
              <dd className="font-medium">
                {idea.days_in_stage} {idea.days_in_stage === 1 ? "day" : "days"}
              </dd>
              <dt className="text-ink-muted">Created</dt>
              <dd className="font-medium">{formatDate(idea.created_at)}</dd>
              <dt className="text-ink-muted">Created by</dt>
              <dd className="font-medium break-words">{idea.created_by}</dd>
            </dl>
          </Card>
          <NotesPanel entityType="idea" entityId={idea.id} title="Notes" />
        </div>
      </div>

      <IdeaEditorDialog open={editOpen} idea={idea} onClose={() => setEditOpen(false)} />
      <Dialog
        open={archiveOpen}
        onClose={() => setArchiveOpen(false)}
        title="Archive this idea?"
        description="The idea will disappear from the active pipeline. You can still find it by including archived ideas."
        footer={
          <>
            <Button onClick={() => setArchiveOpen(false)}>Cancel</Button>
            <Button variant="danger" busy={archive.isPending} onClick={() => archive.mutate(idea)}>
              <Archive aria-hidden="true" className="size-4" /> Archive idea
            </Button>
          </>
        }
      >
        {archive.isError && !(archive.error instanceof ConflictError) ? (
          <Alert tone="danger" title="The idea was not archived">
            {describeError(archive.error)}
          </Alert>
        ) : null}
      </Dialog>
      <ConflictDialog
        open={archiveConflictOpen}
        entity="idea"
        error={archive.error instanceof ConflictError ? archive.error : null}
        changedBy={latest?.updated_by}
        latest={
          latest
            ? `${latest.title} · ${IDEA_STAGE_LABELS[latest.status]} · version ${latest.version}`
            : undefined
        }
        yours={`${idea.title} · archive version ${idea.version}`}
        onReload={reloadArchiveConflict}
        onKeepEditing={closeArchiveConflict}
      />
      <StageMoveDialog
        idea={idea}
        target={moveTarget}
        onClose={() => setMoveTarget(null)}
        onMoved={(updated) => {
          queryClient.setQueryData(ideasQueryKey.detail(ideaId), { ...result, idea: updated });
          setMoveTarget(null);
        }}
      />
    </div>
  );
}
