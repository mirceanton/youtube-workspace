import { useQuery } from "@tanstack/react-query";
import {
  SEARCH_PATH,
  SEARCH_QUERY_MAX_CHARS,
  searchResponseSchema,
  searchSnippetSegments,
} from "@ytw/shared/api/search";
import { useState, type FormEvent } from "react";
import { Link } from "react-router";
import { Search as SearchIcon } from "lucide-react";
import { Badge } from "@/kit/Badge.tsx";
import { Button } from "@/kit/Button.tsx";
import { Card } from "@/kit/Card.tsx";
import { EmptyState, ErrorState, LoadingState } from "@/kit/states.tsx";
import { PageHeader } from "@/kit/PageHeader.tsx";
import { TextField } from "@/kit/Field.tsx";
import { api } from "@/lib/api.ts";

export function Component() {
  const [draft, setDraft] = useState("");
  const [queryText, setQueryText] = useState("");
  const query = useQuery({
    queryKey: ["search", queryText],
    enabled: queryText.length > 0,
    queryFn: ({ signal }) =>
      api.get(SEARCH_PATH, {
        query: { q: queryText },
        parse: searchResponseSchema,
        signal,
      }),
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    setQueryText(draft.trim().slice(0, SEARCH_QUERY_MAX_CHARS));
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="Search"
        description="Search readable idea titles, pitches and the latest script revisions."
      />
      <Card>
        <search>
          <form className="flex flex-col gap-3 sm:flex-row sm:items-end" onSubmit={submit}>
            <TextField
              label="Search the workspace"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              maxLength={SEARCH_QUERY_MAX_CHARS}
              autoComplete="off"
              className="min-w-0 flex-1"
              hint="Use quoted phrases, OR, or a minus sign to exclude a term."
            />
            <Button type="submit" variant="primary">
              <SearchIcon aria-hidden="true" className="size-4" />
              Search
            </Button>
          </form>
        </search>
      </Card>

      {!queryText ? (
        <EmptyState
          title="Search ideas and scripts"
          description="Enter a word or phrase to find matching workspace content."
        />
      ) : query.isPending ? (
        <LoadingState label="Searching" lines={4} />
      ) : query.isError ? (
        <ErrorState
          error={query.error}
          onRetry={() => void query.refetch()}
          retrying={query.isFetching}
        />
      ) : query.data.results.length === 0 ? (
        <EmptyState title="No matches found" description="Try a broader term or another phrase." />
      ) : (
        <div className="space-y-3" aria-live="polite" aria-label="Search results">
          <p className="text-sm text-ink-muted">
            {query.data.results.length} {query.data.results.length === 1 ? "match" : "matches"}
          </p>
          <ul className="grid min-w-0 gap-3">
            {query.data.results.map((result) => {
              const label =
                result.entity_type === "idea"
                  ? (result.title ?? "Idea")
                  : `${result.kind === "packaging" ? "Packaging" : "Script"} · version ${result.version}`;
              const href =
                result.entity_type === "idea"
                  ? `/ideas/${result.idea_id}`
                  : `/scripts/${result.idea_id}/${result.kind ?? "script"}`;
              return (
                <li key={`${result.entity_type}:${result.id}`}>
                  <Card>
                    <div className="flex flex-wrap items-start gap-2">
                      <h2 className="min-w-0 flex-1 text-lg font-semibold">
                        <Link
                          to={href}
                          className="text-link hover:underline focus-visible:outline-2 focus-visible:outline-focus"
                        >
                          {label}
                        </Link>
                      </h2>
                      <Badge tone="info">{result.entity_type === "idea" ? "Idea" : "Script"}</Badge>
                      {result.kind === "packaging" ? <Badge>Packaging</Badge> : null}
                    </div>
                    <p className="mt-3 whitespace-pre-wrap break-words text-sm leading-relaxed">
                      {searchSnippetSegments(result.snippet).map((segment, index) =>
                        segment.highlight ? (
                          <mark
                            key={`${index}-${segment.text}`}
                            className="rounded bg-accent-soft px-0.5 text-ink"
                          >
                            {segment.text}
                          </mark>
                        ) : (
                          <span key={`${index}-${segment.text}`}>{segment.text}</span>
                        ),
                      )}
                    </p>
                  </Card>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
