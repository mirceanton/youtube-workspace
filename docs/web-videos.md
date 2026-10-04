# Videos web feature

The Videos feature is code-split with the rest of the SPA. It requires Read on `videos`; every API
route checks the current database-backed level, and registration or edits require Write. Writes use
the existing `register_video` and `update_video` database functions through an actor-bound transaction.
Edits send the version shown on the video. A stale version returns `409` with the latest video so the
editor can reload or keep its draft.

## API

- `GET /api/videos?limit=1000` returns active videos from `video_performance_summary`, including the
  latest snapshot, channel medians and metric differences. `limit` is 1-1000; the UI requests the
  maximum and warns when the list reaches that limit.
- `GET /api/videos/:id` returns the video, up to 1,000 snapshots in capture-time order, the current
  channel comparison and, when the caller can Read ideas, the linked idea title.
- `POST /api/videos` registers an existing YouTube video with its 11-character ID, title, optional
  idea, publication time and thumbnail URL.
- `PATCH /api/videos/:id` updates the title, publication time, thumbnail URL or idea link and requires
  `expected_version`. The YouTube ID is immutable.

Metrics are append-only and remain managed by the shared database functions. The web detail page
charts views, CTR and average view duration across snapshots. Its audience-retention chart uses the
most recent snapshot that contains a curve; each point's `t` is elapsed seconds and `pct` is the
percentage of viewers still watching. Missing values stay as chart gaps. Each chart includes a text
summary and an expandable data table, and the 1,000-point route limit bounds the plot size.

The video list can sort title, publication time and every available latest metric: views, impressions,
CTR, average view duration, average viewed percentage, watch time or subscribers gained. Median
differences are displayed alongside each metric. External video links are built from the validated
YouTube ID and open with `noopener noreferrer`; the originating-idea link appears only when the
caller can Read ideas.
