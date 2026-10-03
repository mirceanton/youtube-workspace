-- 0061_video_performance: how each video does, next to the channel (PRD 4 "Views for agents and the
-- UI", T15). One row per video that is not archived: the video, its latest metric snapshot and, for
-- every metric, the channel median and the video's difference from it.
--
-- Definitions (docs/database.md, "Views, search and activity (T15)"):
--   * latest snapshot = the row with the greatest captured_at of that video, as stored: a metric the
--     snapshot did not measure is NULL, even when an older snapshot had it;
--   * channel median = percentile_cont(0.5) over the latest snapshots of all videos that are not
--     archived (the video itself included) that measured the metric. percentile_cont works in double
--     precision and the result is cast back to numeric, so a median of values beyond 2^53 is
--     approximate; the per-video values stay exact;
--   * <metric>_vs_median = the video's value minus that median; NULL when either is NULL;
--   * a video without a snapshot keeps its row with NULL metrics and NULL differences; a channel
--     with a single video has that video's own values as medians (all differences 0); a channel
--     without any snapshot has NULL medians and median_sample_size 0.
-- Archived videos are left out of the rows and out of the medians: they are frozen and would skew the
-- baseline of the videos that are still live.
--
-- security_invoker: reads videos and video_metrics with the caller's privileges; built-in functions
-- only, so ytw_readonly needs no function grant; no ytw_private or users relation is involved.

CREATE VIEW public.video_performance_summary
WITH (security_invoker = true) AS
WITH latest AS (
  SELECT
    v.id,
    v.idea_id,
    v.youtube_id,
    v.title,
    v.published_at,
    v.thumbnail_url,
    m.id AS snapshot_id,
    m.captured_at,
    m.views,
    m.impressions,
    m.ctr,
    m.avg_view_duration_s,
    m.avg_view_pct,
    m.watch_time_min,
    m.subs_gained
  FROM public.videos v
  LEFT JOIN LATERAL (
    SELECT x.id, x.captured_at, x.views, x.impressions, x.ctr, x.avg_view_duration_s,
           x.avg_view_pct, x.watch_time_min, x.subs_gained
    FROM public.video_metrics x
    WHERE x.video_id = v.id
    ORDER BY x.captured_at DESC
    LIMIT 1
  ) m ON true
  WHERE v.archived_at IS NULL
),
channel AS (
  SELECT
    count(l.snapshot_id)::integer AS sample_size,
    (percentile_cont(0.5) WITHIN GROUP (ORDER BY l.views))::numeric AS views,
    (percentile_cont(0.5) WITHIN GROUP (ORDER BY l.impressions))::numeric AS impressions,
    (percentile_cont(0.5) WITHIN GROUP (ORDER BY l.ctr))::numeric AS ctr,
    (percentile_cont(0.5) WITHIN GROUP (ORDER BY l.avg_view_duration_s))::numeric AS avg_view_duration_s,
    (percentile_cont(0.5) WITHIN GROUP (ORDER BY l.avg_view_pct))::numeric AS avg_view_pct,
    (percentile_cont(0.5) WITHIN GROUP (ORDER BY l.watch_time_min))::numeric AS watch_time_min,
    (percentile_cont(0.5) WITHIN GROUP (ORDER BY l.subs_gained))::numeric AS subs_gained
  FROM latest l
)
SELECT
  l.id,
  l.idea_id,
  l.youtube_id,
  l.title,
  l.published_at,
  l.thumbnail_url,
  l.snapshot_id,
  l.captured_at,
  l.views,
  l.impressions,
  l.ctr,
  l.avg_view_duration_s,
  l.avg_view_pct,
  l.watch_time_min,
  l.subs_gained,
  c.sample_size AS median_sample_size,
  c.views AS median_views,
  c.impressions AS median_impressions,
  c.ctr AS median_ctr,
  c.avg_view_duration_s AS median_avg_view_duration_s,
  c.avg_view_pct AS median_avg_view_pct,
  c.watch_time_min AS median_watch_time_min,
  c.subs_gained AS median_subs_gained,
  l.views - c.views AS views_vs_median,
  l.impressions - c.impressions AS impressions_vs_median,
  l.ctr - c.ctr AS ctr_vs_median,
  l.avg_view_duration_s - c.avg_view_duration_s AS avg_view_duration_s_vs_median,
  l.avg_view_pct - c.avg_view_pct AS avg_view_pct_vs_median,
  l.watch_time_min - c.watch_time_min AS watch_time_min_vs_median,
  l.subs_gained - c.subs_gained AS subs_gained_vs_median
FROM latest l
CROSS JOIN channel c;

COMMENT ON VIEW public.video_performance_summary IS
  'Videos that are not archived with their latest metric snapshot and, per metric, the channel median (of the latest snapshots) and the difference from it. NULL metrics mean not measured; a video without snapshots has NULL metrics and differences.';

COMMENT ON COLUMN public.video_performance_summary.id IS 'The video id.';
COMMENT ON COLUMN public.video_performance_summary.snapshot_id IS 'The latest metric snapshot of the video; NULL when it has none.';
COMMENT ON COLUMN public.video_performance_summary.captured_at IS 'When the latest snapshot was captured.';
COMMENT ON COLUMN public.video_performance_summary.ctr IS 'Impressions click-through rate of the latest snapshot, in percent (4.5 means 4.5 %).';
COMMENT ON COLUMN public.video_performance_summary.avg_view_pct IS 'Average percentage viewed (above 100 when viewers rewatch).';
COMMENT ON COLUMN public.video_performance_summary.subs_gained IS 'Net subscribers gained (negative when more were lost).';
COMMENT ON COLUMN public.video_performance_summary.median_sample_size IS 'How many videos have a snapshot, i.e. how many the medians are computed over (per metric, only those that measured it count).';
COMMENT ON COLUMN public.video_performance_summary.median_views IS 'Channel median of views over the latest snapshots, the video itself included; the other median_* columns do the same for their metric.';
COMMENT ON COLUMN public.video_performance_summary.views_vs_median IS 'views minus median_views (negative: below the channel median); the other *_vs_median columns do the same for their metric.';

GRANT SELECT ON TABLE public.video_performance_summary TO ytw_web, ytw_mcp, ytw_readonly;
