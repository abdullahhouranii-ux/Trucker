-- Operational closure is recorded once. Subsequent discrepancies are surfaced as review_required.
CREATE TABLE trucker.booking_closure (
  booking_id uuid PRIMARY KEY REFERENCES trucker.booking(id),
  closed_at timestamptz NOT NULL
);

CREATE TABLE trucker.booking_closure_assignment (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  booking_id uuid NOT NULL REFERENCES trucker.booking(id),
  owner_id uuid NOT NULL REFERENCES trucker.staff_account(id),
  assigned_by uuid NOT NULL REFERENCES trucker.staff_account(id),
  assigned_at timestamptz NOT NULL,
  retry_key text NOT NULL,
  UNIQUE (booking_id,assigned_by,retry_key)
);
CREATE INDEX booking_closure_assignment_latest ON trucker.booking_closure_assignment(booking_id,id DESC);
ALTER TABLE trucker.booking_closure ENABLE ROW LEVEL SECURITY;
ALTER TABLE trucker.booking_closure_assignment ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON trucker.booking_closure,trucker.booking_closure_assignment FROM PUBLIC,trucker_app;
CREATE TRIGGER booking_closure_immutable BEFORE UPDATE OR DELETE ON trucker.booking_closure
  FOR EACH ROW EXECUTE FUNCTION trucker.guard_trip_record();
CREATE TRIGGER booking_closure_no_truncate BEFORE TRUNCATE ON trucker.booking_closure
  FOR EACH STATEMENT EXECUTE FUNCTION trucker.guard_trip_record();
CREATE TRIGGER booking_closure_assignment_immutable BEFORE UPDATE OR DELETE ON trucker.booking_closure_assignment
  FOR EACH ROW EXECUTE FUNCTION trucker.guard_trip_record();
CREATE TRIGGER booking_closure_assignment_no_truncate BEFORE TRUNCATE ON trucker.booking_closure_assignment
  FOR EACH STATEMENT EXECUTE FUNCTION trucker.guard_trip_record();

CREATE FUNCTION trucker.booking_closure_blockers(p_booking uuid) RETURNS text[]
LANGUAGE sql STABLE SET search_path = pg_catalog,trucker,pg_temp AS $$
  SELECT trucker.booking_financial_blockers(p_booking) || array_remove(ARRAY[
    CASE WHEN NOT EXISTS (SELECT 1 FROM trucker.trip WHERE booking_id=p_booking)
      THEN 'trip_not_dispatched' END,
    CASE WHEN NOT EXISTS (
      SELECT 1 FROM trucker.pod_review r JOIN trucker.pod_version v ON v.id=r.pod_id
      WHERE r.decision='accepted'
        AND v.id=(SELECT p.id FROM trucker.pod_version p WHERE p.booking_id=p_booking ORDER BY p.version DESC LIMIT 1)
        AND v.outcome_id=(SELECT o.id FROM trucker.trip_delivery_outcome o WHERE o.trip_id=v.trip_id ORDER BY o.version DESC LIMIT 1)
    ) THEN 'pod_not_accepted' END,
    CASE WHEN EXISTS (SELECT 1 FROM trucker.resource_reservation WHERE booking_id=p_booking AND status='active')
       OR EXISTS (SELECT 1 FROM trucker.occupancy_episode WHERE booking_id=p_booking AND closed_at IS NULL)
      THEN 'resources_not_released' END,
    CASE WHEN EXISTS (SELECT 1 FROM trucker.trip t WHERE t.booking_id=p_booking AND trucker.cargo_on_vehicle(t.id)>0)
      THEN 'cargo_in_custody' END,
    CASE WHEN EXISTS (SELECT 1 FROM trucker.booking_cancellation WHERE booking_id=p_booking)
      THEN 'booking_cancelled' END
  ],NULL)
$$;

CREATE FUNCTION trucker.booking_closure_state(p_booking uuid) RETURNS text
LANGUAGE sql STABLE SET search_path = pg_catalog,trucker,pg_temp AS $$
  SELECT CASE
    WHEN NOT EXISTS (SELECT 1 FROM trucker.booking_closure WHERE booking_id=p_booking) THEN 'open'
    WHEN cardinality(trucker.booking_closure_blockers(p_booking))>0 THEN 'review_required'
    ELSE 'closed'
  END
$$;

-- Background checks close only after acquiring the same trip lock as dispute, finance, and
-- custody commands. A fresh read under the lock is the gate, not the candidate selection.
CREATE FUNCTION trucker.booking_closure_watch() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog,trucker,pg_temp AS $$
DECLARE
  candidate uuid;
  closed_count integer := 0;
BEGIN
  FOR candidate IN SELECT t.booking_id FROM trucker.trip t
    WHERE NOT EXISTS (SELECT 1 FROM trucker.booking_closure c WHERE c.booking_id=t.booking_id)
      AND cardinality(trucker.booking_closure_blockers(t.booking_id))=0
    ORDER BY t.dispatched_at,t.booking_id LIMIT 50
    FOR UPDATE OF t SKIP LOCKED
  LOOP
    IF cardinality(trucker.booking_closure_blockers(candidate))=0 THEN
      INSERT INTO trucker.booking_closure(booking_id,closed_at)
        VALUES(candidate,trucker.clock_now()) ON CONFLICT DO NOTHING;
      IF FOUND THEN closed_count := closed_count+1; END IF;
    END IF;
  END LOOP;
  RETURN closed_count;
END
$$;

CREATE FUNCTION trucker.staff_booking_closure(p_token text,p_request_id text,p_booking uuid,
  p_owner uuid,p_key text,OUT status text,OUT detail jsonb)
RETURNS record LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog,trucker,pg_temp AS $$
DECLARE
  a record;
  existing trucker.booking_closure_assignment;
BEGIN
  SELECT * INTO a FROM trucker.staff_enter(p_token,'operations','staff.booking_closure',NULL,p_request_id);
  IF a.status <> 'ok' THEN status := a.status; RETURN; END IF;
  IF p_owner IS NOT NULL THEN
    IF p_booking IS NULL OR p_key IS NULL OR p_key !~ '^[A-Za-z0-9._-]{16,128}$'
      THEN status := 'invalid'; RETURN; END IF;
    PERFORM 1 FROM trucker.trip WHERE booking_id=p_booking FOR UPDATE;
    IF NOT FOUND THEN status := 'not_found'; RETURN; END IF;
    SELECT * INTO a FROM trucker.staff_enter(p_token,'operations','staff.booking_closure',NULL,p_request_id);
    IF a.status <> 'ok' THEN status := a.status; RETURN; END IF;
    SELECT * INTO existing FROM trucker.booking_closure_assignment
      WHERE booking_id=p_booking AND assigned_by=a.staff_id AND retry_key=p_key;
    IF FOUND THEN
      IF existing.owner_id <> p_owner THEN status := 'conflict'; RETURN; END IF;
    ELSE
      IF NOT EXISTS(SELECT 1 FROM trucker.staff_account s WHERE s.id=p_owner AND s.status='active'
         AND 'operations'=ANY(trucker.staff_privileges(s.id))) THEN status := 'invalid'; RETURN; END IF;
      IF trucker.booking_closure_state(p_booking)='closed' THEN status := 'conflict'; RETURN; END IF;
      INSERT INTO trucker.booking_closure_assignment(booking_id,owner_id,assigned_by,assigned_at,retry_key)
      VALUES(p_booking,p_owner,a.staff_id,trucker.clock_now(),p_key);
    END IF;
    status := 'ok'; detail := jsonb_build_object('bookingId',p_booking,'ownerId',p_owner); RETURN;
  END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'bookingId',x.booking_id,'state',x.state,'closedAt',x.closed_at,'blockers',x.blockers,
    'ownerId',x.owner_id,'ownerName',x.owner_name
  ) ORDER BY x.dispatched_at,x.booking_id),'[]'::jsonb) INTO detail
  FROM (
    SELECT t.booking_id,t.dispatched_at,c.closed_at,st.state,
      trucker.booking_closure_blockers(t.booking_id) AS blockers, owner.owner_id, owner.owner_name
    FROM trucker.trip t LEFT JOIN trucker.booking_closure c ON c.booking_id=t.booking_id
    CROSS JOIN LATERAL (SELECT trucker.booking_closure_state(t.booking_id) AS state) st
    LEFT JOIN LATERAL (
      SELECT CASE WHEN s.status='active' AND 'operations'=ANY(trucker.staff_privileges(s.id)) THEN v.owner_id END AS owner_id,
        CASE WHEN s.status='active' AND 'operations'=ANY(trucker.staff_privileges(s.id)) THEN s.display_name END AS owner_name
      FROM trucker.booking_closure_assignment v
      JOIN trucker.staff_account s ON s.id=v.owner_id WHERE v.booking_id=t.booking_id ORDER BY v.id DESC LIMIT 1
    ) owner ON true
    WHERE (p_booking IS NULL AND st.state <> 'closed') OR t.booking_id=p_booking
    ORDER BY t.dispatched_at,t.booking_id LIMIT 200
  ) x;
  status := 'ok';
END
$$;

CREATE FUNCTION trucker.booking_closure_for_party(p_booking uuid, OUT status text, OUT detail jsonb)
RETURNS record LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog,trucker,pg_temp AS $$
DECLARE
  org uuid := trucker.request_organisation();
BEGIN
  IF trucker.request_person() IS NULL THEN status := 'unauthorized'; RETURN; END IF;
  IF org IS NULL OR NOT trucker.is_admin(org) OR NOT EXISTS (
    SELECT 1 FROM trucker.booking b LEFT JOIN trucker.booking_party p ON p.booking_id=b.id
    WHERE b.id=p_booking AND org IN (b.shipper_organisation_id,b.carrier_organisation_id,p.customer_organisation_id,p.organiser_organisation_id)
  ) THEN status := 'not_found'; RETURN; END IF;
  status := 'ok'; detail := jsonb_build_object('state',trucker.booking_closure_state(p_booking));
END
$$;

REVOKE ALL ON FUNCTION trucker.booking_closure_blockers(uuid),trucker.booking_closure_state(uuid),
  trucker.booking_closure_watch(),trucker.staff_booking_closure(text,text,uuid,uuid,text),
  trucker.booking_closure_for_party(uuid) FROM PUBLIC,trucker_app;
GRANT EXECUTE ON FUNCTION trucker.booking_closure_watch(),
  trucker.staff_booking_closure(text,text,uuid,uuid,text),trucker.booking_closure_for_party(uuid) TO trucker_app;
