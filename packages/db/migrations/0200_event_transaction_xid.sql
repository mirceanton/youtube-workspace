-- 0200_event_transaction_xid: commit-safe checkpoints for the activity change poll.
--
-- created_at is transaction-start time. It cannot be used as a commit watermark: a transaction
-- can remain open for an arbitrary duration, then commit an event whose timestamp sorts before an
-- already-observed event. Keep the full top-level xid on each row so the poll can compare the
-- transaction's visibility across two PostgreSQL snapshots without imposing a writer lifetime.
--
-- Existing immutable audit rows predate the snapshot cursor and are baseline data. Assign them xid
-- 2 (older than every application transaction); new inserts use pg_current_xact_id() by default.
ALTER TABLE public.events
  ADD COLUMN transaction_xid xid8 NOT NULL DEFAULT '2'::xid8;

ALTER TABLE public.events
  ALTER COLUMN transaction_xid SET DEFAULT pg_current_xact_id();

CREATE INDEX events_transaction_xid_idx ON public.events (transaction_xid);

COMMENT ON COLUMN public.events.transaction_xid IS
  'Full top-level transaction ID that inserted this event, used by the live poll to detect commits since a PostgreSQL snapshot.';
