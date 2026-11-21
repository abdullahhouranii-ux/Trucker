-- One internal preparation record per settled fee. Tax issuance and delivery remain configuration work.
CREATE TABLE trucker.fee_invoice_draft (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id uuid NOT NULL UNIQUE REFERENCES trucker.booking_fee(booking_id),
  payment_id uuid NOT NULL UNIQUE REFERENCES trucker.fee_payment(id),
  payer_organisation_id uuid NOT NULL REFERENCES trucker.organisation(id),
  booker_id uuid NOT NULL REFERENCES trucker.person(id),
  recorded_fee numeric NOT NULL CHECK (recorded_fee > 0),
  currency text NOT NULL REFERENCES trucker.currency(code),
  minor_units int NOT NULL CHECK (minor_units BETWEEN 0 AND 3),
  paid_at timestamptz NOT NULL,
  prepared_at timestamptz NOT NULL
);
ALTER TABLE trucker.fee_invoice_draft ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON trucker.fee_invoice_draft FROM PUBLIC,trucker_app;
CREATE TRIGGER fee_invoice_draft_immutable BEFORE UPDATE OR DELETE ON trucker.fee_invoice_draft
  FOR EACH ROW EXECUTE FUNCTION trucker.guard_trip_record();
CREATE TRIGGER fee_invoice_draft_no_truncate BEFORE TRUNCATE ON trucker.fee_invoice_draft
  FOR EACH STATEMENT EXECUTE FUNCTION trucker.guard_trip_record();

CREATE FUNCTION trucker.prepare_fee_invoice_draft() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog,trucker,pg_temp AS $$
BEGIN
  INSERT INTO trucker.fee_invoice_draft(
    booking_id,payment_id,payer_organisation_id,booker_id,recorded_fee,currency,minor_units,paid_at,prepared_at
  )
  SELECT NEW.booking_id,NEW.payment_id,NEW.payer_organisation_id,b.accepted_by,
    p.amount,p.currency_code,p.minor_units,NEW.paid_at,trucker.clock_now()
  FROM trucker.booking b JOIN trucker.fee_payment p ON p.booking_id=b.id
  WHERE b.id=NEW.booking_id AND p.id=NEW.payment_id AND p.status='approved' AND p.outcome='settled';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invoice preparation requires the settled platform fee'
      USING ERRCODE='check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER booking_fee_prepare_invoice AFTER UPDATE OF status ON trucker.booking_fee
  FOR EACH ROW WHEN (OLD.status <> 'paid' AND NEW.status='paid')
  EXECUTE FUNCTION trucker.prepare_fee_invoice_draft();

CREATE FUNCTION trucker.read_fee_invoice_draft(p_booking uuid,p_staff_token text,p_request_id text,
  OUT status text,OUT detail jsonb)
RETURNS record LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog,trucker,pg_temp AS $$
DECLARE
  entered record;
  org uuid;
  f trucker.booking_fee;
  d trucker.fee_invoice_draft;
  example_vat numeric;
BEGIN
  IF p_staff_token IS NULL THEN
    IF trucker.request_person() IS NULL THEN status := 'unauthorized'; RETURN; END IF;
    org := trucker.request_organisation();
    IF org IS NULL OR NOT trucker.is_admin(org) THEN status := 'not_found'; RETURN; END IF;
  ELSE
    SELECT * INTO entered FROM trucker.staff_enter(p_staff_token,'staff_admin','staff.fee_invoice_draft',NULL,p_request_id);
    IF entered.status <> 'ok' THEN status := entered.status; RETURN; END IF;
  END IF;
  SELECT * INTO f FROM trucker.booking_fee WHERE booking_id=p_booking;
  IF f.booking_id IS NULL OR (p_staff_token IS NULL AND org IS DISTINCT FROM f.payer_organisation_id)
    THEN status := 'not_found'; RETURN; END IF;
  SELECT * INTO d FROM trucker.fee_invoice_draft WHERE booking_id=p_booking;
  status := 'ok';
  IF d.id IS NULL THEN detail := jsonb_build_object('draft', NULL); RETURN; END IF;

  -- This is a staff-only illustration, not an applied tax classification or a payable amount.
  IF p_staff_token IS NOT NULL AND d.currency='OMR' THEN
    example_vat := round(d.recorded_fee * 0.05,d.minor_units);
  END IF;
  detail := jsonb_build_object('draft',jsonb_build_object(
    'id',d.id,'bookingId',d.booking_id,'recordedFee',trucker.amount_text(d.recorded_fee,d.minor_units),
    'currency',d.currency,'paidAt',d.paid_at,'preparedAt',d.prepared_at,'status','pending_issuer_and_tax',
    'illustration',CASE WHEN example_vat IS NOT NULL THEN jsonb_build_object(
      'ratePercent',5,'vat',trucker.amount_text(example_vat,d.minor_units),
      'gross',trucker.amount_text(d.recorded_fee + example_vat,d.minor_units)) END
  ));
END
$$;
REVOKE ALL ON FUNCTION trucker.prepare_fee_invoice_draft(),trucker.read_fee_invoice_draft(uuid,text,text)
  FROM PUBLIC,trucker_app;
GRANT EXECUTE ON FUNCTION trucker.read_fee_invoice_draft(uuid,text,text) TO trucker_app;
