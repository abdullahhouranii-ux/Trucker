-- 0030: the delivery outcome, cargo custody and the release of resources (slice 18a).
--
-- Once the truck has arrived at delivery, the driver records one delivery outcome; the carrier's
-- administrator or Trucker operations may record it on the driver's behalf, with a reason and the
-- stated time, which is then reported, not observed (E-4). Any outcome other than delivered in
-- full opens one operations case. Cargo left on the vehicle is in custody until a handover is
-- recorded. Each resource is released by its own recorded act, only when the release condition
-- holds (DI-403); the release closes the occupancy episode and releases the reservation together.
-- Nothing else closes an episode (E-3). Operations may correct an outcome, as a new version,
-- until a handover or a release is recorded.
--
-- Development defaults, not approved for production: DL-1 to DL-6 (DELIVERY_SLICE_18_SCOPE.md).

CREATE FUNCTION trucker.delivery_outcomes() RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT ARRAY['delivered_in_full', 'delivered_with_remarks', 'partly_delivered', 'refused', 'not_delivered']
$$;

CREATE TABLE trucker.trip_delivery_outcome (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id uuid NOT NULL REFERENCES trucker.trip (id),
  -- 1 for the first; a correction by operations is the next version (DL-6).
  version integer NOT NULL CHECK (version >= 1),
  outcome text NOT NULL CHECK (outcome = ANY (trucker.delivery_outcomes())),
  receiver_name text CHECK (receiver_name IS NULL OR char_length(receiver_name) BETWEEN 1 AND 200),
  remarks text CHECK (remarks IS NULL OR char_length(remarks) BETWEEN 1 AND 2000),
  -- Cargo left on the vehicle: in custody until a handover is recorded (DLV-4).
  cargo_remains boolean NOT NULL,
  stated_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL,
  basis text NOT NULL CHECK (basis IN ('observed', 'reported')),
  driver_id uuid NOT NULL REFERENCES trucker.person (id),
  recorded_by uuid REFERENCES trucker.person (id),
  recorded_by_staff uuid REFERENCES trucker.staff_account (id),
  reason text CHECK (reason IS NULL OR reason IN ('no_phone', 'no_signal', 'driver_unable', 'correction', 'other')),
  note text CHECK (note IS NULL OR char_length(note) BETWEEN 1 AND 1000),
  UNIQUE (trip_id, version),
  CONSTRAINT trip_delivery_outcome_one_recorder CHECK ((recorded_by IS NULL) <> (recorded_by_staff IS NULL)),
  CONSTRAINT trip_delivery_outcome_basis CHECK ((basis = 'reported') = (reason IS NOT NULL)),
  CONSTRAINT trip_delivery_outcome_observed CHECK (
    basis = 'reported' OR (recorded_by = driver_id AND stated_at = recorded_at)),
  CONSTRAINT trip_delivery_outcome_not_future CHECK (stated_at <= recorded_at),
  CONSTRAINT trip_delivery_outcome_receiver CHECK (
    outcome IN ('refused', 'not_delivered') OR receiver_name IS NOT NULL),
  CONSTRAINT trip_delivery_outcome_remarks CHECK (outcome = 'delivered_in_full' OR remarks IS NOT NULL),
  CONSTRAINT trip_delivery_outcome_remains CHECK (
    (outcome = 'delivered_in_full' AND NOT cargo_remains)
    OR outcome = 'delivered_with_remarks'
    OR (outcome IN ('partly_delivered', 'refused', 'not_delivered') AND cargo_remains)),
  -- A correction is entered by operations with a note (DL-6).
  CONSTRAINT trip_delivery_outcome_correction CHECK (
    version = 1 OR (recorded_by_staff IS NOT NULL AND reason = 'correction' AND note IS NOT NULL)),
  CONSTRAINT trip_delivery_outcome_other CHECK (reason IS DISTINCT FROM 'other' OR note IS NOT NULL)
);

-- The handover of the cargo left on the vehicle: closes custody for the outcome in force (DLV-5).
CREATE TABLE trucker.cargo_handover (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id uuid NOT NULL REFERENCES trucker.trip (id),
  outcome_id uuid NOT NULL UNIQUE REFERENCES trucker.trip_delivery_outcome (id),
  kind text NOT NULL CHECK (kind IN ('returned_to_shipper', 'delivered_elsewhere', 'replacement_vehicle')),
  handed_by text NOT NULL CHECK (char_length(handed_by) BETWEEN 1 AND 200),
  received_by text NOT NULL CHECK (char_length(received_by) BETWEEN 1 AND 200),
  handed_at timestamptz NOT NULL,
  place text NOT NULL CHECK (char_length(place) BETWEEN 1 AND 500),
  note text CHECK (note IS NULL OR char_length(note) BETWEEN 1 AND 1000),
  recorded_by uuid REFERENCES trucker.person (id),
  recorded_by_staff uuid REFERENCES trucker.staff_account (id),
  recorded_at timestamptz NOT NULL,
  CONSTRAINT cargo_handover_one_recorder CHECK ((recorded_by IS NULL) <> (recorded_by_staff IS NULL)),
  CONSTRAINT cargo_handover_not_future CHECK (handed_at <= recorded_at)
);

-- The release of one resource from a trip (REL-1 to REL-3).
CREATE TABLE trucker.resource_release (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id uuid NOT NULL REFERENCES trucker.booking (id),
  episode_id uuid NOT NULL UNIQUE REFERENCES trucker.occupancy_episode (id),
  reservation_id uuid NOT NULL REFERENCES trucker.resource_reservation (id),
  role text NOT NULL CHECK (role IN ('truck', 'trailer', 'driver')),
  released_by uuid REFERENCES trucker.person (id),
  released_by_staff uuid REFERENCES trucker.staff_account (id),
  released_at timestamptz NOT NULL,
  -- On the release condition, or by operations with custody still open (REL-2).
  basis text NOT NULL CHECK (basis IN ('condition', 'operations')),
  note text CHECK (note IS NULL OR char_length(note) BETWEEN 1 AND 1000),
  CONSTRAINT resource_release_one_releaser CHECK ((released_by IS NULL) <> (released_by_staff IS NULL)),
  CONSTRAINT resource_release_operations CHECK (
    basis = 'condition' OR (released_by_staff IS NOT NULL AND note IS NOT NULL))
);

CREATE TRIGGER trip_delivery_outcome_guard BEFORE UPDATE OR DELETE ON trucker.trip_delivery_outcome
  FOR EACH ROW EXECUTE FUNCTION trucker.guard_trip_record();
CREATE TRIGGER trip_delivery_outcome_truncate_guard BEFORE TRUNCATE ON trucker.trip_delivery_outcome
  FOR EACH STATEMENT EXECUTE FUNCTION trucker.guard_trip_record();
CREATE TRIGGER cargo_handover_guard BEFORE UPDATE OR DELETE ON trucker.cargo_handover
  FOR EACH ROW EXECUTE FUNCTION trucker.guard_trip_record();
CREATE TRIGGER cargo_handover_truncate_guard BEFORE TRUNCATE ON trucker.cargo_handover
  FOR EACH STATEMENT EXECUTE FUNCTION trucker.guard_trip_record();
CREATE TRIGGER resource_release_guard BEFORE UPDATE OR DELETE ON trucker.resource_release
  FOR EACH ROW EXECUTE FUNCTION trucker.guard_trip_record();
CREATE TRIGGER resource_release_truncate_guard BEFORE TRUNCATE ON trucker.resource_release
  FOR EACH STATEMENT EXECUTE FUNCTION trucker.guard_trip_record();

-- An outcome is the next version, recorded under the trip's lock, and never once a handover or a
-- release is recorded (DL-6).
CREATE FUNCTION trucker.guard_delivery_outcome_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, trucker, pg_temp AS $$
BEGIN
  PERFORM 1 FROM trucker.trip t WHERE t.id = NEW.trip_id FOR UPDATE;
  IF NEW.version <> 1 + coalesce((SELECT max(o.version) FROM trucker.trip_delivery_outcome o WHERE o.trip_id = NEW.trip_id), 0) THEN
    RAISE EXCEPTION 'an outcome is the next version of the trip''s outcome' USING ERRCODE = 'unique_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM trucker.cargo_handover h WHERE h.trip_id = NEW.trip_id)
     OR EXISTS (SELECT 1 FROM trucker.resource_release r JOIN trucker.trip t ON t.booking_id = r.booking_id
                WHERE t.id = NEW.trip_id) THEN
    RAISE EXCEPTION 'an outcome is not corrected once a handover or a release is recorded' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER trip_delivery_outcome_next BEFORE INSERT ON trucker.trip_delivery_outcome
  FOR EACH ROW EXECUTE FUNCTION trucker.guard_delivery_outcome_insert();

-- A handover closes the custody of the outcome in force, and only where cargo remains.
CREATE FUNCTION trucker.guard_cargo_handover_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, trucker, pg_temp AS $$
DECLARE
  o trucker.trip_delivery_outcome;
BEGIN
  PERFORM 1 FROM trucker.trip t WHERE t.id = NEW.trip_id FOR UPDATE;
  SELECT * INTO o FROM trucker.trip_delivery_outcome x WHERE x.trip_id = NEW.trip_id ORDER BY x.version DESC LIMIT 1;
  IF o.id IS DISTINCT FROM NEW.outcome_id OR NOT o.cargo_remains THEN
    RAISE EXCEPTION 'a handover closes the custody of the outcome in force' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER cargo_handover_custody BEFORE INSERT ON trucker.cargo_handover
  FOR EACH ROW EXECUTE FUNCTION trucker.guard_cargo_handover_insert();

-- An episode closes only through its release record, once, and is never removed (REL-4).
CREATE FUNCTION trucker.guard_occupancy_episode() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, trucker, pg_temp AS $$
DECLARE
  r trucker.resource_release;
BEGIN
  IF TG_OP = 'UPDATE'
     AND (NEW.id, NEW.resource_kind, NEW.vehicle_id, NEW.person_id, NEW.booking_id, NEW.reservation_id, NEW.opened_at)
         IS NOT DISTINCT FROM
         (OLD.id, OLD.resource_kind, OLD.vehicle_id, OLD.person_id, OLD.booking_id, OLD.reservation_id, OLD.opened_at)
     AND OLD.closed_at IS NULL AND NEW.closed_at IS NOT NULL THEN
    SELECT * INTO r FROM trucker.resource_release x WHERE x.episode_id = NEW.id;
    IF FOUND AND NEW.closed_at = r.released_at AND NEW.release_reason = 'released' THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'an occupancy closes only by its recorded release, once, and is never removed'
    USING ERRCODE = 'check_violation';
END
$$;
CREATE TRIGGER occupancy_episode_guard BEFORE UPDATE OR DELETE ON trucker.occupancy_episode
  FOR EACH ROW EXECUTE FUNCTION trucker.guard_occupancy_episode();
CREATE TRIGGER occupancy_episode_truncate_guard BEFORE TRUNCATE ON trucker.occupancy_episode
  FOR EACH STATEMENT EXECUTE FUNCTION trucker.guard_trip_record();

ALTER TABLE trucker.resource_reservation DROP CONSTRAINT resource_reservation_release_reason_check;
ALTER TABLE trucker.resource_reservation ADD CONSTRAINT resource_reservation_release_reason_check CHECK (
  release_reason IS NULL OR release_reason IN (
    'unassigned', 'reassigned', 'substituted', 'proposal_declined', 'proposal_withdrawn',
    'proposal_failed', 'booking_cancelled', 'trip_released'
  ));

-- An outcome other than delivered in full opens one case (DLV-3).
ALTER TABLE trucker.trip_case DROP CONSTRAINT trip_case_kind_check;
ALTER TABLE trucker.trip_case ADD CONSTRAINT trip_case_kind_check
  CHECK (kind IN ('exception', 'overrun', 'no_pickup_arrival', 'delivery_outcome'));

ALTER TABLE trucker.trip_delivery_outcome ENABLE ROW LEVEL SECURITY;
ALTER TABLE trucker.cargo_handover ENABLE ROW LEVEL SECURITY;
ALTER TABLE trucker.resource_release ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON trucker.trip_delivery_outcome, trucker.cargo_handover, trucker.resource_release FROM trucker_app, PUBLIC;

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
    'trip.milestone_withdrawn', 'trip.delivery_recorded', 'trip.cargo_handed_over',
    'booking.resource_released'
  ));

-- ---------------------------------------------------------------------------------------------
-- What the parties see
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION trucker.delivery_outcome_values(o trucker.trip_delivery_outcome, p_audience text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
  SELECT jsonb_build_object(
    'version', o.version, 'outcome', o.outcome, 'receiverName', o.receiver_name, 'remarks', o.remarks,
    'cargoRemains', o.cargo_remains, 'statedAt', o.stated_at, 'recordedAt', o.recorded_at, 'basis', o.basis,
    'about', (SELECT p.display_name FROM trucker.person p WHERE p.id = o.driver_id),
    'enteredAs', CASE WHEN o.basis = 'observed' THEN 'driver'
                      WHEN o.recorded_by_staff IS NOT NULL THEN 'operations' ELSE 'carrier' END,
    'enteredBy', CASE WHEN o.basis = 'reported' AND o.recorded_by IS NOT NULL
                      THEN (SELECT p.display_name FROM trucker.person p WHERE p.id = o.recorded_by)
                      WHEN o.recorded_by_staff IS NOT NULL AND p_audience = 'operations'
                      THEN (SELECT a.display_name FROM trucker.staff_account a WHERE a.id = o.recorded_by_staff) END,
    'reason', o.reason,
    'note', CASE WHEN p_audience = 'operations' OR (p_audience = 'carrier' AND o.recorded_by IS NOT NULL) THEN o.note END)
$$;

-- The outcome in force and earlier ones, custody, and (not for the shipper) the releases.
CREATE FUNCTION trucker.delivery_values(p_trip uuid, p_audience text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
  WITH o AS (
    SELECT x AS rec, x.id, x.version, x.cargo_remains, row_number() OVER (ORDER BY x.version DESC) AS n
    FROM trucker.trip_delivery_outcome x WHERE x.trip_id = p_trip)
  SELECT jsonb_build_object(
    'outcome', (SELECT trucker.delivery_outcome_values(o.rec, p_audience) FROM o WHERE o.n = 1),
    'earlier', coalesce((SELECT jsonb_agg(trucker.delivery_outcome_values(o.rec, p_audience) ORDER BY o.version DESC)
                         FROM o WHERE o.n > 1), '[]'::jsonb),
    'custody', (SELECT jsonb_build_object(
                  'open', h.id IS NULL,
                  'handover', CASE WHEN h.id IS NOT NULL THEN jsonb_build_object(
                    'kind', h.kind, 'handedBy', h.handed_by, 'receivedBy', h.received_by, 'handedAt', h.handed_at,
                    'place', h.place, 'recordedAt', h.recorded_at,
                    'enteredAs', CASE WHEN h.recorded_by_staff IS NOT NULL THEN 'operations' ELSE 'carrier' END,
                    'note', CASE WHEN p_audience IN ('carrier', 'operations') THEN h.note END) END)
                FROM o LEFT JOIN trucker.cargo_handover h ON h.outcome_id = o.id
                WHERE o.n = 1 AND o.cargo_remains),
    'releases', CASE WHEN p_audience = 'shipper' THEN NULL ELSE coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'role', r.role, 'releasedAt', r.released_at, 'basis', r.basis,
               'releasedAs', CASE WHEN r.released_by_staff IS NOT NULL THEN 'operations' ELSE 'carrier' END,
               'releasedBy', CASE WHEN r.released_by IS NOT NULL
                                  THEN (SELECT p.display_name FROM trucker.person p WHERE p.id = r.released_by)
                                  WHEN p_audience = 'operations'
                                  THEN (SELECT a.display_name FROM trucker.staff_account a WHERE a.id = r.released_by_staff) END,
               'note', CASE WHEN p_audience = 'operations' THEN r.note END)
             ORDER BY r.released_at, r.role)
      FROM trucker.resource_release r JOIN trucker.trip t ON t.booking_id = r.booking_id
      WHERE t.id = p_trip), '[]'::jsonb) END)
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
    -- The delivery outcome, custody and releases (slice 18a).
    'delivery', trucker.delivery_values(t.id, p_audience),
    'cases', coalesce((SELECT jsonb_agg(trucker.trip_case_values(c, p_audience) ORDER BY c.reported_at, c.id)
                       FROM trucker.trip_case c WHERE c.trip_id = t.id), '[]'::jsonb),
    'estimate', (SELECT jsonb_build_object('arrivalAt', e.arrival_at, 'statedAt', e.stated_at, 'statedAs', e.stated_as,
                                           'statedBy', (SELECT p.display_name FROM trucker.person p WHERE p.id = e.stated_by))
                 FROM trucker.trip_estimate e WHERE e.trip_id = t.id ORDER BY e.seq DESC LIMIT 1))
  FROM trucker.trip t WHERE t.booking_id = p_booking
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
      -- Released from its trip by a recorded release (slice 18a).
      AND NOT (r.status = 'released' AND r.release_reason = 'trip_released'
               AND EXISTS (SELECT 1 FROM trucker.resource_release x WHERE x.reservation_id = r.id))
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
    -- A dispatched booking whose assigned resource has no open episode for it, and no release.
    SELECT 'trip_resource_not_occupied', t.booking_id, a.id
    FROM trucker.trip t JOIN trucker.booking_assignment a ON a.booking_id = t.booking_id AND a.status = 'active'
    WHERE NOT EXISTS (SELECT 1 FROM trucker.occupancy_episode e
                      WHERE e.booking_id = t.booking_id AND e.reservation_id = a.reservation_id AND e.closed_at IS NULL)
      AND NOT EXISTS (SELECT 1 FROM trucker.resource_release x WHERE x.reservation_id = a.reservation_id)
    UNION ALL
    -- A release whose episode or reservation was not closed with it (slice 18a).
    SELECT 'release_not_applied', x.booking_id, x.id
    FROM trucker.resource_release x
    JOIN trucker.occupancy_episode e ON e.id = x.episode_id
    JOIN trucker.resource_reservation r ON r.id = x.reservation_id
    WHERE e.closed_at IS DISTINCT FROM x.released_at
       OR (r.status <> 'released' AND EXISTS (SELECT 1 FROM trucker.trip t WHERE t.booking_id = x.booking_id))
    UNION ALL
    -- A released resource whose outcome did not allow it and that operations did not release.
    SELECT 'released_with_custody_open', x.booking_id, x.id
    FROM trucker.resource_release x
    JOIN trucker.trip t ON t.booking_id = x.booking_id
    JOIN LATERAL (SELECT o.* FROM trucker.trip_delivery_outcome o WHERE o.trip_id = t.id
                  ORDER BY o.version DESC LIMIT 1) o ON true
    WHERE x.basis = 'condition' AND o.cargo_remains
      AND NOT EXISTS (SELECT 1 FROM trucker.cargo_handover h WHERE h.outcome_id = o.id)
    UNION ALL
    SELECT 'dispatched_and_cancelled', t.booking_id, t.id
    FROM trucker.trip t JOIN trucker.booking_cancellation c ON c.booking_id = t.booking_id
    UNION ALL
    SELECT 'cancelled_open_substitution', c.booking_id, s.id
    FROM trucker.booking_cancellation c JOIN trucker.booking_substitution s ON s.booking_id=c.booking_id
    WHERE s.status='proposed'
  ) AS x
$function$;

CREATE OR REPLACE FUNCTION trucker.operations_booking_values(b trucker.booking, p_at timestamp with time zone)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'trucker', 'pg_temp'
AS $function$
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
    'roles', coalesce((SELECT jsonb_agg(a.role ORDER BY a.role) FROM trucker.booking_assignment a
                       WHERE a.booking_id = b.id AND a.status = 'active'), '[]'::jsonb),
    'trip', trucker.trip_values(b.id, 'operations'),
    'cases', coalesce((SELECT jsonb_agg(trucker.trip_case_values(c, 'operations') ORDER BY c.reported_at, c.id)
                       FROM trucker.trip_case c WHERE c.booking_id = b.id), '[]'::jsonb),
    -- Cases about earlier trips that put this booking at risk.
    'atRiskFrom', coalesce((SELECT jsonb_agg(l.case_id ORDER BY l.linked_at)
                            FROM trucker.trip_case_booking l WHERE l.booking_id = b.id), '[]'::jsonb))
$function$;

-- ---------------------------------------------------------------------------------------------
-- Recording
-- ---------------------------------------------------------------------------------------------
-- Records an outcome for b, under the trip's lock (taken by the caller). p_driver is whom it is
-- about; p_actor or p_staff who entered it. Status: recorded, not_dispatched, not_arrived,
-- on_hold, already_recorded, conflict, invalid.
CREATE FUNCTION trucker.delivery_outcome_add(b trucker.booking, p_expected_version integer, p_content jsonb,
                                             p_driver uuid, p_actor uuid, p_staff uuid, p_at timestamptz,
                                             OUT status text, OUT detail jsonb)
RETURNS record
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
DECLARE
  tr trucker.trip;
  v_current integer;
  v_outcome text := p_content ->> 'outcome';
  v_receiver text := nullif(btrim(coalesce(p_content ->> 'receiverName', '')), '');
  v_remarks text := nullif(btrim(coalesce(p_content ->> 'remarks', '')), '');
  v_reason text := p_content ->> 'reason';
  v_note text := nullif(btrim(coalesce(p_content ->> 'note', '')), '');
  v_remains boolean;
  v_stated timestamptz;
  v_audience text := CASE WHEN p_staff IS NOT NULL THEN 'operations' WHEN v_reason IS NULL THEN 'driver' ELSE 'carrier' END;
  problems jsonb := '[]'::jsonb;
  c trucker.trip_case;
BEGIN
  SELECT * INTO tr FROM trucker.trip x WHERE x.booking_id = b.id FOR UPDATE;
  IF NOT FOUND THEN
    status := 'not_dispatched';
    RETURN;
  END IF;
  IF tr.milestone_count < array_position(trucker.trip_milestones(), 'arrived_at_delivery') THEN
    status := 'not_arrived';
    detail := trucker.trip_values(b.id, v_audience);
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM trucker.trip_hold h WHERE h.trip_id = tr.id AND h.resumed_at IS NULL) THEN
    status := 'on_hold';
    detail := trucker.trip_values(b.id, v_audience);
    RETURN;
  END IF;
  v_current := coalesce((SELECT max(o.version) FROM trucker.trip_delivery_outcome o WHERE o.trip_id = tr.id), 0);
  IF p_staff IS NULL AND v_current > 0 THEN
    status := 'already_recorded';
    detail := trucker.trip_values(b.id, v_audience);
    RETURN;
  END IF;
  IF p_expected_version IS DISTINCT FROM v_current THEN
    status := 'conflict';
    detail := trucker.trip_values(b.id, v_audience);
    RETURN;
  END IF;
  IF v_current > 0 AND (EXISTS (SELECT 1 FROM trucker.cargo_handover h WHERE h.trip_id = tr.id)
                        OR EXISTS (SELECT 1 FROM trucker.resource_release r WHERE r.booking_id = b.id)) THEN
    status := 'settled';
    detail := trucker.trip_values(b.id, v_audience);
    RETURN;
  END IF;
  -- What is said and its shape (DL-2).
  IF v_outcome IS NULL OR NOT v_outcome = ANY (trucker.delivery_outcomes()) THEN
    problems := problems || jsonb_build_object('field', 'outcome', 'code', 'invalid');
  END IF;
  v_remains := CASE WHEN v_outcome = 'delivered_in_full' THEN false
                    WHEN v_outcome IN ('partly_delivered', 'refused', 'not_delivered') THEN true
                    ELSE coalesce((p_content ->> 'cargoRemains')::boolean, false) END;
  IF v_receiver IS NULL AND v_outcome NOT IN ('refused', 'not_delivered') THEN
    problems := problems || jsonb_build_object('field', 'receiverName', 'code', 'required');
  END IF;
  IF char_length(coalesce(v_receiver, '')) > 200 THEN
    problems := problems || jsonb_build_object('field', 'receiverName', 'code', 'too_long');
  END IF;
  IF v_remarks IS NULL AND v_outcome IS DISTINCT FROM 'delivered_in_full' THEN
    problems := problems || jsonb_build_object('field', 'remarks', 'code', 'required');
  END IF;
  IF char_length(coalesce(v_remarks, '')) > 2000 THEN
    problems := problems || jsonb_build_object('field', 'remarks', 'code', 'too_long');
  END IF;
  IF p_actor IS NOT NULL AND p_actor = p_driver AND v_reason IS NULL THEN
    v_stated := p_at;
  ELSE
    BEGIN
      v_stated := (p_content ->> 'statedAt')::timestamptz;
    EXCEPTION WHEN others THEN
      v_stated := NULL;
    END;
    IF v_stated IS NULL OR v_stated > p_at THEN
      problems := problems || jsonb_build_object('field', 'statedAt', 'code', CASE WHEN v_stated IS NULL THEN 'invalid' ELSE 'future' END);
    END IF;
    IF v_reason IS NULL OR v_reason NOT IN ('no_phone', 'no_signal', 'driver_unable', 'correction', 'other')
       OR (v_current > 0 AND v_reason <> 'correction') THEN
      problems := problems || jsonb_build_object('field', 'reason', 'code', 'invalid');
    END IF;
    IF v_note IS NULL AND (v_reason = 'other' OR v_current > 0) THEN
      problems := problems || jsonb_build_object('field', 'note', 'code', 'required');
    END IF;
    IF char_length(coalesce(v_note, '')) > 1000 THEN
      problems := problems || jsonb_build_object('field', 'note', 'code', 'too_long');
    END IF;
  END IF;
  IF jsonb_array_length(problems) > 0 THEN
    status := 'invalid';
    detail := problems;
    RETURN;
  END IF;
  INSERT INTO trucker.trip_delivery_outcome (trip_id, version, outcome, receiver_name, remarks, cargo_remains, stated_at,
                                             recorded_at, basis, driver_id, recorded_by, recorded_by_staff, reason, note)
  VALUES (tr.id, v_current + 1, v_outcome, v_receiver, v_remarks, v_remains, v_stated, p_at,
          CASE WHEN v_reason IS NULL THEN 'observed' ELSE 'reported' END, p_driver, p_actor, p_staff, v_reason, v_note);
  INSERT INTO trucker.audit_entry
    (occurred_at, actor_person_id, actor_staff_id, organisation_id, action, record_type, record_id, request_id,
     after_values)
  SELECT p_at, p_actor, p_staff, o, 'trip.delivery_recorded', 'booking', b.id,
         nullif(current_setting('trucker.request_id', true), ''),
         jsonb_build_object('outcome', v_outcome, 'version', v_current + 1, 'cargoRemains', v_remains,
                            'basis', CASE WHEN v_reason IS NULL THEN 'observed' ELSE 'reported' END,
                            'onBehalfOf', CASE WHEN v_reason IS NOT NULL THEN p_driver END, 'reason', v_reason)
  FROM unnest(ARRAY[b.shipper_organisation_id, b.carrier_organisation_id]) o;
  -- Anything but delivered in full: one operations case for the trip (DLV-3).
  IF v_outcome <> 'delivered_in_full' THEN
    INSERT INTO trucker.trip_case (trip_id, booking_id, kind, reported_as, reported_at)
    VALUES (tr.id, b.id, 'delivery_outcome', 'system', p_at)
    ON CONFLICT (trip_id, kind) WHERE kind <> 'exception' DO NOTHING
    RETURNING * INTO c;
    IF c.id IS NOT NULL THEN
      INSERT INTO trucker.audit_entry (occurred_at, organisation_id, action, record_type, record_id, after_values)
      SELECT p_at, o, 'trip.case_opened', 'booking', b.id, jsonb_build_object('case', c.id, 'kind', c.kind)
      FROM unnest(ARRAY[b.shipper_organisation_id, b.carrier_organisation_id]) o;
    END IF;
  END IF;
  status := 'recorded';
  detail := trucker.trip_values(b.id, v_audience);
END
$$;

-- The driver, as it happens; or the carrier's administrator on the driver's behalf.
-- Status as delivery_outcome_add, and not_found, unauthorized.
CREATE FUNCTION trucker.trip_delivery_record(p_booking uuid, p_expected_version integer, p_content jsonb,
                                             OUT status text, OUT detail jsonb)
RETURNS record
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
DECLARE
  actor uuid := trucker.request_person();
  org uuid := trucker.request_organisation();
  b trucker.booking;
  v_driver uuid;
  t timestamptz;
  r record;
  v_content jsonb := p_content;
BEGIN
  IF actor IS NULL THEN
    status := 'unauthorized';
    RETURN;
  END IF;
  SELECT * INTO b FROM trucker.booking x WHERE x.id = p_booking;
  IF NOT FOUND OR NOT ((org IS NULL AND trucker.trip_driver_of(b) = actor)
                       OR (org = b.carrier_organisation_id AND trucker.is_admin(org))) THEN
    status := 'not_found';
    RETURN;
  END IF;
  -- The driver records as it happens: no reason, no stated time.
  IF org IS NULL THEN
    v_content := p_content - 'reason' - 'note' - 'statedAt';
  ELSIF p_content ->> 'reason' IS NULL THEN
    v_content := p_content || jsonb_build_object('reason', '');
  END IF;
  PERFORM 1 FROM trucker.trip x WHERE x.booking_id = b.id FOR UPDATE;
  t := trucker.clock_now();
  IF trucker.request_person() IS DISTINCT FROM actor
     OR (org IS NULL AND trucker.trip_driver_of(b) IS DISTINCT FROM actor)
     OR (org IS NOT NULL AND NOT trucker.is_admin(org)) THEN
    status := 'not_found';
    RETURN;
  END IF;
  v_driver := (SELECT a.person_id FROM trucker.booking_assignment a
               WHERE a.booking_id = b.id AND a.role = 'driver' AND a.status = 'active');
  IF v_driver IS NULL THEN
    status := 'not_dispatched';
    RETURN;
  END IF;
  SELECT * INTO r FROM trucker.delivery_outcome_add(b, p_expected_version, v_content, v_driver, actor, NULL, t);
  status := r.status;
  detail := r.detail;
END
$$;

-- Operations records the outcome on the driver's behalf, or corrects it (DL-6).
CREATE FUNCTION trucker.staff_delivery_record(p_token_hash text, p_booking uuid, p_expected_version integer,
                                              p_content jsonb, p_request_id text, OUT status text, OUT detail jsonb)
RETURNS record
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
DECLARE
  e record;
  b trucker.booking;
  v_driver uuid;
  t timestamptz;
  r record;
BEGIN
  SELECT * INTO e FROM trucker.staff_enter(p_token_hash, 'operations', 'staff.operations.delivery', NULL, p_request_id);
  status := e.status;
  IF status <> 'ok' THEN
    RETURN;
  END IF;
  SELECT * INTO b FROM trucker.booking x WHERE x.id = p_booking;
  IF NOT FOUND THEN
    status := 'not_found';
    RETURN;
  END IF;
  PERFORM 1 FROM trucker.trip x WHERE x.booking_id = b.id FOR UPDATE;
  t := trucker.clock_now();
  v_driver := (SELECT a.person_id FROM trucker.booking_assignment a
               WHERE a.booking_id = b.id AND a.role = 'driver' AND a.status = 'active');
  IF v_driver IS NULL THEN
    status := 'not_dispatched';
    RETURN;
  END IF;
  SELECT * INTO r FROM trucker.delivery_outcome_add(b, p_expected_version,
                                                    p_content || CASE WHEN p_content ->> 'reason' IS NULL
                                                                      THEN jsonb_build_object('reason', '') ELSE '{}'::jsonb END,
                                                    v_driver, NULL, e.staff_id, t);
  status := r.status;
  detail := r.detail;
  IF status = 'recorded' THEN
    PERFORM trucker.staff_audit(t, e.staff_id, 'staff.operations.delivery', 'done', NULL, p_request_id,
                                jsonb_build_object('booking', b.id, 'outcome', p_content ->> 'outcome'));
  END IF;
END
$$;

-- Records the handover of the cargo left on the vehicle (DLV-5). Status: recorded, no_custody,
-- not_dispatched, invalid.
CREATE FUNCTION trucker.cargo_handover_add(b trucker.booking, p_content jsonb, p_actor uuid, p_staff uuid,
                                           p_at timestamptz, OUT status text, OUT detail jsonb)
RETURNS record
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
DECLARE
  tr trucker.trip;
  o trucker.trip_delivery_outcome;
  v_kind text := p_content ->> 'kind';
  v_by text := nullif(btrim(coalesce(p_content ->> 'handedBy', '')), '');
  v_to text := nullif(btrim(coalesce(p_content ->> 'receivedBy', '')), '');
  v_place text := nullif(btrim(coalesce(p_content ->> 'place', '')), '');
  v_note text := nullif(btrim(coalesce(p_content ->> 'note', '')), '');
  v_at timestamptz;
  v_audience text := CASE WHEN p_staff IS NOT NULL THEN 'operations' ELSE 'carrier' END;
  problems jsonb := '[]'::jsonb;
BEGIN
  SELECT * INTO tr FROM trucker.trip x WHERE x.booking_id = b.id FOR UPDATE;
  IF NOT FOUND THEN
    status := 'not_dispatched';
    RETURN;
  END IF;
  SELECT * INTO o FROM trucker.trip_delivery_outcome x WHERE x.trip_id = tr.id ORDER BY x.version DESC LIMIT 1;
  IF o.id IS NULL OR NOT o.cargo_remains OR EXISTS (SELECT 1 FROM trucker.cargo_handover h WHERE h.outcome_id = o.id) THEN
    status := 'no_custody';
    detail := trucker.trip_values(b.id, v_audience);
    RETURN;
  END IF;
  BEGIN
    v_at := (p_content ->> 'handedAt')::timestamptz;
  EXCEPTION WHEN others THEN
    v_at := NULL;
  END;
  IF v_kind IS NULL OR v_kind NOT IN ('returned_to_shipper', 'delivered_elsewhere', 'replacement_vehicle') THEN
    problems := problems || jsonb_build_object('field', 'kind', 'code', 'invalid');
  END IF;
  IF v_by IS NULL OR char_length(v_by) > 200 THEN
    problems := problems || jsonb_build_object('field', 'handedBy', 'code', CASE WHEN v_by IS NULL THEN 'required' ELSE 'too_long' END);
  END IF;
  IF v_to IS NULL OR char_length(v_to) > 200 THEN
    problems := problems || jsonb_build_object('field', 'receivedBy', 'code', CASE WHEN v_to IS NULL THEN 'required' ELSE 'too_long' END);
  END IF;
  IF v_place IS NULL OR char_length(v_place) > 500 THEN
    problems := problems || jsonb_build_object('field', 'place', 'code', CASE WHEN v_place IS NULL THEN 'required' ELSE 'too_long' END);
  END IF;
  -- Times are entered to the minute: the minute of the outcome itself is accepted.
  IF v_at IS NULL OR v_at > p_at OR v_at < date_trunc('minute', o.stated_at) THEN
    problems := problems || jsonb_build_object('field', 'handedAt', 'code', CASE WHEN v_at IS NULL THEN 'invalid'
                                                                                 WHEN v_at > p_at THEN 'future' ELSE 'before_outcome' END);
  END IF;
  IF char_length(coalesce(v_note, '')) > 1000 THEN
    problems := problems || jsonb_build_object('field', 'note', 'code', 'too_long');
  END IF;
  IF jsonb_array_length(problems) > 0 THEN
    status := 'invalid';
    detail := problems;
    RETURN;
  END IF;
  INSERT INTO trucker.cargo_handover (trip_id, outcome_id, kind, handed_by, received_by, handed_at, place, note,
                                      recorded_by, recorded_by_staff, recorded_at)
  VALUES (tr.id, o.id, v_kind, v_by, v_to, v_at, v_place, v_note, p_actor, p_staff, p_at);
  INSERT INTO trucker.audit_entry
    (occurred_at, actor_person_id, actor_staff_id, organisation_id, action, record_type, record_id, request_id,
     after_values)
  SELECT p_at, p_actor, p_staff, x, 'trip.cargo_handed_over', 'booking', b.id,
         nullif(current_setting('trucker.request_id', true), ''), jsonb_build_object('kind', v_kind, 'handedAt', v_at)
  FROM unnest(ARRAY[b.shipper_organisation_id, b.carrier_organisation_id]) x;
  status := 'recorded';
  detail := trucker.trip_values(b.id, v_audience);
END
$$;

CREATE FUNCTION trucker.cargo_handover_record(p_booking uuid, p_content jsonb, OUT status text, OUT detail jsonb)
RETURNS record
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
DECLARE
  actor uuid := trucker.request_person();
  org uuid := trucker.request_organisation();
  b trucker.booking;
  t timestamptz;
  r record;
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
  PERFORM 1 FROM trucker.trip x WHERE x.booking_id = b.id FOR UPDATE;
  t := trucker.clock_now();
  IF trucker.request_person() IS DISTINCT FROM actor OR NOT trucker.is_admin(org) THEN
    status := 'not_found';
    RETURN;
  END IF;
  SELECT * INTO r FROM trucker.cargo_handover_add(b, p_content, actor, NULL, t);
  status := r.status;
  detail := r.detail;
END
$$;

CREATE FUNCTION trucker.staff_cargo_handover(p_token_hash text, p_booking uuid, p_content jsonb, p_request_id text,
                                             OUT status text, OUT detail jsonb)
RETURNS record
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
DECLARE
  e record;
  b trucker.booking;
  t timestamptz;
  r record;
BEGIN
  SELECT * INTO e FROM trucker.staff_enter(p_token_hash, 'operations', 'staff.operations.handover', NULL, p_request_id);
  status := e.status;
  IF status <> 'ok' THEN
    RETURN;
  END IF;
  SELECT * INTO b FROM trucker.booking x WHERE x.id = p_booking;
  IF NOT FOUND THEN
    status := 'not_found';
    RETURN;
  END IF;
  PERFORM 1 FROM trucker.trip x WHERE x.booking_id = b.id FOR UPDATE;
  t := trucker.clock_now();
  SELECT * INTO r FROM trucker.cargo_handover_add(b, p_content, NULL, e.staff_id, t);
  status := r.status;
  detail := r.detail;
  IF status = 'recorded' THEN
    PERFORM trucker.staff_audit(t, e.staff_id, 'staff.operations.handover', 'done', NULL, p_request_id,
                                jsonb_build_object('booking', b.id));
  END IF;
END
$$;

-- Releases one resource (REL-1 to REL-3). Status: released, already_released, no_outcome,
-- custody_open, not_assigned, not_dispatched, invalid.
CREATE FUNCTION trucker.resource_release_add(b trucker.booking, p_role text, p_actor uuid, p_staff uuid,
                                             p_override boolean, p_note text, p_at timestamptz,
                                             OUT status text, OUT detail jsonb)
RETURNS record
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
DECLARE
  tr trucker.trip;
  o trucker.trip_delivery_outcome;
  a trucker.booking_assignment;
  ep trucker.occupancy_episode;
  v_custody_open boolean;
  v_audience text := CASE WHEN p_staff IS NOT NULL THEN 'operations' ELSE 'carrier' END;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
BEGIN
  IF p_role IS NULL OR p_role NOT IN ('truck', 'trailer', 'driver') THEN
    status := 'invalid';
    detail := jsonb_build_array(jsonb_build_object('field', 'role', 'code', 'invalid'));
    RETURN;
  END IF;
  IF (p_override AND v_note IS NULL) OR char_length(coalesce(v_note, '')) > 1000 THEN
    status := 'invalid';
    detail := jsonb_build_array(jsonb_build_object('field', 'note', 'code', CASE WHEN v_note IS NULL THEN 'required' ELSE 'too_long' END));
    RETURN;
  END IF;
  SELECT * INTO tr FROM trucker.trip x WHERE x.booking_id = b.id FOR UPDATE;
  IF NOT FOUND THEN
    status := 'not_dispatched';
    RETURN;
  END IF;
  SELECT * INTO a FROM trucker.booking_assignment x WHERE x.booking_id = b.id AND x.role = p_role AND x.status = 'active';
  IF NOT FOUND THEN
    status := 'not_assigned';
    detail := trucker.trip_values(b.id, v_audience);
    RETURN;
  END IF;
  SELECT * INTO ep FROM trucker.occupancy_episode e WHERE e.reservation_id = a.reservation_id FOR UPDATE;
  IF ep.closed_at IS NOT NULL THEN
    status := 'already_released';
    detail := trucker.trip_values(b.id, v_audience);
    RETURN;
  END IF;
  SELECT * INTO o FROM trucker.trip_delivery_outcome x WHERE x.trip_id = tr.id ORDER BY x.version DESC LIMIT 1;
  IF o.id IS NULL THEN
    status := 'no_outcome';
    detail := trucker.trip_values(b.id, v_audience);
    RETURN;
  END IF;
  -- The release condition (DI-403): nothing left on the vehicle, or its handover recorded; or
  -- operations releasing with a note (REL-2).
  v_custody_open := o.cargo_remains AND NOT EXISTS (SELECT 1 FROM trucker.cargo_handover h WHERE h.outcome_id = o.id);
  IF v_custody_open AND NOT (p_override AND p_staff IS NOT NULL) THEN
    status := 'custody_open';
    detail := trucker.trip_values(b.id, v_audience);
    RETURN;
  END IF;
  INSERT INTO trucker.resource_release (booking_id, episode_id, reservation_id, role, released_by, released_by_staff,
                                        released_at, basis, note)
  VALUES (b.id, ep.id, a.reservation_id, p_role, p_actor, p_staff, p_at,
          CASE WHEN v_custody_open THEN 'operations' ELSE 'condition' END, v_note);
  UPDATE trucker.occupancy_episode e SET closed_at = p_at, release_reason = 'released' WHERE e.id = ep.id;
  UPDATE trucker.resource_reservation r
  SET status = 'released', released_at = p_at, release_reason = 'trip_released'
  WHERE r.id = a.reservation_id;
  INSERT INTO trucker.audit_entry
    (occurred_at, actor_person_id, actor_staff_id, organisation_id, action, record_type, record_id, request_id,
     after_values)
  VALUES (p_at, p_actor, p_staff, b.carrier_organisation_id, 'booking.resource_released', 'booking', b.id,
          nullif(current_setting('trucker.request_id', true), ''),
          jsonb_build_object('role', p_role, 'basis', CASE WHEN v_custody_open THEN 'operations' ELSE 'condition' END));
  status := 'released';
  detail := trucker.trip_values(b.id, v_audience);
END
$$;

CREATE FUNCTION trucker.resource_release_record(p_booking uuid, p_role text, OUT status text, OUT detail jsonb)
RETURNS record
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
DECLARE
  actor uuid := trucker.request_person();
  org uuid := trucker.request_organisation();
  b trucker.booking;
  t timestamptz;
  r record;
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
  -- The same locks as a dispatch: the next dispatch of this resource waits for the release.
  PERFORM trucker.booking_lock_set(b);
  t := trucker.clock_now();
  IF trucker.request_person() IS DISTINCT FROM actor OR NOT trucker.is_admin(org) THEN
    status := 'not_found';
    RETURN;
  END IF;
  SELECT * INTO r FROM trucker.resource_release_add(b, p_role, actor, NULL, false, NULL, t);
  status := r.status;
  detail := r.detail;
END
$$;

CREATE FUNCTION trucker.staff_resource_release(p_token_hash text, p_booking uuid, p_role text, p_override boolean,
                                               p_note text, p_request_id text, OUT status text, OUT detail jsonb)
RETURNS record
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
DECLARE
  e record;
  b trucker.booking;
  t timestamptz;
  r record;
BEGIN
  SELECT * INTO e FROM trucker.staff_enter(p_token_hash, 'operations', 'staff.operations.release', NULL, p_request_id);
  status := e.status;
  IF status <> 'ok' THEN
    RETURN;
  END IF;
  SELECT * INTO b FROM trucker.booking x WHERE x.id = p_booking;
  IF NOT FOUND THEN
    status := 'not_found';
    RETURN;
  END IF;
  PERFORM trucker.booking_lock_set(b);
  t := trucker.clock_now();
  SELECT * INTO r FROM trucker.resource_release_add(b, p_role, NULL, e.staff_id, coalesce(p_override, false), p_note, t);
  status := r.status;
  detail := r.detail;
  IF status = 'released' THEN
    PERFORM trucker.staff_audit(t, e.staff_id, 'staff.operations.release', 'done', NULL, p_request_id,
                                jsonb_build_object('booking', b.id, 'role', p_role, 'override', p_override));
  END IF;
END
$$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA trucker FROM PUBLIC;
GRANT EXECUTE ON FUNCTION trucker.trip_delivery_record(uuid, integer, jsonb) TO trucker_app;
GRANT EXECUTE ON FUNCTION trucker.staff_delivery_record(text, uuid, integer, jsonb, text) TO trucker_app;
GRANT EXECUTE ON FUNCTION trucker.cargo_handover_record(uuid, jsonb) TO trucker_app;
GRANT EXECUTE ON FUNCTION trucker.staff_cargo_handover(text, uuid, jsonb, text) TO trucker_app;
GRANT EXECUTE ON FUNCTION trucker.resource_release_record(uuid, text) TO trucker_app;
GRANT EXECUTE ON FUNCTION trucker.staff_resource_release(text, uuid, text, boolean, text, text) TO trucker_app;
