-- Online payment of Trucker's fee, and receipts (slice 27; ADR-001 R-10 to R-13, G-10).
--
-- The payer opens a checkout with a payment provider through a provider-neutral interface. Only
-- one payment provider exists here: a development stand-in that moves no money. A return from
-- the checkout is never proof (R-12): only a provider's signed notification, or the provider's
-- answer to a status check made by the server, counts. Each notification is stored once by its
-- identifier and each provider transaction is applied once (R-13); the amount and the currency
-- must equal the checkout's (G-10). A payment that settles the fee confirms the booking when
-- every resource is reserved, as a verified bank transfer does (slice 26). Money that arrives
-- for a booking that has ended, or twice, becomes a refund record. Each payment that settles a
-- fee gets a receipt: an acknowledgement of payment, not a tax invoice.
--
-- The API verifies the provider's signature before it calls payment_report; the database
-- stores and applies what it is given. Development defaults are in
-- docs/delivery/ONLINE_PAYMENT_SLICE_27.md.

-- ---------------------------------------------------------------------------------------------
-- Settings: how long a checkout stays open, and how long after it the booking waits for word
-- ---------------------------------------------------------------------------------------------
ALTER TABLE trucker.security_setting
  ADD COLUMN checkout_minutes integer NOT NULL DEFAULT 30 CHECK (checkout_minutes BETWEEN 5 AND 120),
  ADD COLUMN payment_notice_grace_minutes integer NOT NULL DEFAULT 15
    CHECK (payment_notice_grace_minutes BETWEEN 1 AND 120);

-- ---------------------------------------------------------------------------------------------
-- Checkouts
-- ---------------------------------------------------------------------------------------------
-- opening: written, the provider not yet answered; open: the provider has a checkout; then
-- paid, failed or expired. A checkout reported paid after it failed or expired here is still
-- paid: the money was taken.
CREATE TABLE trucker.fee_checkout (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id uuid NOT NULL REFERENCES trucker.booking_fee (booking_id),
  provider text NOT NULL CHECK (provider IN ('test')),
  provider_reference text CHECK (provider_reference ~ '^[A-Za-z0-9_.:-]{1,200}$'),
  checkout_url text CHECK (checkout_url IS NULL OR char_length(checkout_url) <= 2000),
  currency_code text NOT NULL REFERENCES trucker.currency (code),
  minor_units integer NOT NULL,
  amount numeric NOT NULL CHECK (amount > 0),
  status text NOT NULL CHECK (status IN ('opening', 'open', 'paid', 'failed', 'expired')),
  requested_by uuid NOT NULL REFERENCES trucker.person (id),
  organisation_id uuid NOT NULL REFERENCES trucker.organisation (id),
  request_key text NOT NULL,
  request_hash text NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  closed_at timestamptz,
  row_version integer NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  UNIQUE (requested_by, request_key),
  UNIQUE (provider, provider_reference),
  CONSTRAINT fee_checkout_started CHECK ((status = 'opening') OR status IN ('failed', 'expired')
                                         OR provider_reference IS NOT NULL),
  CONSTRAINT fee_checkout_closed CHECK ((status IN ('opening', 'open')) = (closed_at IS NULL)),
  CONSTRAINT fee_checkout_window CHECK (expires_at > created_at)
);
ALTER TABLE trucker.fee_checkout ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON trucker.fee_checkout FROM PUBLIC, trucker_app;
-- One checkout in progress per booking: a payer who asks again resumes it (R-13).
CREATE UNIQUE INDEX fee_checkout_one_open ON trucker.fee_checkout (booking_id) WHERE status IN ('opening', 'open');

CREATE FUNCTION trucker.guard_fee_checkout() RETURNS trigger
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
     AND ((OLD.status = 'opening' AND NEW.status IN ('open', 'failed', 'expired'))
          OR (OLD.status = 'open' AND NEW.status IN ('paid', 'failed', 'expired'))
          OR (OLD.status IN ('failed', 'expired') AND NEW.status = 'paid')) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'a checkout only moves forward' USING ERRCODE = 'check_violation';
END
$$;
CREATE TRIGGER fee_checkout_guard BEFORE UPDATE OR DELETE ON trucker.fee_checkout
  FOR EACH ROW EXECUTE FUNCTION trucker.guard_fee_checkout();
CREATE TRIGGER fee_checkout_truncate_guard BEFORE TRUNCATE ON trucker.fee_checkout
  FOR EACH STATEMENT EXECUTE FUNCTION trucker.guard_fee_checkout();

-- ---------------------------------------------------------------------------------------------
-- Online payments join the fee payments; receipts
-- ---------------------------------------------------------------------------------------------
ALTER TABLE trucker.fee_payment
  DROP CONSTRAINT fee_payment_method_check,
  ADD CONSTRAINT fee_payment_method_check CHECK (method IN ('bank_transfer', 'online')),
  ALTER COLUMN recorded_by DROP NOT NULL,
  ADD COLUMN checkout_id uuid REFERENCES trucker.fee_checkout (id),
  DROP CONSTRAINT fee_payment_decided,
  -- A transfer is decided by a second administrator; an online payment is decided by the
  -- provider's signed word, on arrival.
  ADD CONSTRAINT fee_payment_decided CHECK (
    (status = 'recorded') = (decided_at IS NULL)
    AND (method <> 'bank_transfer' OR (status = 'recorded') = (decided_by IS NULL))
    AND (method <> 'online' OR (status = 'approved' AND decided_by IS NULL))),
  ADD CONSTRAINT fee_payment_source CHECK (
    (method = 'bank_transfer' AND recorded_by IS NOT NULL AND checkout_id IS NULL)
    OR (method = 'online' AND recorded_by IS NULL AND checkout_id IS NOT NULL));

-- An acknowledgement that the fee was paid. Not a tax invoice: no tax rule is decided.
-- Numbers come from a sequence, so a rolled-back transaction can leave a gap.
CREATE SEQUENCE trucker.fee_receipt_number;
CREATE TABLE trucker.fee_receipt (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number text NOT NULL UNIQUE CHECK (number ~ '^TR-[0-9]{8,}$'),
  booking_id uuid NOT NULL REFERENCES trucker.booking_fee (booking_id),
  payment_id uuid NOT NULL UNIQUE REFERENCES trucker.fee_payment (id),
  payer_organisation_id uuid NOT NULL REFERENCES trucker.organisation (id),
  method text NOT NULL CHECK (method IN ('bank_transfer', 'online')),
  currency_code text NOT NULL REFERENCES trucker.currency (code),
  minor_units integer NOT NULL,
  amount numeric NOT NULL CHECK (amount > 0),
  issued_at timestamptz NOT NULL
);
ALTER TABLE trucker.fee_receipt ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON trucker.fee_receipt FROM PUBLIC, trucker_app;
CREATE TRIGGER fee_receipt_guard BEFORE UPDATE OR DELETE ON trucker.fee_receipt
  FOR EACH ROW EXECUTE FUNCTION trucker.guard_fee_refund();
CREATE TRIGGER fee_receipt_truncate_guard BEFORE TRUNCATE ON trucker.fee_receipt
  FOR EACH STATEMENT EXECUTE FUNCTION trucker.guard_fee_refund();

CREATE FUNCTION trucker.fee_receipt_issue(p_payment uuid, p_at timestamptz) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
  INSERT INTO trucker.fee_receipt
    (number, booking_id, payment_id, payer_organisation_id, method, currency_code, minor_units, amount, issued_at)
  SELECT 'TR-' || lpad(nextval('trucker.fee_receipt_number')::text, 8, '0'), p.booking_id, p.id,
         f.payer_organisation_id, p.method, p.currency_code, p.minor_units, p.amount, p_at
  FROM trucker.fee_payment p JOIN trucker.booking_fee f ON f.booking_id = p.booking_id
  WHERE p.id = p_payment AND p.outcome = 'settled'
$$;

-- Transfers that settled a fee before this migration get their receipt now.
SELECT trucker.fee_receipt_issue(p.id, p.decided_at)
FROM trucker.fee_payment p WHERE p.outcome = 'settled' ORDER BY p.decided_at, p.id;

-- ---------------------------------------------------------------------------------------------
-- What the providers said
-- ---------------------------------------------------------------------------------------------
-- Stored once per provider and identifier, whatever it said and whatever came of it. A status
-- check made by the server is stored the same way, under an identifier of its own.
CREATE TABLE trucker.payment_notification (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL CHECK (provider IN ('test')),
  notification_id text NOT NULL CHECK (notification_id ~ '^[A-Za-z0-9_.:-]{1,200}$'),
  kind text NOT NULL CHECK (kind IN ('notification', 'status_check')),
  reported text NOT NULL CHECK (reported IN ('paid', 'failed', 'expired')),
  provider_reference text NOT NULL,
  transaction_id text,
  amount numeric,
  currency_code text,
  paid_at timestamptz,
  received_at timestamptz NOT NULL,
  checkout_id uuid REFERENCES trucker.fee_checkout (id),
  payment_id uuid REFERENCES trucker.fee_payment (id),
  result text NOT NULL CHECK (result IN ('settled', 'refund_due', 'failed', 'expired', 'mismatch',
                                         'unknown_checkout', 'already_applied')),
  UNIQUE (provider, notification_id)
);
ALTER TABLE trucker.payment_notification ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON trucker.payment_notification FROM PUBLIC, trucker_app;
CREATE TRIGGER payment_notification_guard BEFORE UPDATE OR DELETE ON trucker.payment_notification
  FOR EACH ROW EXECUTE FUNCTION trucker.guard_fee_refund();
CREATE TRIGGER payment_notification_truncate_guard BEFORE TRUNCATE ON trucker.payment_notification
  FOR EACH STATEMENT EXECUTE FUNCTION trucker.guard_fee_refund();

-- ---------------------------------------------------------------------------------------------
-- Confirmation by an online payment, with no one acting
-- ---------------------------------------------------------------------------------------------
ALTER TABLE trucker.booking_confirmation
  DROP CONSTRAINT booking_confirmation_completed_by_check,
  ADD CONSTRAINT booking_confirmation_completed_by_check
    CHECK (completed_by IN ('assignment', 'fee_verification', 'online_payment')),
  DROP CONSTRAINT booking_confirmation_actor,
  ADD CONSTRAINT booking_confirmation_actor CHECK (
    (completed_by = 'assignment' AND confirmed_by IS NOT NULL AND confirmed_by_staff IS NULL)
    OR (completed_by = 'fee_verification' AND confirmed_by IS NULL AND confirmed_by_staff IS NOT NULL)
    OR (completed_by = 'online_payment' AND confirmed_by IS NULL AND confirmed_by_staff IS NULL));

ALTER TABLE trucker.audit_entry
  DROP CONSTRAINT audit_entry_one_actor,
  ADD CONSTRAINT audit_entry_one_actor CHECK (
    (actor_person_id IS NULL) <> (actor_staff_id IS NULL)
    OR (actor_person_id IS NULL AND actor_staff_id IS NULL AND action IN (
    'shipment.expired', 'shipment.suspended', 'shipment.suspension_ended', 'quotation.expired',
    'quotation.closed', 'quotation.reconfirmation_required', 'booking.lapsed',
    'booking.fee_paid', 'booking.refund_recorded', 'booking.confirmed')));

-- ---------------------------------------------------------------------------------------------
-- A checkout opened by the deadline holds the booking until it closes and word can arrive
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION trucker.fee_checkout_hold(p_booking uuid, p_at timestamptz) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM trucker.fee_checkout c JOIN trucker.booking_fee f ON f.booking_id = c.booking_id
    WHERE c.booking_id = p_booking AND c.status IN ('opening', 'open') AND c.created_at <= f.due_at
      AND p_at < c.expires_at + make_interval(mins => (SELECT g.payment_notice_grace_minutes
                                                       FROM trucker.security_setting g)))
$$;

CREATE OR REPLACE FUNCTION trucker.fee_overdue(p_booking uuid, p_at timestamp with time zone)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'trucker', 'pg_temp'
AS $function$
  SELECT EXISTS (SELECT 1 FROM trucker.booking_fee f
                 WHERE f.booking_id = p_booking AND f.status = 'due' AND f.due_at <= p_at AND NOT trucker.fee_held(f)
                   AND NOT trucker.fee_checkout_hold(f.booking_id, p_at))
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
                            jsonb_build_object('reason', 'fee_not_paid', 'recordedAt', p_at));
  RETURN true;
END
$function$;

CREATE OR REPLACE FUNCTION trucker.lapse_overdue_fee()
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'trucker', 'pg_temp'
AS $function$
#variable_conflict use_column
DECLARE
  b trucker.booking;
  n integer;
BEGIN
  SELECT x.* INTO b FROM trucker.booking x
  WHERE x.id = (SELECT f.booking_id FROM trucker.booking_fee f
                WHERE f.status = 'due' AND f.due_at <= trucker.clock_now() AND NOT trucker.fee_held(f)
                  AND NOT trucker.fee_checkout_hold(f.booking_id, trucker.clock_now())
                ORDER BY f.due_at, f.booking_id LIMIT 1);
  IF NOT FOUND THEN
    RETURN 'none';
  END IF;
  n := trucker.booking_lock_set(b);
  RETURN CASE WHEN trucker.fee_lapse_if_due(b, n, trucker.clock_now()) THEN 'lapsed' ELSE 'unchanged' END;
END
$function$;

CREATE OR REPLACE FUNCTION trucker.fee_confirm_if_ready(b trucker.booking, p_set integer, p_at timestamp with time zone, p_staff uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'trucker', 'pg_temp'
AS $function$
#variable_conflict use_column
DECLARE
  cur record;
BEGIN
  IF EXISTS (SELECT 1 FROM trucker.booking_confirmation x WHERE x.booking_id = b.id)
     OR EXISTS (SELECT 1 FROM trucker.booking_cancellation x WHERE x.booking_id = b.id)
     OR NOT trucker.fee_settled(b.id) OR NOT trucker.assignment_ready(b) THEN
    RETURN false;
  END IF;
  SELECT * INTO cur FROM trucker.assignment_current(b.id);
  INSERT INTO trucker.booking_confirmation
    (booking_id, confirmed_at, confirmed_by, confirmed_by_staff, completed_by, set_no, resources, site_details)
  -- With no staff member, the provider's signed word completed it (slice 27).
  SELECT b.id, p_at, NULL, p_staff,
         CASE WHEN p_staff IS NULL THEN 'online_payment' ELSE 'fee_verification' END, p_set,
         trucker.assignment_set_values(cur.truck, cur.trailer, cur.affiliation, 'carrier'),
         jsonb_build_object(
           'pickup', jsonb_build_object('address', d.pickup_address, 'accessNotes', d.pickup_access_notes),
           'delivery', jsonb_build_object('address', d.delivery_address, 'accessNotes', d.delivery_access_notes))
  FROM trucker.shipment_draft d WHERE d.id = b.shipment_id;
  -- In the shipper's history, as when the assignment confirms (one confirmation event per
  -- booking); the carrier's history has the fee payment.
  PERFORM trucker.fleet_audit(p_at, NULL, p_staff, b.shipper_organisation_id, 'booking.confirmed', 'booking', b.id,
    jsonb_build_object('status', 'awaiting_fee'),
    jsonb_build_object('status', 'confirmed',
                       'by', CASE WHEN p_staff IS NULL THEN 'online_payment' ELSE 'fee_verification' END,
                       'resources', trucker.assignment_set_values(cur.truck, cur.trailer, cur.affiliation, 'shipper')));
  RETURN true;
END
$function$;

CREATE OR REPLACE FUNCTION trucker.fee_payment_values(p trucker.fee_payment)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'trucker', 'pg_temp'
AS $function$
  SELECT jsonb_build_object(
    'id', p.id, 'version', p.row_version, 'bookingId', p.booking_id, 'method', p.method, 'status', p.status,
    'outcome', p.outcome, 'amount', trucker.amount_text(p.amount, p.minor_units), 'currency', p.currency_code,
    'valueDate', p.value_date, 'statementReference', p.statement_reference, 'note', p.note,
    'reference', (SELECT f.reference FROM trucker.booking_fee f WHERE f.booking_id = p.booking_id),
    'recordedBy', (SELECT jsonb_build_object('id', a.id, 'displayName', a.display_name)
                   FROM trucker.staff_account a WHERE a.id = p.recorded_by),
    'recordedAt', p.recorded_at,
    'decidedBy', (SELECT jsonb_build_object('id', a.id, 'displayName', a.display_name)
                  FROM trucker.staff_account a WHERE a.id = p.decided_by),
    'decidedAt', p.decided_at, 'decisionNote', p.decision_note, 'checkoutId', p.checkout_id)
$function$;

CREATE FUNCTION trucker.fee_checkout_values(c trucker.fee_checkout) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
  SELECT jsonb_build_object('id', c.id, 'bookingId', c.booking_id, 'status', c.status, 'provider', c.provider,
                            'providerReference', c.provider_reference, 'url', c.checkout_url,
                            'amount', trucker.amount_text(c.amount, c.minor_units), 'currency', c.currency_code,
                            'createdAt', c.created_at, 'expiresAt', c.expires_at, 'closedAt', c.closed_at,
                            'reference', (SELECT f.reference FROM trucker.booking_fee f WHERE f.booking_id = c.booking_id))
$$;

CREATE FUNCTION trucker.fee_receipt_values(r trucker.fee_receipt) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
  SELECT jsonb_build_object('number', r.number, 'method', r.method,
                            'amount', trucker.amount_text(r.amount, r.minor_units), 'currency', r.currency_code,
                            'issuedAt', r.issued_at,
                            'reference', (SELECT f.reference FROM trucker.booking_fee f WHERE f.booking_id = r.booking_id))
$$;

CREATE OR REPLACE FUNCTION trucker.fee_values(b trucker.booking, p_audience text, p_at timestamp with time zone)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'trucker', 'pg_temp'
AS $function$
  SELECT jsonb_build_object(
           'status', CASE WHEN f.status = 'due' AND f.due_at <= p_at AND NOT trucker.fee_held(f)
                               AND NOT trucker.fee_checkout_hold(f.booking_id, p_at) THEN 'overdue'
                          ELSE f.status END,
           'dueAt', f.due_at, 'paidAt', f.paid_at)
    || CASE WHEN p_audience IN ('staff', 'organiser')
              OR (p_audience = 'shipper' AND f.payer_organisation_id = b.shipper_organisation_id)
              OR (p_audience = 'carrier' AND f.payer_organisation_id = b.carrier_organisation_id)
            THEN jsonb_build_object(
                   'payer', f.payer, 'amount', trucker.amount_text(f.amount, f.minor_units),
                   'currency', f.currency_code, 'reference', f.reference, 'paymentHours', f.payment_hours,
                   -- A transfer is in hand and being verified.
                   'verifying', EXISTS (SELECT 1 FROM trucker.fee_payment x
                                        WHERE x.booking_id = f.booking_id AND x.status = 'recorded'),
                   'refunds', coalesce((SELECT jsonb_agg(trucker.fee_refund_values(r) ORDER BY r.recorded_at, r.id)
                                        FROM trucker.fee_refund r WHERE r.booking_id = f.booking_id), '[]'::jsonb),
                   -- An online payment in progress, to be resumed rather than started again.
                   'checkout', (SELECT trucker.fee_checkout_values(c) FROM trucker.fee_checkout c
                                WHERE c.booking_id = f.booking_id AND c.status IN ('opening', 'open')
                                  AND c.expires_at > p_at),
                   'receipts', coalesce((SELECT jsonb_agg(trucker.fee_receipt_values(x) ORDER BY x.issued_at, x.number)
                                         FROM trucker.fee_receipt x WHERE x.booking_id = f.booking_id), '[]'::jsonb))
            ELSE '{}'::jsonb END
    || CASE WHEN p_audience = 'staff'
            THEN jsonb_build_object(
                   'basis', f.basis,
                   'payerOrganisation', (SELECT jsonb_build_object('id', o.id, 'legalName', o.legal_name)
                                         FROM trucker.organisation o WHERE o.id = f.payer_organisation_id),
                   'payments', coalesce((SELECT jsonb_agg(trucker.fee_payment_values(x) ORDER BY x.recorded_at, x.id)
                                         FROM trucker.fee_payment x WHERE x.booking_id = f.booking_id), '[]'::jsonb),
                   'checkouts', coalesce((SELECT jsonb_agg(trucker.fee_checkout_values(c) ORDER BY c.created_at, c.id)
                                          FROM trucker.fee_checkout c WHERE c.booking_id = f.booking_id), '[]'::jsonb))
            ELSE '{}'::jsonb END
  FROM trucker.booking_fee f WHERE f.booking_id = b.id
$function$;

CREATE OR REPLACE FUNCTION trucker.staff_fee_decide(p_token_hash text, p_payment uuid, p_expected_version integer, p_decision text, p_note text, p_request_id text, OUT status text, OUT detail jsonb)
 RETURNS record
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'trucker', 'pg_temp'
AS $function$
#variable_conflict use_column
DECLARE
  e record;
  p trucker.fee_payment;
  f trucker.booking_fee;
  b trucker.booking;
  r trucker.fee_refund;
  n integer;
  t timestamptz;
  v_note text := nullif(btrim(p_note), '');
  v_confirmed boolean := false;
BEGIN
  SELECT * INTO e FROM trucker.staff_enter(p_token_hash, 'staff_admin', 'staff.fee_payment.decide', NULL, p_request_id);
  status := e.status;
  IF status <> 'ok' THEN
    RETURN;
  END IF;
  SELECT * INTO p FROM trucker.fee_payment x WHERE x.id = p_payment;
  IF NOT FOUND THEN
    status := 'not_found';
    RETURN;
  END IF;
  IF p_decision IS NULL OR p_decision NOT IN ('approve', 'reject')
     OR char_length(coalesce(v_note, '')) > 1000 OR (p_decision = 'reject' AND v_note IS NULL) THEN
    status := 'invalid';
    detail := jsonb_build_array(jsonb_build_object(
      'field', CASE WHEN p_decision IN ('approve', 'reject') THEN 'note' ELSE 'decision' END,
      'code', CASE WHEN p_decision IN ('approve', 'reject') AND v_note IS NULL THEN 'required' ELSE 'invalid' END));
    RETURN;
  END IF;
  SELECT * INTO b FROM trucker.booking x WHERE x.id = p.booking_id;
  n := trucker.booking_lock_set(b);
  t := trucker.clock_now();
  SELECT * INTO p FROM trucker.fee_payment x WHERE x.id = p_payment FOR UPDATE;
  IF p.status <> 'recorded' THEN
    status := 'already_decided';
    detail := trucker.fee_payment_values(p);
    RETURN;
  END IF;
  IF p_expected_version IS DISTINCT FROM p.row_version THEN
    status := 'conflict';
    RETURN;
  END IF;
  -- G-9: the one who matched the money to the statement does not approve it.
  IF p.recorded_by = e.staff_id THEN
    PERFORM trucker.staff_audit(t, e.staff_id, 'staff.fee_payment.decide', 'refused', NULL, p_request_id,
                                jsonb_build_object('reason', 'same_person', 'payment', p.id));
    status := 'same_person';
    RETURN;
  END IF;
  SELECT * INTO f FROM trucker.booking_fee x WHERE x.booking_id = b.id FOR UPDATE;
  IF p_decision = 'reject' THEN
    UPDATE trucker.fee_payment x SET status = 'rejected', decided_by = e.staff_id, decided_at = t,
                                     decision_note = v_note, row_version = row_version + 1
    WHERE x.id = p.id RETURNING * INTO p;
    -- Without this receipt, a fee past its deadline lapses now.
    PERFORM trucker.fee_lapse_if_due(b, n, t);
    status := 'rejected';
  ELSIF f.status = 'due' AND p.recorded_at <= f.due_at THEN
    UPDATE trucker.fee_payment x SET status = 'approved', outcome = 'settled', decided_by = e.staff_id,
                                     decided_at = t, decision_note = v_note, row_version = row_version + 1
    WHERE x.id = p.id RETURNING * INTO p;
    UPDATE trucker.booking_fee x SET status = 'paid', paid_at = t, payment_id = p.id, row_version = row_version + 1
    WHERE x.booking_id = b.id;
    PERFORM trucker.fee_receipt_issue(p.id, t);
    PERFORM trucker.fee_audit(b, t, NULL, e.staff_id, 'booking.fee_paid', jsonb_build_object('status', 'paid'));
    v_confirmed := trucker.fee_confirm_if_ready(b, n, t, e.staff_id);
    status := 'approved';
  ELSE
    -- G-11: money for a booking that lapsed or was cancelled, or paid twice, is returned.
    UPDATE trucker.fee_payment x SET status = 'approved', outcome = 'refund_due', decided_by = e.staff_id,
                                     decided_at = t, decision_note = v_note, row_version = row_version + 1
    WHERE x.id = p.id RETURNING * INTO p;
    INSERT INTO trucker.fee_refund (booking_id, payment_id, reason, currency_code, minor_units, amount, status, recorded_at)
    VALUES (b.id, p.id, CASE WHEN f.status = 'paid' THEN 'duplicate_payment' ELSE 'booking_ended' END,
            p.currency_code, p.minor_units, p.amount, 'pending', t)
    RETURNING * INTO r;
    PERFORM trucker.fee_audit(b, t, NULL, e.staff_id, 'booking.refund_recorded',
                              jsonb_build_object('reason', r.reason, 'amount', trucker.amount_text(r.amount, r.minor_units),
                                                 'currency', r.currency_code));
    status := 'approved';
  END IF;
  PERFORM trucker.staff_audit(t, e.staff_id, 'staff.fee_payment.decided', 'done', NULL, p_request_id,
                              jsonb_build_object('payment', p.id, 'booking', b.id, 'decision', p_decision,
                                                 'outcome', p.outcome, 'confirmed', v_confirmed));
  SELECT * INTO b FROM trucker.booking x WHERE x.id = b.id;
  detail := jsonb_build_object('payment', trucker.fee_payment_values(p),
                               'booking', trucker.booking_view(b, 'staff', t));
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
      SELECT jsonb_agg(trucker.fee_checkout_values(c) ORDER BY c.expires_at, c.id)
      FROM trucker.fee_checkout c WHERE c.status IN ('opening', 'open')), '[]'::jsonb),
    'refunds', coalesce((
      SELECT jsonb_agg(trucker.fee_refund_values(r) || jsonb_build_object(
               'reference', (SELECT f.reference FROM trucker.booking_fee f WHERE f.booking_id = r.booking_id))
             ORDER BY r.recorded_at, r.id)
      FROM trucker.fee_refund r WHERE r.status = 'pending'), '[]'::jsonb));
END
$function$;

CREATE OR REPLACE FUNCTION trucker.shipment_commission_terms(p_shipment uuid, p_amount text, p_currency text, OUT status text, OUT detail jsonb)
 RETURNS record
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'trucker', 'pg_temp'
AS $function$
#variable_conflict use_column
DECLARE
  actor uuid := trucker.request_person();
  v_org uuid := trucker.request_organisation();
  d trucker.shipment_draft;
  c trucker.shipment_commission;
  f record;
BEGIN
  IF actor IS NULL THEN
    status := 'unauthorized';
    RETURN;
  END IF;
  IF v_org IS NULL OR NOT trucker.is_admin(v_org) THEN
    status := 'not_found';
    RETURN;
  END IF;
  SELECT * INTO d FROM trucker.shipment_draft x WHERE x.id = p_shipment;
  -- The keeper of the shipment, or a carrier while it is published. Never the customer.
  IF NOT FOUND OR NOT (d.organisation_id = v_org
                       OR (d.status = 'published' AND trucker.is_carrier(v_org)
                           AND trucker.shipment_customer(d.id) <> v_org)) THEN
    status := 'not_found';
    RETURN;
  END IF;
  SELECT * INTO c FROM trucker.shipment_commission x WHERE x.shipment_id = d.id;
  status := 'ok';
  detail := jsonb_build_object('commission', trucker.shipment_commission_values(c));
  -- Under the contract option, a carrier is told the contract it holds with the organiser.
  IF c.option = 'contract' AND d.organisation_id <> v_org THEN
    detail := detail || jsonb_build_object('contract', (
      SELECT trucker.contract_values(k, v_org) FROM trucker.commission_contract k
      WHERE k.organiser_organisation_id = trucker.shipment_organiser(d.id)
        AND k.carrier_organisation_id = v_org AND k.status = 'active'));
  END IF;
  IF d.organisation_id = v_org THEN
    detail := detail || jsonb_build_object(
      'arranged', trucker.shipment_customer(d.id) <> v_org,
      'editable', d.status = 'draft' AND d.published_version IS NULL,
      -- The organiser's view of the price of the booking made from it, once there is one.
      'bookedPrice', (SELECT trucker.booking_price_values(p, 'organiser') FROM trucker.booking_price p
                      JOIN trucker.booking b ON b.id = p.booking_id
                      WHERE b.shipment_id = d.id AND p.organiser_organisation_id = v_org
                        AND trucker.shipment_customer(d.id) <> v_org
                      ORDER BY b.accepted_at DESC LIMIT 1),
      -- Trucker's fee, when the organiser is the one who pays it.
      'feePayment', (SELECT trucker.fee_values(b, 'organiser', trucker.clock_now())
                            || jsonb_build_object('bookingId', b.id) FROM trucker.booking b
                     JOIN trucker.booking_fee f ON f.booking_id = b.id
                     WHERE b.shipment_id = d.id AND f.payer_organisation_id = v_org
                       AND trucker.shipment_customer(d.id) <> v_org
                     ORDER BY b.accepted_at DESC LIMIT 1),
      -- What the settings in force allow, for the organiser's form.
      'limits', (SELECT jsonb_build_object('options', to_jsonb(f.commission_options),
                                           'maxBasisPoints', f.commission_max_basis_points)
                 FROM trucker.financial_settings_at(trucker.clock_now()) f));
  END IF;
  IF c.shipment_id IS NOT NULL AND p_amount ~ '^[0-9]{1,12}(\.[0-9]{1,3})?$'
     AND EXISTS (SELECT 1 FROM trucker.currency x WHERE x.code = p_currency) THEN
    SELECT * INTO f FROM trucker.commission_figures_for(
      d.id, CASE WHEN d.organisation_id <> v_org THEN v_org END, p_amount::numeric, p_currency);
    detail := detail || jsonb_build_object('figures', jsonb_build_object(
      'state', f.status,
      'commission', CASE WHEN f.status = 'ok' THEN trucker.amount_text(f.commission, f.minor) END,
      'net', CASE WHEN f.status = 'ok' THEN trucker.amount_text(f.net, f.minor) END,
      'currency', p_currency));
  END IF;
END
$function$;

-- ---------------------------------------------------------------------------------------------
-- The payer opens a checkout
-- ---------------------------------------------------------------------------------------------
-- Status: created, existing (a checkout in progress is resumed), repeated, key_conflict,
-- not_due, deadline_passed, unavailable, invalid, not_found, unauthorized. The API then asks
-- the provider and reports back with fee_checkout_started or fee_checkout_refused.
CREATE FUNCTION trucker.fee_checkout_open(p_booking uuid, p_key text, p_provider text,
                                          OUT status text, OUT detail jsonb)
RETURNS record
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
DECLARE
  actor uuid := trucker.request_person();
  org uuid := trucker.request_organisation();
  hash text := trucker.content_hash(jsonb_build_object('booking', p_booking, 'provider', p_provider));
  b trucker.booking;
  f trucker.booking_fee;
  c trucker.fee_checkout;
  n integer;
  t timestamptz;
BEGIN
  IF actor IS NULL THEN
    status := 'unauthorized';
    RETURN;
  END IF;
  IF org IS NULL OR NOT trucker.is_admin(org) THEN
    status := 'not_found';
    RETURN;
  END IF;
  IF p_key IS NULL OR p_key !~ '^[A-Za-z0-9._-]{16,128}$' THEN
    status := 'invalid';
    detail := jsonb_build_array(jsonb_build_object('field', 'retryKey', 'code', 'invalid'));
    RETURN;
  END IF;
  -- Only the one who pays opens a checkout.
  SELECT * INTO f FROM trucker.booking_fee x WHERE x.booking_id = p_booking AND x.payer_organisation_id = org;
  IF NOT FOUND THEN
    status := 'not_found';
    RETURN;
  END IF;
  IF p_provider IS NULL OR p_provider NOT IN ('test') THEN
    status := 'unavailable';
    RETURN;
  END IF;
  SELECT * INTO c FROM trucker.fee_checkout x WHERE x.requested_by = actor AND x.request_key = p_key;
  IF FOUND THEN
    status := CASE WHEN c.request_hash = hash THEN 'repeated' ELSE 'key_conflict' END;
    detail := CASE WHEN status = 'repeated' THEN trucker.fee_checkout_values(c) END;
    RETURN;
  END IF;
  SELECT * INTO b FROM trucker.booking x WHERE x.id = p_booking;
  n := trucker.booking_lock_set(b);
  t := trucker.clock_now();
  IF trucker.request_person() IS DISTINCT FROM actor OR NOT trucker.is_admin(org) THEN
    status := 'unauthorized';
    RETURN;
  END IF;
  PERFORM trucker.fee_lapse_if_due(b, n, t);
  SELECT * INTO f FROM trucker.booking_fee x WHERE x.booking_id = b.id FOR UPDATE;
  IF f.status <> 'due' THEN
    status := 'not_due';
    detail := jsonb_build_object('feeStatus', f.status);
    RETURN;
  END IF;
  -- A checkout in progress is resumed, never doubled (R-13).
  SELECT * INTO c FROM trucker.fee_checkout x
  WHERE x.booking_id = b.id AND x.status IN ('opening', 'open') AND x.expires_at > t FOR UPDATE;
  IF FOUND THEN
    status := 'existing';
    detail := trucker.fee_checkout_values(c);
    RETURN;
  END IF;
  IF f.due_at <= t THEN
    status := 'deadline_passed';
    RETURN;
  END IF;
  -- One whose time ran out is closed here; if the provider was paid on it, its word still counts.
  UPDATE trucker.fee_checkout x SET status = 'expired', closed_at = t, row_version = row_version + 1
  WHERE x.booking_id = b.id AND x.status IN ('opening', 'open') AND x.expires_at <= t;
  BEGIN
    INSERT INTO trucker.fee_checkout
      (booking_id, provider, currency_code, minor_units, amount, status, requested_by, organisation_id, request_key,
       request_hash, created_at, expires_at)
    SELECT b.id, p_provider, f.currency_code, f.minor_units, f.amount, 'opening', actor, org, p_key, hash, t,
           least(t + make_interval(mins => g.checkout_minutes), f.due_at)
    FROM trucker.security_setting g
    RETURNING * INTO c;
  EXCEPTION WHEN unique_violation THEN
    SELECT * INTO c FROM trucker.fee_checkout x WHERE x.requested_by = actor AND x.request_key = p_key;
    status := CASE WHEN c.request_hash = hash THEN 'repeated' ELSE 'key_conflict' END;
    detail := CASE WHEN status = 'repeated' THEN trucker.fee_checkout_values(c) END;
    RETURN;
  END;
  status := 'created';
  detail := trucker.fee_checkout_values(c);
END
$$;

-- The provider has the checkout: its reference and where the payer goes.
CREATE FUNCTION trucker.fee_checkout_started(p_checkout uuid, p_provider_reference text, p_url text,
                                             OUT status text, OUT detail jsonb)
RETURNS record
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
DECLARE
  actor uuid := trucker.request_person();
  c trucker.fee_checkout;
BEGIN
  SELECT * INTO c FROM trucker.fee_checkout x WHERE x.id = p_checkout AND x.requested_by = actor FOR UPDATE;
  IF actor IS NULL OR NOT FOUND THEN
    status := 'not_found';
    RETURN;
  END IF;
  IF p_provider_reference IS NULL OR p_provider_reference !~ '^[A-Za-z0-9_.:-]{1,200}$'
     OR char_length(coalesce(p_url, '')) > 2000 THEN
    status := 'invalid';
    RETURN;
  END IF;
  IF c.status = 'opening' THEN
    UPDATE trucker.fee_checkout x SET status = 'open', provider_reference = p_provider_reference,
                                      checkout_url = p_url, row_version = row_version + 1
    WHERE x.id = c.id RETURNING * INTO c;
  ELSIF c.provider_reference IS DISTINCT FROM p_provider_reference THEN
    status := 'conflict';
    RETURN;
  END IF;
  status := 'ok';
  detail := trucker.fee_checkout_values(c);
END
$$;

-- The provider refused to open it: the payer may ask again.
CREATE FUNCTION trucker.fee_checkout_refused(p_checkout uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
DECLARE
  actor uuid := trucker.request_person();
BEGIN
  UPDATE trucker.fee_checkout x SET status = 'failed', closed_at = trucker.clock_now(), row_version = row_version + 1
  WHERE x.id = p_checkout AND x.requested_by = actor AND x.status = 'opening';
  RETURN CASE WHEN FOUND THEN 'failed' ELSE 'unchanged' END;
END
$$;

-- Checkouts whose time ran out with no word from the provider: the API asks the provider.
CREATE FUNCTION trucker.fee_checkouts_to_check() RETURNS TABLE (provider text, provider_reference text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
  SELECT c.provider, c.provider_reference FROM trucker.fee_checkout c
  WHERE c.status = 'open' AND c.expires_at <= trucker.clock_now()
  ORDER BY c.expires_at, c.id LIMIT 50
$$;

-- ---------------------------------------------------------------------------------------------
-- What a provider said, signed (checked by the API) or answered to a status check
-- ---------------------------------------------------------------------------------------------
-- p_content: {"status": "paid" | "failed" | "expired", "providerReference", "transactionId",
-- "amount", "currency", "paidAt"}. Status: recorded or repeated (detail: the result), or
-- invalid (nothing stored).
CREATE FUNCTION trucker.payment_report(p_provider text, p_notification_id text, p_kind text, p_content jsonb,
                                       OUT status text, OUT detail jsonb)
RETURNS record
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
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
      UPDATE trucker.fee_checkout x SET status = v_status, closed_at = t, row_version = row_version + 1
      WHERE x.id = c.id;
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
        UPDATE trucker.fee_checkout x SET status = 'failed', closed_at = t, row_version = row_version + 1
        WHERE x.id = c.id;
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
$$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA trucker FROM PUBLIC;
GRANT EXECUTE ON FUNCTION trucker.fee_checkout_open(uuid, text, text) TO trucker_app;
GRANT EXECUTE ON FUNCTION trucker.fee_checkout_started(uuid, text, text) TO trucker_app;
GRANT EXECUTE ON FUNCTION trucker.fee_checkout_refused(uuid) TO trucker_app;
GRANT EXECUTE ON FUNCTION trucker.fee_checkouts_to_check() TO trucker_app;
GRANT EXECUTE ON FUNCTION trucker.payment_report(text, text, text, jsonb) TO trucker_app;
