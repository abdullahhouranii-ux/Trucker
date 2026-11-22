-- Slice 18b: proof of delivery (POD). The driver, or someone on the driver's behalf, declares a
-- manifest of evidence items, then sends each file; the server recomputes each file's
-- fingerprint and refuses one that differs (DI-402, DI-405). A POD is reviewed only when every
-- required item has arrived. Only the shipper's administrators decide (E-1): accept, or ask for
-- more evidence. Nothing is accepted by the passage of time (R-402), and accepting moves no
-- money, places or lifts no hold, and releases no resource (E-3). A correction is a new version;
-- earlier versions stay readable. Files live behind a storage interface outside the database:
-- the database keeps the declaration, the fingerprint and the key only.

CREATE FUNCTION trucker.pod_kinds() RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT ARRAY['signature', 'signed_document', 'delivery_note', 'cargo_photo', 'other']
$$;

CREATE FUNCTION trucker.pod_media_types() RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT ARRAY['image/jpeg', 'image/png', 'application/pdf']
$$;

-- Development default PD-2: at most 10 MB a file, at most 10 items in one version.
CREATE FUNCTION trucker.pod_max_bytes() RETURNS integer
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$ SELECT 10485760 $$;

CREATE TABLE trucker.pod_version (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id uuid NOT NULL REFERENCES trucker.trip (id),
  booking_id uuid NOT NULL REFERENCES trucker.booking (id),
  version integer NOT NULL CHECK (version >= 1),
  -- The outcome in force when it was declared.
  outcome_id uuid NOT NULL REFERENCES trucker.trip_delivery_outcome (id),
  basis text NOT NULL CHECK (basis IN ('observed', 'reported')),
  driver_id uuid NOT NULL REFERENCES trucker.person (id),
  recorded_by uuid REFERENCES trucker.person (id),
  recorded_by_staff uuid REFERENCES trucker.staff_account (id),
  reason text CHECK (reason IS NULL OR reason IN ('no_phone', 'no_signal', 'driver_unable', 'device_lost', 'paper_copy', 'other')),
  note text CHECK (note IS NULL OR char_length(note) BETWEEN 1 AND 1000),
  receiver_name text CHECK (receiver_name IS NULL OR char_length(receiver_name) BETWEEN 1 AND 200),
  receiver_role text CHECK (receiver_role IS NULL OR char_length(receiver_role) BETWEEN 1 AND 200),
  receiver_remarks text CHECK (receiver_remarks IS NULL OR char_length(receiver_remarks) BETWEEN 1 AND 2000),
  -- Why an earlier version is replaced (every version after the first).
  replaces_reason text CHECK (replaces_reason IS NULL OR char_length(replaces_reason) BETWEEN 1 AND 1000),
  captured_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL,
  UNIQUE (trip_id, version),
  CONSTRAINT pod_version_one_recorder CHECK ((recorded_by IS NULL) <> (recorded_by_staff IS NULL)),
  CONSTRAINT pod_version_basis CHECK ((basis = 'reported') = (reason IS NOT NULL)),
  CONSTRAINT pod_version_observed CHECK (basis = 'reported' OR recorded_by = driver_id),
  CONSTRAINT pod_version_not_future CHECK (captured_at <= recorded_at),
  CONSTRAINT pod_version_replaces CHECK ((version = 1) = (replaces_reason IS NULL))
);

CREATE TABLE trucker.pod_item (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pod_id uuid NOT NULL REFERENCES trucker.pod_version (id),
  position integer NOT NULL CHECK (position BETWEEN 1 AND 10),
  kind text NOT NULL CHECK (kind = ANY (trucker.pod_kinds())),
  required boolean NOT NULL,
  media_type text NOT NULL CHECK (media_type = ANY (trucker.pod_media_types())),
  size_bytes integer NOT NULL CHECK (size_bytes BETWEEN 1 AND 10485760),
  -- SHA-256 declared with the manifest; the file must hash to it on receipt.
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  storage_key text CHECK (storage_key IS NULL OR storage_key ~ '^[0-9a-f-]{36}$'),
  received_at timestamptz,
  received_by uuid REFERENCES trucker.person (id),
  received_by_staff uuid REFERENCES trucker.staff_account (id),
  UNIQUE (pod_id, position),
  UNIQUE (storage_key),
  CONSTRAINT pod_item_received CHECK (
    (storage_key IS NULL AND received_at IS NULL AND received_by IS NULL AND received_by_staff IS NULL)
    OR (storage_key IS NOT NULL AND received_at IS NOT NULL AND (received_by IS NULL) <> (received_by_staff IS NULL)))
);

-- One decision per version, by one of the shipper's administrators (E-1).
CREATE TABLE trucker.pod_review (
  pod_id uuid PRIMARY KEY REFERENCES trucker.pod_version (id),
  decision text NOT NULL CHECK (decision IN ('accepted', 'more_evidence_requested')),
  note text CHECK (note IS NULL OR char_length(note) BETWEEN 1 AND 2000),
  decided_by uuid NOT NULL REFERENCES trucker.person (id),
  organisation_id uuid NOT NULL REFERENCES trucker.organisation (id),
  decided_at timestamptz NOT NULL,
  CONSTRAINT pod_review_note CHECK (decision = 'accepted' OR note IS NOT NULL)
);

-- Every view of a POD file by staff (AT-415).
CREATE TABLE trucker.pod_file_view (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id uuid NOT NULL REFERENCES trucker.pod_item (id),
  staff_id uuid NOT NULL REFERENCES trucker.staff_account (id),
  viewed_at timestamptz NOT NULL,
  request_id text
);

ALTER TABLE trucker.pod_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE trucker.pod_item ENABLE ROW LEVEL SECURITY;
ALTER TABLE trucker.pod_review ENABLE ROW LEVEL SECURITY;
ALTER TABLE trucker.pod_file_view ENABLE ROW LEVEL SECURITY;

-- Forward only: a declaration and a decision never change; an item is received once.
CREATE FUNCTION trucker.guard_pod_record() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, trucker, pg_temp AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND TG_TABLE_NAME = 'pod_item' THEN
    IF (NEW.id, NEW.pod_id, NEW.position, NEW.kind, NEW.required, NEW.media_type, NEW.size_bytes, NEW.fingerprint)
       IS NOT DISTINCT FROM (OLD.id, OLD.pod_id, OLD.position, OLD.kind, OLD.required, OLD.media_type, OLD.size_bytes,
                             OLD.fingerprint)
       AND OLD.storage_key IS NULL AND NEW.storage_key IS NOT NULL THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'this record only moves forward and is never removed' USING ERRCODE = 'check_violation';
END
$$;
CREATE TRIGGER pod_version_guard BEFORE UPDATE OR DELETE ON trucker.pod_version FOR EACH ROW EXECUTE FUNCTION trucker.guard_pod_record();
CREATE TRIGGER pod_item_guard BEFORE UPDATE OR DELETE ON trucker.pod_item FOR EACH ROW EXECUTE FUNCTION trucker.guard_pod_record();
CREATE TRIGGER pod_review_guard BEFORE UPDATE OR DELETE ON trucker.pod_review FOR EACH ROW EXECUTE FUNCTION trucker.guard_pod_record();
CREATE TRIGGER pod_file_view_guard BEFORE UPDATE OR DELETE ON trucker.pod_file_view FOR EACH ROW EXECUTE FUNCTION trucker.guard_pod_record();
CREATE TRIGGER pod_version_truncate_guard BEFORE TRUNCATE ON trucker.pod_version FOR EACH STATEMENT EXECUTE FUNCTION trucker.guard_trip_record();
CREATE TRIGGER pod_item_truncate_guard BEFORE TRUNCATE ON trucker.pod_item FOR EACH STATEMENT EXECUTE FUNCTION trucker.guard_trip_record();
CREATE TRIGGER pod_review_truncate_guard BEFORE TRUNCATE ON trucker.pod_review FOR EACH STATEMENT EXECUTE FUNCTION trucker.guard_trip_record();
CREATE TRIGGER pod_file_view_truncate_guard BEFORE TRUNCATE ON trucker.pod_file_view FOR EACH STATEMENT EXECUTE FUNCTION trucker.guard_trip_record();

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
    'booking.resource_released', 'booking.instruction_authority_declared',
    'booking.instruction_authority_ended', 'trip.cargo_instructed', 'trip.cargo_emergency',
    'trip.cargo_offered', 'trip.cargo_decided', 'trip.cargo_executed', 'trip.cargo_receipt',
    'trip.leg_progressed', 'booking.hold_placed', 'trip.cargo_authority_order',
    'trip.cargo_case_closed', 'trip.cargo_liability_recorded', 'trip.cargo_claim_decided',
    'booking.hold_released', 'trip.cargo_escalated', 'trip.pod_declared',
    'trip.pod_version_added', 'trip.pod_item_received', 'trip.pod_integrity_failed',
    'trip.pod_accepted', 'trip.pod_more_evidence_requested'
  ));

-- ---------------------------------------------------------------------------------------------
-- State and views
-- ---------------------------------------------------------------------------------------------

-- The state of one version: superseded by a later one, decided, ready, or still incomplete.
CREATE FUNCTION trucker.pod_state(v trucker.pod_version) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM trucker.pod_review r WHERE r.pod_id = v.id)
      THEN (SELECT r.decision FROM trucker.pod_review r WHERE r.pod_id = v.id)
    WHEN EXISTS (SELECT 1 FROM trucker.pod_version x WHERE x.trip_id = v.trip_id AND x.version > v.version)
      THEN 'superseded'
    WHEN EXISTS (SELECT 1 FROM trucker.pod_item i WHERE i.pod_id = v.id AND i.required AND i.storage_key IS NULL)
      THEN 'upload_incomplete'
    ELSE 'ready_for_review' END
$$;

CREATE FUNCTION trucker.pod_values(p_trip uuid, p_audience text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
  SELECT jsonb_build_object(
    -- not_received: nothing declared yet; the trip shows that evidence is awaited (DI-402).
    'state', coalesce((SELECT trucker.pod_state(v) FROM trucker.pod_version v WHERE v.trip_id = p_trip
                       ORDER BY v.version DESC LIMIT 1), 'not_received'),
    'versions', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'id', v.id, 'version', v.version, 'state', trucker.pod_state(v),
               'outcomeVersion', (SELECT o.version FROM trucker.trip_delivery_outcome o WHERE o.id = v.outcome_id),
               'basis', v.basis,
               'enteredAs', CASE WHEN v.basis = 'observed' THEN 'driver'
                                 WHEN v.recorded_by_staff IS NOT NULL THEN 'operations' ELSE 'carrier' END,
               'about', (SELECT p.display_name FROM trucker.person p WHERE p.id = v.driver_id),
               'enteredBy', CASE WHEN v.recorded_by IS NOT NULL
                                 THEN (SELECT p.display_name FROM trucker.person p WHERE p.id = v.recorded_by)
                                 WHEN p_audience = 'operations'
                                 THEN (SELECT a.display_name FROM trucker.staff_account a WHERE a.id = v.recorded_by_staff) END,
               'reason', v.reason,
               'note', CASE WHEN p_audience IN ('carrier', 'operations') THEN v.note END,
               'receiverName', v.receiver_name, 'receiverRole', v.receiver_role, 'receiverRemarks', v.receiver_remarks,
               'replacesReason', v.replaces_reason, 'capturedAt', v.captured_at, 'recordedAt', v.recorded_at,
               'items', coalesce((
                 SELECT jsonb_agg(jsonb_build_object(
                          'id', i.id, 'position', i.position, 'kind', i.kind, 'required', i.required,
                          'mediaType', i.media_type, 'sizeBytes', i.size_bytes, 'fingerprint', i.fingerprint,
                          'received', i.storage_key IS NOT NULL, 'receivedAt', i.received_at)
                        ORDER BY i.position)
                 FROM trucker.pod_item i WHERE i.pod_id = v.id), '[]'::jsonb),
               'review', (SELECT jsonb_build_object(
                            'decision', r.decision, 'note', r.note, 'decidedAt', r.decided_at,
                            'decidedBy', (SELECT p.display_name FROM trucker.person p WHERE p.id = r.decided_by))
                          FROM trucker.pod_review r WHERE r.pod_id = v.id))
             ORDER BY v.version)
      FROM trucker.pod_version v WHERE v.trip_id = p_trip), '[]'::jsonb))
$$;

-- ---------------------------------------------------------------------------------------------
-- Declaring a version (the manifest)
-- ---------------------------------------------------------------------------------------------

-- The required evidence for an outcome (development default PD-1): a delivery needs the
-- receiver's signature or a signed document; a partial delivery also a photo of the cargo; a
-- refusal or a delivery that did not happen needs a photo (of the cargo or of the site).
CREATE FUNCTION trucker.pod_requirement_missing(p_outcome text, p_kinds text[]) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT CASE
    WHEN p_outcome IN ('delivered_in_full', 'delivered_with_remarks', 'partly_delivered')
         AND NOT (p_kinds && ARRAY['signature', 'signed_document']) THEN 'signature_or_signed_document'
    WHEN p_outcome = 'partly_delivered' AND NOT ('cargo_photo' = ANY (p_kinds)) THEN 'cargo_photo'
    WHEN p_outcome IN ('refused', 'not_delivered') AND NOT (p_kinds && ARRAY['cargo_photo', 'other']) THEN 'photo'
  END
$$;

-- The shared step: called with the trip locked, the caller checked, and the time read.
CREATE FUNCTION trucker.pod_declare_add(b trucker.booking, p_content jsonb, p_driver uuid, p_actor uuid, p_staff uuid,
                                        p_at timestamptz, OUT status text, OUT detail jsonb)
RETURNS record
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
DECLARE
  tr trucker.trip;
  o trucker.trip_delivery_outcome;
  prev trucker.pod_version;
  v_id uuid;
  v_version integer;
  v_captured timestamptz;
  v_reason text := nullif(p_content ->> 'reason', '');
  v_receiver text := nullif(btrim(coalesce(p_content ->> 'receiverName', '')), '');
  v_problems jsonb := '[]'::jsonb;
  v_items jsonb := p_content -> 'items';
  v_required_kinds text[];
  v_missing text;
  e jsonb;
  n integer := 0;
BEGIN
  SELECT * INTO tr FROM trucker.trip x WHERE x.booking_id = b.id;
  IF tr.id IS NULL THEN
    status := 'not_dispatched';
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM trucker.trip_hold h WHERE h.trip_id = tr.id AND h.resumed_at IS NULL) THEN
    status := 'on_hold';
    RETURN;
  END IF;
  SELECT * INTO o FROM trucker.trip_delivery_outcome x WHERE x.trip_id = tr.id ORDER BY x.version DESC LIMIT 1;
  IF o.id IS NULL THEN
    status := 'no_outcome';
    RETURN;
  END IF;
  SELECT * INTO prev FROM trucker.pod_version x WHERE x.trip_id = tr.id ORDER BY x.version DESC LIMIT 1;
  v_version := coalesce(prev.version, 0) + 1;
  -- Each version names the one it follows: a stale or simultaneous declaration is refused.
  IF (p_content ->> 'version') IS DISTINCT FROM v_version::text THEN
    status := 'conflict';
    RETURN;
  END IF;
  IF prev.id IS NOT NULL AND EXISTS (SELECT 1 FROM trucker.pod_review r WHERE r.pod_id = prev.id AND r.decision = 'accepted') THEN
    status := 'pod_accepted';
    RETURN;
  END IF;
  -- Validation.
  IF jsonb_typeof(v_items) IS DISTINCT FROM 'array' OR jsonb_array_length(v_items) NOT BETWEEN 1 AND 10 THEN
    v_problems := v_problems || jsonb_build_object('field', 'items', 'code', 'invalid');
  ELSE
    FOR e IN SELECT * FROM jsonb_array_elements(v_items) LOOP
      n := n + 1;
      IF jsonb_typeof(e) IS DISTINCT FROM 'object'
         OR NOT coalesce(e ->> 'kind', '') = ANY (trucker.pod_kinds())
         OR NOT coalesce(e ->> 'mediaType', '') = ANY (trucker.pod_media_types())
         OR coalesce(e ->> 'fingerprint', '') !~ '^[0-9a-f]{64}$'
         OR jsonb_typeof(e -> 'sizeBytes') IS DISTINCT FROM 'number'
         OR (e ->> 'sizeBytes') !~ '^[0-9]{1,9}$'
         OR (e ->> 'sizeBytes')::integer NOT BETWEEN 1 AND trucker.pod_max_bytes()
         OR (e ? 'optional' AND jsonb_typeof(e -> 'optional') IS DISTINCT FROM 'boolean') THEN
        v_problems := v_problems || jsonb_build_object('field', 'items[' || (n - 1) || ']', 'code', 'invalid');
      END IF;
    END LOOP;
  END IF;
  IF v_receiver IS NOT NULL AND char_length(v_receiver) > 200
     OR char_length(coalesce(p_content ->> 'receiverRole', '')) > 200
     OR char_length(coalesce(p_content ->> 'receiverRemarks', '')) > 2000 THEN
    v_problems := v_problems || jsonb_build_object('field', 'receiver', 'code', 'invalid');
  END IF;
  -- The receiver is named unless nothing was delivered.
  IF o.outcome NOT IN ('refused', 'not_delivered') AND coalesce(v_receiver, o.receiver_name) IS NULL THEN
    v_problems := v_problems || jsonb_build_object('field', 'receiverName', 'code', 'required');
  END IF;
  IF prev.id IS NOT NULL AND (nullif(btrim(coalesce(p_content ->> 'replacesReason', '')), '') IS NULL
                              OR char_length(p_content ->> 'replacesReason') > 1000) THEN
    v_problems := v_problems || jsonb_build_object('field', 'replacesReason', 'code', 'required');
  END IF;
  IF p_driver IS DISTINCT FROM p_actor THEN
    IF v_reason IS NULL OR v_reason NOT IN ('no_phone', 'no_signal', 'driver_unable', 'device_lost', 'paper_copy', 'other')
       OR (v_reason = 'other' AND nullif(btrim(coalesce(p_content ->> 'note', '')), '') IS NULL)
       OR char_length(coalesce(p_content ->> 'note', '')) > 1000 THEN
      v_problems := v_problems || jsonb_build_object('field', 'reason', 'code', 'required');
    END IF;
  END IF;
  -- The capture time: now for the driver; stated on the driver's behalf, never in the future and
  -- never before the outcome it supports.
  IF p_driver = p_actor THEN
    v_captured := p_at;
  ELSE
    BEGIN
      v_captured := (p_content ->> 'capturedAt')::timestamptz;
    EXCEPTION WHEN others THEN
      v_captured := NULL;
    END;
    IF v_captured IS NULL OR v_captured > p_at OR v_captured < date_trunc('minute', o.stated_at) THEN
      v_problems := v_problems || jsonb_build_object('field', 'capturedAt', 'code', 'invalid');
    END IF;
  END IF;
  IF jsonb_array_length(v_problems) > 0 THEN
    status := 'invalid';
    detail := v_problems;
    RETURN;
  END IF;
  v_required_kinds := ARRAY(SELECT x ->> 'kind' FROM jsonb_array_elements(v_items) x
                            WHERE NOT coalesce((x ->> 'optional')::boolean, false));
  v_missing := trucker.pod_requirement_missing(o.outcome, v_required_kinds);
  IF v_missing IS NOT NULL THEN
    status := 'evidence_missing';
    detail := jsonb_build_object('missing', v_missing, 'outcome', o.outcome);
    RETURN;
  END IF;
  INSERT INTO trucker.pod_version (trip_id, booking_id, version, outcome_id, basis, driver_id, recorded_by, recorded_by_staff,
                                   reason, note, receiver_name, receiver_role, receiver_remarks, replaces_reason,
                                   captured_at, recorded_at)
  VALUES (tr.id, b.id, v_version, o.id,
          CASE WHEN p_driver = p_actor THEN 'observed' ELSE 'reported' END,
          p_driver, p_actor, p_staff,
          CASE WHEN p_driver = p_actor THEN NULL ELSE v_reason END,
          CASE WHEN p_driver = p_actor THEN NULL ELSE nullif(btrim(coalesce(p_content ->> 'note', '')), '') END,
          coalesce(v_receiver, o.receiver_name),
          nullif(btrim(coalesce(p_content ->> 'receiverRole', '')), ''),
          nullif(btrim(coalesce(p_content ->> 'receiverRemarks', '')), ''),
          CASE WHEN prev.id IS NOT NULL THEN btrim(p_content ->> 'replacesReason') END,
          v_captured, p_at)
  RETURNING id INTO v_id;
  INSERT INTO trucker.pod_item (pod_id, position, kind, required, media_type, size_bytes, fingerprint)
  SELECT v_id, x.n, x.e ->> 'kind', NOT coalesce((x.e ->> 'optional')::boolean, false), x.e ->> 'mediaType',
         (x.e ->> 'sizeBytes')::integer, x.e ->> 'fingerprint'
  FROM jsonb_array_elements(v_items) WITH ORDINALITY AS x(e, n);
  PERFORM trucker.cargo_audit(p_at, p_actor, p_staff, b, CASE WHEN v_version = 1 THEN 'trip.pod_declared' ELSE 'trip.pod_version_added' END,
                              jsonb_build_object('pod', v_id, 'version', v_version, 'items', jsonb_array_length(v_items),
                                                 'basis', CASE WHEN p_driver = p_actor THEN 'observed' ELSE 'reported' END));
  status := 'declared';
END
$$;

-- Who is asking about this booking's POD as a party: the assigned driver (no organisation), or an
-- administrator of the carrier or the shipper. Anything else is answered as for a missing record.
CREATE FUNCTION trucker.pod_side(b trucker.booking, p_org uuid, p_actor uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
  SELECT CASE
    WHEN p_org IS NULL AND trucker.trip_driver_of(b) = p_actor THEN 'driver'
    WHEN p_org = b.carrier_organisation_id AND trucker.is_admin(p_org) THEN 'carrier'
    WHEN p_org = b.shipper_organisation_id AND trucker.is_admin(p_org) THEN 'shipper'
  END
$$;

CREATE FUNCTION trucker.pod_declare(p_booking uuid, p_content jsonb, OUT status text, OUT detail jsonb)
RETURNS record
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
DECLARE
  actor uuid := trucker.request_person();
  org uuid := trucker.request_organisation();
  b trucker.booking;
  v_side text;
  v_driver uuid;
  t timestamptz;
  r record;
BEGIN
  IF actor IS NULL THEN
    status := 'unauthorized';
    RETURN;
  END IF;
  SELECT * INTO b FROM trucker.booking x WHERE x.id = p_booking;
  v_side := CASE WHEN b.id IS NULL THEN NULL ELSE trucker.pod_side(b, org, actor) END;
  -- Only the driver and the carrier's administrators capture a POD (AT-404).
  IF v_side IS NULL OR v_side = 'shipper' THEN
    status := 'not_found';
    RETURN;
  END IF;
  PERFORM 1 FROM trucker.trip x WHERE x.booking_id = b.id FOR UPDATE;
  t := trucker.clock_now();
  -- Checked again under the lock: an assignment or a role may have ended while this waited.
  IF trucker.request_person() IS DISTINCT FROM actor OR trucker.pod_side(b, org, actor) IS DISTINCT FROM v_side THEN
    status := 'not_found';
    RETURN;
  END IF;
  v_driver := (SELECT a.person_id FROM trucker.booking_assignment a
               WHERE a.booking_id = b.id AND a.role = 'driver' AND a.status = 'active');
  IF v_driver IS NULL THEN
    status := 'not_dispatched';
    RETURN;
  END IF;
  SELECT * INTO r FROM trucker.pod_declare_add(b, CASE WHEN v_side = 'driver'
                                                       THEN p_content - 'reason' - 'note' - 'capturedAt' ELSE p_content END,
                                               v_driver, actor, NULL, t);
  status := r.status;
  detail := CASE WHEN r.status = 'declared'
                 THEN trucker.pod_values((SELECT x.id FROM trucker.trip x WHERE x.booking_id = b.id), v_side)
                 ELSE r.detail END;
END
$$;

CREATE FUNCTION trucker.staff_pod_declare(p_token_hash text, p_booking uuid, p_content jsonb, p_request_id text,
                                          OUT status text, OUT detail jsonb)
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
  SELECT * INTO e FROM trucker.staff_enter(p_token_hash, 'operations', 'staff.operations.pod', NULL, p_request_id);
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
  SELECT * INTO r FROM trucker.pod_declare_add(b, p_content, v_driver, NULL, e.staff_id, t);
  status := r.status;
  detail := CASE WHEN r.status = 'declared'
                 THEN trucker.pod_values((SELECT x.id FROM trucker.trip x WHERE x.booking_id = b.id), 'operations')
                 ELSE r.detail END;
  IF status = 'declared' THEN
    PERFORM trucker.staff_audit(t, e.staff_id, 'staff.operations.pod', 'done', NULL, p_request_id,
                                jsonb_build_object('booking', b.id));
  END IF;
END
$$;

-- ---------------------------------------------------------------------------------------------
-- Receiving a file
-- ---------------------------------------------------------------------------------------------

-- The API has stored the bytes under p_key and computed their fingerprint and size; the item is
-- received only when they match its declaration. A mismatch is recorded and refused (AT-402).
-- The byte count the API found, or nothing when it is not a whole number.
CREATE FUNCTION trucker.pod_receipt_bytes(p_receipt jsonb) RETURNS integer
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT CASE WHEN jsonb_typeof(p_receipt -> 'bytes') = 'number' AND (p_receipt ->> 'bytes') ~ '^[0-9]{1,9}$'
              THEN (p_receipt ->> 'bytes')::integer END
$$;

CREATE FUNCTION trucker.pod_receive_add(b trucker.booking, p_item uuid, p_fingerprint text, p_size integer,
                                        p_media text, p_key text, p_actor uuid, p_staff uuid, p_at timestamptz,
                                        OUT status text, OUT detail jsonb)
RETURNS record
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
DECLARE
  i trucker.pod_item;
  v trucker.pod_version;
BEGIN
  SELECT x.* INTO i FROM trucker.pod_item x JOIN trucker.pod_version y ON y.id = x.pod_id
  WHERE x.id = p_item AND y.booking_id = b.id FOR UPDATE OF x;
  IF i.id IS NULL THEN
    status := 'not_found';
    RETURN;
  END IF;
  SELECT * INTO v FROM trucker.pod_version x WHERE x.id = i.pod_id;
  IF i.storage_key IS NOT NULL THEN
    -- The same file sent again: nothing changes. A different file is refused.
    status := CASE WHEN i.fingerprint = p_fingerprint THEN 'already_received' ELSE 'already_received_other' END;
    RETURN;
  END IF;
  IF trucker.pod_state(v) IN ('superseded', 'accepted', 'more_evidence_requested') THEN
    status := 'pod_closed';
    RETURN;
  END IF;
  IF p_media IS DISTINCT FROM i.media_type THEN
    status := 'media_type_mismatch';
    RETURN;
  END IF;
  IF p_fingerprint IS DISTINCT FROM i.fingerprint OR p_size IS DISTINCT FROM i.size_bytes THEN
    PERFORM trucker.cargo_audit(p_at, p_actor, p_staff, b, 'trip.pod_integrity_failed',
                                jsonb_build_object('pod', v.id, 'item', i.id, 'declared', i.fingerprint,
                                                   'received', p_fingerprint));
    status := 'fingerprint_mismatch';
    RETURN;
  END IF;
  UPDATE trucker.pod_item x SET storage_key = p_key, received_at = p_at, received_by = p_actor, received_by_staff = p_staff
  WHERE x.id = i.id;
  PERFORM trucker.cargo_audit(p_at, p_actor, p_staff, b, 'trip.pod_item_received',
                              jsonb_build_object('pod', v.id, 'item', i.id, 'fingerprint', p_fingerprint));
  status := 'received';
END
$$;

-- p_receipt: what the API found on the bytes it stored ({fingerprint, bytes, mediaType, key}).
CREATE FUNCTION trucker.pod_receive(p_booking uuid, p_item uuid, p_receipt jsonb, OUT status text, OUT detail jsonb)
RETURNS record
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
DECLARE
  actor uuid := trucker.request_person();
  org uuid := trucker.request_organisation();
  b trucker.booking;
  v_side text;
  r record;
BEGIN
  IF actor IS NULL THEN
    status := 'unauthorized';
    RETURN;
  END IF;
  SELECT * INTO b FROM trucker.booking x WHERE x.id = p_booking;
  v_side := CASE WHEN b.id IS NULL THEN NULL ELSE trucker.pod_side(b, org, actor) END;
  IF v_side IS NULL OR v_side = 'shipper' THEN
    status := 'not_found';
    RETURN;
  END IF;
  PERFORM 1 FROM trucker.trip x WHERE x.booking_id = b.id FOR UPDATE;
  IF trucker.request_person() IS DISTINCT FROM actor OR trucker.pod_side(b, org, actor) IS DISTINCT FROM v_side THEN
    status := 'not_found';
    RETURN;
  END IF;
  SELECT * INTO r FROM trucker.pod_receive_add(b, p_item, p_receipt ->> 'fingerprint', trucker.pod_receipt_bytes(p_receipt),
                                               p_receipt ->> 'mediaType', p_receipt ->> 'key', actor, NULL, trucker.clock_now());
  status := r.status;
  detail := trucker.pod_values((SELECT x.id FROM trucker.trip x WHERE x.booking_id = b.id), v_side);
END
$$;

CREATE FUNCTION trucker.staff_pod_receive(p_token_hash text, p_booking uuid, p_item uuid, p_receipt jsonb,
                                          p_request_id text, OUT status text, OUT detail jsonb)
RETURNS record
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
DECLARE
  e record;
  b trucker.booking;
  r record;
BEGIN
  SELECT * INTO e FROM trucker.staff_enter(p_token_hash, 'operations', 'staff.operations.pod', NULL, p_request_id);
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
  SELECT * INTO r FROM trucker.pod_receive_add(b, p_item, p_receipt ->> 'fingerprint', trucker.pod_receipt_bytes(p_receipt),
                                               p_receipt ->> 'mediaType', p_receipt ->> 'key', NULL, e.staff_id, trucker.clock_now());
  status := r.status;
  detail := trucker.pod_values((SELECT x.id FROM trucker.trip x WHERE x.booking_id = b.id), 'operations');
END
$$;

-- ---------------------------------------------------------------------------------------------
-- Review: the shipper's administrators only (E-1); never by silence (R-402)
-- ---------------------------------------------------------------------------------------------

CREATE FUNCTION trucker.pod_review_record(p_booking uuid, p_pod uuid, p_expected_version integer, p_decision text,
                                          p_note text, OUT status text, OUT detail jsonb)
RETURNS record
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
DECLARE
  actor uuid := trucker.request_person();
  org uuid := trucker.request_organisation();
  b trucker.booking;
  v trucker.pod_version;
  t timestamptz;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_state text;
BEGIN
  IF actor IS NULL THEN
    status := 'unauthorized';
    RETURN;
  END IF;
  SELECT * INTO b FROM trucker.booking x WHERE x.id = p_booking;
  -- Only an administrator of the shipper decides (AT-411); anyone else sees no such action.
  IF b.id IS NULL OR trucker.pod_side(b, org, actor) IS DISTINCT FROM 'shipper' THEN
    status := 'not_found';
    RETURN;
  END IF;
  IF p_decision IS NULL OR p_decision NOT IN ('accepted', 'more_evidence_requested')
     OR (p_decision = 'more_evidence_requested' AND v_note IS NULL) OR char_length(coalesce(v_note, '')) > 2000 THEN
    status := 'invalid';
    detail := jsonb_build_array(jsonb_build_object('field', CASE WHEN p_decision = 'more_evidence_requested'
                                                                 THEN 'note' ELSE 'decision' END, 'code', 'invalid'));
    RETURN;
  END IF;
  -- The trip's lock orders two decisions made at once: the first stands (AT-412).
  PERFORM 1 FROM trucker.trip x WHERE x.booking_id = b.id FOR UPDATE;
  t := trucker.clock_now();
  IF trucker.request_person() IS DISTINCT FROM actor OR trucker.pod_side(b, org, actor) IS DISTINCT FROM 'shipper' THEN
    status := 'not_found';
    RETURN;
  END IF;
  SELECT * INTO v FROM trucker.pod_version x WHERE x.id = p_pod AND x.booking_id = b.id;
  IF v.id IS NULL THEN
    status := 'not_found';
    RETURN;
  END IF;
  -- A decision names the version it applies to (AT-411, Part 4 validation).
  IF v.version IS DISTINCT FROM p_expected_version THEN
    status := 'conflict';
    RETURN;
  END IF;
  v_state := trucker.pod_state(v);
  IF v_state = 'superseded' THEN
    status := 'superseded';
    RETURN;
  END IF;
  IF v_state IN ('accepted', 'more_evidence_requested') THEN
    status := 'already_decided';
    RETURN;
  END IF;
  IF v_state <> 'ready_for_review' THEN
    status := 'not_ready';
    RETURN;
  END IF;
  INSERT INTO trucker.pod_review (pod_id, decision, note, decided_by, organisation_id, decided_at)
  VALUES (v.id, p_decision, v_note, actor, org, t);
  PERFORM trucker.cargo_audit(t, actor, NULL, b,
                              CASE WHEN p_decision = 'accepted' THEN 'trip.pod_accepted' ELSE 'trip.pod_more_evidence_requested' END,
                              jsonb_build_object('pod', v.id, 'version', v.version));
  status := p_decision;
  detail := trucker.pod_values(v.trip_id, 'shipper');
END
$$;

-- ---------------------------------------------------------------------------------------------
-- Reading a file
-- ---------------------------------------------------------------------------------------------

-- A party to the booking (the driver, the carrier's or the shipper's administrators) may read
-- the booking's POD files; anyone else is answered as for a missing record (AT-405).
CREATE FUNCTION trucker.pod_file(p_booking uuid, p_item uuid, OUT status text, OUT detail jsonb)
RETURNS record
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
DECLARE
  actor uuid := trucker.request_person();
  org uuid := trucker.request_organisation();
  b trucker.booking;
BEGIN
  IF actor IS NULL THEN
    status := 'unauthorized';
    RETURN;
  END IF;
  SELECT * INTO b FROM trucker.booking x WHERE x.id = p_booking;
  IF b.id IS NULL OR trucker.pod_side(b, org, actor) IS NULL THEN
    status := 'not_found';
    RETURN;
  END IF;
  SELECT 'ok', jsonb_build_object('storageKey', i.storage_key, 'mediaType', i.media_type, 'sizeBytes', i.size_bytes,
                                  'fingerprint', i.fingerprint)
  INTO status, detail
  FROM trucker.pod_item i JOIN trucker.pod_version v ON v.id = i.pod_id
  WHERE i.id = p_item AND v.booking_id = b.id AND i.storage_key IS NOT NULL;
  IF status IS NULL THEN
    status := 'not_found';
  END IF;
END
$$;

-- Operations reads a file; every view is recorded with who and when (AT-415).
CREATE FUNCTION trucker.staff_pod_file(p_token_hash text, p_booking uuid, p_item uuid, p_request_id text,
                                       OUT status text, OUT detail jsonb)
RETURNS record
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
DECLARE
  e record;
  i trucker.pod_item;
BEGIN
  SELECT * INTO e FROM trucker.staff_enter(p_token_hash, 'operations', 'staff.operations.pod_file', NULL, p_request_id);
  status := e.status;
  IF status <> 'ok' THEN
    RETURN;
  END IF;
  SELECT x.* INTO i FROM trucker.pod_item x JOIN trucker.pod_version v ON v.id = x.pod_id
  WHERE x.id = p_item AND v.booking_id = p_booking AND x.storage_key IS NOT NULL;
  IF i.id IS NULL THEN
    status := 'not_found';
    RETURN;
  END IF;
  INSERT INTO trucker.pod_file_view (item_id, staff_id, viewed_at, request_id)
  VALUES (i.id, e.staff_id, e.at, p_request_id);
  PERFORM trucker.staff_audit(e.at, e.staff_id, 'staff.operations.pod_file', 'done', NULL, p_request_id,
                              jsonb_build_object('booking', p_booking, 'item', i.id));
  detail := jsonb_build_object('storageKey', i.storage_key, 'mediaType', i.media_type, 'sizeBytes', i.size_bytes,
                               'fingerprint', i.fingerprint);
END
$$;

-- ---------------------------------------------------------------------------------------------
-- The trip shows its POD
-- ---------------------------------------------------------------------------------------------
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
    -- Undeliverable or refused cargo (R-406).
    'cargo', trucker.cargo_values(t.id, p_audience),
    -- Proof of delivery (slice 18b).
    'pod', trucker.pod_values(t.id, p_audience),
    'cases', coalesce((SELECT jsonb_agg(trucker.trip_case_values(c, p_audience) ORDER BY c.reported_at, c.id)
                       FROM trucker.trip_case c WHERE c.trip_id = t.id), '[]'::jsonb),
    'estimate', (SELECT jsonb_build_object('arrivalAt', e.arrival_at, 'statedAt', e.stated_at, 'statedAs', e.stated_as,
                                           'statedBy', (SELECT p.display_name FROM trucker.person p WHERE p.id = e.stated_by))
                 FROM trucker.trip_estimate e WHERE e.trip_id = t.id ORDER BY e.seq DESC LIMIT 1))
  FROM trucker.trip t WHERE t.booking_id = p_booking
$function$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA trucker FROM PUBLIC;
GRANT EXECUTE ON FUNCTION trucker.pod_declare(uuid, jsonb) TO trucker_app;
GRANT EXECUTE ON FUNCTION trucker.staff_pod_declare(text, uuid, jsonb, text) TO trucker_app;
GRANT EXECUTE ON FUNCTION trucker.pod_receive(uuid, uuid, jsonb) TO trucker_app;
GRANT EXECUTE ON FUNCTION trucker.staff_pod_receive(text, uuid, uuid, jsonb, text) TO trucker_app;
GRANT EXECUTE ON FUNCTION trucker.pod_review_record(uuid, uuid, integer, text, text) TO trucker_app;
GRANT EXECUTE ON FUNCTION trucker.pod_file(uuid, uuid) TO trucker_app;
GRANT EXECUTE ON FUNCTION trucker.staff_pod_file(text, uuid, uuid, text) TO trucker_app;
