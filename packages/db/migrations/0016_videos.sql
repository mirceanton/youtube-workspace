-- 0016_videos: published (or scheduled) videos and their append-only metric snapshots (PRD 4
-- "videos", "video_metrics", "Integrity rules"; PRD 5 "register_video", "log_metrics"). Writes
-- arrive with T13's functions.

CREATE TABLE public.videos (
  id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(),
  -- The idea the video came from, if any.
  idea_id uuid REFERENCES public.ideas (id) ON DELETE RESTRICT,
  -- YouTube's 11-character video id (the v= parameter), not a URL.
  youtube_id text NOT NULL
    CONSTRAINT videos_youtube_id_check CHECK (youtube_id ~ '^[A-Za-z0-9_-]{11}$'),
  title text NOT NULL
    CONSTRAINT videos_title_check CHECK (btrim(title) <> '' AND char_length(title) <= 500),
  -- Publication time; in the future for a scheduled video, NULL while unscheduled.
  published_at timestamptz,
  -- URL or path of the thumbnail (no files are stored here). http(s) URLs or scheme-less paths only,
  -- so a stored value can never be a javascript: or data: URL.
  thumbnail_url text
    CONSTRAINT videos_thumbnail_url_check
    CHECK (char_length(thumbnail_url) BETWEEN 1 AND 2048
           AND thumbnail_url !~ '[[:space:][:cntrl:]]'
           AND (thumbnail_url ~* '^https?://' OR thumbnail_url !~ '^[A-Za-z][A-Za-z0-9+.-]*:')),
  version integer NOT NULL DEFAULT 1
    CONSTRAINT videos_version_check CHECK (version >= 1),
  -- Soft delete (PRD 4): videos are archived, never deleted.
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL DEFAULT public.ytw_current_actor(),
  updated_by text NOT NULL DEFAULT public.ytw_current_actor(),
  CONSTRAINT videos_youtube_id_key UNIQUE (youtube_id)
);

COMMENT ON TABLE public.videos IS 'Published or scheduled videos (PRD 4); youtube_id is unique.';
COMMENT ON COLUMN public.videos.youtube_id IS 'YouTube video id (11 characters), unique.';
COMMENT ON COLUMN public.videos.version IS 'Optimistic-concurrency version, incremented on every change.';

CREATE INDEX videos_idea_idx ON public.videos (idea_id);
CREATE INDEX videos_published_at_idx ON public.videos (published_at DESC);

CREATE TRIGGER videos_touch
  BEFORE UPDATE ON public.videos
  FOR EACH ROW EXECUTE FUNCTION public.ytw_touch('version');
CREATE TRIGGER videos_audit
  AFTER INSERT OR UPDATE OR DELETE ON public.videos
  FOR EACH ROW EXECUTE FUNCTION public.ytw_audit('video', '-updated_by');

-- Metric snapshots. A row is never changed: rows that never change carry no updated_at/updated_by
-- (as events). Every metric is optional, but a snapshot must hold at least one. Exact numerics so a
-- replayed snapshot compares equal (log_metrics is idempotent on (video_id, captured_at)).
CREATE TABLE public.video_metrics (
  id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(),
  video_id uuid NOT NULL REFERENCES public.videos (id) ON DELETE RESTRICT,
  -- When the numbers were read (from YouTube Studio or the Analytics API).
  captured_at timestamptz NOT NULL,
  views bigint CONSTRAINT video_metrics_views_check CHECK (views >= 0),
  impressions bigint CONSTRAINT video_metrics_impressions_check CHECK (impressions >= 0),
  -- Impressions click-through rate in percent (4.5 means 4.5 %).
  ctr numeric CONSTRAINT video_metrics_ctr_check CHECK (ctr BETWEEN 0 AND 100),
  avg_view_duration_s numeric
    CONSTRAINT video_metrics_avg_view_duration_s_check CHECK (avg_view_duration_s >= 0),
  -- Average percentage viewed; can exceed 100 when viewers rewatch.
  avg_view_pct numeric CONSTRAINT video_metrics_avg_view_pct_check CHECK (avg_view_pct >= 0),
  watch_time_min numeric CONSTRAINT video_metrics_watch_time_min_check CHECK (watch_time_min >= 0),
  -- Net subscribers gained in the period; negative when more were lost.
  subs_gained integer,
  -- Audience retention curve: a JSON array (shape defined by log_metrics, T13), at most 64 KiB.
  retention jsonb
    CONSTRAINT video_metrics_retention_check
    CHECK (jsonb_typeof(retention) = 'array' AND octet_length(retention::text) <= 65536),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL DEFAULT public.ytw_current_actor(),
  CONSTRAINT video_metrics_any_metric_check
    CHECK (num_nonnulls(views, impressions, ctr, avg_view_duration_s, avg_view_pct, watch_time_min,
                        subs_gained, retention) >= 1),
  CONSTRAINT video_metrics_video_captured_key UNIQUE (video_id, captured_at)
);

COMMENT ON TABLE public.video_metrics IS
  'Append-only metric snapshots (PRD 4): unique (video_id, captured_at); rows are never updated or deleted.';
COMMENT ON COLUMN public.video_metrics.ctr IS 'Impressions click-through rate in percent (0-100).';
COMMENT ON COLUMN public.video_metrics.avg_view_pct IS 'Average percentage viewed (may exceed 100).';
COMMENT ON COLUMN public.video_metrics.subs_gained IS 'Net subscribers gained; negative when more were lost.';

CREATE TRIGGER video_metrics_append_only
  BEFORE UPDATE OR DELETE ON public.video_metrics
  FOR EACH ROW EXECUTE FUNCTION public.ytw_append_only();
CREATE TRIGGER video_metrics_no_truncate
  BEFORE TRUNCATE ON public.video_metrics
  FOR EACH STATEMENT EXECUTE FUNCTION public.ytw_append_only();
CREATE TRIGGER video_metrics_audit
  AFTER INSERT OR UPDATE OR DELETE ON public.video_metrics
  FOR EACH ROW EXECUTE FUNCTION public.ytw_audit('video_metric');
