-- Refunds of Trucker's fee, and reconciliation (slice 28; ADR-001 D-8, G-11, R-11, R-15).
--
-- Money owed back (fee_refund, from slices 26 and 27) is paid back through refund requests. A
-- request is requested by one administrator and approved by another; it is then submitted
-- (to the payment provider, or as a bank transfer made by staff) and ends completed or failed.
-- A request may be for part of what is owed; the requests that have not failed or been
-- withdrawn never add up to more than the payment, which the database checks under a lock on
-- the payment. A provider is asked with the request's own identifier as its idempotency key, so
-- a retry after a lost answer reaches the same refund. Reconciliation records what Trucker's
-- bank statement or the provider's report shows for each payment and refund, by someone who
-- had no hand in it; a correction is a new entry that replaces the earlier one, which stays.
-- Nothing recorded is changed or removed. Development defaults are in
-- docs/delivery/REFUNDS_SLICE_28.md. No real provider exists; no money moves.

-- ---------------------------------------------------------------------------------------------
-- Refund requests
-- ---------------------------------------------------------------------------------------------
CREATE TABLE trucker.refund_request (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  refund_id uuid NOT NULL REFERENCES trucker.fee_refund (id),
  payment_id uuid NOT NULL REFERENCES trucker.fee_payment (id),
  -- provider: back through the payment provider (online payments only); bank_transfer: a
  -- transfer made by staff outside Trucker and recorded here.
  method text NOT NULL CHECK (method IN ('provider', 'bank_transfer')),
  currency_code text NOT NULL REFERENCES trucker.currency (code),
  minor_units integer NOT NULL,
  amount numeric NOT NULL CHECK (amount > 0),
  status text NOT NULL CHECK (status IN ('requested', 'approved', 'submitted', 'completed', 'failed', 'withdrawn')),
  note text NOT NULL CHECK (char_length(note) BETWEEN 1 AND 1000),
  requested_by uuid NOT NULL REFERENCES trucker.staff_account (id),
  requested_at timestamptz NOT NULL,
  request_key text NOT NULL UNIQUE,
  request_hash text NOT NULL,
  approved_by uuid REFERENCES trucker.staff_account (id),
  approved_at timestamptz,
  submitted_by uuid REFERENCES trucker.staff_account (id),
  submitted_at timestamptz,
  bank_reference text CHECK (bank_reference IS NULL OR char_length(bank_reference) BETWEEN 1 AND 100),
  provider_refund_reference text CHECK (provider_refund_reference IS NULL
                                        OR provider_refund_reference ~ '^[A-Za-z0-9_.:-]{1,200}$'),
  completed_by uuid REFERENCES trucker.staff_account (id),
  completed_at timestamptz,
  statement_reference text CHECK (statement_reference IS NULL OR char_length(statement_reference) BETWEEN 1 AND 100),
  failed_at timestamptz,
  failure_reason text CHECK (failure_reason IS NULL OR char_length(failure_reason) BETWEEN 1 AND 1000),
  withdrawn_by uuid REFERENCES trucker.staff_account (id),
  withdrawn_at timestamptz,
  withdrawal_note text CHECK (withdrawal_note IS NULL OR char_length(withdrawal_note) BETWEEN 1 AND 1000),
  row_version integer NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  -- Approval is independent of the request (D-8).
  CONSTRAINT refund_request_second_person CHECK (approved_by IS NULL OR approved_by <> requested_by),
  -- A bank refund is confirmed on the statement by someone other than the one who sent it.
  CONSTRAINT refund_request_completion_person CHECK (completed_by IS NULL OR completed_by <> submitted_by),
  CONSTRAINT refund_request_approved CHECK (
    (status IN ('approved', 'submitted', 'completed', 'failed')) <= (approved_by IS NOT NULL AND approved_at IS NOT NULL)),
  CONSTRAINT refund_request_submitted CHECK (
    (status IN ('submitted', 'completed', 'failed')) = (submitted_at IS NOT NULL)),
  CONSTRAINT refund_request_completed CHECK ((status = 'completed') = (completed_at IS NOT NULL)),
  CONSTRAINT refund_request_failed CHECK ((status = 'failed') = (failed_at IS NOT NULL AND failure_reason IS NOT NULL)),
  CONSTRAINT refund_request_withdrawn CHECK (
    (status = 'withdrawn') = (withdrawn_at IS NOT NULL AND withdrawn_by IS NOT NULL AND withdrawal_note IS NOT NULL)),
  CONSTRAINT refund_request_bank CHECK (
    method <> 'bank_transfer'
    OR ((status NOT IN ('submitted', 'completed', 'failed') OR (bank_reference IS NOT NULL AND submitted_by IS NOT NULL))
        AND (status <> 'completed' OR (completed_by IS NOT NULL AND statement_reference IS NOT NULL)))),
  CONSTRAINT refund_request_provider CHECK (method <> 'provider' OR (completed_by IS NULL AND bank_reference IS NULL))
);
ALTER TABLE trucker.refund_request ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON trucker.refund_request FROM PUBLIC, trucker_app;
CREATE INDEX refund_request_payment ON trucker.refund_request (payment_id, status);

CREATE FUNCTION trucker.guard_refund_request() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, trucker, pg_temp AS $$
BEGIN
  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'a refund request is never removed' USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW.id, NEW.refund_id, NEW.payment_id, NEW.method, NEW.currency_code, NEW.minor_units, NEW.amount, NEW.note,
      NEW.requested_by, NEW.requested_at, NEW.request_key, NEW.request_hash)
     IS NOT DISTINCT FROM
     (OLD.id, OLD.refund_id, OLD.payment_id, OLD.method, OLD.currency_code, OLD.minor_units, OLD.amount, OLD.note,
      OLD.requested_by, OLD.requested_at, OLD.request_key, OLD.request_hash)
     AND NEW.row_version = OLD.row_version + 1
     -- What was recorded at an earlier step stays as it was.
     AND (OLD.approved_at IS NULL OR (NEW.approved_by, NEW.approved_at) IS NOT DISTINCT FROM (OLD.approved_by, OLD.approved_at))
     AND (OLD.submitted_at IS NULL
          OR (NEW.submitted_by, NEW.submitted_at, NEW.bank_reference)
             IS NOT DISTINCT FROM (OLD.submitted_by, OLD.submitted_at, OLD.bank_reference))
     AND (OLD.provider_refund_reference IS NULL OR NEW.provider_refund_reference = OLD.provider_refund_reference)
     AND ((OLD.status = 'requested' AND NEW.status IN ('approved', 'withdrawn'))
          OR (OLD.status = 'approved' AND NEW.status IN ('submitted', 'withdrawn'))
          OR (OLD.status = 'submitted' AND NEW.status IN ('submitted', 'completed', 'failed'))) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'a refund request only moves forward, and what it recorded stays' USING ERRCODE = 'check_violation';
END
$$;
CREATE TRIGGER refund_request_guard BEFORE UPDATE OR DELETE ON trucker.refund_request
  FOR EACH ROW EXECUTE FUNCTION trucker.guard_refund_request();
CREATE TRIGGER refund_request_truncate_guard BEFORE TRUNCATE ON trucker.refund_request
  FOR EACH STATEMENT EXECUTE FUNCTION trucker.guard_refund_request();

-- Never more than the payment, nor than what is owed, however the rows are written.
CREATE FUNCTION trucker.refund_request_within_payment() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
DECLARE
  p trucker.fee_payment;
  r trucker.fee_refund;
  v_total numeric;
BEGIN
  SELECT * INTO p FROM trucker.fee_payment x WHERE x.id = NEW.payment_id FOR UPDATE;
  SELECT * INTO r FROM trucker.fee_refund x WHERE x.id = NEW.refund_id;
  IF r.payment_id IS DISTINCT FROM NEW.payment_id OR NEW.currency_code <> p.currency_code
     OR NEW.minor_units <> p.minor_units OR (NEW.method = 'provider' AND p.method <> 'online') THEN
    RAISE EXCEPTION 'a refund request belongs to its payment' USING ERRCODE = 'check_violation';
  END IF;
  SELECT coalesce(sum(x.amount), 0) INTO v_total FROM trucker.refund_request x
  WHERE x.payment_id = NEW.payment_id AND x.status NOT IN ('failed', 'withdrawn');
  IF v_total > p.amount OR v_total > r.amount THEN
    RAISE EXCEPTION 'refunds would exceed the payment' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER refund_request_total AFTER INSERT OR UPDATE ON trucker.refund_request
  FOR EACH ROW EXECUTE FUNCTION trucker.refund_request_within_payment();

-- Every step, as it happened. Never changed.
CREATE TABLE trucker.refund_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The order steps were taken in; several can share one instant.
  seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  refund_request_id uuid NOT NULL REFERENCES trucker.refund_request (id),
  occurred_at timestamptz NOT NULL,
  actor_staff_id uuid REFERENCES trucker.staff_account (id),
  event text NOT NULL CHECK (event IN ('requested', 'approved', 'withdrawn', 'submitted', 'resubmitted',
                                       'provider_answered', 'completed', 'failed')),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb
);
ALTER TABLE trucker.refund_event ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON trucker.refund_event FROM PUBLIC, trucker_app;
CREATE INDEX refund_event_request ON trucker.refund_event (refund_request_id, seq);
CREATE TRIGGER refund_event_guard BEFORE UPDATE OR DELETE ON trucker.refund_event
  FOR EACH ROW EXECUTE FUNCTION trucker.guard_fee_refund();
CREATE TRIGGER refund_event_truncate_guard BEFORE TRUNCATE ON trucker.refund_event
  FOR EACH STATEMENT EXECUTE FUNCTION trucker.guard_fee_refund();

CREATE FUNCTION trucker.refund_event_add(p_request uuid, p_at timestamptz, p_staff uuid, p_event text, p_detail jsonb)
RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
  INSERT INTO trucker.refund_event (refund_request_id, occurred_at, actor_staff_id, event, detail)
  VALUES (p_request, p_at, p_staff, p_event, coalesce(p_detail, '{}'::jsonb))
$$;

-- ---------------------------------------------------------------------------------------------
-- Reconciliation
-- ---------------------------------------------------------------------------------------------
-- What Trucker's bank statement or the provider's report shows for a payment or a completed
-- refund. Matched when the amount and currency agree; otherwise a discrepancy, with a note.
-- A correction is a new entry naming the one it replaces; the replaced one stays.
CREATE TABLE trucker.reconciliation_entry (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_type text NOT NULL CHECK (subject_type IN ('payment', 'refund')),
  payment_id uuid REFERENCES trucker.fee_payment (id),
  refund_request_id uuid REFERENCES trucker.refund_request (id),
  source text NOT NULL CHECK (source IN ('bank_statement', 'provider_report')),
  source_reference text NOT NULL CHECK (char_length(source_reference) BETWEEN 1 AND 200),
  currency_code text NOT NULL,
  amount numeric NOT NULL CHECK (amount >= 0),
  outcome text NOT NULL CHECK (outcome IN ('matched', 'discrepancy')),
  note text CHECK (note IS NULL OR char_length(note) BETWEEN 1 AND 1000),
  supersedes uuid UNIQUE REFERENCES trucker.reconciliation_entry (id),
  reconciled_by uuid NOT NULL REFERENCES trucker.staff_account (id),
  reconciled_at timestamptz NOT NULL,
  entry_key text NOT NULL UNIQUE,
  entry_hash text NOT NULL,
  CONSTRAINT reconciliation_subject CHECK (
    (subject_type = 'payment') = (payment_id IS NOT NULL) AND (subject_type = 'refund') = (refund_request_id IS NOT NULL)),
  CONSTRAINT reconciliation_note CHECK ((outcome = 'matched' AND supersedes IS NULL) OR note IS NOT NULL)
);
ALTER TABLE trucker.reconciliation_entry ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON trucker.reconciliation_entry FROM PUBLIC, trucker_app;
CREATE TRIGGER reconciliation_entry_guard BEFORE UPDATE OR DELETE ON trucker.reconciliation_entry
  FOR EACH ROW EXECUTE FUNCTION trucker.guard_fee_refund();
CREATE TRIGGER reconciliation_entry_truncate_guard BEFORE TRUNCATE ON trucker.reconciliation_entry
  FOR EACH STATEMENT EXECUTE FUNCTION trucker.guard_fee_refund();

-- The entry in force for a subject: the one no later entry replaces.
CREATE FUNCTION trucker.reconciliation_current(p_type text, p_subject uuid) RETURNS trucker.reconciliation_entry
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
  SELECT e.* FROM trucker.reconciliation_entry e
  WHERE e.subject_type = p_type AND coalesce(e.payment_id, e.refund_request_id) = p_subject
    AND NOT EXISTS (SELECT 1 FROM trucker.reconciliation_entry z WHERE z.supersedes = e.id)
$$;

-- ---------------------------------------------------------------------------------------------
-- What is shown
-- ---------------------------------------------------------------------------------------------
-- Money owed back, with how far it has been paid back. The payer sees this.
CREATE OR REPLACE FUNCTION trucker.fee_refund_values(r trucker.fee_refund) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
  SELECT jsonb_build_object('id', r.id, 'bookingId', r.booking_id, 'paymentId', r.payment_id, 'reason', r.reason,
                            'amount', trucker.amount_text(r.amount, r.minor_units), 'currency', r.currency_code,
                            'status', CASE WHEN x.done >= r.amount THEN 'refunded'
                                           WHEN x.done > 0 THEN 'partly_refunded'
                                           WHEN x.open > 0 THEN 'in_progress'
                                           ELSE 'pending' END,
                            'refunded', trucker.amount_text(x.done, r.minor_units),
                            'inProgress', trucker.amount_text(x.open, r.minor_units),
                            'remaining', trucker.amount_text(r.amount - x.done - x.open, r.minor_units),
                            'recordedAt', r.recorded_at)
  FROM (SELECT coalesce(sum(q.amount) FILTER (WHERE q.status = 'completed'), 0) AS done,
               coalesce(sum(q.amount) FILTER (WHERE q.status IN ('requested', 'approved', 'submitted')), 0) AS open
        FROM trucker.refund_request q WHERE q.refund_id = r.id) x
$$;

CREATE FUNCTION trucker.refund_request_values(q trucker.refund_request) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
  SELECT jsonb_build_object(
    'id', q.id, 'version', q.row_version, 'refundId', q.refund_id, 'paymentId', q.payment_id, 'method', q.method,
    'amount', trucker.amount_text(q.amount, q.minor_units), 'currency', q.currency_code, 'status', q.status,
    'note', q.note, 'bookingId', (SELECT r.booking_id FROM trucker.fee_refund r WHERE r.id = q.refund_id),
    'reference', (SELECT f.reference FROM trucker.fee_refund r JOIN trucker.booking_fee f ON f.booking_id = r.booking_id
                  WHERE r.id = q.refund_id),
    'requestedBy', (SELECT jsonb_build_object('id', a.id, 'displayName', a.display_name)
                    FROM trucker.staff_account a WHERE a.id = q.requested_by),
    'requestedAt', q.requested_at,
    'approvedBy', (SELECT jsonb_build_object('id', a.id, 'displayName', a.display_name)
                   FROM trucker.staff_account a WHERE a.id = q.approved_by),
    'approvedAt', q.approved_at,
    'submittedBy', (SELECT jsonb_build_object('id', a.id, 'displayName', a.display_name)
                    FROM trucker.staff_account a WHERE a.id = q.submitted_by),
    'submittedAt', q.submitted_at, 'bankReference', q.bank_reference,
    'providerRefundReference', q.provider_refund_reference,
    'completedBy', (SELECT jsonb_build_object('id', a.id, 'displayName', a.display_name)
                    FROM trucker.staff_account a WHERE a.id = q.completed_by),
    'completedAt', q.completed_at, 'statementReference', q.statement_reference,
    'failedAt', q.failed_at, 'failureReason', q.failure_reason,
    'withdrawnAt', q.withdrawn_at, 'withdrawalNote', q.withdrawal_note,
    'reconciliation', (SELECT jsonb_build_object('outcome', e.outcome, 'at', e.reconciled_at)
                       FROM trucker.reconciliation_current('refund', q.id) e WHERE e.id IS NOT NULL),
    'history', coalesce((SELECT jsonb_agg(jsonb_build_object(
                                   'event', v.event, 'at', v.occurred_at, 'detail', v.detail,
                                   'by', (SELECT jsonb_build_object('id', a.id, 'displayName', a.display_name)
                                          FROM trucker.staff_account a WHERE a.id = v.actor_staff_id))
                                          ORDER BY v.seq)
                         FROM trucker.refund_event v WHERE v.refund_request_id = q.id), '[]'::jsonb))
$$;

CREATE FUNCTION trucker.reconciliation_values(e trucker.reconciliation_entry) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
  SELECT jsonb_build_object(
    'id', e.id, 'subjectType', e.subject_type, 'subjectId', coalesce(e.payment_id, e.refund_request_id),
    'source', e.source, 'sourceReference', e.source_reference, 'amount', e.amount::text, 'currency', e.currency_code,
    'outcome', e.outcome, 'note', e.note, 'supersedes', e.supersedes,
    'expectedAmount', coalesce((SELECT trucker.amount_text(p.amount, p.minor_units) || ' ' || p.currency_code FROM trucker.fee_payment p WHERE p.id = e.payment_id),
                               (SELECT trucker.amount_text(q.amount, q.minor_units) || ' ' || q.currency_code FROM trucker.refund_request q
                                WHERE q.id = e.refund_request_id)),
    'reference', (SELECT f.reference FROM trucker.booking_fee f
                  WHERE f.booking_id = coalesce((SELECT p.booking_id FROM trucker.fee_payment p WHERE p.id = e.payment_id),
                                                (SELECT r.booking_id FROM trucker.refund_request q
                                                 JOIN trucker.fee_refund r ON r.id = q.refund_id
                                                 WHERE q.id = e.refund_request_id))),
    'reconciledBy', (SELECT jsonb_build_object('id', a.id, 'displayName', a.display_name)
                     FROM trucker.staff_account a WHERE a.id = e.reconciled_by),
    'reconciledAt', e.reconciled_at)
$$;

CREATE FUNCTION trucker.staff_refunds(p_token_hash text, p_request_id text, OUT status text, OUT detail jsonb)
RETURNS record
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
DECLARE
  e record;
BEGIN
  SELECT * INTO e FROM trucker.staff_enter(p_token_hash, 'staff_admin', 'staff.refund.view', NULL, p_request_id);
  status := e.status;
  IF status <> 'ok' THEN
    RETURN;
  END IF;
  PERFORM trucker.staff_audit(e.at, e.staff_id, 'staff.refund.view', 'done', NULL, p_request_id, '{}'::jsonb);
  detail := jsonb_build_object(
    'staffId', e.staff_id,
    -- Money owed back with something left to request, oldest first.
    'owed', coalesce((
      SELECT jsonb_agg(x.item ORDER BY x.recorded_at, x.id) FROM (
        SELECT r.recorded_at, r.id, trucker.fee_refund_values(r) || jsonb_build_object(
                 'method', p.method,
                 'reference', (SELECT f.reference FROM trucker.booking_fee f WHERE f.booking_id = r.booking_id)) AS item
        FROM trucker.fee_refund r JOIN trucker.fee_payment p ON p.id = r.payment_id
        WHERE r.amount > (SELECT coalesce(sum(q.amount), 0) FROM trucker.refund_request q
                          WHERE q.refund_id = r.id AND q.status NOT IN ('failed', 'withdrawn'))
        ORDER BY r.recorded_at, r.id LIMIT 200) x), '[]'::jsonb),
    'open', coalesce((
      SELECT jsonb_agg(trucker.refund_request_values(q) ORDER BY q.requested_at, q.id)
      FROM trucker.refund_request q WHERE q.status IN ('requested', 'approved', 'submitted')), '[]'::jsonb),
    'ended', coalesce((
      SELECT jsonb_agg(x.item ORDER BY x.at DESC, x.id) FROM (
        SELECT coalesce(q.completed_at, q.failed_at, q.withdrawn_at) AS at, q.id, trucker.refund_request_values(q) AS item
        FROM trucker.refund_request q WHERE q.status IN ('completed', 'failed', 'withdrawn')
        ORDER BY coalesce(q.completed_at, q.failed_at, q.withdrawn_at) DESC, q.id LIMIT 50) x), '[]'::jsonb),
    -- Settled or returned payments and completed refunds with no reconciliation yet.
    'toReconcile', jsonb_build_object(
      'payments', coalesce((
        SELECT jsonb_agg(x.item ORDER BY x.decided_at, x.id) FROM (
          SELECT p.decided_at, p.id, trucker.fee_payment_values(p) AS item
          FROM trucker.fee_payment p
          WHERE p.status = 'approved' AND (trucker.reconciliation_current('payment', p.id)).id IS NULL
          ORDER BY p.decided_at, p.id LIMIT 200) x), '[]'::jsonb),
      'refunds', coalesce((
        SELECT jsonb_agg(x.item ORDER BY x.completed_at, x.id) FROM (
          SELECT q.completed_at, q.id, trucker.refund_request_values(q) AS item
          FROM trucker.refund_request q
          WHERE q.status = 'completed' AND (trucker.reconciliation_current('refund', q.id)).id IS NULL
          ORDER BY q.completed_at, q.id LIMIT 200) x), '[]'::jsonb)),
    'discrepancies', coalesce((
      SELECT jsonb_agg(trucker.reconciliation_values(r) ORDER BY r.reconciled_at, r.id)
      FROM trucker.reconciliation_entry r
      WHERE r.outcome = 'discrepancy'
        AND NOT EXISTS (SELECT 1 FROM trucker.reconciliation_entry z WHERE z.supersedes = r.id)), '[]'::jsonb));
END
$$;

-- ---------------------------------------------------------------------------------------------
-- Request, approve or withdraw
-- ---------------------------------------------------------------------------------------------
-- p_content: {"refundId", "amount", "method": "provider" | "bank_transfer", "note"}. The amount
-- may be part of what is owed (a partial refund); the requests that are not failed or withdrawn
-- never add up to more than the payment.
CREATE FUNCTION trucker.staff_refund_request(p_token_hash text, p_key text, p_content jsonb, p_request_id text,
                                             OUT status text, OUT detail jsonb)
RETURNS record
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
DECLARE
  e record;
  hash text := trucker.content_hash(coalesce(p_content, '{}'::jsonb));
  q trucker.refund_request;
  r trucker.fee_refund;
  p trucker.fee_payment;
  t timestamptz;
  problems jsonb := '[]'::jsonb;
  v_amount numeric;
  v_method text := p_content ->> 'method';
  v_note text := btrim(coalesce(p_content ->> 'note', ''));
  v_left numeric;
BEGIN
  SELECT * INTO e FROM trucker.staff_enter(p_token_hash, 'staff_admin', 'staff.refund.request', NULL, p_request_id);
  status := e.status;
  IF status <> 'ok' THEN
    RETURN;
  END IF;
  IF p_key IS NULL OR p_key !~ '^[A-Za-z0-9._-]{16,128}$' THEN
    status := 'invalid';
    detail := jsonb_build_array(jsonb_build_object('field', 'retryKey', 'code', 'invalid'));
    RETURN;
  END IF;
  SELECT * INTO q FROM trucker.refund_request x WHERE x.request_key = p_key;
  IF FOUND THEN
    status := CASE WHEN q.requested_by = e.staff_id AND q.request_hash = hash THEN 'repeated' ELSE 'key_conflict' END;
    detail := CASE WHEN status = 'repeated' THEN trucker.refund_request_values(q) END;
    RETURN;
  END IF;
  IF coalesce(p_content ->> 'refundId', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    problems := problems || jsonb_build_object('field', 'refundId', 'code', 'unknown');
  ELSE
    SELECT * INTO r FROM trucker.fee_refund x WHERE x.id = (p_content ->> 'refundId')::uuid;
    IF NOT FOUND THEN
      problems := problems || jsonb_build_object('field', 'refundId', 'code', 'unknown');
    END IF;
  END IF;
  IF jsonb_typeof(p_content -> 'amount') IS DISTINCT FROM 'string'
     OR (p_content ->> 'amount') !~ '^[0-9]{1,12}(\.[0-9]{1,3})?$' OR (p_content ->> 'amount')::numeric <= 0 THEN
    problems := problems || jsonb_build_object('field', 'amount', 'code', 'invalid');
  ELSE
    v_amount := (p_content ->> 'amount')::numeric;
  END IF;
  IF v_method IS NULL OR v_method NOT IN ('provider', 'bank_transfer') THEN
    problems := problems || jsonb_build_object('field', 'method', 'code', 'invalid');
  END IF;
  IF char_length(v_note) NOT BETWEEN 1 AND 1000 THEN
    problems := problems || jsonb_build_object('field', 'note', 'code', 'required');
  END IF;
  IF jsonb_array_length(problems) > 0 THEN
    status := 'invalid';
    detail := problems;
    RETURN;
  END IF;
  -- The payment's lock orders every request against it.
  SELECT * INTO p FROM trucker.fee_payment x WHERE x.id = r.payment_id FOR UPDATE;
  t := trucker.clock_now();
  SELECT r.amount - coalesce(sum(x.amount), 0) INTO v_left FROM trucker.refund_request x
  WHERE x.refund_id = r.id AND x.status NOT IN ('failed', 'withdrawn');
  IF scale(v_amount) > r.minor_units THEN
    problems := problems || jsonb_build_object('field', 'amount', 'code', 'invalid');
  ELSIF v_amount > v_left THEN
    problems := problems || jsonb_build_object('field', 'amount', 'code', 'exceeds_owed',
                                               'remaining', trucker.amount_text(v_left, r.minor_units));
  END IF;
  IF v_method = 'provider' AND p.method <> 'online' THEN
    problems := problems || jsonb_build_object('field', 'method', 'code', 'not_online');
  END IF;
  IF jsonb_array_length(problems) > 0 THEN
    status := 'invalid';
    detail := problems;
    RETURN;
  END IF;
  BEGIN
    INSERT INTO trucker.refund_request
      (refund_id, payment_id, method, currency_code, minor_units, amount, status, note, requested_by, requested_at,
       request_key, request_hash)
    VALUES (r.id, p.id, v_method, r.currency_code, r.minor_units, v_amount, 'requested', v_note, e.staff_id, t,
            p_key, hash)
    RETURNING * INTO q;
  EXCEPTION WHEN unique_violation THEN
    SELECT * INTO q FROM trucker.refund_request x WHERE x.request_key = p_key;
    status := CASE WHEN q.requested_by = e.staff_id AND q.request_hash = hash THEN 'repeated' ELSE 'key_conflict' END;
    detail := CASE WHEN status = 'repeated' THEN trucker.refund_request_values(q) END;
    RETURN;
  END;
  PERFORM trucker.refund_event_add(q.id, t, e.staff_id, 'requested',
                                   jsonb_build_object('amount', trucker.amount_text(q.amount, q.minor_units),
                                                      'method', q.method, 'partial', q.amount < r.amount));
  PERFORM trucker.staff_audit(t, e.staff_id, 'staff.refund.requested', 'done', NULL, p_request_id,
                              jsonb_build_object('refundRequest', q.id, 'refund', r.id));
  status := 'requested';
  detail := trucker.refund_request_values(q);
END
$$;

-- p_decision: approve (by someone other than the one who asked) or withdraw (a correction,
-- with its reason; the request stays as a record).
CREATE FUNCTION trucker.staff_refund_decide(p_token_hash text, p_request uuid, p_expected_version integer,
                                            p_decision text, p_note text, p_request_id text,
                                            OUT status text, OUT detail jsonb)
RETURNS record
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
DECLARE
  e record;
  q trucker.refund_request;
  t timestamptz;
  v_note text := nullif(btrim(p_note), '');
BEGIN
  SELECT * INTO e FROM trucker.staff_enter(p_token_hash, 'staff_admin', 'staff.refund.decide', NULL, p_request_id);
  status := e.status;
  IF status <> 'ok' THEN
    RETURN;
  END IF;
  SELECT * INTO q FROM trucker.refund_request x WHERE x.id = p_request;
  IF NOT FOUND THEN
    status := 'not_found';
    RETURN;
  END IF;
  IF p_decision IS NULL OR p_decision NOT IN ('approve', 'withdraw') OR char_length(coalesce(v_note, '')) > 1000
     OR (p_decision = 'withdraw' AND v_note IS NULL) THEN
    status := 'invalid';
    detail := jsonb_build_array(jsonb_build_object(
      'field', CASE WHEN p_decision IN ('approve', 'withdraw') THEN 'note' ELSE 'decision' END,
      'code', CASE WHEN p_decision = 'withdraw' AND v_note IS NULL THEN 'required' ELSE 'invalid' END));
    RETURN;
  END IF;
  PERFORM 1 FROM trucker.fee_payment x WHERE x.id = q.payment_id FOR UPDATE;
  SELECT * INTO q FROM trucker.refund_request x WHERE x.id = p_request FOR UPDATE;
  t := trucker.clock_now();
  IF p_expected_version IS DISTINCT FROM q.row_version THEN
    status := CASE WHEN (p_decision = 'approve' AND q.status <> 'requested')
                        OR (p_decision = 'withdraw' AND q.status NOT IN ('requested', 'approved'))
                   THEN 'not_open' ELSE 'conflict' END;
    detail := trucker.refund_request_values(q);
    RETURN;
  END IF;
  IF p_decision = 'approve' THEN
    IF q.status <> 'requested' THEN
      status := 'not_open';
      detail := trucker.refund_request_values(q);
      RETURN;
    END IF;
    IF q.requested_by = e.staff_id THEN
      PERFORM trucker.staff_audit(t, e.staff_id, 'staff.refund.decide', 'refused', NULL, p_request_id,
                                  jsonb_build_object('reason', 'same_person', 'refundRequest', q.id));
      status := 'same_person';
      RETURN;
    END IF;
    UPDATE trucker.refund_request x SET status = 'approved', approved_by = e.staff_id, approved_at = t,
                                        row_version = row_version + 1
    WHERE x.id = q.id RETURNING * INTO q;
    PERFORM trucker.refund_event_add(q.id, t, e.staff_id, 'approved',
                                     CASE WHEN v_note IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('note', v_note) END);
    status := 'approved';
  ELSE
    IF q.status NOT IN ('requested', 'approved') THEN
      status := 'not_open';
      detail := trucker.refund_request_values(q);
      RETURN;
    END IF;
    UPDATE trucker.refund_request x SET status = 'withdrawn', withdrawn_by = e.staff_id, withdrawn_at = t,
                                        withdrawal_note = v_note, row_version = row_version + 1
    WHERE x.id = q.id RETURNING * INTO q;
    PERFORM trucker.refund_event_add(q.id, t, e.staff_id, 'withdrawn', jsonb_build_object('note', v_note));
    status := 'withdrawn';
  END IF;
  PERFORM trucker.staff_audit(t, e.staff_id, 'staff.refund.decided', 'done', NULL, p_request_id,
                              jsonb_build_object('refundRequest', q.id, 'decision', p_decision));
  detail := trucker.refund_request_values(q);
END
$$;

-- ---------------------------------------------------------------------------------------------
-- Submit, and the outcome
-- ---------------------------------------------------------------------------------------------
-- Provider refunds: the request is marked submitted before the provider is asked, so a lost
-- answer leaves it submitted and the retry asks the provider again with the same identifier.
-- Status: submitted, or already_submitted (the API may ask again); detail carries what the
-- provider needs. Bank refunds: p_bank_reference is the transfer staff made.
CREATE FUNCTION trucker.staff_refund_submit(p_token_hash text, p_request uuid, p_expected_version integer,
                                            p_bank_reference text, p_request_id text,
                                            OUT status text, OUT detail jsonb)
RETURNS record
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
DECLARE
  e record;
  q trucker.refund_request;
  t timestamptz;
  v_bank text := nullif(btrim(p_bank_reference), '');
BEGIN
  SELECT * INTO e FROM trucker.staff_enter(p_token_hash, 'staff_admin', 'staff.refund.submit', NULL, p_request_id);
  status := e.status;
  IF status <> 'ok' THEN
    RETURN;
  END IF;
  SELECT * INTO q FROM trucker.refund_request x WHERE x.id = p_request;
  IF NOT FOUND THEN
    status := 'not_found';
    RETURN;
  END IF;
  PERFORM 1 FROM trucker.fee_payment x WHERE x.id = q.payment_id FOR UPDATE;
  SELECT * INTO q FROM trucker.refund_request x WHERE x.id = p_request FOR UPDATE;
  t := trucker.clock_now();
  IF q.status = 'submitted' AND q.method = 'provider' THEN
    PERFORM trucker.refund_event_add(q.id, t, e.staff_id, 'resubmitted', '{}'::jsonb);
    status := 'already_submitted';
  ELSIF q.status <> 'approved' THEN
    status := 'not_open';
    detail := jsonb_build_object('refund', trucker.refund_request_values(q));
    RETURN;
  ELSIF p_expected_version IS DISTINCT FROM q.row_version THEN
    status := 'conflict';
    RETURN;
  ELSIF q.method = 'bank_transfer' AND (v_bank IS NULL OR char_length(v_bank) > 100) THEN
    status := 'invalid';
    detail := jsonb_build_array(jsonb_build_object('field', 'bankReference', 'code', 'required'));
    RETURN;
  ELSE
    UPDATE trucker.refund_request x SET status = 'submitted', submitted_by = e.staff_id, submitted_at = t,
                                        bank_reference = CASE WHEN q.method = 'bank_transfer' THEN v_bank END,
                                        row_version = row_version + 1
    WHERE x.id = q.id RETURNING * INTO q;
    PERFORM trucker.refund_event_add(q.id, t, e.staff_id, 'submitted',
                                     CASE WHEN v_bank IS NULL OR q.method <> 'bank_transfer' THEN '{}'::jsonb
                                          ELSE jsonb_build_object('bankReference', v_bank) END);
    status := 'submitted';
  END IF;
  PERFORM trucker.staff_audit(t, e.staff_id, 'staff.refund.submitted', 'done', NULL, p_request_id,
                              jsonb_build_object('refundRequest', q.id, 'repeat', status = 'already_submitted'));
  detail := jsonb_build_object('refund', trucker.refund_request_values(q), 'provider', trucker.refund_provider_details(q));
END
$$;

-- What the provider needs to refund an online payment.
CREATE FUNCTION trucker.refund_provider_details(q trucker.refund_request) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
  SELECT CASE WHEN q.method = 'provider' THEN jsonb_build_object(
           'refundId', q.id, 'provider', c.provider, 'providerReference', c.provider_reference,
           'transactionId', substr(p.statement_reference, char_length('online:' || c.provider || ':') + 1),
           'amount', trucker.amount_text(q.amount, q.minor_units), 'currency', q.currency_code) END
  FROM trucker.fee_payment p LEFT JOIN trucker.fee_checkout c ON c.id = p.checkout_id
  WHERE p.id = q.payment_id
$$;

-- What the provider answered about a refund: succeeded, failed, or still pending.
CREATE FUNCTION trucker.refund_provider_report(p_request uuid, p_content jsonb, OUT status text, OUT detail jsonb)
RETURNS record
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
DECLARE
  q trucker.refund_request;
  t timestamptz;
  v_status text := p_content ->> 'status';
  v_ref text := p_content ->> 'providerRefundReference';
  v_reason text := left(btrim(coalesce(p_content ->> 'reason', '')), 1000);
BEGIN
  IF v_status IS NULL OR v_status NOT IN ('pending', 'succeeded', 'failed')
     OR v_ref IS NULL OR v_ref !~ '^[A-Za-z0-9_.:-]{1,200}$' THEN
    status := 'invalid';
    RETURN;
  END IF;
  SELECT * INTO q FROM trucker.refund_request x WHERE x.id = p_request AND x.method = 'provider';
  IF NOT FOUND THEN
    status := 'not_found';
    RETURN;
  END IF;
  PERFORM 1 FROM trucker.fee_payment x WHERE x.id = q.payment_id FOR UPDATE;
  SELECT * INTO q FROM trucker.refund_request x WHERE x.id = p_request FOR UPDATE;
  t := trucker.clock_now();
  IF q.status IN ('completed', 'failed') THEN
    -- Already settled. A different answer now is shown, never applied.
    status := CASE WHEN (q.status = 'completed') = (v_status = 'succeeded') OR v_status = 'pending'
                   THEN 'repeated' ELSE 'contradicted' END;
    IF status = 'contradicted' THEN
      PERFORM trucker.refund_event_add(q.id, t, NULL, 'provider_answered',
                                       jsonb_build_object('status', v_status, 'reference', v_ref, 'applied', false));
    END IF;
    detail := trucker.refund_request_values(q);
    RETURN;
  END IF;
  IF q.status <> 'submitted' OR (q.provider_refund_reference IS NOT NULL AND q.provider_refund_reference <> v_ref) THEN
    status := 'not_open';
    detail := trucker.refund_request_values(q);
    RETURN;
  END IF;
  IF v_status = 'pending' THEN
    IF q.provider_refund_reference IS NULL THEN
      UPDATE trucker.refund_request x SET provider_refund_reference = v_ref, row_version = row_version + 1
      WHERE x.id = q.id RETURNING * INTO q;
      PERFORM trucker.refund_event_add(q.id, t, NULL, 'provider_answered',
                                       jsonb_build_object('status', 'pending', 'reference', v_ref));
    END IF;
    status := 'pending';
  ELSIF v_status = 'succeeded' THEN
    UPDATE trucker.refund_request x SET status = 'completed', completed_at = t, provider_refund_reference = v_ref,
                                        row_version = row_version + 1
    WHERE x.id = q.id RETURNING * INTO q;
    PERFORM trucker.refund_event_add(q.id, t, NULL, 'completed', jsonb_build_object('reference', v_ref));
    status := 'completed';
  ELSE
    UPDATE trucker.refund_request x SET status = 'failed', failed_at = t, provider_refund_reference = v_ref,
                                        failure_reason = coalesce(nullif(v_reason, ''), 'refused by the provider'),
                                        row_version = row_version + 1
    WHERE x.id = q.id RETURNING * INTO q;
    PERFORM trucker.refund_event_add(q.id, t, NULL, 'failed', jsonb_build_object('reference', v_ref,
                                                                                 'reason', q.failure_reason));
    status := 'failed';
  END IF;
  detail := trucker.refund_request_values(q);
END
$$;

-- Provider refunds submitted a while ago with no final answer: the API asks the provider.
CREATE FUNCTION trucker.refunds_to_check() RETURNS SETOF jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
  SELECT trucker.refund_provider_details(q) FROM trucker.refund_request q
  WHERE q.status = 'submitted' AND q.method = 'provider' AND q.submitted_at <= trucker.clock_now() - interval '1 minute'
  ORDER BY q.submitted_at, q.id LIMIT 50
$$;

-- A bank refund's outcome, recorded by someone other than the one who sent it: completed when
-- the transfer is on Trucker's bank statement, failed when it came back.
CREATE FUNCTION trucker.staff_refund_outcome(p_token_hash text, p_request uuid, p_expected_version integer,
                                             p_outcome text, p_statement_reference text, p_note text,
                                             p_request_id text, OUT status text, OUT detail jsonb)
RETURNS record
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
DECLARE
  e record;
  q trucker.refund_request;
  t timestamptz;
  v_line text := nullif(btrim(p_statement_reference), '');
  v_note text := nullif(btrim(p_note), '');
BEGIN
  SELECT * INTO e FROM trucker.staff_enter(p_token_hash, 'staff_admin', 'staff.refund.outcome', NULL, p_request_id);
  status := e.status;
  IF status <> 'ok' THEN
    RETURN;
  END IF;
  SELECT * INTO q FROM trucker.refund_request x WHERE x.id = p_request AND x.method = 'bank_transfer';
  IF NOT FOUND THEN
    status := 'not_found';
    RETURN;
  END IF;
  IF p_outcome IS NULL OR p_outcome NOT IN ('completed', 'failed')
     OR (p_outcome = 'completed' AND (v_line IS NULL OR char_length(v_line) > 100))
     OR (p_outcome = 'failed' AND (v_note IS NULL OR char_length(v_note) > 1000)) THEN
    status := 'invalid';
    detail := jsonb_build_array(jsonb_build_object(
      'field', CASE WHEN p_outcome = 'completed' THEN 'statementReference' WHEN p_outcome = 'failed' THEN 'note'
                    ELSE 'outcome' END,
      'code', CASE WHEN p_outcome IN ('completed', 'failed') THEN 'required' ELSE 'invalid' END));
    RETURN;
  END IF;
  PERFORM 1 FROM trucker.fee_payment x WHERE x.id = q.payment_id FOR UPDATE;
  SELECT * INTO q FROM trucker.refund_request x WHERE x.id = p_request FOR UPDATE;
  t := trucker.clock_now();
  IF q.status <> 'submitted' THEN
    status := 'not_open';
    detail := trucker.refund_request_values(q);
    RETURN;
  END IF;
  IF p_expected_version IS DISTINCT FROM q.row_version THEN
    status := 'conflict';
    RETURN;
  END IF;
  IF q.submitted_by = e.staff_id THEN
    PERFORM trucker.staff_audit(t, e.staff_id, 'staff.refund.outcome', 'refused', NULL, p_request_id,
                                jsonb_build_object('reason', 'same_person', 'refundRequest', q.id));
    status := 'same_person';
    RETURN;
  END IF;
  IF p_outcome = 'completed' THEN
    UPDATE trucker.refund_request x SET status = 'completed', completed_by = e.staff_id, completed_at = t,
                                        statement_reference = v_line, row_version = row_version + 1
    WHERE x.id = q.id RETURNING * INTO q;
    PERFORM trucker.refund_event_add(q.id, t, e.staff_id, 'completed', jsonb_build_object('statementReference', v_line));
  ELSE
    UPDATE trucker.refund_request x SET status = 'failed', failed_at = t, failure_reason = v_note,
                                        row_version = row_version + 1
    WHERE x.id = q.id RETURNING * INTO q;
    PERFORM trucker.refund_event_add(q.id, t, e.staff_id, 'failed', jsonb_build_object('reason', v_note));
  END IF;
  PERFORM trucker.staff_audit(t, e.staff_id, 'staff.refund.outcome', 'done', NULL, p_request_id,
                              jsonb_build_object('refundRequest', q.id, 'outcome', p_outcome));
  status := p_outcome;
  detail := trucker.refund_request_values(q);
END
$$;

-- ---------------------------------------------------------------------------------------------
-- Reconcile
-- ---------------------------------------------------------------------------------------------
-- p_content: {"subjectType": "payment" | "refund", "subjectId", "source", "sourceReference",
-- "amount", "currency", "note"?, "supersedes"?}. Recorded by someone who had no hand in the
-- payment or the refund. The outcome is worked out, not chosen: matched when the amount and the
-- currency agree. An entry in force can only be replaced by naming it, with a note.
CREATE FUNCTION trucker.staff_reconcile(p_token_hash text, p_key text, p_content jsonb, p_request_id text,
                                        OUT status text, OUT detail jsonb)
RETURNS record
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
DECLARE
  e record;
  hash text := trucker.content_hash(coalesce(p_content, '{}'::jsonb));
  x trucker.reconciliation_entry;
  cur trucker.reconciliation_entry;
  p trucker.fee_payment;
  q trucker.refund_request;
  t timestamptz;
  problems jsonb := '[]'::jsonb;
  v_type text := p_content ->> 'subjectType';
  v_subject uuid;
  v_amount numeric;
  v_note text := nullif(btrim(coalesce(p_content ->> 'note', '')), '');
  v_ref text := btrim(coalesce(p_content ->> 'sourceReference', ''));
  v_supersedes uuid;
  v_people uuid[];
  v_expected numeric;
  v_currency text;
  v_outcome text;
BEGIN
  SELECT * INTO e FROM trucker.staff_enter(p_token_hash, 'staff_admin', 'staff.reconcile', NULL, p_request_id);
  status := e.status;
  IF status <> 'ok' THEN
    RETURN;
  END IF;
  IF p_key IS NULL OR p_key !~ '^[A-Za-z0-9._-]{16,128}$' THEN
    status := 'invalid';
    detail := jsonb_build_array(jsonb_build_object('field', 'retryKey', 'code', 'invalid'));
    RETURN;
  END IF;
  SELECT * INTO x FROM trucker.reconciliation_entry z WHERE z.entry_key = p_key;
  IF FOUND THEN
    status := CASE WHEN x.reconciled_by = e.staff_id AND x.entry_hash = hash THEN 'repeated' ELSE 'key_conflict' END;
    detail := CASE WHEN status = 'repeated' THEN trucker.reconciliation_values(x) END;
    RETURN;
  END IF;
  IF v_type IS NULL OR v_type NOT IN ('payment', 'refund')
     OR coalesce(p_content ->> 'subjectId', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    problems := problems || jsonb_build_object('field', 'subjectId', 'code', 'unknown');
  ELSE
    v_subject := (p_content ->> 'subjectId')::uuid;
  END IF;
  IF coalesce(p_content ->> 'source', '') NOT IN ('bank_statement', 'provider_report') THEN
    problems := problems || jsonb_build_object('field', 'source', 'code', 'invalid');
  END IF;
  IF char_length(v_ref) NOT BETWEEN 1 AND 200 THEN
    problems := problems || jsonb_build_object('field', 'sourceReference', 'code', 'required');
  END IF;
  IF jsonb_typeof(p_content -> 'amount') IS DISTINCT FROM 'string'
     OR (p_content ->> 'amount') !~ '^[0-9]{1,12}(\.[0-9]{1,3})?$' THEN
    problems := problems || jsonb_build_object('field', 'amount', 'code', 'invalid');
  ELSE
    v_amount := (p_content ->> 'amount')::numeric;
  END IF;
  IF coalesce(p_content ->> 'currency', '') !~ '^[A-Z]{3}$' THEN
    problems := problems || jsonb_build_object('field', 'currency', 'code', 'invalid');
  END IF;
  IF char_length(coalesce(v_note, '')) > 1000 THEN
    problems := problems || jsonb_build_object('field', 'note', 'code', 'invalid');
  END IF;
  IF p_content ? 'supersedes' AND jsonb_typeof(p_content -> 'supersedes') <> 'null' THEN
    IF coalesce(p_content ->> 'supersedes', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      problems := problems || jsonb_build_object('field', 'supersedes', 'code', 'invalid');
    ELSE
      v_supersedes := (p_content ->> 'supersedes')::uuid;
    END IF;
  END IF;
  IF jsonb_array_length(problems) > 0 THEN
    status := 'invalid';
    detail := problems;
    RETURN;
  END IF;
  IF v_type = 'payment' THEN
    SELECT * INTO p FROM trucker.fee_payment z WHERE z.id = v_subject AND z.status = 'approved' FOR UPDATE;
    IF NOT FOUND THEN
      status := 'not_found';
      RETURN;
    END IF;
    v_people := ARRAY[p.recorded_by, p.decided_by];
    v_expected := p.amount;
    v_currency := p.currency_code;
  ELSE
    SELECT * INTO q FROM trucker.refund_request z WHERE z.id = v_subject AND z.status = 'completed';
    IF NOT FOUND THEN
      status := 'not_found';
      RETURN;
    END IF;
    PERFORM 1 FROM trucker.fee_payment z WHERE z.id = q.payment_id FOR UPDATE;
    v_people := ARRAY[q.requested_by, q.approved_by, q.submitted_by, q.completed_by];
    v_expected := q.amount;
    v_currency := q.currency_code;
  END IF;
  t := trucker.clock_now();
  -- Independent: no one reconciles what they recorded, approved, submitted or confirmed.
  IF e.staff_id = ANY (v_people) THEN
    PERFORM trucker.staff_audit(t, e.staff_id, 'staff.reconcile', 'refused', NULL, p_request_id,
                                jsonb_build_object('reason', 'not_independent', 'subject', v_subject));
    status := 'not_independent';
    RETURN;
  END IF;
  cur := trucker.reconciliation_current(v_type, v_subject);
  IF cur.id IS NOT NULL AND v_supersedes IS DISTINCT FROM cur.id THEN
    status := 'already_reconciled';
    detail := trucker.reconciliation_values(cur);
    RETURN;
  END IF;
  IF cur.id IS NULL AND v_supersedes IS NOT NULL THEN
    status := 'invalid';
    detail := jsonb_build_array(jsonb_build_object('field', 'supersedes', 'code', 'invalid'));
    RETURN;
  END IF;
  v_outcome := CASE WHEN v_amount = v_expected AND p_content ->> 'currency' = v_currency THEN 'matched'
                    ELSE 'discrepancy' END;
  IF (v_outcome = 'discrepancy' OR v_supersedes IS NOT NULL) AND v_note IS NULL THEN
    status := 'invalid';
    detail := jsonb_build_array(jsonb_build_object('field', 'note', 'code', 'required', 'outcome', v_outcome));
    RETURN;
  END IF;
  BEGIN
    INSERT INTO trucker.reconciliation_entry
      (subject_type, payment_id, refund_request_id, source, source_reference, currency_code, amount, outcome, note,
       supersedes, reconciled_by, reconciled_at, entry_key, entry_hash)
    VALUES (v_type, CASE WHEN v_type = 'payment' THEN v_subject END, CASE WHEN v_type = 'refund' THEN v_subject END,
            p_content ->> 'source', v_ref, p_content ->> 'currency', v_amount, v_outcome, v_note, v_supersedes,
            e.staff_id, t, p_key, hash)
    RETURNING * INTO x;
  EXCEPTION WHEN unique_violation THEN
    SELECT * INTO x FROM trucker.reconciliation_entry z WHERE z.entry_key = p_key;
    IF FOUND THEN
      status := CASE WHEN x.reconciled_by = e.staff_id AND x.entry_hash = hash THEN 'repeated' ELSE 'key_conflict' END;
      detail := CASE WHEN status = 'repeated' THEN trucker.reconciliation_values(x) END;
    ELSE
      status := 'already_reconciled';
    END IF;
    RETURN;
  END;
  PERFORM trucker.staff_audit(t, e.staff_id, 'staff.reconciled', 'done', NULL, p_request_id,
                              jsonb_build_object('entry', x.id, 'subject', v_subject, 'outcome', v_outcome,
                                                 'supersedes', v_supersedes));
  status := 'recorded';
  detail := trucker.reconciliation_values(x);
END
$$;

-- The fee payments page lists money owed back that is not yet paid back.
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
      FROM trucker.fee_refund r
      -- Owed and not yet fully paid back (slice 28).
      WHERE r.amount > (SELECT coalesce(sum(q.amount), 0) FROM trucker.refund_request q
                        WHERE q.refund_id = r.id AND q.status = 'completed')), '[]'::jsonb));
END
$function$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA trucker FROM PUBLIC;
GRANT EXECUTE ON FUNCTION trucker.staff_refunds(text, text) TO trucker_app;
GRANT EXECUTE ON FUNCTION trucker.staff_refund_request(text, text, jsonb, text) TO trucker_app;
GRANT EXECUTE ON FUNCTION trucker.staff_refund_decide(text, uuid, integer, text, text, text) TO trucker_app;
GRANT EXECUTE ON FUNCTION trucker.staff_refund_submit(text, uuid, integer, text, text) TO trucker_app;
GRANT EXECUTE ON FUNCTION trucker.staff_refund_outcome(text, uuid, integer, text, text, text, text) TO trucker_app;
GRANT EXECUTE ON FUNCTION trucker.staff_reconcile(text, text, jsonb, text) TO trucker_app;
GRANT EXECUTE ON FUNCTION trucker.refund_provider_report(uuid, jsonb) TO trucker_app;
GRANT EXECUTE ON FUNCTION trucker.refunds_to_check() TO trucker_app;
