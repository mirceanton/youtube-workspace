-- 0013_web_sessions: server-side browser sessions of the web app (PLAN.md section 0 "Sessions", a
-- supporting table beyond PRD 4; PRD 7 "tokens stay server-side", idle and absolute timeouts).
-- Written and read only through T14's SECURITY DEFINER functions, used by the web server (T40).
--
-- Deliberately not audited: a session is not a business record (logins and logouts are logged with
-- ytw_log_event as auth.login / auth.logout), last_seen_at changes on every request, and an audit row
-- would copy the session id, the handle behind the session cookie, into events, which every
-- application role and the activity feed can read.

CREATE TABLE ytw_private.web_sessions (
  -- The session handle (the web server keeps it, signed, in the HttpOnly cookie). A random v4 UUID
  -- (122 random bits) rather than the time-ordered v7 used elsewhere: it is a bearer secret, so it
  -- should not reveal when the session started.
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users (id) ON DELETE RESTRICT,
  -- The OIDC refresh token, encrypted by the web server (key derived from SESSION_SECRET). NULL when
  -- the provider issued none.
  refresh_token_encrypted bytea
    CONSTRAINT web_sessions_refresh_token_encrypted_check
    CHECK (octet_length(refresh_token_encrypted) BETWEEN 1 AND 16384),
  -- The ID token, sent as id_token_hint for RP-initiated logout (PRD 7).
  id_token_hint text
    CONSTRAINT web_sessions_id_token_hint_check
    CHECK (char_length(id_token_hint) BETWEEN 1 AND 16384),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  -- Idle expiry (moves forward on activity) and absolute expiry (fixed at login). A session never
  -- outlives its absolute expiry.
  expires_at timestamptz NOT NULL,
  absolute_expires_at timestamptz NOT NULL,
  CONSTRAINT web_sessions_expiry_check CHECK (expires_at <= absolute_expires_at)
);

COMMENT ON TABLE ytw_private.web_sessions IS
  'Server-side web sessions: refresh token encrypted at rest, idle (expires_at) and absolute (absolute_expires_at) expiry.';

CREATE INDEX web_sessions_user_idx ON ytw_private.web_sessions (user_id);
CREATE INDEX web_sessions_expires_idx ON ytw_private.web_sessions (expires_at);

-- No grants and no audit trigger (see above).
