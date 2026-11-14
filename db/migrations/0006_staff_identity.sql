-- 0006_staff_identity
-- Staff accounts, separate from participants: their own table, sessions, sign-in and audit.
-- A participant session is never a staff session and the reverse, because neither can be
-- found in the other's tables.
--
-- Decisions recorded on 14 November 2026 (docs/delivery/STAFF_IDENTITY_SLICE_8_SCOPE.md):
--   S-1  work email and password, a mandatory authenticator-app code, single-use recovery codes;
--   S-2  the first administrator is created once by an operator command, with an expiring,
--        single-use enrolment link; an existing administrator is never reset by it;
--   S-3  an administrator may grant a privilege to another person, never to themselves;
--        grants, removals and refusals are recorded;
--   S-4  whether a staff member also has a participant account is an explicit declaration.
--        "Not declared" never means "independent".
--
-- There is no setting that makes the second factor optional: a staff session is created by
-- one function only, and it creates one only after a correct authenticator or recovery code.
--
-- As in 0004: the API's role has no right on any table here. Each operation is a function
-- that runs as the tables' owner, establishes for itself who is asking, takes its locks, reads
-- the database's clock and only then decides. Limits come from the protected settings row.
-- Passwords, authenticator secrets and recovery codes are checked here and never handed back.
--
-- Password hashing (bcrypt) and HMAC-SHA-1 for authenticator codes come from pgcrypto, which
-- ships with PostgreSQL. It lives in a schema of its own that the API's role cannot use.

CREATE SCHEMA trucker_ext;
REVOKE ALL ON SCHEMA trucker_ext FROM PUBLIC;
CREATE EXTENSION pgcrypto WITH SCHEMA trucker_ext;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA trucker_ext FROM PUBLIC;

-- ---------------------------------------------------------------------------------------------
-- Protected settings for staff. Development defaults; they need review before production, so
-- adding them withdraws any earlier review.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE trucker.security_setting
  ADD COLUMN staff_session_idle_minutes integer NOT NULL DEFAULT 15
    CHECK (staff_session_idle_minutes BETWEEN 1 AND 240),
  ADD COLUMN staff_session_absolute_hours integer NOT NULL DEFAULT 8
    CHECK (staff_session_absolute_hours BETWEEN 1 AND 24),
  ADD COLUMN staff_failure_limit integer NOT NULL DEFAULT 5
    CHECK (staff_failure_limit BETWEEN 3 AND 20),
  ADD COLUMN staff_lock_minutes integer NOT NULL DEFAULT 15
    CHECK (staff_lock_minutes BETWEEN 1 AND 1440),
  ADD COLUMN staff_ticket_seconds integer NOT NULL DEFAULT 300
    CHECK (staff_ticket_seconds BETWEEN 30 AND 900),
  ADD COLUMN staff_enrolment_hours integer NOT NULL DEFAULT 24
    CHECK (staff_enrolment_hours BETWEEN 1 AND 168);
UPDATE trucker.security_setting SET reviewed_for_production = false, updated_at = now();

-- ---------------------------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------------------------
CREATE TABLE trucker.staff_account (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE
    CHECK (email = lower(email) AND length(email) BETWEEN 3 AND 254 AND email ~ '^[^@[:space:]]+@[^@[:space:]]+$'),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 120),
  -- invited: has never completed enrolment. active: may sign in. disabled: may not.
  status text NOT NULL CHECK (status IN ('invited', 'active', 'disabled')),
  enrolled_at timestamptz,
  password_hash text,
  totp_secret bytea,
  -- The last 30-second step a code was accepted for: a code is never accepted twice.
  totp_last_step bigint,
  failed_count integer NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
  locked_until timestamptz,
  -- S-4. Whether this person also has a participant account, as declared by an administrator.
  participant_link text NOT NULL DEFAULT 'not_declared'
    CHECK (participant_link IN ('not_declared', 'declared_none', 'declared')),
  participant_phone text CHECK (participant_phone ~ '^\+[1-9][0-9]{6,14}$'),
  created_by uuid REFERENCES trucker.staff_account (id),
  creation_key text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT staff_account_enrolled CHECK (
    (status = 'invited' AND enrolled_at IS NULL)
    OR (status = 'active' AND enrolled_at IS NOT NULL AND password_hash IS NOT NULL AND totp_secret IS NOT NULL)
    OR status = 'disabled'),
  CONSTRAINT staff_account_link CHECK ((participant_link = 'declared') = (participant_phone IS NOT NULL))
);
COMMENT ON TABLE trucker.staff_account IS
  'Staff accounts. Separate from trucker.person. No function hands back password_hash or totp_secret.';

CREATE TABLE trucker.staff_privilege (
  staff_id uuid NOT NULL REFERENCES trucker.staff_account (id),
  privilege text NOT NULL CHECK (privilege IN ('staff_admin', 'reviewer')),
  granted_by uuid REFERENCES trucker.staff_account (id),
  granted_at timestamptz NOT NULL,
  PRIMARY KEY (staff_id, privilege),
  CONSTRAINT staff_privilege_not_self CHECK (granted_by IS DISTINCT FROM staff_id)
);

CREATE TABLE trucker.staff_enrolment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id uuid NOT NULL REFERENCES trucker.staff_account (id),
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  -- Ended by use, by a newer link, or by too many wrong codes.
  ended_at timestamptz,
  ended_reason text CHECK (ended_reason IN ('used', 'superseded', 'too_many_failures')),
  pending_password_hash text,
  pending_totp_secret bytea,
  failed_count integer NOT NULL DEFAULT 0,
  CONSTRAINT staff_enrolment_end CHECK ((ended_at IS NULL) = (ended_reason IS NULL))
);
CREATE UNIQUE INDEX staff_enrolment_one_open ON trucker.staff_enrolment (staff_id) WHERE ended_at IS NULL;

CREATE TABLE trucker.staff_recovery_code (
  staff_id uuid NOT NULL REFERENCES trucker.staff_account (id),
  code_hash text NOT NULL,
  used_at timestamptz,
  PRIMARY KEY (staff_id, code_hash)
);

-- Between the password and the code: proof that the password step was passed, for a short time.
CREATE TABLE trucker.staff_sign_in_ticket (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id uuid NOT NULL REFERENCES trucker.staff_account (id),
  ticket_hash text NOT NULL UNIQUE CHECK (ticket_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  failed_count integer NOT NULL DEFAULT 0,
  used_at timestamptz,
  session_id uuid
);

CREATE TABLE trucker.staff_session (
  id uuid PRIMARY KEY,
  staff_id uuid NOT NULL REFERENCES trucker.staff_account (id),
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL,
  last_used_at timestamptz NOT NULL,
  absolute_expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoked_reason text CHECK (revoked_reason IN (
    'signed_out', 'idle_expired', 'absolute_expired', 'account_closed', 'credentials_replaced')),
  CONSTRAINT staff_session_revocation_complete CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL))
);
CREATE INDEX staff_session_staff_idx ON trucker.staff_session (staff_id);

-- Every staff action, and every refused attempt to use a privilege not held. Holds no
-- password, code, secret or token.
CREATE TABLE trucker.staff_audit_entry (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at timestamptz NOT NULL,
  -- Nothing for the operator command and for attempts by nobody who could be identified.
  actor_staff_id uuid REFERENCES trucker.staff_account (id),
  action text NOT NULL CHECK (action ~ '^staff\.[a-z_]+(\.[a-z_]+)?$'),
  outcome text NOT NULL CHECK (outcome IN ('done', 'refused')),
  subject_staff_id uuid REFERENCES trucker.staff_account (id),
  request_id text,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX staff_audit_entry_subject_idx ON trucker.staff_audit_entry (subject_staff_id, id);

CREATE FUNCTION trucker.guard_staff_audit() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, trucker, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'a staff audit entry cannot be changed or removed' USING ERRCODE = 'check_violation';
END
$$;
CREATE TRIGGER staff_audit_entry_guard BEFORE UPDATE OR DELETE ON trucker.staff_audit_entry
  FOR EACH ROW EXECUTE FUNCTION trucker.guard_staff_audit();
CREATE TRIGGER staff_audit_entry_truncate_guard BEFORE TRUNCATE ON trucker.staff_audit_entry
  FOR EACH STATEMENT EXECUTE FUNCTION trucker.guard_staff_audit();

-- ---------------------------------------------------------------------------------------------
-- Building blocks. None is callable by the API's role.
-- ---------------------------------------------------------------------------------------------

-- RFC 4648 base32, without padding: how an authenticator secret is written for a person.
CREATE FUNCTION trucker.base32(p_bytes bytea) RETURNS text
LANGUAGE plpgsql IMMUTABLE STRICT SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  alphabet constant text := 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  buffer bigint := 0;
  bits integer := 0;
  result text := '';
BEGIN
  FOR i IN 0..length(p_bytes) - 1 LOOP
    buffer := (buffer << 8) | get_byte(p_bytes, i);
    bits := bits + 8;
    WHILE bits >= 5 LOOP
      result := result || substr(alphabet, ((buffer >> (bits - 5)) & 31)::integer + 1, 1);
      bits := bits - 5;
    END LOOP;
    buffer := buffer & ((1::bigint << bits) - 1);
  END LOOP;
  IF bits > 0 THEN
    result := result || substr(alphabet, ((buffer << (5 - bits)) & 31)::integer + 1, 1);
  END IF;
  RETURN result;
END
$$;

-- RFC 6238 with the RFC 4226 truncation: six digits, 30-second steps, HMAC-SHA-1, which is
-- what authenticator apps implement. The HMAC is pgcrypto's.
CREATE FUNCTION trucker.totp_code(p_secret bytea, p_step bigint) RETURNS text
LANGUAGE plpgsql IMMUTABLE STRICT SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  mac bytea := trucker_ext.hmac(int8send(p_step), p_secret, 'sha1');
  start integer := get_byte(mac, 19) & 15;
  binary_code bigint;
BEGIN
  binary_code := ((get_byte(mac, start) & 127)::bigint << 24)
               | (get_byte(mac, start + 1)::bigint << 16)
               | (get_byte(mac, start + 2)::bigint << 8)
               | get_byte(mac, start + 3)::bigint;
  RETURN lpad((binary_code % 1000000)::text, 6, '0');
END
$$;

-- What is stored for a password: bcrypt of the password keyed with a value the caller holds
-- and the database does not keep. Keying first also keeps long passwords within bcrypt's
-- 72 bytes without cutting them.
CREATE FUNCTION trucker.staff_password_material(p_password text, p_pepper text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, trucker, pg_temp AS $$
  SELECT encode(
    trucker.hmac_sha256(decode(p_pepper, 'hex'), convert_to('staff-password:' || p_password, 'UTF8')),
    'hex')
$$;

CREATE FUNCTION trucker.staff_recovery_hash(p_pepper text, p_staff uuid, p_code text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, trucker, pg_temp AS $$
  SELECT encode(
    trucker.hmac_sha256(decode(p_pepper, 'hex'),
                        convert_to('staff-recovery:' || p_staff::text || ':' || p_code, 'UTF8')),
    'hex')
$$;

CREATE FUNCTION trucker.staff_privileges(p_staff uuid) RETURNS text[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
  SELECT coalesce(array_agg(p.privilege ORDER BY p.privilege), '{}')
  FROM trucker.staff_privilege p WHERE p.staff_id = p_staff
$$;

CREATE FUNCTION trucker.staff_audit(
  p_at timestamptz, p_actor uuid, p_action text, p_outcome text, p_subject uuid,
  p_request_id text, p_detail jsonb
) RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
  INSERT INTO trucker.staff_audit_entry
    (occurred_at, actor_staff_id, action, outcome, subject_staff_id, request_id, detail)
  VALUES (p_at, p_actor, p_action, p_outcome, p_subject, left(p_request_id, 200),
          coalesce(p_detail, '{}'::jsonb))
$$;

-- THE rule for whether a staff session is live at a given moment:
--   live | revoked | absolute_expired | idle_expired | account_closed | unknown
-- A session of an account that is not active is never live.
CREATE FUNCTION trucker.staff_session_state(p_session trucker.staff_session, p_at timestamptz) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
  SELECT CASE
    WHEN p_session.id IS NULL OR p_at IS NULL THEN 'unknown'
    WHEN p_session.revoked_at IS NOT NULL THEN 'revoked'
    WHEN NOT EXISTS (SELECT 1 FROM trucker.staff_account a
                     WHERE a.id = p_session.staff_id AND a.status = 'active') THEN 'account_closed'
    WHEN least(p_session.absolute_expires_at,
               p_session.created_at + make_interval(hours => g.staff_session_absolute_hours)) <= p_at
      THEN 'absolute_expired'
    WHEN p_session.last_used_at + make_interval(mins => g.staff_session_idle_minutes) <= p_at
      THEN 'idle_expired'
    ELSE 'live'
  END
  FROM trucker.security_setting g
$$;

-- For reading only: the live staff session for a token hash, judged at the moment of the call.
CREATE FUNCTION trucker.staff_live_session(p_token_hash text)
RETURNS TABLE (session_id uuid, staff_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
  SELECT s.id, s.staff_id
  FROM (SELECT trucker.clock_now() AS at) c
  CROSS JOIN trucker.staff_session s
  WHERE p_token_hash ~ '^[0-9a-f]{64}$'
    AND s.token_hash = p_token_hash
    AND trucker.staff_session_state(s, c.at) = 'live'
$$;

-- The start of every function that changes something on behalf of a signed-in staff member:
-- lock the caller's session, lock the account acted on if there is one, read the clock, judge
-- the session, then check the privilege. A caller without the privilege is refused and the
-- refusal is recorded.
--   status: ok | unauthorized | forbidden
CREATE FUNCTION trucker.staff_enter(
  p_token_hash text, p_privilege text, p_action text, p_subject uuid, p_request_id text,
  OUT status text, OUT staff_id uuid, OUT at timestamptz
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
DECLARE
  own trucker.staff_session;
BEGIN
  status := 'unauthorized';
  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN
    RETURN;
  END IF;
  SELECT * INTO own FROM trucker.staff_session s WHERE s.token_hash = p_token_hash FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  IF p_subject IS NOT NULL THEN
    PERFORM 1 FROM trucker.staff_account a WHERE a.id = p_subject FOR UPDATE;
  END IF;
  at := trucker.clock_now();
  IF trucker.staff_session_state(own, at) <> 'live' THEN
    RETURN;
  END IF;
  staff_id := own.staff_id;
  IF p_privilege IS NOT NULL AND NOT (p_privilege = ANY (trucker.staff_privileges(own.staff_id))) THEN
    PERFORM trucker.staff_audit(at, own.staff_id, p_action, 'refused', p_subject, p_request_id,
                                jsonb_build_object('reason', 'privilege_not_held', 'privilege', p_privilege));
    status := 'forbidden';
    RETURN;
  END IF;
  status := 'ok';
END
$$;

-- Ends every open session of an account.
CREATE FUNCTION trucker.staff_end_sessions(p_staff uuid, p_reason text, p_at timestamptz) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
DECLARE
  ended integer;
BEGIN
  UPDATE trucker.staff_session s SET revoked_at = p_at, revoked_reason = p_reason
  WHERE s.staff_id = p_staff AND s.revoked_at IS NULL;
  GET DIAGNOSTICS ended = ROW_COUNT;
  RETURN ended;
END
$$;

-- Replaces the open enrolment link of an account, if any, with a new one.
CREATE FUNCTION trucker.staff_open_enrolment(p_staff uuid, p_enrol_hash text, p_at timestamptz) RETURNS timestamptz
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
DECLARE
  until timestamptz;
BEGIN
  UPDATE trucker.staff_enrolment e SET ended_at = p_at, ended_reason = 'superseded'
  WHERE e.staff_id = p_staff AND e.ended_at IS NULL;
  SELECT p_at + make_interval(hours => g.staff_enrolment_hours) INTO until FROM trucker.security_setting g;
  INSERT INTO trucker.staff_enrolment (staff_id, token_hash, created_at, expires_at)
  VALUES (p_staff, p_enrol_hash, p_at, until);
  RETURN until;
END
$$;

-- One wrong password or code against an account: counted, and at the limit the account is
-- locked for the configured period.
CREATE FUNCTION trucker.staff_count_failure(p_staff uuid, p_at timestamptz, p_request_id text) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
DECLARE
  g trucker.security_setting;
  failures integer;
BEGIN
  SELECT * INTO g FROM trucker.security_setting;
  UPDATE trucker.staff_account a SET failed_count = a.failed_count + 1
  WHERE a.id = p_staff RETURNING a.failed_count INTO failures;
  IF failures >= g.staff_failure_limit THEN
    UPDATE trucker.staff_account a
    SET failed_count = 0, locked_until = p_at + make_interval(mins => g.staff_lock_minutes)
    WHERE a.id = p_staff;
    PERFORM trucker.staff_audit(p_at, NULL, 'staff.locked', 'done', p_staff, p_request_id, '{}'::jsonb);
  END IF;
END
$$;

-- Whether a code is right for an account now. An authenticator code is accepted for the
-- current 30-second step and the one on either side, and never for a step already used. A
-- recovery code is accepted once. `method` says which it was.
CREATE FUNCTION trucker.staff_check_code(
  p_staff uuid, p_secret bytea, p_last_step bigint, p_code text, p_pepper text, p_at timestamptz,
  OUT accepted boolean, OUT method text, OUT step bigint
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
DECLARE
  typed text := lower(regexp_replace(coalesce(p_code, ''), '[^0-9A-Za-z]', '', 'g'));
  current_step bigint := floor(extract(epoch FROM p_at) / 30)::bigint;
  secret bytea;
BEGIN
  accepted := false;
  IF typed ~ '^[0-9]{6}$' THEN
    method := 'authenticator';
    IF p_secret IS NULL THEN
      RETURN;
    END IF;
    BEGIN
      secret := trucker_ext.pgp_sym_decrypt_bytea(p_secret, p_pepper);
    EXCEPTION WHEN others THEN
      RETURN;
    END;
    FOR candidate IN current_step - 1 .. current_step + 1 LOOP
      IF candidate > coalesce(p_last_step, 0) AND trucker.totp_code(secret, candidate) = typed THEN
        accepted := true;
        step := candidate;
        RETURN;
      END IF;
    END LOOP;
    RETURN;
  END IF;
  method := 'recovery_code';
  IF typed !~ '^[a-z2-7]{16}$' THEN
    RETURN;
  END IF;
  UPDATE trucker.staff_recovery_code r SET used_at = p_at
  WHERE r.staff_id = p_staff AND r.used_at IS NULL
    AND r.code_hash = trucker.staff_recovery_hash(p_pepper, p_staff, typed);
  accepted := FOUND;
END
$$;

-- ---------------------------------------------------------------------------------------------
-- The operator command (S-2). Not callable by the API's role: it is run by the migration
-- role, once, to create the first administrator. It refuses when an enrolled, active
-- administrator exists, and it never touches an existing administrator's credentials.
--   status: created | reissued | administrator_exists | email_taken | invalid
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION trucker.bootstrap_staff_admin(
  p_email text, p_display_name text, p_enrol_hash text,
  OUT status text, OUT staff_id uuid, OUT link_expires_at timestamptz
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_name text := btrim(coalesce(p_display_name, ''));
  existing trucker.staff_account;
  t timestamptz;
BEGIN
  LOCK TABLE trucker.staff_account IN SHARE ROW EXCLUSIVE MODE;
  t := trucker.clock_now();
  IF v_email !~ '^[^@[:space:]]+@[^@[:space:]]+$' OR length(v_email) > 254
     OR length(v_name) NOT BETWEEN 1 AND 120 OR p_enrol_hash IS NULL OR p_enrol_hash !~ '^[0-9a-f]{64}$' THEN
    status := 'invalid';
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM trucker.staff_account a
             JOIN trucker.staff_privilege p ON p.staff_id = a.id AND p.privilege = 'staff_admin'
             WHERE a.status = 'active') THEN
    PERFORM trucker.staff_audit(t, NULL, 'staff.bootstrap', 'refused', NULL, NULL,
                                jsonb_build_object('reason', 'administrator_exists'));
    status := 'administrator_exists';
    RETURN;
  END IF;
  SELECT * INTO existing FROM trucker.staff_account a WHERE a.email = v_email;
  IF FOUND THEN
    -- Only an administrator who was invited and never enrolled gets a new link.
    IF existing.status <> 'invited'
       OR NOT ('staff_admin' = ANY (trucker.staff_privileges(existing.id))) THEN
      status := 'email_taken';
      RETURN;
    END IF;
    staff_id := existing.id;
    status := 'reissued';
  ELSE
    INSERT INTO trucker.staff_account (email, display_name, status, created_at, updated_at)
    VALUES (v_email, v_name, 'invited', t, t) RETURNING id INTO staff_id;
    INSERT INTO trucker.staff_privilege (staff_id, privilege, granted_by, granted_at)
    VALUES (staff_id, 'staff_admin', NULL, t);
    status := 'created';
  END IF;
  link_expires_at := trucker.staff_open_enrolment(staff_id, p_enrol_hash, t);
  PERFORM trucker.staff_audit(t, NULL, 'staff.bootstrap', 'done', staff_id, NULL,
                              jsonb_build_object('result', status));
END
$$;

-- ---------------------------------------------------------------------------------------------
-- Enrolment: the holder of a link sets a password, is given an authenticator secret, and
-- proves the authenticator works. Only then does the account become usable, and only then are
-- recovery codes issued, once.
-- ---------------------------------------------------------------------------------------------

-- Whether a link can still be used. status: open | invalid
CREATE FUNCTION trucker.staff_enrol_state(p_enrol_hash text, OUT status text, OUT email text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
BEGIN
  status := 'invalid';
  IF p_enrol_hash IS NULL OR p_enrol_hash !~ '^[0-9a-f]{64}$' THEN
    RETURN;
  END IF;
  SELECT a.email INTO email
  FROM trucker.staff_enrolment e JOIN trucker.staff_account a ON a.id = e.staff_id
  WHERE e.token_hash = p_enrol_hash AND e.ended_at IS NULL AND e.expires_at > trucker.clock_now()
    AND a.status <> 'disabled';
  IF FOUND THEN
    status := 'open';
  END IF;
END
$$;

-- Step one. May be repeated while the link is open: each time a new secret is made.
--   status: ok | invalid_link | weak_password
CREATE FUNCTION trucker.staff_enrol_begin(
  p_enrol_hash text, p_password text, p_pepper text, p_request_id text,
  OUT status text, OUT email text, OUT secret text
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
DECLARE
  link trucker.staff_enrolment;
  account trucker.staff_account;
  t timestamptz;
  raw bytea;
BEGIN
  status := 'invalid_link';
  IF p_enrol_hash IS NULL OR p_enrol_hash !~ '^[0-9a-f]{64}$' OR p_pepper IS NULL OR p_pepper !~ '^[0-9a-f]{64}$' THEN
    RETURN;
  END IF;
  SELECT * INTO link FROM trucker.staff_enrolment e WHERE e.token_hash = p_enrol_hash FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  SELECT * INTO account FROM trucker.staff_account a WHERE a.id = link.staff_id FOR UPDATE;
  t := trucker.clock_now();
  IF link.ended_at IS NOT NULL OR link.expires_at <= t OR account.status = 'disabled' THEN
    RETURN;
  END IF;
  IF p_password IS NULL OR length(p_password) NOT BETWEEN 12 AND 128
     OR lower(p_password) = account.email THEN
    status := 'weak_password';
    RETURN;
  END IF;
  raw := trucker_ext.gen_random_bytes(20);
  UPDATE trucker.staff_enrolment e
  SET pending_password_hash = trucker_ext.crypt(trucker.staff_password_material(p_password, p_pepper),
                                                trucker_ext.gen_salt('bf', 12)),
      pending_totp_secret = trucker_ext.pgp_sym_encrypt_bytea(raw, p_pepper)
  WHERE e.id = link.id;
  status := 'ok';
  email := account.email;
  secret := trucker.base32(raw);
END
$$;

-- Step two. status: ok | invalid_link | not_started | wrong_code
CREATE FUNCTION trucker.staff_enrol_complete(
  p_enrol_hash text, p_code text, p_pepper text, p_request_id text,
  OUT status text, OUT recovery_codes text[]
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
DECLARE
  link trucker.staff_enrolment;
  account trucker.staff_account;
  g trucker.security_setting;
  t timestamptz;
  checked record;
  code text;
BEGIN
  status := 'invalid_link';
  IF p_enrol_hash IS NULL OR p_enrol_hash !~ '^[0-9a-f]{64}$' OR p_pepper IS NULL OR p_pepper !~ '^[0-9a-f]{64}$' THEN
    RETURN;
  END IF;
  SELECT * INTO link FROM trucker.staff_enrolment e WHERE e.token_hash = p_enrol_hash FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  SELECT * INTO account FROM trucker.staff_account a WHERE a.id = link.staff_id FOR UPDATE;
  SELECT * INTO g FROM trucker.security_setting;
  t := trucker.clock_now();
  IF link.ended_at IS NOT NULL OR link.expires_at <= t OR account.status = 'disabled' THEN
    RETURN;
  END IF;
  IF link.pending_password_hash IS NULL OR link.pending_totp_secret IS NULL THEN
    status := 'not_started';
    RETURN;
  END IF;
  -- Only an authenticator code proves the authenticator works.
  IF coalesce(p_code, '') !~ '^[[:space:]]*[0-9]{3}[[:space:]]?[0-9]{3}[[:space:]]*$' THEN
    checked := NULL;
  ELSE
    SELECT * INTO checked
    FROM trucker.staff_check_code(account.id, link.pending_totp_secret, NULL, p_code, p_pepper, t);
  END IF;
  IF checked IS NULL OR NOT checked.accepted THEN
    IF link.failed_count + 1 >= g.staff_failure_limit THEN
      UPDATE trucker.staff_enrolment e
      SET failed_count = e.failed_count + 1, ended_at = t, ended_reason = 'too_many_failures'
      WHERE e.id = link.id;
      PERFORM trucker.staff_audit(t, NULL, 'staff.enrolment_ended', 'done', account.id, p_request_id,
                                  jsonb_build_object('reason', 'too_many_failures'));
    ELSE
      UPDATE trucker.staff_enrolment e SET failed_count = e.failed_count + 1 WHERE e.id = link.id;
    END IF;
    status := 'wrong_code';
    RETURN;
  END IF;
  UPDATE trucker.staff_account a
  SET password_hash = link.pending_password_hash, totp_secret = link.pending_totp_secret,
      totp_last_step = checked.step, status = 'active', enrolled_at = coalesce(a.enrolled_at, t),
      failed_count = 0, locked_until = NULL, updated_at = t
  WHERE a.id = account.id;
  UPDATE trucker.staff_enrolment e
  SET ended_at = t, ended_reason = 'used', pending_password_hash = NULL, pending_totp_secret = NULL
  WHERE e.id = link.id;
  -- New credentials end what the old ones opened.
  PERFORM trucker.staff_end_sessions(account.id, 'credentials_replaced', t);
  DELETE FROM trucker.staff_recovery_code r WHERE r.staff_id = account.id;
  recovery_codes := '{}';
  FOR i IN 1..10 LOOP
    code := lower(trucker.base32(trucker_ext.gen_random_bytes(10)));
    INSERT INTO trucker.staff_recovery_code (staff_id, code_hash)
    VALUES (account.id, trucker.staff_recovery_hash(p_pepper, account.id, code));
    recovery_codes := recovery_codes
      || (substr(code, 1, 4) || '-' || substr(code, 5, 4) || '-' || substr(code, 9, 4) || '-' || substr(code, 13, 4));
  END LOOP;
  PERFORM trucker.staff_audit(t, account.id, 'staff.enrolled', 'done', account.id, p_request_id,
                              jsonb_build_object('first', account.enrolled_at IS NULL));
  status := 'ok';
END
$$;

-- ---------------------------------------------------------------------------------------------
-- Sign-in, in two steps. Neither step alone creates a session.
-- ---------------------------------------------------------------------------------------------

-- Step one: email and password. The answer is the same for an unknown email, a wrong
-- password, an account that is not active and a locked account, and takes the same work, so
-- it cannot be used to find out who is staff.
--   status: continue | refused
CREATE FUNCTION trucker.staff_sign_in_password(
  p_email text, p_password text, p_pepper text, p_ticket_hash text, p_request_id text,
  OUT status text
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
DECLARE
  account trucker.staff_account;
  g trucker.security_setting;
  t timestamptz;
  known boolean;
  matches boolean;
  -- A hash of nothing anyone knows: compared against when there is no account, for equal work.
  decoy constant text := '$2a$12$C6UzMDM.H6dfI/f/IKcEeO5KJ0Z1cXh0M4r5qfXqM5S8P0q0w6yIu';
BEGIN
  status := 'refused';
  IF p_pepper IS NULL OR p_pepper !~ '^[0-9a-f]{64}$'
     OR p_ticket_hash IS NULL OR p_ticket_hash !~ '^[0-9a-f]{64}$' THEN
    RETURN;
  END IF;
  SELECT * INTO account FROM trucker.staff_account a
  WHERE a.email = lower(btrim(coalesce(p_email, ''))) FOR UPDATE;
  known := FOUND;
  SELECT * INTO g FROM trucker.security_setting;
  t := trucker.clock_now();
  matches := trucker_ext.crypt(trucker.staff_password_material(coalesce(p_password, ''), p_pepper),
                               coalesce(account.password_hash, decoy))
             = coalesce(account.password_hash, decoy);
  IF NOT known OR account.status <> 'active' OR account.password_hash IS NULL THEN
    RETURN;
  END IF;
  IF account.locked_until IS NOT NULL AND account.locked_until > t THEN
    PERFORM trucker.staff_audit(t, NULL, 'staff.sign_in', 'refused', account.id, p_request_id,
                                jsonb_build_object('reason', 'locked'));
    RETURN;
  END IF;
  IF NOT matches THEN
    PERFORM trucker.staff_audit(t, NULL, 'staff.sign_in', 'refused', account.id, p_request_id,
                                jsonb_build_object('reason', 'password'));
    PERFORM trucker.staff_count_failure(account.id, t, p_request_id);
    RETURN;
  END IF;
  INSERT INTO trucker.staff_sign_in_ticket (staff_id, ticket_hash, created_at, expires_at)
  VALUES (account.id, p_ticket_hash, t, t + make_interval(secs => g.staff_ticket_seconds))
  ON CONFLICT (ticket_hash) DO NOTHING;
  status := 'continue';
END
$$;

-- Step two: the authenticator code, or a recovery code. This is the only place a staff
-- session is created. Repeating the call for a ticket already used with the same session
-- answers ok again and creates nothing, so a lost answer can be asked for again.
--   status: ok | refused | expired
CREATE FUNCTION trucker.staff_sign_in_verify(
  p_ticket_hash text, p_code text, p_pepper text, p_session uuid, p_token_hash text, p_request_id text,
  OUT status text, OUT staff_id uuid
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
DECLARE
  ticket trucker.staff_sign_in_ticket;
  account trucker.staff_account;
  g trucker.security_setting;
  t timestamptz;
  checked record;
  left_over integer;
BEGIN
  status := 'refused';
  IF p_ticket_hash IS NULL OR p_ticket_hash !~ '^[0-9a-f]{64}$'
     OR p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$'
     OR p_pepper IS NULL OR p_pepper !~ '^[0-9a-f]{64}$' OR p_session IS NULL THEN
    RETURN;
  END IF;
  SELECT * INTO ticket FROM trucker.staff_sign_in_ticket k WHERE k.ticket_hash = p_ticket_hash FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  SELECT * INTO account FROM trucker.staff_account a WHERE a.id = ticket.staff_id FOR UPDATE;
  SELECT * INTO g FROM trucker.security_setting;
  t := trucker.clock_now();
  IF ticket.used_at IS NOT NULL THEN
    IF ticket.session_id = p_session AND EXISTS (
         SELECT 1 FROM trucker.staff_session s
         WHERE s.id = p_session AND s.token_hash = p_token_hash
           AND trucker.staff_session_state(s, t) = 'live') THEN
      status := 'ok';
      staff_id := account.id;
    END IF;
    RETURN;
  END IF;
  IF ticket.expires_at <= t OR ticket.failed_count >= g.staff_failure_limit THEN
    status := 'expired';
    RETURN;
  END IF;
  IF account.status <> 'active' OR (account.locked_until IS NOT NULL AND account.locked_until > t) THEN
    RETURN;
  END IF;
  SELECT * INTO checked
  FROM trucker.staff_check_code(account.id, account.totp_secret, account.totp_last_step, p_code, p_pepper, t);
  IF NOT checked.accepted THEN
    UPDATE trucker.staff_sign_in_ticket k SET failed_count = k.failed_count + 1 WHERE k.id = ticket.id;
    PERFORM trucker.staff_audit(t, NULL, 'staff.sign_in', 'refused', account.id, p_request_id,
                                jsonb_build_object('reason', 'code', 'method', checked.method));
    PERFORM trucker.staff_count_failure(account.id, t, p_request_id);
    RETURN;
  END IF;
  UPDATE trucker.staff_account a
  SET failed_count = 0, locked_until = NULL,
      totp_last_step = coalesce(checked.step, a.totp_last_step)
  WHERE a.id = account.id;
  INSERT INTO trucker.staff_session (id, staff_id, token_hash, created_at, last_used_at, absolute_expires_at)
  VALUES (p_session, account.id, p_token_hash, t, t, t + make_interval(hours => g.staff_session_absolute_hours));
  UPDATE trucker.staff_sign_in_ticket k SET used_at = t, session_id = p_session WHERE k.id = ticket.id;
  SELECT count(*)::integer INTO left_over FROM trucker.staff_recovery_code r
  WHERE r.staff_id = account.id AND r.used_at IS NULL;
  PERFORM trucker.staff_audit(t, account.id, 'staff.sign_in', 'done', account.id, p_request_id,
                              jsonb_build_object('method', checked.method, 'recovery_codes_left', left_over));
  status := 'ok';
  staff_id := account.id;
END
$$;

-- ---------------------------------------------------------------------------------------------
-- The session check made on every staff request.
--   status: ok | unknown | expired
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION trucker.staff_session_check(
  p_token_hash text, p_request_id text,
  OUT status text, OUT staff_id uuid, OUT session_id uuid, OUT privileges text[]
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
DECLARE
  s trucker.staff_session;
  t timestamptz;
  state text;
BEGIN
  status := 'unknown';
  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN
    RETURN;
  END IF;
  SELECT * INTO s FROM trucker.staff_session x WHERE x.token_hash = p_token_hash FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  t := trucker.clock_now();
  state := trucker.staff_session_state(s, t);
  IF state = 'revoked' THEN
    RETURN;
  END IF;
  IF state <> 'live' THEN
    UPDATE trucker.staff_session x SET revoked_at = t, revoked_reason = state WHERE x.id = s.id;
    PERFORM trucker.staff_audit(t, s.staff_id, 'staff.session_ended', 'done', s.staff_id, p_request_id,
                                jsonb_build_object('reason', state));
    status := 'expired';
    RETURN;
  END IF;
  IF t - s.last_used_at >= interval '1 minute' THEN
    UPDATE trucker.staff_session x SET last_used_at = t WHERE x.id = s.id;
  END IF;
  status := 'ok';
  staff_id := s.staff_id;
  session_id := s.id;
  privileges := trucker.staff_privileges(s.staff_id);
END
$$;

CREATE TYPE trucker.staff_view AS (
  staff_id uuid,
  email text,
  display_name text,
  status text,
  privileges text[],
  participant_link text,
  participant_phone text,
  enrolled_at timestamptz,
  created_at timestamptz,
  recovery_codes_left integer,
  link_open boolean
);

CREATE FUNCTION trucker.staff_view_of(p_staff uuid) RETURNS SETOF trucker.staff_view
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
  SELECT a.id, a.email, a.display_name, a.status, trucker.staff_privileges(a.id),
         a.participant_link, a.participant_phone, a.enrolled_at, a.created_at,
         (SELECT count(*)::integer FROM trucker.staff_recovery_code r
           WHERE r.staff_id = a.id AND r.used_at IS NULL),
         EXISTS (SELECT 1 FROM trucker.staff_enrolment e
                 WHERE e.staff_id = a.id AND e.ended_at IS NULL AND e.expires_at > trucker.clock_now())
  FROM trucker.staff_account a WHERE a.id = p_staff
$$;

-- The caller's own account and session.
CREATE FUNCTION trucker.staff_me(p_token_hash text)
RETURNS TABLE (account trucker.staff_view, session_created_at timestamptz, session_expires_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
  SELECT v, s.created_at,
         least(s.last_used_at + make_interval(mins => g.staff_session_idle_minutes),
               s.absolute_expires_at,
               s.created_at + make_interval(hours => g.staff_session_absolute_hours))
  FROM trucker.staff_live_session(p_token_hash) l
  JOIN trucker.staff_session s ON s.id = l.session_id
  CROSS JOIN LATERAL trucker.staff_view_of(l.staff_id) v
  CROSS JOIN trucker.security_setting g
$$;

-- Ends the caller's own session. status: signed_out | unauthorized
CREATE FUNCTION trucker.staff_sign_out(p_token_hash text, p_request_id text) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
DECLARE
  own trucker.staff_session;
  t timestamptz;
BEGIN
  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN
    RETURN 'unauthorized';
  END IF;
  SELECT * INTO own FROM trucker.staff_session s WHERE s.token_hash = p_token_hash FOR UPDATE;
  IF NOT FOUND THEN
    RETURN 'unauthorized';
  END IF;
  t := trucker.clock_now();
  IF own.revoked_at IS NOT NULL THEN
    -- Already ended, by this request sent twice or otherwise: nothing more to do.
    RETURN CASE WHEN own.revoked_reason = 'signed_out' THEN 'signed_out' ELSE 'unauthorized' END;
  END IF;
  UPDATE trucker.staff_session s SET revoked_at = t, revoked_reason = 'signed_out' WHERE s.id = own.id;
  PERFORM trucker.staff_audit(t, own.staff_id, 'staff.sign_out', 'done', own.staff_id, p_request_id, '{}'::jsonb);
  RETURN 'signed_out';
END
$$;

-- Asks whether the caller holds a privilege, and records a refusal. For reads, which change
-- nothing themselves. status: ok | unauthorized | forbidden
CREATE FUNCTION trucker.staff_require(p_token_hash text, p_privilege text, p_action text, p_request_id text)
RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
DECLARE
  entered record;
BEGIN
  IF p_privilege IS NULL OR p_privilege NOT IN ('staff_admin', 'reviewer')
     OR p_action IS NULL OR p_action !~ '^staff\.[a-z_]+(\.[a-z_]+)?$' THEN
    RETURN 'unauthorized';
  END IF;
  SELECT * INTO entered FROM trucker.staff_enter(p_token_hash, p_privilege, p_action, NULL, p_request_id);
  RETURN entered.status;
END
$$;

-- ---------------------------------------------------------------------------------------------
-- Administration. Every function here needs staff_admin, checks it itself and records what it
-- did or refused. None lets a person act on their own account.
-- ---------------------------------------------------------------------------------------------

-- Every staff account. Nothing for a caller who is not an administrator.
CREATE FUNCTION trucker.staff_list(p_token_hash text) RETURNS SETOF trucker.staff_view
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
  SELECT v.*
  FROM trucker.staff_live_session(p_token_hash) l
  JOIN trucker.staff_account a ON 'staff_admin' = ANY (trucker.staff_privileges(l.staff_id))
  CROSS JOIN LATERAL trucker.staff_view_of(a.id) v
  ORDER BY a.created_at, a.id
$$;

-- Creates an account in the state "invited" and opens its enrolment link. Sending the same
-- request again with the same key creates nothing more and replaces the link.
--   status: created | repeated | unauthorized | forbidden | invalid | email_taken
CREATE FUNCTION trucker.staff_create(
  p_token_hash text, p_key text, p_email text, p_display_name text, p_link text, p_phone text,
  p_enrol_hash text, p_request_id text,
  OUT status text, OUT staff_id uuid, OUT link_expires_at timestamptz
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
DECLARE
  entered record;
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_name text := btrim(coalesce(p_display_name, ''));
  v_phone text := nullif(btrim(coalesce(p_phone, '')), '');
  existing trucker.staff_account;
BEGIN
  SELECT * INTO entered FROM trucker.staff_enter(p_token_hash, 'staff_admin', 'staff.create', NULL, p_request_id);
  status := entered.status;
  IF status <> 'ok' THEN
    RETURN;
  END IF;
  IF p_key IS NULL OR p_key !~ '^[A-Za-z0-9._-]{16,128}$'
     OR p_enrol_hash IS NULL OR p_enrol_hash !~ '^[0-9a-f]{64}$'
     OR v_email !~ '^[^@[:space:]]+@[^@[:space:]]+$' OR length(v_email) > 254
     OR length(v_name) NOT BETWEEN 1 AND 120
     OR p_link IS NULL OR p_link NOT IN ('declared_none', 'declared')
     OR (p_link = 'declared') <> (v_phone IS NOT NULL)
     OR (v_phone IS NOT NULL AND v_phone !~ '^\+[1-9][0-9]{6,14}$') THEN
    status := 'invalid';
    RETURN;
  END IF;
  -- One creation at a time, so that two requests for one v_email cannot both pass the check.
  PERFORM pg_advisory_xact_lock(hashtextextended('trucker.staff_create:' || v_email, 0));
  SELECT * INTO existing FROM trucker.staff_account a WHERE a.email = v_email FOR UPDATE;
  IF FOUND THEN
    IF existing.creation_key = p_key AND existing.created_by = entered.staff_id
       AND existing.status = 'invited' THEN
      staff_id := existing.id;
      link_expires_at := trucker.staff_open_enrolment(existing.id, p_enrol_hash, entered.at);
      status := 'repeated';
      RETURN;
    END IF;
    status := 'email_taken';
    RETURN;
  END IF;
  INSERT INTO trucker.staff_account
    (email, display_name, status, participant_link, participant_phone, created_by, creation_key,
     created_at, updated_at)
  VALUES (v_email, v_name, 'invited', p_link, v_phone, entered.staff_id, p_key, entered.at, entered.at)
  RETURNING id INTO staff_id;
  link_expires_at := trucker.staff_open_enrolment(staff_id, p_enrol_hash, entered.at);
  PERFORM trucker.staff_audit(entered.at, entered.staff_id, 'staff.create', 'done', staff_id, p_request_id,
                              jsonb_build_object('email', v_email, 'display_name', v_name,
                                                 'participant_link', p_link));
  status := 'created';
END
$$;

-- Opens a new enrolment link for another person's account, for a lost password or
-- authenticator. The account's present credentials keep working until the link is used.
--   status: issued | unauthorized | forbidden | not_found | self | disabled
CREATE FUNCTION trucker.staff_issue_enrolment(
  p_token_hash text, p_staff uuid, p_enrol_hash text, p_request_id text,
  OUT status text, OUT link_expires_at timestamptz
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
DECLARE
  entered record;
  subject trucker.staff_account;
BEGIN
  SELECT * INTO entered
  FROM trucker.staff_enter(p_token_hash, 'staff_admin', 'staff.enrolment_issue', p_staff, p_request_id);
  status := entered.status;
  IF status <> 'ok' THEN
    RETURN;
  END IF;
  SELECT * INTO subject FROM trucker.staff_account a WHERE a.id = p_staff;
  IF NOT FOUND OR p_enrol_hash IS NULL OR p_enrol_hash !~ '^[0-9a-f]{64}$' THEN
    status := 'not_found';
    RETURN;
  END IF;
  IF subject.id = entered.staff_id THEN
    PERFORM trucker.staff_audit(entered.at, entered.staff_id, 'staff.enrolment_issue', 'refused', p_staff,
                                p_request_id, jsonb_build_object('reason', 'self'));
    status := 'self';
    RETURN;
  END IF;
  IF subject.status = 'disabled' THEN
    status := 'disabled';
    RETURN;
  END IF;
  link_expires_at := trucker.staff_open_enrolment(p_staff, p_enrol_hash, entered.at);
  PERFORM trucker.staff_audit(entered.at, entered.staff_id, 'staff.enrolment_issue', 'done', p_staff,
                              p_request_id, '{}'::jsonb);
  status := 'issued';
END
$$;

-- Disables or re-enables another person's account. Disabling ends their sessions and their
-- open enrolment link. Asking for the state an account already has changes and records nothing.
--   status: changed | unchanged | unauthorized | forbidden | not_found | self | invalid
CREATE FUNCTION trucker.staff_set_status(p_token_hash text, p_staff uuid, p_status text, p_request_id text)
RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
DECLARE
  entered record;
  subject trucker.staff_account;
  target text;
BEGIN
  SELECT * INTO entered
  FROM trucker.staff_enter(p_token_hash, 'staff_admin', 'staff.status', p_staff, p_request_id);
  IF entered.status <> 'ok' THEN
    RETURN entered.status;
  END IF;
  IF p_status IS NULL OR p_status NOT IN ('enabled', 'disabled') THEN
    RETURN 'invalid';
  END IF;
  SELECT * INTO subject FROM trucker.staff_account a WHERE a.id = p_staff;
  IF NOT FOUND THEN
    RETURN 'not_found';
  END IF;
  IF subject.id = entered.staff_id THEN
    PERFORM trucker.staff_audit(entered.at, entered.staff_id, 'staff.status', 'refused', p_staff,
                                p_request_id, jsonb_build_object('reason', 'self'));
    RETURN 'self';
  END IF;
  target := CASE
    WHEN p_status = 'disabled' THEN 'disabled'
    WHEN subject.enrolled_at IS NOT NULL AND subject.password_hash IS NOT NULL
         AND subject.totp_secret IS NOT NULL THEN 'active'
    ELSE 'invited'
  END;
  IF (p_status = 'disabled') = (subject.status = 'disabled') THEN
    RETURN 'unchanged';
  END IF;
  UPDATE trucker.staff_account a SET status = target, updated_at = entered.at WHERE a.id = p_staff;
  IF target = 'disabled' THEN
    PERFORM trucker.staff_end_sessions(p_staff, 'account_closed', entered.at);
    UPDATE trucker.staff_enrolment e SET ended_at = entered.at, ended_reason = 'superseded'
    WHERE e.staff_id = p_staff AND e.ended_at IS NULL;
  END IF;
  PERFORM trucker.staff_audit(entered.at, entered.staff_id, 'staff.status', 'done', p_staff, p_request_id,
                              jsonb_build_object('before', subject.status, 'after', target));
  RETURN 'changed';
END
$$;

-- Grants a privilege to another person, or removes it (S-3). Never to or from oneself.
--   status: changed | unchanged | unauthorized | forbidden | not_found | self | invalid
CREATE FUNCTION trucker.staff_set_privilege(
  p_token_hash text, p_staff uuid, p_privilege text, p_granted boolean, p_request_id text
) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
DECLARE
  entered record;
  held boolean;
  action text := CASE WHEN p_granted THEN 'staff.privilege.grant' ELSE 'staff.privilege.remove' END;
BEGIN
  IF p_granted IS NULL THEN
    RETURN 'invalid';
  END IF;
  SELECT * INTO entered FROM trucker.staff_enter(p_token_hash, 'staff_admin', action, p_staff, p_request_id);
  IF entered.status <> 'ok' THEN
    RETURN entered.status;
  END IF;
  IF p_privilege IS NULL OR p_privilege NOT IN ('staff_admin', 'reviewer') THEN
    RETURN 'invalid';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM trucker.staff_account a WHERE a.id = p_staff) THEN
    RETURN 'not_found';
  END IF;
  IF p_staff = entered.staff_id THEN
    PERFORM trucker.staff_audit(entered.at, entered.staff_id, action, 'refused', p_staff, p_request_id,
                                jsonb_build_object('reason', 'self', 'privilege', p_privilege));
    RETURN 'self';
  END IF;
  held := p_privilege = ANY (trucker.staff_privileges(p_staff));
  IF held = p_granted THEN
    RETURN 'unchanged';
  END IF;
  IF p_granted THEN
    INSERT INTO trucker.staff_privilege (staff_id, privilege, granted_by, granted_at)
    VALUES (p_staff, p_privilege, entered.staff_id, entered.at);
  ELSE
    DELETE FROM trucker.staff_privilege p WHERE p.staff_id = p_staff AND p.privilege = p_privilege;
  END IF;
  PERFORM trucker.staff_audit(entered.at, entered.staff_id, action, 'done', p_staff, p_request_id,
                              jsonb_build_object('privilege', p_privilege));
  RETURN 'changed';
END
$$;

-- Records the declaration of whether another person also has a participant account (S-4).
--   status: changed | unchanged | unauthorized | forbidden | not_found | self | invalid
CREATE FUNCTION trucker.staff_set_participant_link(
  p_token_hash text, p_staff uuid, p_link text, p_phone text, p_request_id text
) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
DECLARE
  entered record;
  subject trucker.staff_account;
  v_phone text := nullif(btrim(coalesce(p_phone, '')), '');
BEGIN
  SELECT * INTO entered
  FROM trucker.staff_enter(p_token_hash, 'staff_admin', 'staff.participant_link', p_staff, p_request_id);
  IF entered.status <> 'ok' THEN
    RETURN entered.status;
  END IF;
  IF p_link IS NULL OR p_link NOT IN ('declared_none', 'declared')
     OR (p_link = 'declared') <> (v_phone IS NOT NULL)
     OR (v_phone IS NOT NULL AND v_phone !~ '^\+[1-9][0-9]{6,14}$') THEN
    RETURN 'invalid';
  END IF;
  SELECT * INTO subject FROM trucker.staff_account a WHERE a.id = p_staff;
  IF NOT FOUND THEN
    RETURN 'not_found';
  END IF;
  IF subject.id = entered.staff_id THEN
    PERFORM trucker.staff_audit(entered.at, entered.staff_id, 'staff.participant_link', 'refused', p_staff,
                                p_request_id, jsonb_build_object('reason', 'self'));
    RETURN 'self';
  END IF;
  IF subject.participant_link = p_link AND subject.participant_phone IS NOT DISTINCT FROM v_phone THEN
    RETURN 'unchanged';
  END IF;
  UPDATE trucker.staff_account a
  SET participant_link = p_link, participant_phone = v_phone, updated_at = entered.at WHERE a.id = p_staff;
  PERFORM trucker.staff_audit(entered.at, entered.staff_id, 'staff.participant_link', 'done', p_staff,
                              p_request_id,
                              jsonb_build_object('before', subject.participant_link, 'after', p_link,
                                                 'phone_changed', subject.participant_phone IS DISTINCT FROM v_phone));
  RETURN 'changed';
END
$$;

-- The staff audit list, newest first, fifty at a time. `p_after` is the id of the last entry
-- already read. Nothing for a caller who is not an administrator.
CREATE FUNCTION trucker.staff_audit_list(p_token_hash text, p_after text)
RETURNS TABLE (
  id bigint, occurred_at timestamptz, actor_staff_id uuid, actor_email text, action text,
  outcome text, subject_staff_id uuid, subject_email text, request_id text, detail jsonb, more boolean
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
  SELECT q.id, q.occurred_at, q.actor_staff_id, actor.email, q.action, q.outcome,
         q.subject_staff_id, subject.email, q.request_id, q.detail, q.found > 50
  FROM (
    SELECT e.*, count(*) OVER () AS found
    FROM trucker.staff_live_session(p_token_hash) l
    JOIN trucker.staff_audit_entry e ON 'staff_admin' = ANY (trucker.staff_privileges(l.staff_id))
    WHERE p_after IS NULL OR (p_after ~ '^[0-9]{1,18}$' AND e.id < p_after::bigint)
    ORDER BY e.id DESC
    LIMIT 51) q
  LEFT JOIN trucker.staff_account actor ON actor.id = q.actor_staff_id
  LEFT JOIN trucker.staff_account subject ON subject.id = q.subject_staff_id
  ORDER BY q.id DESC
  LIMIT 50
$$;

-- ---------------------------------------------------------------------------------------------
-- Who may run what, and who may read what: nothing, except these functions.
-- ---------------------------------------------------------------------------------------------
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA trucker FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  trucker.staff_enrol_state(text),
  trucker.staff_enrol_begin(text, text, text, text),
  trucker.staff_enrol_complete(text, text, text, text),
  trucker.staff_sign_in_password(text, text, text, text, text),
  trucker.staff_sign_in_verify(text, text, text, uuid, text, text),
  trucker.staff_session_check(text, text),
  trucker.staff_me(text),
  trucker.staff_sign_out(text, text),
  trucker.staff_require(text, text, text, text),
  trucker.staff_list(text),
  trucker.staff_create(text, text, text, text, text, text, text, text),
  trucker.staff_issue_enrolment(text, uuid, text, text),
  trucker.staff_set_status(text, uuid, text, text),
  trucker.staff_set_privilege(text, uuid, text, boolean, text),
  trucker.staff_set_participant_link(text, uuid, text, text, text),
  trucker.staff_audit_list(text, text)
TO trucker_app;

REVOKE ALL ON trucker.staff_account, trucker.staff_privilege, trucker.staff_enrolment,
  trucker.staff_recovery_code, trucker.staff_sign_in_ticket, trucker.staff_session,
  trucker.staff_audit_entry FROM trucker_app, PUBLIC;
ALTER TABLE trucker.staff_account ENABLE ROW LEVEL SECURITY;
ALTER TABLE trucker.staff_privilege ENABLE ROW LEVEL SECURITY;
ALTER TABLE trucker.staff_enrolment ENABLE ROW LEVEL SECURITY;
ALTER TABLE trucker.staff_recovery_code ENABLE ROW LEVEL SECURITY;
ALTER TABLE trucker.staff_sign_in_ticket ENABLE ROW LEVEL SECURITY;
ALTER TABLE trucker.staff_session ENABLE ROW LEVEL SECURITY;
ALTER TABLE trucker.staff_audit_entry ENABLE ROW LEVEL SECURITY;
