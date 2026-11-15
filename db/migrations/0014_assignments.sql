-- 0014: resource assignment, planned reservations, occupancy and confirmation (slice 15).
--
-- The carrier assigns a truck, a driver and, where the truck needs one, a trailer to a booking.
-- Each assigned resource holds a planned reservation for the booking's planned interval. When
-- every required resource is assigned, eligible for the whole interval and reserved, the booking
-- is confirmed, in the same transaction, and never by hand.
--
-- Four things are kept apart:
--   * the planned reservation: the time a resource is planned to be committed;
--   * actual occupancy: an episode that opens at dispatch and closes only by a recorded release.
--     A resource has any number of closed episodes and at most one open one. Nothing in this
--     slice opens or closes an episode, and nothing about a proof of delivery ever does;
--   * the confirmation: a historical fact, recorded once and never changed;
--   * dispatch readiness: judged now, every time it is asked. A resource that stops being
--     eligible blocks dispatch and calls for reassignment. It does not cancel or unconfirm.
--
-- Reassignment follows the substitution rules of the specification (Part 2, 7.2): the hard
-- requirements are never waived, the price cannot change (the booking is immutable), and after
-- confirmation a materially different substitute takes effect only with the shipper's recorded
-- acceptance. The old assignment and its reservations stay until the replacement commits in
-- the same transaction. Any change to the assigned set ends the driver's acknowledgement.
--
-- Operational details are released by stage: the carrier sees the pick-up and delivery
-- addresses and access notes only once the booking is confirmed; the shipper sees registration
-- numbers and the driver's name only once it is confirmed. No site contact is shown anywhere:
-- shipments hold none, and none is invented.

-- Equality on a uuid inside an exclusion constraint. Ships with PostgreSQL.
CREATE EXTENSION btree_gist WITH SCHEMA trucker_ext;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA trucker_ext FROM PUBLIC;

-- ---------------------------------------------------------------------------------------------
-- Which resources a booking requires (AB-2): a truck and a driver always, and a trailer when
-- the truck's category is one that pulls a trailer. The mapping is a register, fictional in
-- development like the categories themselves.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE trucker.vehicle_category
  ADD COLUMN requires_trailer boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT vehicle_category_trailer CHECK (NOT requires_trailer OR kind = 'truck');
COMMENT ON COLUMN trucker.vehicle_category.requires_trailer IS
  'Fictional until the real categories are approved. Not a statement about any real vehicle.';

-- ---------------------------------------------------------------------------------------------
-- The assigned set of a booking has a number that rises with every change. Commands name the
-- number they saw; an acknowledgement belongs to one number. The row is also what a command
-- locks, so changes to one booking's set happen one at a time.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE trucker.booking_assignment_state (
  booking_id uuid PRIMARY KEY REFERENCES trucker.booking (id),
  set_no integer NOT NULL DEFAULT 0 CHECK (set_no >= 0),
  updated_at timestamptz NOT NULL
);

-- An open proposal to substitute a materially different set after confirmation.
CREATE TABLE trucker.booking_substitution (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id uuid NOT NULL REFERENCES trucker.booking (id),
  status text NOT NULL DEFAULT 'proposed'
    CHECK (status IN ('proposed', 'accepted', 'declined', 'withdrawn', 'failed_checks')),
  -- The set number the proposal was made against, and the whole set it proposes.
  from_set_no integer NOT NULL,
  truck_id uuid NOT NULL REFERENCES trucker.vehicle (id),
  trailer_id uuid REFERENCES trucker.vehicle (id),
  affiliation_id uuid NOT NULL REFERENCES trucker.driver_affiliation (id),
  -- What makes it materially different, as the shipper is shown it.
  differences jsonb NOT NULL CHECK (jsonb_typeof(differences) = 'array' AND jsonb_array_length(differences) > 0),
  proposed_by uuid NOT NULL REFERENCES trucker.person (id),
  proposed_at timestamptz NOT NULL,
  decided_by uuid REFERENCES trucker.person (id),
  decided_at timestamptz,
  failure jsonb,
  row_version integer NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  CONSTRAINT booking_substitution_decided CHECK ((status = 'proposed') = (decided_at IS NULL)),
  CONSTRAINT booking_substitution_failure CHECK ((status = 'failed_checks') = (failure IS NOT NULL))
);
CREATE UNIQUE INDEX booking_substitution_one_open ON trucker.booking_substitution (booking_id)
  WHERE status = 'proposed';

-- ---------------------------------------------------------------------------------------------
-- Planned reservations. One per resource per booking, for the half-open interval on the booking
-- snapshot, so reservations that touch do not overlap. The database refuses two active
-- reservations of one resource that overlap, whichever organisation asks. A driver is reserved
-- as a person: the same person cannot be reserved twice through two carriers.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE trucker.resource_reservation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id uuid NOT NULL REFERENCES trucker.booking (id),
  resource_kind text NOT NULL CHECK (resource_kind IN ('truck', 'trailer', 'driver')),
  vehicle_id uuid REFERENCES trucker.vehicle (id),
  person_id uuid REFERENCES trucker.person (id),
  resource_id uuid GENERATED ALWAYS AS (coalesce(vehicle_id, person_id)) STORED,
  -- Held for the booking's assigned set, or for a substitute while the shipper decides.
  purpose text NOT NULL CHECK (purpose IN ('assignment', 'proposed_substitute')),
  substitution_id uuid REFERENCES trucker.booking_substitution (id),
  planned tstzrange NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'released')),
  created_by uuid NOT NULL REFERENCES trucker.person (id),
  created_at timestamptz NOT NULL,
  released_at timestamptz,
  release_reason text CHECK (release_reason IS NULL OR release_reason IN (
    'unassigned', 'reassigned', 'substituted', 'proposal_declined', 'proposal_withdrawn', 'proposal_failed')),
  -- Set once, when an open occupancy is first seen to have passed the planned end.
  overrun_recorded_at timestamptz,
  CONSTRAINT resource_reservation_subject CHECK (
    (resource_kind IN ('truck', 'trailer') AND vehicle_id IS NOT NULL AND person_id IS NULL)
    OR (resource_kind = 'driver' AND person_id IS NOT NULL AND vehicle_id IS NULL)),
  CONSTRAINT resource_reservation_interval CHECK (
    NOT isempty(planned) AND lower_inc(planned) AND NOT upper_inc(planned)
    AND NOT lower_inf(planned) AND NOT upper_inf(planned)),
  CONSTRAINT resource_reservation_released CHECK (
    (status = 'released') = (released_at IS NOT NULL) AND (status = 'released') = (release_reason IS NOT NULL)),
  CONSTRAINT resource_reservation_proposed CHECK (purpose <> 'proposed_substitute' OR substitution_id IS NOT NULL),
  CONSTRAINT resource_reservation_no_overlap
    EXCLUDE USING gist (resource_id WITH =, planned WITH &&) WHERE (status = 'active')
);
CREATE INDEX resource_reservation_booking_idx ON trucker.resource_reservation (booking_id) WHERE status = 'active';

-- Who is assigned to a booking. At most one active member for each role.
CREATE TABLE trucker.booking_assignment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id uuid NOT NULL REFERENCES trucker.booking (id),
  role text NOT NULL CHECK (role IN ('truck', 'trailer', 'driver')),
  vehicle_id uuid REFERENCES trucker.vehicle (id),
  affiliation_id uuid REFERENCES trucker.driver_affiliation (id),
  person_id uuid REFERENCES trucker.person (id),
  reservation_id uuid NOT NULL UNIQUE REFERENCES trucker.resource_reservation (id),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'ended')),
  -- The set numbers at which this member joined and left.
  set_no integer NOT NULL,
  ended_set_no integer,
  assigned_by uuid NOT NULL REFERENCES trucker.person (id),
  assigned_at timestamptz NOT NULL,
  ended_at timestamptz,
  CONSTRAINT booking_assignment_subject CHECK (
    (role IN ('truck', 'trailer') AND vehicle_id IS NOT NULL AND affiliation_id IS NULL AND person_id IS NULL)
    OR (role = 'driver' AND vehicle_id IS NULL AND affiliation_id IS NOT NULL AND person_id IS NOT NULL)),
  CONSTRAINT booking_assignment_ended CHECK (
    (status = 'ended') = (ended_at IS NOT NULL) AND (status = 'ended') = (ended_set_no IS NOT NULL))
);
CREATE UNIQUE INDEX booking_assignment_one_active ON trucker.booking_assignment (booking_id, role)
  WHERE status = 'active';
CREATE INDEX booking_assignment_driver_idx ON trucker.booking_assignment (person_id) WHERE status = 'active';

-- The confirmation: a fact about the past. It records the set that was confirmed and exactly
-- what was released to the carrier at that moment. Never changed, and not undone by anything
-- that happens to a resource afterwards.
CREATE TABLE trucker.booking_confirmation (
  booking_id uuid PRIMARY KEY REFERENCES trucker.booking (id),
  confirmed_at timestamptz NOT NULL,
  confirmed_by uuid NOT NULL REFERENCES trucker.person (id),
  set_no integer NOT NULL,
  resources jsonb NOT NULL,
  site_details jsonb NOT NULL
);
CREATE FUNCTION trucker.guard_booking_confirmation() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, trucker, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'a confirmation is a record of the past and cannot be changed or removed'
    USING ERRCODE = 'check_violation';
END
$$;
CREATE TRIGGER booking_confirmation_guard BEFORE UPDATE OR DELETE ON trucker.booking_confirmation
  FOR EACH ROW EXECUTE FUNCTION trucker.guard_booking_confirmation();

-- The driver's acknowledgement of one numbered set. A changed set has none until given again.
CREATE TABLE trucker.assignment_acknowledgement (
  booking_id uuid NOT NULL REFERENCES trucker.booking (id),
  set_no integer NOT NULL,
  person_id uuid NOT NULL REFERENCES trucker.person (id),
  acknowledged_at timestamptz NOT NULL,
  PRIMARY KEY (booking_id, set_no)
);

-- The shipper's explicit decision to wait after a missed assignment deadline (AB-4).
CREATE TABLE trucker.booking_wait_decision (
  booking_id uuid PRIMARY KEY REFERENCES trucker.booking (id),
  decided_by uuid NOT NULL REFERENCES trucker.person (id),
  decided_at timestamptz NOT NULL,
  assignment_due_at timestamptz NOT NULL,
  CONSTRAINT booking_wait_after_deadline CHECK (decided_at > assignment_due_at)
);

-- ---------------------------------------------------------------------------------------------
-- Actual occupancy. An episode is the fact that a resource is physically committed to a
-- booking. It opens at dispatch and closes by a recorded release; both belong to later slices,
-- and nothing here writes this table. It is created now so that the reservation checks and the
-- dispatch-readiness check can read it, and so that the rule "many closed, one open" is the
-- database's from the first row.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE trucker.occupancy_episode (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  resource_kind text NOT NULL CHECK (resource_kind IN ('truck', 'trailer', 'driver')),
  vehicle_id uuid REFERENCES trucker.vehicle (id),
  person_id uuid REFERENCES trucker.person (id),
  resource_id uuid GENERATED ALWAYS AS (coalesce(vehicle_id, person_id)) STORED,
  booking_id uuid NOT NULL REFERENCES trucker.booking (id),
  reservation_id uuid NOT NULL REFERENCES trucker.resource_reservation (id),
  opened_at timestamptz NOT NULL,
  closed_at timestamptz,
  release_reason text,
  CONSTRAINT occupancy_episode_subject CHECK (
    (resource_kind IN ('truck', 'trailer') AND vehicle_id IS NOT NULL AND person_id IS NULL)
    OR (resource_kind = 'driver' AND person_id IS NOT NULL AND vehicle_id IS NULL)),
  CONSTRAINT occupancy_episode_closed CHECK (
    (closed_at IS NULL) = (release_reason IS NULL) AND (closed_at IS NULL OR closed_at >= opened_at))
);
-- Any number of closed episodes for a resource, and at most one open one.
CREATE UNIQUE INDEX occupancy_episode_one_open ON trucker.occupancy_episode (resource_id) WHERE closed_at IS NULL;
CREATE INDEX occupancy_episode_resource_idx ON trucker.occupancy_episode (resource_id, opened_at);

-- A later booking seen to be at risk because a resource it holds is still occupied past the
-- planned end of an earlier one. Recorded once for each such occupancy.
CREATE TABLE trucker.booking_risk_flag (
  booking_id uuid NOT NULL REFERENCES trucker.booking (id),
  episode_id uuid NOT NULL REFERENCES trucker.occupancy_episode (id),
  recorded_at timestamptz NOT NULL,
  PRIMARY KEY (booking_id, episode_id)
);

ALTER TABLE trucker.booking_assignment_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE trucker.booking_substitution ENABLE ROW LEVEL SECURITY;
ALTER TABLE trucker.resource_reservation ENABLE ROW LEVEL SECURITY;
ALTER TABLE trucker.booking_assignment ENABLE ROW LEVEL SECURITY;
ALTER TABLE trucker.booking_confirmation ENABLE ROW LEVEL SECURITY;
ALTER TABLE trucker.assignment_acknowledgement ENABLE ROW LEVEL SECURITY;
ALTER TABLE trucker.booking_wait_decision ENABLE ROW LEVEL SECURITY;
ALTER TABLE trucker.occupancy_episode ENABLE ROW LEVEL SECURITY;
ALTER TABLE trucker.booking_risk_flag ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON trucker.booking_assignment_state, trucker.booking_substitution, trucker.resource_reservation,
  trucker.booking_assignment, trucker.booking_confirmation, trucker.assignment_acknowledgement,
  trucker.booking_wait_decision, trucker.occupancy_episode, trucker.booking_risk_flag FROM trucker_app, PUBLIC;

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
    'booking.created', 'booking.assignment_changed', 'booking.confirmed', 'booking.wait_decided',
    'substitution.proposed', 'substitution.accepted', 'substitution.declined', 'substitution.withdrawn',
    'substitution.checks_failed', 'assignment.acknowledged')),
  DROP CONSTRAINT audit_entry_record_type_check,
  ADD CONSTRAINT audit_entry_record_type_check CHECK (record_type IN (
    'organisation', 'shipment_draft', 'verification_application', 'quotation',
    'vehicle', 'driver_affiliation', 'driver_authorisation', 'fleet_document', 'booking',
    'booking_substitution'));
-- A booking is confirmed once, and a wait is decided once.
CREATE UNIQUE INDEX audit_entry_one_confirmation ON trucker.audit_entry (record_id)
  WHERE action IN ('booking.confirmed');
CREATE UNIQUE INDEX audit_entry_one_wait ON trucker.audit_entry (record_id)
  WHERE action IN ('booking.wait_decided');

-- ---------------------------------------------------------------------------------------------
-- Building blocks (not callable by the API)
-- ---------------------------------------------------------------------------------------------
-- Locks the resources a command is about, in one order, until the transaction ends. Every path
-- that reserves, releases or will occupy a resource takes these first.
CREATE FUNCTION trucker.resource_lock(p_resources uuid[]) RETURNS void
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  r uuid;
BEGIN
  FOR r IN SELECT DISTINCT x FROM unnest(p_resources) AS x WHERE x IS NOT NULL ORDER BY x LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('trucker.resource:' || r::text, 0));
  END LOOP;
END
$$;

-- Locks one booking's assigned set and returns its number.
CREATE FUNCTION trucker.assignment_state_lock(p_booking uuid, p_at timestamptz) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_set integer;
BEGIN
  INSERT INTO trucker.booking_assignment_state (booking_id, set_no, updated_at)
  VALUES (p_booking, 0, p_at) ON CONFLICT (booking_id) DO NOTHING;
  SELECT s.set_no INTO v_set FROM trucker.booking_assignment_state s WHERE s.booking_id = p_booking FOR UPDATE;
  RETURN v_set;
END
$$;

CREATE FUNCTION trucker.booking_planned(b trucker.booking) RETURNS tstzrange
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT tstzrange(b.planned_start_at, b.planned_end_at, '[)')
$$;

-- The active set of a booking.
CREATE FUNCTION trucker.assignment_current(
  p_booking uuid, OUT truck uuid, OUT trailer uuid, OUT affiliation uuid, OUT driver uuid
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
BEGIN
  SELECT a.vehicle_id INTO truck FROM trucker.booking_assignment a
  WHERE a.booking_id = p_booking AND a.role = 'truck' AND a.status = 'active';
  SELECT a.vehicle_id INTO trailer FROM trucker.booking_assignment a
  WHERE a.booking_id = p_booking AND a.role = 'trailer' AND a.status = 'active';
  SELECT a.affiliation_id, a.person_id INTO affiliation, driver FROM trucker.booking_assignment a
  WHERE a.booking_id = p_booking AND a.role = 'driver' AND a.status = 'active';
END
$$;

-- The hard requirements of a set, for the whole planned interval. NULL when every one holds;
-- otherwise the first that does not, as {"role", "reason"}. Nobody can waive these, and the
-- shipper's consent cannot make a failing resource eligible. Availability is a separate check.
-- With p_complete, a missing required member is itself a failure.
--   reasons: required | not_found | trailer_not_needed | truck_needed_first
--            | every reason of vehicle_eligibility and driver_eligibility
CREATE FUNCTION trucker.assignment_set_check(
  b trucker.booking, p_truck uuid, p_trailer uuid, p_affiliation uuid, p_complete boolean
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_equipment text := b.shipment_snapshot #>> '{equipment,type}';
  v_truck trucker.vehicle;
  v_needs_trailer boolean := false;
  v_reason text;
BEGIN
  IF p_truck IS NOT NULL THEN
    SELECT * INTO v_truck FROM trucker.vehicle x
    WHERE x.id = p_truck AND x.organisation_id = b.carrier_organisation_id AND x.kind = 'truck';
    IF NOT FOUND THEN
      RETURN jsonb_build_object('role', 'truck', 'reason', 'not_found');
    END IF;
    SELECT c.requires_trailer INTO v_needs_trailer FROM trucker.vehicle_category c WHERE c.code = v_truck.category_code;
    -- The cargo rides on the trailer where there is one, so the trailer carries the equipment type.
    v_reason := trucker.vehicle_eligibility(v_truck.id, b.carrier_organisation_id, b.planned_start_at,
                                            b.planned_end_at, CASE WHEN v_needs_trailer THEN NULL ELSE v_equipment END);
    IF v_reason <> 'eligible' THEN
      RETURN jsonb_build_object('role', 'truck', 'reason', v_reason);
    END IF;
  ELSIF p_complete THEN
    RETURN jsonb_build_object('role', 'truck', 'reason', 'required');
  END IF;
  IF p_trailer IS NOT NULL THEN
    IF p_truck IS NULL THEN
      RETURN jsonb_build_object('role', 'trailer', 'reason', 'truck_needed_first');
    END IF;
    IF NOT v_needs_trailer THEN
      RETURN jsonb_build_object('role', 'trailer', 'reason', 'trailer_not_needed');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM trucker.vehicle x
                   WHERE x.id = p_trailer AND x.organisation_id = b.carrier_organisation_id AND x.kind = 'trailer') THEN
      RETURN jsonb_build_object('role', 'trailer', 'reason', 'not_found');
    END IF;
    v_reason := trucker.vehicle_eligibility(p_trailer, b.carrier_organisation_id, b.planned_start_at,
                                            b.planned_end_at, v_equipment);
    IF v_reason <> 'eligible' THEN
      RETURN jsonb_build_object('role', 'trailer', 'reason', v_reason);
    END IF;
  ELSIF v_needs_trailer AND p_complete THEN
    RETURN jsonb_build_object('role', 'trailer', 'reason', 'required');
  END IF;
  IF p_affiliation IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM trucker.driver_affiliation x
                   WHERE x.id = p_affiliation AND x.organisation_id = b.carrier_organisation_id) THEN
      RETURN jsonb_build_object('role', 'driver', 'reason', 'not_found');
    END IF;
    -- Documents, authorisation and licence class, for the truck and for the trailer.
    v_reason := trucker.driver_eligibility(p_affiliation, p_truck, b.planned_start_at, b.planned_end_at);
    IF v_reason = 'eligible' AND p_trailer IS NOT NULL THEN
      v_reason := trucker.driver_eligibility(p_affiliation, p_trailer, b.planned_start_at, b.planned_end_at);
    END IF;
    IF v_reason <> 'eligible' THEN
      RETURN jsonb_build_object('role', 'driver', 'reason', v_reason);
    END IF;
  ELSIF p_complete THEN
    RETURN jsonb_build_object('role', 'driver', 'reason', 'required');
  END IF;
  RETURN NULL;
END
$$;

-- Why a resource cannot be newly reserved for [p_from, p_until) by this booking, or NULL.
--   reserved: another booking holds an active reservation that overlaps.
--   occupied: the resource is still physically committed to another booking past that booking's
--             planned end. While it is, it counts as taken until now, whatever the plan said.
-- The caller holds the resource lock.
CREATE FUNCTION trucker.reservation_blocker(
  p_resource uuid, p_booking uuid, p_from timestamptz, p_until timestamptz, p_at timestamptz
) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM trucker.resource_reservation r
                 WHERE r.resource_id = p_resource AND r.status = 'active' AND r.booking_id <> p_booking
                   AND r.planned && tstzrange(p_from, p_until, '[)')) THEN 'reserved'
    WHEN EXISTS (SELECT 1 FROM trucker.occupancy_episode e
                 JOIN trucker.resource_reservation r ON r.id = e.reservation_id
                 WHERE e.resource_id = p_resource AND e.closed_at IS NULL AND e.booking_id <> p_booking
                   AND greatest(upper(r.planned), p_at) > p_from) THEN 'occupied'
  END
$$;

-- Records, once each, what the clock now shows: an occupancy still open past its planned end,
-- and every later booking that holds the same resource. Nothing is cancelled or reassigned.
CREATE FUNCTION trucker.overrun_note(p_at timestamptz) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
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
END
$$;

CREATE FUNCTION trucker.assignment_audit(
  p_at timestamptz, p_person uuid, p_organisation uuid, p_action text, p_type text, p_record uuid,
  p_before jsonb, p_after jsonb
) RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
  INSERT INTO trucker.audit_entry
    (occurred_at, actor_person_id, organisation_id, action, record_type, record_id, request_id,
     before_values, after_values)
  VALUES (p_at, p_person, p_organisation, p_action, p_type, p_record,
          nullif(current_setting('trucker.request_id', true), ''), p_before, p_after)
$$;

CREATE FUNCTION trucker.category_name(p_code text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
  SELECT jsonb_build_object('code', c.code, 'en', c.name_en, 'ar', c.name_ar, 'ur', c.name_ur)
  FROM trucker.vehicle_category c WHERE c.code = p_code
$$;

-- One vehicle as a party may see it. The shipper is shown the registration only (AB-3).
CREATE FUNCTION trucker.assignment_vehicle_values(p_vehicle uuid, p_audience text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
  SELECT jsonb_build_object('registrationCountry', v.registration_country, 'registrationNumber', v.registration_number)
         || CASE WHEN p_audience = 'shipper' THEN '{}'::jsonb ELSE jsonb_build_object(
              'id', v.id, 'category', trucker.category_name(v.category_code), 'equipmentType', v.equipment_type) END
  FROM trucker.vehicle v WHERE v.id = p_vehicle
$$;
-- One driver as a party may see them: a name. Never a phone or a document.
CREATE FUNCTION trucker.assignment_driver_values(p_affiliation uuid, p_audience text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
  SELECT jsonb_build_object('name', p.display_name)
         || CASE WHEN p_audience = 'shipper' THEN '{}'::jsonb ELSE jsonb_build_object('affiliationId', a.id) END
  FROM trucker.driver_affiliation a JOIN trucker.person p ON p.id = a.person_id WHERE a.id = p_affiliation
$$;
CREATE FUNCTION trucker.assignment_set_values(p_truck uuid, p_trailer uuid, p_affiliation uuid, p_audience text)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
  SELECT jsonb_build_object(
    'truck', trucker.assignment_vehicle_values(p_truck, p_audience),
    'trailer', trucker.assignment_vehicle_values(p_trailer, p_audience),
    'driver', trucker.assignment_driver_values(p_affiliation, p_audience))
$$;

-- What makes a proposed set materially different from the current one: a truck or trailer of
-- another category, or a trailer added or taken away. A like-for-like vehicle and a change of
-- driver are not material. An empty list means the change may take effect at once.
CREATE FUNCTION trucker.assignment_differences(
  p_old_truck uuid, p_old_trailer uuid, p_new_truck uuid, p_new_trailer uuid
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
DECLARE
  result jsonb := '[]'::jsonb;
  v_old text;
  v_new text;
BEGIN
  SELECT v.category_code INTO v_old FROM trucker.vehicle v WHERE v.id = p_old_truck;
  SELECT v.category_code INTO v_new FROM trucker.vehicle v WHERE v.id = p_new_truck;
  IF v_old IS DISTINCT FROM v_new THEN
    result := result || jsonb_build_object('role', 'truck', 'change', 'category',
                                           'from', trucker.category_name(v_old), 'to', trucker.category_name(v_new));
  END IF;
  v_old := NULL;
  v_new := NULL;
  SELECT v.category_code INTO v_old FROM trucker.vehicle v WHERE v.id = p_old_trailer;
  SELECT v.category_code INTO v_new FROM trucker.vehicle v WHERE v.id = p_new_trailer;
  IF v_old IS NULL AND v_new IS NOT NULL THEN
    result := result || jsonb_build_object('role', 'trailer', 'change', 'added', 'to', trucker.category_name(v_new));
  ELSIF v_old IS NOT NULL AND v_new IS NULL THEN
    result := result || jsonb_build_object('role', 'trailer', 'change', 'removed', 'from', trucker.category_name(v_old));
  ELSIF v_old IS DISTINCT FROM v_new THEN
    result := result || jsonb_build_object('role', 'trailer', 'change', 'category',
                                           'from', trucker.category_name(v_old), 'to', trucker.category_name(v_new));
  END IF;
  RETURN result;
END
$$;

-- Replaces the active set with a new one, in the caller's transaction: members that leave are
-- ended and their reservations released, then members that join are reserved and assigned.
-- With p_substitution, a joining member's reservation is the one already held for that proposal.
-- An overlap raises exclusion_violation; the caller turns that into a refusal that changes
-- nothing. Returns the new set number.
CREATE FUNCTION trucker.assignment_apply(
  b trucker.booking, p_truck uuid, p_trailer uuid, p_affiliation uuid, p_actor uuid, p_at timestamptz,
  p_release_reason text, p_substitution uuid
) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
DECLARE
  cur record;
  v_set integer;
  v_person uuid;
  v_reservation uuid;
  item record;
BEGIN
  SELECT * INTO cur FROM trucker.assignment_current(b.id);
  UPDATE trucker.booking_assignment_state s SET set_no = s.set_no + 1, updated_at = p_at
  WHERE s.booking_id = b.id RETURNING s.set_no INTO v_set;
  SELECT a.person_id INTO v_person FROM trucker.driver_affiliation a WHERE a.id = p_affiliation;
  -- Members that leave.
  FOR item IN
    SELECT a.id, a.reservation_id FROM trucker.booking_assignment a
    WHERE a.booking_id = b.id AND a.status = 'active'
      AND ((a.role = 'truck' AND a.vehicle_id IS DISTINCT FROM p_truck)
        OR (a.role = 'trailer' AND a.vehicle_id IS DISTINCT FROM p_trailer)
        OR (a.role = 'driver' AND a.affiliation_id IS DISTINCT FROM p_affiliation))
  LOOP
    UPDATE trucker.booking_assignment a SET status = 'ended', ended_at = p_at, ended_set_no = v_set WHERE a.id = item.id;
    UPDATE trucker.resource_reservation r
    SET status = 'released', released_at = p_at, release_reason = p_release_reason WHERE r.id = item.reservation_id;
  END LOOP;
  -- Members that join.
  FOR item IN
    SELECT * FROM (VALUES
      ('truck', p_truck, NULL::uuid, NULL::uuid, cur.truck IS DISTINCT FROM p_truck),
      ('trailer', p_trailer, NULL::uuid, NULL::uuid, cur.trailer IS DISTINCT FROM p_trailer),
      ('driver', NULL::uuid, p_affiliation, v_person, cur.affiliation IS DISTINCT FROM p_affiliation)
    ) AS m (role, vehicle, affiliation, person, changed)
    WHERE m.changed AND coalesce(m.vehicle, m.affiliation) IS NOT NULL
  LOOP
    v_reservation := NULL;
    IF p_substitution IS NOT NULL THEN
      UPDATE trucker.resource_reservation r SET purpose = 'assignment'
      WHERE r.substitution_id = p_substitution AND r.status = 'active' AND r.purpose = 'proposed_substitute'
        AND r.resource_id = coalesce(item.vehicle, item.person)
      RETURNING r.id INTO v_reservation;
    END IF;
    IF v_reservation IS NULL THEN
      INSERT INTO trucker.resource_reservation
        (booking_id, resource_kind, vehicle_id, person_id, purpose, planned, created_by, created_at)
      VALUES (b.id, item.role, item.vehicle, item.person, 'assignment', trucker.booking_planned(b), p_actor, p_at)
      RETURNING id INTO v_reservation;
    END IF;
    INSERT INTO trucker.booking_assignment
      (booking_id, role, vehicle_id, affiliation_id, person_id, reservation_id, set_no, assigned_by, assigned_at)
    VALUES (b.id, item.role, item.vehicle, item.affiliation, item.person, v_reservation, v_set, p_actor, p_at);
  END LOOP;
  RETURN v_set;
END
$$;

-- What stands between this booking and dispatch, judged now. An empty list means nothing does.
-- It reads the confirmation but never changes it: a booking that was confirmed stays confirmed,
-- and a resource that has since lost eligibility shows here as needing reassignment.
--   not_confirmed | needs_reassignment (role, reason) | resource_occupied (role)
--   | resource_overrunning (role) | acknowledgement_missing
-- The dispatch slice refuses on the same list, at its own moment.
CREATE FUNCTION trucker.booking_dispatch_blockers(b trucker.booking, p_at timestamptz) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
DECLARE
  result jsonb := '[]'::jsonb;
  cur record;
  v_confirmed boolean := EXISTS (SELECT 1 FROM trucker.booking_confirmation c WHERE c.booking_id = b.id);
  v_failure jsonb;
  item record;
BEGIN
  SELECT * INTO cur FROM trucker.assignment_current(b.id);
  IF NOT v_confirmed THEN
    result := result || jsonb_build_object('code', 'not_confirmed');
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
$$;

-- An open proposal as a party may see it.
CREATE FUNCTION trucker.substitution_values(s trucker.booking_substitution, p_audience text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
  SELECT jsonb_build_object(
    'id', s.id, 'status', s.status, 'version', s.row_version, 'proposedAt', s.proposed_at,
    'differences', s.differences,
    'proposed', trucker.assignment_set_values(s.truck_id, s.trailer_id, s.affiliation_id, p_audience))
$$;

-- A booking with its present state, for one audience: shipper | carrier | staff.
--   The carrier and staff see the assigned set as it stands. The shipper sees registration
--   numbers and the driver's name once the booking is confirmed, and the reasons a resource is
--   not eligible never: only that the booking needs reassignment.
--   The carrier sees the addresses and access notes once the booking is confirmed, from the
--   record of what was released then. No site contact exists to show.
CREATE FUNCTION trucker.booking_view(b trucker.booking, p_audience text, p_at timestamptz) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
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
  RETURN trucker.booking_values(b) || jsonb_build_object(
    'status', CASE WHEN c.booking_id IS NOT NULL THEN 'confirmed' ELSE 'awaiting_resources' END,
    'confirmedAt', c.confirmed_at,
    'overdue', c.booking_id IS NULL AND p_at > b.assignment_due_at,
    'waitDecision', CASE WHEN w.booking_id IS NOT NULL THEN jsonb_build_object('decidedAt', w.decided_at) END,
    'assignmentVersion', v_set,
    'dispatch', jsonb_build_object('ready', jsonb_array_length(v_blockers) = 0, 'blockers', v_shown),
    'needsReassignment', v_blockers @> '[{"code": "needs_reassignment"}]'::jsonb,
    'atRisk', v_blockers @> '[{"code": "resource_overrunning"}]'::jsonb,
    'acknowledgedAt', v_acknowledged,
    'resources', CASE WHEN p_audience <> 'shipper' OR c.booking_id IS NOT NULL
                      THEN trucker.assignment_set_values(cur.truck, cur.trailer, cur.affiliation, p_audience) END,
    'substitution', CASE WHEN s.id IS NOT NULL THEN trucker.substitution_values(s, p_audience) END,
    'site', CASE WHEN p_audience <> 'shipper' AND c.booking_id IS NOT NULL THEN c.site_details END);
END
$$;

-- The carrier's own resources as candidates for this booking, each with the first reason it
-- cannot be assigned now, or "eligible". Availability is part of the answer here.
CREATE FUNCTION trucker.assignment_candidates(b trucker.booking, p_at timestamptz) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_equipment text := b.shipment_snapshot #>> '{equipment,type}';
BEGIN
  RETURN jsonb_build_object(
    'vehicles', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'id', v.id, 'kind', v.kind, 'registrationCountry', v.registration_country,
               'registrationNumber', v.registration_number, 'category', trucker.category_name(v.category_code),
               'equipmentType', v.equipment_type, 'requiresTrailer', c.requires_trailer,
               'state', coalesce(
                 nullif(trucker.vehicle_eligibility(
                   v.id, b.carrier_organisation_id, b.planned_start_at, b.planned_end_at,
                   CASE WHEN c.requires_trailer THEN NULL ELSE v_equipment END), 'eligible'),
                 trucker.reservation_blocker(v.id, b.id, b.planned_start_at, b.planned_end_at, p_at),
                 'eligible'))
             ORDER BY v.kind DESC, v.registration_number, v.id)
      FROM trucker.vehicle v JOIN trucker.vehicle_category c ON c.code = v.category_code
      WHERE v.organisation_id = b.carrier_organisation_id AND v.status = 'active'), '[]'::jsonb),
    'drivers', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'affiliationId', a.id, 'name', p.display_name,
               'state', coalesce(
                 nullif(trucker.driver_eligibility(a.id, NULL, b.planned_start_at, b.planned_end_at), 'eligible'),
                 trucker.reservation_blocker(a.person_id, b.id, b.planned_start_at, b.planned_end_at, p_at),
                 'eligible'))
             ORDER BY p.display_name, a.id)
      FROM trucker.driver_affiliation a JOIN trucker.person p ON p.id = a.person_id
      WHERE a.organisation_id = b.carrier_organisation_id AND a.status = 'active'), '[]'::jsonb));
END
$$;

-- Violations of the reservation rules, for the consistency check (AT-234). Empty when every
-- booking is as it should be. Released reservations and closed episodes are history and are
-- never reported.
CREATE FUNCTION trucker.booking_consistency() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object('code', x.code, 'booking', x.booking, 'record', x.record)
                            ORDER BY x.code, x.booking, x.record), '[]'::jsonb)
  FROM (
    -- A confirmed booking without an active member for a role it requires.
    SELECT 'confirmed_missing_member' AS code, c.booking_id AS booking, c.booking_id AS record
    FROM trucker.booking_confirmation c
    WHERE NOT EXISTS (SELECT 1 FROM trucker.booking_assignment a
                      WHERE a.booking_id = c.booking_id AND a.role = 'truck' AND a.status = 'active')
       OR NOT EXISTS (SELECT 1 FROM trucker.booking_assignment a
                      WHERE a.booking_id = c.booking_id AND a.role = 'driver' AND a.status = 'active')
       OR (EXISTS (SELECT 1 FROM trucker.booking_assignment a
                   JOIN trucker.vehicle v ON v.id = a.vehicle_id
                   JOIN trucker.vehicle_category k ON k.code = v.category_code
                   WHERE a.booking_id = c.booking_id AND a.role = 'truck' AND a.status = 'active' AND k.requires_trailer)
           AND NOT EXISTS (SELECT 1 FROM trucker.booking_assignment a
                           WHERE a.booking_id = c.booking_id AND a.role = 'trailer' AND a.status = 'active'))
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
  ) AS x
$$;

-- ---------------------------------------------------------------------------------------------
-- The carrier sets the assigned set of a booking: the whole set it wants, members it leaves out
-- being unassigned. Before confirmation a partial set is allowed. From confirmation on the set
-- stays complete, and the old members remain until their replacements commit.
--   status: assigned | confirmed | unchanged | proposed | conflict | not_eligible | not_free
--           | incomplete | substitution_open | closed | unauthorized | not_found | not_carrier
--   detail: the booking as the carrier sees it; for not_eligible and not_free, {"role", "reason"}
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION trucker.set_booking_assignment(
  p_booking uuid, p_expected_version integer, p_truck uuid, p_trailer uuid, p_affiliation uuid,
  p_allow_fixtures boolean, OUT status text, OUT detail jsonb
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
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
  PERFORM trucker.overrun_note(v_at);

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
                           'confirms', NOT v_confirmed AND v_complete));
      status := 'assigned';
      IF NOT v_confirmed AND v_complete THEN
        -- Every required resource is assigned, eligible for the whole interval and reserved.
        INSERT INTO trucker.booking_confirmation (booking_id, confirmed_at, confirmed_by, set_no, resources, site_details)
        SELECT b.id, v_at, entered.actor, v_new_set,
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
$$;

-- ---------------------------------------------------------------------------------------------
-- A decision on an open proposal: the shipper accepts or declines; the carrier withdraws.
-- Acceptance runs the hard requirements again at that moment. A substitute that fails them
-- ends the proposal as failed: the shipper's acceptance cannot make it eligible.
--   status: accepted | declined | withdrawn | already_decided | conflict | checks_failed
--           | closed | invalid | unauthorized | not_found
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION trucker.decide_booking_substitution(
  p_substitution uuid, p_expected_version integer, p_decision text, p_allow_fixtures boolean,
  OUT status text, OUT detail jsonb
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
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
$$;

-- ---------------------------------------------------------------------------------------------
-- The shipper's explicit decision to wait once the assignment deadline has passed. It records
-- a decision and changes nothing else: nothing is cancelled, reassigned or charged.
--   status: recorded | already_recorded | not_due | confirmed | unauthorized | not_found
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION trucker.record_booking_wait(p_booking uuid, OUT status text, OUT detail jsonb)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
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
$$;

-- ---------------------------------------------------------------------------------------------
-- The driver: their own current assignments, and their acknowledgement of one.
-- A driver sees a booking only while they are its assigned driver and affiliated with its
-- carrier, and then only what a driver needs before dispatch: the carrier, the places as areas,
-- the windows, the cargo and the vehicles. No price, no fee, no address and no shipper.
-- ---------------------------------------------------------------------------------------------
--   status: ok | unauthorized
CREATE FUNCTION trucker.driver_assignments(p_allow_fixtures boolean, OUT status text, OUT detail jsonb)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
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
           ORDER BY b.planned_start_at, b.id)
    FROM trucker.booking_assignment a
    JOIN trucker.booking b ON b.id = a.booking_id
    JOIN trucker.booking_assignment_state s ON s.booking_id = b.id
    JOIN trucker.driver_affiliation f ON f.id = a.affiliation_id
    WHERE a.role = 'driver' AND a.status = 'active' AND a.person_id = actor
      AND f.status = 'active' AND f.organisation_id = b.carrier_organisation_id
      AND trucker.booking_terms_available(p_allow_fixtures)), '[]'::jsonb);
END
$$;

--   status: recorded | already_recorded | conflict | unauthorized | not_found
CREATE FUNCTION trucker.driver_assignment_receipt(p_booking uuid, p_expected_version integer, OUT status text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
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
$$;

-- ---------------------------------------------------------------------------------------------
-- Reading
-- ---------------------------------------------------------------------------------------------
-- One booking, for an administrator of its shipper or of its carrier.
--   status: ok | unauthorized | not_found
CREATE FUNCTION trucker.booking_detail(p_booking uuid, p_allow_fixtures boolean, OUT status text, OUT detail jsonb)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
DECLARE
  actor uuid := trucker.request_person();
  v_org uuid := trucker.request_organisation();
  b trucker.booking;
  v_at timestamptz;
  v_role text;
BEGIN
  IF actor IS NULL THEN
    status := 'unauthorized';
    RETURN;
  END IF;
  IF v_org IS NULL OR NOT trucker.is_admin(v_org) THEN
    status := 'not_found';
    RETURN;
  END IF;
  SELECT * INTO b FROM trucker.booking x
  WHERE x.id = p_booking AND v_org IN (x.shipper_organisation_id, x.carrier_organisation_id);
  IF NOT FOUND THEN
    status := 'not_found';
    RETURN;
  END IF;
  v_at := trucker.clock_now();
  PERFORM trucker.overrun_note(v_at);
  v_role := CASE WHEN b.shipper_organisation_id = v_org THEN 'shipper' ELSE 'carrier' END;
  status := 'ok';
  detail := jsonb_build_object(
    'open', trucker.booking_terms_available(p_allow_fixtures),
    'booking', trucker.booking_view(b, v_role, v_at) || jsonb_build_object('role', v_role),
    'candidates', CASE WHEN v_role = 'carrier' AND trucker.capability_effective(v_org, 'carry_as_company')
                       THEN trucker.assignment_candidates(b, v_at) END);
END
$$;

-- The earlier readers now show the present state.
CREATE OR REPLACE FUNCTION trucker.booking_overview(p_shipment uuid, p_allow_fixtures boolean, OUT status text, OUT detail jsonb)
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
    'booking', CASE WHEN b.id IS NOT NULL THEN trucker.booking_view(b, 'shipper', v_at) END,
    'acceptance', coalesce((
      SELECT jsonb_agg(trucker.acceptance_preview(q, d, v_at, p_allow_fixtures) ORDER BY q.created_at, q.id)
      FROM trucker.quotation q WHERE q.shipment_id = d.id AND q.status = 'submitted'), '[]'::jsonb));
END
$$;

CREATE OR REPLACE FUNCTION trucker.organisation_bookings(OUT status text, OUT detail jsonb)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
DECLARE
  actor uuid := trucker.request_person();
  v_org uuid := trucker.request_organisation();
  v_at timestamptz := trucker.clock_now();
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
    SELECT jsonb_agg(
             trucker.booking_view(b, CASE WHEN b.shipper_organisation_id = v_org THEN 'shipper' ELSE 'carrier' END, v_at)
             || jsonb_build_object('role', CASE WHEN b.shipper_organisation_id = v_org THEN 'shipper' ELSE 'carrier' END)
           ORDER BY b.accepted_at DESC, b.id)
    FROM trucker.booking b
    WHERE b.shipper_organisation_id = v_org OR b.carrier_organisation_id = v_org), '[]'::jsonb);
END
$$;

CREATE OR REPLACE FUNCTION trucker.staff_shipment_booking(
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
  PERFORM trucker.overrun_note(entered.at);
  SELECT * INTO b FROM trucker.booking x WHERE x.shipment_id = p_shipment;
  detail := jsonb_build_object('booking', CASE WHEN b.id IS NOT NULL THEN trucker.booking_view(b, 'staff', entered.at) END);
END
$$;

-- Staff: the bookings that need someone's attention, and the consistency check. Read-only:
-- nothing here cancels, reassigns or releases. Each look is recorded.
--   status: ok | unauthorized | forbidden
CREATE FUNCTION trucker.staff_booking_attention(p_token_hash text, p_request_id text, OUT status text, OUT detail jsonb)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
DECLARE
  entered record;
BEGIN
  SELECT * INTO entered FROM trucker.staff_enter(p_token_hash, NULL, 'staff.booking_attention', NULL, p_request_id);
  status := entered.status;
  IF status <> 'ok' THEN
    RETURN;
  END IF;
  IF NOT (trucker.staff_privileges(entered.staff_id) && ARRAY['reviewer', 'staff_admin']) THEN
    PERFORM trucker.staff_audit(entered.at, entered.staff_id, 'staff.booking_attention', 'refused', NULL, p_request_id,
                                jsonb_build_object('reason', 'privilege_not_held'));
    status := 'forbidden';
    RETURN;
  END IF;
  PERFORM trucker.staff_audit(entered.at, entered.staff_id, 'staff.booking_attention', 'done', NULL, p_request_id, '{}'::jsonb);
  PERFORM trucker.overrun_note(entered.at);
  detail := jsonb_build_object(
    'bookings', coalesce((
      SELECT jsonb_agg(x.item ORDER BY x.due, x.id)
      FROM (
        SELECT b.id, b.assignment_due_at AS due, jsonb_build_object(
                 'id', v ->> 'id', 'shipmentId', v ->> 'shipmentId', 'status', v ->> 'status',
                 'shipper', v -> 'shipper', 'carrier', v -> 'carrier',
                 'assignmentDueAt', b.assignment_due_at, 'overdue', v -> 'overdue',
                 'waitDecision', v -> 'waitDecision', 'needsReassignment', v -> 'needsReassignment',
                 'atRisk', v -> 'atRisk', 'substitutionOpen', (v -> 'substitution') <> 'null'::jsonb,
                 'blockers', v #> '{dispatch,blockers}') AS item
        FROM trucker.booking b
        CROSS JOIN LATERAL trucker.booking_view(b, 'staff', entered.at) AS v
        WHERE (v ->> 'overdue')::boolean OR (v ->> 'needsReassignment')::boolean OR (v ->> 'atRisk')::boolean
           OR (v -> 'substitution') <> 'null'::jsonb
        ORDER BY b.assignment_due_at, b.id LIMIT 200) AS x), '[]'::jsonb),
    'consistency', trucker.booking_consistency());
END
$$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA trucker FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  trucker.set_booking_assignment(uuid, integer, uuid, uuid, uuid, boolean),
  trucker.decide_booking_substitution(uuid, integer, text, boolean),
  trucker.record_booking_wait(uuid),
  trucker.driver_assignments(boolean),
  trucker.driver_assignment_receipt(uuid, integer),
  trucker.booking_detail(uuid, boolean),
  trucker.staff_booking_attention(text, text)
TO trucker_app;
