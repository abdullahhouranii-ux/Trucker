-- 0021_commission_contracts
-- Organiser commission, part two (slice 23b; model: docs/specs/ADR_001_COMMERCIAL_MODEL.md,
-- R-5 and R-7). The third commission option: a contract between an organiser and a carrier,
-- proposed by the organiser and accepted by the carrier in advance. It states how the
-- commission is calculated (a percentage of the shipping price, or a fixed amount), when it is
-- earned and when it is payable. On a request the organiser may choose "contract": each
-- carrier's commission is then the one in its own contract with the organiser, and a carrier
-- that holds none in force cannot quote. As before, no quotation exists unless the carrier also
-- accepted the exact commission and net for its price.
--
-- Development defaults, not approved for production (ADR-001 D-3, D-10): the same 25% limit
-- and fixed-amount rules as the other options; one earning condition, the carrier recording
-- receipt of the freight payment; settlement within 1 to 60 days. The earning condition and the
-- settlement days are recorded now and used by settlement, which is not built.
--
-- A contract's terms never change once proposed. To change them, either side ends it and the
-- organiser proposes another. Ending it stops new quotations, revisions and reconfirmations
-- under it; quotations already made and bookings keep the commission the carrier accepted.

CREATE TABLE trucker.commission_contract (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organiser_organisation_id uuid NOT NULL REFERENCES trucker.organisation (id),
  carrier_organisation_id uuid NOT NULL REFERENCES trucker.organisation (id),
  status text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'active', 'declined', 'ended')),
  option text NOT NULL CHECK (option IN ('percentage', 'fixed')),
  basis_points integer CHECK (basis_points BETWEEN 1 AND 2500),
  fixed_amount numeric CHECK (fixed_amount > 0 AND fixed_amount < 1000000000000),
  currency_code text REFERENCES trucker.currency (code),
  earning_condition text NOT NULL CHECK (earning_condition IN ('freight_receipt_recorded')),
  settlement_days integer NOT NULL CHECK (settlement_days BETWEEN 1 AND 60),
  proposed_by uuid NOT NULL REFERENCES trucker.person (id),
  proposed_at timestamptz NOT NULL,
  decided_by uuid REFERENCES trucker.person (id),
  decided_at timestamptz,
  ended_at timestamptz,
  ended_by text CHECK (ended_by IS NULL OR ended_by IN ('organiser', 'carrier')),
  row_version integer NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  CONSTRAINT commission_contract_parties CHECK (organiser_organisation_id <> carrier_organisation_id),
  CONSTRAINT commission_contract_shape CHECK (
    (option = 'percentage' AND basis_points IS NOT NULL AND fixed_amount IS NULL AND currency_code IS NULL)
    OR (option = 'fixed' AND basis_points IS NULL AND fixed_amount IS NOT NULL AND currency_code IS NOT NULL)),
  CONSTRAINT commission_contract_decided CHECK ((status = 'proposed') = (decided_at IS NULL)),
  CONSTRAINT commission_contract_ended CHECK ((status = 'ended') = (ended_at IS NOT NULL))
);
CREATE UNIQUE INDEX commission_contract_one_open
  ON trucker.commission_contract (organiser_organisation_id, carrier_organisation_id)
  WHERE status IN ('proposed', 'active');
CREATE INDEX commission_contract_carrier_idx ON trucker.commission_contract (carrier_organisation_id);
ALTER TABLE trucker.commission_contract ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON trucker.commission_contract FROM trucker_app, PUBLIC;

-- The terms and the parties are fixed when proposed; only the status and its record move.
CREATE FUNCTION trucker.guard_commission_contract() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, trucker, pg_temp AS $$
BEGIN
  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'the terms of a commission contract are never changed' USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW.id, NEW.organiser_organisation_id, NEW.carrier_organisation_id, NEW.option, NEW.basis_points,
         NEW.fixed_amount, NEW.currency_code, NEW.earning_condition, NEW.settlement_days, NEW.proposed_by,
         NEW.proposed_at)
        IS DISTINCT FROM
        (OLD.id, OLD.organiser_organisation_id, OLD.carrier_organisation_id, OLD.option, OLD.basis_points,
         OLD.fixed_amount, OLD.currency_code, OLD.earning_condition, OLD.settlement_days, OLD.proposed_by,
         OLD.proposed_at)
     OR OLD.status IN ('declined', 'ended') THEN
    RAISE EXCEPTION 'the terms of a commission contract are never changed' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER commission_contract_guard BEFORE UPDATE OR DELETE ON trucker.commission_contract
  FOR EACH ROW EXECUTE FUNCTION trucker.guard_commission_contract();
CREATE TRIGGER commission_contract_truncate_guard BEFORE TRUNCATE ON trucker.commission_contract
  FOR EACH STATEMENT EXECUTE FUNCTION trucker.guard_commission_contract();

-- The contract option on a request, and which contract each quotation and booking used.
ALTER TABLE trucker.shipment_commission
  DROP CONSTRAINT shipment_commission_option_check,
  DROP CONSTRAINT shipment_commission_shape,
  ADD CONSTRAINT shipment_commission_option_check CHECK (option IN ('percentage', 'fixed', 'contract')),
  ADD CONSTRAINT shipment_commission_shape CHECK (
    (option = 'percentage' AND basis_points IS NOT NULL AND fixed_amount IS NULL AND currency_code IS NULL)
    OR (option = 'fixed' AND basis_points IS NULL AND fixed_amount IS NOT NULL AND currency_code IS NOT NULL)
    OR (option = 'contract' AND basis_points IS NULL AND fixed_amount IS NULL AND currency_code IS NULL));
ALTER TABLE trucker.quotation_commission
  DROP CONSTRAINT quotation_commission_option_check,
  ADD CONSTRAINT quotation_commission_option_check CHECK (option IN ('percentage', 'fixed', 'contract')),
  ADD COLUMN contract_id uuid REFERENCES trucker.commission_contract (id),
  ADD CONSTRAINT quotation_commission_contract CHECK ((option = 'contract') = (contract_id IS NOT NULL));
ALTER TABLE trucker.booking_commission
  ADD COLUMN contract_id uuid REFERENCES trucker.commission_contract (id);

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
    'shipment.commission_set', 'commission_contract.proposed', 'commission_contract.decided',
    'commission_contract.ended'));
ALTER TABLE trucker.audit_entry
  DROP CONSTRAINT audit_entry_record_type_check,
  ADD CONSTRAINT audit_entry_record_type_check CHECK (record_type IN (
    'organisation', 'shipment_draft', 'verification_application', 'quotation', 'vehicle',
    'driver_affiliation', 'driver_authorisation', 'fleet_document', 'booking',
    'booking_substitution', 'organiser_authority', 'commission_contract'));

-- ---------------------------------------------------------------------------------------------
-- Contracts
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION trucker.contract_values(k trucker.commission_contract, p_for uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
  SELECT CASE WHEN k.id IS NULL THEN NULL ELSE jsonb_build_object(
    'id', k.id, 'version', k.row_version, 'status', k.status,
    'role', CASE WHEN k.carrier_organisation_id = p_for THEN 'carrier' ELSE 'organiser' END,
    'option', k.option, 'basisPoints', k.basis_points,
    'amount', CASE WHEN k.fixed_amount IS NOT NULL THEN trucker.amount_text(
                k.fixed_amount, (SELECT x.minor_units FROM trucker.currency x WHERE x.code = k.currency_code)) END,
    'currency', k.currency_code, 'earningCondition', k.earning_condition, 'settlementDays', k.settlement_days,
    'proposedAt', k.proposed_at, 'decidedAt', k.decided_at, 'endedAt', k.ended_at, 'endedBy', k.ended_by,
    'organiser', (SELECT jsonb_build_object('legalName', o.legal_name, 'kind', o.kind)
                  FROM trucker.organisation o WHERE o.id = k.organiser_organisation_id),
    'carrier', (SELECT jsonb_build_object('legalName', o.legal_name, 'kind', o.kind)
                FROM trucker.organisation o WHERE o.id = k.carrier_organisation_id)) END
$$;

-- The organiser of a shipment: as recorded at publication, or the account that keeps it.
CREATE FUNCTION trucker.shipment_organiser(p_shipment uuid) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
  SELECT coalesce(
    (SELECT p.organiser_organisation_id FROM trucker.shipment_party p WHERE p.shipment_id = p_shipment),
    (SELECT d.organisation_id FROM trucker.shipment_draft d WHERE d.id = p_shipment))
$$;

-- The terms of a proposal, or the problems with them.
--   p_content: {"option": "percentage" | "fixed", "basisPoints": int, "amount": text,
--               "currency": text, "settlementDays": int}
CREATE FUNCTION trucker.contract_problems(p_content jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
DECLARE
  v_option text := p_content ->> 'option';
  v_minor integer;
  problems jsonb := '[]'::jsonb;
BEGIN
  IF v_option IS NULL OR v_option NOT IN ('percentage', 'fixed') THEN
    problems := problems || jsonb_build_object('field', 'option', 'code', 'required');
  ELSIF v_option = 'percentage' THEN
    IF coalesce(p_content ->> 'basisPoints', '') !~ '^[0-9]{1,4}$'
       OR (p_content ->> 'basisPoints')::integer NOT BETWEEN 1 AND 2500 THEN
      problems := problems || jsonb_build_object('field', 'basisPoints', 'code', 'out_of_range');
    END IF;
  ELSE
    SELECT x.minor_units INTO v_minor FROM trucker.currency x WHERE x.code = p_content ->> 'currency';
    IF v_minor IS NULL THEN
      problems := problems || jsonb_build_object('field', 'currency', 'code', 'unavailable');
    ELSIF coalesce(p_content ->> 'amount', '') !~ ('^[0-9]{1,12}(\.[0-9]{1,' || greatest(v_minor, 1) || '})?$')
          OR (v_minor = 0 AND p_content ->> 'amount' ~ '\.')
          OR (p_content ->> 'amount')::numeric <= 0 THEN
      problems := problems || jsonb_build_object('field', 'amount', 'code', 'invalid');
    END IF;
  END IF;
  IF coalesce(p_content ->> 'settlementDays', '') !~ '^[0-9]{1,2}$'
     OR (p_content ->> 'settlementDays')::integer NOT BETWEEN 1 AND 60 THEN
    problems := problems || jsonb_build_object('field', 'settlementDays', 'code', 'out_of_range');
  END IF;
  RETURN problems;
END
$$;

-- An organiser proposes a contract to a carrier named by its account code. A code that names
-- no account, the organiser's own, or an account that is not a verified carrier answers the same.
--   status: proposed | exists | invalid | not_organiser | no_account | unauthorized | not_found
CREATE FUNCTION trucker.propose_commission_contract(p_code text, p_content jsonb, OUT status text, OUT detail jsonb)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
DECLARE
  entered record;
  v_carrier uuid;
  k trucker.commission_contract;
  v_at timestamptz;
  problems jsonb;
BEGIN
  SELECT * INTO entered FROM trucker.authority_enter();
  status := entered.status;
  IF status <> 'ok' THEN
    RETURN;
  END IF;
  IF NOT trucker.capability_effective(entered.org, 'organise') THEN
    status := 'not_organiser';
    RETURN;
  END IF;
  SELECT o.id INTO v_carrier FROM trucker.organisation o
  WHERE o.account_code = upper(btrim(coalesce(p_code, ''))) AND o.id <> entered.org AND o.status = 'verified'
    AND trucker.is_carrier(o.id);
  IF v_carrier IS NULL THEN
    status := 'no_account';
    RETURN;
  END IF;
  problems := trucker.contract_problems(coalesce(p_content, '{}'::jsonb));
  IF jsonb_array_length(problems) > 0 THEN
    status := 'invalid';
    detail := problems;
    RETURN;
  END IF;
  -- One open contract for a pair; two proposals at once are decided one at a time.
  PERFORM pg_advisory_xact_lock(hashtextextended('commission.contract:' || entered.org::text || ':' || v_carrier::text, 0));
  SELECT * INTO k FROM trucker.commission_contract x
  WHERE x.organiser_organisation_id = entered.org AND x.carrier_organisation_id = v_carrier
    AND x.status IN ('proposed', 'active');
  IF FOUND THEN
    status := 'exists';
    detail := trucker.contract_values(k, entered.org);
    RETURN;
  END IF;
  v_at := trucker.clock_now();
  INSERT INTO trucker.commission_contract
    (organiser_organisation_id, carrier_organisation_id, option, basis_points, fixed_amount, currency_code,
     earning_condition, settlement_days, proposed_by, proposed_at)
  VALUES (entered.org, v_carrier, p_content ->> 'option',
          CASE WHEN p_content ->> 'option' = 'percentage' THEN (p_content ->> 'basisPoints')::integer END,
          CASE WHEN p_content ->> 'option' = 'fixed' THEN (p_content ->> 'amount')::numeric END,
          CASE WHEN p_content ->> 'option' = 'fixed' THEN p_content ->> 'currency' END,
          'freight_receipt_recorded', (p_content ->> 'settlementDays')::integer, entered.actor, v_at)
  RETURNING * INTO k;
  PERFORM trucker.fleet_audit(v_at, entered.actor, NULL, o, 'commission_contract.proposed', 'commission_contract',
                              k.id, NULL, trucker.contract_values(k, o))
  FROM unnest(ARRAY[k.organiser_organisation_id, k.carrier_organisation_id]) o;
  status := 'proposed';
  detail := trucker.contract_values(k, entered.org);
END
$$;

-- The carrier accepts or declines. Only a carrier that is one now can accept.
--   status: accepted | declined | already_decided | conflict | invalid | not_carrier
--           | unauthorized | not_found
CREATE FUNCTION trucker.decide_commission_contract(
  p_contract uuid, p_expected_version integer, p_decision text, OUT status text, OUT detail jsonb
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
DECLARE
  entered record;
  k trucker.commission_contract;
  v_at timestamptz;
BEGIN
  SELECT * INTO entered FROM trucker.authority_enter();
  status := entered.status;
  IF status <> 'ok' THEN
    RETURN;
  END IF;
  SELECT * INTO k FROM trucker.commission_contract x
  WHERE x.id = p_contract AND x.carrier_organisation_id = entered.org FOR UPDATE;
  IF NOT FOUND THEN
    status := 'not_found';
    RETURN;
  END IF;
  IF k.status <> 'proposed' THEN
    status := 'already_decided';
    detail := trucker.contract_values(k, entered.org);
    RETURN;
  END IF;
  IF k.row_version IS DISTINCT FROM p_expected_version THEN
    status := 'conflict';
    RETURN;
  END IF;
  IF p_decision IS NULL OR p_decision NOT IN ('accept', 'decline') THEN
    status := 'invalid';
    RETURN;
  END IF;
  IF p_decision = 'accept' AND NOT trucker.is_carrier(entered.org) THEN
    status := 'not_carrier';
    RETURN;
  END IF;
  v_at := trucker.clock_now();
  UPDATE trucker.commission_contract x
  SET status = CASE WHEN p_decision = 'accept' THEN 'active' ELSE 'declined' END,
      decided_by = entered.actor, decided_at = v_at, row_version = x.row_version + 1
  WHERE x.id = k.id RETURNING * INTO k;
  PERFORM trucker.fleet_audit(v_at, entered.actor, NULL, o, 'commission_contract.decided', 'commission_contract',
                              k.id, jsonb_build_object('status', 'proposed'), jsonb_build_object('status', k.status))
  FROM unnest(ARRAY[k.organiser_organisation_id, k.carrier_organisation_id]) o;
  status := CASE WHEN p_decision = 'accept' THEN 'accepted' ELSE 'declined' END;
  detail := trucker.contract_values(k, entered.org);
END
$$;

-- Either side ends it, at once: a proposal is withdrawn, a contract in force stops applying.
--   status: ended | already_ended | conflict | unauthorized | not_found
CREATE FUNCTION trucker.end_commission_contract(
  p_contract uuid, p_expected_version integer, OUT status text, OUT detail jsonb
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
DECLARE
  entered record;
  k trucker.commission_contract;
  v_at timestamptz;
  v_before text;
BEGIN
  SELECT * INTO entered FROM trucker.authority_enter();
  status := entered.status;
  IF status <> 'ok' THEN
    RETURN;
  END IF;
  SELECT * INTO k FROM trucker.commission_contract x
  WHERE x.id = p_contract AND entered.org IN (x.organiser_organisation_id, x.carrier_organisation_id) FOR UPDATE;
  IF NOT FOUND THEN
    status := 'not_found';
    RETURN;
  END IF;
  IF k.status NOT IN ('proposed', 'active') THEN
    status := 'already_ended';
    detail := trucker.contract_values(k, entered.org);
    RETURN;
  END IF;
  IF k.row_version IS DISTINCT FROM p_expected_version THEN
    status := 'conflict';
    RETURN;
  END IF;
  v_at := trucker.clock_now();
  v_before := k.status;
  UPDATE trucker.commission_contract x
  SET status = 'ended', ended_at = v_at,
      ended_by = CASE WHEN x.carrier_organisation_id = entered.org THEN 'carrier' ELSE 'organiser' END,
      decided_by = coalesce(x.decided_by, entered.actor), decided_at = coalesce(x.decided_at, v_at),
      row_version = x.row_version + 1
  WHERE x.id = k.id RETURNING * INTO k;
  PERFORM trucker.fleet_audit(v_at, entered.actor, NULL, o, 'commission_contract.ended', 'commission_contract',
                              k.id, jsonb_build_object('status', v_before),
                              jsonb_build_object('status', 'ended', 'endedBy', k.ended_by))
  FROM unnest(ARRAY[k.organiser_organisation_id, k.carrier_organisation_id]) o;
  status := 'ended';
  detail := trucker.contract_values(k, entered.org);
END
$$;

-- The contracts of the account named by the request, on either side, with its account code.
--   status: ok | unauthorized | not_found
CREATE FUNCTION trucker.commission_contracts(OUT status text, OUT detail jsonb)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
DECLARE
  entered record;
BEGIN
  SELECT * INTO entered FROM trucker.authority_enter();
  status := entered.status;
  IF status <> 'ok' THEN
    RETURN;
  END IF;
  detail := jsonb_build_object(
    'accountCode', (SELECT o.account_code FROM trucker.organisation o WHERE o.id = entered.org),
    'organiser', trucker.capability_effective(entered.org, 'organise'),
    'carrier', trucker.is_carrier(entered.org),
    'contracts', coalesce((
      SELECT jsonb_agg(trucker.contract_values(k, entered.org) ORDER BY k.proposed_at DESC, k.id)
      FROM trucker.commission_contract k
      WHERE entered.org IN (k.organiser_organisation_id, k.carrier_organisation_id)), '[]'::jsonb));
END
$$;

-- ---------------------------------------------------------------------------------------------
-- The figures, now for a carrier: under the contract option, from its contract in force with
-- the organiser, read under a share lock so that a contract being ended is waited for.
--   status: none | ok | currency | nothing_left | no_contract
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION trucker.commission_figures_for(
  p_shipment uuid, p_carrier uuid, p_amount numeric, p_currency text,
  OUT status text, OUT commission numeric, OUT net numeric, OUT minor integer,
  OUT contract_id uuid, OUT basis_points integer, OUT fixed_currency text
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
#variable_conflict use_column
DECLARE
  c trucker.shipment_commission;
  k trucker.commission_contract;
  v_option text;
  v_fixed numeric;
BEGIN
  SELECT * INTO c FROM trucker.shipment_commission x WHERE x.shipment_id = p_shipment;
  IF NOT FOUND THEN
    status := 'none';
    RETURN;
  END IF;
  IF c.option = 'contract' THEN
    SELECT * INTO k FROM trucker.commission_contract x
    WHERE x.organiser_organisation_id = trucker.shipment_organiser(p_shipment)
      AND x.carrier_organisation_id = p_carrier AND x.status = 'active'
    FOR SHARE;
    IF NOT FOUND THEN
      status := 'no_contract';
      RETURN;
    END IF;
    contract_id := k.id;
    v_option := k.option;
    basis_points := k.basis_points;
    v_fixed := k.fixed_amount;
    fixed_currency := k.currency_code;
  ELSE
    v_option := c.option;
    basis_points := c.basis_points;
    v_fixed := c.fixed_amount;
    fixed_currency := c.currency_code;
  END IF;
  SELECT x.minor_units INTO minor FROM trucker.currency x WHERE x.code = p_currency;
  IF v_option = 'fixed' AND fixed_currency <> p_currency THEN
    status := 'currency';
    RETURN;
  END IF;
  commission := CASE WHEN v_option = 'fixed' THEN v_fixed ELSE round(p_amount * basis_points / 10000, minor) END;
  net := p_amount - commission;
  status := CASE WHEN commission > 0 AND net > 0 THEN 'ok' ELSE 'nothing_left' END;
END
$$;

CREATE OR REPLACE FUNCTION trucker.commission_figures(
  p_shipment uuid, p_amount numeric, p_currency text,
  OUT status text, OUT commission numeric, OUT net numeric, OUT minor integer
)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
  SELECT f.status, f.commission, f.net, f.minor
  FROM trucker.commission_figures_for(p_shipment, NULL, p_amount, p_currency) f
$$;

CREATE OR REPLACE FUNCTION trucker.set_shipment_commission(
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
  IF v_option IS NULL OR v_option NOT IN ('none', 'percentage', 'fixed', 'contract') THEN
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

CREATE OR REPLACE FUNCTION trucker.shipment_commission_terms(
  p_shipment uuid, p_amount text, p_currency text, OUT status text, OUT detail jsonb
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
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
      'editable', d.status = 'draft' AND d.published_version IS NULL);
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
$$;

CREATE OR REPLACE FUNCTION trucker.quotation_commission_record() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
DECLARE
  q trucker.quotation;
  c trucker.shipment_commission;
  f record;
  prev trucker.quotation_commission;
  expected text;
BEGIN
  SELECT * INTO q FROM trucker.quotation x WHERE x.id = NEW.quotation_id;
  SELECT * INTO c FROM trucker.shipment_commission x WHERE x.shipment_id = q.shipment_id;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;
  SELECT * INTO f
  FROM trucker.commission_figures_for(q.shipment_id, q.carrier_organisation_id, NEW.amount, NEW.currency_code);
  IF f.status = 'no_contract' THEN
    RAISE EXCEPTION 'no commission contract with the organiser is in force' USING ERRCODE = 'TR013';
  ELSIF f.status = 'currency' THEN
    RAISE EXCEPTION 'the commission is in another currency' USING ERRCODE = 'TR011', DETAIL = f.fixed_currency;
  ELSIF f.status <> 'ok' THEN
    RAISE EXCEPTION 'nothing is left for the carrier' USING ERRCODE = 'TR012';
  END IF;
  expected := trucker.amount_text(f.commission, f.minor) || '|' || trucker.amount_text(f.net, f.minor);
  SELECT * INTO prev FROM trucker.quotation_commission x
  WHERE x.quotation_id = NEW.quotation_id AND x.version_no = NEW.version_no - 1;
  -- A reconfirmation keeps the earlier acceptance only if the figures and the contract are the
  -- same; otherwise, and for every other version, the carrier accepts these figures now.
  IF NOT (NEW.kind = 'reconfirmed' AND prev.quotation_id IS NOT NULL
          AND prev.commission_amount = f.commission AND prev.net_amount = f.net
          AND prev.contract_id IS NOT DISTINCT FROM f.contract_id)
     AND nullif(current_setting('trucker.commission_accepted', true), '') IS DISTINCT FROM expected THEN
    RAISE EXCEPTION 'the commission was not accepted' USING ERRCODE = 'TR010', DETAIL = expected;
  END IF;
  INSERT INTO trucker.quotation_commission
    (quotation_id, version_no, organiser_organisation_id, option, basis_points, currency_code, minor_units,
     shipping_amount, commission_amount, net_amount, accepted_by, accepted_at, contract_id)
  VALUES (NEW.quotation_id, NEW.version_no, trucker.shipment_organiser(q.shipment_id),
          c.option, f.basis_points,
          NEW.currency_code, f.minor, NEW.amount, f.commission, f.net, NEW.created_by, NEW.created_at,
          f.contract_id);
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION trucker.booking_commission_record() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, trucker, pg_temp AS $$
BEGIN
  INSERT INTO trucker.booking_commission
    (booking_id, organiser_organisation_id, carrier_organisation_id, option, basis_points, currency_code,
     minor_units, shipping_amount, commission_amount, net_amount, recorded_at, contract_id)
  SELECT NEW.id, c.organiser_organisation_id, NEW.carrier_organisation_id, c.option, c.basis_points,
         c.currency_code, c.minor_units, c.shipping_amount, c.commission_amount, c.net_amount, NEW.accepted_at,
         c.contract_id
  FROM trucker.quotation_commission c
  WHERE c.quotation_id = NEW.quotation_id AND c.version_no = NEW.quotation_version;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION trucker.commission_overview(OUT status text, OUT detail jsonb)
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
               'net', trucker.amount_text(c.net_amount, c.minor_units),
               'contractId', c.contract_id) ORDER BY q.created_at, q.id)
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
               'recordedAt', c.recorded_at, 'contractId', c.contract_id) ORDER BY c.recorded_at, c.booking_id)
      FROM trucker.booking_commission c
      WHERE v_org IN (c.carrier_organisation_id, c.organiser_organisation_id)), '[]'::jsonb));
END
$$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA trucker FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  trucker.propose_commission_contract(text, jsonb),
  trucker.decide_commission_contract(uuid, integer, text),
  trucker.end_commission_contract(uuid, integer),
  trucker.commission_contracts()
TO trucker_app;
