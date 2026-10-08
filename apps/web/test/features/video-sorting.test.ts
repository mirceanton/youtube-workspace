import type { VideoPerformance } from "@ytw/shared/api/videos";
import { describe, expect, it } from "vitest";
import { sortVideos } from "../../src/features/videos/sorting.ts";

function video(title: string, views: string | null, publishedAt: string | null) {
  return {
    title,
    published_at: publishedAt,
    latest: views === null ? null : { views },
  } as unknown as VideoPerformance;
}

const titles = (videos: VideoPerformance[]) => videos.map((v) => v.title);

describe("sortVideos", () => {
  const videos = [
    video("b", "9007199254740993", "2025-01-02T00:00:00Z"),
    video("a", "9007199254740992", null),
    video("c", null, "2024-05-01T00:00:00Z"),
  ];

  it("compares big integer counts exactly and puts missing values last in both directions", () => {
    expect(titles(sortVideos(videos, "views", "desc"))).toEqual(["b", "a", "c"]);
    expect(titles(sortVideos(videos, "views", "asc"))).toEqual(["a", "b", "c"]);
  });

  it("sorts by publish date with unpublished videos last", () => {
    expect(titles(sortVideos(videos, "published_at", "asc"))).toEqual(["c", "b", "a"]);
    expect(titles(sortVideos(videos, "published_at", "desc"))).toEqual(["b", "c", "a"]);
  });
});
