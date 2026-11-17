-- 0020_commission
-- Organiser commission, part one (slice 23a; model: docs/specs/ADR_001_COMMERCIAL_MODEL.md,
-- R-5 to R-9). The organiser of a shipment arranged for a customer states its commission on the
-- request: a percentage of the shipping price, or a fixed amount. The carrier quotes the
-- shipping price the customer pays; the commission is included in it; the carrier's net
-- earnings are the price less the commission. No quotation exists on such a shipment unless
-- the carrier has accepted exactly those figures. The customer is shown the shipping price and
-- no commission line; the carrier and the organiser see the price, the commission and the net.
--
-- Development defaults, not approved for production (ADR-001 D-1 to D-3): the percentage is of
-- the shipping price; amounts are rounded half-up to the currency's minor unit and the net is
-- never rounded separately; a percentage is at most 25%; a fixed amount must leave the carrier
-- something. The third option of the plan, a commission contract accepted in advance, is the
-- next slice. When a commission is earned and paid belongs to settlement.
--
-- Nothing here changes a quotation function: the commission of a quotation version is written
-- by a trigger when the version is, and the version is refused if the figures the carrier
-- accepted are not exactly the ones computed. The booking keeps a copy, written once.

CREATE TABLE trucker.shipment_commission (
  shipment_id uuid PRIMARY KEY REFERENCES trucker.shipment_draft (id),
  option text NOT NULL CHECK (option IN ('percentage', 'fixed')),
  -- Of the customer shipping price. 1 to 2500: a development limit.
  basis_points integer CHECK (basis_points BETWEEN 1 AND 2500),
  fixed_amount numeric CHECK (fixed_amount > 0 AND fixed_amount < 1000000000000),
  currency_code text REFERENCES trucker.currency (code),
  set_by uuid NOT NULL REFERENCES trucker.person (id),
  set_at timestamptz NOT NULL,
  CONSTRAINT shipment_commission_shape CHECK (
    (option = 'percentage' AND basis_points IS NOT NULL AND fixed_amount IS NULL AND currency_code IS NULL)
    OR (option = 'fixed' AND basis_points IS NULL AND fixed_amount IS NOT NULL AND currency_code IS NOT NULL))
);
ALTER TABLE trucker.shipment_commission ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON trucker.shipment_commission FROM trucker_app, PUBLIC;

-- What one version of a quotation gives the organiser and leaves the carrier. Written once.
CREATE TABLE trucker.quotation_commission (
  quotation_id uuid NOT NULL,
  version_no integer NOT NULL,
  organiser_organisation_id uuid NOT NULL REFERENCES trucker.organisation (id),
  option text NOT NULL CHECK (option IN ('percentage', 'fixed')),
  basis_points integer,
  currency_code text NOT NULL REFERENCES trucker.currency (code),
  minor_units integer NOT NULL,
  shipping_amount numeric NOT NULL,
  commission_amount numeric NOT NULL CHECK (commission_amount > 0),
  net_amount numeric NOT NULL CHECK (net_amount > 0),
  accepted_by uuid NOT NULL REFERENCES trucker.person (id),
  accepted_at timestamptz NOT NULL,
  PRIMARY KEY (quotation_id, version_no),
  FOREIGN KEY (quotation_id, version_no) REFERENCES trucker.quotation_version (quotation_id, version_no),
  CONSTRAINT quotation_commission_exact CHECK (
    shipping_amount = commission_amount + net_amount
    AND commission_amount = round(commission_amount, minor_units))
);
ALTER TABLE trucker.quotation_commission ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON trucker.quotation_commission FROM trucker_app, PUBLIC;

-- The commission of a booking, as accepted. Written once when the booking is made.
CREATE TABLE trucker.booking_commission (
  booking_id uuid PRIMARY KEY REFERENCES trucker.booking (id),
  organiser_organisation_id uuid NOT NULL REFERENCES trucker.organisation (id),
  carrier_organisation_id uuid NOT NULL REFERENCES trucker.organisation (id),
  option text NOT NULL,
  basis_points integer,
  currency_code text NOT NULL,
  minor_units integer NOT NULL,
  shipping_amount numeric NOT NULL,
  commission_amount numeric NOT NULL,
  net_amount numeric NOT NULL,
  recorded_at timestamptz NOT NULL,
  CONSTRAINT booking_commission_exact CHECK (shipping_amount = commission_amount + net_amount)
);
ALTER TABLE trucker.booking_commission ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON trucker.booking_commission FROM trucker_app, PUBLIC;

CREATE FUNCTION trucker.guard_commission_record() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, trucker, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'a recorded commission is never changed' USING ERRCODE = 'check_violation';
END
$$;
CREATE TRIGGER quotation_commission_guard BEFORE UPDATE OR DELETE ON trucker.quotation_commission
  FOR EACH ROW EXECUTE FUNCTION trucker.guard_commission_record();
CREATE TRIGGER booking_commission_guard BEFORE UPDATE OR DELETE ON trucker.booking_commission
  FOR EACH ROW EXECUTE FUNCTION trucker.guard_commission_record();
CREATE TRIGGER quotation_commission_truncate_guard BEFORE TRUNCATE ON trucker.quotation_commission
  FOR EACH STATEMENT EXECUTE FUNCTION trucker.guard_commission_record();
CREATE TRIGGER booking_commission_truncate_guard BEFORE TRUNCATE ON trucker.booking_commission
  FOR EACH STATEMENT EXECUTE FUNCTION trucker.guard_commission_record();

-- History.
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
    'shipment.commission_set'));

-- The commission terms as shown to the organiser and to carriers. Never to the customer.
CREATE FUNCTION trucker.shipment_commission_values(c trucker.shipment_commission) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
  SELECT CASE WHEN c.shipment_id IS NULL THEN NULL ELSE jsonb_build_object(
    'option', c.option, 'basisPoints', c.basis_points,
    'amount', CASE WHEN c.fixed_amount IS NOT NULL THEN trucker.amount_text(
                c.fixed_amount, (SELECT x.minor_units FROM trucker.currency x WHERE x.code = c.currency_code)) END,
    'currency', c.currency_code) END
$$;

-- The figures for one price: exact, half-up, the net never rounded on its own.
--   status: none | ok | currency | nothing_left
CREATE FUNCTION trucker.commission_figures(
  p_shipment uuid, p_amount numeric, p_currency text,
  OUT status text, OUT commission numeric, OUT net numeric, OUT minor integer
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
DECLARE
  c trucker.shipment_commission;
BEGIN
  SELECT * INTO c FROM trucker.shipment_commission x WHERE x.shipment_id = p_shipment;
  IF NOT FOUND THEN
    status := 'none';
    RETURN;
  END IF;
  SELECT x.minor_units INTO minor FROM trucker.currency x WHERE x.code = p_currency;
  IF c.option = 'fixed' AND c.currency_code <> p_currency THEN
    status := 'currency';
    RETURN;
  END IF;
  commission := CASE WHEN c.option = 'fixed' THEN c.fixed_amount
                     ELSE round(p_amount * c.basis_points / 10000, minor) END;
  net := p_amount - commission;
  status := CASE WHEN commission > 0 AND net > 0 THEN 'ok' ELSE 'nothing_left' END;
END
$$;

-- Setting the commission of a draft arranged for a customer. Fixed once it has been published.
--   p_content: {"option": "none" | "percentage" | "fixed", "basisPoints": int,
--               "amount": text, "currency": text}
--   status: saved | invalid | not_draft | conflict | unauthorized | not_found
CREATE FUNCTION trucker.set_shipment_commission(
  p_shipment uuid, p_expected_version integer, p_content jsonb, OUT status text, OUT detail jsonb
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
DECLARE
  entered record;
  d trucker.shipment_draft;
  c trucker.shipment_commission;
  v_option text := p_content ->> 'option';
  v_points integer;
  v_amount numeric;
  v_minor integer;
  problems jsonb := '[]'::jsonb;
BEGIN
  SELECT * INTO entered FROM trucker.shipment_enter(p_shipment);
  status := entered.status;
  IF status <> 'ok' THEN
    RETURN;
  END IF;
  d := entered.row_found;
  IF d.status <> 'draft' OR d.published_version IS NOT NULL THEN
    status := 'not_draft';
    RETURN;
  END IF;
  IF d.version IS DISTINCT FROM p_expected_version THEN
    status := 'conflict';
    RETURN;
  END IF;
  IF v_option IS NULL OR v_option NOT IN ('none', 'percentage', 'fixed') THEN
    problems := problems || jsonb_build_object('field', 'commission', 'code', 'required');
  ELSIF v_option <> 'none' AND trucker.shipment_customer(d.id) = entered.org THEN
    -- A commission is the organiser's, on a shipment it arranges for a customer.
    problems := problems || jsonb_build_object('field', 'commission', 'code', 'own_shipment');
  ELSIF v_option = 'percentage' THEN
    IF coalesce(p_content ->> 'basisPoints', '') !~ '^[0-9]{1,4}$'
       OR (p_content ->> 'basisPoints')::integer NOT BETWEEN 1 AND 2500 THEN
      problems := problems || jsonb_build_object('field', 'commissionPercentage', 'code', 'out_of_range');
    ELSE
      v_points := (p_content ->> 'basisPoints')::integer;
    END IF;
  ELSIF v_option = 'fixed' THEN
    SELECT x.minor_units INTO v_minor FROM trucker.currency x WHERE x.code = p_content ->> 'currency';
    IF v_minor IS NULL THEN
      problems := problems || jsonb_build_object('field', 'commissionCurrency', 'code', 'unavailable');
    ELSIF coalesce(p_content ->> 'amount', '') !~ ('^[0-9]{1,12}(\.[0-9]{1,' || greatest(v_minor, 1) || '})?$')
          OR (v_minor = 0 AND p_content ->> 'amount' ~ '\.')
          OR (p_content ->> 'amount')::numeric <= 0 THEN
      problems := problems || jsonb_build_object('field', 'commissionAmount', 'code', 'invalid');
    ELSE
      v_amount := (p_content ->> 'amount')::numeric;
    END IF;
  END IF;
  IF jsonb_array_length(problems) > 0 THEN
    status := 'invalid';
    detail := problems;
    RETURN;
  END IF;
  DELETE FROM trucker.shipment_commission x WHERE x.shipment_id = d.id;
  IF v_option <> 'none' THEN
    INSERT INTO trucker.shipment_commission
      (shipment_id, option, basis_points, fixed_amount, currency_code, set_by, set_at)
    VALUES (d.id, v_option, v_points, v_amount,
            CASE WHEN v_option = 'fixed' THEN p_content ->> 'currency' END, entered.actor, entered.at)
    RETURNING * INTO c;
  END IF;
  PERFORM trucker.fleet_audit(entered.at, entered.actor, NULL, entered.org, 'shipment.commission_set',
                              'shipment_draft', d.id, NULL,
                              coalesce(trucker.shipment_commission_values(c), jsonb_build_object('option', 'none')));
  status := 'saved';
  detail := trucker.shipment_commission_values(c);
END
$$;

-- The commission of a published shipment, for a carrier deciding what to quote, and for the
-- account that keeps the shipment. With an amount and currency it also gives the figures.
--   status: ok | unauthorized | not_found
CREATE FUNCTION trucker.shipment_commission_terms(
  p_shipment uuid, p_amount text, p_currency text, OUT status text, OUT detail jsonb
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
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
  IF d.organisation_id = v_org THEN
    detail := detail || jsonb_build_object(
      'arranged', trucker.shipment_customer(d.id) <> v_org,
      'editable', d.status = 'draft' AND d.published_version IS NULL);
  END IF;
  IF c.shipment_id IS NOT NULL AND p_amount ~ '^[0-9]{1,12}(\.[0-9]{1,3})?$'
     AND EXISTS (SELECT 1 FROM trucker.currency x WHERE x.code = p_currency) THEN
    SELECT * INTO f FROM trucker.commission_figures(d.id, p_amount::numeric, p_currency);
    detail := detail || jsonb_build_object('figures', jsonb_build_object(
      'state', f.status,
      'commission', CASE WHEN f.status = 'ok' THEN trucker.amount_text(f.commission, f.minor) END,
      'net', CASE WHEN f.status = 'ok' THEN trucker.amount_text(f.net, f.minor) END,
      'currency', p_currency));
  END IF;
END
$$;

-- When a version of a quotation is written on a shipment that carries a commission: the
-- carrier must have accepted exactly the commission and the net that follow from its price.
-- What it accepted reaches here as "commission|net" in trucker.commission_accepted, set by
-- the request; a version that only reconfirms the same values keeps the earlier acceptance.
--   TR010 not accepted (the figures are in the detail); TR011 the fixed amount is in another
--   currency; TR012 nothing would be left for the carrier.
CREATE FUNCTION trucker.quotation_commission_record() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
DECLARE
  q trucker.quotation;
  c trucker.shipment_commission;
  f record;
  expected text;
BEGIN
  SELECT * INTO q FROM trucker.quotation x WHERE x.id = NEW.quotation_id;
  SELECT * INTO c FROM trucker.shipment_commission x WHERE x.shipment_id = q.shipment_id;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;
  SELECT * INTO f FROM trucker.commission_figures(q.shipment_id, NEW.amount, NEW.currency_code);
  IF f.status = 'currency' THEN
    RAISE EXCEPTION 'the commission is in another currency' USING ERRCODE = 'TR011', DETAIL = c.currency_code;
  ELSIF f.status <> 'ok' THEN
    RAISE EXCEPTION 'nothing is left for the carrier' USING ERRCODE = 'TR012';
  END IF;
  expected := trucker.amount_text(f.commission, f.minor) || '|' || trucker.amount_text(f.net, f.minor);
  IF NEW.kind <> 'reconfirmed'
     AND nullif(current_setting('trucker.commission_accepted', true), '') IS DISTINCT FROM expected THEN
    RAISE EXCEPTION 'the commission was not accepted' USING ERRCODE = 'TR010', DETAIL = expected;
  END IF;
  INSERT INTO trucker.quotation_commission
    (quotation_id, version_no, organiser_organisation_id, option, basis_points, currency_code, minor_units,
     shipping_amount, commission_amount, net_amount, accepted_by, accepted_at)
  VALUES (NEW.quotation_id, NEW.version_no,
          (SELECT p.organiser_organisation_id FROM trucker.shipment_party p WHERE p.shipment_id = q.shipment_id),
          c.option, c.basis_points,
          NEW.currency_code, f.minor, NEW.amount, f.commission, f.net, NEW.created_by, NEW.created_at);
  RETURN NEW;
END
$$;
CREATE TRIGGER quotation_commission_record AFTER INSERT ON trucker.quotation_version
  FOR EACH ROW EXECUTE FUNCTION trucker.quotation_commission_record();

CREATE FUNCTION trucker.booking_commission_record() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
BEGIN
  INSERT INTO trucker.booking_commission
    (booking_id, organiser_organisation_id, carrier_organisation_id, option, basis_points, currency_code,
     minor_units, shipping_amount, commission_amount, net_amount, recorded_at)
  SELECT NEW.id, c.organiser_organisation_id, NEW.carrier_organisation_id, c.option, c.basis_points,
         c.currency_code, c.minor_units, c.shipping_amount, c.commission_amount, c.net_amount, NEW.accepted_at
  FROM trucker.quotation_commission c
  WHERE c.quotation_id = NEW.quotation_id AND c.version_no = NEW.quotation_version;
  RETURN NEW;
END
$$;
CREATE TRIGGER booking_commission_record AFTER INSERT ON trucker.booking
  FOR EACH ROW EXECUTE FUNCTION trucker.booking_commission_record();

-- The commissions the account named by the request may see: as the organiser, on every
-- quotation and booking of the shipments it arranged; as a carrier, on its own. A customer
-- is shown none: its price is the shipping price.
--   status: ok | unauthorized | not_found
CREATE FUNCTION trucker.commission_overview(OUT status text, OUT detail jsonb)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
DECLARE
  actor uuid := trucker.request_person();
  v_org uuid := trucker.request_organisation();
BEGIN
  IF actor IS NULL THEN
    status := 'unauthorized';
    RETURN;
  END IF;
  IF v_org IS NULL OR NOT trucker.is_admin(v_org) THEN
    status := 'not_found';
    RETURN;
  END IF;
  status := 'ok';
  detail := jsonb_build_object(
    'quotations', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'quotationId', q.id, 'shipmentId', q.shipment_id, 'version', c.version_no,
               'role', CASE WHEN q.carrier_organisation_id = v_org THEN 'carrier' ELSE 'organiser' END,
               'option', c.option, 'basisPoints', c.basis_points, 'currency', c.currency_code,
               'shippingPrice', trucker.amount_text(c.shipping_amount, c.minor_units),
               'commission', trucker.amount_text(c.commission_amount, c.minor_units),
               'net', trucker.amount_text(c.net_amount, c.minor_units)) ORDER BY q.created_at, q.id)
      FROM trucker.quotation q
      JOIN trucker.quotation_commission c ON c.quotation_id = q.id AND c.version_no = q.current_version
      WHERE v_org IN (q.carrier_organisation_id, c.organiser_organisation_id)), '[]'::jsonb),
    'bookings', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'bookingId', c.booking_id,
               'role', CASE WHEN c.carrier_organisation_id = v_org THEN 'carrier' ELSE 'organiser' END,
               'option', c.option, 'basisPoints', c.basis_points, 'currency', c.currency_code,
               'shippingPrice', trucker.amount_text(c.shipping_amount, c.minor_units),
               'commission', trucker.amount_text(c.commission_amount, c.minor_units),
               'net', trucker.amount_text(c.net_amount, c.minor_units),
               'recordedAt', c.recorded_at) ORDER BY c.recorded_at, c.booking_id)
      FROM trucker.booking_commission c
      WHERE v_org IN (c.carrier_organisation_id, c.organiser_organisation_id)), '[]'::jsonb));
END
$$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA trucker FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  trucker.set_shipment_commission(uuid, integer, jsonb),
  trucker.shipment_commission_terms(uuid, text, text),
  trucker.commission_overview()
TO trucker_app;
