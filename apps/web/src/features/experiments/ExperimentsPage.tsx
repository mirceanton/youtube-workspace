import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router";
import {
  createExperimentRequestSchema,
  createExperimentResponseSchema,
  EXPERIMENTS_PATH,
  EXPERIMENTS_LIST_LIMIT,
  EXPERIMENT_VIDEOS_PATH,
  listExperimentVideosResponseSchema,
  listExperimentsResponseSchema,
} from "@ytw/shared/api/experiments";
import { EXPERIMENT_TYPES, type ExperimentType } from "@ytw/shared/constants";
import { Alert } from "@/kit/Alert.tsx";
import { Badge } from "@/kit/Badge.tsx";
import { Button } from "@/kit/Button.tsx";
import { Card } from "@/kit/Card.tsx";
import { SelectField, TextAreaField, TextField } from "@/kit/Field.tsx";
import { PageHeader } from "@/kit/PageHeader.tsx";
import { EmptyState, ErrorState, LoadingState } from "@/kit/states.tsx";
import { WriteGuard } from "@/kit/WriteGuard.tsx";
import { api } from "@/lib/api.ts";
import { describeError } from "@/lib/errors.ts";
import { formatDateTime } from "@/lib/format.ts";
import { useCan } from "@/lib/session.ts";

interface VariantDraft {
  label: string;
  content: string;
  is_control: boolean;
}

const NEW_VARIANT: VariantDraft = { label: "", content: "", is_control: false };
const LIST_KEY = ["experiments", "list"] as const;

function typeLabel(type: ExperimentType): string {
  return type.replace(/^./, (first) => first.toUpperCase());
}

export function Component() {
  const [creating, setCreating] = useState(false);
  const [videoId, setVideoId] = useState("");
  const [type, setType] = useState<ExperimentType>("title");
  const [hypothesis, setHypothesis] = useState("");
  const [variants, setVariants] = useState<VariantDraft[]>([
    { label: "Control", content: "", is_control: true },
    { label: "Variant B", content: "", is_control: false },
  ]);
  const canReadVideos = useCan("videos", "read");
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const query = useQuery({
    queryKey: LIST_KEY,
    queryFn: ({ signal }) =>
      api.get(EXPERIMENTS_PATH, { parse: listExperimentsResponseSchema, signal }),
  });
  const videosQuery = useQuery({
    queryKey: ["experiments", "videos"],
    enabled: creating && canReadVideos,
    queryFn: ({ signal }) =>
      api.get(EXPERIMENT_VIDEOS_PATH, { parse: listExperimentVideosResponseSchema, signal }),
  });
  const createMutation = useMutation({
    mutationFn: (body: unknown) =>
      api.post(EXPERIMENTS_PATH, body, { parse: createExperimentResponseSchema }),
    onSuccess: async ({ experiment }) => {
      await queryClient.invalidateQueries({ queryKey: LIST_KEY });
      navigate(`/experiments/${experiment.id}`);
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    const parsed = createExperimentRequestSchema.safeParse({
      video_id: videoId,
      type,
      hypothesis: hypothesis.trim() || null,
      variants,
    });
    if (parsed.success) createMutation.mutate(parsed.data);
  }

  function updateVariant(index: number, patch: Partial<VariantDraft>) {
    setVariants((current) =>
      current.map((variant, position) => (position === index ? { ...variant, ...patch } : variant)),
    );
  }

  const actions = (
    <WriteGuard resource="experiments" explain={false}>
      <Button
        variant={creating ? "secondary" : "primary"}
        onClick={() => setCreating((open) => !open)}
      >
        {creating ? "Close form" : "New experiment"}
      </Button>
    </WriteGuard>
  );

  return (
    <>
      <PageHeader
        title="Experiments"
        description="Compare packaging variants and record the results from YouTube Test & Compare."
        actions={actions}
      />

      {creating ? (
        <Card className="mb-6">
          <form className="grid min-w-0 gap-4" onSubmit={submit}>
            <h2 className="text-lg font-semibold">Plan an experiment</h2>
            {!canReadVideos ? (
              <Alert tone="warn" title="Video access required">
                Read access to videos is needed to choose which video to test.
              </Alert>
            ) : videosQuery.isPending ? (
              <LoadingState compact label="Loading videos" lines={2} />
            ) : videosQuery.isError ? (
              <ErrorState
                compact
                error={videosQuery.error}
                onRetry={() => void videosQuery.refetch()}
                retrying={videosQuery.isFetching}
              />
            ) : videosQuery.data.videos.length === 0 ? (
              <EmptyState
                compact
                title="No videos available"
                description="Register a video before planning an experiment."
              />
            ) : (
              <>
                <div className="grid gap-4 sm:grid-cols-2">
                  <SelectField
                    label="Video"
                    required
                    value={videoId}
                    onChange={(event) => setVideoId(event.target.value)}
                  >
                    <option value="">Choose a video</option>
                    {videosQuery.data.videos.map((video) => (
                      <option key={video.id} value={video.id}>
                        {video.title}
                      </option>
                    ))}
                  </SelectField>
                  <SelectField
                    label="Packaging element"
                    value={type}
                    onChange={(event) => setType(event.target.value as ExperimentType)}
                  >
                    {EXPERIMENT_TYPES.map((value) => (
                      <option key={value} value={value}>
                        {typeLabel(value)}
                      </option>
                    ))}
                  </SelectField>
                </div>
                <TextAreaField
                  label="Hypothesis"
                  value={hypothesis}
                  onChange={(event) => setHypothesis(event.target.value)}
                  rows={3}
                  hint="What do you expect the experiment to show?"
                />
                <div className="grid min-w-0 gap-3 md:grid-cols-2">
                  {variants.map((variant, index) => (
                    <Card key={index} className="grid min-w-0 gap-3 bg-canvas p-3">
                      <div className="flex items-center justify-between gap-2">
                        <h3 className="font-semibold">Variant {index + 1}</h3>
                        <label className="inline-flex min-h-11 items-center gap-2 text-sm">
                          <input
                            type="radio"
                            name="control-variant"
                            checked={variant.is_control}
                            onChange={() =>
                              setVariants((current) =>
                                current.map((item, position) => ({
                                  ...item,
                                  is_control: position === index,
                                })),
                              )
                            }
                          />
                          Control
                        </label>
                      </div>
                      <TextField
                        label="Variant label"
                        required
                        value={variant.label}
                        onChange={(event) => updateVariant(index, { label: event.target.value })}
                      />
                      <TextAreaField
                        label="Variant content or thumbnail URL"
                        required
                        value={variant.content}
                        onChange={(event) => updateVariant(index, { content: event.target.value })}
                        rows={3}
                      />
                      {variants.length > 2 ? (
                        <Button
                          onClick={() =>
                            setVariants((current) => {
                              const next = current.filter((_, position) => position !== index);
                              if (variant.is_control && next[0])
                                next[0] = { ...next[0], is_control: true };
                              return next;
                            })
                          }
                        >
                          Remove variant
                        </Button>
                      ) : null}
                    </Card>
                  ))}
                </div>
                {variants.length < 10 ? (
                  <Button
                    onClick={() => setVariants((current) => [...current, { ...NEW_VARIANT }])}
                  >
                    Add variant
                  </Button>
                ) : null}
                {createMutation.isError ? (
                  <Alert tone="danger" title="Experiment was not created">
                    {describeError(createMutation.error)}
                  </Alert>
                ) : null}
                <WriteGuard resource="experiments" explain={false}>
                  <Button type="submit" variant="primary" busy={createMutation.isPending}>
                    Create experiment
                  </Button>
                </WriteGuard>
              </>
            )}
          </form>
        </Card>
      ) : null}

      {query.isPending ? (
        <LoadingState label="Loading experiments" lines={5} />
      ) : query.isError ? (
        <ErrorState
          error={query.error}
          onRetry={() => void query.refetch()}
          retrying={query.isFetching}
        />
      ) : query.data.experiments.length === 0 ? (
        <EmptyState
          title="No experiments yet"
          description="Plan a packaging experiment to compare titles, thumbnails, or descriptions."
        />
      ) : (
        <>
          <ul className="grid min-w-0 gap-3">
            {query.data.experiments.map((experiment) => (
              <li key={experiment.id}>
                <Card className="p-0">
                  <Link
                    to={`/experiments/${experiment.id}`}
                    className="block min-h-11 rounded-xl p-4 outline-none focus-visible:ring-2 focus-visible:ring-focus"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="min-w-0 flex-1 text-lg font-semibold">
                        {experiment.video_title}
                      </h2>
                      <Badge tone={experiment.status === "concluded" ? "ok" : "info"}>
                        {experiment.status}
                      </Badge>
                      <Badge>{typeLabel(experiment.type)}</Badge>
                    </div>
                    <p className="mt-1 text-sm text-ink-muted">
                      {experiment.variants.length} variants ·{" "}
                      {experiment.starts_at
                        ? `Started ${formatDateTime(experiment.starts_at)}`
                        : `Planned ${formatDateTime(experiment.created_at)}`}
                    </p>
                    {experiment.hypothesis ? (
                      <p className="mt-2 line-clamp-2 text-sm">{experiment.hypothesis}</p>
                    ) : null}
                  </Link>
                </Card>
              </li>
            ))}
          </ul>
          {query.data.experiments.length >= EXPERIMENTS_LIST_LIMIT ? (
            <Alert tone="info" className="mt-3" title="Experiment list limit reached">
              Showing up to {EXPERIMENTS_LIST_LIMIT} experiments; additional experiments may not be
              shown.
            </Alert>
          ) : null}
        </>
      )}
    </>
  );
}
