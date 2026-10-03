-- 0062_experiment_results: the variants of every packaging experiment side by side, with the click-
-- through difference from the control and the winner flagged (PRD 4 "Views for agents and the UI",
-- T15). One row per variant; the experiment's own columns repeat on each of its rows.
--
--   * ctr_vs_control = the variant's ctr minus the control's ctr, in percentage points (0 for the
--     control itself); NULL when either ctr is not recorded yet;
--   * ctr_lift_pct = that difference as a percentage of the control's ctr (the relative gain:
--     control 4.0, variant 5.0 gives 25), rounded to 4 decimal places; NULL when it is not defined
--     (a missing ctr, or a control with ctr 0);
--   * is_winner is true for the variant that conclude_experiment named; false for every variant of an
--     experiment that is not concluded or ended without a winner. The view never decides a winner by
--     itself: that is the owner's call (conclude_experiment).
-- Experiments of archived videos are included (they can still be concluded); video_title names the
-- video. A video's experiments can be told apart by experiment_id; order rows by experiment, then
-- is_control DESC, then label, as the wrapper does: a view has no order of its own.
--
-- security_invoker: reads experiments, experiment_variants and videos with the caller's privileges;
-- built-in functions only; no ytw_private or users relation is involved.

CREATE VIEW public.experiment_results
WITH (security_invoker = true) AS
SELECT
  e.id AS experiment_id,
  e.video_id,
  v.title AS video_title,
  e.type,
  e.status,
  e.hypothesis,
  e.starts_at,
  e.ends_at,
  e.conclusion,
  e.winner_variant_id,
  e.created_at AS experiment_created_at,
  x.id AS variant_id,
  x.label,
  x.content,
  x.is_control,
  x.impressions,
  x.ctr,
  c.id AS control_variant_id,
  c.ctr AS control_ctr,
  x.ctr - c.ctr AS ctr_vs_control,
  CASE WHEN c.ctr > 0 THEN round((x.ctr - c.ctr) / c.ctr * 100, 4) END AS ctr_lift_pct,
  (e.winner_variant_id IS NOT NULL AND x.id = e.winner_variant_id) AS is_winner
FROM public.experiments e
JOIN public.videos v ON v.id = e.video_id
JOIN public.experiment_variants x ON x.experiment_id = e.id
LEFT JOIN public.experiment_variants c ON c.experiment_id = e.id AND c.is_control;

COMMENT ON VIEW public.experiment_results IS
  'One row per experiment variant, side by side: impressions, ctr, the ctr difference from the control and whether the variant won. The experiment columns repeat on every row of the experiment.';

COMMENT ON COLUMN public.experiment_results.status IS 'planned, running, concluded or cancelled.';
COMMENT ON COLUMN public.experiment_results.ctr IS 'Click-through rate of the variant in percent (4.5 means 4.5 %); NULL until recorded.';
COMMENT ON COLUMN public.experiment_results.control_variant_id IS 'The experiment''s control variant (every experiment made by create_experiment has exactly one).';
COMMENT ON COLUMN public.experiment_results.ctr_vs_control IS 'ctr minus the control''s ctr, in percentage points; 0 for the control; NULL when either ctr is missing.';
COMMENT ON COLUMN public.experiment_results.ctr_lift_pct IS 'ctr_vs_control as a percentage of the control''s ctr, rounded to 4 decimals; NULL when undefined (missing ctr or a control ctr of 0).';
COMMENT ON COLUMN public.experiment_results.is_winner IS 'True for the variant named by conclude_experiment; no variant is a winner before the conclusion or when none won.';

GRANT SELECT ON TABLE public.experiment_results TO ytw_web, ytw_mcp, ytw_readonly;
