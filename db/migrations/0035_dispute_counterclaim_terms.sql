-- A proposal can settle only counterclaims already recorded when it was sent.
CREATE FUNCTION trucker.dispute_proposal_covers_counterclaims(p_dispute uuid, p_proposal text)
RETURNS boolean LANGUAGE sql STABLE SET search_path = pg_catalog, trucker, pg_temp AS $$
  SELECT NOT EXISTS (
    SELECT 1 FROM trucker.booking_dispute_event c
    WHERE c.dispute_id = p_dispute AND c.kind = 'counterclaim'
      AND NOT EXISTS (
        SELECT 1 FROM trucker.booking_dispute_event p
        WHERE p.dispute_id = c.dispute_id AND p.kind = 'propose'
          AND p.id::text = p_proposal AND p.id > c.id
          AND jsonb_typeof(p.command->'counterclaimTerms') = 'string'
          AND char_length(btrim(p.command->>'counterclaimTerms')) BETWEEN 1 AND 4000
      )
  )
$$;

REVOKE ALL ON FUNCTION trucker.dispute_proposal_covers_counterclaims(uuid, text) FROM PUBLIC, trucker_app;

CREATE OR REPLACE FUNCTION trucker.booking_disputes(p_booking uuid, p_staff_token text, p_request_id text,
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
  v_milestone uuid;
  related uuid;
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
    v_milestone := (p_command->>'tripMilestoneId')::uuid;
    related := (p_command->>'relatedDisputeId')::uuid;
    IF v_milestone IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM trucker.trip_milestone m JOIN trucker.trip t ON t.id = m.trip_id
      WHERE m.id = v_milestone AND t.booking_id = b.id
    ) THEN status := 'not_found'; RETURN; END IF;
    IF related IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM trucker.booking_dispute WHERE id = related AND booking_id = b.id
    ) THEN status := 'not_found'; RETURN; END IF;
    INSERT INTO trucker.booking_dispute(booking_id, opened_for, kind, description, requested_outcome,
      amount, scope, currency, pod_version_id, trip_milestone_id, related_dispute_id, financial_setting_version_id, opened_at)
    VALUES (b.id, on_behalf, p_command->>'kind', p_command->>'description', p_command->>'requestedOutcome',
      v_amount, v_scope, b.currency_code, pod, v_milestone, related, (trucker.booking_terms_version(b)).id, at_time) RETURNING * INTO d;
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
      IF terminal = 'agreement' AND NOT trucker.dispute_proposal_covers_counterclaims(d.id, (
        SELECT e.command->>'proposalId' FROM trucker.booking_dispute_event e
        WHERE e.dispute_id = d.id AND e.kind = 'agreement' ORDER BY e.id DESC LIMIT 1
      )) THEN status := 'conflict'; RETURN; END IF;
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
  IF action = 'accept' AND trucker.dispute_proposal_covers_counterclaims(d.id, proposal::text) AND EXISTS (
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
