import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { invalidateChangedQueryCaches } from "../../src/features/dashboard/live-updates.ts";

describe("live updates", () => {
  it("invalidates the caches that depend on a changed resource, and only those", async () => {
    const client = new QueryClient();
    const keys = [
      ["videos", "detail", "id"],
      ["experiments", "ctr-history", "id"],
      ["dashboard"],
      ["scripts", "id", "script"],
    ];
    for (const key of keys) client.setQueryData(key, {});

    await invalidateChangedQueryCaches(client, ["videos"]);

    const invalidated = keys.filter((key) => client.getQueryState(key)?.isInvalidated);
    expect(invalidated).toEqual([keys[0], keys[1], keys[2]]);
    client.clear();
  });
});
