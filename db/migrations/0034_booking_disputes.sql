-- Booking disputes use the existing per-cause settlement holds (DI-401).
CREATE TABLE trucker.booking_dispute (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id uuid NOT NULL REFERENCES trucker.booking(id),
  opened_for uuid NOT NULL REFERENCES trucker.organisation(id),
  kind text NOT NULL,
  description text NOT NULL,
  requested_outcome text NOT NULL,
  amount numeric,
  scope text,
  currency text NOT NULL,
  pod_version_id uuid REFERENCES trucker.pod_version(id),
  opened_at timestamptz NOT NULL,
  CHECK (amount IS NULL OR amount > 0)
);

CREATE INDEX booking_dispute_booking ON trucker.booking_dispute(booking_id);

CREATE TABLE trucker.booking_dispute_event (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  booking_id uuid NOT NULL REFERENCES trucker.booking(id),
  dispute_id uuid NOT NULL REFERENCES trucker.booking_dispute(id),
  kind text NOT NULL,
  actor uuid REFERENCES trucker.person(id),
  actor_org uuid REFERENCES trucker.organisation(id),
  staff_id uuid REFERENCES trucker.staff_account(id),
  recorded_at timestamptz NOT NULL,
  retry_key text,
  command jsonb NOT NULL,
  CHECK ((actor IS NULL) <> (staff_id IS NULL)),
  UNIQUE (booking_id, actor, actor_org, retry_key),
  UNIQUE (booking_id, staff_id, retry_key)
);

CREATE INDEX booking_dispute_event_dispute ON trucker.booking_dispute_event(dispute_id, id);

ALTER TABLE trucker.booking_dispute ENABLE ROW LEVEL SECURITY;
ALTER TABLE trucker.booking_dispute_event ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON trucker.booking_dispute, trucker.booking_dispute_event FROM PUBLIC, trucker_app;
CREATE TRIGGER booking_dispute_immutable BEFORE UPDATE OR DELETE ON trucker.booking_dispute
  FOR EACH ROW EXECUTE FUNCTION trucker.guard_trip_record();
CREATE TRIGGER booking_dispute_event_immutable BEFORE UPDATE OR DELETE ON trucker.booking_dispute_event
  FOR EACH ROW EXECUTE FUNCTION trucker.guard_trip_record();
CREATE TRIGGER booking_dispute_no_truncate BEFORE TRUNCATE ON trucker.booking_dispute
  FOR EACH STATEMENT EXECUTE FUNCTION trucker.guard_trip_record();
CREATE TRIGGER booking_dispute_event_no_truncate BEFORE TRUNCATE ON trucker.booking_dispute_event
  FOR EACH STATEMENT EXECUTE FUNCTION trucker.guard_trip_record();

ALTER TABLE trucker.settlement_hold DROP CONSTRAINT settlement_hold_owner_kind_check;
ALTER TABLE trucker.settlement_hold DROP CONSTRAINT settlement_hold_cost_ids_check;
ALTER TABLE trucker.settlement_hold ALTER COLUMN placed_by DROP NOT NULL;
ALTER TABLE trucker.settlement_hold ADD COLUMN placed_by_staff uuid REFERENCES trucker.staff_account(id);
ALTER TABLE trucker.settlement_hold ADD CONSTRAINT settlement_hold_placement CHECK (
  (placed_by IS NULL) <> (placed_by_staff IS NULL)
);
ALTER TABLE trucker.settlement_hold ADD CONSTRAINT settlement_hold_owner_scope CHECK (
  (owner_kind IN ('cost_dispute', 'carrier_claim') AND cardinality(cost_ids) >= 1 AND placed_by_staff IS NULL)
  OR (owner_kind = 'booking_dispute' AND cardinality(cost_ids) = 0)
);
CREATE UNIQUE INDEX booking_dispute_one_hold ON trucker.settlement_hold(owner_id)
  WHERE owner_kind = 'booking_dispute';

CREATE FUNCTION trucker.dispute_view(p_booking uuid, p_staff boolean) RETURNS jsonb
LANGUAGE sql VOLATILE SET search_path = pg_catalog, trucker, pg_temp AS $$
  SELECT jsonb_build_object(
    'held', EXISTS (SELECT 1 FROM trucker.settlement_hold WHERE booking_id = p_booking AND released_at IS NULL),
    'disputes', coalesce(jsonb_agg(jsonb_build_object(
      'id', d.id, 'openedFor', d.opened_for, 'kind', d.kind, 'description', d.description,
      'requestedOutcome', d.requested_outcome, 'amount', d.amount::text, 'currency', d.currency,
      'scope', d.scope, 'podVersionId', d.pod_version_id, 'openedAt', d.opened_at,
      'hold', (SELECT jsonb_build_object('id', h.id, 'releasedAt', h.released_at, 'releaseReason', h.release_note)
               FROM trucker.settlement_hold h WHERE h.owner_kind = 'booking_dispute' AND h.owner_id = d.id),
      'events', coalesce((SELECT jsonb_agg(jsonb_build_object('id', e.id::text, 'kind', e.kind,
        'organisationId', e.actor_org, 'recordedAt', e.recorded_at,
        'staffId', CASE WHEN p_staff THEN e.staff_id END, 'data',
        CASE WHEN NOT p_staff AND (e.kind = 'assign' OR (e.kind = 'open' AND e.staff_id IS NOT NULL))
          THEN '{}'::jsonb ELSE e.command - 'disputeId' - 'storageKey' END) ORDER BY e.id)
        FROM trucker.booking_dispute_event e WHERE e.dispute_id = d.id
          AND (p_staff OR e.kind <> 'internal_note')), '[]'::jsonb)
    ) ORDER BY d.opened_at, d.id), '[]'::jsonb))
  FROM trucker.booking_dispute d WHERE d.booking_id = p_booking
$$;

CREATE FUNCTION trucker.booking_disputes(p_booking uuid, p_staff_token text, p_request_id text,
  p_key text, p_command jsonb, OUT status text, OUT detail jsonb)
RETURNS record LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
DECLARE
  b trucker.booking;
  d trucker.booking_dispute;
  previous trucker.booking_dispute_event;
  entered record;
  staff uuid;
  actor uuid;
  org uuid;
  on_behalf uuid;
  at_time timestamptz;
  action text := p_command->>'action';
  proposal bigint;
  terminal text;
  note text := btrim(p_command->>'note');
  v_amount numeric;
  v_scope text;
  pod uuid;
  privilege text := CASE WHEN action = 'release' THEN 'staff_admin' ELSE 'operations' END;
BEGIN
  IF p_staff_token IS NULL THEN
    actor := trucker.request_person();
    org := trucker.request_organisation();
    IF actor IS NULL THEN status := 'unauthorized'; RETURN; END IF;
  ELSE
    SELECT * INTO entered FROM trucker.staff_enter(p_staff_token, privilege, 'staff.operations.dispute', NULL, p_request_id);
    IF entered.status <> 'ok' THEN status := entered.status; RETURN; END IF;
    staff := entered.staff_id;
  END IF;

  SELECT * INTO b FROM trucker.booking WHERE id = p_booking;
  IF b.id IS NULL OR (staff IS NULL AND
    (org IS NULL OR org NOT IN (b.shipper_organisation_id, b.carrier_organisation_id)
      OR NOT trucker.is_admin(org))) THEN
    status := 'not_found'; RETURN;
  END IF;
  IF action = 'read_evidence' THEN
    SELECT e.command INTO detail
    FROM trucker.booking_dispute_event e
    WHERE e.booking_id = b.id AND e.dispute_id = (p_command->>'disputeId')::uuid
      AND e.id::text = p_command->>'evidenceId' AND e.kind = 'evidence';
    IF NOT FOUND THEN status := 'not_found'; RETURN; END IF;
    IF staff IS NOT NULL THEN
      PERFORM trucker.staff_audit(trucker.clock_now(), staff, 'staff.operations.dispute_file', 'done',
        NULL, p_request_id, jsonb_build_object('dispute', p_command->>'disputeId', 'evidence', p_command->>'evidenceId'));
    END IF;
    status := 'ok'; RETURN;
  END IF;
  IF p_command IS NULL THEN
    status := 'ok'; detail := trucker.dispute_view(b.id, staff IS NOT NULL); RETURN;
  END IF;

  -- Serialize dispute commands even if dispatch creates the trip concurrently.
  PERFORM pg_advisory_xact_lock(hashtextextended('booking-dispute:' || b.id::text, 0));
  PERFORM 1 FROM trucker.trip WHERE booking_id = b.id FOR UPDATE;

  at_time := trucker.clock_now();
  IF staff IS NULL THEN
    IF trucker.request_person() IS DISTINCT FROM actor OR NOT trucker.is_admin(org) THEN
      status := 'not_found'; RETURN;
    END IF;
  ELSE
    SELECT * INTO entered FROM trucker.staff_enter(p_staff_token, privilege, 'staff.operations.dispute', NULL, p_request_id);
    IF entered.status <> 'ok' THEN status := entered.status; RETURN; END IF;
  END IF;

  IF p_key IS NULL OR p_key !~ '^[A-Za-z0-9._-]{16,128}$' OR action IS NULL THEN
    status := 'invalid'; RETURN;
  END IF;
  SELECT * INTO previous FROM trucker.booking_dispute_event e
    WHERE e.booking_id = b.id AND e.actor IS NOT DISTINCT FROM actor
      AND e.actor_org IS NOT DISTINCT FROM org AND e.staff_id IS NOT DISTINCT FROM staff AND e.retry_key = p_key;
  IF FOUND THEN
    IF (previous.command - 'storageKey') <> (p_command - 'storageKey') THEN status := 'conflict'; RETURN; END IF;
    status := 'replayed'; detail := jsonb_build_object('disputeId', previous.dispute_id, 'eventId', previous.id::text); RETURN;
  END IF;

  IF action = 'open' THEN
    on_behalf := CASE WHEN staff IS NULL THEN org ELSE (p_command->>'organisationId')::uuid END;
    IF on_behalf IS NULL OR on_behalf NOT IN (b.shipper_organisation_id, b.carrier_organisation_id)
      OR (staff IS NOT NULL AND coalesce(char_length(note), 0) NOT BETWEEN 1 AND 1000)
      OR coalesce(p_command->>'kind', '') NOT IN ('damage','shortage','delay','undeliverable','waiting_storage_return','freight_commission','pod')
      OR coalesce(char_length(btrim(p_command->>'description')), 0) NOT BETWEEN 1 AND 4000
      OR coalesce(char_length(btrim(p_command->>'requestedOutcome')), 0) NOT BETWEEN 1 AND 4000 THEN
      status := 'invalid'; RETURN;
    END IF;
    v_amount := (p_command->>'amount')::numeric;
    v_scope := nullif(btrim(p_command->>'scope'), '');
    IF (v_amount IS NOT NULL AND (v_amount <= 0 OR v_amount > 999999999999 OR v_amount <> round(v_amount, b.minor_units::integer)))
      OR coalesce(char_length(v_scope), 0) > 1000 THEN status := 'invalid'; RETURN; END IF;
    pod := (p_command->>'podVersionId')::uuid;
    IF pod IS NOT NULL AND NOT EXISTS (SELECT 1 FROM trucker.pod_version v JOIN trucker.trip t ON t.id = v.trip_id
                                      WHERE v.id = pod AND t.booking_id = b.id) THEN
      status := 'not_found'; RETURN;
    END IF;
    INSERT INTO trucker.booking_dispute(booking_id, opened_for, kind, description, requested_outcome,
      amount, scope, currency, pod_version_id, opened_at)
    VALUES (b.id, on_behalf, p_command->>'kind', p_command->>'description', p_command->>'requestedOutcome',
      v_amount, v_scope, b.currency_code, pod, at_time) RETURNING * INTO d;
    IF v_amount IS NOT NULL OR v_scope IS NOT NULL OR p_command->>'financial' = 'true' THEN
      INSERT INTO trucker.settlement_hold(booking_id, owner_kind, owner_id, cost_ids, reason, placed_by, placed_by_staff, placed_at)
      VALUES (b.id, 'booking_dispute', d.id, '{}', coalesce(v_scope, 'Scope under review'), actor, staff, at_time);
    END IF;
  ELSE
    SELECT * INTO d FROM trucker.booking_dispute WHERE booking_id = b.id AND id = (p_command->>'disputeId')::uuid;
    IF d.id IS NULL THEN status := 'not_found'; RETURN; END IF;
    SELECT e.kind INTO terminal FROM trucker.booking_dispute_event e
      WHERE e.dispute_id = d.id AND e.kind IN ('withdraw','close','agreement','external') ORDER BY e.id DESC LIMIT 1;

    IF action = 'release' AND staff IS NOT NULL THEN
      IF terminal IS NULL OR terminal NOT IN ('agreement','withdraw') OR coalesce(char_length(note), 0) NOT BETWEEN 1 AND 1000 THEN
        status := 'conflict'; RETURN;
      END IF;
      IF terminal = 'withdraw' AND EXISTS (
        SELECT 1 FROM trucker.booking_dispute_event WHERE dispute_id = d.id AND kind = 'counterclaim'
      ) THEN status := 'conflict'; RETURN; END IF;
      UPDATE trucker.settlement_hold SET released_at = at_time, released_by = staff, release_note = note
        WHERE owner_kind = 'booking_dispute' AND owner_id = d.id AND booking_id = b.id AND released_at IS NULL;
      IF NOT FOUND THEN status := 'conflict'; RETURN; END IF;
    ELSIF terminal IS NOT NULL THEN status := 'conflict'; RETURN;
    ELSIF action IN ('accept','reject') AND staff IS NULL THEN
      SELECT max(id) INTO proposal FROM trucker.booking_dispute_event WHERE dispute_id = d.id AND kind = 'propose';
      IF proposal IS NULL OR proposal::text IS DISTINCT FROM p_command->>'proposalId' OR EXISTS (
        SELECT 1 FROM trucker.booking_dispute_event WHERE dispute_id = d.id AND actor_org = org
          AND kind IN ('accept','reject') AND command->>'proposalId' = proposal::text
      ) THEN status := 'conflict'; RETURN; END IF;
    ELSIF action = 'evidence' THEN
      IF coalesce(p_command->>'fingerprint', '') !~ '^[0-9a-f]{64}$'
        OR coalesce(char_length(p_command->>'storageKey'), 0) NOT BETWEEN 1 AND 400
        OR NOT coalesce((p_command->>'mediaType') = ANY(trucker.pod_media_types()), false)
        OR coalesce((p_command->>'size')::integer, 0) NOT BETWEEN 1 AND trucker.pod_max_bytes() THEN
        status := 'invalid'; RETURN;
      END IF;
    ELSIF action = 'withdraw' AND staff IS NULL AND org = d.opened_for THEN
      NULL;
    ELSIF (staff IS NOT NULL AND action IN ('assign','request_information','internal_note','propose','close','external','reply'))
        OR (staff IS NULL AND action IN ('reply','counterclaim') AND (action <> 'counterclaim' OR org <> d.opened_for)) THEN
      IF coalesce(char_length(note), 0) NOT BETWEEN 1 AND 4000 THEN status := 'invalid'; RETURN; END IF;
      IF action = 'assign' AND NOT EXISTS (SELECT 1 FROM trucker.staff_account WHERE id = (p_command->>'assigneeId')::uuid AND 'operations' = ANY(trucker.staff_privileges(id))) THEN
        status := 'invalid'; RETURN;
      END IF;
      IF action = 'external' AND coalesce(char_length(btrim(p_command->>'reference')), 0) NOT BETWEEN 1 AND 1000 THEN
        status := 'invalid'; RETURN;
      END IF;
    ELSE status := 'forbidden'; RETURN;
    END IF;
  END IF;

  INSERT INTO trucker.booking_dispute_event(booking_id, dispute_id, kind, actor, actor_org, staff_id,
    recorded_at, retry_key, command)
  VALUES (b.id, d.id, action, actor, org, staff, at_time, p_key, p_command) RETURNING * INTO previous;
  IF action = 'accept' AND EXISTS (
    SELECT 1 FROM trucker.booking_dispute_event WHERE dispute_id = d.id AND actor_org <> org
      AND kind = 'accept' AND command->>'proposalId' = proposal::text
  ) THEN
    INSERT INTO trucker.booking_dispute_event(booking_id, dispute_id, kind, actor, actor_org,
      recorded_at, retry_key, command)
    VALUES (b.id, d.id, 'agreement', actor, org, at_time, NULL,
            jsonb_build_object('proposalId', proposal::text));
  END IF;
  status := 'ok';
  detail := jsonb_build_object('disputeId', d.id, 'eventId', previous.id::text);
END
$$;

REVOKE ALL ON FUNCTION trucker.dispute_view(uuid, boolean) FROM PUBLIC, trucker_app;
REVOKE ALL ON FUNCTION trucker.booking_disputes(uuid, text, text, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION trucker.booking_disputes(uuid, text, text, text, jsonb) TO trucker_app;


-- The existing cargo command can release only holds owned by its own workflow.
ALTER FUNCTION trucker.cargo_apply(trucker.booking, text, uuid, uuid, uuid, jsonb, timestamptz)
  RENAME TO cargo_apply_18d;

CREATE FUNCTION trucker.cargo_apply(b trucker.booking, p_side text, p_org uuid, p_actor uuid, p_staff uuid,
  p_command jsonb, p_at timestamptz, OUT status text, OUT detail jsonb, OUT done boolean)
RETURNS record LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
BEGIN
  IF p_command->>'command' = 'release_hold' AND EXISTS (
    SELECT 1 FROM trucker.settlement_hold h WHERE h.booking_id = b.id
      AND h.id = (p_command->>'holdId')::uuid AND h.owner_kind = 'booking_dispute'
  ) THEN
    status := 'not_found'; done := false; RETURN;
  END IF;
  SELECT x.status, x.detail, x.done INTO status, detail, done
  FROM trucker.cargo_apply_18d(b, p_side, p_org, p_actor, p_staff, p_command, p_at) x;
END
$$;

REVOKE ALL ON FUNCTION trucker.cargo_apply_18d(trucker.booking, text, uuid, uuid, uuid, jsonb, timestamptz)
  FROM PUBLIC, trucker_app;
REVOKE ALL ON FUNCTION trucker.cargo_apply(trucker.booking, text, uuid, uuid, uuid, jsonb, timestamptz)
  FROM PUBLIC, trucker_app;

CREATE FUNCTION trucker.staff_dispute_queue(p_token_hash text, p_request_id text, OUT status text, OUT detail jsonb)
RETURNS record LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
DECLARE
  entered record;
BEGIN
  SELECT * INTO entered FROM trucker.staff_enter(p_token_hash, 'operations', 'staff.operations.dispute', NULL, p_request_id);
  status := entered.status;
  IF status <> 'ok' THEN RETURN; END IF;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'id', d.id, 'bookingId', d.booking_id, 'kind', d.kind, 'openedAt', d.opened_at,
    'state', coalesce(latest.kind, 'open'), 'assignee', assigned.command->>'assigneeId',
    'held', h.id IS NOT NULL
  ) ORDER BY d.opened_at, d.id), '[]'::jsonb) INTO detail
  FROM trucker.booking_dispute d
  LEFT JOIN LATERAL (
    SELECT e.kind FROM trucker.booking_dispute_event e WHERE e.dispute_id = d.id
      AND e.kind IN ('assign','request_information','propose','agreement','withdraw','close','external')
    ORDER BY e.id DESC LIMIT 1
  ) latest ON true
  LEFT JOIN LATERAL (
    SELECT e.command FROM trucker.booking_dispute_event e WHERE e.dispute_id = d.id AND e.kind = 'assign'
    ORDER BY e.id DESC LIMIT 1
  ) assigned ON true
  LEFT JOIN trucker.settlement_hold h ON h.owner_kind = 'booking_dispute' AND h.owner_id = d.id AND h.released_at IS NULL;
END
$$;
REVOKE ALL ON FUNCTION trucker.staff_dispute_queue(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION trucker.staff_dispute_queue(text, text) TO trucker_app;

-- Dispute evidence is kept in the same file store as proof of delivery, under the key recorded
-- in its evidence event. The sweep of unrecorded files (0033) must count those keys too, or it
-- would remove evidence once its grace period ends.
CREATE OR REPLACE FUNCTION trucker.pod_storage_keys_in_use(p_keys jsonb)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, trucker, pg_temp
AS $function$
#variable_conflict use_column
DECLARE
  v_keys text[];
BEGIN
  IF p_keys IS NULL OR jsonb_typeof(p_keys) <> 'array' THEN
    RAISE EXCEPTION 'pod_storage_keys_in_use expects an array of keys' USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(p_keys) > 500 THEN
    RAISE EXCEPTION 'pod_storage_keys_in_use takes at most 500 keys' USING ERRCODE = '22023';
  END IF;
  SELECT coalesce(array_agg(k), '{}') INTO v_keys
  FROM jsonb_array_elements_text(p_keys) k
  WHERE k ~ '^[0-9a-f-]{36}$';
  RETURN coalesce((SELECT jsonb_agg(u.k ORDER BY u.k) FROM (
             SELECT i.storage_key AS k FROM trucker.pod_item i WHERE i.storage_key = ANY (v_keys)
             UNION
             SELECT e.command->>'storageKey' FROM trucker.booking_dispute_event e
             WHERE e.kind = 'evidence' AND e.command->>'storageKey' = ANY (v_keys)) u),
           '[]'::jsonb);
END
$function$;
REVOKE ALL ON FUNCTION trucker.pod_storage_keys_in_use(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION trucker.pod_storage_keys_in_use(jsonb) TO trucker_app;
