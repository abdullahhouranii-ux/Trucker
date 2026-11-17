-- Payment recovery and decisions after lock waits (review of 17 November 2026, R2 to R5).
--
-- R2, R3. A checkout whose outcome the provider has not given is unresolved, whatever Trucker
-- shows for it: one that expired here, or that a new checkout replaced, can still have been
-- paid. Such a checkout opened before the fee's deadline holds the booking until the provider
-- answers, for at most a protected number of minutes after the usual wait. Every lapse path
-- goes through the same rule, so a payer's request can no longer lapse a booking the fee job
-- has not yet asked about. The fee job asks about every unresolved checkout, longest unasked
-- first, until the provider answers. A booking still unanswered at the end of the longest wait
-- lapses, and the lapse records how many checkouts were unanswered.
--
-- R4, R5. A decision taken after waiting for a lock is checked against the caller's session at
-- the time it is taken: reading the decision time, or writing an audit entry, checks again that
-- the participant's session (live when the request began) or the staff session and privilege
-- are still valid. If not, the whole request is undone and answered as signed out (SQLSTATE
-- TR401) or as lacking the privilege (TR403). No money moves: the only provider is a
-- development stand-in.

-- ---------------------------------------------------------------------------------------------
-- R2, R3: unresolved checkouts
-- ---------------------------------------------------------------------------------------------
ALTER TABLE trucker.security_setting
  ADD COLUMN payment_unresolved_minutes integer NOT NULL DEFAULT 60
    CHECK (payment_unresolved_minutes BETWEEN 0 AND 1440);

-- When Trucker learnt the provider's final word on the checkout (paid, failed or expired), or
-- that the provider never opened it.
ALTER TABLE trucker.fee_checkout ADD COLUMN resolved_at timestamptz;
ALTER TABLE trucker.fee_checkout DISABLE TRIGGER fee_checkout_guard;
UPDATE trucker.fee_checkout c SET resolved_at = coalesce(c.closed_at, c.created_at)
WHERE c.status IN ('paid', 'failed')
   OR EXISTS (SELECT 1 FROM trucker.payment_notification n
              WHERE n.checkout_id = c.id AND n.reported IN ('failed', 'expired'));
ALTER TABLE trucker.fee_checkout ENABLE TRIGGER fee_checkout_guard;
ALTER TABLE trucker.fee_checkout
  ADD CONSTRAINT fee_checkout_resolved CHECK (resolved_at IS NULL OR status NOT IN ('opening', 'open'));
CREATE INDEX fee_checkout_unresolved ON trucker.fee_checkout (booking_id) WHERE resolved_at IS NULL;

CREATE OR REPLACE FUNCTION trucker.guard_fee_checkout() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, trucker, pg_temp AS $$
BEGIN
  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'a checkout is never removed' USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW.id, NEW.booking_id, NEW.provider, NEW.currency_code, NEW.minor_units, NEW.amount, NEW.requested_by,
      NEW.organisation_id, NEW.request_key, NEW.request_hash, NEW.created_at, NEW.expires_at)
     IS NOT DISTINCT FROM
     (OLD.id, OLD.booking_id, OLD.provider, OLD.currency_code, OLD.minor_units, OLD.amount, OLD.requested_by,
      OLD.organisation_id, OLD.request_key, OLD.request_hash, OLD.created_at, OLD.expires_at)
     AND NEW.row_version = OLD.row_version + 1
     AND ((OLD.provider_reference IS NULL AND OLD.status = 'opening')
          OR (NEW.provider_reference, NEW.checkout_url) IS NOT DISTINCT FROM (OLD.provider_reference, OLD.checkout_url))
     -- The provider's word, once known, stays.
     AND (OLD.resolved_at IS NULL OR NEW.resolved_at IS NOT DISTINCT FROM OLD.resolved_at)
     AND ((OLD.status = 'opening' AND NEW.status IN ('open', 'failed', 'expired'))
          OR (OLD.status = 'open' AND NEW.status IN ('paid', 'failed', 'expired'))
          OR (OLD.status IN ('failed', 'expired') AND NEW.status = 'paid')
          -- The provider's word on a checkout already closed here.
          OR (OLD.status IN ('failed', 'expired') AND NEW.status = OLD.status
              AND OLD.resolved_at IS NULL AND NEW.resolved_at IS NOT NULL)) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'a checkout only moves forward' USING ERRCODE = 'check_violation';
END
$$;

-- When the fee job last asked the provider about an unresolved checkout, and what it heard.
CREATE TABLE trucker.fee_checkout_inquiry (
  checkout_id uuid PRIMARY KEY REFERENCES trucker.fee_checkout (id),
  asked_at timestamptz NOT NULL,
  answer text NOT NULL CHECK (answer IN ('reported', 'open', 'unknown', 'unreachable')),
  asked_count integer NOT NULL DEFAULT 1 CHECK (asked_count >= 1)
);
ALTER TABLE trucker.fee_checkout_inquiry ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON trucker.fee_checkout_inquiry FROM PUBLIC, trucker_app;

-- A checkout opened before the deadline holds the booking: while it is open, until it closes
-- and the usual wait for the provider's word has passed; and while the provider has not
-- answered for it, for at most payment_unresolved_minutes more.
CREATE OR REPLACE FUNCTION trucker.fee_checkout_hold(p_booking uuid, p_at timestamptz) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM trucker.fee_checkout c JOIN trucker.booking_fee f ON f.booking_id = c.booking_id
    CROSS JOIN trucker.security_setting g
    WHERE c.booking_id = p_booking AND c.created_at <= f.due_at AND c.resolved_at IS NULL
      AND ((c.status IN ('opening', 'open') AND p_at < c.expires_at + make_interval(mins => g.payment_notice_grace_minutes))
           OR (c.provider_reference IS NOT NULL
               AND p_at < c.expires_at + make_interval(mins => g.payment_notice_grace_minutes + g.payment_unresolved_minutes))))
$$;

-- Every checkout whose outcome the provider has not given, once it is closed or its time is
-- up, longest unasked first.
CREATE OR REPLACE FUNCTION trucker.fee_checkouts_to_check() RETURNS TABLE (provider text, provider_reference text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
  SELECT c.provider, c.provider_reference FROM trucker.fee_checkout c
  LEFT JOIN trucker.fee_checkout_inquiry q ON q.checkout_id = c.id
  WHERE c.resolved_at IS NULL AND c.provider_reference IS NOT NULL
    AND (c.status IN ('failed', 'expired') OR c.expires_at <= trucker.clock_now())
  ORDER BY q.asked_at NULLS FIRST, c.expires_at, c.id LIMIT 50
$$;

-- What the fee job heard when it asked: the provider's word itself goes to payment_report.
CREATE FUNCTION trucker.fee_checkout_asked(p_provider text, p_reference text, p_answer text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
DECLARE
  c trucker.fee_checkout;
BEGIN
  IF p_answer IS NULL OR p_answer NOT IN ('reported', 'open', 'unknown', 'unreachable') THEN
    RETURN;
  END IF;
  SELECT * INTO c FROM trucker.fee_checkout x WHERE x.provider = p_provider AND x.provider_reference = p_reference;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  INSERT INTO trucker.fee_checkout_inquiry (checkout_id, asked_at, answer)
  VALUES (c.id, trucker.clock_now(), p_answer)
  ON CONFLICT (checkout_id) DO UPDATE
    SET asked_at = excluded.asked_at, answer = excluded.answer,
        asked_count = trucker.fee_checkout_inquiry.asked_count + 1;
END
$$;

-- A refusal by the provider is its final word: it never opened the checkout.
CREATE OR REPLACE FUNCTION trucker.fee_checkout_refused(p_checkout uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
DECLARE
  actor uuid := trucker.request_person();
  t timestamptz := trucker.clock_now();
BEGIN
  UPDATE trucker.fee_checkout x SET status = 'failed', closed_at = t, resolved_at = t, row_version = row_version + 1
  WHERE x.id = p_checkout AND x.requested_by = actor AND x.status = 'opening';
  RETURN CASE WHEN FOUND THEN 'failed' ELSE 'unchanged' END;
END
$$;

CREATE OR REPLACE FUNCTION trucker.fee_checkout_values(c trucker.fee_checkout)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'trucker', 'pg_temp'
AS $function$
  SELECT jsonb_build_object('id', c.id, 'bookingId', c.booking_id, 'status', c.status, 'provider', c.provider,
                            'providerReference', c.provider_reference, 'url', c.checkout_url,
                            'amount', trucker.amount_text(c.amount, c.minor_units), 'currency', c.currency_code,
                            'createdAt', c.created_at, 'expiresAt', c.expires_at, 'closedAt', c.closed_at,
                            'resolvedAt', c.resolved_at,
                            'reference', (SELECT f.reference FROM trucker.booking_fee f WHERE f.booking_id = c.booking_id))
$function$;

CREATE OR REPLACE FUNCTION trucker.payment_report(p_provider text, p_notification_id text, p_kind text, p_content jsonb, OUT status text, OUT detail jsonb)
 RETURNS record
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'trucker', 'pg_temp'
AS $function$
#variable_conflict use_column
DECLARE
  v_status text := p_content ->> 'status';
  v_ref text := p_content ->> 'providerReference';
  v_tx text := p_content ->> 'transactionId';
  v_currency text := p_content ->> 'currency';
  v_amount numeric;
  v_paid timestamptz;
  v_line text;
  v_result text;
  v_settle boolean;
  pn trucker.payment_notification;
  c trucker.fee_checkout;
  b trucker.booking;
  f trucker.booking_fee;
  p trucker.fee_payment;
  r trucker.fee_refund;
  n integer;
  t timestamptz;
BEGIN
  IF p_provider IS NULL OR p_provider NOT IN ('test')
     OR p_notification_id IS NULL OR p_notification_id !~ '^[A-Za-z0-9_.:-]{1,200}$'
     OR p_kind IS NULL OR p_kind NOT IN ('notification', 'status_check')
     OR v_status IS NULL OR v_status NOT IN ('paid', 'failed', 'expired')
     OR v_ref IS NULL OR v_ref !~ '^[A-Za-z0-9_.:-]{1,200}$' THEN
    status := 'invalid';
    RETURN;
  END IF;
  IF v_status = 'paid' THEN
    IF v_tx IS NULL OR v_tx !~ '^[A-Za-z0-9_.:-]{1,80}$'
       OR coalesce(p_content ->> 'amount', '') !~ '^[0-9]{1,12}(\.[0-9]{1,3})?$'
       OR coalesce(v_currency, '') !~ '^[A-Z]{3}$'
       OR coalesce(p_content ->> 'paidAt', '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T' THEN
      status := 'invalid';
      RETURN;
    END IF;
    BEGIN
      v_paid := (p_content ->> 'paidAt')::timestamptz;
    EXCEPTION WHEN OTHERS THEN
      status := 'invalid';
      RETURN;
    END;
    v_amount := (p_content ->> 'amount')::numeric;
    v_line := 'online:' || p_provider || ':' || v_tx;
  END IF;
  SELECT * INTO pn FROM trucker.payment_notification x WHERE x.provider = p_provider AND x.notification_id = p_notification_id;
  IF FOUND THEN
    status := 'repeated';
    detail := jsonb_build_object('result', pn.result);
    RETURN;
  END IF;
  SELECT * INTO c FROM trucker.fee_checkout x WHERE x.provider = p_provider AND x.provider_reference = v_ref;
  IF NOT FOUND THEN
    t := trucker.clock_now();
    INSERT INTO trucker.payment_notification
      (provider, notification_id, kind, reported, provider_reference, transaction_id, amount, currency_code, paid_at,
       received_at, result)
    VALUES (p_provider, p_notification_id, p_kind, v_status, v_ref, v_tx, v_amount, v_currency, v_paid, t,
            'unknown_checkout')
    ON CONFLICT (provider, notification_id) DO NOTHING;
    status := CASE WHEN FOUND THEN 'recorded' ELSE 'repeated' END;
    detail := jsonb_build_object('result', 'unknown_checkout');
    RETURN;
  END IF;
  SELECT * INTO b FROM trucker.booking x WHERE x.id = c.booking_id;
  n := trucker.booking_lock_set(b);
  t := trucker.clock_now();
  -- The same notice may have been stored while this one waited for the locks.
  SELECT * INTO pn FROM trucker.payment_notification x WHERE x.provider = p_provider AND x.notification_id = p_notification_id;
  IF FOUND THEN
    status := 'repeated';
    detail := jsonb_build_object('result', pn.result);
    RETURN;
  END IF;
  SELECT * INTO c FROM trucker.fee_checkout x WHERE x.id = c.id FOR UPDATE;
  SELECT * INTO f FROM trucker.booking_fee x WHERE x.booking_id = b.id FOR UPDATE;
  IF v_status IN ('failed', 'expired') THEN
    IF c.status IN ('opening', 'open') THEN
      UPDATE trucker.fee_checkout x SET status = v_status, closed_at = t, resolved_at = t,
                                        row_version = row_version + 1
      WHERE x.id = c.id;
    ELSIF c.resolved_at IS NULL AND c.status IN ('failed', 'expired') THEN
      -- Closed here earlier (expired or replaced); now the provider's word is known.
      UPDATE trucker.fee_checkout x SET resolved_at = t, row_version = row_version + 1 WHERE x.id = c.id;
    END IF;
    v_result := v_status;
  ELSE
    SELECT * INTO p FROM trucker.fee_payment x WHERE x.statement_reference = v_line;
    IF FOUND THEN
      -- The provider's transaction is applied once, however many times it is reported (R-13).
      v_result := 'already_applied';
    ELSIF v_amount <> c.amount OR v_currency <> c.currency_code THEN
      -- G-10: never settled. Staff review it; reconciliation is slice 28.
      v_result := 'mismatch';
      IF c.status IN ('opening', 'open') THEN
        UPDATE trucker.fee_checkout x SET status = 'failed', closed_at = t, resolved_at = t,
                                          row_version = row_version + 1
        WHERE x.id = c.id;
      ELSIF c.resolved_at IS NULL AND c.status IN ('failed', 'expired') THEN
        UPDATE trucker.fee_checkout x SET resolved_at = t, row_version = row_version + 1 WHERE x.id = c.id;
      END IF;
    ELSE
      -- In time if the provider took it by the deadline, and the fee is still due.
      v_settle := f.status = 'due' AND least(v_paid, t) <= f.due_at;
      INSERT INTO trucker.fee_payment
        (booking_id, method, currency_code, minor_units, amount, value_date, statement_reference, status, outcome,
         recorded_at, record_key, record_hash, decided_at, checkout_id)
      VALUES (b.id, 'online', c.currency_code, c.minor_units, v_amount, (least(v_paid, t) AT TIME ZONE 'UTC')::date,
              v_line, 'approved', CASE WHEN v_settle THEN 'settled' ELSE 'refund_due' END, t, v_line,
              trucker.content_hash(p_content), t, c.id)
      RETURNING * INTO p;
      IF c.status <> 'paid' THEN
        UPDATE trucker.fee_checkout x SET status = 'paid', closed_at = coalesce(x.closed_at, t),
                                          resolved_at = coalesce(x.resolved_at, t),
                                          row_version = row_version + 1
        WHERE x.id = c.id;
      END IF;
      IF v_settle THEN
        UPDATE trucker.booking_fee x SET status = 'paid', paid_at = t, payment_id = p.id, row_version = row_version + 1
        WHERE x.booking_id = b.id;
        PERFORM trucker.fee_receipt_issue(p.id, t);
        PERFORM trucker.fee_audit(b, t, NULL, NULL, 'booking.fee_paid',
                                  jsonb_build_object('status', 'paid', 'method', 'online'));
        PERFORM trucker.fee_confirm_if_ready(b, n, t, NULL);
        v_result := 'settled';
      ELSE
        INSERT INTO trucker.fee_refund (booking_id, payment_id, reason, currency_code, minor_units, amount, status,
                                        recorded_at)
        VALUES (b.id, p.id, CASE WHEN f.status = 'paid' THEN 'duplicate_payment' ELSE 'booking_ended' END,
                p.currency_code, p.minor_units, p.amount, 'pending', t)
        RETURNING * INTO r;
        PERFORM trucker.fee_audit(b, t, NULL, NULL, 'booking.refund_recorded',
                                  jsonb_build_object('reason', r.reason, 'currency', r.currency_code,
                                                     'amount', trucker.amount_text(r.amount, r.minor_units)));
        v_result := 'refund_due';
      END IF;
    END IF;
  END IF;
  INSERT INTO trucker.payment_notification
    (provider, notification_id, kind, reported, provider_reference, transaction_id, amount, currency_code, paid_at,
     received_at, checkout_id, payment_id, result)
  VALUES (p_provider, p_notification_id, p_kind, v_status, v_ref, v_tx, v_amount, v_currency, v_paid, t, c.id, p.id,
          v_result);
  status := 'recorded';
  detail := jsonb_build_object('result', v_result, 'bookingId', b.id);
END
$function$;

CREATE OR REPLACE FUNCTION trucker.fee_lapse_if_due(b trucker.booking, p_set integer, p_at timestamp with time zone)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'trucker', 'pg_temp'
AS $function$
#variable_conflict use_column
DECLARE
  f trucker.booking_fee;
BEGIN
  SELECT * INTO f FROM trucker.booking_fee x WHERE x.booking_id = b.id FOR UPDATE;
  IF NOT FOUND OR f.status <> 'due' OR f.due_at > p_at OR trucker.fee_held(f)
     OR trucker.fee_checkout_hold(b.id, p_at)
     OR EXISTS (SELECT 1 FROM trucker.booking_cancellation x WHERE x.booking_id = b.id) THEN
    RETURN false;
  END IF;
  -- It lapsed at the deadline; what was held is let go now.
  INSERT INTO trucker.booking_cancellation
    (booking_id, cancelled_by, cancelling_organisation, party, cancelled_at, reason, note, set_no,
     pickup_in_seconds, was_confirmed, assignment_overdue, wait_decided_at, terms_code, terms_version, terms_hash)
  VALUES (b.id, NULL, NULL, 'platform', f.due_at, 'fee_not_paid', NULL, p_set,
          extract(epoch FROM b.pickup_from_at - f.due_at),
          EXISTS (SELECT 1 FROM trucker.booking_confirmation x WHERE x.booking_id = b.id),
          b.assignment_due_at < f.due_at,
          (SELECT w.decided_at FROM trucker.booking_wait_decision w WHERE w.booking_id = b.id),
          b.terms_code, b.terms_version, b.terms_hash);
  UPDATE trucker.resource_reservation x SET status = 'released', released_at = p_at, release_reason = 'booking_cancelled'
  WHERE x.booking_id = b.id AND x.status = 'active';
  UPDATE trucker.booking_assignment x SET status = 'ended', ended_at = p_at, ended_set_no = p_set + 1
  WHERE x.booking_id = b.id AND x.status = 'active';
  UPDATE trucker.booking_substitution x SET status = 'cancelled', decided_at = p_at, row_version = row_version + 1
  WHERE x.booking_id = b.id AND x.status = 'proposed';
  UPDATE trucker.booking_assignment_state x SET set_no = p_set + 1, updated_at = p_at WHERE x.booking_id = b.id;
  -- The shipment can be published again, as after any cancellation.
  UPDATE trucker.shipment_draft d SET status = 'booking_cancelled', awarded_at = NULL, updated_at = p_at,
                                      version = version + 1
  WHERE d.id = b.shipment_id;
  UPDATE trucker.booking_fee x SET status = 'lapsed', ended_at = f.due_at, row_version = row_version + 1
  WHERE x.booking_id = b.id;
  PERFORM trucker.fee_audit(b, f.due_at, NULL, NULL, 'booking.lapsed',
                            jsonb_build_object('reason', 'fee_not_paid', 'recordedAt', p_at,
                                               -- Checkouts the provider never answered for, at the end of the
                                               -- longest wait: a payment may still be reported, and is returned.
                                               'providerUnanswered',
                                               (SELECT count(*) FROM trucker.fee_checkout c
                                                WHERE c.booking_id = b.id AND c.resolved_at IS NULL
                                                  AND c.provider_reference IS NOT NULL)));
  RETURN true;
END
$function$;

CREATE OR REPLACE FUNCTION trucker.staff_fee_payments(p_token_hash text, p_request_id text, OUT status text, OUT detail jsonb)
 RETURNS record
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'trucker', 'pg_temp'
AS $function$
#variable_conflict use_column
DECLARE
  e record;
BEGIN
  SELECT * INTO e FROM trucker.staff_enter(p_token_hash, 'staff_admin', 'staff.fee_payment.view', NULL, p_request_id);
  status := e.status;
  IF status <> 'ok' THEN
    RETURN;
  END IF;
  PERFORM trucker.staff_audit(e.at, e.staff_id, 'staff.fee_payment.view', 'done', NULL, p_request_id, '{}'::jsonb);
  detail := jsonb_build_object(
    'staffId', e.staff_id,
    -- Soonest deadline first.
    'due', coalesce((
      SELECT jsonb_agg(x.item ORDER BY x.due_at, x.booking_id) FROM (
        SELECT f.due_at, f.booking_id, trucker.fee_values(b, 'staff', e.at) || jsonb_build_object('bookingId', b.id)
                 AS item
        FROM trucker.booking_fee f JOIN trucker.booking b ON b.id = f.booking_id
        WHERE f.status = 'due' ORDER BY f.due_at, f.booking_id LIMIT 200) x), '[]'::jsonb),
    'awaitingApproval', coalesce((
      SELECT jsonb_agg(trucker.fee_payment_values(p) ORDER BY p.recorded_at, p.id)
      FROM trucker.fee_payment p WHERE p.status = 'recorded'), '[]'::jsonb),
    'decided', coalesce((
      SELECT jsonb_agg(x.item ORDER BY x.decided_at DESC, x.id) FROM (
        SELECT p.decided_at, p.id, trucker.fee_payment_values(p) AS item
        FROM trucker.fee_payment p WHERE p.status <> 'recorded' ORDER BY p.decided_at DESC, p.id LIMIT 50) x),
      '[]'::jsonb),
    -- What a provider said that could not be applied: for staff to look into (slice 28).
    'onlineReview', coalesce((
      SELECT jsonb_agg(x.item ORDER BY x.received_at DESC, x.id) FROM (
        SELECT n.received_at, n.id, jsonb_build_object(
                 'id', n.id, 'provider', n.provider, 'notificationId', n.notification_id, 'kind', n.kind,
                 'result', n.result, 'providerReference', n.provider_reference, 'transactionId', n.transaction_id,
                 'amount', n.amount::text, 'currency', n.currency_code, 'receivedAt', n.received_at,
                 'reference', (SELECT f.reference FROM trucker.fee_checkout c JOIN trucker.booking_fee f
                               ON f.booking_id = c.booking_id WHERE c.id = n.checkout_id)) AS item
        FROM trucker.payment_notification n WHERE n.result IN ('mismatch', 'unknown_checkout')
        ORDER BY n.received_at DESC, n.id LIMIT 50) x), '[]'::jsonb),
    'openCheckouts', coalesce((
      -- In progress, and those whose outcome the provider has not given (R3).
      SELECT jsonb_agg(trucker.fee_checkout_values(c) || jsonb_build_object(
               'awaitingProvider', c.status NOT IN ('opening', 'open'),
               'lastAsked', (SELECT jsonb_build_object('at', q.asked_at, 'answer', q.answer, 'times', q.asked_count)
                             FROM trucker.fee_checkout_inquiry q WHERE q.checkout_id = c.id))
             ORDER BY c.expires_at, c.id)
      FROM trucker.fee_checkout c
      WHERE c.status IN ('opening', 'open') OR (c.resolved_at IS NULL AND c.provider_reference IS NOT NULL)), '[]'::jsonb),
    'refunds', coalesce((
      SELECT jsonb_agg(trucker.fee_refund_values(r) || jsonb_build_object(
               'reference', (SELECT f.reference FROM trucker.booking_fee f WHERE f.booking_id = r.booking_id))
             ORDER BY r.recorded_at, r.id)
      FROM trucker.fee_refund r WHERE r.status = 'pending'), '[]'::jsonb));
END
$function$;

-- ---------------------------------------------------------------------------------------------
-- R4, R5: the caller is checked again when the decision is taken
-- ---------------------------------------------------------------------------------------------
-- The time, without any check.
CREATE FUNCTION trucker.clock_raw() RETURNS timestamptz
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
  SELECT coalesce(
    (SELECT c.fixed_at FROM trucker.test_clock c
      WHERE (SELECT e.kind FROM trucker.environment e) = 'test'),
    pg_catalog.clock_timestamp())
$$;

-- The request's caller, at p_at. A participant's session that was live at the first check of
-- this transaction must still be live; a staff session that staff_enter admitted must still be
-- live, with the privilege it was admitted for. Otherwise the transaction is undone. Checked
-- again whenever the time reaches the earliest moment the session could end, or a second has
-- passed since the last check (a revocation or a privilege removed meanwhile).
CREATE FUNCTION trucker.actor_recheck(p_at timestamptz) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_person text := nullif(current_setting('trucker.session_token_hash', true), '');
  v_staff text := nullif(current_setting('trucker.staff_token_hash', true), '');
  v_until text := nullif(current_setting('trucker.actor_valid_until', true), '');
  v_checked text := nullif(current_setting('trucker.actor_checked_at', true), '');
  v_baseline text := nullif(current_setting('trucker.actor_session_live', true), '');
  v_privilege text := nullif(current_setting('trucker.staff_privilege', true), '');
  v_valid timestamptz := 'infinity';
  s trucker.session;
  ss trucker.staff_session;
  g trucker.security_setting;
  v_state text;
BEGIN
  IF (v_person IS NULL AND v_staff IS NULL) OR p_at IS NULL
     OR current_setting('trucker.actor_checking', true) = 'on' THEN
    RETURN;
  END IF;
  IF v_until IS NOT NULL AND v_checked IS NOT NULL AND p_at < v_until::timestamptz
     AND p_at < v_checked::timestamptz + interval '1 second' THEN
    RETURN;
  END IF;
  PERFORM set_config('trucker.actor_checking', 'on', true);
  SELECT * INTO g FROM trucker.security_setting;
  IF v_person IS NOT NULL AND v_person ~ '^[0-9a-f]{64}$' THEN
    SELECT * INTO s FROM trucker.session x WHERE x.token_hash = v_person;
    v_state := trucker.session_state(s, p_at);
    IF v_baseline IS NULL THEN
      -- The first check: the session the request began with. One that was not live then is
      -- handled by each function as before.
      v_baseline := CASE WHEN v_state = 'live' THEN 'live' ELSE 'not_live' END;
      PERFORM set_config('trucker.actor_session_live', v_baseline, true);
    ELSIF v_baseline = 'live' AND v_state <> 'live' THEN
      RAISE EXCEPTION 'no signed-in person: the session ended while the request waited, so it would go on without a signed-in person'
        USING ERRCODE = 'TR401';
    END IF;
    IF v_state = 'live' THEN
      v_valid := least(v_valid, s.absolute_expires_at,
                       s.created_at + make_interval(hours => g.session_absolute_hours),
                       s.last_used_at + make_interval(mins => g.session_idle_minutes));
    END IF;
  END IF;
  IF v_staff IS NOT NULL THEN
    SELECT * INTO ss FROM trucker.staff_session x WHERE x.token_hash = v_staff;
    IF trucker.staff_session_state(ss, p_at) <> 'live' THEN
      RAISE EXCEPTION 'the staff session ended while the request waited' USING ERRCODE = 'TR401';
    END IF;
    IF v_privilege IS NOT NULL AND NOT (v_privilege = ANY (trucker.staff_privileges(ss.staff_id))) THEN
      RAISE EXCEPTION 'the privilege was removed while the request waited' USING ERRCODE = 'TR403';
    END IF;
    v_valid := least(v_valid, ss.absolute_expires_at,
                     ss.created_at + make_interval(hours => g.staff_session_absolute_hours),
                     ss.last_used_at + make_interval(mins => g.staff_session_idle_minutes));
  END IF;
  PERFORM set_config('trucker.actor_valid_until', v_valid::text, true);
  PERFORM set_config('trucker.actor_checked_at', p_at::text, true);
  PERFORM set_config('trucker.actor_checking', 'off', true);
END
$$;

-- Reading the decision time checks the caller. Every function reads it after taking its locks.
CREATE OR REPLACE FUNCTION trucker.clock_now() RETURNS timestamptz
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
DECLARE
  t timestamptz := trucker.clock_raw();
BEGIN
  PERFORM trucker.actor_recheck(t);
  RETURN t;
END
$$;

-- So does recording what was decided, for functions that took their time earlier.
CREATE FUNCTION trucker.audit_actor_recheck() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
BEGIN
  PERFORM trucker.actor_recheck(trucker.clock_raw());
  RETURN NEW;
END
$$;
CREATE TRIGGER audit_entry_actor_recheck BEFORE INSERT ON trucker.audit_entry
  FOR EACH ROW EXECUTE FUNCTION trucker.audit_actor_recheck();
CREATE TRIGGER staff_audit_entry_actor_recheck BEFORE INSERT ON trucker.staff_audit_entry
  FOR EACH ROW EXECUTE FUNCTION trucker.audit_actor_recheck();

CREATE OR REPLACE FUNCTION trucker.staff_enter(p_token_hash text, p_privilege text, p_action text, p_subject uuid, p_request_id text, OUT status text, OUT staff_id uuid, OUT at timestamp with time zone)
 RETURNS record
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'trucker', 'pg_temp'
AS $function$
#variable_conflict use_column
DECLARE
  own trucker.staff_session;
BEGIN
  status := 'unauthorized';
  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN
    RETURN;
  END IF;
  SELECT * INTO own FROM trucker.staff_session s WHERE s.token_hash = p_token_hash FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  IF p_subject IS NOT NULL THEN
    PERFORM 1 FROM trucker.staff_account a WHERE a.id = p_subject FOR UPDATE;
  END IF;
  at := trucker.clock_now();
  IF trucker.staff_session_state(own, at) <> 'live' THEN
    RETURN;
  END IF;
  staff_id := own.staff_id;
  IF p_privilege IS NOT NULL AND NOT (p_privilege = ANY (trucker.staff_privileges(own.staff_id))) THEN
    PERFORM trucker.staff_audit(at, own.staff_id, p_action, 'refused', p_subject, p_request_id,
                                jsonb_build_object('reason', 'privilege_not_held', 'privilege', p_privilege));
    status := 'forbidden';
    RETURN;
  END IF;
  status := 'ok';
  -- What later reads of the time check again (actor_recheck).
  PERFORM set_config('trucker.staff_token_hash', p_token_hash, true),
          set_config('trucker.staff_privilege', coalesce(p_privilege, ''), true),
          set_config('trucker.actor_valid_until', '', true);
END
$function$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA trucker FROM PUBLIC;
GRANT EXECUTE ON FUNCTION trucker.fee_checkouts_to_check() TO trucker_app;
GRANT EXECUTE ON FUNCTION trucker.fee_checkout_asked(text, text, text) TO trucker_app;
