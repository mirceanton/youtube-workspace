-- 0014_ideas: video ideas moving through the pipeline (PRD 4 "ideas", "Idea stages"). Stage moves are
-- decided by T12's advance_idea; this table only guarantees that the stage is a known one and that
-- status_changed_at ("age in stage") and version are always right.
--
-- The stage list mirrors IDEA_STAGES of @ytw/shared (packages/db/test/schema.test.ts checks it).

CREATE TABLE public.ideas (
  id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(),
  title text NOT NULL
    CONSTRAINT ideas_title_check CHECK (btrim(title) <> '' AND char_length(title) <= 500),
  pitch text
    CONSTRAINT ideas_pitch_check CHECK (char_length(pitch) <= 20000),
  -- The stage. New ideas start in the inbox.
  status text NOT NULL DEFAULT 'inbox'
    CONSTRAINT ideas_status_check
    CHECK (status IN ('inbox', 'shortlisted', 'scripting', 'filming', 'editing', 'published', 'dropped')),
  -- When the idea entered its current stage. Maintained by ytw_touch(): moves only when status does.
  status_changed_at timestamptz NOT NULL DEFAULT now(),
  -- Priority score, 0-100 (higher is better); NULL = not scored yet.
  score integer
    CONSTRAINT ideas_score_check CHECK (score BETWEEN 0 AND 100),
  -- Where the idea came from (an agent, a viewer comment, the owner, ...); free text.
  source text
    CONSTRAINT ideas_source_check CHECK (btrim(source) <> '' AND char_length(source) <= 200),
  tags text[] NOT NULL DEFAULT '{}'
    CONSTRAINT ideas_tags_check CHECK (public.ytw_valid_tags(tags)),
  -- Optimistic concurrency: +1 on every change (ytw_touch()); updates pass the version they read.
  version integer NOT NULL DEFAULT 1
    CONSTRAINT ideas_version_check CHECK (version >= 1),
  -- Soft delete (PRD 4): ideas are archived, never deleted.
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL DEFAULT public.ytw_current_actor(),
  updated_by text NOT NULL DEFAULT public.ytw_current_actor(),
  -- Full-text search over title (weight A) and pitch (weight B); query it with the 'english'
  -- configuration, e.g. websearch_to_tsquery('english', $1).
  search_vector tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('english'::regconfig, title), 'A')
    || setweight(to_tsvector('english'::regconfig, coalesce(pitch, '')), 'B')
  ) STORED
);

COMMENT ON TABLE public.ideas IS
  'Video ideas (PRD 4). Stages: inbox -> shortlisted -> scripting -> filming -> editing -> published, plus dropped; moves only through advance_idea.';
COMMENT ON COLUMN public.ideas.status IS 'The stage (IDEA_STAGES). Changed only by advance_idea.';
COMMENT ON COLUMN public.ideas.status_changed_at IS 'When the idea entered its current stage (age in stage).';
COMMENT ON COLUMN public.ideas.score IS 'Priority score from 0 to 100, higher is better; NULL when not scored.';
COMMENT ON COLUMN public.ideas.version IS 'Optimistic-concurrency version, incremented on every change.';

-- Filters of the ideas screen (PRD 6: stage, tag, score, source) and full-text search.
CREATE INDEX ideas_status_idx ON public.ideas (status, status_changed_at);
CREATE INDEX ideas_score_idx ON public.ideas (score);
CREATE INDEX ideas_source_idx ON public.ideas (source);
CREATE INDEX ideas_tags_idx ON public.ideas USING gin (tags);
CREATE INDEX ideas_search_idx ON public.ideas USING gin (search_vector);

CREATE TRIGGER ideas_touch
  BEFORE UPDATE ON public.ideas
  FOR EACH ROW EXECUTE FUNCTION public.ytw_touch('version', 'status_changed_at');
CREATE TRIGGER ideas_audit
  AFTER INSERT OR UPDATE OR DELETE ON public.ideas
  FOR EACH ROW EXECUTE FUNCTION public.ytw_audit('idea', '-search_vector', '-updated_by');
