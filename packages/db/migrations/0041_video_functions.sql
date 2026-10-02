-- 0041_video_functions: the only write paths for videos (PRD 4 "videos", "Integrity rules"; PRD 5
-- register_video). Conventions: docs/database.md; helpers: 0030 and 0040.
--
--   register_video  creates the record of a video that exists on YouTube (idea optional, youtube_id unique)
--   update_video    edits title, published_at, thumbnail_url and the idea link; needs the version the caller read
--   archive_video   soft delete (archived_at); an archived video is frozen
--
-- Registering a video never moves its idea to another stage: advance_idea is the only way to do that.
-- The limits mirror the CHECK constraints of 0016_videos; a violated CHECK is a bare SQLSTATE 23514,
-- so every limit is validated first (ytw_check_video_field) with a readable error.

-- register_video: PRD 5 `register_video(idea_id, youtube_id, title, published_at)` plus an optional
-- thumbnail. p_idea_id is NULL for a video without an idea; when given, the idea must exist (it may
-- be archived: the video's life does not depend on it). p_published_at is NULL while a video is not
-- scheduled yet and may lie in the future for a scheduled one. A youtube_id that is already
-- registered is a `duplicate` error that names the existing video, also when two callers register it
-- at the same time.
CREATE FUNCTION public.register_video(
  p_actor text, p_actor_type text, p_token_id uuid,
  p_idea_id uuid, p_youtube_id text, p_title text,
  p_published_at timestamptz DEFAULT NULL,
  p_thumbnail_url text DEFAULT NULL
)
RETURNS public.videos
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_video public.videos;
  v_existing public.videos;
BEGIN
  PERFORM public.ytw_set_actor(p_actor, p_actor_type, p_token_id);
  PERFORM public.ytw_check_video_field('youtube_id', to_jsonb(p_youtube_id));
  PERFORM public.ytw_check_video_field('title', to_jsonb(p_title));
  IF p_published_at IS NOT NULL THEN
    PERFORM public.ytw_check_video_time('published_at', p_published_at, now() + interval '2 years',
                                        'scheduled videos can be at most 2 years ahead');
  END IF;
  PERFORM public.ytw_check_video_field('thumbnail_url', to_jsonb(p_thumbnail_url));
  IF p_idea_id IS NOT NULL THEN
    PERFORM 1 FROM public.ideas AS i WHERE i.id = p_idea_id;
    IF NOT FOUND THEN
      PERFORM public.ytw_raise_not_found('idea', p_idea_id);
    END IF;
  END IF;

  INSERT INTO public.videos (idea_id, youtube_id, title, published_at, thumbnail_url)
  VALUES (p_idea_id, p_youtube_id, p_title, p_published_at, p_thumbnail_url)
  ON CONFLICT ON CONSTRAINT videos_youtube_id_key DO NOTHING
  RETURNING * INTO v_video;
  IF FOUND THEN
    RETURN v_video;
  END IF;

  -- The conflicting row is committed (the insert waited for its transaction), so it can be read.
  SELECT * INTO v_existing FROM public.videos AS v WHERE v.youtube_id = p_youtube_id;
  PERFORM public.ytw_raise(
    'duplicate',
    format('youtube_id %s is already registered as video %s (%s)%s: work with that video instead of registering it again',
           public.ytw_fmt_value(p_youtube_id), v_existing.id, public.ytw_fmt_value(v_existing.title),
           CASE WHEN v_existing.archived_at IS NOT NULL THEN ', which is archived and read-only' ELSE '' END),
    jsonb_build_object('entity', 'video', 'field', 'youtube_id', 'value', p_youtube_id,
                       'existing_id', v_existing.id, 'existing_archived', v_existing.archived_at IS NOT NULL));
  RETURN NULL;
END
$$;

REVOKE ALL ON FUNCTION public.register_video(text, text, uuid, uuid, text, text, timestamptz, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.register_video(text, text, uuid, uuid, text, text, timestamptz, text)
  TO ytw_web, ytw_mcp;

COMMENT ON FUNCTION public.register_video(text, text, uuid, uuid, text, text, timestamptz, text) IS
  'Create the record of a YouTube video (idea optional, youtube_id unique). Errors: validation, not_found (idea), duplicate (existing_id).';

-- update_video: edits the fields named in p_fields (a JSON object; a key that is present is set,
-- "thumbnail_url": null clears it, an absent key is left alone). Editable: title, published_at,
-- thumbnail_url and idea_id (link or unlink the originating idea). youtube_id is the identity of the
-- video on YouTube, and its metrics and experiments belong to that video, so it cannot be changed.
-- The caller passes the version it read; if the video changed since, version_conflict carries
-- latest_version. Saving values equal to the stored ones changes nothing: no new version, no audit row.
CREATE FUNCTION public.update_video(
  p_actor text, p_actor_type text, p_token_id uuid,
  p_id uuid, p_expected_version integer, p_fields jsonb
)
RETURNS public.videos
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  c_editable CONSTANT text[] := ARRAY['title', 'published_at', 'thumbnail_url', 'idea_id'];
  v_key text;
  v_video public.videos;
  v_title text;
  v_published_at timestamptz;
  v_thumbnail_url text;
  v_idea_id uuid;
  v_latest integer;
BEGIN
  PERFORM public.ytw_set_actor(p_actor, p_actor_type, p_token_id);

  IF p_id IS NULL THEN
    PERFORM public.ytw_raise('validation', 'id is required: pass the id of the video to update',
                             jsonb_build_object('field', 'id'));
  END IF;
  IF p_expected_version IS NULL OR p_expected_version < 1 THEN
    PERFORM public.ytw_raise('validation',
      'expected_version is required: pass the version of the video you read (a whole number, at least 1)',
      jsonb_build_object('field', 'expected_version'));
  END IF;
  IF p_fields IS NULL OR jsonb_typeof(p_fields) <> 'object' THEN
    PERFORM public.ytw_raise('validation',
      format('fields must be an object such as {"title": "New title"}; editable fields: %s',
             public.ytw_fmt_list(c_editable)),
      jsonb_build_object('field', 'fields', 'allowed', to_jsonb(c_editable)));
  END IF;
  IF p_fields = '{}'::jsonb THEN
    PERFORM public.ytw_raise('validation',
      format('fields is empty: give at least one of %s', public.ytw_fmt_list(c_editable)),
      jsonb_build_object('field', 'fields', 'allowed', to_jsonb(c_editable)));
  END IF;
  FOR v_key IN SELECT k FROM jsonb_object_keys(p_fields) AS k ORDER BY k LOOP
    IF v_key = 'youtube_id' THEN
      PERFORM public.ytw_raise('validation',
        'youtube_id cannot be changed: it identifies the video on YouTube, and its metrics and experiments belong to that video. If it was registered with the wrong id, archive this video and register the right one',
        jsonb_build_object('field', 'youtube_id', 'allowed', to_jsonb(c_editable)));
    END IF;
    IF NOT v_key = ANY (c_editable) THEN
      PERFORM public.ytw_raise('validation',
        format('field %s cannot be edited; editable fields: %s',
               public.ytw_fmt_value(v_key), public.ytw_fmt_list(c_editable)),
        jsonb_build_object('field', left(v_key, 60), 'allowed', to_jsonb(c_editable)));
    END IF;
    PERFORM public.ytw_check_video_field(v_key, p_fields -> v_key);
  END LOOP;

  -- The row lock serialises writers of this video; the version check below then sees the winner.
  SELECT * INTO v_video FROM public.videos WHERE id = p_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    PERFORM public.ytw_raise_not_found('video', p_id);
  END IF;
  IF v_video.archived_at IS NOT NULL THEN
    PERFORM public.ytw_raise_video_archived(p_id, 'edited');
  END IF;
  IF v_video.version <> p_expected_version THEN
    PERFORM public.ytw_raise_version_conflict('video', p_id, p_expected_version, v_video.version);
  END IF;

  v_title := CASE WHEN p_fields ? 'title' THEN p_fields ->> 'title' ELSE v_video.title END;
  v_published_at := CASE WHEN p_fields ? 'published_at'
                         THEN (p_fields ->> 'published_at')::timestamptz ELSE v_video.published_at END;
  v_thumbnail_url := CASE WHEN p_fields ? 'thumbnail_url'
                          THEN p_fields ->> 'thumbnail_url' ELSE v_video.thumbnail_url END;
  v_idea_id := CASE WHEN p_fields ? 'idea_id' THEN (p_fields ->> 'idea_id')::uuid ELSE v_video.idea_id END;

  IF v_idea_id IS NOT NULL AND v_idea_id IS DISTINCT FROM v_video.idea_id THEN
    PERFORM 1 FROM public.ideas AS i WHERE i.id = v_idea_id;
    IF NOT FOUND THEN
      PERFORM public.ytw_raise_not_found('idea', v_idea_id);
    END IF;
  END IF;

  IF (v_title, v_published_at, v_thumbnail_url, v_idea_id)
     IS NOT DISTINCT FROM (v_video.title, v_video.published_at, v_video.thumbnail_url, v_video.idea_id) THEN
    RETURN v_video;
  END IF;

  -- The update names the version that was read: if the row lock were ever bypassed, a concurrent
  -- change finds no row here and is reported as the conflict it is, never overwritten.
  UPDATE public.videos
     SET title = v_title, published_at = v_published_at, thumbnail_url = v_thumbnail_url,
         idea_id = v_idea_id
   WHERE id = p_id AND version = v_video.version
  RETURNING * INTO v_video;
  IF NOT FOUND THEN
    SELECT v.version INTO v_latest FROM public.videos AS v WHERE v.id = p_id;
    PERFORM public.ytw_raise_version_conflict('video', p_id, p_expected_version, v_latest);
  END IF;
  RETURN v_video;
END
$$;

REVOKE ALL ON FUNCTION public.update_video(text, text, uuid, uuid, integer, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.update_video(text, text, uuid, uuid, integer, jsonb)
  TO ytw_web, ytw_mcp;

COMMENT ON FUNCTION public.update_video(text, text, uuid, uuid, integer, jsonb) IS
  'Edit title, published_at, thumbnail_url or idea_id of a video; p_expected_version must be the version read. Errors: validation, not_found, invalid_transition (archived), version_conflict.';

-- archive_video: soft delete (PRD 4). The video keeps its row, metrics, experiments and notes but
-- can no longer be edited, given metric snapshots or given experiments (its existing experiments
-- can still be recorded, concluded or cancelled, so that none is left running for good). Archiving
-- twice is a no-op. p_expected_version is optional: pass it when the caller acts on a version it read.
CREATE FUNCTION public.archive_video(
  p_actor text, p_actor_type text, p_token_id uuid,
  p_id uuid, p_expected_version integer DEFAULT NULL
)
RETURNS public.videos
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_video public.videos;
  v_latest integer;
BEGIN
  PERFORM public.ytw_set_actor(p_actor, p_actor_type, p_token_id);

  IF p_id IS NULL THEN
    PERFORM public.ytw_raise('validation', 'id is required: pass the id of the video to archive',
                             jsonb_build_object('field', 'id'));
  END IF;
  IF p_expected_version IS NOT NULL AND p_expected_version < 1 THEN
    PERFORM public.ytw_raise('validation',
      'expected_version must be a whole number of at least 1, or omitted to archive whatever the latest version is',
      jsonb_build_object('field', 'expected_version'));
  END IF;

  SELECT * INTO v_video FROM public.videos WHERE id = p_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    PERFORM public.ytw_raise_not_found('video', p_id);
  END IF;
  IF p_expected_version IS NOT NULL AND v_video.version <> p_expected_version THEN
    PERFORM public.ytw_raise_version_conflict('video', p_id, p_expected_version, v_video.version);
  END IF;
  IF v_video.archived_at IS NOT NULL THEN
    RETURN v_video;
  END IF;

  UPDATE public.videos SET archived_at = now()
   WHERE id = p_id AND version = v_video.version
  RETURNING * INTO v_video;
  IF NOT FOUND THEN
    SELECT v.version INTO v_latest FROM public.videos AS v WHERE v.id = p_id;
    PERFORM public.ytw_raise_version_conflict('video', p_id, p_expected_version, v_latest);
  END IF;
  RETURN v_video;
END
$$;

REVOKE ALL ON FUNCTION public.archive_video(text, text, uuid, uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.archive_video(text, text, uuid, uuid, integer) TO ytw_web, ytw_mcp;

COMMENT ON FUNCTION public.archive_video(text, text, uuid, uuid, integer) IS
  'Soft-delete a video (archived_at). Errors: validation, not_found, version_conflict.';
