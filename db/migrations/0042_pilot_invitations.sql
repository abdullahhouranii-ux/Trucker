-- Pilot invitations (DB-17): only people Trucker invites can register while the pilot is by
-- invitation.
--
-- A staff administrator invites a named contact of an organisation by their mobile number.
-- Nothing is sent: there is no message supplier yet, so staff tell the contact themselves. The
-- contact then signs in with that number as anyone does, and registration takes the invitation.
-- An invitation expires after a set number of days, can be cancelled by staff, is taken once, and
-- every step is recorded in the staff audit list or the identity events.
--
-- While `pilot_invitation_required` is 1, registration needs a pending, unexpired invitation for
-- the person's number, or a pending driver invitation from a carrier (a driver is invited by an
-- organisation that is itself in the pilot). Development defaults, not approved for production:
-- the requirement is off (0) so local work and the existing tests are unchanged, and an invitation
-- lasts 14 days. Before production the requirement must be set to 1.

ALTER TABLE trucker.security_setting
  ADD COLUMN pilot_invitation_required integer NOT NULL DEFAULT 0
    CHECK (pilot_invitation_required IN (0, 1)),
  ADD COLUMN pilot_invitation_days integer NOT NULL DEFAULT 14
    CHECK (pilot_invitation_days BETWEEN 1 AND 90);

CREATE TABLE trucker.pilot_invitation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_e164 text NOT NULL CHECK (phone_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  organisation_name text NOT NULL CHECK (length(btrim(organisation_name)) BETWEEN 1 AND 200),
  contact_name text NOT NULL CHECK (length(btrim(contact_name)) BETWEEN 1 AND 200),
  -- 'expired' is stored only when a new invitation replaces an expired one; until then an
  -- expired invitation is still 'pending' and is read as expired from expires_at.
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'cancelled', 'expired')),
  row_version integer NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  invited_by uuid NOT NULL REFERENCES trucker.staff_account (id),
  invited_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  accepted_by uuid REFERENCES trucker.person (id),
  accepted_at timestamptz,
  ended_by uuid REFERENCES trucker.staff_account (id),
  ended_at timestamptz,
  CONSTRAINT pilot_invitation_expiry CHECK (expires_at > invited_at),
  CONSTRAINT pilot_invitation_accepted CHECK (
    (status = 'accepted') = (accepted_by IS NOT NULL AND accepted_at IS NOT NULL)),
  CONSTRAINT pilot_invitation_cancelled CHECK (
    (status = 'cancelled') = (ended_by IS NOT NULL) AND (status IN ('cancelled', 'expired')) = (ended_at IS NOT NULL))
);
-- At most one pending invitation for a number.
CREATE UNIQUE INDEX pilot_invitation_pending ON trucker.pilot_invitation (phone_e164) WHERE status = 'pending';
CREATE INDEX pilot_invitation_list ON trucker.pilot_invitation (invited_at DESC, id);
ALTER TABLE trucker.pilot_invitation ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON trucker.pilot_invitation FROM PUBLIC, trucker_app;

-- Only the functions below change an invitation, and only in these ways.
CREATE FUNCTION trucker.guard_pilot_invitation() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, trucker, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a pilot invitation is never removed' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status <> 'pending'
     OR NEW.id <> OLD.id OR NEW.phone_e164 <> OLD.phone_e164
     OR NEW.organisation_name <> OLD.organisation_name OR NEW.contact_name <> OLD.contact_name
     OR NEW.invited_by <> OLD.invited_by OR NEW.invited_at <> OLD.invited_at
     OR NEW.expires_at <> OLD.expires_at OR NEW.row_version <> OLD.row_version + 1 THEN
    RAISE EXCEPTION 'a pilot invitation only moves once, from pending' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER pilot_invitation_guard BEFORE UPDATE OR DELETE ON trucker.pilot_invitation
  FOR EACH ROW EXECUTE FUNCTION trucker.guard_pilot_invitation();

ALTER TABLE trucker.identity_event DROP CONSTRAINT identity_event_kind_check;
ALTER TABLE trucker.identity_event ADD CONSTRAINT identity_event_kind_check CHECK (kind IN (
  'signed_in', 'code_locked', 'registration_completed', 'signed_out', 'session_revoked', 'session_expired',
  'registration_refused_not_invited', 'pilot_invitation_accepted'
));

-- How staff see an invitation at a moment: its stored status, with a pending one past its expiry
-- read as expired.
CREATE FUNCTION trucker.pilot_invitation_values(p_invitation trucker.pilot_invitation, p_at timestamptz)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
  SELECT jsonb_build_object(
    'id', p_invitation.id,
    'version', p_invitation.row_version,
    'phone', p_invitation.phone_e164,
    'organisationName', p_invitation.organisation_name,
    'contactName', p_invitation.contact_name,
    'status', CASE WHEN p_invitation.status = 'pending' AND p_invitation.expires_at <= p_at
                   THEN 'expired' ELSE p_invitation.status END,
    'invitedAt', p_invitation.invited_at,
    'invitedBy', (SELECT jsonb_build_object('id', a.id, 'displayName', a.display_name)
                  FROM trucker.staff_account a WHERE a.id = p_invitation.invited_by),
    'expiresAt', p_invitation.expires_at,
    'acceptedAt', p_invitation.accepted_at,
    'endedAt', p_invitation.ended_at,
    'endedBy', (SELECT jsonb_build_object('id', a.id, 'displayName', a.display_name)
                FROM trucker.staff_account a WHERE a.id = p_invitation.ended_by))
$$;

-- Every invitation, newest first, and whether registration needs one. staff_admin only.
--   status: ok | unauthorized | forbidden
CREATE FUNCTION trucker.staff_pilot_invitations(p_token_hash text, p_request_id text, OUT status text, OUT detail jsonb)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
DECLARE
  entered record;
BEGIN
  SELECT * INTO entered
  FROM trucker.staff_enter(p_token_hash, 'staff_admin', 'staff.pilot_invitations', NULL, p_request_id);
  status := entered.status;
  IF status <> 'ok' THEN
    RETURN;
  END IF;
  SELECT jsonb_build_object(
    'required', g.pilot_invitation_required = 1,
    'validDays', g.pilot_invitation_days,
    'invitations', coalesce((
      SELECT jsonb_agg(trucker.pilot_invitation_values(i, entered.at) ORDER BY i.invited_at DESC, i.id)
      FROM (SELECT * FROM trucker.pilot_invitation ORDER BY invited_at DESC, id LIMIT 500) i), '[]'::jsonb))
  INTO detail
  FROM trucker.security_setting g;
END
$$;

-- Invites a named contact of an organisation by mobile number. staff_admin only.
--   content: { phone, organisationName, contactName }
--   status: invited | repeated | exists | registered | invalid | unauthorized | forbidden
-- repeated: the same pending invitation was already made (a retry); nothing more is made.
-- exists:   another pending invitation for this number is open; cancel it first.
-- registered: someone has already registered with this number.
CREATE FUNCTION trucker.staff_pilot_invite(p_token_hash text, p_content jsonb, p_request_id text, OUT status text, OUT detail jsonb)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
DECLARE
  entered record;
  v_phone text;
  v_org text;
  v_contact text;
  problems jsonb := '[]'::jsonb;
  open_one trucker.pilot_invitation;
  made trucker.pilot_invitation;
  v_days integer;
BEGIN
  SELECT * INTO entered
  FROM trucker.staff_enter(p_token_hash, 'staff_admin', 'staff.pilot_invite', NULL, p_request_id);
  status := entered.status;
  IF status <> 'ok' THEN
    RETURN;
  END IF;
  IF p_content IS NULL OR jsonb_typeof(p_content) <> 'object' THEN
    p_content := '{}'::jsonb;
  END IF;
  v_phone := CASE WHEN jsonb_typeof(p_content->'phone') = 'string' THEN btrim(p_content->>'phone') END;
  v_org := CASE WHEN jsonb_typeof(p_content->'organisationName') = 'string' THEN btrim(p_content->>'organisationName') END;
  v_contact := CASE WHEN jsonb_typeof(p_content->'contactName') = 'string' THEN btrim(p_content->>'contactName') END;
  IF v_phone IS NULL OR v_phone !~ '^\+[1-9][0-9]{6,14}$' THEN
    problems := problems || jsonb_build_object('field', 'phone', 'code', 'invalid');
  END IF;
  IF v_org IS NULL OR length(v_org) NOT BETWEEN 1 AND 200 THEN
    problems := problems || jsonb_build_object('field', 'organisationName', 'code', 'invalid');
  END IF;
  IF v_contact IS NULL OR length(v_contact) NOT BETWEEN 1 AND 200 THEN
    problems := problems || jsonb_build_object('field', 'contactName', 'code', 'invalid');
  END IF;
  IF jsonb_array_length(problems) > 0 THEN
    status := 'invalid';
    detail := problems;
    RETURN;
  END IF;
  -- Two administrators inviting the same number wait for each other here.
  PERFORM pg_advisory_xact_lock(hashtextextended('pilot_invitation:' || v_phone, 0));
  IF EXISTS (SELECT 1 FROM trucker.person p
             WHERE p.phone_e164 = v_phone AND p.registration_completed_at IS NOT NULL) THEN
    status := 'registered';
    PERFORM trucker.staff_audit(entered.at, entered.staff_id, 'staff.pilot_invite', 'refused', NULL, p_request_id,
                                jsonb_build_object('reason', 'already_registered'));
    RETURN;
  END IF;
  SELECT * INTO open_one FROM trucker.pilot_invitation i
  WHERE i.phone_e164 = v_phone AND i.status = 'pending' FOR UPDATE;
  IF FOUND AND open_one.expires_at <= entered.at THEN
    -- The open one has expired: it is closed as expired, at its expiry, so a new one can be made.
    UPDATE trucker.pilot_invitation i
    SET status = 'expired', ended_at = open_one.expires_at, row_version = i.row_version + 1
    WHERE i.id = open_one.id;
  ELSIF FOUND THEN
    detail := trucker.pilot_invitation_values(open_one, entered.at);
    IF open_one.organisation_name = v_org AND open_one.contact_name = v_contact THEN
      status := 'repeated';
    ELSE
      status := 'exists';
    END IF;
    RETURN;
  END IF;
  SELECT g.pilot_invitation_days INTO v_days FROM trucker.security_setting g;
  INSERT INTO trucker.pilot_invitation
    (phone_e164, organisation_name, contact_name, invited_by, invited_at, expires_at)
  VALUES (v_phone, v_org, v_contact, entered.staff_id, entered.at, entered.at + make_interval(days => v_days))
  RETURNING * INTO made;
  -- The audit entry names the invitation, not the number or the names.
  PERFORM trucker.staff_audit(entered.at, entered.staff_id, 'staff.pilot_invite', 'done', NULL, p_request_id,
                              jsonb_build_object('invitation', made.id, 'expiresAt', made.expires_at));
  status := 'invited';
  detail := trucker.pilot_invitation_values(made, entered.at);
END
$$;

-- Cancels a pending invitation. staff_admin only.
--   status: cancelled | repeated | not_open | conflict | not_found | unauthorized | forbidden
CREATE FUNCTION trucker.staff_pilot_cancel(
  p_token_hash text, p_invitation uuid, p_expected_version integer, p_request_id text,
  OUT status text, OUT detail jsonb
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
DECLARE
  entered record;
  found_one trucker.pilot_invitation;
BEGIN
  SELECT * INTO entered
  FROM trucker.staff_enter(p_token_hash, 'staff_admin', 'staff.pilot_invitation_cancel', NULL, p_request_id);
  status := entered.status;
  IF status <> 'ok' THEN
    RETURN;
  END IF;
  SELECT * INTO found_one FROM trucker.pilot_invitation i WHERE i.id = p_invitation;
  IF NOT FOUND THEN
    status := 'not_found';
    RETURN;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('pilot_invitation:' || found_one.phone_e164, 0));
  SELECT * INTO found_one FROM trucker.pilot_invitation i WHERE i.id = p_invitation FOR UPDATE;
  detail := trucker.pilot_invitation_values(found_one, entered.at);
  IF found_one.status = 'cancelled' AND found_one.row_version = coalesce(p_expected_version, 0) + 1 THEN
    status := 'repeated';
    RETURN;
  END IF;
  IF found_one.status <> 'pending' OR found_one.expires_at <= entered.at THEN
    status := 'not_open';
    RETURN;
  END IF;
  IF p_expected_version IS NULL OR found_one.row_version <> p_expected_version THEN
    status := 'conflict';
    RETURN;
  END IF;
  UPDATE trucker.pilot_invitation i
  SET status = 'cancelled', ended_by = entered.staff_id, ended_at = entered.at, row_version = i.row_version + 1
  WHERE i.id = found_one.id
  RETURNING * INTO found_one;
  PERFORM trucker.staff_audit(entered.at, entered.staff_id, 'staff.pilot_invitation_cancel', 'done', NULL, p_request_id,
                              jsonb_build_object('invitation', found_one.id));
  status := 'cancelled';
  detail := trucker.pilot_invitation_values(found_one, entered.at);
END
$$;

-- Registration, as in 0004, with the invitation rule added. A new status, 'not_invited', refuses
-- a person who needs an invitation and has none; the refusal is recorded. When an invitation is
-- taken, it is marked accepted in the same transaction as the registration.
CREATE OR REPLACE FUNCTION trucker.complete_registration(
  p_token_hash text, p_display_name text, p_contact_email text,
  p_terms_version text, p_terms_language text, p_request_id text
) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
DECLARE
  own trucker.session;
  kind text;
  t timestamptz;
  completed timestamptz;
  v_phone text;
  v_required boolean;
  taken trucker.pilot_invitation;
BEGIN
  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN
    RETURN 'unauthorized';
  END IF;
  SELECT * INTO own FROM trucker.session s WHERE s.token_hash = p_token_hash FOR UPDATE;
  IF NOT FOUND THEN
    RETURN 'unauthorized';
  END IF;
  SELECT p.registration_completed_at, p.phone_e164 INTO completed, v_phone
  FROM trucker.person p WHERE p.id = own.person_id FOR UPDATE;
  t := trucker.clock_now();
  IF trucker.session_state(own, t) <> 'live' THEN
    RETURN 'unauthorized';
  END IF;
  SELECT e.kind INTO kind FROM trucker.environment e;
  IF kind IS NULL OR kind NOT IN ('local-development', 'test') THEN
    RETURN 'closed';
  END IF;
  IF completed IS NOT NULL THEN
    RETURN 'already';
  END IF;
  -- The same lock the staff functions take for this number: an invitation cannot be cancelled
  -- or replaced while it is being taken.
  PERFORM pg_advisory_xact_lock(hashtextextended('pilot_invitation:' || v_phone, 0));
  SELECT * INTO taken FROM trucker.pilot_invitation i
  WHERE i.phone_e164 = v_phone AND i.status = 'pending' AND i.expires_at > t FOR UPDATE;
  SELECT g.pilot_invitation_required = 1 INTO v_required FROM trucker.security_setting g;
  IF v_required AND taken.id IS NULL
     AND NOT EXISTS (SELECT 1 FROM trucker.driver_affiliation a
                     WHERE a.invited_phone = v_phone AND a.status = 'invited') THEN
    PERFORM trucker.record_identity_event('registration_refused_not_invited', own.person_id, own.id, p_request_id, t);
    RETURN 'not_invited';
  END IF;
  INSERT INTO trucker.terms_acceptance (person_id, terms_kind, version, language, accepted_at)
  VALUES (own.person_id, 'demonstration', p_terms_version, p_terms_language, t)
  ON CONFLICT ON CONSTRAINT terms_acceptance_once DO NOTHING;
  UPDATE trucker.person p
  SET display_name = p_display_name, contact_email = p_contact_email, registration_completed_at = t
  WHERE p.id = own.person_id;
  IF taken.id IS NOT NULL THEN
    UPDATE trucker.pilot_invitation i
    SET status = 'accepted', accepted_by = own.person_id, accepted_at = t, row_version = i.row_version + 1
    WHERE i.id = taken.id;
    PERFORM trucker.record_identity_event('pilot_invitation_accepted', own.person_id, own.id, p_request_id, t);
  END IF;
  PERFORM trucker.record_identity_event('registration_completed', own.person_id, own.id, p_request_id, t);
  RETURN 'completed';
END
$$;

REVOKE ALL ON FUNCTION trucker.guard_pilot_invitation() FROM PUBLIC;
REVOKE ALL ON FUNCTION trucker.pilot_invitation_values(trucker.pilot_invitation, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION trucker.staff_pilot_invitations(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION trucker.staff_pilot_invite(text, jsonb, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION trucker.staff_pilot_cancel(text, uuid, integer, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  trucker.staff_pilot_invitations(text, text),
  trucker.staff_pilot_invite(text, jsonb, text),
  trucker.staff_pilot_cancel(text, uuid, integer, text)
TO trucker_app;
