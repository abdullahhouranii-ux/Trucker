-- 0004_identity_hardening
-- Takes away every right the API's database role had on the identity tables and replaces
-- them with functions, one per operation, that run as the tables' owner.
--
-- Decisions recorded on 13 November 2026 (docs/delivery/IDENTITY_HARDENING_SLICE_6.md):
--   * one-time codes are created by the database, never by the API;
--   * the limits are read from a protected settings row. No function takes a limit or a time
--     from its caller, so a caller cannot loosen either;
--   * the clock can be set only in a database marked "test";
--   * no code is created outside a database marked local-development or test: with no message
--     supplier there is nowhere to deliver one, so sign-in stays closed there;
--   * a stored code hash is keyed with a value the database never keeps
--     (docs/delivery/IDENTITY_HARDENING_SLICE_6.md, section 3).
--
-- Every function here names its search path, with pg_temp last, and is closed to PUBLIC.

-- ---------------------------------------------------------------------------------------------
-- Protected settings. One row. The API's role has no right on it at all.
-- The values are the development defaults reviewed in docs/delivery/REGISTRATION_SLICE_4.md
-- (section 4) and ORGANISATION_ONBOARDING_SLICE_5.md. They need review before production,
-- which is recorded in reviewed_for_production and checked when a production API starts.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE trucker.security_setting (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  code_ttl_seconds integer NOT NULL DEFAULT 300 CHECK (code_ttl_seconds BETWEEN 30 AND 900),
  code_max_attempts integer NOT NULL DEFAULT 5 CHECK (code_max_attempts BETWEEN 1 AND 10),
  code_resend_wait_seconds integer NOT NULL DEFAULT 60
    CHECK (code_resend_wait_seconds BETWEEN 10 AND 3600),
  code_max_per_hour integer NOT NULL DEFAULT 5 CHECK (code_max_per_hour BETWEEN 1 AND 30),
  session_idle_minutes integer NOT NULL DEFAULT 30 CHECK (session_idle_minutes BETWEEN 1 AND 1440),
  session_absolute_hours integer NOT NULL DEFAULT 12
    CHECK (session_absolute_hours BETWEEN 1 AND 720),
  organisation_creation_limit integer NOT NULL DEFAULT 5
    CHECK (organisation_creation_limit BETWEEN 1 AND 1000),
  reviewed_for_production boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO trucker.security_setting (singleton) VALUES (true);

CREATE FUNCTION trucker.guard_security_setting() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, trucker, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'the security settings row cannot be removed' USING ERRCODE = 'check_violation';
END
$$;
CREATE TRIGGER security_setting_guard BEFORE DELETE ON trucker.security_setting
  FOR EACH ROW EXECUTE FUNCTION trucker.guard_security_setting();

-- ---------------------------------------------------------------------------------------------
-- The clock. Everything below reads the time here and nowhere else. It is the database's own
-- clock, except in a database marked "test", where a test may fix it. The API's role cannot
-- write this table or the mark.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE trucker.test_clock (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  fixed_at timestamptz NOT NULL
);

CREATE FUNCTION trucker.guard_test_clock() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, trucker, pg_temp AS $$
DECLARE
  current_kind text;
BEGIN
  SELECT e.kind INTO current_kind FROM trucker.environment e;
  IF current_kind IS DISTINCT FROM 'test' THEN
    RAISE EXCEPTION 'the clock can be set only in a database marked test (this one is %)', current_kind
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER test_clock_guard BEFORE INSERT OR UPDATE ON trucker.test_clock
  FOR EACH ROW EXECUTE FUNCTION trucker.guard_test_clock();

CREATE FUNCTION trucker.clock_now() RETURNS timestamptz
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
  SELECT coalesce(
    (SELECT c.fixed_at FROM trucker.test_clock c
      WHERE (SELECT e.kind FROM trucker.environment e) = 'test'),
    pg_catalog.now())
$$;

-- ---------------------------------------------------------------------------------------------
-- Building blocks. None is callable by the API's role.
-- ---------------------------------------------------------------------------------------------

-- HMAC-SHA-256 (RFC 2104) from the built-in sha256, so no extension is needed.
CREATE FUNCTION trucker.hmac_sha256(p_key bytea, p_message bytea) RETURNS bytea
LANGUAGE plpgsql IMMUTABLE STRICT SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  k bytea := p_key;
  inner_pad bytea := decode(repeat('36', 64), 'hex');
  outer_pad bytea := decode(repeat('5c', 64), 'hex');
BEGIN
  IF length(k) > 64 THEN
    k := sha256(k);
  END IF;
  k := k || decode(repeat('00', 64 - length(k)), 'hex');
  FOR i IN 0..63 LOOP
    inner_pad := set_byte(inner_pad, i, get_byte(k, i) # 54);
    outer_pad := set_byte(outer_pad, i, get_byte(k, i) # 92);
  END LOOP;
  RETURN sha256(outer_pad || sha256(inner_pad || p_message));
END
$$;

-- Six digits, uniformly distributed, leading zeros kept. The bytes come from
-- gen_random_uuid(), which PostgreSQL fills from its cryptographic source (pg_strong_random);
-- the first four bytes of a version 4 identifier are entirely random. Values that would make
-- some codes more likely than others are thrown away and drawn again.
CREATE FUNCTION trucker.random_code() RETURNS text
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  raw bytea;
  drawn bigint;
BEGIN
  LOOP
    raw := uuid_send(gen_random_uuid());
    drawn := (get_byte(raw, 0)::bigint << 24) | (get_byte(raw, 1)::bigint << 16)
           | (get_byte(raw, 2)::bigint << 8) | get_byte(raw, 3)::bigint;
    EXIT WHEN drawn < 4294000000;
  END LOOP;
  RETURN lpad((drawn % 1000000)::text, 6, '0');
END
$$;

-- The stored form of a code: keyed with a value the caller holds and the database does not
-- keep, and bound to its challenge.
CREATE FUNCTION trucker.code_hash(p_pepper text, p_challenge uuid, p_code text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, trucker, pg_temp AS $$
  SELECT encode(
    trucker.hmac_sha256(decode(p_pepper, 'hex'),
                        convert_to('code:' || p_challenge::text || ':' || p_code, 'UTF8')),
    'hex')
$$;

-- The live session for a token hash, or nothing. A session is live when it has not been
-- ended, has been used within the idle period, and is younger than the absolute limit: both
-- the limit written when it was created and the limit in force now, whichever is earlier.
-- Every check of a session goes through here.
CREATE FUNCTION trucker.live_session(p_token_hash text)
RETURNS TABLE (session_id uuid, person_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
  SELECT s.id, s.person_id
  FROM trucker.session s CROSS JOIN trucker.security_setting g
  WHERE p_token_hash ~ '^[0-9a-f]{64}$'
    AND s.token_hash = p_token_hash
    AND s.revoked_at IS NULL
    AND s.absolute_expires_at > trucker.clock_now()
    AND s.created_at + make_interval(hours => g.session_absolute_hours) > trucker.clock_now()
    AND s.last_used_at + make_interval(mins => g.session_idle_minutes) > trucker.clock_now()
$$;

CREATE TYPE trucker.account_view AS (
  person_id uuid,
  phone_e164 text,
  display_name text,
  contact_email text,
  registration_completed_at timestamptz,
  session_id uuid,
  session_created_at timestamptz,
  session_last_used_at timestamptz,
  session_expires_at timestamptz
);

CREATE FUNCTION trucker.account_of(p_session uuid) RETURNS SETOF trucker.account_view
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
  SELECT p.id, p.phone_e164, p.display_name, p.contact_email, p.registration_completed_at,
         s.id, s.created_at, s.last_used_at,
         least(s.last_used_at + make_interval(mins => g.session_idle_minutes),
               s.absolute_expires_at,
               s.created_at + make_interval(hours => g.session_absolute_hours))
  FROM trucker.session s
  JOIN trucker.person p ON p.id = s.person_id
  CROSS JOIN trucker.security_setting g
  WHERE s.id = p_session
$$;

CREATE FUNCTION trucker.record_identity_event(
  p_kind text, p_person uuid, p_session uuid, p_request_id text
) RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
  INSERT INTO trucker.identity_event (occurred_at, kind, person_id, session_id, request_id)
  VALUES (trucker.clock_now(), p_kind, p_person, p_session, left(p_request_id, 200))
$$;

-- ---------------------------------------------------------------------------------------------
-- Asking for a code.
--   p_pepper  64 hexadecimal characters derived by the API from its secret. Never stored.
--   p_reveal  whether the caller asks to be given the code (local development display).
-- status: created | repeated | too_soon | too_many | closed
-- The code is returned only when asked for AND the database is marked local-development or
-- test. In any other database nothing is created at all.
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION trucker.sign_in_request_code(
  p_phone text, p_request_key text, p_pepper text, p_reveal boolean,
  OUT status text, OUT challenge_id uuid, OUT created_at timestamptz, OUT expires_at timestamptz,
  OUT resend_available_at timestamptz, OUT retry_after_seconds integer, OUT development_code text
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
DECLARE
  g trucker.security_setting;
  kind text;
  t timestamptz := trucker.clock_now();
  wait interval;
  found_id uuid;
  found_created timestamptz;
  found_expires timestamptz;
  recent integer;
  latest timestamptz;
  oldest timestamptz;
  code text;
BEGIN
  SELECT e.kind INTO kind FROM trucker.environment e;
  IF kind IS NULL OR kind NOT IN ('local-development', 'test') THEN
    status := 'closed';
    RETURN;
  END IF;
  IF p_phone IS NULL OR p_phone !~ '^\+[1-9][0-9]{6,14}$'
     OR p_request_key IS NULL OR length(p_request_key) NOT BETWEEN 1 AND 200
     OR p_pepper IS NULL OR p_pepper !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT * INTO g FROM trucker.security_setting;
  wait := make_interval(secs => g.code_resend_wait_seconds);

  -- One request at a time per number, so the limits below cannot be raced.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_phone, 0));

  SELECT c.id, c.created_at, c.expires_at INTO found_id, found_created, found_expires
  FROM trucker.sign_in_challenge c
  WHERE c.phone_e164 = p_phone AND c.request_key = p_request_key;
  IF FOUND THEN
    status := 'repeated';
    challenge_id := found_id;
    created_at := found_created;
    expires_at := found_expires;
    resend_available_at := found_created + wait;
    RETURN;
  END IF;

  SELECT count(*)::integer, max(c.created_at), min(c.created_at) INTO recent, latest, oldest
  FROM trucker.sign_in_challenge c
  WHERE c.phone_e164 = p_phone AND c.created_at > t - interval '1 hour';
  IF latest IS NOT NULL AND t - latest < wait THEN
    status := 'too_soon';
    retry_after_seconds := ceil(extract(epoch FROM (latest + wait - t)))::integer;
    RETURN;
  END IF;
  IF recent >= g.code_max_per_hour THEN
    status := 'too_many';
    retry_after_seconds := ceil(extract(epoch FROM (oldest + interval '1 hour' - t)))::integer;
    RETURN;
  END IF;

  -- Only the newest code can be used.
  UPDATE trucker.sign_in_challenge c SET superseded_at = t
  WHERE c.phone_e164 = p_phone AND c.consumed_at IS NULL AND c.superseded_at IS NULL;

  code := trucker.random_code();
  found_id := gen_random_uuid();
  INSERT INTO trucker.sign_in_challenge (id, phone_e164, code_hash, request_key, created_at, expires_at)
  VALUES (found_id, p_phone, trucker.code_hash(p_pepper, found_id, code), p_request_key, t,
          t + make_interval(secs => g.code_ttl_seconds));

  status := 'created';
  challenge_id := found_id;
  created_at := t;
  expires_at := t + make_interval(secs => g.code_ttl_seconds);
  resend_available_at := t + wait;
  IF coalesce(p_reveal, false) THEN
    development_code := code;
  END IF;
END
$$;

-- ---------------------------------------------------------------------------------------------
-- Exchanging a code for a session. The comparison happens here; nothing about the stored
-- hash is returned. The caller supplies the identifier of the session to create and the hash
-- of the token it derived for it; both are used only when the code is correct.
-- status: signed_in | repeated | incorrect | used | replaced | expired | locked
-- "repeated" is the same request sent again shortly after it succeeded (same retry key, same
-- code, session not ended): it gets the same session, so a lost answer can be retried.
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION trucker.sign_in_verify_code(
  p_challenge uuid, p_code text, p_request_key text, p_pepper text,
  p_session uuid, p_token_hash text, p_request_id text,
  OUT status text, OUT attempts_remaining integer, OUT session_id uuid
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
DECLARE
  g trucker.security_setting;
  ch trucker.sign_in_challenge;
  t timestamptz := trucker.clock_now();
  matches boolean;
  attempts integer;
  person uuid;
BEGIN
  IF p_session IS NULL OR p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$'
     OR p_request_key IS NULL OR length(p_request_key) NOT BETWEEN 1 AND 200
     OR p_pepper IS NULL OR p_pepper !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT * INTO g FROM trucker.security_setting;

  SELECT * INTO ch FROM trucker.sign_in_challenge c WHERE c.id = p_challenge FOR UPDATE;
  IF NOT FOUND THEN
    status := 'incorrect';
    RETURN;
  END IF;
  matches := p_code IS NOT NULL AND p_code ~ '^[0-9]{6}$'
             AND ch.code_hash = trucker.code_hash(p_pepper, ch.id, p_code);

  IF ch.consumed_at IS NOT NULL THEN
    IF matches AND ch.verify_key = p_request_key AND t - ch.consumed_at <= interval '2 minutes'
       AND EXISTS (SELECT 1 FROM trucker.session s
                   WHERE s.id = ch.session_id AND s.revoked_at IS NULL) THEN
      status := 'repeated';
      session_id := ch.session_id;
    ELSE
      status := 'used';
    END IF;
    RETURN;
  END IF;
  IF ch.superseded_at IS NOT NULL THEN
    status := 'replaced';
    RETURN;
  END IF;
  IF ch.expires_at <= t THEN
    status := 'expired';
    RETURN;
  END IF;
  IF ch.failed_attempts >= g.code_max_attempts THEN
    status := 'locked';
    RETURN;
  END IF;

  IF NOT matches THEN
    attempts := ch.failed_attempts + 1;
    UPDATE trucker.sign_in_challenge c SET failed_attempts = attempts WHERE c.id = ch.id;
    IF attempts >= g.code_max_attempts THEN
      PERFORM trucker.record_identity_event('code_locked', NULL, NULL, p_request_id);
      status := 'locked';
    ELSE
      status := 'incorrect';
      attempts_remaining := g.code_max_attempts - attempts;
    END IF;
    RETURN;
  END IF;

  INSERT INTO trucker.person (phone_e164) VALUES (ch.phone_e164)
  ON CONFLICT (phone_e164) DO UPDATE SET phone_e164 = EXCLUDED.phone_e164
  RETURNING id INTO person;
  INSERT INTO trucker.session (id, person_id, token_hash, created_at, last_used_at, absolute_expires_at)
  VALUES (p_session, person, p_token_hash, t, t, t + make_interval(hours => g.session_absolute_hours));
  UPDATE trucker.sign_in_challenge c
  SET consumed_at = t, verify_key = p_request_key, session_id = p_session
  WHERE c.id = ch.id;
  PERFORM trucker.record_identity_event('signed_in', person, p_session, p_request_id);
  status := 'signed_in';
  session_id := p_session;
END
$$;

-- ---------------------------------------------------------------------------------------------
-- The session check made on every request: one statement.
-- status: ok | unknown | expired. A session past its idle period or its absolute limit is
-- ended here and recorded. "Last used" is rewritten at most once a minute.
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION trucker.session_check(
  p_token_hash text, p_request_id text,
  OUT status text, OUT person_id uuid, OUT session_id uuid
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
DECLARE
  g trucker.security_setting;
  s trucker.session;
  t timestamptz := trucker.clock_now();
  reason text;
BEGIN
  status := 'unknown';
  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN
    RETURN;
  END IF;
  SELECT * INTO s FROM trucker.session x WHERE x.token_hash = p_token_hash FOR UPDATE;
  IF NOT FOUND OR s.revoked_at IS NOT NULL THEN
    RETURN;
  END IF;
  SELECT * INTO g FROM trucker.security_setting;
  IF least(s.absolute_expires_at, s.created_at + make_interval(hours => g.session_absolute_hours)) <= t THEN
    reason := 'absolute_expired';
  ELSIF s.last_used_at + make_interval(mins => g.session_idle_minutes) <= t THEN
    reason := 'idle_expired';
  END IF;
  IF reason IS NOT NULL THEN
    UPDATE trucker.session x SET revoked_at = t, revoked_reason = reason WHERE x.id = s.id;
    PERFORM trucker.record_identity_event('session_expired', s.person_id, s.id, p_request_id);
    status := 'expired';
    RETURN;
  END IF;
  IF t - s.last_used_at >= interval '1 minute' THEN
    UPDATE trucker.session x SET last_used_at = t WHERE x.id = s.id;
  END IF;
  status := 'ok';
  person_id := s.person_id;
  session_id := s.id;
END
$$;

-- ---------------------------------------------------------------------------------------------
-- What a signed-in person may do with their own account. Each function finds the person from
-- the token hash of a live session and takes no identifier of a person, so it cannot be
-- pointed at anyone else.
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION trucker.my_account(p_token_hash text) RETURNS SETOF trucker.account_view
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
  SELECT a.*
  FROM trucker.live_session(p_token_hash) l
  CROSS JOIN LATERAL trucker.account_of(l.session_id) a
$$;

-- status: completed | already | unauthorized | closed
-- Only demonstration terms exist, and only a database marked local-development or test
-- records them: a row is never evidence that approved legal terms were accepted.
CREATE FUNCTION trucker.complete_registration(
  p_token_hash text, p_display_name text, p_contact_email text,
  p_terms_version text, p_terms_language text, p_request_id text
) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
DECLARE
  who record;
  kind text;
  t timestamptz := trucker.clock_now();
  completed timestamptz;
BEGIN
  SELECT l.session_id, l.person_id INTO who FROM trucker.live_session(p_token_hash) l;
  IF NOT FOUND THEN
    RETURN 'unauthorized';
  END IF;
  SELECT e.kind INTO kind FROM trucker.environment e;
  IF kind IS NULL OR kind NOT IN ('local-development', 'test') THEN
    RETURN 'closed';
  END IF;
  SELECT p.registration_completed_at INTO completed
  FROM trucker.person p WHERE p.id = who.person_id FOR UPDATE;
  IF completed IS NOT NULL THEN
    RETURN 'already';
  END IF;
  INSERT INTO trucker.terms_acceptance (person_id, terms_kind, version, language, accepted_at)
  VALUES (who.person_id, 'demonstration', p_terms_version, p_terms_language, t)
  ON CONFLICT ON CONSTRAINT terms_acceptance_once DO NOTHING;
  UPDATE trucker.person p
  SET display_name = p_display_name, contact_email = p_contact_email, registration_completed_at = t
  WHERE p.id = who.person_id;
  PERFORM trucker.record_identity_event('registration_completed', who.person_id, who.session_id, p_request_id);
  RETURN 'completed';
END
$$;

-- The caller's own open sessions, newest first.
CREATE FUNCTION trucker.my_sessions(p_token_hash text)
RETURNS TABLE (id uuid, created_at timestamptz, last_used_at timestamptz, expires_at timestamptz, current boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
  SELECT s.id, s.created_at, s.last_used_at,
         least(s.last_used_at + make_interval(mins => g.session_idle_minutes),
               s.absolute_expires_at,
               s.created_at + make_interval(hours => g.session_absolute_hours)),
         s.id = l.session_id
  FROM trucker.live_session(p_token_hash) l
  JOIN trucker.session s ON s.person_id = l.person_id
  CROSS JOIN trucker.security_setting g
  WHERE s.revoked_at IS NULL
    AND s.absolute_expires_at > trucker.clock_now()
    AND s.created_at + make_interval(hours => g.session_absolute_hours) > trucker.clock_now()
    AND s.last_used_at + make_interval(mins => g.session_idle_minutes) > trucker.clock_now()
  ORDER BY s.created_at DESC, s.id
$$;

-- Ends one of the caller's own sessions. status: revoked | not_found | unauthorized.
-- A session of another person is answered exactly like one that does not exist.
CREATE FUNCTION trucker.revoke_my_session(p_token_hash text, p_session uuid, p_request_id text)
RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
DECLARE
  who record;
  own boolean;
BEGIN
  SELECT l.session_id, l.person_id INTO who FROM trucker.live_session(p_token_hash) l;
  IF NOT FOUND THEN
    RETURN 'unauthorized';
  END IF;
  own := p_session = who.session_id;
  UPDATE trucker.session s
  SET revoked_at = trucker.clock_now(),
      revoked_reason = CASE WHEN own THEN 'signed_out' ELSE 'revoked_by_person' END
  WHERE s.id = p_session AND s.person_id = who.person_id AND s.revoked_at IS NULL;
  IF NOT FOUND THEN
    RETURN 'not_found';
  END IF;
  PERFORM trucker.record_identity_event(
    CASE WHEN own THEN 'signed_out' ELSE 'session_revoked' END, who.person_id, p_session, p_request_id);
  RETURN 'revoked';
END
$$;

-- Ends every other session of the caller. Returns how many, or NULL when not signed in.
CREATE FUNCTION trucker.revoke_my_other_sessions(p_token_hash text, p_request_id text)
RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
DECLARE
  who record;
  ended uuid;
  total integer := 0;
BEGIN
  SELECT l.session_id, l.person_id INTO who FROM trucker.live_session(p_token_hash) l;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  FOR ended IN
    UPDATE trucker.session s
    SET revoked_at = trucker.clock_now(), revoked_reason = 'revoked_by_person'
    WHERE s.person_id = who.person_id AND s.id <> who.session_id AND s.revoked_at IS NULL
    RETURNING s.id
  LOOP
    PERFORM trucker.record_identity_event('session_revoked', who.person_id, ended, p_request_id);
    total := total + 1;
  END LOOP;
  RETURN total;
END
$$;

-- Whether the settings have been reviewed for production. Read when a production API starts.
CREATE FUNCTION trucker.security_settings_reviewed() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
  SELECT g.reviewed_for_production FROM trucker.security_setting g
$$;

-- ---------------------------------------------------------------------------------------------
-- Organisation functions from 0003 that decided who is asking: they now apply the idle
-- period as well as the absolute limit, through the one place that defines a live session.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trucker.request_person() RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
  SELECT l.person_id
  FROM trucker.live_session(nullif(current_setting('trucker.session_token_hash', true), '')) l
$$;

-- Creating an organisation no longer takes the time or the limit from its caller.
DROP FUNCTION trucker.create_organisation(text, text, text, text, text, text, timestamptz, integer, boolean);
CREATE FUNCTION trucker.create_organisation(
  p_legal_name text, p_trading_name text, p_country_code text, p_registration_number text,
  p_address text, p_contact_name text, p_allow_fixtures boolean
) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
DECLARE
  actor uuid := trucker.request_person();
  t timestamptz := trucker.clock_now();
  creation_limit integer;
  created uuid;
  new_row trucker.organisation;
  kind text;
BEGIN
  IF actor IS NULL THEN
    RAISE EXCEPTION 'no signed-in person' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM trucker.person
                 WHERE id = actor AND registration_completed_at IS NOT NULL) THEN
    RAISE EXCEPTION 'registration is not complete' USING ERRCODE = 'TR001';
  END IF;
  -- One creation at a time per person, so the limit cannot be raced.
  PERFORM pg_advisory_xact_lock(hashtextextended('organisation.create:' || actor::text, 0));
  SELECT g.organisation_creation_limit INTO creation_limit FROM trucker.security_setting g;
  IF creation_limit IS NULL
     OR (SELECT count(*) FROM trucker.organisation WHERE created_by = actor) >= creation_limit THEN
    RAISE EXCEPTION 'creation limit reached'
      USING ERRCODE = 'TR002', DETAIL = coalesce(creation_limit::text, '');
  END IF;
  SELECT e.kind INTO kind FROM trucker.environment e;
  IF NOT EXISTS (
    SELECT 1 FROM trucker.country c
    WHERE c.code = p_country_code
      AND c.registration_state = 'enabled'
      AND (NOT c.fixture
           OR (coalesce(p_allow_fixtures, false) AND kind IN ('local-development', 'test')))) THEN
    RAISE EXCEPTION 'country is not open for registration' USING ERRCODE = 'TR003';
  END IF;

  INSERT INTO trucker.organisation
    (legal_name, trading_name, country_code, registration_number, address, contact_name,
     created_by, created_at, updated_at)
  VALUES
    (p_legal_name, p_trading_name, p_country_code, p_registration_number, p_address,
     p_contact_name, actor, t, t)
  RETURNING * INTO new_row;
  created := new_row.id;
  INSERT INTO trucker.membership (organisation_id, person_id, role, created_at)
  VALUES (created, actor, 'admin', t);
  INSERT INTO trucker.audit_entry
    (occurred_at, actor_person_id, organisation_id, action, record_type, record_id,
     request_id, before_values, after_values)
  VALUES
    (t, actor, created, 'organisation.created', 'organisation', created,
     nullif(current_setting('trucker.request_id', true), ''),
     NULL, trucker.organisation_values(new_row));
  RETURN created;
END
$$;

-- The time of a change is the database's, not the caller's. Runs before the audit trigger,
-- which copies it into the history.
CREATE FUNCTION trucker.stamp_organisation_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
BEGIN
  NEW.updated_at := trucker.clock_now();
  RETURN NEW;
END
$$;
CREATE TRIGGER organisation_stamp BEFORE UPDATE ON trucker.organisation
  FOR EACH ROW EXECUTE FUNCTION trucker.stamp_organisation_change();
REVOKE UPDATE (updated_at) ON trucker.organisation FROM trucker_app;

-- Search paths of the functions kept from 0003: temporary objects are searched last.
ALTER FUNCTION trucker.is_member(uuid) SET search_path = pg_catalog, trucker, pg_temp;
ALTER FUNCTION trucker.is_admin(uuid) SET search_path = pg_catalog, trucker, pg_temp;
ALTER FUNCTION trucker.request_organisation() SET search_path = pg_catalog, trucker, pg_temp;
ALTER FUNCTION trucker.my_organisations() SET search_path = pg_catalog, trucker, pg_temp;
ALTER FUNCTION trucker.audit_organisation_change() SET search_path = pg_catalog, trucker, pg_temp;
ALTER FUNCTION trucker.organisation_selected() SET search_path = pg_catalog, trucker, pg_temp;
ALTER FUNCTION trucker.organisation_values(trucker.organisation) SET search_path = pg_catalog, trucker, pg_temp;
ALTER FUNCTION trucker.guard_country() SET search_path = pg_catalog, trucker, pg_temp;
ALTER FUNCTION trucker.guard_environment() SET search_path = pg_catalog, trucker, pg_temp;

-- ---------------------------------------------------------------------------------------------
-- Who may run what. Nothing in this schema is open to PUBLIC. The API's role may run exactly
-- the functions named here; the building blocks above are reachable only from inside them.
-- ---------------------------------------------------------------------------------------------
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA trucker FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA trucker FROM trucker_app;
GRANT EXECUTE ON FUNCTION
  trucker.sign_in_request_code(text, text, text, boolean),
  trucker.sign_in_verify_code(uuid, text, text, text, uuid, text, text),
  trucker.session_check(text, text),
  trucker.my_account(text),
  trucker.complete_registration(text, text, text, text, text, text),
  trucker.my_sessions(text),
  trucker.revoke_my_session(text, uuid, text),
  trucker.revoke_my_other_sessions(text, text),
  trucker.security_settings_reviewed(),
  trucker.request_person(),
  trucker.request_organisation(),
  trucker.is_member(uuid),
  trucker.is_admin(uuid),
  trucker.organisation_selected(),
  trucker.my_organisations(),
  trucker.create_organisation(text, text, text, text, text, text, boolean)
TO trucker_app;

-- ---------------------------------------------------------------------------------------------
-- The identity tables: no right of any kind for the API's role, and row security with no
-- policy as a second barrier should a right ever be granted by mistake. The owner, as which
-- the functions above run, is not bound by it.
-- ---------------------------------------------------------------------------------------------
REVOKE ALL ON trucker.person, trucker.session, trucker.sign_in_challenge,
  trucker.terms_acceptance, trucker.identity_event FROM trucker_app;
REVOKE ALL ON trucker.security_setting, trucker.test_clock FROM trucker_app, PUBLIC;

ALTER TABLE trucker.person ENABLE ROW LEVEL SECURITY;
ALTER TABLE trucker.session ENABLE ROW LEVEL SECURITY;
ALTER TABLE trucker.sign_in_challenge ENABLE ROW LEVEL SECURITY;
ALTER TABLE trucker.terms_acceptance ENABLE ROW LEVEL SECURITY;
ALTER TABLE trucker.identity_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE trucker.security_setting ENABLE ROW LEVEL SECURITY;
ALTER TABLE trucker.test_clock ENABLE ROW LEVEL SECURITY;
