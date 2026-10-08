import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { ErrorState, LoadingState } from "@/kit/states.tsx";
import { ResponseShapeError, UnauthorizedError } from "@/lib/errors.ts";
import { fetchMe, hasAnyAccess, ME_QUERY_KEY, SessionContext } from "@/lib/session.ts";
import { AccessNotGrantedPage, VersionMismatchPage } from "./pages.tsx";

/**
 * Everything behind the login. Loads `GET /api/me` and decides what the visitor sees:
 *  - loading: a spinner; 401: the API client is already sending the browser to the OIDC login;
 *  - a response this build cannot parse (the server moved on): "new version available", fail closed;
 *  - no access to any object: the "access not granted" page;
 *  - otherwise the app, with `useSession()` available.
 * The query polls like every other (12 s), so granted or lowered levels show up without a reload,
 * and an expired session is noticed within one interval.
 */
export function SessionGate({ children }: { children: ReactNode }) {
  const query = useQuery({ queryKey: ME_QUERY_KEY, queryFn: ({ signal }) => fetchMe(signal) });

  // Checked first, even when older data is cached: a response we cannot read must not leave
  // write controls on screen that this build can no longer judge.
  if (query.error instanceof ResponseShapeError) return <VersionMismatchPage />;

  if (query.data) {
    if (!hasAnyAccess(query.data)) {
      return (
        <AccessNotGrantedPage
          me={query.data}
          onCheckAgain={() => void query.refetch()}
          checking={query.isFetching}
        />
      );
    }
    return <SessionContext value={query.data}>{children}</SessionContext>;
  }

  if (query.isError) {
    if (query.error instanceof UnauthorizedError) {
      return <LoadingState label="Redirecting to sign in" className="min-h-dvh" />;
    }
    return (
      <div className="min-h-dvh">
        <ErrorState
          error={query.error}
          title="The workspace could not be loaded"
          onRetry={() => void query.refetch()}
          retrying={query.isFetching}
        />
      </div>
    );
  }
  return <LoadingState className="min-h-dvh" />;
}
