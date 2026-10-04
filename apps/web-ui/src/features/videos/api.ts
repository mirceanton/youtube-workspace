import type {
  VideoDetailResponse,
  ListVideosResponse,
  Video,
  VideoPerformance,
} from "@ytw/shared/api/videos";
import { api } from "@/lib/api.ts";

export const VIDEOS_PATH = "/api/videos";

function isDateOrNull(value: unknown): boolean {
  return value === null || (typeof value === "string" && !Number.isNaN(Date.parse(value)));
}

export const videosQueryKey = {
  all: ["videos"] as const,
  list: (limit: number) => ["videos", "list", limit] as const,
  detail: (id: string) => ["videos", id] as const,
};

export function fetchVideos(limit = 500, signal?: AbortSignal): Promise<ListVideosResponse> {
  return api.get<ListVideosResponse>(VIDEOS_PATH, { query: { limit }, signal });
}

export function fetchVideo(id: string, signal?: AbortSignal): Promise<VideoDetailResponse> {
  return api.get<VideoDetailResponse>(`${VIDEOS_PATH}/${id}`, { signal });
}

/** The YouTube id is validated before constructing the canonical HTTPS link. */
export function videoWatchUrl(youtubeId: string): string | null {
  return /^[A-Za-z0-9_-]{11}$/.test(youtubeId)
    ? `https://www.youtube.com/watch?v=${encodeURIComponent(youtubeId)}`
    : null;
}

/** Validate the conflict payload before showing it or updating local query state. */
export function parseVideo(value: unknown): Video | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const video = value as Record<string, unknown>;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (
    typeof video.id !== "string" ||
    !uuid.test(video.id) ||
    !(video.idea_id === null || (typeof video.idea_id === "string" && uuid.test(video.idea_id))) ||
    typeof video.youtube_id !== "string" ||
    !/^[A-Za-z0-9_-]{11}$/.test(video.youtube_id) ||
    typeof video.title !== "string" ||
    !isDateOrNull(video.published_at) ||
    !(video.thumbnail_url === null || typeof video.thumbnail_url === "string") ||
    !Number.isInteger(video.version) ||
    !isDateOrNull(video.archived_at) ||
    !isDateOrNull(video.created_at) ||
    !isDateOrNull(video.updated_at) ||
    typeof video.created_by !== "string" ||
    typeof video.updated_by !== "string"
  ) {
    return null;
  }
  return video as unknown as Video;
}

export type VideoListItem = VideoPerformance;
