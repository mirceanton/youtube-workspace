import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createQueryClient } from "@/lib/query-client.ts";
import { LiveUpdatePoller } from "./LiveUpdatePoller.tsx";
import { invalidateChangedQueryCaches } from "./live-updates.ts";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("global live-update poll", () => {
  it("uses the shared 15-second refetch interval", () => {
    const client = createQueryClient();
    expect(client.getDefaultOptions().queries?.refetchInterval).toBe(15_000);
    client.clear();
  });

  it("invalidates affected query prefixes when the since cursor advances", async () => {
    const responses = [
      { changed_resources: [], cursor: "baseline", has_more: false },
      { changed_resources: ["ideas"], cursor: "next", has_more: true },
      { changed_resources: ["scripts"], cursor: "caught-up", has_more: false },
    ];
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => jsonResponse(responses.shift()!));
    vi.stubGlobal("fetch", fetchMock);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, refetchInterval: false } },
    });
    client.setQueryData(["ideas", "list"], { ideas: [] });
    client.setQueryData(["scripts", "detail", "id"], {});
    client.setQueryData(["search", "term"], { results: [] });
    client.setQueryData(["activity", "list", {}], { pages: [] });
    client.setQueryData(["videos", "list"], { videos: [] });

    const view = render(
      <QueryClientProvider client={client}>
        <LiveUpdatePoller />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await client.refetchQueries({ queryKey: ["live-updates"] });
    await waitFor(() => {
      expect(client.getQueryState(["ideas", "list"])?.isInvalidated).toBe(true);
      expect(client.getQueryState(["scripts", "detail", "id"])?.isInvalidated).toBe(true);
      expect(client.getQueryState(["search", "term"])?.isInvalidated).toBe(true);
      expect(client.getQueryState(["activity", "list", {}])?.isInvalidated).toBe(true);
    });
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("since=baseline");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(String(fetchMock.mock.calls[2]?.[0])).toContain("since=next");
    expect(client.getQueryState(["videos", "list"])?.isInvalidated).toBe(false);
    view.unmount();
    client.clear();
  });

  it("maps resource changes to the related cache keys", async () => {
    const client = new QueryClient();
    client.setQueryData(["videos", "detail", "id"], {});
    client.setQueryData(["experiments", "ctr-history", "id"], {});
    client.setQueryData(["dashboard"], {});
    client.setQueryData(["scripts", "id", "script"], {});

    await invalidateChangedQueryCaches(client, ["videos"]);

    expect(client.getQueryState(["videos", "detail", "id"])?.isInvalidated).toBe(true);
    expect(client.getQueryState(["experiments", "ctr-history", "id"])?.isInvalidated).toBe(true);
    expect(client.getQueryState(["dashboard"])?.isInvalidated).toBe(true);
    expect(client.getQueryState(["scripts", "id", "script"])?.isInvalidated).toBe(false);
    client.clear();
  });
});
