-- Trucker's fee before confirmation (slice 26; ADR-001 R-10 to R-15, G-8, G-9, G-11, D-6 to D-8).
--
-- Every booking now carries a fee obligation. The payer quotes a reference and pays by bank
-- transfer. One staff member matches the money on Trucker's bank statement to the reference and
-- records it; a second approves. A slip or a payer's word is never proof (R-12). A booking is
-- confirmed only when both the fee is verified and every required resource is assigned, eligible
-- and reserved (R-14): whichever comes second confirms it, under the locks the assignment and
-- cancellation commands take. A fee not paid by its deadline lapses the booking as a recorded
-- cancellation (D-7). Money that arrives for a lapsed or cancelled booking, money paid twice, and
-- the fee of a booking cancelled after payment become refund records (G-11, D-8). Processing
-- refunds is slice 28.
--
-- Development defaults recorded in docs/delivery/FEE_PAYMENT_SLICE_26.md: the 12 hours of D-6
-- live in the financial settings; a receipt recorded by the deadline holds the lapse until the
-- second staff member decides; only an exact match is recorded against a fee that is due.

-- ---------------------------------------------------------------------------------------------
-- Settings: the hours the payer has (D-6), approved with the other financial settings
-- ---------------------------------------------------------------------------------------------
ALTER TABLE trucker.financial_setting_version
  ADD COLUMN fee_payment_hours integer NOT NULL DEFAULT 12
    CONSTRAINT financial_setting_fee_payment_hours CHECK (fee_payment_hours BETWEEN 1 AND 168);
ALTER TABLE trucker.financial_setting_version ALTER COLUMN fee_payment_hours DROP DEFAULT;

CREATE OR REPLACE FUNCTION trucker.guard_financial_setting()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'trucker', 'pg_temp'
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.development_default AND (SELECT e.kind FROM trucker.environment e) = 'production' THEN
      RAISE EXCEPTION 'a development default is never added to a production database' USING ERRCODE = 'check_violation';
    END IF;
    IF NOT NEW.development_default AND NEW.status <> 'draft' THEN
      RAISE EXCEPTION 'a financial setting version is written as a draft' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'a financial setting version is never changed or removed' USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW.id, NEW.version_no, NEW.development_default, NEW.fee_method, NEW.fee_basis_points, NEW.fee_rounding,
      NEW.commission_options, NEW.commission_max_basis_points, NEW.commission_settlement_max_days,
      NEW.freight_due_days, NEW.fee_payment_hours, NEW.note, NEW.effective_from, NEW.draft_key, NEW.draft_hash, NEW.drafted_by,
      NEW.drafted_at)
     IS DISTINCT FROM
     (OLD.id, OLD.version_no, OLD.development_default, OLD.fee_method, OLD.fee_basis_points, OLD.fee_rounding,
      OLD.commission_options, OLD.commission_max_basis_points, OLD.commission_settlement_max_days,
      OLD.freight_due_days, OLD.fee_payment_hours, OLD.note, OLD.effective_from, OLD.draft_key, OLD.draft_hash, OLD.drafted_by,
      OLD.drafted_at)
     OR NOT ((OLD.status = 'draft' AND NEW.status IN ('approved', 'discarded'))
             OR (OLD.status = 'approved' AND NEW.status = 'withdrawn'
                 AND NEW.effective_at = OLD.effective_at AND NEW.approved_by IS NOT DISTINCT FROM OLD.approved_by
                 AND NEW.approved_at IS NOT DISTINCT FROM OLD.approved_at
                 AND trucker.clock_now() < OLD.effective_at)) THEN
    RAISE EXCEPTION 'a financial setting version is never changed or removed' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION trucker.financial_setting_values(v trucker.financial_setting_version, p_at timestamp with time zone)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'trucker', 'pg_temp'
AS $function$
  SELECT jsonb_build_object(
    'id', v.id, 'versionNo', v.version_no, 'version', v.row_version, 'status', v.status,
    'state', CASE WHEN v.status <> 'approved' THEN v.status
                  WHEN v.id = (trucker.financial_settings_at(p_at)).id THEN 'in_force'
                  WHEN v.effective_at > p_at THEN 'scheduled'
                  ELSE 'superseded' END,
    'developmentDefault', v.development_default,
    'feeMethod', v.fee_method, 'feeBasisPoints', v.fee_basis_points, 'feeRounding', v.fee_rounding,
    'commissionOptions', to_jsonb(v.commission_options),
    'commissionMaxBasisPoints', v.commission_max_basis_points,
    'commissionSettlementMaxDays', v.commission_settlement_max_days,
    'freightDueDays', v.freight_due_days,
    'feePaymentHours', v.fee_payment_hours,
    'note', v.note,
    'effectiveFrom', v.effective_from,
    'effectiveAt', CASE WHEN v.effective_at = '-infinity' THEN NULL ELSE v.effective_at END,
    'draftedBy', (SELECT jsonb_build_object('id', a.id, 'displayName', a.display_name)
                  FROM trucker.staff_account a WHERE a.id = v.drafted_by),
    'draftedAt', v.drafted_at,
    'approvedBy', (SELECT jsonb_build_object('id', a.id, 'displayName', a.display_name)
                   FROM trucker.staff_account a WHERE a.id = v.approved_by),
    'approvedAt', v.approved_at,
    'closedBy', (SELECT jsonb_build_object('id', a.id, 'displayName', a.display_name)
                 FROM trucker.staff_account a WHERE a.id = v.closed_by),
    'closedAt', v.closed_at)
$function$;

CREATE OR REPLACE FUNCTION trucker.financial_setting_problems(p_content jsonb, p_at timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'trucker', 'pg_temp'
AS $function$
DECLARE
  problems jsonb := '[]'::jsonb;
  field text;
  bounds integer[];
  v_from timestamptz;
BEGIN
  FOR field, bounds IN
    SELECT * FROM (VALUES ('feeBasisPoints', ARRAY[0, 5000]), ('commissionMaxBasisPoints', ARRAY[1, 5000]),
                          ('commissionSettlementMaxDays', ARRAY[1, 365]), ('freightDueDays', ARRAY[0, 365]),
                          ('feePaymentHours', ARRAY[1, 168])) f
  LOOP
    IF jsonb_typeof(p_content -> field) IS DISTINCT FROM 'number'
       OR (p_content ->> field) !~ '^[0-9]{1,4}$'
       OR (p_content ->> field)::integer NOT BETWEEN bounds[1] AND bounds[2] THEN
      problems := problems || jsonb_build_object('field', field, 'code', 'out_of_range');
    END IF;
  END LOOP;
  IF jsonb_typeof(p_content -> 'commissionOptions') IS DISTINCT FROM 'array'
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(p_content -> 'commissionOptions') e
                WHERE jsonb_typeof(e) <> 'string' OR e #>> '{}' NOT IN ('percentage', 'fixed', 'contract'))
     OR (SELECT count(*) <> count(DISTINCT e) FROM jsonb_array_elements(p_content -> 'commissionOptions') e) THEN
    problems := problems || jsonb_build_object('field', 'commissionOptions', 'code', 'invalid');
  END IF;
  IF jsonb_typeof(p_content -> 'note') IS DISTINCT FROM 'string'
     OR char_length(btrim(p_content ->> 'note')) NOT BETWEEN 1 AND 1000 THEN
    problems := problems || jsonb_build_object('field', 'note', 'code', 'required');
  END IF;
  IF jsonb_typeof(p_content -> 'effectiveFrom') = 'string' THEN
    IF (p_content ->> 'effectiveFrom') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(:[0-9]{2}(\.[0-9]{1,6})?)?(Z|[+-][0-9]{2}:[0-9]{2})$' THEN
      problems := problems || jsonb_build_object('field', 'effectiveFrom', 'code', 'invalid');
    ELSE
      BEGIN
        v_from := (p_content ->> 'effectiveFrom')::timestamptz;
        IF v_from <= p_at THEN
          problems := problems || jsonb_build_object('field', 'effectiveFrom', 'code', 'passed');
        END IF;
      EXCEPTION WHEN OTHERS THEN
        problems := problems || jsonb_build_object('field', 'effectiveFrom', 'code', 'invalid');
      END;
    END IF;
  ELSIF p_content ? 'effectiveFrom' AND jsonb_typeof(p_content -> 'effectiveFrom') <> 'null' THEN
    problems := problems || jsonb_build_object('field', 'effectiveFrom', 'code', 'invalid');
  END IF;
  RETURN problems;
END
$function$;

CREATE OR REPLACE FUNCTION trucker.staff_financial_draft(p_token_hash text, p_key text, p_content jsonb, p_request_id text, OUT status text, OUT detail jsonb)
 RETURNS record
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'trucker', 'pg_temp'
AS $function$
#variable_conflict use_column
DECLARE
  entered record;
  v trucker.financial_setting_version;
  hash text := trucker.content_hash(coalesce(p_content, '{}'::jsonb));
  problems jsonb;
BEGIN
  SELECT * INTO entered FROM trucker.staff_enter(p_token_hash, 'staff_admin', 'staff.financial_setting.draft', NULL, p_request_id);
  status := entered.status;
  IF status <> 'ok' THEN
    RETURN;
  END IF;
  IF p_key IS NULL OR p_key !~ '^[A-Za-z0-9._-]{16,128}$' THEN
    status := 'invalid';
    detail := jsonb_build_array(jsonb_build_object('field', 'retryKey', 'code', 'invalid'));
    RETURN;
  END IF;
  SELECT * INTO v FROM trucker.financial_setting_version x WHERE x.draft_key = p_key;
  IF FOUND THEN
    status := CASE WHEN v.drafted_by = entered.staff_id AND v.draft_hash = hash THEN 'repeated' ELSE 'key_conflict' END;
    detail := CASE WHEN status = 'repeated' THEN trucker.financial_setting_values(v, entered.at) END;
    RETURN;
  END IF;
  problems := trucker.financial_setting_problems(coalesce(p_content, '{}'::jsonb), entered.at);
  IF jsonb_array_length(problems) > 0 THEN
    status := 'invalid';
    detail := problems;
    RETURN;
  END IF;
  BEGIN
    INSERT INTO trucker.financial_setting_version
      (status, fee_basis_points, commission_options, commission_max_basis_points, commission_settlement_max_days,
       freight_due_days, fee_payment_hours, note, effective_from, draft_key, draft_hash, drafted_by, drafted_at)
    VALUES ('draft', (p_content ->> 'feeBasisPoints')::integer,
            ARRAY(SELECT e FROM jsonb_array_elements_text(p_content -> 'commissionOptions') e
                  ORDER BY array_position(ARRAY['percentage', 'fixed', 'contract'], e)),
            (p_content ->> 'commissionMaxBasisPoints')::integer, (p_content ->> 'commissionSettlementMaxDays')::integer,
            (p_content ->> 'freightDueDays')::integer, (p_content ->> 'feePaymentHours')::integer,
            btrim(p_content ->> 'note'),
            CASE WHEN jsonb_typeof(p_content -> 'effectiveFrom') = 'string'
                 THEN (p_content ->> 'effectiveFrom')::timestamptz END,
            p_key, hash, entered.staff_id, entered.at)
    RETURNING * INTO v;
  EXCEPTION WHEN unique_violation THEN
    SELECT * INTO v FROM trucker.financial_setting_version x WHERE x.draft_key = p_key;
    status := CASE WHEN v.drafted_by = entered.staff_id AND v.draft_hash = hash THEN 'repeated' ELSE 'key_conflict' END;
    detail := CASE WHEN status = 'repeated' THEN trucker.financial_setting_values(v, entered.at) END;
    RETURN;
  END;
  PERFORM trucker.staff_audit(entered.at, entered.staff_id, 'staff.financial_setting.drafted', 'done', NULL, p_request_id,
                              jsonb_build_object('versionId', v.id, 'versionNo', v.version_no));
  status := 'drafted';
  detail := trucker.financial_setting_values(v, entered.at);
END
$function$;

-- ---------------------------------------------------------------------------------------------
-- The fee obligation of each booking
-- ---------------------------------------------------------------------------------------------
-- status: due, then paid (verified in time), lapsed (not paid by the deadline) or closed (the
-- booking was cancelled first). not_required: nothing was due, or the booking predates this.
CREATE TABLE trucker.booking_fee (
  booking_id uuid PRIMARY KEY REFERENCES trucker.booking (id),
  status text NOT NULL CHECK (status IN ('due', 'paid', 'lapsed', 'closed', 'not_required')),
  basis text NOT NULL CHECK (basis IN ('due', 'nothing_due', 'before_fee_payment')),
  payer text CHECK (payer IN ('customer', 'organiser', 'carrier')),
  payer_organisation_id uuid REFERENCES trucker.organisation (id),
  currency_code text NOT NULL REFERENCES trucker.currency (code),
  minor_units integer NOT NULL,
  amount numeric NOT NULL CHECK (amount >= 0),
  -- What the payer quotes on the transfer. Ten hexadecimal digits drawn at random.
  reference text UNIQUE CHECK (reference ~ '^TF-[0-9A-F]{10}$'),
  payment_hours integer,
  due_at timestamptz,
  paid_at timestamptz,
  payment_id uuid,
  ended_at timestamptz,
  created_at timestamptz NOT NULL,
  row_version integer NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  CONSTRAINT booking_fee_shape CHECK (
    (basis = 'due' AND amount > 0 AND payer IS NOT NULL AND payer_organisation_id IS NOT NULL
     AND reference IS NOT NULL AND payment_hours IS NOT NULL AND due_at IS NOT NULL
     AND status IN ('due', 'paid', 'lapsed', 'closed'))
    OR (basis <> 'due' AND status = 'not_required' AND reference IS NULL AND due_at IS NULL)),
  CONSTRAINT booking_fee_paid CHECK ((status = 'paid') = (paid_at IS NOT NULL AND payment_id IS NOT NULL)),
  CONSTRAINT booking_fee_ended CHECK ((status IN ('lapsed', 'closed')) = (ended_at IS NOT NULL))
);
ALTER TABLE trucker.booking_fee ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON trucker.booking_fee FROM PUBLIC, trucker_app;
CREATE INDEX booking_fee_due ON trucker.booking_fee (due_at, booking_id) WHERE status = 'due';

-- A receipt of money on Trucker's bank statement, recorded by one administrator and approved or
-- rejected by another. Online payments join this in slice 27.
CREATE TABLE trucker.fee_payment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id uuid NOT NULL REFERENCES trucker.booking_fee (booking_id),
  method text NOT NULL CHECK (method IN ('bank_transfer')),
  currency_code text NOT NULL REFERENCES trucker.currency (code),
  minor_units integer NOT NULL,
  amount numeric NOT NULL CHECK (amount > 0),
  value_date date NOT NULL,
  statement_reference text NOT NULL CHECK (char_length(statement_reference) BETWEEN 1 AND 100
                                           AND statement_reference = btrim(statement_reference)),
  note text CHECK (note IS NULL OR char_length(note) BETWEEN 1 AND 1000),
  status text NOT NULL CHECK (status IN ('recorded', 'approved', 'rejected')),
  -- On approval: whether it settled the fee, or is money to return.
  outcome text CHECK (outcome IN ('settled', 'refund_due')),
  recorded_by uuid NOT NULL REFERENCES trucker.staff_account (id),
  recorded_at timestamptz NOT NULL,
  record_key text NOT NULL UNIQUE,
  record_hash text NOT NULL,
  decided_by uuid REFERENCES trucker.staff_account (id),
  decided_at timestamptz,
  decision_note text CHECK (decision_note IS NULL OR char_length(decision_note) BETWEEN 1 AND 1000),
  row_version integer NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  CONSTRAINT fee_payment_decided CHECK ((status = 'recorded') = (decided_by IS NULL AND decided_at IS NULL)),
  CONSTRAINT fee_payment_outcome CHECK ((status = 'approved') = (outcome IS NOT NULL)),
  CONSTRAINT fee_payment_rejection CHECK (status <> 'rejected' OR decision_note IS NOT NULL),
  CONSTRAINT fee_payment_second_person CHECK (decided_by IS NULL OR decided_by <> recorded_by)
);
ALTER TABLE trucker.fee_payment ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON trucker.fee_payment FROM PUBLIC, trucker_app;
-- A line of the bank statement is matched once. A rejected record frees it.
CREATE UNIQUE INDEX fee_payment_statement_line ON trucker.fee_payment (statement_reference)
  WHERE status <> 'rejected';
CREATE INDEX fee_payment_booking ON trucker.fee_payment (booking_id, recorded_at);
ALTER TABLE trucker.booking_fee
  ADD CONSTRAINT booking_fee_payment FOREIGN KEY (payment_id) REFERENCES trucker.fee_payment (id);

-- Money to return. Approval and payment of refunds come in slice 28 (D-8).
CREATE TABLE trucker.fee_refund (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id uuid NOT NULL REFERENCES trucker.booking_fee (booking_id),
  payment_id uuid NOT NULL UNIQUE REFERENCES trucker.fee_payment (id),
  reason text NOT NULL CHECK (reason IN ('booking_ended', 'duplicate_payment', 'cancelled_after_payment')),
  currency_code text NOT NULL REFERENCES trucker.currency (code),
  minor_units integer NOT NULL,
  amount numeric NOT NULL CHECK (amount > 0),
  status text NOT NULL CHECK (status IN ('pending')),
  recorded_at timestamptz NOT NULL
);
ALTER TABLE trucker.fee_refund ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON trucker.fee_refund FROM PUBLIC, trucker_app;

CREATE FUNCTION trucker.guard_booking_fee() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, trucker, pg_temp AS $$
BEGIN
  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'a fee obligation is never removed' USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW.booking_id, NEW.basis, NEW.payer, NEW.payer_organisation_id, NEW.currency_code, NEW.minor_units,
          NEW.amount, NEW.reference, NEW.payment_hours, NEW.due_at, NEW.created_at)
         IS NOT DISTINCT FROM
         (OLD.booking_id, OLD.basis, OLD.payer, OLD.payer_organisation_id, OLD.currency_code, OLD.minor_units,
          OLD.amount, OLD.reference, OLD.payment_hours, OLD.due_at, OLD.created_at)
     AND OLD.status = 'due' AND NEW.status IN ('paid', 'lapsed', 'closed')
     AND NEW.row_version = OLD.row_version + 1 THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'a fee obligation only moves from due to paid, lapsed or closed'
    USING ERRCODE = 'check_violation';
END
$$;
CREATE TRIGGER booking_fee_guard BEFORE UPDATE OR DELETE ON trucker.booking_fee
  FOR EACH ROW EXECUTE FUNCTION trucker.guard_booking_fee();
CREATE TRIGGER booking_fee_truncate_guard BEFORE TRUNCATE ON trucker.booking_fee
  FOR EACH STATEMENT EXECUTE FUNCTION trucker.guard_booking_fee();

CREATE FUNCTION trucker.guard_fee_payment() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, trucker, pg_temp AS $$
BEGIN
  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'a recorded receipt is never removed' USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW.id, NEW.booking_id, NEW.method, NEW.currency_code, NEW.minor_units, NEW.amount, NEW.value_date,
          NEW.statement_reference, NEW.note, NEW.recorded_by, NEW.recorded_at, NEW.record_key, NEW.record_hash)
         IS NOT DISTINCT FROM
         (OLD.id, OLD.booking_id, OLD.method, OLD.currency_code, OLD.minor_units, OLD.amount, OLD.value_date,
          OLD.statement_reference, OLD.note, OLD.recorded_by, OLD.recorded_at, OLD.record_key, OLD.record_hash)
     AND OLD.status = 'recorded' AND NEW.status IN ('approved', 'rejected')
     AND NEW.row_version = OLD.row_version + 1 THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'a recorded receipt is only approved or rejected, once' USING ERRCODE = 'check_violation';
END
$$;
CREATE TRIGGER fee_payment_guard BEFORE UPDATE OR DELETE ON trucker.fee_payment
  FOR EACH ROW EXECUTE FUNCTION trucker.guard_fee_payment();
CREATE TRIGGER fee_payment_truncate_guard BEFORE TRUNCATE ON trucker.fee_payment
  FOR EACH STATEMENT EXECUTE FUNCTION trucker.guard_fee_payment();

CREATE FUNCTION trucker.guard_fee_refund() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, trucker, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'a refund record is not changed or removed' USING ERRCODE = 'check_violation';
END
$$;
CREATE TRIGGER fee_refund_guard BEFORE UPDATE OR DELETE ON trucker.fee_refund
  FOR EACH ROW EXECUTE FUNCTION trucker.guard_fee_refund();
CREATE TRIGGER fee_refund_truncate_guard BEFORE TRUNCATE ON trucker.fee_refund
  FOR EACH STATEMENT EXECUTE FUNCTION trucker.guard_fee_refund();

CREATE FUNCTION trucker.fee_reference() RETURNS text
LANGUAGE sql VOLATILE SET search_path = pg_catalog, trucker, pg_temp AS $$
  SELECT 'TF-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10))
$$;

-- Written with the booking, after its price (trigger names fire in order).
CREATE FUNCTION trucker.booking_fee_record() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
DECLARE
  p trucker.booking_price;
  f trucker.financial_setting_version;
BEGIN
  SELECT * INTO p FROM trucker.booking_price x WHERE x.booking_id = NEW.id;
  SELECT * INTO f FROM trucker.financial_setting_version x WHERE x.id = NEW.financial_setting_version_id;
  IF p.booking_id IS NULL OR f.id IS NULL THEN
    RAISE EXCEPTION 'a booking is written with its price and settings' USING ERRCODE = 'check_violation';
  END IF;
  IF p.fee_amount > 0 THEN
    -- D-6: within the hours of the settings in force, and never after the assignment deadline.
    INSERT INTO trucker.booking_fee
      (booking_id, status, basis, payer, payer_organisation_id, currency_code, minor_units, amount, reference,
       payment_hours, due_at, created_at)
    VALUES (NEW.id, 'due', 'due', p.fee_payer, p.fee_payer_organisation_id, p.currency_code, p.minor_units,
            p.fee_amount, trucker.fee_reference(), f.fee_payment_hours,
            least(NEW.accepted_at + make_interval(hours => f.fee_payment_hours), NEW.assignment_due_at),
            NEW.accepted_at);
  ELSE
    INSERT INTO trucker.booking_fee
      (booking_id, status, basis, payer, payer_organisation_id, currency_code, minor_units, amount, created_at)
    VALUES (NEW.id, 'not_required', 'nothing_due', p.fee_payer, p.fee_payer_organisation_id, p.currency_code,
            p.minor_units, 0, NEW.accepted_at);
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER booking_settle_fee AFTER INSERT ON trucker.booking
  FOR EACH ROW EXECUTE FUNCTION trucker.booking_fee_record();

-- Bookings made before this migration keep the rule they were made under.
INSERT INTO trucker.booking_fee
  (booking_id, status, basis, payer, payer_organisation_id, currency_code, minor_units, amount, created_at)
SELECT b.id, 'not_required', 'before_fee_payment', p.fee_payer, p.fee_payer_organisation_id, b.currency_code,
       b.minor_units, coalesce(p.fee_amount, b.fee_amount), b.accepted_at
FROM trucker.booking b LEFT JOIN trucker.booking_price p ON p.booking_id = b.id;

-- ---------------------------------------------------------------------------------------------
-- Confirmation by fee verification; lapse as a recorded cancellation
-- ---------------------------------------------------------------------------------------------
ALTER TABLE trucker.booking_confirmation
  ALTER COLUMN confirmed_by DROP NOT NULL,
  ADD COLUMN confirmed_by_staff uuid REFERENCES trucker.staff_account (id),
  ADD COLUMN completed_by text NOT NULL DEFAULT 'assignment'
    CHECK (completed_by IN ('assignment', 'fee_verification'));
ALTER TABLE trucker.booking_confirmation ALTER COLUMN completed_by DROP DEFAULT;
ALTER TABLE trucker.booking_confirmation ADD CONSTRAINT booking_confirmation_actor CHECK (
  (completed_by = 'assignment' AND confirmed_by IS NOT NULL AND confirmed_by_staff IS NULL)
  OR (completed_by = 'fee_verification' AND confirmed_by IS NULL AND confirmed_by_staff IS NOT NULL));

ALTER TABLE trucker.booking_cancellation
  ALTER COLUMN cancelled_by DROP NOT NULL,
  ALTER COLUMN cancelling_organisation DROP NOT NULL,
  DROP CONSTRAINT booking_cancellation_party_check,
  ADD CONSTRAINT booking_cancellation_party_check CHECK (party IN ('shipper', 'carrier', 'platform')),
  DROP CONSTRAINT booking_cancellation_reason_check,
  ADD CONSTRAINT booking_cancellation_reason_check CHECK (reason IN ('shipment_no_longer_needed', 'dates_changed',
    'carrier_did_not_assign', 'resource_unavailable', 'cannot_meet_window', 'other', 'fee_not_paid')),
  DROP CONSTRAINT cancellation_reason_party,
  ADD CONSTRAINT cancellation_reason_party CHECK (
    (party = 'shipper' AND reason IN ('shipment_no_longer_needed', 'dates_changed', 'carrier_did_not_assign', 'other'))
    OR (party = 'carrier' AND reason IN ('resource_unavailable', 'cannot_meet_window', 'other'))
    OR (party = 'platform' AND reason = 'fee_not_paid')),
  -- A lapse is nobody's act: Trucker records it at the deadline.
  ADD CONSTRAINT cancellation_actor CHECK (
    (party = 'platform') = (cancelled_by IS NULL) AND (party = 'platform') = (cancelling_organisation IS NULL));

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
    'booking.refund_recorded')),
  -- A lapse is recorded by Trucker at the deadline, with no one acting.
  DROP CONSTRAINT audit_entry_one_actor,
  ADD CONSTRAINT audit_entry_one_actor CHECK (
    (actor_person_id IS NULL) <> (actor_staff_id IS NULL)
    OR (actor_person_id IS NULL AND actor_staff_id IS NULL AND action IN (
    'shipment.expired', 'shipment.suspended', 'shipment.suspension_ended', 'quotation.expired',
    'quotation.closed', 'quotation.reconfirmation_required', 'booking.lapsed')));

-- Whether the fee no longer stands in the way of confirmation. No record, no confirmation.
CREATE FUNCTION trucker.fee_settled(p_booking uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
  SELECT coalesce((SELECT f.status IN ('paid', 'not_required') FROM trucker.booking_fee f
                   WHERE f.booking_id = p_booking), false)
$$;

-- A receipt recorded by the deadline holds the lapse until the second staff member decides.
CREATE FUNCTION trucker.fee_held(f trucker.booking_fee) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM trucker.fee_payment x
                 WHERE x.booking_id = f.booking_id AND x.status = 'recorded' AND x.recorded_at <= f.due_at)
$$;

CREATE FUNCTION trucker.fee_overdue(p_booking uuid, p_at timestamptz) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM trucker.booking_fee f
                 WHERE f.booking_id = p_booking AND f.status = 'due' AND f.due_at <= p_at AND NOT trucker.fee_held(f))
$$;

-- Every required resource is assigned, eligible for the whole interval and reserved.
CREATE FUNCTION trucker.assignment_ready(b trucker.booking) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
DECLARE
  cur record;
  v_needs_trailer boolean;
BEGIN
  SELECT * INTO cur FROM trucker.assignment_current(b.id);
  IF cur.truck IS NULL OR cur.affiliation IS NULL THEN
    RETURN false;
  END IF;
  SELECT c.requires_trailer INTO v_needs_trailer
  FROM trucker.vehicle v JOIN trucker.vehicle_category c ON c.code = v.category_code WHERE v.id = cur.truck;
  IF coalesce(v_needs_trailer, false) AND cur.trailer IS NULL THEN
    RETURN false;
  END IF;
  IF trucker.assignment_set_check(b, cur.truck, cur.trailer, cur.affiliation, true) IS NOT NULL THEN
    RETURN false;
  END IF;
  RETURN NOT EXISTS (
    SELECT 1 FROM unnest(ARRAY[cur.truck, cur.trailer, cur.driver]) AS r (id)
    WHERE r.id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM trucker.resource_reservation x
      WHERE x.booking_id = b.id AND x.resource_id = r.id AND x.status = 'active' AND x.purpose = 'assignment'));
END
$$;

-- The locks of every command that can end or confirm a booking, in the one order: both
-- organisations, the shipment, the assignment set, then the reserved resources. Returns the set.
CREATE FUNCTION trucker.booking_lock_set(b trucker.booking) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
DECLARE
  n integer;
BEGIN
  PERFORM 1 FROM trucker.organisation o
  WHERE o.id IN (b.shipper_organisation_id, b.carrier_organisation_id) ORDER BY o.id FOR SHARE;
  PERFORM 1 FROM trucker.shipment_draft d WHERE d.id = b.shipment_id FOR UPDATE;
  n := trucker.assignment_state_lock(b.id, trucker.clock_now());
  PERFORM trucker.resource_lock(ARRAY(SELECT r.resource_id FROM trucker.resource_reservation r
    WHERE r.booking_id = b.id AND r.status = 'active' ORDER BY r.resource_id));
  RETURN n;
END
$$;

-- Everyone who keeps a history of this booking's fee: both parties, and an organiser who pays.
CREATE FUNCTION trucker.fee_audit(b trucker.booking, p_at timestamptz, p_person uuid, p_staff uuid, p_action text,
                                  p_after jsonb)
RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
  INSERT INTO trucker.audit_entry
    (occurred_at, actor_person_id, actor_staff_id, organisation_id, action, record_type, record_id, request_id,
     after_values)
  SELECT p_at, p_person, p_staff, o, p_action, 'booking', b.id, nullif(current_setting('trucker.request_id', true), ''), p_after
  FROM (SELECT DISTINCT unnest(ARRAY[b.shipper_organisation_id, b.carrier_organisation_id,
                                     (SELECT f.payer_organisation_id FROM trucker.booking_fee f
                                      WHERE f.booking_id = b.id)]) AS o) x
  WHERE o IS NOT NULL
$$;

-- D-7. The caller holds trucker.booking_lock_set(b) and read p_at after taking it.
CREATE FUNCTION trucker.fee_lapse_if_due(b trucker.booking, p_set integer, p_at timestamptz) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
DECLARE
  f trucker.booking_fee;
BEGIN
  SELECT * INTO f FROM trucker.booking_fee x WHERE x.booking_id = b.id FOR UPDATE;
  IF NOT FOUND OR f.status <> 'due' OR f.due_at > p_at OR trucker.fee_held(f)
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
$$;

-- After a cancellation: a fee still due is closed; a fee paid is returned in full (D-8).
CREATE FUNCTION trucker.fee_after_cancellation(b trucker.booking, p_at timestamptz, p_person uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
DECLARE
  f trucker.booking_fee;
  r trucker.fee_refund;
BEGIN
  SELECT * INTO f FROM trucker.booking_fee x WHERE x.booking_id = b.id FOR UPDATE;
  IF f.status = 'due' THEN
    UPDATE trucker.booking_fee x SET status = 'closed', ended_at = p_at, row_version = row_version + 1
    WHERE x.booking_id = b.id;
  ELSIF f.status = 'paid' THEN
    INSERT INTO trucker.fee_refund (booking_id, payment_id, reason, currency_code, minor_units, amount, status, recorded_at)
    SELECT f.booking_id, p.id, 'cancelled_after_payment', p.currency_code, p.minor_units, p.amount, 'pending', p_at
    FROM trucker.fee_payment p WHERE p.id = f.payment_id
    RETURNING * INTO r;
    PERFORM trucker.fee_audit(b, p_at, p_person, NULL, 'booking.refund_recorded',
                              jsonb_build_object('reason', r.reason, 'amount', trucker.amount_text(r.amount, r.minor_units),
                                                 'currency', r.currency_code));
  END IF;
END
$$;

-- The later of fee verification and full assignment confirms the booking (G-8). This is the
-- fee side; set_booking_assignment is the assignment side. The caller holds the lock set.
CREATE FUNCTION trucker.fee_confirm_if_ready(b trucker.booking, p_set integer, p_at timestamptz, p_staff uuid)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
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
  SELECT b.id, p_at, NULL, p_staff, 'fee_verification', p_set,
         trucker.assignment_set_values(cur.truck, cur.trailer, cur.affiliation, 'carrier'),
         jsonb_build_object(
           'pickup', jsonb_build_object('address', d.pickup_address, 'accessNotes', d.pickup_access_notes),
           'delivery', jsonb_build_object('address', d.delivery_address, 'accessNotes', d.delivery_access_notes))
  FROM trucker.shipment_draft d WHERE d.id = b.shipment_id;
  -- In the shipper's history, as when the assignment confirms (one confirmation event per
  -- booking); the carrier's history has the fee payment.
  PERFORM trucker.fleet_audit(p_at, NULL, p_staff, b.shipper_organisation_id, 'booking.confirmed', 'booking', b.id,
    jsonb_build_object('status', 'awaiting_fee'),
    jsonb_build_object('status', 'confirmed', 'by', 'fee_verification',
                       'resources', trucker.assignment_set_values(cur.truck, cur.trailer, cur.affiliation, 'shipper')));
  RETURN true;
END
$$;

-- Lapses at most one booking whose fee is overdue, so that one call never holds the locks of
-- two bookings. The API calls it until it answers 'none'.
CREATE FUNCTION trucker.lapse_overdue_fee() RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
DECLARE
  b trucker.booking;
  n integer;
BEGIN
  SELECT x.* INTO b FROM trucker.booking x
  WHERE x.id = (SELECT f.booking_id FROM trucker.booking_fee f
                WHERE f.status = 'due' AND f.due_at <= trucker.clock_now() AND NOT trucker.fee_held(f)
                ORDER BY f.due_at, f.booking_id LIMIT 1);
  IF NOT FOUND THEN
    RETURN 'none';
  END IF;
  n := trucker.booking_lock_set(b);
  RETURN CASE WHEN trucker.fee_lapse_if_due(b, n, trucker.clock_now()) THEN 'lapsed' ELSE 'unchanged' END;
END
$$;

-- What a participant or the staff are shown of the fee. The payer and the staff see the
-- amount and the reference; the other parties see whether it is settled.
CREATE FUNCTION trucker.fee_payment_values(p trucker.fee_payment) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
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
    'decidedAt', p.decided_at, 'decisionNote', p.decision_note)
$$;

CREATE FUNCTION trucker.fee_refund_values(r trucker.fee_refund) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
  SELECT jsonb_build_object('id', r.id, 'bookingId', r.booking_id, 'paymentId', r.payment_id, 'reason', r.reason,
                            'amount', trucker.amount_text(r.amount, r.minor_units), 'currency', r.currency_code,
                            'status', r.status, 'recordedAt', r.recorded_at)
$$;

-- p_audience: shipper (the customer), carrier, organiser (only when it pays) or staff.
CREATE FUNCTION trucker.fee_values(b trucker.booking, p_audience text, p_at timestamptz) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
  SELECT jsonb_build_object(
           'status', CASE WHEN f.status = 'due' AND f.due_at <= p_at AND NOT trucker.fee_held(f) THEN 'overdue'
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
                                        FROM trucker.fee_refund r WHERE r.booking_id = f.booking_id), '[]'::jsonb))
            ELSE '{}'::jsonb END
    || CASE WHEN p_audience = 'staff'
            THEN jsonb_build_object(
                   'basis', f.basis,
                   'payerOrganisation', (SELECT jsonb_build_object('id', o.id, 'legalName', o.legal_name)
                                         FROM trucker.organisation o WHERE o.id = f.payer_organisation_id),
                   'payments', coalesce((SELECT jsonb_agg(trucker.fee_payment_values(x) ORDER BY x.recorded_at, x.id)
                                         FROM trucker.fee_payment x WHERE x.booking_id = f.booking_id), '[]'::jsonb))
            ELSE '{}'::jsonb END
  FROM trucker.booking_fee f WHERE f.booking_id = b.id
$$;

CREATE OR REPLACE FUNCTION trucker.booking_view(b trucker.booking, p_audience text, p_at timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'trucker', 'pg_temp'
AS $function$
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
    RETURN trucker.booking_money(b, p_audience) || jsonb_build_object(
      'status','cancelled','confirmedAt',(SELECT x.confirmed_at FROM trucker.booking_confirmation x WHERE x.booking_id=b.id),
      'overdue',false,'waitDecision',NULL,'assignmentVersion',
      coalesce((SELECT x.set_no FROM trucker.booking_assignment_state x WHERE x.booking_id=b.id),0),
      'dispatch',jsonb_build_object('ready',false,'blockers',jsonb_build_array(jsonb_build_object('code','booking_cancelled'))),
      'needsReassignment',false,'atRisk',false,'acknowledgedAt',NULL,'resources',NULL,'substitution',NULL,'site',NULL,
      'vehicleChanges',trucker.vehicle_changes(b.id),
      'cancellation',trucker.cancellation_values(b.id,p_audience),
      'feePayment',trucker.fee_values(b,p_audience,p_at));
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
  RETURN trucker.booking_money(b, p_audience) || jsonb_build_object(
    -- Whichever of the fee and the resources is still missing (R-14).
    'status', CASE WHEN c.booking_id IS NOT NULL THEN 'confirmed'
                   WHEN NOT trucker.fee_settled(b.id) AND trucker.assignment_ready(b) THEN 'awaiting_fee'
                   ELSE 'awaiting_resources' END,
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
    'vehicleChanges', trucker.vehicle_changes(b.id),
    'site', CASE WHEN p_audience <> 'shipper' AND c.booking_id IS NOT NULL THEN c.site_details END,
    'feePayment', trucker.fee_values(b, p_audience, p_at));
END
$function$;

CREATE OR REPLACE FUNCTION trucker.booking_dispatch_blockers(b trucker.booking, p_at timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'trucker', 'pg_temp'
AS $function$
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
  IF NOT v_confirmed AND NOT trucker.fee_settled(b.id) THEN
    result := result || jsonb_build_object('code', 'fee_not_paid');
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
$function$;

CREATE OR REPLACE FUNCTION trucker.booking_consistency()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'trucker', 'pg_temp'
AS $function$
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
    -- A confirmation without the fee (R-14).
    SELECT 'confirmed_without_fee', c.booking_id, c.booking_id
    FROM trucker.booking_confirmation c WHERE NOT trucker.fee_settled(c.booking_id)
    UNION ALL
    SELECT 'cancelled_open_substitution', c.booking_id, s.id
    FROM trucker.booking_cancellation c JOIN trucker.booking_substitution s ON s.booking_id=c.booking_id
    WHERE s.status='proposed'
  ) AS x
$function$;

CREATE OR REPLACE FUNCTION trucker.staff_booking_attention(p_token_hash text, p_request_id text, OUT status text, OUT detail jsonb)
 RETURNS record
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'trucker', 'pg_temp'
AS $function$
#variable_conflict use_column
DECLARE
  entered record;
BEGIN
  SELECT * INTO entered FROM trucker.staff_enter(p_token_hash, NULL, 'staff.booking_attention', NULL, p_request_id);
  status := entered.status;
  IF status <> 'ok' THEN
    RETURN;
  END IF;
  IF NOT (trucker.staff_privileges(entered.staff_id) && ARRAY['reviewer', 'staff_admin']) THEN
    PERFORM trucker.staff_audit(entered.at, entered.staff_id, 'staff.booking_attention', 'refused', NULL, p_request_id,
                                jsonb_build_object('reason', 'privilege_not_held'));
    status := 'forbidden';
    RETURN;
  END IF;
  PERFORM trucker.staff_audit(entered.at, entered.staff_id, 'staff.booking_attention', 'done', NULL, p_request_id, '{}'::jsonb);
  PERFORM trucker.overrun_note(entered.at);
  detail := jsonb_build_object(
    'bookings', coalesce((
      SELECT jsonb_agg(x.item ORDER BY x.due, x.id)
      FROM (
        SELECT b.id, b.assignment_due_at AS due, jsonb_build_object(
                 'id', v ->> 'id', 'shipmentId', v ->> 'shipmentId', 'status', v ->> 'status',
                 'shipper', v -> 'shipper', 'carrier', v -> 'carrier',
                 'assignmentDueAt', b.assignment_due_at, 'overdue', v -> 'overdue',
                 'waitDecision', v -> 'waitDecision', 'needsReassignment', v -> 'needsReassignment',
                 'atRisk', v -> 'atRisk', 'substitutionOpen', (v -> 'substitution') <> 'null'::jsonb,
                 'blockers', v #> '{dispatch,blockers}', 'feeStatus', v #>> '{feePayment,status}') AS item
        FROM trucker.booking b
        CROSS JOIN LATERAL trucker.booking_view(b, 'staff', entered.at) AS v
        WHERE (v ->> 'overdue')::boolean OR (v ->> 'needsReassignment')::boolean OR (v ->> 'atRisk')::boolean
           OR (v -> 'substitution') <> 'null'::jsonb OR (v #>> '{feePayment,status}') = 'overdue'
        ORDER BY b.assignment_due_at, b.id LIMIT 200) AS x), '[]'::jsonb),
    'consistency', trucker.booking_consistency());
END
$function$;

CREATE OR REPLACE FUNCTION trucker.set_booking_assignment(p_booking uuid, p_expected_version integer, p_truck uuid, p_trailer uuid, p_affiliation uuid, p_allow_fixtures boolean, OUT status text, OUT detail jsonb)
 RETURNS record
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'trucker', 'pg_temp'
AS $function$
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
  v_changes jsonb;
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
  -- Nothing is reserved for a booking whose fee was not paid by its deadline (D-7).
  IF trucker.fee_overdue(b.id, v_at) THEN
    status := 'fee_not_paid'; RETURN;
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
                           'confirms', NOT v_confirmed AND v_complete AND trucker.fee_settled(b.id)));
      -- After confirmation a vehicle replaced by one of the same category takes effect at once
      -- (N-1). The shipper's history records it, with the registrations only: the same facts the
      -- shipper is shown of the vehicles. A change of driver is not recorded here.
      IF v_confirmed THEN
        SELECT coalesce(jsonb_agg(jsonb_build_object(
                 'role', m.role,
                 'from', trucker.assignment_vehicle_values(m.held, 'shipper'),
                 'to', trucker.assignment_vehicle_values(m.wanted, 'shipper')) ORDER BY m.n), '[]'::jsonb)
        INTO v_changes
        FROM (VALUES (1, 'truck', cur.truck, p_truck), (2, 'trailer', cur.trailer, p_trailer))
          AS m (n, role, held, wanted)
        WHERE m.held IS DISTINCT FROM m.wanted;
        IF jsonb_array_length(v_changes) > 0 THEN
          PERFORM trucker.assignment_audit(
            v_at, entered.actor, b.shipper_organisation_id, 'booking.vehicles_changed', 'booking', b.id,
            NULL, jsonb_build_object('changes', v_changes));
        END IF;
      END IF;
      status := 'assigned';
      -- R-14: and Trucker's fee is verified. Otherwise the fee's verification confirms it.
      IF NOT v_confirmed AND v_complete AND trucker.fee_settled(b.id) THEN
        -- Every required resource is assigned, eligible for the whole interval and reserved.
        INSERT INTO trucker.booking_confirmation
          (booking_id, confirmed_at, confirmed_by, completed_by, set_no, resources, site_details)
        SELECT b.id, v_at, entered.actor, 'assignment', v_new_set,
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
$function$;

CREATE OR REPLACE FUNCTION trucker.cancel_booking(p_booking uuid, p_expected_version integer, p_reason text, p_note text, p_allow_fixtures boolean, OUT status text, OUT detail jsonb)
 RETURNS record
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'trucker', 'pg_temp'
AS $function$
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
  -- A fee unpaid at its deadline lapsed the booking then, whatever is asked now.
  PERFORM trucker.fee_lapse_if_due(b, n, t);
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
  PERFORM trucker.fee_after_cancellation(b, t, actor);
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
      'feePayment', (SELECT trucker.fee_values(b, 'organiser', trucker.clock_now()) FROM trucker.booking b
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
-- The staff side: record a receipt, approve or reject it, see what is due
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION trucker.staff_fee_payments(p_token_hash text, p_request_id text, OUT status text, OUT detail jsonb)
RETURNS record
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
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
    'refunds', coalesce((
      SELECT jsonb_agg(trucker.fee_refund_values(r) || jsonb_build_object(
               'reference', (SELECT f.reference FROM trucker.booking_fee f WHERE f.booking_id = r.booking_id))
             ORDER BY r.recorded_at, r.id)
      FROM trucker.fee_refund r WHERE r.status = 'pending'), '[]'::jsonb));
END
$$;

-- p_content: {"reference", "amount", "currency", "valueDate" (YYYY-MM-DD), "statementReference",
-- "note"?}. Only an exact match is recorded against a fee that is due; money for a booking that
-- has lapsed, been cancelled or already paid is recorded as it arrived, to be returned.
CREATE FUNCTION trucker.staff_fee_record(p_token_hash text, p_key text, p_content jsonb, p_request_id text,
                                         OUT status text, OUT detail jsonb)
RETURNS record
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
DECLARE
  e record;
  hash text := trucker.content_hash(coalesce(p_content, '{}'::jsonb));
  p trucker.fee_payment;
  f trucker.booking_fee;
  b trucker.booking;
  n integer;
  t timestamptz;
  problems jsonb := '[]'::jsonb;
  v_amount numeric;
  v_date date;
  v_line text := btrim(p_content ->> 'statementReference');
  v_note text := nullif(btrim(p_content ->> 'note'), '');
BEGIN
  SELECT * INTO e FROM trucker.staff_enter(p_token_hash, 'staff_admin', 'staff.fee_payment.record', NULL, p_request_id);
  status := e.status;
  IF status <> 'ok' THEN
    RETURN;
  END IF;
  IF p_key IS NULL OR p_key !~ '^[A-Za-z0-9._-]{16,128}$' THEN
    status := 'invalid';
    detail := jsonb_build_array(jsonb_build_object('field', 'retryKey', 'code', 'invalid'));
    RETURN;
  END IF;
  SELECT * INTO p FROM trucker.fee_payment x WHERE x.record_key = p_key;
  IF FOUND THEN
    status := CASE WHEN p.recorded_by = e.staff_id AND p.record_hash = hash THEN 'repeated' ELSE 'key_conflict' END;
    detail := CASE WHEN status = 'repeated' THEN trucker.fee_payment_values(p) END;
    RETURN;
  END IF;
  -- The form first; then the fee it names.
  IF jsonb_typeof(p_content -> 'amount') IS DISTINCT FROM 'string'
     OR (p_content ->> 'amount') !~ '^[0-9]{1,12}(\.[0-9]{1,3})?$' OR (p_content ->> 'amount')::numeric <= 0 THEN
    problems := problems || jsonb_build_object('field', 'amount', 'code', 'invalid');
  ELSE
    v_amount := (p_content ->> 'amount')::numeric;
  END IF;
  IF jsonb_typeof(p_content -> 'valueDate') IS DISTINCT FROM 'string'
     OR (p_content ->> 'valueDate') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
    problems := problems || jsonb_build_object('field', 'valueDate', 'code', 'invalid');
  ELSE
    BEGIN
      v_date := (p_content ->> 'valueDate')::date;
    EXCEPTION WHEN OTHERS THEN
      problems := problems || jsonb_build_object('field', 'valueDate', 'code', 'invalid');
    END;
  END IF;
  IF jsonb_typeof(p_content -> 'statementReference') IS DISTINCT FROM 'string'
     OR char_length(v_line) NOT BETWEEN 1 AND 100 THEN
    problems := problems || jsonb_build_object('field', 'statementReference', 'code', 'required');
  END IF;
  IF p_content ? 'note' AND jsonb_typeof(p_content -> 'note') <> 'null'
     AND (jsonb_typeof(p_content -> 'note') <> 'string' OR char_length(coalesce(v_note, '')) > 1000) THEN
    problems := problems || jsonb_build_object('field', 'note', 'code', 'invalid');
  END IF;
  IF jsonb_typeof(p_content -> 'currency') IS DISTINCT FROM 'string' THEN
    problems := problems || jsonb_build_object('field', 'currency', 'code', 'invalid');
  END IF;
  SELECT * INTO f FROM trucker.booking_fee x
  WHERE x.reference = upper(btrim(coalesce(p_content ->> 'reference', '')));
  IF NOT FOUND THEN
    problems := problems || jsonb_build_object('field', 'reference', 'code', 'unknown');
  END IF;
  IF jsonb_array_length(problems) > 0 THEN
    status := 'invalid';
    detail := problems;
    RETURN;
  END IF;
  SELECT * INTO b FROM trucker.booking x WHERE x.id = f.booking_id;
  n := trucker.booking_lock_set(b);
  t := trucker.clock_now();
  -- Money that arrives after the deadline never holds a booking that should have lapsed.
  PERFORM trucker.fee_lapse_if_due(b, n, t);
  SELECT * INTO f FROM trucker.booking_fee x WHERE x.booking_id = b.id FOR UPDATE;
  IF (p_content ->> 'currency') IS DISTINCT FROM f.currency_code THEN
    problems := problems || jsonb_build_object('field', 'currency', 'code', 'mismatch', 'expected', f.currency_code);
  END IF;
  IF scale(v_amount) > f.minor_units THEN
    problems := problems || jsonb_build_object('field', 'amount', 'code', 'invalid');
  ELSIF f.status = 'due' AND v_amount <> f.amount THEN
    problems := problems || jsonb_build_object('field', 'amount', 'code', 'mismatch',
                                               'expected', trucker.amount_text(f.amount, f.minor_units));
  END IF;
  IF v_date > (t AT TIME ZONE 'UTC')::date + 1 THEN
    problems := problems || jsonb_build_object('field', 'valueDate', 'code', 'future');
  END IF;
  IF EXISTS (SELECT 1 FROM trucker.fee_payment x WHERE x.statement_reference = v_line AND x.status <> 'rejected') THEN
    problems := problems || jsonb_build_object('field', 'statementReference', 'code', 'already_recorded');
  END IF;
  IF f.status = 'not_required' THEN
    problems := problems || jsonb_build_object('field', 'reference', 'code', 'not_required');
  END IF;
  IF jsonb_array_length(problems) > 0 THEN
    status := 'invalid';
    detail := problems;
    RETURN;
  END IF;
  BEGIN
    INSERT INTO trucker.fee_payment
      (booking_id, method, currency_code, minor_units, amount, value_date, statement_reference, note, status,
       recorded_by, recorded_at, record_key, record_hash)
    VALUES (f.booking_id, 'bank_transfer', f.currency_code, f.minor_units, v_amount, v_date, v_line, v_note,
            'recorded', e.staff_id, t, p_key, hash)
    RETURNING * INTO p;
  EXCEPTION WHEN unique_violation THEN
    SELECT * INTO p FROM trucker.fee_payment x WHERE x.record_key = p_key;
    IF FOUND THEN
      status := CASE WHEN p.recorded_by = e.staff_id AND p.record_hash = hash THEN 'repeated' ELSE 'key_conflict' END;
      detail := CASE WHEN status = 'repeated' THEN trucker.fee_payment_values(p) END;
    ELSE
      status := 'invalid';
      detail := jsonb_build_array(jsonb_build_object('field', 'statementReference', 'code', 'already_recorded'));
    END IF;
    RETURN;
  END;
  PERFORM trucker.staff_audit(t, e.staff_id, 'staff.fee_payment.recorded', 'done', NULL, p_request_id,
                              jsonb_build_object('payment', p.id, 'booking', p.booking_id, 'feeStatus', f.status));
  status := 'recorded';
  detail := trucker.fee_payment_values(p);
END
$$;

CREATE FUNCTION trucker.staff_fee_decide(p_token_hash text, p_payment uuid, p_expected_version integer,
                                         p_decision text, p_note text, p_request_id text,
                                         OUT status text, OUT detail jsonb)
RETURNS record
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
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
$$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA trucker FROM PUBLIC;
GRANT EXECUTE ON FUNCTION trucker.staff_fee_payments(text, text) TO trucker_app;
GRANT EXECUTE ON FUNCTION trucker.staff_fee_record(text, text, jsonb, text) TO trucker_app;
GRANT EXECUTE ON FUNCTION trucker.staff_fee_decide(text, uuid, integer, text, text, text) TO trucker_app;
GRANT EXECUTE ON FUNCTION trucker.lapse_overdue_fee() TO trucker_app;
