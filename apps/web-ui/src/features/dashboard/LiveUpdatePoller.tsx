import { useQuery, useQueryClient } from "@tanstack/react-query";
import { RESOURCES, type Resource } from "@ytw/shared/constants";
import { useEffect, useRef } from "react";
import { api } from "@/lib/api.ts";
import { invalidateChangedQueryCaches } from "./live-updates.ts";

const ACTIVITY_CHANGES_PATH = "/api/activity/changes";

interface ActivityChangesResponse {
  changed_resources: Resource[];
  cursor: string | null;
  has_more: boolean;
}

function parseActivityChanges(value: unknown): ActivityChangesResponse {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("The activity changes response must be an object");
  }
  const response = value as Record<string, unknown>;
  const resources = response.changed_resources;
  if (
    !Array.isArray(resources) ||
    !resources.every(
      (resource) =>
        typeof resource === "string" && (RESOURCES as readonly string[]).includes(resource),
    ) ||
    (response.cursor !== null && typeof response.cursor !== "string") ||
    typeof response.has_more !== "boolean"
  ) {
    throw new Error("The activity changes response has an unexpected shape");
  }
  return {
    changed_resources: resources as Resource[],
    cursor: response.cursor,
    has_more: response.has_more,
  };
}

/** Mounted by AppShell so event-driven invalidation stays active on every signed-in screen. */
export function LiveUpdatePoller() {
  const queryClient = useQueryClient();
  const cursor = useRef<string | undefined>(undefined);
  const { data, refetch } = useQuery({
    queryKey: ["live-updates"],
    queryFn: async ({ signal }) => {
      const changes = await api.get(ACTIVITY_CHANGES_PATH, {
        query: cursor.current === undefined ? undefined : { since: cursor.current },
        parse: { parse: parseActivityChanges },
        signal,
      });
      cursor.current = changes.cursor ?? undefined;
      return changes;
    },
  });

  useEffect(() => {
    if (!data) return;
    if (data.changed_resources.length > 0) {
      void invalidateChangedQueryCaches(queryClient, data.changed_resources);
    }
    if (data.has_more) void refetch();
  }, [data, queryClient, refetch]);

  return null;
}
