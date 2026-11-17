-- 0028: dispatch and the trip's milestones (slice 17a).
--
-- The carrier's administrator dispatches a confirmed booking (DB-9, DD-1: one step). After the
-- same locks, in the same order, as a cancellation, the database judges every precondition now,
-- and in the same transaction opens an occupancy episode for each assigned resource and
-- creates the trip. Nothing here closes an episode: release is slice 18.
--
-- The driver records milestones in their fixed order (DD-5); the carrier's administrator may
-- record one on the driver's behalf, with a reason and the stated time, which is then marked as
-- reported, not observed (DB-11, E-4, DD-6). The driver or the carrier's administrator states
-- an estimated arrival at delivery (DD-7). The shipper sees the milestones and the latest
-- estimate; the driver sees the addresses, access notes and the shipper's name from dispatch
-- on, never the price or the fee (N-5, DD-8). No location is collected (DB-10).
--
-- Development defaults, not approved for production: DD-1 to DD-10 (DISPATCH_SLICE_17_SCOPE.md).

ALTER TABLE trucker.security_setting
  ADD COLUMN dispatch_lead_hours integer NOT NULL DEFAULT 12 CHECK (dispatch_lead_hours BETWEEN 1 AND 72);

-- ---------------------------------------------------------------------------------------------
-- The trip
-- ---------------------------------------------------------------------------------------------
CREATE TABLE trucker.trip (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id uuid NOT NULL UNIQUE REFERENCES trucker.booking (id),
  -- The assigned set that was dispatched.
  set_no integer NOT NULL,
  dispatched_by uuid NOT NULL REFERENCES trucker.person (id),
  dispatched_at timestamptz NOT NULL,
  -- Dispatched after the planned start: allowed, and shown as late (DD-2).
  late boolean NOT NULL,
  dispatch_key text NOT NULL,
  dispatch_hash text NOT NULL,
  milestone_count integer NOT NULL DEFAULT 0 CHECK (milestone_count BETWEEN 0 AND 6),
  row_version integer NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  UNIQUE (dispatched_by, dispatch_key)
);

CREATE FUNCTION trucker.guard_trip() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, trucker, pg_temp AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND (NEW.id, NEW.booking_id, NEW.set_no, NEW.dispatched_by, NEW.dispatched_at, NEW.late, NEW.dispatch_key,
          NEW.dispatch_hash)
         IS NOT DISTINCT FROM
         (OLD.id, OLD.booking_id, OLD.set_no, OLD.dispatched_by, OLD.dispatched_at, OLD.late, OLD.dispatch_key,
          OLD.dispatch_hash)
     AND NEW.milestone_count = OLD.milestone_count + 1 AND NEW.row_version = OLD.row_version + 1 THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'a trip is never removed, and only moves to its next milestone' USING ERRCODE = 'check_violation';
END
$$;
CREATE TRIGGER trip_guard BEFORE UPDATE OR DELETE ON trucker.trip FOR EACH ROW EXECUTE FUNCTION trucker.guard_trip();
CREATE TRIGGER trip_truncate_guard BEFORE TRUNCATE ON trucker.trip
  FOR EACH STATEMENT EXECUTE FUNCTION trucker.guard_trip();

-- The milestones of Release 1, in their only order (DD-5). The delivery outcome is slice 18.
CREATE FUNCTION trucker.trip_milestones() RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT ARRAY['departed_for_pickup', 'arrived_at_pickup', 'loading_started', 'loaded_departed',
               'arrived_at_delivery', 'unloading_started']
$$;

CREATE TABLE trucker.trip_milestone (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id uuid NOT NULL REFERENCES trucker.trip (id),
  seq integer NOT NULL CHECK (seq BETWEEN 1 AND 6),
  milestone text NOT NULL,
  -- When it happened, as stated; and when it was recorded.
  stated_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL,
  -- Observed: the driver recorded it as it happened. Reported: entered on the driver's behalf.
  basis text NOT NULL CHECK (basis IN ('observed', 'reported')),
  -- Whom it is about, and who entered it.
  driver_id uuid NOT NULL REFERENCES trucker.person (id),
  recorded_by uuid NOT NULL REFERENCES trucker.person (id),
  reason text CHECK (reason IS NULL OR reason IN ('no_phone', 'no_signal', 'driver_unable', 'correction', 'other')),
  note text CHECK (note IS NULL OR char_length(note) BETWEEN 1 AND 1000),
  -- A stated time earlier than the previous milestone's: accepted, and marked for review.
  needs_review boolean NOT NULL DEFAULT false,
  UNIQUE (trip_id, seq),
  CONSTRAINT trip_milestone_order CHECK (milestone = (trucker.trip_milestones())[seq]),
  CONSTRAINT trip_milestone_basis CHECK ((basis = 'reported') = (reason IS NOT NULL)),
  CONSTRAINT trip_milestone_observed CHECK (basis = 'reported' OR (recorded_by = driver_id AND stated_at = recorded_at)),
  CONSTRAINT trip_milestone_other CHECK (reason IS DISTINCT FROM 'other' OR note IS NOT NULL),
  CONSTRAINT trip_milestone_not_future CHECK (stated_at <= recorded_at)
);

-- The estimated arrival at delivery, as stated. The latest one is shown (DD-7).
CREATE TABLE trucker.trip_estimate (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id uuid NOT NULL REFERENCES trucker.trip (id),
  arrival_at timestamptz NOT NULL,
  stated_by uuid NOT NULL REFERENCES trucker.person (id),
  stated_as text NOT NULL CHECK (stated_as IN ('driver', 'carrier')),
  stated_at timestamptz NOT NULL,
  seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE
);

CREATE FUNCTION trucker.guard_trip_record() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, trucker, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'a recorded milestone or estimate is never changed or removed' USING ERRCODE = 'check_violation';
END
$$;
CREATE TRIGGER trip_milestone_guard BEFORE UPDATE OR DELETE ON trucker.trip_milestone
  FOR EACH ROW EXECUTE FUNCTION trucker.guard_trip_record();
CREATE TRIGGER trip_milestone_truncate_guard BEFORE TRUNCATE ON trucker.trip_milestone
  FOR EACH STATEMENT EXECUTE FUNCTION trucker.guard_trip_record();
CREATE TRIGGER trip_estimate_guard BEFORE UPDATE OR DELETE ON trucker.trip_estimate
  FOR EACH ROW EXECUTE FUNCTION trucker.guard_trip_record();
CREATE TRIGGER trip_estimate_truncate_guard BEFORE TRUNCATE ON trucker.trip_estimate
  FOR EACH STATEMENT EXECUTE FUNCTION trucker.guard_trip_record();

ALTER TABLE trucker.trip ENABLE ROW LEVEL SECURITY;
ALTER TABLE trucker.trip_milestone ENABLE ROW LEVEL SECURITY;
ALTER TABLE trucker.trip_estimate ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON trucker.trip, trucker.trip_milestone, trucker.trip_estimate FROM trucker_app, PUBLIC;

-- After dispatch nothing changes the assigned set, its acknowledgement or a wait decision
-- (DSP-7). The functions refuse first; this holds for any other path.
CREATE FUNCTION trucker.guard_dispatched_booking() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, trucker, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM trucker.trip t WHERE t.booking_id = NEW.booking_id) THEN
    RAISE EXCEPTION 'this booking has been dispatched' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER booking_assignment_dispatched BEFORE INSERT OR UPDATE ON trucker.booking_assignment
  FOR EACH ROW EXECUTE FUNCTION trucker.guard_dispatched_booking();
CREATE TRIGGER booking_substitution_dispatched BEFORE INSERT OR UPDATE ON trucker.booking_substitution
  FOR EACH ROW EXECUTE FUNCTION trucker.guard_dispatched_booking();
CREATE TRIGGER assignment_acknowledgement_dispatched BEFORE INSERT OR UPDATE ON trucker.assignment_acknowledgement
  FOR EACH ROW EXECUTE FUNCTION trucker.guard_dispatched_booking();
CREATE TRIGGER booking_wait_decision_dispatched BEFORE INSERT OR UPDATE ON trucker.booking_wait_decision
  FOR EACH ROW EXECUTE FUNCTION trucker.guard_dispatched_booking();

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
    'trip.estimate_stated'));

-- ---------------------------------------------------------------------------------------------
-- What is shown
-- ---------------------------------------------------------------------------------------------
-- The trip, for the shipper, the carrier or the driver. Every milestone shows whom it is about,
-- who entered it and why, and whether its time is observed or reported (E-4).
CREATE FUNCTION trucker.trip_values(p_booking uuid, p_audience text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
  SELECT jsonb_build_object(
    'id', t.id, 'version', t.row_version, 'dispatchedAt', t.dispatched_at, 'late', t.late,
    'next', (trucker.trip_milestones())[t.milestone_count + 1],
    'milestones', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'milestone', m.milestone, 'statedAt', m.stated_at, 'recordedAt', m.recorded_at, 'basis', m.basis,
               'about', (SELECT p.display_name FROM trucker.person p WHERE p.id = m.driver_id),
               'enteredBy', CASE WHEN m.basis = 'reported'
                                 THEN (SELECT p.display_name FROM trucker.person p WHERE p.id = m.recorded_by) END,
               'reason', m.reason,
               -- The note stays with the carrier.
               'note', CASE WHEN p_audience = 'carrier' THEN m.note END,
               'needsReview', m.needs_review)
             ORDER BY m.seq)
      FROM trucker.trip_milestone m WHERE m.trip_id = t.id), '[]'::jsonb),
    'estimate', (SELECT jsonb_build_object('arrivalAt', e.arrival_at, 'statedAt', e.stated_at, 'statedAs', e.stated_as,
                                           'statedBy', (SELECT p.display_name FROM trucker.person p WHERE p.id = e.stated_by))
                 FROM trucker.trip_estimate e WHERE e.trip_id = t.id ORDER BY e.seq DESC LIMIT 1))
  FROM trucker.trip t WHERE t.booking_id = p_booking
$$;

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
    SELECT coalesce(jsonb_agg(DISTINCT jsonb_build_object('code', x ->> 'code')), '[]'::jsonb) INTO v_shown
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

CREATE OR REPLACE FUNCTION trucker.driver_assignments(p_allow_fixtures boolean, OUT status text, OUT detail jsonb)
 RETURNS record
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'trucker', 'pg_temp'
AS $function$
#variable_conflict use_column
DECLARE
  actor uuid := trucker.request_person();
BEGIN
  IF actor IS NULL THEN
    status := 'unauthorized';
    RETURN;
  END IF;
  status := 'ok';
  detail := coalesce((
    SELECT jsonb_agg(jsonb_build_object(
             'bookingId', b.id, 'version', s.set_no,
             'carrier', (SELECT jsonb_build_object('legalName', o.legal_name, 'tradingName', o.trading_name)
                         FROM trucker.organisation o WHERE o.id = b.carrier_organisation_id),
             'pickup', b.shipment_snapshot -> 'pickup', 'delivery', b.shipment_snapshot -> 'delivery',
             'cargo', b.shipment_snapshot -> 'cargo', 'equipment', b.shipment_snapshot -> 'equipment',
             'plannedReservation', jsonb_build_object('startAt', b.planned_start_at, 'endAt', b.planned_end_at),
             'truck', (SELECT trucker.assignment_vehicle_values(x.vehicle_id, 'shipper') FROM trucker.booking_assignment x
                       WHERE x.booking_id = b.id AND x.role = 'truck' AND x.status = 'active'),
             'trailer', (SELECT trucker.assignment_vehicle_values(x.vehicle_id, 'shipper') FROM trucker.booking_assignment x
                         WHERE x.booking_id = b.id AND x.role = 'trailer' AND x.status = 'active'),
             'acknowledgedAt', (SELECT k.acknowledged_at FROM trucker.assignment_acknowledgement k
                                WHERE k.booking_id = b.id AND k.set_no = s.set_no AND k.person_id = actor))
           -- From dispatch on: the trip, the addresses and access notes, and the shipper's name
           -- for the gate. Never the price or the fee (N-5, DD-8).
           || coalesce((SELECT jsonb_build_object(
                         'trip', trucker.trip_values(b.id, 'driver'),
                         'site', (SELECT c.site_details FROM trucker.booking_confirmation c WHERE c.booking_id = b.id),
                         'shipper', (SELECT jsonb_build_object('legalName', o.legal_name, 'tradingName', o.trading_name)
                                     FROM trucker.organisation o WHERE o.id = b.shipper_organisation_id))
                       FROM trucker.trip x WHERE x.booking_id = b.id), '{}'::jsonb)
           ORDER BY b.planned_start_at, b.id)
    FROM trucker.booking_assignment a
    JOIN trucker.booking b ON b.id = a.booking_id
    JOIN trucker.booking_assignment_state s ON s.booking_id = b.id
    JOIN trucker.driver_affiliation f ON f.id = a.affiliation_id
    WHERE a.role = 'driver' AND a.status = 'active' AND a.person_id = actor
      AND f.status = 'active' AND f.organisation_id = b.carrier_organisation_id
      AND trucker.booking_terms_available(p_allow_fixtures)), '[]'::jsonb);
END
$function$;

-- ---------------------------------------------------------------------------------------------
-- Dispatch
-- ---------------------------------------------------------------------------------------------
-- Only an administrator of the booking's carrier (DSP-1). The refusal names the first
-- precondition that fails, in the order of the booking page's blockers and then: an open
-- substitution (N-3), the parties' capabilities, the earliest dispatch time (DD-2). Status:
-- dispatched, repeated (the same request again), already_dispatched, refused (detail: code),
-- conflict, key_conflict, not_found, unauthorized, closed, invalid.
CREATE FUNCTION trucker.dispatch_booking(p_booking uuid, p_key text, p_allow_fixtures boolean,
                                         OUT status text, OUT detail jsonb)
RETURNS record
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
DECLARE
  actor uuid := trucker.request_person();
  org uuid := trucker.request_organisation();
  hash text := trucker.content_hash(jsonb_build_object('booking', p_booking));
  b trucker.booking;
  tr trucker.trip;
  t timestamptz;
  n integer;
  v_blockers jsonb;
  v_earliest timestamptz;
BEGIN
  IF actor IS NULL THEN
    status := 'unauthorized';
    RETURN;
  END IF;
  IF org IS NULL OR NOT trucker.is_admin(org) THEN
    status := 'not_found';
    RETURN;
  END IF;
  SELECT * INTO b FROM trucker.booking x WHERE x.id = p_booking AND x.carrier_organisation_id = org;
  IF NOT FOUND THEN
    status := 'not_found';
    RETURN;
  END IF;
  IF NOT trucker.booking_terms_available(p_allow_fixtures) THEN
    status := 'closed';
    RETURN;
  END IF;
  IF p_key IS NULL OR p_key !~ '^[A-Za-z0-9._-]{16,128}$' THEN
    status := 'invalid';
    RETURN;
  END IF;
  -- The same locks, in the same order, as a cancellation (slice 16).
  n := trucker.booking_lock_set(b);
  t := trucker.clock_now();
  IF trucker.request_person() IS DISTINCT FROM actor OR NOT trucker.is_admin(org) THEN
    status := 'unauthorized';
    RETURN;
  END IF;
  SELECT * INTO tr FROM trucker.trip x WHERE x.booking_id = b.id;
  IF FOUND THEN
    status := CASE WHEN tr.dispatched_by = actor AND tr.dispatch_key = p_key AND tr.dispatch_hash = hash
                   THEN 'repeated' ELSE 'already_dispatched' END;
    detail := trucker.trip_values(b.id, 'carrier');
    RETURN;
  END IF;
  -- A fee unpaid at its deadline lapsed the booking then, whatever is asked now.
  PERFORM trucker.fee_lapse_if_due(b, n, t);
  PERFORM trucker.overrun_note(t);
  v_blockers := trucker.booking_dispatch_blockers(b, t);
  IF jsonb_array_length(v_blockers) > 0 THEN
    status := 'refused';
    detail := v_blockers -> 0;
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM trucker.booking_substitution s WHERE s.booking_id = b.id AND s.status = 'proposed') THEN
    status := 'refused';
    detail := jsonb_build_object('code', 'substitution_open');
    RETURN;
  END IF;
  IF NOT trucker.organisation_publishable(b.shipper_organisation_id) THEN
    status := 'refused';
    detail := jsonb_build_object('code', 'capability_missing', 'party', 'shipper');
    RETURN;
  END IF;
  IF NOT trucker.is_carrier(b.carrier_organisation_id) THEN
    status := 'refused';
    detail := jsonb_build_object('code', 'capability_missing', 'party', 'carrier');
    RETURN;
  END IF;
  SELECT b.planned_start_at - make_interval(hours => g.dispatch_lead_hours) INTO v_earliest
  FROM trucker.security_setting g;
  IF t < v_earliest THEN
    status := 'refused';
    detail := jsonb_build_object('code', 'too_early', 'earliestAt', v_earliest);
    RETURN;
  END IF;
  BEGIN
    INSERT INTO trucker.trip (booking_id, set_no, dispatched_by, dispatched_at, late, dispatch_key, dispatch_hash)
    VALUES (b.id, n, actor, t, t > b.planned_start_at, p_key, hash)
    RETURNING * INTO tr;
  EXCEPTION WHEN unique_violation THEN
    status := 'key_conflict';
    RETURN;
  END;
  -- One episode for each assigned resource. A resource has at most one open episode: the
  -- database refuses a second.
  INSERT INTO trucker.occupancy_episode (resource_kind, vehicle_id, person_id, booking_id, reservation_id, opened_at)
  SELECT r.resource_kind, r.vehicle_id, r.person_id, b.id, r.id, t
  FROM trucker.booking_assignment a JOIN trucker.resource_reservation r ON r.id = a.reservation_id
  WHERE a.booking_id = b.id AND a.status = 'active' AND r.status = 'active'
  ORDER BY r.resource_id;
  INSERT INTO trucker.audit_entry
    (occurred_at, actor_person_id, organisation_id, action, record_type, record_id, request_id, after_values)
  SELECT t, actor, o, 'booking.dispatched', 'booking', b.id, nullif(current_setting('trucker.request_id', true), ''),
         jsonb_build_object('trip', tr.id, 'late', tr.late, 'set', n)
  FROM unnest(ARRAY[b.shipper_organisation_id, b.carrier_organisation_id]) o;
  status := 'dispatched';
  detail := trucker.trip_values(b.id, 'carrier');
END
$$;

-- ---------------------------------------------------------------------------------------------
-- Milestones
-- ---------------------------------------------------------------------------------------------
-- The next milestone, or the refusal. Locks the trip; the caller has checked who may record.
CREATE FUNCTION trucker.trip_milestone_add(b trucker.booking, p_expected_version integer, p_milestone text,
                                           p_actor uuid, p_driver uuid, p_stated timestamptz, p_reason text,
                                           p_note text, p_at timestamptz, OUT status text, OUT detail jsonb)
RETURNS record
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
DECLARE
  tr trucker.trip;
  v_previous timestamptz;
  v_stated timestamptz := coalesce(p_stated, p_at);
  v_audience text := CASE WHEN p_reason IS NULL THEN 'driver' ELSE 'carrier' END;
BEGIN
  SELECT * INTO tr FROM trucker.trip x WHERE x.booking_id = b.id FOR UPDATE;
  IF NOT FOUND THEN
    status := 'not_dispatched';
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
  SELECT m.stated_at INTO v_previous FROM trucker.trip_milestone m WHERE m.trip_id = tr.id ORDER BY m.seq DESC LIMIT 1;
  INSERT INTO trucker.trip_milestone (trip_id, seq, milestone, stated_at, recorded_at, basis, driver_id, recorded_by,
                                      reason, note, needs_review)
  VALUES (tr.id, tr.milestone_count + 1, p_milestone, v_stated, p_at,
          CASE WHEN p_reason IS NULL THEN 'observed' ELSE 'reported' END, p_driver, p_actor, p_reason, p_note,
          coalesce(v_stated < v_previous, false) OR v_stated < tr.dispatched_at);
  UPDATE trucker.trip x SET milestone_count = milestone_count + 1, row_version = row_version + 1 WHERE x.id = tr.id;
  INSERT INTO trucker.audit_entry
    (occurred_at, actor_person_id, organisation_id, action, record_type, record_id, request_id, after_values)
  SELECT p_at, p_actor, o, 'trip.milestone_recorded', 'booking', b.id,
         nullif(current_setting('trucker.request_id', true), ''),
         jsonb_build_object('milestone', p_milestone, 'statedAt', v_stated,
                            'basis', CASE WHEN p_reason IS NULL THEN 'observed' ELSE 'reported' END,
                            'onBehalfOf', CASE WHEN p_reason IS NOT NULL THEN p_driver END, 'reason', p_reason)
  FROM unnest(ARRAY[b.shipper_organisation_id, b.carrier_organisation_id]) o;
  status := 'recorded';
  detail := trucker.trip_values(b.id, v_audience);
END
$$;

-- The booking's assigned driver, while affiliated with its carrier (TRP-2).
CREATE FUNCTION trucker.trip_driver_of(b trucker.booking) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
  SELECT a.person_id FROM trucker.booking_assignment a JOIN trucker.driver_affiliation f ON f.id = a.affiliation_id
  WHERE a.booking_id = b.id AND a.role = 'driver' AND a.status = 'active'
    AND f.status = 'active' AND f.organisation_id = b.carrier_organisation_id
$$;

-- The driver records a milestone as it happens.
CREATE FUNCTION trucker.trip_milestone_by_driver(p_booking uuid, p_expected_version integer, p_milestone text,
                                                 OUT status text, OUT detail jsonb)
RETURNS record
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
DECLARE
  actor uuid := trucker.request_person();
  b trucker.booking;
  t timestamptz;
  r record;
BEGIN
  IF actor IS NULL THEN
    status := 'unauthorized';
    RETURN;
  END IF;
  SELECT * INTO b FROM trucker.booking x WHERE x.id = p_booking;
  IF NOT FOUND OR trucker.trip_driver_of(b) IS DISTINCT FROM actor THEN
    status := 'not_found';
    RETURN;
  END IF;
  PERFORM 1 FROM trucker.trip x WHERE x.booking_id = b.id FOR UPDATE;
  t := trucker.clock_now();
  -- Still the driver once the trip is locked.
  IF trucker.request_person() IS DISTINCT FROM actor OR trucker.trip_driver_of(b) IS DISTINCT FROM actor THEN
    status := 'not_found';
    RETURN;
  END IF;
  SELECT * INTO r FROM trucker.trip_milestone_add(b, p_expected_version, p_milestone, actor, actor, NULL, NULL, NULL, t);
  status := r.status;
  detail := r.detail;
END
$$;

-- The carrier's administrator records one on the driver's behalf (DD-6): p_content
-- {"milestone", "statedAt", "reason", "note"?}. The stated time is reported, not observed.
CREATE FUNCTION trucker.trip_milestone_on_behalf(p_booking uuid, p_expected_version integer, p_content jsonb,
                                                 OUT status text, OUT detail jsonb)
RETURNS record
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
DECLARE
  actor uuid := trucker.request_person();
  org uuid := trucker.request_organisation();
  b trucker.booking;
  t timestamptz;
  r record;
  v_driver uuid;
  v_reason text := p_content ->> 'reason';
  v_note text := nullif(btrim(coalesce(p_content ->> 'note', '')), '');
  v_stated timestamptz;
  problems jsonb := '[]'::jsonb;
BEGIN
  IF actor IS NULL THEN
    status := 'unauthorized';
    RETURN;
  END IF;
  IF org IS NULL OR NOT trucker.is_admin(org) THEN
    status := 'not_found';
    RETURN;
  END IF;
  SELECT * INTO b FROM trucker.booking x WHERE x.id = p_booking AND x.carrier_organisation_id = org;
  IF NOT FOUND THEN
    status := 'not_found';
    RETURN;
  END IF;
  IF v_reason IS NULL OR v_reason NOT IN ('no_phone', 'no_signal', 'driver_unable', 'correction', 'other') THEN
    problems := problems || jsonb_build_object('field', 'reason', 'code', 'invalid');
  END IF;
  IF (v_reason = 'other' AND v_note IS NULL) OR char_length(coalesce(v_note, '')) > 1000 THEN
    problems := problems || jsonb_build_object('field', 'note', 'code', CASE WHEN v_note IS NULL THEN 'required' ELSE 'invalid' END);
  END IF;
  IF coalesce(p_content ->> 'statedAt', '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}' THEN
    problems := problems || jsonb_build_object('field', 'statedAt', 'code', 'invalid');
  ELSE
    BEGIN
      v_stated := (p_content ->> 'statedAt')::timestamptz;
    EXCEPTION WHEN OTHERS THEN
      problems := problems || jsonb_build_object('field', 'statedAt', 'code', 'invalid');
    END;
  END IF;
  IF jsonb_array_length(problems) > 0 THEN
    status := 'invalid';
    detail := problems -> 0;
    RETURN;
  END IF;
  PERFORM 1 FROM trucker.trip x WHERE x.booking_id = b.id FOR UPDATE;
  t := trucker.clock_now();
  IF trucker.request_person() IS DISTINCT FROM actor OR NOT trucker.is_admin(org) THEN
    status := 'unauthorized';
    RETURN;
  END IF;
  SELECT a.person_id INTO v_driver FROM trucker.booking_assignment a
  WHERE a.booking_id = b.id AND a.role = 'driver' AND a.status = 'active';
  SELECT * INTO r FROM trucker.trip_milestone_add(b, p_expected_version, p_content ->> 'milestone', actor, v_driver,
                                                  v_stated, v_reason, v_note, t);
  status := r.status;
  detail := r.detail;
END
$$;

-- An estimated arrival at delivery, by the driver (no organisation selected) or by the carrier's
-- administrator: p_content {"arrivalAt"}. Not after arrival at delivery; not in the past.
CREATE FUNCTION trucker.trip_estimate_state(p_booking uuid, p_content jsonb, OUT status text, OUT detail jsonb)
RETURNS record
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
DECLARE
  actor uuid := trucker.request_person();
  org uuid := trucker.request_organisation();
  b trucker.booking;
  tr trucker.trip;
  t timestamptz;
  v_as text;
  v_arrival timestamptz;
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
  v_as := CASE WHEN org IS NOT NULL AND org = b.carrier_organisation_id AND trucker.is_admin(org) THEN 'carrier'
               WHEN org IS NULL AND trucker.trip_driver_of(b) = actor THEN 'driver' END;
  IF v_as IS NULL THEN
    status := 'not_found';
    RETURN;
  END IF;
  IF coalesce(p_content ->> 'arrivalAt', '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}' THEN
    status := 'invalid';
    RETURN;
  END IF;
  BEGIN
    v_arrival := (p_content ->> 'arrivalAt')::timestamptz;
  EXCEPTION WHEN OTHERS THEN
    status := 'invalid';
    RETURN;
  END;
  SELECT * INTO tr FROM trucker.trip x WHERE x.booking_id = b.id FOR UPDATE;
  IF NOT FOUND THEN
    status := 'not_dispatched';
    RETURN;
  END IF;
  t := trucker.clock_now();
  IF trucker.request_person() IS DISTINCT FROM actor
     OR (v_as = 'carrier' AND NOT trucker.is_admin(org))
     OR (v_as = 'driver' AND trucker.trip_driver_of(b) IS DISTINCT FROM actor) THEN
    status := 'not_found';
    RETURN;
  END IF;
  IF tr.milestone_count >= array_position(trucker.trip_milestones(), 'arrived_at_delivery') THEN
    status := 'arrived';
    RETURN;
  END IF;
  IF v_arrival < t OR v_arrival > t + interval '30 days' THEN
    status := 'invalid';
    RETURN;
  END IF;
  INSERT INTO trucker.trip_estimate (trip_id, arrival_at, stated_by, stated_as, stated_at)
  VALUES (tr.id, v_arrival, actor, v_as, t);
  INSERT INTO trucker.audit_entry
    (occurred_at, actor_person_id, organisation_id, action, record_type, record_id, request_id, after_values)
  SELECT t, actor, o, 'trip.estimate_stated', 'booking', b.id, nullif(current_setting('trucker.request_id', true), ''),
         jsonb_build_object('arrivalAt', v_arrival, 'statedAs', v_as)
  FROM unnest(ARRAY[b.shipper_organisation_id, b.carrier_organisation_id]) o;
  status := 'stated';
  detail := trucker.trip_values(b.id, v_as);
END
$$;

-- ---------------------------------------------------------------------------------------------
-- After dispatch, nothing changes the assigned set (DSP-7)
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trucker.set_booking_assignment(p_booking uuid, p_expected_version integer, p_truck uuid, p_trailer uuid, p_affiliation uuid, p_allow_fixtures boolean, OUT status text, OUT detail jsonb)
 RETURNS record
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'trucker', 'pg_temp'
AS $function$
#variable_conflict use_column
DECLARE
  entered record;
  b trucker.booking;
  cur record;
  s trucker.booking_substitution;
  v_at timestamptz;
  v_set integer;
  v_new_set integer;
  v_person uuid;
  v_confirmed boolean;
  v_complete boolean;
  v_needs_trailer boolean := false;
  v_failure jsonb;
  v_differences jsonb;
  v_blocker text;
  v_changes jsonb;
  item record;
BEGIN
  IF p_booking IS NULL OR p_expected_version IS NULL OR p_expected_version < 0 THEN
    RAISE EXCEPTION 'invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT * INTO entered FROM trucker.fleet_carrier_enter();
  status := entered.status;
  IF status NOT IN ('ok', 'not_carrier') THEN
    RETURN;
  END IF;
  -- Anyone but an administrator of this booking's carrier: as for a missing record.
  SELECT * INTO b FROM trucker.booking x WHERE x.id = p_booking AND x.carrier_organisation_id = entered.org;
  IF NOT FOUND THEN
    status := 'not_found';
    RETURN;
  END IF;
  IF status <> 'ok' THEN
    RETURN;
  END IF;
  IF NOT trucker.booking_terms_available(p_allow_fixtures) THEN
    status := 'closed';
    RETURN;
  END IF;
  -- Locks: the organisation (taken on entry), then this booking's set, then the resources.
  v_set := trucker.assignment_state_lock(b.id, entered.at);
  SELECT * INTO cur FROM trucker.assignment_current(b.id);
  SELECT a.person_id INTO v_person FROM trucker.driver_affiliation a
  WHERE a.id = p_affiliation AND a.organisation_id = entered.org;
  PERFORM trucker.resource_lock(ARRAY[cur.truck, cur.trailer, cur.driver, p_truck, p_trailer, v_person]);
  -- The clock is read only now: a request that waited is judged at the moment it proceeds.
  v_at := trucker.clock_now();
  IF EXISTS (SELECT 1 FROM trucker.booking_cancellation x WHERE x.booking_id = b.id) THEN
    status := 'cancelled'; RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM trucker.trip x WHERE x.booking_id = b.id) THEN
    status := 'already_dispatched'; RETURN;
  END IF;
  -- Nothing is reserved for a booking whose fee was not paid by its deadline (D-7).
  IF trucker.fee_overdue(b.id, v_at) THEN
    status := 'fee_not_paid'; RETURN;
  END IF;
  PERFORM trucker.overrun_note(v_at);

  -- Initial assignment after the deadline needs the shipper's explicit wait decision.
  -- The assignment-state lock also serializes record_booking_wait, so neither request
  -- can act on a stale view of that decision. Historical confirmation remains intact.
  IF v_at > b.assignment_due_at
     AND NOT EXISTS (SELECT 1 FROM trucker.booking_confirmation c WHERE c.booking_id = b.id)
     AND NOT EXISTS (SELECT 1 FROM trucker.booking_wait_decision w WHERE w.booking_id = b.id) THEN
    status := 'wait_required';
    RETURN;
  END IF;

  IF cur.truck IS NOT DISTINCT FROM p_truck AND cur.trailer IS NOT DISTINCT FROM p_trailer
     AND cur.affiliation IS NOT DISTINCT FROM p_affiliation THEN
    status := 'unchanged';
    detail := trucker.booking_view(b, 'carrier', v_at);
    RETURN;
  END IF;
  SELECT * INTO s FROM trucker.booking_substitution x WHERE x.booking_id = b.id AND x.status = 'proposed';
  IF FOUND THEN
    IF s.truck_id IS NOT DISTINCT FROM p_truck AND s.trailer_id IS NOT DISTINCT FROM p_trailer
       AND s.affiliation_id IS NOT DISTINCT FROM p_affiliation THEN
      status := 'proposed';
      detail := trucker.booking_view(b, 'carrier', v_at);
    ELSE
      status := 'substitution_open';
    END IF;
    RETURN;
  END IF;
  IF v_set <> p_expected_version THEN
    status := 'conflict';
    RETURN;
  END IF;
  v_confirmed := EXISTS (SELECT 1 FROM trucker.booking_confirmation c WHERE c.booking_id = b.id);
  SELECT c.requires_trailer INTO v_needs_trailer
  FROM trucker.vehicle v JOIN trucker.vehicle_category c ON c.code = v.category_code WHERE v.id = p_truck;
  v_complete := p_truck IS NOT NULL AND p_affiliation IS NOT NULL
                AND (NOT coalesce(v_needs_trailer, false) OR p_trailer IS NOT NULL);
  -- From confirmation on, nothing is taken away without its replacement.
  IF v_confirmed AND NOT v_complete THEN
    status := 'incomplete';
    RETURN;
  END IF;
  -- The hard requirements. Nobody waives them.
  v_failure := trucker.assignment_set_check(b, p_truck, p_trailer, p_affiliation, false);
  IF v_failure IS NOT NULL THEN
    status := 'not_eligible';
    detail := v_failure;
    RETURN;
  END IF;
  -- Availability of every member that joins.
  FOR item IN
    SELECT * FROM (VALUES ('truck', p_truck, cur.truck), ('trailer', p_trailer, cur.trailer),
                          ('driver', v_person, cur.driver)) AS m (role, resource, held)
    WHERE m.resource IS NOT NULL AND m.resource IS DISTINCT FROM m.held
  LOOP
    v_blocker := trucker.reservation_blocker(item.resource, b.id, b.planned_start_at, b.planned_end_at, v_at);
    IF v_blocker IS NOT NULL THEN
      status := 'not_free';
      detail := jsonb_build_object('role', item.role, 'reason', v_blocker);
      RETURN;
    END IF;
  END LOOP;

  v_differences := CASE WHEN v_confirmed
                        THEN trucker.assignment_differences(cur.truck, cur.trailer, p_truck, p_trailer)
                        ELSE '[]'::jsonb END;
  BEGIN
    IF jsonb_array_length(v_differences) > 0 THEN
      -- Materially different after confirmation: a proposal. The substitute is held so that it
      -- cannot be booked elsewhere while the shipper decides; the current set stays as it is.
      INSERT INTO trucker.booking_substitution
        (booking_id, from_set_no, truck_id, trailer_id, affiliation_id, differences, proposed_by, proposed_at)
      VALUES (b.id, v_set, p_truck, p_trailer, p_affiliation, v_differences, entered.actor, v_at)
      RETURNING * INTO s;
      INSERT INTO trucker.resource_reservation
        (booking_id, resource_kind, vehicle_id, person_id, purpose, substitution_id, planned, created_by, created_at)
      SELECT b.id, m.role, m.vehicle, m.person, 'proposed_substitute', s.id, trucker.booking_planned(b),
             entered.actor, v_at
      FROM (VALUES ('truck', p_truck, NULL::uuid, cur.truck),
                   ('trailer', p_trailer, NULL::uuid, cur.trailer),
                   ('driver', NULL::uuid, v_person, cur.driver)) AS m (role, vehicle, person, held)
      WHERE coalesce(m.vehicle, m.person) IS NOT NULL AND coalesce(m.vehicle, m.person) IS DISTINCT FROM m.held;
      PERFORM trucker.assignment_audit(
        v_at, entered.actor, entered.org, 'substitution.proposed', 'booking_substitution', s.id, NULL,
        jsonb_build_object('booking', b.id, 'fromVersion', v_set, 'truck', p_truck, 'trailer', p_trailer,
                           'driver', p_affiliation, 'differences', v_differences));
      status := 'proposed';
    ELSE
      v_new_set := trucker.assignment_apply(
        b, p_truck, p_trailer, p_affiliation, entered.actor, v_at,
        CASE WHEN v_confirmed THEN 'reassigned' ELSE 'unassigned' END, NULL);
      PERFORM trucker.assignment_audit(
        v_at, entered.actor, entered.org, 'booking.assignment_changed', 'booking', b.id,
        jsonb_build_object('version', v_set, 'truck', cur.truck, 'trailer', cur.trailer, 'driver', cur.affiliation),
        jsonb_build_object('version', v_new_set, 'truck', p_truck, 'trailer', p_trailer, 'driver', p_affiliation,
                           'confirms', NOT v_confirmed AND v_complete AND trucker.fee_settled(b.id)));
      -- After confirmation a vehicle replaced by one of the same category takes effect at once
      -- (N-1). The shipper's history records it, with the registrations only: the same facts the
      -- shipper is shown of the vehicles. A change of driver is not recorded here.
      IF v_confirmed THEN
        SELECT coalesce(jsonb_agg(jsonb_build_object(
                 'role', m.role,
                 'from', trucker.assignment_vehicle_values(m.held, 'shipper'),
                 'to', trucker.assignment_vehicle_values(m.wanted, 'shipper')) ORDER BY m.n), '[]'::jsonb)
        INTO v_changes
        FROM (VALUES (1, 'truck', cur.truck, p_truck), (2, 'trailer', cur.trailer, p_trailer))
          AS m (n, role, held, wanted)
        WHERE m.held IS DISTINCT FROM m.wanted;
        IF jsonb_array_length(v_changes) > 0 THEN
          PERFORM trucker.assignment_audit(
            v_at, entered.actor, b.shipper_organisation_id, 'booking.vehicles_changed', 'booking', b.id,
            NULL, jsonb_build_object('changes', v_changes));
        END IF;
      END IF;
      status := 'assigned';
      -- R-14: and Trucker's fee is verified. Otherwise the fee's verification confirms it.
      IF NOT v_confirmed AND v_complete AND trucker.fee_settled(b.id) THEN
        -- Every required resource is assigned, eligible for the whole interval and reserved.
        INSERT INTO trucker.booking_confirmation
          (booking_id, confirmed_at, confirmed_by, completed_by, set_no, resources, site_details)
        SELECT b.id, v_at, entered.actor, 'assignment', v_new_set,
               trucker.assignment_set_values(p_truck, p_trailer, p_affiliation, 'carrier'),
               jsonb_build_object(
                 'pickup', jsonb_build_object('address', d.pickup_address, 'accessNotes', d.pickup_access_notes),
                 'delivery', jsonb_build_object('address', d.delivery_address, 'accessNotes', d.delivery_access_notes))
        FROM trucker.shipment_draft d WHERE d.id = b.shipment_id;
        -- In the shipper's history: that it is confirmed, and no more than the shipper is shown.
        PERFORM trucker.assignment_audit(
          v_at, entered.actor, b.shipper_organisation_id, 'booking.confirmed', 'booking', b.id,
          jsonb_build_object('status', 'awaiting_resources'),
          jsonb_build_object('status', 'confirmed',
                             'resources', trucker.assignment_set_values(p_truck, p_trailer, p_affiliation, 'shipper')));
        status := 'confirmed';
      END IF;
    END IF;
  EXCEPTION WHEN exclusion_violation THEN
    -- Another reservation overlaps after all. Everything in this block is undone.
    status := 'not_free';
    detail := jsonb_build_object('reason', 'reserved');
    RETURN;
  END;
  detail := trucker.booking_view(b, 'carrier', v_at);
END
$function$;

CREATE OR REPLACE FUNCTION trucker.decide_booking_substitution(p_substitution uuid, p_expected_version integer, p_decision text, p_allow_fixtures boolean, OUT status text, OUT detail jsonb)
 RETURNS record
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'trucker', 'pg_temp'
AS $function$
#variable_conflict use_column
DECLARE
  actor uuid := trucker.request_person();
  v_org uuid := trucker.request_organisation();
  s trucker.booking_substitution;
  b trucker.booking;
  cur record;
  v_at timestamptz;
  v_set integer;
  v_new_set integer;
  v_person uuid;
  v_audience text;
  v_failure jsonb;
  v_outcome text;
BEGIN
  IF p_substitution IS NULL OR p_expected_version IS NULL THEN
    RAISE EXCEPTION 'invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_decision IS NULL OR p_decision NOT IN ('accept', 'decline', 'withdraw') THEN
    status := 'invalid';
    RETURN;
  END IF;
  IF actor IS NULL THEN
    status := 'unauthorized';
    RETURN;
  END IF;
  IF v_org IS NULL OR NOT trucker.is_admin(v_org) THEN
    status := 'not_found';
    RETURN;
  END IF;
  SELECT x.* INTO b FROM trucker.booking x JOIN trucker.booking_substitution z ON z.booking_id = x.id
  WHERE z.id = p_substitution;
  -- The shipper decides; only the carrier withdraws. Anyone else: as for a missing record.
  v_audience := CASE WHEN p_decision = 'withdraw' THEN 'carrier' ELSE 'shipper' END;
  IF b.id IS NULL OR v_org IS DISTINCT FROM
       (CASE WHEN v_audience = 'carrier' THEN b.carrier_organisation_id ELSE b.shipper_organisation_id END) THEN
    status := 'not_found';
    RETURN;
  END IF;
  IF NOT trucker.booking_terms_available(p_allow_fixtures) THEN
    status := 'closed';
    RETURN;
  END IF;
  PERFORM 1 FROM trucker.organisation o WHERE o.id = v_org FOR SHARE;
  IF trucker.request_person() IS DISTINCT FROM actor OR NOT trucker.is_admin(v_org) THEN
    status := 'not_found';
    RETURN;
  END IF;
  v_set := trucker.assignment_state_lock(b.id, trucker.clock_now());
  SELECT * INTO s FROM trucker.booking_substitution x WHERE x.id = p_substitution FOR UPDATE;
  SELECT * INTO cur FROM trucker.assignment_current(b.id);
  SELECT a.person_id INTO v_person FROM trucker.driver_affiliation a WHERE a.id = s.affiliation_id;
  PERFORM trucker.resource_lock(ARRAY[cur.truck, cur.trailer, cur.driver, s.truck_id, s.trailer_id, v_person]);
  v_at := trucker.clock_now();
  IF EXISTS (SELECT 1 FROM trucker.booking_cancellation x WHERE x.booking_id = b.id) THEN
    status := 'cancelled'; RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM trucker.trip x WHERE x.booking_id = b.id) THEN
    status := 'already_dispatched'; RETURN;
  END IF;
  IF s.status <> 'proposed' THEN
    status := 'already_decided';
    detail := jsonb_build_object('status', s.status);
    RETURN;
  END IF;
  IF s.row_version <> p_expected_version THEN
    status := 'conflict';
    RETURN;
  END IF;
  IF p_decision = 'accept' THEN
    v_failure := trucker.assignment_set_check(b, s.truck_id, s.trailer_id, s.affiliation_id, true);
    IF v_failure IS NULL AND s.from_set_no <> v_set THEN
      v_failure := jsonb_build_object('reason', 'set_changed');
    END IF;
  END IF;
  IF v_failure IS NOT NULL THEN
    v_outcome := 'failed_checks';
  ELSE
    v_outcome := CASE p_decision WHEN 'accept' THEN 'accepted' WHEN 'decline' THEN 'declined' ELSE 'withdrawn' END;
  END IF;
  UPDATE trucker.booking_substitution x
  SET status = v_outcome, decided_by = actor, decided_at = v_at, failure = v_failure, row_version = x.row_version + 1
  WHERE x.id = s.id;
  IF v_outcome = 'accepted' THEN
    -- One transaction: the substitute's reservations become the booking's, the originals are
    -- released, and the set number moves on, which ends the earlier acknowledgement.
    v_new_set := trucker.assignment_apply(b, s.truck_id, s.trailer_id, s.affiliation_id, actor, v_at, 'substituted', s.id);
    PERFORM trucker.assignment_audit(
      v_at, actor, b.carrier_organisation_id, 'booking.assignment_changed', 'booking', b.id,
      jsonb_build_object('version', v_set, 'truck', cur.truck, 'trailer', cur.trailer, 'driver', cur.affiliation),
      jsonb_build_object('version', v_new_set, 'truck', s.truck_id, 'trailer', s.trailer_id,
                         'driver', s.affiliation_id, 'substitution', s.id));
  ELSE
    UPDATE trucker.resource_reservation r
    SET status = 'released', released_at = v_at,
        release_reason = CASE v_outcome WHEN 'declined' THEN 'proposal_declined'
                                        WHEN 'withdrawn' THEN 'proposal_withdrawn' ELSE 'proposal_failed' END
    WHERE r.substitution_id = s.id AND r.status = 'active' AND r.purpose = 'proposed_substitute';
  END IF;
  -- Recorded in the history of the organisation that decided, and in the carrier's. Why a
  -- substitute failed its checks is the carrier's to know: the shipper's record says only that
  -- it failed.
  PERFORM trucker.assignment_audit(
    v_at, actor, v_org,
    'substitution.' || CASE v_outcome WHEN 'failed_checks' THEN 'checks_failed' ELSE v_outcome END,
    'booking_substitution', s.id, jsonb_build_object('status', 'proposed'),
    jsonb_build_object('status', v_outcome, 'booking', b.id));
  IF v_org <> b.carrier_organisation_id THEN
    PERFORM trucker.assignment_audit(
      v_at, actor, b.carrier_organisation_id,
      'substitution.' || CASE v_outcome WHEN 'failed_checks' THEN 'checks_failed' ELSE v_outcome END,
      'booking_substitution', s.id, jsonb_build_object('status', 'proposed'),
      jsonb_strip_nulls(jsonb_build_object('status', v_outcome, 'booking', b.id, 'failed', v_failure)));
  END IF;
  status := CASE v_outcome WHEN 'failed_checks' THEN 'checks_failed' ELSE v_outcome END;
  detail := trucker.booking_view(b, v_audience, v_at);
END
$function$;

CREATE OR REPLACE FUNCTION trucker.record_booking_wait(p_booking uuid, OUT status text, OUT detail jsonb)
 RETURNS record
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'trucker', 'pg_temp'
AS $function$
#variable_conflict use_column
DECLARE
  actor uuid := trucker.request_person();
  v_org uuid := trucker.request_organisation();
  b trucker.booking;
  v_at timestamptz;
BEGIN
  IF p_booking IS NULL THEN
    RAISE EXCEPTION 'invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF actor IS NULL THEN
    status := 'unauthorized';
    RETURN;
  END IF;
  IF v_org IS NULL OR NOT trucker.is_admin(v_org) THEN
    status := 'not_found';
    RETURN;
  END IF;
  SELECT * INTO b FROM trucker.booking x WHERE x.id = p_booking AND x.shipper_organisation_id = v_org;
  IF NOT FOUND THEN
    status := 'not_found';
    RETURN;
  END IF;
  PERFORM 1 FROM trucker.organisation o WHERE o.id = v_org FOR SHARE;
  IF trucker.request_person() IS DISTINCT FROM actor OR NOT trucker.is_admin(v_org) THEN
    status := 'not_found';
    RETURN;
  END IF;
  PERFORM trucker.assignment_state_lock(b.id, trucker.clock_now());
  v_at := trucker.clock_now();
  IF EXISTS (SELECT 1 FROM trucker.booking_cancellation x WHERE x.booking_id = b.id) THEN
    status := 'cancelled'; RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM trucker.trip x WHERE x.booking_id = b.id) THEN
    status := 'already_dispatched'; RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM trucker.booking_confirmation c WHERE c.booking_id = b.id) THEN
    status := 'confirmed';
  ELSIF EXISTS (SELECT 1 FROM trucker.booking_wait_decision w WHERE w.booking_id = b.id) THEN
    status := 'already_recorded';
  ELSIF v_at <= b.assignment_due_at THEN
    status := 'not_due';
  ELSE
    INSERT INTO trucker.booking_wait_decision (booking_id, decided_by, decided_at, assignment_due_at)
    VALUES (b.id, actor, v_at, b.assignment_due_at);
    PERFORM trucker.assignment_audit(
      v_at, actor, v_org, 'booking.wait_decided', 'booking', b.id, NULL,
      jsonb_build_object('decision', 'wait', 'assignmentDueAt', b.assignment_due_at));
    status := 'recorded';
  END IF;
  detail := trucker.booking_view(b, 'shipper', v_at);
END
$function$;

CREATE OR REPLACE FUNCTION trucker.driver_assignment_receipt(p_booking uuid, p_expected_version integer, OUT status text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'trucker', 'pg_temp'
AS $function$
#variable_conflict use_column
DECLARE
  actor uuid := trucker.request_person();
  b trucker.booking;
  v_at timestamptz;
  v_set integer;
BEGIN
  IF p_booking IS NULL OR p_expected_version IS NULL THEN
    RAISE EXCEPTION 'invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF actor IS NULL THEN
    status := 'unauthorized';
    RETURN;
  END IF;
  SELECT * INTO b FROM trucker.booking x WHERE x.id = p_booking;
  IF NOT FOUND THEN
    status := 'not_found';
    RETURN;
  END IF;
  v_set := trucker.assignment_state_lock(b.id, trucker.clock_now());
  v_at := trucker.clock_now();
  IF EXISTS (SELECT 1 FROM trucker.booking_cancellation x WHERE x.booking_id = b.id) THEN
    status := 'cancelled'; RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM trucker.trip x WHERE x.booking_id = b.id) THEN
    status := 'already_dispatched'; RETURN;
  END IF;
  -- Only the assigned driver, while affiliated with the booking's carrier.
  IF trucker.request_person() IS DISTINCT FROM actor OR NOT EXISTS (
       SELECT 1 FROM trucker.booking_assignment a JOIN trucker.driver_affiliation f ON f.id = a.affiliation_id
       WHERE a.booking_id = b.id AND a.role = 'driver' AND a.status = 'active' AND a.person_id = actor
         AND f.status = 'active' AND f.organisation_id = b.carrier_organisation_id) THEN
    status := 'not_found';
    RETURN;
  END IF;
  -- An acknowledgement is of the set the driver was shown, not of whatever stands now.
  IF v_set <> p_expected_version THEN
    status := 'conflict';
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM trucker.assignment_acknowledgement k WHERE k.booking_id = b.id AND k.set_no = v_set) THEN
    status := 'already_recorded';
    RETURN;
  END IF;
  INSERT INTO trucker.assignment_acknowledgement (booking_id, set_no, person_id, acknowledged_at)
  VALUES (b.id, v_set, actor, v_at);
  PERFORM trucker.assignment_audit(
    v_at, actor, b.carrier_organisation_id, 'assignment.acknowledged', 'booking', b.id, NULL,
    jsonb_build_object('version', v_set));
  status := 'recorded';
END
$function$;

CREATE OR REPLACE FUNCTION trucker.booking_consistency()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'trucker', 'pg_temp'
AS $function$
  SELECT coalesce(jsonb_agg(jsonb_build_object('code', x.code, 'booking', x.booking, 'record', x.record)
                            ORDER BY x.code, x.booking, x.record), '[]'::jsonb)
  FROM (
    -- A confirmed booking without an active member for a role it requires.
    SELECT 'confirmed_missing_member' AS code, c.booking_id AS booking, c.booking_id AS record
    FROM trucker.booking_confirmation c
    WHERE NOT EXISTS (SELECT 1 FROM trucker.booking_cancellation z WHERE z.booking_id=c.booking_id) AND (NOT EXISTS (SELECT 1 FROM trucker.booking_assignment a
                      WHERE a.booking_id = c.booking_id AND a.role = 'truck' AND a.status = 'active')
       OR NOT EXISTS (SELECT 1 FROM trucker.booking_assignment a
                      WHERE a.booking_id = c.booking_id AND a.role = 'driver' AND a.status = 'active')
       OR (EXISTS (SELECT 1 FROM trucker.booking_assignment a
                   JOIN trucker.vehicle v ON v.id = a.vehicle_id
                   JOIN trucker.vehicle_category k ON k.code = v.category_code
                   WHERE a.booking_id = c.booking_id AND a.role = 'truck' AND a.status = 'active' AND k.requires_trailer)
           AND NOT EXISTS (SELECT 1 FROM trucker.booking_assignment a
                           WHERE a.booking_id = c.booking_id AND a.role = 'trailer' AND a.status = 'active')))
    UNION ALL
    -- An active member whose reservation is not an active one for that booking and resource.
    SELECT 'member_without_reservation', a.booking_id, a.id
    FROM trucker.booking_assignment a
    LEFT JOIN trucker.resource_reservation r ON r.id = a.reservation_id
    WHERE a.status = 'active'
      AND (r.status IS DISTINCT FROM 'active' OR r.purpose <> 'assignment' OR r.booking_id <> a.booking_id
           OR r.resource_id <> coalesce(a.vehicle_id, a.person_id))
    UNION ALL
    -- An active reservation held for a set that no active member answers for.
    SELECT 'reservation_without_member', r.booking_id, r.id
    FROM trucker.resource_reservation r
    WHERE r.status = 'active' AND r.purpose = 'assignment'
      AND NOT EXISTS (SELECT 1 FROM trucker.booking_assignment a WHERE a.reservation_id = r.id AND a.status = 'active')
    UNION ALL
    -- A reservation held for a proposal that is no longer open.
    SELECT 'proposed_reservation_without_proposal', r.booking_id, r.id
    FROM trucker.resource_reservation r
    WHERE r.status = 'active' AND r.purpose = 'proposed_substitute'
      AND NOT EXISTS (SELECT 1 FROM trucker.booking_substitution s WHERE s.id = r.substitution_id AND s.status = 'proposed')
    UNION ALL
    -- A resource physically committed with no active reservation behind it.
    SELECT 'occupancy_without_reservation', e.booking_id, e.id
    FROM trucker.occupancy_episode e
    JOIN trucker.resource_reservation r ON r.id = e.reservation_id
    WHERE e.closed_at IS NULL AND r.status <> 'active'
    UNION ALL
    SELECT 'cancelled_active_reservation', c.booking_id, r.id
    FROM trucker.booking_cancellation c JOIN trucker.resource_reservation r ON r.booking_id=c.booking_id
    WHERE r.status='active'
    UNION ALL
    SELECT 'cancelled_active_assignment', c.booking_id, a.id
    FROM trucker.booking_cancellation c JOIN trucker.booking_assignment a ON a.booking_id=c.booking_id
    WHERE a.status='active'
    UNION ALL
    -- A confirmation without the fee (R-14).
    SELECT 'confirmed_without_fee', c.booking_id, c.booking_id
    FROM trucker.booking_confirmation c WHERE NOT trucker.fee_settled(c.booking_id)
    UNION ALL
    -- A dispatched booking whose assigned resource has no open episode for it (until slice 18).
    SELECT 'trip_resource_not_occupied', t.booking_id, a.id
    FROM trucker.trip t JOIN trucker.booking_assignment a ON a.booking_id = t.booking_id AND a.status = 'active'
    WHERE NOT EXISTS (SELECT 1 FROM trucker.occupancy_episode e
                      WHERE e.booking_id = t.booking_id AND e.reservation_id = a.reservation_id AND e.closed_at IS NULL)
    UNION ALL
    SELECT 'dispatched_and_cancelled', t.booking_id, t.id
    FROM trucker.trip t JOIN trucker.booking_cancellation c ON c.booking_id = t.booking_id
    UNION ALL
    SELECT 'cancelled_open_substitution', c.booking_id, s.id
    FROM trucker.booking_cancellation c JOIN trucker.booking_substitution s ON s.booking_id=c.booking_id
    WHERE s.status='proposed'
  ) AS x
$function$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA trucker FROM PUBLIC;
GRANT EXECUTE ON FUNCTION trucker.dispatch_booking(uuid, text, boolean) TO trucker_app;
GRANT EXECUTE ON FUNCTION trucker.trip_milestone_by_driver(uuid, integer, text) TO trucker_app;
GRANT EXECUTE ON FUNCTION trucker.trip_milestone_on_behalf(uuid, integer, jsonb) TO trucker_app;
GRANT EXECUTE ON FUNCTION trucker.trip_estimate_state(uuid, jsonb) TO trucker_app;
