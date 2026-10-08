import { useInfiniteQuery } from "@tanstack/react-query";
import { ACTOR_TYPES } from "@ytw/shared/constants";
import {
  ACTIVITY_PATH,
  ACTIVITY_PAGE_SIZE,
  activityResponseSchema,
} from "@ytw/shared/api/activity";
import { useMemo, useState } from "react";
import { Badge } from "@/kit/Badge.tsx";
import { Button } from "@/kit/Button.tsx";
import { Card } from "@/kit/Card.tsx";
import { SelectField, TextField } from "@/kit/Field.tsx";
import { PageHeader } from "@/kit/PageHeader.tsx";
import { EmptyState, ErrorState, LoadingState } from "@/kit/states.tsx";
import { api } from "@/lib/api.ts";
import { formatDateTime } from "@/lib/format.ts";

const ENTITY_TYPES = [
  "idea",
  "script",
  "note",
  "video",
  "video_metric",
  "experiment",
  "experiment_variant",
  "user",
  "user_permission",
  "api_token",
  "api_token_permission",
] as const;

function dateStart(value: string): string | undefined {
  if (!value) return undefined;
  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month || !day) return undefined;
  return new Date(year, month - 1, day).toISOString();
}

function dateExclusiveEnd(value: string): string | undefined {
  if (!value) return undefined;
  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month || !day) return undefined;
  return new Date(year, month - 1, day + 1).toISOString();
}

export function Component() {
  const [actor, setActor] = useState("");
  const [actorType, setActorType] = useState<(typeof ACTOR_TYPES)[number] | "">("");
  const [entityType, setEntityType] = useState("");
  const [entityId, setEntityId] = useState("");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const filters = useMemo(
    () => ({
      ...(actor.trim() ? { actor: actor.trim() } : {}),
      ...(actorType ? { actor_type: actorType } : {}),
      ...(entityType ? { entity_type: entityType } : {}),
      ...(entityId.trim() ? { entity_id: entityId.trim() } : {}),
      ...(dateStart(fromDate) ? { from: dateStart(fromDate) } : {}),
      ...(dateExclusiveEnd(toDate) ? { to: dateExclusiveEnd(toDate) } : {}),
      limit: ACTIVITY_PAGE_SIZE,
    }),
    [actor, actorType, entityId, entityType, fromDate, toDate],
  );
  const query = useInfiniteQuery({
    queryKey: ["activity", "list", filters],
    queryFn: ({ signal, pageParam }) =>
      api.get(ACTIVITY_PATH, {
        query: { ...filters, ...(pageParam ? { cursor: pageParam } : {}) },
        parse: activityResponseSchema,
        signal,
      }),
    initialPageParam: "",
    getNextPageParam: (lastPage) => lastPage.next_cursor ?? undefined,
  });

  const events = query.data?.pages.flatMap((page) => page.events) ?? [];

  return (
    <div className="space-y-4">
      <PageHeader
        title="Activity"
        description="A filterable audit trail of changes made by people and agents."
      />
      <Card className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <TextField
          label="Actor"
          value={actor}
          maxLength={200}
          onChange={(event) => setActor(event.target.value)}
        />
        <SelectField
          label="Actor type"
          value={actorType}
          onChange={(event) =>
            setActorType(ACTOR_TYPES.find((type) => type === event.target.value) ?? "")
          }
        >
          <option value="">People and agents</option>
          {ACTOR_TYPES.map((type) => (
            <option key={type} value={type}>
              {type === "human" ? "Human" : "Agent"}
            </option>
          ))}
        </SelectField>
        <SelectField
          label="Entity type"
          value={entityType}
          onChange={(event) => setEntityType(event.target.value)}
        >
          <option value="">All entity types</option>
          {ENTITY_TYPES.map((type) => (
            <option key={type} value={type}>
              {type.replaceAll("_", " ")}
            </option>
          ))}
        </SelectField>
        <TextField
          label="Entity ID"
          value={entityId}
          maxLength={36}
          onChange={(event) => setEntityId(event.target.value)}
          placeholder="Optional UUID"
        />
        <TextField
          label="From date"
          type="date"
          value={fromDate}
          onChange={(event) => setFromDate(event.target.value)}
        />
        <TextField
          label="To date"
          type="date"
          value={toDate}
          onChange={(event) => setToDate(event.target.value)}
          hint="Includes this date."
        />
      </Card>

      {query.isPending ? (
        <LoadingState label="Loading activity" lines={5} />
      ) : query.isError && events.length === 0 ? (
        <ErrorState
          error={query.error}
          onRetry={() => void query.refetch()}
          retrying={query.isFetching}
        />
      ) : events.length === 0 ? (
        <EmptyState
          title="No activity matches these filters"
          description="Try a different actor, entity or date range."
        />
      ) : (
        <>
          <ul className="grid min-w-0 gap-3">
            {events.map((event) => (
              <li key={event.id}>
                <Card>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold">{event.actor}</span>
                    <Badge tone={event.actor_type === "agent" ? "info" : "neutral"}>
                      {event.actor_type === "agent" ? "Agent" : "Human"}
                    </Badge>
                    <Badge>{event.action}</Badge>
                  </div>
                  <p className="mt-2 text-sm">
                    {event.entity_type ?? "Workspace"}
                    {event.entity_id ? ` · ${event.entity_id}` : ""}
                  </p>
                  <time className="mt-1 block text-sm text-ink-muted" dateTime={event.created_at}>
                    {formatDateTime(event.created_at)}
                  </time>
                </Card>
              </li>
            ))}
          </ul>
          {query.isError ? (
            <ErrorState
              compact
              error={query.error}
              onRetry={() => void query.refetch()}
              retrying={query.isFetching}
            />
          ) : null}
          {query.hasNextPage ? (
            <div className="flex justify-center">
              <Button
                variant="secondary"
                onClick={() => void query.fetchNextPage()}
                busy={query.isFetchingNextPage}
              >
                Load more activity
              </Button>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
