-- 0011: SEC-01. At least one administrator always remains.
--
-- Before this migration two administrators could each remove the other's staff_admin privilege,
-- or disable each other, at the same moment. Nothing ordered the two requests and nothing
-- checked afterwards that an administrator remained; one was left only because PostgreSQL's
-- deadlock detector aborted the other request, which answered 500.
--
-- Now:
--   1. Every change of status or privilege takes one transaction-scoped advisory lock before it
--      reads anything, so that two such changes never run at the same time and cannot deadlock
--      with each other.
--   2. The caller's session and privilege are read after that lock (staff_enter runs after it),
--      so a caller who lost staff_admin, or whose account was disabled, while waiting is refused.
--   3. After the change, in the same transaction, at least one account that is active, enrolled
--      and holds staff_admin must remain. Otherwise the change is undone, the refusal is audited
--      and the function answers 'last_administrator'.
-- Migration 0006 is merged and is not edited; the two functions are replaced with the same
-- signatures, so their grants are unchanged.

-- The advisory lock key for administration changes. A fixed number, used nowhere else.
CREATE FUNCTION trucker.staff_administration_lock() RETURNS bigint
LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
  SELECT 7311001101::bigint
$$;
REVOKE ALL ON FUNCTION trucker.staff_administration_lock() FROM PUBLIC;

-- Raises TA001 when no active, enrolled account holds staff_admin.
CREATE FUNCTION trucker.staff_administrator_remains() RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM trucker.staff_account a
    JOIN trucker.staff_privilege p ON p.staff_id = a.id AND p.privilege = 'staff_admin'
    WHERE a.status = 'active' AND a.enrolled_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'no active administrator would remain' USING ERRCODE = 'TA001';
  END IF;
END
$$;
REVOKE ALL ON FUNCTION trucker.staff_administrator_remains() FROM PUBLIC;

-- Disables or re-enables another person's account (replaces 0006).
--   status: changed | unchanged | unauthorized | forbidden | not_found | self | invalid
--           | last_administrator
CREATE OR REPLACE FUNCTION trucker.staff_set_status(p_token_hash text, p_staff uuid, p_status text, p_request_id text)
RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
DECLARE
  entered record;
  subject trucker.staff_account;
  target text;
BEGIN
  -- SEC-01: every change to who is an administrator runs alone, before anything is read.
  PERFORM pg_advisory_xact_lock(trucker.staff_administration_lock());
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
  BEGIN
    UPDATE trucker.staff_account a SET status = target, updated_at = entered.at WHERE a.id = p_staff;
    IF target = 'disabled' THEN
      PERFORM trucker.staff_end_sessions(p_staff, 'account_closed', entered.at);
      UPDATE trucker.staff_enrolment e SET ended_at = entered.at, ended_reason = 'superseded'
      WHERE e.staff_id = p_staff AND e.ended_at IS NULL;
    END IF;
    PERFORM trucker.staff_administrator_remains();
  EXCEPTION WHEN SQLSTATE 'TA001' THEN
    -- The change is undone; the refusal is recorded.
    PERFORM trucker.staff_audit(entered.at, entered.staff_id, 'staff.status', 'refused', p_staff,
                                p_request_id, jsonb_build_object('reason', 'last_administrator'));
    RETURN 'last_administrator';
  END;
  PERFORM trucker.staff_audit(entered.at, entered.staff_id, 'staff.status', 'done', p_staff, p_request_id,
                              jsonb_build_object('before', subject.status, 'after', target));
  RETURN 'changed';
END
$$;


-- Grants a privilege to another person, or removes it (replaces 0006).
--   status: changed | unchanged | unauthorized | forbidden | not_found | self | invalid
--           | last_administrator
CREATE OR REPLACE FUNCTION trucker.staff_set_privilege(
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
  -- SEC-01: every change to who is an administrator runs alone, before anything is read.
  PERFORM pg_advisory_xact_lock(trucker.staff_administration_lock());
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
    BEGIN
      DELETE FROM trucker.staff_privilege p WHERE p.staff_id = p_staff AND p.privilege = p_privilege;
      PERFORM trucker.staff_administrator_remains();
    EXCEPTION WHEN SQLSTATE 'TA001' THEN
      PERFORM trucker.staff_audit(entered.at, entered.staff_id, action, 'refused', p_staff, p_request_id,
                                  jsonb_build_object('reason', 'last_administrator', 'privilege', p_privilege));
      RETURN 'last_administrator';
    END;
  END IF;
  PERFORM trucker.staff_audit(entered.at, entered.staff_id, action, 'done', p_staff, p_request_id,
                              jsonb_build_object('privilege', p_privilege));
  RETURN 'changed';
END
$$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA trucker FROM PUBLIC;
