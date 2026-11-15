-- 0015: completing a staff enrolment with a value that is not an authenticator code.
--
-- A defect in 0006, found when the tests of slice 15 ran. The function kept the result of the
-- code check in an untyped record and, for a value that is not shaped like a code, left that
-- record unassigned and then asked "is it null, or not accepted?". PostgreSQL has to know the
-- structure of a record to plan that question, so it failed with "record is not assigned yet"
-- whenever the question was planned while the record was unassigned: on the first call of a
-- database session, or after the session's cached plans were reset. The caller got an
-- unexpected error instead of "wrong code", and the failed attempt was not counted. A session
-- that had already checked a well-shaped code did not show it, which is why it went unseen.
--
-- The function is the same as in 0006 except that the outcome of the check is kept in two
-- typed variables. Nothing else about enrolment changes.

-- Step two. status: ok | invalid_link | not_started | wrong_code
CREATE OR REPLACE FUNCTION trucker.staff_enrol_complete(
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
  v_accepted boolean := false;
  v_step bigint;
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
  IF coalesce(p_code, '') ~ '^[[:space:]]*[0-9]{3}[[:space:]]?[0-9]{3}[[:space:]]*$' THEN
    SELECT c.accepted, c.step INTO v_accepted, v_step
    FROM trucker.staff_check_code(account.id, link.pending_totp_secret, NULL, p_code, p_pepper, t) AS c;
  END IF;
  IF NOT coalesce(v_accepted, false) THEN
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
      totp_last_step = v_step, status = 'active', enrolled_at = coalesce(a.enrolled_at, t),
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

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA trucker FROM PUBLIC;
