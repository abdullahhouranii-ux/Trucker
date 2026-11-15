-- 0017: cancellation before dispatch and one booking per publication cycle.
-- No charge or compensation is calculated. Commercial/legal production rules stay gated.

CREATE TABLE trucker.booking_publication_cycle (
  booking_id uuid PRIMARY KEY REFERENCES trucker.booking(id),
  shipment_id uuid NOT NULL REFERENCES trucker.shipment_draft(id),
  cycle_id uuid NOT NULL,
  UNIQUE (shipment_id, cycle_id)
);
INSERT INTO trucker.booking_publication_cycle
  SELECT b.id, b.shipment_id, d.publication_cycle FROM trucker.booking b
  JOIN trucker.shipment_draft d ON d.id = b.shipment_id;
ALTER TABLE trucker.booking_publication_cycle ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON trucker.booking_publication_cycle FROM PUBLIC, trucker_app;
CREATE FUNCTION trucker.booking_cycle_stamp() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
BEGIN
  INSERT INTO trucker.booking_publication_cycle (booking_id, shipment_id, cycle_id)
    SELECT NEW.id, NEW.shipment_id, d.publication_cycle FROM trucker.shipment_draft d
    WHERE d.id = NEW.shipment_id;
  RETURN NEW;
END
$$;
CREATE TRIGGER booking_cycle_stamp AFTER INSERT ON trucker.booking
  FOR EACH ROW EXECUTE FUNCTION trucker.booking_cycle_stamp();
CREATE TRIGGER booking_cycle_immutable BEFORE UPDATE OR DELETE ON trucker.booking_publication_cycle
  FOR EACH ROW EXECUTE FUNCTION trucker.guard_booking();
ALTER TABLE trucker.booking DROP CONSTRAINT booking_shipment_id_key;
DROP INDEX trucker.quotation_one_accepted;
-- The immutable cycle map enforces exactly one booking per publication cycle. The booking's
-- quotation_id remains unique, so an earlier accepted quotation can never be awarded again.

CREATE TABLE trucker.booking_cancellation (
  booking_id uuid PRIMARY KEY REFERENCES trucker.booking(id),
  cancelled_by uuid NOT NULL REFERENCES trucker.person(id),
  cancelling_organisation uuid NOT NULL REFERENCES trucker.organisation(id),
  party text NOT NULL CHECK (party IN ('shipper', 'carrier')),
  cancelled_at timestamptz NOT NULL,
  reason text NOT NULL CHECK (reason IN ('shipment_no_longer_needed','dates_changed',
    'carrier_did_not_assign','resource_unavailable','cannot_meet_window','other')),
  note text CHECK (note IS NULL OR length(note) <= 2000),
  set_no integer NOT NULL,
  pickup_in_seconds numeric NOT NULL,
  was_confirmed boolean NOT NULL,
  assignment_overdue boolean NOT NULL,
  wait_decided_at timestamptz,
  terms_code text NOT NULL,
  terms_version integer NOT NULL,
  terms_hash text NOT NULL,
  charge_basis text NOT NULL DEFAULT 'none_recorded' CHECK (charge_basis = 'none_recorded'),
  CONSTRAINT cancellation_note CHECK (reason <> 'other' OR length(btrim(note)) > 0),
  CONSTRAINT cancellation_reason_party CHECK (reason = 'other'
    OR (party = 'shipper' AND reason IN ('shipment_no_longer_needed','dates_changed','carrier_did_not_assign'))
    OR (party = 'carrier' AND reason IN ('resource_unavailable','cannot_meet_window')))
);
ALTER TABLE trucker.booking_cancellation ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON trucker.booking_cancellation FROM PUBLIC, trucker_app;
CREATE TRIGGER booking_cancellation_immutable BEFORE UPDATE OR DELETE ON trucker.booking_cancellation
  FOR EACH ROW EXECUTE FUNCTION trucker.guard_booking();
ALTER TABLE trucker.resource_reservation DROP CONSTRAINT resource_reservation_release_reason_check;
ALTER TABLE trucker.resource_reservation ADD CONSTRAINT resource_reservation_release_reason_check
  CHECK (release_reason IS NULL OR release_reason IN ('unassigned','reassigned','substituted',
    'proposal_declined','proposal_withdrawn','proposal_failed','booking_cancelled'));
ALTER TABLE trucker.booking_substitution DROP CONSTRAINT booking_substitution_status_check;
ALTER TABLE trucker.booking_substitution ADD CONSTRAINT booking_substitution_status_check
  CHECK (status IN ('proposed','accepted','declined','withdrawn','failed_checks','cancelled'));
ALTER TABLE trucker.shipment_draft DROP CONSTRAINT shipment_draft_status_check;
ALTER TABLE trucker.shipment_draft ADD CONSTRAINT shipment_draft_status_check
  CHECK (status IN ('draft','discarded','published','withdrawn','expired','awarded','booking_cancelled'));

CREATE FUNCTION trucker.cancellation_values(p_booking uuid, p_audience text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
  SELECT jsonb_build_object('party', c.party, 'at', c.cancelled_at, 'reason', c.reason,
    'note', CASE WHEN p_audience IN (c.party, 'staff') THEN c.note END,
    'chargeBasis', c.charge_basis, 'wasConfirmed', c.was_confirmed,
    'assignmentOverdue', c.assignment_overdue, 'waitDecidedAt', c.wait_decided_at)
  FROM trucker.booking_cancellation c WHERE c.booking_id = p_booking
$$;

CREATE FUNCTION trucker.cancel_booking(p_booking uuid, p_expected_version integer, p_reason text,
  p_note text, p_allow_fixtures boolean, OUT status text, OUT detail jsonb)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
DECLARE
  actor uuid := trucker.request_person(); org uuid := trucker.request_organisation();
  b trucker.booking; c trucker.booking_cancellation; t timestamptz; n integer; party text;
BEGIN
  IF actor IS NULL THEN status := 'unauthorized'; RETURN; END IF;
  IF org IS NULL OR NOT trucker.is_admin(org) THEN status := 'not_found'; RETURN; END IF;
  SELECT * INTO b FROM trucker.booking x WHERE x.id = p_booking
    AND org IN (x.shipper_organisation_id, x.carrier_organisation_id);
  IF NOT FOUND THEN status := 'not_found'; RETURN; END IF;
  IF NOT trucker.booking_terms_available(p_allow_fixtures) THEN status := 'closed'; RETURN; END IF;
  PERFORM 1 FROM trucker.organisation o
    WHERE o.id IN (b.shipper_organisation_id, b.carrier_organisation_id) ORDER BY o.id FOR SHARE;
  PERFORM 1 FROM trucker.shipment_draft d WHERE d.id = b.shipment_id FOR UPDATE;
  n := trucker.assignment_state_lock(b.id, trucker.clock_now());
  PERFORM trucker.resource_lock(ARRAY(SELECT r.resource_id FROM trucker.resource_reservation r
    WHERE r.booking_id = b.id AND r.status = 'active' ORDER BY r.resource_id));
  t := trucker.clock_now();
  IF trucker.request_person() IS DISTINCT FROM actor OR NOT trucker.is_admin(org) THEN
    status := 'unauthorized'; RETURN;
  END IF;
  party := CASE WHEN org = b.shipper_organisation_id THEN 'shipper' ELSE 'carrier' END;
  SELECT * INTO c FROM trucker.booking_cancellation x WHERE x.booking_id = b.id;
  IF FOUND THEN status := 'already_cancelled'; detail := trucker.booking_view(b, party, t); RETURN; END IF;
  -- An episode, including a closed one, proves dispatch has occurred. The future dispatch
  -- function must take the assignment-state lock before opening an episode.
  IF EXISTS (SELECT 1 FROM trucker.occupancy_episode e WHERE e.booking_id = b.id) THEN
    status := 'already_dispatched'; RETURN;
  END IF;
  IF p_expected_version IS DISTINCT FROM n THEN status := 'conflict'; RETURN; END IF;
  IF p_reason IS NULL OR p_reason NOT IN ('shipment_no_longer_needed','dates_changed',
      'carrier_did_not_assign','resource_unavailable','cannot_meet_window','other')
     OR (party = 'shipper' AND p_reason IN ('resource_unavailable','cannot_meet_window'))
     OR (party = 'carrier' AND p_reason IN ('shipment_no_longer_needed','dates_changed','carrier_did_not_assign'))
     OR length(coalesce(p_note,'')) > 2000
     OR (p_reason = 'other' AND length(btrim(coalesce(p_note,''))) = 0) THEN
    status := 'invalid'; RETURN;
  END IF;
  INSERT INTO trucker.booking_cancellation
    (booking_id,cancelled_by,cancelling_organisation,party,cancelled_at,reason,note,set_no,
      pickup_in_seconds,was_confirmed,assignment_overdue,wait_decided_at,terms_code,terms_version,terms_hash)
    VALUES (b.id,actor,org,party,t,p_reason,nullif(p_note,''),n,extract(epoch FROM b.pickup_from_at-t),
      EXISTS (SELECT 1 FROM trucker.booking_confirmation x WHERE x.booking_id=b.id),
      b.assignment_due_at<t,(SELECT w.decided_at FROM trucker.booking_wait_decision w WHERE w.booking_id=b.id),
      b.terms_code,b.terms_version,b.terms_hash);
  UPDATE trucker.resource_reservation x SET status='released',released_at=t,release_reason='booking_cancelled'
    WHERE x.booking_id=b.id AND x.status='active';
  UPDATE trucker.booking_assignment x SET status='ended',ended_at=t,ended_set_no=n+1
    WHERE x.booking_id=b.id AND x.status='active';
  UPDATE trucker.booking_substitution x SET status='cancelled',decided_at=t,decided_by=actor,row_version=row_version+1
    WHERE x.booking_id=b.id AND x.status='proposed';
  UPDATE trucker.booking_assignment_state x SET set_no=n+1,updated_at=t WHERE x.booking_id=b.id;
  UPDATE trucker.shipment_draft d SET status='booking_cancelled',awarded_at=NULL,updated_at=t,version=version+1
    WHERE d.id=b.shipment_id;
  -- Notes never enter shared participant history. They are restricted by cancellation_values.
  INSERT INTO trucker.audit_entry
    (occurred_at,actor_person_id,organisation_id,action,record_type,record_id,request_id,before_values,after_values)
    SELECT t,actor,o,'booking.cancelled','booking',b.id,
      nullif(current_setting('trucker.request_id',true),''),NULL,
      jsonb_build_object('party',party,'reason',p_reason,'chargeBasis','none_recorded')
    FROM unnest(ARRAY[b.shipper_organisation_id,b.carrier_organisation_id]) o;
  status := 'cancelled'; detail := trucker.booking_view(b,party,t);
END
$$;
REVOKE ALL ON FUNCTION trucker.booking_cycle_stamp(),trucker.cancellation_values(uuid,text),
  trucker.cancel_booking(uuid,integer,text,text,boolean) FROM PUBLIC, trucker_app;
GRANT EXECUTE ON FUNCTION trucker.cancel_booking(uuid,integer,text,text,boolean) TO trucker_app;

-- Existing entry points retain their signatures and least-privilege grants.

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
    'substitution.checks_failed', 'assignment.acknowledged', 'booking.cancelled'));

CREATE OR REPLACE FUNCTION trucker.set_booking_assignment(
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
  IF EXISTS (SELECT 1 FROM trucker.booking_cancellation x WHERE x.booking_id = b.id) THEN
    status := 'cancelled'; RETURN;
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

CREATE OR REPLACE FUNCTION trucker.decide_booking_substitution(
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
  IF EXISTS (SELECT 1 FROM trucker.booking_cancellation x WHERE x.booking_id = b.id) THEN
    status := 'cancelled'; RETURN;
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
$$;

CREATE OR REPLACE FUNCTION trucker.record_booking_wait(p_booking uuid, OUT status text, OUT detail jsonb)
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
  IF EXISTS (SELECT 1 FROM trucker.booking_cancellation x WHERE x.booking_id = b.id) THEN
    status := 'cancelled'; RETURN;
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
$$;

CREATE OR REPLACE FUNCTION trucker.driver_assignment_receipt(p_booking uuid, p_expected_version integer, OUT status text)
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
  IF EXISTS (SELECT 1 FROM trucker.booking_cancellation x WHERE x.booking_id = b.id) THEN
    status := 'cancelled'; RETURN;
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
$$;

CREATE OR REPLACE FUNCTION trucker.booking_view(b trucker.booking, p_audience text, p_at timestamptz) RETURNS jsonb
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
  IF EXISTS (SELECT 1 FROM trucker.booking_cancellation x WHERE x.booking_id = b.id) THEN
    RETURN trucker.booking_values(b) || jsonb_build_object(
      'status','cancelled','confirmedAt',(SELECT x.confirmed_at FROM trucker.booking_confirmation x WHERE x.booking_id=b.id),
      'overdue',false,'waitDecision',NULL,'assignmentVersion',
      coalesce((SELECT x.set_no FROM trucker.booking_assignment_state x WHERE x.booking_id=b.id),0),
      'dispatch',jsonb_build_object('ready',false,'blockers',jsonb_build_array(jsonb_build_object('code','booking_cancelled'))),
      'needsReassignment',false,'atRisk',false,'acknowledgedAt',NULL,'resources',NULL,'substitution',NULL,'site',NULL,
      'cancellation',trucker.cancellation_values(b.id,p_audience));
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

CREATE OR REPLACE FUNCTION trucker.booking_dispatch_blockers(b trucker.booking, p_at timestamptz) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
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

CREATE OR REPLACE FUNCTION trucker.booking_detail(p_booking uuid, p_allow_fixtures boolean, OUT status text, OUT detail jsonb)
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
    'candidates', CASE WHEN NOT EXISTS (SELECT 1 FROM trucker.booking_cancellation z WHERE z.booking_id=b.id) AND v_role = 'carrier' AND trucker.capability_effective(v_org, 'carry_as_company')
                       THEN trucker.assignment_candidates(b, v_at) END);
END
$$;

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
  SELECT * INTO b FROM trucker.booking x WHERE x.shipment_id = d.id AND EXISTS (SELECT 1 FROM trucker.booking_publication_cycle z WHERE z.booking_id=x.id AND z.cycle_id=d.publication_cycle);
  status := 'ok';
  detail := jsonb_build_object(
    'open', trucker.booking_terms_available(p_allow_fixtures),
    'booking', CASE WHEN b.id IS NOT NULL THEN trucker.booking_view(b, 'shipper', v_at) END,
    'acceptance', coalesce((
      SELECT jsonb_agg(trucker.acceptance_preview(q, d, v_at, p_allow_fixtures) ORDER BY q.created_at, q.id)
      FROM trucker.quotation q WHERE q.shipment_id = d.id AND q.status = 'submitted'), '[]'::jsonb));
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
  SELECT * INTO b FROM trucker.booking x WHERE x.shipment_id = p_shipment ORDER BY x.accepted_at DESC, x.id DESC LIMIT 1;
  detail := jsonb_build_object('booking', CASE WHEN b.id IS NOT NULL THEN trucker.booking_view(b, 'staff', entered.at) END);
END
$$;

CREATE OR REPLACE FUNCTION trucker.booking_consistency() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
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
    SELECT 'cancelled_open_substitution', c.booking_id, s.id
    FROM trucker.booking_cancellation c JOIN trucker.booking_substitution s ON s.booking_id=c.booking_id
    WHERE s.status='proposed'
  ) AS x
$$;

CREATE OR REPLACE FUNCTION trucker.republish_shipment(
  p_shipment uuid, p_expected_version integer, p_key text, p_deadline jsonb, p_allow_fixtures boolean,
  OUT status text, OUT version integer, OUT detail jsonb
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
DECLARE
  entered record;
  seen record;
  g trucker.security_setting;
  d trucker.shipment_draft;
  r record;
  problems jsonb;
  before_cycle uuid;
  hash text := trucker.content_hash(coalesce(p_deadline, 'null'::jsonb) || jsonb_build_object('_v', p_expected_version));
BEGIN
  IF p_shipment IS NULL OR p_deadline IS NULL OR jsonb_typeof(p_deadline) <> 'object' THEN
    RAISE EXCEPTION 'invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT * INTO entered FROM trucker.shipment_enter(p_shipment);
  status := entered.status;
  IF status <> 'ok' THEN
    RETURN;
  END IF;
  d := entered.row_found;
  version := d.version;
  SELECT * INTO seen FROM trucker.shipment_retry_seen(entered.actor, p_key, 'republish', p_shipment, hash, entered.at);
  IF seen.status <> 'none' THEN
    status := seen.status;
    version := coalesce(seen.resulting_version, d.version);
    RETURN;
  END IF;
  IF d.status NOT IN ('expired','booking_cancelled') THEN
    status := 'not_expired';
    detail := jsonb_build_object('status', d.status);
    RETURN;
  END IF;
  IF p_expected_version IS DISTINCT FROM d.version THEN
    status := 'conflict';
    RETURN;
  END IF;
  IF NOT trucker.organisation_publishable(entered.org) THEN
    status := 'not_eligible';
    RETURN;
  END IF;
  -- Every detail is checked again against the catalogues as they are now.
  SELECT * INTO r FROM trucker.resolve_publication_details(
    jsonb_build_object('cargoCategory', d.cargo_category, 'equipmentType', d.equipment_type,
                       'dangerousGoods', d.dangerous_goods, 'pickupArea', d.pickup_area,
                       'deliveryArea', d.delivery_area, 'quotationDeadline', p_deadline),
    d.pickup_time_zone, p_allow_fixtures);
  d.deadline_local := r.deadline_local;
  d.deadline_offset_minutes := r.deadline_offset_minutes;
  d.deadline_at := r.deadline_at;
  problems := r.problems || trucker.publication_problems(d, entered.at, true, true, p_allow_fixtures);
  IF problems <> '[]'::jsonb THEN
    status := 'invalid';
    detail := problems;
    RETURN;
  END IF;
  SELECT * INTO g FROM trucker.security_setting;
  IF (SELECT count(*) FROM trucker.shipment_draft x
      WHERE x.organisation_id = entered.org AND x.status = 'published') >= g.published_shipment_limit THEN
    status := 'limit';
    detail := jsonb_build_object('limit', g.published_shipment_limit);
    RETURN;
  END IF;
  before_cycle := d.publication_cycle;
  UPDATE trucker.shipment_draft x SET
    deadline_local = d.deadline_local, deadline_offset_minutes = d.deadline_offset_minutes,
    deadline_at = d.deadline_at, status = 'published', expired_at = NULL,
    published_version = x.published_version + 1, published_at = entered.at,
    publication_cycle = gen_random_uuid(),
    version = x.version + 1, updated_at = entered.at
  WHERE x.id = p_shipment RETURNING * INTO d;
  INSERT INTO trucker.shipment_publication_version
    (shipment_id, organisation_id, version_no, kind, publication_cycle, carrier_values, created_at, created_by)
  VALUES (d.id, entered.org, d.published_version, 'republished', d.publication_cycle,
          trucker.shipment_material_values(d),
          entered.at, entered.actor);
  INSERT INTO trucker.shipment_retry_key (person_id, key, operation, request_hash, draft_id, resulting_version, created_at)
  VALUES (entered.actor, p_key, 'republish', hash, d.id, d.version, entered.at);
  INSERT INTO trucker.audit_entry
    (occurred_at, actor_person_id, organisation_id, action, record_type, record_id, request_id,
     publication_cycle, before_values, after_values)
  VALUES (entered.at, entered.actor, entered.org, 'shipment.republished', 'shipment_draft', d.id,
          nullif(current_setting('trucker.request_id', true), ''), d.publication_cycle,
          jsonb_build_object('status', 'expired', 'previousCycle', before_cycle),
          jsonb_build_object('status', 'published', 'publishedVersion', d.published_version,
                             'carrierValues', trucker.shipment_material_values(d)));
  status := 'republished';
  version := d.version;
END
$$;

-- Awards repeat across publication cycles; booking creation remains once per booking.
DROP INDEX trucker.audit_entry_one_booking;
CREATE UNIQUE INDEX audit_entry_one_booking ON trucker.audit_entry(record_id)
  WHERE action='booking.created';
CREATE UNIQUE INDEX audit_entry_one_award_cycle ON trucker.audit_entry(record_id, publication_cycle)
  WHERE action='shipment.awarded';
CREATE OR REPLACE FUNCTION trucker.accept_quotation(
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
    (occurred_at, actor_person_id, organisation_id, action, record_type, record_id, request_id, publication_cycle, before_values, after_values)
  VALUES (v_at, actor, q.carrier_organisation_id, 'quotation.accepted', 'quotation', q.id, request, d.publication_cycle,
          jsonb_build_object('status', 'submitted', 'version', q.current_version),
          jsonb_build_object('status', 'accepted', 'booking', b.id));
  FOR other IN SELECT * FROM trucker.quotation x
               WHERE x.shipment_id = d.id AND x.status = 'submitted' ORDER BY x.id LOOP
    UPDATE trucker.quotation x SET status = 'not_selected', ended_at = v_at, updated_at = v_at WHERE x.id = other.id;
    INSERT INTO trucker.audit_entry
      (occurred_at, actor_person_id, organisation_id, action, record_type, record_id, request_id, publication_cycle, before_values, after_values)
    VALUES (v_at, actor, other.carrier_organisation_id, 'quotation.not_selected', 'quotation', other.id, request, d.publication_cycle,
            jsonb_build_object('status', 'submitted', 'version', other.current_version),
            jsonb_build_object('status', 'not_selected'));
  END LOOP;
  UPDATE trucker.shipment_draft x
  SET status = 'awarded', awarded_at = v_at, version = x.version + 1, updated_at = v_at WHERE x.id = d.id;
  INSERT INTO trucker.audit_entry
    (occurred_at, actor_person_id, organisation_id, action, record_type, record_id, request_id, publication_cycle, before_values, after_values)
  VALUES
    (v_at, actor, d.organisation_id, 'shipment.awarded', 'shipment_draft', d.id, request, d.publication_cycle,
     jsonb_build_object('status', 'published', 'publishedVersion', d.published_version),
     jsonb_build_object('status', 'awarded', 'booking', b.id)),
    (v_at, actor, d.organisation_id, 'booking.created', 'booking', b.id, request, d.publication_cycle, NULL,
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

CREATE OR REPLACE FUNCTION trucker.offset_choices(p_draft uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
  SELECT coalesce(jsonb_object_agg(e.name, e.offsets), '{}'::jsonb)
  FROM trucker.shipment_draft d
  CROSS JOIN LATERAL (VALUES
    ('pickup.from', d.pickup_from_local, d.pickup_time_zone),
    ('pickup.until', d.pickup_until_local, d.pickup_time_zone),
    ('delivery.from', d.delivery_from_local, d.delivery_time_zone),
    ('delivery.until', d.delivery_until_local, d.delivery_time_zone),
    ('quotationDeadline', d.deadline_local, d.pickup_time_zone)) w (name, wall, zone)
  CROSS JOIN LATERAL (
    SELECT w.name, to_jsonb(array_agg(c.offset_minutes ORDER BY c.instant)) AS offsets, count(*) AS found
    FROM trucker.local_time_candidates(w.wall, w.zone) c
    WHERE w.wall IS NOT NULL AND w.zone IS NOT NULL) e
  WHERE d.id = p_draft
    AND d.organisation_id = trucker.request_organisation()
    AND e.found > 1
$$;

-- Historical bookings remain readable to authorized staff by booking id, even after a
-- new booking exists for a later publication cycle of the same shipment.
CREATE FUNCTION trucker.staff_booking_detail(p_token_hash text, p_booking uuid, p_request_id text,
  OUT status text, OUT detail jsonb)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
DECLARE e record; b trucker.booking;
BEGIN
  SELECT * INTO e FROM trucker.staff_enter(p_token_hash,NULL,'staff.booking_view',NULL,p_request_id);
  status := e.status;
  IF status <> 'ok' THEN RETURN; END IF;
  IF NOT (trucker.staff_privileges(e.staff_id) && ARRAY['reviewer','staff_admin']) THEN
    PERFORM trucker.staff_audit(e.at,e.staff_id,'staff.booking_view','refused',NULL,p_request_id,
      jsonb_build_object('reason','privilege_not_held','booking',p_booking));
    status := 'forbidden'; RETURN;
  END IF;
  SELECT * INTO b FROM trucker.booking x WHERE x.id=p_booking;
  IF NOT FOUND THEN status := 'not_found'; RETURN; END IF;
  PERFORM trucker.staff_audit(e.at,e.staff_id,'staff.booking_view','done',NULL,p_request_id,
    jsonb_build_object('booking',p_booking));
  detail := jsonb_build_object('booking',trucker.booking_view(b,'staff',e.at));
END
$$;
REVOKE ALL ON FUNCTION trucker.staff_booking_detail(text,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION trucker.staff_booking_detail(text,uuid,text) TO trucker_app;
