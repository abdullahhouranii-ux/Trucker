-- 0029: exceptions and operations on trips (slice 17b).
--
-- Trucker staff who hold the new operations privilege (DD-3) handle what goes wrong around a
-- trip. The driver, the carrier, the shipper or the system reports an exception of a fixed type
-- (DD-10); it is a case in the operations queue at once (EXC-1). Operations acknowledges a case,
-- records what it did, and resolves it, each step with its time, person and note; the notes stay
-- with operations (EXC-2, EXC-5). A resource still occupied past its planned end opens one case,
-- linked to the overrunning trip and to every later booking it puts at risk, however often the
-- overrun is seen; so does a trip with no arrival at pick-up by the end of the pick-up window
-- (EXC-3, N-6, DD-9). Neither has any automatic consequence.
--
-- Operations can block a dispatch before it happens, with a reason from a fixed list the parties
-- see and a note they do not (DB-9, DD-4); put a trip on hold, when it accepts no milestone, and
-- resume it (EXC-4); record a milestone on the driver's behalf (DD-6); and withdraw the latest
-- milestone when it was recorded by mistake. A withdrawn milestone stays in the record, shown as
-- withdrawn with when and why; the trip goes back one step.
--
-- Development defaults, not approved for production: DD-1 to DD-10 (approved as the slice scope
-- on 18 November 2026) and XS-1 to XS-5 (EXCEPTIONS_SLICE_17B.md).

-- ---------------------------------------------------------------------------------------------
-- The operations privilege (DD-3)
-- ---------------------------------------------------------------------------------------------
ALTER TABLE trucker.staff_privilege DROP CONSTRAINT staff_privilege_privilege_check;
ALTER TABLE trucker.staff_privilege ADD CONSTRAINT staff_privilege_privilege_check
  CHECK (privilege IN ('staff_admin', 'reviewer', 'operations'));

CREATE OR REPLACE FUNCTION trucker.staff_set_privilege(p_token_hash text, p_staff uuid, p_privilege text, p_granted boolean, p_request_id text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'trucker', 'pg_temp'
AS $function$
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
  IF p_privilege IS NULL OR p_privilege NOT IN ('staff_admin', 'reviewer', 'operations') THEN
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
$function$;

-- ---------------------------------------------------------------------------------------------
-- Operations blocks on dispatch (DB-9, DD-4)
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION trucker.operations_reasons() RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT ARRAY['safety_review', 'document_concern', 'suspected_fraud', 'other']
$$;

CREATE TABLE trucker.dispatch_block (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id uuid NOT NULL REFERENCES trucker.booking (id),
  reason text NOT NULL CHECK (reason = ANY (trucker.operations_reasons())),
  -- Stays with operations.
  note text NOT NULL CHECK (char_length(note) BETWEEN 1 AND 1000),
  blocked_by uuid NOT NULL REFERENCES trucker.staff_account (id),
  blocked_at timestamptz NOT NULL,
  lifted_by uuid REFERENCES trucker.staff_account (id),
  lifted_at timestamptz,
  lift_note text CHECK (lift_note IS NULL OR char_length(lift_note) BETWEEN 1 AND 1000),
  CONSTRAINT dispatch_block_lifted CHECK (
    (lifted_at IS NULL) = (lifted_by IS NULL) AND (lifted_at IS NULL) = (lift_note IS NULL)
    AND (lifted_at IS NULL OR lifted_at >= blocked_at))
);
-- At most one block in force on a booking.
CREATE UNIQUE INDEX dispatch_block_one_active ON trucker.dispatch_block (booking_id) WHERE lifted_at IS NULL;

-- ---------------------------------------------------------------------------------------------
-- Holds on a trip (EXC-4)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE trucker.trip_hold (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id uuid NOT NULL REFERENCES trucker.trip (id),
  reason text NOT NULL CHECK (reason = ANY (trucker.operations_reasons())),
  note text NOT NULL CHECK (char_length(note) BETWEEN 1 AND 1000),
  held_by uuid NOT NULL REFERENCES trucker.staff_account (id),
  held_at timestamptz NOT NULL,
  resumed_by uuid REFERENCES trucker.staff_account (id),
  resumed_at timestamptz,
  resume_note text CHECK (resume_note IS NULL OR char_length(resume_note) BETWEEN 1 AND 1000),
  CONSTRAINT trip_hold_resumed CHECK (
    (resumed_at IS NULL) = (resumed_by IS NULL) AND (resumed_at IS NULL) = (resume_note IS NULL)
    AND (resumed_at IS NULL OR resumed_at >= held_at))
);
CREATE UNIQUE INDEX trip_hold_one_active ON trucker.trip_hold (trip_id) WHERE resumed_at IS NULL;

-- A block or hold is lifted once; nothing else about it changes, and neither is removed.
CREATE FUNCTION trucker.guard_operations_measure() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, trucker, pg_temp AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF TG_TABLE_NAME = 'dispatch_block' THEN
      IF (NEW.id, NEW.booking_id, NEW.reason, NEW.note, NEW.blocked_by, NEW.blocked_at)
           IS NOT DISTINCT FROM (OLD.id, OLD.booking_id, OLD.reason, OLD.note, OLD.blocked_by, OLD.blocked_at)
         AND OLD.lifted_at IS NULL AND NEW.lifted_at IS NOT NULL THEN
        RETURN NEW;
      END IF;
    ELSIF (NEW.id, NEW.trip_id, NEW.reason, NEW.note, NEW.held_by, NEW.held_at)
            IS NOT DISTINCT FROM (OLD.id, OLD.trip_id, OLD.reason, OLD.note, OLD.held_by, OLD.held_at)
          AND OLD.resumed_at IS NULL AND NEW.resumed_at IS NOT NULL THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'a block or hold is only ever lifted, once' USING ERRCODE = 'check_violation';
END
$$;
CREATE TRIGGER dispatch_block_guard BEFORE UPDATE OR DELETE ON trucker.dispatch_block
  FOR EACH ROW EXECUTE FUNCTION trucker.guard_operations_measure();
CREATE TRIGGER dispatch_block_truncate_guard BEFORE TRUNCATE ON trucker.dispatch_block
  FOR EACH STATEMENT EXECUTE FUNCTION trucker.guard_trip_record();
CREATE TRIGGER trip_hold_guard BEFORE UPDATE OR DELETE ON trucker.trip_hold
  FOR EACH ROW EXECUTE FUNCTION trucker.guard_operations_measure();
CREATE TRIGGER trip_hold_truncate_guard BEFORE TRUNCATE ON trucker.trip_hold
  FOR EACH STATEMENT EXECUTE FUNCTION trucker.guard_trip_record();

-- ---------------------------------------------------------------------------------------------
-- Milestones: entered by operations, and withdrawn when recorded by mistake
-- ---------------------------------------------------------------------------------------------
ALTER TABLE trucker.trip_milestone
  ALTER COLUMN recorded_by DROP NOT NULL,
  ADD COLUMN recorded_by_staff uuid REFERENCES trucker.staff_account (id),
  ADD CONSTRAINT trip_milestone_one_recorder CHECK ((recorded_by IS NULL) <> (recorded_by_staff IS NULL)),
  ADD CONSTRAINT trip_milestone_staff_reported CHECK (recorded_by_staff IS NULL OR basis = 'reported'),
  -- A withdrawn milestone may be recorded again: one milestone in force for each step.
  DROP CONSTRAINT trip_milestone_trip_id_seq_key;

CREATE TABLE trucker.trip_milestone_withdrawal (
  milestone_id uuid PRIMARY KEY REFERENCES trucker.trip_milestone (id),
  trip_id uuid NOT NULL REFERENCES trucker.trip (id),
  withdrawn_by uuid NOT NULL REFERENCES trucker.staff_account (id),
  withdrawn_at timestamptz NOT NULL,
  note text NOT NULL CHECK (char_length(note) BETWEEN 1 AND 1000)
);
CREATE TRIGGER trip_milestone_withdrawal_guard BEFORE UPDATE OR DELETE ON trucker.trip_milestone_withdrawal
  FOR EACH ROW EXECUTE FUNCTION trucker.guard_trip_record();
CREATE TRIGGER trip_milestone_withdrawal_truncate_guard BEFORE TRUNCATE ON trucker.trip_milestone_withdrawal
  FOR EACH STATEMENT EXECUTE FUNCTION trucker.guard_trip_record();

-- One milestone in force for each step of a trip: checked under the trip's lock, for any path.
CREATE FUNCTION trucker.guard_trip_milestone_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, trucker, pg_temp AS $$
BEGIN
  PERFORM 1 FROM trucker.trip t WHERE t.id = NEW.trip_id FOR UPDATE;
  IF EXISTS (SELECT 1 FROM trucker.trip_milestone m
             WHERE m.trip_id = NEW.trip_id AND m.seq = NEW.seq
               AND NOT EXISTS (SELECT 1 FROM trucker.trip_milestone_withdrawal w WHERE w.milestone_id = m.id)) THEN
    RAISE EXCEPTION 'this step of the trip is already recorded' USING ERRCODE = 'unique_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER trip_milestone_one_in_force BEFORE INSERT ON trucker.trip_milestone
  FOR EACH ROW EXECUTE FUNCTION trucker.guard_trip_milestone_insert();

-- Only the latest milestone in force is withdrawn, and the trip goes back that one step.
CREATE FUNCTION trucker.guard_trip_milestone_withdrawal() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, trucker, pg_temp AS $$
DECLARE
  tr trucker.trip;
  m trucker.trip_milestone;
BEGIN
  SELECT * INTO tr FROM trucker.trip t WHERE t.id = NEW.trip_id FOR UPDATE;
  SELECT * INTO m FROM trucker.trip_milestone x WHERE x.id = NEW.milestone_id;
  IF m.trip_id IS DISTINCT FROM NEW.trip_id OR m.seq IS DISTINCT FROM tr.milestone_count THEN
    RAISE EXCEPTION 'only the latest milestone in force is withdrawn' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER trip_milestone_withdrawal_latest BEFORE INSERT ON trucker.trip_milestone_withdrawal
  FOR EACH ROW EXECUTE FUNCTION trucker.guard_trip_milestone_withdrawal();

-- The trip moves forward by one milestone, or back by one when its latest is withdrawn.
CREATE OR REPLACE FUNCTION trucker.guard_trip() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, trucker, pg_temp AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND (NEW.id, NEW.booking_id, NEW.set_no, NEW.dispatched_by, NEW.dispatched_at, NEW.late, NEW.dispatch_key,
          NEW.dispatch_hash)
         IS NOT DISTINCT FROM
         (OLD.id, OLD.booking_id, OLD.set_no, OLD.dispatched_by, OLD.dispatched_at, OLD.late, OLD.dispatch_key,
          OLD.dispatch_hash)
     AND NEW.row_version = OLD.row_version + 1 THEN
    IF NEW.milestone_count = OLD.milestone_count + 1
       AND EXISTS (SELECT 1 FROM trucker.trip_milestone m
                   WHERE m.trip_id = NEW.id AND m.seq = NEW.milestone_count
                     AND NOT EXISTS (SELECT 1 FROM trucker.trip_milestone_withdrawal w WHERE w.milestone_id = m.id)) THEN
      RETURN NEW;
    END IF;
    IF NEW.milestone_count = OLD.milestone_count - 1
       AND NOT EXISTS (SELECT 1 FROM trucker.trip_milestone m
                       WHERE m.trip_id = NEW.id AND m.seq = OLD.milestone_count
                         AND NOT EXISTS (SELECT 1 FROM trucker.trip_milestone_withdrawal w WHERE w.milestone_id = m.id)) THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'a trip is never removed, and only moves to its next milestone or back from a withdrawn one'
    USING ERRCODE = 'check_violation';
END
$$;

-- ---------------------------------------------------------------------------------------------
-- Cases (EXC-1, EXC-3)
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION trucker.exception_types() RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT ARRAY['delay', 'breakdown', 'accident', 'cargo_damage_or_shortage', 'refused_at_site', 'receiver_absent',
               'document_problem', 'road_closed', 'safety_concern', 'no_show', 'other']
$$;

CREATE TABLE trucker.trip_case (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id uuid NOT NULL REFERENCES trucker.trip (id),
  booking_id uuid NOT NULL REFERENCES trucker.booking (id),
  -- Reported by someone, or seen by the system (DD-9).
  kind text NOT NULL CHECK (kind IN ('exception', 'overrun', 'no_pickup_arrival')),
  exception_type text CHECK (exception_type IS NULL OR exception_type = ANY (trucker.exception_types())),
  -- Seen by operations and by the side that reported it.
  description text CHECK (description IS NULL OR char_length(description) BETWEEN 1 AND 2000),
  reported_as text NOT NULL CHECK (reported_as IN ('driver', 'carrier', 'shipper', 'system')),
  reported_by uuid REFERENCES trucker.person (id),
  reported_at timestamptz NOT NULL,
  report_key text,
  report_hash text,
  state text NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'acknowledged', 'resolved')),
  row_version integer NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  CONSTRAINT trip_case_shape CHECK (
    (kind = 'exception') = (exception_type IS NOT NULL)
    AND (kind = 'exception') = (description IS NOT NULL)
    AND (kind = 'exception') = (reported_as <> 'system')
    AND (reported_as = 'system') = (reported_by IS NULL)
    AND (reported_by IS NULL) = (report_key IS NULL) AND (report_key IS NULL) = (report_hash IS NULL)),
  UNIQUE (reported_by, report_key)
);
-- A system case is recorded once for each trip, however often it is seen (EXC-3).
CREATE UNIQUE INDEX trip_case_one_system ON trucker.trip_case (trip_id, kind) WHERE kind <> 'exception';
CREATE INDEX trip_case_open_idx ON trucker.trip_case (reported_at) WHERE state <> 'resolved';

-- The later bookings an overrun puts at risk.
CREATE TABLE trucker.trip_case_booking (
  case_id uuid NOT NULL REFERENCES trucker.trip_case (id),
  booking_id uuid NOT NULL REFERENCES trucker.booking (id),
  linked_at timestamptz NOT NULL,
  PRIMARY KEY (case_id, booking_id)
);

-- What operations did, in order. The notes stay with operations (EXC-5).
CREATE TABLE trucker.trip_case_event (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  case_id uuid NOT NULL REFERENCES trucker.trip_case (id),
  action text NOT NULL CHECK (action IN ('acknowledged', 'action', 'resolved')),
  staff_id uuid NOT NULL REFERENCES trucker.staff_account (id),
  at timestamptz NOT NULL,
  note text CHECK (note IS NULL OR char_length(note) BETWEEN 1 AND 2000),
  CONSTRAINT trip_case_event_note CHECK (action = 'acknowledged' OR note IS NOT NULL)
);
CREATE INDEX trip_case_event_case_idx ON trucker.trip_case_event (case_id, id);

-- A case only moves forward: open, acknowledged, resolved. Nothing else about it changes.
CREATE FUNCTION trucker.guard_trip_case() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, trucker, pg_temp AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND (NEW.id, NEW.trip_id, NEW.booking_id, NEW.kind, NEW.exception_type, NEW.description, NEW.reported_as,
          NEW.reported_by, NEW.reported_at, NEW.report_key, NEW.report_hash)
         IS NOT DISTINCT FROM
         (OLD.id, OLD.trip_id, OLD.booking_id, OLD.kind, OLD.exception_type, OLD.description, OLD.reported_as,
          OLD.reported_by, OLD.reported_at, OLD.report_key, OLD.report_hash)
     AND NEW.row_version = OLD.row_version + 1
     AND ((OLD.state = 'open' AND NEW.state = 'acknowledged')
          OR (OLD.state = 'acknowledged' AND NEW.state IN ('acknowledged', 'resolved'))) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'a case is never removed, and only moves forward' USING ERRCODE = 'check_violation';
END
$$;
CREATE TRIGGER trip_case_guard BEFORE UPDATE OR DELETE ON trucker.trip_case
  FOR EACH ROW EXECUTE FUNCTION trucker.guard_trip_case();
CREATE TRIGGER trip_case_truncate_guard BEFORE TRUNCATE ON trucker.trip_case
  FOR EACH STATEMENT EXECUTE FUNCTION trucker.guard_trip_record();
CREATE TRIGGER trip_case_booking_guard BEFORE UPDATE OR DELETE ON trucker.trip_case_booking
  FOR EACH ROW EXECUTE FUNCTION trucker.guard_trip_record();
CREATE TRIGGER trip_case_booking_truncate_guard BEFORE TRUNCATE ON trucker.trip_case_booking
  FOR EACH STATEMENT EXECUTE FUNCTION trucker.guard_trip_record();
CREATE TRIGGER trip_case_event_guard BEFORE UPDATE OR DELETE ON trucker.trip_case_event
  FOR EACH ROW EXECUTE FUNCTION trucker.guard_trip_record();
CREATE TRIGGER trip_case_event_truncate_guard BEFORE TRUNCATE ON trucker.trip_case_event
  FOR EACH STATEMENT EXECUTE FUNCTION trucker.guard_trip_record();

ALTER TABLE trucker.dispatch_block ENABLE ROW LEVEL SECURITY;
ALTER TABLE trucker.trip_hold ENABLE ROW LEVEL SECURITY;
ALTER TABLE trucker.trip_milestone_withdrawal ENABLE ROW LEVEL SECURITY;
ALTER TABLE trucker.trip_case ENABLE ROW LEVEL SECURITY;
ALTER TABLE trucker.trip_case_booking ENABLE ROW LEVEL SECURITY;
ALTER TABLE trucker.trip_case_event ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON trucker.dispatch_block, trucker.trip_hold, trucker.trip_milestone_withdrawal, trucker.trip_case,
  trucker.trip_case_booking, trucker.trip_case_event FROM trucker_app, PUBLIC;

-- History.
ALTER TABLE trucker.audit_entry
  DROP CONSTRAINT audit_entry_action_check,
  ADD CONSTRAINT audit_entry_action_check CHECK (action IN (
    'organisation.created', 'organisation.updated', 'shipment.created', 'shipment.updated',
    'shipment.discarded', 'shipment.published', 'shipment.version_created',
    'shipment.withdrawn', 'shipment.expired', 'shipment.republished', 'shipment.copied',
    'shipment.suspended', 'shipment.suspension_ended', 'shipment.quotation_terms_set',
    'shipment.awarded', 'verification.submitted', 'verification.withdrawn',
    'verification.claim_raised', 'verification.decided', 'verification.revoked',
    'capability.revalidated', 'quotation.submitted', 'quotation.revised',
    'quotation.reconfirmed', 'quotation.withdrawn', 'quotation.rejected', 'quotation.expired',
    'quotation.closed', 'quotation.reconfirmation_required', 'quotation.accepted',
    'quotation.not_selected', 'acceptance.refused', 'vehicle.registered', 'vehicle.retired',
    'vehicle.ownership_decided', 'fleet_document.submitted', 'fleet_document.decided',
    'driver.invited', 'driver.invitation_cancelled', 'driver.invitation_declined',
    'driver.affiliation_accepted', 'driver.affiliation_ended', 'driver.authorised',
    'driver.authorisation_revoked', 'fleet.suspended', 'fleet.suspension_ended',
    'booking.created', 'booking.assignment_changed', 'booking.confirmed',
    'booking.wait_decided', 'substitution.proposed', 'substitution.accepted',
    'substitution.declined', 'substitution.withdrawn', 'substitution.checks_failed',
    'assignment.acknowledged', 'booking.cancelled', 'booking.vehicles_changed',
    'authority.requested', 'authority.decided', 'authority.ended', 'shipment.parties_set',
    'shipment.commission_set', 'commission_contract.proposed', 'commission_contract.decided',
    'commission_contract.ended', 'booking.fee_paid', 'booking.lapsed',
    'booking.refund_recorded', 'booking.dispatched', 'trip.milestone_recorded',
    'trip.estimate_stated', 'trip.exception_reported', 'trip.case_opened', 'trip.case_updated',
    'booking.dispatch_blocked', 'booking.dispatch_unblocked', 'trip.held', 'trip.resumed',
    'trip.milestone_withdrawn'
  )),
  DROP CONSTRAINT audit_entry_one_actor,
  ADD CONSTRAINT audit_entry_one_actor CHECK (
    (actor_person_id IS NULL) <> (actor_staff_id IS NULL)
    OR (actor_person_id IS NULL AND actor_staff_id IS NULL AND action IN (
      'shipment.expired', 'shipment.suspended', 'shipment.suspension_ended', 'quotation.expired',
    'quotation.closed', 'quotation.reconfirmation_required', 'booking.lapsed',
    'booking.fee_paid', 'booking.refund_recorded', 'booking.confirmed', 'trip.case_opened'
    )));

-- ---------------------------------------------------------------------------------------------
-- What the parties and operations see
-- ---------------------------------------------------------------------------------------------
-- One case. A party sees that it exists, its type and its state (EXC-5); the description only
-- the side that reported it, and operations. Operations sees everything, with its history.
CREATE FUNCTION trucker.trip_case_values(c trucker.trip_case, p_audience text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
  SELECT jsonb_build_object(
    'id', c.id, 'kind', c.kind, 'type', c.exception_type, 'state', c.state, 'reportedAs', c.reported_as,
    'reportedAt', c.reported_at,
    'description', CASE WHEN p_audience IN ('operations', c.reported_as)
                          OR (p_audience = 'carrier' AND c.reported_as = 'driver') THEN c.description END)
  || CASE WHEN p_audience = 'operations' THEN jsonb_build_object(
       'version', c.row_version, 'bookingId', c.booking_id,
       'reportedBy', (SELECT p.display_name FROM trucker.person p WHERE p.id = c.reported_by),
       'atRisk', coalesce((SELECT jsonb_agg(l.booking_id ORDER BY l.linked_at, l.booking_id)
                           FROM trucker.trip_case_booking l WHERE l.case_id = c.id), '[]'::jsonb),
       'events', coalesce((SELECT jsonb_agg(jsonb_build_object(
                             'action', e.action, 'at', e.at, 'note', e.note,
                             'by', (SELECT a.display_name FROM trucker.staff_account a WHERE a.id = e.staff_id))
                           ORDER BY e.id)
                           FROM trucker.trip_case_event e WHERE e.case_id = c.id), '[]'::jsonb))
     ELSE '{}'::jsonb END
$$;

CREATE OR REPLACE FUNCTION trucker.trip_values(p_booking uuid, p_audience text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'trucker', 'pg_temp'
AS $function$
  SELECT jsonb_build_object(
    'id', t.id, 'version', t.row_version, 'dispatchedAt', t.dispatched_at, 'late', t.late,
    'next', (trucker.trip_milestones())[t.milestone_count + 1],
    'milestones', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'milestone', m.milestone, 'statedAt', m.stated_at, 'recordedAt', m.recorded_at, 'basis', m.basis,
               'about', (SELECT p.display_name FROM trucker.person p WHERE p.id = m.driver_id),
               -- Operations' entries name Trucker operations, not the staff member, to the parties.
               'enteredBy', CASE WHEN m.basis = 'reported' AND m.recorded_by IS NOT NULL
                                 THEN (SELECT p.display_name FROM trucker.person p WHERE p.id = m.recorded_by)
                                 WHEN m.recorded_by_staff IS NOT NULL AND p_audience = 'operations'
                                 THEN (SELECT a.display_name FROM trucker.staff_account a WHERE a.id = m.recorded_by_staff) END,
               'enteredAs', CASE WHEN m.basis = 'observed' THEN 'driver'
                                 WHEN m.recorded_by_staff IS NOT NULL THEN 'operations' ELSE 'carrier' END,
               'reason', m.reason,
               -- The note stays with the carrier.
               'note', CASE WHEN p_audience = 'carrier' AND m.recorded_by IS NOT NULL
                              OR p_audience = 'operations' THEN m.note END,
               'needsReview', m.needs_review)
             ORDER BY m.seq)
      FROM trucker.trip_milestone m WHERE m.trip_id = t.id
        AND NOT EXISTS (SELECT 1 FROM trucker.trip_milestone_withdrawal w WHERE w.milestone_id = m.id)), '[]'::jsonb),
    -- Milestones withdrawn as recorded by mistake stay visible, with when and why (slice 17b).
    'withdrawn', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'milestone', m.milestone, 'statedAt', m.stated_at, 'withdrawnAt', w.withdrawn_at,
               'note', CASE WHEN p_audience = 'operations' THEN w.note END)
             ORDER BY w.withdrawn_at, m.seq)
      FROM trucker.trip_milestone_withdrawal w JOIN trucker.trip_milestone m ON m.id = w.milestone_id
      WHERE w.trip_id = t.id), '[]'::jsonb),
    'hold', (SELECT jsonb_build_object('reason', h.reason, 'heldAt', h.held_at)
                    || CASE WHEN p_audience = 'operations' THEN jsonb_build_object(
                         'note', h.note, 'heldBy', (SELECT a.display_name FROM trucker.staff_account a WHERE a.id = h.held_by))
                       ELSE '{}'::jsonb END
             FROM trucker.trip_hold h WHERE h.trip_id = t.id AND h.resumed_at IS NULL),
    'cases', coalesce((SELECT jsonb_agg(trucker.trip_case_values(c, p_audience) ORDER BY c.reported_at, c.id)
                       FROM trucker.trip_case c WHERE c.trip_id = t.id), '[]'::jsonb),
    'estimate', (SELECT jsonb_build_object('arrivalAt', e.arrival_at, 'statedAt', e.stated_at, 'statedAs', e.stated_as,
                                           'statedBy', (SELECT p.display_name FROM trucker.person p WHERE p.id = e.stated_by))
                 FROM trucker.trip_estimate e WHERE e.trip_id = t.id ORDER BY e.seq DESC LIMIT 1))
  FROM trucker.trip t WHERE t.booking_id = p_booking
$function$;

-- ---------------------------------------------------------------------------------------------
-- What the clock shows: overruns and missing arrivals at pick-up become cases (EXC-3, DD-9)
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trucker.overrun_note(p_at timestamp with time zone)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'trucker', 'pg_temp'
AS $function$
#variable_conflict use_column
BEGIN
  UPDATE trucker.resource_reservation r SET overrun_recorded_at = p_at
  FROM trucker.occupancy_episode e
  WHERE e.reservation_id = r.id AND e.closed_at IS NULL AND upper(r.planned) < p_at
    AND r.overrun_recorded_at IS NULL;
  INSERT INTO trucker.booking_risk_flag (booking_id, episode_id, recorded_at)
  SELECT DISTINCT later.booking_id, e.id, p_at
  FROM trucker.occupancy_episode e
  JOIN trucker.resource_reservation r ON r.id = e.reservation_id
  JOIN trucker.resource_reservation later
    ON later.resource_id = e.resource_id AND later.status = 'active' AND later.booking_id <> e.booking_id
  WHERE e.closed_at IS NULL AND upper(r.planned) < p_at
  ON CONFLICT DO NOTHING;
  -- One case for each overrunning trip, however often it is seen, linked to every later booking
  -- it puts at risk (EXC-3, N-6). No automatic consequence.
  WITH opened AS (
    INSERT INTO trucker.trip_case (trip_id, booking_id, kind, reported_as, reported_at)
    SELECT DISTINCT t.id, t.booking_id, 'overrun', 'system', p_at
    FROM trucker.occupancy_episode e
    JOIN trucker.resource_reservation r ON r.id = e.reservation_id
    JOIN trucker.trip t ON t.booking_id = e.booking_id
    WHERE e.closed_at IS NULL AND upper(r.planned) < p_at
    ON CONFLICT (trip_id, kind) WHERE kind <> 'exception' DO NOTHING
    RETURNING *)
  INSERT INTO trucker.audit_entry (occurred_at, organisation_id, action, record_type, record_id, after_values)
  SELECT p_at, o, 'trip.case_opened', 'booking', b.id, jsonb_build_object('case', c.id, 'kind', c.kind)
  FROM opened c JOIN trucker.booking b ON b.id = c.booking_id,
       unnest(ARRAY[b.shipper_organisation_id, b.carrier_organisation_id]) o;
  INSERT INTO trucker.trip_case_booking (case_id, booking_id, linked_at)
  SELECT DISTINCT c.id, f.booking_id, p_at
  FROM trucker.booking_risk_flag f
  JOIN trucker.occupancy_episode e ON e.id = f.episode_id
  JOIN trucker.trip t ON t.booking_id = e.booking_id
  JOIN trucker.trip_case c ON c.trip_id = t.id AND c.kind = 'overrun'
  ON CONFLICT DO NOTHING;
  -- No arrival at pick-up by the end of the pick-up window (DD-9): one case for the trip.
  WITH opened AS (
    INSERT INTO trucker.trip_case (trip_id, booking_id, kind, reported_as, reported_at)
    SELECT t.id, t.booking_id, 'no_pickup_arrival', 'system', p_at
    FROM trucker.trip t JOIN trucker.booking b ON b.id = t.booking_id
    WHERE t.milestone_count < 2
      AND (b.shipment_snapshot #>> '{pickup,until,at}')::timestamptz < p_at
    ON CONFLICT (trip_id, kind) WHERE kind <> 'exception' DO NOTHING
    RETURNING *)
  INSERT INTO trucker.audit_entry (occurred_at, organisation_id, action, record_type, record_id, after_values)
  SELECT p_at, o, 'trip.case_opened', 'booking', b.id, jsonb_build_object('case', c.id, 'kind', c.kind)
  FROM opened c JOIN trucker.booking b ON b.id = c.booking_id,
       unnest(ARRAY[b.shipper_organisation_id, b.carrier_organisation_id]) o;
END
$function$;

-- ---------------------------------------------------------------------------------------------
-- Changed to see blocks and holds, and operations' entries
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trucker.booking_dispatch_blockers(b trucker.booking, p_at timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'trucker', 'pg_temp'
AS $function$
#variable_conflict use_column
DECLARE
  result jsonb := '[]'::jsonb;
  cur record;
  v_confirmed boolean := EXISTS (SELECT 1 FROM trucker.booking_confirmation c WHERE c.booking_id = b.id);
  v_failure jsonb;
  item record;
BEGIN
  IF EXISTS (SELECT 1 FROM trucker.booking_cancellation x WHERE x.booking_id=b.id) THEN
    RETURN '[{"code":"booking_cancelled"}]'::jsonb;
  END IF;
  -- Dispatched: nothing is left to block (slice 17).
  IF EXISTS (SELECT 1 FROM trucker.trip x WHERE x.booking_id = b.id) THEN
    RETURN '[]'::jsonb;
  END IF;
  SELECT * INTO cur FROM trucker.assignment_current(b.id);
  IF NOT v_confirmed THEN
    result := result || jsonb_build_object('code', 'not_confirmed');
  END IF;
  IF NOT v_confirmed AND NOT trucker.fee_settled(b.id) THEN
    result := result || jsonb_build_object('code', 'fee_not_paid');
  END IF;
  v_failure := trucker.assignment_set_check(b, cur.truck, cur.trailer, cur.affiliation, v_confirmed);
  IF v_failure IS NOT NULL THEN
    result := result || (jsonb_build_object('code', 'needs_reassignment') || v_failure);
  END IF;
  FOR item IN
    SELECT a.role, upper(r.planned) < p_at AS overrunning
    FROM trucker.booking_assignment a
    JOIN trucker.occupancy_episode e
      ON e.resource_id = coalesce(a.vehicle_id, a.person_id) AND e.closed_at IS NULL AND e.booking_id <> b.id
    JOIN trucker.resource_reservation r ON r.id = e.reservation_id
    WHERE a.booking_id = b.id AND a.status = 'active'
    ORDER BY a.role
  LOOP
    result := result || jsonb_build_object(
      'code', CASE WHEN item.overrunning THEN 'resource_overrunning' ELSE 'resource_occupied' END, 'role', item.role);
  END LOOP;
  IF cur.affiliation IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM trucker.assignment_acknowledgement k
       JOIN trucker.booking_assignment_state s ON s.booking_id = k.booking_id AND s.set_no = k.set_no
       WHERE k.booking_id = b.id AND k.person_id = cur.driver) THEN
    result := result || jsonb_build_object('code', 'acknowledgement_missing');
  END IF;
  -- A block by Trucker operations, with the reason the parties see (DB-9, DD-4).
  SELECT result || coalesce(jsonb_agg(jsonb_build_object('code', 'operations_block', 'reason', k.reason)), '[]'::jsonb)
  INTO result FROM trucker.dispatch_block k WHERE k.booking_id = b.id AND k.lifted_at IS NULL;
  RETURN result;
END
$function$;

CREATE OR REPLACE FUNCTION trucker.booking_view(b trucker.booking, p_audience text, p_at timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'trucker', 'pg_temp'
AS $function$
#variable_conflict use_column
DECLARE
  c trucker.booking_confirmation;
  w trucker.booking_wait_decision;
  s trucker.booking_substitution;
  cur record;
  v_set integer;
  v_blockers jsonb := trucker.booking_dispatch_blockers(b, p_at);
  v_shown jsonb;
  v_acknowledged timestamptz;
BEGIN
  IF EXISTS (SELECT 1 FROM trucker.booking_cancellation x WHERE x.booking_id = b.id) THEN
    RETURN trucker.booking_money(b, p_audience) || jsonb_build_object(
      'status','cancelled','confirmedAt',(SELECT x.confirmed_at FROM trucker.booking_confirmation x WHERE x.booking_id=b.id),
      'overdue',false,'waitDecision',NULL,'assignmentVersion',
      coalesce((SELECT x.set_no FROM trucker.booking_assignment_state x WHERE x.booking_id=b.id),0),
      'dispatch',jsonb_build_object('ready',false,'blockers',jsonb_build_array(jsonb_build_object('code','booking_cancelled'))),
      'needsReassignment',false,'atRisk',false,'acknowledgedAt',NULL,'resources',NULL,'substitution',NULL,'site',NULL,
      'vehicleChanges',trucker.vehicle_changes(b.id),
      'cancellation',trucker.cancellation_values(b.id,p_audience),
      'feePayment',trucker.fee_values(b,p_audience,p_at),
      'trip',NULL);
  END IF;
  SELECT * INTO c FROM trucker.booking_confirmation x WHERE x.booking_id = b.id;
  SELECT * INTO w FROM trucker.booking_wait_decision x WHERE x.booking_id = b.id;
  SELECT * INTO s FROM trucker.booking_substitution x WHERE x.booking_id = b.id AND x.status = 'proposed';
  SELECT * INTO cur FROM trucker.assignment_current(b.id);
  SELECT coalesce((SELECT x.set_no FROM trucker.booking_assignment_state x WHERE x.booking_id = b.id), 0) INTO v_set;
  SELECT k.acknowledged_at INTO v_acknowledged FROM trucker.assignment_acknowledgement k
  WHERE k.booking_id = b.id AND k.set_no = v_set AND k.person_id = cur.driver;
  -- The shipper is told that something blocks dispatch, not what is wrong with whose resource.
  IF p_audience = 'shipper' THEN
    SELECT coalesce(jsonb_agg(DISTINCT jsonb_build_object('code', x ->> 'code')
                              || CASE WHEN x ->> 'code' = 'operations_block'
                                      THEN jsonb_build_object('reason', x -> 'reason') ELSE '{}'::jsonb END),
                    '[]'::jsonb) INTO v_shown
    FROM jsonb_array_elements(v_blockers) AS x;
  ELSE
    v_shown := v_blockers;
  END IF;
  RETURN trucker.booking_money(b, p_audience) || jsonb_build_object(
    -- Whichever of the fee and the resources is still missing (R-14).
    'status', CASE WHEN c.booking_id IS NOT NULL THEN 'confirmed'
                   WHEN NOT trucker.fee_settled(b.id) AND trucker.assignment_ready(b) THEN 'awaiting_fee'
                   ELSE 'awaiting_resources' END,
    'confirmedAt', c.confirmed_at,
    'overdue', c.booking_id IS NULL AND p_at > b.assignment_due_at,
    'waitDecision', CASE WHEN w.booking_id IS NOT NULL THEN jsonb_build_object('decidedAt', w.decided_at) END,
    'assignmentVersion', v_set,
    -- Ready means nothing blocks it; whether it is time yet is dispatchFrom (DD-2). Once
    -- dispatched, the trip is shown instead (slice 17).
    'dispatch', jsonb_build_object(
      'ready', jsonb_array_length(v_blockers) = 0 AND NOT EXISTS (SELECT 1 FROM trucker.trip x WHERE x.booking_id = b.id),
      'blockers', v_shown),
    'dispatchFrom', b.planned_start_at - make_interval(hours => (SELECT g.dispatch_lead_hours FROM trucker.security_setting g)),
    'needsReassignment', v_blockers @> '[{"code": "needs_reassignment"}]'::jsonb,
    'atRisk', v_blockers @> '[{"code": "resource_overrunning"}]'::jsonb,
    'acknowledgedAt', v_acknowledged,
    'resources', CASE WHEN p_audience <> 'shipper' OR c.booking_id IS NOT NULL
                      THEN trucker.assignment_set_values(cur.truck, cur.trailer, cur.affiliation, p_audience) END,
    'substitution', CASE WHEN s.id IS NOT NULL THEN trucker.substitution_values(s, p_audience) END,
    'vehicleChanges', trucker.vehicle_changes(b.id),
    'site', CASE WHEN p_audience <> 'shipper' AND c.booking_id IS NOT NULL THEN c.site_details END,
    'feePayment', trucker.fee_values(b, p_audience, p_at),
    'trip', trucker.trip_values(b.id, p_audience));
END
$function$;

DROP FUNCTION trucker.trip_milestone_add(trucker.booking, integer, text, uuid, uuid, timestamptz, text, text,
                                         timestamptz);
CREATE FUNCTION trucker.trip_milestone_add(b trucker.booking, p_expected_version integer, p_milestone text, p_actor uuid, p_driver uuid, p_stated timestamp with time zone, p_reason text, p_note text, p_at timestamp with time zone, p_staff uuid DEFAULT NULL, OUT status text, OUT detail jsonb)
 RETURNS record
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'trucker', 'pg_temp'
AS $function$
#variable_conflict use_column
DECLARE
  tr trucker.trip;
  v_previous timestamptz;
  v_stated timestamptz := coalesce(p_stated, p_at);
  v_audience text := CASE WHEN p_staff IS NOT NULL THEN 'operations' WHEN p_reason IS NULL THEN 'driver' ELSE 'carrier' END;
BEGIN
  SELECT * INTO tr FROM trucker.trip x WHERE x.booking_id = b.id FOR UPDATE;
  IF NOT FOUND THEN
    status := 'not_dispatched';
    RETURN;
  END IF;
  -- A trip on hold accepts no milestone until it is resumed (EXC-4).
  IF EXISTS (SELECT 1 FROM trucker.trip_hold h WHERE h.trip_id = tr.id AND h.resumed_at IS NULL) THEN
    status := 'on_hold';
    detail := trucker.trip_values(b.id, v_audience);
    RETURN;
  END IF;
  -- A skipped or repeated step is refused with the current state (TRP-1).
  IF p_milestone IS DISTINCT FROM (trucker.trip_milestones())[tr.milestone_count + 1] THEN
    status := CASE WHEN p_milestone = ANY (trucker.trip_milestones()) THEN 'out_of_sequence' ELSE 'invalid' END;
    detail := trucker.trip_values(b.id, v_audience);
    RETURN;
  END IF;
  IF p_expected_version IS DISTINCT FROM tr.row_version THEN
    status := 'conflict';
    detail := trucker.trip_values(b.id, v_audience);
    RETURN;
  END IF;
  -- A stated time in the future is refused (TRP-3).
  IF v_stated > p_at THEN
    status := 'invalid';
    detail := jsonb_build_object('field', 'statedAt', 'code', 'future');
    RETURN;
  END IF;
  SELECT m.stated_at INTO v_previous FROM trucker.trip_milestone m
  WHERE m.trip_id = tr.id AND NOT EXISTS (SELECT 1 FROM trucker.trip_milestone_withdrawal w WHERE w.milestone_id = m.id)
  ORDER BY m.seq DESC LIMIT 1;
  INSERT INTO trucker.trip_milestone (trip_id, seq, milestone, stated_at, recorded_at, basis, driver_id, recorded_by,
                                      reason, note, needs_review, recorded_by_staff)
  VALUES (tr.id, tr.milestone_count + 1, p_milestone, v_stated, p_at,
          CASE WHEN p_reason IS NULL THEN 'observed' ELSE 'reported' END, p_driver, p_actor, p_reason, p_note,
          coalesce(v_stated < v_previous, false) OR v_stated < tr.dispatched_at, p_staff);
  UPDATE trucker.trip x SET milestone_count = milestone_count + 1, row_version = row_version + 1 WHERE x.id = tr.id;
  INSERT INTO trucker.audit_entry
    (occurred_at, actor_person_id, actor_staff_id, organisation_id, action, record_type, record_id, request_id,
     after_values)
  SELECT p_at, p_actor, p_staff, o, 'trip.milestone_recorded', 'booking', b.id,
         nullif(current_setting('trucker.request_id', true), ''),
         jsonb_build_object('milestone', p_milestone, 'statedAt', v_stated,
                            'basis', CASE WHEN p_reason IS NULL THEN 'observed' ELSE 'reported' END,
                            'onBehalfOf', CASE WHEN p_reason IS NOT NULL THEN p_driver END, 'reason', p_reason)
  FROM unnest(ARRAY[b.shipper_organisation_id, b.carrier_organisation_id]) o;
  status := 'recorded';
  detail := trucker.trip_values(b.id, v_audience);
END
$function$;

-- ---------------------------------------------------------------------------------------------
-- A party reports an exception (EXC-1)
-- ---------------------------------------------------------------------------------------------
-- The driver of the trip (as themselves), or an administrator of the carrier or of the shipper.
-- A repeated request with the same key returns the first case. Status: reported, repeated,
-- key_conflict, not_found, not_dispatched, unauthorized, invalid.
CREATE FUNCTION trucker.trip_exception_report(p_booking uuid, p_key text, p_content jsonb,
                                              OUT status text, OUT detail jsonb)
RETURNS record
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
DECLARE
  actor uuid := trucker.request_person();
  org uuid := trucker.request_organisation();
  b trucker.booking;
  tr trucker.trip;
  c trucker.trip_case;
  t timestamptz;
  v_as text;
  v_type text := p_content ->> 'type';
  v_description text := nullif(btrim(coalesce(p_content ->> 'description', '')), '');
  hash text;
  problems jsonb := '[]'::jsonb;
BEGIN
  IF actor IS NULL THEN
    status := 'unauthorized';
    RETURN;
  END IF;
  SELECT * INTO b FROM trucker.booking x WHERE x.id = p_booking;
  IF NOT FOUND THEN
    status := 'not_found';
    RETURN;
  END IF;
  v_as := CASE WHEN org IS NULL AND trucker.trip_driver_of(b) = actor THEN 'driver'
               WHEN org = b.carrier_organisation_id AND trucker.is_admin(org) THEN 'carrier'
               WHEN org = b.shipper_organisation_id AND trucker.is_admin(org) THEN 'shipper' END;
  IF v_as IS NULL THEN
    status := 'not_found';
    RETURN;
  END IF;
  IF p_key IS NULL OR p_key !~ '^[A-Za-z0-9._-]{16,128}$' THEN
    status := 'invalid';
    detail := jsonb_build_array(jsonb_build_object('field', 'key', 'code', 'invalid'));
    RETURN;
  END IF;
  IF v_type IS NULL OR NOT v_type = ANY (trucker.exception_types()) THEN
    problems := problems || jsonb_build_object('field', 'type', 'code', 'invalid');
  END IF;
  IF v_description IS NULL OR char_length(v_description) > 2000 THEN
    problems := problems || jsonb_build_object('field', 'description',
                                               'code', CASE WHEN v_description IS NULL THEN 'required' ELSE 'too_long' END);
  END IF;
  IF jsonb_array_length(problems) > 0 THEN
    status := 'invalid';
    detail := problems;
    RETURN;
  END IF;
  hash := trucker.content_hash(jsonb_build_object('booking', b.id, 'type', v_type, 'description', v_description));
  SELECT * INTO tr FROM trucker.trip x WHERE x.booking_id = b.id FOR UPDATE;
  IF NOT FOUND THEN
    status := 'not_dispatched';
    RETURN;
  END IF;
  t := trucker.clock_now();
  -- Still the same person in the same place once the trip is locked.
  IF trucker.request_person() IS DISTINCT FROM actor
     OR (v_as = 'driver' AND trucker.trip_driver_of(b) IS DISTINCT FROM actor)
     OR (v_as <> 'driver' AND NOT trucker.is_admin(org)) THEN
    status := 'not_found';
    RETURN;
  END IF;
  SELECT * INTO c FROM trucker.trip_case x WHERE x.reported_by = actor AND x.report_key = p_key;
  IF FOUND THEN
    status := CASE WHEN c.report_hash = hash THEN 'repeated' ELSE 'key_conflict' END;
    detail := CASE WHEN status = 'repeated' THEN trucker.trip_case_values(c, v_as) END;
    RETURN;
  END IF;
  INSERT INTO trucker.trip_case (trip_id, booking_id, kind, exception_type, description, reported_as, reported_by,
                                 reported_at, report_key, report_hash)
  VALUES (tr.id, b.id, 'exception', v_type, v_description, v_as, actor, t, p_key, hash)
  RETURNING * INTO c;
  INSERT INTO trucker.audit_entry
    (occurred_at, actor_person_id, organisation_id, action, record_type, record_id, request_id, after_values)
  SELECT t, actor, o, 'trip.exception_reported', 'booking', b.id,
         nullif(current_setting('trucker.request_id', true), ''),
         jsonb_build_object('case', c.id, 'type', v_type, 'reportedAs', v_as)
  FROM unnest(ARRAY[b.shipper_organisation_id, b.carrier_organisation_id]) o;
  status := 'reported';
  detail := trucker.trip_case_values(c, v_as);
END
$$;

-- ---------------------------------------------------------------------------------------------
-- Operations
-- ---------------------------------------------------------------------------------------------
-- A history entry on the booking for both parties, with the staff member as the actor.
CREATE FUNCTION trucker.operations_audit(p_at timestamptz, p_staff uuid, b trucker.booking, p_action text,
                                         p_after jsonb) RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
  INSERT INTO trucker.audit_entry
    (occurred_at, actor_staff_id, organisation_id, action, record_type, record_id, request_id, after_values)
  SELECT p_at, p_staff, o, p_action, 'booking', b.id, nullif(current_setting('trucker.request_id', true), ''), p_after
  FROM unnest(ARRAY[b.shipper_organisation_id, b.carrier_organisation_id]) o
$$;

-- Everything operations sees of one booking: the parties, the plan, the dispatch blockers, the
-- block in force and past ones, the trip with its hold and withdrawn milestones, and its cases.
CREATE FUNCTION trucker.operations_booking_values(b trucker.booking, p_at timestamptz) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
  SELECT jsonb_build_object(
    'id', b.id,
    'shipper', (SELECT jsonb_build_object('id', o.id, 'legalName', o.legal_name) FROM trucker.organisation o
                WHERE o.id = b.shipper_organisation_id),
    'carrier', (SELECT jsonb_build_object('id', o.id, 'legalName', o.legal_name) FROM trucker.organisation o
                WHERE o.id = b.carrier_organisation_id),
    'plannedReservation', jsonb_build_object('startAt', b.planned_start_at, 'endAt', b.planned_end_at),
    'cancelled', EXISTS (SELECT 1 FROM trucker.booking_cancellation x WHERE x.booking_id = b.id),
    'confirmed', EXISTS (SELECT 1 FROM trucker.booking_confirmation x WHERE x.booking_id = b.id),
    'blockers', trucker.booking_dispatch_blockers(b, p_at),
    'blocks', coalesce((SELECT jsonb_agg(jsonb_build_object(
                          'reason', k.reason, 'note', k.note, 'blockedAt', k.blocked_at,
                          'blockedBy', (SELECT a.display_name FROM trucker.staff_account a WHERE a.id = k.blocked_by),
                          'liftedAt', k.lifted_at, 'liftNote', k.lift_note,
                          'liftedBy', (SELECT a.display_name FROM trucker.staff_account a WHERE a.id = k.lifted_by))
                        ORDER BY k.blocked_at DESC)
                        FROM trucker.dispatch_block k WHERE k.booking_id = b.id), '[]'::jsonb),
    'trip', trucker.trip_values(b.id, 'operations'),
    'cases', coalesce((SELECT jsonb_agg(trucker.trip_case_values(c, 'operations') ORDER BY c.reported_at, c.id)
                       FROM trucker.trip_case c WHERE c.booking_id = b.id), '[]'::jsonb),
    -- Cases about earlier trips that put this booking at risk.
    'atRiskFrom', coalesce((SELECT jsonb_agg(l.case_id ORDER BY l.linked_at)
                            FROM trucker.trip_case_booking l WHERE l.booking_id = b.id), '[]'::jsonb))
$$;

-- The operations queue: every case not yet resolved, oldest first, and the latest resolved ones.
CREATE FUNCTION trucker.staff_operations_queue(p_token_hash text, p_request_id text,
                                               OUT status text, OUT detail jsonb)
RETURNS record
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
DECLARE
  e record;
BEGIN
  SELECT * INTO e FROM trucker.staff_enter(p_token_hash, 'operations', 'staff.operations.queue', NULL, p_request_id);
  status := e.status;
  IF status <> 'ok' THEN
    RETURN;
  END IF;
  PERFORM trucker.overrun_note(e.at);
  detail := jsonb_build_object(
    'open', coalesce((SELECT jsonb_agg(trucker.trip_case_values(c, 'operations') ORDER BY c.reported_at, c.id)
                      FROM trucker.trip_case c WHERE c.state <> 'resolved'), '[]'::jsonb),
    'resolved', coalesce((SELECT jsonb_agg(v ORDER BY (v ->> 'reportedAt') DESC)
                          FROM (SELECT trucker.trip_case_values(c, 'operations') AS v FROM trucker.trip_case c
                                WHERE c.state = 'resolved' ORDER BY c.reported_at DESC LIMIT 50) x), '[]'::jsonb),
    'blocks', coalesce((SELECT jsonb_agg(jsonb_build_object('bookingId', k.booking_id, 'reason', k.reason,
                                                            'blockedAt', k.blocked_at) ORDER BY k.blocked_at)
                        FROM trucker.dispatch_block k WHERE k.lifted_at IS NULL), '[]'::jsonb),
    'holds', coalesce((SELECT jsonb_agg(jsonb_build_object('bookingId', t.booking_id, 'reason', h.reason,
                                                           'heldAt', h.held_at) ORDER BY h.held_at)
                       FROM trucker.trip_hold h JOIN trucker.trip t ON t.id = h.trip_id
                       WHERE h.resumed_at IS NULL), '[]'::jsonb));
  PERFORM trucker.staff_audit(e.at, e.staff_id, 'staff.operations.queue', 'done', NULL, p_request_id, '{}'::jsonb);
END
$$;

-- One booking for operations.
CREATE FUNCTION trucker.staff_operations_booking(p_token_hash text, p_booking uuid, p_request_id text,
                                                 OUT status text, OUT detail jsonb)
RETURNS record
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
DECLARE
  e record;
  b trucker.booking;
BEGIN
  SELECT * INTO e FROM trucker.staff_enter(p_token_hash, 'operations', 'staff.operations.booking', NULL, p_request_id);
  status := e.status;
  IF status <> 'ok' THEN
    RETURN;
  END IF;
  SELECT * INTO b FROM trucker.booking x WHERE x.id = p_booking;
  IF NOT FOUND THEN
    status := 'not_found';
    RETURN;
  END IF;
  PERFORM trucker.overrun_note(e.at);
  detail := trucker.operations_booking_values(b, e.at);
  PERFORM trucker.staff_audit(e.at, e.staff_id, 'staff.operations.booking', 'done', NULL, p_request_id,
                              jsonb_build_object('booking', b.id));
END
$$;

-- Acknowledge a case, record an action on it, or resolve it (EXC-2). The note is required for an
-- action and for resolving. Status: acknowledged, recorded, resolved, conflict, not_open,
-- not_found, unauthorized, forbidden, invalid.
CREATE FUNCTION trucker.staff_case_act(p_token_hash text, p_case uuid, p_expected_version integer, p_action text,
                                       p_note text, p_request_id text, OUT status text, OUT detail jsonb)
RETURNS record
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
DECLARE
  e record;
  c trucker.trip_case;
  b trucker.booking;
  t timestamptz;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_state text;
BEGIN
  SELECT * INTO e FROM trucker.staff_enter(p_token_hash, 'operations', 'staff.operations.case', NULL, p_request_id);
  status := e.status;
  IF status <> 'ok' THEN
    RETURN;
  END IF;
  SELECT * INTO c FROM trucker.trip_case x WHERE x.id = p_case;
  IF NOT FOUND THEN
    status := 'not_found';
    RETURN;
  END IF;
  IF p_action IS NULL OR p_action NOT IN ('acknowledge', 'action', 'resolve') THEN
    status := 'invalid';
    detail := jsonb_build_array(jsonb_build_object('field', 'action', 'code', 'invalid'));
    RETURN;
  END IF;
  IF (p_action <> 'acknowledge' AND v_note IS NULL) OR char_length(coalesce(v_note, '')) > 2000 THEN
    status := 'invalid';
    detail := jsonb_build_array(jsonb_build_object('field', 'note',
                                                   'code', CASE WHEN v_note IS NULL THEN 'required' ELSE 'too_long' END));
    RETURN;
  END IF;
  SELECT * INTO c FROM trucker.trip_case x WHERE x.id = p_case FOR UPDATE;
  t := trucker.clock_now();
  IF (p_action = 'acknowledge' AND c.state <> 'open') OR (p_action <> 'acknowledge' AND c.state <> 'acknowledged') THEN
    status := 'not_open';
    detail := trucker.trip_case_values(c, 'operations');
    RETURN;
  END IF;
  IF p_expected_version IS DISTINCT FROM c.row_version THEN
    status := 'conflict';
    detail := trucker.trip_case_values(c, 'operations');
    RETURN;
  END IF;
  v_state := CASE p_action WHEN 'resolve' THEN 'resolved' ELSE 'acknowledged' END;
  UPDATE trucker.trip_case x SET state = v_state, row_version = row_version + 1 WHERE x.id = c.id RETURNING * INTO c;
  INSERT INTO trucker.trip_case_event (case_id, action, staff_id, at, note)
  VALUES (c.id, CASE p_action WHEN 'acknowledge' THEN 'acknowledged' WHEN 'resolve' THEN 'resolved' ELSE 'action' END,
          e.staff_id, t, v_note);
  -- The parties' history shows the state, never the note (EXC-5).
  IF p_action <> 'action' THEN
    SELECT * INTO b FROM trucker.booking x WHERE x.id = c.booking_id;
    PERFORM trucker.operations_audit(t, e.staff_id, b, 'trip.case_updated',
                                     jsonb_build_object('case', c.id, 'state', c.state));
  END IF;
  PERFORM trucker.staff_audit(t, e.staff_id, 'staff.operations.case', 'done', NULL, p_request_id,
                              jsonb_build_object('case', c.id, 'action', p_action));
  status := CASE p_action WHEN 'acknowledge' THEN 'acknowledged' WHEN 'resolve' THEN 'resolved' ELSE 'recorded' END;
  detail := trucker.trip_case_values(c, 'operations');
END
$$;

-- Blocks a dispatch, or lifts the block in force (DB-9, DD-4). Only before dispatch: taken
-- under the same locks as a dispatch, so the two never cross. Status: blocked, lifted,
-- already_blocked, not_blocked, already_dispatched, cancelled, not_found, unauthorized,
-- forbidden, invalid.
CREATE FUNCTION trucker.staff_dispatch_block(p_token_hash text, p_booking uuid, p_block boolean, p_reason text,
                                             p_note text, p_request_id text, OUT status text, OUT detail jsonb)
RETURNS record
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
DECLARE
  e record;
  b trucker.booking;
  t timestamptz;
  k trucker.dispatch_block;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  problems jsonb := '[]'::jsonb;
BEGIN
  SELECT * INTO e FROM trucker.staff_enter(p_token_hash, 'operations', 'staff.operations.block', NULL, p_request_id);
  status := e.status;
  IF status <> 'ok' THEN
    RETURN;
  END IF;
  SELECT * INTO b FROM trucker.booking x WHERE x.id = p_booking;
  IF NOT FOUND THEN
    status := 'not_found';
    RETURN;
  END IF;
  IF p_block IS NULL THEN
    problems := problems || jsonb_build_object('field', 'block', 'code', 'invalid');
  END IF;
  IF p_block AND (p_reason IS NULL OR NOT p_reason = ANY (trucker.operations_reasons())) THEN
    problems := problems || jsonb_build_object('field', 'reason', 'code', 'invalid');
  END IF;
  IF v_note IS NULL OR char_length(v_note) > 1000 THEN
    problems := problems || jsonb_build_object('field', 'note',
                                               'code', CASE WHEN v_note IS NULL THEN 'required' ELSE 'too_long' END);
  END IF;
  IF jsonb_array_length(problems) > 0 THEN
    status := 'invalid';
    detail := problems;
    RETURN;
  END IF;
  -- The same locks, in the same order, as a dispatch and a cancellation.
  PERFORM trucker.booking_lock_set(b);
  t := trucker.clock_now();
  SELECT * INTO k FROM trucker.dispatch_block x WHERE x.booking_id = b.id AND x.lifted_at IS NULL;
  IF p_block THEN
    IF EXISTS (SELECT 1 FROM trucker.booking_cancellation x WHERE x.booking_id = b.id) THEN
      status := 'cancelled';
    ELSIF EXISTS (SELECT 1 FROM trucker.trip x WHERE x.booking_id = b.id) THEN
      status := 'already_dispatched';
    ELSIF k.id IS NOT NULL THEN
      status := 'already_blocked';
    END IF;
    IF status <> 'ok' THEN
      detail := trucker.operations_booking_values(b, t);
      RETURN;
    END IF;
    INSERT INTO trucker.dispatch_block (booking_id, reason, note, blocked_by, blocked_at)
    VALUES (b.id, p_reason, v_note, e.staff_id, t);
    PERFORM trucker.operations_audit(t, e.staff_id, b, 'booking.dispatch_blocked', jsonb_build_object('reason', p_reason));
    status := 'blocked';
  ELSE
    IF k.id IS NULL THEN
      status := 'not_blocked';
      detail := trucker.operations_booking_values(b, t);
      RETURN;
    END IF;
    UPDATE trucker.dispatch_block x SET lifted_by = e.staff_id, lifted_at = t, lift_note = v_note WHERE x.id = k.id;
    PERFORM trucker.operations_audit(t, e.staff_id, b, 'booking.dispatch_unblocked', jsonb_build_object('reason', k.reason));
    status := 'lifted';
  END IF;
  PERFORM trucker.staff_audit(t, e.staff_id, 'staff.operations.block', 'done', NULL, p_request_id,
                              jsonb_build_object('booking', b.id, 'block', p_block, 'reason', p_reason));
  detail := trucker.operations_booking_values(b, t);
END
$$;

-- Puts a trip on hold, or resumes it (EXC-4). Status: held, resumed, already_held, not_held,
-- not_dispatched, not_found, unauthorized, forbidden, invalid.
CREATE FUNCTION trucker.staff_trip_hold(p_token_hash text, p_booking uuid, p_hold boolean, p_reason text,
                                        p_note text, p_request_id text, OUT status text, OUT detail jsonb)
RETURNS record
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
DECLARE
  e record;
  b trucker.booking;
  tr trucker.trip;
  h trucker.trip_hold;
  t timestamptz;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  problems jsonb := '[]'::jsonb;
BEGIN
  SELECT * INTO e FROM trucker.staff_enter(p_token_hash, 'operations', 'staff.operations.hold', NULL, p_request_id);
  status := e.status;
  IF status <> 'ok' THEN
    RETURN;
  END IF;
  SELECT * INTO b FROM trucker.booking x WHERE x.id = p_booking;
  IF NOT FOUND THEN
    status := 'not_found';
    RETURN;
  END IF;
  IF p_hold IS NULL THEN
    problems := problems || jsonb_build_object('field', 'hold', 'code', 'invalid');
  END IF;
  IF p_hold AND (p_reason IS NULL OR NOT p_reason = ANY (trucker.operations_reasons())) THEN
    problems := problems || jsonb_build_object('field', 'reason', 'code', 'invalid');
  END IF;
  IF v_note IS NULL OR char_length(v_note) > 1000 THEN
    problems := problems || jsonb_build_object('field', 'note',
                                               'code', CASE WHEN v_note IS NULL THEN 'required' ELSE 'too_long' END);
  END IF;
  IF jsonb_array_length(problems) > 0 THEN
    status := 'invalid';
    detail := problems;
    RETURN;
  END IF;
  SELECT * INTO tr FROM trucker.trip x WHERE x.booking_id = b.id FOR UPDATE;
  IF NOT FOUND THEN
    status := 'not_dispatched';
    RETURN;
  END IF;
  t := trucker.clock_now();
  SELECT * INTO h FROM trucker.trip_hold x WHERE x.trip_id = tr.id AND x.resumed_at IS NULL;
  IF p_hold THEN
    IF h.id IS NOT NULL THEN
      status := 'already_held';
      detail := trucker.operations_booking_values(b, t);
      RETURN;
    END IF;
    INSERT INTO trucker.trip_hold (trip_id, reason, note, held_by, held_at) VALUES (tr.id, p_reason, v_note, e.staff_id, t);
    PERFORM trucker.operations_audit(t, e.staff_id, b, 'trip.held', jsonb_build_object('reason', p_reason));
    status := 'held';
  ELSE
    IF h.id IS NULL THEN
      status := 'not_held';
      detail := trucker.operations_booking_values(b, t);
      RETURN;
    END IF;
    UPDATE trucker.trip_hold x SET resumed_by = e.staff_id, resumed_at = t, resume_note = v_note WHERE x.id = h.id;
    PERFORM trucker.operations_audit(t, e.staff_id, b, 'trip.resumed', jsonb_build_object('reason', h.reason));
    status := 'resumed';
  END IF;
  PERFORM trucker.staff_audit(t, e.staff_id, 'staff.operations.hold', 'done', NULL, p_request_id,
                              jsonb_build_object('booking', b.id, 'hold', p_hold, 'reason', p_reason));
  detail := trucker.operations_booking_values(b, t);
END
$$;

-- Records the next milestone on the driver's behalf (DD-6), as the carrier's administrator can.
-- Status as trip_milestone_on_behalf, and forbidden.
CREATE FUNCTION trucker.staff_milestone_on_behalf(p_token_hash text, p_booking uuid, p_expected_version integer,
                                                  p_content jsonb, p_request_id text,
                                                  OUT status text, OUT detail jsonb)
RETURNS record
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
DECLARE
  e record;
  b trucker.booking;
  r record;
  t timestamptz;
  v_driver uuid;
  v_reason text := p_content ->> 'reason';
  v_note text := nullif(btrim(coalesce(p_content ->> 'note', '')), '');
  v_stated timestamptz;
BEGIN
  SELECT * INTO e FROM trucker.staff_enter(p_token_hash, 'operations', 'staff.operations.milestone', NULL, p_request_id);
  status := e.status;
  IF status <> 'ok' THEN
    RETURN;
  END IF;
  SELECT * INTO b FROM trucker.booking x WHERE x.id = p_booking;
  IF NOT FOUND THEN
    status := 'not_found';
    RETURN;
  END IF;
  BEGIN
    v_stated := (p_content ->> 'statedAt')::timestamptz;
  EXCEPTION WHEN others THEN
    v_stated := NULL;
  END;
  IF v_stated IS NULL OR v_reason IS NULL
     OR v_reason NOT IN ('no_phone', 'no_signal', 'driver_unable', 'correction', 'other')
     OR (v_reason = 'other' AND v_note IS NULL) OR char_length(coalesce(v_note, '')) > 500 THEN
    status := 'invalid';
    detail := jsonb_build_object('field', CASE WHEN v_stated IS NULL THEN 'statedAt'
                                               WHEN v_reason IS NULL OR v_reason NOT IN ('no_phone', 'no_signal',
                                                    'driver_unable', 'correction', 'other') THEN 'reason'
                                               ELSE 'note' END, 'code', 'invalid');
    RETURN;
  END IF;
  PERFORM 1 FROM trucker.trip x WHERE x.booking_id = b.id FOR UPDATE;
  t := trucker.clock_now();
  v_driver := (SELECT a.person_id FROM trucker.booking_assignment a
               WHERE a.booking_id = b.id AND a.role = 'driver' AND a.status = 'active');
  IF v_driver IS NULL THEN
    status := CASE WHEN EXISTS (SELECT 1 FROM trucker.trip x WHERE x.booking_id = b.id)
                   THEN 'not_found' ELSE 'not_dispatched' END;
    RETURN;
  END IF;
  SELECT * INTO r FROM trucker.trip_milestone_add(b, p_expected_version, p_content ->> 'milestone', NULL, v_driver,
                                                  v_stated, v_reason, v_note, t, e.staff_id);
  status := r.status;
  detail := r.detail;
  IF status = 'recorded' THEN
    PERFORM trucker.staff_audit(t, e.staff_id, 'staff.operations.milestone', 'done', NULL, p_request_id,
                                jsonb_build_object('booking', b.id, 'milestone', p_content ->> 'milestone'));
  END IF;
END
$$;

-- Withdraws the latest milestone in force, recorded by mistake; the trip goes back one step and
-- the milestone stays in the record as withdrawn. Status: withdrawn, conflict, nothing_to_withdraw,
-- not_dispatched, not_found, unauthorized, forbidden, invalid.
CREATE FUNCTION trucker.staff_milestone_withdraw(p_token_hash text, p_booking uuid, p_expected_version integer,
                                                 p_note text, p_request_id text, OUT status text, OUT detail jsonb)
RETURNS record
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
DECLARE
  e record;
  b trucker.booking;
  tr trucker.trip;
  m trucker.trip_milestone;
  t timestamptz;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
BEGIN
  SELECT * INTO e FROM trucker.staff_enter(p_token_hash, 'operations', 'staff.operations.withdraw', NULL, p_request_id);
  status := e.status;
  IF status <> 'ok' THEN
    RETURN;
  END IF;
  SELECT * INTO b FROM trucker.booking x WHERE x.id = p_booking;
  IF NOT FOUND THEN
    status := 'not_found';
    RETURN;
  END IF;
  IF v_note IS NULL OR char_length(v_note) > 1000 THEN
    status := 'invalid';
    detail := jsonb_build_array(jsonb_build_object('field', 'note',
                                                   'code', CASE WHEN v_note IS NULL THEN 'required' ELSE 'too_long' END));
    RETURN;
  END IF;
  SELECT * INTO tr FROM trucker.trip x WHERE x.booking_id = b.id FOR UPDATE;
  IF NOT FOUND THEN
    status := 'not_dispatched';
    RETURN;
  END IF;
  t := trucker.clock_now();
  IF p_expected_version IS DISTINCT FROM tr.row_version THEN
    status := 'conflict';
    detail := trucker.trip_values(b.id, 'operations');
    RETURN;
  END IF;
  SELECT * INTO m FROM trucker.trip_milestone x
  WHERE x.trip_id = tr.id AND x.seq = tr.milestone_count
    AND NOT EXISTS (SELECT 1 FROM trucker.trip_milestone_withdrawal w WHERE w.milestone_id = x.id);
  IF NOT FOUND THEN
    status := 'nothing_to_withdraw';
    detail := trucker.trip_values(b.id, 'operations');
    RETURN;
  END IF;
  INSERT INTO trucker.trip_milestone_withdrawal (milestone_id, trip_id, withdrawn_by, withdrawn_at, note)
  VALUES (m.id, tr.id, e.staff_id, t, v_note);
  UPDATE trucker.trip x SET milestone_count = milestone_count - 1, row_version = row_version + 1 WHERE x.id = tr.id;
  PERFORM trucker.operations_audit(t, e.staff_id, b, 'trip.milestone_withdrawn',
                                   jsonb_build_object('milestone', m.milestone, 'statedAt', m.stated_at));
  PERFORM trucker.staff_audit(t, e.staff_id, 'staff.operations.withdraw', 'done', NULL, p_request_id,
                              jsonb_build_object('booking', b.id, 'milestone', m.milestone));
  status := 'withdrawn';
  detail := trucker.trip_values(b.id, 'operations');
END
$$;

-- The watch, run by the API's job: records what the clock now shows (EXC-3, DD-9). Returns how
-- many cases it opened.
CREATE FUNCTION trucker.trip_watch() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
DECLARE
  before_count bigint := (SELECT count(*) FROM trucker.trip_case WHERE kind <> 'exception');
BEGIN
  PERFORM trucker.overrun_note(trucker.clock_now());
  RETURN (SELECT count(*) FROM trucker.trip_case WHERE kind <> 'exception') - before_count;
END
$$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA trucker FROM PUBLIC;
GRANT EXECUTE ON FUNCTION trucker.trip_exception_report(uuid, text, jsonb) TO trucker_app;
GRANT EXECUTE ON FUNCTION trucker.staff_operations_queue(text, text) TO trucker_app;
GRANT EXECUTE ON FUNCTION trucker.staff_operations_booking(text, uuid, text) TO trucker_app;
GRANT EXECUTE ON FUNCTION trucker.staff_case_act(text, uuid, integer, text, text, text) TO trucker_app;
GRANT EXECUTE ON FUNCTION trucker.staff_dispatch_block(text, uuid, boolean, text, text, text) TO trucker_app;
GRANT EXECUTE ON FUNCTION trucker.staff_trip_hold(text, uuid, boolean, text, text, text) TO trucker_app;
GRANT EXECUTE ON FUNCTION trucker.staff_milestone_on_behalf(text, uuid, integer, jsonb, text) TO trucker_app;
GRANT EXECUTE ON FUNCTION trucker.staff_milestone_withdraw(text, uuid, integer, text, text) TO trucker_app;
GRANT EXECUTE ON FUNCTION trucker.trip_watch() TO trucker_app;
