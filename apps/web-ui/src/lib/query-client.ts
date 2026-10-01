import { QueryClient } from "@tanstack/react-query";
import { LIVE_UPDATE_INTERVAL_MS } from "@ytw/shared/constants";
import { isClientError, ResponseShapeError } from "./errors.ts";

const MAX_RETRIES = 2;

/**
 * 4xx answers (401, 403, 404, 409, 400) and responses in an unexpected shape are final; network
 * failures and 5xx get two more tries.
 */
export function shouldRetry(failureCount: number, error: unknown): boolean {
  if (isClientError(error) || error instanceof ResponseShapeError) return false;
  return failureCount < MAX_RETRIES;
}

/**
 * Live updates are polling (PRD 6 accepts 15 s): every active query refetches every
 * `LIVE_UPDATE_INTERVAL_MS`, but not while the tab is hidden (`refetchIntervalInBackground: false`),
 * and again when the tab regains focus or the network returns. A query that must not refetch under
 * the user (an editor's source document, say) passes `refetchInterval: false`.
 *
 * Mutations use `networkMode: "always"` so they fail at once when offline instead of queueing:
 * v1 does not queue offline edits (PRD 8).
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        refetchInterval: LIVE_UPDATE_INTERVAL_MS,
        refetchIntervalInBackground: false,
        refetchOnWindowFocus: true,
        refetchOnReconnect: true,
        staleTime: 5_000,
        retry: shouldRetry,
      },
      mutations: {
        networkMode: "always",
        retry: false,
      },
    },
  });
}
