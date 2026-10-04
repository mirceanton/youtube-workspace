import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState, type FormEvent } from "react";
import { useParams } from "react-router";
import {
  concludeExperimentResponseSchema,
  EXPERIMENT_CONCLUDE_PATH,
  EXPERIMENT_CTR_HISTORY_PATH,
  EXPERIMENTS_PATH,
  experimentCtrHistoryResponseSchema,
  getExperimentResponseSchema,
  recordVariantStatsResponseSchema,
  EXPERIMENT_VARIANT_STATS_PATH,
  updateExperimentStatusResponseSchema,
  EXPERIMENT_STATUS_PATH,
  type ExperimentVariant,
} from "@ytw/shared/api/experiments";
import { Alert } from "@/kit/Alert.tsx";
import { Badge } from "@/kit/Badge.tsx";
import { Button } from "@/kit/Button.tsx";
import { Card } from "@/kit/Card.tsx";
import { SelectField, TextAreaField, TextField } from "@/kit/Field.tsx";
import { LastChangedBy } from "@/kit/LastChangedBy.tsx";
import { PageHeader } from "@/kit/PageHeader.tsx";
import { TimeSeriesChart } from "@/kit/charts/TimeSeriesChart.tsx";
import type { ChartMarker, ChartSeries } from "@/kit/charts/series.ts";
import { EmptyState, ErrorState, LoadingState } from "@/kit/states.tsx";
import { WriteGuard } from "@/kit/WriteGuard.tsx";
import { api } from "@/lib/api.ts";
import { describeError, isConflictError } from "@/lib/errors.ts";
import { formatDateTime } from "@/lib/format.ts";
import { useCan } from "@/lib/session.ts";

function experimentPath(id: string): string {
  return `${EXPERIMENTS_PATH}/${encodeURIComponent(id)}`;
}

function variantStatsPath(experimentId: string, variantId: string): string {
  return EXPERIMENT_VARIANT_STATS_PATH.replace(
    ":experiment_id",
    encodeURIComponent(experimentId),
  ).replace(":variant_id", encodeURIComponent(variantId));
}

function statusPath(id: string): string {
  return EXPERIMENT_STATUS_PATH.replace(":experiment_id", encodeURIComponent(id));
}

function concludePath(id: string): string {
  return EXPERIMENT_CONCLUDE_PATH.replace(":experiment_id", encodeURIComponent(id));
}

function historyPath(id: string): string {
  return EXPERIMENT_CTR_HISTORY_PATH.replace(":experiment_id", encodeURIComponent(id));
}

function formatPercent(value: string | null): string {
  if (value === null || !Number.isFinite(Number(value))) return "Not recorded";
  return `${Number(value).toFixed(2)}%`;
}

function formatDifference(value: string | null): string {
  if (value === null || !Number.isFinite(Number(value))) return "Not available";
  const difference = Number(value);
  if (difference === 0) return "0.00 percentage points";
  return `${difference > 0 ? "+" : ""}${difference.toFixed(2)} percentage points`;
}

function VariantStatsForm({
  variant,
  pending,
  onSave,
}: {
  variant: ExperimentVariant;
  pending: boolean;
  onSave: (input: { variantId: string; impressions?: string; ctr?: string }) => Promise<void>;
}) {
  const [impressionsDraft, setImpressionsDraft] = useState<string | null>(null);
  const [ctrDraft, setCtrDraft] = useState<string | null>(null);
  const impressions = impressionsDraft ?? variant.impressions ?? "";
  const ctr = ctrDraft ?? variant.ctr ?? "";

  const changedStats = {
    ...(impressions === "" || impressions === (variant.impressions ?? "") ? {} : { impressions }),
    ...(ctr === "" || ctr === (variant.ctr ?? "") ? {} : { ctr }),
  };
  const hasChanges = Object.keys(changedStats).length > 0;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!hasChanges) return;
    try {
      await onSave({ variantId: variant.id, ...changedStats });
      setImpressionsDraft(null);
      setCtrDraft(null);
    } catch {
      // Keep the edited fields in place so the user can correct or retry the failed save.
    }
  }

  return (
    <WriteGuard resource="experiments">
      <form className="mt-4 grid gap-3 border-t border-line pt-4" onSubmit={submit}>
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField
            label="Impressions"
            type="number"
            min="0"
            step="1"
            value={impressions}
            onChange={(event) => setImpressionsDraft(event.target.value)}
          />
          <TextField
            label="CTR (%)"
            type="number"
            min="0"
            max="100"
            step="any"
            value={ctr}
            onChange={(event) => setCtrDraft(event.target.value)}
          />
        </div>
        <Button type="submit" busy={pending} disabled={!hasChanges}>
          Record stats
        </Button>
      </form>
    </WriteGuard>
  );
}

export function Component() {
  const { experimentId = "" } = useParams();
  const validId = zUuid(experimentId);
  const canReadVideoMetrics = useCan("videos", "read");
  const queryClient = useQueryClient();
  const [conclusionDraft, setConclusionDraft] = useState({ winnerVariantId: "", conclusion: "" });
  const detailKey = ["experiments", "detail", experimentId] as const;
  const query = useQuery({
    queryKey: detailKey,
    enabled: validId,
    queryFn: ({ signal }) =>
      api.get(experimentPath(experimentId), { parse: getExperimentResponseSchema, signal }),
  });
  const historyQuery = useQuery({
    queryKey: ["experiments", "ctr-history", experimentId],
    enabled: validId && canReadVideoMetrics,
    queryFn: ({ signal }) =>
      api.get(historyPath(experimentId), {
        parse: experimentCtrHistoryResponseSchema,
        signal,
      }),
  });
  const statusMutation = useMutation({
    mutationFn: (status: "running" | "cancelled") =>
      api.patch(
        statusPath(experimentId),
        { expected_version: query.data?.experiment.version, status },
        { parse: updateExperimentStatusResponseSchema },
      ),
    onSuccess: async () => {
      await invalidateExperiment(queryClient, experimentId, detailKey);
    },
    onError: async () => {
      await queryClient.invalidateQueries({ queryKey: detailKey });
    },
  });
  const statsMutation = useMutation({
    mutationFn: (input: { variantId: string; impressions?: string; ctr?: string }) =>
      api.patch(
        variantStatsPath(experimentId, input.variantId),
        {
          ...(input.impressions === undefined ? {} : { impressions: input.impressions }),
          ...(input.ctr === undefined ? {} : { ctr: input.ctr }),
        },
        { parse: recordVariantStatsResponseSchema },
      ),
    onSuccess: async () => {
      await invalidateExperiment(queryClient, experimentId, detailKey);
    },
  });
  const concludeMutation = useMutation({
    mutationFn: (input: { winnerVariantId: string | null; conclusion: string }) =>
      api.post(
        concludePath(experimentId),
        {
          expected_version: query.data?.experiment.version,
          winner_variant_id: input.winnerVariantId,
          conclusion: input.conclusion,
        },
        { parse: concludeExperimentResponseSchema },
      ),
    onSuccess: async () => {
      setConclusionDraft({ winnerVariantId: "", conclusion: "" });
      await invalidateExperiment(queryClient, experimentId, detailKey);
    },
    onError: async (error) => {
      if (isConflictError(error)) return;
      await queryClient.invalidateQueries({ queryKey: detailKey });
    },
  });

  const experiment = query.data?.experiment;
  const history = historyQuery.data?.history;
  const series = useMemo<ChartSeries[]>(
    () => [
      {
        label: "Video CTR",
        points: (history ?? []).map((point) => ({
          x: point.captured_at,
          y: point.ctr === null ? null : Number(point.ctr),
        })),
      },
    ],
    [history],
  );
  const markers = useMemo<ChartMarker[]>(() => {
    const result: ChartMarker[] = [];
    if (experiment?.starts_at)
      result.push({ x: experiment.starts_at, label: "Experiment started" });
    if (experiment?.ends_at) result.push({ x: experiment.ends_at, label: "Experiment ended" });
    return result;
  }, [experiment]);

  if (!validId) {
    return <ErrorState title="Experiment not found" description="Choose a valid experiment." />;
  }

  if (query.isPending) {
    return (
      <>
        <PageHeader title="Experiment" back={{ to: "/experiments", label: "Experiments" }} />
        <LoadingState label="Loading experiment" lines={5} />
      </>
    );
  }
  if (query.isError) {
    return (
      <>
        <PageHeader title="Experiment" back={{ to: "/experiments", label: "Experiments" }} />
        <ErrorState
          error={query.error}
          onRetry={() => void query.refetch()}
          retrying={query.isFetching}
        />
      </>
    );
  }
  if (!experiment) return null;

  function submitConclusion(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const winner = conclusionDraft.winnerVariantId;
    const conclusion = conclusionDraft.conclusion.trim();
    if (conclusion) {
      concludeMutation.mutate({ winnerVariantId: winner || null, conclusion });
    }
  }

  async function reloadAfterConclusionConflict() {
    const result = await query.refetch();
    if (!result.isError) {
      setConclusionDraft({ winnerVariantId: "", conclusion: "" });
      concludeMutation.reset();
    }
  }

  return (
    <>
      <PageHeader
        title={experiment.video_title}
        description={`${experiment.type[0]?.toUpperCase()}${experiment.type.slice(1)} experiment`}
        back={{ to: "/experiments", label: "Experiments" }}
        actions={
          <Badge tone={experiment.status === "concluded" ? "ok" : "info"}>
            {experiment.status}
          </Badge>
        }
      />
      <LastChangedBy actor={experiment.updated_by} at={experiment.updated_at} />
      {experiment.hypothesis ? (
        <Card className="mt-4">
          <h2 className="font-semibold">Hypothesis</h2>
          <p className="mt-1 whitespace-pre-wrap text-ink-muted">{experiment.hypothesis}</p>
        </Card>
      ) : null}

      <section className="mt-6" aria-labelledby="variants-heading">
        <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
          <div>
            <h2 id="variants-heading" className="text-xl font-semibold">
              Variants
            </h2>
            <p className="text-sm text-ink-muted">
              CTR differences are measured in percentage points against the control.
            </p>
          </div>
          {experiment.starts_at ? (
            <p className="text-sm text-ink-muted">Started {formatDateTime(experiment.starts_at)}</p>
          ) : null}
        </div>
        <div className="grid min-w-0 gap-3 lg:grid-cols-2">
          {experiment.variants.map((variant) => (
            <Card key={variant.id} className="min-w-0">
              <div className="flex flex-wrap items-start gap-2">
                <h3 className="min-w-0 flex-1 text-lg font-semibold">{variant.label}</h3>
                {variant.is_control ? <Badge tone="info">Control</Badge> : null}
                {variant.is_winner ? <Badge tone="ok">Winner</Badge> : null}
              </div>
              <p className="mt-2 whitespace-pre-wrap break-words">{variant.content}</p>
              <p className="mt-2 text-sm text-ink-muted">Last recorded by {variant.updated_by}</p>
              <dl className="mt-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
                <div>
                  <dt className="text-ink-muted">Impressions</dt>
                  <dd className="font-semibold tabular-nums">
                    {variant.impressions ?? "Not recorded"}
                  </dd>
                </div>
                <div>
                  <dt className="text-ink-muted">CTR</dt>
                  <dd className="font-semibold tabular-nums">{formatPercent(variant.ctr)}</dd>
                </div>
                <div>
                  <dt className="text-ink-muted">Difference vs control</dt>
                  <dd className="font-semibold tabular-nums">
                    {formatDifference(variant.ctr_vs_control)}
                  </dd>
                </div>
              </dl>
              {experiment.status === "planned" || experiment.status === "running" ? (
                <VariantStatsForm
                  variant={variant}
                  pending={statsMutation.isPending}
                  onSave={(input) => statsMutation.mutateAsync(input).then(() => undefined)}
                />
              ) : null}
            </Card>
          ))}
        </div>
        {statsMutation.isError ? (
          <Alert tone="danger" className="mt-3" title="Could not record variant stats">
            {describeError(statsMutation.error)}
          </Alert>
        ) : null}
      </section>

      <section className="mt-6" aria-labelledby="ctr-heading">
        <Card>
          <h2 id="ctr-heading" className="text-xl font-semibold">
            CTR over time
          </h2>
          <p className="mb-4 mt-1 text-sm text-ink-muted">
            This chart uses overall video CTR metric snapshots. They are not attributed to
            individual variants. The markers show the experiment start and end.
          </p>
          {!canReadVideoMetrics ? (
            <EmptyState
              compact
              title="Video metrics are restricted"
              description="Read access to videos is needed to view this CTR history."
            />
          ) : historyQuery.isPending ? (
            <LoadingState compact label="Loading CTR history" lines={3} />
          ) : historyQuery.isError ? (
            <ErrorState
              compact
              error={historyQuery.error}
              onRetry={() => void historyQuery.refetch()}
              retrying={historyQuery.isFetching}
            />
          ) : (
            <TimeSeriesChart
              title="Video CTR snapshots"
              series={series}
              markers={markers}
              valueFormat={(value) => `${value.toFixed(2)}%`}
              yMin={0}
              emptyMessage="No video metric snapshots with CTR have been recorded."
            />
          )}
        </Card>
      </section>

      {experiment.conclusion ? (
        <Card className="mt-6">
          <h2 className="text-xl font-semibold">Conclusion</h2>
          <p className="mt-2 whitespace-pre-wrap">{experiment.conclusion}</p>
          {experiment.ends_at ? (
            <p className="mt-2 text-sm text-ink-muted">
              Ended {formatDateTime(experiment.ends_at)}
            </p>
          ) : null}
        </Card>
      ) : null}

      {experiment.status === "planned" || experiment.status === "running" ? (
        <Card className="mt-6">
          <h2 className="text-xl font-semibold">Manage experiment</h2>
          <div className="mt-3 flex flex-wrap gap-2">
            {experiment.status === "planned" ? (
              <WriteGuard resource="experiments">
                <Button
                  variant="primary"
                  busy={statusMutation.isPending}
                  onClick={() => statusMutation.mutate("running")}
                >
                  Start experiment
                </Button>
              </WriteGuard>
            ) : null}
            {experiment.status === "planned" || experiment.status === "running" ? (
              <WriteGuard resource="experiments">
                <Button
                  variant="secondary"
                  busy={statusMutation.isPending}
                  onClick={() => statusMutation.mutate("cancelled")}
                >
                  Cancel experiment
                </Button>
              </WriteGuard>
            ) : null}
          </div>
          {statusMutation.isError ? (
            <Alert tone="danger" className="mt-3" title="Could not update experiment status">
              {describeError(statusMutation.error)}
            </Alert>
          ) : null}
          {experiment.status === "running" ? (
            <form className="mt-5 grid gap-3 border-t border-line pt-4" onSubmit={submitConclusion}>
              <h3 className="font-semibold">Conclude experiment</h3>
              <SelectField
                label="Winning variant"
                name="winner_variant_id"
                value={conclusionDraft.winnerVariantId}
                onChange={(event) =>
                  setConclusionDraft((current) => ({
                    ...current,
                    winnerVariantId: event.target.value,
                  }))
                }
              >
                <option value="">No winner</option>
                {experiment.variants.map((variant) => (
                  <option key={variant.id} value={variant.id}>
                    {variant.label}
                  </option>
                ))}
              </SelectField>
              <TextAreaField
                label="Conclusion"
                name="conclusion"
                required
                rows={4}
                value={conclusionDraft.conclusion}
                onChange={(event) =>
                  setConclusionDraft((current) => ({
                    ...current,
                    conclusion: event.target.value,
                  }))
                }
                hint="Summarize the result. Choose No winner if the experiment was inconclusive."
              />
              <WriteGuard resource="experiments" explain={false}>
                <Button type="submit" variant="primary" busy={concludeMutation.isPending}>
                  Save conclusion
                </Button>
              </WriteGuard>
            </form>
          ) : null}
        </Card>
      ) : null}

      {concludeMutation.isError ? (
        <Card className="mt-6">
          <Alert tone="danger" title="Could not conclude experiment">
            {describeError(concludeMutation.error)}
          </Alert>
          {isConflictError(concludeMutation.error) ? (
            <div className="mt-3 space-y-3 text-sm">
              <p>
                Your draft is preserved. Review it before choosing to reload the latest experiment.
              </p>
              <dl className="grid gap-2 sm:grid-cols-[max-content_1fr]">
                <dt className="font-medium">Draft winner</dt>
                <dd>
                  {experiment.variants.find(
                    (variant) => variant.id === conclusionDraft.winnerVariantId,
                  )?.label ?? "No winner"}
                </dd>
                <dt className="font-medium">Draft conclusion</dt>
                <dd className="whitespace-pre-wrap">
                  {conclusionDraft.conclusion || "No conclusion entered"}
                </dd>
              </dl>
              <Button
                variant="secondary"
                busy={query.isFetching}
                onClick={() => void reloadAfterConclusionConflict()}
              >
                Reload latest experiment and discard draft
              </Button>
            </div>
          ) : null}
        </Card>
      ) : null}
    </>
  );
}

function zUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

async function invalidateExperiment(
  queryClient: ReturnType<typeof useQueryClient>,
  id: string,
  detailKey: readonly unknown[],
): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: detailKey }),
    queryClient.invalidateQueries({ queryKey: ["experiments", "list"] }),
    queryClient.invalidateQueries({ queryKey: ["experiments", "ctr-history", id] }),
  ]);
}
