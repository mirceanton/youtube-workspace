import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { SCRIPTS_PATH, listScriptsResponseSchema } from "@ytw/shared/api/scripts";
import { PageHeader } from "@/kit/PageHeader.tsx";
import { Badge } from "@/kit/Badge.tsx";
import { Card } from "@/kit/Card.tsx";
import { EmptyState, ErrorState, LoadingState } from "@/kit/states.tsx";
import { LastChangedBy } from "@/kit/LastChangedBy.tsx";
import { api } from "@/lib/api.ts";
import { formatRelativeTime } from "@/lib/format.ts";

export function Component() {
  const query = useQuery({
    queryKey: ["scripts", "latest"],
    queryFn: ({ signal }) => api.get(SCRIPTS_PATH, { parse: listScriptsResponseSchema, signal }),
  });

  return (
    <>
      <PageHeader
        title="Scripts"
        description="Read and revise scripts and packaging notes. Every save creates a new version."
      />
      {query.isPending ? (
        <LoadingState label="Loading scripts" lines={5} />
      ) : query.isError ? (
        <ErrorState
          error={query.error}
          onRetry={() => void query.refetch()}
          retrying={query.isFetching}
        />
      ) : query.data.scripts.length === 0 ? (
        <EmptyState
          title="No scripts yet"
          description="Create a script or packaging document from an idea's detail page."
        />
      ) : (
        <ul className="grid min-w-0 gap-3">
          {query.data.scripts.map((script) => (
            <li key={script.id}>
              <Card className="p-0">
                <Link
                  to={`/scripts/${script.idea_id}/${script.kind}`}
                  className="block min-h-11 rounded-xl p-4 outline-none focus-visible:ring-2 focus-visible:ring-focus"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="min-w-0 flex-1 text-lg font-semibold">{script.idea_title}</h2>
                    <Badge tone="info">{script.kind === "script" ? "Script" : "Packaging"}</Badge>
                    <Badge>{script.status}</Badge>
                  </div>
                  <p className="mt-1 text-sm text-ink-muted">
                    Latest version {script.version} · {formatRelativeTime(script.updated_at)}
                  </p>
                  <LastChangedBy
                    actor={script.updated_by}
                    at={script.updated_at}
                    className="mt-2"
                  />
                </Link>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
