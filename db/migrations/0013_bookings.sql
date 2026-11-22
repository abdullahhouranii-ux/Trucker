-- 0013: acceptance and booking (slice 14).
--
-- The shipper's administrator accepts one exact version of one open quotation. In one
-- transaction: the quotation becomes accepted, every other open quotation on the shipment is
-- not selected, the shipment is awarded, and one booking is created. The booking is an immutable
-- snapshot of the quotation version, the transport price, Trucker's fee and the terms in force
-- at that moment. Later changes to any setting, register or record do not alter it.
--
-- A booking starts as "awaiting resources". Nothing here confirms it: a booking is confirmed
-- only when every required, eligible resource is assigned and reserved, which is a later slice
-- and a different check from dispatch. No resource is assigned, reserved or occupied here.
--
-- Every commercial value (fee payer, fee level, payment period, assignment deadline, reservation
-- buffers) is a protected setting holding a development default. They are not approved for
-- production: outside a database marked local-development or test, acceptance answers "closed".
-- No tax is calculated or stated; how tax is presented is undecided.
--
-- Short notice is refused, not recorded as late: if the assignment deadline calculated at the
-- moment of acceptance has already passed, no booking is created.

-- ---------------------------------------------------------------------------------------------
-- Settings: development defaults only (CC-1 to CC-6).
-- ---------------------------------------------------------------------------------------------
ALTER TABLE trucker.security_setting
  ADD COLUMN booking_fee_payer text NOT NULL DEFAULT 'shipper' CHECK (booking_fee_payer IN ('shipper', 'carrier')),
  -- Hundredths of a percent: 300 is 3%.
  ADD COLUMN booking_fee_basis_points integer NOT NULL DEFAULT 300
    CHECK (booking_fee_basis_points BETWEEN 0 AND 5000),
  ADD COLUMN booking_payment_due_days integer NOT NULL DEFAULT 15 CHECK (booking_payment_due_days BETWEEN 0 AND 365),
  -- The carrier assigns every resource within this many hours of acceptance...
  ADD COLUMN booking_assignment_hours integer NOT NULL DEFAULT 12 CHECK (booking_assignment_hours BETWEEN 1 AND 720),
  -- ...and never later than this many hours before the pick-up window opens.
  ADD COLUMN booking_assignment_lead_hours integer NOT NULL DEFAULT 6
    CHECK (booking_assignment_lead_hours BETWEEN 0 AND 720),
  ADD COLUMN reservation_positioning_minutes integer NOT NULL DEFAULT 120
    CHECK (reservation_positioning_minutes BETWEEN 0 AND 10080),
  ADD COLUMN reservation_completion_minutes integer NOT NULL DEFAULT 720
    CHECK (reservation_completion_minutes BETWEEN 0 AND 10080);

-- ---------------------------------------------------------------------------------------------
-- The terms a booking is made under: an immutable, versioned register. A booking names the
-- exact version and its content hash. The only version that can exist is a demonstration text
-- for development: it is not legal text, has not been reviewed and binds nobody. Approved terms
-- arrive as a later, reviewed migration; until then the register refuses anything else, and a
-- database holding demonstration terms cannot be marked as anything but development or test.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE trucker.booking_terms (
  code text NOT NULL CHECK (code ~ '^[a-z][a-z0-9_]{1,39}$'),
  version_no integer NOT NULL CHECK (version_no >= 1),
  demonstration boolean NOT NULL,
  body text NOT NULL CHECK (length(btrim(body)) BETWEEN 1 AND 20000),
  content_hash text NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (code, version_no),
  CONSTRAINT booking_terms_hash CHECK (
    content_hash = encode(sha256(convert_to(code || ':' || version_no || ':' || body, 'UTF8')), 'hex')),
  -- No approved terms exist. Removing this is part of the reviewed migration that adds them.
  CONSTRAINT booking_terms_demonstration_only CHECK (demonstration)
);
CREATE FUNCTION trucker.guard_booking_terms() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, trucker, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'a version of the booking terms cannot be changed or removed' USING ERRCODE = 'check_violation';
END
$$;
CREATE TRIGGER booking_terms_guard BEFORE UPDATE OR DELETE ON trucker.booking_terms
  FOR EACH ROW EXECUTE FUNCTION trucker.guard_booking_terms();
CREATE TRIGGER booking_terms_truncate_guard BEFORE TRUNCATE ON trucker.booking_terms
  FOR EACH STATEMENT EXECUTE FUNCTION trucker.guard_booking_terms();
-- The register ships empty, like every fictional register: the demonstration version is a
-- development fixture, and only a database marked for development or test accepts it. With no
-- version in the register, acceptance answers "closed".
CREATE FUNCTION trucker.guard_booking_terms_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, trucker, pg_temp AS $$
BEGIN
  IF (SELECT e.kind FROM trucker.environment e) NOT IN ('local-development', 'test') THEN
    RAISE EXCEPTION 'demonstration booking terms are allowed only in a database marked local-development or test'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER booking_terms_insert_guard BEFORE INSERT ON trucker.booking_terms
  FOR EACH ROW EXECUTE FUNCTION trucker.guard_booking_terms_insert();
CREATE FUNCTION trucker.guard_environment_booking_terms() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, trucker, pg_temp AS $$
BEGIN
  IF NEW.kind NOT IN ('local-development', 'test')
     AND EXISTS (SELECT 1 FROM trucker.booking_terms t WHERE t.demonstration) THEN
    RAISE EXCEPTION 'this database holds demonstration booking terms and cannot be marked %', NEW.kind
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER environment_guard_booking_terms BEFORE UPDATE ON trucker.environment
  FOR EACH ROW EXECUTE FUNCTION trucker.guard_environment_booking_terms();
ALTER TABLE trucker.booking_terms ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON trucker.booking_terms FROM trucker_app, PUBLIC;

-- ---------------------------------------------------------------------------------------------
-- New states of existing records
-- ---------------------------------------------------------------------------------------------
ALTER TABLE trucker.shipment_draft
  DROP CONSTRAINT shipment_draft_status_check,
  ADD CONSTRAINT shipment_draft_status_check
    CHECK (status IN ('draft', 'discarded', 'published', 'withdrawn', 'expired', 'awarded')),
  ADD COLUMN awarded_at timestamptz,
  ADD CONSTRAINT shipment_draft_awarded CHECK ((status = 'awarded') = (awarded_at IS NOT NULL));
ALTER TABLE trucker.quotation
  DROP CONSTRAINT quotation_status_check,
  ADD CONSTRAINT quotation_status_check
    CHECK (status IN ('submitted', 'withdrawn', 'rejected', 'expired', 'closed', 'accepted', 'not_selected'));
-- At most one accepted quotation per shipment.
CREATE UNIQUE INDEX quotation_one_accepted ON trucker.quotation (shipment_id) WHERE status = 'accepted';

-- ---------------------------------------------------------------------------------------------
-- The booking
-- ---------------------------------------------------------------------------------------------
CREATE TABLE trucker.booking (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- One booking per shipment.
  shipment_id uuid NOT NULL UNIQUE REFERENCES trucker.shipment_draft (id),
  shipment_version integer NOT NULL,
  quotation_id uuid NOT NULL UNIQUE REFERENCES trucker.quotation (id),
  quotation_version integer NOT NULL,
  shipper_organisation_id uuid NOT NULL REFERENCES trucker.organisation (id),
  carrier_organisation_id uuid NOT NULL REFERENCES trucker.organisation (id),
  -- No state is stored here. A booking starts as "awaiting resources"; what it is afterwards
  -- follows from the records of assignment and reservation, never from a word kept on this row.
  commercial_model text NOT NULL DEFAULT 'agent' CHECK (commercial_model IN ('agent')),
  -- Money: exact decimals in the shipment's one currency. Never converted, never a binary number.
  currency_code text NOT NULL,
  minor_units integer NOT NULL CHECK (minor_units BETWEEN 0 AND 3),
  transport_amount numeric NOT NULL CHECK (transport_amount > 0),
  fee_payer text NOT NULL CHECK (fee_payer IN ('shipper', 'carrier')),
  fee_basis_points integer NOT NULL CHECK (fee_basis_points BETWEEN 0 AND 5000),
  fee_rounding text NOT NULL DEFAULT 'half_up' CHECK (fee_rounding IN ('half_up')),
  fee_amount numeric NOT NULL CHECK (fee_amount >= 0),
  payment_due_days integer NOT NULL CHECK (payment_due_days BETWEEN 0 AND 365),
  -- The terms version this booking was made under, with its content hash at that moment.
  terms_code text NOT NULL,
  terms_version integer NOT NULL,
  terms_demonstration boolean NOT NULL,
  terms_hash text NOT NULL,
  -- What was agreed, exactly as it stood: the quotation version and the shipment as carriers saw it.
  quotation_snapshot jsonb NOT NULL,
  inclusions jsonb NOT NULL,
  shipment_snapshot jsonb NOT NULL,
  pickup_from_at timestamptz NOT NULL,
  pickup_until_at timestamptz NOT NULL,
  delivery_from_at timestamptz NOT NULL,
  delivery_until_at timestamptz NOT NULL,
  -- The assignment deadline and the rule it came from.
  assignment_hours integer NOT NULL,
  assignment_lead_hours integer NOT NULL,
  assignment_due_at timestamptz NOT NULL,
  -- The planned reservation interval for the resources to be assigned, and its buffers. Planned
  -- only: it reserves nothing, and it is not occupancy.
  positioning_minutes integer NOT NULL,
  completion_minutes integer NOT NULL,
  planned_start_at timestamptz NOT NULL,
  planned_end_at timestamptz NOT NULL,
  accepted_by uuid NOT NULL REFERENCES trucker.person (id),
  accepted_at timestamptz NOT NULL,
  CONSTRAINT booking_terms_reference FOREIGN KEY (terms_code, terms_version)
    REFERENCES trucker.booking_terms (code, version_no),
  CONSTRAINT booking_parties CHECK (shipper_organisation_id <> carrier_organisation_id),
  -- The fee is the stated share of the transport price, rounded half-up to the currency's minor unit.
  CONSTRAINT booking_fee_exact CHECK (
    fee_amount = round(transport_amount * fee_basis_points / 10000, minor_units)
    AND scale(transport_amount) <= minor_units),
  CONSTRAINT booking_assignment_rule CHECK (
    assignment_due_at = least(accepted_at + make_interval(hours => assignment_hours),
                              pickup_from_at - make_interval(hours => assignment_lead_hours))),
  -- A booking is never created with its assignment deadline already passed.
  CONSTRAINT booking_not_overdue CHECK (assignment_due_at > accepted_at),
  CONSTRAINT booking_planned_interval CHECK (
    planned_start_at = pickup_from_at - make_interval(mins => positioning_minutes)
    AND planned_end_at = delivery_until_at + make_interval(mins => completion_minutes)
    AND planned_start_at < planned_end_at)
);
CREATE INDEX booking_shipper_idx ON trucker.booking (shipper_organisation_id, accepted_at);
CREATE INDEX booking_carrier_idx ON trucker.booking (carrier_organisation_id, accepted_at);
COMMENT ON TABLE trucker.booking IS
  'An accepted quotation: an immutable snapshot of price, fee and terms. Commercial values are development defaults, not approved for production.';

CREATE FUNCTION trucker.guard_booking() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, trucker, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'a booking snapshot cannot be changed or removed' USING ERRCODE = 'check_violation';
END
$$;
CREATE TRIGGER booking_guard BEFORE UPDATE OR DELETE ON trucker.booking
  FOR EACH ROW EXECUTE FUNCTION trucker.guard_booking();

CREATE TABLE trucker.booking_retry_key (
  person_id uuid NOT NULL REFERENCES trucker.person (id),
  key text NOT NULL CHECK (key ~ '^[A-Za-z0-9._-]{16,128}$'),
  operation text NOT NULL CHECK (operation IN ('accept')),
  request_hash text NOT NULL,
  record_id uuid NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (person_id, key)
);
ALTER TABLE trucker.booking ENABLE ROW LEVEL SECURITY;
ALTER TABLE trucker.booking_retry_key ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON trucker.booking, trucker.booking_retry_key FROM trucker_app, PUBLIC;

-- History.
ALTER TABLE trucker.audit_entry
  DROP CONSTRAINT audit_entry_action_check,
  ADD CONSTRAINT audit_entry_action_check CHECK (action IN (
    'organisation.created', 'organisation.updated',
    'shipment.created', 'shipment.updated', 'shipment.discarded',
    'shipment.published', 'shipment.version_created', 'shipment.withdrawn', 'shipment.expired',
    'shipment.republished', 'shipment.copied', 'shipment.suspended', 'shipment.suspension_ended',
    'shipment.quotation_terms_set', 'shipment.awarded',
    'verification.submitted', 'verification.withdrawn', 'verification.claim_raised',
    'verification.decided', 'verification.revoked', 'capability.revalidated',
    'quotation.submitted', 'quotation.revised', 'quotation.reconfirmed', 'quotation.withdrawn',
    'quotation.rejected', 'quotation.expired', 'quotation.closed',
    'quotation.reconfirmation_required', 'quotation.accepted', 'quotation.not_selected',
    'acceptance.refused',
    'vehicle.registered', 'vehicle.retired', 'vehicle.ownership_decided',
    'fleet_document.submitted', 'fleet_document.decided',
    'driver.invited', 'driver.invitation_cancelled', 'driver.invitation_declined',
    'driver.affiliation_accepted', 'driver.affiliation_ended',
    'driver.authorised', 'driver.authorisation_revoked',
    'fleet.suspended', 'fleet.suspension_ended',
    'booking.created')),
  DROP CONSTRAINT audit_entry_record_type_check,
  ADD CONSTRAINT audit_entry_record_type_check CHECK (record_type IN (
    'organisation', 'shipment_draft', 'verification_application', 'quotation',
    'vehicle', 'driver_affiliation', 'driver_authorisation', 'fleet_document', 'booking'));
-- Each ending of a quotation by acceptance is recorded once, and each booking once.
CREATE UNIQUE INDEX audit_entry_one_quotation_award ON trucker.audit_entry (record_id)
  WHERE action IN ('quotation.accepted', 'quotation.not_selected');
CREATE UNIQUE INDEX audit_entry_one_booking ON trucker.audit_entry (record_id)
  WHERE action IN ('booking.created', 'shipment.awarded');

-- ---------------------------------------------------------------------------------------------
-- Building blocks (not callable by the API)
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION trucker.booking_terms_available(p_allow_fixtures boolean) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
  SELECT coalesce(p_allow_fixtures, false)
     AND (SELECT e.kind FROM trucker.environment e) IN ('local-development', 'test')
$$;

-- The terms version an acceptance now would be made under: the newest one.
CREATE FUNCTION trucker.booking_terms_current() RETURNS trucker.booking_terms
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
  SELECT t FROM trucker.booking_terms t WHERE t.code = 'booking' ORDER BY t.version_no DESC LIMIT 1
$$;
CREATE FUNCTION trucker.booking_terms_values(p_code text, p_version integer, p_demonstration boolean, p_hash text)
RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT jsonb_build_object('code', p_code, 'version', p_version, 'demonstration', p_demonstration,
                            'contentHash', p_hash)
$$;

-- A refused acceptance, recorded in the history of the shipper that asked, against the
-- quotation it asked about. It is written only for a caller already known to be an
-- administrator of the shipper that received the quotation, and holds only the reason and the
-- version numbers: what that caller is told anyway. Nothing is written into the carrier's
-- history, and nothing at all for a caller who may not see the quotation.
CREATE FUNCTION trucker.acceptance_refused(
  p_at timestamptz, p_actor uuid, p_shipper uuid, p_quotation uuid, p_reason text,
  p_expected_version integer, p_current_version integer
) RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
  INSERT INTO trucker.audit_entry
    (occurred_at, actor_person_id, organisation_id, action, record_type, record_id, request_id,
     before_values, after_values)
  VALUES (p_at, p_actor, p_shipper, 'acceptance.refused', 'quotation', p_quotation,
          nullif(current_setting('trucker.request_id', true), ''), NULL,
          jsonb_strip_nulls(jsonb_build_object(
            'reason', p_reason, 'expectedVersion', p_expected_version, 'currentVersion', p_current_version)))
$$;

-- An amount written with exactly the currency's minor units: padded, never rounded.
CREATE FUNCTION trucker.amount_text(p_amount numeric, p_minor_units integer) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT to_char(p_amount, 'FM999999999999990' || CASE WHEN p_minor_units > 0
                                                       THEN '.' || repeat('0', p_minor_units) ELSE '' END)
$$;

-- The commercial terms an acceptance at p_at would fix, from the settings as they are now.
CREATE FUNCTION trucker.acceptance_terms(
  p_amount numeric, p_minor_units integer, d trucker.shipment_draft, p_at timestamptz,
  OUT fee_payer text, OUT fee_basis_points integer, OUT fee_amount numeric, OUT payment_due_days integer,
  OUT assignment_hours integer, OUT assignment_lead_hours integer, OUT assignment_due_at timestamptz,
  OUT positioning_minutes integer, OUT completion_minutes integer,
  OUT planned_start_at timestamptz, OUT planned_end_at timestamptz
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
  SELECT g.booking_fee_payer, g.booking_fee_basis_points,
         -- numeric rounding is half away from zero, which for a positive amount is half-up.
         round(p_amount * g.booking_fee_basis_points / 10000, p_minor_units),
         g.booking_payment_due_days, g.booking_assignment_hours, g.booking_assignment_lead_hours,
         least(p_at + make_interval(hours => g.booking_assignment_hours),
               d.pickup_from_at - make_interval(hours => g.booking_assignment_lead_hours)),
         g.reservation_positioning_minutes, g.reservation_completion_minutes,
         d.pickup_from_at - make_interval(mins => g.reservation_positioning_minutes),
         d.delivery_until_at + make_interval(mins => g.reservation_completion_minutes)
  FROM trucker.security_setting g
$$;

-- Whether this quotation could be accepted at p_at, apart from who is asking and which version
-- they saw. "ok", or the first reason it could not.
--   closed | already_awarded | shipment_not_open | not_open | reconfirmation_needed
--   | carrier_not_eligible | shipment_suspended | assignment_deadline_passed
CREATE FUNCTION trucker.acceptance_check(
  q trucker.quotation, d trucker.shipment_draft, p_at timestamptz, p_allow_fixtures boolean
) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
DECLARE
  standing text;
  g trucker.security_setting;
BEGIN
  IF NOT trucker.booking_terms_available(p_allow_fixtures) THEN
    RETURN 'closed';
  END IF;
  IF (trucker.booking_terms_current()).code IS NULL THEN
    RETURN 'closed';
  END IF;
  IF d.status = 'awarded' THEN
    RETURN 'already_awarded';
  END IF;
  IF d.status <> 'published' THEN
    RETURN 'shipment_not_open';
  END IF;
  standing := trucker.quotation_standing(q, d, p_at, p_allow_fixtures);
  IF standing <> 'current' THEN
    RETURN CASE standing
      WHEN 'needs_reconfirmation' THEN 'reconfirmation_needed'
      WHEN 'carrier_not_eligible' THEN 'carrier_not_eligible'
      WHEN 'shipment_suspended' THEN 'shipment_suspended'
      ELSE 'not_open' END;
  END IF;
  -- Short notice: the assignment deadline would already have passed.
  SELECT * INTO g FROM trucker.security_setting;
  IF d.pickup_from_at - make_interval(hours => g.booking_assignment_lead_hours) <= p_at THEN
    RETURN 'assignment_deadline_passed';
  END IF;
  RETURN 'ok';
END
$$;

CREATE FUNCTION trucker.booking_values(b trucker.booking) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
  SELECT jsonb_build_object(
    'id', b.id, 'status', 'awaiting_resources', 'shipmentId', b.shipment_id, 'shipmentVersion', b.shipment_version,
    'quotationId', b.quotation_id, 'quotationVersion', b.quotation_version,
    'commercialModel', b.commercial_model,
    'shipper', (SELECT jsonb_build_object('id', o.id, 'legalName', o.legal_name, 'tradingName', o.trading_name)
                FROM trucker.organisation o WHERE o.id = b.shipper_organisation_id),
    'carrier', (SELECT jsonb_build_object('id', o.id, 'legalName', o.legal_name, 'tradingName', o.trading_name)
                FROM trucker.organisation o WHERE o.id = b.carrier_organisation_id),
    'currency', b.currency_code, 'minorUnits', b.minor_units,
    'transportAmount', trucker.amount_text(b.transport_amount, b.minor_units),
    'fee', jsonb_build_object(
      'payer', b.fee_payer, 'basisPoints', b.fee_basis_points, 'rounding', b.fee_rounding,
      'amount', trucker.amount_text(b.fee_amount, b.minor_units)),
    'shipperTotal', trucker.amount_text(
      b.transport_amount + CASE WHEN b.fee_payer = 'shipper' THEN b.fee_amount ELSE 0 END, b.minor_units),
    'carrierNet', trucker.amount_text(
      b.transport_amount - CASE WHEN b.fee_payer = 'carrier' THEN b.fee_amount ELSE 0 END, b.minor_units),
    'paymentDueDays', b.payment_due_days,
    'terms', trucker.booking_terms_values(b.terms_code, b.terms_version, b.terms_demonstration, b.terms_hash),
    'quotation', b.quotation_snapshot, 'inclusions', b.inclusions, 'shipment', b.shipment_snapshot,
    'assignment', jsonb_build_object(
      'dueAt', b.assignment_due_at, 'hours', b.assignment_hours, 'leadHours', b.assignment_lead_hours),
    'plannedReservation', jsonb_build_object(
      'startAt', b.planned_start_at, 'endAt', b.planned_end_at,
      'positioningMinutes', b.positioning_minutes, 'completionMinutes', b.completion_minutes),
    'acceptedAt', b.accepted_at)
$$;

-- What accepting one open quotation would fix, shown to the shipper before they accept.
CREATE FUNCTION trucker.acceptance_preview(
  q trucker.quotation, d trucker.shipment_draft, p_at timestamptz, p_allow_fixtures boolean
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
DECLARE
  v trucker.quotation_version;
  t record;
  v_minor integer;
  v_state text := trucker.acceptance_check(q, d, p_at, p_allow_fixtures);
  v_terms trucker.booking_terms := trucker.booking_terms_current();
BEGIN
  IF v_state = 'closed' THEN
    RETURN jsonb_build_object('quotationId', q.id, 'state', v_state);
  END IF;
  SELECT * INTO v FROM trucker.quotation_version x WHERE x.quotation_id = q.id AND x.version_no = q.current_version;
  SELECT c.minor_units INTO v_minor FROM trucker.currency c WHERE c.code = v.currency_code;
  SELECT * INTO t FROM trucker.acceptance_terms(v.amount, v_minor, d, p_at);
  RETURN jsonb_build_object(
    'quotationId', q.id, 'version', q.current_version, 'state', v_state,
    'currency', v.currency_code,
    'transportAmount', trucker.amount_text(v.amount, v_minor),
    'fee', jsonb_build_object('payer', t.fee_payer, 'basisPoints', t.fee_basis_points, 'rounding', 'half_up',
                              'amount', trucker.amount_text(t.fee_amount, v_minor)),
    'shipperTotal', trucker.amount_text(
      v.amount + CASE WHEN t.fee_payer = 'shipper' THEN t.fee_amount ELSE 0 END, v_minor),
    'paymentDueDays', t.payment_due_days,
    'terms', trucker.booking_terms_values(v_terms.code, v_terms.version_no, v_terms.demonstration, v_terms.content_hash),
    'assignmentDueAt', CASE WHEN v_state = 'ok' THEN t.assignment_due_at END);
END
$$;

-- ---------------------------------------------------------------------------------------------
-- Acceptance
-- A refusal given to an administrator of the shipper is recorded in that shipper's history.
--   status: accepted | repeated | conflict | key_conflict | unauthorized | not_found | closed
--           | already_awarded | shipment_not_open | not_open | reconfirmation_needed
--           | carrier_not_eligible | shipment_suspended | assignment_deadline_passed
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION trucker.accept_quotation(
  p_quotation uuid, p_expected_version integer, p_key text, p_allow_fixtures boolean,
  OUT status text, OUT detail jsonb
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
DECLARE
  actor uuid := trucker.request_person();
  v_org uuid := trucker.request_organisation();
  v_shipment uuid;
  v_carrier uuid;
  d trucker.shipment_draft;
  q trucker.quotation;
  v trucker.quotation_version;
  b trucker.booking;
  t record;
  seen trucker.booking_retry_key;
  g trucker.security_setting;
  v_at timestamptz;
  v_minor integer;
  v_terms trucker.shipment_quotation_terms;
  v_booking_terms trucker.booking_terms;
  other trucker.quotation;
  request text := nullif(current_setting('trucker.request_id', true), '');
  hash text := trucker.content_hash(jsonb_build_object('q', p_quotation, 'v', p_expected_version));
BEGIN
  IF p_quotation IS NULL OR p_key IS NULL OR p_key !~ '^[A-Za-z0-9._-]{16,128}$' THEN
    RAISE EXCEPTION 'invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF actor IS NULL THEN
    status := 'unauthorized';
    RETURN;
  END IF;
  -- Only an administrator of the shipper commits it. Anyone else: as for a missing record.
  IF v_org IS NULL OR NOT trucker.is_admin(v_org) THEN
    status := 'not_found';
    RETURN;
  END IF;
  SELECT x.shipment_id, x.carrier_organisation_id INTO v_shipment, v_carrier
  FROM trucker.quotation x WHERE x.id = p_quotation AND x.shipper_organisation_id = v_org;
  IF NOT FOUND THEN
    status := 'not_found';
    RETURN;
  END IF;
  -- Locks, in one order everywhere: organisations, then the shipment, then its quotations.
  PERFORM 1 FROM trucker.organisation o WHERE o.id IN (v_org, v_carrier) ORDER BY o.id FOR SHARE;
  SELECT * INTO d FROM trucker.shipment_draft x WHERE x.id = v_shipment AND x.organisation_id = v_org FOR UPDATE;
  PERFORM 1 FROM trucker.quotation x WHERE x.shipment_id = v_shipment ORDER BY x.id FOR UPDATE;
  IF d.id IS NULL OR trucker.request_person() IS DISTINCT FROM actor OR NOT trucker.is_admin(v_org) THEN
    status := 'not_found';
    RETURN;
  END IF;
  -- The clock is read only now: a request that waited is judged at the moment it proceeds.
  v_at := trucker.clock_now();
  SELECT * INTO g FROM trucker.security_setting;
  SELECT * INTO seen FROM trucker.booking_retry_key k WHERE k.person_id = actor AND k.key = p_key;
  IF FOUND AND seen.created_at <= v_at - make_interval(hours => g.retry_key_retention_hours) THEN
    DELETE FROM trucker.booking_retry_key k WHERE k.person_id = actor AND k.key = p_key;
  ELSIF FOUND THEN
    SELECT * INTO b FROM trucker.booking x WHERE x.id = seen.record_id AND x.quotation_id = p_quotation;
    IF FOUND AND seen.request_hash = hash THEN
      status := 'repeated';
      detail := trucker.booking_values(b);
    ELSE
      status := 'key_conflict';
      PERFORM trucker.acceptance_refused(v_at, actor, v_org, p_quotation, status, p_expected_version, NULL);
    END IF;
    RETURN;
  END IF;
  -- Expiry that is due is recorded first, so an acceptance one moment late finds it expired.
  PERFORM trucker.quotation_expire_shipment(d.id, v_at);
  SELECT * INTO q FROM trucker.quotation x WHERE x.id = p_quotation;
  status := trucker.acceptance_check(q, d, v_at, p_allow_fixtures);
  IF status = 'ok' AND q.current_version IS DISTINCT FROM p_expected_version THEN
    status := 'conflict';
  END IF;
  IF status <> 'ok' THEN
    -- Every refusal from here is recorded: who asked, when, and why nothing was accepted.
    PERFORM trucker.acceptance_refused(v_at, actor, v_org, p_quotation, status, p_expected_version,
                                       CASE WHEN status = 'conflict' THEN q.current_version END);
    RETURN;
  END IF;
  v_booking_terms := trucker.booking_terms_current();
  SELECT * INTO v FROM trucker.quotation_version x WHERE x.quotation_id = q.id AND x.version_no = q.current_version;
  SELECT c.minor_units INTO v_minor FROM trucker.currency c WHERE c.code = v.currency_code;
  SELECT * INTO v_terms FROM trucker.shipment_quotation_terms x WHERE x.shipment_id = d.id;
  SELECT * INTO t FROM trucker.acceptance_terms(v.amount, v_minor, d, v_at);

  INSERT INTO trucker.booking
    (shipment_id, shipment_version, quotation_id, quotation_version, shipper_organisation_id,
     carrier_organisation_id, currency_code, minor_units, transport_amount, fee_payer, fee_basis_points,
     fee_amount, payment_due_days, terms_code, terms_version, terms_demonstration, terms_hash,
     quotation_snapshot, inclusions, shipment_snapshot,
     pickup_from_at, pickup_until_at, delivery_from_at, delivery_until_at,
     assignment_hours, assignment_lead_hours, assignment_due_at,
     positioning_minutes, completion_minutes, planned_start_at, planned_end_at, accepted_by, accepted_at)
  VALUES
    (d.id, d.published_version, q.id, q.current_version, d.organisation_id,
     q.carrier_organisation_id, v.currency_code, v_minor, v.amount, t.fee_payer, t.fee_basis_points,
     t.fee_amount, t.payment_due_days, v_booking_terms.code, v_booking_terms.version_no,
     v_booking_terms.demonstration, v_booking_terms.content_hash,
     trucker.quotation_version_values(v, d.pickup_time_zone),
     coalesce((SELECT jsonb_agg(jsonb_build_object(
                 'code', i.code, 'included', (v.inclusions ->> i.code)::boolean,
                 'name', jsonb_build_object('en', i.name_en, 'ar', i.name_ar, 'ur', i.name_ur)) ORDER BY x.n)
               FROM unnest(v_terms.inclusions) WITH ORDINALITY x(code, n)
               JOIN trucker.quotation_inclusion i ON i.code = x.code), '[]'::jsonb),
     trucker.shipment_carrier_values(d, v_at),
     d.pickup_from_at, d.pickup_until_at, d.delivery_from_at, d.delivery_until_at,
     t.assignment_hours, t.assignment_lead_hours, t.assignment_due_at,
     t.positioning_minutes, t.completion_minutes, t.planned_start_at, t.planned_end_at, actor, v_at)
  RETURNING * INTO b;

  UPDATE trucker.quotation x SET status = 'accepted', ended_at = v_at, updated_at = v_at WHERE x.id = q.id;
  INSERT INTO trucker.audit_entry
    (occurred_at, actor_person_id, organisation_id, action, record_type, record_id, request_id,
     before_values, after_values)
  VALUES (v_at, actor, q.carrier_organisation_id, 'quotation.accepted', 'quotation', q.id, request,
          jsonb_build_object('status', 'submitted', 'version', q.current_version),
          jsonb_build_object('status', 'accepted', 'booking', b.id));
  FOR other IN SELECT * FROM trucker.quotation x
               WHERE x.shipment_id = d.id AND x.status = 'submitted' ORDER BY x.id LOOP
    UPDATE trucker.quotation x SET status = 'not_selected', ended_at = v_at, updated_at = v_at WHERE x.id = other.id;
    INSERT INTO trucker.audit_entry
      (occurred_at, actor_person_id, organisation_id, action, record_type, record_id, request_id,
       before_values, after_values)
    VALUES (v_at, actor, other.carrier_organisation_id, 'quotation.not_selected', 'quotation', other.id, request,
            jsonb_build_object('status', 'submitted', 'version', other.current_version),
            jsonb_build_object('status', 'not_selected'));
  END LOOP;
  UPDATE trucker.shipment_draft x
  SET status = 'awarded', awarded_at = v_at, version = x.version + 1, updated_at = v_at WHERE x.id = d.id;
  INSERT INTO trucker.audit_entry
    (occurred_at, actor_person_id, organisation_id, action, record_type, record_id, request_id,
     before_values, after_values)
  VALUES
    (v_at, actor, d.organisation_id, 'shipment.awarded', 'shipment_draft', d.id, request,
     jsonb_build_object('status', 'published', 'publishedVersion', d.published_version),
     jsonb_build_object('status', 'awarded', 'booking', b.id)),
    (v_at, actor, d.organisation_id, 'booking.created', 'booking', b.id, request, NULL,
     jsonb_build_object('status', 'awaiting_resources', 'quotation', q.id, 'quotationVersion', q.current_version,
                        'transportAmount', trucker.amount_text(b.transport_amount, b.minor_units),
                        'feeAmount', trucker.amount_text(b.fee_amount, b.minor_units),
                        'currency', b.currency_code, 'assignmentDueAt', b.assignment_due_at,
                        'terms', trucker.booking_terms_values(
                          b.terms_code, b.terms_version, b.terms_demonstration, b.terms_hash)));
  INSERT INTO trucker.booking_retry_key (person_id, key, operation, request_hash, record_id, created_at)
  VALUES (actor, p_key, 'accept', hash, b.id, v_at);
  status := 'accepted';
  detail := trucker.booking_values(b);
END
$$;

-- ---------------------------------------------------------------------------------------------
-- Reading
-- ---------------------------------------------------------------------------------------------
-- The shipper's view of one shipment: its booking if it is awarded, and otherwise what accepting
-- each open quotation would fix.
--   status: ok | unauthorized | not_found
CREATE FUNCTION trucker.booking_overview(p_shipment uuid, p_allow_fixtures boolean, OUT status text, OUT detail jsonb)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
DECLARE
  actor uuid := trucker.request_person();
  v_org uuid := trucker.request_organisation();
  d trucker.shipment_draft;
  b trucker.booking;
  v_at timestamptz;
BEGIN
  IF actor IS NULL THEN
    status := 'unauthorized';
    RETURN;
  END IF;
  IF v_org IS NULL OR NOT trucker.is_admin(v_org) THEN
    status := 'not_found';
    RETURN;
  END IF;
  SELECT * INTO d FROM trucker.shipment_draft x WHERE x.id = p_shipment AND x.organisation_id = v_org FOR SHARE;
  IF NOT FOUND THEN
    status := 'not_found';
    RETURN;
  END IF;
  v_at := trucker.clock_now();
  PERFORM trucker.quotation_expire_shipment(d.id, v_at);
  SELECT * INTO b FROM trucker.booking x WHERE x.shipment_id = d.id;
  status := 'ok';
  detail := jsonb_build_object(
    'open', trucker.booking_terms_available(p_allow_fixtures),
    'booking', CASE WHEN b.id IS NOT NULL THEN trucker.booking_values(b) END,
    'acceptance', coalesce((
      SELECT jsonb_agg(trucker.acceptance_preview(q, d, v_at, p_allow_fixtures) ORDER BY q.created_at, q.id)
      FROM trucker.quotation q WHERE q.shipment_id = d.id AND q.status = 'submitted'), '[]'::jsonb));
END
$$;

-- The bookings of the organisation named by the request, as shipper or as carrier, newest first.
--   status: ok | unauthorized | not_found
CREATE FUNCTION trucker.organisation_bookings(OUT status text, OUT detail jsonb)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
DECLARE
  actor uuid := trucker.request_person();
  v_org uuid := trucker.request_organisation();
BEGIN
  IF actor IS NULL THEN
    status := 'unauthorized';
    RETURN;
  END IF;
  IF v_org IS NULL OR NOT trucker.is_admin(v_org) THEN
    status := 'not_found';
    RETURN;
  END IF;
  status := 'ok';
  detail := coalesce((
    SELECT jsonb_agg(trucker.booking_values(b) || jsonb_build_object(
             'role', CASE WHEN b.shipper_organisation_id = v_org THEN 'shipper' ELSE 'carrier' END)
           ORDER BY b.accepted_at DESC, b.id)
    FROM trucker.booking b
    WHERE b.shipper_organisation_id = v_org OR b.carrier_organisation_id = v_org), '[]'::jsonb);
END
$$;

-- Staff: the booking of a shipment, read-only. Each look is recorded.
--   status: ok | unauthorized | forbidden | not_found
CREATE FUNCTION trucker.staff_shipment_booking(
  p_token_hash text, p_shipment uuid, p_request_id text, OUT status text, OUT detail jsonb
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
DECLARE
  entered record;
  b trucker.booking;
BEGIN
  SELECT * INTO entered FROM trucker.staff_enter(p_token_hash, NULL, 'staff.booking_view', NULL, p_request_id);
  status := entered.status;
  IF status <> 'ok' THEN
    RETURN;
  END IF;
  IF NOT (trucker.staff_privileges(entered.staff_id) && ARRAY['reviewer', 'staff_admin']) THEN
    PERFORM trucker.staff_audit(entered.at, entered.staff_id, 'staff.booking_view', 'refused', NULL, p_request_id,
                                jsonb_build_object('reason', 'privilege_not_held', 'shipment', p_shipment));
    status := 'forbidden';
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM trucker.shipment_draft x WHERE x.id = p_shipment AND x.published_version IS NOT NULL) THEN
    status := 'not_found';
    RETURN;
  END IF;
  PERFORM trucker.staff_audit(entered.at, entered.staff_id, 'staff.booking_view', 'done', NULL, p_request_id,
                              jsonb_build_object('shipment', p_shipment));
  SELECT * INTO b FROM trucker.booking x WHERE x.shipment_id = p_shipment;
  detail := jsonb_build_object('booking', CASE WHEN b.id IS NOT NULL THEN trucker.booking_values(b) END);
END
$$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA trucker FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  trucker.accept_quotation(uuid, integer, text, boolean),
  trucker.booking_overview(uuid, boolean),
  trucker.organisation_bookings(),
  trucker.staff_shipment_booking(text, uuid, text)
TO trucker_app;
