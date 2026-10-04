import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  CreateVideoRequest,
  UpdateVideoRequest,
  Video,
  VideoMutationResponse,
} from "@ytw/shared/api/videos";
import { useEffect, useState, type FormEvent } from "react";
import { Alert, Button, ConflictDialog, Dialog, SelectField, TextField, WriteGuard } from "@/kit";
import { api } from "@/lib/api.ts";
import { ConflictError, describeError } from "@/lib/errors.ts";
import { useCan } from "@/lib/session.ts";
import { fetchIdeas } from "../ideas/api.ts";
import { parseVideo, VIDEOS_PATH, videosQueryKey } from "./api.ts";

export interface VideoEditorDialogProps {
  open: boolean;
  video?: Video;
  onClose: () => void;
  onSaved?: (video: Video) => void;
}

function padDatePart(part: number): string {
  return String(part).padStart(2, "0");
}

function toLocalDateTime(value?: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getFullYear()}-${padDatePart(date.getMonth() + 1)}-${padDatePart(date.getDate())}T${padDatePart(date.getHours())}:${padDatePart(date.getMinutes())}`;
}

function initial(video?: Video) {
  return {
    title: video?.title ?? "",
    youtubeId: video?.youtube_id ?? "",
    publishedAt: toLocalDateTime(video?.published_at),
    thumbnailUrl: video?.thumbnail_url ?? "",
    ideaId: video?.idea_id ?? "",
  };
}

type Values = ReturnType<typeof initial>;

export function VideoEditorDialog({ open, video, onClose, onSaved }: VideoEditorDialogProps) {
  const queryClient = useQueryClient();
  const canReadIdeas = useCan("ideas", "read");
  const [values, setValues] = useState<Values>(initial(video));
  const [expectedVersion, setExpectedVersion] = useState(video?.version ?? 1);
  const [conflictOpen, setConflictOpen] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const ideasQuery = useQuery({
    queryKey: ["ideas", "video-editor-options"],
    queryFn: ({ signal }) =>
      fetchIdeas({ limit: 500, sort_by: "title", sort_order: "asc" }, signal),
    enabled: open && canReadIdeas,
  });

  const save = useMutation({
    mutationFn: (input: CreateVideoRequest) => {
      if (!video) return api.post<VideoMutationResponse>(VIDEOS_PATH, input);
      const update: UpdateVideoRequest = {
        expected_version: expectedVersion,
        title: input.title,
        published_at: input.published_at,
        thumbnail_url: input.thumbnail_url,
        idea_id: input.idea_id,
      };
      return api.patch<VideoMutationResponse>(`${VIDEOS_PATH}/${video.id}`, update);
    },
    onSuccess: async ({ video: saved }) => {
      await queryClient.invalidateQueries({ queryKey: videosQueryKey.all });
      await queryClient.invalidateQueries({ queryKey: videosQueryKey.detail(saved.id) });
      onSaved?.(saved);
      onClose();
    },
    onError: (error) => {
      if (error instanceof ConflictError) setConflictOpen(true);
    },
  });

  useEffect(() => {
    if (!open) return;
    setValues(initial(video));
    setExpectedVersion(video?.version ?? 1);
    setFormError(null);
    setConflictOpen(false);
    save.reset();
    // Values are reset when the selected video changes or the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, video?.id]);

  function setField(field: keyof Values, value: string) {
    setValues((current) => ({ ...current, [field]: value }));
    setFormError(null);
    save.reset();
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const youtubeId = values.youtubeId.trim();
    if (!video && !/^[A-Za-z0-9_-]{11}$/.test(youtubeId)) {
      setFormError("Enter the 11-character YouTube video ID, not the full URL.");
      return;
    }
    if (
      values.ideaId.trim() &&
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        values.ideaId.trim(),
      )
    ) {
      setFormError("Choose an idea or enter a valid idea ID.");
      return;
    }
    const input: CreateVideoRequest = {
      title: values.title.trim(),
      youtube_id: video?.youtube_id ?? youtubeId,
      published_at: values.publishedAt ? new Date(values.publishedAt).toISOString() : null,
      thumbnail_url: values.thumbnailUrl.trim() || null,
      idea_id: values.ideaId.trim() || null,
    };
    if (!input.title) {
      setFormError("A title is required.");
      return;
    }
    setFormError(null);
    save.mutate(input);
  }

  const latest = save.error instanceof ConflictError ? parseVideo(save.error.latest) : null;

  function reloadLatest() {
    if (latest) {
      setValues(initial(latest));
      setExpectedVersion(latest.version);
    }
    setConflictOpen(false);
    save.reset();
  }

  return (
    <>
      <Dialog
        open={open}
        onClose={onClose}
        title={video ? "Edit video" : "Register video"}
        description={
          video
            ? "Update the video record. YouTube metrics stay in their snapshot history."
            : "Add a published or scheduled YouTube video to the workspace."
        }
        footer={
          <>
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" type="submit" form="video-editor-form" busy={save.isPending}>
              {video ? "Save changes" : "Register video"}
            </Button>
          </>
        }
      >
        <WriteGuard resource="videos">
          <form id="video-editor-form" onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
            {!video ? (
              <TextField
                label="YouTube video ID"
                value={values.youtubeId}
                onChange={(event) => setField("youtubeId", event.target.value)}
                placeholder="dQw4w9WgXcQ"
                required
                maxLength={11}
                hint="Enter the 11-character ID from the YouTube watch URL."
                className="sm:col-span-2"
              />
            ) : null}
            <TextField
              label="Title"
              value={values.title}
              onChange={(event) => setField("title", event.target.value)}
              required
              maxLength={500}
              className="sm:col-span-2"
            />
            <TextField
              label="Published or scheduled at"
              type="datetime-local"
              value={values.publishedAt}
              onChange={(event) => setField("publishedAt", event.target.value)}
              hint="Leave empty when the video has no publication date yet."
            />
            <TextField
              label="Thumbnail URL"
              type="text"
              value={values.thumbnailUrl}
              onChange={(event) => setField("thumbnailUrl", event.target.value)}
              maxLength={2048}
              hint="Optional. Use an HTTPS URL or a path."
            />
            {canReadIdeas ? (
              <SelectField
                label="Originating idea"
                value={values.ideaId}
                onChange={(event) => setField("ideaId", event.target.value)}
                hint="You can leave this unlinked and add an idea later."
                className="sm:col-span-2"
              >
                <option value="">No linked idea</option>
                {(ideasQuery.data?.ideas ?? []).map((idea) => (
                  <option key={idea.id} value={idea.id}>
                    {idea.title}
                  </option>
                ))}
              </SelectField>
            ) : (
              <TextField
                label="Originating idea ID"
                value={values.ideaId}
                onChange={(event) => setField("ideaId", event.target.value)}
                hint="Optional UUID. The idea link appears when you also have Read access to ideas."
                className="sm:col-span-2"
              />
            )}
            {formError ? (
              <Alert tone="danger" title="Check the video details" className="sm:col-span-2">
                {formError}
              </Alert>
            ) : null}
            {save.isError && !(save.error instanceof ConflictError) ? (
              <Alert tone="danger" title="Could not save video" className="sm:col-span-2">
                {describeError(save.error)}
              </Alert>
            ) : null}
          </form>
        </WriteGuard>
      </Dialog>
      <ConflictDialog
        open={conflictOpen}
        entity="video"
        error={save.error instanceof ConflictError ? save.error : null}
        latest={
          latest ? (
            <p>
              {latest.title} · Version {latest.version}
            </p>
          ) : undefined
        }
        onReload={reloadLatest}
        onKeepEditing={() => setConflictOpen(false)}
      />
    </>
  );
}
