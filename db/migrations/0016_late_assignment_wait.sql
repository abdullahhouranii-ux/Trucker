-- 0016: late initial assignment requires the shipper's recorded wait decision.
-- Forward-only update; leaves the original assignment migration unchanged.

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
