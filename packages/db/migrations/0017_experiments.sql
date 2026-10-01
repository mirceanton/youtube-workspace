-- 0017_experiments: A/B tests of a video's packaging and their variants (PRD 4 "experiments",
-- "experiment_variants"; PRD 5 "create_experiment", "record_variant_stats", "conclude_experiment").
-- The status machine (planned -> running -> concluded | cancelled) is T13's; the schema guarantees
-- that a winner is one of the experiment's own variants, that only a concluded experiment has one,
-- and that an experiment has at most one control.
--
-- type and status mirror EXPERIMENT_TYPES and EXPERIMENT_STATUSES of @ytw/shared
-- (packages/db/test/schema.test.ts checks them).

CREATE TABLE public.experiments (
  id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(),
  video_id uuid NOT NULL REFERENCES public.videos (id) ON DELETE RESTRICT,
  type text NOT NULL
    CONSTRAINT experiments_type_check CHECK (type IN ('title', 'thumbnail', 'description')),
  hypothesis text
    CONSTRAINT experiments_hypothesis_check CHECK (char_length(hypothesis) <= 20000),
  status text NOT NULL DEFAULT 'planned'
    CONSTRAINT experiments_status_check
    CHECK (status IN ('planned', 'running', 'concluded', 'cancelled')),
  starts_at timestamptz,
  ends_at timestamptz,
  -- References experiment_variants (constraint experiments_winner_variant_fkey, added below).
  winner_variant_id uuid,
  conclusion text
    CONSTRAINT experiments_conclusion_check CHECK (char_length(conclusion) <= 20000),
  version integer NOT NULL DEFAULT 1
    CONSTRAINT experiments_version_check CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL DEFAULT public.ytw_current_actor(),
  updated_by text NOT NULL DEFAULT public.ytw_current_actor(),
  CONSTRAINT experiments_period_check CHECK (ends_at >= starts_at),
  CONSTRAINT experiments_winner_concluded_check
    CHECK (winner_variant_id IS NULL OR status = 'concluded')
);

COMMENT ON TABLE public.experiments IS
  'Packaging A/B tests on a video (PRD 4). Status: planned -> running -> concluded | cancelled.';
COMMENT ON COLUMN public.experiments.winner_variant_id IS
  'The winning variant; must belong to this experiment and is set only when concluded.';
COMMENT ON COLUMN public.experiments.version IS 'Optimistic-concurrency version, incremented on every change.';

CREATE INDEX experiments_video_idx ON public.experiments (video_id);
CREATE INDEX experiments_status_idx ON public.experiments (status);

CREATE TABLE public.experiment_variants (
  id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(),
  experiment_id uuid NOT NULL REFERENCES public.experiments (id) ON DELETE RESTRICT,
  -- Short name shown side by side, e.g. "A" or "Control".
  label text NOT NULL
    CONSTRAINT experiment_variants_label_check CHECK (btrim(label) <> '' AND char_length(label) <= 200),
  -- What is being tested: the title or description text, or the thumbnail's URL or path.
  content text NOT NULL
    CONSTRAINT experiment_variants_content_check CHECK (char_length(content) <= 20000),
  is_control boolean NOT NULL DEFAULT false,
  impressions bigint
    CONSTRAINT experiment_variants_impressions_check CHECK (impressions >= 0),
  -- Click-through rate in percent (4.5 means 4.5 %), as video_metrics.ctr.
  ctr numeric
    CONSTRAINT experiment_variants_ctr_check CHECK (ctr BETWEEN 0 AND 100),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL DEFAULT public.ytw_current_actor(),
  updated_by text NOT NULL DEFAULT public.ytw_current_actor(),
  CONSTRAINT experiment_variants_label_key UNIQUE (experiment_id, label),
  -- Target of the composite winner foreign key below.
  CONSTRAINT experiment_variants_experiment_variant_key UNIQUE (experiment_id, id)
);

COMMENT ON TABLE public.experiment_variants IS
  'Variants of an experiment with their results (PRD 4); at most one control per experiment.';
COMMENT ON COLUMN public.experiment_variants.ctr IS 'Click-through rate in percent (0-100).';

CREATE UNIQUE INDEX experiment_variants_one_control_idx
  ON public.experiment_variants (experiment_id) WHERE is_control;

-- The circular reference: an experiment's winner is a variant of that same experiment. The key
-- (id, winner_variant_id) makes "winner belongs to the experiment" a schema rule; it is checked
-- only when winner_variant_id is set. Deferrable, initially deferred, so an experiment and its
-- variants can be written in any order within one transaction.
ALTER TABLE public.experiments
  ADD CONSTRAINT experiments_winner_variant_fkey
  FOREIGN KEY (id, winner_variant_id)
  REFERENCES public.experiment_variants (experiment_id, id)
  ON DELETE RESTRICT
  DEFERRABLE INITIALLY DEFERRED;

CREATE INDEX experiments_winner_idx ON public.experiments (winner_variant_id)
  WHERE winner_variant_id IS NOT NULL;

CREATE TRIGGER experiments_touch
  BEFORE UPDATE ON public.experiments
  FOR EACH ROW EXECUTE FUNCTION public.ytw_touch('version');
CREATE TRIGGER experiments_audit
  AFTER INSERT OR UPDATE OR DELETE ON public.experiments
  FOR EACH ROW EXECUTE FUNCTION public.ytw_audit('experiment', '-updated_by');

CREATE TRIGGER experiment_variants_touch
  BEFORE UPDATE ON public.experiment_variants
  FOR EACH ROW EXECUTE FUNCTION public.ytw_touch();
CREATE TRIGGER experiment_variants_audit
  AFTER INSERT OR UPDATE OR DELETE ON public.experiment_variants
  FOR EACH ROW EXECUTE FUNCTION public.ytw_audit('experiment_variant', '-updated_by');

GRANT SELECT ON TABLE public.experiments, public.experiment_variants TO ytw_web, ytw_mcp, ytw_readonly;
