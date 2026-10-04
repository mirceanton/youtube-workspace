import type { QueryClient } from "@tanstack/react-query";
import type { Resource } from "@ytw/shared/constants";

const INVALIDATION_PREFIXES: Readonly<Record<Resource, readonly (readonly string[])[]>> = {
  ideas: [["ideas"], ["dashboard"], ["search"], ["activity"]],
  scripts: [["scripts"], ["ideas"], ["dashboard"], ["search"], ["activity"]],
  experiments: [["experiments"], ["dashboard"], ["activity"]],
  videos: [["videos"], ["experiments"], ["ideas"], ["dashboard"], ["activity"]],
  notes: [["notes"], ["dashboard"], ["activity"]],
  activity: [["activity"], ["dashboard"]],
};

/** Invalidate the feature queries whose summaries or detail views depend on each changed resource. */
export async function invalidateChangedQueryCaches(
  queryClient: QueryClient,
  resources: readonly Resource[],
): Promise<void> {
  const prefixes = new Map<string, readonly string[]>();
  for (const resource of resources) {
    for (const prefix of INVALIDATION_PREFIXES[resource]) {
      prefixes.set(prefix[0] ?? "", prefix);
    }
  }
  await Promise.all(
    [...prefixes.values()].map((queryKey) => queryClient.invalidateQueries({ queryKey })),
  );
}
