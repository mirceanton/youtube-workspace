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
import { describeError } from "@/lib/errors.ts";
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
  onSave: (input: { variantId: string; impressions?: string; ctr?: string }) => void;
}) {
  const [impressions, setImpressions] = useState(variant.impressions ?? "");
  const [ctr, setCtr] = useState(variant.ctr ?? "");

  function submit(event: FormEvent) {
    event.preventDefault();
    if (impressions === "" && ctr === "") return;
    onSave({
      variantId: variant.id,
      ...(impressions === "" ? {} : { impressions }),
      ...(ctr === "" ? {} : { ctr }),
    });
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
            onChange={(event) => setImpressions(event.target.value)}
          />
          <TextField
            label="CTR (%)"
            type="number"
            min="0"
            max="100"
            step="any"
            value={ctr}
            onChange={(event) => setCtr(event.target.value)}
          />
        </div>
        <Button type="submit" busy={pending} disabled={impressions === "" && ctr === ""}>
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
      await invalidateExperiment(queryClient, experimentId, detailKey);
    },
    onError: async () => {
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
    if (!experiment) return [];
    return [
      experiment.starts_at ? { x: experiment.starts_at, label: "Experiment started" } : null,
      experiment.ends_at ? { x: experiment.ends_at, label: "Experiment ended" } : null,
    ].filter((marker): marker is ChartMarker => marker !== null);
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
    const form = new FormData(event.currentTarget);
    const winner = String(form.get("winner_variant_id") ?? "");
    const conclusion = String(form.get("conclusion") ?? "").trim();
    if (conclusion) {
      concludeMutation.mutate({ winnerVariantId: winner || null, conclusion });
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
                  onSave={(input) => statsMutation.mutate(input)}
                />
              ) : (
                <p className="mt-3 text-sm text-ink-muted">Last recorded by {variant.updated_by}</p>
              )}
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
            ) : (
              <WriteGuard resource="experiments">
                <Button
                  variant="secondary"
                  busy={statusMutation.isPending}
                  onClick={() => statusMutation.mutate("cancelled")}
                >
                  Cancel experiment
                </Button>
              </WriteGuard>
            )}
          </div>
          {statusMutation.isError ? (
            <Alert tone="danger" className="mt-3" title="Could not update experiment status">
              {describeError(statusMutation.error)}
            </Alert>
          ) : null}
          {experiment.status === "running" ? (
            <form className="mt-5 grid gap-3 border-t border-line pt-4" onSubmit={submitConclusion}>
              <h3 className="font-semibold">Conclude experiment</h3>
              <SelectField label="Winning variant" name="winner_variant_id" defaultValue="">
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
                hint="Summarize the result. Choose No winner if the experiment was inconclusive."
              />
              {concludeMutation.isError ? (
                <Alert tone="danger" title="Could not conclude experiment">
                  {describeError(concludeMutation.error)}
                </Alert>
              ) : null}
              <WriteGuard resource="experiments" explain={false}>
                <Button type="submit" variant="primary" busy={concludeMutation.isPending}>
                  Save conclusion
                </Button>
              </WriteGuard>
            </form>
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
