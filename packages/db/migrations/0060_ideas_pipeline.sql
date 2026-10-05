-- 0060_ideas_pipeline: the idea pipeline for the board, the idea table and `query_sql` agents (PRD 4
-- "Views for agents and the UI", T15). One row per idea: the idea itself, how long it has been in
-- its stage, and the latest revision of each script kind.
--
-- Both views are security_invoker: they read ideas and scripts with the privileges of whoever selects
-- from them, so they can never show more than the caller could read from the tables. They read
-- nothing but public tables (never users, user_permissions or ytw_private), which the guard checks
-- (private_data_exposure), and use only built-in functions, so ytw_readonly needs no function grant.
--
-- A view cannot take a parameter, so "archived ideas only when asked for" is two views over one
-- definition: ideas_pipeline hides archived ideas, ideas_pipeline_all keeps them.
--
-- The latest_<kind>_* columns mirror SCRIPT_KINDS of @ytw/shared (packages/db/test/views.test.ts
-- checks it): a new kind needs a new migration that replaces these views.

CREATE VIEW public.ideas_pipeline_all
WITH (security_invoker = true) AS
SELECT
  i.id,
  i.title,
  i.pitch,
  i.status,
  i.score,
  i.source,
  i.tags,
  i.version,
  i.status_changed_at,
  greatest(now() - i.status_changed_at, interval '0') AS age_in_stage,
  floor(extract(epoch FROM greatest(now() - i.status_changed_at, interval '0')) / 86400)::integer
    AS days_in_stage,
  ls.id AS latest_script_id,
  ls.version AS latest_script_version,
  ls.status AS latest_script_status,
  ls.created_at AS latest_script_at,
  lp.id AS latest_packaging_id,
  lp.version AS latest_packaging_version,
  lp.status AS latest_packaging_status,
  lp.created_at AS latest_packaging_at,
  i.archived_at,
  i.created_at,
  i.updated_at,
  i.created_by,
  i.updated_by
FROM public.ideas i
LEFT JOIN LATERAL (
  SELECT s.id, s.version, s.status, s.created_at
  FROM public.scripts s
  WHERE s.idea_id = i.id AND s.kind = 'script'
  ORDER BY s.version DESC
  LIMIT 1
) ls ON true
LEFT JOIN LATERAL (
  SELECT s.id, s.version, s.status, s.created_at
  FROM public.scripts s
  WHERE s.idea_id = i.id AND s.kind = 'packaging'
  ORDER BY s.version DESC
  LIMIT 1
) lp ON true;

CREATE VIEW public.ideas_pipeline
WITH (security_invoker = true) AS
SELECT * FROM public.ideas_pipeline_all
WHERE archived_at IS NULL;

COMMENT ON VIEW public.ideas_pipeline IS
  'Ideas that are not archived, one row each: stage (status), age in stage and the latest script and packaging revision (NULL when none was saved). Use ideas_pipeline_all to include archived ideas.';
COMMENT ON VIEW public.ideas_pipeline_all IS
  'Like ideas_pipeline, but archived ideas are included (archived_at is set for them).';

COMMENT ON COLUMN public.ideas_pipeline.status IS 'The stage: inbox, shortlisted, scripting, filming, editing, published or dropped.';
COMMENT ON COLUMN public.ideas_pipeline.status_changed_at IS 'When the idea entered its current stage; only a stage change moves it.';
COMMENT ON COLUMN public.ideas_pipeline.age_in_stage IS 'Time since status_changed_at (never negative).';
COMMENT ON COLUMN public.ideas_pipeline.days_in_stage IS 'age_in_stage in whole days.';
COMMENT ON COLUMN public.ideas_pipeline.latest_script_version IS 'Highest saved version of the idea''s script; NULL when no script exists.';
COMMENT ON COLUMN public.ideas_pipeline.latest_script_status IS 'Review status (draft, review, approved) of that latest script version.';
COMMENT ON COLUMN public.ideas_pipeline.latest_script_at IS 'When that latest script version was saved.';
COMMENT ON COLUMN public.ideas_pipeline.latest_packaging_version IS 'Highest saved version of the idea''s packaging doc; NULL when none exists.';
COMMENT ON COLUMN public.ideas_pipeline.latest_packaging_status IS 'Review status (draft, review, approved) of that latest packaging version.';
COMMENT ON COLUMN public.ideas_pipeline.latest_packaging_at IS 'When that latest packaging version was saved.';

-- Both views have the same columns: describe them once, on ideas_pipeline, and copy the text.
DO $$
DECLARE
  v_column record;
BEGIN
  FOR v_column IN
    SELECT a.attname, d.description
    FROM pg_catalog.pg_attribute a
    JOIN pg_catalog.pg_description d
      ON d.classoid = 'pg_catalog.pg_class'::regclass
     AND d.objoid = a.attrelid AND d.objsubid = a.attnum
    WHERE a.attrelid = 'public.ideas_pipeline'::regclass AND a.attnum > 0 AND NOT a.attisdropped
  LOOP
    EXECUTE format('COMMENT ON COLUMN public.ideas_pipeline_all.%I IS %L',
                   v_column.attname, v_column.description);
  END LOOP;
END
$$;
