-- External freight and commission payments. Existing fee/refund records remain authoritative.
CREATE TABLE trucker.booking_payment_record (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id uuid NOT NULL REFERENCES trucker.booking(id),
  kind text NOT NULL CHECK (kind IN ('freight','commission')),
  amount numeric NOT NULL CHECK (amount > 0),
  currency text NOT NULL REFERENCES trucker.currency(code),
  reference text NOT NULL CHECK (char_length(reference) BETWEEN 1 AND 200),
  evidence text NOT NULL CHECK (char_length(evidence) BETWEEN 1 AND 200),
  reported_by uuid NOT NULL REFERENCES trucker.person(id),
  recorded_at timestamptz NOT NULL
);
CREATE INDEX booking_payment_by_booking ON trucker.booking_payment_record(booking_id);
CREATE INDEX booking_payment_reference ON trucker.booking_payment_record(booking_id, kind, lower(reference));

CREATE TABLE trucker.booking_payment_event (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  payment_id uuid NOT NULL REFERENCES trucker.booking_payment_record(id),
  booking_id uuid NOT NULL REFERENCES trucker.booking(id),
  kind text NOT NULL CHECK (kind IN ('report','confirm','reject','review','match','discrepancy','void')),
  person_id uuid REFERENCES trucker.person(id),
  organisation_id uuid REFERENCES trucker.organisation(id),
  staff_id uuid REFERENCES trucker.staff_account(id),
  retry_key text NOT NULL CHECK (retry_key ~ '^[A-Za-z0-9._-]{16,128}$'),
  command jsonb NOT NULL,
  recorded_at timestamptz NOT NULL,
  CHECK ((person_id IS NULL) <> (staff_id IS NULL)),
  CHECK ((organisation_id IS NULL) = (person_id IS NULL)),
  UNIQUE NULLS NOT DISTINCT (booking_id, person_id, organisation_id, staff_id, retry_key)
);
CREATE INDEX booking_payment_event_latest ON trucker.booking_payment_event(payment_id, id DESC);
CREATE INDEX booking_payment_statement_reference ON trucker.booking_payment_event
  (lower(command->>'reference')) WHERE kind = 'match';

ALTER TABLE trucker.booking_payment_record ENABLE ROW LEVEL SECURITY;
ALTER TABLE trucker.booking_payment_event ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON trucker.booking_payment_record, trucker.booking_payment_event FROM PUBLIC, trucker_app;
CREATE TRIGGER booking_payment_record_immutable BEFORE UPDATE OR DELETE ON trucker.booking_payment_record
  FOR EACH ROW EXECUTE FUNCTION trucker.guard_trip_record();
CREATE TRIGGER booking_payment_record_no_truncate BEFORE TRUNCATE ON trucker.booking_payment_record
  FOR EACH STATEMENT EXECUTE FUNCTION trucker.guard_trip_record();
CREATE TRIGGER booking_payment_event_immutable BEFORE UPDATE OR DELETE ON trucker.booking_payment_event
  FOR EACH ROW EXECUTE FUNCTION trucker.guard_trip_record();
CREATE TRIGGER booking_payment_event_no_truncate BEFORE TRUNCATE ON trucker.booking_payment_event
  FOR EACH STATEMENT EXECUTE FUNCTION trucker.guard_trip_record();

CREATE FUNCTION trucker.booking_payment_latest(p_payment uuid) RETURNS trucker.booking_payment_event
LANGUAGE sql STABLE SET search_path = pg_catalog, trucker, pg_temp AS $$
  SELECT e.* FROM trucker.booking_payment_event e WHERE e.payment_id = p_payment ORDER BY e.id DESC LIMIT 1
$$;

-- Use the frozen amount and counterparties. The contracting customer provides evidence for any
-- sender or receiver that paid on its behalf. Commission is an independent carrier obligation.
CREATE FUNCTION trucker.booking_payment_obligations(p_booking uuid)
RETURNS TABLE(kind text, amount numeric, currency text, minor_units int, payer uuid, payee uuid)
LANGUAGE sql STABLE SET search_path = pg_catalog, trucker, pg_temp AS $$
  SELECT v.kind, v.amount, p.currency_code, p.minor_units, v.payer, v.payee
  FROM trucker.booking_price p JOIN trucker.booking b ON b.id = p.booking_id
  LEFT JOIN trucker.booking_party r ON r.booking_id = b.id
  CROSS JOIN LATERAL (VALUES
    ('freight', p.shipping_amount, coalesce(r.customer_organisation_id, b.shipper_organisation_id), b.carrier_organisation_id),
    ('commission', p.commission_amount, b.carrier_organisation_id, p.organiser_organisation_id)
  ) v(kind, amount, payer, payee)
  WHERE p.booking_id = p_booking AND v.amount > 0
$$;

CREATE FUNCTION trucker.booking_financial_blockers(p_booking uuid) RETURNS text[]
LANGUAGE sql STABLE SET search_path = pg_catalog, trucker, pg_temp AS $$
  SELECT array_remove(ARRAY[
    CASE WHEN EXISTS (SELECT 1 FROM trucker.settlement_hold WHERE booking_id = p_booking AND released_at IS NULL)
      THEN 'settlement_hold' END,
    CASE WHEN NOT trucker.fee_settled(p_booking) OR EXISTS (
      SELECT 1 FROM trucker.fee_payment p WHERE p.booking_id = p_booking
        AND (p.status = 'recorded' OR (p.status = 'approved' AND
           (trucker.reconciliation_current('payment', p.id)).outcome IS DISTINCT FROM 'matched'))
    ) THEN 'fee_unreconciled' END,
    CASE WHEN EXISTS (
      SELECT 1 FROM trucker.fee_refund f WHERE f.booking_id = p_booking AND f.amount IS DISTINCT FROM (
        SELECT sum(q.amount) FROM trucker.refund_request q WHERE q.refund_id = f.id
          AND q.status = 'completed' AND (trucker.reconciliation_current('refund',q.id)).outcome = 'matched'
      )
    ) THEN 'refund_unreconciled' END,
    CASE WHEN NOT EXISTS (SELECT 1 FROM trucker.booking_payment_obligations(p_booking) WHERE kind = 'freight')
      THEN 'missing_freight_terms' END,
    CASE WHEN EXISTS (
      SELECT 1 FROM trucker.booking_payment_obligations(p_booking) o
      WHERE o.kind = 'freight' AND o.amount IS DISTINCT FROM (
        SELECT sum(p.amount) FROM trucker.booking_payment_record p WHERE p.booking_id = p_booking
          AND p.kind = o.kind AND (trucker.booking_payment_latest(p.id)).kind = 'match'
      )
    ) THEN 'freight_unreconciled' END,
    CASE WHEN EXISTS (
      SELECT 1 FROM trucker.booking_payment_obligations(p_booking) o
      WHERE o.kind = 'commission' AND o.amount IS DISTINCT FROM (
        SELECT sum(p.amount) FROM trucker.booking_payment_record p WHERE p.booking_id = p_booking
          AND p.kind = o.kind AND (trucker.booking_payment_latest(p.id)).kind = 'match'
      )
    ) THEN 'commission_unreconciled' END
  ], NULL)
$$;

CREATE FUNCTION trucker.booking_financial_view(p_booking uuid, p_org uuid, p_staff boolean) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, trucker, pg_temp AS $$
  SELECT jsonb_build_object(
    'bookingId',p_booking,'recordingOpen',EXISTS(SELECT 1 FROM trucker.trip WHERE booking_id=p_booking),
    'blockers', CASE WHEN p_staff THEN to_jsonb(trucker.booking_financial_blockers(p_booking)) END,
    'obligations', coalesce(jsonb_agg(jsonb_build_object(
      'kind',o.kind,'amount',o.amount::text,'currency',o.currency,
      'side',CASE WHEN p_org=o.payer THEN 'payer' WHEN p_org=o.payee THEN 'payee' END,
      'payments',coalesce((
        SELECT jsonb_agg(jsonb_build_object(
          'id',p.id,'amount',p.amount::text,'reference',p.reference,'evidence',p.evidence,
          'status',e.kind,'recordedAt',p.recorded_at,
          'reviewer',CASE WHEN p_staff AND e.kind='review' THEN e.staff_id END,
          'history',CASE WHEN p_staff THEN (
            SELECT jsonb_agg(jsonb_build_object('kind',v.kind,'staffId',v.staff_id,'recordedAt',v.recorded_at,
              'note',v.command->>'note','reference',v.command->>'reference','evidence',v.command->>'evidence',
              'actualAmount',v.command->>'amount','actualCurrency',v.command->>'currency')
              ORDER BY v.id)
            FROM trucker.booking_payment_event v WHERE v.payment_id=p.id
          ) END
        ) ORDER BY p.recorded_at,p.id)
        FROM trucker.booking_payment_record p CROSS JOIN LATERAL trucker.booking_payment_latest(p.id) e
        WHERE p.booking_id=p_booking AND p.kind=o.kind
      ),'[]'::jsonb)
    ) ORDER BY o.kind),'[]'::jsonb)
  ) FROM trucker.booking_payment_obligations(p_booking) o
  WHERE p_staff OR p_org IN (o.payer,o.payee)
$$;

CREATE FUNCTION trucker.booking_financial(p_booking uuid, p_staff_token text, p_request_id text,
  p_key text, p_command jsonb, OUT status text, OUT detail jsonb)
RETURNS record LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog,trucker,pg_temp AS $$
#variable_conflict use_column
DECLARE
  b trucker.booking;
  a record;
  actor uuid;
  org uuid;
  staff uuid;
  privilege text := 'staff_admin';
  cmd text := p_command->>'action';
  payment trucker.booking_payment_record;
  last_event trucker.booking_payment_event;
  previous trucker.booking_payment_event;
  obligation record;
  value_amount numeric;
  other_amount numeric;
  ref text := btrim(p_command->>'reference');
  evidence_ref text := btrim(p_command->>'evidence');
  t timestamptz;
BEGIN
  IF p_staff_token IS NULL THEN
    actor := trucker.request_person();
    org := trucker.request_organisation();
    IF actor IS NULL THEN status := 'unauthorized'; RETURN; END IF;
  ELSE
    SELECT * INTO a FROM trucker.staff_enter(p_staff_token,privilege,'staff.booking_payments',NULL,p_request_id);
    IF a.status <> 'ok' THEN status := a.status; RETURN; END IF;
    staff := a.staff_id;
  END IF;
  SELECT * INTO b FROM trucker.booking WHERE id=p_booking;
  IF b.id IS NULL OR (staff IS NULL AND (
    org IS NULL OR NOT trucker.is_admin(org) OR NOT EXISTS (
      SELECT 1 FROM trucker.booking_payment_obligations(p_booking) o WHERE org IN (o.payer,o.payee)
    )
  )) THEN status := 'not_found'; RETURN; END IF;
  IF p_command IS NULL THEN
    status := 'ok'; detail := trucker.booking_financial_view(p_booking,org,staff IS NOT NULL); RETURN;
  END IF;
  IF p_key IS NULL OR p_key !~ '^[A-Za-z0-9._-]{16,128}$' THEN status := 'invalid'; RETURN; END IF;
  -- Matches the trip lock used by dispute, custody and release commands.
  PERFORM 1 FROM trucker.trip WHERE booking_id = p_booking FOR UPDATE;
  IF NOT FOUND THEN status := 'conflict'; RETURN; END IF;
  t := trucker.clock_now();
  IF staff IS NULL THEN
    IF trucker.request_person() IS DISTINCT FROM actor OR NOT trucker.is_admin(org)
      THEN status := 'not_found'; RETURN; END IF;
  ELSE
    SELECT * INTO a FROM trucker.staff_enter(p_staff_token,privilege,'staff.booking_payments',NULL,p_request_id);
    IF a.status <> 'ok' THEN status := a.status; RETURN; END IF;
  END IF;
  SELECT * INTO previous FROM trucker.booking_payment_event e
  WHERE e.booking_id=p_booking AND e.person_id IS NOT DISTINCT FROM actor
    AND e.organisation_id IS NOT DISTINCT FROM org AND e.staff_id IS NOT DISTINCT FROM staff AND e.retry_key=p_key;
  IF FOUND THEN
    IF previous.command IS DISTINCT FROM p_command THEN status := 'conflict'; RETURN; END IF;
    status := 'ok'; detail := jsonb_build_object('paymentId',previous.payment_id); RETURN;
  END IF;

  IF cmd = 'report' THEN
    SELECT * INTO obligation FROM trucker.booking_payment_obligations(p_booking) o WHERE o.kind=p_command->>'kind';
    IF NOT FOUND OR staff IS NOT NULL OR org IS DISTINCT FROM obligation.payer
      THEN status := 'not_found'; RETURN; END IF;
    value_amount := (p_command->>'amount')::numeric;
    IF value_amount IS NULL OR value_amount <= 0 OR value_amount <> round(value_amount,obligation.minor_units)
       OR p_command->>'currency' IS DISTINCT FROM obligation.currency
       OR coalesce(char_length(ref),0) NOT BETWEEN 1 AND 200 OR coalesce(char_length(evidence_ref),0) NOT BETWEEN 1 AND 200
      THEN status := 'invalid'; RETURN; END IF;
    SELECT coalesce(sum(p.amount),0) INTO other_amount FROM trucker.booking_payment_record p
      WHERE p.booking_id=p_booking AND p.kind=obligation.kind
        AND (trucker.booking_payment_latest(p.id)).kind NOT IN ('reject','void');
    IF other_amount + value_amount > obligation.amount OR EXISTS (
      SELECT 1 FROM trucker.booking_payment_record p WHERE p.booking_id=p_booking
        AND p.kind=obligation.kind AND lower(p.reference)=lower(ref)
        AND (trucker.booking_payment_latest(p.id)).kind NOT IN ('reject','void')
    ) THEN status := 'conflict'; RETURN; END IF;
    INSERT INTO trucker.booking_payment_record(booking_id,kind,amount,currency,reference,evidence,reported_by,recorded_at)
      VALUES (p_booking,obligation.kind,value_amount,obligation.currency,ref,evidence_ref,actor,t) RETURNING * INTO payment;
  ELSE
    SELECT * INTO payment FROM trucker.booking_payment_record p WHERE p.booking_id=p_booking AND p.id=(p_command->>'paymentId')::uuid;
    IF payment.id IS NULL THEN status := 'not_found'; RETURN; END IF;
    SELECT * INTO obligation FROM trucker.booking_payment_obligations(p_booking) o WHERE o.kind=payment.kind;
    IF staff IS NULL AND NOT coalesce(org IN (obligation.payer,obligation.payee),false)
      THEN status := 'not_found'; RETURN; END IF;
    last_event := trucker.booking_payment_latest(payment.id);
    CASE cmd
      WHEN 'confirm','reject' THEN
        IF staff IS NOT NULL OR org IS DISTINCT FROM obligation.payee OR actor=payment.reported_by
          THEN status := 'forbidden'; RETURN; END IF;
        IF last_event.kind <> 'report' THEN status := 'conflict'; RETURN; END IF;
      WHEN 'review' THEN
        IF staff IS NULL THEN status := 'forbidden'; RETURN; END IF;
        IF last_event.kind NOT IN ('confirm','discrepancy','match') THEN status := 'conflict'; RETURN; END IF;
      WHEN 'reconcile','void' THEN
        IF staff IS NULL OR staff IS NOT DISTINCT FROM last_event.staff_id THEN status := 'forbidden'; RETURN; END IF;
        IF last_event.kind <> 'review' THEN status := 'conflict'; RETURN; END IF;
        IF cmd = 'reconcile' THEN
          IF coalesce(char_length(ref),0) NOT BETWEEN 1 AND 200 OR coalesce(char_length(evidence_ref),0) NOT BETWEEN 1 AND 200
             OR (p_command->>'amount')::numeric IS NULL OR p_command->>'currency' IS NULL
            THEN status := 'invalid'; RETURN; END IF;
          cmd := CASE WHEN (p_command->>'amount')::numeric = payment.amount AND p_command->>'currency'=payment.currency
                      THEN 'match' ELSE 'discrepancy' END;
          IF cmd = 'match' THEN
            -- A statement line may be checked again for its own payment, never matched to a second one.
            PERFORM pg_advisory_xact_lock(hashtextextended('booking-payment-line:' || lower(ref),0));
            IF EXISTS (
              SELECT 1 FROM trucker.booking_payment_event e
              WHERE e.kind='match' AND lower(e.command->>'reference')=lower(ref) AND e.payment_id<>payment.id
            ) THEN status := 'conflict'; RETURN; END IF;
          END IF;
        END IF;
      ELSE status := 'invalid'; RETURN;
    END CASE;
    IF cmd IN ('reject','review','discrepancy','void') AND coalesce(char_length(btrim(p_command->>'note')),0) NOT BETWEEN 1 AND 1000
      THEN status := 'invalid'; RETURN; END IF;
  END IF;
  INSERT INTO trucker.booking_payment_event(payment_id,booking_id,kind,person_id,organisation_id,staff_id,retry_key,command,recorded_at)
    VALUES(payment.id,p_booking,cmd,actor,org,staff,p_key,p_command,t);
  status := 'ok'; detail := jsonb_build_object('paymentId',payment.id);
EXCEPTION WHEN unique_violation THEN
  status := 'conflict'; detail := NULL;
END
$$;

REVOKE ALL ON FUNCTION trucker.booking_payment_latest(uuid), trucker.booking_payment_obligations(uuid),
  trucker.booking_financial_blockers(uuid), trucker.booking_financial_view(uuid,uuid,boolean),
  trucker.booking_financial(uuid,text,text,text,jsonb) FROM PUBLIC,trucker_app;
GRANT EXECUTE ON FUNCTION trucker.booking_financial(uuid,text,text,text,jsonb) TO trucker_app;

-- An organiser has access to its commission records through the organisation's financial list.
CREATE FUNCTION trucker.booking_financial_list(OUT status text, OUT detail jsonb)
RETURNS record LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog,trucker,pg_temp AS $$
DECLARE
  org uuid := trucker.request_organisation();
BEGIN
  IF trucker.request_person() IS NULL THEN status := 'unauthorized'; RETURN; END IF;
  IF org IS NULL OR NOT trucker.is_admin(org) THEN status := 'not_found'; RETURN; END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('bookingId',v.id,'acceptedAt',v.accepted_at)
    ORDER BY v.accepted_at DESC,v.id),'[]'::jsonb) INTO detail
  FROM (
    SELECT b.id,b.accepted_at FROM trucker.booking b
    JOIN trucker.booking_price p ON p.booking_id=b.id
    LEFT JOIN trucker.booking_party r ON r.booking_id=b.id
    WHERE org IN (b.shipper_organisation_id,b.carrier_organisation_id,r.customer_organisation_id,p.organiser_organisation_id)
      AND EXISTS (SELECT 1 FROM trucker.booking_payment_obligations(b.id) o WHERE org IN(o.payer,o.payee))
    ORDER BY b.accepted_at DESC,b.id LIMIT 200
  ) v;
  status := 'ok';
END
$$;
REVOKE ALL ON FUNCTION trucker.booking_financial_list() FROM PUBLIC,trucker_app;
GRANT EXECUTE ON FUNCTION trucker.booking_financial_list() TO trucker_app;
